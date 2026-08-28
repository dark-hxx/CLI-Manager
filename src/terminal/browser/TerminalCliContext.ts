import type { Project, TerminalSession } from "../../lib/types";

const CODEX_COMMAND_PATTERN = /(?:^|\s)codex(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i;
const CLAUDE_COMMAND_PATTERN = /(?:^|\s)claude(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i;
const PI_COMMAND_PATTERN = /^\s*(?:&\s*)?pi(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i;
const OPENCODE_TOOL_VALUES = new Set(["opencode", "opencode.cmd", "opencode.exe", "opencode.ps1"]);
const OPENCODE_COMMAND_PATTERN = /^opencode(?:\.(?:cmd|exe|ps1))?$/i;
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const PI_OUTPUT_SIGNATURE_PATTERN = /(?:Pi can explain its own features|\bpi\s+v\d+\.\d+\.\d+\b)/i;

export interface TerminalCliContext {
  projectTool: string;
  sessionTool: string;
  startupCmd: string;
  titleTool: string;
  outputHint: string;
}


function commandExecutableToken(command: string): string {
  const trimmed = command.trim().replace(/^&\s*/, "");
  if (!trimmed) return "";
  const match = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
}

const isOpenCodeToolValue = (value: string): boolean => (
  OPENCODE_TOOL_VALUES.has(value.trim().toLowerCase())
);

const hasPiOutputSignature = (text: string): boolean => {
  CSI_PATTERN.lastIndex = 0;
  return PI_OUTPUT_SIGNATURE_PATTERN.test(text.replace(CSI_PATTERN, ""));
};

export const createTerminalCliContext = (
  session: TerminalSession | null | undefined,
  project: Project | null | undefined,
): TerminalCliContext => ({
  projectTool: project?.cli_tool.trim().toLowerCase() ?? "",
  sessionTool: session?.cliTool?.trim().toLowerCase() ?? "",
  startupCmd: session?.startupCmd ?? "",
  titleTool: session?.title.match(/\(([^()]*)\)\s*$/)?.[1]?.trim().toLowerCase() ?? "",
  outputHint: session?.initialTerminalOutput ?? "",
});

export const isCodexTerminalContext = ({
  projectTool,
  sessionTool,
  startupCmd,
  titleTool,
}: TerminalCliContext): boolean => (
  sessionTool === "codex"
  || projectTool === "codex"
  || titleTool === "codex"
  || CODEX_COMMAND_PATTERN.test(startupCmd)
);

export const isClaudeTerminalContext = ({
  projectTool,
  startupCmd,
  titleTool,
}: TerminalCliContext): boolean => (
  projectTool.includes("claude")
  || titleTool.includes("claude")
  || CLAUDE_COMMAND_PATTERN.test(startupCmd)
);

export const isClaudeOrCodexTerminalContext = (context: TerminalCliContext): boolean => (
  isCodexTerminalContext(context) || isClaudeTerminalContext(context)
);

export const isPiTerminalContext = ({
  projectTool,
  sessionTool,
  startupCmd,
  titleTool,
  outputHint = "",
}: TerminalCliContext): boolean => (
  sessionTool === "pi"
  || projectTool === "pi"
  || titleTool === "pi"
  || PI_COMMAND_PATTERN.test(startupCmd)
  || hasPiOutputSignature(outputHint)
);

export const containsPiOutputSignature = hasPiOutputSignature;
export const isOpenCodeTerminalContext = ({
  projectTool,
  sessionTool,
  startupCmd,
}: TerminalCliContext): boolean => {
  // Persisted session classification is authoritative. Project classification
  // is the next fallback; only unclassified sessions inspect the executable.
  if (sessionTool) return isOpenCodeToolValue(sessionTool);
  if (projectTool) return isOpenCodeToolValue(projectTool);
  return OPENCODE_COMMAND_PATTERN.test(commandExecutableToken(startupCmd));
};
