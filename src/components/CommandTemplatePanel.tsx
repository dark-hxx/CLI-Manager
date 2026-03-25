import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTemplateStore } from "../stores/templateStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useProjectStore } from "../stores/projectStore";
import type { CommandTemplate, Project } from "../lib/types";
import { TerminalSquare, Plus, Trash2 } from "./icons";
import { Portal } from "./ui/Portal";
import { EmptyState } from "./ui/EmptyState";
import { Skeleton } from "./ui/Skeleton";
import { toast } from "sonner";
import { logError } from "../lib/logger";

/** Resolve template variables: ${projectPath}, ${projectName} */
function resolveCommand(command: string, project?: Project): string {
  if (!project) return command;
  return command
    .replace(/\$\{projectPath\}/g, project.path)
    .replace(/\$\{projectName\}/g, project.name);
}

interface PanelPosition {
  left: number;
  top: number;
}

export function CommandTemplatePanel() {
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelPosition, setPanelPosition] = useState<PanelPosition>({ left: 0, top: 0 });

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const panelWidth = 288;
    const estimatedHeight = showForm ? 420 : 280;
    const nextLeft = Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8));
    const preferredTop = rect.bottom + 6;
    const nextTop = preferredTop + estimatedHeight <= window.innerHeight - 8
      ? preferredTop
      : Math.max(8, rect.top - estimatedHeight - 6);

    setPanelPosition({ left: nextLeft, top: nextTop });
  }, [showForm]);

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

  useEffect(() => {
    if (!open) return;
    updatePosition();

    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
      setShowForm(false);
    };

    const reposition = () => updatePosition();

    document.addEventListener("mousedown", handler);
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (open) {
      updatePosition();
    }
  }, [open, showForm, updatePosition]);

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
      toast.error("执行模板命令失败", { description: String(err) });
      logError("Failed to run command template", {
        templateId: template.id,
        sessionId: activeSessionId,
        err,
      });
    }
  };

  const handleCreate = async () => {
    if (!name.trim() || !command.trim()) return;

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
      toast.success("模板保存成功");
    } catch (err) {
      toast.error("模板保存失败", { description: String(err) });
      logError("Failed to save command template", {
        scope,
        projectId,
        activeSessionId,
        err,
      });
    }
  };

  const scopeLabel = (template: CommandTemplate) => {
    if (template.session_id) return "会话";
    if (!template.project_id) return "全局";
    const project = projects.find((item) => item.id === template.project_id);
    return project ? `项目:${project.name}` : "项目";
  };

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-6 items-center gap-1.5 rounded-md border border-border bg-bg-tertiary px-2.5 text-xs text-text-muted opacity-90 transition-opacity hover:opacity-100"
        title="Command templates"
      >
        <TerminalSquare size={14} strokeWidth={1.5} />
        <span>Templates</span>
      </button>

      {open && (
        <Portal>
          <div
            ref={panelRef}
            className="fixed z-40 w-72 overflow-hidden rounded-lg border border-border bg-bg-secondary shadow-lg animate-slide-down"
            style={{ left: panelPosition.left, top: panelPosition.top }}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-xs font-semibold text-text-primary">命令模板</span>
              <button
                onClick={() => setShowForm((prev) => !prev)}
                className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-accent"
              >
                <Plus size={10} strokeWidth={2} /> 新增
              </button>
            </div>

            {/* New template form */}
            {showForm && (
              <div className="space-y-1.5 border-b border-border px-3 py-2">
                <input
                  type="text"
                  placeholder="名称"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary outline-none"
                />
                <input
                  type="text"
                  placeholder="命令（支持 ${projectPath}, ${projectName}）"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary outline-none"
                />
                <input
                  type="text"
                  placeholder="描述（可选）"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary outline-none"
                />
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as "global" | "project" | "session")}
                  className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary outline-none"
                >
                  <option value="global">全局模板</option>
                  <option value="project">项目模板</option>
                  <option value="session">会话模板（单次终端）</option>
                </select>
                {scope === "project" && (
                  <select
                    value={projectId ?? ""}
                    onChange={(e) => setProjectId(e.target.value || null)}
                    className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary outline-none"
                  >
                    <option value="">请选择项目</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                )}
                {scope === "session" && (
                  <div className="text-[10px] text-text-muted">
                    {activeSessionId ? `绑定到当前会话 ${activeSessionId}` : "请先打开会话终端"}
                  </div>
                )}
                <div className="flex justify-end gap-1">
                  <button
                    onClick={() => setShowForm(false)}
                    className="rounded border border-border px-2 py-0.5 text-[10px] text-text-muted"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleCreate}
                    disabled={(scope === "project" && !projectId) || (scope === "session" && !activeSessionId)}
                    className="rounded bg-accent px-2 py-0.5 text-[10px] text-white disabled:opacity-50"
                  >
                    保存
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
                  title="暂无模板"
                  description="创建第一个模板后，可在当前终端一键执行。"
                  action={{ label: "创建模板", onClick: () => setShowForm(true) }}
                  className="px-3 py-6"
                />
              ) : (
                visibleTemplates.map((t) => (
                  <div
                    key={t.id}
                    className="group flex cursor-pointer items-center gap-2 px-3 py-1.5 text-text-secondary transition-colors hover:bg-bg-tertiary"
                    onClick={() => handleRun(t)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-text-primary">{t.name}</span>
                        <span className="shrink-0 rounded-full border border-border px-1 text-[9px] text-text-muted">
                          {scopeLabel(t)}
                        </span>
                      </div>
                      <div className="truncate text-[10px] text-text-muted">{t.command}</div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (t.session_id) {
                          deleteSessionTemplate(t.session_id, t.id);
                        } else {
                          void deleteTemplate(t.id);
                        }
                      }}
                      className="hidden shrink-0 text-danger opacity-70 group-hover:block"
                    >
                      <Trash2 size={12} strokeWidth={1.5} />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Footer hint */}
            {!activeSessionId && (
              <div className="border-t border-border px-3 py-1 text-[10px] text-text-muted">
                当前无活跃终端，仅可管理全局/项目模板
              </div>
            )}
          </div>
        </Portal>
      )}
    </>
  );
}
