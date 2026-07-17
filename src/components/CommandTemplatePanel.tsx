import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/shallow";
import { useTemplateStore } from "../stores/templateStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useProjectStore } from "../stores/projectStore";
import type { CommandTemplate, Project } from "../lib/types";
import { Check, ChevronDown, Pencil, Play, Plus, Search, TerminalSquare, Trash2, X } from "./icons";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { EmptyState } from "./ui/EmptyState";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/Skeleton";
import { toast } from "sonner";
import { logError } from "../lib/logger";
import { useI18n } from "../lib/i18n";
import { terminalProcessManager } from "../terminal/core/TerminalProcessManager";

type TemplateScope = "global" | "project" | "session";
type ScopeFilter = "all" | TemplateScope;

function resolveCommand(command: string, project?: Project): string {
  if (!project) return command;
  return command
    .replace(/\$\{projectPath\}/g, project.path)
    .replace(/\$\{projectName\}/g, project.name);
}

function getTemplateScope(template: CommandTemplate): TemplateScope {
  if (template.session_id) return "session";
  if (template.project_id) return "project";
  return "global";
}

interface CommandTemplatePanelProps {
  popoverSide?: "top" | "right" | "bottom" | "left";
  toneClassName?: string;
  popoverStyle?: CSSProperties;
}

interface InlineSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface InlinePanelSelectProps {
  value: string;
  options: InlineSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
}

