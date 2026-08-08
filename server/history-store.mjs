import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_HISTORY_FILE = fileURLToPath(new URL("../data/game-history.json", import.meta.url));

function clone(value) {
  return structuredClone(value);
}

function summary(record) {
  return {
    id: record.id,
    roomName: record.roomName,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: Math.max(0, record.endedAt - record.startedAt),
    initialHealth: record.initialHealth,
    ruleIds: [...(record.ruleIds ?? [])],
    players: clone(record.players),
    winner: record.winner,
    endReason: record.endReason,
    stepCount: Math.max(0, record.frames.length - 1),
  };
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || typeof record.id !== "string") {
    throw new TypeError("历史记录缺少有效 ID");
  }
  if (!Array.isArray(record.frames) || !record.frames.length) {
    throw new TypeError("历史记录必须包含至少一个回放画面");
  }
  if (!Array.isArray(record.players) || record.players.length !== 2) {
    throw new TypeError("历史记录必须包含两名玩家");
  }
}

export class HistoryStore {
  constructor({ filePath = DEFAULT_HISTORY_FILE } = {}) {
    this.filePath = resolve(filePath);
    this.records = [];
    this.load();
  }

  load() {
    if (!existsSync(this.filePath)) return;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new Error(`无法读取历史对局文件 ${this.filePath}：${error.message}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`历史对局文件 ${this.filePath} 的根节点必须是数组`);
    for (const record of parsed) validateRecord(record);
    this.records = parsed;
  }

  persist() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.records, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  append(record) {
    validateRecord(record);
    if (this.records.some((entry) => entry.id === record.id)) return false;
    this.records.push(clone(record));
    try {
      this.persist();
    } catch (error) {
      this.records.pop();
      throw error;
    }
    return true;
  }

  list() {
    return this.records
      .map(summary)
      .sort((left, right) => right.endedAt - left.endedAt);
  }

  get(id) {
    const record = this.records.find((entry) => entry.id === id);
    return record ? clone(record) : null;
  }
}
