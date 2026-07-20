import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ActionIcon, Badge, Box, Button, Card, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { ArrowDown, ArrowUp, Check, GripVertical, Plus, Save, X } from "lucide-react";
import { toast } from "sonner";
import { pickByLanguage, type AppLanguage, useI18n } from "@/lib/i18n";
import { useSettingsStore } from "@/stores/settingsStore";
import { StatuslinePreview, type StatuslinePreviewState } from "./StatuslinePreview";
import { StatuslineProfileBar } from "@/components/settings/StatuslineProfileBar";
import { useStatuslineProfiles, type StatuslineProfileState } from "@/lib/statuslineProfiles";

interface CodexStatuslineConfig {
  configDir: string;
  configPath: string;
  items: string[];
}

interface ItemDefinition {
  id: string;
  zh: string;
  en: string;
  preview: string;
}

const ITEMS: ItemDefinition[] = [
  { id: "app-name", zh: "应用名称", en: "App name", preview: "codex" },
  { id: "project-name", zh: "项目名称", en: "Project name", preview: "CLI-Manager" },
  { id: "current-dir", zh: "当前目录", en: "Current directory", preview: "D:\\work\\pythonProject\\CLI-Manager" },
  { id: "status", zh: "运行状态", en: "Run status", preview: "Starting" },
  { id: "thread-title", zh: "会话标题", en: "Thread title", preview: "statusline editor" },
  { id: "git-branch", zh: "Git 分支", en: "Git branch", preview: "feature/statusline" },
  { id: "pull-request-number", zh: "PR 编号", en: "Pull request", preview: "PR #123" },
  { id: "branch-changes", zh: "分支变更", en: "Branch changes", preview: "+12 -3" },
  { id: "permissions", zh: "权限模式", en: "Permissions", preview: "Workspace" },
  { id: "approval-mode", zh: "审批模式", en: "Approval mode", preview: "on-request" },
  { id: "context-remaining", zh: "剩余上下文", en: "Context remaining", preview: "Context 68% left" },
  { id: "context-used", zh: "已用上下文", en: "Context used", preview: "Context 32% used" },
  { id: "five-hour-limit", zh: "5 小时额度", en: "5-hour limit", preview: "5h 72%" },
  { id: "weekly-limit", zh: "周额度", en: "Weekly limit", preview: "weekly 64%" },
  { id: "codex-version", zh: "Codex 版本", en: "Codex version", preview: "0.1.0" },
  { id: "context-window-size", zh: "上下文窗口", en: "Context window", preview: "258K window" },
  { id: "used-tokens", zh: "已用 Token", en: "Used tokens", preview: "38.2K used" },
  { id: "total-input-tokens", zh: "输入 Token", en: "Input tokens", preview: "31.4K in" },
  { id: "total-output-tokens", zh: "输出 Token", en: "Output tokens", preview: "6.8K out" },
  { id: "session-id", zh: "会话 ID", en: "Session ID", preview: "019f55fc-927f-70c2-b63b-49ec0d9272d3" },
  { id: "fast-mode", zh: "快速模式", en: "Fast mode", preview: "Fast off" },
  { id: "raw-output", zh: "原始输出模式", en: "Raw output", preview: "raw output" },
  { id: "model", zh: "模型", en: "Model", preview: "gpt-5.6-sol" },
  { id: "model-with-reasoning", zh: "模型与推理等级", en: "Model and reasoning", preview: "gpt-5.6-sol medium" },
  { id: "task-progress", zh: "任务进度", en: "Task progress", preview: "Tasks 3/5" },
];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function codexAnsiCode(id: string) {
  if (id === "app-name" || id === "project-name" || id === "current-dir") return 93;
  if (id === "model" || id === "model-with-reasoning") return 92;
  if (id === "session-id" || id === "codex-version") return 90;
  if (id === "context-remaining" || id === "context-used" || id === "context-window-size"
    || id === "used-tokens" || id === "total-input-tokens" || id === "total-output-tokens") return 95;
  if (id === "five-hour-limit" || id === "weekly-limit") return 96;
  if (id === "git-branch" || id === "pull-request-number" || id === "branch-changes") return 33;
  if (id === "permissions" || id === "approval-mode") return 36;
  if (id === "task-progress") return 32;
  return 35;
}

