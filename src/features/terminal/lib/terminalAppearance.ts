type CursorStyle = "bar" | "block" | "underline";

export function terminalAppearanceOptions(lineHeight: unknown, cursorStyle: unknown) {
  return {
    lineHeight: typeof lineHeight === "number" && Number.isFinite(lineHeight)
      ? Math.max(1, Math.min(2, lineHeight)) : 1,
    cursorStyle: (cursorStyle === "block" || cursorStyle === "underline" ? cursorStyle : "bar") as CursorStyle,
  };
}

export function applyTerminalAppearance(
  terminal: { options: { lineHeight?: number; cursorStyle?: CursorStyle } },
  lineHeight: unknown,
  cursorStyle: unknown,
) {
  const next = terminalAppearanceOptions(lineHeight, cursorStyle);
  const resize = terminal.options.lineHeight !== next.lineHeight;
  terminal.options.lineHeight = next.lineHeight;
  terminal.options.cursorStyle = next.cursorStyle;
  return resize;
}
