const RETRY_DELAYS_MS = [50, 100, 200, ...Array<number>(18).fill(500)];

export function isWebTerminalQueueFull(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === "web device send queue is full"
    || message === "web device send queue byte limit reached";
}

/** Retry only explicit admission rejection; transport failures may have executed. */
export async function publishWebTerminalBatch(
  publish: () => Promise<void>,
  isCurrent: () => boolean,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<boolean> {
  for (let attempt = 0; isCurrent(); attempt += 1) {
    try {
      await publish();
      return isCurrent();
    } catch (error) {
      if (!isCurrent()) return false;
      if (!isWebTerminalQueueFull(error) || attempt >= RETRY_DELAYS_MS.length) throw error;
      await wait(RETRY_DELAYS_MS[attempt]!);
    }
  }
  return false;
}