function buildCodexPreview(items: string[], definitions: Map<string, ItemDefinition>, language: AppLanguage) {
  return items.map((id) => {
    const definition = definitions.get(id);
    const value = definition?.preview ?? id;
    const label = definition ? pickByLanguage(language, definition.zh, definition.en) : id;
    return `\x1b[${codexAnsiCode(id)}m${label}: ${value}\x1b[0m`;
  }).join("\x1b[90m · \x1b[0m");
}

function SortableCodexItem({ id, children }: { id: string; children: (dragHandle: ReactNode) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <Group
      ref={setNodeRef}
      justify="space-between"
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, zIndex: isDragging ? 2 : undefined }}
      className="ui-interactive rounded-md border border-border bg-surface-container-low px-2 py-1.5"
    >
      {children(<span {...attributes} {...listeners} className="inline-flex cursor-grab touch-none active:cursor-grabbing"><GripVertical size={15} color="var(--on-surface-variant)" /></span>)}
    </Group>
  );
}

export function CodexStatuslineEditor({
  searchValue,
  previewState,
  onPreviewStateChange,
  reloadToken,
}: {
  searchValue: string;
  previewState: StatuslinePreviewState;
  onPreviewStateChange: (state: StatuslinePreviewState) => void;
  reloadToken: number;
}) {
  const { language, t } = useI18n();
  const codexConfigDir = useSettingsStore((state) => state.codexHookConfigDir);
  const [config, setConfig] = useState<CodexStatuslineConfig | null>(null);
  const [items, setItems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedItems, setSavedItems] = useState<string[]>([]);
  const profiles = useStatuslineProfiles<string[]>({ tool: "codex", configDir: codexConfigDir ?? undefined });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const applyProfileState = useCallback((next: StatuslineProfileState<string[]>) => {
    const active = next.profiles.find((profile) => profile.id === next.activeProfileId);
    if (!active) throw new Error("statusline_profiles_invalid_active");
    setItems(active.payload);
    setSavedItems(active.payload);
  }, []);

  const load = useCallback(async () => {
    const [nextConfig, nextProfiles] = await Promise.all([
      invoke<CodexStatuslineConfig>("codex_statusline_load", { configDir: codexConfigDir ?? undefined }),
      profiles.load(),
    ]);
    setConfig(nextConfig);
    applyProfileState(nextProfiles);
  }, [applyProfileState, codexConfigDir, profiles.load]);

  useEffect(() => {
    load().catch((error) => toast.error(t("settings.codexStatusline.loadFailed"), { description: errorMessage(error) }));
  }, [load, reloadToken, t]);

  const definitions = useMemo(() => new Map(ITEMS.map((item) => [item.id, item])), []);
  const preview = buildCodexPreview(items, definitions, language);
  const dirty = items.join("\u0000") !== savedItems.join("\u0000");
  const filteredItems = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    if (!query) return ITEMS;
    return ITEMS.filter((item) => `${item.id} ${item.zh} ${item.en}`.toLowerCase().includes(query));
  }, [searchValue]);

  const toggle = (id: string) => {
    setItems((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const move = (index: number, offset: -1 | 1) => {
    setItems((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setItems((current) => {
      const from = current.indexOf(String(active.id));
      const to = current.indexOf(String(over.id));
      return from < 0 || to < 0 ? current : arrayMove(current, from, to);
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      if (!profiles.state) return;
      const next = await profiles.save(profiles.state.activeProfileId, items);
      applyProfileState(next);
      toast.success(t("settings.codexStatusline.saved"));
    } catch (error) {
      toast.error(t("settings.codexStatusline.saveFailed"), { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap="md">
      <Card className="border border-border bg-surface-container-low" radius="lg" p="md">
        <StatuslineProfileBar
          state={profiles.state}
          dirty={dirty}
          busy={saving}
          onSave={save}
          onCreate={async (name) => applyProfileState(await profiles.create(name, items))}
          onSwitch={async (profileId) => applyProfileState(await profiles.switchProfile(profileId))}
          onRename={async (profileId, name) => applyProfileState(await profiles.rename(profileId, name))}
          onDuplicate={async (profileId, name) => applyProfileState(await profiles.duplicate(profileId, name))}
          onDelete={async (profileId) => applyProfileState(await profiles.remove(profileId))}
          onCaptureExternal={async (name) => applyProfileState(await profiles.captureExternal(name))}
        />
      </Card>
      <Card className="border border-border bg-surface-container-low" radius="lg" p="md">
      <Group justify="space-between" align="flex-start">
        <Box>
          <Group gap="xs"><Text fw={600}>{t("settings.codexStatusline.title")}</Text><Badge color="green">{t("settings.codexStatusline.native")}</Badge></Group>
          <Text size="xs" c="var(--on-surface-variant)" mt={4}>{config?.configPath ?? t("settings.codexStatusline.loading")}</Text>
        </Box>
        <Group gap="xs">
          {dirty && <Badge color="yellow" variant="light">{t("settings.statusline.unsaved")}</Badge>}
          <Button leftSection={<Save size={16} />} onClick={save} loading={saving} disabled={!dirty}>{t("settings.codexStatusline.save")}</Button>
        </Group>
      </Group>

      <Box mt="md">
        <StatuslinePreview
          text={preview}
          state={previewState}
          onChange={onPreviewStateChange}
          emptyText={t("settings.codexStatusline.previewEmpty")}
          ariaLabel={t("settings.statusline.codexPreviewAria")}
          variant="codex-footer"
        />
      </Box>

      <Box mt="md" className="grid gap-4 lg:grid-cols-[minmax(300px,0.9fr)_minmax(420px,1.1fr)]">
        <section className="rounded-xl border border-border bg-surface-container-lowest p-3">
          <Text size="sm" fw={600} mb="xs">{t("settings.codexStatusline.selected")}</Text>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={items} strategy={verticalListSortingStrategy}>
              <Stack gap={6} mah={500} className="overflow-y-auto pr-1">
                {items.map((id, index) => {
                  const definition = definitions.get(id);
                  return (
                    <SortableCodexItem key={id} id={id}>{(dragHandle) => <>
                      <Group gap="xs" wrap="nowrap">{dragHandle}<Box><Text size="sm">{definition ? pickByLanguage(language, definition.zh, definition.en) : id}</Text><Text size="xs" c="var(--on-surface-variant)">{id}</Text></Box></Group>
                      <Group gap={4}>
                        <ActionIcon variant="subtle" disabled={index === 0} onClick={() => move(index, -1)} aria-label={t("settings.codexStatusline.moveUp")}><ArrowUp size={15} /></ActionIcon>
                        <ActionIcon variant="subtle" disabled={index === items.length - 1} onClick={() => move(index, 1)} aria-label={t("settings.codexStatusline.moveDown")}><ArrowDown size={15} /></ActionIcon>
                        <ActionIcon color="red" variant="subtle" onClick={() => toggle(id)} aria-label={t("settings.codexStatusline.remove")}><X size={15} /></ActionIcon>
                      </Group>
                    </>}</SortableCodexItem>
                  );
                })}
                {items.length === 0 && <Text size="sm" c="var(--on-surface-variant)">{t("settings.codexStatusline.empty")}</Text>}
              </Stack>
            </SortableContext>
          </DndContext>
        </section>

        <section className="rounded-xl border border-border bg-surface-container-lowest p-3">
          <Text size="sm" fw={600} mb="xs">{t("settings.codexStatusline.available")}</Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs" mah={500} className="overflow-y-auto pr-1">
            {filteredItems.map((item) => {
              const selected = items.includes(item.id);
              return <Button key={item.id} variant={selected ? "light" : "subtle"} color={selected ? "green" : "gray"} justify="space-between" rightSection={selected ? <Check size={14} /> : <Plus size={14} />} onClick={() => toggle(item.id)}>{pickByLanguage(language, item.zh, item.en)}</Button>;
            })}
          </SimpleGrid>
        </section>
      </Box>

      </Card>
    </Stack>
  );
}
