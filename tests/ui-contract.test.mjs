import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [html, app, css] = await Promise.all([
  readFile(new URL("public/index.html", root), "utf8"),
  readFile(new URL("public/app.js", root), "utf8"),
  readFile(new URL("public/styles.css", root), "utf8"),
]);

test("对局界面包含我方标记、AI、观战和双侧吃子列表入口", () => {
  assert.match(html, /class="me-badge"/);
  assert.match(html, /id="ai-player-button"/);
  assert.match(html, /id="spectate-code-button"/);
  assert.match(html, /id="captured-blue-pieces"/);
  assert.match(html, /id="captured-red-pieces"/);
  assert.match(app, /asSpectator:\s*true/);
  assert.match(app, /state\.room\?\.role !== "player"/);
  assert.match(app, /groupCapturedPieces/);
  assert.match(app, /captured-multiplier/);
  assert.match(app, /AI 预判中/);
  assert.match(app, /ponderIterations/);
  assert.match(css, /\.captured-item/);
});

test("主要动效均有独立动画并由运行态类名触发", () => {
  for (const animation of [
    "selected-hover",
    "piece-flip",
    "piece-move",
    "piece-capture",
    "captured-arrive",
    "danger-frame",
  ]) {
    assert.match(css, new RegExp(`@keyframes\\s+${animation}`));
  }
  for (const runtimeClass of ["just-flipped", "just-moved", "just-captured", "countdown-danger"]) {
    assert.match(app, new RegExp(runtimeClass));
  }
});

test("局域网 HTTP 会话 ID 有兼容降级，重复局面禁着有前端提示", () => {
  assert.match(app, /createSessionId\(\)/);
  assert.match(app, /repetitionForbiddenMoves/);
  assert.match(app, /第 4 次出现/);
  assert.match(css, /\.board-cell\.repetition-forbidden::after/);
});
