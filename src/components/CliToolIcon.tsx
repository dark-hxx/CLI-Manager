import type { ComponentType } from "react";
import AmpColor from "@lobehub/icons/es/Amp/components/Color";
import AntigravityColor from "@lobehub/icons/es/Antigravity/components/Color";
import ClaudeColor from "@lobehub/icons/es/Claude/components/Color";
import ClineMono from "@lobehub/icons/es/Cline/components/Mono";
import CopilotColor from "@lobehub/icons/es/Copilot/components/Color";
import CursorMono from "@lobehub/icons/es/Cursor/components/Mono";
import GeminiCliColor from "@lobehub/icons/es/GeminiCLI/components/Color";
import GooseMono from "@lobehub/icons/es/Goose/components/Mono";
import GrokMono from "@lobehub/icons/es/Grok/components/Mono";
import KiroColor from "@lobehub/icons/es/Kiro/components/Color";
import OpenCodeMono from "@lobehub/icons/es/OpenCode/components/Mono";
import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono";
import QwenColor from "@lobehub/icons/es/Qwen/components/Color";
import { Bot, Heart, Pi } from "lucide-react";
import type { CliToolIconKey } from "../lib/cliTools";

type IconComponent = ComponentType<{
  size?: string | number;
  className?: string;
}>;

const CLI_TOOL_ICONS: Record<CliToolIconKey, IconComponent> = {
  "claude-code": ClaudeColor,
  codex: OpenAI,
  opencode: OpenCodeMono,
  grok: GrokMono,
  qwen: QwenColor,
  "gemini-cli": GeminiCliColor,
  copilot: CopilotColor,
  antigravity: AntigravityColor,
  cursor: CursorMono,
  kiro: KiroColor,
  cline: ClineMono,
  goose: GooseMono,
  amp: AmpColor,
  aider: Bot,
  crush: Heart,
  pi: Pi,
};

export function CliToolIcon({ icon, size = 16 }: { icon: CliToolIconKey; size?: number }) {
  const Icon = CLI_TOOL_ICONS[icon];
  return <Icon size={size} className="text-text-primary" />;
}
