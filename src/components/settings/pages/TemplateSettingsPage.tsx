import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useTemplateStore } from "../../../stores/templateStore";
import { useProjectStore } from "../../../stores/projectStore";
import { useTerminalStore } from "../../../stores/terminalStore";
import type { CommandTemplate } from "../../../lib/types";

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

function resolveScope(template: CommandTemplate): Scope {
  if (template.session_id) return "session";
  if (template.project_id) return "project";
  return "global";
}

export function TemplateSettingsPage({ searchValue }: TemplateSettingsPageProps) {
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
    if (template.session_id) return "会话";
    if (!template.project_id) return "全局";
    const project = projects.find((item) => item.id === template.project_id);
    return project ? `项目:${project.name}` : "项目";
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
  }, [allTemplates, keyword]);

  const selectedTemplate = useMemo(
    () => allTemplates.find((item) => item.id === selectedId) ?? null,
    [allTemplates, selectedId]
  );

  const resetToCreate = () => {
    setMode("create");
    setSelectedId(null);
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
    if (!name || !command) return;
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

  const saveDisabled = saving
    || !form.name.trim()
    || !form.command.trim()
    || (mode === "create" && form.scope === "project" && !form.projectId)
    || (mode === "create" && form.scope === "session" && !activeSessionId);

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[320px_1fr]">
      <section className="ui-surface-card rounded-2xl border border-border p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-on-surface">模板列表</div>
          <button
            onClick={resetToCreate}
            className="ui-interactive rounded-md border border-border px-2 py-1 text-[11px] text-primary"
          >
            新建模板
          </button>
        </div>

        <div className="space-y-1">
          {visibleTemplates.map((template) => {
            const active = selectedId === template.id && mode === "edit";
            return (
              <button
                key={template.id}
                onClick={() => openEditor(template)}
                className={`ui-interactive w-full rounded-xl border px-3 py-2 text-left ${
                  active ? "border-primary bg-surface-container-highest" : "border-border bg-surface-container-high"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-xs font-medium text-on-surface">{template.name}</span>
                  <span className="shrink-0 rounded-full border border-border px-1 py-0.5 text-[9px] text-on-surface-variant">
                    {scopeLabel(template)}
                  </span>
                </div>
                <div className="mt-1 truncate text-[10px] text-on-surface-variant">{template.command}</div>
              </button>
            );
          })}
          {visibleTemplates.length === 0 && (
            <div className="rounded-xl border border-dashed border-border px-3 py-8 text-center text-xs text-on-surface-variant">
              暂无匹配模板，可从右侧新建。
            </div>
          )}
        </div>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-on-surface">
              {mode === "create" ? "新建模板" : "编辑模板"}
            </div>
            <div className="mt-0.5 text-xs text-on-surface-variant">
              新建与编辑共用同一表单，避免行为分叉。
            </div>
          </div>
          {mode === "edit" && (
            <button
              onClick={() => void handleDelete()}
              className="ui-interactive rounded-md border border-danger/50 px-2 py-1 text-[11px] text-danger"
            >
              删除
            </button>
          )}
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-on-surface-variant">名称</label>
            <Input
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="例如：启动后端服务"
              className="text-xs"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-on-surface-variant">命令</label>
            <Input
              value={form.command}
              onChange={(e) => setForm((prev) => ({ ...prev, command: e.target.value }))}
              placeholder="支持 ${projectPath}, ${projectName}"
              className="text-xs"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-on-surface-variant">描述</label>
            <Input
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="可选"
              className="text-xs"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-on-surface-variant">作用域</label>
            <Select
              value={form.scope}
              onChange={(e) => setForm((prev) => ({ ...prev, scope: e.target.value as Scope }))}
              disabled={mode === "edit"}
              className="text-xs disabled:opacity-70"
            >
              <option value="global">全局</option>
              <option value="project">项目</option>
              <option value="session" disabled={!activeSessionId}>
                会话
              </option>
            </Select>
            {!activeSessionId && form.scope === "session" && (
              <div className="mt-1 text-[11px] text-warning">当前无活跃会话，不能创建会话模板。</div>
            )}
            {mode === "edit" && (
              <div className="mt-1 text-[11px] text-on-surface-variant">
                编辑模式锁定作用域，避免跨作用域迁移造成误操作。
              </div>
            )}
          </div>

          {form.scope === "project" && (
            <div>
              <label className="mb-1 block text-xs text-on-surface-variant">目标项目</label>
              <Select
                value={form.projectId ?? ""}
                onChange={(e) => setForm((prev) => ({ ...prev, projectId: e.target.value || null }))}
                disabled={mode === "edit"}
                className="text-xs disabled:opacity-70"
              >
                <option value="">请选择项目</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {form.scope === "session" && (
            <div className="rounded-lg border border-border bg-surface-container-lowest px-3 py-2 text-[11px] text-on-surface-variant">
              {activeSessionId
                ? `将绑定到当前会话：${activeSessionId}`
                : "请先激活一个会话后再创建会话模板。"}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {mode === "edit" && (
              <button
                onClick={resetToCreate}
                className="ui-interactive rounded-md border border-border px-3 py-1.5 text-xs text-on-surface-variant"
              >
                取消编辑
              </button>
            )}
            <button
              onClick={() => void handleSave()}
              disabled={saveDisabled}
              className="ui-interactive rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
