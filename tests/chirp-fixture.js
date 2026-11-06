export function chirpFixture({ start = -3, end = 3, dt = 0.01, count = 41, arrival = () => 0, shape, missing } = {}) {
  const timeAxis = Array.from({ length: Math.round((end - start) / dt) + 1 }, (_, i) => start + i * dt);
  const spectralAxis = Array.from({ length: count }, (_, i) => 400 + 300 * i / (count - 1));
  const matrix = spectralAxis.map((w, i) => timeAxis.map((t, j) => missing?.(i, j, t) ? NaN
    : shape ? shape(t - arrival(w, i), i, j) : 0.5 * (1 + Math.tanh((t - arrival(w, i)) / 0.03))));
  return { timeAxis, spectralAxis, matrix, provenance: [], excluded: [], selectedRange: { time: { min: start, max: end }, spectral: { min: 400, max: 700 } } };
}

export function chirpCsv(analysis) {
  return [`0,${analysis.timeAxis.join(',')}`, ...analysis.spectralAxis.map((w, i) => `${w},${analysis.matrix[i].join(',')}`)].join('\n');
}
