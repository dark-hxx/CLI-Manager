import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { projectSupportsCapability } from "../../../lib/projectCapabilities";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Badge,
  Button,
  Card,
  Center,
  Checkbox,
  Group,
  Loader,
  Modal,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  FolderSearch,
  Play,
  QrCode,
  RefreshCw,
  RotateCw,
  Save,
  Square,
  Trash2,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";
import { useI18n, type AppLanguage, type TranslationKey } from "../../../lib/i18n";
import { useProjectStore } from "../../../stores/projectStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { ConfirmDialog } from "../../ConfirmDialog";

type AgentKind = "claude" | "codex";
type PlatformKind = "telegram" | "feishu" | "weixin" | "wecom";
type ReplyLanguage = "zh" | "en";

interface CcConnectPlatformProfile {
  platform: PlatformKind;
  enabled: boolean;
  allowFrom: string;
}

interface CcConnectProfile {
  autoStart: boolean;
  executablePath: string | null;
  projectId: string;
  projectName: string;
  projectPath: string;
  agent: AgentKind;
  platform: PlatformKind;
  allowFrom: string;
  platforms: CcConnectPlatformProfile[];
  yoloEnabled: boolean;
  proxyEnabled: boolean;
  proxyUrl: string | null;
  loggingEnabled: boolean;
  language: ReplyLanguage;
  ccSwitchDbPath: string | null;
  codexConfigDir: string | null;
}

interface CcConnectPlatformStatus {
  platform: PlatformKind;
  enabled: boolean;
  credentialsReady: boolean;
}

interface CcConnectStatus {
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  sha256: string | null;
  compatible: boolean;
  detectionError: string | null;
  configPath: string;
  dataDir: string;
  logPath: string;
  profile: CcConnectProfile | null;
  configExists: boolean;
  credentialsReady: boolean;
  platformStatuses: CcConnectPlatformStatus[];
  ready: boolean;
  blockers: string[];
  warnings: string[];
  running: boolean;
  starting: boolean;
  pid: number | null;
  startedAtMs: number | null;
  lastExitCode: number | null;
  lastExitAtMs: number | null;
}

const PLATFORM_KINDS: PlatformKind[] = ["telegram", "feishu", "weixin", "wecom"];

function withPlatformProfiles(profile: CcConnectProfile): CcConnectProfile {
  const rawPlatforms = profile.platforms ?? [];
  const configured = new Map(rawPlatforms.map((item) => [item.platform, item]));
  if (rawPlatforms.length === 0) {
    configured.set(profile.platform, {
      platform: profile.platform,
      enabled: true,
      allowFrom: profile.allowFrom,
    });
  }
  const platforms = PLATFORM_KINDS.map((platform) => configured.get(platform) ?? {
    platform,
    enabled: false,
    allowFrom: "",
  });
  return {
    ...profile,
    platforms,
    allowFrom: platforms.find((item) => item.platform === profile.platform)?.allowFrom ?? "",
  };
}

interface CcConnectExecutableStatus {
  installed: boolean;
  executablePath: string;
  version: string | null;
  sha256: string | null;
  compatible: boolean;
  detectionError: string | null;
}

interface CcConnectLogLine {
  seq: number;
  timestampMs: number;
  source: string;
  message: string;
}

interface CcConnectLogPage {
  lines: CcConnectLogLine[];
  nextSeq: number;
  logPath: string;
}

const EMPTY_PROFILE: CcConnectProfile = {
  autoStart: false,
  executablePath: null,
  projectId: "",
  projectName: "",
  projectPath: "",
  agent: "claude",
  platform: "telegram",
  allowFrom: "",
  platforms: PLATFORM_KINDS.map((platform) => ({
    platform,
    enabled: platform === "telegram",
    allowFrom: "",
  })),
  yoloEnabled: false,
  proxyEnabled: true,
  proxyUrl: null,
  loggingEnabled: false,
  language: "zh",
  ccSwitchDbPath: null,
  codexConfigDir: null,
};

const BLOCKER_KEYS: Record<string, TranslationKey> = {
  profile_missing: "settings.ccConnect.blocker.profileMissing",
  project_missing: "settings.ccConnect.blocker.projectMissing",
  project_path_missing: "settings.ccConnect.blocker.projectPathMissing",
  platform_missing: "settings.ccConnect.blocker.platformMissing",
  allowlist_invalid: "settings.ccConnect.blocker.allowlistInvalid",
  proxy_invalid: "settings.ccConnect.blocker.proxyInvalid",
  credentials_missing: "settings.ccConnect.blocker.credentialsMissing",
  credential_store_error: "settings.ccConnect.blocker.credentialStoreError",
  config_missing: "settings.ccConnect.blocker.configMissing",
  binary_missing: "settings.ccConnect.blocker.binaryMissing",
  binary_incompatible: "settings.ccConnect.blocker.binaryIncompatible",
  codex_app_server_unavailable: "settings.ccConnect.blocker.codexAppServerUnavailable",
};

const WARNING_KEYS: Record<string, TranslationKey> = {
  independent_sessions: "settings.ccConnect.warning.independentSessions",
  current_user_permissions: "settings.ccConnect.warning.currentUserPermissions",
  credential_store_unavailable: "settings.ccConnect.warning.credentialStoreUnavailable",
  yolo_enabled: "settings.ccConnect.warning.yoloEnabled",
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type WeixinAuthorizationPhase = "preparing" | "starting" | "waiting" | "completed" | "failed" | "cancelled";

interface CcConnectWeixinAuthorizationStatus {
  phase: WeixinAuthorizationPhase;
  qrDataUrl: string | null;
  error: string | null;
  allowFrom: string | null;
  profile: CcConnectProfile | null;
  startedAtMs: number | null;
}

function normalizeWindowsExtendedPath(value: string) {
  return value
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "");
}

