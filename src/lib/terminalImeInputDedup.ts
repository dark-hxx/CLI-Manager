export type TerminalInputSource = "onData" | "nativeTextInput";

const IME_CROSS_SOURCE_DUPLICATE_WINDOW_MS = 80;
const IME_PROCESS_KEY_CHECKPOINT_WINDOW_MS = 400;
const IME_PROCESS_KEY_SNAPSHOT_WINDOW_MS = 32;
const MAX_TRACKED_IME_PAYLOAD_LENGTH = 1_024;

interface ForwardedTerminalInput {
  data: string;
  source: TerminalInputSource;
  at: number;
}

interface ImeProcessKeyCheckpoint {
  at: number;
  precedingData: string;
  followingData: string;
}

export interface TerminalImeInputDeduperOptions {
  shouldEnableSameSourceProcessKeyDedup?: () => boolean;
}

export interface TerminalImeInputDeduper {
  shouldForward: (data: string, source: TerminalInputSource, now: number) => boolean;
  noteImeProcessKey: (now: number) => void;
  resetForComposition: () => void;
}

const normalizeInput = (data: string) => data.replace(/\r\n?/g, "\n");

const isInputCandidate = (data: string) => {
  if (!data || data === "\r" || data === "\x7f" || data === "\b" || data.startsWith("\x1b")) return false;
  return Boolean(normalizeInput(data).trim());
};

const isCrossSourceImeDuplicateCandidate = (data: string, source: TerminalInputSource) => {
  if (!isInputCandidate(data)) return false;
  const normalized = normalizeInput(data);
  if (/[^\x00-\x7f]/.test(normalized)) return true;
  return source === "nativeTextInput"
    && Array.from(normalized).length === 1
    && normalized.charCodeAt(0) >= 32;
};

const isSameSourceImeDuplicateCandidate = (data: string) => (
  isInputCandidate(data) && /[^\x00-\x7f]/.test(normalizeInput(data))
);

export const createTerminalImeInputDeduper = ({
  shouldEnableSameSourceProcessKeyDedup = () => false,
}: TerminalImeInputDeduperOptions = {}): TerminalImeInputDeduper => {
  let lastForwarded: ForwardedTerminalInput | null = null;
  let processKeyCheckpoint: ImeProcessKeyCheckpoint | null = null;

  const getActiveProcessKeyCheckpoint = (now: number) => {
    if (!processKeyCheckpoint) return null;
    if (!shouldEnableSameSourceProcessKeyDedup()) {
      processKeyCheckpoint = null;
      return null;
    }
    const elapsedMs = now - processKeyCheckpoint.at;
    if (elapsedMs < 0 || elapsedMs > IME_PROCESS_KEY_CHECKPOINT_WINDOW_MS) {
      processKeyCheckpoint = null;
      return null;
    }
    return processKeyCheckpoint;
  };

  const matchesProcessKeyCheckpoint = (data: string, checkpoint: ImeProcessKeyCheckpoint) => {
    const combinedData = checkpoint.precedingData + checkpoint.followingData;
    return data === checkpoint.precedingData
      || data === checkpoint.followingData
      || (combinedData.length > 0 && data === combinedData);
  };

  const appendFollowingData = (checkpoint: ImeProcessKeyCheckpoint, data: string) => {
    if (checkpoint.followingData.length + data.length > MAX_TRACKED_IME_PAYLOAD_LENGTH) {
      checkpoint.followingData = "";
      return;
    }
    checkpoint.followingData += data;
  };

  return {
    shouldForward: (data, source, now) => {
      const sameSourceCandidate = source === "onData" && isSameSourceImeDuplicateCandidate(data);
      const checkpoint = sameSourceCandidate ? getActiveProcessKeyCheckpoint(now) : null;
      if (checkpoint && matchesProcessKeyCheckpoint(data, checkpoint)) return false;

      if (
        isCrossSourceImeDuplicateCandidate(data, source)
        && lastForwarded
        && lastForwarded.source !== source
        && lastForwarded.data === data
        && now - lastForwarded.at >= 0
        && now - lastForwarded.at <= IME_CROSS_SOURCE_DUPLICATE_WINDOW_MS
      ) {
        return false;
      }

      lastForwarded = { data, source, at: now };
      if (checkpoint && sameSourceCandidate) {
        appendFollowingData(checkpoint, data);
      }
      return true;
    },
    noteImeProcessKey: (now) => {
      if (!shouldEnableSameSourceProcessKeyDedup()) {
        processKeyCheckpoint = null;
        return;
      }

      const precedingInput = lastForwarded;
      const precedingData = (
        precedingInput
        && precedingInput.source === "onData"
        && isSameSourceImeDuplicateCandidate(precedingInput.data)
        && now - precedingInput.at >= 0
        && now - precedingInput.at <= IME_PROCESS_KEY_SNAPSHOT_WINDOW_MS
      ) ? precedingInput.data : "";
      const activeCheckpoint = getActiveProcessKeyCheckpoint(now);
      if (activeCheckpoint) {
        if (!activeCheckpoint.precedingData && !activeCheckpoint.followingData && precedingData) {
          activeCheckpoint.precedingData = precedingData;
        }
        return;
      }

      processKeyCheckpoint = {
        at: now,
        precedingData,
        followingData: "",
      };
    },
    resetForComposition: () => {
      processKeyCheckpoint = null;
    },
  };
};
