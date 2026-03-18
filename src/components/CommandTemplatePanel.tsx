import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTemplateStore } from "../stores/templateStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useProjectStore } from "../stores/projectStore";
import type { CommandTemplate, Project } from "../lib/types";
import { TerminalSquare, Plus, Trash2 } from "lucide-react";

/** Resolve template variables: ${projectPath}, ${projectName} */
function resolveCommand(command: string, project?: Project): string {
  if (!project) return command;
  return command
    .replace(/\$\{projectPath\}/g, project.path)
    .replace(/\$\{projectName\}/g, project.name);
}

export function CommandTemplatePanel() {
  const { templates, fetchTemplates, createTemplate, deleteTemplate } = useTemplateStore();
  const { sessions, activeSessionId } = useTerminalStore();
  const { projects } = useProjectStore();
  const [open, setOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowForm(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeProject = activeSession?.projectId
    ? projects.find((p) => p.id === activeSession.projectId)
    : undefined;

  // Show templates relevant to the active project
  const visibleTemplates = templates.filter(
    (t) => t.project_id === null || t.project_id === activeSession?.projectId
  );

  const handleRun = async (template: CommandTemplate) => {
    if (!activeSessionId) return;
    const resolved = resolveCommand(template.command, activeProject);
    await invoke("pty_write", { sessionId: activeSessionId, data: resolved + "\r" });
    setOpen(false);
  };

  const handleCreate = async () => {
    if (!name.trim() || !command.trim()) return;
    await createTemplate({
      project_id: projectId,
      name: name.trim(),
      command: command.trim(),
      description: description.trim(),
    });
    setName("");
    setCommand("");
    setDescription("");
    setProjectId(null);
    setShowForm(false);
  };

  const inputStyle = {
    backgroundColor: "var(--bg-tertiary)",
    borderColor: "var(--border)",
    color: "var(--text-primary)",
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 h-6 rounded-md text-xs border hover:opacity-100 transition-opacity"
        style={{ color: "var(--text-muted)", borderColor: "var(--border)", backgroundColor: "var(--bg-tertiary)", opacity: 0.9 }}
        title="Command templates"
      >
        <TerminalSquare size={14} strokeWidth={1.5} />
        <span>Templates</span>
      </button>

      {open && (
        <div
          className="absolute top-8 left-0 z-50 w-72 rounded-lg border shadow-lg overflow-hidden"
          style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--border)", animation: "slide-down var(--animate-duration-fast) ease-out" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: "var(--border)" }}>
            <span className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
              命令模板
            </span>
            <button
              onClick={() => setShowForm(!showForm)}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border"
              style={{ borderColor: "var(--border)", color: "var(--accent)" }}
            >
              <Plus size={10} strokeWidth={2} /> 新增
            </button>
          </div>

          {/* New template form */}
          {showForm && (
            <div className="px-3 py-2 border-b space-y-1.5" style={{ borderColor: "var(--border)" }}>
              <input
                type="text"
                placeholder="名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-2 py-1 text-xs rounded border outline-none"
                style={inputStyle}
              />
              <input
                type="text"
                placeholder="命令（支持 ${projectPath}, ${projectName}）"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                className="w-full px-2 py-1 text-xs rounded border outline-none"
                style={inputStyle}
              />
              <input
                type="text"
                placeholder="描述（可选）"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-2 py-1 text-xs rounded border outline-none"
                style={inputStyle}
              />
              <select
                value={projectId ?? ""}
                onChange={(e) => setProjectId(e.target.value || null)}
                className="w-full px-2 py-1 text-xs rounded border outline-none"
                style={inputStyle}
              >
                <option value="">全局模板</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <div className="flex justify-end gap-1">
                <button
                  onClick={() => setShowForm(false)}
                  className="px-2 py-0.5 text-[10px] rounded border"
                  style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
                >
                  取消
                </button>
                <button
                  onClick={handleCreate}
                  className="px-2 py-0.5 text-[10px] rounded"
                  style={{ backgroundColor: "var(--accent)", color: "#fff" }}
                >
                  保存
                </button>
              </div>
            </div>
          )}

          {/* Template list */}
          <div className="max-h-48 overflow-y-auto">
            {visibleTemplates.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                暂无模板
              </div>
            ) : (
              visibleTemplates.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-2 px-3 py-1.5 cursor-pointer group transition-colors"
                  style={{ color: "var(--text-secondary)" }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--bg-tertiary)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                  onClick={() => handleRun(t)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium truncate" style={{ color: "var(--text-primary)" }}>
                        {t.name}
                      </span>
                      {t.project_id && (
                        <span className="text-[9px] px-1 rounded-full border shrink-0"
                          style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
                          项目
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] truncate" style={{ color: "var(--text-muted)" }}>
                      {t.command}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteTemplate(t.id); }}
                    className="hidden group-hover:block shrink-0"
                    style={{ color: "var(--danger)", opacity: 0.7 }}
                  >
                    <Trash2 size={12} strokeWidth={1.5} />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Footer hint */}
          {!activeSessionId && (
            <div className="px-3 py-1 text-[10px] border-t" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
              请先打开终端再运行模板
            </div>
          )}
        </div>
      )}
    </div>
  );
}
