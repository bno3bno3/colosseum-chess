import test from "node:test";
import assert from "node:assert/strict";
import { groupCapturedPieces } from "../public/captured.mjs";

test("吃子统计按鼠到象排序、足球置后并聚合为倍数", () => {
  const grouped = groupCapturedPieces([
    { type: "elephant", color: "red" },
    { type: "cat", color: "red" },
    { type: "mouse", color: "red" },
    { type: "football", color: "red" },
    { type: "cat", color: "red" },
    { type: "tiger", color: "red" },
    { type: "mouse", color: "red" },
    { type: "mouse", color: "red" },
  ]);
  assert.deepEqual(grouped.map((entry) => entry.type), ["mouse", "cat", "tiger", "elephant", "football"]);
  assert.deepEqual(grouped.map((entry) => entry.count), [3, 2, 1, 1, 1]);
});
