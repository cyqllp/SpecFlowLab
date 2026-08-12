import { strToU8, zipSync } from "fflate";
import { addSourceArchiveEntries } from "./source-data.js";

export const ORIGIN_BUNDLE_SCHEMA = "specflowlab.origin_bundle.v1";

const FIT_ARRAY_KEYS = new Set([
  "amplitudes",
  "artifactAmplitudes",
  "dasSpectra",
  "easSpectra",
  "fittedMatrix",
  "residualMatrix",
]);

/**
 * Build a portable, plot-ready archive for the Python/OriginPro bridge.
 *
 * This module deliberately has no DOM or Tauri dependency. The Windows app can
 * call it directly, while tests and future command-line exporters can use the
 * same contract.
 */
export function createOriginBundle(project, options = {}) {
  const entries = {};
  const hideIrfLimited = true;
  const datasets = (project.datasets ?? []).map((dataset, index) => {
    const directory = `datasets/${String(index + 1).padStart(4, "0")}`;
    const timePath = `${directory}/treated-time.f64`;
    const wavelengthPath = `${directory}/treated-wavelength.f64`;
    const matrixPath = `${directory}/treated-matrix.f64`;
    const analysis = dataset.analysis ?? {};
    const source = addSourceArchiveEntries(
      entries,
      directory,
      dataset.source,
      `${dataset.projectLabel || `dataset-${index + 1}`}.csv`,
    );

    const timeAxis = analysis.timeAxis ?? [];
    const spectralAxis = analysis.spectralAxis ?? [];
    const matrix = analysis.matrix ?? [];
    assertMatrixShape(matrix, spectralAxis.length, timeAxis.length, "treated matrix");

    entries[timePath] = encodeFloat64Array(timeAxis);
    entries[wavelengthPath] = encodeFloat64Array(spectralAxis);
    entries[matrixPath] = encodeFloat64Matrix(matrix);

    const selectedTimeIndex = clampIndex(project.state?.selectedTimeIndex, timeAxis.length);
    const selectedWavelengthIndex = clampIndex(project.state?.selectedWavelengthIndex, spectralAxis.length);

    return {
      id: dataset.id,
      folderId: dataset.folderId,
      kind: dataset.kind ?? "imported",
      projectLabel: dataset.projectLabel,
      sampleNote: dataset.sampleNote ?? "",
      merge: dataset.merge ?? null,
      source,
      units: inferUnits(dataset),
      selection: {
        timeIndex: selectedTimeIndex,
        wavelengthIndex: selectedWavelengthIndex,
        timeValue: timeAxis[selectedTimeIndex] ?? null,
        wavelengthValue: spectralAxis[selectedWavelengthIndex] ?? null,
      },
      analysis: {
        metadata: stripMatrixData(analysis),
        timeAxis: { entry: timePath, length: timeAxis.length },
        spectralAxis: { entry: wavelengthPath, length: spectralAxis.length },
        matrix: matrixDescriptor(matrixPath, matrix),
      },
      fit: addFitEntries(
        entries,
        directory,
        dataset.fit,
        analysis,
        hideIrfLimited,
      ),
      plotPlan: buildPlotPlan(dataset.fit, hideIrfLimited, analysis),
    };
  });

  const manifest = {
    bundleSchema: ORIGIN_BUNDLE_SCHEMA,
    sourceProjectSchema: project.schema,
    appVersion: project.appVersion,
    sourceSavedAt: project.savedAt,
    createdAt: options.createdAt ?? new Date().toISOString(),
    generator: {
      name: "SpecFlowLab Origin bridge exporter",
      version: 1,
    },
    projectContract: project.projectContract,
    state: {
      activeIndex: project.state?.activeIndex ?? 0,
      selectedTimeIndex: project.state?.selectedTimeIndex ?? 0,
      selectedWavelengthIndex: project.state?.selectedWavelengthIndex ?? 0,
      compare: project.state?.compare,
      fitting: project.state?.fitting,
    },
    folders: project.folders ?? [],
    datasets,
  };

  entries["manifest.json"] = strToU8(JSON.stringify(manifest));
  return zipSync(entries, { level: 6 });
}

function addFitEntries(entries, directory, fit, analysis, hideIrfLimited) {
  if (!fit) return null;

  const result = {
    metadata: interpretedFitMetadata(fit),
  };

  if (fit.fittedMatrix) {
    assertMatrixShape(
      fit.fittedMatrix,
      analysis.spectralAxis?.length ?? 0,
      analysis.timeAxis?.length ?? 0,
      "fitted matrix",
    );
    const entry = `${directory}/fitted-matrix.f64`;
    entries[entry] = encodeFloat64Matrix(fit.fittedMatrix);
    result.fittedMatrix = matrixDescriptor(entry, fit.fittedMatrix);
  }

  if (fit.residualMatrix) {
    assertMatrixShape(
      fit.residualMatrix,
      analysis.spectralAxis?.length ?? 0,
      analysis.timeAxis?.length ?? 0,
      "residual matrix",
    );
    const entry = `${directory}/residual-matrix.f64`;
    entries[entry] = encodeFloat64Matrix(fit.residualMatrix);
    result.residualMatrix = matrixDescriptor(entry, fit.residualMatrix);
  }

  result.das = addSpectraEntries(entries, `${directory}/das-spectra.f64`, fit.dasSpectra, analysis.spectralAxis, "DAS", fit.irfLimited);
  result.eas = addSpectraEntries(entries, `${directory}/eas-spectra.f64`, fit.easSpectra, analysis.spectralAxis, "EAS", fit.irfLimited);
  return result;
}

