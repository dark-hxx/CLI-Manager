import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import { Accordion, ActionIcon, Badge, Box, Button, Card, Checkbox, ColorSwatch, Group, NumberInput, ScrollArea, SegmentedControl, Select, Stack, Switch, Text, TextInput } from "@mantine/core";
import { Bot, Braces, Download, GripVertical, Plus, RefreshCw, Save, Trash2, Upload } from "lucide-react";
import { pickByLanguage, useI18n } from "@/lib/i18n";
import { normalizeTerminalFontFamily } from "@/lib/terminalFontFamily";
import {
  STATUSLINE_PREVIEW_PAYLOAD,
  type StatuslineCatalogEntry,
  type StatuslineSettings,
  type StatuslineStatus,
  type StatuslineWidget,
} from "@/lib/statusline";
import { CodexStatuslineEditor } from "./CodexStatuslineEditor";
import { StatuslinePreview, type StatuslinePreviewState } from "./StatuslinePreview";
import { useSettingsStore, type StatuslineEditorSource } from "@/stores/settingsStore";
import { SettingsListItem } from "@/components/settings/SettingsListItem";
import { StatuslineProfileBar } from "@/components/settings/StatuslineProfileBar";
import { useStatuslineProfiles, type StatuslineImportAnalysis, type StatuslineImportDecision, type StatuslineProfileState } from "@/lib/statuslineProfiles";
import { useAppPrompt } from "@/components/ui/useAppPrompt";
import { useAppConfirm } from "@/components/ui/useAppConfirm";

const COLOR_DEFINITIONS = [
  ["", "默认 (Default)", "transparent"], ["black", "黑色 (Black)", "#000000"], ["red", "红色 (Red)", "#cc0000"],
  ["green", "绿色 (Green)", "#4e9a06"], ["yellow", "黄色 (Yellow)", "#c4a000"], ["blue", "蓝色 (Blue)", "#3465a4"],
  ["magenta", "品红 (Magenta)", "#75507b"], ["cyan", "青色 (Cyan)", "#06989a"], ["white", "白色 (White)", "#d3d7cf"],
  ["brightBlack", "亮黑色 (Bright Black)", "#555753"], ["brightRed", "亮红色 (Bright Red)", "#ef2929"],
  ["brightGreen", "亮绿色 (Bright Green)", "#8ae234"], ["brightYellow", "亮黄色 (Bright Yellow)", "#fce94f"],
  ["brightBlue", "亮蓝色 (Bright Blue)", "#729fcf"], ["brightMagenta", "亮品红 (Bright Magenta)", "#ad7fa8"],
  ["brightCyan", "亮青色 (Bright Cyan)", "#34e2e2"], ["brightWhite", "亮白色 (Bright White)", "#eeeeec"],
] as const;
const COLOR_OPTIONS = COLOR_DEFINITIONS.map(([value, label]) => ({ value, label }));
const COLOR_SWATCHES = new Map<string, string>(COLOR_DEFINITIONS.map(([value, , color]) => [value, color]));
const CATEGORY_ORDER = ["core", "git", "jj", "tokens", "context", "session", "environment", "custom", "layout"];
const POWERLINE_THEMES = ["custom", "nord", "nord-aurora", "monokai", "solarized", "minimal", "dracula", "catppuccin", "gruvbox", "onedark", "tokyonight"].map((value) => ({ value, label: value === "custom" ? "Custom" : value.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ").replace("Onedark", "One Dark").replace("Tokyonight", "Tokyo Night") }));
const POWERLINE_SEPARATORS = [{ value: "\ue0b0", label: " 右三角 (Right Triangle)" }, { value: "\ue0b2", label: " 左三角 (Left Triangle)" }, { value: "\ue0b4", label: " 右圆弧 (Right Round)" }, { value: "\ue0b6", label: " 左圆弧 (Left Round)" }];
const POWERLINE_START_CAPS = [{ value: "", label: "无 (None)" }, { value: "\ue0b2", label: " 三角 (Triangle)" }, { value: "\ue0b6", label: " 圆弧 (Round)" }, { value: "\ue0ba", label: " 下三角 (Lower Triangle)" }, { value: "\ue0be", label: " 斜线 (Diagonal)" }];
const POWERLINE_END_CAPS = [{ value: "", label: "无 (None)" }, { value: "\ue0b0", label: " 三角 (Triangle)" }, { value: "\ue0b4", label: " 圆弧 (Round)" }, { value: "\ue0b8", label: " 下三角 (Lower Triangle)" }, { value: "\ue0bc", label: " 斜线 (Diagonal)" }];
const POWERLINE_SELECT_CLASS_NAMES = { input: "ui-statusline-powerline-select-input" } as const;

interface PowerlineFontStatus { installed: boolean; checkedSymbol: string; matchedFont: string | null }
interface PowerlineFontInstallResult { success: boolean; message: string; installedCount: number }

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function nextWidgetId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const renderColorOption = ({ option }: { option: { value: string; label: string } }) => (
  <Group gap="xs" wrap="nowrap">
    <ColorSwatch size={16} color={COLOR_SWATCHES.get(option.value) ?? "transparent"} withShadow={option.value !== ""} />
    <Text size="sm">{option.label}</Text>
  </Group>
);

function SortableWidgetChip({
  item,
  label,
  selected,
  removeLabel,
  onSelect,
  onRemove,
}: {
  item: StatuslineWidget;
  label: string;
  selected: boolean;
  removeLabel: string;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  return (
    <Box
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, zIndex: isDragging ? 2 : undefined }}
      onClick={(event) => { event.stopPropagation(); onSelect(); }}
      className={`rounded-lg border px-2 py-1.5 ${selected ? "border-[var(--interactive-selected-border)] bg-[var(--interactive-selected-bg)]" : "border-border bg-surface-container"}`}
    >
      <Group gap={4} wrap="nowrap">
        <span {...attributes} {...listeners} className="inline-flex cursor-grab touch-none active:cursor-grabbing" aria-label={label}>
          <GripVertical size={13} />
        </span>
        <Text size="xs">{label}</Text>
        <ActionIcon size="sm" variant="subtle" color="red" aria-label={removeLabel} onClick={(event) => { event.stopPropagation(); onRemove(); }}><Trash2 size={13} /></ActionIcon>
      </Group>
    </Box>
  );
}

function CatalogWidgetItem({
  entry,
  title,
  ariaLabel,
  onAdd,
}: {
  entry: StatuslineCatalogEntry;
  title: string;
  ariaLabel: string;
  onAdd: () => void;
}) {
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: `statusline-catalog-${entry.widgetType}`,
    data: { source: "catalog", widgetType: entry.widgetType },
  });
  return (
    <Box ref={setNodeRef} {...listeners} className="cursor-grab touch-none active:cursor-grabbing" style={{ opacity: isDragging ? 0.35 : 1 }}>
      <SettingsListItem
        title={title}
        subtitle={entry.widgetType}
        subtitleMonospace
        rightSection={<Group gap={4} wrap="nowrap"><Plus size={14} style={{ color: "var(--text-muted)" }} /><GripVertical size={14} style={{ color: "var(--text-muted)" }} /></Group>}
        onClick={onAdd}
        ariaLabel={ariaLabel}
      />
    </Box>
  );
}

