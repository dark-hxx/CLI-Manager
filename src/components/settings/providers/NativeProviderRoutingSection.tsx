import { useEffect, useState } from "react";
import { Accordion, Alert, Group, NumberInput, Stack, Switch, Text } from "@mantine/core";
import { RefreshCw, Route, Server } from "lucide-react";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { NativeProviderButton as Button } from "./NativeProviderButton";
import type { NativeProviderAppType, NativeProviderHomeIdentity } from "./nativeProviderTypes";
import type { UseNativeProviderRoutingResult } from "./useNativeProviderRouting";
import { NativeProviderFailoverSection } from "./NativeProviderFailoverSection";
import { NativeProviderGlobalProxySection } from "./NativeProviderGlobalProxySection";
import { NativeProviderRectifierSection } from "./NativeProviderRectifierSection";

interface NativeProviderRoutingSectionProps {
  appType: NativeProviderAppType;
  homeIdentity: NativeProviderHomeIdentity | null;
  state: UseNativeProviderRoutingResult;
}

const ROUTING_ERROR_TRANSLATIONS: Partial<Record<string, TranslationKey>> = {
  routing_provider_not_ready: "providerCatalog.routing.errors.providerNotReady",
  routing_provider_key_not_active: "providerCatalog.routing.errors.providerKeyNotActive",
  routing_service_unavailable: "providerCatalog.routing.errors.serviceUnavailable",
  routing_port_invalid: "providerCatalog.routing.errors.portInvalid",
  routing_port_change_requires_service_disabled: "providerCatalog.routing.errors.portRequiresServiceDisabled",
  routing_port_change_requires_takeover_disabled: "providerCatalog.routing.errors.portRequiresTakeoverDisabled",
  routing_failover_manual_queue_single: "providerCatalog.routing.errors.manualQueueSingle",
};

