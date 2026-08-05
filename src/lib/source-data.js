function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return null;
}

export function sourceFormat(source) {
  if (source?.sourceFormat === "ufs" || source?.format === "ufs") return "ufs";
  if (source?.sourceFormat === "derived-merge" || source?.format === "derived-merge") return "derived-merge";
  if (/\.ufs$/i.test(source?.fileName ?? "") && toUint8Array(source?.rawBytes)) return "ufs";
  return "csv";
}

export function addSourceArchiveEntries(entries, directory, source, fallbackName) {
  const format = sourceFormat(source);
  const requestedFallback = fallbackName || (format === "ufs" ? "dataset.ufs" : "dataset.csv");
  const formatFallback = format === "ufs"
    ? requestedFallback.replace(/\.[^.]+$/, ".ufs")
    : requestedFallback;
  const fileName = source?.fileName || formatFallback;
  const csvEntry = `${directory}/source.csv`;

  if (format === "ufs") {
    const rawBytes = toUint8Array(source?.rawBytes);
    if (!rawBytes?.byteLength) {
      throw new Error(`Dataset ${fileName} has no preserved UFS raw bytes.`);
    }
    const rawEntry = `${directory}/source.ufs`;
    entries[rawEntry] = rawBytes.slice();
    entries[csvEntry] = new TextEncoder().encode(spectroscopySourceToCsv(source));
    return {
      fileName,
      format: "ufs",
      entry: csvEntry,
      rawEntry,
    };
  }

  if (format === "derived-merge") {
    if (typeof source?.rawText !== "string") {
      throw new Error(`Derived merged dataset ${fileName} has no canonical materialized CSV.`);
    }
    entries[csvEntry] = new TextEncoder().encode(source.rawText);
    return {
      fileName,
      format: "derived-merge",
      entry: csvEntry,
    };
  }

  if (typeof source?.rawText !== "string") {
    throw new Error(`Dataset ${fileName} has no preserved source CSV text.`);
  }
  entries[csvEntry] = new TextEncoder().encode(source.rawText);
  return {
    fileName,
    format: "csv",
    entry: csvEntry,
  };
}

export function spectroscopySourceToCsv(source) {
  const timeAxis = source?.timeAxis ?? [];
  const spectralAxis = source?.spectralAxis ?? [];
  const matrix = source?.matrix ?? [];
  if (matrix.length !== spectralAxis.length
    || !matrix.every((row) => Array.isArray(row) && row.length === timeAxis.length)) {
    throw new Error("Cannot encode source data whose matrix does not match its axes.");
  }
  const rows = [[0, ...timeAxis]];
  spectralAxis.forEach((wavelength, index) => rows.push([wavelength, ...matrix[index]]));
  return `${rows.map((row) => row.map(sourceCsvCell).join(",")).join("\r\n")}\r\n`;
}

function sourceCsvCell(value) {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NaN";
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
