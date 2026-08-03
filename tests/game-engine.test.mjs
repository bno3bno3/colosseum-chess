import test from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_SIZE,
  canAnimalCapture,
  canFootballCapture,
  createGame,
  flipPiece,
  gameViewFor,
  legalActionsFor,
  makePiece,
  makePieceSet,
  movePiece,
  processTurnTimeout,
  positionSignature,
  resignGame,
} from "../server/game-engine.mjs";

function piece(type, color, revealed = true, id = `${color}-${type}-${Math.random()}`) {
  return { ...makePiece(type, color, id), revealed };
}

function emptyBoard() {
  return Array(BOARD_SIZE).fill(null);
}

function fixedGame(board, options = {}) {
  return createGame({
    playerIds: ["player-blue", "player-red"],
    initialHealth: options.health ?? 14,
    turnDurationMs: options.turnDurationMs ?? 30_000,
    rng: () => 0,
    now: options.now ?? 1_000,
    board,
  });
}

test("每方棋子数量与总棋盘完全匹配", () => {
  const pieces = makePieceSet();
  assert.equal(pieces.length, 32);
  for (const color of ["blue", "red"]) {
    const own = pieces.filter((item) => item.color === color);
    assert.equal(own.length, 16);
    assert.equal(own.filter((item) => item.type === "elephant").length, 2);
    assert.equal(own.filter((item) => item.type === "tiger").length, 2);
    assert.equal(own.filter((item) => item.type === "wolf").length, 2);
    assert.equal(own.filter((item) => item.type === "dog").length, 2);
    assert.equal(own.filter((item) => item.type === "cat").length, 3);
    assert.equal(own.filter((item) => item.type === "mouse").length, 3);
    assert.equal(own.filter((item) => item.type === "football").length, 2);
  }
});

test("动物强弱、同级、老鼠大象和足球特例", () => {
  assert.equal(canAnimalCapture("tiger", "wolf"), true);
  assert.equal(canAnimalCapture("wolf", "tiger"), false);
  assert.equal(canAnimalCapture("cat", "cat"), true);
  assert.equal(canAnimalCapture("mouse", "elephant"), true);
  assert.equal(canAnimalCapture("elephant", "mouse"), false);
  assert.equal(canAnimalCapture("dog", "football"), true);
  assert.equal(canAnimalCapture("mouse", "football"), false);
  assert.equal(canAnimalCapture("football", "mouse"), false);
});

test("暗子只下发占位信息，翻子会换回合", () => {
  const board = emptyBoard();
  board[0] = piece("elephant", "red", false, "secret-elephant");
  const game = fixedGame(board);
  const before = gameViewFor(game, "player-blue", 1_000);
  assert.deepEqual(before.board[0], { hidden: true });
  assert.equal(JSON.stringify(before).includes("elephant"), false);

  flipPiece(game, "blue", 0, { version: 1, now: 1_500 });
  assert.equal(game.board[0].revealed, true);
  assert.equal(game.turn, "red");
  assert.equal(game.version, 2);
  assert.equal(game.turnDeadline, 31_500);
});

test("普通移动仅限正交一格且不能移动敌方、暗子或进入暗子", () => {
  const board = emptyBoard();
  board[0] = piece("dog", "blue");
  board[1] = piece("cat", "red", false);
  board[4] = piece("mouse", "red");
  const game = fixedGame(board);
  assert.throws(() => movePiece(game, "blue", 0, 5, { version: 1 }), { code: "move_too_far" });
  assert.throws(() => movePiece(game, "blue", 0, 1, { version: 1 }), { code: "hidden_target" });
  assert.throws(() => movePiece(game, "blue", 4, 5, { version: 1 }), { code: "opponent_piece" });

  movePiece(game, "blue", 0, 4, { version: 1, now: 2_000 });
  assert.equal(game.board[0], null);
  assert.equal(game.board[4].type, "dog");
  assert.equal(game.health.red, 13);
});

