import { isDeepSeekTuiTool } from "./deepseekTui";
import type { VendorKey } from "../ui/VendorIcon";
import type { HistorySourceId } from "./historySources";

export type CliToolIconKey =
  | "claude-code"
  | "codex"
  | "opencode"
  | "kimi"
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
  | "pi"
  | "deepseek-harness"
  | "zcode";

export interface CliToolDescriptor {
  id: string;
  command: string;
  label: string;
  icon: CliToolIconKey;
  vendor: VendorKey | null;
  historySourceId?: HistorySourceId;
  imagePasteMode?: ImagePasteMode;
}

export type ImagePasteMode = "native" | "at" | "aider" | "unsupported";

export const CLI_TOOL_DESCRIPTORS: readonly CliToolDescriptor[] = [
  {
    id: "deepseek-harness",
    command: "dsh-tui",
    label: "DeepSeek Harness TUI",
    icon: "deepseek-harness",
    vendor: "deepseek",
    imagePasteMode: "unsupported",
  },
  {
    id: "claude",
    command: "claude",
    label: "Claude Code",
    icon: "claude-code",
    vendor: "claude",
    historySourceId: "claude",
    imagePasteMode: "native",
  },
  {
    id: "codex",
    command: "codex",
    label: "Codex CLI",
    icon: "codex",
    vendor: "openai",
    historySourceId: "codex",
    imagePasteMode: "native",
  },
  {
    id: "opencode",
    command: "opencode",
    label: "OpenCode",
    icon: "opencode",
    vendor: null,
    historySourceId: "opencode",
    imagePasteMode: "at",
  },
  {
    id: "kimi",
    command: "kimi",
    label: "Kimi",
    icon: "kimi",
    vendor: "kimi",
    historySourceId: "kimi",
    imagePasteMode: "at",
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
    imagePasteMode: "at",
  },
  {
    id: "agy",
    command: "agy",
    label: "Antigravity CLI",
    icon: "antigravity",
    vendor: null,
    historySourceId: "antigravity",
    imagePasteMode: "unsupported",
  },
  {
    id: "gemini",
    command: "gemini",
    label: "Gemini CLI",
    icon: "gemini-cli",
    vendor: "gemini",
    historySourceId: "gemini",
    imagePasteMode: "at",
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
    imagePasteMode: "aider",
  },
  {
    id: "crush",
    command: "crush",
    label: "Crush",
    icon: "crush",
    vendor: null,
    imagePasteMode: "at",
  },
  {
    id: "pi",
    command: "pi",
    label: "Pi Coding Agent",
    icon: "pi",
    vendor: null,
    imagePasteMode: "at",
    historySourceId: "pi",
  },
  {
    id: "zcode",
    command: "zcode",
    label: "ZCode",
    icon: "zcode",
    vendor: "zhipu",
    imagePasteMode: "unsupported",
  },
];

export const CLI_TOOL_COMMANDS = CLI_TOOL_DESCRIPTORS.map((tool) => tool.command);

export const PROJECT_CLI_TOOL_PRIORITY = ["claude", "codex", "pi", "agy", "grok", "dsh-tui"] as const;
export const HIDDEN_PROJECT_CLI_TOOLS = new Set(["goose", "amp", "aider", "crush"]);

export const PROJECT_CLI_TOOL_OPTIONS: readonly CliToolDescriptor[] = CLI_TOOL_DESCRIPTORS
  .filter((tool) => !HIDDEN_PROJECT_CLI_TOOLS.has(tool.command))
  .sort((left, right) => {
    const leftIndex = PROJECT_CLI_TOOL_PRIORITY.indexOf(left.command as (typeof PROJECT_CLI_TOOL_PRIORITY)[number]);
    const rightIndex = PROJECT_CLI_TOOL_PRIORITY.indexOf(right.command as (typeof PROJECT_CLI_TOOL_PRIORITY)[number]);
    return (leftIndex < 0 ? PROJECT_CLI_TOOL_PRIORITY.length : leftIndex)
      - (rightIndex < 0 ? PROJECT_CLI_TOOL_PRIORITY.length : rightIndex);
  });

