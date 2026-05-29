import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type HookInstallStatus = "directoryMissing" | "notInstalled" | "partialInstalled" | "installed";

interface HookSettingsStatus {
  claudeDir: string | null;
  hooksDir: string | null;
  settingsPath: string | null;
  status: HookInstallStatus;
  approvalScriptInstalled: boolean;
  finishedScriptInstalled: boolean;
  notificationHookInstalled: boolean;
  stopHookInstalled: boolean;
  stopFailureHookInstalled: boolean;
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

export function HookSettingsPage() {
  const [status, setStatus] = useState<HookSettingsStatus | null>(null);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);

  const selectedDirArg = useMemo(() => selectedDir ?? undefined, [selectedDir]);

  const refreshStatus = async (dir = selectedDirArg) => {
    setLoading(true);
    try {
      const nextStatus = await invoke<HookSettingsStatus>("hook_settings_get_status", {
        selectedDir: dir,
      });
      setStatus(nextStatus);
      if (nextStatus.claudeDir) {
        setSelectedDir(nextStatus.claudeDir);
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
      const dir = await invoke<string | null>("hook_settings_select_dir");
      if (!dir) return;
      setSelectedDir(dir);
      await refreshStatus(dir);
    } catch (error) {
      toast.error("选择目录失败", { description: getErrorMessage(error) });
    }
  };

  const handleInstall = async () => {
    setWorking(true);
    try {
      const nextStatus = await invoke<HookSettingsStatus>("hook_settings_install", {
        selectedDir: selectedDirArg,
      });
      setStatus(nextStatus);
      if (nextStatus.claudeDir) setSelectedDir(nextStatus.claudeDir);
      toast.success("Hook 已安装");
    } catch (error) {
      toast.error("安装 Hook 失败", { description: getErrorMessage(error) });
    } finally {
      setWorking(false);
    }
  };

  const handleUninstall = async () => {
    setWorking(true);
    try {
      const nextStatus = await invoke<HookSettingsStatus>("hook_settings_uninstall", {
        selectedDir: selectedDirArg,
      });
      setStatus(nextStatus);
      if (nextStatus.claudeDir) setSelectedDir(nextStatus.claudeDir);
      toast.success("Hook 已删除");
    } catch (error) {
      toast.error("删除 Hook 失败", { description: getErrorMessage(error) });
    } finally {
      setWorking(false);
    }
  };

  const currentStatus = status?.status ?? "directoryMissing";
  const approvalHookInstalled = Boolean(status?.approvalScriptInstalled && status.notificationHookInstalled);
  const finishedHookInstalled = Boolean(
    status?.finishedScriptInstalled && status.stopHookInstalled && status.stopFailureHookInstalled,
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Claude Hook 桥接</CardTitle>
              <CardDescription className="mt-1">
                安装两个独立 PowerShell 脚本，把 Claude Code Hook 事件转发到 CLI-Manager 终端标签。
              </CardDescription>
            </div>
            <span className={`rounded-full border px-3 py-1 text-xs font-medium ${STATUS_CLASS_NAMES[currentStatus]}`}>
              {STATUS_LABELS[currentStatus]}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <PathRow label="Claude 配置目录" value={status?.claudeDir ?? selectedDir} />
            <PathRow label="hooks 目录" value={status?.hooksDir ?? null} />
            <PathRow label="settings.json" value={status?.settingsPath ?? null} />
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <CheckRow label="Notification 脚本" checked={approvalHookInstalled} />
            <CheckRow label="Stop / StopFailure 脚本" checked={finishedHookInstalled} />
          </div>

          <div className="rounded-lg border border-border bg-surface-container-low px-3 py-2 text-xs leading-5 text-on-surface-variant">
            安装只会写入 <span className="font-mono">notify-cli-manager-approval.ps1</span> 和{" "}
            <span className="font-mono">notify-cli-manager-finished.ps1</span>，并合并修改 Claude 的{" "}
            <span className="font-mono">settings.json</span>。删除时不会移除用户自己的 hooks，也不会删除旧的{" "}
            <span className="font-mono">notify.ps1</span> 或 <span className="font-mono">notify-cli-manager.ps1</span>。
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={handleSelectDir} disabled={loading || working}>
              选择目录
            </Button>
            <Button variant="default" onClick={handleInstall} disabled={loading || working || currentStatus === "directoryMissing"}>
              {working ? "处理中..." : "一键安装"}
            </Button>
            <Button variant="destructive" onClick={handleUninstall} disabled={loading || working || currentStatus === "directoryMissing"}>
              一键删除
            </Button>
            <Button variant="outline" onClick={() => void refreshStatus()} disabled={loading || working}>
              {loading ? "刷新中..." : "刷新状态"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