test("大象不能吃老鼠，老鼠可以吃大象并触发血量胜利", () => {
  const illegalBoard = emptyBoard();
  illegalBoard[0] = piece("elephant", "blue");
  illegalBoard[1] = piece("mouse", "red");
  const illegal = fixedGame(illegalBoard);
  assert.throws(() => movePiece(illegal, "blue", 0, 1, { version: 1 }), { code: "weaker_piece" });

  const winningBoard = emptyBoard();
  winningBoard[0] = piece("mouse", "blue");
  winningBoard[1] = piece("elephant", "red");
  const winning = fixedGame(winningBoard, { health: 1 });
  movePiece(winning, "blue", 0, 1, { version: 1, now: 2_000 });
  assert.equal(winning.status, "finished");
  assert.equal(winning.winner, "blue");
  assert.equal(winning.endReason, "health");
  assert.equal(winning.health.red, 0);
});

test("老鼠不能吃足球，其他动物仍可吃足球", () => {
  const mouseBoard = emptyBoard();
  mouseBoard[0] = piece("mouse", "blue");
  mouseBoard[1] = piece("football", "red");
  assert.throws(() => movePiece(fixedGame(mouseBoard), "blue", 0, 1, { version: 1 }), { code: "weaker_piece" });

  const catBoard = emptyBoard();
  catBoard[0] = piece("cat", "blue");
  catBoard[1] = piece("football", "red");
  const game = fixedGame(catBoard);
  movePiece(game, "blue", 0, 1, { version: 1, now: 2_000 });
  assert.equal(game.board[1].type, "cat");
  assert.deepEqual(game.capturedBy.blue, [{ type: "football", color: "red" }]);
  assert.deepEqual(gameViewFor(game, "player-blue").capturedBy.blue, [{ type: "football", color: "red" }]);
});

test("足球吃子时允许任意空位但必须恰好一枚炮架", () => {
  const board = emptyBoard();
  board[0] = piece("football", "blue");
  board[8] = piece("cat", "red", false);
  board[20] = piece("elephant", "red");
  assert.equal(canFootballCapture(board, 0, 20), true);
  assert.equal(canFootballCapture(board, 0, 3), false);

  const game = fixedGame(board);
  movePiece(game, "blue", 0, 20, { version: 1, now: 2_000 });
  assert.equal(game.board[20].type, "football");
  assert.equal(game.health.red, 13);
});

test("足球无炮架、两个炮架、斜线和暗目标都不能吃", () => {
  const noScreen = emptyBoard();
  noScreen[0] = piece("football", "blue");
  noScreen[12] = piece("dog", "red");
  assert.throws(() => movePiece(fixedGame(noScreen), "blue", 0, 12, { version: 1 }), { code: "football_screen" });

  const twoScreens = emptyBoard();
  twoScreens[0] = piece("football", "blue");
  twoScreens[4] = piece("mouse", "blue");
  twoScreens[8] = piece("cat", "red", false);
  twoScreens[16] = piece("dog", "red");
  assert.throws(() => movePiece(fixedGame(twoScreens), "blue", 0, 16, { version: 1 }), { code: "football_screen" });

  const diagonal = emptyBoard();
  diagonal[0] = piece("football", "blue");
  diagonal[1] = piece("cat", "blue");
  diagonal[5] = piece("dog", "red");
  assert.throws(() => movePiece(fixedGame(diagonal), "blue", 0, 5, { version: 1 }), { code: "football_screen" });

  const hiddenTarget = emptyBoard();
  hiddenTarget[0] = piece("football", "blue");
  hiddenTarget[4] = piece("cat", "blue");
  hiddenTarget[8] = piece("dog", "red", false);
  assert.throws(() => movePiece(fixedGame(hiddenTarget), "blue", 0, 8, { version: 1 }), { code: "hidden_target" });
});

test("足球不吃子时只能正交移动一格", () => {
  const board = emptyBoard();
  board[0] = piece("football", "blue");
  const game = fixedGame(board);
  assert.throws(() => movePiece(game, "blue", 0, 8, { version: 1 }), { code: "move_too_far" });
  movePiece(game, "blue", 0, 1, { version: 1, now: 2_000 });
  assert.equal(game.board[1].type, "football");
});

