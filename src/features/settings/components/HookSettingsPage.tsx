import { useActiveCodexHookProfile } from "../../terminal/api/codexHookProfile";
import { useHookStatusRequest } from "../api/useHookStatusRequest";
import { AntigravityHookSection } from "./AntigravityHookSection";
import { CliHookBridgeCard } from "./CliHookBridgeCard";
import { CodexHookScopeStatus } from "./CodexHookScopeStatus";
import { LegacyCliHookBody, type LegacyHookModuleItem } from "./LegacyCliHookBody";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  Badge, Box, Button, Card, Divider, Group, NumberInput, SegmentedControl, Stack, Switch,
  Text, TextInput,
} from "@mantine/core";
import {
  Play, CheckCircle, Folder, Activity,
  Bell, ShieldAlert, ToggleRight, XCircle, Layers, Volume2, Trash2,
} from "lucide-react";
import { SettingsGlyph } from "./SettingsIcons";
import { useSettingsStore, type HookEventType, type HookSettingsSectionKey } from "../../../shared/preferences/settingsStore";
import { getErrorMessage, getKimiHookErrorMessage, getPiHookErrorMessage } from "../api/hookErrors";
import { useI18n } from "../../../shared/i18n/index";
import { ThirdPartyNotificationSection } from "./ThirdPartyNotificationSection";
import {
  type HookTool, type HookModule, type HookSettingsStatus, pickText, isWindowsPlatform,
  type NotificationSoundStatus, getNotificationSoundFileName, getNotificationSoundErrorDescription,
} from "../lib/hookSettingsModel";
import { SettingsSwitchRow, CollapsibleHookSection } from "./HookSettingsControls";

