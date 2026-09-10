import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Badge, Button, Card, Group, NumberInput, PasswordInput, Select, Stack, Switch, Text, TextInput } from "@mantine/core";
import { Globe, Play, RefreshCw, Save, ShieldAlert, Square } from "lucide-react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import { webServerApi, type WebServerStatus } from "../../lib/webServer";

const STATUS_EVENT = "web-server-status-changed";

export function WebServerSettingsSection() {
  const { t } = useI18n();
  const [status, setStatus] = useState<WebServerStatus | null>(null);
  const [autoStart, setAutoStart] = useState(false);
  const [bind, setBind] = useState("127.0.0.1");
  const [port, setPort] = useState<number | string>(8787);
  const [adminUsername, setAdminUsername] = useState("admin");
  const [adminPassword, setAdminPassword] = useState("");
  const [allowedOrigin, setAllowedOrigin] = useState("");
  const [trustedNetwork, setTrustedNetwork] = useState(false);
  const [working, setWorking] = useState<string | null>(null);

  const applyStatus = useCallback((next: WebServerStatus) => {
    setStatus(next);
    setAutoStart(next.autoStart);
    setBind(next.bind);
    setPort(next.port);
    setAllowedOrigin(next.allowedOrigin ?? "");
    setTrustedNetwork(next.trustedNetwork ?? false);
  }, []);

  const refresh = useCallback(async () => {
    try { applyStatus(await webServerApi.getStatus()); }
    catch (caught) { toast.error(t("settings.webServer.toast.loadFailed"), { description: String(caught) }); }
  }, [applyStatus, t]);

  useEffect(() => {
    void refresh();
    const unlisten = listen<WebServerStatus>(STATUS_EVENT, (event) => applyStatus(event.payload));
    let disposed = false;
    let pending = false;
    const timer = window.setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await webServerApi.getStatus();
        // Background status updates must not overwrite unsaved form edits.
        if (!disposed) setStatus(next);
      } catch { /* Explicit actions and initial load report failures. */ }
      finally { pending = false; }
    }, 2_000);
    return () => { disposed = true; window.clearInterval(timer); void unlisten.then((dispose) => dispose()); };
  }, [applyStatus, refresh]);

  const errorText = (error: unknown) => String(error) === "web_server_still_stopping"
    ? t("settings.webServer.error.stopping") : String(error);

  const run = async (key: string, action: () => Promise<WebServerStatus>, successKey: TranslationKey) => {
    setWorking(key);
    try { applyStatus(await action()); toast.success(t(successKey)); }
    catch (caught) {
      toast.error(t("settings.webServer.toast.actionFailed"), { description: errorText(caught) });
      await refresh();
    }
    finally { setWorking(null); }
  };

  const save = () => run("save", () => webServerApi.saveConfig({
    autoStart, bind: bind.trim(), port: Number(port), adminUsername: adminUsername.trim(),
    allowedOrigin: allowedOrigin.trim() || undefined,
    trustedNetwork,
    ...(adminPassword.trim() ? { adminPassword: adminPassword.trim() } : {}),
  }), "settings.webServer.toast.saved");

  const busy = working !== null;
  const networkExposed = !["127.0.0.1", "::1"].includes(bind.trim());
  const stateKey: TranslationKey = status?.stopping
    ? "settings.webServer.state.stopping"
    : status?.running
    ? "settings.webServer.state.running"
    : status?.configured ? "settings.webServer.state.stopped" : "settings.webServer.state.unconfigured";

  return (
    <Card className="border border-primary/25 bg-primary/5" p="md" radius="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="xs"><Globe size={18} /><Text fw={700}>{t("settings.webServer.title")}</Text></Group>
          <Text mt={4} size="xs" c="var(--text-muted)">{t("settings.webServer.description")}</Text>
        </div>
        <Badge color={status?.running ? "green" : status?.configured ? "gray" : "yellow"} variant="light">{t(stateKey)}</Badge>
      </Group>
      <Stack gap="sm" mt="md">
        <Select label={t("settings.webServer.interface")} placeholder={t("settings.webServer.interfaceHint")} value={null} onChange={(value) => { if (value) setBind(value); }} data={Array.from(new Map((status?.interfaces ?? []).map(([name, ip]) => [ip, { value: ip, label: `${name} — ${ip}` }])).values())} searchable />
        <Group grow align="flex-start">
          <TextInput label={t("settings.webServer.bind")} description={t("settings.webServer.bindHint")} value={bind} onChange={(event) => setBind(event.currentTarget.value)} placeholder="127.0.0.1" />
          <NumberInput label={t("settings.webServer.port")} min={1} max={65535} value={port} onChange={setPort} />
        </Group>
        <TextInput label={t("settings.webServer.allowedOrigin")} description={t("settings.webServer.allowedOriginHint")} value={allowedOrigin} onChange={(event) => setAllowedOrigin(event.currentTarget.value)} placeholder="https://cli.example.com" />
        <Switch checked={trustedNetwork} onChange={(event) => setTrustedNetwork(event.currentTarget.checked)} label={t("settings.webServer.trustedNetwork")} description={t("settings.webServer.trustedNetworkHint")} />
        {networkExposed && <Group gap="xs" align="flex-start" wrap="nowrap"><ShieldAlert size={16} color="var(--mantine-color-orange-6)" /><Text size="xs" c="orange.7">{t(bind.trim() === "0.0.0.0" || bind.trim() === "::" ? "settings.webServer.allInterfacesWarning" : "settings.webServer.networkWarning")}</Text></Group>}
        <TextInput label={t("settings.webServer.adminUsername")} value={adminUsername} onChange={(event) => setAdminUsername(event.currentTarget.value)} />
        <PasswordInput label={t("settings.webServer.adminPassword")} description={t("settings.webServer.adminPasswordHint")} value={adminPassword} onChange={(event) => setAdminPassword(event.currentTarget.value)} placeholder={t("settings.webServer.passwordUnchanged")} />
        <Switch checked={autoStart} onChange={(event) => setAutoStart(event.currentTarget.checked)} label={t("settings.webServer.autoStart")} description={t("settings.webServer.autoStartHint")} />
        {status?.running && <Text size="xs" c="var(--text-muted)">{t("settings.webServer.url")}: {status.url}</Text>}
        {status?.running && <Text size="xs" c="var(--text-muted)">{t("settings.webServer.localDeviceUrl")}: {status.localDeviceUrl}</Text>}
        {status?.lastError && <Text size="xs" c="red">{errorText(status.lastError)}</Text>}
        <Group gap="xs">
          <Button size="xs" leftSection={<Save size={14} />} loading={working === "save"} disabled={busy} onClick={() => void save()}>{t("common.save")}</Button>
          <Button size="xs" variant="light" color="green" leftSection={<Play size={14} />} loading={working === "start"} disabled={busy || !!status?.running || !!status?.stopping} onClick={() => void run("start", webServerApi.start, "settings.webServer.toast.started")}>{t("settings.webServer.start")}</Button>
          <Button size="xs" variant="light" color="red" leftSection={<Square size={13} />} loading={working === "stop"} disabled={busy || (!status?.running && !status?.stopping)} onClick={() => void run("stop", webServerApi.stop, "settings.webServer.toast.stopped")}>{t("settings.webServer.stop")}</Button>
          <Button size="xs" variant="default" leftSection={<RefreshCw size={14} />} loading={working === "restart"} disabled={busy || !status?.running} onClick={() => void run("restart", webServerApi.restart, "settings.webServer.toast.restarted")}>{t("settings.webServer.restart")}</Button>
        </Group>
      </Stack>
    </Card>
  );
}
