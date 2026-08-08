import test from "node:test";
import assert from "node:assert/strict";
import { chooseAIAction, publicStateForAI } from "../server/ai-engine.mjs";
import {
  applyBeliefAction,
  chooseAIActionV2,
} from "../server/ai-engine-v2.mjs";
import { chooseVersionedAIAction } from "../server/ai-versions.mjs";
import { createGame, makePiece } from "../server/game-engine.mjs";

function piece(type, color, revealed = true) {
  return { ...makePiece(type, color, `${color}-${type}-v2-test`), revealed };
}

function state(board, options = {}) {
  return {
    status: "playing",
    turn: options.turn ?? "blue",
    health: options.health ?? { blue: 5, red: 5 },
    initialHealth: options.initialHealth ?? 5,
    board,
    capturedBy: options.capturedBy ?? { blue: [], red: [] },
    positionCounts: options.positionCounts ?? {},
  };
}

test("V1 原引擎保持可用，版本分发器可明确选择 V1 或 V2", () => {
  const board = Array(32).fill(null);
  board[0] = piece("mouse", "blue");
  board[1] = piece("elephant", "red");
  const publicState = state(board, { health: { blue: 1, red: 1 }, initialHealth: 1 });
  const original = chooseAIAction(publicState, "blue", { timeLimitMs: 30, seed: 7 });
  const v1 = chooseVersionedAIAction(publicState, "blue", { aiVersion: "v1", timeLimitMs: 30, seed: 7 });
  const v2 = chooseVersionedAIAction(publicState, "blue", { aiVersion: "v2", timeLimitMs: 30, seed: 7 });
  assert.equal(v1.aiVersion, "v1");
  assert.equal(v1.method, original.method);
  assert.deepEqual(v1.action, original.action);
  assert.equal(v2.aiVersion, "v2");
  assert.equal(v2.method, "forced-win-v2");
});

test("V2 只在翻棋发生时抽样该格，绝不确定化其余暗子", () => {
  const game = createGame({ playerIds: ["a", "b"], rng: () => 0.2 });
  const publicState = publicStateForAI(game);
  const next = structuredClone(publicState);
  assert.equal(applyBeliefAction(next, { type: "flip", index: 7 }, () => 0.4), true);
  assert.equal(next.board[7].revealed, true);
  assert.ok(next.board[7].type);
  assert.ok(next.board[7].color);
  assert.equal(next.board.filter((item, index) => index !== 7 && item && !item.revealed).length, 31);
  assert.equal(next.board.filter((item, index) => index !== 7 && item && !item.revealed).every((item) => !item.type && !item.color), true);
});

test("V2 概率树在固定种子和迭代数下可复现", () => {
  const game = createGame({ playerIds: ["a", "b"], rng: () => 0.35 });
  const publicState = publicStateForAI(game);
  const options = { timeLimitMs: 3_000, maxIterations: 48, seed: 20260804, v2Lane: "belief" };
  const first = chooseAIActionV2(publicState, game.turn, options);
  const second = chooseAIActionV2(publicState, game.turn, options);
  assert.equal(first.method, "belief-mcts-v2");
  assert.equal(first.iterations, 48);
  assert.equal(second.iterations, 48);
  assert.deepEqual(first.action, second.action);
});

test("V2 吃子静态延伸会避开贪吃后的立即反吃", () => {
  const board = Array(32).fill(null);
  board[0] = piece("dog", "blue");
  board[1] = piece("cat", "red");
  board[2] = piece("elephant", "red");
  board[8] = piece("cat", "blue");
  board[9] = piece("mouse", "red");
  const result = chooseAIActionV2(state(board, {
    health: { blue: 3, red: 3 },
    initialHealth: 3,
  }), "blue", { timeLimitMs: 180, seed: 11 });
  assert.equal(result.method, "alpha-beta-v2");
  assert.deepEqual({ from: result.action.from, to: result.action.to }, { from: 8, to: 9 });
  assert.ok(result.completedDepth >= 4);
});

test("V2 预判也使用公开概率树并产出可复用分支", () => {
  const game = createGame({ playerIds: ["human", "ai"], rng: () => 0.4 });
  const publicState = publicStateForAI(game);
  const aiColor = game.turn === "blue" ? "red" : "blue";
  const result = chooseAIActionV2(publicState, aiColor, {
    ponder: true,
    timeLimitMs: 3_000,
    maxIterations: 70,
    seed: 8080,
    v2Lane: "belief",
  });
  assert.equal(result.method, "ponder-belief-mcts-v2");
  assert.equal(result.action, null);
  assert.ok(result.ponderStates.length > 0);
  assert.ok(result.ponderStates.some((entry) => entry.candidates.some((candidate) => candidate.visits > 0)));
});

test("V2 默认混合通道保留 V1 搜索结果并增加战术安全复核", () => {
  const game = createGame({ playerIds: ["a", "b"], rng: () => 0.27 });
  const result = chooseAIActionV2(publicStateForAI(game), game.turn, {
    timeLimitMs: 80,
    seed: 909,
  });
  assert.equal(result.method, "hybrid-mcts-v2");
  assert.equal(result.aiVersion, "v2");
  assert.equal(result.lane, "classic");
  assert.ok(result.action);
  assert.ok(result.iterations > 0);
});

test("V2 搜索时间片可继承先前根统计，同时只回传本片新增访问", () => {
  const game = createGame({ playerIds: ["a", "b"], rng: () => 0.22 });
  const publicState = publicStateForAI(game);
  const first = chooseAIAction(publicState, game.turn, {
    timeLimitMs: 2_000,
    maxIterations: 80,
    seed: 101,
  });
  const continued = chooseAIAction(publicState, game.turn, {
    timeLimitMs: 2_000,
    maxIterations: 40,
    seed: 202,
    initialCandidates: first.candidates,
  });
  assert.equal(continued.candidateDeltas.reduce((sum, candidate) => sum + candidate.visits, 0), 40);
  assert.ok(continued.candidates[0].visits > continued.candidateDeltas[0].visits);
});

test("只剩一个暗子时 V2 会用公开棋池推导身份并进入强化终局", () => {
  const game = createGame({ playerIds: ["a", "b"], rng: () => 0.18 });
  game.board.forEach((item, index) => { item.revealed = index !== 0; });
  const result = chooseAIActionV2(publicStateForAI(game), game.turn, {
    timeLimitMs: 80,
    seed: 303,
  });
  assert.equal(result.method, "deduced-alpha-beta-v2");
  assert.ok(result.action);
});
