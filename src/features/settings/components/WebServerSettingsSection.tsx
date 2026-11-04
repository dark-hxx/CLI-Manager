import { useCallback, useEffect, useReducer, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Badge, Button, Card, Collapse, Divider, Group, NumberInput, PasswordInput, Select, SimpleGrid, Stack, Switch, Text, TextInput, UnstyledButton } from "@mantine/core";
import { ChevronDown, ChevronUp, Globe, Play, RefreshCw, Save, ShieldAlert, Square } from "lucide-react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../../../shared/i18n/index";
import { webServerApi, type WebServerStatus } from "../../../shared/lib/webServer";
import { createWebSettingsDraft, webSettingsDraftReducer } from "../lib/webSettingsDraft";
import { webBindScope, webNetworkErrorKey, webServerNetworkRequirement } from "../lib/webNetworkGuidance";

const STATUS_EVENT = "web-server-status-changed";

const initialDraft = {
  autoStart: false, bind: "127.0.0.1", port: 8787 as number | string,
  adminUsername: "admin", adminPassword: "", allowedOrigin: "", trustedNetwork: false,
};

export function WebServerSettingsSection() {
  const { t } = useI18n();
  const [status, setStatus] = useState<WebServerStatus | null>(null);
  const [draft, dispatchDraft] = useReducer(webSettingsDraftReducer<typeof initialDraft>, createWebSettingsDraft(initialDraft));
  const { autoStart, bind, port, adminUsername, adminPassword, allowedOrigin, trustedNetwork } = draft.values;
  const edit = (patch: Partial<typeof initialDraft>) => dispatchDraft({ type: "edit", patch });
  const [working, setWorking] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // 运行状态与表单草稿独立；失败刷新、后台事件和启停结果均不能重置用户输入。
  const applyStatus = useCallback((next: WebServerStatus, savedRevision?: number) => {
    setStatus(next);
    const patch = {
      autoStart: next.autoStart, bind: next.bind, port: next.port,
      allowedOrigin: next.allowedOrigin ?? "", trustedNetwork: next.trustedNetwork ?? false,
    };
    dispatchDraft(savedRevision === undefined
      ? { type: "status", patch }
      : { type: "saved", patch: { ...patch, adminPassword: "" }, revision: savedRevision });
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
        if (!disposed) applyStatus(next);
      } catch { /* Explicit actions and initial load report failures. */ }
      finally { pending = false; }
    }, 2_000);
    return () => { disposed = true; window.clearInterval(timer); void unlisten.then((dispose) => dispose()); };
  }, [applyStatus, refresh]);

  const errorText = (error: unknown) => {
    const key = webNetworkErrorKey(error);
    return key ? t(key) : String(error);
  };

  // 捕获提交版本；保存期间仍允许编辑，回执不可覆盖新草稿。
  const run = async (key: string, action: () => Promise<WebServerStatus>, successKey: TranslationKey) => {
    const savedRevision = key === "save" ? draft.revision : undefined;
    setWorking(key);
    try { applyStatus(await action(), savedRevision); toast.success(t(successKey)); }
    catch (caught) {
      const errorKey = webNetworkErrorKey(caught);
      if (errorKey && errorKey !== "settings.webServer.error.stopping") setAdvancedOpen(true);
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
  const scope = webBindScope(bind);
  const networkExposed = scope === "network" || scope === "all";
  const networkRequirement = webServerNetworkRequirement(bind, allowedOrigin, trustedNetwork);
  useEffect(() => {
    if (networkExposed) setAdvancedOpen(true);
  }, [bind, networkExposed]);
  const stateKey: TranslationKey = status?.stopping
    ? "settings.webServer.state.stopping"
    : status?.running
    ? "settings.webServer.state.running"
    : status?.configured ? "settings.webServer.state.stopped" : "settings.webServer.state.unconfigured";
  const interfaceOptions = Array.from(new Map((status?.interfaces ?? []).map(([name, ip]) => [ip, { value: ip, label: `${name} — ${ip}` }])).values());
  const selectedInterface = interfaceOptions.some((option) => option.value === bind) ? bind : null;

  return (
    <Card className="border border-primary/25 bg-primary/5" p="md" radius="lg">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Group gap="xs"><Globe size={18} /><Text fw={600}>{t("settings.webServer.title")}</Text></Group>
          <Text mt={4} size="xs" c="var(--text-muted)">{t("settings.webServer.description")}</Text>
        </div>
        <Badge color={status?.running ? "green" : status?.configured ? "gray" : "yellow"} variant="light">{t(stateKey)}</Badge>
      </Group>
      <Group gap="xs" mt="md" wrap="wrap">
        <Button size="xs" leftSection={<Save size={14} />} loading={working === "save"} disabled={busy} onClick={() => void save()}>{t("common.save")}</Button>
        <Button size="xs" variant="light" color="green" leftSection={<Play size={14} />} loading={working === "start"} disabled={busy || !!status?.running || !!status?.stopping} onClick={() => void run("start", webServerApi.start, "settings.webServer.toast.started")}>{t("settings.webServer.start")}</Button>
        <Button size="xs" variant="light" color="red" leftSection={<Square size={13} />} loading={working === "stop"} disabled={busy || (!status?.running && !status?.stopping)} onClick={() => void run("stop", webServerApi.stop, "settings.webServer.toast.stopped")}>{t("settings.webServer.stop")}</Button>
        <Button size="xs" variant="default" leftSection={<RefreshCw size={14} />} loading={working === "restart"} disabled={busy || !status?.running} onClick={() => void run("restart", webServerApi.restart, "settings.webServer.toast.restarted")}>{t("settings.webServer.restart")}</Button>
      </Group>

      {(status?.running || status?.lastError) && <div className="mt-3 rounded-md border border-border/70 bg-surface-container-low px-3 py-2">
        {status?.running && <Stack gap={2}>
          <Text size="xs" style={{ overflowWrap: "anywhere" }}>{t("settings.webServer.url")}: {status.url}</Text>
          <Text size="xs" c="var(--text-muted)" style={{ overflowWrap: "anywhere" }}>{t("settings.webServer.localDeviceUrl")}: {status.localDeviceUrl}</Text>
        </Stack>}
        {status?.lastError && <Text mt={status.running ? "xs" : 0} size="xs" c="red" style={{ overflowWrap: "anywhere" }}>{errorText(status.lastError)}</Text>}
      </div>}

      <Divider my="md" />
      <Stack gap="xs">
        <Text fw={600} size="sm">{t("settings.webServer.basicTitle")}</Text>
        <Text size="xs" c="var(--text-muted)">{t("settings.webServer.basicDescription")}</Text>
      </Stack>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm" mt="sm">
        <Select label={t("settings.webServer.interface")} description={t("settings.webServer.interfaceHint")} placeholder={t("settings.webServer.interfaceHint")} value={selectedInterface} onChange={(value) => { if (value) edit({ bind: value }); }} data={interfaceOptions} searchable clearable />
        <TextInput label={t("settings.webServer.bind")} description={t("settings.webServer.bindHint")} value={bind} onChange={(event) => edit({ bind: event.currentTarget.value })} placeholder="127.0.0.1" />
        <NumberInput label={t("settings.webServer.port")} min={1} max={65535} value={port} onChange={(value) => edit({ port: value })} />
        <Switch mt="xs" checked={autoStart} onChange={(event) => edit({ autoStart: event.currentTarget.checked })} label={t("settings.webServer.autoStart")} description={t("settings.webServer.autoStartHint")} />
      </SimpleGrid>
      {networkRequirement && <Text mt="sm" size="xs" c="orange.7" role="status">{t(networkRequirement)}</Text>}

      <Divider my="md" />
      <UnstyledButton className="w-full rounded-md text-left" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen}>
        <Group justify="space-between" wrap="nowrap">
          <div>
            <Text fw={600} size="sm">{t("settings.webServer.advancedTitle")}</Text>
            <Text size="xs" c="var(--text-muted)">{t("settings.webServer.advancedDescription")}</Text>
          </div>
          {advancedOpen ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
        </Group>
      </UnstyledButton>
      <Collapse expanded={advancedOpen} keepMounted={false}>
        <Stack gap="sm" mt="sm">
          <TextInput label={t("settings.webServer.allowedOrigin")} description={t("settings.webServer.allowedOriginHint")} value={allowedOrigin} onChange={(event) => edit({ allowedOrigin: event.currentTarget.value })} placeholder="https://cli.example.com" />
          <Switch checked={trustedNetwork} onChange={(event) => edit({ trustedNetwork: event.currentTarget.checked })} label={t("settings.webServer.trustedNetwork")} description={t("settings.webServer.trustedNetworkHint")} />
          {networkExposed && <Group gap="xs" align="flex-start" wrap="nowrap"><ShieldAlert size={16} color="var(--mantine-color-orange-6)" /><Text size="xs" c="orange.7">{t(scope === "all" ? "settings.webServer.allInterfacesWarning" : "settings.webServer.networkWarning")}</Text></Group>}
        </Stack>
      </Collapse>

      <Divider my="md" />
      <Stack gap="xs">
        <Text fw={600} size="sm">{t("settings.webServer.securityTitle")}</Text>
        <Text size="xs" c="var(--text-muted)">{t("settings.webServer.securityDescription")}</Text>
      </Stack>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm" mt="sm">
        <TextInput label={t("settings.webServer.adminUsername")} value={adminUsername} onChange={(event) => edit({ adminUsername: event.currentTarget.value })} />
        <PasswordInput label={t("settings.webServer.adminPassword")} value={adminPassword} onChange={(event) => edit({ adminPassword: event.currentTarget.value })} placeholder={t("settings.webServer.passwordUnchanged")} />
      </SimpleGrid>
    </Card>
  );
}
