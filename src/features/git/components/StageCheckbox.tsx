import { Check, Minus } from "../../../shared/ui/icons";
import { TERM } from "../../stats/api/termStatsUi";

export type StageState = "checked" | "unchecked" | "indeterminate";

interface StageCheckboxProps {
  state: StageState;
  onToggle: () => void;
  title?: string;
  ariaLabel?: string;
}

/**
 * 暗色主题三态暂存复选框：替换原生白色 checkbox。
 * checked = 全部暂存，indeterminate = 部分暂存，unchecked = 未暂存。
 */
export function StageCheckbox({ state, onToggle, title, ariaLabel }: StageCheckboxProps) {
  const active = state === "checked" || state === "indeterminate";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "indeterminate" ? "mixed" : state === "checked"}
      title={title}
      aria-label={ariaLabel ?? title}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="ui-focus-ring inline-flex shrink-0 items-center justify-center rounded-[3px] transition-colors"
      style={{
        width: 13,
        height: 13,
        border: `1px solid ${active ? TERM.green : TERM.dim}`,
        backgroundColor: active ? TERM.green : "transparent",
      }}
    >
      {state === "checked" && <Check size={9} strokeWidth={3.5} style={{ color: TERM.bg }} />}
      {state === "indeterminate" && <Minus size={9} strokeWidth={3.5} style={{ color: TERM.bg }} />}
    </button>
  );
}
