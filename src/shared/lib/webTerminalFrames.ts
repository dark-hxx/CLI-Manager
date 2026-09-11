import type { TerminalBinaryFrame } from "../../features/terminal/transport/PtyHostSocket";

export type WebTerminalBatchKiB = 96 | 256 | 512;

export function normalizeWebTerminalBatchKiB(value: unknown): WebTerminalBatchKiB {
  return value === 256 || value === 512 ? value : 96;
}
const MAX_FRAME_BYTES = 48 * 1024;
const MAX_BATCH_FRAMES = 512;

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function batchWebTerminalFrames(frames: TerminalBinaryFrame[], maxBatchKiB: WebTerminalBatchKiB = 96) {
  const maxBatchBytes = normalizeWebTerminalBatchKiB(maxBatchKiB) * 1024;
  type Frame = { sequence: number; sequenceStart: boolean; sequenceEnd: boolean; cols: number; rows: number; data: string; kind: TerminalBinaryFrame["kind"]; replayBatchEnd: boolean };
  type Batch = { frames: Frame[]; acknowledgements: { sequence: number; bytes: number }[] };
  const batches: Batch[] = [];
  let batch: Batch = { frames: [], acknowledgements: [] };
  let bytes = 2;
  const normalized = frames.flatMap((frame) => frame.kind === "reset" && frame.data.length > 0
    ? [{ ...frame, data: new Uint8Array(), replayBatchEnd: false }, { ...frame, kind: "replay" as const }]
    : [frame]);
  for (const frame of normalized) {
    for (let offset = 0; offset < Math.max(1, frame.data.length); offset += MAX_FRAME_BYTES) {
      const last = offset + MAX_FRAME_BYTES >= frame.data.length;
      const part: Frame = {
        sequence: frame.sequence, cols: frame.cols, rows: frame.rows,
        sequenceEnd: last && !(frame.kind === "reset" && !frame.replayBatchEnd),
        sequenceStart: offset === 0,
        data: encode(frame.data.subarray(offset, offset + MAX_FRAME_BYTES)),
        // A reset belongs only to the first piece; another reset would erase
        // bytes already rendered from the same snapshot.
        kind: offset > 0 && frame.kind === "reset" ? "replay" : frame.kind,
        replayBatchEnd: last && frame.replayBatchEnd === true,
      };
      const size = JSON.stringify(part).length + 1;
      if (batch.frames.length && (bytes + size > maxBatchBytes || batch.frames.length >= MAX_BATCH_FRAMES)) {
        batches.push(batch);
        batch = { frames: [], acknowledgements: [] };
        bytes = 2;
      }
      batch.frames.push(part);
      bytes += size;
      // Commit the original sequence only after all its pieces were sent.
      if (last && frame.kind === "output" && !frame.replayBatchEnd) {
        batch.acknowledgements.push({ sequence: frame.sequence, bytes: frame.data.length });
      }
    }
  }
  if (batch.frames.length) batches.push(batch);
  return batches;
}
