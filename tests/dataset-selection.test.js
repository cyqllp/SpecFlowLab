import assert from "node:assert/strict";
import test from "node:test";

import {
  SELECTION_MODES,
  isEligibleForMode,
  toggleSelection,
  validateSelection,
  selectionSummary,
} from "../src/lib/dataset-selection.js";

function makeDataset(id, opts = {}) {
  return {
    id,
    analysis: {
      provenance: opts.treated ? [{ label: "Baseline", status: "applied" }] : [],
      spectralAxis: opts.spectralAxis ?? [400, 410, 420],
      timeAxis: opts.timeAxis ?? [0, 1, 2],
    },
    fit: opts.fit ?? null,
    folderId: opts.folderId ?? "f1",
    projectLabel: opts.label ?? `Dataset ${id}`,
  };
}

// --- isEligibleForMode ---

test("isEligibleForMode: compare mode accepts all datasets", () => {
  assert.equal(isEligibleForMode(makeDataset("a", { treated: false }), "compare"), true);
  assert.equal(isEligibleForMode(makeDataset("b", { treated: true }), "compare"), true);
});

test("isEligibleForMode: merge mode accepts only treated datasets", () => {
  assert.equal(isEligibleForMode(makeDataset("a", { treated: true }), "merge"), true);
  assert.equal(isEligibleForMode(makeDataset("b", { treated: false }), "merge"), false);
});

test("isEligibleForMode throws for unknown mode", () => {
  assert.throws(() => isEligibleForMode(makeDataset("a"), "unknown"), /unknown selection mode/i);
});

// --- toggleSelection ---

test("toggleSelection adds an unselected dataset for compare mode", () => {
  const result = toggleSelection(["a", "b"], "c", "compare");
  assert.deepEqual(result, ["a", "b", "c"]);
});

test("toggleSelection removes a selected dataset", () => {
  const result = toggleSelection(["a", "b", "c"], "b", "compare");
  assert.deepEqual(result, ["a", "c"]);
});

test("toggleSelection enforces maxCount for merge mode — blocks third selection", () => {
  const result = toggleSelection(["a", "b"], "c", "merge");
  // maxCount=2, so the third should be blocked
  assert.deepEqual(result, ["a", "b"]);
});

test("toggleSelection enforces maxCount for merge — replaces oldest when blocked (shift)", () => {
  // Actually per plan: "Prefer blocking; it is easier to understand"
  const result = toggleSelection(["a", "b"], "c", "merge");
  assert.deepEqual(result, ["a", "b"]); // blocked, unchanged
});

// --- validateSelection ---

test("validateSelection: compare requires at least 2", () => {
  assert.equal(validateSelection(["a"], "compare").valid, false);
  assert.match(validateSelection(["a"], "compare").reason, /at least 2/i);
  assert.equal(validateSelection(["a", "b"], "compare").valid, true);
});

test("validateSelection: merge requires exactly 2", () => {
  assert.equal(validateSelection(["a"], "merge").valid, false);
  assert.match(validateSelection(["a"], "merge").reason, /exactly 2/i);
  assert.equal(validateSelection(["a", "b", "c"], "merge").valid, false);
  assert.match(validateSelection(["a", "b", "c"], "merge").reason, /exactly 2/i);
  assert.equal(validateSelection(["a", "b"], "merge").valid, true);
});

test("validateSelection throws for unknown mode", () => {
  assert.throws(() => validateSelection(["a"], "unknown"), /unknown selection mode/i);
});

// --- selectionSummary ---

test("selectionSummary describes compare selection", () => {
  const datasets = [
    makeDataset("a", { label: "VIS 1" }),
    makeDataset("b", { label: "NIR 1" }),
    makeDataset("c", { label: "IR 1" }),
  ];
  const summary = selectionSummary(datasets, ["a", "b", "c"], "compare");
  assert.equal(summary, "3 selected");
});

test("selectionSummary describes merge selection with names", () => {
  const datasets = [
    makeDataset("a", { label: "VIS Treated", treated: true }),
    makeDataset("b", { label: "NIR Treated", treated: true }),
  ];
  const summary = selectionSummary(datasets, ["a", "b"], "merge");
  assert.equal(summary, "2 selected (VIS Treated, NIR Treated)");
});

test("selectionSummary returns '0 selected' for empty selection", () => {
  assert.equal(selectionSummary([], [], "compare"), "0 selected");
});

// --- SELECTION_MODES constants ---

test("SELECTION_MODES has correct compare configuration", () => {
  assert.equal(SELECTION_MODES.compare.minCount, 2);
  assert.equal(SELECTION_MODES.compare.maxCount, Infinity);
  assert.equal(SELECTION_MODES.compare.eligibility, "all");
  assert.equal(SELECTION_MODES.compare.supportsSelectAll, true);
});

test("SELECTION_MODES has correct merge configuration", () => {
  assert.equal(SELECTION_MODES.merge.minCount, 2);
  assert.equal(SELECTION_MODES.merge.maxCount, 2);
  assert.equal(SELECTION_MODES.merge.eligibility, "treated");
  assert.equal(SELECTION_MODES.merge.supportsSelectAll, false);
});
