export interface TerminalRichTextSegment {
  kind: "text";
  text: string;
  rawStart: number;
  rawEnd: number;
}

export interface TerminalRichFileSegment {
  kind: "file";
  raw: string;
  pathPart: string;
  fileName: string;
  lineLabel: string | null;
  label: string;
  rawStart: number;
  rawEnd: number;
}

export interface TerminalRichSeparatorSegment {
  kind: "separator";
  text: string;
  rawStart: number;
  rawEnd: number;
}

export type TerminalRichAtomicSegment = TerminalRichFileSegment | TerminalRichSeparatorSegment;
export type TerminalRichInputSegment = TerminalRichTextSegment | TerminalRichAtomicSegment;

const AI_PATH_TOKEN_REGEX = /@([^\s@]+)(?:\s+(L\d+(?:-L?\d+)?))?/g;

const cursorLength = (text: string) => Array.from(text).length;

const extractFileName = (pathPart: string): string => {
  let body = pathPart.replace(/[#:]L?\d+(?:-L?\d+)?$/i, "");
  body = body.replace(/\/+$/, "");
  const segments = body.split(/[/\\]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : body;
};

const resolveLineLabel = (pathPart: string, spacedRange: string | undefined): string | null => {
  let raw = spacedRange;
  if (!raw) {
    const inline = pathPart.match(/[#:](L?\d+(?:-L?\d+)?)$/i);
    if (inline) raw = inline[1];
  }
  if (!raw) return null;
  const match = raw.match(/L?(\d+)(?:-L?(\d+))?/i);
  if (!match) return null;
  return match[2] ? `L${match[1]}-L${match[2]}` : `L${match[1]}`;
};

export function parseTerminalRichInput(input: string): TerminalRichInputSegment[] {
  const segments: TerminalRichInputSegment[] = [];
  let previousStringIndex = 0;
  let previousCursorIndex = 0;
  AI_PATH_TOKEN_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = AI_PATH_TOKEN_REGEX.exec(input)) !== null) {
    const rawStart = cursorLength(input.slice(0, match.index));
    if (match.index > previousStringIndex) {
      segments.push({
        kind: "text",
        text: input.slice(previousStringIndex, match.index),
        rawStart: previousCursorIndex,
        rawEnd: rawStart,
      });
    }

    const raw = match[0];
    const pathPart = match[1];
    const fileName = extractFileName(pathPart);
    const lineLabel = resolveLineLabel(pathPart, match[2]);
    const rawEnd = rawStart + cursorLength(raw);
    if (fileName) {
      segments.push({
        kind: "file",
        raw,
        pathPart,
        fileName,
        lineLabel,
        label: lineLabel ? `${fileName} ${lineLabel}` : fileName,
        rawStart,
        rawEnd,
      });
    } else {
      segments.push({ kind: "text", text: raw, rawStart, rawEnd });
    }

    previousStringIndex = match.index + raw.length;
    previousCursorIndex = rawEnd;
  }

  if (previousStringIndex < input.length) {
    segments.push({
      kind: "text",
      text: input.slice(previousStringIndex),
      rawStart: previousCursorIndex,
      rawEnd: cursorLength(input),
    });
  }

  return segments.map((segment, index) => {
    if (
      segment.kind === "text" &&
      /^[ \t]+$/u.test(segment.text) &&
      segments[index - 1]?.kind === "file" &&
      segments[index + 1]?.kind === "file"
    ) {
      return {
        kind: "separator",
        text: segment.text,
        rawStart: segment.rawStart,
        rawEnd: segment.rawEnd,
      } satisfies TerminalRichSeparatorSegment;
    }
    return segment;
  });
}

export function findTerminalRichAtomicBeforeCursor(
  segments: TerminalRichInputSegment[],
  cursorIndex: number,
): TerminalRichAtomicSegment | null {
  return segments.find((segment): segment is TerminalRichAtomicSegment => (
    segment.kind !== "text" && segment.rawEnd === cursorIndex
  )) ?? null;
}

export function findTerminalRichAtomicAfterCursor(
  segments: TerminalRichInputSegment[],
  cursorIndex: number,
): TerminalRichAtomicSegment | null {
  return segments.find((segment): segment is TerminalRichAtomicSegment => (
    segment.kind !== "text" && segment.rawStart === cursorIndex
  )) ?? null;
}

export function snapTerminalRichCursor(
  segments: TerminalRichInputSegment[],
  cursorIndex: number,
): number {
  const containingSegment = segments.find((segment): segment is TerminalRichAtomicSegment => (
    segment.kind !== "text" && cursorIndex > segment.rawStart && cursorIndex < segment.rawEnd
  ));
  if (!containingSegment) return cursorIndex;
  return cursorIndex - containingSegment.rawStart <= containingSegment.rawEnd - cursorIndex
    ? containingSegment.rawStart
    : containingSegment.rawEnd;
}
