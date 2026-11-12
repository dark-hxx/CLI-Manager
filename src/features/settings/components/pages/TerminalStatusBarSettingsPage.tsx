import { ActionIcon, Badge, Button, Card, Group, Stack, Switch, Text, Tooltip } from "@mantine/core";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { SettingsRow, SettingsSection } from "../SettingsPrimitives";
import {
  TERMINAL_STATUS_BAR_ITEM_KEYS,
  useSettingsStore,
  type TerminalStatusBarItemKey,
} from "../../../../shared/preferences/settingsStore";
import { useI18n } from "../../../../shared/i18n/index";
import { DND_ACTIVATION_CONSTRAINT, DND_SORTABLE_TRANSITION } from "../../../workspace/api/dragInteraction";
import { TERMINAL_STATUS_BAR_ITEM_META } from "../../../terminal/lib/terminalStatusBarItems";

function SortableStatusBarItemRow({
  id,
  dragLabel,
  children,
  actions,
}: {
  id: TerminalStatusBarItemKey;
  dragLabel: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    transition: DND_SORTABLE_TRANSITION,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0.55 : 1,
    position: "relative",
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
        <Group justify="space-between" align="center" gap="md" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <Tooltip label={dragLabel} withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={dragLabel}
                style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
                {...attributes}
                {...listeners}
              >
                <GripVertical size={14} />
              </ActionIcon>
            </Tooltip>
            {children}
          </Group>
          {actions}
        </Group>
      </Card>
    </div>
  );
}

export function TerminalStatusBarSettingsPage() {
  const { t } = useI18n();
  const enabled = useSettingsStore((s) => s.terminalStatusBarEnabled);
  const order = useSettingsStore((s) => s.terminalStatusBarOrder);
  const visibility = useSettingsStore((s) => s.terminalStatusBarVisibility);
  const update = useSettingsStore((s) => s.update);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: DND_ACTIVATION_CONSTRAINT }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = order.indexOf(String(active.id) as TerminalStatusBarItemKey);
    const newIndex = order.indexOf(String(over.id) as TerminalStatusBarItemKey);
    if (oldIndex === -1 || newIndex === -1) return;
    void update("terminalStatusBarOrder", arrayMove(order, oldIndex, newIndex));
  };

  const moveItem = (key: TerminalStatusBarItemKey, offset: -1 | 1) => {
    const index = order.indexOf(key);
    const targetIndex = index + offset;
    if (index < 0 || targetIndex < 0 || targetIndex >= order.length) return;
    const nextOrder = [...order];
    [nextOrder[index], nextOrder[targetIndex]] = [nextOrder[targetIndex], nextOrder[index]];
    void update("terminalStatusBarOrder", nextOrder);
  };

  const visibleCount = order.filter((key) => visibility[key]).length;

  return (
    <Stack gap="md">
      <SettingsSection title={t("settings.tabs.terminalStatusBar.title")}>
        <SettingsRow
          title={t("settings.terminalStatusBar.enable")}
          description={t("settings.terminalStatusBar.enableDescription")}
        >
          <Switch
            color="cliPrimary"
            checked={enabled}
            onChange={(event) => void update("terminalStatusBarEnabled", event.currentTarget.checked)}
            aria-label={t("settings.terminalStatusBar.enable")}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title={t("settings.terminalStatusBar.items")}
        description={t("settings.terminalStatusBar.itemsDescription")}
        actions={(
          <Badge variant="light" color="cliPrimary">
            {visibleCount} / {TERMINAL_STATUS_BAR_ITEM_KEYS.length}
          </Badge>
        )}
      >
        <Stack gap="sm" style={{ opacity: enabled ? 1 : 0.6 }}>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={[...order]} strategy={verticalListSortingStrategy}>
              <Stack gap="xs">
                {order.map((key, index) => {
                  const meta = TERMINAL_STATUS_BAR_ITEM_META[key];
                  const Icon = meta.icon;
                  const label = t(meta.labelKey);
                  return (
                    <SortableStatusBarItemRow
                      key={key}
                      id={key}
                      dragLabel={t("settings.terminalStatusBar.dragHandle")}
                      actions={(
                        <Group gap="xs" wrap="nowrap">
                          <Text size="xs" c="var(--on-surface-variant)" ff="monospace" visibleFrom="sm">
                            {meta.sample}
                          </Text>
                          <Group gap={4} wrap="nowrap">
                            <Tooltip label={t("settings.terminalStatusBar.moveUp")} withArrow>
                              <ActionIcon
                                variant="subtle"
                                color="cliPrimary"
                                size="sm"
                                disabled={index === 0}
                                onClick={() => moveItem(key, -1)}
                                aria-label={`${t("settings.terminalStatusBar.moveUp")} ${label}`}
                              >
                                <ArrowUp size={14} />
                              </ActionIcon>
                            </Tooltip>
                            <Tooltip label={t("settings.terminalStatusBar.moveDown")} withArrow>
                              <ActionIcon
                                variant="subtle"
                                color="cliPrimary"
                                size="sm"
                                disabled={index === order.length - 1}
                                onClick={() => moveItem(key, 1)}
                                aria-label={`${t("settings.terminalStatusBar.moveDown")} ${label}`}
                              >
                                <ArrowDown size={14} />
                              </ActionIcon>
                            </Tooltip>
                          </Group>
                          <Switch
                            color="cliPrimary"
                            checked={visibility[key]}
                            onChange={(event) => void update("terminalStatusBarVisibility", {
                              ...visibility,
                              [key]: event.currentTarget.checked,
                            })}
                            aria-label={label}
                          />
                        </Group>
                      )}
                    >
                      <Icon size={14} aria-hidden="true" style={{ flexShrink: 0, color: "var(--primary)" }} />
                      <Stack gap={0} style={{ minWidth: 0 }}>
                        <Group gap={6} wrap="nowrap">
                          <Text size="sm" c="var(--on-surface)">{label}</Text>
                          <Badge size="xs" variant="light" color={meta.group === "ai" ? "violet" : "gray"}>
                            {t(meta.group === "ai" ? "terminalStatusBar.group.ai" : "terminalStatusBar.group.system")}
                          </Badge>
                        </Group>
                        <Text size="xs" c="var(--on-surface-variant)" truncate>
                          {t(meta.descriptionKey)}
                        </Text>
                      </Stack>
                    </SortableStatusBarItemRow>
                  );
                })}
              </Stack>
            </SortableContext>
          </DndContext>
          <Group justify="flex-end">
            <Button
              variant="subtle"
              size="xs"
              onClick={() => void update("terminalStatusBarOrder", [...TERMINAL_STATUS_BAR_ITEM_KEYS])}
            >
              {t("settings.terminalStatusBar.resetOrder")}
            </Button>
          </Group>
        </Stack>
      </SettingsSection>
    </Stack>
  );
}
