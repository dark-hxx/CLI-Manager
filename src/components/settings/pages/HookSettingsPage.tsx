import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ActionIcon, Badge, Box, Button, Card, Group, SimpleGrid, Stack, Switch, Text, TextInput } from "@mantine/core";
import { Play, CheckCircle, HelpCircle, ChevronDown, ChevronUp, Folder, FileCode, Copy, Check, X, Activity, Bell, ShieldAlert, ToggleRight, AlertTriangle, BellOff, XCircle, Layers } from "lucide-react";
import { useSettingsStore, type HookEventType } from "@/stores/settingsStore";
import { useI18n, type AppLanguage } from "@/lib/i18n";

type HookInstallStatus = "directoryMissing" | "notInstalled" | "partialInstalled" | "installed";
type HookTool = "claude" | "codex";
type HookModule = "sessionStart" | "running" | "attention" | "stop" | "failure" | "subagent" | "hooksFeature";

interface ToolHookSettingsStatus {
  configDir: string | null;
  hooksDir: string | null;
  configPath: string | null;
  featureConfigPath: string | null;
  status: HookInstallStatus;
  attentionScriptInstalled: boolean;
  finishedScriptInstalled: boolean;
  sessionStartHookInstalled: boolean;
  runningHookInstalled: boolean;
  attentionHookInstalled: boolean;
  stopHookInstalled: boolean;
  failureHookInstalled: boolean;
  subagentStartHookInstalled: boolean;
  hooksFeatureInstalled: boolean;
}

interface HookSettingsStatus {
  claude: ToolHookSettingsStatus;
  codex: ToolHookSettingsStatus;
  ccSwitch: CcSwitchHookProtectionStatus;
  claudeAutoRepaired: boolean;
}

type CcSwitchHookProtectionState =
  | "notDetected"
  | "notSynced"
  | "synced"
  | "invalidDb"
  | "unavailable"
  | "syncFailed";

interface CcSwitchHookProtectionStatus {
  state: CcSwitchHookProtectionState;
  dbPath: string | null;
  message: string | null;
  wslMismatch: boolean;
}

const STATUS_LABELS: Record<HookInstallStatus, { zh: string; en: string }> = {
  directoryMissing: { zh: "目录未选择", en: "Directory Missing" },
  notInstalled: { zh: "未安装", en: "Not Installed" },
  partialInstalled: { zh: "部分安装", en: "Partially Installed" },
  installed: { zh: "已安装", en: "Installed" },
};

const STATUS_COLORS: Record<HookInstallStatus, string> = {
  directoryMissing: "yellow",
  notInstalled: "gray",
  partialInstalled: "yellow",
  installed: "green",
};

const CCSWITCH_STATE_LABELS: Record<CcSwitchHookProtectionState, { zh: string; en: string }> = {
  notDetected: { zh: "未检测到 cc-switch", en: "cc-switch not detected" },
  notSynced: { zh: "未同步", en: "Not Synced" },
  synced: { zh: "已同步", en: "Synced" },
  invalidDb: { zh: "数据库路径无效", en: "Invalid database path" },
  unavailable: { zh: "不可用", en: "Unavailable" },
  syncFailed: { zh: "同步失败", en: "Sync Failed" },
};

const CCSWITCH_STATE_COLORS: Record<CcSwitchHookProtectionState, string> = {
  notDetected: "gray",
  notSynced: "yellow",
  synced: "green",
  invalidDb: "red",
  unavailable: "yellow",
  syncFailed: "red",
};


function pickText(language: AppLanguage, zh: string, en: string) {
  return language === "zh-CN" ? zh : en;
}

