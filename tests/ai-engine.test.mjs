import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_AI_SEARCH_MS,
  chooseAIAction,
  determinize,
  publicStateForAI,
  remainingInventory,
} from "../server/ai-engine.mjs";
import { createGame, makePiece, makePieceSet, otherColor, positionSignature } from "../server/game-engine.mjs";

function piece(type, color, revealed = true) {
  return { ...makePiece(type, color, `${color}-${type}-ai-test`), revealed };
}

function state(board, options = {}) {
  return {
    status: "playing",
    turn: options.turn ?? "blue",
    health: options.health ?? { blue: 5, red: 5 },
    initialHealth: options.initialHealth ?? 5,
    board,
    capturedBy: options.capturedBy ?? { blue: [], red: [] },
  };
}

test("AI 输入会彻底移除暗子身份，不会偷看服务器真实棋盘", () => {
  const board = makePieceSet();
  board[0].revealed = true;
  const game = createGame({ playerIds: ["a", "b"], board, rng: () => 0 });
  const view = publicStateForAI(game);
  assert.equal(view.board[0].type, board[0].type);
  assert.deepEqual(view.board[1], { revealed: false });
  assert.equal(JSON.stringify(view.board[1]).includes(board[1].type), false);
  assert.equal(view.board.filter((item) => item && !item.revealed).every((item) => !item.type && !item.color), true);
});

test("剩余暗子概率会扣除所有已翻开和已吃掉棋子", () => {
  const board = Array(32).fill(null);
  board[0] = { type: "elephant", color: "blue", revealed: true };
  board[1] = { type: "mouse", color: "red", revealed: true };
  for (let index = 2; index < 31; index += 1) board[index] = { revealed: false };
  const publicState = state(board, {
    capturedBy: { blue: [{ type: "tiger", color: "red" }], red: [] },
  });
  const inventory = remainingInventory(publicState);
  assert.equal(inventory.remaining.blue.elephant, 1);
  assert.equal(inventory.remaining.red.mouse, 2);
  assert.equal(inventory.remaining.red.tiger, 1);
  assert.equal(inventory.pool.length, 29);

  const sampled = determinize(publicState, () => 0.25);
  const hidden = sampled.board.filter((item) => item && !item.revealed);
  assert.equal(hidden.length, 29);
  assert.equal(hidden.every((item) => item.type && item.color), true);
});

test("AI 会立即执行一击结束比赛的合法吃子", () => {
  const board = Array(32).fill(null);
  board[0] = piece("mouse", "blue");
  board[1] = piece("elephant", "red");
  const result = chooseAIAction(state(board, { health: { blue: 1, red: 1 }, initialHealth: 1 }), "blue", {
    timeLimitMs: 5_000,
    seed: 7,
  });
  assert.equal(result.method, "forced-win");
  assert.deepEqual({ from: result.action.from, to: result.action.to }, { from: 0, to: 1 });
  assert.ok(result.elapsedMs < 100);
});

test("完全信息终局会搜索反吃，避开贪吃陷阱", () => {
  const board = Array(32).fill(null);
  board[0] = piece("dog", "blue");
  board[1] = piece("cat", "red");
  board[2] = piece("elephant", "red");
  board[8] = piece("cat", "blue");
  board[9] = piece("mouse", "red");
  const result = chooseAIAction(state(board, { health: { blue: 3, red: 3 }, initialHealth: 3 }), "blue", {
    timeLimitMs: 180,
    seed: 11,
  });
  assert.equal(result.method, "alpha-beta");
  assert.deepEqual({ from: result.action.from, to: result.action.to }, { from: 8, to: 9 });
  assert.ok(result.completedDepth >= 2);
});

test("信息集 MCTS 在固定采样种子与迭代数下可复现", () => {
  const game = createGame({ playerIds: ["a", "b"], rng: () => 0 });
  const publicState = publicStateForAI(game);
  const options = { timeLimitMs: 2_000, maxIterations: 220, seed: 2026 };
  const first = chooseAIAction(publicState, game.turn, options);
  const second = chooseAIAction(publicState, game.turn, options);
  assert.equal(first.method, "so-ismcts");
  assert.deepEqual(first.action, second.action);
  assert.equal(first.iterations, 220);
  assert.equal(second.iterations, 220);
});

test("真人回合可预判下一层公开信息集而不读取暗子身份", () => {
  const game = createGame({ playerIds: ["human", "ai"], rng: () => 0.3 });
  const publicState = publicStateForAI(game);
  const result = chooseAIAction(publicState, otherColor(game.turn), {
    ponder: true,
    timeLimitMs: 2_000,
    maxIterations: 500,
    seed: 808,
  });
  assert.equal(result.method, "ponder-ismcts");
  assert.equal(result.action, null);
  assert.equal(publicState.board.filter((item) => item && !item.revealed).every((item) => !item.type), true);
  assert.ok(result.ponderStates.length > 0);
  assert.ok(result.ponderStates.some((entry) => entry.candidates.some((candidate) => candidate.visits > 0)));
});

test("搜索预算硬上限为 15 秒，短预算仍会及时返回合法走法", () => {
  assert.equal(MAX_AI_SEARCH_MS, 15_000);
  const game = createGame({ playerIds: ["a", "b"], rng: () => 0.4 });
  const publicState = publicStateForAI(game);
  const started = Date.now();
  const result = chooseAIAction(publicState, game.turn, { timeLimitMs: 60, seed: 99 });
  const wallTime = Date.now() - started;
  assert.ok(result.action);
  assert.ok(result.iterations > 10);
  assert.ok(result.elapsedMs < 400);
  assert.ok(wallTime < 500);
});

test("AI 不会选择会造成第 4 次重复局面的走法", () => {
  const board = Array(32).fill(null);
  board[0] = piece("cat", "blue");
  board[31] = piece("dog", "red");
  const game = createGame({ playerIds: ["a", "b"], board, rng: () => 0 });
  const repeatedBoard = [...game.board];
  repeatedBoard[1] = repeatedBoard[0];
  repeatedBoard[0] = null;
  const repeatedKey = positionSignature(repeatedBoard, "red");
  game.positionCounts[repeatedKey] = 3;
  const result = chooseAIAction(publicStateForAI(game), "blue", { timeLimitMs: 30, seed: 17 });
  assert.notDeepEqual(result.action && { from: result.action.from, to: result.action.to }, { from: 0, to: 1 });
});
