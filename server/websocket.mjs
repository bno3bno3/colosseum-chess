import { createHash } from "node:crypto";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = body.length;
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

export class WebSocketPeer {
  constructor(socket, head = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;

    socket.on("data", (chunk) => this.consume(chunk));
    socket.on("close", () => this.finishClose());
    socket.on("end", () => this.finishClose());
    socket.on("error", () => this.finishClose());
    if (head.length) this.consume(head);
  }

  send(payload) {
    if (this.closed || this.socket.destroyed) return;
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.socket.write(encodeFrame(0x1, Buffer.from(text)));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(String(reason).slice(0, 120));
    const payload = Buffer.allocUnsafe(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.socket.write(encodeFrame(0x8, payload));
    this.socket.end();
  }

  finishClose() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  protocolError() {
    this.close(1002, "协议错误");
  }

  consume(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (!masked) return this.protocolError();
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const longLength = this.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(2 ** 24)) return this.close(1009, "消息过大");
        length = Number(longLength);
        offset = 10;
      }

      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

      if (opcode >= 0x8 && (!fin || payload.length > 125)) return this.protocolError();
      if (opcode === 0x8) {
        if (!this.socket.destroyed) this.socket.write(encodeFrame(0x8, payload));
        this.socket.end();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(encodeFrame(0xA, payload));
        continue;
      }
      if (opcode === 0xA) continue;

      if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragmentOpcode !== null) return this.protocolError();
        if (fin) this.deliver(opcode, payload);
        else {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
        }
        continue;
      }

      if (opcode === 0x0 && this.fragmentOpcode !== null) {
        this.fragments.push(payload);
        if (fin) {
          const combined = Buffer.concat(this.fragments);
          const originalOpcode = this.fragmentOpcode;
          this.fragmentOpcode = null;
          this.fragments = [];
          this.deliver(originalOpcode, combined);
        }
        continue;
      }

      return this.protocolError();
    }
  }

  deliver(opcode, payload) {
    if (opcode !== 0x1) return this.close(1003, "仅支持文本消息");
    this.onmessage?.(payload.toString("utf8"));
  }
}

export function upgradeWebSocket(request, socket, head) {
  const key = request.headers["sec-websocket-key"];
  const version = request.headers["sec-websocket-version"];
  const upgrade = request.headers.upgrade;
  if (!key || version !== "13" || String(upgrade).toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }

  const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      "\r\n",
  );
  return new WebSocketPeer(socket, head);
}
