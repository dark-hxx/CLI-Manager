import * as monaco from "monaco-editor";

interface MonacoNlsGlobal {
  _VSCODE_NLS_MESSAGES?: string[];
}

export { monaco };

export const monacoEnglishNlsMessages = (
  globalThis as typeof globalThis & MonacoNlsGlobal
)._VSCODE_NLS_MESSAGES ?? [];
