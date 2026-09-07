import { lazy } from "react";

export const HistoryWorkspace = lazy(() =>
  import("../../history/api/HistoryWorkspace").then((module) => ({ default: module.HistoryWorkspace }))
);

export const GitChangesPanel = lazy(() =>
  import("../../git/api/GitChangesPanel").then((module) => ({ default: module.GitChangesPanel }))
);

export const GitWorkspace = lazy(() =>
  import("../../git/api/GitWorkspace").then((module) => ({ default: module.GitWorkspace }))
);

export const TerminalStatsPanel = lazy(() =>
  import("./TerminalStatsPanel").then((module) => ({ default: module.TerminalStatsPanel }))
);

export const FileEditorPane = lazy(() =>
  import("../../files/index").then((module) => ({ default: module.FileEditorPane }))
);

export const SubagentTranscriptView = lazy(() =>
  import("./SubagentTranscriptView").then((module) => ({ default: module.SubagentTranscriptView }))
);

export const SessionReplayPanel = lazy(() =>
  import("./SessionReplayPanel").then((module) => ({ default: module.SessionReplayPanel }))
);
