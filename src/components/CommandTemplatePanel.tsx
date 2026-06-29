import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTemplateStore } from "../stores/templateStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useProjectStore } from "../stores/projectStore";
import type { CommandTemplate, Project } from "../lib/types";
import { Check, ChevronDown, TerminalSquare, Plus, Trash2 } from "./icons";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { EmptyState } from "./ui/EmptyState";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/Skeleton";
import { toast } from "sonner";
import { logError } from "../lib/logger";
import { useI18n } from "../lib/i18n";

/** Resolve template variables: ${projectPath}, ${projectName} */
function resolveCommand(command: string, project?: Project): string {
  if (!project) return command;
  return command
    .replace(/\$\{projectPath\}/g, project.path)
    .replace(/\$\{projectName\}/g, project.name);
}

interface CommandTemplatePanelProps {
  popoverSide?: "top" | "right" | "bottom" | "left";
  toneClassName?: string;
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

export function CommandTemplatePanel({ popoverSide = "bottom", toneClassName = "" }: CommandTemplatePanelProps) {
  const { t } = useI18n();
  const {
    fetchTemplates,
    getForContext,
    createTemplate,
    createSessionTemplate,
    deleteTemplate,
    deleteSessionTemplate,
    pruneSessionTemplates,
  } = useTemplateStore();
  const { sessions, activeSessionId } = useTerminalStore();
  const { projects } = useProjectStore();
  const [open, setOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"global" | "project" | "session">("global");
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

  // Show templates relevant to the active project and session.
  const visibleTemplates = getForContext(activeSession?.projectId ?? null, activeSessionId);

  const handleRun = async (template: CommandTemplate) => {
    if (!activeSessionId) return;
    const resolved = resolveCommand(template.command, activeProject);
    try {
      await invoke("pty_write", { sessionId: activeSessionId, data: resolved + "\r" });
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

  const handleCreate = async () => {
    const commandRequired = scope !== "global";
    if (!name.trim() || (commandRequired && !command.trim())) return;

    try {
      if (scope === "session") {
        if (!activeSessionId) return;
        await createSessionTemplate(activeSessionId, {
          project_id: activeSession?.projectId ?? null,
          session_id: activeSessionId,
          name: name.trim(),
          command: command.trim(),
          description: description.trim(),
        });
      } else {
        await createTemplate({
          project_id: scope === "project" ? projectId : null,
          name: name.trim(),
          command: command.trim(),
          description: description.trim(),
        });
      }

      setName("");
      setCommand("");
      setDescription("");
      setScope("global");
      setProjectId(null);
      setShowForm(false);
      toast.success(t("commandTemplate.toast.saveSuccess"));
    } catch (err) {
      toast.error(t("commandTemplate.toast.saveFailed"), { description: String(err) });
      logError("Failed to save command template", {
        scope,
        projectId,
        activeSessionId,
        err,
      });
    }
  };

  const scopeLabel = (template: CommandTemplate) => {
    if (template.session_id) return t("settings.templates.scope.session");
    if (!template.project_id) return t("settings.templates.scope.global");
    const project = projects.find((item) => item.id === template.project_id);
    return project
      ? t("settings.templates.scope.projectWithName", { name: project.name })
      : t("settings.templates.scope.project");
  };

  const commandRequired = scope !== "global";

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setShowForm(false);
      }}
    >
      <PopoverTrigger asChild>
        <button
          className={`ui-focus-ring ui-icon-action ${toneClassName}`.trim()}
          title={t("commandTemplate.title")}
          aria-label={t("commandTemplate.openPanel")}
        >
          <TerminalSquare size={14} strokeWidth={1.5} />
        </button>
      </PopoverTrigger>
      <PopoverContent id="command-template-panel" align="start" side={popoverSide} className="w-72">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-semibold text-on-surface">{t("commandTemplate.title")}</span>
          <button
            onClick={() => setShowForm((prev) => !prev)}
            className="ui-flat-action h-6 gap-1 px-2 text-[10px] text-primary"
            aria-label={showForm ? t("commandTemplate.collapseForm") : t("commandTemplate.expandForm")}
          >
            <Plus size={10} strokeWidth={2} /> {t("settings.templates.new")}
          </button>
        </div>

        {/* New template form */}
        {showForm && (
          <div className="space-y-1.5 px-3 py-2">
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
            <InlinePanelSelect
              value={scope}
              options={scopeOptions}
              onChange={(value) => setScope(value as "global" | "project" | "session")}
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
            <div className="flex justify-end gap-1">
              <button
                onClick={() => setShowForm(false)}
                className="ui-flat-action h-6 px-2 text-[10px]"
                aria-label={t("commandTemplate.cancelCreate")}
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleCreate}
                disabled={name.trim().length === 0
                  || (commandRequired && command.trim().length === 0)
                  || (scope === "project" && !projectId)
                  || (scope === "session" && !activeSessionId)}
                className="ui-flat-action ui-primary-action h-6 px-2 text-[10px] disabled:opacity-50"
                aria-label={t("commandTemplate.save")}
              >
                {t("common.save")}
              </button>
            </div>
          </div>
        )}

        {/* Template list */}
        <div className="max-h-48 overflow-y-auto">
          {panelLoading ? (
            <div className="space-y-2 px-3 py-3">
              {[1, 2, 3, 4].map((item) => (
                <div key={item} className="space-y-1">
                  <Skeleton className="h-3 w-2/3" />
                  <Skeleton className="h-2.5 w-full" />
                </div>
              ))}
            </div>
          ) : visibleTemplates.length === 0 ? (
            <EmptyState
              icon={<TerminalSquare size={20} strokeWidth={1.5} />}
              title={t("commandTemplate.emptyTitle")}
              description={t("commandTemplate.emptyDescription")}
              action={{ label: t("commandTemplate.create"), onClick: () => setShowForm(true) }}
              className="px-3 py-6"
            />
          ) : (
            visibleTemplates.map((template) => (
              <div
                key={template.id}
                className="group ui-interactive flex cursor-pointer items-center gap-2 px-3 py-1.5 text-on-surface-variant"
                onClick={() => handleRun(template)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-on-surface">{template.name}</span>
                    <span className="shrink-0 rounded-full bg-surface-container-high px-1 text-[9px] text-on-surface-variant">
                      {scopeLabel(template)}
                    </span>
                  </div>
                  <div className="truncate text-[10px] text-on-surface-variant">{template.command}</div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (template.session_id) {
                      deleteSessionTemplate(template.session_id, template.id);
                    } else {
                      void deleteTemplate(template.id);
                    }
                  }}
                  className="hidden shrink-0 text-danger opacity-70 group-hover:block"
                  aria-label={t("commandTemplate.deleteNamed", { name: template.name })}
                >
                  <Trash2 size={12} strokeWidth={1.5} />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        {!activeSessionId && (
          <div className="px-3 py-1 text-[10px] text-on-surface-variant">
            {t("commandTemplate.inactiveHint")}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
