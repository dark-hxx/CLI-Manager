import { useEffect, useState, type ComponentType } from "react";
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  Check,
  Download,
  ExternalLink,
  Github,
  Info,
  RefreshCw,
  RotateCw,
  UserRound,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTerminalStore } from "../../stores/terminalStore";
import { useUpdateStore } from "../../stores/updateStore";
import { MarkdownContent } from "../ui/MarkdownContent";
import { pickByLanguage, useI18n } from "../../lib/i18n";

const REPOSITORY_URL = "https://github.com/dark-hxx/CLI-Manager";
const MANUAL_URL = `${REPOSITORY_URL}/blob/master/docs/%E5%8A%9F%E8%83%BD%E6%B8%85%E5%8D%95.md`;
const AUTHOR_URL = "https://github.com/dark-hxx";
const AUR_PACKAGE_URL = "https://aur.archlinux.org/packages/cli-manager-bin";

const PROJECT_HIGHLIGHTS = [
  { zh: "多项目 PTY 终端管理", en: "Multi-project PTY terminal management" },
  { zh: "Claude Code / Codex CLI 集成", en: "Claude Code / Codex CLI integration" },
  { zh: "历史会话 Diff 与用量分析", en: "History Diff and usage analysis" },
  { zh: "供应商切换与 WebDAV 同步", en: "Provider switching and WebDAV sync" },
];

interface ExternalLinkItemProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  url: string;
}

async function openExternalUrl(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (e) {
    console.error("Failed to open URL:", e);
  }
}

function ExternalLinkItem({ icon: Icon, title, description, url }: ExternalLinkItemProps) {
  return (
    <button
      type="button"
      onClick={() => void openExternalUrl(url)}
      className="ui-interactive ui-focus-ring ui-surface-card flex min-w-0 items-start gap-3 rounded-2xl border border-border p-4 text-left transition-colors hover:bg-surface-container-high"
    >
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-surface-container-high text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-on-surface">
          {title}
          <ExternalLink className="h-3.5 w-3.5 text-on-surface-variant" />
        </span>
        <span className="mt-1 block text-xs leading-5 text-on-surface-variant">{description}</span>
      </span>
    </button>
  );
}

