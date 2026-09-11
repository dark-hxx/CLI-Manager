import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { createRequestId } from "./requestId.ts";

test("LAN HTTP request IDs work without secure-context randomUUID", () => {
  const httpCrypto = { getRandomValues: (bytes) => webcrypto.getRandomValues(bytes) };
  assert.equal(httpCrypto.randomUUID, undefined);
  const ids = new Set(Array.from({ length: 100 }, () => createRequestId(httpCrypto)));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
