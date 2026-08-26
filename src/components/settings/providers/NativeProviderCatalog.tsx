import { Group, Loader, Stack, Text } from "@mantine/core";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { FileDown, Plus, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { useI18n } from "@/lib/i18n";
import { DND_ACTIVATION_CONSTRAINT } from "@/lib/dragInteraction";
import { NativeProviderButton as Button } from "./NativeProviderButton";
import { NativeProviderCard } from "./NativeProviderCard";
import type { NativeProviderCard as NativeProviderCardData, NativeProviderFailoverState } from "./nativeProviderTypes";

interface NativeProviderCatalogProps {
  providers: NativeProviderCardData[];
  allProviders: NativeProviderCardData[];
  failover: NativeProviderFailoverState | null;
  failoverBusy: boolean;
  selectedProviderId: string | null;
  loading: boolean;
  hasSearchQuery: boolean;
  busy: boolean;
  onSelect: (providerId: string) => void;
  onCreate: () => void;
  onOpenImport: () => void;
  onRefresh: () => void;
  onDuplicate: (providerId: string) => void;
  onDelete: (providerId: string) => void;
  onEnabledChange: (providerId: string, enabled: boolean) => void;
  onFailoverQueueChange: (providerId: string, enabled: boolean) => void;
  onReorder: (providerIds: string[]) => void;
}

export function NativeProviderCatalog({
  providers,
  allProviders,
  failover,
  failoverBusy,
  selectedProviderId,
  loading,
  hasSearchQuery,
  busy,
  onSelect,
  onCreate,
  onOpenImport,
  onRefresh,
  onDuplicate,
  onDelete,
  onEnabledChange,
  onFailoverQueueChange,
  onReorder,
}: NativeProviderCatalogProps) {
  const { t } = useI18n();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: DND_ACTIVATION_CONSTRAINT }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // 搜索过滤时禁用拖拽：后端 provider_catalog_reorder 要求提交该 appType 的全量 ID，
  // 在过滤后的子集上拖拽无法安全推导全量顺序。
  const canReorder = allProviders.length > 1 && !busy && !failoverBusy && !hasSearchQuery;
  const failoverById = useMemo(
    () => new Map(failover?.providers.map((provider) => [provider.id, provider]) ?? []),
    [failover],
  );
  const queuedIds = useMemo(
    () => allProviders
      .filter((provider) => failoverById.get(provider.id)?.inFailoverQueue)
      .map((provider) => provider.id),
    [allProviders, failoverById],
  );
  const queuePosition = useMemo(
    () => new Map(queuedIds.map((providerId, index) => [providerId, index])),
    [queuedIds],
  );

  const moveProvider = (providerId: string, offset: number) => {
    const ids = allProviders.map((provider) => provider.id);
    const sourceIndex = ids.indexOf(providerId);
    const targetIndex = sourceIndex + offset;
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= ids.length) return;
    onReorder(arrayMove(ids, sourceIndex, targetIndex));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = allProviders.map((provider) => provider.id);
    const sourceIndex = ids.indexOf(String(active.id));
    const targetIndex = ids.indexOf(String(over.id));
    if (sourceIndex < 0 || targetIndex < 0) return;
    onReorder(arrayMove(ids, sourceIndex, targetIndex));
  };

  const moveFailoverProvider = (providerId: string, offset: number) => {
    const sourceIndex = queuedIds.indexOf(providerId);
    const targetIndex = sourceIndex + offset;
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= queuedIds.length) return;
    const nextQueued = arrayMove(queuedIds, sourceIndex, targetIndex);
    const queued = new Set(nextQueued);
    onReorder([
      ...nextQueued,
      ...allProviders.filter((provider) => !queued.has(provider.id)).map((provider) => provider.id),
    ]);
  };

  return (
    <Stack gap="xs" className="min-w-0">
      <Group justify="space-between" align="center" wrap="wrap" gap="xs">
        <Text size="sm" c="dimmed">
          {t("providerCatalog.countSummary", { count: allProviders.length })}
        </Text>
        <Group gap={4}>
          <Button
            size="compact-sm"
            variant="subtle"
            color="gray"
            leftSection={<FileDown size={15} />}
            onClick={onOpenImport}
          >
            {t("providerCatalog.import.open")}
          </Button>
          <Button
            size="compact-sm"
            variant="subtle"
            color="gray"
            loading={loading}
            aria-label={t("common.refresh")}
            onClick={onRefresh}
          >
            <RefreshCw size={15} />
          </Button>
          <Button size="compact-sm" color="cliPrimary" leftSection={<Plus size={15} />} onClick={onCreate}>
            {t("providerCatalog.add")}
          </Button>
        </Group>
      </Group>

      {loading && providers.length === 0 ? (
        <Stack align="center" justify="center" gap="xs" py="xl">
          <Loader size="sm" color="cliPrimary" />
          <Text size="sm" c="dimmed">{t("providerCatalog.loading")}</Text>
        </Stack>
      ) : providers.length === 0 ? (
        <Stack align="center" justify="center" gap="xs" py="xl" px="md" className="text-center">
          <Text fw={600}>{t(hasSearchQuery ? "providerCatalog.noSearchResults" : "providerCatalog.emptyTitle")}</Text>
          <Text size="sm" c="dimmed">
            {t(hasSearchQuery ? "providerCatalog.noSearchResultsDescription" : "providerCatalog.emptyDescription")}
          </Text>
          {!hasSearchQuery && (
            <Button size="compact-sm" color="cliPrimary" leftSection={<Plus size={15} />} onClick={onCreate}>
              {t("providerCatalog.add")}
            </Button>
          )}
        </Stack>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={providers.map((provider) => provider.id)} strategy={verticalListSortingStrategy}>
            <Stack gap={6} className="min-w-0">
              {providers.map((provider) => (
                <NativeProviderCard
                  key={provider.id}
                  provider={provider}
                  selected={provider.id === selectedProviderId}
                  busy={busy || failoverBusy}
                  canReorder={canReorder}
                  failover={failover ? {
                    provider: failoverById.get(provider.id) ?? null,
                    position: queuePosition.get(provider.id) ?? null,
                    busy: failoverBusy,
                    isFirst: queuedIds[0] === provider.id,
                    isLast: queuedIds[queuedIds.length - 1] === provider.id,
                  } : null}
                  isFirst={allProviders[0]?.id === provider.id}
                  isLast={allProviders[allProviders.length - 1]?.id === provider.id}
                  onSelect={() => onSelect(provider.id)}
                  onDuplicate={() => onDuplicate(provider.id)}
                  onDelete={() => onDelete(provider.id)}
                  onEnabledChange={(enabled) => onEnabledChange(provider.id, enabled)}
                  onFailoverQueueChange={(enabled) => onFailoverQueueChange(provider.id, enabled)}
                  onFailoverMoveUp={() => moveFailoverProvider(provider.id, -1)}
                  onFailoverMoveDown={() => moveFailoverProvider(provider.id, 1)}
                  onMoveUp={() => moveProvider(provider.id, -1)}
                  onMoveDown={() => moveProvider(provider.id, 1)}
                />
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      )}
    </Stack>
  );
}
