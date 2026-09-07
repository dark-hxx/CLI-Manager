import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Badge, Button, Card, Group, Stack, Switch, Text, TextInput } from "@mantine/core";
import { Copy, Link2, Play, RefreshCw, Save, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import { webDeviceApi, type WebDeviceStatus } from "../../lib/webDevice";

const STATUS_EVENT = "web-device-status-changed";

interface Props {
  onStatusChange?: (status: WebDeviceStatus) => void;
}

export function WebDeviceSettingsSection({ onStatusChange }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<WebDeviceStatus | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [autoStart, setAutoStart] = useState(true);
  const [uploadWallpaper, setUploadWallpaper] = useState(true);
  const [working, setWorking] = useState<string | null>(null);

  const applyStatus = useCallback((next: WebDeviceStatus) => {
    setStatus(next);
    onStatusChange?.(next);
    if (next.profile) {
      setServerUrl(next.profile.serverUrl);
      setDeviceName(next.profile.name);
      setAutoStart(next.profile.autoStart);
      setUploadWallpaper(next.profile.uploadWallpaper);
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

  const run = async (key: string, action: () => Promise<WebDeviceStatus>, successKey: TranslationKey) => {
    setWorking(key);
    try {
      applyStatus(await action());
      toast.success(t(successKey));
    } catch (caught) {
      toast.error(t("settings.webDevice.toast.actionFailed"), { description: String(caught) });
    } finally {
      setWorking(null);
    }
  };

  const save = () => run("save", () => webDeviceApi.saveProfile({
    serverUrl: serverUrl.trim(),
    name: deviceName.trim() || t("settings.webDevice.defaultName"),
    autoStart,
    uploadWallpaper,
  }), "settings.webDevice.toast.saved");

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

  return (
    <Card className="border border-primary/25 bg-primary/5" p="md" radius="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="xs"><Link2 size={18} /><Text fw={700}>{t("settings.webDevice.title")}</Text></Group>
          <Text mt={4} size="xs" c="var(--text-muted)">{t("settings.webDevice.description")}</Text>
        </div>
        <Badge color={status?.connected && status.paired ? "green" : status?.running ? "yellow" : "gray"} variant="light">
          {t(stateKey)}
        </Badge>
      </Group>

      <Stack gap="sm" mt="md">
        <TextInput label={t("settings.webDevice.serverUrl")} description={t("settings.webDevice.serverUrlHint")} placeholder="https://example.com" value={serverUrl} onChange={(event) => setServerUrl(event.currentTarget.value)} />
        <TextInput label={t("settings.webDevice.deviceName")} placeholder={t("settings.webDevice.defaultName")} value={deviceName} onChange={(event) => setDeviceName(event.currentTarget.value)} />
        <Switch checked={autoStart} onChange={(event) => setAutoStart(event.currentTarget.checked)} label={t("settings.webDevice.autoStart")} description={t("settings.webDevice.autoStartHint")} />
        <Switch checked={uploadWallpaper} onChange={(event) => setUploadWallpaper(event.currentTarget.checked)} label={t("settings.webDevice.uploadWallpaper")} description={t("settings.webDevice.uploadWallpaperHint")} />
        {status?.profile && <Text size="xs" c="var(--text-muted)" style={{ overflowWrap: "anywhere" }}>{t("settings.webDevice.clientId")}: {status.profile.clientId}</Text>}
        {status?.lastError && <Text size="xs" c="red">{status.lastError}</Text>}

        {status?.pairingCode && (
          <Card p="sm" radius="md" className="border border-blue-500/30 bg-blue-500/10">
            <Group justify="space-between">
              <div>
                <Text size="xs" c="var(--text-muted)">{t("settings.webDevice.pairingCode")}</Text>
                <Text ff="monospace" fw={800} size="xl" style={{ letterSpacing: "0.18em" }}>{status.pairingCode}</Text>
              </div>
              <Button size="xs" variant="light" leftSection={<Copy size={14} />} onClick={() => void navigator.clipboard.writeText(status.pairingCode ?? "")}>{t("common.copy")}</Button>
            </Group>
          </Card>
        )}

        <Group gap="xs">
          <Button size="xs" color="cliPrimary" leftSection={<Save size={14} />} loading={working === "save"} disabled={busy || !serverUrl.trim()} onClick={() => void save()}>{t("common.save")}</Button>
          <Button size="xs" variant="light" leftSection={<Play size={14} />} loading={working === "start"} disabled={busy || !status?.configured || !!status?.running} onClick={() => void run("start", webDeviceApi.start, "settings.webDevice.toast.started")}>{t("settings.webDevice.start")}</Button>
          <Button size="xs" variant="light" color="red" leftSection={<Square size={13} />} loading={working === "stop"} disabled={busy || !status?.running} onClick={() => void run("stop", webDeviceApi.stop, "settings.webDevice.toast.stopped")}>{t("settings.webDevice.stop")}</Button>
          <Button size="xs" variant="default" leftSection={<RefreshCw size={14} />} loading={working === "restart"} disabled={busy || !status?.configured} onClick={() => void run("restart", webDeviceApi.restart, "settings.webDevice.toast.restarted")}>{t("settings.webDevice.restart")}</Button>
          <Button size="xs" variant="default" leftSection={<Link2 size={14} />} loading={working === "pair"} disabled={busy || !status?.connected || !!status?.paired} onClick={() => void createPairing()}>{t("settings.webDevice.createPairing")}</Button>
          <Button size="xs" variant="subtle" color="red" leftSection={<Trash2 size={14} />} loading={working === "clear"} disabled={busy || !status?.configured} onClick={() => void run("clear", webDeviceApi.clearPairing, "settings.webDevice.toast.pairingCleared")}>{t("settings.webDevice.resetDevice")}</Button>
        </Group>
      </Stack>
    </Card>
  );
}
