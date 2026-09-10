import type { TerminalChunk } from "./domain";

export type TerminalStreamListener = (chunk: TerminalChunk) => void;

export type TerminalStream = {
  start: (sessionId: string) => void;
  clear: (sessionId?: string) => void;
  publish: (sessionId: string, chunk: TerminalChunk) => void;
  subscribe: (sessionId: string, listener: TerminalStreamListener) => () => void;
  markRendered: (sessionId: string, sequence: number) => void;
  renderedSequence: (sessionId: string) => number | undefined;
};

const MAX_BUFFERED_CHUNKS = 64;

export function createTerminalStream(): TerminalStream {
  type SessionStream = {
    generation: number;
    buffered: TerminalChunk[];
    rendered: number;
    listeners: Set<{ generation: number; listener: TerminalStreamListener }>;
  };
  const sessions = new Map<string, SessionStream>();

  return {
    start(sessionId) {
      if (sessions.has(sessionId)) return;
      sessions.set(sessionId, { generation: 1, buffered: [], rendered: 0, listeners: new Set() });
    },
    clear(sessionId) {
      if (sessionId) {
        sessions.delete(sessionId);
        return;
      }
      sessions.clear();
    },
    publish(sessionId, chunk) {
      const session = sessions.get(sessionId);
      if (!session) return;
      const active = [...session.listeners].filter((entry) => entry.generation === session.generation);
      if (active.length) {
        active.forEach((entry) => entry.listener(chunk));
        return;
      }
      session.buffered.push(chunk);
      if (session.buffered.length > MAX_BUFFERED_CHUNKS) session.buffered = session.buffered.slice(-MAX_BUFFERED_CHUNKS);
    },
    subscribe(sessionId, listener) {
      const session = sessions.get(sessionId);
      if (!session) return () => undefined;
      const entry = { generation: session.generation, listener };
      session.listeners.add(entry);
      const pending = session.buffered;
      session.buffered = [];
      pending.forEach(listener);
      return () => session.listeners.delete(entry);
    },
    markRendered(sessionId, sequence) {
      const session = sessions.get(sessionId);
      if (session && Number.isSafeInteger(sequence) && sequence > session.rendered) session.rendered = sequence;
    },
    renderedSequence(sessionId) {
      const rendered = sessions.get(sessionId)?.rendered ?? 0;
      return rendered > 0 ? rendered : undefined;
    },
  };
}
