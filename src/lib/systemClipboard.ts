import {
  readText as readNativeClipboardText,
  writeText as writeNativeClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";

export async function readTextFromClipboard(): Promise<string> {
  try {
    return (await readNativeClipboardText()) ?? "";
  } catch {
    try {
      return (await navigator.clipboard.readText()) ?? "";
    } catch {
      return "";
    }
  }
}

export async function copyTextToClipboard(text: string) {
  if (!text) return;
  try {
    await writeNativeClipboardText(text);
    return;
  } catch {
    // Browser-only development does not expose the Tauri clipboard plugin.
  }
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  }
}
