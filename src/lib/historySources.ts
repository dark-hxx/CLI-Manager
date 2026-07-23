import type { TranslationKey } from "./i18n";

export type HistorySourceId =
  | "claude"
  | "codex"
  | "gemini"
  | "copilot"
  | "antigravity"
  | "grok"
  | "pi"
  | "opencode"
  | "kiro"
  | "cursor"
  | "cline";

export type HistoryCapabilityState = "supported" | "planned" | "unsupported";
export type HistoryParserStage = "native" | "research" | "planned";
export type HistoryParserBatch =
  | "core"
  | "batch-1"
  | "batch-2"
  | "batch-3"
  | "batch-4";
export type HistoryLocationPurpose = "config" | "content" | "state";
export type HistoryLocationKind = "directory" | "database";
export type HistorySourceEnvironment =
  | { kind: "windows" }
  | { kind: "wsl"; distro: string }
  | { kind: "macos" }
  | { kind: "linux" };

export interface HistoryLocationSlot {
  id: string;
  labelKey: TranslationKey;
  defaultLabel: string;
  purpose: HistoryLocationPurpose;
  kind: HistoryLocationKind;
  required: boolean;
}

export interface HistorySourceCapabilities {
  list: HistoryCapabilityState;
  search: HistoryCapabilityState;
  stats: HistoryCapabilityState;
  usage: HistoryCapabilityState;
  rawOpen: HistoryCapabilityState;
  resume: HistoryCapabilityState;
  appOpen: HistoryCapabilityState;
  edit: HistoryCapabilityState;
  delete: HistoryCapabilityState;
  convertFrom: HistoryCapabilityState;
  convertTo: HistoryCapabilityState;
  realtimeStats: HistoryCapabilityState;
}

export interface HistorySourceDescriptor {
  id: HistorySourceId;
  labelKey: TranslationKey;
  defaultLabel: string;
  shortLabel?: string;
  aliases?: string[];
  locations: HistoryLocationSlot[];
  capabilities: HistorySourceCapabilities;
  parserPlan: {
    stage: HistoryParserStage;
    batch: HistoryParserBatch;
    writer: HistoryCapabilityState;
    note: string;
  };
}

export interface HistorySourceInstanceSettings {
  id: string;
  environment: HistorySourceEnvironment;
  locations: Record<string, string>;
}

export interface HistorySourceSettings {
  enabled: boolean;
  activeInstance?: HistorySourceInstanceSettings;
}

export type HistorySourceSettingsMap = Partial<Record<HistorySourceId, HistorySourceSettings>>;

const unsupportedMutationCapabilities = {
  edit: "planned",
  delete: "planned",
  convertTo: "planned",
} satisfies Pick<HistorySourceCapabilities, "edit" | "delete" | "convertTo">;

const fileReaderCapabilities: HistorySourceCapabilities = {
  list: "planned",
  search: "planned",
  stats: "planned",
  usage: "planned",
  rawOpen: "planned",
  resume: "planned",
  appOpen: "planned",
  convertFrom: "planned",
  realtimeStats: "unsupported",
  ...unsupportedMutationCapabilities,
};

const supportedClaudeCodexCapabilities: HistorySourceCapabilities = {
  list: "supported",
  search: "supported",
  stats: "supported",
  usage: "supported",
  rawOpen: "supported",
  resume: "supported",
  appOpen: "planned",
  edit: "planned",
  delete: "planned",
  convertFrom: "supported",
  convertTo: "supported",
  realtimeStats: "supported",
};

const jsonReaderCapabilities: HistorySourceCapabilities = {
  ...fileReaderCapabilities,
  list: "supported",
  search: "supported",
  stats: "supported",
  rawOpen: "supported",
  resume: "unsupported",
};

const readonlyDatabaseCapabilities: HistorySourceCapabilities = {
  ...fileReaderCapabilities,
  list: "supported",
  search: "supported",
  stats: "supported",
  usage: "supported",
  resume: "unsupported",
  rawOpen: "planned",
};

const configRootSlot: HistoryLocationSlot = {
  id: "configRoot",
  labelKey: "historySources.location.configRoot",
  defaultLabel: "Config root",
  purpose: "config",
  kind: "directory",
  required: true,
};

const sessionRootSlot: HistoryLocationSlot = {
  id: "sessionRoot",
  labelKey: "historySources.location.sessionRoot",
  defaultLabel: "Session root",
  purpose: "content",
  kind: "directory",
  required: true,
};

const sessionDbSlot: HistoryLocationSlot = {
  id: "sessionDb",
  labelKey: "historySources.location.sessionDb",
  defaultLabel: "Session database",
  purpose: "state",
  kind: "database",
  required: true,
};

