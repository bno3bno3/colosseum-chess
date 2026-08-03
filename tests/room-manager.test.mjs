import test from "node:test";
import assert from "node:assert/strict";
import { RoomManager } from "../server/room-manager.mjs";

function attach(manager, id, name) {
  const messages = [];
  const transport = {
    send(message) { messages.push(structuredClone(message)); },
    close() {},
  };
  const client = manager.attach({ sessionId: id, nickname: name, transport });
  return { client, messages, transport };
}

test("可创建不限数量房间并实时形成大厅列表", () => {
  const manager = new RoomManager({ rng: () => 0, now: () => 1_000 });
  const a = attach(manager, "player-a1", "小虎");
  const b = attach(manager, "player-b2", "小象");
  manager.createRoom(a.client, "森林一号");
  manager.createRoom(b.client, "森林二号");
  assert.equal(manager.rooms.size, 2);
  assert.equal(manager.lobbyView().length, 2);
  assert.deepEqual(new Set(manager.lobbyView().map((room) => room.name)), new Set(["森林一号", "森林二号"]));
});

test("加入、观战、入座、退出与房主转移", () => {
  const manager = new RoomManager({ rng: () => 0, now: () => 1_000 });
  const host = attach(manager, "host-0001", "房主");
  const player = attach(manager, "player-02", "玩家");
  const watcher = attach(manager, "watcher-3", "观战者");
  const room = manager.createRoom(host.client, "测试房");
  manager.joinRoom(player.client, room.id);
  manager.joinRoom(watcher.client, room.id);
  assert.deepEqual(room.players, [host.client.id, player.client.id]);
  assert.equal(room.spectators.has(watcher.client.id), true);

  manager.leaveRoom(player.client);
  manager.takeSeat(watcher.client);
  assert.deepEqual(room.players, [host.client.id, watcher.client.id]);
  manager.leaveRoom(host.client);
  assert.equal(room.hostId, watcher.client.id);
});

test("显式观战不占玩家席位且观战人数不设上限", () => {
  const manager = new RoomManager({ rng: () => 0, now: () => 1_000 });
  const host = attach(manager, "host-watch", "房主");
  const room = manager.createRoom(host.client, "无限观战测试");
  const watchers = [];
  for (let index = 0; index < 40; index += 1) {
    const watcher = attach(manager, `watcher-${index}`, `观众${index}`);
    watchers.push(watcher);
    manager.joinRoom(watcher.client, room.id, { asSpectator: true });
  }
  assert.equal(room.players[1], null);
  assert.equal(room.spectators.size, 40);
  assert.equal(manager.roomView(room, watchers[0].client).room.role, "spectator");
  assert.equal(manager.lobbyView()[0].spectators, 40);
});

test("房主可添加 AI，AI 自动准备并在自己的回合执行合法动作", () => {
  let clock = 1_000;
  const manager = new RoomManager({
    aiThinkMinMs: 10,
    aiThinkMaxMs: 10,
    aiSearchTimeMs: 5,
    rng: () => 0,
    now: () => clock,
  });
  const host = attach(manager, "host-ai-01", "真人房主");
  const room = manager.createRoom(host.client, "AI 测试");
  manager.addAI(host.client);
  const aiId = room.players[1];
  assert.equal(manager.clients.get(aiId).isAI, true);
  assert.equal(room.ready.has(aiId), true);
  assert.equal(manager.roomView(room, host.client).room.players[1].connected, true);
  assert.equal(manager.roomView(room, host.client).room.players[1].isAI, true);

  manager.setHealth(host.client, 8);
  manager.setReady(host.client, true);
  assert.equal(room.status, "playing");
  assert.equal(room.game.players.red, aiId);

  manager.performGameAction(host.client, { type: "flip", index: 0, version: room.game.version });
  const versionBeforeAI = room.game.version;
  clock += 10;
  manager.tick(clock);
  assert.equal(room.game.version, versionBeforeAI + 1);
  assert.equal(room.game.lastAction.isAI, true);
  assert.equal(room.game.turn, "blue");
});

test("房主可在开局前移除 AI", () => {
  const manager = new RoomManager({ rng: () => 0, now: () => 1_000 });
  const host = attach(manager, "host-ai-remove", "真人房主");
  const room = manager.createRoom(host.client, "移除 AI 测试");
  manager.addAI(host.client);
  const aiId = room.players[1];
  manager.removeAI(host.client);
  assert.equal(room.players[1], null);
  assert.equal(manager.clients.has(aiId), false);
});

