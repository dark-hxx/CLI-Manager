import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeftRight, Boxes, CircleAlert, GripVertical, RefreshCw, Settings } from "../icons";
import { useI18n } from "../../lib/i18n";
import type { NativeProviderAppType, NativeProviderFailoverCircuit, NativeProviderFailoverProvider, NativeProviderGlobalPreview } from "../settings/providers/nativeProviderTypes";
import { orderFailoverProviders } from "../settings/providers/providerFailoverOrder";
import { useProviderQuickSwitch } from "./useProviderQuickSwitch";
import { TerminalPanelHeader } from "./TerminalPanelHeader";
import { TERM_PANEL, panelColorTint } from "../stats/termStatsUi";
import { VendorIcon, inferVendor } from "../VendorIcon";
import { DND_ACTIVATION_CONSTRAINT, DND_SORTABLE_TRANSITION } from "../../lib/dragInteraction";

const APP_TYPES: readonly NativeProviderAppType[] = ["claude", "codex", "grokbuild"];

interface ProviderQuickSwitchPanelProps {
  open: boolean;
  defaultAppType: NativeProviderAppType;
  onOpenSettings?: () => void;
}

interface ProviderRow extends NativeProviderFailoverProvider {
  model: string | null;
  baseUrl: string | null;
  settingsValid: boolean;
}

interface PendingProviderSwitch {
  provider: ProviderRow;
  preview: NativeProviderGlobalPreview;
}

function appTypeLabelKey(appType: NativeProviderAppType): "providerCatalog.appType.claude" | "providerCatalog.appType.codex" | "providerCatalog.appType.grokbuild" {
  return `providerCatalog.appType.${appType}` as "providerCatalog.appType.claude" | "providerCatalog.appType.codex" | "providerCatalog.appType.grokbuild";
}

