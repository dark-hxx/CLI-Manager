import type { TerminalProcessTraits } from "../transport/PtyHostSocket";

export const shouldReflowTerminalCursorLine = (
  traits: TerminalProcessTraits | null | undefined,
): boolean => {
  if (!traits) return false;
  if (traits.os === "macos" || traits.os === "linux") return true;
  return traits.os === "windows"
    && traits.windowsPty?.backend === "conpty"
    && traits.windowsPty.usesConptyDll === true;
};
