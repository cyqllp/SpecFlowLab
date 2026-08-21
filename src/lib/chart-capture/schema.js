export const CHART_CAPTURE_SCHEMA = "specflowlab.chart_capture.v1";

export function createChartCapture(input = {}) {
  const figureBytes = toUint8Array(input.figure?.bytes);
  const datasetIds = [...new Set((input.datasetIds ?? []).map(String).filter(Boolean))];
  const capture = {
    schema: CHART_CAPTURE_SCHEMA,
    id: String(input.id || createCaptureId()),
    createdAt: input.createdAt ?? new Date().toISOString(),
    title: String(input.title || input.plotKey || "Chart capture"),
    note: String(input.note || ""),
    plotKey: String(input.plotKey || ""),
    datasetIds,
    datasetLabels: Array.isArray(input.datasetLabels) ? input.datasetLabels.map(String) : [],
    sourceFingerprint: String(input.sourceFingerprint || ""),
    view: structuredCopy(input.view ?? {}),
    figure: {
      mediaType: "image/png",
      width: finiteInteger(input.figure?.width),
      height: finiteInteger(input.figure?.height),
      bytes: figureBytes,
      sha256: input.figure?.sha256 ?? null,
    },
    data: {
      mediaType: "text/tab-separated-values",
      text: String(input.data?.text ?? ""),
      sha256: input.data?.sha256 ?? null,
      representation: String(input.data?.representation || "exact displayed numerical values"),
    },
    stale: Boolean(input.stale),
    provenance: Array.isArray(input.provenance) ? structuredCopy(input.provenance) : [],
  };
  validateChartCapture(capture);
  return capture;
}

export function validateChartCapture(capture) {
  const errors = [];
  if (capture?.schema !== CHART_CAPTURE_SCHEMA) errors.push("The chart-capture schema is missing or unsupported.");
  if (!capture?.id) errors.push("The chart capture requires an ID.");
  if (!capture?.plotKey) errors.push("The chart capture requires a plot key.");
  if (!capture?.datasetIds?.length) errors.push("The chart capture must reference at least one dataset.");
  if (!(capture?.figure?.bytes instanceof Uint8Array) || !capture.figure.bytes.byteLength) errors.push("The chart capture requires PNG bytes.");
  if (!capture?.data?.text) errors.push("The chart capture requires the displayed numerical data.");
  if (errors.length) throw new Error(errors.join(" "));
  return capture;
}

export function chartCaptureMetadata(capture) {
  validateChartCapture(capture);
  return {
    schema: capture.schema,
    id: capture.id,
    createdAt: capture.createdAt,
    title: capture.title,
    note: capture.note,
    plotKey: capture.plotKey,
    datasetIds: capture.datasetIds,
    datasetLabels: capture.datasetLabels,
    sourceFingerprint: capture.sourceFingerprint,
    view: capture.view,
    figure: {
      mediaType: capture.figure.mediaType,
      width: capture.figure.width,
      height: capture.figure.height,
      byteLength: capture.figure.bytes.byteLength,
      sha256: capture.figure.sha256,
    },
    data: {
      mediaType: capture.data.mediaType,
      representation: capture.data.representation,
      sha256: capture.data.sha256,
    },
    stale: capture.stale,
    provenance: capture.provenance,
  };
}

function createCaptureId() {
  if (globalThis.crypto?.randomUUID) return `capture:${globalThis.crypto.randomUUID()}`;
  return `capture:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (Array.isArray(value)) return Uint8Array.from(value);
  return null;
}

function finiteInteger(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function structuredCopy(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
