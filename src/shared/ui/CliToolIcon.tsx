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
import KimiColor from "@lobehub/icons/es/Kimi/components/Color";
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
  kimi: KimiColor,
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

export function CliToolIcon({
  icon,
  size = 16,
  className = "text-text-primary",
}: {
  icon: CliToolIconKey;
  size?: number;
  className?: string;
}) {
  const Icon = CLI_TOOL_ICONS[icon];
  return <Icon size={size} className={className} />;
}

/**
 * 判定字符串是否为内置 CLI 工具图标 key。
 * 直接查 `CLI_TOOL_ICONS`（类型为 `Record<CliToolIconKey, ...>`，编译期保证覆盖完整），
 * 避免另维护一份 key 清单导致漂移。
 */
export function isCliToolIconKey(value: string): value is CliToolIconKey {
  return Object.prototype.hasOwnProperty.call(CLI_TOOL_ICONS, value);
}
