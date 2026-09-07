import { lazy } from "react";

export const HistoryWorkspace = lazy(() =>
  import("../../../components/HistoryWorkspace").then((module) => ({ default: module.HistoryWorkspace }))
);

export const GitChangesPanel = lazy(() =>
  import("../../../components/git/GitChangesPanel").then((module) => ({ default: module.GitChangesPanel }))
);

export const GitWorkspace = lazy(() =>
  import("../../../components/git/workspace/GitWorkspace").then((module) => ({ default: module.GitWorkspace }))
);

export const TerminalStatsPanel = lazy(() =>
  import("../../../components/terminal/TerminalStatsPanel").then((module) => ({ default: module.TerminalStatsPanel }))
);

export const FileEditorPane = lazy(() =>
  import("../../../components/files/FileEditorPane").then((module) => ({ default: module.FileEditorPane }))
);

export const SubagentTranscriptView = lazy(() =>
  import("../../../components/terminal/SubagentTranscriptView").then((module) => ({ default: module.SubagentTranscriptView }))
);

export const SessionReplayPanel = lazy(() =>
  import("../../../components/terminal/SessionReplayPanel").then((module) => ({ default: module.SessionReplayPanel }))
);
