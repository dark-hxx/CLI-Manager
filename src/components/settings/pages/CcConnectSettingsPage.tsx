import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { projectSupportsCapability } from "../../../lib/projectCapabilities";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
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
import { ConfirmDialog } from "../../ConfirmDialog";
import { WebDeviceSettingsSection } from "../WebDeviceSettingsSection";

type AgentKind = "claude" | "codex";
type PlatformKind = "telegram" | "feishu";
type ReplyLanguage = "zh" | "en";

interface CcConnectProfile {
  autoStart: boolean;
  executablePath: string | null;
  projectId: string;
  projectName: string;
  projectPath: string;
  agent: AgentKind;
  platform: PlatformKind;
  allowFrom: string;
  yoloEnabled: boolean;
  proxyEnabled: boolean;
  proxyUrl: string | null;
  loggingEnabled: boolean;
  language: ReplyLanguage;
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
  yoloEnabled: false,
  proxyEnabled: true,
  proxyUrl: null,
  loggingEnabled: false,
  language: "zh",
};

const BLOCKER_KEYS: Record<string, TranslationKey> = {
  profile_missing: "settings.ccConnect.blocker.profileMissing",
  project_missing: "settings.ccConnect.blocker.projectMissing",
  project_path_missing: "settings.ccConnect.blocker.projectPathMissing",
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
  const [status, setStatus] = useState<CcConnectStatus | null>(null);
  const [profile, setProfile] = useState<CcConnectProfile>(() => ({
    ...EMPTY_PROFILE,
    language: language === "en-US" ? "en" : "zh",
  }));
  const [telegramToken, setTelegramToken] = useState("");
  const [feishuAppId, setFeishuAppId] = useState("");
  const [feishuAppSecret, setFeishuAppSecret] = useState("");
  const [logs, setLogs] = useState<CcConnectLogLine[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [executableDirty, setExecutableDirty] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [yoloConfirmOpen, setYoloConfirmOpen] = useState(false);
  const logCursorRef = useRef(0);
  const statusRequestRef = useRef(0);
  const statusInFlightRef = useRef(false);
  const logInFlightRef = useRef(false);
  const formTouchedRef = useRef(false);
  const workingRef = useRef<string | null>(null);

  const hydrateProfile = useCallback((next: CcConnectStatus) => {
    if (next.profile) setProfile(next.profile);
    formTouchedRef.current = false;
    setDirty(false);
    setExecutableDirty(false);
  }, []);

  const refreshStatus = useCallback(async (force = false, hydrate = false, silent = false) => {
    if (statusInFlightRef.current || workingRef.current) return;
    statusInFlightRef.current = true;
    const requestId = ++statusRequestRef.current;
    try {
      const next = await invoke<CcConnectStatus>("cc_connect_get_status", { refreshDetection: force });
      if (requestId !== statusRequestRef.current) return;
      setStatus(next);
      if (hydrate && !formTouchedRef.current) hydrateProfile(next);
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
        updateProfile("executablePath", selected);
        setExecutableDirty(true);
      }
    } catch (error) {
      toast.error(t("settings.ccConnect.toast.selectExecutableFailed"), { description: errorMessage(error) });
    }
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
          },
          telegramToken: telegramToken.trim() || null,
          feishuAppId: feishuAppId.trim() || null,
          feishuAppSecret: feishuAppSecret.trim() || null,
        },
      });
      setStatus(next);
      hydrateProfile(next);
      setTelegramToken("");
      setFeishuAppId("");
      setFeishuAppSecret("");
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
      toast.success(t("settings.ccConnect.toast.clearSuccess"));
    } catch (error) {
      toast.error(t("settings.ccConnect.toast.clearFailed"), { description: errorMessage(error) });
    } finally {
      setWorkingState(null);
    }
  };

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

  const credentialInputPending = profile.platform === "telegram"
    ? telegramToken.trim().length > 0
    : feishuAppId.trim().length > 0 || feishuAppSecret.trim().length > 0;
  const credentialStored = !credentialInputPending
    && status?.profile?.platform === profile.platform
    && status.credentialsReady;
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
  const busy = working !== null || Boolean(status?.starting);
  const processLabel = status?.starting
    ? t("settings.ccConnect.starting")
    : status?.running
      ? t("settings.ccConnect.running")
      : t("settings.ccConnect.stopped");

  return (
    <Stack gap="md" maw={1040}>
      <WebDeviceSettingsSection />
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
            <Badge color={!status ? "gray" : status.installed ? "green" : "gray"} variant="light">
              {!status
                ? t("settings.ccConnect.detecting")
                : status.installed
                  ? t("settings.ccConnect.installed")
                  : t("settings.ccConnect.notInstalled")}
            </Badge>
            {executableDirty ? (
              <Badge color="yellow" variant="light">{t("settings.ccConnect.executableUnverified")}</Badge>
            ) : status?.installed && (
              <Badge color={status.compatible ? "green" : "red"} variant="light">
                {status.compatible ? t("settings.ccConnect.compatible") : t("settings.ccConnect.incompatible")}
              </Badge>
            )}
          </Group>
        </Group>
        <SimpleGrid cols={{ base: 1, md: 2 }} mt="md" spacing="sm">
          <TextInput
            label={t("settings.ccConnect.executablePath")}
            value={profile.executablePath ?? status?.executablePath ?? ""}
            onChange={(event) => {
              updateProfile("executablePath", event.currentTarget.value || null);
              setExecutableDirty(true);
            }}
            rightSection={<FolderSearch size={16} />}
          />
          <Stack gap={6} justify="flex-end">
            <Group gap="xs">
              <Button size="xs" variant="default" disabled={busy} onClick={() => void chooseExecutable()} leftSection={<FolderSearch size={14} />}>
                {t("settings.ccConnect.chooseExecutable")}
              </Button>
              <Button size="xs" variant="subtle" disabled={busy || executableDirty} onClick={() => void refreshStatus(true, false, false)} leftSection={<RefreshCw size={14} />}>
                {t("settings.ccConnect.rescan")}
              </Button>
            </Group>
          </Stack>
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, md: 2 }} mt="sm" spacing="sm">
          <Text size="xs" c="var(--text-muted)">{t("settings.ccConnect.version")}: {executableDirty ? "—" : status?.version ?? "—"}</Text>
          <Text size="xs" c="var(--text-muted)" style={{ overflowWrap: "anywhere" }}>{t("settings.ccConnect.sha256")}: {executableDirty ? "—" : status?.sha256 ?? "—"}</Text>
        </SimpleGrid>
        {status?.detectionError && <Text mt="xs" size="xs" c="red">{status.detectionError}</Text>}
      </Card>

      <Card className="border border-border bg-surface-container-low" p="md" radius="lg">
        <Text fw={700}>{t("settings.ccConnect.profile.title")}</Text>
        <Text mt={4} size="xs" c="var(--text-muted)">{t("settings.ccConnect.profile.description")}</Text>
        <SimpleGrid cols={{ base: 1, md: 2 }} mt="md" spacing="sm">
          <Select label={t("settings.ccConnect.project")} placeholder={t("settings.ccConnect.projectPlaceholder")} nothingFoundMessage={t("settings.ccConnect.projectEmpty")} data={projectOptions} value={profile.projectId || null} onChange={selectProject} searchable />
          <Select label={t("settings.ccConnect.agent")} data={[{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }]} value={profile.agent} onChange={(value) => value && updateProfile("agent", value as AgentKind)} />
          <Select label={t("settings.ccConnect.platform")} data={[{ value: "telegram", label: t("settings.ccConnect.platformTelegram") }, { value: "feishu", label: t("settings.ccConnect.platformFeishu") }]} value={profile.platform} onChange={(value) => value && updateProfile("platform", value as PlatformKind)} />
          <Select label={t("settings.ccConnect.language")} data={[{ value: "zh", label: t("settings.ccConnect.languageZh") }, { value: "en", label: t("settings.ccConnect.languageEn") }]} value={profile.language} onChange={(value) => value && updateProfile("language", value as ReplyLanguage)} />
        </SimpleGrid>
        <TextInput
          mt="sm"
          label={t("settings.ccConnect.allowFrom")}
          description={profile.platform === "telegram" ? t("settings.ccConnect.allowFromTelegramHelp") : t("settings.ccConnect.allowFromFeishuHelp")}
          value={profile.allowFrom}
          onChange={(event) => updateProfile("allowFrom", event.currentTarget.value)}
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
        ) : (
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
        )}
        <Group mt="md" justify="flex-end">
          <Button size="xs" variant="light" color="red" leftSection={<Trash2 size={14} />} disabled={!!status?.running || busy} loading={working === "clear"} onClick={() => setClearConfirmOpen(true)}>
            {t("settings.ccConnect.clearCredentials")}
          </Button>
          <Button size="xs" color="cliPrimary" leftSection={<Save size={14} />} disabled={!!status?.running || busy} loading={working === "save"} onClick={() => void saveProfile()}>
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
