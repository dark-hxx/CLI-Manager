import { findOscTerminator } from "../../features/terminal/lib/terminalOscParse";

const MAX_BUFFERED_OSC = 16 * 1024;

function removeColorQueries(body: string): string | null {
  const [id, ...slots] = body.split(";");
  if (!slots.includes("?")) return body;
  if (id === "4") {
    const kept: string[] = [];
    for (let index = 0; index < slots.length; index += 2) {
      if (slots[index + 1] === "?") continue;
      kept.push(slots[index]);
      if (index + 1 < slots.length) kept.push(slots[index + 1]);
    }
    return kept.length ? [id, ...kept].join(";") : null;
  }
  if (id === "10" || id === "11" || id === "12") {
    const kept = slots.map((slot) => slot === "?" ? "" : slot);
    return kept.some(Boolean) ? [id, ...kept].join(";") : null;
  }
  return body;
}

/** Feed decoded strings in order, including allowed output; reset at terminal resets.
 * Oversized/malformed OSC passes through unchanged instead of retaining unbounded data.
 */
export function createTerminalColorQueryFilter() {
  let pending = "";
  let passthrough = false;
  return {
    feed(text: string, suppressQueries = true): string {
      const combined = pending + text;
      pending = "";
      let output = "";
      let cursor = 0;
      while (cursor < combined.length) {
        if (passthrough) {
          const end = findOscTerminator(combined, cursor);
          if (!end) {
            const trailingEscape = combined.endsWith("\x1b");
            output += combined.slice(cursor, trailingEscape ? -1 : undefined);
            pending = trailingEscape ? "\x1b" : "";
            break;
          }
          const next = "abortAt" in end ? end.abortAt : end.index + end.length;
          output += combined.slice(cursor, next);
          cursor = next;
          passthrough = false;
          continue;
        }
        const start = combined.indexOf("\x1b]", cursor);
        if (start < 0) {
          const trailingEscape = combined.endsWith("\x1b");
          output += combined.slice(cursor, trailingEscape ? -1 : undefined);
          pending = trailingEscape ? "\x1b" : "";
          break;
        }
        output += combined.slice(cursor, start);
        const end = findOscTerminator(combined, start + 2);
        if (!end) {
          pending = combined.slice(start);
          if (pending.length > MAX_BUFFERED_OSC) {
            const trailingEscape = pending.endsWith("\x1b");
            output += trailingEscape ? pending.slice(0, -1) : pending;
            pending = trailingEscape ? "\x1b" : "";
            passthrough = true;
          }
          break;
        }
        if ("abortAt" in end) {
          output += combined.slice(start, end.abortAt);
          cursor = end.abortAt;
          continue;
        }
        const body = combined.slice(start + 2, end.index);
        const filtered = suppressQueries ? removeColorQueries(body) : body;
        if (filtered !== null) output += "\x1b]" + filtered + combined.slice(end.index, end.index + end.length);
        cursor = end.index + end.length;
      }
      return output;
    },
    reset(): void { pending = ""; passthrough = false; },
  };
}
