import { useEffect, useMemo, useState } from "react";
import { Badge, Box, Button, Card, Group, List, Select, Stack, Text, TextInput } from "@mantine/core";
import { ChevronRight, Plus, TerminalSquare } from "../../icons";
import { useTemplateStore } from "../../../stores/templateStore";
import { useProjectStore } from "../../../stores/projectStore";
import { useTerminalStore } from "../../../stores/terminalStore";
import type { CommandTemplate } from "../../../lib/types";
import { useI18n, type TranslationKey } from "../../../lib/i18n";

type Scope = "global" | "project" | "session";

interface TemplateSettingsPageProps {
  searchValue: string;
}

interface TemplateEditorForm {
  name: string;
  command: string;
  description: string;
  scope: Scope;
  projectId: string | null;
}

const SCOPE_OPTIONS: { value: Scope; labelKey: TranslationKey }[] = [
  { value: "global", labelKey: "settings.templates.scope.global" },
  { value: "project", labelKey: "settings.templates.scope.project" },
  { value: "session", labelKey: "settings.templates.scope.session" },
];

function resolveScope(template: CommandTemplate): Scope {
  if (template.session_id) return "session";
  if (template.project_id) return "project";
  return "global";
}

export function TemplateSettingsPage({ searchValue }: TemplateSettingsPageProps) {
  const { t } = useI18n();
  const {
    templates,
    sessionTemplates,
    fetchTemplates,
    createTemplate,
    createSessionTemplate,
    updateTemplate,
    updateSessionTemplate,
    deleteTemplate,
    deleteSessionTemplate,
    pruneSessionTemplates,
  } = useTemplateStore();
  const { projects } = useProjectStore();
  const { sessions, activeSessionId } = useTerminalStore();

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [form, setForm] = useState<TemplateEditorForm>({
    name: "",
    command: "",
    description: "",
    scope: "global",
    projectId: null,
  });

  useEffect(() => {
    void fetchTemplates();
  }, [fetchTemplates]);

  useEffect(() => {
    pruneSessionTemplates(sessions.map((session) => session.id));
  }, [sessions, pruneSessionTemplates]);

  const currentSessionTemplates = activeSessionId ? (sessionTemplates[activeSessionId] ?? []) : [];
  const allTemplates = useMemo(
    () => [...templates, ...currentSessionTemplates],
    [templates, currentSessionTemplates]
  );

  const scopeLabel = (template: CommandTemplate): string => {
    if (template.session_id) return t("settings.templates.scope.session");
    if (!template.project_id) return t("settings.templates.scope.global");
    const project = projects.find((item) => item.id === template.project_id);
    return project
      ? t("settings.templates.scope.projectWithName", { name: project.name })
      : t("settings.templates.scope.project");
  };

  const keyword = searchValue.trim().toLowerCase();
  const visibleTemplates = useMemo(() => {
    if (!keyword) return allTemplates;
    return allTemplates.filter((template) => {
      const scopeText = scopeLabel(template).toLowerCase();
      return (
        template.name.toLowerCase().includes(keyword)
        || template.command.toLowerCase().includes(keyword)
        || template.description.toLowerCase().includes(keyword)
        || scopeText.includes(keyword)
      );
    });
  }, [allTemplates, keyword, projects, t]);

  const selectedTemplate = useMemo(
    () => allTemplates.find((item) => item.id === selectedId) ?? null,
    [allTemplates, selectedId]
  );
  const projectOptions = useMemo(
    () => [
      { value: "", label: t("settings.templates.selectProject") },
      ...projects.map((project) => ({ value: project.id, label: project.name })),
    ],
    [projects, t]
  );
  const scopeOptions = useMemo(
    () => SCOPE_OPTIONS.map((option) => ({
      value: option.value,
      label: t(option.labelKey),
      disabled: option.value === "session" && !activeSessionId,
    })),
    [activeSessionId, t]
  );

  const resetToCreate = () => {
    setMode("create");
    setSelectedId(null);
    setConfirmingDelete(false);
    setForm({
      name: "",
      command: "",
      description: "",
      scope: "global",
      projectId: activeSession?.projectId ?? null,
    });
  };

  const openEditor = (template: CommandTemplate) => {
    setMode("edit");
    setSelectedId(template.id);
    setConfirmingDelete(false);
    setForm({
      name: template.name,
      command: template.command,
      description: template.description,
      scope: resolveScope(template),
      projectId: template.project_id,
    });
  };

  const handleSave = async () => {
    const name = form.name.trim();
    const command = form.command.trim();
    const description = form.description.trim();
    const commandRequired = form.scope !== "global";
    if (!name || (commandRequired && !command)) return;
    if (mode === "create" && form.scope === "project" && !form.projectId) return;
    if (mode === "create" && form.scope === "session" && !activeSessionId) return;

    setSaving(true);
    try {
      if (mode === "create") {
        if (form.scope === "session") {
          await createSessionTemplate(activeSessionId!, {
            session_id: activeSessionId!,
            project_id: activeSession?.projectId ?? null,
            name,
            command,
            description,
          });
        } else {
          await createTemplate({
            project_id: form.scope === "project" ? form.projectId : null,
            name,
            command,
            description,
          });
        }
        resetToCreate();
        return;
      }

      if (!selectedTemplate) return;
      const editingTemplate = selectedTemplate;
      if (editingTemplate.session_id) {
        await updateSessionTemplate(editingTemplate.session_id, editingTemplate.id, {
          name,
          command,
          description,
        });
      } else {
        await updateTemplate(editingTemplate.id, {
          name,
          command,
          description,
        });
      }
      openEditor({ ...editingTemplate, name, command, description });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedTemplate) return;
    if (selectedTemplate.session_id) {
      deleteSessionTemplate(selectedTemplate.session_id, selectedTemplate.id);
    } else {
      await deleteTemplate(selectedTemplate.id);
    }
    resetToCreate();
  };

  const commandRequired = form.scope !== "global";
  const saveDisabled = saving
    || !form.name.trim()
    || (commandRequired && !form.command.trim())
    || (mode === "create" && form.scope === "project" && !form.projectId)
    || (mode === "create" && form.scope === "session" && !activeSessionId);

  return (
    <div className="grid grid-cols-[280px_minmax(0,1fr)] gap-4">
      <section className="ui-surface-card min-w-0 rounded-2xl border border-border p-3">
        <Stack gap="sm">
          <Group justify="space-between" align="center" gap="sm">
            <Text size="sm" fw={600} c="var(--on-surface)">
              {t("settings.templates.list")}
            </Text>
            <Button
              type="button"
              size="xs"
              variant="filled"
              color="cliPrimary"
              leftSection={<Plus size={12} strokeWidth={2} aria-hidden="true" />}
              onClick={resetToCreate}
            >
              {t("settings.templates.new")}
            </Button>
          </Group>

          {visibleTemplates.length > 0 ? (
            <List
              listStyleType="none"
              spacing="sm"
              className="min-h-0 overflow-auto pr-1 ui-thin-scroll"
              styles={{ root: { paddingInlineStart: 0 } }}
            >
              {visibleTemplates.map((template) => {
                const active = selectedId === template.id && mode === "edit";
                return (
                  <List.Item
                    key={template.id}
                    role="button"
                    tabIndex={0}
                    aria-selected={active}
                    data-selected={active ? "true" : "false"}
                    className="ui-interactive ui-focus-ring cursor-pointer rounded-2xl border border-border bg-surface-container-lowest px-3 py-3 transition-colors"
                    styles={{ itemWrapper: { display: "block" } }}
                    onClick={() => openEditor(template)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openEditor(template);
                      }
                    }}
                  >
                    <Group justify="space-between" align="center" gap="sm" wrap="nowrap">
                      <Group gap="sm" wrap="nowrap" className="min-w-0">
                        <Box className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-container-high text-primary">
                          <TerminalSquare size={20} strokeWidth={1.8} aria-hidden="true" />
                        </Box>
                        <Box className="min-w-0">
                          <Text size="xs" fw={600} c="var(--on-surface)" truncate>
                            {template.name}
                          </Text>
                          <Text mt={3} size="xs" c="var(--on-surface-variant)" truncate>
                            {template.command || template.description}
                          </Text>
                        </Box>
                      </Group>
                      <Group gap="xs" wrap="nowrap" className="shrink-0">
                        <Badge size="xs" variant="light" color={active ? "cliPrimary" : "gray"}>
                          {scopeLabel(template)}
                        </Badge>
                        <ChevronRight
                          size={16}
                          strokeWidth={1.8}
                          style={{ color: "var(--on-surface-variant)" }}
                          aria-hidden="true"
                        />
                      </Group>
                    </Group>
                  </List.Item>
                );
              })}
            </List>
          ) : (
            <Box className="rounded-lg border border-dashed border-border bg-surface-container-lowest px-3 py-6 text-center">
              <Text size="xs" c="var(--on-surface-variant)">
                {t("settings.templates.empty")}
              </Text>
            </Box>
          )}
        </Stack>
      </section>

      <section className="ui-surface-card min-w-0 rounded-2xl border border-border p-0">
        <Box className="sticky top-0 z-10 border-b border-border bg-surface-container px-4 py-3">
          <Group justify="space-between" align="flex-start" gap="md">
            <Box>
              <Text size="sm" fw={600} c="var(--on-surface)">
                {mode === "create" ? t("settings.templates.createTitle") : t("settings.templates.editTitle")}
              </Text>
              <Text mt={2} size="xs" c="var(--on-surface-variant)">
                {t("settings.templates.formDescription")}
              </Text>
            </Box>
            <Group gap="xs" justify="flex-end">
            {mode === "edit" && (
              <Button
                type="button"
                size="xs"
                variant="default"
                color="gray"
                onClick={resetToCreate}
              >
                {t("settings.templates.cancelEdit")}
              </Button>
            )}
            <Button
              type="button"
              size="xs"
              color="cliPrimary"
              onClick={() => void handleSave()}
              disabled={saveDisabled}
            >
              {saving ? t("settings.templates.saving") : t("settings.templates.confirmSave")}
            </Button>
            {mode === "edit" && (
              confirmingDelete ? (
                <>
                  <Button
                    type="button"
                    size="xs"
                    variant="default"
                    color="gray"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    {t("settings.templates.cancelDelete")}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    color="red"
                    onClick={() => void handleDelete()}
                  >
                    {t("settings.templates.confirmDelete")}
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="light"
                  color="red"
                  onClick={() => setConfirmingDelete(true)}
                >
                  {t("common.delete")}
                </Button>
              )
            )}
            </Group>
          </Group>
        </Box>

        <Stack gap="sm" p="md">
          <TextInput
              label={t("settings.templates.name")}
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.currentTarget.value }))}
              placeholder={t("settings.templates.namePlaceholder")}
              size="xs"
              aria-label={t("settings.templates.name")}
          />

          <TextInput
              label={t("settings.templates.command")}
              value={form.command}
              onChange={(event) => setForm((prev) => ({ ...prev, command: event.currentTarget.value }))}
              placeholder={t("settings.templates.commandPlaceholder")}
              size="xs"
              aria-label={t("settings.templates.command")}
          />

          <TextInput
              label={t("settings.templates.description")}
              value={form.description}
              onChange={(event) => setForm((prev) => ({ ...prev, description: event.currentTarget.value }))}
              placeholder={t("settings.templates.optional")}
              size="xs"
              aria-label={t("settings.templates.description")}
          />

          <Box>
            <Select<Scope>
              label={t("settings.templates.scopeLabel")}
              value={form.scope}
              onChange={(value) => {
                if (value) setForm((prev) => ({ ...prev, scope: value }));
              }}
              data={scopeOptions}
              allowDeselect={false}
              disabled={mode === "edit"}
              size="xs"
              aria-label={t("settings.templates.scopeLabel")}
            />
            {!activeSessionId && form.scope === "session" && (
              <Text mt={4} size="xs" c="var(--warning)">
                {t("settings.templates.noActiveSession")}
              </Text>
            )}
            {mode === "edit" && (
              <Text mt={4} size="xs" c="var(--on-surface-variant)">
                {t("settings.templates.lockedScope")}
              </Text>
            )}
          </Box>

          {form.scope === "project" && (
            <Select<string>
                label={t("settings.templates.targetProject")}
                value={form.projectId ?? ""}
                onChange={(value) => setForm((prev) => ({ ...prev, projectId: value || null }))}
                data={projectOptions}
                allowDeselect={false}
                disabled={mode === "edit"}
                size="xs"
                aria-label={t("settings.templates.targetProject")}
            />
          )}

          {form.scope === "session" && (
            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Text size="xs" c="var(--on-surface-variant)">
                {activeSessionId
                  ? t("settings.templates.bindSession", { sessionId: activeSessionId })
                  : t("settings.templates.activateSessionFirst")}
              </Text>
            </Card>
          )}

        </Stack>
      </section>
    </div>
  );
}
