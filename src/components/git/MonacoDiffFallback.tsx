import { useMemo } from "react";
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
  wrapLines?: boolean;
}

export function MonacoDiffFallback({ value, theme, wrapLines = false }: MonacoDiffFallbackProps) {
  const options = useMemo(() => ({
    ...DIFF_EDITOR_OPTIONS,
    wordWrap: wrapLines ? "on" as const : "off" as const,
  }), [wrapLines]);

  return <Editor value={value} language="diff" theme={theme} options={options} />;
}
