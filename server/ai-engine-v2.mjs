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
import {
  DEFAULT_AI_SEARCH_MS,
  MAX_AI_SEARCH_MS,
  actionKey,
  applySimulatedAction,
  chooseAIAction,
  createSeededRng,
  determinize,
  heuristicActionScore,
  informationSetKey,
  remainingInventory,
} from "./ai-engine.mjs";

const SEARCH_TIMEOUT = Symbol("v2-search-timeout");
const TYPE_CODE = Object.freeze({
  elephant: "E",
  tiger: "T",
  wolf: "W",
  dog: "D",
  cat: "C",
  snake: "S",
  mouse: "M",
  football: "F",
});
const BASE_VALUE = Object.freeze({
  elephant: 3.7,
  tiger: 3.35,
  wolf: 2.9,
  dog: 2.6,
  cat: 2.35,
  snake: 2.75,
  mouse: 3.45,
  football: 4.4,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function cloneCaptured(capturedBy = {}) {
  return {
    blue: (capturedBy.blue ?? []).map((piece) => ({ ...piece })),
    red: (capturedBy.red ?? []).map((piece) => ({ ...piece })),
  };
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
    positionCounts: Object.fromEntries(Object.entries(state.positionCounts ?? {})),
    ruleIds: [...(state.ruleIds ?? [])],
    pieceCounts: { ...(state.pieceCounts ?? PIECE_COUNTS) },
  };
}

function sampleInventoryPiece(publicState, rng) {
  const pool = remainingInventory(publicState).pool;
  if (!pool.length) return null;
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

/**
 * V2 never determinizes untouched squares. A hidden identity is sampled only
 * when that square is actually flipped, exactly when a real player would see it.
 */
export function applyBeliefAction(state, action, rng = Math.random) {
  if (action.type !== "flip") return applySimulatedAction(state, action);
  const hidden = state.board[action.index];
  if (!hidden || hidden.revealed) return false;
  const revealed = sampleInventoryPiece(state, rng);
  if (!revealed) return false;
  state.board[action.index] = { ...revealed, revealed: false };
  return applySimulatedAction(state, action);
}

function centerScore(index) {
  const { row, col } = indexToPoint(index);
  const rowDistance = Math.abs(row - 3.5) / 3.5;
  const colDistance = Math.abs(col - 1.5) / 1.5;
  return 1 - (rowDistance + colDistance) / 2;
}

function canCapture(board, from, to) {
  const attacker = board[from];
  const defender = board[to];
  if (!attacker?.revealed || !defender?.revealed || attacker.color === defender.color) return false;
  return attacker.type === "football"
    ? canFootballCapture(board, from, to)
    : isAdjacent(from, to) && canAnimalCapture(attacker.type, defender.type);
}

function captureMap(state, color) {
  const attacked = new Map();
  let weighted = 0;
  for (const action of legalActionsFor(state, color).captures) {
    const target = state.board[action.to];
    const value = 1 + (BASE_VALUE[target?.type] ?? 1) * 0.18;
    attacked.set(action.to, Math.max(attacked.get(action.to) ?? 0, value));
    weighted += value;
  }
  return { attacked, weighted };
}

function footballPressure(state, color) {
  let score = 0;
  for (let from = 0; from < BOARD_SIZE; from += 1) {
    const piece = state.board[from];
    if (!piece?.revealed || piece.color !== color || piece.type !== "football") continue;
    for (let to = 0; to < BOARD_SIZE; to += 1) {
      const target = state.board[to];
      if (target?.revealed && target.color !== color && canFootballCapture(state.board, from, to)) {
        score += 1.4 + (BASE_VALUE[target.type] ?? 1) * 0.12;
      }
    }
  }
  return score;
}

function dynamicMaterial(state, color) {
  const enemy = otherColor(color);
  const inventory = remainingInventory(state).remaining;
  let value = 0;
  for (const piece of state.board) {
    if (!piece?.revealed || piece.color !== color) continue;
    let capturableEnemyKinds = 0;
    let dangerousEnemyCopies = 0;
    for (const [type, copies] of Object.entries(inventory[enemy] ?? {})) {
      if (copies <= 0) continue;
      if (piece.type === "football" || (piece.type === "snake" && type !== "elephant") || canAnimalCapture(piece.type, type, state.ruleIds)) capturableEnemyKinds += copies;
      if (type === "football" || (type === "snake" && piece.type !== "elephant") || canAnimalCapture(type, piece.type, state.ruleIds)) dangerousEnemyCopies += copies;
    }
    const matchup = (capturableEnemyKinds - dangerousEnemyCopies * 0.72) * 0.035;
    const poisonFactor = piece.poisoned ? 0.42 + Math.max(0, piece.poisonTurns ?? 3) * 0.13 : 1;
    value += (BASE_VALUE[piece.type] ?? 1) * poisonFactor + matchup;
  }
  return value;
}

export function evaluateStateV2(state, rootColor) {
  if (state.status === "finished") return state.winner === rootColor ? 1 : -1;
  const enemy = otherColor(rootColor);
  const initial = Math.max(1, state.initialHealth || 14);
  const health = (state.health[rootColor] - state.health[enemy]) / initial;
  const ownMaterial = dynamicMaterial(state, rootColor);
  const enemyMaterial = dynamicMaterial(state, enemy);
  const material = (ownMaterial - enemyMaterial) / Math.max(7, ownMaterial + enemyMaterial);
  const ownCaptures = captureMap(state, rootColor);
  const enemyCaptures = captureMap(state, enemy);
  const capturePressure = (ownCaptures.weighted - enemyCaptures.weighted) / 11;
  const ownMobility = legalActionsFor(state, rootColor);
  const enemyMobility = legalActionsFor(state, enemy);
  const mobility = (
    ownMobility.moves.length + ownMobility.captures.length * 2.2 -
    enemyMobility.moves.length - enemyMobility.captures.length * 2.2
  ) / 30;
  let position = 0;
  let hanging = 0;
  for (let index = 0; index < BOARD_SIZE; index += 1) {
    const piece = state.board[index];
    if (!piece?.revealed) continue;
    const sign = piece.color === rootColor ? 1 : -1;
    position += sign * centerScore(index) * 0.026;
    const attackedByEnemy = piece.color === rootColor
      ? enemyCaptures.attacked.has(index)
      : ownCaptures.attacked.has(index);
    if (attackedByEnemy) hanging -= sign * (0.09 + (BASE_VALUE[piece.type] ?? 1) * 0.018);
  }
  const football = (footballPressure(state, rootColor) - footballPressure(state, enemy)) / 12;
  const enemyCritical = state.health[enemy] <= 2 ? ownCaptures.attacked.size * 0.12 : 0;
  const ownCritical = state.health[rootColor] <= 2 ? enemyCaptures.attacked.size * 0.14 : 0;
  const tempo = state.turn === rootColor ? 0.02 : -0.02;
  const raw = (
    health * 3.35 + material * 0.92 + capturePressure * 0.92 + mobility * 0.24 +
    position + hanging + football * 0.38 + enemyCritical - ownCritical + tempo
  );
  return clamp(Math.tanh(raw), -0.995, 0.995);
}

function immediateWins(state) {
  if (state.health[otherColor(state.turn)] > 1) return [];
  return legalActionsFor(state, state.turn).captures;
}

function fastActionScore(state, action) {
  if (action.type === "flip") {
    let adjacentRevealedEnemies = 0;
    for (let index = 0; index < BOARD_SIZE; index += 1) {
      const piece = state.board[index];
      if (piece?.revealed && piece.color !== state.turn && isAdjacent(index, action.index)) adjacentRevealedEnemies += 1;
    }
    return 4 + centerScore(action.index) * 0.55 - adjacentRevealedEnemies * 0.28;
  }
  return heuristicActionScore(state, action, state.turn);
}

function orderedActionsV2(state, ttActionKey = null, capturesOnly = false) {
  const legal = legalActionsFor(state, state.turn);
  const actions = capturesOnly ? legal.captures : legal.all;
  return actions
    .map((action) => {
      const target = action.type === "move" ? state.board[action.to] : null;
      let score = fastActionScore(state, action);
      if (target) score += 8 + (BASE_VALUE[target.type] ?? 1) * 1.6;
      if (actionKey(action) === ttActionKey) score += 1_000_000;
      return { action, score };
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.action);
}

function quiescence(state, alpha, beta, rootColor, depth, deadline, counters, ply = 0) {
  counters.nodes += 1;
  if ((counters.nodes & 127) === 0 && Date.now() >= deadline) throw SEARCH_TIMEOUT;
  if (state.status === "finished") return state.winner === rootColor ? 10_000 - ply : -10_000 + ply;
  const standPat = evaluateStateV2(state, rootColor);
  const maximizing = state.turn === rootColor;
  if (depth <= 0) return standPat;
  const captures = orderedActionsV2(state, null, true);
  if (!captures.length) return standPat;
  let value = standPat;
  if (maximizing) {
    if (value >= beta) return value;
    alpha = Math.max(alpha, value);
    for (const action of captures) {
      const next = cloneState(state);
      applySimulatedAction(next, action);
      value = Math.max(value, quiescence(next, alpha, beta, rootColor, depth - 1, deadline, counters, ply + 1));
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break;
    }
  } else {
    if (value <= alpha) return value;
    beta = Math.min(beta, value);
    for (const action of captures) {
      const next = cloneState(state);
      applySimulatedAction(next, action);
      value = Math.min(value, quiescence(next, alpha, beta, rootColor, depth - 1, deadline, counters, ply + 1));
      beta = Math.min(beta, value);
      if (alpha >= beta) break;
    }
  }
  return value;
}

function rolloutPolicyV2(state, rng) {
  const legal = legalActionsFor(state, state.turn);
  if (!legal.all.length) return null;
  const wins = immediateWins(state);
  if (wins.length) return wins[0];
  const scored = legal.all.map((action) => ({
    action,
    score: fastActionScore(state, action) +
      (action.type === "move" && state.board[action.to] ? 7 : 0),
  })).sort((left, right) => right.score - left.score);
  if (rng() < 0.76) return scored[0].action;
  const shortlist = scored.slice(0, Math.min(4, scored.length));
  const total = shortlist.reduce((sum, entry, index) => sum + (shortlist.length - index) ** 2, 0);
  let target = rng() * total;
  for (let index = 0; index < shortlist.length; index += 1) {
    target -= (shortlist.length - index) ** 2;
    if (target <= 0) return shortlist[index].action;
  }
  return shortlist[0].action;
}

function qualityRollout(state, rootColor, rng, depthLimit, deadline, counters) {
  let captureSwing = 0;
  for (let depth = 0; depth < depthLimit && state.status === "playing"; depth += 1) {
    if ((depth & 7) === 0 && Date.now() >= deadline) throw SEARCH_TIMEOUT;
    const beforeBlue = state.health.blue;
    const beforeRed = state.health.red;
    const actor = state.turn;
    const action = rolloutPolicyV2(state, rng);
    if (!action || !applyBeliefAction(state, action, rng)) break;
    const dealt = actor === "blue" ? beforeRed - state.health.red : beforeBlue - state.health.blue;
    if (dealt) captureSwing += actor === rootColor ? 1 : -1;
  }
  if (state.status === "finished") return state.winner === rootColor ? 1 : -1;
  const staticValue = quiescence(state, -Infinity, Infinity, rootColor, 3, deadline, counters);
  return clamp(staticValue + captureSwing * 0.018, -0.995, 0.995);
}

function normalizedBiases(state, actions) {
  const scores = actions.map((action) => fastActionScore(state, action));
  const minimum = Math.min(...scores);
  const maximum = Math.max(...scores);
  const spread = Math.max(1, maximum - minimum);
  return new Map(actions.map((action, index) => [actionKey(action), ((scores[index] - minimum) / spread) * 2 - 1]));
}

function estimateActionValue(state, action, rootColor) {
  const base = evaluateStateV2(state, rootColor);
  const actorSign = state.turn === rootColor ? 1 : -1;
  if (action.type === "flip") {
    return clamp(base + actorSign * clamp((fastActionScore(state, action) - 4) / 10, -0.18, 0.18), -1, 1);
  }
  const next = cloneState(state);
  if (!applySimulatedAction(next, action)) return -actorSign;
  return evaluateStateV2(next, rootColor);
}

function ensureBeliefNode(table, state, actions, rootColor) {
  const key = informationSetKey(state);
  let node = table.get(key);
  if (node) return node;
  const biases = normalizedBiases(state, actions);
  node = {
    key,
    turn: state.turn,
    visits: 0,
    implicitValue: evaluateStateV2(state, rootColor),
    actions: new Map(),
  };
  for (const action of actions) {
    node.actions.set(actionKey(action), {
      action: { ...action },
      visits: 0,
      value: 0,
      valueSquared: 0,
      bias: biases.get(actionKey(action)) ?? 0,
      implicit: estimateActionValue(state, action, rootColor),
    });
  }
  table.set(key, node);
  return node;
}

function selectBeliefAction(node, rootColor, rng) {
  const maximizing = node.turn === rootColor;
  const logParent = Math.log(node.visits + 2);
  let best = null;
  let bestScore = -Infinity;
  for (const stats of node.actions.values()) {
    const mean = stats.visits ? stats.value / stats.visits : stats.implicit;
    const blended = mean * 0.74 + stats.implicit * 0.26;
    const exploitation = maximizing ? blended : -blended;
    const exploration = 0.84 * Math.sqrt(logParent / (stats.visits + 1));
    const progressiveBias = 0.34 * stats.bias / (1 + stats.visits * 0.045);
    const score = exploitation + exploration + progressiveBias + rng() * 1e-8;
    if (score > bestScore) {
      bestScore = score;
      best = stats;
    }
  }
  return best;
}

function rankedBeliefCandidates(node, rootColor, limit = 8) {
  const maximizing = node.turn === rootColor;
  return [...node.actions.values()]
    .map((stats) => {
      const mean = stats.visits ? stats.value / stats.visits : stats.implicit;
      const variance = stats.visits
        ? Math.max(0, stats.valueSquared / stats.visits - mean * mean)
        : 1;
      const uncertainty = Math.sqrt(variance / Math.max(1, stats.visits));
      const decisionScore = maximizing ? mean - uncertainty * 0.16 : -mean - uncertainty * 0.16;
      return {
        action: stats.action,
        visits: stats.visits,
        score: mean,
        variance,
        prior: (stats.bias + 1) / 2,
        decisionScore,
      };
    })
    .sort((left, right) => (
      right.visits - left.visits || right.decisionScore - left.decisionScore || right.prior - left.prior
    ))
    .slice(0, limit);
}

function runBeliefMCTS(publicState, rootColor, {
  deadline,
  rng,
  maxIterations = Infinity,
  collectPonderStates = false,
} = {}) {
  const table = new Map();
  const rootActions = legalActionsFor(publicState, publicState.turn).all;
  const rootKey = informationSetKey(publicState);
  const root = ensureBeliefNode(table, publicState, rootActions, rootColor);
  const ponderKeys = new Set();
  const counters = { nodes: 0 };
  let iterations = 0;

  try {
    while (iterations < maxIterations && Date.now() < deadline) {
      const state = cloneState(publicState);
      const path = [];
      let treeDepth = 0;

      while (state.status === "playing" && treeDepth < 24) {
        const actions = legalActionsFor(state, state.turn).all;
        if (!actions.length) break;
        const node = ensureBeliefNode(table, state, actions, rootColor);
        const selected = selectBeliefAction(node, rootColor, rng);
        if (!selected) break;
        if (!applyBeliefAction(state, selected.action, rng)) break;
        const childKey = informationSetKey(state);
        path.push({ node, stats: selected, childKey });
        treeDepth += 1;
        if (collectPonderStates && treeDepth === 1 && state.turn === rootColor && state.status === "playing") {
          const replies = legalActionsFor(state, state.turn).all;
          if (replies.length) {
            ensureBeliefNode(table, state, replies, rootColor);
            ponderKeys.add(childKey);
          }
        }
        if (selected.visits === 0) break;
      }

      const hiddenCount = state.board.filter((piece) => piece && !piece.revealed).length;
      const reward = qualityRollout(state, rootColor, rng, hiddenCount ? 10 : 20, deadline, counters);
      for (let index = path.length - 1; index >= 0; index -= 1) {
        const entry = path[index];
        entry.node.visits += 1;
        entry.stats.visits += 1;
        entry.stats.value += reward;
        entry.stats.valueSquared += reward * reward;
        const child = table.get(entry.childKey);
        if (child) entry.stats.implicit = child.implicitValue;
        const implicitValues = [...entry.node.actions.values()].map((stats) => stats.implicit);
        entry.node.implicitValue = entry.node.turn === rootColor
          ? Math.max(...implicitValues)
          : Math.min(...implicitValues);
      }
      iterations += 1;
    }
  } catch (error) {
    if (error !== SEARCH_TIMEOUT) throw error;
  }

  const candidates = rankedBeliefCandidates(root, rootColor);
  const ponderStates = collectPonderStates
    ? [...ponderKeys]
        .map((key) => {
          const node = table.get(key);
          const candidatesForState = node ? rankedBeliefCandidates(node, rootColor) : [];
          const visits = candidatesForState.reduce((sum, candidate) => sum + candidate.visits, 0);
          return { key, visits, candidates: candidatesForState };
        })
        .filter((entry) => entry.visits > 0)
    : undefined;
  return {
    action: candidates[0]?.action ?? rootActions[0] ?? null,
    iterations,
    candidates,
    ...(ponderStates ? { ponderStates } : {}),
  };
}

function repetitionSignature(positionCounts = {}) {
  return Object.entries(positionCounts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}:${count}`)
    .join(";");
}

function fullStateKey(state) {
  const board = state.board.map((piece) => (
    piece ? `${piece.color[0]}${TYPE_CODE[piece.type]}${piece.poisoned ? `p${piece.poisonTurns ?? 3}` : ""}` : "."
  )).join("");
  return `${(state.ruleIds ?? []).join(",")}|${state.turn[0]}|${state.health.blue},${state.health.red}|${board}|${repetitionSignature(state.positionCounts)}`;
}

function alphaBetaV2(state, depth, alpha, beta, rootColor, deadline, table, counters, ply = 0) {
  counters.nodes += 1;
  if ((counters.nodes & 127) === 0 && Date.now() >= deadline) throw SEARCH_TIMEOUT;
  if (state.status === "finished") return state.winner === rootColor ? 10_000 - ply : -10_000 + ply;
  if (depth <= 0) return quiescence(state, alpha, beta, rootColor, 4, deadline, counters, ply);

  const key = fullStateKey(state);
  const cached = table.get(key);
  const originalAlpha = alpha;
  const originalBeta = beta;
  if (cached && cached.depth >= depth) {
    if (cached.flag === "exact") return cached.score;
    if (cached.flag === "lower") alpha = Math.max(alpha, cached.score);
    else if (cached.flag === "upper") beta = Math.min(beta, cached.score);
    if (alpha >= beta) return cached.score;
  }

  const actions = orderedActionsV2(state, cached?.bestActionKey);
  if (!actions.length) return evaluateStateV2(state, rootColor);
  const maximizing = state.turn === rootColor;
  let value = maximizing ? -Infinity : Infinity;
  let bestAction = null;
  for (const action of actions) {
    const next = cloneState(state);
    if (!applySimulatedAction(next, action)) continue;
    const score = alphaBetaV2(next, depth - 1, alpha, beta, rootColor, deadline, table, counters, ply + 1);
    if ((maximizing && score > value) || (!maximizing && score < value)) {
      value = score;
      bestAction = action;
    }
    if (maximizing) alpha = Math.max(alpha, value);
    else beta = Math.min(beta, value);
    if (alpha >= beta) break;
  }

  const flag = value <= originalAlpha ? "upper" : value >= originalBeta ? "lower" : "exact";
  table.set(key, { depth, score: value, flag, bestActionKey: bestAction ? actionKey(bestAction) : null });
  return value;
}

function runEndgameV2(publicState, rootColor, { deadline, rootActionKeys } = {}) {
  const state = cloneState(publicState);
  const allowedRootKeys = rootActionKeys?.length ? new Set(rootActionKeys) : null;
  const rootActions = orderedActionsV2(state).filter((action) => !allowedRootKeys || allowedRootKeys.has(actionKey(action)));
  let bestAction = rootActions[0] ?? null;
  let bestScore = bestAction ? estimateActionValue(state, bestAction, rootColor) : -Infinity;
  let completedDepth = 0;
  const counters = { nodes: 0 };
  const table = new Map();
  const pieceCount = state.board.filter(Boolean).length;
  const maximumDepth = pieceCount <= 6 ? 20 : pieceCount <= 10 ? 15 : pieceCount <= 16 ? 11 : 9;

  for (let depth = 1; depth <= maximumDepth && Date.now() < deadline; depth += 1) {
    let iterationAction = null;
    let iterationScore = -Infinity;
    try {
      for (const action of rootActions) {
        const next = cloneState(state);
        if (!applySimulatedAction(next, action)) continue;
        const score = alphaBetaV2(next, depth - 1, -Infinity, Infinity, rootColor, deadline, table, counters, 1);
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

function applyKnownFlip(state, index, piece) {
  if (!state.board[index] || state.board[index].revealed) return false;
  state.board[index] = { ...piece, revealed: true };
  state.turn = otherColor(state.turn);
  recordCurrentPosition(state);
  return true;
}

function immediateLossRisk(publicState, action, rootColor) {
  if (publicState.health[rootColor] > 1) return 0;
  const outcomes = [];
  if (action.type === "flip") {
    const pool = remainingInventory(publicState).pool;
    const groups = new Map();
    for (const piece of pool) {
      const key = `${piece.color}:${piece.type}`;
      const group = groups.get(key) ?? { piece, count: 0 };
      group.count += 1;
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const next = cloneState(publicState);
      if (applyKnownFlip(next, action.index, group.piece)) outcomes.push({ state: next, weight: group.count });
    }
  } else {
    const next = cloneState(publicState);
    if (applySimulatedAction(next, action)) outcomes.push({ state: next, weight: 1 });
  }
  if (!outcomes.length) return 1;

  let weightedRisk = 0;
  let totalWeight = 0;
  for (const outcome of outcomes) {
    const alreadyLost = outcome.state.status === "finished" && outcome.state.loser === rootColor;
    const canLoseNext = outcome.state.status === "playing" &&
      outcome.state.health[rootColor] <= 1 &&
      legalActionsFor(outcome.state, outcome.state.turn).captures.length > 0;
    if (alreadyLost || canLoseNext) weightedRisk += outcome.weight;
    totalWeight += outcome.weight;
  }
  return totalWeight ? weightedRisk / totalWeight : 1;
}

function runClassicHybridV2(publicState, color, options, deadline) {
  const verificationReserve = publicState.health[color] <= 1 ? 8 : 1;
  const remainingMs = Math.max(5, deadline - Date.now() - verificationReserve);
  const maxIterations = Number.isFinite(options.maxIterations) ? options.maxIterations : undefined;
  const baseline = chooseAIAction(publicState, color, {
    ...options,
    timeLimitMs: remainingMs,
    ...(maxIterations === undefined ? {} : { maxIterations }),
  });
  if (options.ponder === true) {
    return {
      ...baseline,
      action: null,
      method: "ponder-hybrid-mcts-v2",
      aiVersion: "v2",
      lane: "classic",
    };
  }
  if (!baseline.action || !baseline.candidates?.length) {
    return { ...baseline, method: "hybrid-mcts-v2", aiVersion: "v2", lane: "classic" };
  }

  const candidates = baseline.candidates.slice(0, 4).map((candidate) => ({ ...candidate }));
  const baselineKey = actionKey(baseline.action);
  let selected = candidates.find((candidate) => actionKey(candidate.action) === baselineKey) ?? candidates[0];
  let selectedRisk = immediateLossRisk(publicState, selected.action, color);
  for (const candidate of candidates) {
    candidate.immediateLossRisk = actionKey(candidate.action) === actionKey(selected.action)
      ? selectedRisk
      : immediateLossRisk(publicState, candidate.action, color);
    const enoughEvidence = candidate.visits >= Math.max(2, (selected.visits ?? 0) * 0.12);
    if (enoughEvidence && candidate.immediateLossRisk + 0.12 < selectedRisk) {
      selected = candidate;
      selectedRisk = candidate.immediateLossRisk;
    }
  }
  const visitBoost = Math.max(1, Math.floor(Math.max(...candidates.map((candidate) => candidate.visits ?? 0)) * 0.3));
  selected.visits = (selected.visits ?? 0) + visitBoost;
  candidates.sort((left, right) => (
    (actionKey(left.action) === actionKey(selected.action) ? 1 : 0) -
    (actionKey(right.action) === actionKey(selected.action) ? 1 : 0)
  )).reverse();
  return {
    ...baseline,
    action: selected.action,
    candidates,
    method: "hybrid-mcts-v2",
    aiVersion: "v2",
    lane: "classic",
  };
}

export function chooseAIActionV2(publicState, color, options = {}) {
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
    return { action: null, method: "none-v2", elapsedMs: Date.now() - startedAt, hiddenCount, remaining: inventory.remaining };
  }

  const immediateWin = !pondering && rootActions.find((action) => (
    action.type === "move" && publicState.board[action.to]?.revealed && publicState.health[otherColor(color)] <= 1
  ));
  if (immediateWin) {
    return {
      action: immediateWin,
      method: "forced-win-v2",
      aiVersion: "v2",
      elapsedMs: Date.now() - startedAt,
      hiddenCount,
      remaining: inventory.remaining,
      score: 1,
    };
  }

  if (!pondering && hiddenCount === 1) {
    // The final hidden identity is logically deducible from public inventory;
    // assigning it reveals no information that a human could not calculate.
    const deducedState = determinize(publicState, () => 0);
    const result = runEndgameV2(deducedState, color, { deadline, rootActionKeys: options.rootActionKeys });
    return {
      ...result,
      method: "deduced-alpha-beta-v2",
      aiVersion: "v2",
      elapsedMs: Date.now() - startedAt,
      hiddenCount,
      remaining: inventory.remaining,
    };
  }

  const useClassicLane = options.v2Lane !== "belief";
  if (hiddenCount > 0 && useClassicLane) {
    const result = runClassicHybridV2(publicState, color, options, deadline);
    return { ...result, elapsedMs: Date.now() - startedAt, hiddenCount, remaining: inventory.remaining };
  }

  if (pondering) {
    const result = runBeliefMCTS(publicState, color, {
      deadline,
      rng,
      maxIterations: Number.isFinite(options.maxIterations) ? options.maxIterations : Infinity,
      collectPonderStates: true,
    });
    return {
      ...result,
      action: null,
      method: "ponder-belief-mcts-v2",
      aiVersion: "v2",
      elapsedMs: Date.now() - startedAt,
      hiddenCount,
      remaining: inventory.remaining,
    };
  }

  const result = hiddenCount === 0
    ? runEndgameV2(publicState, color, { deadline, rootActionKeys: options.rootActionKeys })
    : runBeliefMCTS(publicState, color, {
        deadline,
        rng,
        maxIterations: Number.isFinite(options.maxIterations) ? options.maxIterations : Infinity,
      });
  return {
    ...result,
    method: hiddenCount === 0 ? "alpha-beta-v2" : "belief-mcts-v2",
    aiVersion: "v2",
    elapsedMs: Date.now() - startedAt,
    hiddenCount,
    remaining: inventory.remaining,
  };
}