function addSpectraEntries(entries, entry, spectra, spectralAxis = [], kind, irfLimited = []) {
  if (!Array.isArray(spectra) || !spectra.length) return null;
  const retained = spectra
    .map((spectrum, componentIndex) => ({ spectrum, componentIndex }))
    .filter(({ componentIndex }) => !irfLimited[componentIndex]);
  if (!retained.length) return null;
  const matrix = retained.map(({ spectrum, componentIndex }) => {
    if (!Array.isArray(spectrum.y) || spectrum.y.length !== spectralAxis.length) {
      throw new Error(`${kind} component ${componentIndex + 1} does not match the treated spectral axis.`);
    }
    return spectrum.y;
  });
  entries[entry] = encodeFloat64Matrix(matrix);
  return {
    entry,
    rows: matrix.length,
    cols: spectralAxis.length,
    componentIndices: retained.map(({ componentIndex }) => componentIndex),
    labels: retained.map(({ spectrum, componentIndex }) => spectrum.label ?? `${kind} ${componentIndex + 1}`),
    lifetimes: retained.map(({ spectrum }) => archiveNumber(spectrum.lifetime)),
  };
}

function buildPlotPlan(fit, hideIrfLimited, analysis = {}) {
  const spectralDisplay = (analysis.wavelengthBreaks ?? []).length
    ? { spectralSegments: "analysis.metadata.spectralSegments", wavelengthBreaks: "analysis.metadata.wavelengthBreaks" }
    : {};
  const plots = [
    {
      id: "treated-heatmap",
      kind: "virtual-matrix-heatmap",
      source: "analysis.matrix",
      x: "spectral",
      y: "time",
      yScale: "log10",
      yMinimum: 0.1,
      z: "signal",
      ...spectralDisplay,
    },
    {
      id: "selected-spectrum",
      kind: "line",
      source: "analysis.matrix",
      x: "spectral",
      y: "signal-at-selected-time",
      ...spectralDisplay,
    },
    {
      id: "selected-kinetics",
      kind: "line",
      source: "analysis.matrix",
      x: "time",
      y: "signal-at-selected-wavelength",
    },
  ];
  if (fit?.residualMatrix) {
    plots.push({
      id: "residual-heatmap",
      kind: "virtual-matrix-heatmap",
      source: "fit.residualMatrix",
      x: "spectral",
      y: "time",
      yScale: "log10",
      yMinimum: 0.1,
      z: "residual",
      ...spectralDisplay,
    });
  }
  const componentFilter = hideIrfLimited ? "exclude-irf-limited" : "all";
  if (fit?.dasSpectra?.length) {
    plots.push({
      id: "das",
      kind: "multi-line",
      source: "fit.das",
      componentFilter,
      ...spectralDisplay,
    });
  }
  if (fit?.easSpectra?.length) {
    plots.push({
      id: "eas",
      kind: "multi-line",
      source: "fit.eas",
      componentFilter,
      ...spectralDisplay,
    });
  }
  return plots;
}

function compactFitMetadata(fit) {
  return Object.fromEntries(
    Object.entries(fit).filter(([key]) => !FIT_ARRAY_KEYS.has(key)),
  );
}

function interpretedFitMetadata(fit) {
  const metadata = compactFitMetadata(fit);
  const retainedIndices = (fit.lifetimes ?? [])
    .map((_, index) => index)
    .filter((index) => !fit.irfLimited?.[index]);
  return {
    ...metadata,
    componentCount: retainedIndices.length,
    lifetimes: retainedIndices.map((index) => archiveNumber(fit.lifetimes[index])),
    fixedLifetimes: retainedIndices.map((index) => Boolean(fit.fixedLifetimes?.[index])),
    irfLimited: retainedIndices.map(() => false),
    excludedIrfLimitedComponentCount: (fit.irfLimited ?? []).filter(Boolean).length,
    originHideIrfLimited: true,
  };
}

function stripMatrixData(value) {
  if (!value) return {};
  const metadata = { ...value };
  delete metadata.timeAxis;
  delete metadata.spectralAxis;
  delete metadata.matrix;
  return metadata;
}

function inferUnits(dataset) {
  const metadata = dataset.source?.metadata ?? {};
  return {
    time: metadata["Time units"] || metadata["Time unit"] || "ps",
    spectral: metadata["Spectral units"] || metadata["Wavelength units"] || "nm",
    signal: metadata["Z axis title"] || metadata["Signal units"] || "signal",
  };
}

function matrixDescriptor(entry, matrix) {
  return {
    entry,
    rows: matrix.length,
    cols: matrix.length ? matrix[0].length : 0,
  };
}

function assertMatrixShape(matrix, rows, cols, label) {
  if (!Array.isArray(matrix) || matrix.length !== rows) {
    throw new Error(`The ${label} row count does not match its spectral axis.`);
  }
  if (!matrix.every((row) => Array.isArray(row) && row.length === cols)) {
    throw new Error(`The ${label} column count does not match its time axis.`);
  }
}

function clampIndex(value, length) {
  if (!length) return 0;
  return Math.max(0, Math.min(length - 1, Math.round(Number(value) || 0)));
}

function encodeFloat64Array(values) {
  const bytes = new Uint8Array(values.length * Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat64(index * 8, archiveNumber(value), true));
  return bytes;
}

function encodeFloat64Matrix(matrix) {
  const rows = matrix.length;
  const cols = rows ? matrix[0].length : 0;
  const bytes = new Uint8Array(rows * cols * Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  matrix.forEach((row) => {
    row.forEach((value) => {
      view.setFloat64(offset, archiveNumber(value), true);
      offset += 8;
    });
  });
  return bytes;
}

function archiveNumber(value) {
  if (value === null) return Number.NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}
