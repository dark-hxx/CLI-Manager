import { useEffect, useState } from "react";
import { Alert, Group, Modal, Stack, Switch, Text, TextInput, Textarea } from "@mantine/core";
import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { NativeProviderButton as Button } from "./NativeProviderButton";
import { NativeClaudeConfigSection } from "./NativeClaudeConfigSection";
import { NativeProviderAdvancedConfigSection } from "./NativeProviderAdvancedConfigSection";
import { NativeProviderCodeEditor } from "./NativeProviderCodeEditor";
import {
  defaultNativeProviderAdvancedConfig,
  generateNativeProviderConfigDocument,
  isEmptyNativeProviderConfigDocument,
  isValidNativeProviderAdvancedConfig,
  nativeProviderAdvancedConfigFromSettings,
  settingsConfigWithAdvanced,
  type NativeProviderAdvancedConfig,
} from "./nativeProviderAdvancedConfig";
import {
  isValidProviderConfigDocument,
  nativeProviderConfigFormat,
  settingsConfigFromProviderDocument,
  providerConfigDocumentFromSettings,
} from "./nativeProviderConfigView";
import type {
  NativeProviderAppType,
  NativeProviderCard,
  NativeProviderClaudeConfig,
  NativeProviderCreateInput,
  NativeProviderDetail,
  NativeProviderUpdateInput,
} from "./nativeProviderTypes";
import { useNativeProviderModels } from "./useNativeProviderModels";

export interface NativeProviderFormValues {
  name: string;
  baseUrl: string;
  model: string;
  apiFormat: string;
  websiteUrl: string;
  category: string;
  notes: string;
  commonConfigEnabled: boolean;
  claudeConfig: NativeProviderClaudeConfig;
  providerConfig: string;
  advanced: NativeProviderAdvancedConfig;
}

interface NativeProviderFormModalProps {
  opened: boolean;
  mode: "create" | "edit";
  appType: NativeProviderAppType;
  provider: NativeProviderCard | null;
  providerDetail: NativeProviderDetail | null;
  loading: boolean;
  onClose: () => void;
  onSubmit: (input: NativeProviderCreateInput | NativeProviderUpdateInput) => Promise<void>;
}

const EMPTY_VALUES: NativeProviderFormValues = {
  name: "",
  baseUrl: "",
  model: "",
  apiFormat: "",
  websiteUrl: "",
  category: "",
  notes: "",
  commonConfigEnabled: true,
  providerConfig: "{}",
  advanced: defaultNativeProviderAdvancedConfig(),
  claudeConfig: {
    apiFormat: "anthropic",
    apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    isFullUrl: false,
    model: "",
    defaultHaikuModel: "",
    defaultHaikuModelName: "",
    defaultSonnetModel: "",
    defaultSonnetModelName: "",
    defaultOpusModel: "",
    defaultOpusModelName: "",
    defaultFableModel: "",
    defaultFableModelName: "",
    subagentModel: "",
  },
};

function valuesFromProvider(
  appType: NativeProviderAppType,
  provider: NativeProviderCard | null,
  detail: NativeProviderDetail | null,
): NativeProviderFormValues {
  const rawSettingsConfig = detail?.settingsConfig ?? "{}";
  if (!provider) {
    const advanced = nativeProviderAdvancedConfigFromSettings(rawSettingsConfig);
    const claudeConfig = EMPTY_VALUES.claudeConfig;
    return {
      ...EMPTY_VALUES,
      claudeConfig,
      advanced,
      providerConfig: providerConfigDocumentFromSettings(
        appType,
        rawSettingsConfig,
        { claude: claudeConfig },
        advanced,
      ),
    };
  }
  const claudeConfig = detail?.claudeConfig ?? EMPTY_VALUES.claudeConfig;
  const baseUrl = provider.baseUrl ?? "";
  const model = provider.model ?? claudeConfig.model;
  const advanced = nativeProviderAdvancedConfigFromSettings(rawSettingsConfig, provider.apiFormat);
  const apiFormat = appType === "claude"
    ? provider.apiFormat ?? claudeConfig.apiFormat
    : provider.apiFormat ?? advanced.wireApi;
  return {
    name: provider.name,
    baseUrl,
    model,
    apiFormat,
    websiteUrl: provider.websiteUrl ?? "",
    category: provider.category ?? "",
    notes: provider.notes ?? "",
    commonConfigEnabled: provider.commonConfigEnabled,
    claudeConfig: { ...EMPTY_VALUES.claudeConfig, ...claudeConfig },
    advanced,
    providerConfig: providerConfigDocumentFromSettings(
      appType,
      rawSettingsConfig,
      {
        baseUrl,
        model,
        apiFormat,
        claude: claudeConfig,
      },
      advanced,
    ),
  };
}

