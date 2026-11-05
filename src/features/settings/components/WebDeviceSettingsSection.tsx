import { useCallback, useEffect, useReducer, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Badge, Button, Card, Collapse, Divider, Group, Select, SimpleGrid, Stack, Switch, Text, TextInput, UnstyledButton } from "@mantine/core";
import { ChevronDown, ChevronUp, Copy, Link2, Play, RefreshCw, Save, Square, Trash2 } from "lucide-react";
import { SettingsGlyph } from "./SettingsIcons";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../../../shared/i18n/index";
import { webDeviceApi, type WebDeviceStatus } from "../../../shared/lib/webDevice";
import { webServerApi } from "../../../shared/lib/webServer";
import { WebMobileAccess } from "./WebMobileAccess";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { normalizeWebTerminalBatchKiB } from "../../../shared/lib/webTerminalFrames";
import { pairingRefreshDelay } from "../lib/webPairingLifecycle";
import { createWebSettingsDraft, webSettingsDraftReducer } from "../lib/webSettingsDraft";
import { webDeviceNeedsNetworkTrust, webNetworkErrorKey } from "../lib/webNetworkGuidance";

const STATUS_EVENT = "web-device-status-changed";

const initialDraft = {
  serverUrl: "", trustedNetwork: false, publicAccessUrl: "", deviceName: "", autoStart: true, uploadWallpaper: true,
};

interface Props {
  onStatusChange?: (status: WebDeviceStatus) => void;
}

