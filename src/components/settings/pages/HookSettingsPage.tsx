import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";

type HookInstallStatus = "directoryMissing" | "notInstalled" | "partialInstalled" | "installed";

interface ToolHookSettingsStatus {
  configDir: string | null;
  hooksDir: string | null;
  configPath: string | null;
  status: HookInstallStatus;
  attentionScriptInstalled: boolean;
  finishedScriptInstalled: boolean;
  attentionHookInstalled: boolean;
  stopHookInstalled: boolean;
  failureHookInstalled: boolean;
}

interface HookSettingsStatus {
  claude: ToolHookSettingsStatus;
  codex: ToolHookSettingsStatus;
}

const STATUS_LABELS: Record<HookInstallStatus, string> = {
  directoryMissing: "目录未选择",
  notInstalled: "未安装",
  partialInstalled: "部分安装",
  installed: "已安装",
};

const STATUS_CLASS_NAMES: Record<HookInstallStatus, string> = {
  directoryMissing: "border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  notInstalled: "border-border bg-surface-container-high text-on-surface-variant",
  partialInstalled: "border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  installed: "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400",
};

function formatPath(value: string | null): string {
  return value && value.trim() ? value : "未选择";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PathRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="mb-1 text-xs text-on-surface-variant">{label}</div>
      <div className="rounded-lg border border-border bg-surface-container-low px-3 py-2 font-mono text-xs text-on-surface break-all">
        {formatPath(value)}
      </div>
    </div>
  );
}

function CheckRow({ label, checked }: { label: string; checked: boolean }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-border bg-surface-container-low px-3 py-2 text-sm">
      <span className="min-w-0 truncate text-on-surface-variant">{label}</span>
      <span className={`shrink-0 ${checked ? "text-green-600 dark:text-green-400" : "text-text-muted"}`}>
        {checked ? "已安装" : "未完整"}
      </span>
    </div>
  );
}

