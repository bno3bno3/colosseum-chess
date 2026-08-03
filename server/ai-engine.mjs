import {
  BOARD_SIZE,
  COLORS,
  PIECE_COUNTS,
  canAnimalCapture,
  canFootballCapture,
  indexToPoint,
  isAdjacent,
  legalActionsFor,
  otherColor,
  recordCurrentPosition,
} from "./game-engine.mjs";

export const MAX_AI_SEARCH_MS = 15_000;
export const DEFAULT_AI_SEARCH_MS = 15_000;

const TYPES = Object.keys(PIECE_COUNTS);
const TYPE_CODE = Object.freeze({
  elephant: "E",
  tiger: "T",
  wolf: "W",
  dog: "D",
  cat: "C",
  mouse: "M",
  football: "F",
});
const PIECE_VALUE = Object.freeze({
  elephant: 3.5,
  tiger: 3.45,
  wolf: 2.95,
  dog: 2.65,
  cat: 2.35,
  mouse: 3.05,
  football: 4.15,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function createSeededRng(seed = Date.now()) {
  let state = Number(seed) >>> 0;
  if (!state) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function cloneCaptured(capturedBy = {}) {
  return {
    blue: (capturedBy.blue ?? []).map((piece) => ({ type: piece.type, color: piece.color })),
    red: (capturedBy.red ?? []).map((piece) => ({ type: piece.type, color: piece.color })),
  };
}

function clonePositionCounts(positionCounts = {}) {
  return Object.fromEntries(Object.entries(positionCounts));
}

function repetitionHistorySignature(positionCounts = {}) {
  return Object.entries(positionCounts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}:${count}`)
    .join(";");
}

export function publicStateForAI(game) {
  return {
    status: game.status,
    turn: game.turn,
    health: { ...game.health },
    initialHealth: game.initialHealth,
    board: game.board.map((piece) => {
      if (!piece) return null;
      if (!piece.revealed) return { revealed: false };
      return { revealed: true, type: piece.type, color: piece.color };
    }),
    capturedBy: cloneCaptured(game.capturedBy),
    positionCounts: clonePositionCounts(game.positionCounts),
  };
}

export function remainingInventory(publicState) {
  const remaining = Object.fromEntries(COLORS.map((color) => [
    color,
    Object.fromEntries(TYPES.map((type) => [type, PIECE_COUNTS[type]])),
  ]));

  for (const piece of publicState.board ?? []) {
    if (piece?.revealed && remaining[piece.color]?.[piece.type] > 0) {
      remaining[piece.color][piece.type] -= 1;
    }
  }
  for (const pieces of Object.values(publicState.capturedBy ?? {})) {
    for (const piece of pieces ?? []) {
      if (remaining[piece.color]?.[piece.type] > 0) remaining[piece.color][piece.type] -= 1;
    }
  }

  const pool = [];
  for (const color of COLORS) {
    for (const type of TYPES) {
      for (let copy = 0; copy < remaining[color][type]; copy += 1) {
        pool.push({ type, color });
      }
    }
  }
  return { remaining, pool };
}

function shuffled(items, rng) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

export function determinize(publicState, rng = Math.random) {
  const hiddenIndices = [];
  const board = publicState.board.map((piece, index) => {
    if (!piece) return null;
    if (!piece.revealed) {
      hiddenIndices.push(index);
      return null;
    }
    return { revealed: true, type: piece.type, color: piece.color };
  });
  const inventory = remainingInventory(publicState);
  let pool = shuffled(inventory.pool, rng);

  // Reduced QA/test positions may omit already removed pieces from capturedBy.
  // Normal games always have an exact pool/hidden-square match.
  if (pool.length < hiddenIndices.length) {
    const fallback = [];
    for (const color of COLORS) {
      for (const type of TYPES) fallback.push({ type, color });
    }
    while (pool.length < hiddenIndices.length) {
      pool.push(fallback[Math.floor(rng() * fallback.length)]);
    }
  }
  pool = shuffled(pool, rng).slice(0, hiddenIndices.length);
  hiddenIndices.forEach((index, offset) => {
    board[index] = { ...pool[offset], revealed: false };
  });

  const state = {
    status: publicState.status,
    turn: publicState.turn,
    health: { ...publicState.health },
    initialHealth: publicState.initialHealth,
    board,
    capturedBy: cloneCaptured(publicState.capturedBy),
    winner: null,
    loser: null,
    positionCounts: clonePositionCounts(publicState.positionCounts),
  };
  if (!Object.keys(state.positionCounts).length) recordCurrentPosition(state);
  return state;
}

function cloneState(state) {
  return {
    status: state.status,
    turn: state.turn,
    health: { ...state.health },
    initialHealth: state.initialHealth,
    board: state.board.map((piece) => (piece ? { ...piece } : null)),
    capturedBy: cloneCaptured(state.capturedBy),
    winner: state.winner ?? null,
    loser: state.loser ?? null,
    positionCounts: clonePositionCounts(state.positionCounts),
  };
}

export function applySimulatedAction(state, action) {
  if (!state.positionCounts) {
    state.positionCounts = Object.create(null);
    recordCurrentPosition(state);
  }
  const actor = state.turn;
  if (action.type === "flip") {
    const piece = state.board[action.index];
    if (!piece || piece.revealed) return false;
    piece.revealed = true;
    state.turn = otherColor(actor);
    recordCurrentPosition(state);
    return true;
  }

  const attacker = state.board[action.from];
  const defender = state.board[action.to];
  if (!attacker?.revealed || attacker.color !== actor) return false;
  if (!defender) {
    if (!isAdjacent(action.from, action.to)) return false;
  } else {
    if (!defender.revealed || defender.color === actor) return false;
    const legal = attacker.type === "football"
      ? canFootballCapture(state.board, action.from, action.to)
      : isAdjacent(action.from, action.to) && canAnimalCapture(attacker.type, defender.type);
    if (!legal) return false;
  }

  state.board[action.to] = attacker;
  state.board[action.from] = null;
  if (defender) {
    state.health[defender.color] = Math.max(0, state.health[defender.color] - 1);
    state.capturedBy[actor].push({ type: defender.type, color: defender.color });
    if (state.health[defender.color] === 0) {
      state.status = "finished";
      state.winner = actor;
      state.loser = defender.color;
      return true;
    }
  }
  state.turn = otherColor(actor);
  recordCurrentPosition(state);
  return true;
}

export function actionKey(action) {
  return action.type === "flip" ? `f${action.index}` : `m${action.from}-${action.to}`;
}

function centerScore(index) {
  const { row, col } = indexToPoint(index);
  const rowDistance = Math.abs(row - 3.5) / 3.5;
  const colDistance = Math.abs(col - 1.5) / 1.5;
  return 1 - (rowDistance + colDistance) / 2;
}

function capturedSignature(capturedBy) {
  const counts = {};
  for (const pieces of Object.values(capturedBy ?? {})) {
    for (const piece of pieces ?? []) {
      const key = `${piece.color[0]}${TYPE_CODE[piece.type]}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return Object.entries(counts).sort().map(([key, count]) => `${key}${count}`).join("");
}

export function informationSetKey(state) {
  const board = state.board.map((piece) => {
    if (!piece) return ".";
    if (!piece.revealed) return "?";
    return `${piece.color[0]}${TYPE_CODE[piece.type]}`;
  }).join("");
  return `${state.turn[0]}|${state.health.blue},${state.health.red}|${capturedSignature(state.capturedBy)}|${board}|${repetitionHistorySignature(state.positionCounts)}`;
}

function materialValue(state, color) {
  let value = 0;
  for (const piece of state.board) {
    if (piece?.color === color) value += PIECE_VALUE[piece.type] ?? 1;
  }
  return value;
}

function capturePotential(state, color) {
  const captures = legalActionsFor(state, color).captures;
  let score = 0;
  for (const action of captures) {
    const defender = state.board[action.to];
    score += 1 + (PIECE_VALUE[defender?.type] ?? 1) * 0.16;
  }
  return { count: captures.length, score };
}

function mobility(state, color) {
  const actions = legalActionsFor(state, color);
  return actions.moves.length + actions.captures.length * 1.7;
}

export function evaluateState(state, rootColor) {
  if (state.status === "finished") return state.winner === rootColor ? 1 : -1;
  const enemy = otherColor(rootColor);
  const initial = Math.max(1, state.initialHealth || 14);
  const health = (state.health[rootColor] - state.health[enemy]) / initial;
  const ownMaterial = materialValue(state, rootColor);
  const enemyMaterial = materialValue(state, enemy);
  const material = (ownMaterial - enemyMaterial) / Math.max(8, ownMaterial + enemyMaterial);
  const ownThreat = capturePotential(state, rootColor);
  const enemyThreat = capturePotential(state, enemy);
  const threat = (ownThreat.score - enemyThreat.score) / 12;
  const moveFreedom = (mobility(state, rootColor) - mobility(state, enemy)) / 28;
  let center = 0;
  for (let index = 0; index < BOARD_SIZE; index += 1) {
    const piece = state.board[index];
    if (!piece?.revealed) continue;
    center += (piece.color === rootColor ? 1 : -1) * centerScore(index) * 0.035;
  }

  const tempo = state.turn === rootColor ? 0.018 : -0.018;
  const raw = health * 2.8 + material * 0.72 + threat * 0.82 + moveFreedom * 0.22 + center + tempo;
  return clamp(Math.tanh(raw), -0.985, 0.985);
}

function immediateCaptureRisk(state, color, targetIndex) {
  const enemy = otherColor(color);
  let risk = 0;
  for (let from = 0; from < BOARD_SIZE; from += 1) {
    const attacker = state.board[from];
    const defender = state.board[targetIndex];
    if (!attacker?.revealed || attacker.color !== enemy || !defender?.revealed || defender.color === enemy) continue;
    const legal = attacker.type === "football"
      ? canFootballCapture(state.board, from, targetIndex)
      : isAdjacent(from, targetIndex) && canAnimalCapture(attacker.type, defender.type);
    if (legal) risk = Math.max(risk, PIECE_VALUE[attacker.type] ?? 1);
  }
  return risk;
}

function captureTargetsFrom(state, from) {
  const attacker = state.board[from];
  if (!attacker?.revealed) return 0;
  let count = 0;
  for (let to = 0; to < BOARD_SIZE; to += 1) {
    const defender = state.board[to];
    if (!defender?.revealed || defender.color === attacker.color) continue;
    const legal = attacker.type === "football"
      ? canFootballCapture(state.board, from, to)
      : isAdjacent(from, to) && canAnimalCapture(attacker.type, defender.type);
    if (legal) count += 1;
  }
  return count;
}

function flipExpectation(state, action, actor) {
  const publicState = {
    ...state,
    board: state.board.map((piece) => {
      if (!piece) return null;
      return piece.revealed ? { ...piece } : { revealed: false };
    }),
  };
  const pool = remainingInventory(publicState).pool;
  if (!pool.length) return 0;
  let total = 0;
  const samples = pool.length <= 18 ? pool : pool.filter((_, index) => index % Math.ceil(pool.length / 18) === 0);
  for (const candidate of samples) {
    const next = cloneState(state);
    next.board[action.index] = { ...candidate, revealed: true };
    next.turn = otherColor(actor);
    let value = candidate.color === actor ? 0.3 : -0.08;
    if (candidate.color === actor) {
      const risk = immediateCaptureRisk(next, actor, action.index);
      if (risk) value -= 3.5 + PIECE_VALUE[candidate.type] + risk * 0.25;
    } else {
      const attacks = captureTargetsFrom(next, action.index);
      if (attacks) value -= 2.2 + attacks * PIECE_VALUE[candidate.type] * 0.35;
      const futureRisk = immediateCaptureRisk(next, candidate.color, action.index);
      if (futureRisk) value += 1.4 + PIECE_VALUE[candidate.type] * 0.35;
    }
    total += value;
  }
  return total / samples.length + centerScore(action.index) * 0.15;
}

export function heuristicActionScore(state, action, actor) {
  if (action.type === "flip") return 4 + flipExpectation(state, action, actor);
  const attacker = state.board[action.from];
  const defender = state.board[action.to];
  const next = cloneState(state);
  if (!applySimulatedAction(next, action)) return -10_000;
  if (next.status === "finished" && next.winner === actor) return 100_000;
  const risk = immediateCaptureRisk(next, actor, action.to);
  const setup = captureTargetsFrom(next, action.to);
  let score = 5 + (centerScore(action.to) - centerScore(action.from)) * 1.1 + setup * 1.9;
  if (defender) score += 20 + (PIECE_VALUE[defender.type] ?? 1) * 2.4;
  score -= risk * (PIECE_VALUE[attacker?.type] ?? 1) * 1.15;
  if (attacker?.type === "football" && defender) score += 3.5;
  return score;
}

function normalizedPriors(state, actions, actor) {
  const scored = actions.map((action) => ({ action, score: heuristicActionScore(state, action, actor) }));
  const maximum = Math.max(...scored.map((entry) => entry.score));
  const weights = scored.map((entry) => Math.exp(clamp((entry.score - maximum) / 7, -12, 0)) + 0.015);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return new Map(scored.map((entry, index) => [actionKey(entry.action), weights[index] / total]));
}

function weightedChoice(entries, weightFor, rng) {
  let total = 0;
  const weighted = entries.map((entry) => {
    const weight = Math.max(0.0001, weightFor(entry));
    total += weight;
    return { entry, cumulative: total };
  });
  const target = rng() * total;
  return weighted.find((item) => target <= item.cumulative)?.entry ?? entries[entries.length - 1];
}

function chooseRolloutAction(state, rng) {
  const legal = legalActionsFor(state, state.turn);
  if (!legal.all.length) return null;
  const winning = legal.captures.find(() => state.health[otherColor(state.turn)] <= 1);
  if (winning) return winning;

  let pool;
  if (legal.captures.length) {
    pool = legal.captures;
  } else if (!legal.moves.length) {
    pool = legal.flips;
  } else if (!legal.flips.length) {
    pool = legal.moves;
  } else {
    const hiddenRatio = legal.flips.length / Math.max(1, state.board.filter(Boolean).length);
    pool = rng() < 0.28 + hiddenRatio * 0.48 ? legal.flips : legal.moves;
  }

  const scored = pool.map((action) => ({
    action,
    score: action.type === "flip"
      ? 4 + centerScore(action.index) * 0.45
      : heuristicActionScore(state, action, state.turn),
  }));
  scored.sort((a, b) => b.score - a.score);
  const shortlist = scored.slice(0, Math.min(5, scored.length));
  return weightedChoice(shortlist, (entry) => Math.exp(clamp(entry.score / 10, -5, 5)), rng).action;
}

function rollout(state, rootColor, rng, depthLimit) {
  for (let depth = 0; depth < depthLimit && state.status === "playing"; depth += 1) {
    const action = chooseRolloutAction(state, rng);
    if (!action || !applySimulatedAction(state, action)) break;
  }
  return evaluateState(state, rootColor);
}

function ensureNode(table, state, actions) {
  const key = informationSetKey(state);
  let node = table.get(key);
  if (!node) {
    const priors = normalizedPriors(state, actions, state.turn);
    node = { visits: 0, actions: new Map() };
    for (const action of actions) {
      node.actions.set(actionKey(action), { action: { ...action }, visits: 0, value: 0, prior: priors.get(actionKey(action)) ?? 0.01 });
    }
    table.set(key, node);
  }
  return node;
}

function selectPUCT(node, maximizing, rng) {
  const parentVisits = Math.max(1, node.visits);
  let best = null;
  let bestScore = -Infinity;
  for (const stats of node.actions.values()) {
    const mean = stats.visits ? stats.value / stats.visits : 0;
    const exploitation = maximizing ? mean : -mean;
    const exploration = 1.45 * stats.prior * Math.sqrt(parentVisits) / (1 + stats.visits);
    const noise = rng() * 1e-7;
    const score = exploitation + exploration + noise;
    if (score > bestScore) {
      bestScore = score;
      best = stats;
    }
  }
  return best;
}

function rankedNodeCandidates(node, limit = 8) {
  return [...node.actions.values()]
    .map((stats) => ({
      action: stats.action,
      visits: stats.visits,
      score: stats.visits ? stats.value / stats.visits : -1,
      prior: stats.prior,
    }))
    .sort((a, b) => b.visits - a.visits || b.score - a.score || b.prior - a.prior)
    .slice(0, limit);
}

function runISMCTS(publicState, rootColor, {
  deadline,
  rng,
  maxIterations = Infinity,
  collectPonderStates = false,
} = {}) {
  const table = new Map();
  const rootActions = legalActionsFor(publicState, publicState.turn).all;
  const rootKey = informationSetKey(publicState);
  const ponderKeys = new Set();
  let iterations = 0;

  while (iterations < maxIterations && Date.now() < deadline) {
    const state = determinize(publicState, rng);
    const path = [];
    let treeDepth = 0;

    while (state.status === "playing" && treeDepth < 14) {
      const actions = legalActionsFor(state, state.turn).all;
      if (!actions.length) break;
      const node = ensureNode(table, state, actions);
      const unvisited = [...node.actions.values()].filter((stats) => stats.visits === 0);
      let selected;
      if (unvisited.length) {
        selected = weightedChoice(unvisited, (stats) => stats.prior, rng);
      } else {
        selected = selectPUCT(node, state.turn === rootColor, rng);
      }
      if (!selected) break;
      path.push({ node, stats: selected });
      if (!applySimulatedAction(state, selected.action)) break;
      treeDepth += 1;
      if (collectPonderStates && treeDepth === 1 && state.turn === rootColor && state.status === "playing") {
        const replyActions = legalActionsFor(state, state.turn).all;
        if (replyActions.length) {
          const replyKey = informationSetKey(state);
          ensureNode(table, state, replyActions);
          ponderKeys.add(replyKey);
        }
      }
      if (unvisited.length) break;
    }

    const hiddenCount = state.board.filter((piece) => piece && !piece.revealed).length;
    const reward = rollout(state, rootColor, rng, hiddenCount ? 18 : 26);
    for (const entry of path) {
      entry.node.visits += 1;
      entry.stats.visits += 1;
      entry.stats.value += reward;
    }
    iterations += 1;
  }

  const root = table.get(rootKey) ?? ensureNode(table, publicState, rootActions);
  const candidates = rankedNodeCandidates(root);
  const ponderStates = collectPonderStates
    ? [...ponderKeys]
        .map((key) => {
          const node = table.get(key);
          const replies = node ? rankedNodeCandidates(node) : [];
          const visits = replies.reduce((sum, candidate) => sum + candidate.visits, 0);
          return { key, visits, candidates: replies };
        })
        .filter((state) => state.visits > 0)
    : undefined;
  return {
    action: candidates[0]?.action ?? rootActions[0] ?? null,
    iterations,
    candidates,
    ...(ponderStates ? { ponderStates } : {}),
  };
}

const SEARCH_TIMEOUT = Symbol("search-timeout");

function fullStateKey(state) {
  return `${state.turn[0]}|${state.health.blue},${state.health.red}|${state.board.map((piece) => piece ? `${piece.color[0]}${TYPE_CODE[piece.type]}` : ".").join("")}|${repetitionHistorySignature(state.positionCounts)}`;
}

function orderedActions(state) {
  return legalActionsFor(state, state.turn).all
    .map((action) => ({ action, score: heuristicActionScore(state, action, state.turn) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.action);
}

function alphaBeta(state, depth, alpha, beta, rootColor, deadline, table, counters) {
  counters.nodes += 1;
  if ((counters.nodes & 255) === 0 && Date.now() >= deadline) throw SEARCH_TIMEOUT;
  if (state.status === "finished" || depth === 0) return evaluateState(state, rootColor);
  const key = `${depth}|${fullStateKey(state)}`;
  if (table.has(key)) return table.get(key);
  const actions = orderedActions(state);
  if (!actions.length) return evaluateState(state, rootColor);
  const maximizing = state.turn === rootColor;
  let value = maximizing ? -Infinity : Infinity;
  for (const action of actions) {
    const next = cloneState(state);
    applySimulatedAction(next, action);
    const child = alphaBeta(next, depth - 1, alpha, beta, rootColor, deadline, table, counters);
    if (maximizing) {
      value = Math.max(value, child);
      alpha = Math.max(alpha, value);
    } else {
      value = Math.min(value, child);
      beta = Math.min(beta, value);
    }
    if (beta <= alpha) break;
  }
  table.set(key, value);
  return value;
}

function runEndgameSearch(publicState, rootColor, { deadline, rootActionKeys } = {}) {
  const state = determinize(publicState, () => 0);
  const allowedRootKeys = rootActionKeys?.length ? new Set(rootActionKeys) : null;
  const rootActions = orderedActions(state).filter((action) => !allowedRootKeys || allowedRootKeys.has(actionKey(action)));
  const fallback = rootActions[0] ?? null;
  let bestAction = fallback;
  let bestScore = fallback ? heuristicActionScore(state, fallback, rootColor) / 100 : -1;
  let completedDepth = 0;
  const counters = { nodes: 0 };
  const pieceCount = state.board.filter(Boolean).length;
  const maximumDepth = pieceCount <= 6 ? 14 : pieceCount <= 10 ? 11 : 8;

  for (let depth = 1; depth <= maximumDepth && Date.now() < deadline; depth += 1) {
    const table = new Map();
    let iterationAction = null;
    let iterationScore = -Infinity;
    try {
      for (const action of rootActions) {
        const next = cloneState(state);
        applySimulatedAction(next, action);
        const score = alphaBeta(next, depth - 1, -Infinity, Infinity, rootColor, deadline, table, counters);
        if (score > iterationScore) {
          iterationScore = score;
          iterationAction = action;
        }
      }
    } catch (error) {
      if (error !== SEARCH_TIMEOUT) throw error;
      break;
    }
    if (iterationAction) {
      bestAction = iterationAction;
      bestScore = iterationScore;
      completedDepth = depth;
    }
  }
  return { action: bestAction, score: bestScore, completedDepth, nodes: counters.nodes };
}

export function chooseAIAction(publicState, color, options = {}) {
  const startedAt = Date.now();
  const requestedBudget = Number.isFinite(options.timeLimitMs) ? options.timeLimitMs : DEFAULT_AI_SEARCH_MS;
  const budget = clamp(requestedBudget, 5, MAX_AI_SEARCH_MS);
  const deadline = startedAt + budget;
  const rng = createSeededRng(options.seed ?? (startedAt ^ Math.floor(Math.random() * 0xffff_ffff)));
  const pondering = options.ponder === true && publicState.turn !== color;
  const rootActions = legalActionsFor(publicState, pondering ? publicState.turn : color).all;
  const inventory = remainingInventory(publicState);
  const hiddenCount = publicState.board.filter((piece) => piece && !piece.revealed).length;
  if (!rootActions.length) {
    return { action: null, method: "none", elapsedMs: Date.now() - startedAt, hiddenCount, remaining: inventory.remaining };
  }

  if (pondering) {
    const result = runISMCTS(publicState, color, {
      deadline,
      rng,
      maxIterations: Number.isFinite(options.maxIterations) ? options.maxIterations : Infinity,
      collectPonderStates: true,
    });
    return {
      ...result,
      action: null,
      method: "ponder-ismcts",
      elapsedMs: Date.now() - startedAt,
      hiddenCount,
      remaining: inventory.remaining,
    };
  }

  const immediateWin = rootActions.find((action) => (
    action.type === "move" && publicState.board[action.to]?.revealed && publicState.health[otherColor(color)] <= 1
  ));
  if (immediateWin) {
    return {
      action: immediateWin,
      method: "forced-win",
      elapsedMs: Date.now() - startedAt,
      hiddenCount,
      remaining: inventory.remaining,
      score: 1,
    };
  }

  const result = hiddenCount === 0
    ? runEndgameSearch(publicState, color, { deadline, rootActionKeys: options.rootActionKeys })
    : runISMCTS(publicState, color, {
        deadline,
        rng,
        maxIterations: Number.isFinite(options.maxIterations) ? options.maxIterations : Infinity,
      });
  return {
    ...result,
    method: hiddenCount === 0 ? "alpha-beta" : "so-ismcts",
    elapsedMs: Date.now() - startedAt,
    hiddenCount,
    remaining: inventory.remaining,
  };
}
