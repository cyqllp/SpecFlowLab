import assert from "node:assert/strict";
import test from "node:test";

import {
  getActiveFolderId,
  getUnfittedDatasetsInFolder,
} from "../src/lib/dataset-scope.js";

function makeDataset(id, folderId, fit = null) {
  return { id, folderId, fit };
}

test("getActiveFolderId returns the folder of the active dataset", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f2"),
    makeDataset("c", "f1"),
  ];
  assert.equal(getActiveFolderId(datasets, "b"), "f2");
  assert.equal(getActiveFolderId(datasets, "a"), "f1");
});

test("getActiveFolderId returns null when the active dataset is not in the array", () => {
  const datasets = [makeDataset("a", "f1")];
  assert.equal(getActiveFolderId(datasets, "missing"), null);
});

test("getActiveFolderId returns null for an empty dataset array", () => {
  assert.equal(getActiveFolderId([], "any"), null);
});

test("getUnfittedDatasetsInFolder returns only unfitted datasets in the given folder", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f1", { lifetimes: [1, 2, 3] }),
    makeDataset("c", "f2"),
    makeDataset("d", "f1"),
    makeDataset("e", "f2", { lifetimes: [4] }),
  ];
  const result = getUnfittedDatasetsInFolder(datasets, "f1");
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((d) => d.id), ["a", "d"]);
});

test("getUnfittedDatasetsInFolder returns empty array when all datasets in folder are fitted", () => {
  const datasets = [
    makeDataset("a", "f1", { lifetimes: [1] }),
    makeDataset("b", "f2"),
  ];
  const result = getUnfittedDatasetsInFolder(datasets, "f1");
  assert.equal(result.length, 0);
});

test("getUnfittedDatasetsInFolder returns empty array for a folder with no datasets", () => {
  const datasets = [makeDataset("a", "f1")];
  const result = getUnfittedDatasetsInFolder(datasets, "nonexistent");
  assert.equal(result.length, 0);
});

test("getUnfittedDatasetsInFolder returns empty array when datasets is empty", () => {
  assert.equal(getUnfittedDatasetsInFolder([], "f1").length, 0);
});

test("getUnfittedDatasetsInFolder preserves dataset object identity", () => {
  const dataset = makeDataset("a", "f1");
  const datasets = [dataset, makeDataset("b", "f1", {})];
  const result = getUnfittedDatasetsInFolder(datasets, "f1");
  assert.equal(result[0], dataset);
});

test("getUnfittedDatasetsInFolder returns empty when folderId is null or undefined", () => {
  const datasets = [makeDataset("a", null), makeDataset("b", null)];
  assert.equal(getUnfittedDatasetsInFolder(datasets, null).length, 2);
  assert.equal(getUnfittedDatasetsInFolder(datasets, undefined).length, 0);
  assert.equal(getUnfittedDatasetsInFolder([], null).length, 0);
});
