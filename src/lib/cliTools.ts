import type { VendorKey } from "@/components/VendorIcon";
import type { HistorySourceId } from "./historySources";

export type CliToolIconKey =
  | "claude-code"
  | "codex"
  | "opencode"
  | "grok"
  | "qwen"
  | "gemini-cli"
  | "copilot"
  | "antigravity"
  | "cursor"
  | "kiro"
  | "cline"
  | "goose"
  | "amp"
  | "aider"
  | "crush"
  | "pi";

export interface CliToolDescriptor {
  id: string;
  command: string;
  label: string;
  icon: CliToolIconKey;
  vendor: VendorKey | null;
  historySourceId?: HistorySourceId;
}

export const CLI_TOOL_DESCRIPTORS: readonly CliToolDescriptor[] = [
  {
    id: "claude",
    command: "claude",
    label: "Claude Code",
    icon: "claude-code",
    vendor: "claude",
    historySourceId: "claude",
  },
  {
    id: "codex",
    command: "codex",
    label: "Codex CLI",
    icon: "codex",
    vendor: "openai",
    historySourceId: "codex",
  },
  {
    id: "opencode",
    command: "opencode",
    label: "OpenCode",
    icon: "opencode",
    vendor: null,
    historySourceId: "opencode",
  },
  {
    id: "grok",
    command: "grok",
    label: "Grok Build",
    icon: "grok",
    vendor: "grok",
    historySourceId: "grok",
  },
  {
    id: "qwen",
    command: "qwen",
    label: "Qwen Code",
    icon: "qwen",
    vendor: "qwen",
  },
  {
    id: "gemini",
    command: "gemini",
    label: "Gemini CLI",
    icon: "gemini-cli",
    vendor: "gemini",
    historySourceId: "gemini",
  },
  {
    id: "copilot",
    command: "copilot",
    label: "GitHub Copilot CLI",
    icon: "copilot",
    vendor: null,
    historySourceId: "copilot",
  },
  {
    id: "cline",
    command: "cline",
    label: "Cline CLI",
    icon: "cline",
    vendor: null,
    historySourceId: "cline",
  },
  {
    id: "goose",
    command: "goose",
    label: "Goose CLI",
    icon: "goose",
    vendor: null,
  },
  {
    id: "amp",
    command: "amp",
    label: "Amp",
    icon: "amp",
    vendor: null,
  },
  {
    id: "aider",
    command: "aider",
    label: "Aider",
    icon: "aider",
    vendor: null,
  },
  {
    id: "crush",
    command: "crush",
    label: "Crush",
    icon: "crush",
    vendor: null,
  },
  {
    id: "pi",
    command: "pi",
    label: "Pi Coding Agent",
    icon: "pi",
    vendor: null,
    historySourceId: "pi",
  },
];

export const CLI_TOOL_COMMANDS = CLI_TOOL_DESCRIPTORS.map((tool) => tool.command);

const HISTORY_SOURCE_ICON_KEYS: Partial<Record<HistorySourceId, CliToolIconKey>> = {
  claude: "claude-code",
  codex: "codex",
  gemini: "gemini-cli",
  copilot: "copilot",
  antigravity: "antigravity",
  grok: "grok",
  pi: "pi",
  opencode: "opencode",
  kiro: "kiro",
  cursor: "cursor",
  cline: "cline",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandMatches(cliTool: string, command: string): boolean {
  const root = command.trim().split(/\s+/)[0];
  if (!root) return false;
  if (command.includes(" ") && cliTool.includes(command)) return true;
  return new RegExp(`(^|[\\s"'&;|()])${escapeRegExp(root)}($|[\\s"'&;|()])`, "i").test(cliTool);
}

export function resolveHistorySourceIconKey(source: string | null | undefined): CliToolIconKey | null {
  const normalized = source?.trim().toLowerCase() as HistorySourceId | undefined;
  return normalized ? HISTORY_SOURCE_ICON_KEYS[normalized] ?? null : null;
}

export function resolveCliToolIconKey(cliTool: string | null | undefined): CliToolIconKey | null {
  const normalized = cliTool?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "code") return "codex";

  const descriptor = CLI_TOOL_DESCRIPTORS.find(
    (tool) => tool.id === normalized || tool.command === normalized || commandMatches(normalized, tool.command)
  );
  if (descriptor) return descriptor.icon;

  return (
    resolveHistorySourceIconKey(normalized) ??
    (normalized.includes("claude") ? "claude-code" : null) ??
    (normalized.includes("codex") ? "codex" : null) ??
    (normalized.includes("cursor") ? "cursor" : null) ??
    (normalized.includes("kiro") ? "kiro" : null) ??
    (normalized.includes("antigravity") ? "antigravity" : null) ??
    (normalized.includes("grok") ? "grok" : null) ??
    (normalized.includes("qwen") ? "qwen" : null)
  );
}

export function resolveCliToolHistorySourceId(cliTool: string | null | undefined): HistorySourceId | null {
  const normalized = cliTool?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "code") return "codex";

  const descriptor = CLI_TOOL_DESCRIPTORS.find(
    (tool) => tool.command === normalized || tool.id === normalized
  );
  if (descriptor?.historySourceId) return descriptor.historySourceId;
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("grok")) return "grok";
  return null;
}
