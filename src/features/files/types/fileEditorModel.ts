import type { OnMount } from "@monaco-editor/react";
import type { TerminalSession } from "../../../lib/types";

export interface FileEditorPaneProps {
  session: TerminalSession;
  isActive: boolean;
  terminalThemeBackground: string;
  onClose: () => void;
}

export type PendingAction = { closePane: boolean; paths: string[]; dirtyPaths: string[] } | null;

export type MonacoEditor = Parameters<OnMount>[0];

export type MarkdownNavigationMode = "source" | "preview";

export interface PendingMarkdownNavigation {
  id: number;
  path: string;
  fragment: string;
  mode: MarkdownNavigationMode;
}