function StatuslineLayoutLine({ lineIndex, itemIds, active, children, onClick }: { lineIndex: number; itemIds: string[]; active: boolean; children: ReactNode; onClick: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `statusline-line-${lineIndex}` });
  return (
    <Box
      ref={setNodeRef}
      className={`min-h-20 rounded-xl border border-dashed bg-surface-container-lowest p-2.5 transition-colors ${active || isOver ? "border-[var(--interactive-selected-border)] ring-1 ring-inset ring-[var(--interactive-selected-border)]" : "border-border"}`}
      onClick={onClick}
    >
      <SortableContext items={itemIds} strategy={horizontalListSortingStrategy}>
        {children}
      </SortableContext>
    </Box>
  );
}

function ClaudeStatuslineEditor({
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
  const { confirm, confirmDialog } = useAppConfirm();
  const terminalFontFamily = useSettingsStore((state) => state.fontFamily);
  const ccSwitchDbPath = useSettingsStore((state) => state.ccSwitchDbPath);
  const normalizedTerminalFontFamily = useMemo(() => normalizeTerminalFontFamily(terminalFontFamily), [terminalFontFamily]);
  const [settings, setSettings] = useState<StatuslineSettings | null>(null);
  const [status, setStatus] = useState<StatuslineStatus | null>(null);
  const [catalog, setCatalog] = useState<StatuslineCatalogEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [working, setWorking] = useState(false);
  const [activeLineIndex, setActiveLineIndex] = useState(0);
  const [draggingCatalogType, setDraggingCatalogType] = useState<string | null>(null);
  const [openedCategories, setOpenedCategories] = useState<string[]>(["core"]);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [fontStatus, setFontStatus] = useState<PowerlineFontStatus | null>(null);
  const [installingFonts, setInstallingFonts] = useState(false);
  const profiles = useStatuslineProfiles<StatuslineSettings>({ tool: "claude" });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const applyProfileState = useCallback((next: StatuslineProfileState<StatuslineSettings>) => {
    const active = next.profiles.find((profile) => profile.id === next.activeProfileId);
    if (!active) throw new Error("statusline_profiles_invalid_active");
    setSettings(active.payload);
    setSavedSnapshot(JSON.stringify(active.payload));
    setSelectedId(null);
  }, []);

  const refresh = useCallback(async () => {
    const [nextProfiles, nextStatus, nextCatalog, nextFontStatus] = await Promise.all([
      profiles.load(),
      invoke<StatuslineStatus>("statusline_get_status"),
      invoke<StatuslineCatalogEntry[]>("statusline_get_catalog"),
      invoke<PowerlineFontStatus>("statusline_powerline_font_status"),
    ]);
    applyProfileState(nextProfiles);
    setStatus(nextStatus);
    setCatalog(nextCatalog);
    setFontStatus(nextFontStatus);
  }, [applyProfileState, profiles.load]);

  useEffect(() => {
    refresh().catch((error) => toast.error(t("settings.statusline.loadFailed"), { description: errorMessage(error) }));
  }, [refresh, reloadToken, t]);

  useEffect(() => {
    if (!settings) return;
    const timer = window.setTimeout(() => {
      invoke<string>("statusline_render_preview", { settings, payload: STATUSLINE_PREVIEW_PAYLOAD, language })
        .then(setPreview)
        .catch((error) => setPreview(`${t("settings.statusline.previewFailed")}: ${errorMessage(error)}`));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [language, settings, t]);

  const selected = useMemo(() => {
    if (!settings || !selectedId) return null;
    for (let line = 0; line < settings.lines.length; line += 1) {
      const index = settings.lines[line].findIndex((item) => item.id === selectedId);
      if (index >= 0) return { line, index, widget: settings.lines[line][index] };
    }
    return null;
  }, [settings, selectedId]);
  const dirty = JSON.stringify(settings) !== savedSnapshot;

  const filteredCatalog = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    if (!query) return catalog;
    return catalog.filter((entry) => `${entry.widgetType} ${entry.zhName} ${entry.enName} ${entry.category}`.toLowerCase().includes(query));
  }, [catalog, searchValue]);
  const groupedCatalog = useMemo(() => {
    const groups = new Map<string, StatuslineCatalogEntry[]>();
    for (const entry of filteredCatalog) {
      const list = groups.get(entry.category) ?? [];
      list.push(entry);
      groups.set(entry.category, list);
    }
    return [...groups.entries()].sort(([left], [right]) => {
      const leftIndex = CATEGORY_ORDER.indexOf(left);
      const rightIndex = CATEGORY_ORDER.indexOf(right);
      return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex);
    });
  }, [filteredCatalog]);

  useEffect(() => {
    setOpenedCategories(searchValue.trim() ? groupedCatalog.map(([category]) => category) : ["core"]);
  }, [groupedCatalog, searchValue]);

  const categoryLabel = (category: string) => {
    const keys: Record<string, Parameters<typeof t>[0]> = {
      core: "settings.statusline.category.core",
      git: "settings.statusline.category.git",
      jj: "settings.statusline.category.jj",
      tokens: "settings.statusline.category.tokens",
      context: "settings.statusline.category.context",
      session: "settings.statusline.category.session",
      environment: "settings.statusline.category.environment",
      custom: "settings.statusline.category.custom",
      layout: "settings.statusline.category.layout",
    };
    return keys[category] ? t(keys[category]) : category;
  };

  const updateSettings = (updater: (current: StatuslineSettings) => StatuslineSettings) => {
    setSettings((current) => (current ? updater(current) : current));
  };

  const updateWidget = (patch: Partial<StatuslineWidget>) => {
    if (!selected) return;
    updateSettings((current) => ({ ...current, lines: current.lines.map((line, lineIndex) => lineIndex === selected.line ? line.map((widget, index) => index === selected.index ? { ...widget, ...patch } : widget) : line) }));
  };

  const addWidget = (type: string, targetLine = activeLineIndex, targetIndex?: number) => {
    const widget: StatuslineWidget = { id: nextWidgetId(), type };
    updateSettings((current) => ({
      ...current,
      lines: current.lines.map((line, index) => {
        if (index !== targetLine) return line;
        const insertAt = Math.min(Math.max(targetIndex ?? line.length, 0), line.length);
        return [...line.slice(0, insertAt), widget, ...line.slice(insertAt)];
      }),
    }));
    setActiveLineIndex(targetLine);
    setSelectedId(widget.id);
  };

  const removeWidget = (id: string) => {
    updateSettings((current) => ({ ...current, lines: current.lines.map((line) => line.filter((widget) => widget.id !== id)) }));
    if (selectedId === id) setSelectedId(null);
  };

  const removeSelected = () => {
    if (!selected) return;
    updateSettings((current) => ({ ...current, lines: current.lines.map((line, lineIndex) => lineIndex === selected.line ? line.filter((_, index) => index !== selected.index) : line) }));
    setSelectedId(null);
  };

  const moveWidget = (from: { line: number; index: number }, to: { line: number; index: number }) => {
    updateSettings((current) => {
      const lines = current.lines.map((line) => [...line]);
      if (from.line === to.line) {
        const [widget] = lines[from.line].splice(from.index, 1);
        lines[to.line].splice(to.index, 0, widget);
        return { ...current, lines };
      }
      const [widget] = lines[from.line].splice(from.index, 1);
      lines[to.line].splice(to.index, 0, widget);
      return { ...current, lines };
    });
  };

  const handleWidgetDragStart = ({ active }: DragStartEvent) => {
    const widgetType = active.data.current?.source === "catalog" ? active.data.current.widgetType : null;
    setDraggingCatalogType(typeof widgetType === "string" ? widgetType : null);
  };

  const handleWidgetDragEnd = ({ active, over }: DragEndEvent) => {
    setDraggingCatalogType(null);
    if (!over || !settings) return;
    const catalogType = active.data.current?.source === "catalog" && typeof active.data.current.widgetType === "string"
      ? active.data.current.widgetType
      : null;
    let from: { line: number; index: number } | null = null;
    let to: { line: number; index: number } | null = null;
    for (let lineIndex = 0; lineIndex < settings.lines.length; lineIndex += 1) {
      const fromIndex = settings.lines[lineIndex].findIndex((item) => item.id === active.id);
      if (fromIndex >= 0) from = { line: lineIndex, index: fromIndex };
      const toIndex = settings.lines[lineIndex].findIndex((item) => item.id === over.id);
      if (toIndex >= 0) to = { line: lineIndex, index: toIndex };
      if (over.id === `statusline-line-${lineIndex}`) to = { line: lineIndex, index: settings.lines[lineIndex].length };
    }
    if (!to) return;
    if (catalogType) {
      addWidget(catalogType, to.line, to.index);
      return;
    }
    if (active.id === over.id || !from) return;
    moveWidget(from, to);
    setActiveLineIndex(to.line);
  };

  const moveSelectedToLine = (targetLine: number) => {
    if (!settings || !selected || selected.line === targetLine) return;
    moveWidget({ line: selected.line, index: selected.index }, { line: targetLine, index: settings.lines[targetLine].length });
    setActiveLineIndex(targetLine);
  };

  const warnCcSwitchSync = (next: StatuslineStatus) => {
    if (next.ccSwitch && ["invalidDb", "unavailable", "syncFailed"].includes(next.ccSwitch.state)) {
      toast.warning(t("settings.statusline.ccSwitchSyncWarning"), {
        description: t("settings.statusline.ccSwitchSyncWarningDescription"),
      });
    }
  };

  const syncClaudeCommonConfigIfInstalled = async () => {
    if (!status?.installed) return;
    try {
      const nextStatus = await invoke<StatuslineStatus>("statusline_sync_ccswitch", {
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
        refreshInterval: 10,
      });
      setStatus(nextStatus);
      warnCcSwitchSync(nextStatus);
    } catch (error) {
      toast.warning(t("settings.statusline.ccSwitchSyncWarning"), { description: errorMessage(error) });
    }
  };

  const save = async () => {
    if (!settings) return;
    setWorking(true);
    try {
      if (!profiles.state) return;
      const saved = await profiles.save(profiles.state.activeProfileId, settings);
      applyProfileState(saved);
      await syncClaudeCommonConfigIfInstalled();
      toast.success(t("settings.statusline.saved"));
    } catch (error) {
      toast.error(t("settings.statusline.saveFailed"), { description: errorMessage(error) });
    } finally { setWorking(false); }
  };

  const importLegacy = async () => {
    setWorking(true);
    try {
      const imported = await invoke<StatuslineSettings>("statusline_import_legacy");
      setSettings(imported);
      setSavedSnapshot(JSON.stringify(imported));
      toast.success(t("settings.statusline.imported"));
    } catch (error) {
      toast.error(t("settings.statusline.importFailed"), { description: errorMessage(error) });
    } finally { setWorking(false); }
  };

  const toggleInstall = async () => {
    setWorking(true);
    try {
      const next = status?.installed
        ? await invoke<StatuslineStatus>("statusline_uninstall", { ccSwitchDbPath: ccSwitchDbPath ?? undefined })
        : await invoke<StatuslineStatus>("statusline_install", { refreshInterval: 10, ccSwitchDbPath: ccSwitchDbPath ?? undefined });
      setStatus(next);
      toast.success(t(status?.installed ? "settings.statusline.uninstalled" : "settings.statusline.installed"));
      warnCcSwitchSync(next);
    } catch (error) {
      toast.error(t("settings.statusline.installFailed"), { description: errorMessage(error) });
    } finally { setWorking(false); }
  };

  const installFonts = async () => {
    if (!(await confirm({ title: t("settings.statusline.powerlineFontInstallConfirm") }))) return;
    setInstallingFonts(true);
    try {
      const result = await invoke<PowerlineFontInstallResult>("statusline_powerline_install_fonts");
      setFontStatus(await invoke<PowerlineFontStatus>("statusline_powerline_font_status"));
      toast.success(t("settings.statusline.powerlineFontInstalled").replace("{count}", String(result.installedCount)));
    } catch (error) {
      toast.error(t("settings.statusline.powerlineFontInstallFailed"), { description: errorMessage(error) });
    } finally { setInstallingFonts(false); }
  };

  const setPowerlineEnabled = (enabled: boolean) => {
    updateSettings((current) => ({
      ...current,
      defaultPadding: enabled ? " " : current.defaultPadding,
      lines: enabled ? current.lines.map((line) => line.filter((item) => item.type !== "separator")) : current.lines,
      powerline: { ...current.powerline, enabled, theme: enabled && (!current.powerline.theme || current.powerline.theme === "custom") ? "nord-aurora" : current.powerline.theme },
    }));
  };

  const draggingCatalogEntry = draggingCatalogType ? catalog.find((entry) => entry.widgetType === draggingCatalogType) : null;
  const draggingCatalogLabel = draggingCatalogEntry
    ? pickByLanguage(language, draggingCatalogEntry.zhName, draggingCatalogEntry.enName)
    : draggingCatalogType;

  if (!settings) return <Text c="var(--on-surface-variant)">{t("settings.statusline.loading")}</Text>;

  return (
    <Stack gap="md">
      <Card className="border border-border bg-surface-container-low" radius="lg" p="md">
        <StatuslineProfileBar
          state={profiles.state}
          dirty={dirty}
          busy={working}
          onSave={save}
          onCreate={async (name) => {
            applyProfileState(await profiles.create(name, settings));
            await syncClaudeCommonConfigIfInstalled();
          }}
          onSwitch={async (profileId) => {
            applyProfileState(await profiles.switchProfile(profileId));
            await syncClaudeCommonConfigIfInstalled();
          }}
          onRename={async (profileId, name) => applyProfileState(await profiles.rename(profileId, name))}
          onDuplicate={async (profileId, name) => {
            applyProfileState(await profiles.duplicate(profileId, name));
            await syncClaudeCommonConfigIfInstalled();
          }}
          onDelete={async (profileId) => applyProfileState(await profiles.remove(profileId))}
          onCaptureExternal={async (name) => {
            applyProfileState(await profiles.captureExternal(name));
            await syncClaudeCommonConfigIfInstalled();
          }}
        />
      </Card>
      <Card className="border border-border bg-surface-container-low" radius="lg" p="md">
        <Group justify="space-between" align="flex-start">
          <Box>
            <Group gap="xs"><Text fw={600}>{t("settings.statusline.runtime")}</Text><Badge color={status?.installed ? "green" : "gray"}>{t(status?.installed ? "settings.statusline.enabled" : "settings.statusline.disabled")}</Badge></Group>
            <Text size="xs" c="var(--on-surface-variant)" mt={4}>{status?.claudeSettingsPath}</Text>
          </Box>
          <Group gap="xs">
            {dirty && <Badge color="yellow" variant="light">{t("settings.statusline.unsaved")}</Badge>}
            {status?.legacySettingsAvailable && <Button variant="light" leftSection={<Download size={16} />} onClick={importLegacy} loading={working}>{t("settings.statusline.import")}</Button>}
            <Button variant="light" leftSection={<RefreshCw size={16} />} onClick={() => void refresh()}>{t("settings.statusline.refresh")}</Button>
            <Button color={status?.installed ? "red" : "cliPrimary"} onClick={toggleInstall} loading={working}>{t(status?.installed ? "settings.statusline.uninstall" : "settings.statusline.install")}</Button>
          </Group>
        </Group>
      </Card>

      <StatuslinePreview
        text={preview}
        state={previewState}
        onChange={onPreviewStateChange}
        emptyText={t("settings.statusline.previewEmpty")}
        ariaLabel={t("settings.statusline.claudePreviewAria")}
      />

      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={handleWidgetDragStart} onDragEnd={handleWidgetDragEnd} onDragCancel={() => setDraggingCatalogType(null)}>
        <Box className="grid gap-4 2xl:grid-cols-[320px_minmax(360px,1fr)_300px] xl:grid-cols-[300px_minmax(340px,1fr)]">
          <Card className="border border-border bg-surface-container-low" radius="lg" p="md">
          <Group justify="space-between" mb="sm">
            <Text fw={600}>{t("settings.statusline.catalog")}</Text>
            <Badge variant="light" color="cliPrimary">{t("settings.statusline.componentCount").replace("{count}", String(catalog.length))}</Badge>
          </Group>
          <ScrollArea.Autosize mah={540} type="auto" offsetScrollbars scrollbarSize={8}>
            {groupedCatalog.length > 0 ? (
              <Accordion
                multiple
                variant="contained"
                radius="md"
                value={openedCategories}
                onChange={setOpenedCategories}
                className="pr-1"
              >
                {groupedCatalog.map(([category, entries]) => (
                  <Accordion.Item key={category} value={category}>
                    <Accordion.Control>
                      <Group justify="space-between" gap="xs" wrap="nowrap" pr="xs">
                        <Text size="xs" fw={600}>{categoryLabel(category)}</Text>
                        <Text size="xs" c="var(--on-surface-variant)">{entries.length}</Text>
                      </Group>
                    </Accordion.Control>
                    <Accordion.Panel>
                      <Stack gap={6}>
                        {entries.map((entry) => {
                          const title = pickByLanguage(language, entry.zhName, entry.enName);
                          return (
                            <CatalogWidgetItem
                              key={entry.widgetType}
                              entry={entry}
                              title={title}
                              onAdd={() => addWidget(entry.widgetType)}
                              ariaLabel={t("settings.statusline.addComponent").replace("{name}", title)}
                            />
                          );
                        })}
                      </Stack>
                    </Accordion.Panel>
                  </Accordion.Item>
                ))}
              </Accordion>
            ) : (
              <Text size="sm" c="var(--on-surface-variant)">{t("settings.statusline.catalogEmpty")}</Text>
            )}
          </ScrollArea.Autosize>
          </Card>

          <Stack gap="md">
            <Card className="border border-border bg-surface-container-low" radius="lg" p="md">
            <Group justify="space-between"><Text fw={600}>{t("settings.statusline.layout")}</Text><Button leftSection={<Save size={16} />} onClick={save} loading={working} disabled={!dirty}>{t("settings.statusline.save")}</Button></Group>
              <Stack gap="sm" mt="sm">
                {settings.lines.map((line, lineIndex) => (
                  <StatuslineLayoutLine key={lineIndex} lineIndex={lineIndex} itemIds={line.map((item) => item.id)} active={activeLineIndex === lineIndex} onClick={() => { setActiveLineIndex(lineIndex); setSelectedId(null); }}>
                    <Text size="xs" c="var(--on-surface-variant)" mb={6}>{t("settings.statusline.line").replace("{line}", String(lineIndex + 1))}</Text>
                    <Group gap={6} align="stretch">
                      {line.map((item) => {
                        const entry = catalog.find((candidate) => candidate.widgetType === item.type);
                        const label = entry ? pickByLanguage(language, entry.zhName, entry.enName) : item.type;
                        return <SortableWidgetChip key={item.id} item={item} label={label} selected={selectedId === item.id} removeLabel={t("settings.statusline.removeComponent").replace("{name}", label)} onSelect={() => { setSelectedId((current) => current === item.id ? null : item.id); setActiveLineIndex(lineIndex); }} onRemove={() => removeWidget(item.id)} />;
                      })}
                      {line.length === 0 && <Text size="xs" c="var(--on-surface-variant)">{t("settings.statusline.dropHere")}</Text>}
                    </Group>
                  </StatuslineLayoutLine>
                ))}
              </Stack>
            </Card>
          </Stack>

          <Card className="border border-border bg-surface-container-low 2xl:col-auto xl:col-span-2" radius="lg" p="md">
          <Text fw={600} mb="sm">{t("settings.statusline.properties")}</Text>
          {selected ? <Stack gap="sm">
            <Text size="sm" fw={500}>{selected.widget.type}</Text>
            <SegmentedControl
              fullWidth
              size="xs"
              value={String(selected.line)}
              onChange={(value) => moveSelectedToLine(Number(value))}
              data={settings.lines.map((_, index) => ({ value: String(index), label: t("settings.statusline.line").replace("{line}", String(index + 1)) }))}
              aria-label={t("settings.statusline.moveToLine")}
            />
            <Select label={t("settings.statusline.foreground")} data={COLOR_OPTIONS} value={selected.widget.color ?? ""} onChange={(value) => updateWidget({ color: value || undefined })} renderOption={renderColorOption} />
            <Select label={t("settings.statusline.background")} data={COLOR_OPTIONS} value={selected.widget.backgroundColor ?? ""} onChange={(value) => updateWidget({ backgroundColor: value || undefined })} renderOption={renderColorOption} />
            <Checkbox label={t("settings.statusline.bold")} checked={selected.widget.bold ?? false} onChange={(event) => updateWidget({ bold: event.currentTarget.checked })} />
            {selected.widget.type === "custom-text" && <TextInput label={t("settings.statusline.text")} value={selected.widget.customText ?? ""} onChange={(event) => updateWidget({ customText: event.currentTarget.value })} />}
            {selected.widget.type === "custom-symbol" && <TextInput label={t("settings.statusline.symbol")} value={selected.widget.customSymbol ?? ""} onChange={(event) => updateWidget({ customSymbol: event.currentTarget.value })} />}
            {selected.widget.type === "custom-command" && <><TextInput label={t("settings.statusline.command")} value={selected.widget.commandPath ?? ""} onChange={(event) => updateWidget({ commandPath: event.currentTarget.value })} /><NumberInput label={t("settings.statusline.timeout")} min={100} max={30000} value={selected.widget.timeout ?? 2000} onChange={(value) => updateWidget({ timeout: Number(value) || 2000 })} /></>}
            <Button color="red" variant="light" leftSection={<Trash2 size={16} />} onClick={removeSelected}>{t("settings.statusline.remove")}</Button>
          </Stack> : <Stack gap="md">
            <Text size="sm" c="var(--on-surface-variant)">{t("settings.statusline.selectWidget")}</Text>
            <Text fw={600}>{t("settings.statusline.powerlineSettings")}</Text>
            <Group justify="space-between"><Text size="sm">{t("settings.statusline.powerlineFontStatus")}</Text><Group gap="xs"><Badge color={fontStatus?.installed ? "green" : "yellow"}>{t(fontStatus?.installed ? "settings.statusline.powerlineFontInstalledStatus" : "settings.statusline.powerlineFontMissing")}</Badge>{!fontStatus?.installed && <Button size="xs" variant="light" loading={installingFonts} onClick={() => void installFonts()}>{t("settings.statusline.powerlineFontInstall")}</Button>}</Group></Group>
            {fontStatus?.installed && <Text size="xs" c="var(--on-surface-variant)">{t("settings.statusline.powerlineFontActivateHint")}</Text>}
            {fontStatus?.matchedFont && <Text size="xs" c="var(--on-surface-variant)">{fontStatus.matchedFont}</Text>}
            <Switch label={t("settings.statusline.powerline")} checked={settings.powerline.enabled} onChange={(event) => setPowerlineEnabled(event.currentTarget.checked)} />
            <Switch label={t("settings.statusline.powerlineAutoAlign")} checked={settings.powerline.autoAlign} disabled={!settings.powerline.enabled} onChange={(event) => updateSettings((current) => ({ ...current, powerline: { ...current.powerline, autoAlign: event.currentTarget.checked } }))} />
            <Switch label={t("settings.statusline.powerlineContinueTheme")} checked={settings.powerline.continueThemeAcrossLines} disabled={!settings.powerline.enabled} onChange={(event) => updateSettings((current) => ({ ...current, powerline: { ...current.powerline, continueThemeAcrossLines: event.currentTarget.checked } }))} />
            <Select label={t("settings.statusline.powerlineSeparator")} data={POWERLINE_SEPARATORS} disabled={!settings.powerline.enabled} value={settings.powerline.separators[0] ?? "\ue0b0"} classNames={POWERLINE_SELECT_CLASS_NAMES} renderOption={({ option }) => <Text size="sm" ff={normalizedTerminalFontFamily}>{option.label}</Text>} onChange={(value) => updateSettings((current) => ({ ...current, powerline: { ...current.powerline, separators: [value ?? "\ue0b0"], separatorInvertBackground: [false] } }))} />
            <Select label={t("settings.statusline.powerlineStartCap")} data={POWERLINE_START_CAPS} disabled={!settings.powerline.enabled} value={settings.powerline.startCaps[0] ?? ""} classNames={POWERLINE_SELECT_CLASS_NAMES} renderOption={({ option }) => <Text size="sm" ff={normalizedTerminalFontFamily}>{option.label}</Text>} onChange={(value) => updateSettings((current) => ({ ...current, powerline: { ...current.powerline, startCaps: value ? [value] : [] } }))} />
            <Select label={t("settings.statusline.powerlineEndCap")} data={POWERLINE_END_CAPS} disabled={!settings.powerline.enabled} value={settings.powerline.endCaps[0] ?? ""} classNames={POWERLINE_SELECT_CLASS_NAMES} renderOption={({ option }) => <Text size="sm" ff={normalizedTerminalFontFamily}>{option.label}</Text>} onChange={(value) => updateSettings((current) => ({ ...current, powerline: { ...current.powerline, endCaps: value ? [value] : [] } }))} />
            <Select label={t("settings.statusline.powerlineTheme")} data={POWERLINE_THEMES} disabled={!settings.powerline.enabled} value={settings.powerline.theme ?? "custom"} onChange={(value) => updateSettings((current) => ({ ...current, powerline: { ...current.powerline, theme: value ?? "custom" } }))} />
            <Switch label={t("settings.statusline.minimalist")} checked={settings.minimalistMode} onChange={(event) => updateSettings((current) => ({ ...current, minimalistMode: event.currentTarget.checked }))} />
            <TextInput label={t("settings.statusline.separator")} value={settings.defaultSeparator ?? ""} onChange={(event) => updateSettings((current) => ({ ...current, defaultSeparator: event.currentTarget.value || undefined }))} />
            <NumberInput label={t("settings.statusline.compactThreshold")} min={1} max={99} value={settings.compactThreshold} onChange={(value) => updateSettings((current) => ({ ...current, compactThreshold: Number(value) || 60 }))} />
          </Stack>}
          </Card>
        </Box>
        <DragOverlay dropAnimation={null}>
          {draggingCatalogType && (
            <Box className="rounded-xl border border-[var(--interactive-selected-border)] bg-surface-container px-3 py-2 shadow-lg">
              <Text size="xs" fw={600}>{draggingCatalogLabel}</Text>
              <Text size="xs" c="var(--on-surface-variant)" ff="var(--font-ui-mono)">{draggingCatalogType}</Text>
            </Box>
          )}
        </DragOverlay>
      </DndContext>
      {confirmDialog}
    </Stack>
  );
}

export function StatuslineSettingsPage({ searchValue = "" }: { searchValue?: string }) {
  const { t } = useI18n();
  const { prompt, promptDialog } = useAppPrompt();
  const source = useSettingsStore((state) => state.statuslineEditorSource);
  const updateSetting = useSettingsStore((state) => state.update);
  const terminalThemeName = useSettingsStore((state) => state.terminalThemeName);
  const codexConfigDir = useSettingsStore((state) => state.codexHookConfigDir);
  const [profileReloadToken, setProfileReloadToken] = useState(0);
  const [transferring, setTransferring] = useState(false);
  const [claudePreviewState, setClaudePreviewState] = useState<StatuslinePreviewState>({
    themeId: terminalThemeName === "auto" ? "" : terminalThemeName,
    width: 100,
  });
  const [codexPreviewState, setCodexPreviewState] = useState<StatuslinePreviewState>({
    themeId: terminalThemeName === "auto" ? "" : terminalThemeName,
    width: 100,
  });

  const handleSourceChange = (value: string) => {
    void updateSetting("statuslineEditorSource", value as StatuslineEditorSource);
  };

  const exportProfiles = async () => {
    const path = await saveDialog({ defaultPath: "cli-manager-statusline-profiles-v1.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    setTransferring(true);
    try {
      await invoke("statusline_profiles_export", { path, configDir: codexConfigDir ?? undefined });
      toast.success(t("settings.statuslineProfiles.exported"));
    } catch (error) {
      toast.error(t("settings.statuslineProfiles.exportFailed"), { description: errorMessage(error) });
    } finally { setTransferring(false); }
  };

  const importProfiles = async () => {
    const path = await open({ multiple: false, directory: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path || Array.isArray(path)) return;
    setTransferring(true);
    try {
      const analysis = await invoke<StatuslineImportAnalysis>("statusline_profiles_analyze_import", { path, configDir: codexConfigDir ?? undefined });
      const decisions: StatuslineImportDecision[] = [];
      for (const conflict of analysis.conflicts) {
        const allowed = conflict.active ? "skip/rename" : "overwrite/skip/rename";
        const action = (await prompt({
          title: t("settings.statuslineProfiles.conflictPrompt")
            .replace("{tool}", conflict.tool)
            .replace("{name}", conflict.name)
            .replace("{allowed}", allowed),
          initialValue: "skip",
        }))?.toLowerCase();
        if (!action) return;
        if (action !== "overwrite" && action !== "skip" && action !== "rename") throw new Error("statusline_profiles_invalid_decision");
        if (conflict.active && action === "overwrite") throw new Error("statusline_profiles_active_overwrite_forbidden");
        const decision: StatuslineImportDecision = { tool: conflict.tool, profileId: conflict.profileId, action };
        if (action === "rename") {
          const newName = await prompt({
            title: t("settings.statuslineProfiles.renameImportPrompt"),
            initialValue: `${conflict.name} (Import)`,
          });
          if (!newName) return;
          decision.newName = newName;
        }
        decisions.push(decision);
      }
      await invoke("statusline_profiles_commit_import", { path, revision: analysis.revision, decisions, configDir: codexConfigDir ?? undefined });
      setProfileReloadToken((value) => value + 1);
      toast.success(t("settings.statuslineProfiles.imported")
        .replace("{claude}", String(analysis.claudeCount))
        .replace("{codex}", String(analysis.codexCount)));
    } catch (error) {
      toast.error(t("settings.statuslineProfiles.importFailed"), { description: errorMessage(error) });
    } finally { setTransferring(false); }
  };

  return (
    <Stack gap="md">
      <Card className="border border-border bg-surface-container-low" radius="lg" p="md">
        <Group justify="space-between" mb="xs">
          <Text size="xs" c="var(--on-surface-variant)">{t("settings.statusline.chooseTool")}</Text>
          <Group gap="xs">
            <Button size="xs" variant="light" leftSection={<Upload size={14} />} loading={transferring} onClick={() => void importProfiles()}>{t("settings.statuslineProfiles.importLibrary")}</Button>
            <Button size="xs" variant="light" leftSection={<Download size={14} />} loading={transferring} onClick={() => void exportProfiles()}>{t("settings.statuslineProfiles.exportLibrary")}</Button>
          </Group>
        </Group>
        <SegmentedControl
          fullWidth
          value={source}
          onChange={handleSourceChange}
          data={[
            {
              value: "claude",
              label: <Group gap="xs" justify="center"><Bot size={16} /><Text size="sm" fw={600}>Claude Code</Text><Badge size="xs" variant="light" color="orange">{t("settings.statusline.builtinRuntime")}</Badge></Group>,
            },
            {
              value: "codex",
              label: <Group gap="xs" justify="center"><Braces size={16} /><Text size="sm" fw={600}>Codex</Text><Badge size="xs" variant="light" color="green">{t("settings.codexStatusline.native")}</Badge></Group>,
            },
          ]}
          aria-label={t("settings.statusline.chooseTool")}
        />
      </Card>

      {source === "claude" ? (
        <ClaudeStatuslineEditor
          searchValue={searchValue}
          previewState={claudePreviewState}
          onPreviewStateChange={setClaudePreviewState}
          reloadToken={profileReloadToken}
        />
      ) : (
        <CodexStatuslineEditor
          searchValue={searchValue}
          previewState={codexPreviewState}
          onPreviewStateChange={setCodexPreviewState}
          reloadToken={profileReloadToken}
        />
      )}
      {promptDialog}
    </Stack>
  );
}