export function HookSettingsPage() {
  const { language, t } = useI18n();
  const text = (zh: string, en: string) => pickText(language, zh, en);
  const claudeHookConfigDir = useSettingsStore((s) => s.claudeHookConfigDir);
  const codexHookConfigDir = useSettingsStore((s) => s.codexHookConfigDir);
  const kimiHookConfigDir = useSettingsStore((s) => s.kimiHookConfigDir);
  const ccSwitchDbPath = useSettingsStore((s) => s.ccSwitchDbPath);
  const piHookConfigDir = useSettingsStore((s) => s.piHookConfigDir);
  const grokHookConfigDir = useSettingsStore((s) => s.grokHookConfigDir);
  const [selectedDir, setSelectedDir] = useState<string | null>(claudeHookConfigDir);
  const [codexSelectedDir, setCodexSelectedDir] = useState<string | null>(codexHookConfigDir);
  const [kimiSelectedDir, setKimiSelectedDir] = useState<string | null>(kimiHookConfigDir);
  const [piSelectedDir, setPiSelectedDir] = useState<string | null>(piHookConfigDir);
  const [grokSelectedDir, setGrokSelectedDir] = useState<string | null>(grokHookConfigDir);
  const [loading, setLoading] = useState(false);
  const [agyRefreshNonce, setAgyRefreshNonce] = useState(0);
  const [claudeWorking, setClaudeWorking] = useState(false);
  const [codexWorking, setCodexWorking] = useState(false);
  const [kimiWorking, setKimiWorking] = useState(false);
  const [piWorking, setPiWorking] = useState(false);
  const [grokWorking, setGrokWorking] = useState(false);
  const hookPopupNotificationsEnabled = useSettingsStore((s) => s.hookPopupNotificationsEnabled);
  const hookPopupAutoCloseEnabled = useSettingsStore((s) => s.hookPopupAutoCloseEnabled);
  const hookPopupAutoCloseSeconds = useSettingsStore((s) => s.hookPopupAutoCloseSeconds);
  const hookSubagentSplitViewEnabled = useSettingsStore((s) => s.hookSubagentSplitViewEnabled);
  const claudeHookBridgeEnabled = useSettingsStore((s) => s.claudeHookBridgeEnabled);
  const codexHookBridgeEnabled = useSettingsStore((s) => s.codexHookBridgeEnabled);
  const kimiHookBridgeEnabled = useSettingsStore((s) => s.kimiHookBridgeEnabled);
  const piHookBridgeEnabled = useSettingsStore((s) => s.piHookBridgeEnabled);
  const grokHookBridgeEnabled = useSettingsStore((s) => s.grokHookBridgeEnabled);
  const antigravityHookBridgeEnabled = useSettingsStore((s) => s.antigravityHookBridgeEnabled);
  const systemNotificationsEnabled = useSettingsStore((s) => s.systemNotificationsEnabled);
  const systemNotificationSoundPath = useSettingsStore((s) => s.systemNotificationSoundPath);
  const suppressSystemNotificationsWhenFocused = useSettingsStore((s) => s.suppressSystemNotificationsWhenFocused);
  const systemNotificationEvents = useSettingsStore((s) => s.systemNotificationEvents);
  const taskbarAttentionEnabled = useSettingsStore((s) => s.taskbarAttentionEnabled);
  const taskbarAttentionMode = useSettingsStore((s) => s.taskbarAttentionMode);
  const taskbarAttentionFlashCount = useSettingsStore((s) => s.taskbarAttentionFlashCount);
  const hookSettingsSectionsExpanded = useSettingsStore((s) => s.hookSettingsSectionsExpanded);
  const claudeHookAutoRepairKnownInstalled = useSettingsStore((s) => s.claudeHookAutoRepairKnownInstalled);
  const claudeHookAutoRepairNoticeShown = useSettingsStore((s) => s.claudeHookAutoRepairNoticeShown);
  const updateSetting = useSettingsStore((s) => s.update);
  const [autoCloseSecondsDraft, setAutoCloseSecondsDraft] = useState(String(hookPopupAutoCloseSeconds));
  const [grokPathsSignal, setGrokPathsSignal] = useState(0);
  const [notificationSoundStatus, setNotificationSoundStatus] = useState<NotificationSoundStatus>(
    systemNotificationSoundPath ? "checking" : "idle",
  );
  const [notificationSoundBusy, setNotificationSoundBusy] = useState<"select" | "preview" | "clear" | null>(null);

  const toggleHookSection = (key: HookSettingsSectionKey) => {
    const current = useSettingsStore.getState().hookSettingsSectionsExpanded;
    void updateSetting("hookSettingsSectionsExpanded", {
      ...current,
      [key]: !current[key],
    });
  };

  useEffect(() => {
    setAutoCloseSecondsDraft(String(hookPopupAutoCloseSeconds));
  }, [hookPopupAutoCloseSeconds]);

  useEffect(() => {
    setSelectedDir(claudeHookConfigDir);
  }, [claudeHookConfigDir]);

  useEffect(() => {
    setCodexSelectedDir(codexHookConfigDir);
  }, [codexHookConfigDir]);

  useEffect(() => {
    setKimiSelectedDir(kimiHookConfigDir);
  }, [kimiHookConfigDir]);

  useEffect(() => {
    setPiSelectedDir(piHookConfigDir);
  }, [piHookConfigDir]);

  useEffect(() => {
    setGrokSelectedDir(grokHookConfigDir);
  }, [grokHookConfigDir]);

  useEffect(() => {
    if (!isWindowsPlatform() || !systemNotificationSoundPath?.trim()) {
      setNotificationSoundStatus("idle");
      return;
    }

    let cancelled = false;
    setNotificationSoundStatus("checking");
    void invoke("validate_system_notification_sound", { path: systemNotificationSoundPath })
      .then(() => {
        if (!cancelled) setNotificationSoundStatus("valid");
      })
      .catch(() => {
        if (!cancelled) setNotificationSoundStatus("invalid");
      });

    return () => {
      cancelled = true;
    };
  }, [systemNotificationSoundPath]);

  const selectedDirArg = useMemo(() => selectedDir ?? undefined, [selectedDir]);
  const codexSelectedDirArg = useMemo(() => codexSelectedDir ?? undefined, [codexSelectedDir]);
  const kimiSelectedDirArg = useMemo(() => kimiSelectedDir ?? undefined, [kimiSelectedDir]);
  const piSelectedDirArg = useMemo(() => piSelectedDir ?? undefined, [piSelectedDir]);
  const grokSelectedDirArg = useMemo(() => grokSelectedDir ?? undefined, [grokSelectedDir]);

  const codexProfileName = useActiveCodexHookProfile();
  const { status, invokeStatus } = useHookStatusRequest({
    selectedDir: claudeHookConfigDir ?? undefined,
    codexSelectedDir: codexHookConfigDir ?? undefined,
    kimiSelectedDir: kimiHookConfigDir ?? undefined,
    piSelectedDir: piHookConfigDir ?? undefined,
    grokSelectedDir: grokHookConfigDir ?? undefined,
    codexProfileName,
    ccSwitchDbPath: ccSwitchDbPath ?? undefined,
  });

  const refreshStatus = async (
    dir = selectedDirArg,
    codexDir = codexSelectedDirArg,
    piDir = piSelectedDirArg,
    grokDir = grokSelectedDirArg,
    kimiDir = kimiSelectedDirArg,
  ) => {
    setLoading(true);
    try {
      const nextStatus = await invokeStatus("hook_settings_get_status", {
        selectedDir: dir,
        codexSelectedDir: codexDir,
        kimiSelectedDir: kimiDir,
        piSelectedDir: piDir,
        grokSelectedDir: grokDir,
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
        autoRepair: claudeHookBridgeEnabled && claudeHookAutoRepairKnownInstalled,
      });
      if (!nextStatus) return;
      // Keep resolved native directories in status only. Persisting an
      // automatic fallback here would turn it into an explicit override.
      if (nextStatus.pi.configDir) {
        setPiSelectedDir(nextStatus.pi.configDir);
        if (useSettingsStore.getState().piHookConfigDir !== nextStatus.pi.configDir) {
          await updateSetting("piHookConfigDir", nextStatus.pi.configDir);
        }
      }
      if (nextStatus.claudeAutoRepaired && !claudeHookAutoRepairNoticeShown) {
        toast.info(text("Claude Hook 已自动恢复", "Claude Hook Restored"), {
          description: text(
            "检测到 Hook 被外部工具覆盖，已重新写入全局 Hook 配置。",
            "The Hook was overwritten by another tool and has been restored to the global Hook config.",
          ),
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
    void refreshStatus(
      claudeHookConfigDir ?? undefined,
      codexHookConfigDir ?? undefined,
      piHookConfigDir ?? undefined,
      grokHookConfigDir ?? undefined,
      kimiHookConfigDir ?? undefined,
    );
  }, [invokeStatus]);

  const handleRefreshAll = () => {
    setAgyRefreshNonce((n) => n + 1);
    void refreshStatus();
  };

  const handleSelectNotificationSound = async () => {
    setNotificationSoundBusy("select");
    try {
      const selectedPath = await openDialog({
        multiple: false,
        directory: false,
        title: t("settings.hooks.systemNotifications.sound.chooseDialogTitle"),
        filters: [{ name: t("settings.hooks.systemNotifications.sound.filterName"), extensions: ["wav"] }],
      });
      if (!selectedPath || Array.isArray(selectedPath)) return;

      await invoke("validate_system_notification_sound", { path: selectedPath });
      await updateSetting("systemNotificationSoundPath", selectedPath);
      setNotificationSoundStatus("valid");
      toast.success(t("settings.hooks.systemNotifications.sound.saved"));
    } catch (error) {
      toast.error(t("settings.hooks.systemNotifications.sound.saveFailed"), {
        description: getNotificationSoundErrorDescription(error, t),
      });
    } finally {
      setNotificationSoundBusy(null);
    }
  };

  const handlePreviewNotificationSound = async () => {
    if (!systemNotificationSoundPath || notificationSoundStatus !== "valid") return;
    setNotificationSoundBusy("preview");
    try {
      await invoke("play_system_notification_sound", { path: systemNotificationSoundPath });
      toast.success(t("settings.hooks.systemNotifications.sound.previewed"));
    } catch (error) {
      setNotificationSoundStatus("invalid");
      toast.error(t("settings.hooks.systemNotifications.sound.previewFailed"), {
        description: getNotificationSoundErrorDescription(error, t),
      });
    } finally {
      setNotificationSoundBusy(null);
    }
  };

  const handleClearNotificationSound = async () => {
    setNotificationSoundBusy("clear");
    try {
      await updateSetting("systemNotificationSoundPath", null);
      setNotificationSoundStatus("idle");
      toast.success(t("settings.hooks.systemNotifications.sound.cleared"));
    } catch (error) {
      toast.error(t("settings.hooks.systemNotifications.sound.clearFailed"), {
        description: getNotificationSoundErrorDescription(error, t),
      });
    } finally {
      setNotificationSoundBusy(null);
    }
  };

  const handleSelectDir = async () => {
    try {
      const dir = await invoke<string | null>("hook_settings_select_dir", {
        title: text("选择 Claude 配置目录", "Choose Claude config directory"),
      });
      if (!dir) return;
      setSelectedDir(dir);
      await updateSetting("claudeHookConfigDir", dir);
      await refreshStatus(dir, codexSelectedDirArg, piSelectedDirArg);
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
      await refreshStatus(selectedDirArg, dir, piSelectedDirArg);
    } catch (error) {
      toast.error(text("选择 Codex 目录失败", "Failed to choose Codex directory"), { description: getErrorMessage(error) });
    }
  };

  const handleSelectKimiDir = async () => {
    try {
      const dir = await invoke<string | null>("hook_settings_select_dir", {
        title: text("选择 Kimi Code 配置目录", "Choose Kimi Code config directory"),
      });
      if (!dir) return;
      setKimiSelectedDir(dir);
      await updateSetting("kimiHookConfigDir", dir);
      await refreshStatus(selectedDirArg, codexSelectedDirArg, piSelectedDirArg, grokSelectedDirArg, dir);
    } catch (error) {
      toast.error(text("选择 Kimi Code 目录失败", "Failed to choose Kimi Code directory"), {
        description: getErrorMessage(error),
      });
    }
  };

  // 手动粘贴配置目录（支持 WSL UNC，如 \\wsl.localhost\Ubuntu-22.04\home\<用户名>\.claude）。
  // 原生选目录弹窗进 WSL 路径体验差，故提供文本输入兜底。
  const handleManualClaudeDirCommit = async (raw: string) => {
    const dir = raw.trim() || null;
    setSelectedDir(dir);
    await updateSetting("claudeHookConfigDir", dir);
    await refreshStatus(dir ?? undefined, codexSelectedDirArg, piSelectedDirArg);
  };

  const handleManualCodexDirCommit = async (raw: string) => {
    const dir = raw.trim() || null;
    setCodexSelectedDir(dir);
    await updateSetting("codexHookConfigDir", dir);
    await refreshStatus(selectedDirArg, dir ?? undefined, piSelectedDirArg);
  };

  const handleManualKimiDirCommit = async (raw: string) => {
    const dir = raw.trim() || null;
    setKimiSelectedDir(dir);
    await updateSetting("kimiHookConfigDir", dir);
    await refreshStatus(selectedDirArg, codexSelectedDirArg, piSelectedDirArg, grokSelectedDirArg, dir ?? undefined);
  };

  const handleManualPiDirCommit = async (raw: string) => {
    const dir = raw.trim() || null;
    setPiSelectedDir(dir);
    await updateSetting("piHookConfigDir", dir);
    await refreshStatus(selectedDirArg, codexSelectedDirArg, dir ?? undefined);
  };

  const handleSelectPiDir = async () => {
    try {
      const dir = await invoke<string | null>("hook_settings_select_dir", {
        title: text("选择 Pi 配置目录", "Choose Pi config directory"),
      });
      if (!dir) return;
      setPiSelectedDir(dir);
      await updateSetting("piHookConfigDir", dir);
      await refreshStatus(selectedDirArg, codexSelectedDirArg, dir);
    } catch (error) {
      toast.error(text("选择 Pi 目录失败", "Failed to choose Pi directory"), { description: getErrorMessage(error) });
    }
  };

  const handleSelectGrokDir = async () => {
    try {
      const dir = await invoke<string | null>("hook_settings_select_dir", {
        title: text("选择 Grok 配置目录", "Choose Grok config directory"),
      });
      if (!dir) return;
      setGrokSelectedDir(dir);
      await updateSetting("grokHookConfigDir", dir);
      await refreshStatus(selectedDirArg, codexSelectedDirArg, piSelectedDirArg, dir);
    } catch (error) {
      toast.error(text("选择 Grok 目录失败", "Failed to choose Grok directory"), { description: getErrorMessage(error) });
    }
  };

  const handleManualGrokDirCommit = async (value: string) => {
    const next = value.trim() || null;
    setGrokSelectedDir(next);
    await updateSetting("grokHookConfigDir", next);
    await refreshStatus(selectedDirArg, codexSelectedDirArg, piSelectedDirArg, next ?? undefined);
  };

  const dirPayload = {
    selectedDir: selectedDirArg,
    codexSelectedDir: codexSelectedDirArg,
    kimiSelectedDir: kimiSelectedDirArg,
    piSelectedDir: piSelectedDirArg,
    grokSelectedDir: grokSelectedDirArg,
  };

  const handleClaudeInstall = async () => {
    setClaudeWorking(true);
    try {
      const nextStatus = await invokeStatus("hook_settings_install", {
        ...dirPayload,
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
      });
      if (!nextStatus) return;
      await updateSetting("claudeHookAutoRepairKnownInstalled", true);
      await updateSetting("claudeHookAutoRepairNoticeShown", false);
      toast.success(text("Claude Hook 已安装", "Claude Hook installed"));
    } catch (error) {
      toast.error(text("安装 Claude Hook 失败", "Failed to install Claude Hook"), { description: getErrorMessage(error) });
    } finally {
      setClaudeWorking(false);
    }
  };

  const handleClaudeUninstall = async () => {
    setClaudeWorking(true);
    try {
      const nextStatus = await invokeStatus("hook_settings_uninstall", {
        ...dirPayload,
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
      });
      if (!nextStatus) return;
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
      const nextStatus = await invokeStatus("hook_settings_install_codex", {
        ...dirPayload,
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
      });
      if (!nextStatus) return;
      toast.success(text("Codex Hook 已安装", "Codex Hook installed"));
    } catch (error) {
      toast.error(text("安装 Codex Hook 失败", "Failed to install Codex Hook"), { description: getErrorMessage(error) });
    } finally {
      setCodexWorking(false);
    }
  };

  const handleCodexUninstall = async () => {
    setCodexWorking(true);
    try {
      const nextStatus = await invokeStatus("hook_settings_uninstall_codex", {
        ...dirPayload,
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
      });
      if (!nextStatus) return;
      toast.success(text("Codex Hook 已删除", "Codex Hook removed"));
    } catch (error) {
      toast.error(text("删除 Codex Hook 失败", "Failed to remove Codex Hook"), { description: getErrorMessage(error) });
    } finally {
      setCodexWorking(false);
    }
  };

  const handleKimiInstall = async () => {
    setKimiWorking(true);
    try {
      const nextStatus = await invokeStatus("hook_settings_install_kimi", {
        ...dirPayload,
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
      });
      if (!nextStatus) return;
      toast.success(text("Kimi Code Hook 已安装", "Kimi Code Hook installed"), {
        description: text(
          "新会话会自动生效；活动中的 Kimi TUI 请执行 /reload。",
          "New sessions pick it up automatically; run /reload in active Kimi TUI sessions.",
        ),
      });
    } catch (error) {
      toast.error(text("安装 Kimi Code Hook 失败", "Failed to install Kimi Code Hook"), {
        description: getKimiHookErrorMessage(error, t),
      });
    } finally {
      setKimiWorking(false);
    }
  };

  const handleKimiUninstall = async () => {
    setKimiWorking(true);
    try {
      const nextStatus = await invokeStatus("hook_settings_uninstall_kimi", {
        ...dirPayload,
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
      });
      if (!nextStatus) return;
      toast.success(text("Kimi Code Hook 已删除", "Kimi Code Hook removed"));
    } catch (error) {
      toast.error(text("删除 Kimi Code Hook 失败", "Failed to remove Kimi Code Hook"), {
        description: getKimiHookErrorMessage(error, t),
      });
    } finally {
      setKimiWorking(false);
    }
  };

  const handlePiInstall = async () => {
    setPiWorking(true);
    try {
      const nextStatus = await invokeStatus("hook_settings_install_pi", dirPayload);
      if (!nextStatus) return;
      if (nextStatus.pi.configDir) setPiSelectedDir(nextStatus.pi.configDir);
      toast.success(text("Pi Hook 已安装", "Pi Hook installed"));
    } catch (error) {
      toast.error(text("安装 Pi Hook 失败", "Failed to install Pi Hook"), {
        description: getPiHookErrorMessage(error, t),
      });
    } finally {
      setPiWorking(false);
    }
  };

  const handlePiUninstall = async () => {
    setPiWorking(true);
    try {
      const nextStatus = await invokeStatus("hook_settings_uninstall_pi", dirPayload);
      if (!nextStatus) return;
      if (nextStatus.pi.configDir) setPiSelectedDir(nextStatus.pi.configDir);
      toast.success(text("Pi Hook 已删除", "Pi Hook removed"));
    } catch (error) {
      toast.error(text("删除 Pi Hook 失败", "Failed to remove Pi Hook"), { description: getErrorMessage(error) });
    } finally {
      setPiWorking(false);
    }
  };

  const handleGrokInstall = async () => {
    setGrokWorking(true);
    try {
      const nextStatus = await invokeStatus("hook_settings_install_grok", dirPayload);
      if (!nextStatus) return;
      const hooksFile = nextStatus.grok.configPath?.trim();
      const configFile = nextStatus.grok.featureConfigPath?.trim();
      toast.success(text("Grok Hook 已安装", "Grok Hook installed"), {
        description: [
          hooksFile
            ? text(`Hook 文件：${hooksFile}`, `Hook file: ${hooksFile}`)
            : text("Hook 文件：~/.grok/hooks/cli-manager.json", "Hook file: ~/.grok/hooks/cli-manager.json"),
          configFile
            ? text(
                `兼容隔离：${configFile}（compat.claude/cursor.hooks=false）`,
                `Isolation: ${configFile} (compat.claude/cursor.hooks=false)`,
              )
            : text("兼容隔离：~/.grok/config.toml", "Isolation: ~/.grok/config.toml"),
          text(
            "注意：Grok 不使用 settings.json，请查看 hooks 目录而非 Claude 配置。",
            "Note: Grok does not use settings.json; check the hooks directory, not Claude config.",
          ),
        ].join("\n"),
        duration: 12_000,
      });
      setGrokPathsSignal((n) => n + 1);
    } catch (error) {
      toast.error(text("安装 Grok Hook 失败", "Failed to install Grok Hook"), { description: getErrorMessage(error) });
    } finally {
      setGrokWorking(false);
    }
  };

  const handleGrokUninstall = async () => {
    setGrokWorking(true);
    try {
      const nextStatus = await invokeStatus("hook_settings_uninstall_grok", dirPayload);
      if (!nextStatus) return;
      toast.success(text("Grok Hook 已删除", "Grok Hook removed"));
    } catch (error) {
      toast.error(text("删除 Grok Hook 失败", "Failed to remove Grok Hook"), { description: getErrorMessage(error) });
    } finally {
      setGrokWorking(false);
    }
  };

  const syncStatusAfterMutation = (nextStatus: HookSettingsStatus) => {
    if (nextStatus.pi.configDir) setPiSelectedDir(nextStatus.pi.configDir);
  };

  const handleModuleToggle = async (
    tool: HookTool,
    module: HookModule,
    installed: boolean,
    moduleLabel: string,
  ) => {
    const command =
      tool === "claude"
        ? installed ? "hook_settings_uninstall" : "hook_settings_install"
        : tool === "codex"
          ? installed ? "hook_settings_uninstall_codex" : "hook_settings_install_codex"
          : tool === "kimi"
            ? installed ? "hook_settings_uninstall_kimi" : "hook_settings_install_kimi"
            : tool === "pi"
              ? installed ? "hook_settings_uninstall_pi" : "hook_settings_install_pi"
              : installed ? "hook_settings_uninstall_grok" : "hook_settings_install_grok";
    const setWorking =
      tool === "claude"
        ? setClaudeWorking
        : tool === "codex"
          ? setCodexWorking
          : tool === "kimi"
            ? setKimiWorking
            : tool === "pi"
              ? setPiWorking
              : setGrokWorking;
    const toolLabel =
      tool === "claude" ? "Claude" : tool === "codex" ? "Codex" : tool === "kimi" ? "Kimi Code" : tool === "pi" ? "Pi" : "Grok";

    setWorking(true);
    try {
      const nextStatus = await invokeStatus(command, {
        ...dirPayload,
        ccSwitchDbPath: ccSwitchDbPath ?? undefined,
        module,
      });
      if (!nextStatus) return;
      syncStatusAfterMutation(nextStatus);
      if (tool === "claude") {
        await updateSetting("claudeHookAutoRepairKnownInstalled", false);
        await updateSetting("claudeHookAutoRepairNoticeShown", false);
      }
      toast.success(
        t(installed ? "settings.hooks.module.removed" : "settings.hooks.module.installed", {
          tool: toolLabel,
          module: moduleLabel,
        }),
      );
    } catch (error) {
      toast.error(
        t(installed ? "settings.hooks.module.removeFailed" : "settings.hooks.module.installFailed", {
          tool: toolLabel,
          module: moduleLabel,
        }),
        {
          description:
            tool === "pi"
              ? getPiHookErrorMessage(error, t)
              : tool === "kimi"
                ? getKimiHookErrorMessage(error, t)
                : getErrorMessage(error),
        },
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
  const kimi = status?.kimi;
  const pi = status?.pi;
  const grok = status?.grok;
  const claudeStatus = claude?.status ?? "directoryMissing";
  const codexStatus = codex?.status ?? "directoryMissing";
  const kimiStatus = kimi?.status ?? "directoryMissing";
  const piStatus = pi?.status ?? "directoryMissing";
  const grokStatus = grok?.status ?? "directoryMissing";
  const anyWorking = loading || claudeWorking || codexWorking || kimiWorking || piWorking || grokWorking;
  const grokIsolationInstalled = Boolean(grok?.hooksFeatureInstalled);

  const toggleNotifyEvents = (events: HookEventType[], enabled: boolean) => {
    const update = { ...systemNotificationEvents };
    for (const event of events) {
      update[event] = enabled;
    }
    void updateSetting("systemNotificationEvents", update);
  };
  const notifyState = (events: HookEventType[]) => events.every((e) => systemNotificationEvents[e]);
  const hookEventNotificationsEnabled = systemNotificationsEnabled || taskbarAttentionEnabled;

  const buildModule = (
    tool: HookTool,
    toolLabel: string,
    module: HookModule,
    icon: ReactNode,
    label: string,
    checked: boolean,
    disabled: boolean,
    notifyEvents?: HookEventType[],
  ): LegacyHookModuleItem => ({
    key: `${tool}-${module}`,
    icon,
    label,
    checked,
    disabled,
    onClick: () => void handleModuleToggle(tool, module, checked, label),
    actionLabel: t(checked ? "settings.hooks.card.clickToUninstall" : "settings.hooks.card.clickToInstall", {
      tool: toolLabel,
      module: label,
    }),
    ...(notifyEvents
      ? {
          notifyEnabled: notifyState(notifyEvents),
          onToggleNotify: () => toggleNotifyEvents(notifyEvents, !notifyState(notifyEvents)),
          notifyDisabled: !hookEventNotificationsEnabled,
        }
      : {}),
  });

  const claudeModuleDisabled = anyWorking || claudeStatus === "directoryMissing";
  const codexModuleDisabled = anyWorking || codexStatus === "directoryMissing";
  const kimiModuleDisabled = anyWorking || kimiStatus === "directoryMissing" || kimiStatus === "unsupported";
  const piModuleDisabled = anyWorking || piStatus === "directoryMissing";
  const grokModuleDisabled = anyWorking || grokStatus === "directoryMissing";

  const claudeModules: LegacyHookModuleItem[] = [
    buildModule("claude", "Claude", "sessionStart", <Play size={20} />, text("会话启动", "Session Start"), Boolean(claude?.attentionScriptInstalled && claude.sessionStartHookInstalled), claudeModuleDisabled, ["SessionStart"]),
    buildModule("claude", "Claude", "running", <Activity size={20} />, text("运行中", "Running"), Boolean(claude?.attentionScriptInstalled && claude.runningHookInstalled), claudeModuleDisabled, ["UserPromptSubmit"]),
    buildModule("claude", "Claude", "attention", <Bell size={20} />, text("待审批", "Awaiting Approval"), Boolean(claude?.attentionScriptInstalled && claude.attentionHookInstalled), claudeModuleDisabled, ["Notification"]),
    buildModule("claude", "Claude", "stop", <CheckCircle size={20} />, text("任务完成", "Task Completed"), Boolean(claude?.finishedScriptInstalled && claude.stopHookInstalled), claudeModuleDisabled, ["Stop"]),
    buildModule("claude", "Claude", "failure", <XCircle size={20} />, text("执行失败", "Failed"), Boolean(claude?.finishedScriptInstalled && claude.failureHookInstalled), claudeModuleDisabled, ["StopFailure"]),
    buildModule("claude", "Claude", "subagent", <Layers size={20} />, text("子 Agent", "Subagent"), Boolean(claude?.subagentStartHookInstalled), claudeModuleDisabled),
  ];

  const codexModules: LegacyHookModuleItem[] = [
    buildModule("codex", "Codex", "sessionStart", <Play size={20} />, text("会话启动", "Session Start"), Boolean(codex?.attentionScriptInstalled && codex.sessionStartHookInstalled), codexModuleDisabled, ["SessionStart"]),
    buildModule("codex", "Codex", "running", <Activity size={20} />, text("运行中", "Running"), Boolean(codex?.attentionScriptInstalled && codex.runningHookInstalled), codexModuleDisabled, ["UserPromptSubmit"]),
    buildModule("codex", "Codex", "attention", <ShieldAlert size={20} />, text("需要审批", "Approval Needed"), Boolean(codex?.attentionScriptInstalled && codex.attentionHookInstalled), codexModuleDisabled, ["PermissionRequest"]),
    buildModule("codex", "Codex", "stop", <CheckCircle size={20} />, text("完成", "Completed"), Boolean(codex?.finishedScriptInstalled && codex.stopHookInstalled), codexModuleDisabled, ["Stop"]),
    buildModule("codex", "Codex", "subagent", <Layers size={20} />, text("子 Agent", "Subagent"), Boolean(codex?.subagentStartHookInstalled), codexModuleDisabled),
    buildModule("codex", "Codex", "hooksFeature", <ToggleRight size={20} />, text("Hooks 功能", "Hooks Feature"), Boolean(codex?.hooksFeatureInstalled), codexModuleDisabled),
  ];

  const kimiModules: LegacyHookModuleItem[] = [
    buildModule("kimi", "Kimi Code", "sessionStart", <Play size={20} />, text("会话启动", "Session Start"), Boolean(kimi?.sessionStartHookInstalled), kimiModuleDisabled, ["SessionStart"]),
    buildModule("kimi", "Kimi Code", "running", <Activity size={20} />, text("运行中", "Running"), Boolean(kimi?.runningHookInstalled), kimiModuleDisabled, ["UserPromptSubmit"]),
    buildModule("kimi", "Kimi Code", "attention", <ShieldAlert size={20} />, text("审批生命周期", "Approval Lifecycle"), Boolean(kimi?.attentionHookInstalled), kimiModuleDisabled, ["PermissionRequest"]),
    buildModule("kimi", "Kimi Code", "stop", <CheckCircle size={20} />, text("完成 / 中断", "Completed / Interrupted"), Boolean(kimi?.stopHookInstalled), kimiModuleDisabled, ["Stop"]),
    buildModule("kimi", "Kimi Code", "failure", <XCircle size={20} />, text("执行失败", "Failed"), Boolean(kimi?.failureHookInstalled), kimiModuleDisabled, ["StopFailure"]),
    buildModule("kimi", "Kimi Code", "subagent", <Layers size={20} />, text("子 Agent", "Subagent"), Boolean(kimi?.subagentStartHookInstalled), kimiModuleDisabled),
  ];

  const piModules: LegacyHookModuleItem[] = [
    buildModule("pi", "Pi", "sessionStart", <Play size={20} />, text("会话启动", "Session Start"), Boolean(pi?.attentionScriptInstalled && pi.sessionStartHookInstalled), piModuleDisabled, ["SessionStart"]),
    buildModule("pi", "Pi", "running", <Activity size={20} />, text("运行中", "Running"), Boolean(pi?.attentionScriptInstalled && pi.runningHookInstalled), piModuleDisabled, ["UserPromptSubmit"]),
    buildModule("pi", "Pi", "stop", <CheckCircle size={20} />, text("任务完成", "Task Completed"), Boolean(pi?.finishedScriptInstalled && pi.stopHookInstalled), piModuleDisabled, ["Stop"]),
  ];

  const grokModules: LegacyHookModuleItem[] = [
    buildModule("grok", "Grok", "sessionStart", <Play size={20} />, text("会话启动", "Session Start"), Boolean(grok?.attentionScriptInstalled && grok.sessionStartHookInstalled), grokModuleDisabled, ["SessionStart"]),
    buildModule("grok", "Grok", "running", <Activity size={20} />, text("运行中", "Running"), Boolean(grok?.attentionScriptInstalled && grok.runningHookInstalled), grokModuleDisabled, ["UserPromptSubmit"]),
    buildModule("grok", "Grok", "attention", <Bell size={20} />, text("待审批", "Awaiting Approval"), Boolean(grok?.attentionScriptInstalled && grok.attentionHookInstalled), grokModuleDisabled, ["Notification"]),
    buildModule("grok", "Grok", "stop", <CheckCircle size={20} />, text("任务完成", "Task Completed"), Boolean(grok?.finishedScriptInstalled && grok.stopHookInstalled), grokModuleDisabled, ["Stop"]),
    buildModule("grok", "Grok", "failure", <XCircle size={20} />, text("执行失败", "Failed"), Boolean(grok?.finishedScriptInstalled && grok.failureHookInstalled), grokModuleDisabled, ["StopFailure"]),
    buildModule("grok", "Grok", "subagent", <Layers size={20} />, text("子 Agent", "Subagent"), Boolean(grok?.subagentStartHookInstalled), grokModuleDisabled),
  ];

  const enabledBridgeCount = [
    claudeHookBridgeEnabled,
    codexHookBridgeEnabled,
    kimiHookBridgeEnabled,
    piHookBridgeEnabled,
    grokHookBridgeEnabled,
    antigravityHookBridgeEnabled,
  ].filter(Boolean).length;

  return (
    <Stack gap="lg">
      <CollapsibleHookSection
        title={text("Hook 通知弹框", "Hook Toast Notifications")}
        description={t("settings.hooks.toastSection.description")}
        open={hookSettingsSectionsExpanded.toast}
        onToggle={() => toggleHookSection("toast")}
      >
        <Stack gap="md">
          <SettingsSwitchRow
            title={text("通知弹框", "Toast Notifications")}
            description={text(
              "关闭后不再弹出 Hook 通知卡片，只更新标签栏小圆点颜色。",
              "When disabled, Hook notification cards stop popping up; only tab dot color updates.",
            )}
            checked={hookPopupNotificationsEnabled}
            onCheckedChange={(checked) => void updateSetting("hookPopupNotificationsEnabled", checked)}
          />
          <SettingsSwitchRow
            title={text("自动关闭", "Auto-close")}
            description={text(
              "开启后 Hook 通知和子任务转录窗格会在指定时间后自动关闭。",
              "When enabled, Hook notifications and sub-agent transcript panes close after the configured delay.",
            )}
            checked={hookPopupAutoCloseEnabled}
            onCheckedChange={(checked) => void updateSetting("hookPopupAutoCloseEnabled", checked)}
          />
          <SettingsSwitchRow
            title={t("settings.hooks.subagentSplit.title")}
            description={t("settings.hooks.subagentSplit.description")}
            checked={hookSubagentSplitViewEnabled}
            onCheckedChange={(checked) => void updateSetting("hookSubagentSplitViewEnabled", checked)}
          />
          <Card className="border border-border bg-surface-container-low" p="sm" radius="lg">
            <Group justify="space-between" align="center" gap="md">
              <Box>
                <Text size="sm" fw={500} c="var(--on-surface)">
                  {text("默认关闭时间", "Default Close Delay")}
                </Text>
                <Text mt={4} size="xs" c="var(--text-muted)">
                  {text(
                    "单位：秒，默认 60 秒；同时用于 Hook 通知和子任务转录窗格。",
                    "Seconds. Default is 60. Applies to Hook notifications and sub-agent transcript panes.",
                  )}
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
                    if (e.key === "Enter") handleCommitAutoCloseSeconds();
                  }}
                  w={96}
                  size="xs"
                  aria-label={text(
                    "Hook 通知和子任务转录默认关闭时间",
                    "Hook notification and sub-agent transcript default close delay",
                  )}
                />
                <Text size="xs" c="var(--on-surface-variant)">
                  {text("秒", "sec")}
                </Text>
              </Group>
            </Group>
          </Card>
        </Stack>
      </CollapsibleHookSection>

      <CollapsibleHookSection
        title={text("Hook 通知", "Hook Notifications")}
        description={text("管理系统通知和第三方通知派发。", "Manage OS notifications and third-party delivery.")}
        open={hookSettingsSectionsExpanded.notifications}
        onToggle={() => toggleHookSection("notifications")}
      >
        <Stack gap="sm">
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
                  {t("settings.hooks.eventNotifications.description")}
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
          {isWindowsPlatform() && (
            <>
              <Divider />
              <Group justify="space-between" align="center" gap="md">
                <Box className="min-w-0">
                  <Text size="sm" fw={500} c="var(--on-surface)">
                    {t("settings.hooks.taskbarAttention.title")}
                  </Text>
                  <Text mt={4} size="xs" c="var(--text-muted)">
                    {t("settings.hooks.taskbarAttention.description")}
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  className="shrink-0"
                  checked={taskbarAttentionEnabled}
                  onChange={(event) => void updateSetting("taskbarAttentionEnabled", event.currentTarget.checked)}
                  aria-label={t("settings.hooks.taskbarAttention.title")}
                />
              </Group>
              <Group justify="space-between" align="center" gap="md">
                <Text size="sm" c="var(--on-surface)">
                  {t("settings.hooks.taskbarAttention.mode")}
                </Text>
                <SegmentedControl
                  size="xs"
                  disabled={!taskbarAttentionEnabled}
                  value={taskbarAttentionMode}
                  data={[
                    { value: "finite", label: t("settings.hooks.taskbarAttention.mode.finite") },
                    { value: "untilFocused", label: t("settings.hooks.taskbarAttention.mode.untilFocused") },
                  ]}
                  onChange={(value) => {
                    if (value === "finite" || value === "untilFocused") {
                      void updateSetting("taskbarAttentionMode", value);
                    }
                  }}
                />
              </Group>
              {taskbarAttentionMode === "finite" && (
                <Group justify="space-between" align="center" gap="md">
                  <Box className="min-w-0">
                    <Text size="sm" c="var(--on-surface)">
                      {t("settings.hooks.taskbarAttention.flashCount")}
                    </Text>
                    <Text mt={4} size="xs" c="var(--text-muted)">
                      {t("settings.hooks.taskbarAttention.flashCount.description")}
                    </Text>
                  </Box>
                  <NumberInput
                    w={96}
                    size="xs"
                    min={1}
                    max={20}
                    step={1}
                    allowDecimal={false}
                    clampBehavior="strict"
                    disabled={!taskbarAttentionEnabled}
                    value={taskbarAttentionFlashCount}
                    onChange={(value) => {
                      if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 20) {
                        void updateSetting("taskbarAttentionFlashCount", value);
                      }
                    }}
                    aria-label={t("settings.hooks.taskbarAttention.flashCount")}
                  />
                </Group>
              )}
              <Card className="border border-border bg-surface-container-low" p="sm" radius="lg">
                <Stack gap="xs">
                  <Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
                    <Box className="min-w-0 flex-1">
                      <Group gap="xs" wrap="nowrap">
                        <SettingsGlyph name="volume" classic={Volume2} size={16} style={{ color: "var(--primary)" }} />
                        <Text size="sm" fw={500} c="var(--on-surface)">
                          {t("settings.hooks.systemNotifications.sound.title")}
                        </Text>
                      </Group>
                      <Text mt={4} size="xs" c="var(--text-muted)">
                        {t("settings.hooks.systemNotifications.sound.description")}
                      </Text>
                    </Box>
                    <Group gap="xs" wrap="wrap">
                      <Text component="span" size="xs" c="var(--text-muted)" className="whitespace-nowrap">
                        {t("settings.hooks.systemNotifications.sound.onlyWav")}
                      </Text>
                      <Button
                        size="xs"
                        variant="default"
                        loading={notificationSoundBusy === "select"}
                        disabled={notificationSoundBusy !== null}
                        onClick={() => void handleSelectNotificationSound()}
                        leftSection={<Folder size={14} />}
                      >
                        {t("settings.hooks.systemNotifications.sound.choose")}
                      </Button>
                      {systemNotificationSoundPath && (
                        <Button
                          size="xs"
                          variant="subtle"
                          color="red"
                          loading={notificationSoundBusy === "clear"}
                          disabled={notificationSoundBusy !== null}
                          onClick={() => void handleClearNotificationSound()}
                          leftSection={<Trash2 size={14} />}
                        >
                          {t("settings.hooks.systemNotifications.sound.clear")}
                        </Button>
                      )}
                    </Group>
                  </Group>
                  <Group justify="space-between" align="center" gap="sm" wrap="wrap">
                    <Text
                      component="code"
                      size="xs"
                      c={systemNotificationSoundPath ? "var(--on-surface)" : "var(--text-muted)"}
                      className="min-w-0 break-all"
                      title={systemNotificationSoundPath ?? undefined}
                    >
                      {systemNotificationSoundPath
                        ? getNotificationSoundFileName(systemNotificationSoundPath)
                        : t("settings.hooks.systemNotifications.sound.notSet")}
                    </Text>
                    <Button
                      size="xs"
                      variant="light"
                      color="cliPrimary"
                      leftSection={<Play size={14} />}
                      loading={notificationSoundBusy === "preview"}
                      disabled={notificationSoundBusy !== null || notificationSoundStatus !== "valid"}
                      onClick={() => void handlePreviewNotificationSound()}
                    >
                      {t("settings.hooks.systemNotifications.sound.preview")}
                    </Button>
                  </Group>
                  <Text size="xs" c={notificationSoundStatus === "invalid" ? "red" : "var(--text-muted)"}>
                    {!systemNotificationSoundPath
                      ? t("settings.hooks.systemNotifications.sound.notSetDescription")
                      : notificationSoundStatus === "checking"
                        ? t("settings.hooks.systemNotifications.sound.checking")
                        : notificationSoundStatus === "invalid"
                          ? t("settings.hooks.systemNotifications.sound.unavailable")
                          : t("settings.hooks.systemNotifications.sound.active")}
                  </Text>
                </Stack>
              </Card>
            </>
          )}
          <Group justify="space-between" align="center" gap="md">
            <Box className="min-w-0">
              <Text size="sm" fw={500} c="var(--on-surface)">
                {t("settings.hooks.systemNotifications.focusSuppress.title")}
              </Text>
              <Text mt={4} size="xs" c="var(--text-muted)">
                {t("settings.hooks.systemNotifications.focusSuppress.description")}
              </Text>
            </Box>
            <Switch
              color="cliPrimary"
              className="shrink-0"
              checked={suppressSystemNotificationsWhenFocused}
              onChange={(event) => void updateSetting("suppressSystemNotificationsWhenFocused", event.currentTarget.checked)}
              aria-label={t("settings.hooks.systemNotifications.focusSuppress.title")}
            />
          </Group>
          <Divider />
          <ThirdPartyNotificationSection embedded />
        </Stack>
      </CollapsibleHookSection>

      <div className="hook-bridge-group">
        <div className="hook-bridge-group-header">
          <Group gap="xs" align="center">
            <Text size="sm" fw={600} c="var(--on-surface)">
              {t("settings.hooks.bridge.groupTitle")}
            </Text>
            <Badge variant="light" color="gray" radius="xl" size="xs">
              {t("settings.hooks.bridge.enabledCount", { enabled: enabledBridgeCount, total: 6 })}
            </Badge>
          </Group>
          <Button variant="default" color="gray" size="xs" onClick={handleRefreshAll} disabled={anyWorking}>
            {loading ? t("settings.hooks.status.refreshingAll") : t("settings.hooks.status.refreshAll")}
          </Button>
        </div>

        <div className="hook-bridge-list">
          <CliHookBridgeCard
            cliIcon="claude-code"
            title={text("Claude Code Hook 桥接", "Claude Code Hook Bridge")}
            description={text(
              "Claude Code 的运行中、待审批、完成和异常退出状态通过 Hook 上报。",
              "Claude Code running, approval, completion, and failure states are reported through Hook.",
            )}
            status={claudeStatus}
            enabled={claudeHookBridgeEnabled}
            onEnabledChange={(checked) => void updateSetting("claudeHookBridgeEnabled", checked)}
            switchAriaLabel={t("settings.hooks.bridge.claudeEnabled")}
            open={hookSettingsSectionsExpanded.claude}
            onToggle={() => toggleHookSection("claude")}
          >
            <LegacyCliHookBody
              tool="claude"
              modules={claudeModules}
              paths={[
                { label: text("Claude 配置目录", "Claude Config Directory"), value: claude?.configDir ?? selectedDir },
                { label: text("hooks 目录", "hooks Directory"), value: claude?.hooksDir ?? null },
                { label: "settings.json", value: claude?.configPath ?? null },
              ]}
              dirLabel={text(
                "Claude 配置目录（可手动粘贴，支持 WSL UNC）",
                "Claude config directory (manual paste supported, including WSL UNC)",
              )}
              dirPlaceholder={text(
                "\\\\wsl.localhost\\Ubuntu-22.04\\home\\用户名\\.claude",
                "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\.claude",
              )}
              dirValue={selectedDir ?? ""}
              onDirChange={(value) => setSelectedDir(value || null)}
              onDirCommit={(raw) => void handleManualClaudeDirCommit(raw)}
              onSelectDir={() => void handleSelectDir()}
              chooseDirLabel={text("选择 Claude 目录", "Choose Claude Directory")}
              onInstall={() => void handleClaudeInstall()}
              installLabel={text("安装 Claude Hook", "Install Claude Hook")}
              installDisabled={anyWorking || claudeStatus === "directoryMissing"}
              working={claudeWorking}
              onUninstall={() => void handleClaudeUninstall()}
              uninstallLabel={text("删除 Claude Hook", "Remove Claude Hook")}
              uninstallDisabled={anyWorking || claudeStatus === "directoryMissing"}
              onRefresh={() => void refreshStatus()}
              loading={loading}
              anyWorking={anyWorking}
            />
          </CliHookBridgeCard>

          <CliHookBridgeCard
            cliIcon="codex"
            title={text("Codex CLI Hook 桥接", "Codex CLI Hook Bridge")}
            description={text(
              "Codex 的运行中、待审批和完成状态通过 Hook 上报。",
              "Codex running, approval, and completion states are reported through Hook.",
            )}
            status={codexStatus}
            enabled={codexHookBridgeEnabled}
            onEnabledChange={(checked) => void updateSetting("codexHookBridgeEnabled", checked)}
            switchAriaLabel={t("settings.hooks.bridge.codexEnabled")}
            open={hookSettingsSectionsExpanded.codex}
            onToggle={() => toggleHookSection("codex")}
          >
            <LegacyCliHookBody
              tool="codex"
              topSlot={<CodexHookScopeStatus status={codex} />}
              modules={codexModules}
              paths={[
                { label: text("Codex 配置目录", "Codex Config Directory"), value: codex?.configDir ?? codexSelectedDir },
                { label: text("hooks 目录", "hooks Directory"), value: codex?.hooksDir ?? null },
                { label: "hooks.json", value: codex?.configPath ?? null },
                { label: "config.toml", value: codex?.featureConfigPath ?? null },
              ]}
              dirLabel={text(
                "Codex 配置目录（可手动粘贴，支持 WSL UNC）",
                "Codex config directory (manual paste supported, including WSL UNC)",
              )}
              dirPlaceholder={text(
                "\\\\wsl.localhost\\Ubuntu-22.04\\home\\用户名\\.codex",
                "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\.codex",
              )}
              dirValue={codexSelectedDir ?? ""}
              onDirChange={(value) => setCodexSelectedDir(value || null)}
              onDirCommit={(raw) => void handleManualCodexDirCommit(raw)}
              onSelectDir={() => void handleSelectCodexDir()}
              chooseDirLabel={text("选择 Codex 目录", "Choose Codex Directory")}
              onInstall={() => void handleCodexInstall()}
              installLabel={text("安装 Codex Hook", "Install Codex Hook")}
              installDisabled={anyWorking || codexStatus === "directoryMissing"}
              working={codexWorking}
              onUninstall={() => void handleCodexUninstall()}
              uninstallLabel={text("删除 Codex Hook", "Remove Codex Hook")}
              uninstallDisabled={anyWorking || codexStatus === "directoryMissing"}
              onRefresh={() => void refreshStatus()}
              loading={loading}
              anyWorking={anyWorking}
            />
          </CliHookBridgeCard>

          <CliHookBridgeCard
            cliIcon="kimi"
            title={text("Kimi Code Hook 桥接", "Kimi Code Hook Bridge")}
            description={text(
              "通过当前 Kimi Code 的 TOML Hook 上报运行、审批、完成、中断、失败和子 Agent 状态。",
              "Reports running, approval, completion, interruption, failure, and sub-agent states through current Kimi Code TOML hooks.",
            )}
            status={kimiStatus}
            enabled={kimiHookBridgeEnabled}
            onEnabledChange={(checked) => void updateSetting("kimiHookBridgeEnabled", checked)}
            switchAriaLabel={t("settings.hooks.bridge.kimiEnabled")}
            open={hookSettingsSectionsExpanded.kimi}
            onToggle={() => toggleHookSection("kimi")}
          >
            <LegacyCliHookBody
              tool="kimi"
              modules={kimiModules}
              paths={[
                { label: text("Kimi Code 配置目录", "Kimi Code Config Directory"), value: kimi?.configDir ?? kimiSelectedDir },
                { label: "config.toml", value: kimi?.configPath ?? null },
              ]}
              dirLabel={text(
                "Kimi Code 配置目录（仅管理 Hook，可手动粘贴 WSL UNC）",
                "Kimi Code config directory (Hook management only; WSL UNC paste supported)",
              )}
              dirPlaceholder={text(
                "\\\\wsl.localhost\\Ubuntu-22.04\\home\\用户名\\.kimi-code",
                "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\.kimi-code",
              )}
              dirValue={kimiSelectedDir ?? ""}
              onDirChange={(value) => setKimiSelectedDir(value || null)}
              onDirCommit={(raw) => void handleManualKimiDirCommit(raw)}
              onSelectDir={() => void handleSelectKimiDir()}
              chooseDirLabel={text("选择 Kimi Code 目录", "Choose Kimi Code Directory")}
              onInstall={() => void handleKimiInstall()}
              installLabel={text("安装 Kimi Code Hook", "Install Kimi Code Hook")}
              installDisabled={anyWorking || kimiStatus === "directoryMissing" || kimiStatus === "unsupported"}
              working={kimiWorking}
              onUninstall={() => void handleKimiUninstall()}
              uninstallLabel={text("删除 Kimi Code Hook", "Remove Kimi Code Hook")}
              uninstallDisabled={anyWorking || kimiStatus === "directoryMissing"}
              onRefresh={() => void refreshStatus()}
              loading={loading}
              anyWorking={anyWorking}
            />
          </CliHookBridgeCard>

          <CliHookBridgeCard
            cliIcon="pi"
            title={text("Pi Agent Hook 桥接", "Pi Agent Hook Bridge")}
            description={text(
              "通过 Pi Extension 上报会话启动、运行中与完成状态，绑定 sessionId 以支持实时统计。",
              "Reports session start, running, and completion through a Pi Extension, binding sessionId for live stats.",
            )}
            status={piStatus}
            enabled={piHookBridgeEnabled}
            onEnabledChange={(checked) => void updateSetting("piHookBridgeEnabled", checked)}
            switchAriaLabel={t("settings.hooks.bridge.piEnabled")}
            open={hookSettingsSectionsExpanded.pi}
            onToggle={() => toggleHookSection("pi")}
          >
            <LegacyCliHookBody
              tool="pi"
              modules={piModules}
              paths={[
                { label: text("Pi 配置目录", "Pi Config Directory"), value: pi?.configDir ?? piSelectedDir },
                { label: text("extensions 目录", "extensions Directory"), value: pi?.hooksDir ?? null },
                { label: "cli-manager-hook.ts", value: pi?.configPath ?? null },
              ]}
              dirLabel={text(
                "Pi 配置目录（可手动粘贴，默认 ~/.pi/agent）",
                "Pi config directory (manual paste supported, default ~/.pi/agent)",
              )}
              dirPlaceholder={text("C:\\Users\\你\\.pi\\agent", "C:\\Users\\you\\.pi\\agent")}
              dirValue={piSelectedDir ?? ""}
              onDirChange={(value) => setPiSelectedDir(value || null)}
              onDirCommit={(raw) => void handleManualPiDirCommit(raw)}
              onSelectDir={() => void handleSelectPiDir()}
              chooseDirLabel={text("选择 Pi 目录", "Choose Pi Directory")}
              onInstall={() => void handlePiInstall()}
              installLabel={text("安装 Pi Hook", "Install Pi Hook")}
              installDisabled={anyWorking || piStatus === "directoryMissing"}
              working={piWorking}
              onUninstall={() => void handlePiUninstall()}
              uninstallLabel={text("删除 Pi Hook", "Remove Pi Hook")}
              uninstallDisabled={anyWorking || piStatus === "directoryMissing"}
              onRefresh={() => void refreshStatus()}
              loading={loading}
              anyWorking={anyWorking}
            />
          </CliHookBridgeCard>

          <CliHookBridgeCard
            cliIcon="grok"
            title={text("Grok Build Hook 桥接", "Grok Build Hook Bridge")}
            description={text(
              "对齐 Claude 的 Hook 模块；安装时写入 ~/.grok/hooks 并关闭 Grok 对 Claude/Cursor hooks 的兼容扫描。",
              "Aligns with Claude Hook modules; install writes ~/.grok/hooks and disables Grok scanning of Claude/Cursor hooks.",
            )}
            status={grokStatus}
            enabled={grokHookBridgeEnabled}
            onEnabledChange={(checked) => void updateSetting("grokHookBridgeEnabled", checked)}
            switchAriaLabel={t("settings.hooks.bridge.grokEnabled")}
            open={hookSettingsSectionsExpanded.grok}
            onToggle={() => toggleHookSection("grok")}
          >
            <LegacyCliHookBody
              tool="grok"
              modules={grokModules}
              grokIsolationInstalled={grokIsolationInstalled}
              openPathsSignal={grokPathsSignal}
              paths={[
                { label: text("Grok 配置目录", "Grok Config Directory"), value: grok?.configDir ?? grokSelectedDir },
                { label: text("hooks 目录", "hooks Directory"), value: grok?.hooksDir ?? null },
                { label: "cli-manager.json", value: grok?.configPath ?? null },
                { label: "config.toml", value: grok?.featureConfigPath ?? null },
              ]}
              dirLabel={text(
                "Grok 配置目录（可手动粘贴，默认 ~/.grok）",
                "Grok config directory (manual paste supported, default ~/.grok)",
              )}
              dirPlaceholder={text("C:\\Users\\你\\.grok", "C:\\Users\\you\\.grok")}
              dirValue={grokSelectedDir ?? ""}
              onDirChange={(value) => setGrokSelectedDir(value || null)}
              onDirCommit={(raw) => void handleManualGrokDirCommit(raw)}
              onSelectDir={() => void handleSelectGrokDir()}
              chooseDirLabel={text("选择 Grok 目录", "Choose Grok Directory")}
              onInstall={() => void handleGrokInstall()}
              installLabel={text("安装 Grok Hook", "Install Grok Hook")}
              installDisabled={anyWorking || grokStatus === "directoryMissing"}
              working={grokWorking}
              onUninstall={() => void handleGrokUninstall()}
              uninstallLabel={text("删除 Grok Hook", "Remove Grok Hook")}
              uninstallDisabled={anyWorking || grokStatus === "directoryMissing"}
              onRefresh={() => void refreshStatus()}
              loading={loading}
              anyWorking={anyWorking}
            />
          </CliHookBridgeCard>

          <AntigravityHookSection
            open={hookSettingsSectionsExpanded.antigravity}
            onToggle={() => toggleHookSection("antigravity")}
            refreshNonce={agyRefreshNonce}
          />
        </div>
      </div>
    </Stack>
  );
}
