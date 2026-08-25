import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ActionIcon,
  Alert,
  Autocomplete,
  Group,
  Menu,
  Modal,
  PasswordInput,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { AlertTriangle, Check, KeyRound, LoaderCircle } from "lucide-react";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { useModelPricingStore } from "@/stores/modelPricingStore";
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
import {
  buildModelCandidates,
  modelCandidatesToSelectData,
  modelOptionsFilter,
  priceTableModelsFor,
  type ModelCandidateGroupId,
} from "./providerModelCandidates";
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

/**
 * 弹框里维护的密钥草稿。
 *
 * 不并入 `NativeProviderFormValues`：密钥不参与 `providerConfig` 文档生成，
 * 也不能被写进供应商配置文本里。
 */
export interface NativeProviderFormKeyDraft {
  /** 输入框当前值（明文）。空串表示未填或已清空。 */
  apiKey: string;
  /** 编辑态下用户当前选中的 key；新增态、或供应商还没有任何 key 时为 null。 */
  selectedKeyId: string | null;
  /** 相对打开弹框时回显的基线是否发生变化——决定要不要写回，避免误触发「密钥已变更」。 */
  changed: boolean;
}

interface NativeProviderFormModalProps {
  opened: boolean;
  mode: "create" | "edit";
  appType: NativeProviderAppType;
  provider: NativeProviderCard | null;
  providerDetail: NativeProviderDetail | null;
  /** 同 appType 的其它供应商，用于兜底模型候选的第四路来源。 */
  peerProviders?: NativeProviderCard[];
  loading: boolean;
  onClose: () => void;
  onSubmit: (
    input: NativeProviderCreateInput | NativeProviderUpdateInput,
    keyDraft: NativeProviderFormKeyDraft,
  ) => Promise<void>;
}

/** 候选分组 id → i18n key。分组文案留在组件侧，`buildModelCandidates` 只产出稳定 id。 */
const MODEL_GROUP_LABEL_KEYS: Record<ModelCandidateGroupId, TranslationKey> = {
  fetched: "providerCatalog.models.groupFetched",
  configured: "providerCatalog.models.groupConfigured",
  priceTable: "providerCatalog.models.groupPriceTable",
  peerProviders: "providerCatalog.models.groupPeerProviders",
};

