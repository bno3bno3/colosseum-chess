import { randomUUID } from "node:crypto";

export const COLS = 4;
export const ROWS = 8;
export const BOARD_SIZE = COLS * ROWS;
export const TURN_DURATION_MS = 30_000;
export const COLORS = ["blue", "red"];

export const PIECE_COUNTS = Object.freeze({
  elephant: 2,
  tiger: 2,
  wolf: 2,
  dog: 2,
  cat: 3,
  mouse: 3,
  football: 2,
});

export const PIECE_LABELS = Object.freeze({
  elephant: "大象",
  tiger: "老虎",
  wolf: "狼",
  dog: "狗",
  cat: "猫",
  mouse: "老鼠",
  football: "足球",
});

const RANKS = Object.freeze({
  elephant: 6,
  tiger: 5,
  wolf: 4,
  dog: 3,
  cat: 2,
  mouse: 1,
});

const POSITION_CODES = Object.freeze({
  elephant: "E",
  tiger: "T",
  wolf: "W",
  dog: "D",
  cat: "C",
  mouse: "M",
  football: "F",
});

export class GameRuleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GameRuleError";
    this.code = code;
  }
}

export function otherColor(color) {
  return color === "blue" ? "red" : "blue";
}

export function indexToPoint(index) {
  return { row: Math.floor(index / COLS), col: index % COLS };
}

export function isBoardIndex(index) {
  return Number.isInteger(index) && index >= 0 && index < BOARD_SIZE;
}

export function isAdjacent(from, to) {
  if (!isBoardIndex(from) || !isBoardIndex(to)) return false;
  const a = indexToPoint(from);
  const b = indexToPoint(to);
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1;
}

export function indicesBetween(from, to) {
  if (!isBoardIndex(from) || !isBoardIndex(to) || from === to) return null;
  const a = indexToPoint(from);
  const b = indexToPoint(to);
  const result = [];

  if (a.row === b.row) {
    const direction = a.col < b.col ? 1 : -1;
    for (let col = a.col + direction; col !== b.col; col += direction) {
      result.push(a.row * COLS + col);
    }
    return result;
  }

  if (a.col === b.col) {
    const direction = a.row < b.row ? 1 : -1;
    for (let row = a.row + direction; row !== b.row; row += direction) {
      result.push(row * COLS + a.col);
    }
    return result;
  }

  return null;
}

export function canAnimalCapture(attackerType, defenderType) {
  if (attackerType === "football") return false;
  if (defenderType === "football") return attackerType !== "mouse";
  if (!(attackerType in RANKS) || !(defenderType in RANKS)) return false;
  if (attackerType === defenderType) return true;
  if (attackerType === "mouse") return defenderType === "elephant";
  if (attackerType === "elephant" && defenderType === "mouse") return false;
  return RANKS[attackerType] > RANKS[defenderType];
}

export function canFootballCapture(board, from, to) {
  const between = indicesBetween(from, to);
  if (!between) return false;
  return between.reduce((count, index) => count + (board[index] ? 1 : 0), 0) === 1;
}

export function makePiece(type, color, id = `${color}-${type}-${randomUUID()}`) {
  if (!(type in PIECE_COUNTS)) throw new TypeError(`未知棋子类型：${type}`);
  if (!COLORS.includes(color)) throw new TypeError(`未知阵营：${color}`);
  return { id, type, color, revealed: false };
}

export function makePieceSet() {
  const pieces = [];
  for (const color of COLORS) {
    for (const [type, count] of Object.entries(PIECE_COUNTS)) {
      for (let copy = 0; copy < count; copy += 1) {
        pieces.push(makePiece(type, color, `${color}-${type}-${copy + 1}`));
      }
    }
  }
  return pieces;
}