export function NativeProviderRoutingSection({
  appType,
  homeIdentity,
  state,
}: NativeProviderRoutingSectionProps) {
  const { t } = useI18n();
  const routing = state.state;
  const service = routing?.persisted.service;
  const daemon = routing?.daemon;
  const failover = state.failoverState[appType];
  const [portDraft, setPortDraft] = useState("");
  const busy = Boolean(state.action);
  const currentTakeover = routing?.persisted.takeovers.find(
    (item) => item.appType === appType
      && item.homeIdentity.environmentKind === homeIdentity?.environmentKind
      && item.homeIdentity.environmentId === homeIdentity?.environmentId
      && item.homeIdentity.identity === homeIdentity?.identity,
  );
  const hasTakeover = Boolean(currentTakeover);
  const hasAnyTakeover = Boolean(routing?.persisted.takeovers.length);
  const serviceRunning = Boolean(service?.serviceEnabled && daemon?.status === "running");
  const runtimeAvailable = Boolean(
    serviceRunning
      && daemon?.capabilitySupported
      && daemon.connected,
  );
  const appLabel = t(`providerCatalog.appType.${appType}` as "providerCatalog.appType.claude" | "providerCatalog.appType.codex" | "providerCatalog.appType.grokbuild");
  const port = Number(portDraft);
  const portChanged = portDraft !== String(service?.preferredPort ?? "");
  const validPort = Number.isInteger(port) && port >= 1024 && port <= 65535;
  const errorMessage = t(ROUTING_ERROR_TRANSLATIONS[state.errorCode ?? ""] ?? "providerCatalog.routing.error");

  useEffect(() => {
    if (service) setPortDraft(String(service.preferredPort));
  }, [service?.preferredPort]);

  useEffect(() => {
    if (!hasTakeover) return;
    void state.refreshFailover(appType);
  }, [appType, hasTakeover, state.refreshFailover]);

  const handleTakeoverChange = async (enabled: boolean) => {
    if (!homeIdentity) return;
    await state.setTakeover(appType, homeIdentity, enabled);
  };

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={700}>{t("providerCatalog.routing.title")}</Text>
          <Text size="sm" c="dimmed">{t("providerCatalog.routing.description")}</Text>
        </div>
        <Button variant="subtle" leftSection={<RefreshCw size={15} />} loading={state.loading} onClick={() => void state.refresh()}>
          {t("providerCatalog.routing.refresh")}
        </Button>
      </Group>

      {state.errorCode && (
        <Alert color="red" withCloseButton onClose={state.clearError}>
          {errorMessage}
        </Alert>
      )}

      <Accordion multiple variant="separated" defaultValue={["service"]}>
        <Accordion.Item value="service">
          <Accordion.Control icon={<Server size={16} />}>{t("providerCatalog.routing.service.title")}</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Switch
                label={t("providerCatalog.routing.service.enabled")}
                description={t("providerCatalog.routing.service.enabledDescription")}
                checked={serviceRunning}
                disabled={!service || busy}
                onChange={(event) => void state.setServiceEnabled(event.currentTarget.checked)}
              />
              <Switch
                label={t("providerCatalog.routing.takeover.currentHome", { app: appLabel })}
                description={homeIdentity?.identity ?? t("providerCatalog.routing.takeover.homeUnavailable")}
                checked={hasTakeover}
                disabled={!homeIdentity || !serviceRunning || busy}
                onChange={(event) => void handleTakeoverChange(event.currentTarget.checked)}
              />
              {hasTakeover && (
                <Switch
                  label={t("providerCatalog.failover.enabled")}
                  description={t("providerCatalog.routing.service.failoverDescription")}
                  checked={failover?.config.autoFailoverEnabled ?? false}
                  disabled={
                    !failover
                      || busy
                      || (!failover.config.autoFailoverEnabled && !runtimeAvailable)
                  }
                  onChange={(event) => void state.setFailoverEnabled(appType, event.currentTarget.checked)}
                />
              )}
              <Switch
                label={t("providerCatalog.routing.service.usageLogging")}
                checked={service?.usageLoggingEnabled ?? false}
                disabled={!service || busy}
                onChange={(event) => service && void state.setQuickControls({
                  showLocalQuickControl: service.showLocalQuickControl,
                  showFailoverQuickControl: service.showFailoverQuickControl,
                  usageLoggingEnabled: event.currentTarget.checked,
                })}
              />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="listener">
          <Accordion.Control icon={<Route size={16} />}>{t("providerCatalog.routing.listener.title")}</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <NumberInput
                label={t("providerCatalog.routing.listener.preferredPort")}
                description={t("providerCatalog.routing.listener.preferredPortDescription")}
                min={1024}
                max={65535}
                value={portDraft}
                disabled={busy || serviceRunning || hasAnyTakeover}
                onChange={(value) => setPortDraft(String(value ?? ""))}
              />
              <Group gap="xs">
                <Button
                  size="sm"
                  variant="light"
                  loading={state.action === "preferred-port"}
                  disabled={busy || serviceRunning || hasAnyTakeover || !validPort || !portChanged}
                  onClick={() => void state.setPreferredPort(port)}
                >
                  {t("providerCatalog.routing.listener.savePort")}
                </Button>
                <Text size="sm" c="dimmed">{t("providerCatalog.routing.listener.actual", { port: daemon?.actualPort ?? service?.actualPort ?? t("providerCatalog.routing.unknownValue") })}</Text>
              </Group>
              <Text size="sm" c="dimmed">{t("providerCatalog.routing.listener.addresses", { addresses: daemon?.listenerAddresses.join(", ") || t("providerCatalog.routing.unknownValue") })}</Text>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="runtime">
          <Accordion.Control icon={<Server size={16} />}>{t("providerCatalog.routing.runtime.title")}</Accordion.Control>
          <Accordion.Panel>
            <Stack gap={4}>
              <Text size="sm">{t("providerCatalog.routing.runtime.status", { status: daemon?.status ?? t("providerCatalog.routing.unknownValue") })}</Text>
              <Text size="sm">{daemon?.connected ? t("providerCatalog.routing.runtime.connected") : t("providerCatalog.routing.runtime.disconnected")}</Text>
              <Text size="sm" c="dimmed">{t("providerCatalog.routing.runtime.boundary")}</Text>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        {hasTakeover && <NativeProviderFailoverSection appType={appType} state={state} />}
        <NativeProviderGlobalProxySection />
        <NativeProviderRectifierSection state={state} />
      </Accordion>
    </Stack>
  );
}
