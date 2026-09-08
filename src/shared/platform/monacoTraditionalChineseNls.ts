import "monaco-editor/esm/nls.messages.zh-tw.js";

interface MonacoNlsGlobal {
  _VSCODE_NLS_MESSAGES?: string[];
}

export const monacoTraditionalChineseNlsMessages = (
  globalThis as typeof globalThis & MonacoNlsGlobal
)._VSCODE_NLS_MESSAGES ?? [];
