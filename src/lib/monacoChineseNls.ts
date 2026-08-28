import "monaco-editor/esm/nls.messages.zh-cn.js";

interface MonacoNlsGlobal {
  _VSCODE_NLS_MESSAGES?: string[];
}

export const monacoChineseNlsMessages = (
  globalThis as typeof globalThis & MonacoNlsGlobal
)._VSCODE_NLS_MESSAGES ?? [];
