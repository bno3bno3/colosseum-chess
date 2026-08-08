import test from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_SIZE,
  createGame,
  flipPiece,
  gameViewFor,
  legalActionsFor,
  makePiece,
  makePieceSet,
  movePiece,
  processTurnTimeout,
} from "../server/game-engine.mjs";
import { applySimulatedAction, publicStateForAI, remainingInventory } from "../server/ai-engine.mjs";
import { chooseVersionedAIAction } from "../server/ai-versions.mjs";
import { normalizeRuleIds, ruleCatalog } from "../server/rule-system.mjs";

const shown = (type, color, id = `${color}-${type}`) => ({ ...makePiece(type, color, id), revealed: true });
const empty = () => Array(BOARD_SIZE).fill(null);

function gameWith(board, ruleIds, health = 14) {
  return createGame({
    playerIds: ["blue-player", "red-player"],
    initialHealth: health,
    turnDurationMs: 30_000,
    rng: () => 0,
    now: 1_000,
    board,
    ruleIds,
  });
}

function forceBlue(game) {
  game.turn = "blue";
  game.players = { blue: "blue-player", red: "red-player" };
  game.positionCounts = Object.create(null);
}

test("规则注册表会过滤未知项，蛇规则只把每方一只猫替换为蛇", () => {
  assert.deepEqual(ruleCatalog().map((rule) => rule.id), ["football-poison", "snake"]);
  assert.deepEqual(normalizeRuleIds(["snake", "unknown", "snake"]), ["snake"]);
  const pieces = makePieceSet(["snake"]);
  for (const color of ["blue", "red"]) {
    assert.equal(pieces.filter((piece) => piece.color === color && piece.type === "cat").length, 2);
    assert.equal(pieces.filter((piece) => piece.color === color && piece.type === "snake").length, 1);
    assert.equal(pieces.filter((piece) => piece.color === color).length, 16);
  }
});

test("吃足球会中毒，新感染回合不扣时；三个后续己方回合后死亡并扣血", () => {
  const board = empty();
  board[0] = shown("cat", "blue", "poison-cat");
  board[1] = shown("football", "red", "poison-ball");
  board[31] = shown("dog", "red", "wait-red");
  const game = gameWith(board, ["football-poison"], 4);
  forceBlue(game);
  movePiece(game, "blue", 0, 1, { version: game.version, now: 2_000 });
  assert.deepEqual([game.board[1].poisoned, game.board[1].poisonTurns], [true, 3]);
  for (let turn = 0; turn < 2; turn += 1) {
    game.turn = "red";
    game.turnDeadline = 2_100 + turn * 2_000;
    processTurnTimeout(game, game.turnDeadline);
    game.turnDeadline += 1;
    processTurnTimeout(game, game.turnDeadline);
  }
  assert.equal(game.board[1].poisonTurns, 1);
  game.turn = "blue";
  game.turnDeadline = 10_000;
  processTurnTimeout(game, 10_000);
  assert.equal(game.board[1], null);
  assert.equal(game.health.blue, 3);
  assert.equal(game.capturedBy.red.at(-1).cause, "poison");
  assert.equal(game.lastAction.poisonDeaths[0].type, "cat");
});

test("毒发扣掉最后一格血时立即以毒素原因判负", () => {
  const board = empty();
  board[0] = { ...shown("cat", "blue", "fatal-poison"), poisoned: true, poisonTurns: 1 };
  const game = gameWith(board, ["football-poison"], 1);
  forceBlue(game);
  game.turnDeadline = 2_000;
  processTurnTimeout(game, 2_000);
  assert.equal(game.status, "finished");
  assert.equal(game.winner, "red");
  assert.equal(game.endReason, "poison");
  assert.equal(game.turnDeadline, null);
});

test("中毒单位吃普通单位可解毒，吃中毒单位则传染并重置为三回合", () => {
  const board = empty();
  board[0] = { ...shown("dog", "blue", "carrier"), poisoned: true, poisonTurns: 1 };
  board[1] = shown("cat", "red", "healthy");
  let game = gameWith(board, ["football-poison"]);
  forceBlue(game);
  movePiece(game, "blue", 0, 1, { version: game.version, now: 2_000 });
  assert.equal(Boolean(game.board[1].poisoned), false);
  assert.equal(game.lastAction.cured, true);

  const chain = empty();
  chain[0] = { ...shown("dog", "blue", "chain-carrier"), poisoned: true, poisonTurns: 1 };
  chain[1] = { ...shown("cat", "red", "chain-target"), poisoned: true, poisonTurns: 2 };
  game = gameWith(chain, ["football-poison"]);
  forceBlue(game);
  movePiece(game, "blue", 0, 1, { version: game.version, now: 2_000 });
  assert.deepEqual([game.board[1].poisoned, game.board[1].poisonTurns], [true, 3]);
});

