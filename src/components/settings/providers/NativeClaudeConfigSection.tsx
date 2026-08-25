import type { ReactNode } from "react";
import {
  Autocomplete,
  Checkbox,
  Divider,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { LoaderCircle, RefreshCw, Wand2 } from "lucide-react";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { NativeProviderButton as Button } from "./NativeProviderButton";
import type {
  NativeClaudeApiFormat,
  NativeClaudeAuthField,
  NativeProviderClaudeConfig,
} from "./nativeProviderTypes";
import { modelOptionsFilter } from "./providerModelCandidates";
import { hasOneM, stripOneM, withOneM } from "./providerModelValue";
import { modelFetchErrorText } from "./providerModelFetchError";

interface NativeClaudeConfigSectionProps {
  value: NativeProviderClaudeConfig;
  onChange: (value: NativeProviderClaudeConfig) => void;
  disabled?: boolean;
  /** API 密钥字段，由表单弹框注入并渲染在本区标题之下。 */
  keyField?: ReactNode;
  /** 已摊平的分组模型候选（`Autocomplete` 的 `data`）。 */
  modelData?: Array<{ group: string; items: string[] }>;
  fetchingModels?: boolean;
  modelFetchError?: string | null;
  onFetchModels?: () => void;
  canFetchModels?: boolean;
}

type ModelKey =
  | "model"
  | "defaultHaikuModel"
  | "defaultSonnetModel"
  | "defaultOpusModel"
  | "defaultFableModel"
  | "subagentModel";
type DisplayNameKey =
  | "defaultHaikuModelName"
  | "defaultSonnetModelName"
  | "defaultOpusModelName"
  | "defaultFableModelName";

interface ModelRole {
  id: "sonnet" | "opus" | "fable" | "haiku" | "subagent";
  labelKey: TranslationKey;
  modelKey: ModelKey;
  displayNameKey?: DisplayNameKey;
  supportsOneM: boolean;
}

const MODEL_ROLES: readonly ModelRole[] = [
  {
    id: "sonnet",
    labelKey: "providerCatalog.claude.modelRoleSonnet",
    modelKey: "defaultSonnetModel",
    displayNameKey: "defaultSonnetModelName",
    supportsOneM: true,
  },
  {
    id: "opus",
    labelKey: "providerCatalog.claude.modelRoleOpus",
    modelKey: "defaultOpusModel",
    displayNameKey: "defaultOpusModelName",
    supportsOneM: true,
  },
  {
    id: "fable",
    labelKey: "providerCatalog.claude.modelRoleFable",
    modelKey: "defaultFableModel",
    displayNameKey: "defaultFableModelName",
    supportsOneM: true,
  },
  {
    id: "haiku",
    labelKey: "providerCatalog.claude.modelRoleHaiku",
    modelKey: "defaultHaikuModel",
    displayNameKey: "defaultHaikuModelName",
    supportsOneM: false,
  },
  {
    id: "subagent",
    labelKey: "providerCatalog.claude.modelRoleSubagent",
    modelKey: "subagentModel",
    supportsOneM: true,
  },
];

const API_FORMATS: Array<{ value: NativeClaudeApiFormat; labelKey: TranslationKey }> = [
  { value: "anthropic", labelKey: "providerCatalog.claude.apiFormatAnthropic" },
  { value: "openai_chat", labelKey: "providerCatalog.claude.apiFormatOpenAIChat" },
  { value: "openai_responses", labelKey: "providerCatalog.claude.apiFormatOpenAIResponses" },
  { value: "gemini_native", labelKey: "providerCatalog.claude.apiFormatGeminiNative" },
];

export function NativeClaudeConfigSection({
  value,
  onChange,
  disabled = false,
  keyField,
  modelData = [],
  fetchingModels = false,
  modelFetchError = null,
  onFetchModels,
  canFetchModels = false,
}: NativeClaudeConfigSectionProps) {
  const { t } = useI18n();
  const update = (patch: Partial<NativeProviderClaudeConfig>) => {
    onChange({ ...value, ...patch });
  };

  const updateRoleModel = (role: ModelRole, next: string) => {
    const current = value[role.modelKey];
    const nextModel = role.supportsOneM ? withOneM(next, hasOneM(current)) : stripOneM(next);
    const patch: Partial<NativeProviderClaudeConfig> = { [role.modelKey]: nextModel };
    if (role.displayNameKey && (!value[role.displayNameKey] || value[role.displayNameKey] === stripOneM(current))) {
      patch[role.displayNameKey] = stripOneM(nextModel);
    }
    update(patch);
  };

  const quickSet = () => {
    const source = value.model || value.defaultSonnetModel || value.defaultOpusModel || value.defaultFableModel || value.defaultHaikuModel || value.subagentModel;
    if (!source) return;
    const model = stripOneM(source);
    const patch: Partial<NativeProviderClaudeConfig> = {
      defaultSonnetModel: withOneM(model, hasOneM(value.defaultSonnetModel)),
      defaultSonnetModelName: model,
      defaultOpusModel: withOneM(model, hasOneM(value.defaultOpusModel)),
      defaultOpusModelName: model,
      defaultFableModel: withOneM(model, hasOneM(value.defaultFableModel)),
      defaultFableModelName: model,
      defaultHaikuModel: model,
      defaultHaikuModelName: model,
      subagentModel: withOneM(model, hasOneM(value.subagentModel)),
    };
    update(patch);
  };

  return (
    <Stack gap="sm" mt="xs">
      <Divider />
      <Text fw={600} size="sm">{t("providerCatalog.claude.advancedTitle")}</Text>
      {keyField}
      <Select
        label={t("providerCatalog.claude.apiFormatLabel")}
        description={t("providerCatalog.claude.apiFormatDescription")}
        value={value.apiFormat}
        data={API_FORMATS.map((item) => ({ value: item.value, label: t(item.labelKey) }))}
        disabled={disabled}
        onChange={(next) => {
          if (next) update({ apiFormat: next as NativeClaudeApiFormat });
        }}
      />
      <Select
        label={t("providerCatalog.claude.authFieldLabel")}
        description={t("providerCatalog.claude.authFieldDescription")}
        value={value.apiKeyField}
        data={[
          { value: "ANTHROPIC_AUTH_TOKEN", label: t("providerCatalog.claude.authToken") },
          { value: "ANTHROPIC_API_KEY", label: t("providerCatalog.claude.apiKey") },
        ]}
        disabled={disabled}
        onChange={(next) => {
          if (next) update({ apiKeyField: next as NativeClaudeAuthField });
        }}
      />
      <Switch
        color="cliPrimary"
        label={t("providerCatalog.claude.fullUrlLabel")}
        description={t("providerCatalog.claude.fullUrlDescription")}
        checked={value.isFullUrl}
        disabled={disabled}
        onChange={(event) => update({ isFullUrl: event.currentTarget.checked })}
      />

      <Group justify="space-between" align="center" mt="xs">
        <Stack gap={2}>
          <Text fw={600} size="sm">{t("providerCatalog.claude.modelMappingTitle")}</Text>
          <Text size="xs" c="dimmed">{t("providerCatalog.claude.modelMappingDescription")}</Text>
        </Stack>
        <Button
          size="compact-sm"
          variant="light"
          color="cliPrimary"
          leftSection={<Wand2 size={14} />}
          disabled={disabled || !value.model && !value.defaultSonnetModel && !value.defaultOpusModel && !value.defaultFableModel && !value.defaultHaikuModel && !value.subagentModel}
          onClick={quickSet}
        >
          {t("providerCatalog.claude.quickSet")}
        </Button>
        <Button
          size="compact-sm"
          variant="light"
          leftSection={fetchingModels ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          disabled={disabled || fetchingModels || !canFetchModels}
          onClick={onFetchModels}
        >
          {t(fetchingModels ? "providerCatalog.models.fetching" : "providerCatalog.models.fetch")}
        </Button>
      </Group>
      {modelFetchError && (() => {
        const reason = modelFetchErrorText(modelFetchError);
        return <Text size="xs" c="red">{t(reason.key, reason.params)}</Text>;
      })()}

      <div className="grid grid-cols-1 gap-2 md:grid-cols-[96px_minmax(0,1fr)_minmax(0,1fr)_68px]">
        <Text size="xs" c="dimmed">{t("providerCatalog.claude.modelRole")}</Text>
        <Text size="xs" c="dimmed">{t("providerCatalog.claude.displayName")}</Text>
        <Text size="xs" c="dimmed">{t("providerCatalog.claude.requestModel")}</Text>
        <Text size="xs" c="dimmed">{t("providerCatalog.claude.oneM")}</Text>
      </div>

      {MODEL_ROLES.map((role) => {
        const model = value[role.modelKey];
        const modelBase = stripOneM(model);
        return (
          <div key={role.id} className="grid grid-cols-1 gap-2 md:grid-cols-[96px_minmax(0,1fr)_minmax(0,1fr)_68px]">
            <TextInput value={t(role.labelKey)} readOnly aria-label={t(role.labelKey)} />
            {role.displayNameKey ? (
              <TextInput
                value={value[role.displayNameKey]}
                disabled={disabled}
                aria-label={t("providerCatalog.claude.displayNameFor", { role: t(role.labelKey) })}
                onChange={(event) => update({ [role.displayNameKey!]: event.currentTarget.value })}
              />
            ) : (
              <TextInput value={t("providerCatalog.claude.hiddenFromModelMenu")} readOnly aria-label={t("providerCatalog.claude.hiddenFromModelMenu")} />
            )}
            <Autocomplete
              value={modelBase}
              data={modelData}
              filter={modelOptionsFilter}
              disabled={disabled}
              placeholder={t("providerCatalog.claude.requestModelPlaceholder")}
              aria-label={t("providerCatalog.claude.requestModelFor", { role: t(role.labelKey) })}
              onChange={(next) => updateRoleModel(role, next)}
            />
            {role.supportsOneM ? (
              <Checkbox
                mt={7}
                label={t("providerCatalog.claude.oneMShort")}
                checked={hasOneM(model)}
                disabled={disabled}
                aria-label={t("providerCatalog.claude.oneMFor", { role: t(role.labelKey) })}
                onChange={(event) => update({ [role.modelKey]: withOneM(model, event.currentTarget.checked) })}
              />
            ) : <div />}
          </div>
        );
      })}

      <Divider mt="xs" />
      <Autocomplete
        label={t("providerCatalog.claude.fallbackModel")}
        description={t("providerCatalog.claude.fallbackModelDescription")}
        placeholder={t("providerCatalog.claude.requestModelPlaceholder")}
        value={stripOneM(value.model)}
        data={modelData}
        filter={modelOptionsFilter}
        disabled={disabled}
        onChange={(next) => update({ model: withOneM(next, hasOneM(value.model)) })}
      />
      <Checkbox
        label={t("providerCatalog.claude.oneM")}
        checked={hasOneM(value.model)}
        disabled={disabled || !stripOneM(value.model)}
        onChange={(event) => update({ model: withOneM(value.model, event.currentTarget.checked) })}
      />
    </Stack>
  );
}
