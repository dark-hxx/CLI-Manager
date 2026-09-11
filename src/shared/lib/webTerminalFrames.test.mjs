import assert from "node:assert/strict";
import { test } from "node:test";
import { batchWebTerminalFrames, normalizeWebTerminalBatchKiB } from "./webTerminalFrames.ts";

const frame = (data, extra = {}) => ({ kind: "replay", sessionId: "session", sequence: 123, cols: 160, rows: 48, data, replayBatchEnd: true, ...extra });
const decode = (batches) => Buffer.concat(batches.flatMap((batch) => batch.frames.map((part) => Buffer.from(part.data, "base64"))));

for (const limit of [96, 256, 512]) {
  test(`${limit} KiB batches preserve live bytes and only complete the last sequence segment`, () => {
    const data = new Uint8Array(2_000_003).map((_, i) => i % 251);
    const batches = batchWebTerminalFrames([frame(data, { kind: "output", replayBatchEnd: false })], limit);
    assert.deepEqual(decode(batches), Buffer.from(data));
    assert.ok(batches.every((batch) => Buffer.byteLength(JSON.stringify(batch.frames)) <= limit * 1024));
    const parts = batches.flatMap((batch) => batch.frames);
    assert.equal(parts[0].sequenceStart, true);
    assert.ok(parts.slice(1).every((part) => part.sequenceStart === false));
    assert.ok(parts.slice(0, -1).every((part) => part.sequenceEnd === false));
    assert.equal(parts.at(-1).sequenceEnd, true);
    assert.deepEqual(batches.flatMap((batch) => batch.acknowledgements), [{ sequence: 123, bytes: data.length }]);
    const small = batchWebTerminalFrames([frame(new Uint8Array([27, 91, 109]))], limit);
    assert.equal(small.length, 1);
    assert.deepEqual(decode(small), Buffer.from([27, 91, 109]));
    if (limit > 96) assert.ok(batches.length < batchWebTerminalFrames([frame(data)], 96).length);
  });
}

test("persisted batch choices normalize unsupported or old settings to default", () => {
  for (const value of [undefined, null, NaN, 0, -1, 1024, "512", {}, Infinity]) {
    assert.equal(normalizeWebTerminalBatchKiB(value), 96);
  }
  for (const value of [96, 256, 512]) assert.equal(normalizeWebTerminalBatchKiB(value), value);
});

test("large UTF-8 / ANSI replay survives bounded wire batches byte-for-byte", () => {
  const data = new TextEncoder().encode("\x1b[32m终端内容 🚀\x1b[0m\r\n".repeat(25_000));
  const batches = batchWebTerminalFrames([frame(new Uint8Array(), { kind: "reset", replayBatchEnd: false }), frame(data)]);
  assert.ok(batches.length > 2);
  assert.deepEqual(decode(batches), Buffer.from(data));
  for (const batch of batches) {
    assert.ok(JSON.stringify(batch.frames).length <= 96 * 1024);
    assert.ok(batch.frames.reduce((size, part) => size + part.data.length, 0) <= 128 * 1024);
    assert.ok(batch.frames.every((part) => part.cols === 160 && part.rows === 48 && part.sequence === 123));
  }
  const parts = batches.flatMap((batch) => batch.frames);
  assert.equal(parts.filter((part) => part.kind === "reset").length, 1);
  assert.equal(parts.filter((part) => part.replayBatchEnd).length, 1);
  assert.equal(parts.at(-1).replayBatchEnd, true);
  assert.equal(batches.flatMap((batch) => batch.acknowledgements).length, 0);
});

test("split live output acknowledges the original bytes only on its final batch", () => {
  const data = new Uint8Array(300_001).map((_, index) => index % 256);
  const batches = batchWebTerminalFrames([frame(data, { kind: "output", replayBatchEnd: false })]);
  assert.deepEqual(decode(batches), Buffer.from(data));
  assert.ok(batches.slice(0, -1).every((batch) => batch.acknowledgements.length === 0));
  assert.deepEqual(batches.at(-1).acknowledgements, [{ sequence: 123, bytes: data.length }]);
});

test("empty reset and replay boundary survive; reset payload becomes replay", () => {
  const batches = batchWebTerminalFrames([frame(new Uint8Array([1, 2, 3]), { kind: "reset" }), frame(new Uint8Array())]);
  const parts = batches.flatMap((batch) => batch.frames);
  assert.equal(parts[0].kind, "reset");
  assert.equal(parts[0].data, "");
  assert.equal(parts[0].replayBatchEnd, false);
  assert.equal(parts[0].sequenceEnd, false);
  assert.equal(parts[1].kind, "replay");
  assert.equal(parts[1].replayBatchEnd, true);
  assert.equal(parts[1].sequenceEnd, true);
  assert.equal(parts[2].replayBatchEnd, true);
  assert.deepEqual(decode(batches), Buffer.from([1, 2, 3]));
});

test("many empty metadata frames remain bounded", () => {
  const batches = batchWebTerminalFrames(Array.from({ length: 5000 }, () => frame(new Uint8Array())));
  assert.equal(batches.flatMap((batch) => batch.frames).length, 5000);
  assert.ok(batches.every((batch) => batch.frames.length <= 512 && JSON.stringify(batch.frames).length <= 96 * 1024));
});
