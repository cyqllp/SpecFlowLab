import assert from "node:assert/strict";
import test from "node:test";

import { moveDataset } from "../src/lib/dataset-order.js";

const FOLDERS = [
  { id: "f1", name: "VIS" },
  { id: "f2", name: "NIR" },
  { id: "f3", name: "IR" },
];

function makeDataset(id, folderId) {
  return { id, folderId, data: `payload-${id}` };
}

function ids(datasets) {
  return datasets.map((d) => d.id);
}

test("moveDataset reorders within the same folder — before a target", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f1"),
    makeDataset("c", "f1"),
  ];
  const result = moveDataset(datasets, FOLDERS, {
    datasetId: "c",
    targetFolderId: "f1",
    targetDatasetId: "a",
    placement: "before",
  });
  assert.equal(result.changed, true);
  assert.deepEqual(ids(result.datasets), ["c", "a", "b"]);
});

test("moveDataset reorders within the same folder — after a target", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f1"),
    makeDataset("c", "f1"),
  ];
  const result = moveDataset(datasets, FOLDERS, {
    datasetId: "a",
    targetFolderId: "f1",
    targetDatasetId: "c",
    placement: "after",
  });
  assert.equal(result.changed, true);
  assert.deepEqual(ids(result.datasets), ["b", "c", "a"]);
});

test("moveDataset places at the end of the target folder", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f1"),
    makeDataset("c", "f1"),
  ];
  const result = moveDataset(datasets, FOLDERS, {
    datasetId: "b",
    targetFolderId: "f1",
    targetDatasetId: null,
    placement: "end",
  });
  assert.equal(result.changed, true);
  assert.deepEqual(ids(result.datasets), ["a", "c", "b"]);
});

test("moveDataset first to last within same folder", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f1"),
    makeDataset("c", "f1"),
    makeDataset("d", "f1"),
  ];
  const result = moveDataset(datasets, FOLDERS, {
    datasetId: "a",
    targetFolderId: "f1",
    targetDatasetId: null,
    placement: "end",
  });
  assert.equal(result.changed, true);
  assert.deepEqual(ids(result.datasets), ["b", "c", "d", "a"]);
});

test("moveDataset last to first within same folder", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f1"),
    makeDataset("c", "f1"),
    makeDataset("d", "f1"),
  ];
  const result = moveDataset(datasets, FOLDERS, {
    datasetId: "d",
    targetFolderId: "f1",
    targetDatasetId: "a",
    placement: "before",
  });
  assert.equal(result.changed, true);
  assert.deepEqual(ids(result.datasets), ["d", "a", "b", "c"]);
});

test("moveDataset moves between folders before a chosen row", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f1"),
    makeDataset("c", "f2"),
    makeDataset("d", "f2"),
  ];
  const result = moveDataset(datasets, FOLDERS, {
    datasetId: "a",
    targetFolderId: "f2",
    targetDatasetId: "c",
    placement: "before",
  });
  assert.equal(result.changed, true);
  assert.deepEqual(ids(result.datasets), ["b", "a", "c", "d"]);
  assert.equal(datasets.find((d) => d.id === "a").folderId, "f2");
});

test("moveDataset moves between folders at the end", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f1"),
    makeDataset("c", "f3"),
  ];
  // f2 is empty — move "a" to end of f2 (after last dataset in f1, the nearest preceding)
  const result = moveDataset(datasets, FOLDERS, {
    datasetId: "a",
    targetFolderId: "f2",
    targetDatasetId: null,
    placement: "end",
  });
  assert.equal(result.changed, true);
  assert.deepEqual(ids(result.datasets), ["b", "a", "c"]);
  assert.equal(datasets.find((d) => d.id === "a").folderId, "f2");
});

