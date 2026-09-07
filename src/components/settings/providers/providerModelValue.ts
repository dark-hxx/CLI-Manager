/**
 * Claude 模型值里的 `[1M]` 长上下文后缀处理。
 *
 * 后缀是 CLI 侧的书写约定（如 `claude-opus-5[1M]`），不是模型 ID 的一部分：
 * 模型候选列表、显示名都只应出现裸模型 ID，后缀由各角色行的 checkbox 单独控制。
 *
 * 实现自 `NativeClaudeConfigSection.tsx` 原地抽出，语义逐字保持不变。
 */

export function stripOneM(value: string): string {
  const trimmed = value.trimEnd();
  return trimmed.toLowerCase().endsWith("[1m]")
    ? trimmed.slice(0, -4).trimEnd()
    : trimmed;
}

export function hasOneM(value: string): boolean {
  return value.trimEnd().toLowerCase().endsWith("[1m]");
}

export function withOneM(value: string, enabled: boolean): string {
  const base = stripOneM(value).trim();
  if (!base) return "";
  return enabled ? `${base}[1M]` : base;
}
