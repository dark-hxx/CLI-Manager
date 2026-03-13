import { useState, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useProjectStore } from "../stores/projectStore";
import type { Project, Group } from "../lib/types";
import { SHELL_OPTIONS } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  project?: Project;
  defaultGroupId?: string | null;
  onClose: () => void;
}

export function ConfigModal({ project, defaultGroupId, onClose }: Props) {
  const { createProject, updateProject, groups } = useProjectStore();
  const isEdit = !!project;

  const [name, setName] = useState(project?.name ?? "");
  const [path, setPath] = useState(project?.path ?? "");
  const [groupId, setGroupId] = useState<string | null>(
    project?.group_id ?? defaultGroupId ?? null
  );
  const [cliTool, setCliTool] = useState(project?.cli_tool ?? "");
  const [startupCmd, setStartupCmd] = useState(project?.startup_cmd ?? "");
  const [shell, setShell] = useState(project?.shell ?? "powershell");
  const [envVarsText, setEnvVarsText] = useState(project?.env_vars ?? "{}");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showConfirmEdit, setShowConfirmEdit] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleBrowse = async () => {
    const selected = await open({ directory: true, title: "选择项目目录" });
    if (selected) {
      setPath(selected);
      if (!name.trim()) {
        const folderName = selected.replace(/\\/g, "/").split("/").pop() ?? "";
        setName(folderName);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !path.trim()) {
      setError("名称和路径为必填项");
      return;
    }
    setError("");
    if (isEdit) {
      setShowConfirmEdit(true);
      return;
    }
    await saveProject();
  };

  const saveProject = async () => {
    setSubmitting(true);
    try {
      if (isEdit && project) {
        await updateProject(project.id, {
          name: name.trim(),
          path: path.trim(),
          group_id: groupId,
          cli_tool: cliTool.trim(),
          startup_cmd: startupCmd.trim(),
          env_vars: envVarsText.trim(),
          shell,
        });
      } else {
        await createProject({
          name: name.trim(),
          path: path.trim(),
          group_id: groupId,
          cli_tool: cliTool.trim() || undefined,
          startup_cmd: startupCmd.trim() || undefined,
          env_vars: envVarsText.trim() || undefined,
          shell,
        });
      }
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle = {
    backgroundColor: "var(--bg-tertiary)",
    borderColor: "var(--border)",
    color: "var(--text-primary)",
  };

  const selectedGroupName = groupId
    ? groups.find((g) => g.id === groupId)?.name ?? "未知分组"
    : "不分组";

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-[420px] rounded-lg p-5 border"
        style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--border)" }}
      >
        <h2 className="text-base font-semibold mb-4">
          {isEdit ? "编辑终端" : "新增终端"}
        </h2>

        {error && (
          <div className="text-xs mb-3 px-2 py-1.5 rounded" style={{ backgroundColor: "rgba(247,118,142,0.15)", color: "var(--danger)" }}>
            {error}
          </div>
        )}

        <div className="space-y-3">
          <Field label="名称 *" value={name} onChange={setName} style={inputStyle} />

          {/* Path with folder picker */}
          <div>
            <label className="text-xs block mb-1" style={{ color: "var(--text-muted)" }}>路径 *</label>
            <div className="flex gap-1">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="C:\\我的项目\\my-app"
                className="flex-1 px-2 py-1.5 text-sm rounded border outline-none"
                style={inputStyle}
              />
              <button
                type="button"
                onClick={handleBrowse}
                className="px-2 py-1.5 text-xs rounded border shrink-0"
                style={{ borderColor: "var(--border)", color: "var(--text-secondary)", backgroundColor: "var(--bg-tertiary)" }}
              >
                浏览
              </button>
            </div>
          </div>

          {/* Group selector */}
          <div>
            <label className="text-xs block mb-1" style={{ color: "var(--text-muted)" }}>分组</label>
            <GroupSelector
              groups={groups}
              value={groupId}
              onChange={setGroupId}
              displayName={selectedGroupName}
              inputStyle={inputStyle}
            />
          </div>

          <Field label="CLI 工具" value={cliTool} onChange={setCliTool} style={inputStyle} placeholder="claude / codex / custom" />

          <div>
            <label className="text-xs block mb-1" style={{ color: "var(--text-muted)" }}>Shell</label>
            <select
              value={shell}
              onChange={(e) => setShell(e.target.value)}
              className="w-full px-2 py-1.5 text-sm rounded border outline-none"
              style={inputStyle}
            >
              {SHELL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <Field label="启动命令" value={startupCmd} onChange={setStartupCmd} style={inputStyle} placeholder="npm run dev" />
          <div>
            <label className="text-xs block mb-1" style={{ color: "var(--text-muted)" }}>
              环境变量（JSON）
            </label>
            <textarea
              value={envVarsText}
              onChange={(e) => setEnvVarsText(e.target.value)}
              className="w-full px-2 py-1.5 text-sm rounded border outline-none resize-none h-16"
              style={inputStyle}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border"
            style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
          >
            取消
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-3 py-1.5 text-sm rounded disabled:opacity-50"
            style={{ backgroundColor: "var(--accent)", color: "#fff" }}
          >
            {submitting ? "保存中..." : isEdit ? "保存" : "新增"}
          </button>
        </div>
      </form>

      <ConfirmDialog
        open={showConfirmEdit}
        title="确认修改终端？"
        message="将保存当前修改内容。"
        confirmText="确认保存"
        onConfirm={() => { setShowConfirmEdit(false); saveProject(); }}
        onClose={() => setShowConfirmEdit(false)}
      />
    </div>
  );
}

// --- Group tree selector ---

function GroupSelector({
  groups,
  value,
  onChange,
  displayName,
  inputStyle,
}: {
  groups: Group[];
  value: string | null;
  onChange: (id: string | null) => void;
  displayName: string;
  inputStyle: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Build flat indented list
  const groupMap = new Map<string | null, Group[]>();
  for (const g of groups) {
    const arr = groupMap.get(g.parent_id) ?? [];
    arr.push(g);
    groupMap.set(g.parent_id, arr);
  }

  type FlatItem = { group: Group; depth: number };
  const flatList: FlatItem[] = [];

  function flatten(parentId: string | null, depth: number) {
    const children = (groupMap.get(parentId) ?? []).sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    );
    for (const g of children) {
      flatList.push({ group: g, depth });
      flatten(g.id, depth + 1);
    }
  }
  flatten(null, 0);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full px-2 py-1.5 text-sm rounded border outline-none text-left flex items-center justify-between"
        style={inputStyle}
      >
        <span className={value ? "" : "opacity-50"}>{displayName}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 6L8 10L12 6" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute z-10 left-0 right-0 mt-1 rounded-md border max-h-48 overflow-y-auto"
          style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--border)" }}
        >
          {/* No group option */}
          <button
            type="button"
            onClick={() => { onChange(null); setOpen(false); }}
            className="w-full text-left px-2 py-1.5 text-sm hover:opacity-80 transition-opacity"
            style={{
              color: !value ? "var(--accent)" : "var(--text-secondary)",
              backgroundColor: !value ? "var(--bg-tertiary)" : "transparent",
            }}
          >
            不分组
          </button>

          {flatList.map(({ group: g, depth }) => (
            <button
              key={g.id}
              type="button"
              onClick={() => { onChange(g.id); setOpen(false); }}
              className="w-full text-left py-1.5 text-sm hover:opacity-80 transition-opacity"
              style={{
                paddingLeft: 8 + depth * 16,
                paddingRight: 8,
                color: value === g.id ? "var(--accent)" : "var(--text-secondary)",
                backgroundColor: value === g.id ? "var(--bg-tertiary)" : "transparent",
              }}
            >
              {g.name}
            </button>
          ))}

          {flatList.length === 0 && (
            <div className="px-2 py-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
              暂无分组
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label, value, onChange, style, placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void;
  style: React.CSSProperties; placeholder?: string;
}) {
  return (
    <div>
      <label className="text-xs block mb-1" style={{ color: "var(--text-muted)" }}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-2 py-1.5 text-sm rounded border outline-none"
        style={style}
      />
    </div>
  );
}
