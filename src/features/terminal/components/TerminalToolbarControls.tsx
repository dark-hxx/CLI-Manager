import { useMemo, type CSSProperties, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useI18n } from "../../../lib/i18n";
import { DND_SORTABLE_TRANSITION } from "../../../lib/dragInteraction";
import { CliCat } from "../../../components/desktop-pet/CliCat";
import { useSystemResources } from "../../../hooks/useSystemResources";

export function SortableToolbarButton({
  id,
  isDragging,
  tooltip,
  children,
}: {
  id: string;
  isDragging: boolean;
  tooltip: string;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id,
    transition: DND_SORTABLE_TRANSITION,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0.4 : 1,
    cursor: "grab",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="ui-terminal-action-sort-item flex w-full justify-center"
      data-tooltip={isDragging ? undefined : tooltip}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

export function CpuCatIndicator({
  enabled,
  active,
  onClick,
}: {
  enabled: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const cpuOnlyOptions = useMemo(() => ({ fullDetail: false, system: false, cpu: true, memory: false }), []);
  const { snapshot } = useSystemResources(enabled, cpuOnlyOptions, 3000);
  if (!enabled) return null;

  const usage = snapshot ? Math.max(0, Math.min(100, snapshot.cpu.usagePercent)) : 0;
  const baseDuration = 1 / (0.6 + 2.6 * (usage / 100));
  // 45% 以下保持原变速，超过后平滑加速，100% 时约 0.20s/圈
  const urgencyFactor = usage <= 45 ? 1 : 1 - 0.35 * ((usage - 45) / 55);
  const speed = `${(baseDuration * urgencyFactor).toFixed(2)}s`;
  const color =
    usage >= 75
      ? "var(--term-panel-red, #f25e5e)"
      : usage >= 45
        ? "var(--term-panel-yellow, #e5c453)"
        : "var(--term-panel-green, #3dd68c)";
  const label = t("systemResources.cpuCatTitle", { usage: `${usage.toFixed(0)}%` });

  return (
    <button
      type="button"
      className="ui-focus-ring ui-cpu-cat"
      data-active={active ? "true" : "false"}
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{ "--cpu-cat-speed": speed, "--cpu-cat-color": color } as CSSProperties}
    >
      <CliCat />
    </button>
  );
}