function formatTimestamp(value: number | null, language: AppLanguage) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(language === "en-US" ? "en-GB" : "zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function CcConnectSettingsPage() {
  const { t, language } = useI18n();
  const allProjects = useProjectStore((state) => state.projects);
  const projects = useMemo(
    () => allProjects.filter((project) => projectSupportsCapability(project, "hooks")),
    [allProjects]
  );
  const projectsLoaded = useProjectStore((state) => state.loaded);
  const fetchProjects = useProjectStore((state) => state.fetchAll);
  const ccSwitchDbPath = useSettingsStore((state) => state.ccSwitchDbPath);
  const codexConfigDir = useSettingsStore((state) => state.codexHookConfigDir);
  const [status, setStatus] = useState<CcConnectStatus | null>(null);
  const [profile, setProfile] = useState<CcConnectProfile>(() => ({
    ...EMPTY_PROFILE,
    language: language === "en-US" ? "en" : "zh",
  }));
  const [telegramToken, setTelegramToken] = useState("");
  const [feishuAppId, setFeishuAppId] = useState("");
  const [feishuAppSecret, setFeishuAppSecret] = useState("");
  const [weixinToken, setWeixinToken] = useState("");
  const [wecomBotId, setWecomBotId] = useState("");
  const [wecomBotSecret, setWecomBotSecret] = useState("");
  const [logs, setLogs] = useState<CcConnectLogLine[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [executableDirty, setExecutableDirty] = useState(false);
  const [executableChecking, setExecutableChecking] = useState(false);
  const [executableInspection, setExecutableInspection] = useState<CcConnectExecutableStatus | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [yoloConfirmOpen, setYoloConfirmOpen] = useState(false);
  const [weixinAuthorizationOpen, setWeixinAuthorizationOpen] = useState(false);
  const [weixinAuthorization, setWeixinAuthorization] = useState<CcConnectWeixinAuthorizationStatus | null>(null);
  const logCursorRef = useRef(0);
  const statusRequestRef = useRef(0);
  const executableInspectionRequestRef = useRef(0);
  const executableCheckingRef = useRef(false);
  const statusInFlightRef = useRef(false);
  const logInFlightRef = useRef(false);
  const formTouchedRef = useRef(false);
  const workingRef = useRef<string | null>(null);
  const weixinAuthorizationActiveRef = useRef(false);

  const hydrateProfile = useCallback((next: CcConnectStatus) => {
    if (next.profile) setProfile(withPlatformProfiles(next.profile));
    executableInspectionRequestRef.current += 1;
    executableCheckingRef.current = false;
    setExecutableInspection(null);
    setExecutableChecking(false);
    formTouchedRef.current = false;
    setDirty(false);
    setExecutableDirty(false);
  }, []);

  const refreshStatus = useCallback(async (force = false, hydrate = false, silent = false) => {
    if (statusInFlightRef.current || workingRef.current || executableCheckingRef.current) return;
    statusInFlightRef.current = true;
    const requestId = ++statusRequestRef.current;
    try {
      const next = await invoke<CcConnectStatus>("cc_connect_get_status", { refreshDetection: force });
      if (requestId !== statusRequestRef.current) return;
      setStatus(next);
      if (hydrate && !formTouchedRef.current && !executableCheckingRef.current) {
        hydrateProfile(next);
      }
    } catch (error) {
      if (!silent && requestId === statusRequestRef.current) {
        toast.error(t("settings.ccConnect.toast.loadFailed"), { description: errorMessage(error) });
      }
    } finally {
      statusInFlightRef.current = false;
    }
  }, [hydrateProfile, t]);

  const loadLogs = useCallback(async () => {
    if (logInFlightRef.current) return;
    logInFlightRef.current = true;
    try {
      const page = await invoke<CcConnectLogPage>("cc_connect_get_logs", {
        afterSeq: logCursorRef.current,
        limit: 200,
      });
      if (page.lines.length > 0) {
        const freshLines = page.lines.filter((line) => line.seq > logCursorRef.current);
        logCursorRef.current = Math.max(logCursorRef.current, page.nextSeq);
        if (freshLines.length > 0) {
          setLogs((current) => [...current, ...freshLines].slice(-500));
        }
      }
    } catch {
      // Status actions surface operational failures; polling stays quiet.
    } finally {
      logInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!projectsLoaded) void fetchProjects();
  }, [fetchProjects, projectsLoaded]);

  useEffect(() => {
    void refreshStatus(true, true);
    const statusTimer = window.setInterval(() => void refreshStatus(false, true, true), 2_000);
    return () => {
      window.clearInterval(statusTimer);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (!profile.loggingEnabled) {
      logCursorRef.current = 0;
      setLogs([]);
      return;
    }
    void loadLogs();
    const logTimer = window.setInterval(() => void loadLogs(), 1_500);
    return () => window.clearInterval(logTimer);
  }, [loadLogs, profile.loggingEnabled]);

  useEffect(() => {
    if (profile.projectId || projects.length === 0 || status?.profile) return;
    const project = projects[0];
    setProfile((current) => ({
      ...current,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      agent: project.cli_tool.toLowerCase().includes("codex") ? "codex" : "claude",
    }));
  }, [profile.projectId, projects, status?.profile]);

  const projectOptions = useMemo(
    () => projects.map((project) => ({ value: project.id, label: project.name })),
    [projects],
  );

  const updateProfile = <K extends keyof CcConnectProfile>(key: K, value: CcConnectProfile[K]) => {
    setProfile((current) => ({ ...current, [key]: value }));
    formTouchedRef.current = true;
    setDirty(true);
  };

  const selectedPlatformProfile = profile.platforms.find(
    (item) => item.platform === profile.platform
  ) ?? {
    platform: profile.platform,
    enabled: false,
    allowFrom: "",
  };

  const selectPlatform = (platform: PlatformKind) => {
    setProfile((current) => {
      const normalized = withPlatformProfiles(current);
      const selected = normalized.platforms.find((item) => item.platform === platform);
      return {
        ...normalized,
        platform,
        allowFrom: selected?.allowFrom ?? "",
      };
    });
    formTouchedRef.current = true;
    setDirty(true);
  };

  const updateSelectedPlatform = (
    patch: Partial<Pick<CcConnectPlatformProfile, "enabled" | "allowFrom">>
  ) => {
    setProfile((current) => {
      const normalized = withPlatformProfiles(current);
      const platforms = normalized.platforms.map((item) => (
        item.platform === normalized.platform ? { ...item, ...patch } : item
      ));
      return {
        ...normalized,
        platforms,
        allowFrom: platforms.find(
          (item) => item.platform === normalized.platform
        )?.allowFrom ?? "",
      };
    });
    formTouchedRef.current = true;
    setDirty(true);
  };

  const updateExecutablePath = (value: string | null) => {
    updateProfile("executablePath", value ? normalizeWindowsExtendedPath(value) : null);
    executableInspectionRequestRef.current += 1;
    executableCheckingRef.current = false;
    setExecutableInspection(null);
    setExecutableChecking(false);
    setExecutableDirty(true);
  };

  const inspectExecutable = useCallback(async (executablePath: string | null, silent = false) => {
    const candidate = executablePath?.trim();
    if (!candidate) return;
    const requestId = ++executableInspectionRequestRef.current;
    executableCheckingRef.current = true;
    setExecutableChecking(true);
    try {
      const next = await invoke<CcConnectExecutableStatus>("cc_connect_inspect_executable", {
        executablePath: candidate,
      });
      if (requestId !== executableInspectionRequestRef.current) return;
      setExecutableInspection(next);
      setProfile((current) => ({ ...current, executablePath: next.executablePath }));
      setExecutableDirty(false);
    } catch (error) {
      if (!silent && requestId === executableInspectionRequestRef.current) {
        toast.error(t("settings.ccConnect.toast.selectExecutableFailed"), {
          description: errorMessage(error),
        });
      }
    } finally {
      if (requestId === executableInspectionRequestRef.current) {
        executableCheckingRef.current = false;
        setExecutableChecking(false);
      }
    }
  }, [t]);

  const requestYoloChange = (enabled: boolean) => {
    if (!enabled) {
      updateProfile("yoloEnabled", false);
      return;
    }
    if (!profile.yoloEnabled) setYoloConfirmOpen(true);
  };

  const selectProject = (projectId: string | null) => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) return;
    setProfile((current) => ({
      ...current,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      agent: project.cli_tool.toLowerCase().includes("codex") ? "codex" : current.agent,
    }));
    formTouchedRef.current = true;
    setDirty(true);
  };

  const setWorkingState = (value: string | null) => {
    if (value) statusRequestRef.current += 1;
    workingRef.current = value;
    setWorking(value);
  };

  const chooseExecutable = async () => {
    if (workingRef.current || status?.starting) return;
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "cc-connect", extensions: ["exe"] }],
      });
      if (typeof selected === "string") {
        updateExecutablePath(selected);
        await inspectExecutable(selected);
      }
    } catch (error) {
      toast.error(t("settings.ccConnect.toast.selectExecutableFailed"), { description: errorMessage(error) });
    }
  };

  const rescanExecutable = async () => {
    const candidate = profile.executablePath?.trim();
    if (candidate) {
      await inspectExecutable(candidate);
      return;
    }
    executableInspectionRequestRef.current += 1;
    setExecutableInspection(null);
    setExecutableDirty(false);
    await refreshStatus(true, false, false);
  };

  const saveProfile = async () => {
    if (workingRef.current || status?.starting) return;
    const currentProject = projects.find((project) => project.id === profile.projectId);
    if (!currentProject) {
      toast.error(t("settings.ccConnect.toast.saveFailed"), {
        description: t("settings.ccConnect.blocker.projectMissing"),
      });
      return;
    }
    setWorkingState("save");
    try {
      const next = await invoke<CcConnectStatus>("cc_connect_save_profile", {
        request: {
          profile: {
            ...profile,
            projectName: currentProject.name,
            projectPath: currentProject.path,
            ccSwitchDbPath,
            codexConfigDir,
          },
          telegramToken: telegramToken.trim() || null,
          feishuAppId: feishuAppId.trim() || null,
          feishuAppSecret: feishuAppSecret.trim() || null,
          weixinToken: weixinToken.trim() || null,
          wecomBotId: wecomBotId.trim() || null,
          wecomBotSecret: wecomBotSecret.trim() || null,
        },
      });
      setStatus(next);
      hydrateProfile(next);
      setTelegramToken("");
      setFeishuAppId("");
      setFeishuAppSecret("");
      setWeixinToken("");
      setWecomBotId("");
      setWecomBotSecret("");
      toast.success(t("settings.ccConnect.toast.saveSuccess"));
    } catch (error) {
      toast.error(t("settings.ccConnect.toast.saveFailed"), { description: errorMessage(error) });
    } finally {
      setWorkingState(null);
    }
  };

  const runAction = async (
    command: "cc_connect_start" | "cc_connect_stop" | "cc_connect_restart",
    action: string,
    successKey: TranslationKey,
    failureKey: TranslationKey,
  ) => {
    if (workingRef.current || status?.starting) return;
    setWorkingState(action);
    try {
      const next = await invoke<CcConnectStatus>(command);
      setStatus(next);
      toast.success(t(successKey));
      if (next.profile?.loggingEnabled) void loadLogs();
    } catch (error) {
      toast.error(t(failureKey), { description: errorMessage(error) });
    } finally {
      setWorkingState(null);
    }
  };

  const clearCredentials = async () => {
    if (workingRef.current || status?.starting) return;
    setWorkingState("clear");
    try {
      const next = await invoke<CcConnectStatus>("cc_connect_clear_credentials", { platform: profile.platform });
      setStatus(next);
      setTelegramToken("");
      setFeishuAppId("");
      setFeishuAppSecret("");
      setWeixinToken("");
      setWecomBotId("");
      setWecomBotSecret("");
      toast.success(t("settings.ccConnect.toast.clearSuccess"));
    } catch (error) {
      toast.error(t("settings.ccConnect.toast.clearFailed"), { description: errorMessage(error) });
    } finally {
      setWorkingState(null);
    }
  };

  const startWeixinAuthorization = async () => {
    if (workingRef.current || status?.starting || status?.running) return;
    const currentProject = projects.find((project) => project.id === profile.projectId);
    if (!currentProject) {
      toast.error(t("settings.ccConnect.weixinAuthStartFailed"), {
        description: t("settings.ccConnect.blocker.projectMissing"),
      });
      return;
    }
    setWorkingState("weixin-authorize");
    weixinAuthorizationActiveRef.current = true;
    setWeixinAuthorizationOpen(true);
    setWeixinAuthorization({
      phase: "preparing",
      qrDataUrl: null,
      error: null,
      allowFrom: null,
      profile: null,
      startedAtMs: null,
    });
    try {
      const next = await invoke<CcConnectWeixinAuthorizationStatus>(
        "cc_connect_weixin_authorization_start",
        {
          request: {
            profile: {
              ...profile,
              projectName: currentProject.name,
              projectPath: currentProject.path,
              ccSwitchDbPath,
              codexConfigDir,
            },
          },
        },
      );
      if (!weixinAuthorizationActiveRef.current) return;
      setWeixinAuthorization(next);
    } catch (error) {
      if (!weixinAuthorizationActiveRef.current) return;
      await invoke("cc_connect_weixin_authorization_cancel").catch(() => undefined);
      weixinAuthorizationActiveRef.current = false;
      setWorkingState(null);
      const message = errorMessage(error);
      setWeixinAuthorization((current) => ({
        phase: "failed",
        qrDataUrl: current?.qrDataUrl ?? null,
        error: message,
        allowFrom: null,
        profile: null,
        startedAtMs: current?.startedAtMs ?? null,
      }));
      toast.error(t("settings.ccConnect.weixinAuthStartFailed"), { description: message });
    }
  };

  const cancelWeixinAuthorization = async () => {
    const active = weixinAuthorization?.phase === "preparing"
      || weixinAuthorization?.phase === "starting"
      || weixinAuthorization?.phase === "waiting";
    try {
      if (active) await invoke("cc_connect_weixin_authorization_cancel");
    } catch (error) {
      toast.error(t("settings.ccConnect.weixinAuthCancelFailed"), { description: errorMessage(error) });
    } finally {
      weixinAuthorizationActiveRef.current = false;
      setWorkingState(null);
      setWeixinAuthorizationOpen(false);
      setWeixinAuthorization(null);
    }
  };

  useEffect(() => {
    const active = weixinAuthorization?.phase === "starting" || weixinAuthorization?.phase === "waiting";
    if (!weixinAuthorizationOpen || !active) return;
    let disposed = false;
    let inFlight = false;
    const poll = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const next = await invoke<CcConnectWeixinAuthorizationStatus>(
          "cc_connect_weixin_authorization_status",
        );
        if (disposed) return;
        if (next.phase === "completed") {
          weixinAuthorizationActiveRef.current = false;
          setWorkingState(null);
          if (next.profile) {
            setProfile(withPlatformProfiles(next.profile));
            formTouchedRef.current = false;
            setDirty(false);
          }
          setWeixinToken("");
          try {
            const nextStatus = await invoke<CcConnectStatus>("cc_connect_get_status", {
              refreshDetection: false,
            });
            if (disposed) return;
            setStatus(nextStatus);
            hydrateProfile(nextStatus);
          } catch {
            // The authorization result already contains the persisted profile.
          }
          if (disposed) return;
          setWeixinAuthorization(next);
          toast.success(t("settings.ccConnect.weixinAuthSuccess"));
        } else if (next.phase === "failed") {
          setWeixinAuthorization(next);
          weixinAuthorizationActiveRef.current = false;
          setWorkingState(null);
          toast.error(t("settings.ccConnect.weixinAuthFailed"), {
            description: next.error ?? undefined,
          });
        } else {
          setWeixinAuthorization(next);
        }
      } catch (error) {
        if (!disposed) {
          await invoke("cc_connect_weixin_authorization_cancel").catch(() => undefined);
          if (disposed) return;
          weixinAuthorizationActiveRef.current = false;
          setWorkingState(null);
          const message = errorMessage(error);
          setWeixinAuthorization((current) => ({
            phase: "failed",
            qrDataUrl: current?.qrDataUrl ?? null,
            error: message,
            allowFrom: null,
            profile: null,
            startedAtMs: current?.startedAtMs ?? null,
          }));
          toast.error(t("settings.ccConnect.weixinAuthFailed"), { description: message });
        }
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 800);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [hydrateProfile, t, weixinAuthorization?.phase, weixinAuthorizationOpen]);

  useEffect(() => () => {
    if (weixinAuthorizationActiveRef.current) {
      void invoke("cc_connect_weixin_authorization_cancel").catch(() => undefined);
    }
  }, []);

  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(logs.map((line) => `[${line.source}] ${line.message}`).join("\n"));
      toast.success(t("settings.ccConnect.logs.copied"));
    } catch (error) {
      toast.error(t("settings.ccConnect.toast.copyFailed"), { description: errorMessage(error) });
    }
  };

  const openLogLocation = async () => {
    if (!status) return;
    try {
      await invoke("open_folder_in_explorer", { path: status.logPath, openFile: false });
    } catch (error) {
      toast.error(t("settings.ccConnect.toast.openPathFailed"), { description: errorMessage(error) });
    }
  };

  const issueText = (code: string, map: Record<string, TranslationKey>) => {
    const key = map[code];
    return key ? t(key) : code;
  };

  const credentialInputPending = {
    telegram: telegramToken.trim().length > 0,
    feishu: feishuAppId.trim().length > 0 || feishuAppSecret.trim().length > 0,
    weixin: weixinToken.trim().length > 0,
    wecom: wecomBotId.trim().length > 0 || wecomBotSecret.trim().length > 0,
  }[profile.platform];
  const currentPlatformStatus = (status?.platformStatuses ?? []).find(
    (item) => item.platform === profile.platform
  );
  const credentialStored = !credentialInputPending
    && Boolean(currentPlatformStatus?.credentialsReady);
  const currentProject = projects.find((project) => project.id === profile.projectId);
  const normalizeProjectPath = (value: string) => value
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLocaleLowerCase("en-US");
  const projectRegistrationCurrent = Boolean(
    currentProject
      && currentProject.name === profile.projectName
      && normalizeProjectPath(currentProject.path) === normalizeProjectPath(profile.projectPath),
  );
  const displayedExecutable = executableInspection ?? (!executableDirty ? status : null);
  const displayedDetectionError = executableInspection?.detectionError
    ?? (!executableDirty ? status?.detectionError : null);
  const busy = working !== null || executableChecking || Boolean(status?.starting);
  const weixinAuthorizationActive = weixinAuthorization?.phase === "preparing"
    || weixinAuthorization?.phase === "starting"
    || weixinAuthorization?.phase === "waiting";
  const processLabel = status?.starting
    ? t("settings.ccConnect.starting")
    : status?.running
      ? t("settings.ccConnect.running")
      : t("settings.ccConnect.stopped");
  const platformOptions = [
    { value: "telegram", label: t("settings.ccConnect.platformTelegram") },
    { value: "feishu", label: t("settings.ccConnect.platformFeishu") },
    { value: "weixin", label: t("settings.ccConnect.platformWeixin") },
    { value: "wecom", label: t("settings.ccConnect.platformWecom") },
  ];
  const allowFromHelpKey = ({
    telegram: "settings.ccConnect.allowFromTelegramHelp",
    feishu: "settings.ccConnect.allowFromFeishuHelp",
    weixin: "settings.ccConnect.allowFromWeixinHelp",
    wecom: "settings.ccConnect.allowFromWecomHelp",
  } satisfies Record<PlatformKind, TranslationKey>)[profile.platform];

  return (
    <Stack gap="md" maw={1040}>
      <Card className="border border-border bg-surface-container-low" p="md" radius="lg">
        <Group justify="space-between" align="flex-start">
          <div>
            <Group gap="xs">
              <Wifi size={18} />
              <Text fw={700}>{t("settings.ccConnect.overview.title")}</Text>
            </Group>
            <Text mt={6} size="xs" c="var(--text-muted)">{t("settings.ccConnect.overview.description")}</Text>
          </div>
          <Group gap="xs">
            <Badge color={displayedExecutable?.installed ? "green" : "gray"} variant="light">
              {executableChecking
                ? t("settings.ccConnect.detecting")
                : displayedExecutable?.installed
                  ? t("settings.ccConnect.installed")
                  : t("settings.ccConnect.notInstalled")}
            </Badge>
            {executableDirty && !executableChecking ? (
              <Badge color="yellow" variant="light">{t("settings.ccConnect.executableUnverified")}</Badge>
            ) : !executableChecking && displayedExecutable?.installed && (
              <Badge color={displayedExecutable.compatible ? "green" : "red"} variant="light">
                {displayedExecutable.compatible ? t("settings.ccConnect.compatible") : t("settings.ccConnect.incompatible")}
              </Badge>
            )}
          </Group>
        </Group>
        <SimpleGrid cols={{ base: 1, md: 2 }} mt="md" spacing="sm">
          <TextInput
            label={t("settings.ccConnect.executablePath")}
            value={profile.executablePath ?? status?.executablePath ?? ""}
            onChange={(event) => {
              updateExecutablePath(event.currentTarget.value || null);
            }}
            rightSection={<FolderSearch size={16} />}
          />
          <Stack gap={6} justify="flex-end">
            <Group gap="xs">
              <Button size="xs" variant="default" disabled={busy} onClick={() => void chooseExecutable()} leftSection={<FolderSearch size={14} />}>
                {t("settings.ccConnect.chooseExecutable")}
              </Button>
              <Button size="xs" variant="subtle" disabled={busy} onClick={() => void rescanExecutable()} leftSection={<RefreshCw size={14} />}>
                {t("settings.ccConnect.rescan")}
              </Button>
            </Group>
          </Stack>
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, md: 2 }} mt="sm" spacing="sm">
          <Text size="xs" c="var(--text-muted)">{t("settings.ccConnect.version")}: {executableChecking ? "—" : displayedExecutable?.version ?? "—"}</Text>
          <Text size="xs" c="var(--text-muted)" style={{ overflowWrap: "anywhere" }}>{t("settings.ccConnect.sha256")}: {executableChecking ? "—" : displayedExecutable?.sha256 ?? "—"}</Text>
        </SimpleGrid>
        {displayedDetectionError && <Text mt="xs" size="xs" c="red">{displayedDetectionError}</Text>}
      </Card>

      <Card className="border border-border bg-surface-container-low" p="md" radius="lg">
        <Text fw={700}>{t("settings.ccConnect.profile.title")}</Text>
        <Text mt={4} size="xs" c="var(--text-muted)">{t("settings.ccConnect.profile.description")}</Text>
        <SimpleGrid cols={{ base: 1, md: 2 }} mt="md" spacing="sm">
          <Select label={t("settings.ccConnect.project")} placeholder={t("settings.ccConnect.projectPlaceholder")} nothingFoundMessage={t("settings.ccConnect.projectEmpty")} data={projectOptions} value={profile.projectId || null} onChange={selectProject} searchable />
          <Select label={t("settings.ccConnect.agent")} data={[{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }]} value={profile.agent} onChange={(value) => value && updateProfile("agent", value as AgentKind)} />
          <Select
            label={t("settings.ccConnect.platform")}
            data={platformOptions}
            value={profile.platform}
            onChange={(value) => value && selectPlatform(value as PlatformKind)}
          />
          <Select label={t("settings.ccConnect.language")} data={[{ value: "zh", label: t("settings.ccConnect.languageZh") }, { value: "en", label: t("settings.ccConnect.languageEn") }]} value={profile.language} onChange={(value) => value && updateProfile("language", value as ReplyLanguage)} />
        </SimpleGrid>
        <Switch
          mt="sm"
          checked={selectedPlatformProfile.enabled}
          onChange={(event) => updateSelectedPlatform({
            enabled: event.currentTarget.checked,
          })}
          label={t("settings.ccConnect.platformEnabled")}
          description={t("settings.ccConnect.platformEnabledDescription")}
          aria-label={t("settings.ccConnect.platformEnabled")}
        />
        <TextInput
          mt="sm"
          label={t("settings.ccConnect.allowFrom")}
          description={t(allowFromHelpKey)}
          value={selectedPlatformProfile.allowFrom}
          onChange={(event) => updateSelectedPlatform({
            allowFrom: event.currentTarget.value,
          })}
        />
        <Switch
          mt="md"
          color="red"
          checked={profile.yoloEnabled}
          onChange={(event) => requestYoloChange(event.currentTarget.checked)}
          label={t("settings.ccConnect.yoloEnabled")}
          description={t("settings.ccConnect.yoloEnabledDescription")}
          aria-label={t("settings.ccConnect.yoloEnabled")}
        />
        <Checkbox
          mt="sm"
          checked={profile.proxyEnabled}
          onChange={(event) => updateProfile("proxyEnabled", event.currentTarget.checked)}
          label={t("settings.ccConnect.proxyEnabled")}
          description={t("settings.ccConnect.proxyEnabledDescription")}
        />
        <TextInput
          mt="xs"
          label={t("settings.ccConnect.proxyUrl")}
          placeholder={t("settings.ccConnect.proxyPlaceholder")}
          description={t("settings.ccConnect.proxyDescription")}
          value={profile.proxyUrl ?? ""}
          onChange={(event) => updateProfile("proxyUrl", event.currentTarget.value || null)}
          disabled={!profile.proxyEnabled}
        />
        <Checkbox
          mt="md"
          checked={profile.loggingEnabled}
          onChange={(event) => updateProfile("loggingEnabled", event.currentTarget.checked)}
          label={t("settings.ccConnect.loggingEnabled")}
          description={t("settings.ccConnect.loggingEnabledDescription")}
        />
        <Checkbox
          mt="md"
          checked={profile.autoStart}
          onChange={(event) => updateProfile("autoStart", event.currentTarget.checked)}
          label={t("settings.ccConnect.autoStart")}
          description={t("settings.ccConnect.autoStartDescription")}
        />
      </Card>

      <Card className="border border-border bg-surface-container-low" p="md" radius="lg">
        <Group justify="space-between">
          <div>
            <Text fw={700}>{t("settings.ccConnect.credentials.title")}</Text>
            <Text mt={4} size="xs" c="var(--text-muted)">{t("settings.ccConnect.credentials.description")}</Text>
          </div>
          <Badge color={credentialStored ? "green" : "yellow"} variant="light">
            {credentialStored ? t("settings.ccConnect.credentialSaved") : t("settings.ccConnect.credentialMissing")}
          </Badge>
        </Group>
        {profile.platform === "telegram" ? (
          <PasswordInput mt="md" label={t("settings.ccConnect.telegramToken")} value={telegramToken} onChange={(event) => {
            setTelegramToken(event.currentTarget.value);
            formTouchedRef.current = true;
            setDirty(true);
          }} />
        ) : profile.platform === "feishu" ? (
          <SimpleGrid cols={{ base: 1, md: 2 }} mt="md" spacing="sm">
            <PasswordInput label={t("settings.ccConnect.feishuAppId")} value={feishuAppId} onChange={(event) => {
              setFeishuAppId(event.currentTarget.value);
              formTouchedRef.current = true;
              setDirty(true);
            }} />
            <PasswordInput label={t("settings.ccConnect.feishuAppSecret")} value={feishuAppSecret} onChange={(event) => {
              setFeishuAppSecret(event.currentTarget.value);
              formTouchedRef.current = true;
              setDirty(true);
            }} />
          </SimpleGrid>
        ) : profile.platform === "weixin" ? (
          <Stack mt="md" gap="xs">
            <PasswordInput
              label={t("settings.ccConnect.weixinToken")}
              description={t("settings.ccConnect.weixinTokenHelp")}
              value={weixinToken}
              onChange={(event) => {
                setWeixinToken(event.currentTarget.value);
                formTouchedRef.current = true;
                setDirty(true);
              }}
            />
            <Group justify="flex-start">
              <Button
                size="xs"
                variant="default"
                leftSection={<QrCode size={15} />}
                loading={working === "weixin-authorize"}
                disabled={busy || !!status?.running || !currentProject || executableDirty || !displayedExecutable?.compatible}
                onClick={() => void startWeixinAuthorization()}
              >
                {t("settings.ccConnect.weixinAuthorize")}
              </Button>
            </Group>
          </Stack>
        ) : (
          <SimpleGrid cols={{ base: 1, md: 2 }} mt="md" spacing="sm">
            <TextInput label={t("settings.ccConnect.wecomBotId")} value={wecomBotId} onChange={(event) => {
              setWecomBotId(event.currentTarget.value);
              formTouchedRef.current = true;
              setDirty(true);
            }} />
            <PasswordInput label={t("settings.ccConnect.wecomBotSecret")} value={wecomBotSecret} onChange={(event) => {
              setWecomBotSecret(event.currentTarget.value);
              formTouchedRef.current = true;
              setDirty(true);
            }} />
          </SimpleGrid>
        )}
        <Group mt="md" justify="flex-end">
          <Button size="xs" variant="light" color="red" leftSection={<Trash2 size={14} />} disabled={!!status?.running || busy} loading={working === "clear"} onClick={() => setClearConfirmOpen(true)}>
            {t("settings.ccConnect.clearCredentials")}
          </Button>
          <Button size="xs" color="cliPrimary" leftSection={<Save size={14} />} disabled={busy} loading={working === "save"} onClick={() => void saveProfile()}>
            {t("settings.ccConnect.save")}
          </Button>
        </Group>
      </Card>

      {(status?.blockers.length || status?.warnings.length) ? (
        <Card className="border border-yellow-500/30 bg-yellow-500/10" p="md" radius="lg">
          <Group gap="xs"><AlertTriangle size={17} /><Text fw={700}>{t("settings.ccConnect.blockers.title")}</Text></Group>
          <Stack gap={6} mt="sm">
            {status.blockers.map((code) => <Text key={code} size="xs">• {issueText(code, BLOCKER_KEYS)}</Text>)}
            {status.warnings.map((code) => <Text key={code} size="xs" c="var(--text-muted)">• {issueText(code, WARNING_KEYS)}</Text>)}
          </Stack>
        </Card>
      ) : null}

      <Card className="border border-border bg-surface-container-low" p="md" radius="lg">
        <Group justify="space-between">
          <Text fw={700}>{t("settings.ccConnect.process.title")}</Text>
          <Badge color={status?.running ? "green" : status?.starting ? "yellow" : "gray"}>{processLabel}</Badge>
        </Group>
        <Stack gap={6} mt="sm">
          <Text size="xs">{t("settings.ccConnect.pid")}: {status?.pid ?? "—"}</Text>
          <Text size="xs">{t("settings.ccConnect.startedAt")}: {formatTimestamp(status?.startedAtMs ?? null, language)}</Text>
          <Text size="xs">{t("settings.ccConnect.lastExit")}: {status?.lastExitCode ?? "—"}</Text>
        </Stack>
        <Group mt="md" gap="xs">
          <Button size="xs" color="cliPrimary" leftSection={<Play size={14} />} disabled={busy || !status?.ready || !!status?.running || dirty || !projectRegistrationCurrent} loading={working === "start"} onClick={() => void runAction("cc_connect_start", "start", "settings.ccConnect.toast.startSuccess", "settings.ccConnect.toast.startFailed")}>
            {t("settings.ccConnect.start")}
          </Button>
          <Button size="xs" variant="light" color="red" leftSection={<Square size={13} />} disabled={busy || !status?.running} loading={working === "stop"} onClick={() => void runAction("cc_connect_stop", "stop", "settings.ccConnect.toast.stopSuccess", "settings.ccConnect.toast.stopFailed")}>
            {t("settings.ccConnect.stop")}
          </Button>
          <Button size="xs" variant="default" leftSection={<RotateCw size={14} />} disabled={busy || !status?.running || dirty || !projectRegistrationCurrent} loading={working === "restart"} onClick={() => void runAction("cc_connect_restart", "restart", "settings.ccConnect.toast.restartSuccess", "settings.ccConnect.toast.restartFailed")}>
            {t("settings.ccConnect.restart")}
          </Button>
        </Group>
      </Card>

      {profile.loggingEnabled && <Card className="border border-border bg-surface-container-low" p="md" radius="lg">
        <Group justify="space-between">
          <Text fw={700}>{t("settings.ccConnect.logs.title")}</Text>
          <Group gap="xs">
            <Button size="xs" variant="subtle" leftSection={<Copy size={14} />} disabled={logs.length === 0} onClick={() => void copyLogs()}>{t("settings.ccConnect.logs.copy")}</Button>
            <Button size="xs" variant="subtle" leftSection={<ExternalLink size={14} />} disabled={!status} onClick={() => void openLogLocation()}>{t("settings.ccConnect.openLog")}</Button>
          </Group>
        </Group>
        <Text mt="xs" size="xs" c="var(--text-muted)" style={{ overflowWrap: "anywhere" }}>{t("settings.ccConnect.configPath")}: {status?.configPath ?? "—"}</Text>
        <Text size="xs" c="var(--text-muted)" style={{ overflowWrap: "anywhere" }}>{t("settings.ccConnect.dataDir")}: {status?.dataDir ?? "—"}</Text>
        <Text size="xs" c="var(--text-muted)" style={{ overflowWrap: "anywhere" }}>{t("settings.ccConnect.logPath")}: {status?.logPath ?? "—"}</Text>
        <pre className="mt-3 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/35 p-3 text-[11px] leading-5 text-on-surface">
          {logs.length === 0
            ? t("settings.ccConnect.logs.empty")
            : logs.map((line) => `[${formatTimestamp(line.timestampMs, language)}] [${line.source}] ${line.message}`).join("\n")}
        </pre>
      </Card>}
      <Modal
        opened={weixinAuthorizationOpen}
        onClose={() => void cancelWeixinAuthorization()}
        title={t("settings.ccConnect.weixinAuthTitle")}
        centered
        size="sm"
        zIndex={90}
        closeOnClickOutside={!weixinAuthorizationActive}
        closeOnEscape={!weixinAuthorizationActive}
        withCloseButton={!weixinAuthorizationActive}
      >
        <Stack gap="md" align="stretch">
          <Center
            w={264}
            h={264}
            mx="auto"
            style={{
              background: weixinAuthorization?.qrDataUrl ? "#ffffff" : "var(--surface-container-low)",
              border: "1px solid var(--border)",
              borderRadius: 8,
            }}
          >
            {weixinAuthorization?.qrDataUrl ? (
              <img
                src={weixinAuthorization.qrDataUrl}
                alt={t("settings.ccConnect.weixinAuthQrAlt")}
                width={240}
                height={240}
                style={{ display: "block", objectFit: "contain" }}
              />
            ) : weixinAuthorization?.phase === "completed" ? (
              <Stack gap="xs" align="center" px="md">
                <QrCode size={36} color="var(--primary)" />
                <Text fw={700} ta="center">{t("settings.ccConnect.weixinAuthSuccess")}</Text>
              </Stack>
            ) : weixinAuthorization?.phase === "failed" ? (
              <Stack gap="xs" align="center" px="md">
                <AlertTriangle size={36} color="var(--danger)" />
                <Text fw={700} ta="center">{t("settings.ccConnect.weixinAuthFailed")}</Text>
              </Stack>
            ) : (
              <Stack gap="sm" align="center" px="md">
                <Loader size="sm" />
                <Text size="sm" ta="center">{t("settings.ccConnect.weixinAuthPreparing")}</Text>
              </Stack>
            )}
          </Center>
          {weixinAuthorization?.qrDataUrl && (
            <Text size="sm" ta="center">{t("settings.ccConnect.weixinAuthScanHint")}</Text>
          )}
          {weixinAuthorization?.phase === "completed" && (
            <Text size="sm" ta="center" c="var(--text-muted)">
              {t("settings.ccConnect.weixinAuthSuccessDescription")}
            </Text>
          )}
          {weixinAuthorization?.phase === "failed" && weixinAuthorization.error && (
            <Text size="xs" c="red" style={{ overflowWrap: "anywhere" }}>
              {weixinAuthorization.error}
            </Text>
          )}
          <Group justify="flex-end">
            {weixinAuthorizationActive ? (
              <Button variant="light" color="red" onClick={() => void cancelWeixinAuthorization()}>
                {t("settings.ccConnect.weixinAuthCancel")}
              </Button>
            ) : (
              <Button variant="default" onClick={() => void cancelWeixinAuthorization()}>
                {t("common.close")}
              </Button>
            )}
          </Group>
        </Stack>
      </Modal>
      <ConfirmDialog
        open={yoloConfirmOpen}
        title={t("settings.ccConnect.yoloConfirmTitle")}
        message={t("settings.ccConnect.yoloConfirmMessage")}
        confirmText={t("settings.ccConnect.yoloConfirmAction")}
        cancelText={t("common.cancel")}
        danger
        zIndex={80}
        onClose={() => setYoloConfirmOpen(false)}
        onConfirm={() => {
          setYoloConfirmOpen(false);
          updateProfile("yoloEnabled", true);
        }}
      />
      <ConfirmDialog
        open={clearConfirmOpen}
        title={t("settings.ccConnect.clearConfirmTitle")}
        message={t("settings.ccConnect.clearConfirmMessage")}
        confirmText={t("common.delete")}
        cancelText={t("common.cancel")}
        danger
        zIndex={80}
        onClose={() => setClearConfirmOpen(false)}
        onConfirm={() => {
          setClearConfirmOpen(false);
          void clearCredentials();
        }}
      />
    </Stack>
  );
}
