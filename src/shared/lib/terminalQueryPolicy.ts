import type { Terminal } from "@xterm/xterm";

const replaying = new WeakSet<Terminal>();
const sessions = new Map<string, { createdHere: boolean; sequence: number }>();

export function createTerminalQuerySession(sessionId: string): void {
  sessions.set(sessionId, { createdHere: true, sequence: 0 });
}

export function forgetTerminalQuerySession(sessionId?: string): void {
  if (sessionId === undefined) sessions.clear();
  else sessions.delete(sessionId);
}

/** First delivery of a new process's startup output can itself be labelled replay. */
export function canAnswerTerminalQueryFrame(sessionId: string, sequence: number, replay: boolean): boolean {
  const state = sessions.get(sessionId);
  return sequence > (state?.sequence ?? 0) && (!replay || state?.createdHere === true);
}

export function claimTerminalQueryFrame(sessionId: string, sequence: number, replay: boolean): boolean {
  const state = sessions.get(sessionId) ?? { createdHere: false, sequence: 0 };
  const answer = canAnswerTerminalQueryFrame(sessionId, sequence, replay);
  state.sequence = Math.max(state.sequence, sequence);
  sessions.set(sessionId, state);
  return answer;
}

export function setTerminalQueryReplay(terminal: Terminal, replay: boolean): void {
  if (replay) replaying.add(terminal);
  else replaying.delete(terminal);
}

export function canAnswerTerminalQuery(terminal: Terminal): boolean {
  return !replaying.has(terminal);
}

/** Queries are output-side protocol, not keystrokes. Mirrored/replayed output must not write back. */
export function installTerminalQueryPolicy(terminal: Terminal, canAnswer: () => boolean) {
  const consume = () => !canAnswer();
  const disposables = [
    terminal.parser.registerCsiHandler({ final: "c" }, consume),
    terminal.parser.registerCsiHandler({ prefix: ">", final: "c" }, consume),
    terminal.parser.registerCsiHandler({ prefix: "=", final: "c" }, consume),
    terminal.parser.registerCsiHandler({ prefix: ">", final: "q" }, consume),
    terminal.parser.registerCsiHandler({ final: "n" }, consume),
    terminal.parser.registerCsiHandler({ prefix: "?", final: "n" }, consume),
    terminal.parser.registerCsiHandler({ intermediates: "$", final: "p" }, consume),
    terminal.parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, consume),
    terminal.parser.registerCsiHandler({ prefix: "?", final: "u" }, consume),
    terminal.parser.registerCsiHandler({ final: "t" }, (params) => (
      [14, 16, 18, 20, 21].includes(Number(params[0])) && consume()
    )),
    terminal.parser.registerDcsHandler({ intermediates: "$", final: "q" }, consume),
    ...[4, 10, 11, 12].map((id) => terminal.parser.registerOscHandler(id, (data) => (
      data.split(";").includes("?") && consume()
    ))),
  ];
  return { dispose: () => disposables.forEach((entry) => entry.dispose()) };
}
