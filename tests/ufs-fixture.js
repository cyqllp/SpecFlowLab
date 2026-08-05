export function buildUfsFixture(options = {}) {
  const version = options.version ?? "Version2";
  const spectralAxis = options.spectralAxis ?? [500, 510];
  const timeAxis = options.timeAxis ?? [-1, 0.1, 10];
  const matrix = options.matrix ?? [
    [1, Number.NaN, 3],
    [4, 5, 6],
  ];
  const storedPlanes = options.storedPlanes ?? 0;
  const metadata = options.metadata
    ?? "File info:\nPump wavelength: 700 nm\nSample: ZnTPP\nOperator: SpecFlowLab test";
  const bytes = [];

  appendString(bytes, version);
  appendString(bytes, options.spectralLabel ?? "Wavelength");
  appendString(bytes, options.spectralUnit ?? "nm");
  appendUint32(bytes, spectralAxis.length);
  spectralAxis.forEach((value) => appendFloat64(bytes, value));
  appendString(bytes, options.timeLabel ?? "Time");
  appendString(bytes, options.timeUnit ?? "ps");
  appendUint32(bytes, timeAxis.length);
  timeAxis.forEach((value) => appendFloat64(bytes, value));
  appendString(bytes, options.dataUnit ?? "Delta A");
  appendUint32(bytes, storedPlanes);
  appendUint32(bytes, options.rows ?? spectralAxis.length);
  appendUint32(bytes, options.columns ?? timeAxis.length);
  matrix.flat().forEach((value) => appendFloat64(bytes, value));
  appendString(bytes, metadata);
  return Uint8Array.from(bytes);
}

function appendUint32(bytes, value) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setUint32(0, value, false);
  bytes.push(...new Uint8Array(buffer));
}

function appendFloat64(bytes, value) {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  bytes.push(...new Uint8Array(buffer));
}

function appendString(bytes, value) {
  const encoded = new TextEncoder().encode(value);
  appendUint32(bytes, encoded.byteLength);
  bytes.push(...encoded);
}
