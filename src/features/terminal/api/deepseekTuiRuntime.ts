const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX = "777;cli-manager-dsh-tui;";
interface Reader { decoder: TextDecoder; pending: string; }
const readers = new Map<string, Reader>();
let identityHandler: ((ptySessionId: string, cliSessionId: string) => void) | null = null;

/** Identity metadata has one state owner; it does not own terminal display or ACKs. */
export function setDeepSeekTuiIdentityHandler(handler: typeof identityHandler): void {
  identityHandler = handler;
}

/** Parse a bounded OSC across arbitrary UTF-8 PTY frame boundaries, scoped to its owning PTY. */
export function observeDeepSeekTuiOutput(sessionId: string, bytes: Uint8Array, reset = false): void {
  if (!UUID.test(sessionId)) return;
  let reader = readers.get(sessionId);
  if (!reader || reset) {
    reader = { decoder: new TextDecoder(), pending: "" };
    readers.set(sessionId, reader);
  }
  const text = reader.pending + reader.decoder.decode(bytes, { stream: true });
  reader.pending = "";
  let offset = 0;
  for (;;) {
    const start = text.indexOf("\x1b]", offset);
    if (start < 0) {
      if (text.endsWith("\x1b")) reader.pending = "\x1b";
      return;
    }
    const bell = text.indexOf("\x07", start + 2);
    const st = text.indexOf("\x1b\\", start + 2);
    const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
    if (end < 0) {
      // Never retain an unbounded or malformed OSC emitted by an external process.
      if (text.length - start <= 512) reader.pending = text.slice(start);
      return;
    }
    const content = text.slice(start + 2, end);
    if (content.startsWith(PREFIX)) {
      const fields = content.slice(PREFIX.length).split(";");
      if (fields.length === 2 && fields[0] === sessionId && UUID.test(fields[1])) {
        identityHandler?.(sessionId, fields[1]);
      }
    }
    offset = end + (end === st ? 2 : 1);
  }
}

/** Fresh/closed PTYs must not retain partial protocol bytes. Live attach resets only the reader. */
export function forgetDeepSeekTuiSession(sessionId?: string): void {
  if (sessionId) readers.delete(sessionId);
  else readers.clear();
}
