import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Button, Group, Select, Stack, Text } from "@mantine/core";
import { invoke } from "@tauri-apps/api/core";
import { Check, HelpCircle, X } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "../../../shared/i18n/index";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { isWindowsPlatform, type HookBridgeBadgeStatus } from "../lib/hookSettingsModel";
import { CliHookBridgeCard } from "./CliHookBridgeCard";
import { PathRow } from "./HookSettingsControls";

type AgyStatus = "notInstalled" | "partialInstalled" | "installed" | "conflict";
interface AgyHookInstallation {
  status: AgyStatus;
  configPath: string;
}

const commands = {
  check: "hook_settings_get_status_antigravity",
  install: "hook_settings_install_antigravity",
  remove: "hook_settings_uninstall_antigravity",
} as const;

export interface AntigravityHookSectionProps {
  open?: boolean;
  onToggle?: () => void;
  refreshNonce?: number;
}

interface EnvironmentInstallationProps {
  distro: string | null;
  refreshNonce?: number;
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  open?: boolean;
  onToggle?: () => void;
  environmentControl?: ReactNode;
}

/** 此组件随环境更换重新挂载；旧环境的响应不能解锁新环境的写操作。 */
function EnvironmentInstallation({
  distro,
  refreshNonce = 0,
  enabled = true,
  onEnabledChange = () => {},
  open = true,
  onToggle = () => {},
  environmentControl,
}: EnvironmentInstallationProps) {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const [result, setResult] = useState<AgyHookInstallation | null>(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const knownStatus = useRef<AgyStatus | null>(null);
  const generation = useRef(0);
  const lastRefreshNonce = useRef(refreshNonce);

  const run = useCallback(
    async (command: keyof typeof commands) => {
      if (!mounted.current || pending.current) return;
      const known = knownStatus.current;
      if (command === "install" && known !== "notInstalled" && known !== "partialInstalled") return;
      if (command === "remove" && known !== "installed" && known !== "partialInstalled") return;
      const request = ++generation.current;
      pending.current = true;
      setBusy(true);
      setFailed(false);
      try {
        const next = await invoke<AgyHookInstallation>(commands[command], distro ? { wslDistro: distro } : {});
        if (request === generation.current) {
          knownStatus.current = next.status;
          setResult(next);
          if (command === "install" && next.status === "installed") {
            toast.success(tRef.current("settings.hooks.agy.installedToast"));
          } else if (command === "remove" && next.status === "notInstalled") {
            toast.success(tRef.current("settings.hooks.agy.removedToast"));
          }
        }
      } catch {
        if (request === generation.current) {
          knownStatus.current = null;
          setResult(null);
          setFailed(true);
          if (command === "install" || command === "remove") {
            toast.error(tRef.current("settings.hooks.agy.actionFailedToast"), {
              description: tRef.current("settings.hooks.agy.error"),
            });
          }
        }
      } finally {
        if (request === generation.current) {
          pending.current = false;
          setBusy(false);
        }
      }
    },
    [distro],
  );

  useEffect(() => {
    mounted.current = true;
    void run("check");
    return () => {
      mounted.current = false;
      ++generation.current;
      pending.current = false;
    };
  }, [run]);

  useEffect(() => {
    if (refreshNonce === lastRefreshNonce.current) return;
    lastRefreshNonce.current = refreshNonce;
    void run("check");
  }, [refreshNonce, run]);

  const badgeStatus: HookBridgeBadgeStatus = failed
    ? "error"
    : result
      ? result.status
      : "pending";
  const writable = !busy && result && result.status !== "conflict";
  const statusTone =
    failed || result?.status === "conflict"
      ? "danger"
      : result?.status === "partialInstalled"
        ? "warning"
        : undefined;
  const showStatusBanner = failed || !result || result.status === "conflict";
  const eventDotColor =
    result?.status === "installed"
      ? "var(--success)"
      : result?.status === "partialInstalled"
        ? "var(--warning)"
        : "var(--text-muted)";

  return (
    <CliHookBridgeCard
      cliIcon="antigravity"
      title={t("settings.hooks.agy.title")}
      description={t("settings.hooks.agy.description")}
      status={badgeStatus}
      enabled={enabled}
      onEnabledChange={onEnabledChange}
      switchAriaLabel={t("settings.hooks.bridge.antigravityEnabled")}
      open={open}
      onToggle={onToggle}
      disabledNotice={t("settings.hooks.agy.enableHint")}
    >
      {showStatusBanner && (
        <div className="hook-bridge-notice" data-tone={statusTone} role="status">
          {failed
            ? t("settings.hooks.agy.error")
            : result
              ? t(`settings.hooks.agy.${result.status}`)
              : t("settings.hooks.agy.pending")}
        </div>
      )}

      <Stack gap={6}>
        <Text size="xs" fw={500} c="var(--on-surface-variant)">
          {t("settings.hooks.agy.eventsTitle")}
        </Text>
        <div className="hook-bridge-events-strip">
          {(
            [
              "settings.hooks.agy.eventSessionStart",
              "settings.hooks.agy.eventPreInvocation",
              "settings.hooks.agy.eventStop",
            ] as const
          ).map((key) => (
            <span key={key} className="hook-bridge-event-chip">
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "9999px",
                  backgroundColor: eventDotColor,
                  flexShrink: 0,
                }}
              />
              {t(key)}
            </span>
          ))}
        </div>
      </Stack>

      <div className="hook-bridge-well">
        {environmentControl}
        {result && <PathRow label={t("settings.hooks.agy.path")} value={result.configPath} />}
        <Group gap="xs">
          <Button
            variant="subtle"
            color="gray"
            size="xs"
            onClick={() => setNotesOpen((prev) => !prev)}
            leftSection={<HelpCircle size={14} />}
          >
            {t("settings.hooks.agy.installNotes")}
          </Button>
        </Group>
        {notesOpen && (
          <div className="hook-bridge-notice">
            <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
              <Group gap="sm" wrap="nowrap" align="flex-start">
                <Box style={{ color: "var(--success)", marginTop: 2 }}>
                  <Check size={16} />
                </Box>
                <Stack gap={2}>
                  <Text size="xs" fw={500} c="var(--on-surface)">
                    {t("settings.hooks.agy.notesInstalledTitle")}
                  </Text>
                  <Text size="xs" c="var(--on-surface-variant)" ff="var(--font-ui-mono)">
                    {t("settings.hooks.agy.notesInstalledEntry")}
                  </Text>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {t("settings.hooks.agy.notesInstalledScope")}
                  </Text>
                </Stack>
              </Group>
              <Group gap="sm" wrap="nowrap" align="flex-start">
                <Box style={{ color: "var(--warning)", marginTop: 2 }}>
                  <X size={16} />
                </Box>
                <Stack gap={2}>
                  <Text size="xs" fw={500} c="var(--on-surface)">
                    {t("settings.hooks.agy.notesKeptTitle")}
                  </Text>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {t("settings.hooks.agy.notesKeptUser")}
                  </Text>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {t("settings.hooks.agy.notesKeptConflict")}
                  </Text>
                </Stack>
              </Group>
            </Stack>
          </div>
        )}
      </div>

      <div className="hook-bridge-actions">
        <Button
          size="xs"
          color="cliPrimary"
          disabled={!writable || result?.status === "installed"}
          onClick={() => void run("install")}
        >
          {t("settings.hooks.agy.install")}
        </Button>
        <Button
          size="xs"
          color="red"
          variant="light"
          disabled={!writable || result?.status === "notInstalled"}
          onClick={() => void run("remove")}
        >
          {t("settings.hooks.agy.remove")}
        </Button>
        <div className="hook-bridge-actions-trailing">
          <Button size="xs" variant="default" color="gray" disabled={busy} onClick={() => void run("check")}>
            {t("settings.hooks.agy.check")}
          </Button>
        </div>
      </div>
    </CliHookBridgeCard>
  );
}

