import { useState, useRef, useEffect, useCallback, useId, useMemo, type Ref } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useProjectStore } from "../stores/projectStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { Project, Group, ProjectFileEntry, ProjectEnvironmentType, WorktreeIsolationStrategy } from "../lib/types";
import { useSshHostStore } from "../stores/sshHostStore";
import { buildSshConnectionSpec } from "../lib/ssh";
import { DEFAULT_SSH_TOOL_CONFIG_ROOT, resolveSshToolSource, validateSshToolConfigRoot } from "../lib/sshToolIntegration";
import { getOsPlatform, normalizeShellKey } from "../lib/shell";
import { getConfigModalShellPrefill } from "../lib/configModalShellPrefill";
import { CLI_TOOL_DESCRIPTORS } from "../lib/cliTools";
import type { OsPlatform } from "../lib/shell";
import { getEnabledTerminalShellOptions } from "../lib/terminalShellProfiles";
import { ConfirmDialog } from "./ConfirmDialog";
import { Check, ChevronDown } from "./icons";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { VendorIcon, inferVendor } from "./VendorIcon";
import { CliToolIcon } from "./CliToolIcon";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { toast } from "sonner";
import { logError, logInfo, logWarn } from "../lib/logger";
import { pickByLanguage, useI18n, type TranslationKey } from "../lib/i18n";
import { ArrowUp, ChevronRight, FolderOpen } from "lucide-react";
import {
  getCliArgsHistorySuggestions,
  type CliArgsHistoryEntry,
} from "../lib/cliArgsHistory";

interface Props {
  project?: Project;
  cloneFrom?: Project;
  defaultGroupId?: string | null;
  onManageSshHosts?: () => void;
  onClose: () => void;
}

interface SshPathCheckResult {
  exists: boolean;
  accessible: boolean;
  gitRepository: boolean;
}

interface SshDirectoryEntry {
  name: string;
  path: string;
}

const CLI_TOOL_OPTIONS = CLI_TOOL_DESCRIPTORS.map((tool) => tool.command);
const WORKTREE_STRATEGIES: WorktreeIsolationStrategy[] = ["disabled", "prompt", "autoParallel", "always"];
const WORKTREE_STRATEGY_LABEL_KEYS: Record<WorktreeIsolationStrategy, TranslationKey> = {
  prompt: "worktree.strategy.prompt",
  disabled: "worktree.strategy.disabled",
  autoParallel: "worktree.strategy.autoParallel",
  always: "worktree.strategy.always",
};
const DEFAULT_WSL_PICKER_PATH = "\\\\wsl.localhost\\Ubuntu-22.04\\data";