test("高强度 AI 在后台线程搜索，完成后才提交匹配版本的走法", async (t) => {
  let clock = 2_000;
  const manager = new RoomManager({
    aiThinkMinMs: 0,
    aiThinkMaxMs: 0,
    aiSearchTimeMs: 220,
    aiWorkerCount: 2,
    aiQuantumMs: 40,
    rng: () => 0,
    now: () => clock,
  });
  t.after(() => manager.close());
  const host = attach(manager, "host-ai-worker", "后台测试");
  const room = manager.createRoom(host.client, "后台 AI");
  manager.addAI(host.client);
  manager.setReady(host.client, true);
  assert.equal(room.aiPondering, true);
  assert.equal(manager.roomView(room, host.client).room.players[1].aiPondering, true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  manager.performGameAction(host.client, { type: "flip", index: 0, version: room.game.version });
  const expectedVersion = room.game.version;
  manager.tick(clock);
  assert.equal(room.aiThinking, true);
  assert.equal(room.aiPondering, false);
  assert.equal(room.game.version, expectedVersion);

  const deadline = Date.now() + 2_000;
  while (room.game.version === expectedVersion && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(room.game.version, expectedVersion + 1);
  assert.equal(room.aiThinking, false);
  assert.equal(room.game.lastAction.isAI, true);
  assert.match(room.game.lastAction.ai.method, /ismcts|alpha-beta|forced-win|fallback/);
  assert.ok(room.game.lastAction.ai.elapsedMs <= 500);
  if (room.game.lastAction.ai.threads) assert.ok(room.game.lastAction.ai.threads <= 2);
});

test("只有房主可在无人准备时设置 1–16 血量", () => {
  const manager = new RoomManager({ rng: () => 0, now: () => 1_000 });
  const host = attach(manager, "host-0001", "房主");
  const player = attach(manager, "player-02", "玩家");
  const room = manager.createRoom(host.client, "设置测试");
  manager.joinRoom(player.client, room.id);
  manager.setHealth(host.client, 9);
  assert.equal(room.health, 9);
  assert.throws(() => manager.setHealth(player.client, 10), { code: "host_only" });
  assert.throws(() => manager.setHealth(host.client, 17), { code: "bad_health" });
  manager.setReady(player.client, true);
  assert.throws(() => manager.setHealth(host.client, 12), { code: "players_ready" });
});

test("两名玩家都准备后自动开局并随机映射阵营", () => {
  const manager = new RoomManager({ rng: () => 0, now: () => 5_000 });
  const a = attach(manager, "player-a1", "甲");
  const b = attach(manager, "player-b2", "乙");
  const room = manager.createRoom(a.client, "开局测试");
  manager.joinRoom(b.client, room.id);
  manager.setHealth(a.client, 7);
  manager.setReady(a.client, true);
  assert.equal(room.status, "waiting");
  manager.setReady(b.client, true);
  assert.equal(room.status, "playing");
  assert.equal(room.game.health.blue, 7);
  assert.equal(room.game.health.red, 7);
  assert.equal(room.game.players.blue, a.client.id);
  assert.equal(room.game.board.length, 32);
  assert.equal(room.game.board.every((piece) => piece && !piece.revealed), true);
});

test("服务器视图不会向玩家或观战者泄漏暗子身份", () => {
  const manager = new RoomManager({ rng: () => 0, now: () => 5_000 });
  const a = attach(manager, "player-a1", "甲");
  const b = attach(manager, "player-b2", "乙");
  const watcher = attach(manager, "watcher-3", "观众");
  const room = manager.createRoom(a.client, "脱敏测试");
  manager.joinRoom(b.client, room.id);
  manager.joinRoom(watcher.client, room.id);
  manager.setReady(a.client, true);
  manager.setReady(b.client, true);

  for (const viewer of [a.client, b.client, watcher.client]) {
    const payload = manager.roomView(room, viewer);
    assert.equal(payload.room.game.board.every((piece) => piece.hidden && !piece.type && !piece.color), true);
  }
});

test("对局中主动退出按认输处理，断线在宽限期内可重连", async () => {
  const manager = new RoomManager({ disconnectGraceMs: 25, rng: () => 0, now: () => Date.now() });
  const a = attach(manager, "player-a1", "甲");
  const b = attach(manager, "player-b2", "乙");
  const room = manager.createRoom(a.client, "重连测试");
  manager.joinRoom(b.client, room.id);
  manager.setReady(a.client, true);
  manager.setReady(b.client, true);

  manager.detach(a.client.id, a.transport);
  assert.equal(room.status, "playing");
  const replacement = attach(manager, "player-a1", "甲");
  assert.equal(replacement.client.roomId, room.id);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(room.status, "playing");

  manager.leaveRoom(replacement.client, { reason: "leave" });
  assert.equal(room.game.status, "finished");
  assert.equal(room.game.winner, "red");
  assert.equal(room.game.endReason, "leave");
});
