import assert from "node:assert/strict";
import { test } from "node:test";
import { createTerminalStream } from "./terminalStream.ts";

function chunk(sequence) {
  return { sequence, frames: [{ sequence, cols: 80, rows: 24, data: "YQ==", kind: "output", replayBatchEnd: false }] };
}

test("terminal stream delivers live chunks without replacing application state", () => {
  const stream = createTerminalStream();
  stream.start("session-a");
  let delivered = 0;
  const unsubscribe = stream.subscribe("session-a", () => { delivered += 1; });
  for (let sequence = 1; sequence <= 10_000; sequence += 1) stream.publish("session-a", chunk(sequence));
  assert.equal(delivered, 10_000);
  unsubscribe();
});

test("terminal stream buffers mount races for multiple sessions", () => {
  const stream = createTerminalStream();
  stream.start("session-a");
  stream.publish("session-a", chunk(1));
  stream.publish("session-a", chunk(2));
  const delivered = [];
  stream.subscribe("session-a", (value) => delivered.push(value.sequence));
  assert.deepEqual(delivered, [1, 2]);

  stream.start("session-b");
  const original = [];
  stream.subscribe("session-a", (value) => original.push(value.sequence));
  stream.publish("session-a", chunk(3));
  stream.publish("session-b", chunk(4));
  const replacement = [];
  stream.subscribe("session-b", (value) => replacement.push(value.sequence));
  assert.deepEqual(replacement, [4]);
  assert.deepEqual(original, [3]);
});

test("terminal stream tracks and clears each session independently", () => {
  const stream = createTerminalStream();
  stream.start("session-a");
  stream.markRendered("session-a", 41);
  stream.markRendered("session-a", 40);
  assert.equal(stream.renderedSequence("session-a"), 41);
  stream.start("session-b");
  stream.markRendered("session-b", 9);
  assert.equal(stream.renderedSequence("session-a"), 41);
  assert.equal(stream.renderedSequence("session-b"), 9);
  stream.clear("session-a");
  assert.equal(stream.renderedSequence("session-a"), undefined);
  assert.equal(stream.renderedSequence("session-b"), 9);
  stream.clear();
  assert.equal(stream.renderedSequence("session-b"), undefined);
});
