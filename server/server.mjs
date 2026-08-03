import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { RoomManager } from "./room-manager.mjs";
import { upgradeWebSocket } from "./websocket.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = normalize(join(HERE, "..", "public"));
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://localhost");
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end("Bad Request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const filePath = normalize(join(PUBLIC_ROOT, pathname));
  if (!filePath.startsWith(`${PUBLIC_ROOT}/`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const content = await readFile(filePath);
    const extension = extname(filePath).toLowerCase();
    response.writeHead(200, {
      "content-type": MIME_TYPES[extension] ?? "application/octet-stream",
      "content-length": content.length,
      "cache-control": extension === ".html" ? "no-store" : "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("没有找到这个页面");
  }
}

function validSessionId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

export function createGameServer(options = {}) {
  const openSockets = new Set();
  const manager = options.manager ?? new RoomManager({
    disconnectGraceMs: options.disconnectGraceMs,
    turnDurationMs: options.turnDurationMs,
    qaEnabled: options.qaEnabled ?? process.env.GAME_QA === "1",
    aiSearchTimeMs: options.aiSearchTimeMs ?? (Number.parseInt(process.env.AI_TIME_MS ?? "", 10) || undefined),
  });

  const httpServer = createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/api/health") {
      json(response, 200, {
        ok: true,
        rooms: manager.rooms.size,
        players: [...manager.clients.values()].filter((client) => client.transport).length,
        now: Date.now(),
      });
      return;
    }
    await serveStatic(request, response);
  });

  httpServer.on("connection", (socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const peer = upgradeWebSocket(request, socket, head);
    if (!peer) return;

    let client = null;
    let transport = null;
    const helloTimer = setTimeout(() => peer.close(4000, "连接超时"), 5_000);
    helloTimer.unref?.();

    peer.onmessage = (rawMessage) => {
      let message;
      try {
        message = JSON.parse(rawMessage);
      } catch {
        peer.send({ type: "error", code: "bad_json", message: "消息不是有效的 JSON" });
        return;
      }

      if (!client) {
        if (message?.type !== "hello") {
          peer.send({ type: "error", code: "hello_required", message: "请先建立玩家会话" });
          return;
        }
        clearTimeout(helloTimer);
        const sessionId = validSessionId(message.sessionId) ? message.sessionId : randomUUID();
        transport = {
          send: (payload) => peer.send(payload),
          close: (code, reason) => peer.close(code, reason),
        };
        client = manager.attach({ sessionId, nickname: message.nickname, transport });
        return;
      }

      manager.handle(client, message);
    };

    peer.onclose = () => {
      clearTimeout(helloTimer);
      if (client) manager.detach(client.id, transport);
    };
  });

  const tickTimer = setInterval(() => manager.tick(), 250);
  tickTimer.unref?.();

  return {
    manager,
    httpServer,
    async listen({ port = 4173, host = "0.0.0.0" } = {}) {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          httpServer.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          resolve();
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port, host);
      });
      return httpServer.address();
    },
    async close() {
      clearInterval(tickTimer);
      await manager.close?.();
      for (const client of manager.clients.values()) {
        client.transport?.close?.(1001, "服务器关闭");
        if (client.disconnectTimer) clearTimeout(client.disconnectTimer);
      }
      if (!httpServer.listening) return;
      const closing = new Promise((resolve) => httpServer.close(resolve));
      httpServer.closeAllConnections?.();
      for (const socket of openSockets) socket.destroy();
      await closing;
    },
  };
}

export function localAddresses(port) {
  const addresses = new Set([`http://localhost:${port}`]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.add(`http://${entry.address}:${port}`);
    }
  }
  return [...addresses];
}

const isMain = process.argv[1] && normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url));
if (isMain) {
  const requestedPort = Number.parseInt(process.env.PORT ?? "4173", 10);
  const port = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 4173;
  const gameServer = createGameServer();
  const address = await gameServer.listen({ port });
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log("\n  斗兽棋服务器已启动\n");
  for (const url of localAddresses(actualPort)) console.log(`  ➜  ${url}`);
  console.log("\n  同一局域网设备打开上面的地址即可加入。按 Ctrl+C 停止服务器。\n");

  const shutdown = async () => {
    await gameServer.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