export function resolveCliToolDescriptor(cliTool: string | null | undefined): CliToolDescriptor | null {
  const normalized = cliTool?.trim().toLowerCase();
  if (!normalized) return null;
  if (isAgyCommand(normalized)) {
    return CLI_TOOL_DESCRIPTORS.find((tool) => tool.id === "agy") ?? null;
  }
  if (normalized === "code") {
    return CLI_TOOL_DESCRIPTORS.find((tool) => tool.id === "codex") ?? null;
  }
  if (isDeepSeekTuiTool(normalized)) {
    return CLI_TOOL_DESCRIPTORS.find((tool) => tool.id === "deepseek-harness") ?? null;
  }
  const exact = CLI_TOOL_DESCRIPTORS.find(
    (tool) => tool.id === normalized || tool.command.toLowerCase() === normalized,
  );
  if (exact) return exact;
  return CLI_TOOL_DESCRIPTORS.find((tool) => commandMatches(normalized, tool.command)) ?? null;
}

export function resolveProxyAgentId(
  cliTool: string | null | undefined,
  startupCmd?: string | null,
): string | null {
  const trimmedCliTool = cliTool?.trim();
  if (trimmedCliTool) {
    return resolveCliToolDescriptor(trimmedCliTool)?.id ?? null;
  }
  const trimmedStartupCmd = startupCmd?.trim();
  if (trimmedStartupCmd) {
    return resolveCliToolDescriptor(trimmedStartupCmd)?.id ?? null;
  }
  return null;
}

export function resolveCliToolImagePasteMode(cliTool: string | null | undefined): ImagePasteMode {
  const normalized = cliTool?.trim().toLowerCase() ?? "";
  if (!normalized || isAgyCommand(normalized)) return "unsupported";
  const descriptor = CLI_TOOL_DESCRIPTORS.find(
    (tool) => tool.id === normalized || tool.command === normalized || commandMatches(normalized, tool.command),
  );
  if (descriptor?.imagePasteMode) return descriptor.imagePasteMode;
  if (normalized.includes("claude") || normalized.includes("codex")) return "native";
  return "unsupported";
}

const HISTORY_SOURCE_ICON_KEYS: Partial<Record<HistorySourceId, CliToolIconKey>> = {
  claude: "claude-code",
  codex: "codex",
  gemini: "gemini-cli",
  copilot: "copilot",
  antigravity: "antigravity",
  grok: "grok",
  kimi: "kimi",
  pi: "pi",
  opencode: "opencode",
  kiro: "kiro",
  cursor: "cursor",
  cline: "cline",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Read only the first executable, including PowerShell's invocation operator. A prompt,
// alias, pipeline wrapper or expandable shell expression is not an agy launcher.
export function matchAgyLauncher(command?: string | null): { path: string; raw: string } | null {
  const first = command?.trim().match(/^(?:&[ \t]+)?(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))(?=\s|$)/);
  const path = first?.[1] ?? first?.[2] ?? first?.[3];
  if (!path || /["';&|<>`$%!^*?()[\]{}\x00-\x1f]/.test(path)) return null;
  return first && /(?:^|[\\/])agy(?:\.(?:exe|cmd|bat|ps1))?$/i.test(path) ? { path, raw: first[0] } : null;
}

export function isAgyCommand(command?: string | null): boolean {
  return matchAgyLauncher(command) !== null;
}

function commandMatches(cliTool: string, command: string): boolean {
  if (command === "agy") return isAgyCommand(cliTool);
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
  if (isAgyCommand(normalized)) return "antigravity";
  if (normalized === "code") return "codex";
  if (isDeepSeekTuiTool(normalized)) return "deepseek-harness";

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
    (normalized.includes("grok") ? "grok" : null) ??
    (normalized.includes("kimi") ? "kimi" : null) ??
    (normalized.includes("qwen") ? "qwen" : null)
  );
}

export function resolveCliToolHistorySourceId(cliTool: string | null | undefined): HistorySourceId | null {
  const normalized = cliTool?.trim().toLowerCase();
  if (!normalized) return null;
  if (isAgyCommand(normalized)) return "antigravity";
  if (normalized === "code") return "codex";

  const descriptor = CLI_TOOL_DESCRIPTORS.find(
    (tool) => tool.command === normalized || tool.id === normalized
  );
  if (descriptor?.historySourceId) return descriptor.historySourceId;
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("grok")) return "grok";
  if (normalized.includes("kimi")) return "kimi";
  return null;
}
