import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Accordion,
  Alert,
  Badge,
  Group,
  PasswordInput,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { Check, Globe2, Radar, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { NativeProviderButton as Button } from "./NativeProviderButton";
import { providerErrorCode } from "./nativeProviderTypes";

interface GlobalProxyState {
  schemaVersion: number;
  url: string | null;
  username: string | null;
  hasPassword: boolean;
}

interface ProxyScanCandidate {
  host: string;
  port: number;
}

interface ProxyTestResult {
  endpoint: string;
}

type ProxyAction = "load" | "save" | "clear" | "scan" | "test" | null;

export function NativeProviderGlobalProxySection() {
  const { t } = useI18n();
  const [saved, setSaved] = useState<GlobalProxyState | null>(null);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [action, setAction] = useState<ProxyAction>("load");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [scanCandidates, setScanCandidates] = useState<ProxyScanCandidate[]>([]);
  const [testedEndpoint, setTestedEndpoint] = useState<string | null>(null);

  const applyState = useCallback((next: GlobalProxyState) => {
    setSaved(next);
    setUrl(next.url ?? "");
    setUsername(next.username ?? "");
    setPassword("");
    setTestedEndpoint(null);
  }, []);

  const run = useCallback(async <T,>(nextAction: Exclude<ProxyAction, null>, work: () => Promise<T>) => {
    setAction(nextAction);
    setErrorCode(null);
    try {
      return await work();
    } catch (error) {
      const code = providerErrorCode(error);
      setErrorCode(code);
      throw error;
    } finally {
      setAction(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await run("load", () => invoke<GlobalProxyState>("routing_get_global_proxy"));
      applyState(next);
    } catch {
      // The sanitized error banner is the user-facing failure state.
    }
  }, [applyState, run]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (clearPassword: boolean) => {
    try {
      const next = await run(clearPassword ? "clear" : "save", () => invoke<GlobalProxyState>("routing_set_global_proxy", {
        input: {
          url: url.trim() || null,
          username: username.trim() || null,
          password: clearPassword ? null : (password || null),
          clearPassword,
        },
      }));
      applyState(next);
      toast.success(t(clearPassword ? "providerCatalog.routing.proxy.clearSuccess" : "providerCatalog.routing.proxy.saveSuccess"));
    } catch {
      toast.error(t("providerCatalog.routing.proxy.error"));
    }
  };

  const scan = async () => {
    try {
      const next = await run("scan", () => invoke<ProxyScanCandidate[]>("routing_scan_global_proxy"));
      setScanCandidates(next);
      toast.success(t("providerCatalog.routing.proxy.scanSuccess", { count: next.length }));
    } catch {
      toast.error(t("providerCatalog.routing.proxy.error"));
    }
  };

  const test = async () => {
    try {
      const result = await run("test", () => invoke<ProxyTestResult>("routing_test_global_proxy", {
        input: {
          url: url.trim() || null,
          username: username.trim() || null,
          password: password || null,
        },
      }));
      setTestedEndpoint(result.endpoint);
      toast.success(t("providerCatalog.routing.proxy.testSuccess"));
    } catch {
      toast.error(t("providerCatalog.routing.proxy.error"));
    }
  };

  const busy = action !== null;
  const errorMessage = errorCode === "routing_proxy_self_loop"
    ? t("providerCatalog.routing.proxy.selfLoopError")
    : errorCode === "routing_proxy_url_invalid"
      ? t("providerCatalog.routing.proxy.invalidUrlError")
      : t("providerCatalog.routing.proxy.error");

  return (
    <Accordion.Item value="global-proxy">
      <Accordion.Control icon={<Globe2 size={16} />}>
        {t("providerCatalog.routing.proxy.title")}
      </Accordion.Control>
      <Accordion.Panel>
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t("providerCatalog.routing.proxy.description")}
          </Text>
          <Alert color="blue" variant="light">
            {t("providerCatalog.routing.proxy.exceptions")}
          </Alert>
          {errorCode && <Alert color="red">{errorMessage}</Alert>}
          <TextInput
            label={t("providerCatalog.routing.proxy.url")}
            description={t("providerCatalog.routing.proxy.urlDescription")}
            placeholder={t("providerCatalog.routing.proxy.urlPlaceholder")}
            value={url}
            onChange={(event) => setUrl(event.currentTarget.value)}
            disabled={busy}
            aria-label={t("providerCatalog.routing.proxy.url")}
          />
          <TextInput
            label={t("providerCatalog.routing.proxy.username")}
            value={username}
            onChange={(event) => setUsername(event.currentTarget.value)}
            disabled={busy}
            aria-label={t("providerCatalog.routing.proxy.username")}
          />
          <PasswordInput
            label={t("providerCatalog.routing.proxy.password")}
            description={saved?.hasPassword ? t("providerCatalog.routing.proxy.passwordKeepDescription") : undefined}
            placeholder={saved?.hasPassword ? t("providerCatalog.routing.proxy.passwordPlaceholder") : undefined}
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            disabled={busy}
            aria-label={t("providerCatalog.routing.proxy.password")}
          />
          <Group gap="xs" wrap="wrap">
            <Button leftSection={<Save size={15} />} loading={action === "save"} disabled={busy} onClick={() => void save(false)}>
              {t("providerCatalog.routing.proxy.save")}
            </Button>
            <Button variant="light" leftSection={<Trash2 size={15} />} loading={action === "clear"} disabled={busy || !saved?.hasPassword} onClick={() => void save(true)}>
              {t("providerCatalog.routing.proxy.clearPassword")}
            </Button>
            <Button variant="subtle" leftSection={<Check size={15} />} loading={action === "test"} disabled={busy} onClick={() => void test()}>
              {t("providerCatalog.routing.proxy.test")}
            </Button>
            <Button variant="subtle" leftSection={<Radar size={15} />} loading={action === "scan"} disabled={busy} onClick={() => void scan()}>
              {t("providerCatalog.routing.proxy.scan")}
            </Button>
          </Group>
          {saved && (
            <Group gap="xs">
              <Badge color={saved.url ? "blue" : "gray"}>
                {saved.url ? t("providerCatalog.routing.proxy.explicit") : t("providerCatalog.routing.proxy.systemOrDirect")}
              </Badge>
              {saved.hasPassword && <Badge color="green">{t("providerCatalog.routing.proxy.passwordSaved")}</Badge>}
            </Group>
          )}
          {testedEndpoint && (
            <Text size="sm" c="green">{t("providerCatalog.routing.proxy.testedEndpoint", { endpoint: testedEndpoint })}</Text>
          )}
          {scanCandidates.length > 0 && (
            <Stack gap={2}>
              <Text size="sm" fw={600}>{t("providerCatalog.routing.proxy.scanResults")}</Text>
              {scanCandidates.map((candidate) => (
                <Button
                  key={`${candidate.host}:${candidate.port}`}
                  variant="subtle"
                  justify="flex-start"
                  onClick={() => setUrl(`http://${candidate.host}:${candidate.port}`)}
                >
                  {candidate.host}:{candidate.port}
                </Button>
              ))}
            </Stack>
          )}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}
