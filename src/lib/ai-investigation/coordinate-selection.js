export function selectRepresentativeTimeIndices(dataset, options = {}) {
  const axis = dataset.analysis?.timeAxis ?? [];
  if (!axis.length) return [];
  const candidates = [];
  addIndex(candidates, clampIndex(options.selectedTimeIndex, axis.length), "current-selection");
  addIndex(candidates, axis.findIndex((value) => Number.isFinite(value) && value >= 0), "earliest-nonnegative");
  for (const lifetime of dataset.fit?.lifetimes ?? []) {
    addIndex(candidates, nearestFiniteIndex(axis, lifetime), `nearest-lifetime-${formatCoordinate(lifetime)}-ps`);
  }
  logarithmicIndices(axis, 2).forEach((index) => addIndex(candidates, index, "log-time-coverage"));
  addIndex(candidates, lastFiniteIndex(axis), "latest-measured-time");
  return candidates.slice(0, options.limit ?? 3);
}
export function selectRepresentativeWavelengthIndices(dataset, options = {}) {
  const axis = dataset.analysis?.spectralAxis ?? [];
  if (!axis.length) return [];
  const candidates = [];
  addIndex(candidates, clampIndex(options.selectedWavelengthIndex, axis.length), "current-selection");
  strongestVarianceRows(dataset.analysis?.matrix ?? [], 2)
    .forEach((index) => addIndex(candidates, index, "strong-temporal-variance"));
  addIndex(candidates, nearestFiniteIndex(axis, medianFinite(axis)), "spectral-coverage-midpoint");
  return candidates.slice(0, options.limit ?? 3);
}

export function nearestFiniteIndex(axis, target) {
  if (!Number.isFinite(target)) return -1;
  let best = -1;
  let distance = Infinity;
  axis.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    const next = Math.abs(value - target);
    if (next < distance) {
      best = index;
      distance = next;
    }
  });
  return best;
}

function logarithmicIndices(axis, count) {
  const valid = axis.map((value, index) => ({ value, index })).filter((item) => item.value > 0 && Number.isFinite(item.value));
  if (!valid.length) return [];
  if (valid.length <= count) return valid.map((item) => item.index);
  const min = Math.log(valid[0].value);
  const max = Math.log(valid.at(-1).value);
  return Array.from({ length: count }, (_, index) => {
    const fraction = (index + 1) / (count + 1);
    return nearestFiniteIndex(axis, Math.exp(min + (max - min) * fraction));
  });
}

function strongestVarianceRows(matrix, count) {
  return matrix.map((row, index) => ({ index, variance: finiteVariance(row) }))
    .filter((item) => Number.isFinite(item.variance))
    .sort((left, right) => right.variance - left.variance || left.index - right.index)
    .slice(0, count)
    .map((item) => item.index);
}

function finiteVariance(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return Number.NaN;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  return finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
}

function medianFinite(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  return finite.length ? finite[Math.floor((finite.length - 1) / 2)] : Number.NaN;
}

function lastFiniteIndex(values) {
  for (let index = values.length - 1; index >= 0; index -= 1) if (Number.isFinite(values[index])) return index;
  return -1;
}

function clampIndex(value, length) {
  const index = Number.isInteger(value) ? value : 0;
  return Math.max(0, Math.min(length - 1, index));
}

function addIndex(items, index, reason) {
  if (index < 0 || items.some((item) => item.index === index)) return;
  items.push({ index, reason });
}

function formatCoordinate(value) {
  return Number.isFinite(value) ? Number(value.toPrecision(6)).toString() : "unknown";
}
