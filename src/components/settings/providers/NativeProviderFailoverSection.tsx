import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Accordion, Alert, Group, NumberInput, Radio, Stack, Switch, Text, Badge } from "@mantine/core";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowLeftRight, ArrowUp, GripVertical, RotateCcw, Save } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { DND_ACTIVATION_CONSTRAINT, DND_SORTABLE_TRANSITION } from "@/lib/dragInteraction";
import { NativeProviderActionIcon as ActionIcon, NativeProviderButton as Button } from "./NativeProviderButton";
import type { NativeProviderAppType, NativeProviderFailoverConfig, NativeProviderFailoverProvider } from "./nativeProviderTypes";
import { orderFailoverProviders } from "./providerFailoverOrder";
import type { UseNativeProviderRoutingResult } from "./useNativeProviderRouting";

interface NativeProviderFailoverSectionProps {
  appType: NativeProviderAppType;
  state: UseNativeProviderRoutingResult;
}

function SortableFailoverProviderRow({
  provider,
  canReorder,
  dragLabel,
  children,
}: {
  provider: NativeProviderFailoverProvider;
  canReorder: boolean;
  dragLabel: string;
  children: (dragHandle: ReactNode) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: provider.id,
    disabled: !canReorder,
    transition: DND_SORTABLE_TRANSITION,
  });
  const style: CSSProperties = {
    position: "relative",
    zIndex: isDragging ? 1 : undefined,
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
  };
  const dragHandle = canReorder ? (
    <ActionIcon
      ref={setActivatorNodeRef}
      aria-label={dragLabel}
      title={dragLabel}
      variant="subtle"
      color="gray"
      size="sm"
      className="opacity-60 transition-opacity group-hover/failover-row:opacity-100 focus-visible:opacity-100"
      style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
      {...attributes}
      {...listeners}
    >
      <GripVertical size={14} />
    </ActionIcon>
  ) : null;

  return (
    <div ref={setNodeRef} className="group/failover-row" style={style}>
      {children(dragHandle)}
    </div>
  );
}

