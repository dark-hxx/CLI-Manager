import type { OsPlatform } from "./shell";

export function getConfigModalShellPrefill(
  os: OsPlatform,
  currentShell: string | null | undefined,
  isEdit: boolean,
  isClone: boolean,
): string {
  const shellValue = currentShell ?? "";

  if (os === "macos") {
    if (!isEdit && !isClone && !shellValue.trim()) {
      return "zsh";
    }
  } else {
    return shellValue;
  }

  return shellValue;
}
