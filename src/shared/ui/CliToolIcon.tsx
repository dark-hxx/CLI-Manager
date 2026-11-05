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
import KimiMono from "@lobehub/icons/es/Kimi/components/Mono";
import KiroColor from "@lobehub/icons/es/Kiro/components/Color";
import OpenCodeMono from "@lobehub/icons/es/OpenCode/components/Mono";
import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono";
import QwenColor from "@lobehub/icons/es/Qwen/components/Color";
import ZhipuColor from "@lobehub/icons/es/Zhipu/components/Color";
import { Bot, Heart, Pi } from "lucide-react";
import DeepSeekColor from "@lobehub/icons/es/DeepSeek/components/Color";
import type { CliToolIconKey } from "../lib/cliTools";

type IconComponent = ComponentType<{
  size?: string | number;
  className?: string;
}>;

const CLI_TOOL_ICONS: Record<CliToolIconKey, IconComponent> = {
  "claude-code": ClaudeColor,
  codex: OpenAI,
  opencode: OpenCodeMono,
  kimi: KimiMono,
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
  "deepseek-harness": DeepSeekColor,
  zcode: ZhipuColor,
};

/**
 * 品牌 Logo 安全区：与 `homeIcons` 的设计稿图形保持一致，在 24 栅格中占 18，
 * 四周各留 3。Logo 原画布几乎铺满 24，需要统一收进安全区后才与文件夹/终端同视觉尺寸。
 */
const LOGO_SAFE_AREA = 18;
const LOGO_INSET = (24 - LOGO_SAFE_AREA) / 2;

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
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <svg x={LOGO_INSET} y={LOGO_INSET} width={LOGO_SAFE_AREA} height={LOGO_SAFE_AREA}>
        <Icon size="100%" className={className} />
      </svg>
    </svg>
  );
}

/**
 * 判定字符串是否为内置 CLI 工具图标 key。
 * 直接查 `CLI_TOOL_ICONS`（类型为 `Record<CliToolIconKey, ...>`，编译期保证覆盖完整），
 * 避免另维护一份 key 清单导致漂移。
 */
export function isCliToolIconKey(value: string): value is CliToolIconKey {
  return Object.prototype.hasOwnProperty.call(CLI_TOOL_ICONS, value);
}
