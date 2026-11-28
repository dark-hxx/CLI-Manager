import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  Group,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { ChevronDown, Play } from "lucide-react";
import { useI18n } from "../../../shared/i18n/index";
import {
  PROXY_PROTOCOL_OPTIONS,
  mergeNoProxy,
  tryParsePastedProxyUrl,
  type ProxyProtocol,
  type ProxyUrlParts,
} from "../../../shared/lib/proxySettings";

export interface ProxyEndpointTestState {
  status: "idle" | "testing" | "ok" | "error";
  message?: string;
}

interface ProxyEndpointFieldsProps {
  parts: ProxyUrlParts;
  noProxy: string;
  onPartsChange: (next: ProxyUrlParts) => void;
  onNoProxyChange: (next: string) => void;
  error?: string;
  testState?: ProxyEndpointTestState;
  onTestConnection?: () => void;
  secondaryAction?: ReactNode;
  footerAction?: ReactNode;
}

export function ProxyEndpointFields({
  parts,
  noProxy,
  onPartsChange,
  onNoProxyChange,
  error,
  testState,
  onTestConnection,
  secondaryAction,
  footerAction,
}: ProxyEndpointFieldsProps) {
  const { t } = useI18n();
  const hasAuth = Boolean(parts.username || parts.password);
  const [authOpen, setAuthOpen] = useState(hasAuth);

  useEffect(() => {
    if (parts.username || parts.password) {
      setAuthOpen(true);
    }
  }, [parts.password, parts.username]);

  const handleHostChange = (rawValue: string) => {
    const pasted = tryParsePastedProxyUrl(rawValue);
    if (pasted) {
      onPartsChange(pasted);
      if (pasted.username || pasted.password) {
        setAuthOpen(true);
      }
      return;
    }
    onPartsChange({ ...parts, host: rawValue });
  };

  return (
    <Stack gap="sm" w="100%">
      <Group gap="xs" align="flex-end" wrap="wrap" w="100%">
        <Select
          label={t("settings.proxy.fields.protocol")}
          value={parts.scheme}
          allowDeselect={false}
          data={PROXY_PROTOCOL_OPTIONS.map((opt) => ({
            value: opt.value,
            label: opt.label,
          }))}
          onChange={(value) => {
            if (!value) return;
            onPartsChange({ ...parts, scheme: value as ProxyProtocol });
          }}
          style={{ width: 118 }}
        />

        <TextInput
          label={t("settings.proxy.fields.host")}
          value={parts.host}
          onChange={(event) => handleHostChange(event.currentTarget.value)}
          placeholder="127.0.0.1"
          classNames={{ input: "settings-input proxy-mono-input" }}
          style={{ flex: "1 1 180px", minWidth: 160 }}
        />

        <TextInput
          label={t("settings.proxy.fields.port")}
          value={parts.port}
          inputMode="numeric"
          onChange={(event) =>
            onPartsChange({
              ...parts,
              port: event.currentTarget.value.replace(/[^\d]/g, ""),
            })
          }
          placeholder="7897"
          classNames={{ input: "settings-input proxy-mono-input" }}
          style={{ width: 92 }}
        />

        <UnstyledButton
          type="button"
          className="proxy-auth-toggle"
          data-has-auth={hasAuth && !authOpen ? "true" : undefined}
          onClick={() => setAuthOpen((prev) => !prev)}
          aria-expanded={authOpen}
        >
          {hasAuth && !authOpen && <span className="proxy-auth-dot" aria-hidden="true" />}
          <span>
            {hasAuth && !authOpen
              ? t("settings.proxy.fields.authConfigured")
              : t("settings.proxy.fields.authToggle")}
          </span>
          <ChevronDown
            size={14}
            aria-hidden="true"
            style={{
              transform: authOpen ? "rotate(180deg)" : undefined,
              transition: "transform 150ms ease",
            }}
          />
        </UnstyledButton>
      </Group>

      {authOpen && (
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
          <TextInput
            label={t("settings.proxy.fields.username")}
            value={parts.username}
            onChange={(event) =>
              onPartsChange({ ...parts, username: event.currentTarget.value })
            }
            placeholder={t("settings.proxy.fields.usernamePlaceholder")}
            autoComplete="off"
          />
          <PasswordInput
            label={t("settings.proxy.fields.password")}
            value={parts.password}
            onChange={(event) =>
              onPartsChange({ ...parts, password: event.currentTarget.value })
            }
            placeholder={t("settings.proxy.fields.passwordPlaceholder")}
            autoComplete="off"
          />
        </SimpleGrid>
      )}

      <TextInput
        label={t("settings.proxy.fields.noProxy")}
        description={t("settings.proxy.fields.noProxyHint", {
          effective: mergeNoProxy(noProxy),
        })}
        value={noProxy}
        onChange={(event) => onNoProxyChange(event.currentTarget.value)}
        placeholder="localhost,127.0.0.1,.corp.local"
        classNames={{ input: "settings-input proxy-mono-input" }}
      />

      {error && (
        <Text size="xs" style={{ color: "var(--danger)" }}>
          {error}
        </Text>
      )}

      {(onTestConnection || secondaryAction || footerAction || (testState && testState.status !== "idle")) && (
        <Group justify="space-between" align="center" gap="xs" wrap="wrap" className="proxy-fields-footer">
          <Group gap={6} align="center" style={{ minHeight: 24 }}>
            {testState && testState.status !== "idle" && testState.message && (
              <>
                <span
                  aria-hidden="true"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    backgroundColor:
                      testState.status === "ok"
                        ? "var(--success)"
                        : testState.status === "error"
                          ? "var(--danger)"
                          : "var(--settings-muted)",
                  }}
                />
                <Text
                  size="xs"
                  style={{
                    color:
                      testState.status === "ok"
                        ? "var(--success)"
                        : testState.status === "error"
                          ? "var(--danger)"
                          : "var(--settings-muted)",
                  }}
                >
                  {testState.message}
                </Text>
              </>
            )}
          </Group>

          <Group gap="xs">
            {onTestConnection && (
              <Button
                variant="default"
                size="xs"
                loading={testState?.status === "testing"}
                leftSection={<Play size={13} />}
                onClick={onTestConnection}
              >
                {t("settings.proxy.actions.testConnection")}
              </Button>
            )}
            {secondaryAction}
            {footerAction}
          </Group>
        </Group>
      )}
    </Stack>
  );
}
