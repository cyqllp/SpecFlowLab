import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { addSourceArchiveEntries } from "./source-data.js";

export const PROJECT_ARCHIVE_SCHEMA = "specflowlab.project_archive.v1";

const MAX_COMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_MATRIX_VALUES = 100_000_000;

const DERIVED_FIT_KEYS = new Set([
  "amplitudes",
  "artifactAmplitudes",
  "dasSpectra",
  "easSpectra",
  "fittedMatrix",
  "residualMatrix",
]);

export function createProjectArchive(project) {
  const entries = {};
  const datasets = (project.datasets ?? []).map((dataset, index) => {
    const directory = `datasets/${String(index + 1).padStart(4, "0")}`;
    const timePath = `${directory}/treated-time.f64`;
    const wavelengthPath = `${directory}/treated-wavelength.f64`;
    const matrixPath = `${directory}/treated-matrix.f64`;
    const source = addSourceArchiveEntries(
      entries,
      directory,
      dataset.source,
      `${dataset.projectLabel || `dataset-${index + 1}`}.csv`,
    );
    entries[timePath] = encodeFloat64Array(dataset.analysis?.timeAxis ?? []);
    entries[wavelengthPath] = encodeFloat64Array(dataset.analysis?.spectralAxis ?? []);
    entries[matrixPath] = encodeFloat64Matrix(dataset.analysis?.matrix ?? []);

    return {
      id: dataset.id,
      folderId: dataset.folderId,
      kind: dataset.kind ?? "imported",
      projectLabel: dataset.projectLabel,
      sampleNote: dataset.sampleNote ?? "",
      merge: dataset.merge ?? null,
      source,
      baseAnalysisMetadata: stripMatrixData(dataset.baseAnalysis),
      analysis: {
        metadata: stripMatrixData(dataset.analysis),
        timeAxis: { entry: timePath, length: dataset.analysis?.timeAxis?.length ?? 0 },
        spectralAxis: { entry: wavelengthPath, length: dataset.analysis?.spectralAxis?.length ?? 0 },
        matrix: matrixDescriptor(matrixPath, dataset.analysis?.matrix ?? []),
      },
      fit: compactFit(dataset.fit),
    };
  });

  const manifest = {
    archiveSchema: PROJECT_ARCHIVE_SCHEMA,
    projectSchema: project.schema,
    appVersion: project.appVersion,
    savedAt: project.savedAt,
    projectContract: project.projectContract,
    state: project.state,
    folders: project.folders,
    datasets,
  };
  entries["manifest.json"] = strToU8(JSON.stringify(manifest));
  return zipSync(entries, { level: 6 });
}

