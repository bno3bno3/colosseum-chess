import test from "node:test";
import assert from "node:assert/strict";
import { createGameServer } from "../server/server.mjs";

function socketClient(url, sessionId, nickname) {
  const socket = new WebSocket(url);
  const messages = [];
  const waiters = [];

  function dispatch(message) {
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  }

  socket.addEventListener("message", (event) => dispatch(JSON.parse(event.data)));

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "hello", sessionId, nickname }));
      resolve();
    }, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  function waitFor(predicate, timeout = 2_000) {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error("等待 WebSocket 消息超时"));
      }, timeout);
      waiters.push(waiter);
    });
  }

  return {
    socket,
    messages,
    opened,
    waitFor,
    send(message) { socket.send(JSON.stringify(message)); },
  };
}

test("HTTP 与两个真实 WebSocket 客户端可完成大厅到首步操作", async (t) => {
  const gameServer = createGameServer({ disconnectGraceMs: 50, turnDurationMs: 2_000 });
  const address = await gameServer.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  t.after(async () => gameServer.close());

  const healthResponse = await fetch(`${base}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).ok, true);
  const pageResponse = await fetch(base);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /斗兽棋大厅/);

  const a = socketClient(wsUrl, "integration-a", "测试甲");
  const b = socketClient(wsUrl, "integration-b", "测试乙");
  await Promise.all([a.opened, b.opened]);
  await Promise.all([
    a.waitFor((message) => message.type === "welcome"),
    b.waitFor((message) => message.type === "welcome"),
  ]);

  a.send({ type: "create_room", name: "联机集成测试" });
  const created = await a.waitFor((message) => message.type === "room" && message.room.name === "联机集成测试");
  const roomId = created.room.id;
  b.send({ type: "join_room", roomId });
  await b.waitFor((message) => message.type === "room" && message.room.id === roomId);

  a.send({ type: "set_health", value: 5 });
  await a.waitFor((message) => message.type === "room" && message.room.health === 5);
  a.send({ type: "set_ready", ready: true });
  b.send({ type: "set_ready", ready: true });
  const gameA = await a.waitFor((message) => message.type === "room" && message.room.game?.status === "playing");
  const gameB = await b.waitFor((message) => message.type === "room" && message.room.game?.status === "playing");
  assert.equal(gameA.room.game.board.length, 32);
  assert.equal(gameA.room.game.board.every((piece) => piece.hidden && !piece.type), true);
  assert.equal(gameB.room.game.initialHealth, 5);

  const current = gameA.room.game.youColor === gameA.room.game.turn ? a : b;
  const currentGame = current === a ? gameA.room.game : gameB.room.game;
  current.send({ type: "flip", index: 0, version: currentGame.version });
  const updated = await current.waitFor(
    (message) => message.type === "room" && message.room.game?.version === currentGame.version + 1,
  );
  assert.equal(updated.room.game.board[0].hidden, undefined);
  assert.ok(updated.room.game.board[0].type);

  a.socket.close();
  b.socket.close();
});