export const HISTORY_SOURCE_DESCRIPTORS: readonly HistorySourceDescriptor[] = [
  {
    id: "claude",
    labelKey: "historySources.source.claude",
    defaultLabel: "Claude Code",
    aliases: ["claude-code"],
    locations: [configRootSlot],
    capabilities: supportedClaudeCodexCapabilities,
    parserPlan: {
      stage: "native",
      batch: "core",
      writer: "supported",
      note: "Existing parser and writer; v2 index uses shadow build before read-path switch.",
    },
  },
  {
    id: "codex",
    labelKey: "historySources.source.codex",
    defaultLabel: "Codex CLI",
    locations: [configRootSlot],
    capabilities: supportedClaudeCodexCapabilities,
    parserPlan: {
      stage: "native",
      batch: "core",
      writer: "supported",
      note: "Existing parser and writer; target writer must keep rollout/history/session index/state DB consistent.",
    },
  },
  {
    id: "gemini",
    labelKey: "historySources.source.gemini",
    defaultLabel: "Gemini CLI",
    locations: [configRootSlot],
    capabilities: jsonReaderCapabilities,
    parserPlan: {
      stage: "native",
      batch: "batch-1",
      writer: "planned",
      note: "Read-only JSON parser for ~/.gemini/tmp/*/chats/session-*.json.",
    },
  },
  {
    id: "copilot",
    labelKey: "historySources.source.copilot",
    defaultLabel: "GitHub Copilot CLI",
    aliases: ["copilot-cli"],
    locations: [sessionRootSlot],
    capabilities: jsonReaderCapabilities,
    parserPlan: {
      stage: "native",
      batch: "batch-1",
      writer: "planned",
      note: "Read-only JSONL parser for ~/.copilot/session-state/*/events.jsonl.",
    },
  },
  {
    id: "antigravity",
    labelKey: "historySources.source.antigravity",
    defaultLabel: "Antigravity",
    locations: [configRootSlot],
    capabilities: jsonReaderCapabilities,
    parserPlan: {
      stage: "native",
      batch: "batch-2",
      writer: "planned",
      note: "Read-only JSONL parser for ~/.gemini/antigravity[-cli]/brain/* transcripts.",
    },
  },
  {
    id: "grok",
    labelKey: "historySources.source.grok",
    defaultLabel: "Grok Build",
    locations: [sessionRootSlot],
    capabilities: {
      ...jsonReaderCapabilities,
      usage: "supported",
      resume: "supported",
      realtimeStats: "supported",
    },
    parserPlan: {
      stage: "native",
      batch: "batch-3",
      writer: "planned",
      note: "Read-only parser for ~/.grok/sessions/*/*/updates.jsonl with summary.json metadata; resume via grok --resume / --continue; realtime stats via hook session bind.",
    },
  },
  {
    id: "pi",
    labelKey: "historySources.source.pi",
    defaultLabel: "Pi",
    locations: [sessionRootSlot],
    capabilities: jsonReaderCapabilities,
    parserPlan: {
      stage: "native",
      batch: "batch-3",
      writer: "planned",
      note: "Read-only parser for ~/.pi/agent/sessions/**/*.jsonl session files.",
    },
  },
  {
    id: "opencode",
    labelKey: "historySources.source.opencode",
    defaultLabel: "OpenCode",
    locations: [sessionDbSlot],
    capabilities: readonlyDatabaseCapabilities,
    parserPlan: {
      stage: "native",
      batch: "batch-2",
      writer: "planned",
      note: "Read-only SQLite parser for ~/.local/share/opencode/opencode.db.",
    },
  },
  {
    id: "kiro",
    labelKey: "historySources.source.kiro",
    defaultLabel: "Kiro",
    aliases: ["kiro-cli"],
    locations: [sessionRootSlot],
    capabilities: jsonReaderCapabilities,
    parserPlan: {
      stage: "native",
      batch: "batch-1",
      writer: "planned",
      note: "Read-only JSON workspace-session parser under Kiro globalStorage.",
    },
  },
  {
    id: "cursor",
    labelKey: "historySources.source.cursor",
    defaultLabel: "Cursor",
    locations: [sessionRootSlot],
    capabilities: jsonReaderCapabilities,
    parserPlan: {
      stage: "native",
      batch: "batch-4",
      writer: "planned",
      note: "Read-only parser for ~/.cursor/projects/*/agent-transcripts/*/*.jsonl.",
    },
  },
  {
    id: "cline",
    labelKey: "historySources.source.cline",
    defaultLabel: "Cline",
    locations: [sessionRootSlot],
    capabilities: jsonReaderCapabilities,
    parserPlan: {
      stage: "native",
      batch: "batch-3",
      writer: "planned",
      note: "Read-only parser for Cline task api_conversation_history.json plus sibling metadata.",
    },
  },
];

export const HISTORY_SOURCE_DESCRIPTOR_BY_ID = new Map(
  HISTORY_SOURCE_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor])
);

export function createHistorySourceInstanceId(sourceId: HistorySourceId): string {
  return `${sourceId}-${crypto.randomUUID().slice(0, 8)}`;
}

export function inferHistorySourceEnvironment(path: string): HistorySourceEnvironment {
  const trimmed = path.trim();
  const wslMatch = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\/i.exec(trimmed);
  if (wslMatch?.[1]) return { kind: "wsl", distro: wslMatch[1] };
  return { kind: "windows" };
}
