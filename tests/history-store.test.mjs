import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HistoryStore } from "../server/history-store.mjs";

function sampleRecord(id = "history-1") {
  return {
    schemaVersion: 1,
    id,
    roomId: "ABCDE",
    roomName: "持久化测试",
    startedAt: 1_000,
    endedAt: 8_000,
    initialHealth: 14,
    players: [
      { color: "blue", id: "blue-player", nickname: "蓝方", isAI: false },
      { color: "red", id: "red-player", nickname: "红方", isAI: true },
    ],
    winner: "blue",
    loser: "red",
    endReason: "resign",
    frames: [
      {
        sequence: 0,
        at: 1_000,
        action: { type: "start", at: 1_000 },
        board: [{ hidden: true }, ...Array(31).fill(null)],
        health: { blue: 14, red: 14 },
        capturedBy: { blue: [], red: [] },
        turn: "blue",
        status: "playing",
        winner: null,
        loser: null,
        endReason: null,
      },
      {
        sequence: 1,
        at: 8_000,
        action: { type: "resign", color: "red", at: 8_000 },
        board: [{ hidden: true }, ...Array(31).fill(null)],
        health: { blue: 14, red: 14 },
        capturedBy: { blue: [], red: [] },
        turn: "red",
        status: "finished",
        winner: "blue",
        loser: "red",
        endReason: "resign",
      },
    ],
  };
}

test("历史记录写入磁盘后可由新的存储实例完整读取", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jungle-history-"));
  const filePath = join(directory, "records.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const firstServer = new HistoryStore({ filePath });
  assert.equal(firstServer.append(sampleRecord()), true);
  assert.equal(firstServer.append(sampleRecord()), false);

  const secondServer = new HistoryStore({ filePath });
  assert.equal(secondServer.list().length, 1);
  assert.equal(secondServer.list()[0].stepCount, 1);
  assert.equal(secondServer.list()[0].durationMs, 7_000);
  assert.equal(secondServer.get("history-1").players[1].isAI, true);
  assert.deepEqual(secondServer.get("history-1").frames[0].board[0], { hidden: true });
  assert.equal((await readFile(filePath, "utf8")).includes("history-1"), true);
});

test("损坏的历史文件会明确拒绝加载而不是静默覆盖", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jungle-history-corrupt-"));
  const filePath = join(directory, "records.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await import("node:fs/promises").then(({ writeFile }) => writeFile(filePath, "{broken", "utf8"));
  assert.throws(() => new HistoryStore({ filePath }), /无法读取历史对局文件/);
});