function normalizeWslUncInput(value: string): string {
  return value.trim().replace(/\//g, "\\").replace(/\\+$/, "");
}

function isWslUncPath(value: string): boolean {
  const normalized = normalizeWslUncInput(value).toLowerCase();
  return normalized.startsWith("\\\\wsl.localhost\\") || normalized.startsWith("\\\\wsl$\\");
}

function parentWslUncPath(value: string): string {
  const normalized = normalizeWslUncInput(value);
  const parts = normalized.split("\\").filter(Boolean);
  if (parts.length <= 3) return normalized;
  const index = normalized.lastIndexOf("\\");
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function childWslUncPath(root: string, name: string): string {
  return `${normalizeWslUncInput(root)}\\${name}`;
}

function basenameFromPath(value: string): string {
  return value.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
}

function initialWslPickerPath(currentPath: string): string {
  const normalized = normalizeWslUncInput(currentPath);
  return isWslUncPath(normalized) ? parentWslUncPath(normalized) : DEFAULT_WSL_PICKER_PATH;
}

export function ConfigModal({ project, cloneFrom, defaultGroupId, onManageSshHosts, onClose }: Props) {
  const { language, t } = useI18n();
  const text = (zh: string, en: string) => pickByLanguage(language, zh, en);
  const { createProject, updateProject, groups } = useProjectStore();
  const sshHosts = useSshHostStore((state) => state.hosts);
  const fetchSshHosts = useSshHostStore((state) => state.fetchHosts);
  const symlinkCompatibilityEnabled = useSettingsStore((s) => s.symlinkCompatibilityEnabled);
  const projectWorktreeConfigEnabled = useSettingsStore((s) => s.projectWorktreeConfigEnabled);
  const terminalShellProfiles = useSettingsStore((s) => s.terminalShellProfiles);
  const defaultShell = useSettingsStore((s) => s.defaultShell);
  const cliArgsHistory = useSettingsStore((s) => s.cliArgsHistory);
  const recordCliArgsHistory = useSettingsStore((s) => s.recordCliArgsHistory);
  const isEdit = !!project;
  const isClone = !!cloneFrom;
  const logInstanceIdRef = useRef(crypto.randomUUID().slice(0, 8));
  const previousFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const dialogDescriptionId = useId();
  const projectTypeFieldId = useId();
  const nameFieldId = useId();
  const pathFieldId = useId();
  const cliToolFieldId = useId();
  const cliToolLabelId = useId();
  const shellFieldId = useId();
  const worktreeDepsPromptFieldId = useId();
  const sshHostFieldId = useId();
  const remotePathFieldId = useId();
  const cliConfigRootFieldId = useId();

  const [osPlatform, setOsPlatform] = useState<OsPlatform>("windows");

  const [name, setName] = useState(
    cloneFrom ? t("configModal.cloneName", { name: cloneFrom.name }) : (project?.name ?? "")
  );
  const [path, setPath] = useState(cloneFrom?.path ?? project?.path ?? "");
  const sourceProject = cloneFrom ?? project;
  const [projectType, setProjectType] = useState<"local" | "ssh">(
    sourceProject?.environment_type === "ssh" ? "ssh" : "local"
  );
  const [sshHostId, setSshHostId] = useState(sourceProject?.ssh_host_id ?? "");
  const [remotePath, setRemotePath] = useState(sourceProject?.remote_path ?? "");
  const [cliConfigRoot, setCliConfigRoot] = useState(sourceProject?.cli_config_root ?? "");
  const [remotePickerOpen, setRemotePickerOpen] = useState(false);
  const [remotePickerTarget, setRemotePickerTarget] = useState<"projectPath" | "cliConfigRoot">("projectPath");
  const [remotePickerPath, setRemotePickerPath] = useState(sourceProject?.remote_path || "/");
  const [remoteDirectories, setRemoteDirectories] = useState<SshDirectoryEntry[]>([]);
  const [remotePickerLoading, setRemotePickerLoading] = useState(false);
  const [remotePickerError, setRemotePickerError] = useState("");
  const [remotePathStatus, setRemotePathStatus] = useState<SshPathCheckResult | null>(null);
  const [groupId, setGroupId] = useState<string | null>(
    cloneFrom?.group_id ?? project?.group_id ?? defaultGroupId ?? null
  );
  const [cliTool, setCliTool] = useState(cloneFrom?.cli_tool ?? project?.cli_tool ?? "");
  const [cliArgs, setCliArgs] = useState(cloneFrom?.cli_args ?? project?.cli_args ?? "");
  const [startupCmd, setStartupCmd] = useState(cloneFrom?.startup_cmd ?? project?.startup_cmd ?? "");
  const [shell, setShell] = useState(cloneFrom?.shell ?? project?.shell ?? "");
  const [envVarsText, setEnvVarsText] = useState(cloneFrom?.env_vars ?? project?.env_vars ?? "{}");
  const [worktreeStrategy, setWorktreeStrategy] = useState<WorktreeIsolationStrategy>(
    cloneFrom?.worktree_strategy ?? project?.worktree_strategy ?? "disabled"
  );
  const [worktreeRoot, setWorktreeRoot] = useState(cloneFrom?.worktree_root ?? project?.worktree_root ?? "");
  const [worktreeDepsPromptEnabled, setWorktreeDepsPromptEnabled] = useState(
    Boolean(cloneFrom?.worktree_deps_prompt_enabled ?? project?.worktree_deps_prompt_enabled ?? 0)
  );
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showConfirmEdit, setShowConfirmEdit] = useState(false);
  const [cliToolComboboxOpen, setCliToolComboboxOpen] = useState(false);
  const [wslPickerOpen, setWslPickerOpen] = useState(false);
  const [wslPickerPath, setWslPickerPath] = useState(DEFAULT_WSL_PICKER_PATH);
  const [wslPickerEntries, setWslPickerEntries] = useState<ProjectFileEntry[]>([]);
  const [wslPickerLoading, setWslPickerLoading] = useState(false);
  const [wslPickerError, setWslPickerError] = useState("");
  const cliArgsHistorySuggestions = useMemo(
    () => getCliArgsHistorySuggestions(cliArgsHistory, cliTool, undefined, cliArgs),
    [cliArgsHistory, cliTool, cliArgs]
  );

  useEffect(() => {
    void fetchSshHosts();
  }, [fetchSshHosts]);

  const resolveFallbackShell = useCallback((platform: OsPlatform) => {
    const enabledOptions = getEnabledTerminalShellOptions(platform, terminalShellProfiles);
    const normalizedDefaultShell = normalizeShellKey(defaultShell);
    const preferred =
      enabledOptions.find((option) => option.value === defaultShell)?.value ??
      enabledOptions.find((option) => normalizeShellKey(option.value) === normalizedDefaultShell)?.value;
    return preferred ?? enabledOptions[0]?.value ?? "";
  }, [defaultShell, terminalShellProfiles]);

  useEffect(() => {
    logInfo("[config-modal] mounted", {
      instanceId: logInstanceIdRef.current,
      isEdit,
      isClone,
    });
    return () => {
      logInfo("[config-modal] unmounted", {
        instanceId: logInstanceIdRef.current,
        isEdit,
        isClone,
      });
    };
  }, [isClone, isEdit]);

  // Detect OS and set default shell on mount
  useEffect(() => {
    void (async () => {
      const platform = await getOsPlatform();
      setOsPlatform(platform);
      setShell((currentShell) => {
        const resolvedShell = getConfigModalShellPrefill(platform, currentShell, isEdit, isClone);
        const nextShell = resolvedShell.trim() || (!isEdit && !isClone ? resolveFallbackShell(platform) : "");
        logInfo("[config-modal] resolved shell prefill", {
          instanceId: logInstanceIdRef.current,
          platform,
          currentShell,
          resolvedShell: nextShell,
          isEdit,
          isClone,
        });
        if (platform === "macos" && !isEdit && !isClone && !nextShell.trim()) {
          logWarn("[config-modal] macOS new terminal modal resolved empty shell prefill", {
            currentShell,
            resolvedShell: nextShell,
          });
        }
        return nextShell;
      });
    })().catch((err) => {
      logError("[config-modal] failed to resolve shell prefill", { err, isEdit, isClone });
    });
  }, [isClone, isEdit, resolveFallbackShell]);

  useEffect(() => {
    if (isEdit || isClone || osPlatform === "unknown") return;
    if (!shell.trim()) {
      const fallbackShell = resolveFallbackShell(osPlatform);
      if (fallbackShell) {
        setShell(fallbackShell);
        return;
      }
    }
    const effectiveShell = getConfigModalShellPrefill(osPlatform, shell, isEdit, isClone);
    const optionValues = getEnabledTerminalShellOptions(osPlatform, terminalShellProfiles).map((opt) => opt.value);
    const hasShellOption = optionValues.includes(effectiveShell);
    logInfo("[config-modal] shell select state", {
      instanceId: logInstanceIdRef.current,
      osPlatform,
      shell,
      effectiveShell,
      hasShellOption,
      optionValues,
    });
    if (osPlatform === "macos" && !effectiveShell.trim()) {
      logWarn("[config-modal] macOS new terminal modal still has empty shell state", {
        shell,
        effectiveShell,
        optionValues,
      });
    }
  }, [isClone, isEdit, osPlatform, resolveFallbackShell, shell, terminalShellProfiles]);

  useEffect(() => {
    if (!wslPickerOpen) return;
    const rootPath = normalizeWslUncInput(wslPickerPath);
    if (!isWslUncPath(rootPath)) {
      setWslPickerEntries([]);
      setWslPickerError(t("configModal.wslPickerInvalidPath"));
      return;
    }

    let cancelled = false;
    setWslPickerLoading(true);
    setWslPickerError("");
    void invoke<ProjectFileEntry[]>("file_list_dir", { rootPath, relativePath: "" })
      .then((entries) => {
        if (cancelled) return;
        setWslPickerEntries(entries.filter((entry) => entry.kind === "directory" && entry.isSymlink === true));
      })
      .catch((err) => {
        if (cancelled) return;
        setWslPickerEntries([]);
        setWslPickerError(String(err));
      })
      .finally(() => {
        if (!cancelled) setWslPickerLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [t, wslPickerOpen, wslPickerPath]);

  const applySelectedPath = (selected: string | string[] | null) => {
    if (selected) {
      const selectedPath = Array.isArray(selected) ? selected[0] : selected;
      if (!selectedPath) return;
      setPath(selectedPath);
      if (!name.trim()) {
        const folderName = selectedPath.replace(/\\/g, "/").split("/").pop() ?? "";
        setName(folderName);
      }
    }
  };

  const handleBrowse = async () => {
    applySelectedPath(await open({ directory: true, title: t("configModal.chooseProjectDirectory") }));
  };

  const handleBrowseSymlink = async () => {
    setWslPickerPath(initialWslPickerPath(path));
    setWslPickerOpen(true);
  };

  const selectedSshHost = sshHosts.find((host) => host.id === sshHostId) ?? null;

  const describeRemotePathError = useCallback((err: unknown) => {
    const code = String(err);
    if (code === "ssh_interactive_auth_required") return t("configModal.ssh.interactiveBrowseUnavailable");
    if (code === "ssh_remote_path_invalid") return t("configModal.ssh.pathInvalid");
    if (code === "ssh_remote_path_parent_forbidden") return t("configModal.ssh.pathParentForbidden");
    return code;
  }, [t]);

  const checkRemotePath = async () => {
    if (!selectedSshHost || !remotePath.trim()) {
      setError(t("configModal.ssh.required"));
      return;
    }
    setRemotePathStatus(null);
    setError("");
    try {
      const result = await invoke<SshPathCheckResult>("ssh_check_path", {
        spec: buildSshConnectionSpec(selectedSshHost, sshHosts),
        path: remotePath.trim(),
      });
      setRemotePathStatus(result);
      if (!result.exists || !result.accessible) setError(t("configModal.ssh.pathUnavailable"));
    } catch (err) {
      setError(describeRemotePathError(err));
    }
  };

  const loadRemoteDirectories = useCallback(async (nextPath: string) => {
    const normalizedPath = nextPath.trim() || "/";
    setRemotePickerPath(normalizedPath);
    const host = sshHosts.find((candidate) => candidate.id === sshHostId);
    if (!host) {
      setRemotePickerError(t("configModal.ssh.selectHost"));
      return;
    }
    setRemotePickerLoading(true);
    setRemotePickerError("");
    try {
      const entries = await invoke<SshDirectoryEntry[]>("ssh_list_directories", {
        spec: buildSshConnectionSpec(host, sshHosts),
        path: normalizedPath,
      });
      setRemoteDirectories(entries);
    } catch (err) {
      setRemoteDirectories([]);
      setRemotePickerError(describeRemotePathError(err));
    } finally {
      setRemotePickerLoading(false);
    }
  }, [describeRemotePathError, sshHostId, sshHosts, t]);

  const openRemotePicker = (target: "projectPath" | "cliConfigRoot") => {
    const initialPath = target === "projectPath" ? remotePath.trim() || "/" : cliConfigRoot.trim() || "/";
    setRemotePickerTarget(target);
    setRemotePickerOpen(true);
    void loadRemoteDirectories(initialPath);
  };

  const selectWslPickerPath = (selectedPath: string) => {
    setPath(selectedPath);
    if (!name.trim()) setName(basenameFromPath(selectedPath));
    setWslPickerOpen(false);
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
    const requiredFieldsReady = projectType === "ssh"
      ? Boolean(name.trim() && sshHostId && remotePath.trim())
      : Boolean(name.trim() && path.trim());
    if (!requiredFieldsReady) {
      const description = projectType === "ssh"
        ? t("configModal.ssh.required")
        : t("configModal.local.required");
      setError(description);
      toast.error(t("configModal.saveFailed"), { description });
      return;
    }

    if (projectType === "local") {
      const normalizedPath = path.trim();
      const pathOk = await validatePath(normalizedPath);
      if (!pathOk) {
        const description = t("configModal.local.pathUnavailable");
        setError(description);
        toast.error(t("configModal.local.pathValidationFailed"), { description });
        return;
      }
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
    // CLI 工具与启动命令在表单里二选一：保存时清空被隐藏的字段，避免残留配置继续生效。
    const trimmedCliTool = cliTool.trim();
    const trimmedCliArgs = trimmedCliTool ? cliArgs.trim() : "";
    const trimmedStartupCmd = trimmedCliTool ? "" : startupCmd.trim();
    const sshToolSource = projectType === "ssh" ? resolveSshToolSource(trimmedCliTool) : null;
    const trimmedCliConfigRoot = sshToolSource ? cliConfigRoot.trim() : "";
    const cliConfigRootError = validateSshToolConfigRoot(trimmedCliConfigRoot);
    if (cliConfigRootError) {
      const description = t(`configModal.ssh.${cliConfigRootError}` as TranslationKey);
      setError(description);
      toast.error(t("configModal.saveFailed"), { description });
      setSubmitting(false);
      return;
    }
    try {
      const environmentType: ProjectEnvironmentType = projectType === "ssh"
        ? "ssh"
        : isWslUncPath(path.trim()) ? "wsl" : "local";
      if (isEdit && project) {
        await updateProject(project.id, {
          name: name.trim(),
          path: projectType === "ssh" ? "" : path.trim(),
          group_id: groupId,
          cli_tool: trimmedCliTool,
          cli_args: trimmedCliArgs,
          startup_cmd: trimmedStartupCmd,
          env_vars: envVarsText.trim(),
          shell: projectType === "ssh" ? "" : shell,
          worktree_strategy: projectType === "ssh" ? "disabled" : worktreeStrategy,
          worktree_root: projectType === "ssh" ? "" : worktreeRoot.trim(),
          worktree_deps_prompt_enabled: projectType === "ssh" ? 0 : worktreeDepsPromptEnabled ? 1 : 0,
          environment_type: environmentType,
          ssh_host_id: projectType === "ssh" ? sshHostId : null,
          remote_path: projectType === "ssh" ? remotePath.trim() : "",
          cli_config_root: trimmedCliConfigRoot,
        });
        toast.success(t("configModal.toast.updated"));
      } else {
        await createProject({
          name: name.trim(),
          path: projectType === "ssh" ? "" : path.trim(),
          group_id: groupId,
          cli_tool: trimmedCliTool || undefined,
          cli_args: trimmedCliArgs || undefined,
          startup_cmd: trimmedStartupCmd || undefined,
          env_vars: envVarsText.trim() || undefined,
          shell: projectType === "ssh" ? "" : shell,
          worktree_strategy: projectType === "ssh" ? "disabled" : worktreeStrategy,
          worktree_root: projectType === "ssh" ? undefined : worktreeRoot.trim() || undefined,
          worktree_deps_prompt_enabled: projectType === "ssh" ? 0 : worktreeDepsPromptEnabled ? 1 : 0,
          environment_type: environmentType,
          ssh_host_id: projectType === "ssh" ? sshHostId : null,
          remote_path: projectType === "ssh" ? remotePath.trim() : "",
          cli_config_root: trimmedCliConfigRoot,
        });
        toast.success(t("configModal.toast.created"));
      }
      if (!isClone && trimmedCliArgs) {
        try {
          await recordCliArgsHistory(trimmedCliTool, trimmedCliArgs);
        } catch (historyError) {
          logWarn("Failed to persist CLI arguments history", historyError);
        }
      }
      onClose();
    } catch (err) {
      const description = String(err);
      setError(description);
      toast.error(isEdit ? t("configModal.toast.updateFailed") : t("configModal.toast.createFailed"), { description });
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
    ? groups.find((g) => g.id === groupId)?.name ?? t("configModal.group.unknown")
    : t("configModal.group.none");
  const shellSelectValue = getConfigModalShellPrefill(osPlatform, shell, isEdit, isClone);
  const shellSelectKey = `${osPlatform}:${isEdit ? "edit" : isClone ? "clone" : "create"}`;

  const shellOptions = useMemo(() => {
    const enabledOptions = getEnabledTerminalShellOptions(osPlatform, terminalShellProfiles);
    const hasCurrent = Boolean(shellSelectValue) && !enabledOptions.some((option) => option.value === shellSelectValue);
    return [
      ...(hasCurrent ? [{ value: shellSelectValue, label: `${shellSelectValue}${text("（当前自定义）", " (current custom)")}` }] : []),
      ...enabledOptions,
    ];
  }, [language, osPlatform, shellSelectValue, terminalShellProfiles]);

  return (
    <>
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <DialogContent
          className="ui-config-modal w-[calc(100vw-2rem)] max-w-[540px] overflow-hidden p-0"
          showCloseButton={false}
          aria-describedby={dialogDescriptionId}
          onEscapeKeyDown={(event) => {
            const escapeTarget = event.target instanceof HTMLElement ? event.target : null;
            const hasOpenListbox = typeof document !== "undefined" && document.querySelector("[role='listbox']") !== null;
            const escapeFromOptionLayer = escapeTarget?.closest("[role='listbox'], [role='option']") !== null;
            if (!(cliToolComboboxOpen || hasOpenListbox || escapeFromOptionLayer)) return;
            event.preventDefault();
            setCliToolComboboxOpen(false);
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            nameInputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            previousFocusRef.current?.focus();
          }}
        >
          <form onSubmit={handleSubmit} className="flex max-h-[86vh] min-h-0 flex-col">
            <div className="shrink-0 border-b border-border/60 px-5 py-4">
              <DialogTitle className="text-base font-semibold text-text-primary">
                {isEdit
                  ? t("configModal.title.edit")
                  : isClone
                    ? t("configModal.title.clone")
                    : t("configModal.title.create")}
              </DialogTitle>
              <DialogDescription id={dialogDescriptionId} className="mt-1 text-xs leading-relaxed text-text-muted">
                {t("configModal.a11y.dialogDescription")}
              </DialogDescription>

              {error && (
                <div className="mt-3 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
                  {error}
                </div>
              )}
            </div>

            <div className="ui-config-modal-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <div>
                <label htmlFor={projectTypeFieldId} className="ui-config-form-label">
                  {t("configModal.projectType")}
                </label>
                <Select
                  id={projectTypeFieldId}
                  value={projectType}
                  disabled={isEdit}
                  onChange={(event) => setProjectType(event.target.value as "local" | "ssh")}
                  className="text-sm"
                >
                  <option value="local">{t("configModal.type.local")}</option>
                  <option value="ssh">{t("configModal.type.ssh")}</option>
                </Select>
              </div>
              <Field
                id={nameFieldId}
                inputRef={nameInputRef}
                label={t("configModal.name")}
                required
                value={name}
                onChange={setName}
              />

              {projectType === "local" ? <div>
                <label htmlFor={pathFieldId} className="ui-config-form-label">
                  {t("configModal.path")} <span className="text-danger">*</span>
                </label>
                <div className="flex gap-2">
                  <Input
                    id={pathFieldId}
                    type="text"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder={t("configModal.pathPlaceholder")}
                    className="min-w-0 flex-1 text-sm"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleBrowse}
                    className="h-9 shrink-0 px-3"
                  >
                    {t("common.browse")}
                  </Button>
                  {symlinkCompatibilityEnabled && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleBrowseSymlink}
                      aria-label={t("configModal.chooseSymlinkPath")}
                      title={t("configModal.chooseSymlinkPath")}
                      className="h-9 shrink-0 px-2 text-[11px]"
                    >
                      WSL
                    </Button>
                  )}
                </div>
              </div> : (
                <>
                  <div>
                    <label htmlFor={sshHostFieldId} className="ui-config-form-label">
                      {t("configModal.ssh.host")} <span className="text-danger">*</span>
                    </label>
                    <div className="flex gap-2">
                      <Select
                        id={sshHostFieldId}
                        value={sshHostId}
                        onChange={(event) => setSshHostId(event.target.value)}
                        className="min-w-0 flex-1 text-sm"
                      >
                        <option value="">{t("configModal.ssh.selectHost")}</option>
                        {sshHosts.map((host) => (
                          <option key={host.id} value={host.id}>
                            {host.name} · {host.config_alias || `${host.username ? `${host.username}@` : ""}${host.host}`}
                          </option>
                        ))}
                      </Select>
                      {onManageSshHosts && (
                        <Button type="button" variant="outline" size="sm" onClick={onManageSshHosts} className="h-9 shrink-0 px-3">
                          {t("configModal.ssh.manageHosts")}
                        </Button>
                      )}
                    </div>
                    {sshHosts.length === 0 && (
                      <p className="mt-1 text-[11px] text-warning">{t("configModal.ssh.noHosts")}</p>
                    )}
                  </div>
                  <div>
                    <label htmlFor={remotePathFieldId} className="ui-config-form-label">
                      {t("configModal.ssh.remotePath")} <span className="text-danger">*</span>
                    </label>
                    <div className="flex gap-2">
                      <Input
                        id={remotePathFieldId}
                        value={remotePath}
                        onChange={(event) => {
                          setRemotePath(event.target.value);
                          setRemotePathStatus(null);
                        }}
                        placeholder="/home/dev/projects/my-app"
                        className="min-w-0 flex-1 text-sm"
                      />
                      <Button type="button" variant="outline" size="sm" onClick={() => openRemotePicker("projectPath")} className="h-9 shrink-0 px-3">
                        {t("common.browse")}
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => void checkRemotePath()} className="h-9 shrink-0 px-3">
                        {t("configModal.ssh.checkPath")}
                      </Button>
                    </div>
                    {remotePathStatus?.exists && remotePathStatus.accessible && (
                      <p className="mt-1 text-[11px] text-primary">
                        {remotePathStatus.gitRepository ? t("configModal.ssh.pathGitReady") : t("configModal.ssh.pathReady")}
                      </p>
                    )}
                  </div>
                </>
              )}

              {/* Group selector */}
              <div>
                <label className="ui-config-form-label">{t("configModal.group.label")}</label>
                <GroupSelector
                  groups={groups}
                  value={groupId}
                  onChange={setGroupId}
                  displayName={selectedGroupName}
                />
              </div>

              <div>
                <label id={cliToolLabelId} htmlFor={cliToolFieldId} className="ui-config-form-label">{t("configModal.cliTool")}</label>
                <CliToolCombobox
                  id={cliToolFieldId}
                  ariaLabel={t("configModal.a11y.cliTool")}
                  labelledBy={cliToolLabelId}
                  open={cliToolComboboxOpen}
                  onOpenChange={setCliToolComboboxOpen}
                  value={cliTool}
                  onChange={setCliTool}
                />
              </div>

              {cliTool.trim() !== "" && (
                !isClone ? (
                  <CliArgsHistoryField
                    label={t("configModal.cliArgs")}
                    value={cliArgs}
                    onChange={setCliArgs}
                    suggestions={cliArgsHistorySuggestions}
                    placeholder="--permission-mode bypassPermissions"
                  />
                ) : (
                  <Field
                    label={t("configModal.cliArgs")}
                    value={cliArgs}
                    onChange={setCliArgs}
                    placeholder="--permission-mode bypassPermissions"
                  />
                )
              )}

              {projectType === "ssh" && resolveSshToolSource(cliTool) && (
                <div>
                  <label htmlFor={cliConfigRootFieldId} className="ui-config-form-label">
                    {t("configModal.ssh.cliConfigRoot")}
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id={cliConfigRootFieldId}
                      value={cliConfigRoot}
                      onChange={(event) => setCliConfigRoot(event.target.value)}
                      placeholder={DEFAULT_SSH_TOOL_CONFIG_ROOT[resolveSshToolSource(cliTool)!]}
                      className="min-w-0 flex-1 font-mono text-sm"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => openRemotePicker("cliConfigRoot")} className="h-9 shrink-0 px-3">
                      <FolderOpen className="h-4 w-4" />
                      {t("common.browse")}
                    </Button>
                  </div>
                  <p className="mt-1 text-[11px] text-text-muted">
                    {t("configModal.ssh.cliConfigRootDescription")}
                  </p>
                </div>
              )}

              {projectType === "local" && <div>
                  <label htmlFor={shellFieldId} className="ui-config-form-label">{t("configModal.shell")}</label>
                  <Select
                    id={shellFieldId}
                    key={shellSelectKey}
                    value={shellSelectValue}
                    aria-label={t("configModal.a11y.shell")}
                    onChange={(e) => {
                      const nextShell = e.target.value;
                      logInfo("[config-modal] shell select onChange", {
                        instanceId: logInstanceIdRef.current,
                        nextShell,
                      });
                      if (!nextShell.trim()) {
                        logWarn("[config-modal] ignored empty shell select onChange", {
                          instanceId: logInstanceIdRef.current,
                          shell,
                        });
                        return;
                      }
                      setShell(nextShell);
                    }}
                    className="text-sm"
                  >
                    {shellOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </Select>
              </div>}

              {cliTool.trim() === "" && (
                <Field label={t("configModal.startupCommand")} value={startupCmd} onChange={setStartupCmd} placeholder="npm run dev" />
              )}
              <div>
                <label className="ui-config-form-label">{t("configModal.envVars")}</label>
                <Textarea
                  value={envVarsText}
                  onChange={(e) => setEnvVarsText(e.target.value)}
                  className="h-16 resize-none text-sm"
                />
              </div>

              <div
                hidden={!projectWorktreeConfigEnabled || projectType === "ssh"}
                className="rounded-xl border border-border/70 bg-bg-secondary/60 p-3"
              >
                <div className="mb-2 text-xs font-semibold text-text-secondary">{t("worktree.settings.title")}</div>
                <div className="space-y-3">
                  <div>
                    <label className="ui-config-form-label">{t("worktree.settings.strategy")}</label>
                    <Select
                      value={worktreeStrategy}
                      onChange={(e) => setWorktreeStrategy(e.target.value as WorktreeIsolationStrategy)}
                      className="text-sm"
                    >
                      {WORKTREE_STRATEGIES.map((strategy) => (
                        <option key={strategy} value={strategy}>{t(WORKTREE_STRATEGY_LABEL_KEYS[strategy])}</option>
                      ))}
                    </Select>
                    <p className="mt-1 text-[11px] leading-relaxed text-text-muted">{t("worktree.settings.strategyDescription")}</p>
                  </div>
                  <label
                    htmlFor={worktreeDepsPromptFieldId}
                    className="flex cursor-pointer items-start gap-2"
                  >
                    <input
                      id={worktreeDepsPromptFieldId}
                      type="checkbox"
                      checked={worktreeDepsPromptEnabled}
                      onChange={(e) => setWorktreeDepsPromptEnabled(e.currentTarget.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-text-secondary">{t("worktree.settings.depsPrompt")}</span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-text-muted">
                        {t("worktree.settings.depsPromptDescription")}
                      </span>
                    </span>
                  </label>
                  <div>
                    <label className="ui-config-form-label">{t("worktree.settings.root")}</label>
                    <div className="flex gap-2">
                      <Input
                        type="text"
                        value={worktreeRoot}
                        onChange={(e) => setWorktreeRoot(e.target.value)}
                        placeholder={t("worktree.settings.rootPlaceholder")}
                        className="flex-1 text-sm"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          const selected = await open({ directory: true, title: t("worktree.settings.chooseRoot") });
                          if (selected) setWorktreeRoot(selected);
                        }}
                        className="h-9 shrink-0 px-3"
                      >
                        {t("common.browse")}
                      </Button>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-text-muted">{t("worktree.settings.rootDescription")}</p>
                  </div>
                </div>
              </div>
              {projectType === "ssh" && (
                <div className="rounded-xl border border-warning/35 bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-warning">
                  {t("configModal.ssh.capabilityNotice")}
                </div>
              )}
            </div>

            <DialogFooter className="shrink-0 border-t border-border/60 bg-surface-container-low/35 px-5 py-3">
              <Button variant="outline" onClick={onClose} className="min-w-20">
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="default" disabled={submitting} className="min-w-20">
                {submitting
                  ? t("common.saving")
                  : isEdit
                    ? t("common.save")
                    : isClone
                      ? t("configModal.action.clone")
                      : t("configModal.action.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showConfirmEdit}
        title={t("configModal.confirmEdit.title")}
        message={t("configModal.confirmEdit.message")}
        confirmText={t("configModal.confirmEdit.confirm")}
        onConfirm={() => {
          setShowConfirmEdit(false);
          void saveProject();
        }}
        onClose={() => setShowConfirmEdit(false)}
      />

      <Dialog open={wslPickerOpen} onOpenChange={setWslPickerOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[520px] overflow-hidden p-0">
          <div className="border-b border-border/70 px-4 py-3">
            <DialogTitle className="text-base font-semibold text-text-primary">
              {t("configModal.chooseSymlinkPath")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("configModal.wslPickerDescription")}
            </DialogDescription>
          </div>
          <div className="space-y-3 px-4 py-3">
            <div>
              <label className="mb-1 block text-xs text-text-muted">{t("configModal.wslPickerPath")}</label>
              <Input
                value={wslPickerPath}
                onChange={(event) => setWslPickerPath(event.target.value)}
                className="text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setWslPickerPath(parentWslUncPath(wslPickerPath))}
              >
                {t("configModal.wslPickerParent")}
              </Button>
              <Button
                type="button"
                variant="default"
                onClick={() => selectWslPickerPath(normalizeWslUncInput(wslPickerPath))}
              >
                {t("configModal.wslPickerSelectCurrent")}
              </Button>
            </div>
            <div className="max-h-64 overflow-y-auto rounded border border-border bg-bg-secondary/60 p-1">
              {wslPickerLoading && (
                <div className="px-2 py-3 text-xs text-text-muted">{t("configModal.wslPickerLoading")}</div>
              )}
              {!wslPickerLoading && wslPickerError && (
                <div className="px-2 py-3 text-xs text-danger">{wslPickerError}</div>
              )}
              {!wslPickerLoading && !wslPickerError && wslPickerEntries.length === 0 && (
                <div className="px-2 py-3 text-xs text-text-muted">{t("configModal.wslPickerEmpty")}</div>
              )}
              {!wslPickerLoading && !wslPickerError && wslPickerEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => setWslPickerPath(childWslUncPath(wslPickerPath, entry.name))}
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm text-text-primary hover:bg-surface-container-highest"
                >
                  <span className="truncate">{entry.name}</span>
                  <span className="text-xs text-text-muted">›</span>
                </button>
              ))}
            </div>
          </div>
          <DialogFooter className="border-t border-border/70 px-4 py-3">
            <Button type="button" variant="outline" onClick={() => setWslPickerOpen(false)}>
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={remotePickerOpen} onOpenChange={setRemotePickerOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[620px] overflow-hidden p-0">
          <div className="border-b border-border px-4 py-3">
            <DialogTitle>{t(remotePickerTarget === "projectPath" ? "configModal.ssh.pickerTitle" : "configModal.ssh.configRootPickerTitle")}</DialogTitle>
            <DialogDescription className="sr-only">{t(remotePickerTarget === "projectPath" ? "configModal.ssh.pickerDescription" : "configModal.ssh.configRootPickerDescription")}</DialogDescription>
          </div>
          <div className="space-y-3 p-4">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const parent = remotePickerPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
                  void loadRemoteDirectories(parent);
                }}
                title={t("common.parentDirectory")}
                aria-label={t("common.parentDirectory")}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Input
                value={remotePickerPath}
                aria-label={t(remotePickerTarget === "projectPath" ? "configModal.ssh.remotePath" : "configModal.ssh.cliConfigRoot")}
                placeholder="/"
                onChange={(event) => {
                  setRemotePickerPath(event.target.value);
                  setRemotePickerError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void loadRemoteDirectories(remotePickerPath);
                }}
                className="flex-1 font-mono text-sm"
              />
              <Button type="button" variant="outline" onClick={() => void loadRemoteDirectories(remotePickerPath)}>
                {t("common.refresh")}
              </Button>
            </div>
            <div className="max-h-80 min-h-52 overflow-y-auto rounded-xl border border-border bg-bg-secondary/60 p-1">
              {remotePickerLoading && <div className="p-4 text-sm text-text-muted">{t("common.loading")}</div>}
              {!remotePickerLoading && remotePickerError && <div className="p-4 text-sm text-danger">{remotePickerError}</div>}
              {!remotePickerLoading && !remotePickerError && remoteDirectories.length === 0 && <div className="p-4 text-sm text-text-muted">{t("configModal.ssh.pickerEmpty")}</div>}
              {!remotePickerLoading && !remotePickerError && remoteDirectories.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onDoubleClick={() => void loadRemoteDirectories(entry.path)}
                  onClick={() => setRemotePickerPath(entry.path)}
                  className="ui-focus-ring flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-text-primary transition-colors hover:bg-surface-container-highest"
                >
                  <span className="truncate">{entry.name}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <Button type="button" variant="outline" onClick={() => setRemotePickerOpen(false)}>{t("common.cancel")}</Button>
            <Button
              type="button"
              onClick={() => {
                if (remotePickerTarget === "projectPath") {
                  setRemotePath(remotePickerPath.trim() || "/");
                  setRemotePathStatus(null);
                } else {
                  setCliConfigRoot(remotePickerPath.trim() || "/");
                }
                setRemotePickerOpen(false);
              }}
            >
              {t("configModal.ssh.selectCurrentDirectory")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CliToolCombobox({
  id,
  ariaLabel,
  labelledBy,
  open,
  onOpenChange,
  value,
  onChange,
}: {
  id?: string;
  ariaLabel?: string;
  labelledBy?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onChange: (value: string) => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();
  const { t } = useI18n();
  const vendor = inferVendor(value);
  const normalizedValue = value.trim().toLowerCase();
  const selectedDescriptor = CLI_TOOL_DESCRIPTORS.find(
    (tool) => tool.command === normalizedValue || tool.id === normalizedValue
  );
  const resolveOptionIndex = useCallback((nextValue: string) => {
    const normalized = nextValue.trim().toLowerCase();
    const exactMatch = CLI_TOOL_OPTIONS.findIndex((tool) => tool === normalized);
    if (exactMatch >= 0) return exactMatch;
    const prefixMatch = CLI_TOOL_OPTIONS.findIndex((tool) => tool.startsWith(normalized));
    return prefixMatch >= 0 ? prefixMatch : 0;
  }, []);

  useEffect(() => {
    if (!open) return;

    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      onOpenChange(false);
    };

    document.addEventListener("mousedown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
    };
  }, [onOpenChange, open]);

  useEffect(() => {
    setActiveIndex(resolveOptionIndex(value));
  }, [resolveOptionIndex, value]);

  const selectTool = (tool: string) => {
    onChange(tool);
    onOpenChange(false);
    setActiveIndex(CLI_TOOL_OPTIONS.indexOf(tool));
    inputRef.current?.focus();
  };

  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const nextFocus = e.relatedTarget as Node | null;
    if (!nextFocus || !e.currentTarget.contains(nextFocus)) {
      onOpenChange(false);
    }
  };

  const activeOptionId = open ? `${listboxId}-option-${CLI_TOOL_OPTIONS[activeIndex]}` : undefined;

  return (
    <div ref={rootRef} className="relative" onBlur={handleBlur}>
      {(selectedDescriptor || vendor) && (
        <span className="pointer-events-none absolute left-2.5 top-1/2 z-10 -translate-y-1/2">
          {selectedDescriptor
            ? <CliToolIcon icon={selectedDescriptor.icon} size={16} />
            : <VendorIcon vendor={vendor} size={16} />}
        </span>
      )}
      <Input
        id={id}
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          const nextValue = e.target.value;
          onChange(nextValue);
          setActiveIndex(resolveOptionIndex(nextValue));
          onOpenChange(true);
        }}
        onClick={() => {
          setActiveIndex(resolveOptionIndex(value));
          onOpenChange(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) {
              setActiveIndex(resolveOptionIndex(value));
              onOpenChange(true);
              return;
            }
            setActiveIndex((current) => (current + 1) % CLI_TOOL_OPTIONS.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) {
              setActiveIndex(resolveOptionIndex(value));
              onOpenChange(true);
              return;
            }
            setActiveIndex((current) => (current - 1 + CLI_TOOL_OPTIONS.length) % CLI_TOOL_OPTIONS.length);
          } else if (e.key === "Enter") {
            if (!open) {
              e.preventDefault();
              setActiveIndex(resolveOptionIndex(value));
              onOpenChange(true);
              return;
            }
            e.preventDefault();
            selectTool(CLI_TOOL_OPTIONS[activeIndex]);
          } else if (e.key === "Home" && open) {
            e.preventDefault();
            setActiveIndex(0);
          } else if (e.key === "End" && open) {
            e.preventDefault();
            setActiveIndex(CLI_TOOL_OPTIONS.length - 1);
          } else if (e.key === "Escape") {
            if (open) {
              e.preventDefault();
              e.stopPropagation();
            }
            onOpenChange(false);
          } else if (e.key === "Tab") {
            onOpenChange(false);
          }
        }}
        placeholder={t("configModal.cliToolPlaceholder")}
        role="combobox"
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        className={`pr-8 text-sm ${selectedDescriptor || vendor ? "pl-9" : ""}`}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setActiveIndex(resolveOptionIndex(value));
          onOpenChange(!open);
          inputRef.current?.focus();
        }}
        className="ui-focus-ring absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-text-muted outline-none transition-colors hover:bg-surface-container-highest hover:text-text-primary"
      >
        <ChevronDown
          size={12}
          strokeWidth={1.8}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          className="ui-select-popover absolute left-0 top-full z-[60] mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-border bg-surface-container-high py-1 text-xs shadow-lg"
        >
          {CLI_TOOL_OPTIONS.map((tool, index) => {
            const descriptor = CLI_TOOL_DESCRIPTORS.find((item) => item.command === tool);
            const selected = normalizedValue === tool;
            return (
              <button
                id={`${listboxId}-option-${tool}`}
                key={tool}
                type="button"
                role="option"
                aria-selected={selected}
                data-selected={selected ? "true" : undefined}
                data-active={activeIndex === index ? "true" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectTool(tool)}
                className="flex w-[calc(100%-8px)] cursor-pointer items-center gap-2 outline-none hover:bg-surface-container-highest hover:text-text-primary data-[active=true]:bg-surface-container-highest data-[active=true]:text-text-primary"
              >
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                  {descriptor
                    ? <CliToolIcon icon={descriptor.icon} size={14} />
                    : <VendorIcon vendor={inferVendor(tool)} size={14} />}
                </span>
                <span className="flex-1 truncate text-left">
                  <span className="font-mono">{tool}</span>
                  {descriptor?.label ? <span className="ml-2 text-text-muted">{descriptor.label}</span> : null}
                </span>
                {selected && <Check size={12} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
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
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener("mousedown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
    };
  }, [open]);

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
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="ui-input ui-focus-ring flex h-9 w-full items-center justify-between px-3 text-left text-sm text-text-primary outline-none"
      >
        <span className={value ? "" : "opacity-50"}>{displayName}</span>
        <ChevronDown size={12} strokeWidth={1.8} className="text-text-muted" />
      </button>

      {open && (
        <div
          ref={panelRef}
          className="ui-select-popover absolute left-0 top-full z-[60] mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-border bg-bg-secondary py-1 animate-slide-down"
        >
          {/* No group option */}
          <button
            type="button"
            onClick={() => { onChange(null); setOpen(false); }}
            className={`mx-1 w-[calc(100%-0.5rem)] rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-surface-container-highest ${!value ? "bg-surface-container-highest text-primary" : "text-text-secondary"}`}
          >
            {t("configModal.group.none")}
          </button>

          {flatList.map(({ group: g, depth }) => (
            <button
              key={g.id}
              type="button"
              onClick={() => { onChange(g.id); setOpen(false); }}
              className={`mx-1 w-[calc(100%-0.5rem)] rounded-lg py-2 text-left text-sm transition-colors hover:bg-surface-container-highest ${value === g.id ? "bg-surface-container-highest text-primary" : "text-text-secondary"}`}
              style={{ paddingLeft: 8 + depth * 16, paddingRight: 8 }}
            >
              {g.name}
            </button>
          ))}

          {flatList.length === 0 && (
            <div className="px-3 py-2 text-xs text-text-muted">{t("configModal.group.empty")}</div>
          )}
        </div>
      )}
    </div>
  );
}

function CliArgsHistoryField({
  label,
  value,
  onChange,
  suggestions,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: CliArgsHistoryEntry[];
  placeholder?: string;
}) {
  const { t } = useI18n();
  const inputId = useId();
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex(0);
    if (suggestions.length === 0) setOpen(false);
  }, [suggestions]);

  const selectSuggestion = (suggestion: CliArgsHistoryEntry) => {
    onChange(suggestion.cliArgs);
    setOpen(false);
    inputRef.current?.focus();
  };

  const activeOptionId = open && suggestions[activeIndex]
    ? `${listboxId}-option-${activeIndex}`
    : undefined;

  return (
    <div className="relative" onBlur={(event) => {
      const nextFocus = event.relatedTarget as Node | null;
      if (!nextFocus || !event.currentTarget.contains(nextFocus)) setOpen(false);
    }}>
      <label htmlFor={inputId} className="ui-config-form-label">{label}</label>
      <div className="relative">
        <Input
          id={inputId}
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            if (suggestions.length > 0) setOpen(true);
          }}
          onClick={() => suggestions.length > 0 && setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && suggestions.length > 0) {
              event.preventDefault();
              if (!open) {
                setOpen(true);
                setActiveIndex(0);
              } else {
                setActiveIndex((current) => (current + 1) % suggestions.length);
              }
            } else if (event.key === "ArrowUp" && suggestions.length > 0) {
              event.preventDefault();
              if (!open) {
                setOpen(true);
                setActiveIndex(suggestions.length - 1);
              } else {
                setActiveIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
              }
            } else if (event.key === "Enter" && open && suggestions[activeIndex]) {
              event.preventDefault();
              selectSuggestion(suggestions[activeIndex]);
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            } else if (event.key === "Tab") {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={suggestions.length > 0 ? listboxId : undefined}
          aria-activedescendant={activeOptionId}
          className={`text-sm ${suggestions.length > 0 ? "pr-8" : ""}`}
        />
        {suggestions.length > 0 && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setOpen((current) => !current);
              inputRef.current?.focus();
            }}
            className="ui-focus-ring absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-text-muted outline-none transition-colors hover:bg-surface-container-highest hover:text-text-primary"
          >
            <ChevronDown
              size={12}
              strokeWidth={1.8}
              className={`transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
        )}
        {open && suggestions.length > 0 && (
          <div
            id={listboxId}
            role="listbox"
            aria-label={t("configModal.cliArgsHistory")}
            className="ui-select-popover absolute left-0 top-full z-[60] mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-border bg-surface-container-high py-1 text-xs shadow-lg"
          >
            {suggestions.map((suggestion, index) => (
              <button
                id={`${listboxId}-option-${index}`}
                key={`${suggestion.cliTool}\u0000${suggestion.cliArgs}`}
                type="button"
                role="option"
                aria-selected={value.trim() === suggestion.cliArgs}
                data-active={activeIndex === index ? "true" : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectSuggestion(suggestion)}
                className="flex w-[calc(100%-8px)] cursor-pointer items-center gap-3 outline-none hover:bg-surface-container-highest hover:text-text-primary data-[active=true]:bg-surface-container-highest data-[active=true]:text-text-primary"
              >
                <span className="min-w-0 flex-1 truncate text-left font-mono">{suggestion.cliArgs}</span>
                <span className="shrink-0 text-text-muted">
                  {t("configModal.cliArgsHistoryCount", { count: suggestion.count })}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  id,
  inputRef,
  label,
  required = false,
  value,
  onChange,
  placeholder,
}: {
  id?: string;
  inputRef?: Ref<HTMLInputElement>;
  label: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="ui-config-form-label">
        {label}{required && <> <span className="text-danger">*</span></>}
      </label>
      <Input
        id={id}
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="text-sm"
      />
    </div>
  );
}