export function NativeProviderFailoverSection({ appType, state }: NativeProviderFailoverSectionProps) {
  const { t } = useI18n();
  const failover = state.failoverState[appType];
  const routing = state.state;
  const service = routing?.persisted.service;
  const [configDraft, setConfigDraft] = useState<NativeProviderFailoverConfig | null>(null);
  const [configDirty, setConfigDirty] = useState(false);
  const busy = Boolean(state.action);
  const daemonUnsupported = routing?.daemon.capabilitySupported === false;
  const daemonDisconnected = Boolean(routing && !routing.daemon.connected);
  const serviceRunning = Boolean(service?.serviceEnabled && routing?.daemon.status === "running");
  const runtimeAvailable = Boolean(serviceRunning && routing?.daemon.capabilitySupported && routing.daemon.connected);
  const manualSwitch = Boolean(failover && !failover.config.autoFailoverEnabled);
  const reorderSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: DND_ACTIVATION_CONSTRAINT }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const orderedProviders = useMemo(
    () => failover ? orderFailoverProviders(failover.providers, !manualSwitch) : [],
    [failover, manualSwitch],
  );
  const queuedProviders = useMemo(
    () => orderedProviders.filter((provider) => provider.inFailoverQueue),
    [orderedProviders],
  );
  const queuePosition = useMemo(
    () => new Map(queuedProviders.map((provider, index) => [provider.id, index])),
    [queuedProviders],
  );
  const canReorder = Boolean(failover?.config.autoFailoverEnabled && orderedProviders.length > 1 && !busy);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!state.action && !state.failoverLoading[appType]) void state.refreshFailover(appType);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [appType, state.action, state.failoverLoading, state.refreshFailover]);

  useEffect(() => {
    if (!failover || configDirty) return;
    setConfigDraft(failover.config);
  }, [configDirty, failover]);

  const updateQueue = async (providerId: string, enabled: boolean) => {
    if (!failover) return;
    if (manualSwitch) {
      if (!enabled) return;
      await state.setFailoverQueue(appType, [providerId]);
      return;
    }
    const providerIds = orderedProviders
      .filter((provider) => provider.id === providerId ? enabled : provider.inFailoverQueue)
      .map((provider) => provider.id);
    await state.setFailoverQueue(appType, providerIds);
  };

  const moveQueuedProvider = async (providerId: string, direction: -1 | 1) => {
    if (!failover) return;
    const queueIndexes = orderedProviders
      .map((provider, index) => provider.inFailoverQueue ? index : -1)
      .filter((index) => index >= 0);
    const currentIndex = orderedProviders.findIndex((provider) => provider.id === providerId);
    const queuePosition = queueIndexes.indexOf(currentIndex);
    const targetPosition = queuePosition + direction;
    if (queuePosition < 0 || targetPosition < 0 || targetPosition >= queueIndexes.length) return;
    const next = [...orderedProviders];
    const targetIndex = queueIndexes[targetPosition];
    [next[currentIndex], next[targetIndex]] = [next[targetIndex], next[currentIndex]];
    await state.reorderFailoverQueue(appType, next.map((provider) => provider.id));
  };

  const handleReorderDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!canReorder || !over || active.id === over.id) return;
    const providerIds = orderedProviders.map((provider) => provider.id);
    const sourceIndex = providerIds.indexOf(String(active.id));
    const targetIndex = providerIds.indexOf(String(over.id));
    if (sourceIndex < 0 || targetIndex < 0) return;
    await state.reorderFailoverQueue(appType, arrayMove(providerIds, sourceIndex, targetIndex));
  };

  const saveConfig = async () => {
    if (!configDraft) return;
    await state.updateFailoverConfig(appType, configDraft);
    setConfigDirty(false);
  };

  const resetConfigDraft = () => {
    if (!failover) return;
    setConfigDraft(failover.config);
    setConfigDirty(false);
  };

  const updateConfigDraft = (field: keyof NativeProviderFailoverConfig, value: number) => {
    setConfigDraft((current) => current ? { ...current, [field]: value } : current);
    setConfigDirty(true);
  };

  const circuits = failover
    ? failover.circuits.length > 0
      ? failover.circuits
      : failover.circuit.providerId
        ? [failover.circuit]
        : []
    : [];
  const circuitByProvider = new Map(circuits.map((circuit) => [circuit.providerId, circuit]));

  return (
    <Accordion.Item value="failover">
      <Accordion.Control icon={<ArrowLeftRight size={16} />}>{t("providerCatalog.failover.title")}</Accordion.Control>
      <Accordion.Panel>
        <Stack gap="md">
          <Text size="sm" c="dimmed">{t("providerCatalog.failover.description")}</Text>

          {!serviceRunning && (
            <Alert color="yellow" title={t("providerCatalog.failover.unavailableTitle")}>
              {t("providerCatalog.failover.requiresService")}
            </Alert>
          )}
          {daemonUnsupported && (
            <Alert color="gray" title={t("providerCatalog.failover.unavailableTitle")}>
              {t("providerCatalog.failover.unsupported")}
            </Alert>
          )}
          {!daemonUnsupported && daemonDisconnected && (
            <Alert color="yellow" title={t("providerCatalog.failover.unavailableTitle")}>
              {t("providerCatalog.failover.daemonUnavailable")}
            </Alert>
          )}

          {state.failoverLoading[appType] && !failover ? (
            <Text size="sm" c="dimmed">{t("providerCatalog.failover.loading")}</Text>
          ) : failover ? (
            <>
              <Text size="sm" c="dimmed">
                {manualSwitch
                  ? t("providerCatalog.failover.manualSwitchDescription")
                  : t("providerCatalog.failover.statusPolling")}
              </Text>
              <DndContext
                sensors={reorderSensors}
                collisionDetection={closestCenter}
                onDragEnd={(event) => void handleReorderDragEnd(event)}
              >
                <SortableContext items={orderedProviders.map((provider) => provider.id)} strategy={verticalListSortingStrategy}>
                  <Stack gap="xs">
                    {orderedProviders.map((provider) => {
                      const circuit = manualSwitch ? undefined : circuitByProvider.get(provider.id);
                      const circuitStatus = circuit?.status;
                      const circuitLabel = circuitStatus === "open"
                        ? t("providerCatalog.failover.circuit.open")
                        : circuitStatus === "halfOpen"
                          ? t("providerCatalog.failover.circuit.halfOpen")
                          : circuitStatus === "closed"
                            ? t("providerCatalog.failover.healthy")
                            : circuit
                              ? t("providerCatalog.failover.circuit.unknown")
                              : routing?.daemon.status === "degraded"
                                ? t("providerCatalog.failover.degraded")
                                : t("providerCatalog.failover.healthy");
                      const circuitColor = circuitStatus === "open"
                        ? "red"
                        : circuitStatus === "halfOpen"
                          ? "yellow"
                          : circuitStatus === "closed"
                            ? "green"
                            : routing?.daemon.status === "degraded" ? "yellow" : "green";
                      return (
                    <SortableFailoverProviderRow
                      key={provider.id}
                      provider={provider}
                      canReorder={canReorder}
                      dragLabel={t("providerQuickSwitch.dragHandle")}
                    >
                      {(dragHandle) => (
                        <Group justify="space-between" wrap="nowrap" className="min-h-9 rounded-md px-2 py-1 hover:bg-gray-50">
                          <Group gap="xs" wrap="wrap">
                            <Text size="sm">{provider.name}</Text>
                            {!manualSwitch && provider.inFailoverQueue && (
                              <Badge color="green" variant="light" size="xs">#{(queuePosition.get(provider.id) ?? 0) + 1}</Badge>
                            )}
                            {provider.isCurrent && <Badge color="cliPrimary" variant="filled" size="sm" fw={700}>{t("providerCatalog.failover.current")}</Badge>}
                            <Badge color={provider.inFailoverQueue ? "blue" : provider.ready ? "green" : "gray"} variant="light">
                              {provider.inFailoverQueue
                                ? t("providerCatalog.failover.inQueue")
                                : provider.ready
                                  ? t("providerCatalog.failover.ready")
                                  : t("providerCatalog.failover.notReady")}
                            </Badge>
                            <Badge color={circuitColor} variant="light">{circuitLabel}</Badge>
                          </Group>
                          <Group gap={2} wrap="nowrap">
                            {provider.inFailoverQueue && !manualSwitch && (
                              <>
                                <ActionIcon aria-label={t("providerCatalog.failover.moveUp", { name: provider.name })} variant="subtle" size="sm" disabled={busy || queuedProviders[0]?.id === provider.id} onClick={() => void moveQueuedProvider(provider.id, -1)}>
                                  <ArrowUp size={14} />
                                </ActionIcon>
                                <ActionIcon aria-label={t("providerCatalog.failover.moveDown", { name: provider.name })} variant="subtle" size="sm" disabled={busy || queuedProviders[queuedProviders.length - 1]?.id === provider.id} onClick={() => void moveQueuedProvider(provider.id, 1)}>
                                  <ArrowDown size={14} />
                                </ActionIcon>
                              </>
                            )}
                            {manualSwitch ? (
                              <Radio
                                aria-label={t("providerCatalog.failover.queueToggle", { name: provider.name })}
                                checked={provider.inFailoverQueue}
                                disabled={busy || !provider.ready}
                                onChange={() => void updateQueue(provider.id, true)}
                              />
                            ) : (
                              <Switch
                                aria-label={t("providerCatalog.failover.queueToggle", { name: provider.name })}
                                checked={provider.inFailoverQueue}
                                disabled={busy || !provider.ready}
                                onChange={(event) => void updateQueue(provider.id, event.currentTarget.checked)}
                              />
                            )}
                            {dragHandle}
                          </Group>
                        </Group>
                      )}
                    </SortableFailoverProviderRow>
                      );
                    })}
                  </Stack>
                </SortableContext>
              </DndContext>

              <Stack gap="xs">
                <Text fw={600} size="sm">{t("providerCatalog.failover.parameters")}</Text>
                <Group align="flex-end" wrap="wrap">
                  <NumberInput label={t("providerCatalog.failover.maxRetries")} min={0} max={32} value={configDraft?.maxRetries ?? failover.config.maxRetries} disabled={busy} onChange={(value) => updateConfigDraft("maxRetries", Math.max(0, Math.min(32, Math.round(typeof value === "number" ? value : Number(value) || 0))))} />
                  <NumberInput label={t("providerCatalog.failover.firstByteTimeout")} min={1} value={configDraft?.streamingFirstByteTimeout ?? failover.config.streamingFirstByteTimeout} disabled={busy} onChange={(value) => updateConfigDraft("streamingFirstByteTimeout", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))} />
                  <NumberInput label={t("providerCatalog.failover.idleTimeout")} min={1} value={configDraft?.streamingIdleTimeout ?? failover.config.streamingIdleTimeout} disabled={busy} onChange={(value) => updateConfigDraft("streamingIdleTimeout", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))} />
                  <NumberInput label={t("providerCatalog.failover.nonStreamingTimeout")} min={1} value={configDraft?.nonStreamingTimeout ?? failover.config.nonStreamingTimeout} disabled={busy} onChange={(value) => updateConfigDraft("nonStreamingTimeout", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))} />
                </Group>
                <Group align="flex-end" wrap="wrap">
                  <NumberInput label={t("providerCatalog.failover.failureThreshold")} min={1} value={configDraft?.circuitFailureThreshold ?? failover.config.circuitFailureThreshold} disabled={busy} onChange={(value) => updateConfigDraft("circuitFailureThreshold", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))} />
                  <NumberInput label={t("providerCatalog.failover.successThreshold")} min={1} value={configDraft?.circuitSuccessThreshold ?? failover.config.circuitSuccessThreshold} disabled={busy} onChange={(value) => updateConfigDraft("circuitSuccessThreshold", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))} />
                  <NumberInput label={t("providerCatalog.failover.circuitTimeout")} min={1} value={configDraft?.circuitTimeoutSeconds ?? failover.config.circuitTimeoutSeconds} disabled={busy} onChange={(value) => updateConfigDraft("circuitTimeoutSeconds", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))} />
                  <NumberInput label={t("providerCatalog.failover.errorRateThreshold")} min={0} max={1} step={0.05} value={configDraft?.circuitErrorRateThreshold ?? failover.config.circuitErrorRateThreshold} disabled={busy} onChange={(value) => updateConfigDraft("circuitErrorRateThreshold", Math.max(0, Math.min(1, typeof value === "number" ? value : Number(value) || 0)))} />
                  <NumberInput label={t("providerCatalog.failover.minRequests")} min={1} value={configDraft?.circuitMinRequests ?? failover.config.circuitMinRequests} disabled={busy} onChange={(value) => updateConfigDraft("circuitMinRequests", Math.max(1, Math.round(typeof value === "number" ? value : Number(value) || 1)))} />
                </Group>
                <Group gap="xs">
                  <Button variant="light" leftSection={<Save size={15} />} loading={state.action === "failover-config"} disabled={busy || !configDirty} onClick={() => void saveConfig()}>{t("providerCatalog.failover.save")}</Button>
                  <Button variant="subtle" leftSection={<RotateCcw size={15} />} disabled={busy || !configDirty} onClick={resetConfigDraft}>{t("providerCatalog.failover.reset")}</Button>
                </Group>
              </Stack>

              <Button
                variant="light"
                leftSection={<RotateCcw size={15} />}
                loading={state.action === "circuit-reset"}
                disabled={busy || !runtimeAvailable}
                onClick={() => void state.resetCircuit(appType)}
              >
                {t("providerCatalog.failover.resetCircuit")}
              </Button>
              <Text size="xs" c="dimmed">{t("providerCatalog.failover.resetCircuitDescription")}</Text>
            </>
          ) : null}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}