export function readProjectArchive(bytes) {
  const archiveBytes = toUint8Array(bytes);
  if (archiveBytes.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error("The project archive exceeds the 512 MB compressed-size limit.");
  }
  let expandedBytes = 0;
  let entryCount = 0;
  const entries = unzipSync(archiveBytes, {
    filter(file) {
      entryCount += 1;
      expandedBytes += file.originalSize;
      if (entryCount > MAX_ARCHIVE_ENTRIES) {
        throw new Error("The project archive contains too many entries.");
      }
      if (expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error("The project archive exceeds the 1 GB expanded-size limit.");
      }
      if (isUnsafeArchivePath(file.name)) {
        throw new Error(`The project archive contains an unsafe path: ${file.name}.`);
      }
      return true;
    },
  });
  const manifestEntry = entries["manifest.json"];
  if (!manifestEntry) throw new Error("The project archive has no manifest.json.");

  const manifest = JSON.parse(strFromU8(manifestEntry));
  if (manifest.archiveSchema !== PROJECT_ARCHIVE_SCHEMA) {
    throw new Error(`Unsupported SpecFlowLab archive schema: ${manifest.archiveSchema || "missing"}.`);
  }

  return {
    schema: manifest.projectSchema ?? PROJECT_ARCHIVE_SCHEMA,
    appVersion: manifest.appVersion,
    savedAt: manifest.savedAt,
    projectContract: manifest.projectContract,
    state: manifest.state,
    folders: manifest.folders,
    datasets: (manifest.datasets ?? []).map((dataset) => ({
      id: dataset.id,
      folderId: dataset.folderId,
      kind: dataset.kind ?? "imported",
      projectLabel: dataset.projectLabel,
      sampleNote: dataset.sampleNote ?? "",
      merge: dataset.merge ?? null,
      archivedSource: {
        fileName: dataset.source?.fileName,
        format: dataset.source?.format ?? "csv",
        rawText: strFromU8(requiredEntry(entries, dataset.source?.entry)),
        rawBytes: dataset.source?.rawEntry
          ? requiredEntry(entries, dataset.source.rawEntry).slice()
          : null,
      },
      baseAnalysisMetadata: dataset.baseAnalysisMetadata ?? {},
      analysis: {
        ...(dataset.analysis?.metadata ?? {}),
        timeAxis: decodeFloat64Array(
          requiredEntry(entries, dataset.analysis?.timeAxis?.entry),
          dataset.analysis?.timeAxis?.length,
        ),
        spectralAxis: decodeFloat64Array(
          requiredEntry(entries, dataset.analysis?.spectralAxis?.entry),
          dataset.analysis?.spectralAxis?.length,
        ),
        matrix: decodeFloat64Matrix(
          requiredEntry(entries, dataset.analysis?.matrix?.entry),
          dataset.analysis?.matrix?.rows,
          dataset.analysis?.matrix?.cols,
        ),
      },
      archivedFit: dataset.fit ?? null,
    })),
    archiveSchema: manifest.archiveSchema,
  };
}

export function hydrateProjectArchive(project, parser) {
  if (project.archiveSchema !== PROJECT_ARCHIVE_SCHEMA) return project;
  return {
    ...project,
    datasets: (project.datasets ?? []).map((dataset) => {
      const source = dataset.archivedSource.format === "ufs" && dataset.archivedSource.rawBytes
        ? parser.parseSpectroscopyUfs(
            dataset.archivedSource.rawBytes,
            dataset.archivedSource.fileName,
          )
        : parser.parseSpectroscopyCsv(
            dataset.archivedSource.rawText,
            dataset.archivedSource.fileName,
          );
      if (source.sourceFormat === "ufs") {
        source.rawBytes = dataset.archivedSource.rawBytes.slice();
        source.rawText = dataset.archivedSource.rawText;
      } else {
        source.rawText = dataset.archivedSource.rawText;
      }
      if (dataset.archivedSource.format === "derived-merge") {
        source.sourceFormat = "derived-merge";
        source.spectralSegments = (dataset.merge?.spectralSegments ?? []).map((item) => ({ ...item }));
        source.wavelengthBreaks = (dataset.merge?.wavelengthBreaks ?? []).map((item) => ({ ...item }));
        source.merge = dataset.merge;
      }
      const selectedRange = dataset.baseAnalysisMetadata?.selectedRange ?? dataset.analysis?.selectedRange;
      const reconstructedBase = parser.createAnalysisDataset(source, selectedRange ? {
        spectralRange: selectedRange.spectral,
        timeRange: selectedRange.time,
      } : {});
      const baseAnalysis = mergeMatrixMetadata(reconstructedBase, dataset.baseAnalysisMetadata);
      const analysis = reviveMatrixObject(dataset.analysis);
      return {
        id: dataset.id,
        folderId: dataset.folderId,
        kind: dataset.kind ?? "imported",
        projectLabel: dataset.projectLabel,
        sampleNote: dataset.sampleNote ?? "",
        merge: dataset.merge ?? null,
        source,
        baseAnalysis,
        analysis,
        fit: restoreFit(dataset.archivedFit, analysis, parser),
      };
    }),
  };
}

