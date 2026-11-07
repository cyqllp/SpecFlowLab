import assert from 'node:assert/strict';
import test from 'node:test';
import '../src/lib/parser-core.js';
import { chirpFixture } from './chirp-fixture.js';
import { estimateChirpModel, chirpArrival } from '../src/lib/chirp-model.js';
import { treatmentStatus } from '../src/lib/treatment-status.js';

const P = globalThis.SpecFlowLabParser;
test('missing baseline and conflicting arrivals apply with diagnostics', () => {
  for (const input of [chirpFixture({ missing: (_i, _j, t) => t < -0.05 }), chirpFixture({ arrival: (_w, i) => i % 2 ? -0.3 : 0.3 })]) {
    const result = P.applyChirpCorrection(input, { approximateZeroTimePs: 0, referenceWavelength: 620 });
    assert.equal(treatmentStatus(result, 'Chirp'), 'applied');
    assert.equal(result.chirp.model.referenceWavelength, 620);
    assert.ok(result.chirp.model.warnings.length);
  }
});
test('flat nonzero traces use a clearly labelled seed-only shift', () => {
  const input = chirpFixture({ shape: () => 12 });
  const result = P.applyChirpCorrection(input, { approximateZeroTimePs: 0.2, referenceWavelength: 620 });
  assert.equal(treatmentStatus(result, 'Chirp'), 'applied');
  assert.equal(result.chirp.model.method, 'seed-only');
  assert.equal(result.chirp.model.anchors.length, 0);
  assert.ok(result.chirp.curve.every(p => p.shift === 0.2));
});
test('one detected wavelength yields a constant model', () => {
  const input = chirpFixture({ shape: (t, i) => i ? 0 : (t > 0.2 ? 1 : 0) });
  const model = estimateChirpModel(input, { approximateZeroTimePs: 0.2, referenceWavelength: 620 });
  assert.equal(model.support, 1);
  assert.equal(model.selectedDegree, 0);
  assert.ok(Math.abs(chirpArrival(model, 400) - 0.2) < 0.05);
});
test('reference reparameterizes a free fitted intercept and retry from base is identical', () => {
  const input = chirpFixture({ arrival: w => 0.2 + (w - 550) * 0.001 });
  const options = { approximateZeroTimePs: 0.3, referenceWavelength: 620 };
  const a = P.applyChirpCorrection(input, options), b = P.applyChirpCorrection(input, options);
  assert.deepEqual(a.matrix, b.matrix);
  assert.equal(a.chirp.model.referenceWavelength, 620);
  assert.ok(Math.abs(a.chirp.model.referenceTime - 0.27) < 0.03);
  assert.notEqual(a.chirp.model.referenceTime, options.approximateZeroTimePs);
});
test('sparse long-delay times do not change early arrival fit', () => {
  const input = chirpFixture({ arrival: w => 0.1 + 0.3 * ((w - 550) / 150) ** 2 });
  const extended = structuredClone(input);
  extended.timeAxis.push(100, 300, 1000);
  extended.matrix.forEach(row => row.push(row.at(-1), row.at(-1), row.at(-1)));
  const options = { approximateZeroTimePs: 0.2, referenceWavelength: 620 };
  const a = estimateChirpModel(input, options), b = estimateChirpModel(extended, options);
  assert.equal(a.selectedDegree, b.selectedDegree);
  assert.deepEqual(a.coefficients, b.coefficients);
});
test('less than 25 percent overlap applies, zero overlap and invalid models preserve input', () => {
  const input = chirpFixture({ start: -1, end: 1, dt: 0.05 });
  const model = shift => ({ referenceWavelength: 550, referenceTime: shift, coefficients: [] });
  const small = P.applyChirpCorrection(input, { model: model(1.7) });
  assert.equal(treatmentStatus(small, 'Chirp'), 'applied');
  assert.ok(small.chirp.model.outputFiniteCount < small.chirp.model.inputFiniteCount * 0.25);
  assert.match(small.chirp.model.warnings.join(' '), /finite input samples.*%/);
  for (const invalid of [model(20), model(NaN)]) {
    const result = P.applyChirpCorrection(input, { model: invalid });
    assert.equal(treatmentStatus(result, 'Chirp'), 'skipped');
    assert.deepEqual(result.matrix, input.matrix);
  }
});