// 终端皮肤下的紧凑开关行：不引入通用应用控件，配色全部走 TERM_PANEL 变量。
function RoutingToggleRow({
  label,
  hint,
  checked,
  disabled,
  busy,
  onToggle,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
  const trackColor = checked ? panelColorTint(TERM_PANEL.green, 55) : TERM_PANEL.track;
  return (
    <div className="flex items-center justify-between gap-3" style={{ opacity: disabled ? 0.55 : 1 }}>
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold" style={{ color: TERM_PANEL.fg }}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        title={hint}
        disabled={disabled}
        className="ui-focus-ring relative shrink-0 rounded-full transition-colors disabled:cursor-not-allowed"
        style={{ width: 28, height: 14, backgroundColor: trackColor }}
        onClick={() => onToggle(!checked)}
      >
        <span
          className="absolute top-1/2 rounded-full transition-all"
          style={{
            width: 8,
            height: 8,
            left: checked ? 17 : 3,
            transform: "translateY(-50%)",
            backgroundColor: checked ? TERM_PANEL.green : TERM_PANEL.dim,
            opacity: busy ? 0.5 : 1,
          }}
        />
      </button>
    </div>
  );
}

/**
 * 供应商行的拖拽容器。
 *
 * 这里刻意走 @dnd-kit 的 pointer/keyboard sensor，而不是 HTML5 原生 draggable：
 * 本项目内所有可用的拖拽排序（终端标签页、工具栏、统计卡片）都是 dnd-kit，
 * 原生 draggable 在本应用 webview 里拿不到有效 dropEffect，只会画出禁用光标。
 * 手柄用 render prop 交回调用方，因为它需要 useSortable 内部的 listeners 与 isDragging。
 */
function SortableProviderRow({
  id,
  selected,
  canReorder,
  dragLabel,
  children,
}: {
  id: string;
  selected: boolean;
  canReorder: boolean;
  dragLabel: string;
  children: (handle: ReactNode) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !canReorder, transition: DND_SORTABLE_TRANSITION });

  // This is a vertical list: carrying pointer X movement into the card expands
  // the panel scroll container and creates a horizontal scrollbar while dragging.
  const verticalTransform = transform ? { ...transform, x: 0 } : transform;

  // 独立卡片：每行自带边框 + 12px 圆角。选中态不用 3px 左竖条（那是 Material/VS Code
  // 的语言），改成淡绿底 + 描边提亮 + 柔光投影，靠"整块抬起"表达选中。
  const style: CSSProperties = {
    transform: CSS.Transform.toString(verticalTransform),
    transition: isDragging ? undefined : transition,
    position: "relative",
    zIndex: isDragging ? 1 : undefined,
    borderRadius: 12,
    borderColor: selected ? panelColorTint(TERM_PANEL.green, 42) : TERM_PANEL.border,
    backgroundColor: isDragging
      ? TERM_PANEL.cardInner
      : selected
        ? panelColorTint(TERM_PANEL.green, 10, TERM_PANEL.card)
        : TERM_PANEL.card,
    boxShadow: isDragging
      ? `0 8px 20px ${panelColorTint("#000000", 50)}`
      : selected
        ? `0 0 14px ${panelColorTint(TERM_PANEL.green, 12)}`
        : "none",
  };

  // 手柄是真实可聚焦 button（旧实现是 aria-hidden 的 span，键盘完全够不到）；
  // 排序是低频操作，默认淡出，hover/聚焦/拖拽中才显形，避免右侧排出一列点阵噪声。
  const handle = canReorder ? (
    <button
      ref={setActivatorNodeRef}
      type="button"
      className={`ui-focus-ring flex shrink-0 items-center px-1 transition-opacity focus-visible:opacity-100 ${isDragging ? "opacity-100" : "opacity-0 group-hover/row:opacity-60"}`}
      style={{ color: TERM_PANEL.dim, cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
      title={dragLabel}
      aria-label={dragLabel}
      {...attributes}
      {...listeners}
    >
      <GripVertical size={14} />
    </button>
  ) : null;

  return (
    <div ref={setNodeRef} className="group/row relative border transition-colors" style={style}>
      {children(handle)}
    </div>
  );
}

export function ProviderQuickSwitchPanel({ open, defaultAppType, onOpenSettings }: ProviderQuickSwitchPanelProps) {
  const { t } = useI18n();
  const [appType, setAppType] = useState<NativeProviderAppType>(defaultAppType);
  const [pendingSwitch, setPendingSwitch] = useState<PendingProviderSwitch | null>(null);
  // 纯视图过滤：只控制本面板列表是否展示「不可入队」供应商，默认关闭，不落库也不影响队列成员。
  const [showNotReady, setShowNotReady] = useState(false);
  useEffect(() => setAppType(defaultAppType), [defaultAppType]);
  useEffect(() => setPendingSwitch(null), [appType, open]);
  const reorderSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: DND_ACTIVATION_CONSTRAINT }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const quickSwitch = useProviderQuickSwitch(appType, open);
  const failover = quickSwitch.failover;
  const routeCurrentId = failover?.providers.find((provider) => provider.isCurrent)?.id ?? null;
  const catalogCurrentId = quickSwitch.providers.find((provider) => provider.isCurrent)?.id ?? null;
  const currentId = quickSwitch.hasLocalTakeover
    ? routeCurrentId
    : quickSwitch.current?.providerId ?? catalogCurrentId;
  const service = quickSwitch.routing?.persisted.service;
  const daemon = quickSwitch.routing?.daemon;
  const serviceRunning = Boolean(service?.serviceEnabled && daemon?.status === "running");
  const autoFailover = failover?.config.autoFailoverEnabled ?? false;
  const localRouting = quickSwitch.hasLocalTakeover;
  const localRoutingRunning = Boolean(localRouting && serviceRunning);
  // 自动故障转移要求 daemon 已连接且支持本地路由能力；仅「服务已启用」不足以放行。
  const runtimeAvailable = Boolean(serviceRunning && daemon?.capabilitySupported && daemon.connected);
  const busy = Boolean(quickSwitch.action);
  const appLabel = t(appTypeLabelKey(appType));

  const rows = useMemo<ProviderRow[]>(() => {
    const catalogById = new Map(quickSwitch.providers.map((provider) => [provider.id, provider]));
    if (failover) {
      return orderFailoverProviders(failover.providers, autoFailover)
        .map((provider) => {
          const card = catalogById.get(provider.id);
          return {
            ...provider,
            model: card?.model ?? null,
            baseUrl: card?.baseUrl ?? null,
            settingsValid: card?.settingsValid ?? provider.ready,
          };
        });
    }
    return [...quickSwitch.providers]
      .sort((left, right) => left.sortIndex - right.sortIndex)
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        sortIndex: provider.sortIndex,
        isCurrent: provider.isCurrent,
        enabled: provider.enabled,
        ready: provider.enabled && provider.settingsValid && Boolean(provider.activeKeyLabel),
        inFailoverQueue: false,
        keyCount: provider.keyCount,
        activeKeyPresent: Boolean(provider.activeKeyLabel),
        model: provider.model,
        baseUrl: provider.baseUrl,
        settingsValid: provider.settingsValid,
      }));
  }, [autoFailover, failover, quickSwitch.providers]);
  // canReorder / queuedIds / queuePosition / 拖拽提交都必须基于全量 rows：
  // 队列成员和 provider_catalog_reorder 都要求全量 ID 覆盖，用过滤后的列表会把隐藏行踢出队列或触发
  // provider_reorder_mismatch。展示过滤只作用在 visibleRows 上。
  const canReorder = autoFailover && rows.length > 1 && !quickSwitch.action;

  const queuedIds = useMemo(
    () => rows.filter((provider) => provider.inFailoverQueue).map((provider) => provider.id),
    [rows],
  );
  const queuePosition = useMemo(() => new Map(queuedIds.map((id, index) => [id, index])), [queuedIds]);

  // 熔断状态只在自动故障转移开启时有意义；过滤与渲染共用同一份查表，避免两处口径漂移。
  const circuitOf = useCallback((providerId: string): NativeProviderFailoverCircuit | null => {
    if (!autoFailover || !failover) return null;
    return failover.circuits.find((item) => item.providerId === providerId)
      ?? (failover.circuit.providerId === providerId ? failover.circuit : null);
  }, [autoFailover, failover]);

  // 「不可入队」= 状态圆点中 !ready 且未熔断的那一档；熔断/半开有各自标签，不归该开关管。
  // 当前供应商始终保留：面板首要职责是显示正在生效的渠道，把它藏掉会让面板看起来没有当前项。
  const visibleRows = useMemo(() => {
    if (showNotReady) return rows;
    return rows.filter((provider) => {
      if (provider.ready || provider.id === currentId) return true;
      const status = circuitOf(provider.id)?.status;
      return status === "open" || status === "halfOpen";
    });
  }, [circuitOf, currentId, rows, showNotReady]);
  const hiddenCount = rows.length - visibleRows.length;

  const selectAppType = (next: NativeProviderAppType) => {
    if (next !== appType) setAppType(next);
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!(["ArrowLeft", "ArrowRight", "Home", "End"] as string[]).includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? APP_TYPES.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + APP_TYPES.length) % APP_TYPES.length;
    const next = APP_TYPES[nextIndex];
    selectAppType(next);
    tabRefs.current[next]?.focus();
  };

  const handleRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!(["ArrowUp", "ArrowDown", "Home", "End"] as string[]).includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? visibleRows.length - 1
        : Math.min(visibleRows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    rowRefs.current[visibleRows[nextIndex]?.id]?.focus();
  };

  const handleGlobalSwitch = async (provider: ProviderRow) => {
    if (quickSwitch.action || !provider.ready || provider.id === currentId) return;
    // Automatic failover owns provider selection through its queue controls.
    // A row click must not bypass that policy by applying a global provider.
    if (autoFailover) return;
    if (quickSwitch.hasLocalTakeover && failover && !autoFailover) {
      try {
        await quickSwitch.setFailoverQueue([provider.id]);
        toast.success(t("providerQuickSwitch.hotSwitchSuccess", { name: provider.name }));
      } catch {
        toast.error(t("providerQuickSwitch.switchFailed"));
      }
      return;
    }

    try {
      const preview = await quickSwitch.previewGlobal(provider.id);
      setPendingSwitch({ provider, preview });
    } catch {
      toast.error(t("providerQuickSwitch.switchFailed"));
    }
  };

  const handleConfirmGlobalSwitch = async () => {
    if (!pendingSwitch || quickSwitch.action) return;
    const { provider, preview } = pendingSwitch;
    try {
      await quickSwitch.applyGlobal(preview);
      setPendingSwitch(null);
      toast.success(t("providerQuickSwitch.switchSuccess", { name: provider.name }));
      rowRefs.current[provider.id]?.focus();
    } catch {
      toast.error(t("providerQuickSwitch.switchFailed"));
    }
  };

  const handleCancelGlobalSwitch = () => {
    const providerId = pendingSwitch?.provider.id;
    setPendingSwitch(null);
    if (providerId) requestAnimationFrame(() => rowRefs.current[providerId]?.focus());
  };

  const handleLocalRoutingToggle = async (next: boolean) => {
    if (busy) return;
    try {
      await quickSwitch.setLocalRouting(next);
    } catch {
      toast.error(next
        ? t("providerQuickSwitch.localRoutingEnableFailed")
        : t("providerQuickSwitch.localRoutingDisableFailed"));
    }
  };

  const handleFailoverToggle = async (next: boolean) => {
    if (busy) return;
    try {
      await quickSwitch.setFailoverEnabled(next);
    } catch {
      toast.error(t("providerQuickSwitch.failoverToggleFailed"));
    }
  };

  const handleQueueToggle = async (provider: ProviderRow) => {
    if (quickSwitch.action || !provider.ready || !failover || !autoFailover) return;
    const next = provider.inFailoverQueue
      ? queuedIds.filter((id) => id !== provider.id)
      : [...queuedIds, provider.id];
    try {
      await quickSwitch.setFailoverQueue(next);
    } catch {
      toast.error(t("providerQuickSwitch.queueUpdateFailed"));
    }
  };

  // 后端 provider_catalog_reorder 要求 ID 覆盖该 appType 全量供应商，否则报
  // provider_reorder_mismatch；rows 就是全量列表，直接整体重排后提交。
  const handleReorderDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!autoFailover || !over || active.id === over.id || quickSwitch.action) return;
    const ordered = rows.map((item) => item.id);
    const sourceIndex = ordered.indexOf(String(active.id));
    const targetIndex = ordered.indexOf(String(over.id));
    if (sourceIndex < 0 || targetIndex < 0) return;
    try {
      await quickSwitch.reorderFailoverQueue(arrayMove(ordered, sourceIndex, targetIndex));
    } catch {
      toast.error(t("providerQuickSwitch.queueUpdateFailed"));
    }
  };

  const errorMessage = quickSwitch.errorCode === "routing_provider_not_ready"
    ? t("providerCatalog.routing.errors.providerNotReady")
    : quickSwitch.errorCode === "routing_provider_key_not_active"
      ? t("providerCatalog.routing.errors.providerKeyNotActive")
      : quickSwitch.errorCode === "routing_failover_manual_queue_single"
        ? t("providerCatalog.routing.errors.manualQueueSingle")
        : quickSwitch.errorCode
          ? t("providerQuickSwitch.loadFailed")
          : null;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{
        color: TERM_PANEL.fg,
        backgroundColor: TERM_PANEL.bg,
        "--ui-scrollbar-thumb": TERM_PANEL.border,
        "--ui-scrollbar-track": TERM_PANEL.bg,
      } as CSSProperties}
    >
      <TerminalPanelHeader
        icon={<ArrowLeftRight size={13} />}
        accent={TERM_PANEL.green}
        title={t("terminal.panel.providers")}
      />
      <div className="shrink-0 border-b px-3 py-3" style={{ borderColor: TERM_PANEL.border }}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-semibold" style={{ color: TERM_PANEL.dim }}>{t("providerQuickSwitch.cliTypes")}</span>
          <span className="text-[10px]" style={{ color: TERM_PANEL.dim }}>{t(appTypeLabelKey(appType))}</span>
        </div>
        {/* 分段控件：灰槽 + 当前项抬升一档的填充块。原实现用绿框描边，
            绿色在本面板已被「当前供应商」占用，标签再用绿会稀释强调语义。
            三格等宽（basis-0 + flex-1）避免「Grok Build」被截断成「Grok Build..」。 */}
        <div role="tablist" aria-label={t("providerQuickSwitch.cliTypes")} className="flex gap-0.5 rounded-[10px] p-0.5" style={{ backgroundColor: TERM_PANEL.track }}>
          {APP_TYPES.map((type, index) => (
            <button
              key={type}
              ref={(node) => { tabRefs.current[type] = node; }}
              type="button"
              role="tab"
              aria-selected={appType === type}
              tabIndex={appType === type ? 0 : -1}
              className="ui-focus-ring flex min-w-0 flex-1 basis-0 items-center justify-center gap-1.5 rounded-lg px-1.5 py-1.5 text-[11px] font-semibold transition-colors"
              data-active={appType === type ? "true" : "false"}
              style={{
                color: appType === type ? TERM_PANEL.fg : TERM_PANEL.dim,
                backgroundColor: appType === type ? TERM_PANEL.cardInner : "transparent",
                boxShadow: appType === type ? `0 1px 2px ${panelColorTint("#000000", 35)}` : "none",
              }}
              onClick={() => selectAppType(type)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              <VendorIcon vendor={inferVendor(type)} size={13} />
              <span className="min-w-0 truncate">{t(appTypeLabelKey(type))}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 固定区：路由状态卡与列表标题不跟随供应商列表滚动，只有下方列表滚。 */}
      <div className="shrink-0 px-3 pt-3">
        <div className="grid grid-cols-[80px_minmax(0,1fr)] gap-3 rounded-lg border px-3 py-2.5" style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.card }}>
          <div className="flex min-w-0 flex-col justify-center">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md" style={{ color: TERM_PANEL.green, backgroundColor: panelColorTint(TERM_PANEL.green, 14) }}><ArrowLeftRight size={12} /></span>
              <div className="min-w-0">
                <div className="truncate text-[11px] font-semibold">{t("providerQuickSwitch.routingStatus")}</div>
                <div className="truncate text-[10px]" style={{ color: localRoutingRunning ? TERM_PANEL.green : TERM_PANEL.yellow }}>
                  {localRoutingRunning ? t("providerQuickSwitch.routingRunning") : t("providerQuickSwitch.routingUnavailable")}
                </div>
              </div>
            </div>
          </div>

          <div className="min-w-0 space-y-2 border-l pl-3" style={{ borderColor: TERM_PANEL.border }}>
            <RoutingToggleRow
              label={t("providerQuickSwitch.localRouting")}
              hint={localRouting
                ? t("providerQuickSwitch.localRoutingOnHint", { app: appLabel })
                : t("providerQuickSwitch.localRoutingOffHint", { app: appLabel })}
              checked={localRouting}
              disabled={busy || !quickSwitch.routing}
              busy={quickSwitch.action === "local-routing"}
              onToggle={(next) => void handleLocalRoutingToggle(next)}
            />
            <RoutingToggleRow
              label={t("providerQuickSwitch.autoFailover")}
              hint={!localRouting
                ? t("providerQuickSwitch.failoverNeedsRouting")
                : !autoFailover && !runtimeAvailable
                  ? t("providerQuickSwitch.failoverNeedsRuntime")
                  : autoFailover
                    ? t("providerQuickSwitch.failoverOnHint")
                    : t("providerQuickSwitch.failoverOffHint")}
              checked={autoFailover}
              disabled={busy || !localRouting || !failover || (!autoFailover && !runtimeAvailable)}
              busy={quickSwitch.action === "failover-enabled"}
              onToggle={(next) => void handleFailoverToggle(next)}
            />
            <RoutingToggleRow
              label={t("providerQuickSwitch.showNotReady")}
              hint={showNotReady
                ? t("providerQuickSwitch.showNotReadyOnHint")
                : t("providerQuickSwitch.showNotReadyOffHint")}
              checked={showNotReady}
              disabled={false}
              busy={false}
              onToggle={setShowNotReady}
            />
          </div>
        </div>

        {errorMessage && <div className="mt-2 flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[10px]" style={{ color: TERM_PANEL.red, borderColor: panelColorTint(TERM_PANEL.red, 45), backgroundColor: panelColorTint(TERM_PANEL.red, 10) }}><CircleAlert size={13} className="mt-0.5 shrink-0" />{errorMessage}</div>}

        <div className="mt-3 flex items-center justify-between">
          <span className="text-[11px] font-semibold" style={{ color: TERM_PANEL.dim }}>{t("providerQuickSwitch.providerList")}</span>
          <span className="text-[10px]" style={{ color: TERM_PANEL.dim }}>{hiddenCount > 0 ? `${visibleRows.length}/${rows.length}` : rows.length}</span>
        </div>
      </div>

      <div className="ui-thin-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
        {quickSwitch.loading && visibleRows.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-[11px]" style={{ color: TERM_PANEL.dim }}><RefreshCw size={14} className="animate-spin" />{t("providerQuickSwitch.loading")}</div>
        )}
        {!quickSwitch.loading && visibleRows.length === 0 && (
          <div className="py-8 text-center text-[11px]" style={{ color: TERM_PANEL.dim }}>
            {hiddenCount > 0 ? t("providerQuickSwitch.allNotReady") : t("providerQuickSwitch.empty")}
          </div>
        )}

        <DndContext
          sensors={reorderSensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => void handleReorderDragEnd(event)}
        >
        <SortableContext items={visibleRows.map((provider) => provider.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2" role="radiogroup" aria-label={t("providerQuickSwitch.providerList")}>
          {visibleRows.map((provider, index) => {
            const selected = provider.id === currentId;
            const circuit = circuitOf(provider.id);
            const vendor = inferVendor(`${provider.name} ${provider.model ?? ""} ${provider.baseUrl ?? ""}`);
            // 当前供应商由整张卡片的高亮表达；右侧只用状态圆点呈现可用性/熔断状态。
            // 左右标记绝对居中，正文保持单列，避免为两个装饰标记拆成三列布局。
            const status = circuit?.status === "open"
              ? { color: TERM_PANEL.red, label: t("providerCatalog.failover.circuit.open"), showLabel: true }
              : circuit?.status === "halfOpen"
                ? { color: TERM_PANEL.yellow, label: t("providerCatalog.failover.circuit.halfOpen"), showLabel: true }
                : provider.ready
                  ? { color: TERM_PANEL.green, label: t("providerCatalog.failover.ready"), showLabel: false }
                  : { color: TERM_PANEL.yellow, label: t("providerCatalog.failover.notReady"), showLabel: true };
            return (
              <SortableProviderRow
                key={provider.id}
                id={provider.id}
                selected={selected}
                canReorder={canReorder}
                dragLabel={t("providerQuickSwitch.dragHandle")}
              >
                {(dragHandle) => (
                <>
                <div className="flex items-center gap-1.5">
                  <button
                    ref={(node) => { rowRefs.current[provider.id] = node; }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-disabled={autoFailover}
                    tabIndex={index === 0 ? 0 : -1}
                    disabled={Boolean(quickSwitch.action) || !provider.ready}
                    className={`ui-focus-ring relative min-w-0 flex-1 px-2.5 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-55 ${autoFailover ? "cursor-default" : ""}`}
                    onClick={() => void handleGlobalSwitch(provider)}
                    onKeyDown={(event) => handleRowKeyDown(event, index)}
                    title={autoFailover ? t("providerQuickSwitch.failoverOnHint") : provider.baseUrl ?? undefined}
                  >
                    <span className="absolute left-2.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md" style={{ backgroundColor: TERM_PANEL.cardInner }}>
                        <VendorIcon vendor={vendor} size={14} fallback={Boxes} />
                    </span>
                    <span className={`block min-w-0 pl-7 ${status.showLabel ? "pr-20" : "pr-5"}`}>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-[13px] font-semibold tracking-tight" style={{ color: TERM_PANEL.fg }}>{provider.name}</span>
                        {autoFailover && provider.inFailoverQueue && <span className="shrink-0 rounded px-1 text-[9px]" style={{ color: TERM_PANEL.green, backgroundColor: panelColorTint(TERM_PANEL.green, 14) }}>#{(queuePosition.get(provider.id) ?? 0) + 1}</span>}
                      </span>
                      <span className="mt-0.5 block min-w-0 truncate text-[11px]" style={{ color: TERM_PANEL.dim }}>
                        {provider.model ?? provider.baseUrl ?? t("providerQuickSwitch.noModel")}
                      </span>
                    </span>
                    <span
                      role="img"
                      aria-label={status.label}
                      title={status.label}
                      className="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-[10px]"
                      style={{ color: status.color }}
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: status.color }} aria-hidden="true" />
                      {status.showLabel && <span className="shrink-0">{status.label}</span>}
                    </span>
                  </button>

                  {canReorder && (
                    <>
                      {failover && (
                        <>
                          {autoFailover && (
                            <>
                              <button type="button" className="ui-focus-ring rounded px-1.5 py-1 text-[10px] disabled:opacity-35" style={{ color: provider.inFailoverQueue ? TERM_PANEL.green : TERM_PANEL.dim }} aria-pressed={provider.inFailoverQueue} aria-label={t("providerCatalog.failover.queueToggle", { name: provider.name })} disabled={Boolean(quickSwitch.action) || !provider.ready} onClick={() => void handleQueueToggle(provider)}>
                                {provider.inFailoverQueue ? "✓" : "+"}
                              </button>
                            </>
                          )}
                        </>
                      )}
                      {dragHandle}
                    </>
                  )}
                </div>
                {pendingSwitch?.provider.id === provider.id && (
                  <div
                    role="group"
                    aria-live="polite"
                    aria-labelledby="provider-switch-confirm-title"
                    aria-describedby="provider-switch-confirm-hint"
                    className="border-t px-2.5 py-2"
                    style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") handleCancelGlobalSwitch();
                    }}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="min-w-0 flex-1">
                        <div id="provider-switch-confirm-title" className="truncate text-[11px] font-semibold" style={{ color: TERM_PANEL.fg }}>
                          {t("providerQuickSwitch.confirmSwitchTitle", { name: pendingSwitch.provider.name })}
                        </div>
                        <div id="provider-switch-confirm-hint" className="truncate text-[10px]" style={{ color: TERM_PANEL.dim }}>
                          {t("providerQuickSwitch.confirmSwitchHint")}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          className="ui-focus-ring rounded-md border px-2 py-1 text-[10px] transition-colors"
                          style={{ color: TERM_PANEL.dim, borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.bg }}
                          onClick={handleCancelGlobalSwitch}
                        >
                          {t("common.cancel")}
                        </button>
                        <button
                          type="button"
                          autoFocus
                          disabled={Boolean(quickSwitch.action)}
                          className="ui-focus-ring rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                          style={{ color: TERM_PANEL.bg, borderColor: TERM_PANEL.green, backgroundColor: TERM_PANEL.green }}
                          onClick={() => void handleConfirmGlobalSwitch()}
                        >
                          {t("providerQuickSwitch.confirmSwitch")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                </>
                )}
              </SortableProviderRow>
            );
          })}
        </div>
        </SortableContext>
        </DndContext>
      </div>

      <div className="shrink-0 border-t px-3 py-3" style={{ borderColor: TERM_PANEL.border }}>
        <button type="button" className="ui-focus-ring flex w-full items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-medium transition-colors" style={{ color: TERM_PANEL.fg, borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.card }} onClick={onOpenSettings}>
          <Settings size={13} style={{ color: TERM_PANEL.green }} />{t("providerQuickSwitch.openSettings")}
        </button>
      </div>
    </div>
  );
}
