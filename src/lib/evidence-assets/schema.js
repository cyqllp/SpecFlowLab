export const EVIDENCE_ASSET_SCHEMA = "specflowlab.evidence_asset.v1";

export const EVIDENCE_ASSET_KINDS = Object.freeze([
  "spectroscopy",
  "characterization",
  "figure",
  "document",
  "manuscript",
  "literature",
]);

export const LITERATURE_RIGHTS_STATUSES = Object.freeze([
  "unknown",
  "citation-only",
  "user-supplied-private",
  "permission-confirmed",
  "open-license",
]);

export function createEvidenceAsset(input = {}) {
  const kind = EVIDENCE_ASSET_KINDS.includes(input.kind) ? input.kind : "document";
  const rawBytes = toUint8Array(input.source?.rawBytes ?? input.rawBytes);
  const sourceKind = kind === "literature" && !rawBytes ? "citation" : rawBytes ? "binary" : "citation";
  const asset = {
    schema: EVIDENCE_ASSET_SCHEMA,
    id: String(input.id || createAssetId(input.label || input.fileName || kind)),
    kind,
    label: String(input.label || input.fileName || titleForKind(kind)),
    techniqueId: String(input.techniqueId || defaultTechnique(kind)),
    measurementRole: String(input.measurementRole || "supporting"),
    note: String(input.note || ""),
    createdAt: input.createdAt ?? null,
    source: {
      kind: sourceKind,
      fileName: String(input.source?.fileName || input.fileName || ""),
      mediaType: String(input.source?.mediaType || input.mediaType || "application/octet-stream"),
      byteLength: rawBytes?.byteLength ?? 0,
      rawBytes,
      sha256: input.source?.sha256 ?? input.sha256 ?? null,
    },
    citation: normalizeCitation(input.citation),
    nativePreview: normalizeNativePreview(input.nativePreview),
    provenance: Array.isArray(input.provenance) ? structuredCopy(input.provenance) : [],
  };
  validateEvidenceAsset(asset);
  return asset;
}

export async function createEvidenceAssetFromFile(file, options = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const inferred = inferEvidenceAsset(file.name, file.type);
  const asset = createEvidenceAsset({
    ...inferred,
    ...options,
    fileName: file.name,
    mediaType: file.type || inferred.mediaType,
    rawBytes: bytes,
    createdAt: options.createdAt ?? new Date().toISOString(),
    provenance: [{
      action: "import",
      sourceFileName: file.name,
      exactSourcePreserved: true,
      createdAt: options.createdAt ?? new Date().toISOString(),
    }],
  });
  asset.source.sha256 = await sha256Hex(bytes);
  if (["spectroscopy", "characterization"].includes(asset.kind)) {
    asset.nativePreview = parseOneDimensionalText(new TextDecoder().decode(bytes), {
      sourceFileName: file.name,
      techniqueId: asset.techniqueId,
    });
  }
  return asset;
}

export function inferEvidenceAsset(fileName, mediaType = "") {
  const extension = safeExtension(fileName);
  if (/^(png|jpe?g|webp|gif|tiff?|svg)$/.test(extension) || mediaType.startsWith("image/")) {
    return { kind: "figure", techniqueId: "other", mediaType: mediaType || imageMediaType(extension) };
  }
  if (/^(csv|tsv|txt|asc|dat|xy)$/.test(extension)) {
    return { kind: "spectroscopy", techniqueId: inferSpectralTechnique(fileName), mediaType: mediaType || "text/plain" };
  }
  if (/^(docx?|odt|rtf|tex|md)$/.test(extension)) {
    return { kind: "manuscript", techniqueId: "other", mediaType: mediaType || "application/octet-stream" };
  }
  if (extension === "pdf" || mediaType === "application/pdf") {
    return { kind: "document", techniqueId: "other", mediaType: "application/pdf" };
  }
  return { kind: "document", techniqueId: "other", mediaType: mediaType || "application/octet-stream" };
}

export function evidenceImportOptions(fileName, mediaType = "", mode = "evidence") {
  const inferred = inferEvidenceAsset(fileName, mediaType);
  if (mode !== "literature") return inferred;
  const label = String(fileName || "Literature evidence").replace(/\.[^.]+$/, "") || "Literature evidence";
  if (inferred.kind === "figure") {
    return {
      ...inferred,
      measurementRole: "supporting",
      citation: { title: label, rightsStatus: "unknown" },
    };
  }
  return {
    ...inferred,
    kind: "literature",
    techniqueId: "other",
    measurementRole: "reference",
    citation: { title: label, rightsStatus: "unknown" },
  };
}