export function AntigravityHookSection({
  open: controlledOpen,
  onToggle: controlledToggle,
  refreshNonce = 0,
}: AntigravityHookSectionProps = {}) {
  const { t } = useI18n();
  const enabled = useSettingsStore((s) => s.antigravityHookBridgeEnabled);
  const update = useSettingsStore((s) => s.update);
  const [localOpen, setLocalOpen] = useState(false);
  const [distro, setDistro] = useState<string | null>(null);
  const [distros, setDistros] = useState<string[]>([]);
  const windows = isWindowsPlatform();

  useEffect(() => {
    if (!windows) return;
    let mounted = true;
    void invoke<string[]>("provider_wsl_list_distros")
      .then((values) => {
        if (!mounted) return;
        const nextDistros = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
        setDistros(nextDistros);
        setDistro((current) => (current && !nextDistros.includes(current) ? null : current));
      })
      .catch(() => {
        if (!mounted) return;
        setDistros([]);
        setDistro(null);
      });
    return () => {
      mounted = false;
    };
  }, [windows, refreshNonce]);

  const open = controlledOpen ?? localOpen;
  const onToggle = controlledToggle ?? (() => setLocalOpen((prev) => !prev));
  const environmentControl =
    windows && distros.length > 0 ? (
      <Select
        size="xs"
        label={t("settings.hooks.agy.environment")}
        value={distro ? `wsl:${distro}` : "local"}
        allowDeselect={false}
        data={[
          { value: "local", label: t("settings.hooks.agy.local") },
          ...distros.map((name) => ({ value: `wsl:${name}`, label: `WSL · ${name}` })),
        ]}
        onChange={(id) => {
          if (id) setDistro(id === "local" ? null : id.slice(4));
        }}
      />
    ) : null;

  return (
    <EnvironmentInstallation
      key={distro ? `wsl:${distro}` : "local"}
      distro={distro}
      refreshNonce={refreshNonce}
      enabled={enabled}
      onEnabledChange={(checked) => void update("antigravityHookBridgeEnabled", checked)}
      open={open}
      onToggle={onToggle}
      environmentControl={environmentControl}
    />
  );
}
