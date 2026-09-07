export interface StatuslineWidget {
  id: string;
  type: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean | "parens";
  character?: string;
  rawValue?: boolean;
  customText?: string;
  customSymbol?: string;
  commandPath?: string;
  maxWidth?: number;
  preserveColors?: boolean;
  timeout?: number;
  merge?: boolean | "no-padding";
  hide?: boolean;
  metadata?: Record<string, string>;
}

export interface StatuslinePowerline {
  enabled: boolean;
  separators: string[];
  separatorInvertBackground: boolean[];
  startCaps: string[];
  endCaps: string[];
  theme?: string;
  autoAlign: boolean;
  continueThemeAcrossLines: boolean;
}

export interface StatuslineSettings {
  version: number;
  lines: StatuslineWidget[][];
  flexMode: string;
  compactThreshold: number;
  colorLevel: number;
  defaultSeparator?: string;
  defaultPadding?: string;
  inheritSeparatorColors: boolean;
  overrideBackgroundColor?: string;
  overrideForegroundColor?: string;
  globalBold: boolean;
  gitCacheTtlSeconds: number;
  minimalistMode: boolean;
  powerline: StatuslinePowerline;
  importedFrom?: string;
}

export interface StatuslineStatus {
  settingsPath: string;
  claudeSettingsPath: string;
  installed: boolean;
  currentCommand: string | null;
  legacySettingsPath: string;
  legacySettingsAvailable: boolean;
}

export interface StatuslineCatalogEntry {
  widgetType: string;
  category: string;
  zhName: string;
  enName: string;
}

export const STATUSLINE_PREVIEW_PAYLOAD = {
  session_id: "preview-session",
  cwd: "D:/work/example-project",
  workspace: { current_dir: "D:/work/example-project", project_dir: "D:/work/example-project" },
  model: { id: "claude-opus", display_name: "Claude Opus" },
  version: "2.2.23",
  output_style: { name: "default" },
  effort: { level: "high" },
  cost: { total_cost_usd: 1.28, total_duration_ms: 754000, total_lines_added: 128, total_lines_removed: 24 },
  context_window: {
    context_window_size: 200000,
    current_usage: { input_tokens: 42600, output_tokens: 8200, cache_creation_input_tokens: 3200, cache_read_input_tokens: 18600 },
  },
  rate_limits: {
    five_hour: { used_percentage: 38 },
    seven_day: { used_percentage: 54 },
    seven_day_sonnet: { used_percentage: 22 },
    seven_day_opus: { used_percentage: 61 },
  },
  vim: { mode: "NORMAL" },
  worktree: { name: "feature-statusline", branch: "feature/statusline", original_branch: "master" },
  preview_git: { branch: "feature/statusline", staged: 2, unstaged: 4, untracked: 1, conflicts: 0, root_dir: "example-project", sha: "7ac91e2" },
};