export function parseOneDimensionalText(text, options = {}) {
  const rows = [];
  String(text ?? "").split(/\r?\n/).forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const cells = trimmed.includes("\t") ? trimmed.split("\t")
      : trimmed.includes(",") ? trimmed.split(",")
        : trimmed.split(/\s+/);
    if (cells.length < 2) return;
    const x = Number(cells[0].trim());
    const rawY = cells[1].trim();
    const y = /^nan$/i.test(rawY) || rawY === "" ? Number.NaN : Number(rawY);
    if (!Number.isFinite(x) || (!Number.isFinite(y) && !Number.isNaN(y))) return;
    rows.push({ lineIndex, x, y });
  });
  if (rows.length < 2) return null;
  return {
    schema: "specflowlab.native_preview.one_dimensional.v1",
    authoritative: false,
    sourceFileName: options.sourceFileName ?? "",
    techniqueId: options.techniqueId ?? "generic-spectrum",
    nativeShape: "one-dimensional-spectrum",
    xAxis: { name: "x", unit: "unknown", values: rows.map((row) => row.x) },
    signal: { name: "signal", unit: "unknown", values: rows.map((row) => row.y) },
    sourceLineIndices: rows.map((row) => row.lineIndex),
    missingValuePolicy: "NaN remains missing; preview does not fill or resample",
  };
}

export function normalizeEvidenceAsset(value) {
  return createEvidenceAsset(value);
}

export function validateEvidenceAsset(asset) {
  const errors = [];
  if (asset?.schema !== EVIDENCE_ASSET_SCHEMA) errors.push("The evidence asset schema is missing or unsupported.");
  if (!asset?.id) errors.push("The evidence asset requires an ID.");
  if (!EVIDENCE_ASSET_KINDS.includes(asset?.kind)) errors.push(`Unsupported evidence asset kind: ${asset?.kind || "missing"}.`);
  if (!String(asset?.label ?? "").trim()) errors.push("The evidence asset requires a label.");
  if (asset?.source?.kind === "binary" && !(asset.source.rawBytes instanceof Uint8Array)) errors.push("Binary evidence must retain exact source bytes.");
  if (asset?.source?.kind === "citation" && asset?.kind !== "literature" && !asset?.citation?.title) errors.push("Citation-only evidence requires a literature title.");
  if (asset?.citation?.rightsStatus && !LITERATURE_RIGHTS_STATUSES.includes(asset.citation.rightsStatus)) errors.push("The literature rights status is invalid.");
  if (errors.length) throw new Error(errors.join(" "));
  return asset;
}

export function evidenceAssetEntityKind(asset) {
  if (["spectroscopy", "characterization"].includes(asset.kind)) return "external-dataset";
  if (asset.kind === "figure") return "figure-evidence";
  if (asset.kind === "literature") return "literature-source";
  return "document-evidence";
}

function normalizeCitation(value = {}) {
  return {
    title: String(value?.title || ""),
    authors: String(value?.authors || ""),
    year: String(value?.year || ""),
    doi: String(value?.doi || ""),
    url: String(value?.url || ""),
    figure: String(value?.figure || ""),
    rightsStatus: LITERATURE_RIGHTS_STATUSES.includes(value?.rightsStatus) ? value.rightsStatus : "unknown",
  };
}

function normalizeNativePreview(value) {
  if (!value) return null;
  return structuredCopy(value, (_key, entry) => Number.isNaN(entry) ? null : entry);
}

function defaultTechnique(kind) {
  return ["spectroscopy", "characterization"].includes(kind) ? "generic-spectrum" : "other";
}

function titleForKind(kind) {
  return kind === "literature" ? "Literature source" : `External ${kind}`;
}

function createAssetId(label) {
  const stem = String(label).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "evidence";
  return `asset:${stem}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeExtension(fileName) {
  return String(fileName ?? "").split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
}

function imageMediaType(extension) {
  if (extension === "svg") return "image/svg+xml";
  if (/^jpe?g$/.test(extension)) return "image/jpeg";
  if (/^tiff?$/.test(extension)) return "image/tiff";
  return `image/${extension || "png"}`;
}

function inferSpectralTechnique(fileName) {
  const name = String(fileName ?? "").toLowerCase();
  if (/(^|[^a-z])(abs|uv[ -]?vis|absorption)([^a-z]|$)/.test(name)) return "absorption";
  if (/(^|[^a-z])(pl|photoluminescence|fluorescence|emission)([^a-z]|$)/.test(name)) return "pl";
  if (/(^|[^a-z])epr([^a-z]|$)/.test(name)) return "epr";
  if (/(^|[^a-z])raman([^a-z]|$)/.test(name)) return "raman";
  if (/(^|[^a-z])(ir|ftir)([^a-z]|$)/.test(name)) return "ir";
  return "generic-spectrum";
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (Array.isArray(value)) return Uint8Array.from(value);
  return null;
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function structuredCopy(value, replacer = null) {
  if (!replacer && typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value, replacer));
}