export function WebDeviceSettingsSection({ onStatusChange }: Props) {
  const { t } = useI18n();
  const batchKiB = useSettingsStore((state) => state.webTerminalBatchKiB);
  const [status, setStatus] = useState<WebDeviceStatus | null>(null);
  const [draft, dispatchDraft] = useReducer(webSettingsDraftReducer<typeof initialDraft>, createWebSettingsDraft(initialDraft));
  const { serverUrl, trustedNetwork, publicAccessUrl, deviceName, autoStart, uploadWallpaper } = draft.values;
  const edit = (patch: Partial<typeof initialDraft>) => dispatchDraft({ type: "edit", patch });
  const [working, setWorking] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // 连接事件和配对刷新只更新状态；保存回执通过版本检查同步草稿。
  const applyStatus = useCallback((next: WebDeviceStatus, savedRevision?: number) => {
    setStatus(next);
    onStatusChange?.(next);
    if (next.profile) {
      const patch = {
        serverUrl: next.profile.serverUrl, trustedNetwork: next.profile.trustedNetwork ?? false,
        publicAccessUrl: next.profile.publicAccessUrl ?? "", deviceName: next.profile.name,
        autoStart: next.profile.autoStart, uploadWallpaper: next.profile.uploadWallpaper,
      };
      dispatchDraft(savedRevision === undefined
        ? { type: "status", patch }
        : { type: "saved", patch, revision: savedRevision });
    }
  }, [onStatusChange]);

  const refresh = useCallback(async () => {
    try {
      applyStatus(await webDeviceApi.getStatus());
    } catch (caught) {
      toast.error(t("settings.webDevice.toast.loadFailed"), { description: String(caught) });
    }
  }, [applyStatus, t]);

  useEffect(() => {
    void refresh();
    const unlisten = listen<WebDeviceStatus>(STATUS_EVENT, (event) => applyStatus(event.payload));
    return () => { void unlisten.then((dispose) => dispose()); };
  }, [applyStatus, refresh]);

  useEffect(() => {
    const delay = pairingRefreshDelay(status?.pairingCode, status?.pairingExpiresAt, Date.now());
    if (delay === null) return;
    const timer = window.setTimeout(() => void refresh(), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [refresh, status?.pairingCode, status?.pairingExpiresAt]);

  const errorText = (error: unknown) => {
    const key = webNetworkErrorKey(error);
    return key ? t(key) : String(error);
  };

  // 提交后仍可修改配置，迟到的成功响应不能把新输入恢复成已保存值。
  const run = async (key: string, action: () => Promise<WebDeviceStatus>, successKey: TranslationKey) => {
    const savedRevision = key === "save" ? draft.revision : undefined;
    setWorking(key);
    try {
      const next = await action();
      applyStatus(next, savedRevision);
      toast.success(t(successKey));
    } catch (caught) {
      if (webNetworkErrorKey(caught)) setAdvancedOpen(true);
      toast.error(t("settings.webDevice.toast.actionFailed"), { description: errorText(caught) });
    } finally {
      setWorking(null);
    }
  };

  const save = () => run("save", () => webDeviceApi.saveProfile({
    serverUrl: serverUrl.trim(),
    trustedNetwork,
    publicAccessUrl: publicAccessUrl.trim(),
    name: deviceName.trim() || t("settings.webDevice.defaultName"),
    autoStart,
    uploadWallpaper,
  }), "settings.webDevice.toast.saved");

  const useLocalServer = async () => {
    setWorking("localServer");
    try {
      const local = await webServerApi.getStatus();
      edit({ serverUrl: local.localDeviceUrl });
    } catch (caught) {
      toast.error(t("settings.webDevice.toast.actionFailed"), { description: String(caught) });
    } finally {
      setWorking(null);
    }
  };

  const createPairing = async () => {
    setWorking("pair");
    try {
      const pairing = await webDeviceApi.createPairing();
      await refresh();
      await navigator.clipboard.writeText(pairing.code).catch(() => undefined);
      toast.success(t("settings.webDevice.toast.pairingCreated"));
    } catch (caught) {
      toast.error(t("settings.webDevice.toast.actionFailed"), { description: String(caught) });
    } finally {
      setWorking(null);
    }
  };

  const stateKey: TranslationKey = status?.connected
    ? status.paired ? "settings.webDevice.state.online" : "settings.webDevice.state.waitingPairing"
    : status?.running ? "settings.webDevice.state.connecting" : "settings.webDevice.state.stopped";
  const busy = working !== null;
  const needsNetworkTrust = webDeviceNeedsNetworkTrust(serverUrl, publicAccessUrl, trustedNetwork);
  useEffect(() => {
    if (needsNetworkTrust) setAdvancedOpen(true);
  }, [serverUrl, publicAccessUrl, needsNetworkTrust]);

  return (
    <Card className="border border-primary/25 bg-primary/5" p="md" radius="lg">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Group gap="xs"><SettingsGlyph name="link" classic={Link2} size={18} /><Text fw={600}>{t("settings.webDevice.title")}</Text></Group>
          <Text mt={4} size="xs" c="var(--text-muted)">{t("settings.webDevice.description")}</Text>
        </div>
        <Badge color={status?.connected && status.paired ? "green" : status?.running ? "yellow" : "gray"} variant="light">
          {t(stateKey)}
        </Badge>
      </Group>

      <Group gap="xs" mt="md" wrap="wrap">
        <Button size="xs" color="cliPrimary" leftSection={<Save size={14} />} loading={working === "save"} disabled={busy || !serverUrl.trim()} onClick={() => void save()}>{t("common.save")}</Button>
        <Button size="xs" variant="light" leftSection={<Play size={14} />} loading={working === "start"} disabled={busy || !status?.configured || !!status?.running} onClick={() => void run("start", webDeviceApi.start, "settings.webDevice.toast.started")}>{t("settings.webDevice.start")}</Button>
        <Button size="xs" variant="light" color="red" leftSection={<Square size={13} />} loading={working === "stop"} disabled={busy || !status?.running} onClick={() => void run("stop", webDeviceApi.stop, "settings.webDevice.toast.stopped")}>{t("settings.webDevice.stop")}</Button>
        <Button size="xs" variant="default" leftSection={<RefreshCw size={14} />} loading={working === "restart"} disabled={busy || !status?.configured} onClick={() => void run("restart", webDeviceApi.restart, "settings.webDevice.toast.restarted")}>{t("settings.webDevice.restart")}</Button>
      </Group>

      {status?.lastError && <div className="mt-3 rounded-md border border-border/70 bg-surface-container-low px-3 py-2">
        <Text size="xs" c="red" style={{ overflowWrap: "anywhere" }}>{errorText(status.lastError)}</Text>
      </div>}

      <Divider my="md" />
      <Stack gap="xs">
        <Text fw={600} size="sm">{t("settings.webDevice.connectionTitle")}</Text>
        <Text size="xs" c="var(--text-muted)">{t("settings.webDevice.connectionDescription")}</Text>
      </Stack>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm" mt="sm">
        <TextInput label={t("settings.webDevice.serverUrl")} description={t("settings.webDevice.serverUrlHint")} placeholder="https://example.com" value={serverUrl} onChange={(event) => edit({ serverUrl: event.currentTarget.value })} />
        <TextInput label={t("settings.webDevice.publicAccessUrl")} description={t("settings.webDevice.publicAccessUrlHint")} placeholder="https://cli.example.com" value={publicAccessUrl} onChange={(event) => edit({ publicAccessUrl: event.currentTarget.value })} />
      </SimpleGrid>
      {needsNetworkTrust && <Text mt="sm" size="xs" c="orange.7" role="status">{t("settings.webDevice.error.trustedNetworkRequired")}</Text>}
      <Button mt="sm" size="xs" variant="subtle" w="fit-content" disabled={busy} loading={working === "localServer"} onClick={() => void useLocalServer()}>{t("settings.webDevice.useLocalServer")}</Button>

      <Divider my="md" />
      <Stack gap="xs">
        <Text fw={600} size="sm">{t("settings.webDevice.identityTitle")}</Text>
        <Text size="xs" c="var(--text-muted)">{t("settings.webDevice.identityDescription")}</Text>
      </Stack>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm" mt="sm">
        <TextInput label={t("settings.webDevice.deviceName")} placeholder={t("settings.webDevice.defaultName")} value={deviceName} onChange={(event) => edit({ deviceName: event.currentTarget.value })} />
        <Switch mt="xs" checked={autoStart} onChange={(event) => edit({ autoStart: event.currentTarget.checked })} label={t("settings.webDevice.autoStart")} description={t("settings.webDevice.autoStartHint")} />
      </SimpleGrid>

      <Divider my="md" />
      <UnstyledButton className="w-full rounded-md text-left" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen}>
        <Group justify="space-between" wrap="nowrap">
          <div>
            <Text fw={600} size="sm">{t("settings.webDevice.advancedTitle")}</Text>
            <Text size="xs" c="var(--text-muted)">{t("settings.webDevice.advancedDescription")}</Text>
          </div>
          {advancedOpen ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
        </Group>
      </UnstyledButton>
      <Collapse expanded={advancedOpen} keepMounted={false}>
        <Stack gap="sm" mt="sm">
          <Select
            label={t("settings.webDevice.outputBatch")}
            description={t("settings.webDevice.outputBatchHint")}
            value={String(batchKiB)}
            allowDeselect={false}
            disabled={busy}
            data={[
              { value: "96", label: t("settings.webDevice.outputBatchDefault") },
              { value: "256", label: "256 KiB" },
              { value: "512", label: "512 KiB" },
            ]}
            onChange={(value) => {
              void useSettingsStore.getState().update("webTerminalBatchKiB", normalizeWebTerminalBatchKiB(Number(value)))
                .catch((caught) => toast.error(t("settings.webDevice.toast.actionFailed"), { description: String(caught) }));
            }}
          />
          <Switch checked={trustedNetwork} onChange={(event) => edit({ trustedNetwork: event.currentTarget.checked })} label={t("settings.webDevice.trustedNetwork")} description={t("settings.webDevice.trustedNetworkHint")} />
          <Switch checked={uploadWallpaper} onChange={(event) => edit({ uploadWallpaper: event.currentTarget.checked })} label={t("settings.webDevice.uploadWallpaper")} description={t("settings.webDevice.uploadWallpaperHint")} />
        </Stack>
      </Collapse>

      <Divider my="md" />
      <Stack gap="xs">
        <Text fw={600} size="sm">{t("settings.webDevice.pairingTitle")}</Text>
        <Text size="xs" c="var(--text-muted)">{t("settings.webDevice.pairingDescription")}</Text>
      </Stack>
      {status?.pairingCode && (
        <div className="mt-3 rounded-md border border-blue-500/30 bg-blue-500/10 p-3">
          <Group justify="space-between" wrap="wrap">
            <div>
              <Text size="xs" c="var(--text-muted)">{t("settings.webDevice.pairingCode")}</Text>
              <Text ff="monospace" fw={600} size="xl" style={{ letterSpacing: "0.18em" }}>{status.pairingCode}</Text>
            </div>
            <Button size="xs" variant="light" leftSection={<Copy size={14} />} onClick={() => void navigator.clipboard.writeText(status.pairingCode ?? "")}>{t("common.copy")}</Button>
          </Group>
        </div>
      )}
      <WebMobileAccess serverUrl={status?.profile?.serverUrl ?? ""} publicAccessUrl={status?.profile?.publicAccessUrl ?? ""} trustedNetwork={status?.profile?.trustedNetwork ?? false} paired={Boolean(status?.paired)} />
      <Group gap="xs" mt="sm" wrap="wrap">
        <Button size="xs" variant="default" leftSection={<Link2 size={14} />} loading={working === "pair"} disabled={busy || !status?.connected || !!status?.paired} onClick={() => void createPairing()}>{t("settings.webDevice.createPairing")}</Button>
        <Button size="xs" variant="subtle" color="red" leftSection={<Trash2 size={14} />} loading={working === "clear"} disabled={busy || !status?.configured} onClick={() => void run("clear", webDeviceApi.clearPairing, "settings.webDevice.toast.pairingCleared")}>{t("settings.webDevice.resetDevice")}</Button>
      </Group>
    </Card>
  );
}