function InlinePanelSelect({ value, options, onChange, ariaLabel }: InlinePanelSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value) ?? null;

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="ui-input ui-focus-ring flex h-7 w-full items-center justify-between gap-2 px-2 text-xs text-on-surface outline-none"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="truncate">{selected?.label ?? ""}</span>
        <ChevronDown
          size={12}
          strokeWidth={1.8}
          className={`shrink-0 text-on-surface-variant transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className="ui-select-popover absolute left-0 right-0 top-[calc(100%+4px)] z-50 rounded-xl border border-border bg-surface-container-high py-1"
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                disabled={option.disabled}
                onClick={() => {
                  if (option.disabled) return;
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`mx-1 flex w-[calc(100%-8px)] items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                  option.disabled
                    ? "cursor-not-allowed opacity-45"
                    : active
                      ? "bg-surface-container-highest text-primary"
                      : "text-on-surface hover:bg-surface-container-highest/80"
                }`}
              >
                <span className="flex-1 truncate">{option.label}</span>
                {active && <Check size={12} strokeWidth={2} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CommandTemplatePanel({
  popoverSide = "bottom",
  toneClassName = "",
  popoverStyle,
}: CommandTemplatePanelProps) {
  const { t } = useI18n();
  const {
    fetchTemplates,
    getForContext,
    createTemplate,
    createSessionTemplate,
    updateTemplate,
    updateSessionTemplate,
    deleteTemplate,
    deleteSessionTemplate,
    pruneSessionTemplates,
  } = useTemplateStore();
  const { sessions, activeSessionId } = useTerminalStore(
    useShallow((s) => ({ sessions: s.sessions, activeSessionId: s.activeSessionId }))
  );
  const { projects } = useProjectStore();
  const [open, setOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<CommandTemplate | null>(null);
  const [pendingDeleteTemplate, setPendingDeleteTemplate] = useState<CommandTemplate | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<TemplateScope>("global");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);

  const scopeOptions: InlineSelectOption[] = [
    { value: "global", label: t("commandTemplate.scope.global") },
    { value: "project", label: t("commandTemplate.scope.project") },
    { value: "session", label: t("commandTemplate.scope.session") },
  ];
  const projectOptions: InlineSelectOption[] = [
    { value: "", label: t("settings.templates.selectProject") },
    ...projects.map((project) => ({ value: project.id, label: project.name })),
  ];
  const scopeFilterOptions: Array<{ value: ScopeFilter; label: string }> = [
    { value: "all", label: t("commandTemplate.filter.all") },
    { value: "global", label: t("settings.templates.scope.global") },
    { value: "project", label: t("settings.templates.scope.project") },
    { value: "session", label: t("settings.templates.scope.session") },
  ];

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  useEffect(() => {
    pruneSessionTemplates(sessions.map((item) => item.id));
  }, [sessions, pruneSessionTemplates]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPanelLoading(true);
    void Promise.all([
      fetchTemplates(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 180);
      }),
    ]).finally(() => {
      if (!cancelled) setPanelLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, fetchTemplates]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeProject = activeSession?.projectId
    ? projects.find((p) => p.id === activeSession.projectId)
    : undefined;
  const visibleTemplates = getForContext(activeSession?.projectId ?? null, activeSessionId);

  const filteredTemplates = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return visibleTemplates.filter((template) => {
      const templateScope = getTemplateScope(template);
      if (scopeFilter !== "all" && templateScope !== scopeFilter) return false;
      if (!query) return true;
      return [template.name, template.command, template.description]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(query));
    });
  }, [visibleTemplates, scopeFilter, searchQuery]);

  const resetForm = () => {
    setEditingTemplate(null);
    setName("");
    setCommand("");
    setDescription("");
    setScope("global");
    setProjectId(null);
  };

  const openCreateForm = () => {
    if (showForm && !editingTemplate) {
      setShowForm(false);
      return;
    }
    setPendingDeleteTemplate(null);
    resetForm();
    setShowForm(true);
  };

  const openEditForm = (template: CommandTemplate) => {
    setPendingDeleteTemplate(null);
    setEditingTemplate(template);
    setName(template.name);
    setCommand(template.command);
    setDescription(template.description);
    setScope(getTemplateScope(template));
    setProjectId(template.project_id);
    setShowForm(true);
  };

  const closeForm = () => {
    resetForm();
    setShowForm(false);
  };

  const scopeLabel = (template: CommandTemplate) => {
    if (template.session_id) return t("settings.templates.scope.session");
    if (!template.project_id) return t("settings.templates.scope.global");
    const project = projects.find((item) => item.id === template.project_id);
    return project
      ? t("settings.templates.scope.projectWithName", { name: project.name })
      : t("settings.templates.scope.project");
  };

  const handleRun = async (template: CommandTemplate) => {
    if (!activeSessionId) return;
    const resolved = resolveCommand(template.command, activeProject);
    try {
      await terminalProcessManager.write(activeSessionId, resolved + "\r");
      setOpen(false);
    } catch (err) {
      toast.error(t("commandTemplate.toast.runFailed"), { description: String(err) });
      logError("Failed to run command template", {
        templateId: template.id,
        sessionId: activeSessionId,
        err,
      });
    }
  };

  const handleSave = async () => {
    const nextName = name.trim();
    const nextCommand = command.trim();
    const nextDescription = description.trim();
    const commandRequired = scope !== "global";
    if (!nextName || (commandRequired && !nextCommand)) return;
    if (!editingTemplate && scope === "project" && !projectId) return;
    if (!editingTemplate && scope === "session" && !activeSessionId) return;

    try {
      if (editingTemplate) {
        if (editingTemplate.session_id) {
          await updateSessionTemplate(editingTemplate.session_id, editingTemplate.id, {
            name: nextName,
            command: nextCommand,
            description: nextDescription,
          });
        } else {
          await updateTemplate(editingTemplate.id, {
            name: nextName,
            command: nextCommand,
            description: nextDescription,
          });
        }
      } else if (scope === "session") {
        await createSessionTemplate(activeSessionId!, {
          project_id: activeSession?.projectId ?? null,
          session_id: activeSessionId!,
          name: nextName,
          command: nextCommand,
          description: nextDescription,
        });
      } else {
        await createTemplate({
          project_id: scope === "project" ? projectId : null,
          name: nextName,
          command: nextCommand,
          description: nextDescription,
        });
      }

      closeForm();
      toast.success(t("commandTemplate.toast.saveSuccess"));
    } catch (err) {
      toast.error(t("commandTemplate.toast.saveFailed"), { description: String(err) });
      logError("Failed to save command template", {
        editingTemplateId: editingTemplate?.id,
        scope,
        projectId,
        activeSessionId,
        err,
      });
    }
  };

  const handleDelete = async (template: CommandTemplate) => {
    if (template.session_id) {
      deleteSessionTemplate(template.session_id, template.id);
    } else {
      await deleteTemplate(template.id);
    }
    if (editingTemplate?.id === template.id) closeForm();
    setPendingDeleteTemplate(null);
  };

  const commandRequired = scope !== "global";
  const saveDisabled = name.trim().length === 0
    || (commandRequired && command.trim().length === 0)
    || (!editingTemplate && scope === "project" && !projectId)
    || (!editingTemplate && scope === "session" && !activeSessionId);
  const emptyTitle = searchQuery || scopeFilter !== "all"
    ? t("commandTemplate.emptySearchTitle")
    : t("commandTemplate.emptyTitle");
  const emptyDescription = searchQuery || scopeFilter !== "all"
    ? t("commandTemplate.emptySearchDescription")
    : t("commandTemplate.emptyDescription");

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          closeForm();
          setPendingDeleteTemplate(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          className={`ui-focus-ring ui-icon-action ${toneClassName}`.trim()}
          title={popoverSide === "left" ? undefined : t("commandTemplate.title")}
          aria-label={t("commandTemplate.openPanel")}
        >
          <TerminalSquare size={14} strokeWidth={1.5} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        id="command-template-panel"
        align="start"
        side={popoverSide}
        className="w-[360px]"
        style={popoverStyle}
      >
        <div className="command-template-panel__header">
          <div className="flex min-w-0 items-center gap-2">
            <span className="command-template-panel__title-icon">
              <TerminalSquare size={15} strokeWidth={1.8} />
            </span>
            <span className="truncate text-sm font-semibold text-on-surface">{t("commandTemplate.title")}</span>
            <span className="command-template-panel__count" aria-label={t("commandTemplate.countLabel", { count: filteredTemplates.length })}>
              {filteredTemplates.length}
            </span>
          </div>
          <button
            type="button"
            onClick={openCreateForm}
            className="command-template-panel__new-button ui-focus-ring"
            aria-label={showForm && !editingTemplate ? t("commandTemplate.collapseForm") : t("commandTemplate.expandForm")}
            title={t("settings.templates.new")}
          >
            <Plus size={16} strokeWidth={2} />
            <span>{t("commandTemplate.newShort")}</span>
          </button>
        </div>

        <div className="command-template-panel__filters">
          <div className="command-template-panel__search ui-focus-ring">
            <Search size={13} strokeWidth={1.8} />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder={t("commandTemplate.searchPlaceholder")}
              aria-label={t("commandTemplate.searchAria")}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label={t("commandTemplate.clearSearch")}
                title={t("commandTemplate.clearSearch")}
              >
                <X size={12} strokeWidth={1.8} />
              </button>
            )}
          </div>
          <div className="command-template-panel__scope-tabs" role="tablist" aria-label={t("commandTemplate.scopeFilterAria")}>
            {scopeFilterOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={scopeFilter === option.value}
                data-active={scopeFilter === option.value ? "true" : "false"}
                onClick={() => setScopeFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {showForm && (
          <div className="command-template-panel__form">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-on-surface">
                {editingTemplate ? t("settings.templates.editTitle") : t("settings.templates.createTitle")}
              </span>
              {editingTemplate && (
                <span className="command-template-panel__scope-pill">{scopeLabel(editingTemplate)}</span>
              )}
            </div>
            <Input
              type="text"
              placeholder={t("settings.templates.name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-7 text-xs"
            />
            <Input
              type="text"
              placeholder={t("settings.templates.commandPlaceholder")}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="h-7 text-xs"
            />
            <Input
              type="text"
              placeholder={t("settings.templates.description")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="h-7 text-xs"
            />
            {!editingTemplate && (
              <>
                <InlinePanelSelect
                  value={scope}
                  options={scopeOptions}
                  onChange={(value) => setScope(value as TemplateScope)}
                  ariaLabel={t("settings.templates.scopeLabel")}
                />
                {scope === "project" && (
                  <InlinePanelSelect
                    value={projectId ?? ""}
                    options={projectOptions}
                    onChange={(value) => setProjectId(value || null)}
                    ariaLabel={t("settings.templates.targetProject")}
                  />
                )}
                {scope === "session" && (
                  <div className="text-[10px] text-on-surface-variant">
                    {activeSessionId
                      ? t("commandTemplate.bindSession", { sessionId: activeSessionId })
                      : t("commandTemplate.openSessionFirst")}
                  </div>
                )}
              </>
            )}
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={closeForm}
                className="ui-flat-action h-6 px-2 text-[10px]"
                aria-label={editingTemplate ? t("settings.templates.cancelEdit") : t("commandTemplate.cancelCreate")}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saveDisabled}
                className="ui-flat-action ui-primary-action h-6 px-2 text-[10px] disabled:opacity-50"
                aria-label={t("commandTemplate.save")}
              >
                {t("common.save")}
              </button>
            </div>
          </div>
        )}

        <div className="command-template-panel__list ui-thin-scroll">
          {panelLoading ? (
            <div className="space-y-3 px-3 py-3">
              {[1, 2, 3].map((item) => (
                <div key={item} className="flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-lg" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-2/3" />
                    <Skeleton className="h-2.5 w-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredTemplates.length === 0 ? (
            <EmptyState
              icon={<TerminalSquare size={20} strokeWidth={1.5} />}
              title={emptyTitle}
              description={emptyDescription}
              action={visibleTemplates.length === 0 ? { label: t("commandTemplate.create"), onClick: openCreateForm } : undefined}
              className="px-3 py-6"
            />
          ) : (
            filteredTemplates.map((template) => {
              const preview = template.command || template.description || t("commandTemplate.noCommand");
              return (
                <div
                  key={template.id}
                  role="button"
                  tabIndex={0}
                  className="command-template-panel__row ui-focus-ring"
                  title={activeSessionId ? t("commandTemplate.runNamed", { name: template.name }) : t("commandTemplate.inactiveHint")}
                  onClick={() => {
                    void handleRun(template);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      void handleRun(template);
                    }
                  }}
                >
                  <span className="command-template-panel__row-icon">
                    <TerminalSquare size={18} strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-xs font-semibold text-on-surface">{template.name}</span>
                      <span className="command-template-panel__scope-pill">{scopeLabel(template)}</span>
                    </span>
                    <code className="block truncate pt-1 font-mono text-[10px] text-primary">{preview}</code>
                  </span>
                  <span className="command-template-panel__actions" aria-hidden="false">
                    {pendingDeleteTemplate?.id === template.id ? (
                      <span className="command-template-panel__delete-confirm">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDeleteTemplate(null);
                          }}
                          className="command-template-panel__icon-button"
                          aria-label={t("settings.templates.cancelDelete")}
                          title={t("settings.templates.cancelDelete")}
                        >
                          <X size={13} strokeWidth={2.2} />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleDelete(template);
                          }}
                          className="command-template-panel__confirm-delete-button"
                          aria-label={t("commandTemplate.deleteNamed", { name: template.name })}
                          title={t("settings.templates.confirmDelete")}
                        >
                          <Check size={12} strokeWidth={2.2} />
                          <span>{t("common.delete")}</span>
                        </button>
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={!activeSessionId}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleRun(template);
                          }}
                          className="command-template-panel__icon-button command-template-panel__icon-button--run"
                          aria-label={t("commandTemplate.runNamed", { name: template.name })}
                          title={t("commandTemplate.runNamed", { name: template.name })}
                        >
                          <Play size={14} strokeWidth={1.9} />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openEditForm(template);
                          }}
                          className="command-template-panel__icon-button"
                          aria-label={t("commandTemplate.editNamed", { name: template.name })}
                          title={t("commandTemplate.editNamed", { name: template.name })}
                        >
                          <Pencil size={14} strokeWidth={1.8} />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            closeForm();
                            setPendingDeleteTemplate(template);
                          }}
                          className="command-template-panel__icon-button command-template-panel__icon-button--danger"
                          aria-label={t("commandTemplate.deleteNamed", { name: template.name })}
                          title={t("commandTemplate.deleteNamed", { name: template.name })}
                        >
                          <Trash2 size={14} strokeWidth={1.8} />
                        </button>
                      </>
                    )}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {!activeSessionId && (
          <div className="border-t border-border/60 px-3 py-2 text-[10px] text-on-surface-variant">
            {t("commandTemplate.inactiveHint")}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
