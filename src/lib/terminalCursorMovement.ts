const repeatSequence = (sequence: string, count: number) => (
  count > 0 ? sequence.repeat(count) : ""
);

export const buildFastCursorMoveSequence = (
  currentCursorIndex: number,
  targetCursorIndex: number,
  inputLength: number,
  allowLineAnchors: boolean,
  applicationCursorKeysMode: boolean
) => {
  const current = Math.min(Math.max(0, currentCursorIndex), inputLength);
  const target = Math.min(Math.max(0, targetCursorIndex), inputLength);
  const delta = target - current;
  const cursorPrefix = applicationCursorKeysMode ? "\x1bO" : "\x1b[";
  const leftSequence = `${cursorPrefix}D`;
  const rightSequence = `${cursorPrefix}C`;
  const direct = {
    cost: Math.abs(delta),
    data: delta > 0
      ? repeatSequence(rightSequence, delta)
      : repeatSequence(leftSequence, -delta),
  };
  if (!allowLineAnchors) return direct.data;

  const candidates = [
    direct,
    {
      cost: target + 1,
      data: `${applicationCursorKeysMode ? "\x1bOH" : "\x1b[H"}${repeatSequence(rightSequence, target)}`,
    },
    {
      cost: inputLength - target + 1,
      data: `${applicationCursorKeysMode ? "\x1bOF" : "\x1b[F"}${repeatSequence(leftSequence, inputLength - target)}`,
    },
  ];
  return candidates.reduce((best, candidate) => candidate.cost < best.cost ? candidate : best).data;
};
