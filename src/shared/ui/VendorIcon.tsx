import type { ComponentType } from "react";
import ClaudeColor from "@lobehub/icons/es/Claude/components/Color";
import DeepSeekColor from "@lobehub/icons/es/DeepSeek/components/Color";
import GeminiColor from "@lobehub/icons/es/Gemini/components/Color";
import Grok from "@lobehub/icons/es/Grok/components/Mono";
import KimiColor from "@lobehub/icons/es/Kimi/components/Color";
import MetaColor from "@lobehub/icons/es/Meta/components/Color";
import MistralColor from "@lobehub/icons/es/Mistral/components/Color";
import Ollama from "@lobehub/icons/es/Ollama/components/Mono";
import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono";
import OpenRouter from "@lobehub/icons/es/OpenRouter/components/Mono";
import QwenColor from "@lobehub/icons/es/Qwen/components/Color";
import ZhipuColor from "@lobehub/icons/es/Zhipu/components/Color";
import type { LucideIcon } from "lucide-react";

/**
 * 厂商品牌图标。
 *
 * 仅使用 @lobehub/icons 的 `.Color`（纯 SVG，不依赖 antd 运行时上下文）；
 * 刻意不使用 `.Avatar`（其内部依赖 @lobehub/ui + antd-style，需 antd ConfigProvider）。
 * 未知厂商回退到传入的 lucide 图标（弱化为 muted 色）。
 */
export type VendorKey =
  | "claude"
  | "openai"
  | "gemini"
  | "deepseek"
  | "qwen"
  | "kimi"
  | "zhipu"
  | "mistral"
  | "grok"
  | "meta"
  | "ollama"
  | "openrouter";

type BrandColorIcon = ComponentType<{ size?: number | string; className?: string }>;

// 有彩色 logo 的厂商用 `.Color`；本身是单色 logo 的（OpenAI / Grok / Ollama / OpenRouter）
// 用基础组件，由 currentColor 上色（调用处给 --on-surface）。
const VENDOR_ICON: Record<VendorKey, BrandColorIcon> = {
  claude: ClaudeColor,
  openai: OpenAI,
  gemini: GeminiColor,
  deepseek: DeepSeekColor,
  qwen: QwenColor,
  kimi: KimiColor,
  zhipu: ZhipuColor,
  mistral: MistralColor,
  grok: Grok,
  meta: MetaColor,
  ollama: Ollama,
  openrouter: OpenRouter,
};

/** 根据模型 ID / baseUrl / appType / 名称等文本推断所属厂商。 */
export function inferVendor(raw: string | null | undefined): VendorKey | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => s.includes(k));

  if (has("claude", "anthropic")) return "claude";
  if (has("deepseek")) return "deepseek";
  if (has("qwen", "tongyi", "dashscope", "bailian", "qwq")) return "qwen";
  if (has("kimi", "moonshot")) return "kimi";
  if (has("glm", "zhipu", "bigmodel")) return "zhipu";
  if (has("mistral", "mixtral", "codestral", "magistral", "devstral", "ministral")) return "mistral";
  if (has("grok", "x.ai", "xai")) return "grok";
  if (has("gemini", "palm", "bison", "gemma")) return "gemini";
  if (has("llama", "codellama")) return "meta";
  if (has("ollama")) return "ollama";
  if (has("openrouter")) return "openrouter";
  if (has("gpt", "openai", "codex", "chatgpt", "davinci", "dall-e", "whisper")) return "openai";
  // o1 / o3 / o4 系列（避免误伤普通含 o1 的串，要求前后非字母数字）
  if (/(^|[^a-z0-9])o[1-4]([^a-z0-9]|$)/.test(s)) return "openai";
  if (has("google")) return "gemini";
  if (has("meta")) return "meta";
  return null;
}

export function VendorIcon({
  vendor,
  size = 20,
  fallback: Fallback,
}: {
  vendor: VendorKey | null;
  size?: number;
  fallback?: LucideIcon;
}) {
  if (vendor) {
    const Icon = VENDOR_ICON[vendor];
    return <Icon size={size} />;
  }
  if (Fallback) {
    return <Fallback size={Math.round(size * 0.85)} style={{ color: "var(--text-muted)" }} />;
  }
  return null;
}
