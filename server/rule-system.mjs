import { footballPoisonRule } from "./rules/football-poison.mjs";
import { snakeRule } from "./rules/snake.mjs";

const RULES = Object.freeze([footballPoisonRule, snakeRule]);
const RULE_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));

export function ruleCatalog() {
  return RULES.map(({ id, name, shortName, description }) => ({ id, name, shortName, description }));
}

export function normalizeRuleIds(ruleIds = []) {
  if (!Array.isArray(ruleIds)) return [];
  return [...new Set(ruleIds.map(String).filter((id) => RULE_BY_ID.has(id)))];
}

export function hasRule(ruleIds, id) {
  return Array.isArray(ruleIds) && ruleIds.includes(id);
}

export function pieceCountsForRules(baseCounts, ruleIds = []) {
  const counts = { ...baseCounts };
  for (const id of normalizeRuleIds(ruleIds)) RULE_BY_ID.get(id)?.modifyPieceCounts?.(counts);
  return Object.freeze(counts);
}

export function normalizeAnimalType(type, ruleIds = []) {
  let normalized = type;
  for (const id of normalizeRuleIds(ruleIds)) {
    normalized = RULE_BY_ID.get(id)?.normalizeAnimalType?.(normalized) ?? normalized;
  }
  return normalized;
}

export function specialAttackOutcome(context, ruleIds = []) {
  for (const id of normalizeRuleIds(ruleIds)) {
    const outcome = RULE_BY_ID.get(id)?.attackOutcome?.(context);
    if (outcome) return outcome;
  }
  return null;
}

export function runAfterCaptureRules(context, ruleIds = []) {
  const events = {};
  for (const id of normalizeRuleIds(ruleIds)) {
    Object.assign(events, RULE_BY_ID.get(id)?.afterCapture?.(context) ?? {});
  }
  return events;
}

export function runAfterTurnRules(context, ruleIds = []) {
  const events = {};
  for (const id of normalizeRuleIds(ruleIds)) {
    const next = RULE_BY_ID.get(id)?.afterTurn?.(context) ?? {};
    for (const [key, value] of Object.entries(next)) {
      if (Array.isArray(value)) events[key] = [...(events[key] ?? []), ...value];
      else events[key] = value;
    }
  }
  return events;
}
