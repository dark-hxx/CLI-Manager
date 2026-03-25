import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useProjectStore } from "../stores/projectStore";
import type { Project, Group } from "../lib/types";
import { SHELL_OPTIONS } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { ChevronDown } from "./icons";
import { Portal } from "./ui/Portal";
import { toast } from "sonner";
import { logError } from "../lib/logger";
import { useFocusTrap } from "../hooks/useFocusTrap";

interface Props {
  project?: Project;
  defaultGroupId?: string | null;
  onClose: () => void;
}

const inputClass = "w-full rounded border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary outline-none";

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
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const dialogRef = useRef<HTMLFormElement | null>(null);
  useFocusTrap(dialogRef, !closing);

  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = window.setTimeout(() => {
      onClose();
    }, 180);
  }, [closing, onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [requestClose]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

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

  const validatePath = useCallback(async (rawPath: string) => {
    try {
      const results = await invoke<boolean[]>("check_paths_exist", { paths: [rawPath] });
      return Boolean(results[0]);
    } catch (err) {
      logError("Path validation failed in ConfigModal", { rawPath, err });
      return false;
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !path.trim()) {
      setError("名称和路径为必填项");
      toast.error("保存失败", { description: "名称和路径为必填项" });
      return;
    }

    const normalizedPath = path.trim();
    const pathOk = await validatePath(normalizedPath);
    if (!pathOk) {
      const description = "路径不存在或不可访问";
      setError(description);
      toast.error("路径校验失败", { description });
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
        toast.success("终端修改成功");
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
        toast.success("终端创建成功");
      }
      requestClose();
    } catch (err) {
      const description = String(err);
      setError(description);
      toast.error(isEdit ? "修改终端失败" : "新增终端失败", { description });
      logError("Failed to save project in ConfigModal", {
        isEdit,
        name: name.trim(),
        path: path.trim(),
        groupId,
        shell,
        err,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const selectedGroupName = groupId
    ? groups.find((g) => g.id === groupId)?.name ?? "未知分组"
    : "不分组";

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 ${closing ? "animate-fade-out" : "animate-fade-in"}`}
      onClick={requestClose}
    >
      <form
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className={`w-[420px] rounded-lg border border-border bg-bg-secondary p-5 ${closing ? "animate-scale-out" : "animate-scale-in"}`}
        role="dialog"
        aria-modal="true"
      >
        <h2 className="mb-4 text-base font-semibold text-text-primary">
          {isEdit ? "编辑终端" : "新增终端"}
        </h2>

        {error && (
          <div className="mb-3 rounded bg-danger/15 px-2 py-1.5 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <Field label="名称 *" value={name} onChange={setName} />

          {/* Path with folder picker */}
          <div>
            <label className="mb-1 block text-xs text-text-muted">路径 *</label>
            <div className="flex gap-1">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="C:\\我的项目\\my-app"
                className={`${inputClass} flex-1`}
              />
              <button
                type="button"
                onClick={handleBrowse}
                className="shrink-0 rounded border border-border bg-bg-tertiary px-2 py-1.5 text-xs text-text-secondary"
              >
                浏览
              </button>
            </div>
          </div>

          {/* Group selector */}
          <div>
            <label className="mb-1 block text-xs text-text-muted">分组</label>
            <GroupSelector
              groups={groups}
              value={groupId}
              onChange={setGroupId}
              displayName={selectedGroupName}
            />
          </div>

          <Field label="CLI 工具" value={cliTool} onChange={setCliTool} placeholder="claude / codex / custom" />

          <div>
            <label className="mb-1 block text-xs text-text-muted">Shell</label>
            <select
              value={shell}
              onChange={(e) => setShell(e.target.value)}
              className={inputClass}
            >
              {SHELL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <Field label="启动命令" value={startupCmd} onChange={setStartupCmd} placeholder="npm run dev" />
          <div>
            <label className="mb-1 block text-xs text-text-muted">环境变量（JSON）</label>
            <textarea
              value={envVarsText}
              onChange={(e) => setEnvVarsText(e.target.value)}
              className="h-16 w-full resize-none rounded border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary outline-none"
            />
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={requestClose}
            className="rounded border border-border px-3 py-1.5 text-sm text-text-secondary"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
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
        onConfirm={() => {
          setShowConfirmEdit(false);
          void saveProject();
        }}
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
}: {
  groups: Group[];
  value: string | null;
  onChange: (id: string | null) => void;
  displayName: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelPosition, setPanelPosition] = useState({ left: 0, top: 0 });

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const panelWidth = rect.width;
    const estimatedHeight = 220;
    const nextLeft = Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8));
    const preferredTop = rect.bottom + 4;
    const nextTop = preferredTop + estimatedHeight <= window.innerHeight - 8
      ? preferredTop
      : Math.max(8, rect.top - estimatedHeight - 4);

    setPanelPosition({ left: nextLeft, top: nextTop });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();

    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
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
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between rounded border border-border bg-bg-tertiary px-2 py-1.5 text-left text-sm text-text-primary outline-none"
      >
        <span className={value ? "" : "opacity-50"}>{displayName}</span>
        <ChevronDown size={12} strokeWidth={1.8} className="text-text-muted" />
      </button>

      {open && (
        <Portal>
          <div
            ref={panelRef}
            className="fixed z-[55] max-h-48 overflow-y-auto rounded-md border border-border bg-bg-secondary animate-slide-down"
            style={{ left: panelPosition.left, top: panelPosition.top, width: triggerRef.current?.offsetWidth ?? 200 }}
          >
            {/* No group option */}
            <button
              type="button"
              onClick={() => { onChange(null); setOpen(false); }}
              className={`w-full px-2 py-1.5 text-left text-sm transition-opacity hover:opacity-80 ${!value ? "bg-bg-tertiary text-accent" : "text-text-secondary"}`}
            >
              不分组
            </button>

            {flatList.map(({ group: g, depth }) => (
              <button
                key={g.id}
                type="button"
                onClick={() => { onChange(g.id); setOpen(false); }}
                className={`w-full py-1.5 text-left text-sm transition-opacity hover:opacity-80 ${value === g.id ? "bg-bg-tertiary text-accent" : "text-text-secondary"}`}
                style={{ paddingLeft: 8 + depth * 16, paddingRight: 8 }}
              >
                {g.name}
              </button>
            ))}

            {flatList.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-text-muted">暂无分组</div>
            )}
          </div>
        </Portal>
      )}
    </>
  );
}

function Field({
  label, value, onChange, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-text-muted">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputClass}
      />
    </div>
  );
}
