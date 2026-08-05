(function attachParser(root) {
  const MAX_UFS_STRING_BYTES = 16 * 1024 * 1024;
  const MAX_UFS_MATRIX_VALUES = 100_000_000;

  function parseSpectroscopyCsv(text, fileName) {
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const numericRows = [];
    const metadataRows = [];

    lines.forEach((line, index) => {
      const cells = line.split(",").map((cell) => cell.trim());
      const parsed = cells.map(parseCell);
      const hasFiniteFirstCell = Number.isFinite(parsed[0]);
      const isNumericRow = cells.length > 1 && hasFiniteFirstCell && parsed.every((value) => Number.isFinite(value) || Number.isNaN(value));

      if (isNumericRow) {
        numericRows.push({ lineNumber: index + 1, cells, values: parsed });
      } else {
        metadataRows.push({ lineNumber: index + 1, text: line });
      }
    });

    if (numericRows.length < 2) {
      throw new Error("No spectroscopy matrix was detected. Expected one header row and at least one spectral row.");
    }

    const width = numericRows[0].values.length;
    const rectangular = numericRows.every((row) => row.values.length === width);
    if (!rectangular) {
      throw new Error("Numeric matrix is not rectangular.");
    }

    const timeAxis = numericRows[0].values.slice(1);
    const spectralAxis = numericRows.slice(1).map((row) => row.values[0]);
    const matrix = numericRows.slice(1).map((row) => row.values.slice(1));
    const metadata = parseMetadata(metadataRows);
    let nanCount = 0;
    let finiteCount = 0;

    matrix.forEach((row) => {
      row.forEach((value) => {
        if (Number.isFinite(value)) finiteCount += 1;
        else nanCount += 1;
      });
    });

    return {
      fileName,
      numericRows,
      metadataRows,
      metadata,
      sourceShape: { rows: numericRows.length, cols: width },
      timeAxis,
      spectralAxis,
      matrix,
      nanCount,
      finiteCount,
    };
  }

  class UfsReader {
    constructor(input) {
      const bytes = toUfsBytes(input);
      this.bytes = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.position = 0;
    }

    ensure(byteCount) {
      if (!Number.isSafeInteger(byteCount) || byteCount < 0
        || this.position + byteCount > this.view.byteLength) {
        throw new Error("UFS file ends before its declared data is complete.");
      }
    }

    uint32() {
      this.ensure(4);
      const value = this.view.getUint32(this.position, false);
      this.position += 4;
      return value;
    }

    float64() {
      this.ensure(8);
      const value = this.view.getFloat64(this.position, false);
      this.position += 8;
      return value;
    }

    string() {
      const byteCount = this.uint32();
      if (byteCount > MAX_UFS_STRING_BYTES) {
        throw new Error("UFS text field exceeds the supported 16 MB limit.");
      }
      this.ensure(byteCount);
      const value = new TextDecoder("utf-8", { fatal: true })
        .decode(this.bytes.subarray(this.position, this.position + byteCount));
      this.position += byteCount;
      return value;
    }

    doubles(length) {
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_UFS_MATRIX_VALUES) {
        throw new Error("UFS numeric array length exceeds the supported limit.");
      }
      this.ensure(length * 8);
      return Array.from({ length }, () => this.float64());
    }
  }

  function parseSpectroscopyUfs(input, fileName) {
    const rawBytes = toUfsBytes(input).slice();
    const reader = new UfsReader(rawBytes);
    const version = reader.string();
    if (!version.toLowerCase().startsWith("version")) {
      throw new Error(`Unsupported UFS header: ${version || "empty"}.`);
    }

    const spectralLabel = reader.string();
    const spectralUnit = reader.string();
    const spectralAxis = reader.doubles(reader.uint32());
    const timeLabel = reader.string();
    const timeUnit = reader.string();
    const timeAxis = reader.doubles(reader.uint32());
    const dataUnit = reader.string();
    const storedPlanes = reader.uint32();
    const rows = reader.uint32();
    const columns = reader.uint32();
    const planes = storedPlanes || 1;

    if (rows !== spectralAxis.length || columns !== timeAxis.length) {
      throw new Error("UFS matrix dimensions do not match its wavelength and time axes.");
    }
    if (planes !== 1) {
      throw new Error("UFS files with multiple data planes are not supported.");
    }
    const valueCount = planes * rows * columns;
    if (!Number.isSafeInteger(valueCount) || valueCount > MAX_UFS_MATRIX_VALUES) {
      throw new Error("UFS matrix dimensions exceed the supported limit.");
    }

    const flat = reader.doubles(valueCount);
    const matrix = Array.from({ length: rows }, (_, rowIndex) =>
      flat.slice(rowIndex * columns, (rowIndex + 1) * columns));
    const metadataText = reader.string();
    if (reader.position !== reader.view.byteLength) {
      throw new Error("Unexpected trailing bytes in UFS file.");
    }

    const metadataRows = metadataText
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((text, index) => ({ lineNumber: index + 1, text }));
    const metadata = {
      ...parseMetadata(metadataRows),
      "Source format": "UFS",
      "UFS version": version,
      "Spectral axis": spectralLabel,
      "Spectral units": spectralUnit || "nm",
      "Time axis": timeLabel,
      "Time units": timeUnit || "ps",
      "Z axis title": dataUnit || "signal",
      "UFS stored planes": String(storedPlanes),
      "UFS rows": String(rows),
      "UFS columns": String(columns),
      "UFS metadata": metadataText.trim(),
    };
    let nanCount = 0;
    let finiteCount = 0;
    matrix.forEach((row) => row.forEach((value) => {
      if (Number.isFinite(value)) finiteCount += 1;
      else nanCount += 1;
    }));

    return {
      fileName,
      sourceFormat: "ufs",
      rawBytes,
      numericRows: [],
      metadataRows,
      metadata,
      sourceShape: { rows: rows + 1, cols: columns + 1 },
      timeAxis,
      spectralAxis,
      matrix,
      nanCount,
      finiteCount,
      ufs: {
        version,
        spectralLabel,
        spectralUnit,
        timeLabel,
        timeUnit,
        dataUnit,
        storedPlanes,
        rows,
        columns,
        metadataText,
      },
    };
  }

  function buildUfsDatasetNote(source) {
    if (source?.sourceFormat !== "ufs" || !source.ufs) return "";
    const details = source.ufs;
    const rawMetadata = details.metadataText.trim();
    return [
      "Imported from Ultrafast Systems UFS raw data.",
      `Format: ${details.version}`,
      `Spectral axis: ${details.spectralLabel || "Wavelength"} (${details.spectralUnit || "nm"}), ${details.rows} points`,
      `Time axis: ${details.timeLabel || "Time"} (${details.timeUnit || "ps"}), ${details.columns} points`,
      `Signal: ${details.dataUnit || "signal"}`,
      `UFS metadata: ${rawMetadata || "(empty)"}`,
    ].join("\n");
  }

  function toUfsBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new Error("UFS input must be binary data.");
  }

  function createAnalysisDataset(source, options = {}) {
    const rowScores = source.matrix.map((row) => finiteFraction(row));
    const colScores = source.timeAxis.map((_, colIndex) => {
      const column = source.matrix.map((row) => row[colIndex]);
      return finiteFraction(column);
    });

    let rowRange = contiguousValidRange(rowScores, 0.15);
    let colRange = contiguousValidRange(colScores, 0.15);

    if (!rowRange || !colRange) {
      throw new Error("No meaningful finite data range was detected.");
    }

    rowRange = applyAxisRange(source.spectralAxis, rowRange, options.spectralRange);
    colRange = applyAxisRange(source.timeAxis, colRange, options.timeRange);

    if (!rowRange || !colRange) {
      throw new Error("Selected analysis range does not overlap meaningful finite data.");
    }

    const matrix = source.matrix
      .slice(rowRange.start, rowRange.end + 1)
      .map((row) => row.slice(colRange.start, colRange.end + 1));
    const spectralAxis = source.spectralAxis.slice(rowRange.start, rowRange.end + 1);
    const timeAxis = source.timeAxis.slice(colRange.start, colRange.end + 1);
    const excluded = buildExclusions(source, rowRange, colRange);
    const spectralSegments = remapSpectralSegments(source.spectralSegments, rowRange, spectralAxis);
    const wavelengthBreaks = (source.wavelengthBreaks ?? [])
      .filter((item) => spectralAxis.some((value) => value <= item.left)
        && spectralAxis.some((value) => value >= item.right))
      .map((item) => ({ ...item }));

    return {
      timeAxis,
      spectralAxis,
      matrix,
      rowRange,
      colRange,
      selectedRange: {
        time: { min: timeAxis[0], max: timeAxis.at(-1) },
        spectral: { min: spectralAxis[0], max: spectralAxis.at(-1) },
      },
      excluded,
      provenance: [],
      spectralSegments,
      wavelengthBreaks,
      merge: clonePlainMetadata(source.merge),
    };
  }

  function cloneAnalysisDataset(analysis) {
    return {
      timeAxis: analysis.timeAxis.slice(),
      spectralAxis: analysis.spectralAxis.slice(),
      matrix: analysis.matrix.map((row) => row.slice()),
      rowRange: { ...analysis.rowRange },
      colRange: { ...analysis.colRange },
      selectedRange: {
        time: { ...analysis.selectedRange.time },
        spectral: { ...analysis.selectedRange.spectral },
      },
      excluded: analysis.excluded.map((item) => ({ ...item })),
      provenance: (analysis.provenance ?? []).map((item) => ({ ...item })),
      spectralSegments: (analysis.spectralSegments ?? []).map((item) => ({ ...item })),
      wavelengthBreaks: (analysis.wavelengthBreaks ?? []).map((item) => ({ ...item })),
      merge: clonePlainMetadata(analysis.merge),
      chirp: analysis.chirp
        ? {
            model: {
              ...analysis.chirp.model,
              coefficients: analysis.chirp.model.coefficients.slice(),
              sourceRange: { ...analysis.chirp.model.sourceRange },
            },
            curve: analysis.chirp.curve.map((point) => ({ ...point })),
          }
        : null,
    };
  }

  function remapSpectralSegments(segments, rowRange, spectralAxis) {
    return (segments ?? []).flatMap((segment) => {
      const start = Math.max(segment.startIndex, rowRange.start);
      const end = Math.min(segment.endIndex, rowRange.end);
      if (end < start) return [];
      const mappedStart = start - rowRange.start;
      const mappedEnd = end - rowRange.start;
      return [{
        ...segment,
        startIndex: mappedStart,
        endIndex: mappedEnd,
        minNm: spectralAxis[mappedStart],
        maxNm: spectralAxis[mappedEnd],
      }];
    });
  }

  function clonePlainMetadata(value) {
    return value ? JSON.parse(JSON.stringify(value)) : null;
  }

  function applyBaselineCorrection(analysis) {
    const next = cloneAnalysisDataset(analysis);
    const baselineIndexes = next.timeAxis
      .map((time, index) => ({ time, index }))
      .filter((item) => Number.isFinite(item.time) && item.time < 0)
      .map((item) => item.index);
    const indexes = baselineIndexes.length > 0 ? baselineIndexes : fallbackLeadingIndexes(next.timeAxis.length);

    if (indexes.length === 0) {
      next.provenance.push({ label: "Baseline", status: "skipped" });
      return next;
    }

    next.matrix = next.matrix.map((row) => {
      const baseline = meanFinite(indexes.map((index) => row[index]));
      if (!Number.isFinite(baseline)) return row.slice();
      return row.map((value) => (Number.isFinite(value) ? value - baseline : value));
    });
    next.provenance.push({ label: "Baseline", status: "applied" });
    return next;
  }

  function applyChirpCorrection(analysis, options = {}) {
    const next = cloneAnalysisDataset(analysis);
    const model = options.model ?? fitPolynomialDispersion(next);
    if (!model) {
      next.provenance.push({ label: "Chirp", status: "skipped" });
      return next;
    }
    const targetReferenceTime = Number.isFinite(options.targetReferenceTime) ? options.targetReferenceTime : 0;

    let shifts = next.spectralAxis.map((wavelength) => evaluateDispersion(model, wavelength) + (model.referenceTime - targetReferenceTime));
    let correctedMatrix = applyTimeShifts(next, shifts);
    const residualTimeZero = estimateDatasetTimeZero({
      timeAxis: next.timeAxis,
      spectralAxis: next.spectralAxis,
      matrix: correctedMatrix,
    });
    const zeroResidualCorrection = Number.isFinite(residualTimeZero) && Math.abs(residualTimeZero - targetReferenceTime) > 0.02
      ? residualTimeZero - targetReferenceTime
      : 0;
    if (zeroResidualCorrection !== 0) {
      shifts = shifts.map((shift) => shift + zeroResidualCorrection);
      correctedMatrix = applyTimeShifts(next, shifts);
    }
    const curve = next.spectralAxis.map((wavelength, rowIndex) => ({
      wavelength,
      shift: shifts[rowIndex],
    }));

    next.matrix = correctedMatrix;
    next.chirp = { model: { ...model, targetReferenceTime, zeroResidualCorrection }, curve };
    next.provenance.push({
      label: "Chirp",
      status: "applied",
      model: "polynomial-dispersion-3",
      range: `${format(next.spectralAxis[0])} to ${format(next.spectralAxis.at(-1))} nm; target t0 ${format(targetReferenceTime)} ps`,
    });
    return next;
  }

  function applyTimeShifts(analysis, shifts) {
    return analysis.matrix.map((row, rowIndex) => {
      const shift = shifts[rowIndex];
      return analysis.timeAxis.map((targetTime) => interpolateAt(analysis.timeAxis, row, targetTime + shift));
    });
  }

  function applySharedChirpCorrection(analyses) {
    const models = analyses.map((analysis) => fitPolynomialDispersion(analysis));
    const targetReferenceTime = 0;
    return analyses.map((analysis, index) => applyChirpCorrection(analysis, {
      model: models[index],
      targetReferenceTime,
    }));
  }

  function analysisToCsv(analysis, source, options = {}) {
    const zeroFill = options.zeroFill === true;
    const rows = [];
    rows.push([""].concat(analysis.timeAxis).map(formatCsvCell).join(","));
    analysis.spectralAxis.forEach((wavelength, rowIndex) => {
      const values = analysis.matrix[rowIndex].map((value) => formatCsvCell(Number.isFinite(value) ? value : zeroFill ? 0 : value));
      rows.push([formatCsvCell(wavelength)].concat(values).join(","));
    });

    rows.push("");
    rows.push(["SpecFlowLab export", "treated analysis dataset"].map(formatCsvCell).join(","));
    if (source?.fileName) rows.push(["Source file", source.fileName].map(formatCsvCell).join(","));
    rows.push(["Rows", "wavelength"].map(formatCsvCell).join(","));
    rows.push(["Columns", "time"].map(formatCsvCell).join(","));
    rows.push(["NaN policy", zeroFill ? "NaN replaced with 0" : "NaN preserved"].map(formatCsvCell).join(","));
    (analysis.provenance ?? []).forEach((item, index) => {
      rows.push([`Treatment ${index + 1}`, item.label, item.status, item.model ?? "", item.range ?? ""].map(formatCsvCell).join(","));
    });
    return `${rows.join("\n")}\n`;
  }

  function analysesToCombinedCsv(datasets, options = {}) {
    const zeroFill = options.zeroFill !== false;
    const rows = [
      ["dataset_id", "raw_file", "wavelength_nm", "time_ps", "signal"].map(formatCsvCell).join(","),
    ];
    datasets.forEach((dataset, datasetIndex) => {
      const analysis = dataset.analysis;
      const source = dataset.source;
      const datasetId = dataset.id || slugify(source?.fileName || `dataset_${datasetIndex + 1}`);
      analysis.spectralAxis.forEach((wavelength, rowIndex) => {
        analysis.timeAxis.forEach((time, colIndex) => {
          const value = analysis.matrix[rowIndex][colIndex];
          rows.push([
            datasetId,
            source?.fileName ?? "",
            wavelength,
            time,
            Number.isFinite(value) ? value : zeroFill ? 0 : Number.NaN,
          ].map(formatCsvCell).join(","));
        });
      });
    });
    rows.push("");
    rows.push(["SpecFlowLab export", "combined treated long-format dataset"].map(formatCsvCell).join(","));
    rows.push(["NaN policy", zeroFill ? "NaN replaced with 0" : "NaN preserved"].map(formatCsvCell).join(","));
    return `${rows.join("\n")}\n`;
  }

  function fitGlobalExponentials(analysis, componentCount, options = {}) {
    const count = Math.max(1, Math.min(6, Number(componentCount) || 1));
    const irfFwhm = Math.max(0, Number(options.irfFwhm) || 0);
    const fitIndexes = analysis.timeAxis
      .map((time, index) => ({ time, index }))
      .filter((item) => Number.isFinite(item.time))
      .map((item) => item.index);
    if (fitIndexes.length < count + 3) {
      throw new Error("Not enough finite time points for fitting.");
    }

    const fitTimes = fitIndexes.map((index) => analysis.timeAxis[index]);
    const requestedLifetimes = Array.isArray(options.lifetimes) ? options.lifetimes.map(Number) : [];
    const initialLifetimes = normalizeFitLifetimes(fitTimes, count, irfFwhm, requestedLifetimes);
    const hasExplicitFixedMask = Array.isArray(options.fixedLifetimes);
    const fixedMask = Array.from({ length: count }, (_, index) => {
      const hasValue = Number.isFinite(requestedLifetimes[index]) && requestedLifetimes[index] > 0;
      return hasValue && (hasExplicitFixedMask ? Boolean(options.fixedLifetimes[index]) : true);
    });
    const includeIrfArtifact = options.includeIrfArtifact !== false && irfFwhm > 0;
    const optimized = refineGlobalLifetimes(analysis, fitIndexes, fitTimes, initialLifetimes, irfFwhm, fixedMask, { includeIrfArtifact });
    const lifetimes = optimized.lifetimes;
    const hasFixedLifetimes = fixedMask.some(Boolean);
    const irfLimited = lifetimes.map((lifetime) => lifetime <= Math.max(0.001, irfFwhm * 1.05));
    const solved = solveGlobalAmplitudes(analysis, fitIndexes, fitTimes, lifetimes, irfFwhm, { includeIrfArtifact });
    const { amplitudes, artifactAmplitudes, fittedMatrix, residualMatrix, sse, sst, finiteCount } = solved;

    const amplitudeRanges = lifetimes.map((_, componentIndex) => {
      const values = amplitudes.map((row) => row[componentIndex]).filter(Number.isFinite);
      return values.length ? { min: Math.min(...values), max: Math.max(...values) } : { min: Number.NaN, max: Number.NaN };
    });
    const dasSpectra = buildDasSpectra(analysis.spectralAxis, lifetimes, amplitudes);
    const easSpectra = buildSequentialEasSpectra(analysis.spectralAxis, lifetimes, amplitudes);

    return {
      model: "global-exponential-preview",
      componentCount: count,
      irfFwhm,
      preZeroModel: "wavelength-dependent constant offset",
      lifetimeBasis: hasFixedLifetimes ? "nonlinear refined with user-fixed components" : "nonlinear globally refined",
      lifetimeIterations: optimized.iterations,
      lifetimeRmseStart: optimized.startRmse,
      fixedLifetimes: fixedMask,
      irfLimited,
      irfArtifactModel: includeIrfArtifact ? "wavelength-dependent Gaussian time-zero term" : "off",
      lifetimes,
      amplitudes,
      artifactAmplitudes,
      amplitudeRanges,
      dasSpectra,
      easSpectra,
      fittedMatrix,
      residualMatrix,
      fitPointCount: finiteCount,
      rmse: finiteCount ? Math.sqrt(sse / finiteCount) : Number.NaN,
      explainedVariance: sst > 0 ? 1 - sse / sst : Number.NaN,
    };
  }

  function refineGlobalLifetimes(analysis, fitIndexes, fitTimes, initialLifetimes, irfFwhm, fixedMask, options = {}) {
    const minimum = estimateLifetimeLowerBound(fitTimes);
    let lifetimes = enforceLifetimeOrder(initialLifetimes, minimum, fixedMask);
    let score = solveGlobalAmplitudes(analysis, fitIndexes, fitTimes, lifetimes, irfFwhm, options).rmse;
    const startRmse = score;
    let step = 0.42;
    let iterations = 0;
    const freeIndexes = lifetimes.map((_, index) => index).filter((index) => !fixedMask[index]);
    if (!freeIndexes.length) return { lifetimes, iterations, startRmse };

    while (step > 0.012 && iterations < 90) {
      let improved = false;
      for (const index of freeIndexes) {
        for (const direction of [-1, 1]) {
          const candidate = lifetimes.slice();
          candidate[index] = candidate[index] * Math.exp(direction * step);
          const ordered = enforceLifetimeOrder(candidate, minimum, fixedMask);
          const candidateScore = solveGlobalAmplitudes(analysis, fitIndexes, fitTimes, ordered, irfFwhm, options).rmse;
          if (Number.isFinite(candidateScore) && candidateScore < score * (1 - 1e-5)) {
            lifetimes = ordered;
            score = candidateScore;
            improved = true;
          }
        }
      }
      iterations += 1;
      if (!improved) step *= 0.58;
    }
    return { lifetimes, iterations, startRmse };
  }

  function enforceLifetimeOrder(lifetimes, minimum, fixedMask = []) {
    const ordered = lifetimes.map((value) => Math.max(minimum, Number.isFinite(value) && value > 0 ? value : minimum));
    for (let index = 1; index < ordered.length; index += 1) {
      if (fixedMask[index]) continue;
      const minAllowed = ordered[index - 1] * 1.08;
      if (ordered[index] < minAllowed) ordered[index] = minAllowed;
    }
    return ordered;
  }

  function solveGlobalAmplitudes(analysis, fitIndexes, fitTimes, lifetimes, irfFwhm, options = {}) {
    const count = lifetimes.length;
    const design = buildGlobalFitDesign(fitTimes, lifetimes, irfFwhm, options);
    const parameterCount = design.parameterCount;
    const amplitudes = [];
    const artifactAmplitudes = [];
    const fittedMatrix = analysis.matrix.map((row) => row.map(() => Number.NaN));
    const residualMatrix = analysis.matrix.map((row) => row.map(() => Number.NaN));
    let sse = 0;
    let sst = 0;
    let finiteCount = 0;
    const allValues = [];

    analysis.matrix.forEach((row) => {
      fitIndexes.forEach((index) => {
        const value = row[index];
        if (Number.isFinite(value)) allValues.push(value);
      });
    });
    const meanValue = meanFinite(allValues);

    analysis.matrix.forEach((row, rowIndex) => {
      const y = fitIndexes.map((index) => row[index]);
      const validRows = y
        .map((value, index) => ({ value, basis: design.rows[index], sourceIndex: fitIndexes[index] }))
        .filter((item) => Number.isFinite(item.value));
      const parameters = validRows.length >= parameterCount ? solveLeastSquares(validRows.map((item) => item.basis), validRows.map((item) => item.value), parameterCount) : null;
      const rowAmplitudes = parameters ? parameters.slice(design.componentOffset) : null;
      amplitudes.push(rowAmplitudes ?? Array.from({ length: count }, () => Number.NaN));
      artifactAmplitudes.push(parameters && design.includeIrfArtifact ? parameters[1] : Number.NaN);
      if (!parameters) return;
      validRows.forEach((item) => {
        const fitted = dot(parameters, item.basis);
        const residual = item.value - fitted;
        fittedMatrix[rowIndex][item.sourceIndex] = fitted;
        residualMatrix[rowIndex][item.sourceIndex] = residual;
        sse += residual ** 2;
        sst += (item.value - meanValue) ** 2;
        finiteCount += 1;
      });
    });
    return {
      amplitudes,
      artifactAmplitudes,
      fittedMatrix,
      residualMatrix,
      sse,
      sst,
      finiteCount,
      rmse: finiteCount ? Math.sqrt(sse / finiteCount) : Number.NaN,
      includeIrfArtifact: design.includeIrfArtifact,
    };
  }

  function fitTargetModelCandidates(analysis, options = {}) {
    const lifetimes = (options.lifetimes ?? []).map(Number).filter((value) => Number.isFinite(value) && value > 0);
    const count = Math.max(1, Math.min(6, lifetimes.length));
    if (count < 2) {
      throw new Error("Target-model preview needs at least two components.");
    }

    const fitIndexes = analysis.timeAxis
      .map((time, index) => ({ time, index }))
      .filter((item) => Number.isFinite(item.time) && item.time >= 0)
      .map((item) => item.index);
    if (fitIndexes.length < count + 2) {
      throw new Error("Not enough positive-time points for target-model scoring.");
    }

    const fitTimes = fitIndexes.map((index) => analysis.timeAxis[index]);
    const candidates = buildTargetCandidates(count);
    const scored = candidates
      .map((candidate) => scoreTargetCandidate(analysis, fitIndexes, fitTimes, lifetimes, candidate))
      .filter((candidate) => Number.isFinite(candidate.rmse))
      .sort((a, b) => a.rmse - b.rmse);
    if (!scored.length) {
      throw new Error("No target-model candidate could be scored.");
    }

    return {
      componentCount: count,
      lifetimes,
      candidates: scored,
      best: scored[0],
    };
  }

  function buildAiReadySummary(source, analysis, options = {}) {
    const selectedTimeIndex = clamp(Math.round(Number(options.selectedTimeIndex) || 0), 0, analysis.timeAxis.length - 1);
    const selectedWavelengthIndex = clamp(Math.round(Number(options.selectedWavelengthIndex) || 0), 0, analysis.spectralAxis.length - 1);
    const componentCount = Math.max(1, Math.min(6, Number(options.componentCount) || 3));
    const irfFwhm = Math.max(0, Number(options.irfFwhm) || 0.25);
    const fit = options.fit ?? fitGlobalExponentials(analysis, componentCount, { irfFwhm, lifetimes: options.lifetimes });
    const datasetId = slugify((options.datasetId || source.fileName || "dataset").replace(/\.[^.]+$/, ""));
    const sampleName = options.sampleName || (source.fileName || "Untitled dataset").replace(/\.[^.]+$/, "");
    const selectedSpectrum = analysis.spectralAxis.map((wavelength, rowIndex) => ({
      wavelength_nm: cleanNumber(wavelength),
      signal: cleanNumber(analysis.matrix[rowIndex][selectedTimeIndex]),
    }));
    const selectedKinetics = analysis.timeAxis.map((time, colIndex) => ({
      time_ps: cleanNumber(time),
      signal: cleanNumber(analysis.matrix[selectedWavelengthIndex][colIndex]),
    }));
    const das = summarizeSpectralSet(fit.dasSpectra ?? []);
    const eas = summarizeSpectralSet(fit.easSpectra ?? []);
    const json = {
      schema: "specflowlab.ai_summary.v1",
      project: {
        project_name: options.projectName || sampleName,
        summary_role: "AI-ready spectroscopy context",
      },
      dataset: {
        dataset_id: datasetId,
        sample_name: sampleName,
        sample_note: options.sampleNote || "",
        technique: options.technique || "time-resolved spectroscopy",
        raw_file: source.fileName,
        source_shape: {
          rows: source.sourceShape.rows,
          columns: source.sourceShape.cols,
          spectral_points: source.spectralAxis.length,
          time_points: source.timeAxis.length,
        },
        analysis_shape: {
          spectral_points: analysis.spectralAxis.length,
          time_points: analysis.timeAxis.length,
        },
        units: {
          time: source.metadata["Time units"] || "ps",
          spectral: "nm",
          signal: source.metadata["Z axis title"] || "signal",
        },
      },
      ranges: {
        raw_time_ps: rangeObject(source.timeAxis),
        raw_wavelength_nm: rangeObject(source.spectralAxis),
        selected_time_ps: rangeObject(analysis.timeAxis),
        selected_wavelength_nm: rangeObject(analysis.spectralAxis),
        excluded_regions: analysis.excluded.map((item) => ({ ...item })),
      },
      preprocessing: {
        history: (analysis.provenance ?? []).map((item) => ({ ...item })),
        chirp: analysis.chirp
          ? {
              method: "polynomial dispersion correction",
              polynomial_terms: analysis.chirp.model.coefficients.length,
              fitted_wavelength_range_nm: analysis.chirp.model.sourceRange,
              reference_time_ps: cleanNumber(analysis.chirp.model.referenceTime),
              target_reference_time_ps: cleanNumber(analysis.chirp.model.targetReferenceTime),
              coefficients: analysis.chirp.model.coefficients.map(cleanNumber),
              curve_points: analysis.chirp.curve.map((point) => ({
                wavelength_nm: cleanNumber(point.wavelength),
                shift_ps: cleanNumber(point.shift),
              })),
            }
          : null,
      },
      global_analysis: {
        model: "IRF-convolved global exponential preview",
        prezero_model: fit.preZeroModel || "wavelength-dependent constant offset",
        timezero_artifact_model: fit.irfArtifactModel || "off",
        lifetime_basis: fit.lifetimeBasis || "nonlinear globally refined",
        irf_limited_components: (fit.irfLimited ?? []).map((limited, index) => (limited ? `C${index + 1}` : null)).filter(Boolean),
        caution: "Initial global analysis for AI discussion; lifetimes are nonlinear-refined but target topology is not yet proven.",
        irf_fwhm_ps: cleanNumber(fit.irfFwhm),
        component_count: fit.componentCount,
        lifetimes_ps: fit.lifetimes.map(cleanNumber),
        fit_quality: {
          rmse: cleanNumber(fit.rmse),
          explained_variance: cleanNumber(fit.explainedVariance),
          fit_point_count: fit.fitPointCount,
        },
        amplitude_ranges: fit.amplitudeRanges.map((range, index) => ({
          component: `C${index + 1}`,
          lifetime_ps: cleanNumber(fit.lifetimes[index]),
          min: cleanNumber(range.min),
          max: cleanNumber(range.max),
        })),
        DAS: das,
        EAS: eas,
      },
      selected_evidence: {
        spectrum: {
          time_ps: cleanNumber(analysis.timeAxis[selectedTimeIndex]),
          reason: "Current selected time row in SpecFlowLab.",
          points: selectedSpectrum,
        },
        kinetics: {
          wavelength_nm: cleanNumber(analysis.spectralAxis[selectedWavelengthIndex]),
          reason: "Current selected wavelength column in SpecFlowLab.",
          points: selectedKinetics,
        },
      },
      ai_handoff: {
        recommended_prompt: [
          "Please evaluate possible kinetic target models using this SpecFlowLab summary.",
          "Do not assume RMSE alone proves a target topology.",
          "Use preprocessing history, lifetimes, DAS/EAS, selected spectra, selected kinetics, and uncertainty notes.",
        ],
        uncertainty_notes: buildUncertaintyNotes(fit, analysis),
        suggested_next_tasks: [
          "Check whether IRF-limited components are physically meaningful.",
          "Compare DAS and EAS signs, peak regions, and decay-associated features.",
          "Propose target matrices but mark underdetermined alternatives.",
          "Ask what multi-dataset constraints would distinguish sequential, branched, and parallel models.",
        ],
      },
    };

    return {
      json,
      markdown: buildAiSummaryMarkdown(json),
    };
  }

  function buildAiReadyProjectSummary(datasets, options = {}) {
    const summaries = datasets.map((dataset, index) => buildAiReadySummary(dataset.source, dataset.analysis, {
      ...options,
      fit: dataset.fit,
      datasetId: dataset.id || dataset.source.fileName || `dataset_${index + 1}`,
      sampleName: dataset.projectLabel || (dataset.source.fileName || `Dataset ${index + 1}`).replace(/\.[^.]+$/, ""),
      sampleNote: dataset.sampleNote || "",
      selectedTimeIndex: dataset.selectedTimeIndex ?? options.selectedTimeIndex ?? 0,
      selectedWavelengthIndex: dataset.selectedWavelengthIndex ?? options.selectedWavelengthIndex ?? 0,
    }));
    const json = {
      schema: "specflowlab.ai_project_summary.v1",
      project: {
        project_name: options.projectName || "SpecFlowLab project",
        dataset_count: summaries.length,
        summary_role: "AI-ready multi-dataset spectroscopy context",
      },
      datasets: summaries.map((summary) => summary.json),
      cross_dataset: {
        lifetime_table: summaries.map((summary) => ({
          dataset_id: summary.json.dataset.dataset_id,
          sample_name: summary.json.dataset.sample_name,
          lifetimes_ps: summary.json.global_analysis.lifetimes_ps,
          lifetime_basis: summary.json.global_analysis.lifetime_basis,
          irf_limited_components: summary.json.global_analysis.irf_limited_components,
          rmse: summary.json.global_analysis.fit_quality.rmse,
          explained_variance: summary.json.global_analysis.fit_quality.explained_variance,
        })),
        notes: [
          "Shared range and preprocessing controls were applied at project level.",
          "Repeated lifetime values across datasets may indicate shared kinetics, but should be checked against residuals, DAS/EAS features, and target-model constraints.",
          "An IRF-limited first component should be treated as unresolved around time zero.",
          "Compare lifetimes, DAS/EAS features, and selected kinetics across datasets before proposing target models.",
          "Treat near-identical target-model RMSE values as underdetermined unless additional constraints are supplied.",
        ],
      },
    };
    return {
      json,
      markdown: buildAiProjectSummaryMarkdown(json),
    };
  }

  function parseCell(cell) {
    if (cell === "" || cell.toLowerCase() === "nan") return Number.NaN;
    return Number(cell);
  }

  function summarizeSpectralSet(spectra) {
    return spectra.map((spectrum, index) => {
      const points = spectrum.x.map((x, pointIndex) => ({
        wavelength_nm: cleanNumber(x),
        signal: cleanNumber(spectrum.y[pointIndex]),
      }));
      return {
        component: spectrum.label || `C${index + 1}`,
        lifetime_ps: cleanNumber(spectrum.lifetime),
        features: extractSpectralFeatures(spectrum.x, spectrum.y),
        points,
      };
    });
  }

  function extractSpectralFeatures(xValues, yValues) {
    const finite = xValues
      .map((x, index) => ({ x, y: yValues[index] }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!finite.length) {
      return {
        max_positive: null,
        max_negative: null,
        zero_crossings_nm: [],
      };
    }
    const maxPositive = finite.reduce((best, point) => (point.y > best.y ? point : best), finite[0]);
    const maxNegative = finite.reduce((best, point) => (point.y < best.y ? point : best), finite[0]);
    const zeroCrossings = [];
    for (let index = 1; index < finite.length; index += 1) {
      const previous = finite[index - 1];
      const current = finite[index];
      if (previous.y === 0 || current.y === 0 || Math.sign(previous.y) !== Math.sign(current.y)) {
        const denominator = Math.abs(previous.y) + Math.abs(current.y);
        const fraction = denominator > 0 ? Math.abs(previous.y) / denominator : 0;
        zeroCrossings.push(cleanNumber(previous.x + (current.x - previous.x) * fraction));
      }
    }
    return {
      max_positive: maxPositive.y > 0 ? { wavelength_nm: cleanNumber(maxPositive.x), signal: cleanNumber(maxPositive.y) } : null,
      max_negative: maxNegative.y < 0 ? { wavelength_nm: cleanNumber(maxNegative.x), signal: cleanNumber(maxNegative.y) } : null,
      zero_crossings_nm: zeroCrossings.slice(0, 8),
    };
  }

  function buildUncertaintyNotes(fit, analysis) {
    const notes = [
      "Global exponential analysis is a preview used to prepare target-model discussion.",
      "Target-model topology should not be selected by RMSE alone.",
    ];
    if (fit.lifetimes.some((lifetime) => lifetime <= Math.max(0.001, fit.irfFwhm * 1.25))) {
      notes.push("At least one lifetime is close to the IRF; an IRF-clamped component should not be interpreted as a resolved species lifetime.");
    }
    if (Number.isFinite(fit.lifetimeRmseStart) && fit.rmse < fit.lifetimeRmseStart) {
      notes.push(`Nonlinear lifetime refinement improved RMSE from ${format(fit.lifetimeRmseStart)} to ${format(fit.rmse)}.`);
    }
    if ((analysis.provenance ?? []).some((item) => item.status === "skipped")) {
      notes.push("At least one preprocessing step was skipped; inspect processing history before interpretation.");
    }
    if (!analysis.chirp) {
      notes.push("No chirp correction model is recorded for the current analysis dataset.");
    }
    return notes;
  }

  function buildAiSummaryMarkdown(summary) {
    const dataset = summary.dataset;
    const ranges = summary.ranges;
    const fit = summary.global_analysis;
    const selected = summary.selected_evidence;
    const preprocessingRows = summary.preprocessing.history.length
      ? summary.preprocessing.history.map((item) => `| ${item.label} | ${item.status} | ${item.model ?? ""} | ${item.range ?? ""} |`).join("\n")
      : "| None | - | - | - |";
    const lifetimeRows = fit.lifetimes_ps.map((lifetime, index) => {
      const range = fit.amplitude_ranges[index];
      return `| C${index + 1} | ${format(lifetime)} | ${format(range?.min)} to ${format(range?.max)} |`;
    }).join("\n");
    const dasRows = fit.DAS.map((component) => spectralFeatureMarkdownRow(component)).join("\n");
    const easRows = fit.EAS.map((component) => spectralFeatureMarkdownRow(component)).join("\n");
    const notes = summary.ai_handoff.uncertainty_notes.map((note) => `- ${note}`).join("\n");
    const promptLines = summary.ai_handoff.recommended_prompt.map((line) => `> ${line}`).join("\n");

    return `# SpecFlowLab AI-Ready Summary: ${dataset.sample_name}

## Dataset

- Dataset ID: \`${dataset.dataset_id}\`
- Sample: ${dataset.sample_name}
- Sample note: ${dataset.sample_note || "Not provided"}
- Technique: ${dataset.technique}
- Raw file: \`${dataset.raw_file}\`
- Source shape: ${dataset.source_shape.spectral_points} wavelengths x ${dataset.source_shape.time_points} time points
- Analysis shape: ${dataset.analysis_shape.spectral_points} wavelengths x ${dataset.analysis_shape.time_points} time points
- Units: time = ${dataset.units.time}, spectral = ${dataset.units.spectral}, signal = ${dataset.units.signal}

## Selected Range

- Raw time range: ${format(ranges.raw_time_ps.min)} to ${format(ranges.raw_time_ps.max)} ps
- Raw wavelength range: ${format(ranges.raw_wavelength_nm.min)} to ${format(ranges.raw_wavelength_nm.max)} nm
- Analysis time range: ${format(ranges.selected_time_ps.min)} to ${format(ranges.selected_time_ps.max)} ps
- Analysis wavelength range: ${format(ranges.selected_wavelength_nm.min)} to ${format(ranges.selected_wavelength_nm.max)} nm

## Preprocessing

| Step | Status | Model | Range |
| --- | --- | --- | --- |
${preprocessingRows}

## Initial Global Analysis

- Model: ${fit.model}
- Lifetime basis: ${fit.lifetime_basis}
- IRF-limited components: ${fit.irf_limited_components.length ? fit.irf_limited_components.join(", ") : "None"}
- IRF FWHM: ${format(fit.irf_fwhm_ps)} ps
- Components: ${fit.component_count}
- RMSE: ${format(fit.fit_quality.rmse)}
- Explained variance: ${Number.isFinite(fit.fit_quality.explained_variance) ? `${(fit.fit_quality.explained_variance * 100).toFixed(1)}%` : "-"}

| Component | Lifetime (ps) | Amplitude range |
| --- | ---: | --- |
${lifetimeRows}

## DAS Features

| Component | Lifetime (ps) | Max positive | Max negative |
| --- | ---: | --- | --- |
${dasRows}

## EAS Features

| Component | Lifetime (ps) | Max positive | Max negative |
| --- | ---: | --- | --- |
${easRows}

## Selected Evidence

- Selected spectrum: t = ${format(selected.spectrum.time_ps)} ps (${selected.spectrum.points.length} points in JSON)
- Selected kinetics: wavelength = ${format(selected.kinetics.wavelength_nm)} nm (${selected.kinetics.points.length} points in JSON)

## Uncertainty Notes

${notes}

## AI Handoff Prompt

${promptLines}
${embeddedJsonMarkdown(summary)}
`;
  }

  function buildAiProjectSummaryMarkdown(projectSummary) {
    const rows = projectSummary.cross_dataset.lifetime_table
      .map((item) => `| ${item.dataset_id} | ${item.sample_name} | ${item.lifetimes_ps.map(format).join(", ")} | ${item.lifetime_basis} | ${item.irf_limited_components.join(", ") || "-"} | ${format(item.rmse)} | ${Number.isFinite(item.explained_variance) ? `${(item.explained_variance * 100).toFixed(1)}%` : "-"} |`)
      .join("\n");
    const datasetSections = projectSummary.datasets.map((dataset) => {
      const fit = dataset.global_analysis;
      return `## Dataset: ${dataset.dataset.sample_name}

- Dataset ID: \`${dataset.dataset.dataset_id}\`
- Raw file: \`${dataset.dataset.raw_file}\`
- Sample note: ${dataset.dataset.sample_note || "Not provided"}
- Analysis shape: ${dataset.dataset.analysis_shape.spectral_points} wavelengths x ${dataset.dataset.analysis_shape.time_points} time points
- Selected range: ${format(dataset.ranges.selected_wavelength_nm.min)} to ${format(dataset.ranges.selected_wavelength_nm.max)} nm; ${format(dataset.ranges.selected_time_ps.min)} to ${format(dataset.ranges.selected_time_ps.max)} ps
- Lifetimes: ${fit.lifetimes_ps.map(format).join(", ")} ps
- Fit quality: RMSE ${format(fit.fit_quality.rmse)}, explained ${Number.isFinite(fit.fit_quality.explained_variance) ? `${(fit.fit_quality.explained_variance * 100).toFixed(1)}%` : "-"}
`;
    }).join("\n");
    const notes = projectSummary.cross_dataset.notes.map((note) => `- ${note}`).join("\n");
    return `# SpecFlowLab AI-Ready Project Summary

- Project: ${projectSummary.project.project_name}
- Dataset count: ${projectSummary.project.dataset_count}
- Role: ${projectSummary.project.summary_role}

## Cross-Dataset Lifetime Table

| Dataset | Sample | Lifetimes (ps) | Basis | IRF-limited | RMSE | Explained |
| --- | --- | --- | --- | --- | ---: | ---: |
${rows}

## Cross-Dataset Notes

${notes}

${datasetSections}

${embeddedJsonMarkdown(projectSummary)}
`;
  }

  function embeddedJsonMarkdown(payload) {
    return `## Complete Structured JSON

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;
  }

  function spectralFeatureMarkdownRow(component) {
    const features = component.features;
    const positive = features.max_positive ? `${format(features.max_positive.wavelength_nm)} nm / ${format(features.max_positive.signal)}` : "-";
    const negative = features.max_negative ? `${format(features.max_negative.wavelength_nm)} nm / ${format(features.max_negative.signal)}` : "-";
    return `| ${component.component} | ${format(component.lifetime_ps)} | ${positive} | ${negative} |`;
  }

  function rangeObject(values) {
    const finite = values.filter(Number.isFinite);
    return finite.length ? { min: cleanNumber(finite[0]), max: cleanNumber(finite.at(-1)) } : { min: null, max: null };
  }

  function cleanNumber(value) {
    return Number.isFinite(value) ? Number(value.toPrecision(10)) : null;
  }

  function slugify(value) {
    return String(value || "dataset")
      .trim()
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      || "dataset";
  }

  function estimateLifetimeGrid(times, count, irfFwhm = 0) {
    const positive = times.filter((time) => time > 0);
    const min = Math.max(positive[0] ?? 0.1, 0.1);
    const max = Math.max(positive.at(-1) ?? min * 10, min * 10);
    if (count === 1) return [Math.sqrt(min * max)];
    return Array.from({ length: count }, (_, index) => min * (max / min) ** (index / (count - 1)));
  }

  function normalizeFitLifetimes(times, count, irfFwhm, requested) {
    const minimum = estimateLifetimeLowerBound(times);
    const defaults = estimateLifetimeGrid(times, count, minimum);
    const provided = Array.isArray(requested) ? requested.map(Number) : [];
    return Array.from({ length: count }, (_, index) => {
      const value = provided[index];
      const fallback = defaults[index] ?? defaults.at(-1) ?? minimum;
      return Math.max(minimum, Number.isFinite(value) && value > 0 ? value : fallback);
    });
  }

  function estimateLifetimeLowerBound(times) {
    const positive = times.filter((time) => Number.isFinite(time) && time > 0).sort((a, b) => a - b);
    const spacings = positive
      .slice(1)
      .map((time, index) => time - positive[index])
      .filter((spacing) => Number.isFinite(spacing) && spacing > 0);
    const firstPositive = positive[0];
    const minSpacing = spacings.length ? Math.min(...spacings) : Number.NaN;
    const sampleFloor = Math.min(
      Number.isFinite(firstPositive) ? firstPositive * 0.5 : Infinity,
      Number.isFinite(minSpacing) ? minSpacing * 0.5 : Infinity,
    );
    return Math.max(0.003, Number.isFinite(sampleFloor) ? sampleFloor : 0.01);
  }

  function buildTargetCandidates(count) {
    const candidates = [];
    candidates.push({
      name: "Sequential",
      transfers: Array.from({ length: count - 1 }, (_, index) => ({ from: index, to: index + 1, fraction: 1 })),
    });
    candidates.push({
      name: "Sequential + loss",
      transfers: Array.from({ length: count - 1 }, (_, index) => ({ from: index, to: index + 1, fraction: 0.7 })),
    });

    if (count >= 3) {
      candidates.push({
        name: "Early branch",
        transfers: [
          { from: 0, to: 1, fraction: 0.5 },
          { from: 0, to: 2, fraction: 0.5 },
          ...Array.from({ length: Math.max(0, count - 3) }, (_, index) => ({ from: index + 2, to: index + 3, fraction: 1 })),
        ],
      });
      candidates.push({
        name: "Branch + loss",
        transfers: [
          { from: 0, to: 1, fraction: 0.35 },
          { from: 0, to: 2, fraction: 0.35 },
          ...Array.from({ length: Math.max(0, count - 3) }, (_, index) => ({ from: index + 2, to: index + 3, fraction: 0.7 })),
        ],
      });
    }

    if (count >= 4) {
      candidates.push({
        name: "Converging branch",
        transfers: [
          { from: 0, to: 1, fraction: 0.5 },
          { from: 0, to: 2, fraction: 0.5 },
          { from: 1, to: 3, fraction: 1 },
          { from: 2, to: 3, fraction: 1 },
          ...Array.from({ length: Math.max(0, count - 4) }, (_, index) => ({ from: index + 3, to: index + 4, fraction: 1 })),
        ],
      });
      candidates.push({
        name: "Delayed branch",
        transfers: [
          { from: 0, to: 1, fraction: 1 },
          { from: 1, to: 2, fraction: 0.5 },
          { from: 1, to: 3, fraction: 0.5 },
          ...Array.from({ length: Math.max(0, count - 4) }, (_, index) => ({ from: index + 3, to: index + 4, fraction: 1 })),
        ],
      });
    }

    return candidates.map((candidate) => ({
      ...candidate,
      matrix: buildTransferMatrix(count, candidate.transfers),
    }));
  }

  function buildTransferMatrix(count, transfers) {
    const matrix = Array.from({ length: count }, () => Array.from({ length: count }, () => 0));
    transfers.forEach((transfer) => {
      if (transfer.from >= 0 && transfer.from < count && transfer.to >= 0 && transfer.to < count && transfer.to !== transfer.from) {
        matrix[transfer.from][transfer.to] += transfer.fraction;
      }
    });
    return matrix.map((row) => {
      const total = row.reduce((sum, value) => sum + Math.max(0, value), 0);
      return row.map((value) => (total > 1 ? value / total : Math.max(0, value)));
    });
  }

  function scoreTargetCandidate(analysis, fitIndexes, fitTimes, lifetimes, candidate) {
    const concentrations = buildTargetConcentrations(fitTimes, lifetimes, candidate.matrix);
    const count = lifetimes.length;
    const spectra = [];
    const fittedMatrix = analysis.matrix.map((row) => row.map(() => Number.NaN));
    const residualMatrix = analysis.matrix.map((row) => row.map(() => Number.NaN));
    let sse = 0;
    let sst = 0;
    let finiteCount = 0;
    const allValues = [];

    analysis.matrix.forEach((row) => {
      fitIndexes.forEach((index) => {
        const value = row[index];
        if (Number.isFinite(value)) allValues.push(value);
      });
    });
    const meanValue = meanFinite(allValues);

    analysis.matrix.forEach((row, rowIndex) => {
      const y = fitIndexes.map((index) => row[index]);
      const validRows = y
        .map((value, index) => ({ value, basis: concentrations[index], sourceIndex: fitIndexes[index] }))
        .filter((item) => Number.isFinite(item.value));
      const spectrum = validRows.length >= count ? solveLeastSquares(validRows.map((item) => item.basis), validRows.map((item) => item.value), count) : null;
      spectra.push(spectrum ?? Array.from({ length: count }, () => Number.NaN));

      if (!spectrum) return;
      validRows.forEach((item) => {
        const fitted = dot(spectrum, item.basis);
        const residual = item.value - fitted;
        fittedMatrix[rowIndex][item.sourceIndex] = fitted;
        residualMatrix[rowIndex][item.sourceIndex] = residual;
        sse += residual ** 2;
        sst += (item.value - meanValue) ** 2;
        finiteCount += 1;
      });
    });

    return {
      name: candidate.name,
      matrix: candidate.matrix,
      concentrations,
      spectra: buildTargetSpectra(analysis.spectralAxis, lifetimes, spectra),
      fittedMatrix,
      residualMatrix,
      fitPointCount: finiteCount,
      rmse: finiteCount ? Math.sqrt(sse / finiteCount) : Number.NaN,
      explainedVariance: sst > 0 ? 1 - sse / sst : Number.NaN,
    };
  }

  function buildTargetConcentrations(times, lifetimes, transferMatrix) {
    const count = lifetimes.length;
    const concentrations = [];
    let current = Array.from({ length: count }, (_, index) => (index === 0 ? 1 : 0));
    let previousTime = 0;
    times.forEach((time) => {
      const targetTime = Math.max(0, time);
      current = advanceTargetPopulation(current, previousTime, targetTime, lifetimes, transferMatrix);
      concentrations.push(current.slice());
      previousTime = targetTime;
    });
    return concentrations;
  }

  function advanceTargetPopulation(start, fromTime, toTime, lifetimes, transferMatrix) {
    const span = Math.max(0, toTime - fromTime);
    if (span === 0) return start.slice();
    const minLifetime = Math.max(0.001, Math.min(...lifetimes.filter(Number.isFinite)));
    const steps = Math.max(1, Math.min(64, Math.ceil(span / Math.max(minLifetime / 3, 0.01))));
    const dt = span / steps;
    let state = start.slice();
    for (let step = 0; step < steps; step += 1) {
      state = rk4TargetStep(state, dt, lifetimes, transferMatrix);
    }
    return state.map((value) => (Math.abs(value) < 1e-14 ? 0 : value));
  }

  function rk4TargetStep(state, dt, lifetimes, transferMatrix) {
    const k1 = targetDerivative(state, lifetimes, transferMatrix);
    const k2 = targetDerivative(state.map((value, index) => value + (dt * k1[index]) / 2), lifetimes, transferMatrix);
    const k3 = targetDerivative(state.map((value, index) => value + (dt * k2[index]) / 2), lifetimes, transferMatrix);
    const k4 = targetDerivative(state.map((value, index) => value + dt * k3[index]), lifetimes, transferMatrix);
    return state.map((value, index) => Math.max(0, value + (dt / 6) * (k1[index] + 2 * k2[index] + 2 * k3[index] + k4[index])));
  }

  function targetDerivative(state, lifetimes, transferMatrix) {
    const next = state.map((value, index) => -value / lifetimes[index]);
    state.forEach((population, from) => {
      const rate = population / lifetimes[from];
      transferMatrix[from].forEach((fraction, to) => {
        if (fraction > 0) next[to] += rate * fraction;
      });
    });
    return next;
  }

  function buildTargetSpectra(spectralAxis, lifetimes, spectraByWavelength) {
    return lifetimes.map((lifetime, componentIndex) => ({
      label: `SADS ${componentIndex + 1}`,
      lifetime,
      x: spectralAxis.slice(),
      y: spectraByWavelength.map((values) => values[componentIndex]),
    }));
  }

  function buildDasSpectra(spectralAxis, lifetimes, amplitudes) {
    return lifetimes.map((lifetime, componentIndex) => ({
      label: `DAS ${componentIndex + 1}`,
      lifetime,
      x: spectralAxis.slice(),
      y: amplitudes.map((row) => row[componentIndex]),
    }));
  }

  function buildSequentialEasSpectra(spectralAxis, lifetimes, amplitudes) {
    const coefficients = sequentialConcentrationCoefficients(lifetimes);
    if (!coefficients) return [];
    const valuesByWavelength = amplitudes.map((dasValues) => solveUpperTriangularDdas(coefficients, dasValues));
    return lifetimes.map((lifetime, componentIndex) => ({
      label: `EAS ${componentIndex + 1}`,
      lifetime,
      x: spectralAxis.slice(),
      y: valuesByWavelength.map((values) => values[componentIndex]),
    }));
  }

  function sequentialConcentrationCoefficients(lifetimes) {
    const rates = lifetimes.map((lifetime) => (lifetime > 0 ? 1 / lifetime : Number.NaN));
    if (rates.some((rate) => !Number.isFinite(rate))) return null;
    const coefficients = lifetimes.map((_, speciesIndex) => Array.from({ length: lifetimes.length }, () => 0));
    for (let species = 0; species < lifetimes.length; species += 1) {
      let numerator = 1;
      for (let index = 0; index < species; index += 1) numerator *= rates[index];
      for (let exponent = 0; exponent <= species; exponent += 1) {
        let denominator = 1;
        for (let index = 0; index <= species; index += 1) {
          if (index !== exponent) denominator *= rates[index] - rates[exponent];
        }
        if (Math.abs(denominator) < 1e-12) return null;
        coefficients[species][exponent] = numerator / denominator;
      }
    }
    return coefficients;
  }

  function solveUpperTriangularDdas(coefficients, dasValues) {
    const count = dasValues.length;
    const eas = Array.from({ length: count }, () => Number.NaN);
    for (let row = count - 1; row >= 0; row -= 1) {
      let remainder = dasValues[row];
      for (let col = row + 1; col < count; col += 1) {
        remainder -= coefficients[col][row] * eas[col];
      }
      const diagonal = coefficients[row][row];
      eas[row] = Math.abs(diagonal) > 1e-12 ? remainder / diagonal : Number.NaN;
    }
    return eas;
  }

  function buildIrfConvolvedDesign(times, lifetimes, irfFwhm) {
    if (!(irfFwhm > 0)) {
      return times.map((time) => lifetimes.map((lifetime) => Math.exp(-time / lifetime)));
    }
    const sigma = irfFwhm / 2.354820045;
    const kernelRadius = Math.max(irfFwhm * 3, sigma * 6);
    return times.map((time) =>
      lifetimes.map((lifetime) => convolvedExponentialAt(time, lifetime, sigma, kernelRadius)),
    );
  }

  function buildGlobalFitDesign(times, lifetimes, irfFwhm, options = {}) {
    const kinetic = buildIrfConvolvedDesign(times, lifetimes, irfFwhm);
    const includeIrfArtifact = options.includeIrfArtifact !== false && irfFwhm > 0;
    const sigma = irfFwhm > 0 ? irfFwhm / 2.354820045 : 0;
    const rows = times.map((time, index) => {
      const constant = time < 0 ? 1 : 0;
      const artifact = includeIrfArtifact ? Math.exp(-(time ** 2) / (2 * sigma ** 2)) : null;
      return includeIrfArtifact ? [constant, artifact, ...kinetic[index]] : [constant, ...kinetic[index]];
    });
    return {
      rows,
      includeIrfArtifact,
      componentOffset: includeIrfArtifact ? 2 : 1,
      parameterCount: lifetimes.length + (includeIrfArtifact ? 2 : 1),
    };
  }

  function convolvedExponentialAt(time, lifetime, sigma, radius) {
    const steps = 48;
    const start = -radius;
    const end = radius;
    const step = (end - start) / steps;
    let weighted = 0;
    let weightSum = 0;
    for (let index = 0; index <= steps; index += 1) {
      const offset = start + step * index;
      const sourceTime = time - offset;
      const response = sourceTime >= 0 ? Math.exp(-sourceTime / lifetime) : 0;
      const weight = Math.exp(-(offset ** 2) / (2 * sigma ** 2));
      weighted += response * weight;
      weightSum += weight;
    }
    return weightSum > 0 ? weighted / weightSum : 0;
  }

  function solveLeastSquares(design, values, degree) {
    const normal = Array.from({ length: degree }, () => Array.from({ length: degree }, () => 0));
    const rhs = Array.from({ length: degree }, () => 0);
    design.forEach((basis, rowIndex) => {
      for (let row = 0; row < degree; row += 1) {
        rhs[row] += basis[row] * values[rowIndex];
        for (let col = 0; col < degree; col += 1) {
          normal[row][col] += basis[row] * basis[col];
        }
      }
    });
    return solveLinearSystem(normal, rhs);
  }

  function dot(a, b) {
    return a.reduce((sum, value, index) => sum + value * b[index], 0);
  }

  function formatCsvCell(value) {
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NaN";
    const text = String(value ?? "");
    if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
    return text;
  }

  function parseMetadata(rows) {
    const metadata = {};
    rows.forEach((row) => {
      const separator = row.text.indexOf(":");
      if (separator > -1) {
        const key = row.text.slice(0, separator).trim();
        const value = row.text.slice(separator + 1).trim();
        if (key) metadata[key] = value;
      }
    });
    return metadata;
  }

  function finiteFraction(values) {
    if (values.length === 0) return 0;
    return values.filter(Number.isFinite).length / values.length;
  }

  function fallbackLeadingIndexes(length) {
    if (length <= 0) return [];
    return Array.from({ length: Math.max(1, Math.floor(length * 0.05)) }, (_, index) => index);
  }

  function meanFinite(values) {
    const finite = values.filter(Number.isFinite);
    if (finite.length === 0) return Number.NaN;
    return finite.reduce((sum, value) => sum + value, 0) / finite.length;
  }

  function median(values) {
    const finite = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (finite.length === 0) return Number.NaN;
    const middle = Math.floor(finite.length / 2);
    return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
  }

  function estimateDatasetTimeZero(analysis) {
    const earlyIndexes = findEarlySignalIndexes(analysis.timeAxis);
    if (earlyIndexes.length < 4) return Number.NaN;
    const anchors = analysis.matrix
      .map((row) => estimateRowTimeZero(row, analysis.timeAxis, earlyIndexes))
      .filter((anchor) => Number.isFinite(anchor.time) && anchor.weight > 0);
    if (anchors.length < Math.max(8, analysis.spectralAxis.length * 0.15)) return Number.NaN;
    return weightedMedian(anchors.map((anchor) => anchor.time), anchors.map((anchor) => anchor.weight));
  }

  function fitPolynomialDispersion(analysis) {
    const earlyIndexes = findEarlySignalIndexes(analysis.timeAxis);
    if (earlyIndexes.length < 4 || analysis.spectralAxis.length < 8) return null;

    const anchors = analysis.matrix.map((row, rowIndex) => {
      const anchor = estimateRowTimeZero(row, analysis.timeAxis, earlyIndexes);
      return {
        wavelength: analysis.spectralAxis[rowIndex],
        anchor: anchor.time,
        weight: anchor.weight,
      };
    });
    const usable = anchors.filter((item) => Number.isFinite(item.wavelength) && Number.isFinite(item.anchor) && item.weight > 0);
    if (usable.length < Math.max(8, analysis.spectralAxis.length * 0.2)) return null;

    const referenceWavelength = median(usable.map((item) => item.wavelength));
    const referenceTime = weightedMedian(usable.map((item) => item.anchor), usable.map((item) => item.weight));
    const maxShift = estimateMaxChirpShift(analysis.timeAxis);
    let samples = usable.map((item) => ({
      x: (item.wavelength - referenceWavelength) / 100,
      y: clamp(item.anchor - referenceTime, -maxShift, maxShift),
      weight: item.weight,
    }));

    let coefficients = [0, 0, 0];
    for (let pass = 0; pass < 3; pass += 1) {
      coefficients = solveWeightedPolynomial(samples, 3);
      if (!coefficients) return null;
      const residuals = samples.map((sample) => sample.y - evaluatePolynomial(coefficients, sample.x));
      const scale = median(residuals.map(Math.abs)) || 1e-12;
      samples = samples.filter((sample, index) => Math.abs(residuals[index]) <= scale * 4.5);
      if (samples.length < 8) return null;
    }

    return {
      referenceWavelength,
      referenceTime,
      coefficients,
      maxShift,
      sourceRange: {
        min: analysis.spectralAxis[0],
        max: analysis.spectralAxis.at(-1),
      },
    };
  }

  function findEarlySignalIndexes(timeAxis) {
    const finiteTimes = timeAxis.filter(Number.isFinite);
    if (finiteTimes.length === 0) return [];
    const positive = finiteTimes.filter((time) => time > 0);
    const positiveLimit = positive.length ? Math.min(8, positive[Math.max(0, Math.floor(positive.length * 0.16))]) : finiteTimes.at(-1);
    return timeAxis
      .map((time, index) => ({ time, index }))
      .filter((item) => Number.isFinite(item.time) && item.time <= positiveLimit)
      .map((item) => item.index);
  }

  function estimateRowTimeZero(row, timeAxis, indexes) {
    let best = { time: Number.NaN, weight: 0 };
    for (let position = 1; position < indexes.length; position += 1) {
      const previousIndex = indexes[position - 1];
      const currentIndex = indexes[position];
      const previousValue = row[previousIndex];
      const currentValue = row[currentIndex];
      const previousTime = timeAxis[previousIndex];
      const currentTime = timeAxis[currentIndex];
      if (!Number.isFinite(previousValue) || !Number.isFinite(currentValue) || !Number.isFinite(previousTime) || !Number.isFinite(currentTime)) continue;
      const dt = currentTime - previousTime;
      if (!(dt > 0)) continue;
      const slope = Math.abs((currentValue - previousValue) / dt);
      if (slope > best.weight) {
        best = { time: currentTime, weight: slope };
      }
    }
    return best;
  }

  function estimateMaxChirpShift(timeAxis) {
    const finite = timeAxis.filter(Number.isFinite);
    if (finite.length < 2) return 0;
    const positive = finite.filter((time) => time > 0);
    const earlyEnd = positive.length ? Math.min(8, positive[Math.max(0, Math.floor(positive.length * 0.16))]) : finite[Math.min(finite.length - 1, 8)];
    const earlyStart = finite[0];
    return Math.max(0.2, Math.min(5, Math.abs(earlyEnd - earlyStart) * 0.35));
  }

  function evaluateDispersion(model, wavelength) {
    const x = (wavelength - model.referenceWavelength) / 100;
    return clamp(evaluatePolynomial(model.coefficients, x), -model.maxShift, model.maxShift);
  }

  function evaluatePolynomial(coefficients, x) {
    return coefficients.reduce((sum, coefficient, index) => sum + coefficient * x ** (index + 1), 0);
  }

  function solveWeightedPolynomial(samples, degree) {
    const normal = Array.from({ length: degree }, () => Array.from({ length: degree }, () => 0));
    const rhs = Array.from({ length: degree }, () => 0);
    samples.forEach((sample) => {
      const powers = Array.from({ length: degree }, (_, index) => sample.x ** (index + 1));
      const weight = Math.max(sample.weight, 1e-12);
      for (let row = 0; row < degree; row += 1) {
        rhs[row] += weight * powers[row] * sample.y;
        for (let col = 0; col < degree; col += 1) {
          normal[row][col] += weight * powers[row] * powers[col];
        }
      }
    });
    return solveLinearSystem(normal, rhs);
  }

  function solveLinearSystem(matrix, vector) {
    const n = vector.length;
    const a = matrix.map((row, index) => row.concat(vector[index]));
    for (let col = 0; col < n; col += 1) {
      let pivot = col;
      for (let row = col + 1; row < n; row += 1) {
        if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
      }
      if (Math.abs(a[pivot][col]) < 1e-12) return null;
      [a[col], a[pivot]] = [a[pivot], a[col]];
      const divisor = a[col][col];
      for (let j = col; j <= n; j += 1) a[col][j] /= divisor;
      for (let row = 0; row < n; row += 1) {
        if (row === col) continue;
        const factor = a[row][col];
        for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
      }
    }
    return a.map((row) => row[n]);
  }

  function weightedMedian(values, weights) {
    const pairs = values
      .map((value, index) => ({ value, weight: weights[index] }))
      .filter((item) => Number.isFinite(item.value) && Number.isFinite(item.weight) && item.weight > 0)
      .sort((a, b) => a.value - b.value);
    if (pairs.length === 0) return Number.NaN;
    const total = pairs.reduce((sum, item) => sum + item.weight, 0);
    let cumulative = 0;
    for (const pair of pairs) {
      cumulative += pair.weight;
      if (cumulative >= total / 2) return pair.value;
    }
    return pairs.at(-1).value;
  }

  function interpolateAt(xValues, yValues, target) {
    if (!Number.isFinite(target)) return Number.NaN;
    if (target < xValues[0] || target > xValues.at(-1)) return Number.NaN;
    let right = xValues.findIndex((value) => value >= target);
    if (right < 0) return Number.NaN;
    if (right === 0) return yValues[0];
    const left = right - 1;
    const x0 = xValues[left];
    const x1 = xValues[right];
    const y0 = yValues[left];
    const y1 = yValues[right];
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) return Number.NaN;
    if (x0 === x1) return y0;
    return y0 + ((target - x0) / (x1 - x0)) * (y1 - y0);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function contiguousValidRange(scores, threshold) {
    const valid = scores.map((score) => score >= threshold);
    const first = valid.indexOf(true);
    const last = valid.lastIndexOf(true);
    if (first < 0 || last < 0) return null;
    return { start: first, end: last };
  }

  function applyAxisRange(axis, currentRange, selected) {
    if (!selected) return currentRange;
    const min = Number.isFinite(selected.min) ? selected.min : -Infinity;
    const max = Number.isFinite(selected.max) ? selected.max : Infinity;
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    let start = currentRange.start;
    let end = currentRange.end;
    while (start <= end && axis[start] < low) start += 1;
    while (end >= start && axis[end] > high) end -= 1;
    return start <= end ? { start, end } : null;
  }

  function buildExclusions(source, rowRange, colRange) {
    const exclusions = [];
    if (rowRange.start > 0) {
      exclusions.push({
        axis: "Spectral",
        range: `${format(source.spectralAxis[0])} to ${format(source.spectralAxis[rowRange.start - 1])}`,
        reason: "Leading mostly-NaN/noisy source rows excluded from analysis dataset.",
      });
    }
    if (rowRange.end < source.spectralAxis.length - 1) {
      exclusions.push({
        axis: "Spectral",
        range: `${format(source.spectralAxis[rowRange.end + 1])} to ${format(source.spectralAxis.at(-1))}`,
        reason: "Trailing mostly-NaN/noisy source rows excluded from analysis dataset.",
      });
    }
    if (colRange.start > 0) {
      exclusions.push({
        axis: "Time",
        range: `${format(source.timeAxis[0])} to ${format(source.timeAxis[colRange.start - 1])}`,
        reason: "Leading mostly-NaN/noisy source columns excluded from analysis dataset.",
      });
    }
    if (colRange.end < source.timeAxis.length - 1) {
      exclusions.push({
        axis: "Time",
        range: `${format(source.timeAxis[colRange.end + 1])} to ${format(source.timeAxis.at(-1))}`,
        reason: "Trailing mostly-NaN/noisy source columns excluded from analysis dataset.",
      });
    }
    return exclusions;
  }

  function format(value) {
    if (!Number.isFinite(value)) return "-";
    return Math.abs(value) >= 1000 || Math.abs(value) < 0.01 ? value.toExponential(3) : value.toFixed(3);
  }

  const api = {
    parseSpectroscopyCsv,
    parseSpectroscopyUfs,
    buildUfsDatasetNote,
    createAnalysisDataset,
    cloneAnalysisDataset,
    applyBaselineCorrection,
    applyChirpCorrection,
    applySharedChirpCorrection,
    analysisToCsv,
    analysesToCombinedCsv,
    fitGlobalExponentials,
    fitTargetModelCandidates,
    buildAiReadySummary,
    buildAiReadyProjectSummary,
    format,
  };
  root.SpecFlowLabParser = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