const EMPTY_VALUES: NativeProviderFormValues = {  name: "",
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
  peerProviders = [],
  loading,
  onClose,
  onSubmit,
}: NativeProviderFormModalProps) {
  const { t } = useI18n();
  const [values, setValues] = useState<NativeProviderFormValues>(EMPTY_VALUES);
  const [nameError, setNameError] = useState(false);
  const [providerConfigManual, setProviderConfigManual] = useState(false);
  // 密钥草稿：apiKey 是输入框现值，revealedBaseline 是打开/切换时回显的原值。
  // 少了 baseline 就无法区分「用户没动」与「用户改了」，会导致每次保存都误报密钥变更。
  const [apiKey, setApiKey] = useState("");
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [revealedBaseline, setRevealedBaseline] = useState("");
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState(false);
  const {
    models: availableModels,
    loading: fetchingModels,
    error: modelFetchError,
    fetchModels,
    reset: resetFetchedModels,
  } = useNativeProviderModels();
  const modelPrices = useModelPricingStore((state) => state.modelPrices);

  // 取模型结果只属于它来自的那个供应商 + 那个地址。本弹框常挂载（Modal 关闭时组件不卸载），
  // 不显式失效就会把 Grok 拉到的列表带到 Claude 的新建表单里，还挂着「接口返回」的分组名。
  useEffect(() => {
    resetFetchedModels();
  }, [appType, opened, provider?.id, values.baseUrl, resetFetchedModels]);

  const modelCandidates = useMemo(() => {
    // 「已配置」取当前表单里所有模型字段：这样即使接口拉不到，用户也总能选回自己配过的值。
    const configured = appType === "claude"
      ? [
          values.claudeConfig.model,
          values.claudeConfig.defaultSonnetModel,
          values.claudeConfig.defaultOpusModel,
          values.claudeConfig.defaultFableModel,
          values.claudeConfig.defaultHaikuModel,
          values.claudeConfig.subagentModel,
        ]
      : [values.model];
    return buildModelCandidates({
      fetched: availableModels,
      configured: [...configured, provider?.model ?? ""],
      priceTableModels: priceTableModelsFor(appType, Object.keys(modelPrices)),
      peerProviderModels: peerProviders
        .filter((item) => item.id !== provider?.id)
        .map((item) => item.model ?? ""),
    });
  }, [appType, availableModels, modelPrices, peerProviders, provider, values.claudeConfig, values.model]);

  const modelSelectData = useMemo(
    () => modelCandidatesToSelectData(modelCandidates, (id) => t(MODEL_GROUP_LABEL_KEYS[id])),
    [modelCandidates, t],
  );
  const configFormat = nativeProviderConfigFormat(appType);
  const configValid = isValidProviderConfigDocument(appType, values.providerConfig);
  const advancedConfigValid = appType === "claude" || isValidNativeProviderAdvancedConfig(values.advanced);
  const providerKeys = providerDetail?.keys ?? [];
  const hasUsableStoredKey = providerKeys.some((item) => item.isActive && item.enabled);
  // 表单里填了密钥就能直接探测；否则退回到已存的激活密钥。两者皆无时后端拿不到密钥。
  const canFetchModels = Boolean(values.baseUrl.trim()) && (Boolean(apiKey.trim()) || hasUsableStoredKey);
  const fetchProviderModels = () => fetchModels({
    appType,
    providerId: provider?.id,
    baseUrl: values.baseUrl,
    apiKey,
    claude: appType === "claude" ? values.claudeConfig : undefined,
    apiFormat: appType === "claude" ? undefined : values.advanced.wireApi,
  });

  useEffect(() => {
    if (opened) {
      const nextValues = valuesFromProvider(appType, provider, providerDetail);
      setValues(nextValues);
      setProviderConfigManual(hasStoredProviderConfig(appType, providerDetail?.settingsConfig ?? "{}"));
      setNameError(false);
      // 编辑态默认落在激活密钥上；新增态从空白开始。
      const activeKey = providerDetail?.keys.find((item) => item.isActive) ?? null;
      setSelectedKeyId(mode === "edit" ? activeKey?.id ?? null : null);
      setApiKey("");
      setRevealedBaseline("");
      setRevealError(false);
    }
  }, [appType, mode, opened, provider, providerDetail]);

  // 打开弹框或切换所选密钥时回显明文。
  // 切换只是换查看对象，不调 provider_key_activate——激活状态由「API 密钥」Tab 负责。
  useEffect(() => {
    if (!opened || mode !== "edit" || !provider || !selectedKeyId) return;
    let cancelled = false;
    setRevealing(true);
    setRevealError(false);
    const loadKey = async () => {
      try {
        const revealed = await invoke<string>("provider_key_reveal", {
          appType,
          providerId: provider.id,
          keyId: selectedKeyId,
        });
        if (cancelled) return;
        setApiKey(revealed);
        setRevealedBaseline(revealed);
      } catch {
        if (cancelled) return;
        // 回显失败（如 keyring 不可用）不应堵住其余字段的编辑。
        setRevealError(true);
        setApiKey("");
        setRevealedBaseline("");
      } finally {
        if (!cancelled) setRevealing(false);
      }
    };
    void loadKey();
    return () => {
      cancelled = true;
    };
  }, [appType, mode, opened, provider, selectedKeyId]);

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

  const selectedKey = providerKeys.find((item) => item.id === selectedKeyId) ?? null;

  // 密钥字段作为 slot 传进「高级选项」区渲染：两个 appType 分支共用同一份实现，不重复。
  // 输入框占满整行让长密钥完整可见，切换密钥收成 rightSection 里的小图标菜单。
  const keyField = mode === "edit" && providerKeys.length > 0 ? (
    <TextInput
      label={t("providerCatalog.apiKeyLabel")}
      description={selectedKey
        ? t("providerCatalog.keyEditingHint", { label: selectedKey.label })
        : t("providerCatalog.keySelectHint")}
      placeholder={t("providerCatalog.apiKeyKeepExisting")}
      value={apiKey}
      disabled={loading}
      error={revealError ? t("providerCatalog.revealKeyFailed") : undefined}
      rightSection={revealing ? (
        <LoaderCircle size={14} className="animate-spin opacity-60" />
      ) : (
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              disabled={loading}
              aria-label={t("providerCatalog.keySelectLabel")}
            >
              <KeyRound size={14} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{t("providerCatalog.keySelectHint")}</Menu.Label>
            {providerKeys.map((item) => (
              <Menu.Item
                key={item.id}
                leftSection={item.id === selectedKeyId ? <Check size={14} /> : <span className="inline-block w-[14px]" />}
                onClick={() => setSelectedKeyId(item.id)}
              >
                {item.isActive
                  ? t("providerCatalog.keySelectActiveOption", { label: item.label })
                  : item.enabled
                    ? item.label
                    : t("providerCatalog.keySelectDisabledOption", { label: item.label })}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      )}
      onChange={(event) => setApiKey(event.currentTarget.value)}
    />
  ) : (
    <PasswordInput
      label={t("providerCatalog.apiKeyLabel")}
      placeholder={t("providerCatalog.apiKeyOptionalPlaceholder")}
      description={t("providerCatalog.apiKeyFirstKeyDescription")}
      value={apiKey}
      disabled={loading}
      onChange={(event) => setApiKey(event.currentTarget.value)}
    />
  );

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

    const keyDraft: NativeProviderFormKeyDraft = {
      apiKey,
      selectedKeyId,
      changed: apiKey.trim() !== revealedBaseline.trim(),
    };

    if (mode === "edit" && provider) {
      await onSubmit({
        ...common,
        baseUrl: values.baseUrl.trim(),
        model: model.trim(),
        apiFormat,
        providerId: provider.id,
      }, keyDraft);
      return;
    }

    await onSubmit(common, keyDraft);
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
          <Autocomplete
            label={t("providerCatalog.modelLabel")}
            placeholder={t("providerCatalog.modelPlaceholder")}
            value={appType === "claude" ? values.claudeConfig.model : values.model}
            data={modelSelectData}
            filter={modelOptionsFilter}
            onChange={(next) => {
              if (appType === "claude") {
                updateClaudeConfig({ ...values.claudeConfig, model: next });
              } else {
                updateValue("model", next);
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
            keyField={keyField}
            modelData={modelSelectData}
            fetchingModels={fetchingModels}
            modelFetchError={modelFetchError}
            onFetchModels={fetchProviderModels}
            canFetchModels={canFetchModels}
          />
        )}
        {appType !== "claude" && (
          <NativeProviderAdvancedConfigSection
            appType={appType}
            value={values.advanced}
            onChange={updateAdvanced}
            disabled={loading}
            keyField={keyField}
            availableModels={availableModels}
            fetchingModels={fetchingModels}
            modelFetchError={modelFetchError}
            onFetchModels={fetchProviderModels}
            canFetchModels={canFetchModels}
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
