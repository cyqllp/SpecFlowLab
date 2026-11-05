import assert from 'node:assert/strict';
import test from 'node:test';
import { chirpOverlaySegments } from '../src/lib/chirp-overlay.js';

const analysis = () => ({
  provenance: [{ label: 'Chirp', status: 'applied' }],
  chirp: { model: { targetReferenceTime: 0.2 }, curve: [
    { wavelength: 400, shift: -0.2 }, { wavelength: 500, shift: 0.8 },
  ] },
});

test('chirp overlay uses physical raw arrival and clips both guides to zoom', () => {
  const result = chirpOverlaySegments(analysis(), [425, 475], [0.2, 0.6]);
  assert.deepEqual(result.guide, [[{ x: 425, y: 0.2 }, { x: 475, y: 0.2 }]]);
  assert.ok(Math.abs(result.raw[0][0].x - 425) < 1e-9);
  assert.ok(Math.abs(result.raw[0][0].y - 0.25) < 1e-9);
  assert.ok(Math.abs(result.raw[0][1].y - 0.6) < 1e-9);
});

test('skipped and review-required chirps do not produce overlays', () => {
  const skipped = analysis(); skipped.provenance[0].status = 'skipped';
  assert.equal(chirpOverlaySegments(skipped, [400, 500], [-1, 1]), null);
  const review = analysis(); review.provenance.push({ label: 'Chirp review', status: 'review-required' });
  assert.equal(chirpOverlaySegments(review, [400, 500], [-1, 1]), null);
});