export function shuffle(items, rng = Math.random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

export function positionSignature(board, turn) {
  const cells = board.map((piece) => {
    if (!piece) return ".";
    if (!piece.revealed) return "?";
    return `${piece.color === "blue" ? "b" : "r"}${POSITION_CODES[piece.type]}`;
  }).join("");
  return `${turn === "blue" ? "b" : "r"}|${cells}`;
}

export function recordCurrentPosition(game) {
  if (!game.positionCounts) game.positionCounts = Object.create(null);
  const signature = positionSignature(game.board, game.turn);
  game.positionCounts[signature] = (game.positionCounts[signature] ?? 0) + 1;
  return game.positionCounts[signature];
}

export function wouldCreateFourthPosition(game, from, to, color = game.turn) {
  if (!game.positionCounts || !isBoardIndex(from) || !isBoardIndex(to)) return false;
  const attacker = game.board[from];
  if (!attacker) return false;
  const nextBoard = [...game.board];
  nextBoard[to] = attacker;
  nextBoard[from] = null;
  const signature = positionSignature(nextBoard, otherColor(color));
  return (game.positionCounts[signature] ?? 0) >= 3;
}

export function createGame({
  playerIds,
  initialHealth = 14,
  turnDurationMs = TURN_DURATION_MS,
  rng = Math.random,
  now = Date.now(),
  board,
} = {}) {
  if (!Array.isArray(playerIds) || playerIds.length !== 2 || playerIds.some((id) => !id)) {
    throw new TypeError("开局需要两名有效玩家");
  }
  if (!Number.isInteger(initialHealth) || initialHealth < 1 || initialHealth > 16) {
    throw new RangeError("初始血量必须是 1–16 的整数");
  }
  if (!Number.isFinite(turnDurationMs) || turnDurationMs < 250) {
    throw new RangeError("回合时长无效");
  }

  const players = rng() < 0.5
    ? { blue: playerIds[0], red: playerIds[1] }
    : { blue: playerIds[1], red: playerIds[0] };
  const turn = rng() < 0.5 ? "blue" : "red";
  const nextBoard = board
    ? board.map((piece) => (piece ? { ...piece } : null))
    : shuffle(makePieceSet(), rng);

  if (nextBoard.length !== BOARD_SIZE) throw new RangeError("棋盘必须恰好包含 32 格");

  const game = {
    id: randomUUID(),
    version: 1,
    status: "playing",
    board: nextBoard,
    players,
    health: { blue: initialHealth, red: initialHealth },
    capturedBy: { blue: [], red: [] },
    initialHealth,
    turn,
    turnDurationMs,
    turnDeadline: now + turnDurationMs,
    winner: null,
    loser: null,
    endReason: null,
    lastAction: { type: "start", at: now, turn },
    startedAt: now,
    endedAt: null,
    positionCounts: Object.create(null),
  };
  recordCurrentPosition(game);
  return game;
}

function requirePlayingTurn(game, color, version) {
  if (game.status !== "playing") {
    throw new GameRuleError("game_finished", "本局已经结束");
  }
  if (!COLORS.includes(color)) {
    throw new GameRuleError("not_a_player", "你不是本局玩家");
  }
  if (version !== undefined && version !== game.version) {
    throw new GameRuleError("stale_version", "棋局状态已更新，请重试");
  }
  if (game.turn !== color) {
    throw new GameRuleError("not_your_turn", "还没轮到你");
  }
}

function completeTurn(game, action, now) {
  game.version += 1;
  game.lastAction = { ...action, at: now };
  if (game.status === "playing") {
    game.turn = otherColor(game.turn);
    game.turnDeadline = now + game.turnDurationMs;
    recordCurrentPosition(game);
  } else {
    game.turnDeadline = null;
  }
  return game;
}

function finishGame(game, loser, reason, now) {
  game.status = "finished";
  game.loser = loser;
  game.winner = otherColor(loser);
  game.endReason = reason;
  game.endedAt = now;
}

export function flipPiece(game, color, index, { version, now = Date.now() } = {}) {
  requirePlayingTurn(game, color, version);
  if (!isBoardIndex(index)) throw new GameRuleError("bad_index", "棋盘位置无效");
  const piece = game.board[index];
  if (!piece) throw new GameRuleError("empty_cell", "这里没有棋子");
  if (piece.revealed) throw new GameRuleError("already_revealed", "这枚棋子已经翻开");

  piece.revealed = true;
  return completeTurn(game, { type: "flip", color, index, piece: piece.type, pieceColor: piece.color }, now);
}

export function movePiece(game, color, from, to, { version, now = Date.now() } = {}) {
  requirePlayingTurn(game, color, version);
  if (!isBoardIndex(from) || !isBoardIndex(to)) {
    throw new GameRuleError("bad_index", "棋盘位置无效");
  }
  const attacker = game.board[from];
  const defender = game.board[to];

  if (!attacker) throw new GameRuleError("empty_source", "起点没有棋子");
  if (!attacker.revealed) throw new GameRuleError("hidden_source", "暗子不能移动");
  if (attacker.color !== color) throw new GameRuleError("opponent_piece", "只能移动自己的棋子");

  if (!defender) {
    if (!isAdjacent(from, to)) {
      throw new GameRuleError("move_too_far", "移动到空格时只能正交走一格");
    }
    if (wouldCreateFourthPosition(game, from, to, color)) {
      throw new GameRuleError("position_repetition", "该走法会让同一局面第 4 次出现，请变招");
    }
    game.board[to] = attacker;
    game.board[from] = null;
    return completeTurn(game, { type: "move", color, from, to, piece: attacker.type }, now);
  }

  if (!defender.revealed) throw new GameRuleError("hidden_target", "暗子不能被吃，只能翻开");
  if (defender.color === color) throw new GameRuleError("friendly_target", "不能吃自己的棋子");

  if (attacker.type === "football") {
    if (!canFootballCapture(game.board, from, to)) {
      throw new GameRuleError("football_screen", "足球吃子时与目标之间必须恰好隔一枚棋子");
    }
  } else {
    if (!isAdjacent(from, to)) {
      throw new GameRuleError("capture_too_far", "动物吃子时只能正交走一格");
    }
    if (!canAnimalCapture(attacker.type, defender.type)) {
      throw new GameRuleError(
        "weaker_piece",
        `${PIECE_LABELS[attacker.type]}不能吃${PIECE_LABELS[defender.type]}`,
      );
    }
  }

  if (wouldCreateFourthPosition(game, from, to, color)) {
    throw new GameRuleError("position_repetition", "该走法会让同一局面第 4 次出现，请变招");
  }

  game.board[to] = attacker;
  game.board[from] = null;
  game.health[defender.color] = Math.max(0, game.health[defender.color] - 1);
  game.capturedBy[color].push({ type: defender.type, color: defender.color });
  if (game.health[defender.color] === 0) finishGame(game, defender.color, "health", now);

  return completeTurn(game, {
    type: "capture",
    color,
    from,
    to,
    piece: attacker.type,
    captured: defender.type,
    capturedColor: defender.color,
  }, now);
}

export function resignGame(game, color, { reason = "resign", now = Date.now() } = {}) {
  if (game.status !== "playing") return game;
  if (!COLORS.includes(color)) throw new GameRuleError("not_a_player", "你不是本局玩家");
  finishGame(game, color, reason, now);
  game.version += 1;
  game.turnDeadline = null;
  game.lastAction = { type: reason, color, at: now };
  return game;
}

export function processTurnTimeout(game, now = Date.now()) {
  if (game.status !== "playing" || now < game.turnDeadline) return false;
  const skipped = game.turn;
  game.turn = otherColor(game.turn);
  game.version += 1;
  game.turnDeadline = now + game.turnDurationMs;
  game.lastAction = { type: "timeout", color: skipped, at: now };
  recordCurrentPosition(game);
  return true;
}

export function colorForPlayer(game, playerId) {
  return COLORS.find((color) => game.players[color] === playerId) ?? null;
}

export function legalActionsFor(game, color) {
  if (game.status !== "playing" || !COLORS.includes(color)) {
    return { captures: [], flips: [], moves: [], forbiddenRepetitionMoves: [], all: [] };
  }

  const captures = [];
  const flips = [];
  const moves = [];
  const forbiddenRepetitionMoves = [];

  for (let index = 0; index < BOARD_SIZE; index += 1) {
    const piece = game.board[index];
    if (piece?.revealed === false) flips.push({ type: "flip", index });
    if (!piece?.revealed || piece.color !== color) continue;

    for (let targetIndex = 0; targetIndex < BOARD_SIZE; targetIndex += 1) {
      if (targetIndex === index) continue;
      const target = game.board[targetIndex];
      if (!target) {
        if (isAdjacent(index, targetIndex)) {
          const action = { type: "move", from: index, to: targetIndex, capture: false };
          if (wouldCreateFourthPosition(game, index, targetIndex, color)) forbiddenRepetitionMoves.push(action);
          else moves.push(action);
        }
        continue;
      }
      if (!target.revealed || target.color === color) continue;

      const legalCapture = piece.type === "football"
        ? canFootballCapture(game.board, index, targetIndex)
        : isAdjacent(index, targetIndex) && canAnimalCapture(piece.type, target.type);
      if (legalCapture) {
        const action = {
          type: "move",
          from: index,
          to: targetIndex,
          capture: true,
          attacker: piece.type,
          defender: target.type,
        };
        if (wouldCreateFourthPosition(game, index, targetIndex, color)) forbiddenRepetitionMoves.push(action);
        else captures.push(action);
      }
    }
  }

  return { captures, flips, moves, forbiddenRepetitionMoves, all: [...captures, ...flips, ...moves] };
}

export function gameViewFor(game, viewerId, now = Date.now()) {
  const youColor = colorForPlayer(game, viewerId);
  const legal = youColor && game.turn === youColor ? legalActionsFor(game, youColor) : null;
  return {
    id: game.id,
    version: game.version,
    status: game.status,
    board: game.board.map((piece) => {
      if (!piece) return null;
      if (!piece.revealed) return { hidden: true };
      return { id: piece.id, type: piece.type, color: piece.color, revealed: true };
    }),
    health: { ...game.health },
    capturedBy: {
      blue: game.capturedBy.blue.map((piece) => ({ ...piece })),
      red: game.capturedBy.red.map((piece) => ({ ...piece })),
    },
    initialHealth: game.initialHealth,
    turn: game.turn,
    turnDeadline: game.turnDeadline,
    turnDurationMs: game.turnDurationMs,
    serverNow: now,
    youColor,
    winner: game.winner,
    loser: game.loser,
    endReason: game.endReason,
    lastAction: game.lastAction ? { ...game.lastAction } : null,
    startedAt: game.startedAt,
    endedAt: game.endedAt,
    repetitionForbiddenMoves: (legal?.forbiddenRepetitionMoves ?? []).map(({ from, to }) => ({ from, to })),
  };
}