test("蛇会沿攻击方向击退，退路被占或越界才吃掉，大象免疫", () => {
  const board = empty();
  board[4] = shown("snake", "blue", "snake-push");
  board[8] = shown("tiger", "red", "tiger-pushed");
  let game = gameWith(board, ["snake"]);
  forceBlue(game);
  assert.equal(legalActionsFor(game, "blue").moves.some((action) => action.from === 4 && action.to === 8 && action.push), true);
  movePiece(game, "blue", 4, 8, { version: game.version, now: 2_000 });
  assert.equal(game.board[4].type, "snake");
  assert.equal(game.board[8], null);
  assert.equal(game.board[12].type, "tiger");
  assert.equal(game.health.red, 14);
  assert.equal(game.lastAction.type, "push");

  const blocked = empty();
  blocked[4] = shown("snake", "blue", "snake-capture");
  blocked[8] = shown("tiger", "red", "tiger-captured");
  blocked[12] = shown("mouse", "blue", "blocker");
  game = gameWith(blocked, ["snake"]);
  forceBlue(game);
  movePiece(game, "blue", 4, 8, { version: game.version, now: 2_000 });
  assert.equal(game.board[8].type, "snake");
  assert.equal(game.health.red, 13);
  assert.equal(game.lastAction.type, "capture");

  const edge = empty();
  edge[4] = shown("snake", "blue", "edge-snake");
  edge[0] = shown("wolf", "red", "edge-wolf");
  game = gameWith(edge, ["snake"]);
  forceBlue(game);
  movePiece(game, "blue", 4, 0, { version: game.version, now: 2_000 });
  assert.equal(game.health.red, 13);

  const elephant = empty();
  elephant[4] = shown("snake", "blue", "snake-elephant");
  elephant[8] = shown("elephant", "red", "immune-elephant");
  game = gameWith(elephant, ["snake"]);
  forceBlue(game);
  assert.throws(() => movePiece(game, "blue", 4, 8, { version: game.version }), { code: "snake_elephant" });
});

test("玩家视图、回放和 AI 公开状态都携带规则与可见毒素，但仍不泄露暗子", () => {
  const board = empty();
  board[0] = { ...shown("snake", "blue", "visible"), poisoned: true, poisonTurns: 2 };
  board[1] = { ...makePiece("elephant", "red", "secret"), revealed: false };
  const game = gameWith(board, ["football-poison", "snake"]);
  forceBlue(game);
  const view = gameViewFor(game, "blue-player");
  assert.deepEqual(view.ruleIds, ["football-poison", "snake"]);
  assert.deepEqual([view.board[0].poisoned, view.board[0].poisonTurns], [true, 2]);
  assert.deepEqual(view.board[1], { hidden: true });
  const state = publicStateForAI(game);
  assert.deepEqual(state.ruleIds, ["football-poison", "snake"]);
  assert.equal(state.pieceCounts.snake, 1);
  assert.equal(JSON.stringify(state.board[1]).includes("elephant"), false);
  assert.equal(remainingInventory(state).remaining.blue.snake, 0);
});

test("AI 模拟器与服务器对蛇击退和毒素倒计时采用同一规则", () => {
  const board = empty();
  board[4] = { ...shown("snake", "blue"), poisoned: true, poisonTurns: 2 };
  board[8] = shown("wolf", "red");
  const game = gameWith(board, ["football-poison", "snake"]);
  forceBlue(game);
  const simulated = publicStateForAI(game);
  assert.equal(applySimulatedAction(simulated, { type: "move", from: 4, to: 8 }), true);
  assert.equal(simulated.board[4].type, "snake");
  assert.equal(simulated.board[8], null);
  assert.equal(simulated.board[12].type, "wolf");
  assert.equal(simulated.board[4].poisonTurns, 1);
  assert.equal(simulated.turn, "red");
});

test("V1 与 V2 都会按蛇规则找到堵住退路后的立即胜着", () => {
  const board = empty();
  board[4] = shown("snake", "blue", "winning-snake");
  board[8] = shown("tiger", "red", "last-health-target");
  board[12] = shown("mouse", "blue", "retreat-blocker");
  const game = gameWith(board, ["snake"]);
  forceBlue(game);
  game.health.red = 1;
  const state = publicStateForAI(game);
  for (const aiVersion of ["v1", "v2"]) {
    const result = chooseVersionedAIAction(state, "blue", {
      aiVersion,
      timeLimitMs: 60,
      maxIterations: 96,
      seed: 42,
    });
    assert.deepEqual([result.action.type, result.action.from, result.action.to], ["move", 4, 8]);
  }
});
