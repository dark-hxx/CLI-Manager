/**
 * 项目栏节点外观（issue #213）：分组 / 项目的颜色标记与图标标记解析。
 *
 * 这是外观解析的唯一实现，侧边栏、History 项目树、Stats 项目树共用。
 * 任何调用方都不得再自行实现 hash 或调色板映射，否则三处观感会漂移。
 *
 * 纯函数、无外部依赖（便于独立验证），可在 render 中直接调用。
 */

/** 调色板 token。实际颜色由 `components.css` 的 `--node-accent-pN` 按亮/暗主题分别给值。 */
export const NODE_ACCENT_TOKENS = [
  "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10",
] as const;

export type NodeAccentToken = (typeof NODE_ACCENT_TOKENS)[number];

/** 本地品牌标记：使用内置 SVG，选择后不受操作系统 Emoji 字体影响。 */
export const NODE_BRAND_ICON_DEFINITIONS = [
  {
    key: "brand-feishu",
    native: "🪽",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#3370ff"/><path d="M7 10.5c5.5-.5 10.1 1 13.8 4.4L25 10v5.2c0 5.1-3.6 9-8.5 9.9l-3.3.6 3.6-4.3c-3.2-3.4-6.1-6.9-9.8-10.9Z" fill="#fff"/></svg>',
  },
  {
    key: "brand-xiaohongshu",
    native: "📕",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#ff2442"/><path d="M9 8.5h9c3.3 0 5 1.5 5 4.1 0 1.6-.7 2.7-2 3.4 1.5.7 2.3 1.9 2.3 3.7 0 2.9-2 4.8-5.6 4.8H9V8.5Zm3.2 3v3.1H17c1.4 0 2.3-.6 2.3-1.6 0-1-.8-1.5-2.3-1.5h-4.8Zm0 6.1v3.8H18c1.5 0 2.5-.7 2.5-1.9s-1-1.9-2.5-1.9h-5.8Z" fill="#fff"/></svg>',
  },
  {
    key: "brand-bilibili",
    native: "📺",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#00aeec"/><path d="M8 12.2a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8.1a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3v-8.1Zm5.1-5.6 2.1 2.1m8.7-2.1-2.1 2.1M12 14.8v2.5m8-2.5v2.5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><path d="M14.2 20c1.1.8 2.5.8 3.6 0" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg>',
  },
] as const;

export type NodeBrandIconKey = (typeof NODE_BRAND_ICON_DEFINITIONS)[number]["key"];

export function isNodeBrandIconKey(value: string): value is NodeBrandIconKey {
  return NODE_BRAND_ICON_DEFINITIONS.some((definition) => definition.key === value);
}

export function nodeBrandIconSource(key: NodeBrandIconKey): string {
  const definition = NODE_BRAND_ICON_DEFINITIONS.find((item) => item.key === key);
  return definition ? `data:image/svg+xml,${encodeURIComponent(definition.svg)}` : "";
}

export interface NodeAppearance {
  /** 显式设置的调色板 token；空串表示未设置，走系统默认色。 */
  token: NodeAccentToken | "";
  /** 有显式颜色时喂给 `--node-accent` 的 CSS 值；未设置时为空串（不写该变量，样式回退系统色）。 */
  colorVar: string;
  /** 单字符标记（emoji 或非 ASCII 单字）。非空时优先于 `iconKey` 渲染。 */
  emoji: string;
  /** 内置图标 key。`emoji` 为空时使用；空串表示由渲染端按节点类型回退默认图标。 */
  iconKey: string;
  /** 是否设置了显式颜色。项目与分组行据此决定是否显示左侧色条。 */
  hasColor: boolean;
}

export interface NodeAppearanceInput {
  /** 数据库中的 `icon` 列，可能为空串或脏数据。 */
  icon?: string | null;
  /** 数据库中的 `color` 列，可能为空串或脏数据。 */
  color?: string | null;
}

export function isNodeAccentToken(value: unknown): value is NodeAccentToken {
  return typeof value === "string" && (NODE_ACCENT_TOKENS as readonly string[]).includes(value);
}

/**
 * 归一化颜色输入：合法 token 原样返回；其他一切（hex、空值、脏数据）都返回空串，
 * 交给自动配色兜底 —— 不抛错，避免同步来的脏数据把界面打挂。
 */
export function normalizeNodeAccentToken(value: unknown): NodeAccentToken | "" {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  return isNodeAccentToken(normalized) ? normalized : "";
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<unknown>;
}

type GraphemeSegmenterCtor = new (
  locales?: string,
  options?: { granularity?: "grapheme" }
) => GraphemeSegmenter;

let segmenterCache: GraphemeSegmenter | null | undefined;

/** `Intl.Segmenter` 未进 tsconfig 的 ES2020 lib，这里按运行时能力探测，缺失时降级到码点计数。 */
function getGraphemeSegmenter(): GraphemeSegmenter | null {
  if (segmenterCache !== undefined) return segmenterCache;
  const ctor = (Intl as unknown as { Segmenter?: GraphemeSegmenterCtor }).Segmenter;
  segmenterCache = ctor ? new ctor(undefined, { granularity: "grapheme" }) : null;
  return segmenterCache;
}

function graphemeCount(value: string): number {
  const segmenter = getGraphemeSegmenter();
  if (!segmenter) return Array.from(value).length;
  let count = 0;
  for (const _segment of segmenter.segment(value)) {
    void _segment;
    count += 1;
    if (count > 1) break;
  }
  return count;
}

const ASCII_PRINTABLE_ONLY = /^[\x20-\x7E]+$/;

/**
 * 判定"单字符标记"：一个字形簇且不是纯 ASCII 可打印字符。
 * 这样 emoji、ZWJ 组合（👨‍👩‍👧）、带修饰符的 emoji、旗帜和 CJK 单字都算标记，
 * 而 `claude-code` 这类内置图标 key 不会被误判。
 */
export function isSingleCharMark(value: string): boolean {
  if (!value) return false;
  if (ASCII_PRINTABLE_ONLY.test(value)) return false;
  return graphemeCount(value) === 1;
}

/** 归一化图标输入：仅做 trim；具体是单字符标记还是内置图标 key 由 `resolveNodeAppearance` 分类。 */
export function normalizeNodeIcon(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function nodeAccentVar(token: NodeAccentToken): string {
  return `var(--node-accent-${token})`;
}

/**
 * 解析节点外观。
 *
 * 未设置颜色时**不做任何自动配色**：`colorVar` 返回空串，渲染端不写 `--node-accent`，
 * 图标因此回退到统一的系统色，行左侧也不显示色条。只有用户显式设过颜色才着色。
 */
export function resolveNodeAppearance(input: NodeAppearanceInput): NodeAppearance {
  const token = normalizeNodeAccentToken(input.color);
  const icon = normalizeNodeIcon(input.icon);
  const isMark = isSingleCharMark(icon);

  return {
    token,
    colorVar: token ? nodeAccentVar(token) : "",
    emoji: isMark ? icon : "",
    iconKey: isMark ? "" : icon,
    hasColor: token !== "",
  };
}