function hasStoredProviderConfig(appType: NativeProviderAppType, settingsConfig: string): boolean {
  if (appType === "claude") {
    return !isEmptyNativeProviderConfigDocument(appType, providerConfigDocumentFromSettings(appType, settingsConfig));
  }
  try {
    const parsed: unknown = JSON.parse(settingsConfig);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const config = (parsed as { config?: unknown }).config;
    return typeof config === "string" && config.trim().length > 0;
  } catch {
    return false;
  }
}

export function NativeProviderFormModal({
  opened,
  mode,
  appType,
  provider,
  providerDetail,
  loading,
  onClose,
  onSubmit,
}: NativeProviderFormModalProps) {
  const { t } = useI18n();
  const [values, setValues] = useState<NativeProviderFormValues>(EMPTY_VALUES);
  const [nameError, setNameError] = useState(false);
  const [providerConfigManual, setProviderConfigManual] = useState(false);
  const { models: availableModels, loading: fetchingModels, error: modelFetchError, fetchModels } = useNativeProviderModels();
  const configFormat = nativeProviderConfigFormat(appType);
  const configValid = isValidProviderConfigDocument(appType, values.providerConfig);
  const advancedConfigValid = appType === "claude" || isValidNativeProviderAdvancedConfig(values.advanced);
  const fetchProviderModels = () => fetchModels({
    appType,
    providerId: provider?.id,
    baseUrl: values.baseUrl,
    claude: appType === "claude" ? values.claudeConfig : undefined,
    apiFormat: appType === "claude" ? undefined : values.advanced.wireApi,
  });

  useEffect(() => {
    if (opened) {
      const nextValues = valuesFromProvider(appType, provider, providerDetail);
      setValues(nextValues);
      setProviderConfigManual(hasStoredProviderConfig(appType, providerDetail?.settingsConfig ?? "{}"));
      setNameError(false);
    }
  }, [appType, opened, provider, providerDetail]);

  const updateValue = <K extends keyof NativeProviderFormValues>(key: K, value: NativeProviderFormValues[K]) => {
    setValues((current) => {
      const next = { ...current, [key]: value };
      if (
        !providerConfigManual
        && (key === "baseUrl" || key === "model" || key === "apiFormat")
      ) {
        next.providerConfig = generateNativeProviderConfigDocument(appType, {
          baseUrl: next.baseUrl,
          model: next.model,
          apiFormat: next.apiFormat,
          claude: next.claudeConfig,
        }, next.advanced);
      }
      return next;
    });
    if (key === "name" && typeof value === "string" && value.trim()) setNameError(false);
  };

  const updateClaudeConfig = (claudeConfig: NativeProviderClaudeConfig) => {
    setValues((current) => {
      const next = { ...current, claudeConfig, model: claudeConfig.model, apiFormat: claudeConfig.apiFormat };
      if (!providerConfigManual) {
        next.providerConfig = generateNativeProviderConfigDocument(appType, {
          baseUrl: next.baseUrl,
          model: next.model,
          apiFormat: next.apiFormat,
          claude: claudeConfig,
        }, next.advanced);
      }
      return next;
    });
  };

  const updateAdvanced = (advanced: NativeProviderAdvancedConfig) => {
    setValues((current) => {
      const next = { ...current, advanced, apiFormat: advanced.wireApi };
      if (!providerConfigManual) {
        next.providerConfig = generateNativeProviderConfigDocument(appType, {
          baseUrl: next.baseUrl,
          model: next.model,
          apiFormat: next.apiFormat,
          claude: next.claudeConfig,
        }, advanced);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    const name = values.name.trim();
    if (!name) {
      setNameError(true);
      return;
    }
    if (!configValid || !advancedConfigValid) return;

    const model = appType === "claude" ? values.claudeConfig.model : values.model.trim();
    const apiFormat = appType === "claude" ? values.claudeConfig.apiFormat : values.apiFormat.trim();
    const documentSettingsConfig = settingsConfigFromProviderDocument(
      appType,
      values.providerConfig,
      providerDetail?.settingsConfig,
    );
    const settingsConfig = appType === "claude"
      ? documentSettingsConfig
      : settingsConfigWithAdvanced(documentSettingsConfig, values.advanced);
    const common = {
      appType,
      name,
      settingsConfig,
      baseUrl: values.baseUrl.trim() || undefined,
      model: model.trim() || undefined,
      apiFormat: apiFormat || undefined,
      websiteUrl: values.websiteUrl.trim() || undefined,
      category: values.category.trim() || undefined,
      notes: values.notes.trim() || undefined,
      commonConfigEnabled: values.commonConfigEnabled,
      claudeConfig: appType === "claude" ? values.claudeConfig : undefined,
    };

    if (mode === "edit" && provider) {
      await onSubmit({
        ...common,
        baseUrl: values.baseUrl.trim(),
        model: model.trim(),
        apiFormat,
        providerId: provider.id,
      });
      return;
    }

    await onSubmit(common);
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t(mode === "create" ? "providerCatalog.createTitle" : "providerCatalog.editTitle")}
      centered
      size="xl"
    >
      <Stack gap="sm">
        <TextInput
          label={t("providerCatalog.nameLabel")}
          placeholder={t("providerCatalog.namePlaceholder")}
          value={values.name}
          error={nameError ? t("providerCatalog.nameRequired") : undefined}
          required
          autoFocus
          onChange={(event) => updateValue("name", event.currentTarget.value)}
        />
        <Group grow align="flex-start">
          <TextInput
            label={t(appType === "codex" ? "providerCatalog.requestUrlLabel" : "providerCatalog.baseUrlLabel")}
            placeholder={t("providerCatalog.baseUrlPlaceholder")}
            value={values.baseUrl}
            onChange={(event) => updateValue("baseUrl", event.currentTarget.value)}
          />
          <TextInput
            label={t("providerCatalog.modelLabel")}
            placeholder={t("providerCatalog.modelPlaceholder")}
            value={appType === "claude" ? values.claudeConfig.model : values.model}
            onChange={(event) => {
              if (appType === "claude") {
                updateClaudeConfig({ ...values.claudeConfig, model: event.currentTarget.value });
              } else {
                updateValue("model", event.currentTarget.value);
              }
            }}
          />
        </Group>
        <Group grow align="flex-start">
          <TextInput
            label={t("providerCatalog.websiteLabel")}
            placeholder={t("providerCatalog.websitePlaceholder")}
            value={values.websiteUrl}
            onChange={(event) => updateValue("websiteUrl", event.currentTarget.value)}
          />
          <TextInput
            label={t("providerCatalog.categoryLabel")}
            placeholder={t("providerCatalog.categoryPlaceholder")}
            value={values.category}
            onChange={(event) => updateValue("category", event.currentTarget.value)}
          />
        </Group>
        {appType === "claude" && (
          <NativeClaudeConfigSection
            value={values.claudeConfig}
            onChange={updateClaudeConfig}
            disabled={loading}
            availableModels={availableModels}
            fetchingModels={fetchingModels}
            modelFetchError={modelFetchError}
            onFetchModels={fetchProviderModels}
            canFetchModels={Boolean(provider?.id)}
          />
        )}
        {appType !== "claude" && (
          <NativeProviderAdvancedConfigSection
            appType={appType}
            value={values.advanced}
            onChange={updateAdvanced}
            disabled={loading}
            availableModels={availableModels}
            fetchingModels={fetchingModels}
            modelFetchError={modelFetchError}
            onFetchModels={fetchProviderModels}
            canFetchModels={Boolean(provider?.id)}
          />
        )}
        {!advancedConfigValid && (
          <Alert color="red" variant="light" icon={<AlertTriangle size={16} />}>
            {t("providerCatalog.compatibleAdvanced.invalid")}
          </Alert>
        )}
        <Stack gap="xs">
          <Text fw={600}>{t("providerCatalog.providerConfig.title")}</Text>
          <Text size="xs" c="dimmed">{configFormat.toUpperCase()}</Text>
          <NativeProviderCodeEditor
            format={configFormat}
            value={values.providerConfig}
            path={`native-provider-form-${appType}-${provider?.id ?? "new"}`}
            ariaLabel={t("providerCatalog.providerConfig.editorLabel", { format: configFormat.toUpperCase() })}
            height="220px"
            invalid={!configValid}
            readOnly={loading}
            onChange={(value) => {
              setProviderConfigManual(true);
              updateValue("providerConfig", value);
            }}
          />
          {!configValid && (
            <Alert color="red" variant="light" icon={<AlertTriangle size={16} />}>
              {t("providerCatalog.providerConfig.invalid")}
            </Alert>
          )}
          <Text size="xs" c="dimmed">
            {t("providerCatalog.providerConfig.description", { format: configFormat.toUpperCase() })}
          </Text>
        </Stack>
        <Textarea
          label={t("providerCatalog.notesLabel")}
          placeholder={t("providerCatalog.notesPlaceholder")}
          minRows={3}
          autosize
          value={values.notes}
          onChange={(event) => updateValue("notes", event.currentTarget.value)}
        />
        <Switch
          color="cliPrimary"
          label={t("providerCatalog.commonConfigLabel")}
          description={t("providerCatalog.commonConfigDescription")}
          checked={values.commonConfigEnabled}
          onChange={(event) => updateValue("commonConfigEnabled", event.currentTarget.checked)}
        />
        <Group
          justify="flex-end"
          className="sticky bottom-0 z-[1000] border-t border-border/60 py-3"
          style={{
            marginInline: "calc(var(--mb-padding, var(--mantine-spacing-md)) * -1)",
            marginBottom: "calc(var(--mb-padding, var(--mantine-spacing-md)) * -1)",
            paddingInline: "var(--mb-padding, var(--mantine-spacing-md))",
            backgroundColor: "var(--mantine-color-body)",
          }}
        >
          <Button variant="subtle" color="gray" onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            color="cliPrimary"
            loading={loading}
            disabled={loading || !configValid || !advancedConfigValid}
            onClick={() => void handleSubmit().catch(() => undefined)}
          >
            {t("common.save")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