function formatPath(value: string | null, language: AppLanguage): string {
  return value && value.trim() ? value : pickText(language, "未选择", "Not selected");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatCcSwitchMessage(message: string | null, language: AppLanguage): string | null {
  if (!message) return null;
  const messages: Record<string, { zh: string; en: string }> = {
    db_not_found: {
      zh: "设置中的 cc-switch 数据库不存在，请在「设置 -> 供应商」重新选择。",
      en: "The cc-switch database in settings does not exist. Choose it again in Settings -> Providers.",
    },
    unsupported_format: {
      zh: "cc-switch 数据库路径必须指向 .db 文件。",
      en: "The cc-switch database path must point to a .db file.",
    },
    wsl_environment_mismatch: {
      zh: "当前 Claude 配置在 WSL 内，cc-switch 数据库在宿主环境，未自动跨环境写入。",
      en: "Current Claude config is in WSL while the cc-switch database is on the host; cross-environment write was skipped.",
    },
    common_config_parse_failed: {
      zh: "Claude 通用配置片段不是有效 JSON，未自动覆盖。",
      en: "The Claude common config snippet is not valid JSON and was not overwritten.",
    },
  };
  const translated = messages[message];
  return translated ? pickText(language, translated.zh, translated.en) : message;
}

function getCcSwitchProtectionDescription(status: CcSwitchHookProtectionStatus | null | undefined, language: AppLanguage): string {
  if (!status) return pickText(language, "正在检测 cc-switch 通用配置保护状态。", "Checking cc-switch common config protection status.");
  switch (status.state) {
    case "synced":
      return pickText(language, "已同步到 cc-switch 通用配置片段，切换供应商时会保留 CLI-Manager Hook。", "Synced to the cc-switch common config snippet. CLI-Manager Hook is preserved when switching providers.");
    case "notSynced":
      return pickText(language, "尚未同步到 cc-switch 通用配置片段，重新安装对应 Hook 可重试。", "Not synced to the cc-switch common config snippet yet. Reinstall the Hook to retry.");
    case "notDetected":
      return pickText(language, "未检测到 cc-switch 数据库，Hook 已按普通全局配置工作。", "No cc-switch database detected. Hook is installed as normal global configuration.");
    case "invalidDb":
      return pickText(language, "设置中的 cc-switch 数据库路径不可用，已停止自动写入以避免误写。", "The cc-switch database path in settings is unavailable. Automatic write is stopped to avoid incorrect writes.");
    case "unavailable":
      return status.wslMismatch
        ? pickText(language, "检测到 WSL 环境不匹配，请在「设置 -> 供应商」选择同一环境内的 cc-switch.db。", "WSL environment mismatch detected. Choose a cc-switch.db from the same environment in Settings -> Providers.")
        : pickText(language, "cc-switch 数据库暂不可用于通用配置同步。", "cc-switch database is currently unavailable for common config sync.");
    case "syncFailed":
      return pickText(language, "cc-switch 通用配置同步失败，Hook 本身已安装，可稍后重试。", "cc-switch common config sync failed. The Hook itself is installed; retry later.");
  }
}

function CcSwitchProtectionCard({ status }: { status?: CcSwitchHookProtectionStatus | null }) {
  const { language } = useI18n();
  const state = status?.state ?? "notDetected";
  const isHealthy = state === "synced";
  const isWarning = state === "notSynced" || state === "unavailable";
  const Icon = isHealthy ? CheckCircle : isWarning || state === "notDetected" ? HelpCircle : AlertTriangle;
  const formattedMessage = formatCcSwitchMessage(status?.message ?? null, language);

  return (
    <Card className="border border-border bg-surface-container-low" p="sm" radius="lg">
      <Stack gap="xs">
        <Group justify="space-between" gap="sm" align="flex-start">
          <Group gap="sm" wrap="nowrap" className="min-w-0">
            <Box
              style={{
                color: isHealthy
                  ? "var(--success)"
                  : state === "syncFailed" || state === "invalidDb"
                    ? "var(--error)"
                    : "var(--warning)",
                marginTop: 2,
                flexShrink: 0,
              }}
            >
              <Icon size={18} />
            </Box>
            <Box className="min-w-0">
              <Text size="sm" fw={500} c="var(--on-surface)">
                {pickText(language, "cc-switch 通用配置保护", "cc-switch Common Config Protection")}
              </Text>
              <Text mt={4} size="xs" c="var(--on-surface-variant)">
                {getCcSwitchProtectionDescription(status, language)}
              </Text>
            </Box>
          </Group>
          <Badge variant="light" color={CCSWITCH_STATE_COLORS[state]} radius="xl" className="shrink-0">
            {pickText(language, CCSWITCH_STATE_LABELS[state].zh, CCSWITCH_STATE_LABELS[state].en)}
          </Badge>
        </Group>
        {status?.dbPath && (
          <Text
            component="code"
            size="xs"
            ff="var(--font-ui-mono)"
            c="var(--on-surface-variant)"
            className="break-all"
          >
            {status.dbPath}
          </Text>
        )}
        {formattedMessage && (
          <Text size="xs" c={state === "syncFailed" || state === "invalidDb" ? "red" : "yellow"}>
            {formattedMessage}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

function PathRow({ label, value }: { label: string; value: string | null }) {
  const { language } = useI18n();
  const formatted = formatPath(value, language);
  const hasValue = Boolean(value && value.trim());
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!hasValue || !value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const getIcon = () => {
    const normalized = label.toLowerCase();
    if (label.includes('目录') || normalized.includes("directory")) return <Folder size={16} />;
    if (label.includes('json') || label.includes('toml')) return <FileCode size={16} />;
    return <FileCode size={16} />;
  };

  return (
    <Card className="border border-border/50 bg-surface-container-lowest" p="sm" radius="md">
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Box
          style={{
            color: hasValue ? "var(--primary)" : "var(--text-muted)",
            marginTop: 2,
          }}
        >
          {getIcon()}
        </Box>
        <Stack gap={4} className="min-w-0 flex-1">
          <Text size="xs" fw={500} c="var(--on-surface-variant)">
            {label}
          </Text>
          <Text
            component="code"
            size="xs"
            ff="var(--font-ui-mono)"
            c={hasValue ? "var(--on-surface)" : "var(--text-muted)"}
            className="min-w-0 break-all leading-5"
            title={formatted}
          >
            {formatted}
          </Text>
        </Stack>
        {hasValue && (
          <Button
            variant="subtle"
            color="gray"
            size="compact-xs"
            onClick={handleCopy}
            className="shrink-0"
            aria-label={pickText(language, "复制路径", "Copy path")}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </Button>
        )}
      </Group>
    </Card>
  );
}

interface HookCardProps {
  icon: React.ReactNode;
  label: string;
  checked: boolean;
  notifyEnabled?: boolean;
  onToggleNotify?: () => void;
  notifyDisabled?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  actionLabel?: string;
}

function HookCard({
  icon,
  label,
  checked,
  notifyEnabled,
  onToggleNotify,
  notifyDisabled,
  onClick,
  disabled,
  actionLabel,
}: HookCardProps) {
  const { language } = useI18n();
  const interactive = Boolean(onClick);
  return (
    <Card
      className="border transition-colors"
      p="md"
      radius="lg"
      role={interactive ? "button" : undefined}
      tabIndex={interactive && !disabled ? 0 : undefined}
      aria-disabled={interactive ? disabled : undefined}
      aria-label={actionLabel}
      title={actionLabel}
      onClick={interactive && !disabled ? onClick : undefined}
      onKeyDown={interactive ? (event) => {
        if (disabled) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick?.();
        }
      } : undefined}
      style={{
        borderColor: checked ? "var(--success)" : "var(--border)",
        backgroundColor: checked ? "var(--success-container)" : "var(--surface-container-low)",
        cursor: interactive && !disabled ? "pointer" : "default",
        opacity: disabled ? 0.68 : 1,
      }}
    >
      <Stack gap={8} align="center">
        <Box
          style={{
            color: checked ? "var(--success)" : "var(--text-muted)",
            fontSize: 26,
            lineHeight: 1,
          }}
        >
          {icon}
        </Box>
        <Text size="xs" fw={500} c={checked ? "var(--on-success-container)" : "var(--on-surface-variant)"} ta="center" lh={1.3}>
          {label}
        </Text>
        <Group gap={4} align="center" wrap="nowrap">
          <Badge
            variant="filled"
            color={checked ? "green" : "gray"}
            radius="xl"
            size="xs"
          >
            {checked ? pickText(language, "已安装", "Installed") : pickText(language, "未安装", "Not Installed")}
          </Badge>
          {onToggleNotify && (
            <ActionIcon
              variant={notifyEnabled ? "light" : "subtle"}
              color={notifyEnabled ? "blue" : "gray"}
              size="sm"
              radius="xl"
              onClick={(e) => { e.stopPropagation(); onToggleNotify(); }}
              disabled={notifyDisabled}
              aria-label={pickText(language, `${label} 系统通知`, `${label} system notification`)}
            >
              {notifyEnabled ? <Bell size={12} /> : <BellOff size={12} />}
            </ActionIcon>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

function StatusPill({ status }: { status: HookInstallStatus }) {
  const { language } = useI18n();
  return (
    <Badge variant="light" color={STATUS_COLORS[status]} radius="xl">
      {pickText(language, STATUS_LABELS[status].zh, STATUS_LABELS[status].en)}
    </Badge>
  );
}

function SettingsSwitchRow({
  title,
  description,
  checked,
  onCheckedChange,
  icon: Icon,
  tools,
}: {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  icon?: React.ComponentType<{ size?: number }>;
  tools?: ("claude" | "codex")[];
}) {
  return (
    <Card className="border border-border bg-surface-container-low" p="sm" radius="lg">
      <Group justify="space-between" align="center" gap="md" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" className="min-w-0">
          {Icon && (
            <Box
              style={{
                color: checked ? "var(--primary)" : "var(--text-muted)",
                marginTop: 2,
                flexShrink: 0,
              }}
            >
              <Icon size={18} />
            </Box>
          )}
          <Box className="min-w-0">
            <Group gap="xs" align="center" wrap="wrap">
              <Text size="sm" fw={500} c="var(--on-surface)" className="whitespace-nowrap">
                {title}
              </Text>
              {tools?.map((tool) => (
                <Badge
                  key={tool}
                  variant="light"
                  size="xs"
                  color={tool === "claude" ? "orange" : "blue"}
                  style={{ textTransform: "none" }}
                >
                  {tool === "claude" ? "Claude" : "Codex"}
                </Badge>
              ))}
            </Group>
            <Text mt={4} size="xs" c="var(--text-muted)">
              {description}
            </Text>
          </Box>
        </Group>
        <Switch
          color="cliPrimary"
          className="shrink-0"
          checked={checked}
          onChange={(event) => onCheckedChange(event.currentTarget.checked)}
          aria-label={title}
        />
      </Group>
    </Card>
  );
}

export function HookSettingsPage() {
  const { language, t } = useI18n();
  const text = (zh: string, en: string) => pickText(language, zh, en);
  const claudeHookConfigDir = useSettingsStore((s) => s.claudeHookConfigDir);
  const codexHookConfigDir = useSettingsStore((s) => s.codexHookConfigDir);
  const [status, setStatus] = useState<HookSettingsStatus | null>(null);
  const [selectedDir, setSelectedDir] = useState<string | null>(claudeHookConfigDir);
  const [codexSelectedDir, setCodexSelectedDir] = useState<string | null>(codexHookConfigDir);
  const [loading, setLoading] = useState(false);
  const [claudeWorking, setClaudeWorking] = useState(false);
  const [codexWorking, setCodexWorking] = useState(false);
  const hookPopupNotificationsEnabled = useSettingsStore((s) => s.hookPopupNotificationsEnabled);
  const hookPopupAutoCloseEnabled = useSettingsStore((s) => s.hookPopupAutoCloseEnabled);
  const hookPopupAutoCloseSeconds = useSettingsStore((s) => s.hookPopupAutoCloseSeconds);
  const systemNotificationsEnabled = useSettingsStore((s) => s.systemNotificationsEnabled);
  const systemNotificationEvents = useSettingsStore((s) => s.systemNotificationEvents);
  const ccSwitchDbPath = useSettingsStore((s) => s.ccSwitchDbPath);
  const claudeHookAutoRepairKnownInstalled = useSettingsStore((s) => s.claudeHookAutoRepairKnownInstalled);
  const claudeHookAutoRepairNoticeShown = useSettingsStore((s) => s.claudeHookAutoRepairNoticeShown);
  const updateSetting = useSettingsStore((s) => s.update);
  const [autoCloseSecondsDraft, setAutoCloseSecondsDraft] = useState(String(hookPopupAutoCloseSeconds));
  const [claudePathsOpen, setClaudePathsOpen] = useState(false);
  const [claudeInfoOpen, setClaudeInfoOpen] = useState(false);
  const [codexPathsOpen, setCodexPathsOpen] = useState(false);
  const [codexInfoOpen, setCodexInfoOpen] = useState(false);

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
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
        autoRepair: claudeHookAutoRepairKnownInstalled,
      });
      setStatus(nextStatus);
      if (nextStatus.claude.configDir) {
        setSelectedDir(nextStatus.claude.configDir);
      }
      if (nextStatus.codex.configDir) {
        setCodexSelectedDir(nextStatus.codex.configDir);
      }
      if (nextStatus.claudeAutoRepaired && !claudeHookAutoRepairNoticeShown) {
        toast.info(text("Claude Hook 已自动恢复", "Claude Hook Restored"), {
          description: text("检测到 Hook 被外部工具覆盖，已重新写入全局 Hook 配置。", "The Hook was overwritten by another tool and has been restored to the global Hook config."),
        });
        await updateSetting("claudeHookAutoRepairNoticeShown", true);
      }
    } catch (error) {
      toast.error(text("刷新 Hook 状态失败", "Failed to refresh Hook status"), { description: getErrorMessage(error) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  const handleSelectDir = async () => {
    try {
      const dir = await invoke<string | null>("hook_settings_select_dir", {
        title: text("选择 Claude 配置目录", "Choose Claude config directory"),
      });
      if (!dir) return;
      setSelectedDir(dir);
      await updateSetting("claudeHookConfigDir", dir);
      await refreshStatus(dir, codexSelectedDirArg);
    } catch (error) {
      toast.error(text("选择目录失败", "Failed to choose directory"), { description: getErrorMessage(error) });
    }
  };

  const handleSelectCodexDir = async () => {
    try {
      const dir = await invoke<string | null>("hook_settings_select_dir", {
        title: text("选择 Codex 配置目录", "Choose Codex config directory"),
      });
      if (!dir) return;
      setCodexSelectedDir(dir);
      await updateSetting("codexHookConfigDir", dir);
      await refreshStatus(selectedDirArg, dir);
    } catch (error) {
      toast.error(text("选择 Codex 目录失败", "Failed to choose Codex directory"), { description: getErrorMessage(error) });
    }
  };

  // 手动粘贴配置目录（支持 WSL UNC，如 \\wsl.localhost\Ubuntu-22.04\home\<用户名>\.claude）。
  // 原生选目录弹窗进 WSL 路径体验差，故提供文本输入兜底。
  const handleManualClaudeDirCommit = async (raw: string) => {
    const dir = raw.trim() || null;
    setSelectedDir(dir);
    await updateSetting("claudeHookConfigDir", dir);
    await refreshStatus(dir ?? undefined, codexSelectedDirArg);
  };

  const handleManualCodexDirCommit = async (raw: string) => {
    const dir = raw.trim() || null;
    setCodexSelectedDir(dir);
    await updateSetting("codexHookConfigDir", dir);
    await refreshStatus(selectedDirArg, dir ?? undefined);
  };

  const handleClaudeInstall = async () => {
    setClaudeWorking(true);
    try {
      const nextStatus = await invoke<HookSettingsStatus>("hook_settings_install", {
        selectedDir: selectedDirArg,
        codexSelectedDir: codexSelectedDirArg,
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
      });
      setStatus(nextStatus);
      if (nextStatus.claude.configDir) setSelectedDir(nextStatus.claude.configDir);
      await updateSetting("claudeHookAutoRepairKnownInstalled", true);
      await updateSetting("claudeHookAutoRepairNoticeShown", false);
      toast.success(text("Claude Hook 已安装", "Claude Hook installed"), {
        description: getCcSwitchProtectionDescription(nextStatus.ccSwitch, language),
      });
    } catch (error) {
      toast.error(text("安装 Claude Hook 失败", "Failed to install Claude Hook"), { description: getErrorMessage(error) });
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
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
      });
      setStatus(nextStatus);
      if (nextStatus.claude.configDir) setSelectedDir(nextStatus.claude.configDir);
      await updateSetting("claudeHookAutoRepairKnownInstalled", false);
      await updateSetting("claudeHookAutoRepairNoticeShown", false);
      toast.success(text("Claude Hook 已删除", "Claude Hook removed"));
    } catch (error) {
      toast.error(text("删除 Claude Hook 失败", "Failed to remove Claude Hook"), { description: getErrorMessage(error) });
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
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
      });
      setStatus(nextStatus);
      if (nextStatus.codex.configDir) setCodexSelectedDir(nextStatus.codex.configDir);
      toast.success(text("Codex Hook 已安装", "Codex Hook installed"), {
        description: getCcSwitchProtectionDescription(nextStatus.ccSwitch, language),
      });
    } catch (error) {
      toast.error(text("安装 Codex Hook 失败", "Failed to install Codex Hook"), { description: getErrorMessage(error) });
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
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
      });
      setStatus(nextStatus);
      if (nextStatus.codex.configDir) setCodexSelectedDir(nextStatus.codex.configDir);
      toast.success(text("Codex Hook 已删除", "Codex Hook removed"));
    } catch (error) {
      toast.error(text("删除 Codex Hook 失败", "Failed to remove Codex Hook"), { description: getErrorMessage(error) });
    } finally {
      setCodexWorking(false);
    }
  };

  const syncStatusAfterMutation = (nextStatus: HookSettingsStatus) => {
    setStatus(nextStatus);
    if (nextStatus.claude.configDir) setSelectedDir(nextStatus.claude.configDir);
    if (nextStatus.codex.configDir) setCodexSelectedDir(nextStatus.codex.configDir);
  };

  const handleModuleToggle = async (
    tool: HookTool,
    module: HookModule,
    installed: boolean,
    moduleLabel: string,
  ) => {
    const command =
      tool === "claude"
        ? (installed ? "hook_settings_uninstall" : "hook_settings_install")
        : (installed ? "hook_settings_uninstall_codex" : "hook_settings_install_codex");
    const setWorking = tool === "claude" ? setClaudeWorking : setCodexWorking;
    const toolLabel = tool === "claude" ? "Claude" : "Codex";

    setWorking(true);
    try {
      const nextStatus = await invoke<HookSettingsStatus>(command, {
        selectedDir: selectedDirArg,
        codexSelectedDir: codexSelectedDirArg,
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
        module,
      });
      syncStatusAfterMutation(nextStatus);
      if (tool === "claude") {
        await updateSetting("claudeHookAutoRepairKnownInstalled", false);
        await updateSetting("claudeHookAutoRepairNoticeShown", false);
      }
      toast.success(
        t(installed ? "settings.hooks.module.removed" : "settings.hooks.module.installed", {
          tool: toolLabel,
          module: moduleLabel,
        })
      );
    } catch (error) {
      toast.error(
        t(installed ? "settings.hooks.module.removeFailed" : "settings.hooks.module.installFailed", {
          tool: toolLabel,
          module: moduleLabel,
        }),
        { description: getErrorMessage(error) }
      );
    } finally {
      setWorking(false);
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
  const ccSwitchProtection = status?.ccSwitch ?? null;
  const claudeStatus = claude?.status ?? "directoryMissing";
  const codexStatus = codex?.status ?? "directoryMissing";
  const claudeSessionStartInstalled = Boolean(claude?.attentionScriptInstalled && claude.sessionStartHookInstalled);
  const claudeRunningInstalled = Boolean(claude?.attentionScriptInstalled && claude.runningHookInstalled);
  const claudeAttentionInstalled = Boolean(claude?.attentionScriptInstalled && claude.attentionHookInstalled);
  // Claude — 拆分为独立事件
  const claudeStopInstalled = Boolean(claude?.finishedScriptInstalled && claude.stopHookInstalled);
  const claudeFailureInstalled = Boolean(claude?.finishedScriptInstalled && claude.failureHookInstalled);
  const claudeSubagentInstalled = Boolean(claude?.subagentStartHookInstalled);
  const codexSessionStartInstalled = Boolean(codex?.attentionScriptInstalled && codex.sessionStartHookInstalled);
  const codexRunningInstalled = Boolean(codex?.attentionScriptInstalled && codex.runningHookInstalled);
  const codexAttentionInstalled = Boolean(codex?.attentionScriptInstalled && codex.attentionHookInstalled);
  // Codex — 拆分为独立事件
  const codexStopInstalled = Boolean(codex?.finishedScriptInstalled && codex.stopHookInstalled);
  const codexSubagentInstalled = Boolean(codex?.subagentStartHookInstalled);
  const claudeToolLabel = "Claude";
  const codexToolLabel = "Codex";
  const claudeSessionStartLabel = text("会话启动", "Session Start");
  const claudeRunningLabel = text("运行中", "Running");
  const claudeAttentionLabel = text("待审批", "Awaiting Approval");
  const claudeStopLabel = text("任务完成", "Task Completed");
  const claudeFailureLabel = text("执行失败", "Failed");
  const claudeSubagentLabel = text("子 Agent", "Subagent");
  const codexSessionStartLabel = text("会话启动", "Session Start");
  const codexRunningLabel = text("运行中", "Running");
  const codexAttentionLabel = text("需要审批", "Approval Needed");
  const codexStopLabel = text("完成", "Completed");
  const codexSubagentLabel = text("子 Agent", "Subagent");
  const codexHooksFeatureLabel = text("Hooks 功能", "Hooks Feature");
  const buildModuleActionLabel = (toolLabel: string, moduleLabel: string, installed: boolean) =>
    t(installed ? "settings.hooks.card.clickToUninstall" : "settings.hooks.card.clickToInstall", {
      tool: toolLabel,
      module: moduleLabel,
    });

  // 切换一组 HookEventType 的系统通知状态
  const toggleNotifyEvents = (events: HookEventType[], enabled: boolean) => {
    const update = { ...systemNotificationEvents };
    for (const event of events) {
      update[event] = enabled;
    }
    void updateSetting("systemNotificationEvents", update);
  };
  const notifyState = (events: HookEventType[]) => events.every((e) => systemNotificationEvents[e]);

  return (
    <Stack gap="md">
      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="md">
          <Box>
            <Text size="sm" fw={600} c="var(--on-surface)">
              {text("Hook 通知弹框", "Hook Toast Notifications")}
            </Text>
            <Text mt={4} size="xs" c="var(--on-surface-variant)">
              {text("控制 Claude Code 和 Codex CLI Hook 事件的右上角弹框；终端标签小圆点不受这里的弹框开关影响。", "Controls top-right toast cards for Claude Code and Codex CLI Hook events. Terminal tab dots are not affected.")}
            </Text>
          </Box>
          <SettingsSwitchRow
            title={text("通知弹框", "Toast Notifications")}
            description={text("关闭后不再弹出 Hook 通知卡片，只更新标签栏小圆点颜色。", "When disabled, Hook notification cards stop popping up; only tab dot color updates.")}
            checked={hookPopupNotificationsEnabled}
            onCheckedChange={(checked) => void updateSetting("hookPopupNotificationsEnabled", checked)}
          />
          <SettingsSwitchRow
            title={text("自动关闭弹框", "Auto-close Toasts")}
            description={text("开启后 Hook 通知会在指定时间后自动消失。", "When enabled, Hook notifications disappear after the configured delay.")}
            checked={hookPopupAutoCloseEnabled}
            onCheckedChange={(checked) => void updateSetting("hookPopupAutoCloseEnabled", checked)}
          />
          <Card className="border border-border bg-surface-container-low" p="sm" radius="lg">
            <Group justify="space-between" align="center" gap="md">
              <Box>
                <Text size="sm" fw={500} c="var(--on-surface)">
                  {text("默认关闭时间", "Default Close Delay")}
                </Text>
                <Text mt={4} size="xs" c="var(--text-muted)">
                  {text("单位：秒，默认 60 秒；仅在自动关闭开启时可编辑。", "Seconds. Default is 60. Editable only when auto-close is enabled.")}
                </Text>
              </Box>
              <Group gap="xs">
              <TextInput
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
                w={96}
                size="xs"
                aria-label={text("Hook 弹框默认关闭时间", "Hook toast default close delay")}
              />
                <Text size="xs" c="var(--on-surface-variant)">
                  {text("秒", "sec")}
                </Text>
              </Group>
            </Group>
          </Card>
        </Stack>
      </section>

      <CcSwitchProtectionCard status={ccSwitchProtection} />

      <Card className="border border-border bg-surface-container-low" p="sm" radius="lg">
        <Group justify="space-between" align="center" gap="md">
          <Group gap="sm">
            <Bell
              size={16}
              style={{ color: systemNotificationsEnabled ? "var(--primary)" : "var(--text-muted)" }}
            />
            <Box>
              <Text size="sm" fw={500} c="var(--on-surface)">
                {text("系统通知", "System Notifications")}
              </Text>
              <Text size="xs" c="var(--on-surface-variant)">
                {text("每个 Hook 卡片下方可独立开关对应事件的系统通知（灰色铃铛=关闭，蓝色铃铛=开启）", "System notifications can be toggled per Hook card. Gray bell means off, blue bell means on.")}
              </Text>
            </Box>
          </Group>
          <Switch
            color="cliPrimary"
            checked={systemNotificationsEnabled}
            onChange={(event) => void updateSetting("systemNotificationsEnabled", event.currentTarget.checked)}
            aria-label={text("启用系统通知", "Enable system notifications")}
          />
        </Group>
      </Card>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start" gap="md">
            <Box>
              <Text size="sm" fw={600} c="var(--on-surface)">
                {text("Claude Code Hook 桥接", "Claude Code Hook Bridge")}
              </Text>
              <Text mt={4} size="xs" c="var(--on-surface-variant)">
                {text("Claude Code 的运行中、待审批、完成和异常退出状态通过 Hook 上报；普通 shell 命令由通用 Shell 运行监控补充。", "Claude Code running, approval, completion, and failure states are reported through Hook. Normal shell commands are covered by generic Shell runtime monitoring.")}
              </Text>
            </Box>
            <StatusPill status={claudeStatus} />
          </Group>

          <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="md">
            <HookCard
              icon={<Play />}
              label={claudeSessionStartLabel}
              checked={claudeSessionStartInstalled}
              notifyEnabled={notifyState(["SessionStart"])}
              onToggleNotify={() => toggleNotifyEvents(["SessionStart"], !notifyState(["SessionStart"]))}
              notifyDisabled={!systemNotificationsEnabled}
              onClick={() => void handleModuleToggle("claude", "sessionStart", claudeSessionStartInstalled, claudeSessionStartLabel)}
              disabled={loading || claudeWorking || codexWorking || claudeStatus === "directoryMissing"}
              actionLabel={buildModuleActionLabel(claudeToolLabel, claudeSessionStartLabel, claudeSessionStartInstalled)}
            />
            <HookCard
              icon={<Activity />}
              label={claudeRunningLabel}
              checked={claudeRunningInstalled}
              notifyEnabled={notifyState(["UserPromptSubmit"])}
              onToggleNotify={() => toggleNotifyEvents(["UserPromptSubmit"], !notifyState(["UserPromptSubmit"]))}
              notifyDisabled={!systemNotificationsEnabled}
              onClick={() => void handleModuleToggle("claude", "running", claudeRunningInstalled, claudeRunningLabel)}
              disabled={loading || claudeWorking || codexWorking || claudeStatus === "directoryMissing"}
              actionLabel={buildModuleActionLabel(claudeToolLabel, claudeRunningLabel, claudeRunningInstalled)}
            />
            <HookCard
              icon={<Bell />}
              label={claudeAttentionLabel}
              checked={claudeAttentionInstalled}
              notifyEnabled={notifyState(["Notification"])}
              onToggleNotify={() => toggleNotifyEvents(["Notification"], !notifyState(["Notification"]))}
              notifyDisabled={!systemNotificationsEnabled}
              onClick={() => void handleModuleToggle("claude", "attention", claudeAttentionInstalled, claudeAttentionLabel)}
              disabled={loading || claudeWorking || codexWorking || claudeStatus === "directoryMissing"}
              actionLabel={buildModuleActionLabel(claudeToolLabel, claudeAttentionLabel, claudeAttentionInstalled)}
            />
            <HookCard
              icon={<CheckCircle />}
              label={claudeStopLabel}
              checked={claudeStopInstalled}
              notifyEnabled={notifyState(["Stop"])}
              onToggleNotify={() => toggleNotifyEvents(["Stop"], !notifyState(["Stop"]))}
              notifyDisabled={!systemNotificationsEnabled}
              onClick={() => void handleModuleToggle("claude", "stop", claudeStopInstalled, claudeStopLabel)}
              disabled={loading || claudeWorking || codexWorking || claudeStatus === "directoryMissing"}
              actionLabel={buildModuleActionLabel(claudeToolLabel, claudeStopLabel, claudeStopInstalled)}
            />
            <HookCard
              icon={<XCircle size={26} />}
              label={claudeFailureLabel}
              checked={claudeFailureInstalled}
              notifyEnabled={notifyState(["StopFailure"])}
              onToggleNotify={() => toggleNotifyEvents(["StopFailure"], !notifyState(["StopFailure"]))}
              notifyDisabled={!systemNotificationsEnabled}
              onClick={() => void handleModuleToggle("claude", "failure", claudeFailureInstalled, claudeFailureLabel)}
              disabled={loading || claudeWorking || codexWorking || claudeStatus === "directoryMissing"}
              actionLabel={buildModuleActionLabel(claudeToolLabel, claudeFailureLabel, claudeFailureInstalled)}
            />
            <HookCard
              icon={<Layers size={26} />}
              label={claudeSubagentLabel}
              checked={claudeSubagentInstalled}
              onClick={() => void handleModuleToggle("claude", "subagent", claudeSubagentInstalled, claudeSubagentLabel)}
              disabled={loading || claudeWorking || codexWorking || claudeStatus === "directoryMissing"}
              actionLabel={buildModuleActionLabel(claudeToolLabel, claudeSubagentLabel, claudeSubagentInstalled)}
            />
          </SimpleGrid>

          <Group gap="xs">
            <Button
              variant="subtle"
              color="gray"
              size="xs"
              onClick={() => setClaudePathsOpen(!claudePathsOpen)}
              leftSection={claudePathsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            >
              {text("查看配置路径", "View Config Paths")}
            </Button>
            <Button
              variant="subtle"
              color="gray"
              size="xs"
              onClick={() => setClaudeInfoOpen(!claudeInfoOpen)}
              leftSection={<HelpCircle size={14} />}
            >
              {text("安装说明", "Install Notes")}
            </Button>
          </Group>

          {claudePathsOpen && (
            <Card className="bg-surface-container-low/50" p="sm" radius="lg">
              <Stack gap="xs">
                <PathRow label={text("Claude 配置目录", "Claude Config Directory")} value={claude?.configDir ?? selectedDir} />
                <PathRow label={text("hooks 目录", "hooks Directory")} value={claude?.hooksDir ?? null} />
                <PathRow label="settings.json" value={claude?.configPath ?? null} />
              </Stack>
            </Card>
          )}

          {claudeInfoOpen && (
            <Card className="bg-surface-container-low/50" p="md" radius="lg">
              <Stack gap="md">
                <Group gap="sm" wrap="nowrap" align="flex-start">
                  <Box style={{ color: "var(--success)", marginTop: 2 }}>
                    <Check size={18} />
                  </Box>
                  <Stack gap={4}>
                    <Text size="xs" fw={500} c="var(--on-surface)">
                      {text("安装内容", "Installed Content")}
                    </Text>
                    <Stack gap={2}>
                      <Group gap="xs">
                        <FileCode size={12} style={{ color: "var(--text-muted)" }} />
                        <Text size="xs" c="var(--on-surface-variant)" ff="var(--font-ui-mono)">
                          {text("settings.json 注册 __hook 命令", "settings.json registers the __hook command")}
                        </Text>
                      </Group>
                      <Group gap="xs">
                        <FileCode size={12} style={{ color: "var(--text-muted)" }} />
                        <Text size="xs" c="var(--on-surface-variant)">
                          {text("指向本程序，跨平台无需脚本", "Points to this app directly; no cross-platform script is needed")}
                        </Text>
                      </Group>
                    </Stack>
                  </Stack>
                </Group>

                <Group gap="sm" wrap="nowrap" align="flex-start">
                  <Box style={{ color: "var(--warning)", marginTop: 2 }}>
                    <X size={18} />
                  </Box>
                  <Stack gap={4}>
                    <Text size="xs" fw={500} c="var(--on-surface)">
                      {text("删除时保留", "Kept on Removal")}
                    </Text>
                    <Stack gap={2}>
                      <Text size="xs" c="var(--on-surface-variant)">
                        {text("• 用户自己的 hooks", "• User-owned hooks")}
                      </Text>
                      <Text size="xs" c="var(--on-surface-variant)">
                        {text("• 其它工具注册的 hook 命令", "• Hook commands registered by other tools")}
                      </Text>

                    </Stack>
                  </Stack>
                </Group>
              </Stack>
            </Card>
          )}

          <TextInput
            size="xs"
            label={text("Claude 配置目录（可手动粘贴，支持 WSL UNC）", "Claude config directory (manual paste supported, including WSL UNC)")}
            placeholder={text("\\wsl.localhost\\Ubuntu-22.04\\home\\用户名\\.claude", "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\.claude")}
            value={selectedDir ?? ""}
            onChange={(e) => setSelectedDir(e.currentTarget.value || null)}
            onBlur={(e) => void handleManualClaudeDirCommit(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleManualClaudeDirCommit(e.currentTarget.value);
            }}
            disabled={loading || claudeWorking || codexWorking}
          />

          <Group gap="xs">
            <Button variant="light" color="cliPrimary" size="xs" onClick={handleSelectDir} disabled={loading || claudeWorking || codexWorking}>
              {text("选择 Claude 目录", "Choose Claude Directory")}
            </Button>
            <Button color="cliPrimary" size="xs" onClick={handleClaudeInstall} disabled={loading || claudeWorking || claudeStatus === "directoryMissing"}>
              {claudeWorking ? text("处理中...", "Processing...") : text("安装 Claude Hook", "Install Claude Hook")}
            </Button>
            <Button variant="light" color="red" size="xs" onClick={handleClaudeUninstall} disabled={loading || claudeWorking || claudeStatus === "directoryMissing"}>
              {text("删除 Claude Hook", "Remove Claude Hook")}
            </Button>
            <Button variant="default" color="gray" size="xs" onClick={() => void refreshStatus()} disabled={loading || claudeWorking || codexWorking}>
              {loading ? text("刷新中...", "Refreshing...") : text("刷新状态", "Refresh Status")}
            </Button>
          </Group>
        </Stack>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start" gap="md">
            <Box>
              <Text size="sm" fw={600} c="var(--on-surface)">
                {text("Codex CLI Hook 桥接", "Codex CLI Hook Bridge")}
              </Text>
              <Text mt={4} size="xs" c="var(--on-surface-variant)">
                {text("Codex 的运行中、待审批和完成状态通过 Hook 上报；普通 shell 命令由通用 Shell 运行监控补充。", "Codex running, approval, and completion states are reported through Hook. Normal shell commands are covered by generic Shell runtime monitoring.")}
              </Text>
            </Box>
            <StatusPill status={codexStatus} />
          </Group>

          <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="md">
            <HookCard
              icon={<Play />}
              label={codexSessionStartLabel}
              checked={codexSessionStartInstalled}
              notifyEnabled={notifyState(["SessionStart"])}
              onToggleNotify={() => toggleNotifyEvents(["SessionStart"], !notifyState(["SessionStart"]))}
              notifyDisabled={!systemNotificationsEnabled}
              onClick={() => void handleModuleToggle("codex", "sessionStart", codexSessionStartInstalled, codexSessionStartLabel)}
              disabled={loading || claudeWorking || codexWorking || codexStatus === "directoryMissing"}
              actionLabel={buildModuleActionLabel(codexToolLabel, codexSessionStartLabel, codexSessionStartInstalled)}
            />
            <HookCard
              icon={<Activity />}
              label={codexRunningLabel}
              checked={codexRunningInstalled}
              notifyEnabled={notifyState(["UserPromptSubmit"])}
              onToggleNotify={() => toggleNotifyEvents(["UserPromptSubmit"], !notifyState(["UserPromptSubmit"]))}
              notifyDisabled={!systemNotificationsEnabled}
              onClick={() => void handleModuleToggle("codex", "running", codexRunningInstalled, codexRunningLabel)}
              disabled={loading || claudeWorking || codexWorking || codexStatus === "directoryMissing"}
              actionLabel={buildModuleActionLabel(codexToolLabel, codexRunningLabel, codexRunningInstalled)}
            />
            <HookCard
              icon={<ShieldAlert />}
              label={codexAttentionLabel}
              checked={codexAttentionInstalled}
              notifyEnabled={notifyState(["PermissionRequest"])}
              onToggleNotify={() => toggleNotifyEvents(["PermissionRequest"], !notifyState(["PermissionRequest"]))}
              notifyDisabled={!systemNotificationsEnabled}
              onClick={() => void handleModuleToggle("codex", "attention", codexAttentionInstalled, codexAttentionLabel)}
              disabled={loading || claudeWorking || codexWorking || codexStatus === "directoryMissing"}
              actionLabel={buildModuleActionLabel(codexToolLabel, codexAttentionLabel, codexAttentionInstalled)}
            />
            <HookCard
              icon={<CheckCircle />}
              label={codexStopLabel}
              checked={codexStopInstalled}
              notifyEnabled={notifyState(["Stop"])}
              onToggleNotify={() => toggleNotifyEvents(["Stop"], !notifyState(["Stop"]))}
              notifyDisabled={!systemNotificationsEnabled}
              onClick={() => void handleModuleToggle("codex", "stop", codexStopInstalled, codexStopLabel)}
              disabled={loading || claudeWorking || codexWorking || codexStatus === "directoryMissing"}
              actionLabel={buildModuleActionLabel(codexToolLabel, codexStopLabel, codexStopInstalled)}
            />
            <HookCard
              icon={<Layers size={26} />}
              label={codexSubagentLabel}
              checked={codexSubagentInstalled}
              onClick={() => void handleModuleToggle("codex", "subagent", codexSubagentInstalled, codexSubagentLabel)}
              disabled={loading || claudeWorking || codexWorking || codexStatus === "directoryMissing"}
              actionLabel={buildModuleActionLabel(codexToolLabel, codexSubagentLabel, codexSubagentInstalled)}
            />
            <HookCard
              icon={<ToggleRight />}
              label={codexHooksFeatureLabel}
              checked={Boolean(codex?.hooksFeatureInstalled)}
              onClick={() => void handleModuleToggle("codex", "hooksFeature", Boolean(codex?.hooksFeatureInstalled), codexHooksFeatureLabel)}
              disabled={loading || claudeWorking || codexWorking || codexStatus === "directoryMissing"}
              actionLabel={buildModuleActionLabel(codexToolLabel, codexHooksFeatureLabel, Boolean(codex?.hooksFeatureInstalled))}
            />
          </SimpleGrid>

          <Group gap="xs">
            <Button
              variant="subtle"
              color="gray"
              size="xs"
              onClick={() => setCodexPathsOpen(!codexPathsOpen)}
              leftSection={codexPathsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            >
              {text("查看配置路径", "View Config Paths")}
            </Button>
            <Button
              variant="subtle"
              color="gray"
              size="xs"
              onClick={() => setCodexInfoOpen(!codexInfoOpen)}
              leftSection={<HelpCircle size={14} />}
            >
              {text("安装说明", "Install Notes")}
            </Button>
          </Group>

          {codexPathsOpen && (
            <Card className="bg-surface-container-low/50" p="sm" radius="lg">
              <Stack gap="xs">
                <PathRow label={text("Codex 配置目录", "Codex Config Directory")} value={codex?.configDir ?? codexSelectedDir} />
                <PathRow label={text("hooks 目录", "hooks Directory")} value={codex?.hooksDir ?? null} />
                <PathRow label="hooks.json" value={codex?.configPath ?? null} />
                <PathRow label="config.toml" value={codex?.featureConfigPath ?? null} />
              </Stack>
            </Card>
          )}

          {codexInfoOpen && (
            <Card className="bg-surface-container-low/50" p="md" radius="lg">
              <Stack gap="md">
                <Group gap="sm" wrap="nowrap" align="flex-start">
                  <Box style={{ color: "var(--success)", marginTop: 2 }}>
                    <Check size={18} />
                  </Box>
                  <Stack gap={4}>
                    <Text size="xs" fw={500} c="var(--on-surface)">
                      {text("安装内容", "Installed Content")}
                    </Text>
                    <Stack gap={2}>
                      <Group gap="xs">
                        <FileCode size={12} style={{ color: "var(--text-muted)" }} />
                        <Text size="xs" c="var(--on-surface-variant)" ff="var(--font-ui-mono)">
                          {text("hooks.json 注册 __hook 命令", "hooks.json registers the __hook command")}
                        </Text>
                      </Group>
                      <Group gap="xs">
                        <FileCode size={12} style={{ color: "var(--text-muted)" }} />
                        <Text size="xs" c="var(--on-surface-variant)">
                          {text("指向本程序，跨平台无需脚本", "Points to this app directly; no cross-platform script is needed")}
                        </Text>
                      </Group>
                      <Group gap="xs">
                        <FileCode size={12} style={{ color: "var(--text-muted)" }} />
                        <Text size="xs" c="var(--on-surface-variant)">
                          {text("config.toml 中开启 ", "Enable ")}<span className="font-mono">[features].hooks = true</span>{text("", " in config.toml")}
                        </Text>
                      </Group>
                    </Stack>
                  </Stack>
                </Group>

                <Group gap="sm" wrap="nowrap" align="flex-start">
                  <Box style={{ color: "var(--warning)", marginTop: 2 }}>
                    <AlertTriangle size={18} />
                  </Box>
                  <Stack gap={4}>
                    <Text size="xs" fw={500} c="var(--on-surface)">
                      {text("注意事项", "Notes")}
                    </Text>
                    <Stack gap={2}>
                      <Text size="xs" c="var(--on-surface-variant)">
                        {text("• 不修改项目级 ", "• Does not modify project-level ")}<span className="font-mono">.codex/hooks.json</span>
                      </Text>
                      <Text size="xs" c="var(--on-surface-variant)">
                        {text("• Codex 0.129+ 仍需在 TUI 执行 ", "• Codex 0.129+ still requires running ")}<span className="font-mono">/hooks</span>{text(" 批准脚本", " in the TUI to approve scripts")}
                      </Text>
                    </Stack>
                  </Stack>
                </Group>
              </Stack>
            </Card>
          )}

          <TextInput
            size="xs"
            label={text("Codex 配置目录（可手动粘贴，支持 WSL UNC）", "Codex config directory (manual paste supported, including WSL UNC)")}
            placeholder={text("\\wsl.localhost\\Ubuntu-22.04\\home\\用户名\\.codex", "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\.codex")}
            value={codexSelectedDir ?? ""}
            onChange={(e) => setCodexSelectedDir(e.currentTarget.value || null)}
            onBlur={(e) => void handleManualCodexDirCommit(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleManualCodexDirCommit(e.currentTarget.value);
            }}
            disabled={loading || claudeWorking || codexWorking}
          />

          <Group gap="xs">
            <Button variant="light" color="cliPrimary" size="xs" onClick={handleSelectCodexDir} disabled={loading || claudeWorking || codexWorking}>
              {text("选择 Codex 目录", "Choose Codex Directory")}
            </Button>
            <Button color="cliPrimary" size="xs" onClick={handleCodexInstall} disabled={loading || codexWorking || codexStatus === "directoryMissing"}>
              {codexWorking ? text("处理中...", "Processing...") : text("安装 Codex Hook", "Install Codex Hook")}
            </Button>
            <Button variant="light" color="red" size="xs" onClick={handleCodexUninstall} disabled={loading || codexWorking || codexStatus === "directoryMissing"}>
              {text("删除 Codex Hook", "Remove Codex Hook")}
            </Button>
            <Button variant="default" color="gray" size="xs" onClick={() => void refreshStatus()} disabled={loading || claudeWorking || codexWorking}>
              {loading ? text("刷新中...", "Refreshing...") : text("刷新状态", "Refresh Status")}
            </Button>
          </Group>
        </Stack>
      </section>
    </Stack>
  );
}