function compactFit(fit) {
  if (!fit) return null;
  const compact = {};
  Object.entries(fit).forEach(([key, value]) => {
    if (!DERIVED_FIT_KEYS.has(key)) compact[key] = value;
  });
  return compact;
}

function restoreFit(fit, analysis, parser) {
  if (!fit) return null;
  const componentCount = Number(fit.componentCount) || fit.lifetimes?.length || 1;
  const recomputed = parser.fitGlobalExponentials(analysis, componentCount, {
    irfFwhm: Number(fit.irfFwhm) || 0,
    lifetimes: fit.lifetimes,
    fixedLifetimes: Array.from({ length: componentCount }, () => true),
    includeIrfArtifact: fit.irfArtifactModel !== "off",
  });
  return {
    ...recomputed,
    ...fit,
    amplitudes: recomputed.amplitudes,
    artifactAmplitudes: recomputed.artifactAmplitudes,
    amplitudeRanges: recomputed.amplitudeRanges,
    dasSpectra: recomputed.dasSpectra,
    easSpectra: recomputed.easSpectra,
    fittedMatrix: recomputed.fittedMatrix,
    residualMatrix: recomputed.residualMatrix,
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

function mergeMatrixMetadata(reconstructed, metadata = {}) {
  return {
    ...reconstructed,
    ...metadata,
    timeAxis: reconstructed.timeAxis,
    spectralAxis: reconstructed.spectralAxis,
    matrix: reconstructed.matrix,
  };
}

function reviveMatrixObject(value) {
  return {
    ...value,
    timeAxis: reviveArray(value?.timeAxis),
    spectralAxis: reviveArray(value?.spectralAxis),
    matrix: (value?.matrix ?? []).map(reviveArray),
  };
}

function reviveArray(values = []) {
  return values.map((value) => value === null ? Number.NaN : value);
}

function matrixDescriptor(entry, matrix) {
  const rows = matrix.length;
  const cols = rows ? matrix[0].length : 0;
  if (!matrix.every((row) => row.length === cols)) {
    throw new Error("Cannot archive a non-rectangular treated matrix.");
  }
  return { entry, rows, cols };
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
  if (!matrix.every((row) => row.length === cols)) {
    throw new Error("Cannot archive a non-rectangular treated matrix.");
  }
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

function decodeFloat64Array(bytes, expectedLength) {
  const length = validateFloat64Bytes(bytes, expectedLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length }, (_, index) => view.getFloat64(index * 8, true));
}

function decodeFloat64Matrix(bytes, rows, cols) {
  const safeRows = nonNegativeInteger(rows, "matrix rows");
  const safeCols = nonNegativeInteger(cols, "matrix columns");
  const valueCount = safeRows * safeCols;
  if (!Number.isSafeInteger(valueCount) || valueCount > MAX_MATRIX_VALUES) {
    throw new Error("The project matrix dimensions exceed the supported limit.");
  }
  validateFloat64Bytes(bytes, valueCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: safeRows }, (_, rowIndex) =>
    Array.from({ length: safeCols }, (_, colIndex) =>
      view.getFloat64((rowIndex * safeCols + colIndex) * 8, true)));
}

function validateFloat64Bytes(bytes, expectedLength) {
  const safeLength = nonNegativeInteger(expectedLength, "array length");
  const expectedBytes = safeLength * Float64Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(`Corrupt project array: expected ${expectedBytes} bytes, found ${bytes.byteLength}.`);
  }
  return safeLength;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`Invalid ${label} in project archive.`);
  return number;
}

function requiredEntry(entries, path) {
  if (!path || !entries[path]) throw new Error(`The project archive is missing ${path || "a required entry"}.`);
  return entries[path];
}

function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes);
}

function archiveNumber(value) {
  return value === null ? Number.NaN : Number(value);
}

function isUnsafeArchivePath(path) {
  return path.startsWith("/")
    || path.startsWith("\\")
    || /^[A-Za-z]:/.test(path)
    || path.split(/[\\/]/).includes("..");
}
