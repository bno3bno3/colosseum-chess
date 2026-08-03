import test from "node:test";
import assert from "node:assert/strict";
import { createSessionId } from "../public/uuid.mjs";

test("安全上下文优先使用 randomUUID", () => {
  const expected = "12345678-1234-4234-9234-123456789abc";
  assert.equal(createSessionId({ randomUUID: () => expected }), expected);
});

test("非安全上下文缺少 randomUUID 时使用 getRandomValues 生成 UUID v4", () => {
  const cryptoWithoutRandomUUID = {
    getRandomValues(bytes) {
      bytes.fill(0xab);
      return bytes;
    },
  };
  const id = createSessionId(cryptoWithoutRandomUUID);
  assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(id, "abababab-abab-4bab-abab-abababababab");
});

test("极旧浏览器没有 Web Crypto 时仍返回服务器可接受的会话 ID", () => {
  const id = createSessionId(null);
  assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
});
