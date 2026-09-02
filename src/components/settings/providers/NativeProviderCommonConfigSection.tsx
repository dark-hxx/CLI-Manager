import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Card, Collapse, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { AlertTriangle, Check, ChevronDown, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { NativeProviderButton as Button } from "./NativeProviderButton";
import type { NativeProviderAppType } from "./nativeProviderTypes";
import type { UseNativeProviderCommonConfigResult } from "./useNativeProviderCommonConfig";
import { NativeProviderCodeEditor } from "./NativeProviderCodeEditor";

interface NativeProviderCommonConfigSectionProps {
  appType: NativeProviderAppType;
  state: UseNativeProviderCommonConfigResult;
}

const ERROR_TRANSLATIONS: Partial<Record<string, TranslationKey>> = {
  provider_common_config_required: "providerCatalog.commonConfig.errors.required",
  provider_common_config_invalid_json: "providerCatalog.commonConfig.errors.invalidJson",
  provider_common_config_must_be_object: "providerCatalog.commonConfig.errors.mustBeObject",
  provider_common_config_invalid_toml: "providerCatalog.commonConfig.errors.invalidToml",
  provider_common_config_format_invalid: "providerCatalog.commonConfig.errors.formatInvalid",
};

function appTypeLabel(appType: NativeProviderAppType, t: (key: TranslationKey) => string): string {
  if (appType === "claude") return t("providerCatalog.appType.claude");
  if (appType === "codex") return t("providerCatalog.appType.codex");
  return t("providerCatalog.appType.grokbuild");
}

export function NativeProviderCommonConfigSection({ appType, state }: NativeProviderCommonConfigSectionProps) {
  const { t } = useI18n();
  const [opened, setOpened] = useState(false);
  const [validated, setValidated] = useState(false);
  useEffect(() => {
    setOpened(false);
    setValidated(false);
  }, [appType]);
  const format = state.document?.format ?? (appType === "claude" ? "json" : "toml");
  const validation = useMemo(() => {
    if (!state.draft.trim()) return "required" as const;
    if (format === "toml") return "valid" as const;
    try {
      const parsed: unknown = JSON.parse(state.draft);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? "valid" as const
        : "object" as const;
    } catch {
      return "invalid" as const;
    }
  }, [format, state.draft]);

  const localError = validation === "required"
    ? t("providerCatalog.commonConfig.errors.required")
    : validation === "invalid"
      ? t("providerCatalog.commonConfig.errors.invalidJson")
      : validation === "object"
        ? t("providerCatalog.commonConfig.errors.mustBeObject")
        : null;
  const serverError = state.errorCode
    ? t(ERROR_TRANSLATIONS[state.errorCode] ?? "providerCatalog.errors.generic")
    : null;
  const serverErrorId = `provider-common-config-server-error-${appType}`;
  const localErrorId = `provider-common-config-local-error-${appType}`;
  const describedBy = [
    serverError ? serverErrorId : null,
    localError ? localErrorId : null,
  ].filter(Boolean).join(" ") || undefined;
  const validationError = serverError || localError;
  const editorLabel = t(format === "json"
    ? "providerCatalog.commonConfig.editorLabelJson"
    : "providerCatalog.commonConfig.editorLabelToml");

  return (
    <Card withBorder radius="lg" padding="sm" className="min-w-0 overflow-hidden border-border/70 bg-surface-container-low">
      <Stack gap="sm">
        {/* 收成单行：折叠态只占一行高度。标题区整体作为展开触发器，
            说明与优先级文案移入展开内容，避免收起时仍堆三行文字。 */}
        <Group justify="space-between" align="center" wrap="nowrap" gap="xs" className="min-w-0">
          <UnstyledButton
            className="ui-focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 text-left"
            aria-expanded={opened}
            aria-controls={`provider-common-config-editor-${appType}`}
            onClick={() => setOpened((current) => !current)}
          >
            <ChevronDown
              size={16}
              className={`shrink-0 text-text-muted transition-transform ${opened ? "rotate-180" : ""}`}
            />
            <Text size="sm" fw={600} truncate className="min-w-0">
              {t("providerCatalog.commonConfig.title", { appType: appTypeLabel(appType, t) })}
            </Text>
            <Badge size="xs" variant="light" color="gray" className="shrink-0">{format.toUpperCase()}</Badge>
          </UnstyledButton>
          <Group gap={4} wrap="nowrap" className="shrink-0">
            <Button
              size="compact-sm"
              variant="subtle"
              color="gray"
              loading={state.loading}
              aria-label={t("common.refresh")}
              onClick={() => {
                setValidated(false);
                void state.refresh();
              }}
            >
              <RefreshCw size={15} />
            </Button>
            <Button
              size="compact-sm"
              color="cliPrimary"
              leftSection={state.dirty ? <Save size={15} /> : <Check size={15} />}
              loading={state.saving}
              disabled={state.loading || !state.dirty || validation !== "valid"}
              onClick={() => void state.save().then(() => setValidated(true)).catch(() => setValidated(false))}
            >
              {t(state.dirty ? "common.save" : "providerCatalog.commonConfig.saved")}
            </Button>
          </Group>
        </Group>

        {serverError && (
          <Alert id={serverErrorId} color="red" variant="light" icon={<AlertTriangle size={16} />} withCloseButton onClose={state.clearError}>
            {serverError}
          </Alert>
        )}
        {localError && <Text id={localErrorId} size="xs" c="red" role="alert">{localError}</Text>}
        {/* keepMounted={false} 必需：默认的 keepMounted 走 React <Activity mode="hidden">，
            折叠时只销毁 effect 而保留 state/ref，Monaco 实例被 dispose 后 ref 仍在，
            展开时会对已销毁实例调用 setModel 并抛 InstantiationService has been disposed。 */}
        <Collapse expanded={opened} keepMounted={false} id={`provider-common-config-editor-${appType}`}>
          <Stack gap="xs">
            <Text size="xs" c="dimmed">{t("providerCatalog.commonConfig.description")}</Text>
            <div aria-describedby={describedBy}>
              <NativeProviderCodeEditor
                format={format === "json" ? "json" : "toml"}
                value={state.draft}
                path={`native-provider-common-${appType}.${format}`}
                ariaLabel={editorLabel}
                invalid={Boolean(validationError)}
                readOnly={state.loading || state.saving || state.validating}
                onChange={(value) => {
                  setValidated(false);
                  state.setDraft(value);
                }}
              />
            </div>
            <Group justify="space-between" align="center" wrap="wrap">
              <Text size="xs" c="dimmed">{t(format === "json"
                ? "providerCatalog.commonConfig.editorHintJson"
                : "providerCatalog.commonConfig.editorHintToml")}</Text>
              <Group gap="xs" wrap="wrap">
                {validated && !validationError && (
                  <Text size="xs" c="green" role="status">
                    <ShieldCheck size={14} className="mr-1 inline-block" />
                    {t("providerCatalog.commonConfig.validationPassed")}
                  </Text>
                )}
                <Button
                  size="compact-sm"
                  variant="light"
                  color="cliPrimary"
                  loading={state.validating}
                  disabled={state.loading || state.saving || validation !== "valid"}
                  onClick={() => void state.validate().then(() => setValidated(true)).catch(() => setValidated(false))}
                >
                  {t("providerCatalog.commonConfig.validate")}
                </Button>
              </Group>
            </Group>
            <Text size="xs" c="dimmed">{t("providerCatalog.commonConfig.precedence", { appType: appTypeLabel(appType, t) })}</Text>
          </Stack>
        </Collapse>
      </Stack>
    </Card>
  );
}
