import Editor from "@monaco-editor/react";
import { configureMonaco } from "../../lib/monacoSetup";

configureMonaco();

const DIFF_EDITOR_OPTIONS = {
  automaticLayout: true,
  readOnly: true,
  domReadOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: "off",
  fontSize: 13,
  lineNumbersMinChars: 4,
  renderLineHighlight: "none",
  scrollbar: {
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
  },
} as const;

interface MonacoDiffFallbackProps {
  value: string;
  theme: "vs" | "vs-dark";
}

export function MonacoDiffFallback({ value, theme }: MonacoDiffFallbackProps) {
  return <Editor value={value} language="diff" theme={theme} options={DIFF_EDITOR_OPTIONS} />;
}
