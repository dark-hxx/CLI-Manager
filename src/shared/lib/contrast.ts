/**
 * WCAG 相对亮度 / 对比度计算工具。
 *
 * 供 App.tsx（决定是否应用自定义应用字体颜色）与设置页（对比度反馈提示）共享，
 * 保证两处判断口径一致。
 */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/**
 * 应用下限：仅拦截「自定义颜色与背景几乎同色」导致界面文字不可见的自锁风险。
 * 低于该比值时不应用自定义颜色。
 */
export const MIN_APPLY_CONTRAST_RATIO = 1.6;

/** 建议可读阈值（WCAG AA 正文标准）：低于该比值仍会应用，但提示可能影响可读性。 */
export const MIN_READABLE_CONTRAST_RATIO = 4.5;

export function parseHexColor(value: string): RgbColor | null {
  const match = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match) return null;

  const hex = match[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

export function getRelativeLuminance(color: RgbColor): number {
  const [r, g, b] = [color.r, color.g, color.b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function getContrastRatio(foreground: RgbColor, background: RgbColor): number {
  const lighter = Math.max(getRelativeLuminance(foreground), getRelativeLuminance(background));
  const darker = Math.min(getRelativeLuminance(foreground), getRelativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

/** 从两个 `#RRGGBB` 字符串计算对比度；任一解析失败返回 null。 */
export function getContrastRatioFromHex(foregroundHex: string, backgroundHex: string): number | null {
  const foreground = parseHexColor(foregroundHex);
  const background = parseHexColor(backgroundHex);
  if (!foreground || !background) return null;
  return getContrastRatio(foreground, background);
}
