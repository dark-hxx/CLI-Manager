import { useRef, useState, type CSSProperties } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { NodeAppearanceIcon } from "../NodeAppearanceIcon";
import { NodeAppearancePanel } from "./NodeAppearancePanel";
import { resolveNodeAppearance } from "../../lib/nodeAppearance";
import { useI18n } from "../../lib/i18n";

interface NewGroupRowProps {
  compact: boolean;
  /** 行内缩进（子级分组）。根级不传，改用容器的 px-2。 */
  paddingLeft?: number;
  onCreate: (name: string, appearance: { icon: string; color: string }) => void;
  onCancel: () => void;
}

/**
 * 新建分组的内联行：图标位是外观快选按钮，不点直接回车照旧一步建组（落自动配色）。
 *
 * 名称与外观一起提交，由 `createGroup` 的同一条 INSERT 落库，
 * 不做"先建组再改外观"的两步写（见任务 design.md §8.4）。
 */
export function NewGroupRow({ compact, paddingLeft, onCreate, onCancel }: NewGroupRowProps) {
  const { t } = useI18n();
  const [icon, setIcon] = useState("");
  const [color, setColor] = useState("");
  const [name, setName] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const appearance = resolveNodeAppearance({ icon, color });

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) onCreate(trimmed, { icon, color });
    else onCancel();
  };

  return (
    <div
      className={`flex items-center ${compact ? "gap-1.5 py-1" : "gap-2 py-1.5"}`}
      style={{
        paddingLeft,
        paddingRight: compact ? 8 : 10,
        ...(appearance.hasColor ? { "--node-accent": appearance.colorVar } : {}),
      } as CSSProperties}
    >
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="ui-tree-leading-icon ui-appearance-trigger"
            title={t("sidebar.tree.newGroupAppearance")}
            aria-label={t("sidebar.tree.newGroupAppearance")}
            // 阻止 mousedown 抢焦点：否则名称输入框会先 blur 并提前提交建组。
            onMouseDown={(event) => event.preventDefault()}
          >
            <NodeAppearanceIcon mark={appearance.emoji} iconKey={appearance.iconKey} fallback="folder" size={16} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <NodeAppearancePanel
            icon={icon}
            color={color}
            onChange={(next) => {
              if (next.icon !== undefined) setIcon(next.icon);
              if (next.color !== undefined) setColor(next.color);
            }}
            onAfterPick={() => setPickerOpen(false)}
          />
        </PopoverContent>
      </Popover>
      <input
        ref={inputRef}
        autoFocus
        value={name}
        className="ui-tree-inline-input ui-focus-ring h-8 flex-1 px-2 text-xs text-on-surface outline-none"
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          if (pickerOpen) return;
          submit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          if (event.key === "Escape") onCancel();
        }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      />
    </div>
  );
}
