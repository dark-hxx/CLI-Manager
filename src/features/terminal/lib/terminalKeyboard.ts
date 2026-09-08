// Pure paste-text helpers for the terminal. No xterm runtime dependency.

export const trimTerminalPasteBoundaryLineBreaks = (text: string) => (
  text.replace(/^(?:\r\n?|\n)+|(?:\r\n?|\n)+$/gu, "")
);

export const wrapTerminalPasteTextForCtrlShiftV = (text: string) => {
  const trimmed = trimTerminalPasteBoundaryLineBreaks(text);
  return /[\r\n]/u.test(trimmed) ? `'${trimmed}'` : trimmed;
};