test("回合超时自动过轮且不扣血，认输立即结束", () => {
  const game = fixedGame(emptyBoard(), { now: 1_000, turnDurationMs: 1_000 });
  assert.equal(processTurnTimeout(game, 1_999), false);
  assert.equal(processTurnTimeout(game, 2_000), true);
  assert.equal(game.turn, "red");
  assert.deepEqual(game.health, { blue: 14, red: 14 });
  assert.equal(game.lastAction.type, "timeout");

  resignGame(game, "red", { now: 2_100 });
  assert.equal(game.status, "finished");
  assert.equal(game.winner, "blue");
  assert.equal(game.endReason, "resign");
});

test("过期版本和非当前玩家操作会被拒绝", () => {
  const board = emptyBoard();
  board[0] = piece("cat", "blue", false);
  const game = fixedGame(board);
  assert.throws(() => flipPiece(game, "blue", 0, { version: 99 }), { code: "stale_version" });
  assert.throws(() => flipPiece(game, "red", 0, { version: 1 }), { code: "not_your_turn" });
});

test("合法动作枚举会区分吃子、翻子和普通移动", () => {
  const board = emptyBoard();
  board[0] = piece("dog", "blue");
  board[1] = piece("cat", "red");
  board[4] = piece("mouse", "red", false);
  const actions = legalActionsFor(fixedGame(board), "blue");
  assert.deepEqual(actions.captures.map(({ from, to }) => [from, to]), [[0, 1]]);
  assert.deepEqual(actions.flips, [{ type: "flip", index: 4 }]);
  assert.equal(actions.moves.length, 0);
});

test("同一局面第 4 次出现的移动会被禁用且服务端拒绝执行", () => {
  const board = emptyBoard();
  board[0] = piece("cat", "blue");
  board[31] = piece("dog", "red");
  const game = fixedGame(board);
  const repeatedBoard = [...game.board];
  repeatedBoard[1] = repeatedBoard[0];
  repeatedBoard[0] = null;
  const repeatedSignature = positionSignature(repeatedBoard, "red");
  game.positionCounts[repeatedSignature] = 3;

  const legal = legalActionsFor(game, "blue");
  assert.equal(legal.moves.some(({ from, to }) => from === 0 && to === 1), false);
  assert.equal(legal.forbiddenRepetitionMoves.some(({ from, to }) => from === 0 && to === 1), true);
  assert.throws(() => movePiece(game, "blue", 0, 1, { version: 1, now: 2_000 }), {
    code: "position_repetition",
  });
  assert.equal(game.board[0].type, "cat");
  assert.equal(game.board[1], null);
  assert.equal(game.version, 1);

  game.positionCounts[repeatedSignature] = 2;
  movePiece(game, "blue", 0, 1, { version: 1, now: 2_000 });
  assert.equal(game.positionCounts[repeatedSignature], 3);
});

test("重复局面按棋子排列和行动方计数，不受棋子 ID 影响", () => {
  const first = emptyBoard();
  first[5] = piece("wolf", "blue", true, "wolf-a");
  const second = emptyBoard();
  second[5] = piece("wolf", "blue", true, "wolf-b");
  assert.equal(positionSignature(first, "red"), positionSignature(second, "red"));
  assert.notEqual(positionSignature(first, "blue"), positionSignature(first, "red"));
});

test("回放帧记录初始画面和每一步，且从不泄露暗子身份", () => {
  const board = emptyBoard();
  board[0] = piece("elephant", "blue", false, "secret-elephant");
  board[1] = piece("cat", "red", false, "secret-cat");
  const game = fixedGame(board);
  assert.equal(game.replayFrames.length, 1);
  assert.deepEqual(game.replayFrames[0].board[0], { hidden: true });
  assert.equal(JSON.stringify(game.replayFrames[0]).includes("secret-elephant"), false);

  flipPiece(game, "blue", 0, { version: 1, now: 2_000 });
  assert.equal(game.replayFrames.length, 2);
  assert.equal(game.replayFrames[1].action.type, "flip");
  assert.equal(game.replayFrames[1].board[0].type, "elephant");
  assert.deepEqual(game.replayFrames[1].board[1], { hidden: true });

  resignGame(game, "red", { now: 3_000 });
  assert.equal(game.replayFrames.length, 3);
  assert.equal(game.replayFrames[2].status, "finished");
  assert.equal(game.replayFrames[2].winner, "blue");
});
