import { treatmentStatus } from './treatment-status.js';

// Clip in physical coordinates before the time transform, which clamps outside its extent.
function clipSegment(a, b, xExtent, yExtent) {
  let lo = 0, hi = 1;
  for (const [start, delta, min, max] of [
    [a.x, b.x - a.x, ...xExtent], [a.y, b.y - a.y, ...yExtent],
  ]) {
    if (delta === 0) { if (start < min || start > max) return null; continue; }
    const t1 = (min - start) / delta, t2 = (max - start) / delta;
    lo = Math.max(lo, Math.min(t1, t2));
    hi = Math.min(hi, Math.max(t1, t2));
    if (lo > hi) return null;
  }
  const point = (t) => ({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
  return [point(lo), point(hi)];
}

export function chirpOverlaySegments(analysis, xExtent, yExtent) {
  if (treatmentStatus(analysis, 'Chirp') !== 'applied') return null;
  const curve = analysis.chirp?.curve;
  if (!Array.isArray(curve) || curve.length < 2) return null;
  const target = Number.isFinite(analysis.chirp.model?.targetReferenceTime) ? analysis.chirp.model.targetReferenceTime : 0;
  const raw = [], predicted = [], guide = [];
  const range = analysis.chirp.model?.extrapolation && analysis.chirp.model.calibrationRange;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i];
    if (![a.wavelength, a.shift, b.wavelength, b.shift].every(Number.isFinite)) continue;
    const rawSegment = clipSegment({ x: a.wavelength, y: a.shift + target }, { x: b.wavelength, y: b.shift + target }, xExtent, yExtent);
    const guideSegment = clipSegment({ x: a.wavelength, y: target }, { x: b.wavelength, y: target }, xExtent, yExtent);
    if (rawSegment) {
      if (!range) raw.push(rawSegment);
      else {
        const fitted = clipSegment(...rawSegment, [range.min, range.max], yExtent);
        if (fitted) raw.push(fitted);
        for (const bounds of [[xExtent[0], range.min], [range.max, xExtent[1]]]) {
          if (bounds[0] >= bounds[1]) continue;
          const part = clipSegment(...rawSegment, bounds, yExtent);
          if (part && part[0].x !== part[1].x) predicted.push(part);
        }
      }
    }
    if (guideSegment) guide.push(guideSegment);
  }
  return { raw, predicted, guide };
}