function StatusPill({ status }: { status: HookInstallStatus }) {
  return (
    <span className={`rounded-full border px-3 py-1 text-xs font-medium ${STATUS_CLASS_NAMES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function SettingsSwitchRow({
  title,
  description,
  checked,
  onCheckedChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-surface-container-low px-3 py-2">
      <div>
        <div className="text-sm font-medium text-on-surface">{title}</div>
        <div className="mt-1 text-xs text-text-muted">{description}</div>
      </div>
      <Switch className="shrink-0" checked={checked} onCheckedChange={onCheckedChange} aria-label={title} />
    </div>
  );
}

export function HookSettingsPage() {
  const [status, setStatus] = useState<HookSettingsStatus | null>(null);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [codexSelectedDir, setCodexSelectedDir] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [claudeWorking, setClaudeWorking] = useState(false);
  const [codexWorking, setCodexWorking] = useState(false);
  const hookPopupNotificationsEnabled = useSettingsStore((s) => s.hookPopupNotificationsEnabled);
  const hookPopupAutoCloseEnabled = useSettingsStore((s) => s.hookPopupAutoCloseEnabled);
  const hookPopupAutoCloseSeconds = useSettingsStore((s) => s.hookPopupAutoCloseSeconds);
  const updateSetting = useSettingsStore((s) => s.update);
  const [autoCloseSecondsDraft, setAutoCloseSecondsDraft] = useState(String(hookPopupAutoCloseSeconds));

  useEffect(() => {
    setAutoCloseSecondsDraft(String(hookPopupAutoCloseSeconds));
  }, [hookPopupAutoCloseSeconds]);

  const selectedDirArg = useMemo(() => selectedDir ?? undefined, [selectedDir]);
  const codexSelectedDirArg = useMemo(() => codexSelectedDir ?? undefined, [codexSelectedDir]);

  const refreshStatus = async (dir = selectedDirArg, codexDir = codexSelectedDirArg) => {
    setLoading(true);
    try {
      const nextStatus = await invoke<HookSettingsStatus>("hook_settings_get_status", {
        selectedDir: dir,
        codexSelectedDir: codexDir,
      });
      setStatus(nextStatus);
      if (nextStatus.claude.configDir) {
        setSelectedDir(nextStatus.claude.configDir);
      }
      if (nextStatus.codex.configDir) {
        setCodexSelectedDir(nextStatus.codex.configDir);
      }
    } catch (error) {
      toast.error("刷新 Hook 状态失败", { description: getErrorMessage(error) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshStatus(undefined);
  }, []);

  const handleSelectDir = async () => {
    try {
      const dir = await invoke<string | null>("hook_settings_select_dir", {
        title: "选择 Claude 配置目录",
      });
      if (!dir) return;
      setSelectedDir(dir);
      await refreshStatus(dir, codexSelectedDirArg);
    } catch (error) {
      toast.error("选择目录失败", { description: getErrorMessage(error) });
    }
  };

  const handleSelectCodexDir = async () => {
    try {
      const dir = await invoke<string | null>("hook_settings_select_dir", {
        title: "选择 Codex 配置目录",
      });
      if (!dir) return;
      setCodexSelectedDir(dir);
      await refreshStatus(selectedDirArg, dir);
    } catch (error) {
      toast.error("选择 Codex 目录失败", { description: getErrorMessage(error) });
    }
  };

  const handleClaudeInstall = async () => {
    setClaudeWorking(true);
    try {
      const nextStatus = await invoke<HookSettingsStatus>("hook_settings_install", {
        selectedDir: selectedDirArg,
        codexSelectedDir: codexSelectedDirArg,
      });
      setStatus(nextStatus);
      if (nextStatus.claude.configDir) setSelectedDir(nextStatus.claude.configDir);
      toast.success("Claude Hook 已安装");
    } catch (error) {
      toast.error("安装 Claude Hook 失败", { description: getErrorMessage(error) });
    } finally {
      setClaudeWorking(false);
    }
  };

  const handleClaudeUninstall = async () => {
    setClaudeWorking(true);
    try {
      const nextStatus = await invoke<HookSettingsStatus>("hook_settings_uninstall", {
        selectedDir: selectedDirArg,
        codexSelectedDir: codexSelectedDirArg,
      });
      setStatus(nextStatus);
      if (nextStatus.claude.configDir) setSelectedDir(nextStatus.claude.configDir);
      toast.success("Claude Hook 已删除");
    } catch (error) {
      toast.error("删除 Claude Hook 失败", { description: getErrorMessage(error) });
    } finally {
      setClaudeWorking(false);
    }
  };

  const handleCodexInstall = async () => {
    setCodexWorking(true);
    try {
      const nextStatus = await invoke<HookSettingsStatus>("hook_settings_install_codex", {
        selectedDir: selectedDirArg,
        codexSelectedDir: codexSelectedDirArg,
      });
      setStatus(nextStatus);
      if (nextStatus.codex.configDir) setCodexSelectedDir(nextStatus.codex.configDir);
      toast.success("Codex Hook 已安装");
    } catch (error) {
      toast.error("安装 Codex Hook 失败", { description: getErrorMessage(error) });
    } finally {
      setCodexWorking(false);
    }
  };

  const handleCodexUninstall = async () => {
    setCodexWorking(true);
    try {
      const nextStatus = await invoke<HookSettingsStatus>("hook_settings_uninstall_codex", {
        selectedDir: selectedDirArg,
        codexSelectedDir: codexSelectedDirArg,
      });
      setStatus(nextStatus);
      if (nextStatus.codex.configDir) setCodexSelectedDir(nextStatus.codex.configDir);
      toast.success("Codex Hook 已删除");
    } catch (error) {
      toast.error("删除 Codex Hook 失败", { description: getErrorMessage(error) });
    } finally {
      setCodexWorking(false);
    }
  };

  const handleCommitAutoCloseSeconds = () => {
    const nextValue = Number(autoCloseSecondsDraft);
    const nextSeconds = Number.isFinite(nextValue) ? Math.round(nextValue) : hookPopupAutoCloseSeconds;
    const clampedSeconds = Math.max(5, Math.min(3600, nextSeconds));
    setAutoCloseSecondsDraft(String(clampedSeconds));
    if (clampedSeconds !== hookPopupAutoCloseSeconds) {
      void updateSetting("hookPopupAutoCloseSeconds", clampedSeconds);
    }
  };

  const claude = status?.claude;
  const codex = status?.codex;
  const claudeStatus = claude?.status ?? "directoryMissing";
  const codexStatus = codex?.status ?? "directoryMissing";
  const claudeAttentionInstalled = Boolean(claude?.attentionScriptInstalled && claude.attentionHookInstalled);
  const claudeFinishedInstalled = Boolean(claude?.finishedScriptInstalled && claude.stopHookInstalled && claude.failureHookInstalled);
  const codexAttentionInstalled = Boolean(codex?.attentionScriptInstalled && codex.attentionHookInstalled);
  const codexFinishedInstalled = Boolean(codex?.finishedScriptInstalled && codex.stopHookInstalled);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Hook 通知弹框</CardTitle>
          <CardDescription className="mt-1">
            控制 Claude Code 和 Codex CLI Hook 事件的右上角弹框；终端标签小圆点不受这里的弹框开关影响。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <SettingsSwitchRow
            title="通知弹框"
            description="关闭后不再弹出 Hook 通知卡片，只更新标签栏小圆点颜色。"
            checked={hookPopupNotificationsEnabled}
            onCheckedChange={(checked) => void updateSetting("hookPopupNotificationsEnabled", checked)}
          />
          <SettingsSwitchRow
            title="自动关闭弹框"
            description="开启后 Hook 通知会在指定时间后自动消失。"
            checked={hookPopupAutoCloseEnabled}
            onCheckedChange={(checked) => void updateSetting("hookPopupAutoCloseEnabled", checked)}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-container-low px-3 py-2">
            <div>
              <div className="text-sm font-medium text-on-surface">默认关闭时间</div>
              <div className="mt-1 text-xs text-text-muted">单位：秒，默认 60 秒；仅在自动关闭开启时可编辑。</div>
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={5}
                max={3600}
                step={1}
                value={autoCloseSecondsDraft}
                disabled={!hookPopupAutoCloseEnabled}
                onChange={(e) => setAutoCloseSecondsDraft(e.target.value)}
                onBlur={handleCommitAutoCloseSeconds}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleCommitAutoCloseSeconds();
                  }
                }}
                className="w-24 text-xs"
                aria-label="Hook 弹框默认关闭时间"
              />
              <span className="text-xs text-on-surface-variant">秒</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Claude Code Hook 桥接</CardTitle>
              <CardDescription className="mt-1">
                安装两个独立 PowerShell 脚本，把 Claude Code Hook 事件转发到 CLI-Manager 终端标签。
              </CardDescription>
            </div>
            <StatusPill status={claudeStatus} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <PathRow label="Claude 配置目录" value={claude?.configDir ?? selectedDir} />
            <PathRow label="hooks 目录" value={claude?.hooksDir ?? null} />
            <PathRow label="settings.json" value={claude?.configPath ?? null} />
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <CheckRow label="Notification 脚本" checked={claudeAttentionInstalled} />
            <CheckRow label="Stop / StopFailure 脚本" checked={claudeFinishedInstalled} />
          </div>

          <div className="rounded-lg border border-border bg-surface-container-low px-3 py-2 text-xs leading-5 text-on-surface-variant">
            安装只会写入 <span className="font-mono">notify-cli-manager-approval.ps1</span> 和{" "}
            <span className="font-mono">notify-cli-manager-finished.ps1</span>，并合并修改 Claude 的{" "}
            <span className="font-mono">settings.json</span>。删除时不会移除用户自己的 hooks，也不会删除旧的{" "}
            <span className="font-mono">notify.ps1</span> 或 <span className="font-mono">notify-cli-manager.ps1</span>。
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={handleSelectDir} disabled={loading || claudeWorking || codexWorking}>
              选择目录
            </Button>
            <Button variant="outline" onClick={() => void refreshStatus()} disabled={loading || claudeWorking || codexWorking}>
              {loading ? "刷新中..." : "刷新状态"}
            </Button>
            <Button variant="default" onClick={handleClaudeInstall} disabled={loading || claudeWorking || claudeStatus === "directoryMissing"}>
              {claudeWorking ? "处理中..." : "安装 Claude Hook"}
            </Button>
            <Button variant="destructive" onClick={handleClaudeUninstall} disabled={loading || claudeWorking || claudeStatus === "directoryMissing"}>
              删除 Claude Hook
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Codex CLI Hook 桥接</CardTitle>
              <CardDescription className="mt-1">
                安装 Codex CLI 的 Stop 和 PermissionRequest 通知脚本，用于任务完成和需要处理提醒。
              </CardDescription>
            </div>
            <StatusPill status={codexStatus} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <PathRow label="Codex 配置目录" value={codex?.configDir ?? codexSelectedDir} />
            <PathRow label="hooks 目录" value={codex?.hooksDir ?? null} />
            <PathRow label="hooks.json" value={codex?.configPath ?? null} />
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <CheckRow label="PermissionRequest 脚本" checked={codexAttentionInstalled} />
            <CheckRow label="Stop 脚本" checked={codexFinishedInstalled} />
          </div>

          <div className="rounded-lg border border-border bg-surface-container-low px-3 py-2 text-xs leading-5 text-on-surface-variant">
            安装会写入用户级 <span className="font-mono">~/.codex/hooks.json</span> 和{" "}
            <span className="font-mono">~/.codex/hooks/</span> 下的 CLI-Manager 脚本，不修改项目{" "}
            <span className="font-mono">.codex/hooks.json</span>。安装会自动写入{" "}
            <span className="font-mono">~/.codex/config.toml</span> 并开启{" "}
            <span className="font-mono">[features].hooks = true</span>，Codex 0.129+ 仍需要在 TUI 里执行{" "}
            <span className="font-mono">/hooks</span> 批准脚本。
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={handleSelectCodexDir} disabled={loading || claudeWorking || codexWorking}>
              选择 Codex 目录
            </Button>
            <Button variant="default" onClick={handleCodexInstall} disabled={loading || codexWorking}>
              {codexWorking ? "处理中..." : "安装 Codex Hook"}
            </Button>
            <Button variant="destructive" onClick={handleCodexUninstall} disabled={loading || codexWorking || codexStatus === "directoryMissing"}>
              删除 Codex Hook
            </Button>
            <Button variant="outline" onClick={() => void refreshStatus()} disabled={loading || claudeWorking || codexWorking}>
              {loading ? "刷新中..." : "刷新状态"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
