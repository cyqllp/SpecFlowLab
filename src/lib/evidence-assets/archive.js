import { normalizeEvidenceAsset } from "./schema.js";

export function addEvidenceAssetsToArchive(entries, assets = []) {
  return assets.map((asset, index) => {
    const normalized = normalizeEvidenceAsset(asset);
    const directory = `evidence-assets/${String(index + 1).padStart(4, "0")}`;
    let source = { ...normalized.source, rawBytes: undefined };
    if (normalized.source.rawBytes instanceof Uint8Array) {
      const entry = `${directory}/source${safeSuffix(normalized.source.fileName)}`;
      entries[entry] = normalized.source.rawBytes.slice();
      source = { ...source, entry, byteLength: normalized.source.rawBytes.byteLength };
    }
    return {
      ...normalized,
      source,
    };
  });
}

export function readEvidenceAssetsFromArchive(entries, descriptors = []) {
  return descriptors.map((descriptor) => {
    const rawBytes = descriptor.source?.entry
      ? requiredEvidenceEntry(entries, descriptor.source.entry).slice()
      : null;
    return normalizeEvidenceAsset({
      ...descriptor,
      source: { ...descriptor.source, rawBytes },
    });
  });
}

function requiredEvidenceEntry(entries, path) {
  if (!path || !entries[path]) throw new Error(`The project archive is missing external evidence entry ${path || "(unknown)"}.`);
  return entries[path];
}

function safeSuffix(fileName) {
  const name = String(fileName ?? "").split(/[\\/]/).at(-1) || "";
  const extension = name.includes(".") ? name.split(".").at(-1).toLowerCase() : "";
  return /^[a-z0-9]{1,10}$/.test(extension) ? `.${extension}` : ".bin";
}
