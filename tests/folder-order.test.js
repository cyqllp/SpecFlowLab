import assert from "node:assert/strict";
import test from "node:test";

import { moveFolder } from "../src/lib/folder-order.js";

function folders() {
  return ["vis", "nir", "ir"].map((id) => ({ id, payload: `${id}-state` }));
}

test("moveFolder moves a folder before another folder and preserves identity", () => {
  const records = folders();
  const original = records[2];
  const result = moveFolder(records, { folderId: "ir", targetFolderId: "vis", placement: "before" });
  assert.equal(result.changed, true);
  assert.deepEqual(records.map((folder) => folder.id), ["ir", "vis", "nir"]);
  assert.equal(records[0], original);
});

test("moveFolder moves a folder after another folder", () => {
  const records = folders();
  const result = moveFolder(records, { folderId: "vis", targetFolderId: "ir", placement: "after" });
  assert.equal(result.changed, true);
  assert.deepEqual(records.map((folder) => folder.id), ["nir", "ir", "vis"]);
});

test("moveFolder reports adjacent and self drops as no-ops", () => {
  const records = folders();
  assert.equal(moveFolder(records, { folderId: "nir", targetFolderId: "vis", placement: "after" }).changed, false);
  assert.equal(moveFolder(records, { folderId: "nir", targetFolderId: "nir", placement: "before" }).changed, false);
  assert.deepEqual(records.map((folder) => folder.id), ["vis", "nir", "ir"]);
});

test("moveFolder rejects missing targets and unsupported placement", () => {
  assert.throws(() => moveFolder(folders(), { folderId: "missing", targetFolderId: "vis", placement: "before" }), /Folder not found/);
  assert.throws(() => moveFolder(folders(), { folderId: "vis", targetFolderId: "missing", placement: "before" }), /Target folder not found/);
  assert.throws(() => moveFolder(folders(), { folderId: "vis", targetFolderId: "nir", placement: "end" }), /Unsupported folder placement/);
});