test("moveDataset into an empty folder places after nearest preceding non-empty folder", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f1"),
    makeDataset("c", "f3"),
    makeDataset("d", "f3"),
  ];
  // f2 is empty, move c to end of f2 (after last in f1 = b)
  const result = moveDataset(datasets, FOLDERS, {
    datasetId: "c",
    targetFolderId: "f2",
    targetDatasetId: null,
    placement: "end",
  });
  assert.equal(result.changed, true);
  assert.deepEqual(ids(result.datasets), ["a", "b", "c", "d"]);
  assert.equal(datasets.find((d) => d.id === "c").folderId, "f2");
});

test("moveDataset into an empty folder when it's the first folder", () => {
  const datasets = [
    makeDataset("b", "f2"),
    makeDataset("c", "f2"),
  ];
  // f1 is empty, move b to f1 (before first in nearest following = f2)
  const result = moveDataset(datasets, FOLDERS, {
    datasetId: "b",
    targetFolderId: "f1",
    targetDatasetId: null,
    placement: "end",
  });
  assert.equal(result.changed, true);
  assert.deepEqual(ids(result.datasets), ["b", "c"]);
  assert.equal(datasets.find((d) => d.id === "b").folderId, "f1");
});

test("moveDataset no-op when folder and position are unchanged", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f1"),
    makeDataset("c", "f1"),
  ];
  const result = moveDataset(datasets, FOLDERS, {
    datasetId: "b",
    targetFolderId: "f1",
    targetDatasetId: "a",
    placement: "after",
  });
  // b is already after a — no change
  assert.equal(result.changed, false);
  assert.deepEqual(ids(result.datasets), ["a", "b", "c"]);
});

test("moveDataset no-op when dragging to end and it is already last", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f1"),
  ];
  const result = moveDataset(datasets, FOLDERS, {
    datasetId: "b",
    targetFolderId: "f1",
    targetDatasetId: null,
    placement: "end",
  });
  assert.equal(result.changed, false);
});

test("moveDataset preserves active index when active dataset is moved", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f1"),
    makeDataset("c", "f1"),
  ];
  const result = moveDataset(datasets, FOLDERS, {
    datasetId: "b",
    targetFolderId: "f1",
    targetDatasetId: null,
    placement: "end",
  }, "b");
  assert.equal(result.changed, true);
  assert.equal(result.activeIndex, 2);
  assert.equal(result.datasets[result.activeIndex].id, "b");
});

test("moveDataset preserves active index when another dataset is moved around it", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f1"),
    makeDataset("c", "f1"),
  ];
  const result = moveDataset(datasets, FOLDERS, {
    datasetId: "a",
    targetFolderId: "f1",
    targetDatasetId: null,
    placement: "end",
  }, "b");
  assert.equal(result.changed, true);
  assert.equal(result.activeIndex, 0);
  assert.equal(result.datasets[result.activeIndex].id, "b");
});

test("moveDataset preserves object identity — does not clone data", () => {
  const datasets = [
    makeDataset("a", "f1"),
    makeDataset("b", "f1"),
    makeDataset("c", "f2"),
  ];
  const original = datasets[0];
  const result = moveDataset(datasets, FOLDERS, {
    datasetId: "a",
    targetFolderId: "f2",
    targetDatasetId: null,
    placement: "end",
  });
  assert.equal(result.datasets.find((d) => d.id === "a"), original);
  assert.equal(original.folderId, "f2");
});

test("moveDataset throws when dataset is not found", () => {
  const datasets = [makeDataset("a", "f1")];
  assert.throws(() => moveDataset(datasets, FOLDERS, {
    datasetId: "missing",
    targetFolderId: "f1",
    targetDatasetId: null,
    placement: "end",
  }), /dataset not found/i);
});

test("moveDataset throws when target dataset is not found for before/after", () => {
  const datasets = [makeDataset("a", "f1")];
  assert.throws(() => moveDataset(datasets, FOLDERS, {
    datasetId: "a",
    targetFolderId: "f1",
    targetDatasetId: "missing",
    placement: "before",
  }), /target.*not found/i);
});