export function AboutSection() {
  const { language, t } = useI18n();
  const text = (zh: string, en: string) => pickByLanguage(language, zh, en);
  const {
    currentVersion,
    distribution,
    checking,
    updateAvailable,
    updateInfo,
    downloading,
    downloadProgress,
    downloadTotalBytes,
    downloadedBytes,
    readyToInstall,
    installing,
    lastCheckedAt,
    error,
    releaseFallbackUrl,
    fetchVersion,
    checkUpdate,
    downloadUpdate,
    installAndRelaunch,
    reset,
  } = useUpdateStore();
  const activeTerminalCount = useTerminalStore((state) =>
    state.sessions.filter((session) => {
      const status = state.sessionStatuses[session.id];
      return status !== "exited" && status !== "error";
    }).length
  );
  const [installConfirmVisible, setInstallConfirmVisible] = useState(false);

  useEffect(() => {
    if (!currentVersion) {
      fetchVersion();
    }
  }, [currentVersion, fetchVersion]);

  useEffect(() => {
    if (!readyToInstall) {
      setInstallConfirmVisible(false);
    }
  }, [readyToInstall, updateInfo?.version]);

  const handleCheckUpdate = () => {
    if (!currentVersion || distribution === "aur" || checking || downloading || installing) return;
    setInstallConfirmVisible(false);
    checkUpdate();
  };

  const handleDownloadUpdate = async () => {
    if (downloading || installing) return;
    const downloaded = await downloadUpdate();
    if (downloaded) {
      setInstallConfirmVisible(true);
    }
  };

  const handleOpenReleaseFallback = () => {
    void openExternalUrl(distribution === "aur" ? AUR_PACKAGE_URL : updateInfo?.downloadUrl ?? releaseFallbackUrl);
  };

  const handleConfirmInstall = () => {
    if (installing) return;
    installAndRelaunch();
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return "";
    try {
      return new Date(dateStr).toLocaleDateString(language, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch {
      return dateStr;
    }
  };

  const formatBytes = (value: number | null) => {
    if (!value || value <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let size = value;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  };

  const canDownload = distribution !== "aur" && updateAvailable && updateInfo && !downloading && !readyToInstall && !installing;
  const showLatest = distribution !== "aur" && Boolean(lastCheckedAt && !checking && !error && !updateAvailable);
  const progressLabel = downloadTotalBytes
    ? `${downloadProgress}%（${formatBytes(downloadedBytes)} / ${formatBytes(downloadTotalBytes)}）`
    : downloadProgress > 0
      ? `${downloadProgress}%`
      : text("正在下载...", "Downloading...");

  return (
    <div className="space-y-4">
      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Info className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-on-surface">{text("项目介绍", "Project Overview")}</div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-on-surface-variant">
              {text(
                "CLI-Manager 是面向 Claude Code / Codex CLI 的跨平台 AI CLI 增强工作台，用于集中管理多项目终端、会话历史、Diff 回看、用量分析、供应商切换和配置同步。",
                "CLI-Manager is a cross-platform AI CLI workspace for Claude Code and Codex CLI, covering multi-project terminals, session history, Diff review, usage analysis, provider switching, and configuration sync."
              )}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {PROJECT_HIGHLIGHTS.map((item) => (
                <span
                  key={item.zh}
                  className="rounded-full border border-border bg-surface-container-high px-2.5 py-1 text-xs text-on-surface-variant"
                >
                  {pickByLanguage(language, item.zh, item.en)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <div className="text-sm font-semibold text-on-surface">{text("应用更新", "App Updates")}</div>

        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-on-surface-variant">{text("版本号", "Version")}</span>
          <span className="rounded-md bg-surface-container-high px-2 py-0.5 font-mono text-xs font-semibold text-on-surface">
            V{currentVersion || "---"}
          </span>
        </div>

        {distribution === "aur" ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-container-high/60 p-3">
            <div className="flex min-w-0 flex-1 items-start gap-2 text-xs text-on-surface-variant">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <span>{t("app.update.aurManaged")}</span>
            </div>
            <button
              type="button"
              onClick={handleOpenReleaseFallback}
              className="ui-interactive ui-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-on-surface"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t("app.update.viewAurPackage")}
            </button>
          </div>
        ) : (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleCheckUpdate}
            disabled={!currentVersion || checking || downloading || installing}
            className="ui-interactive ui-focus-ring flex items-center gap-1.5 rounded-lg border border-border bg-surface-container-high px-3 py-1.5 text-xs font-medium text-on-surface transition-colors hover:bg-surface-container-highest disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={checking ? text("检查中", "Checking") : text("检查更新", "Check for Updates")}
          >
            {checking ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                <span>{text("检查中...", "Checking...")}</span>
              </>
            ) : (
              <>
                <RefreshCw className="h-3.5 w-3.5" />
                <span>{text("检查更新", "Check for Updates")}</span>
              </>
            )}
          </button>

          {error && (
            <div className="flex flex-wrap items-center gap-1 text-xs text-danger">
              <AlertCircle className="h-3.5 w-3.5" />
              <span>{error}</span>
              <button type="button" onClick={handleCheckUpdate} className="ml-1 underline hover:no-underline">
                {text("重试", "Retry")}
              </button>
              <button type="button" onClick={handleOpenReleaseFallback} className="ml-1 underline hover:no-underline">
                {text("查看 Release", "View Release")}
              </button>
            </div>
          )}

          {showLatest && (
            <div className="flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" />
              <span>{text("已是最新版本", "Already up to date")}</span>
            </div>
          )}
        </div>
        )}

        {distribution !== "aur" && updateAvailable && updateInfo && (
          <div className="mt-3 rounded-xl border border-accent/30 bg-accent/5 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-on-surface">V{updateInfo.version}</span>
                  <span className="rounded-full bg-success/20 px-2 py-0.5 text-[10px] font-medium text-success">
                    {text("新版本可用", "New Version Available")}
                  </span>
                </div>
                {updateInfo.releaseDate && (
                  <div className="mt-1 text-xs text-on-surface-variant">
                    {text("发布日期：", "Release date: ")}{formatDate(updateInfo.releaseDate)}
                  </div>
                )}
              </div>
              <div className="flex flex-col items-end gap-2">
                {canDownload && (
                  <button
                    type="button"
                    onClick={handleDownloadUpdate}
                    className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>{text("下载更新", "Download Update")}</span>
                  </button>
                )}
                {readyToInstall && !installConfirmVisible && (
                  <button
                    type="button"
                    onClick={() => setInstallConfirmVisible(true)}
                    className="flex items-center gap-1.5 rounded-lg bg-success px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    <span>{text("安装并重启", "Install and Relaunch")}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleOpenReleaseFallback}
                  className="flex items-center gap-1 text-xs text-on-surface-variant underline hover:no-underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  <span>{text("查看 Release 页面", "View Release Page")}</span>
                </button>
              </div>
            </div>

            {downloading && (
              <div className="mt-3 rounded-lg border border-border/60 bg-surface-container-high/60 p-3">
                <div className="mb-2 flex items-center justify-between text-xs text-on-surface-variant">
                  <span>{text("正在下载更新", "Downloading update")}</span>
                  <span>{progressLabel}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-container-highest">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {readyToInstall && installConfirmVisible && (
              <div className="mt-3 rounded-lg border border-danger/40 bg-danger/10 p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-danger" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-on-surface">{text("确认安装并重启", "Confirm Install and Relaunch")}</div>
                    <div className="mt-1 text-xs text-on-surface-variant">
                      {text("安装更新会关闭并重启 CLI-Manager。", "Installing the update will close and relaunch CLI-Manager.")}
                      {activeTerminalCount > 0
                        ? text(` 当前仍有 ${activeTerminalCount} 个运行中的终端会话，继续操作会中断其中的任务。`, ` ${activeTerminalCount} terminal sessions are still running and will be interrupted.`)
                        : text(" 请确认当前工作已保存。", " Make sure current work is saved.")}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={handleConfirmInstall}
                        disabled={installing}
                        className="rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {installing ? text("正在安装...", "Installing...") : text("确认安装并重启", "Install and Relaunch")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setInstallConfirmVisible(false)}
                        disabled={installing}
                        className="rounded-lg border border-border bg-surface-container-high px-3 py-1.5 text-xs font-medium text-on-surface transition-colors hover:bg-surface-container-highest disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {text("稍后", "Later")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {updateInfo.releaseNotes && (
              <div className="mt-3 border-t border-border/50 pt-3">
                <div className="mb-1 text-xs font-medium text-on-surface-variant">{text("更新说明", "Release Notes")}</div>
                <MarkdownContent content={updateInfo.releaseNotes} linkBehavior="open" />
              </div>
            )}

            <button
              type="button"
              onClick={reset}
              disabled={checking || downloading || installing}
              className="mt-3 text-xs text-on-surface-variant underline hover:no-underline disabled:cursor-not-allowed disabled:opacity-60"
            >
              {text("稍后提醒", "Remind Me Later")}
            </button>
          </div>
        )}
      </section>

      <div className="space-y-3">
        <div className="px-1 text-sm font-semibold text-on-surface">{text("项目资源", "Project Resources")}</div>
        <div className="grid gap-3 md:grid-cols-2">
          <ExternalLinkItem
            icon={Github}
            title={text("Git 开源地址", "Git Repository")}
            description={text("查看源码、提交 Issue 或参与 Pull Request。", "View source code, submit issues, or contribute pull requests.")}
            url={REPOSITORY_URL}
          />
          <ExternalLinkItem
            icon={BookOpen}
            title={text("操作手册", "User Manual")}
            description={text("查看功能清单、使用说明和能力边界。", "View feature list, usage notes, and capability boundaries.")}
            url={MANUAL_URL}
          />
        </div>
      </div>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-2xl bg-surface-container-high text-primary">
            <UserRound className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-on-surface">{text("作者信息", "Author")}</div>
            <div className="mt-2 text-sm text-on-surface-variant">{text("作者：", "Author: ")}hxx / dark-hxx</div>
            <div className="mt-1 text-xs leading-5 text-on-surface-variant">
              {text("项目长期围绕 AI CLI 工作流、终端体验、历史会话分析和多项目管理持续演进。", "The project continues to evolve around AI CLI workflows, terminal experience, history analytics, and multi-project management.")}
            </div>
            <button
              type="button"
              onClick={() => void openExternalUrl(AUTHOR_URL)}
              className="ui-interactive ui-focus-ring mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-container-high px-3 py-1.5 text-xs font-medium text-on-surface transition-colors hover:bg-surface-container-highest"
            >
              <Github className="h-3.5 w-3.5" />
              <span>{text("查看作者主页", "View Author Profile")}</span>
              <ExternalLink className="h-3 w-3 text-on-surface-variant" />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
