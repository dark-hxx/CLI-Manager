import { Folder, Terminal } from "./icons";
import { CliToolIcon, isCliToolIconKey } from "./CliToolIcon";
import { resolveCliToolIconKey } from "../lib/cliTools";
import { isNodeBrandIconKey, nodeBrandIconSource } from "../lib/nodeAppearance";

interface NodeAppearanceIconProps {
  /** `resolveNodeAppearance` 得到的单字符标记（emoji / CJK 单字），非空时优先渲染。 */
  mark: string;
  /** `resolveNodeAppearance` 得到的内置图标 key，`mark` 为空时使用。 */
  iconKey?: string;
  /** 项目的 `cli_tool`，用于回退到工具图标；分组不传。 */
  cliTool?: string;
  /** 都没有时的兜底图标。 */
  fallback: "folder" | "terminal";
  size?: number;
}

/**
 * 节点图标的唯一渲染入口：单字符标记 → 内置图标 key → CLI 工具图标 → 类型兜底图标。
 *
 * 侧边栏、History 项目树、Stats 项目树共用，避免三处各写一遍回退分支。
 * 颜色由外层的 `--node-accent` 决定，但只对单色图标生效 —— CLI 品牌图标与 emoji 自带颜色。
 */
export function NodeAppearanceIcon({
  mark,
  iconKey = "",
  cliTool,
  fallback,
  size = 16,
}: NodeAppearanceIconProps) {
  if (mark) {
    return (
      <span className="ui-tree-icon-mark" style={{ fontSize: size, width: size }} aria-hidden="true">
        {mark}
      </span>
    );
  }

  if (isNodeBrandIconKey(iconKey)) {
    return (
      <img
        className="ui-tree-icon-mark ui-node-brand-icon"
        src={nodeBrandIconSource(iconKey)}
        alt=""
        width={size}
        height={size}
        aria-hidden="true"
      />
    );
  }

  const resolvedKey = isCliToolIconKey(iconKey) ? iconKey : resolveCliToolIconKey(cliTool);
  if (resolvedKey) return <CliToolIcon icon={resolvedKey} size={size} />;

  return fallback === "folder" ? (
    <Folder size={size} strokeWidth={1.5} />
  ) : (
    <Terminal size={size} strokeWidth={1.5} />
  );
}
