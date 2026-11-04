import { test } from "node:test";
import assert from "node:assert/strict";
import { protectUnsavedWork } from "../src/lib/unsaved-work.js";

test("unsaved work decisions protect replacement", async () => {
  for (const [choice, result, expected] of [["save", true, true], ["save", false, false], ["save", null, false], ["discard", null, true], ["cancel", null, false]]) {
    assert.equal(await protectUnsavedWork({ dirty: true, decide: async () => choice, save: async () => result }), expected);
  }
  assert.equal(await protectUnsavedWork({ dirty: true, decide: async () => "save", save: async () => { throw Error("disk full"); } }), false);
  assert.equal(await protectUnsavedWork({ dirty: false, decide: () => { throw Error("unexpected"); } }), true);
});
