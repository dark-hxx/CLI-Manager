import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge, Card, Group, Loader, Stack, Switch, Text } from "@mantine/core";
import { ExternalLink, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { NativeProviderButton as Button } from "./NativeProviderButton";
import type {
  NativeProviderCommonConfig,
  NativeProviderDetail,
  NativeProviderGlobalPreview,
} from "./nativeProviderTypes";
import { NativeProviderCodeEditor } from "./NativeProviderCodeEditor";
import { FLUXION_REGISTER_URL } from "@/lib/sponsors";
import {
  formatJsonDocument,
  nativeProviderConfigFormat,
  providerConfigDocumentFromSettings,
} from "./nativeProviderConfigView";

interface NativeProviderEditorProps {
  view?: "basic" | "effective";
  detail: NativeProviderDetail | null;
  loading: boolean;
  action: string | null;
  commonConfig: NativeProviderCommonConfig | null;
  globalPreview: NativeProviderGlobalPreview | null;
  onEdit: () => void;
  onDelete: () => void;
  onEnabledChange: (enabled: boolean) => void;
}
function formatJson(value: string): string {
  return formatJsonDocument(value);
}

function formatDocument(value: string, format: string): string {
  return format === "json" ? formatJson(value) : value;
}

function formatSourceDocuments(detail: NativeProviderDetail): string {
  if (detail.documents.length === 0) return "{}";
  return detail.documents
    .map((document) => `// ${document.kind}\n${formatDocument(document.value, document.format)}`)
    .join("\n\n");
}

const ORIGIN_FIELDS: Array<{
  label: TranslationKey;
  keys: string[];
}> = [
  { label: "providerCatalog.baseUrl", keys: ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "XAI_BASE_URL", "base_url", "baseUrl", "endpoint"] },
  { label: "providerCatalog.model", keys: ["ANTHROPIC_MODEL", "GROK_DEFAULT_MODEL", "model", "model_name", "default_model", "defaultModel"] },
  { label: "providerCatalog.apiFormat", keys: ["api_format", "apiFormat", "format"] },
];

function findValue(value: unknown, keys: string[]): string | null {
  if (typeof value === "object" && value !== null) {
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findValue(child, keys);
        if (found !== null) return found;
      }
      return null;
    }
    for (const [key, child] of Object.entries(value)) {
      if (keys.some((candidate) => candidate.toLowerCase() === key.toLowerCase())) {
        if (typeof child === "string" && child.trim()) return child.trim();
      }
      const found = findValue(child, keys);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "string" || !value.includes("=")) return null;
  for (const line of value.split(/\r?\n/)) {
    const match = /^\s*([\w.-]+)\s*=\s*["']?([^"'#\r\n]+)["']?/.exec(line);
    if (match && keys.some((candidate) => candidate.toLowerCase() === match[1].toLowerCase())) {
      const result = match[2].trim();
      if (result) return result;
    }
  }
  return null;
}

function parsedValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function originFor(
  detail: NativeProviderDetail,
  commonConfig: NativeProviderCommonConfig | null,
  keys: string[],
): { origin: "common" | "provider" | "effective" | "none"; value: string | null } {
  const providerValue = findValue(parsedValue(detail.settingsConfig), keys);
  const effectiveValue = findValue(parsedValue(detail.effectiveSettingsConfig), keys);
  const commonValue = commonConfig ? findValue(
    commonConfig.format === "json" ? parsedValue(commonConfig.value) : commonConfig.value,
    keys,
  ) : null;
  if (effectiveValue === null) return { origin: "none", value: null };
  if (providerValue !== null) return { origin: "provider", value: effectiveValue };
  if (commonValue !== null) return { origin: "common", value: effectiveValue };
  return { origin: "effective", value: effectiveValue };
}

export function NativeProviderEditor({
  view = "basic",
  detail,
  loading,
  action,
  commonConfig,
  globalPreview,
  onEdit,
  onDelete,
  onEnabledChange,
}: NativeProviderEditorProps) {
  const { t } = useI18n();
  const [previewMode, setPreviewMode] = useState<"source" | "common" | "provider" | "effective" | "live">("effective");
  const configPreview = useMemo(
    () => {
      if (!detail) return "";
      switch (previewMode) {
        case "source": return formatSourceDocuments(detail);
        case "common": return commonConfig ? formatDocument(commonConfig.value, commonConfig.format) : "{}";
        case "provider": return providerConfigDocumentFromSettings(detail.card.appType as "claude" | "codex" | "grokbuild", detail.settingsConfig);
        case "effective": return providerConfigDocumentFromSettings(detail.card.appType as "claude" | "codex" | "grokbuild", detail.effectiveSettingsConfig);
        default: return "";
      }
    },
    [commonConfig, detail, previewMode]
  );

  if (loading) {
    return (
      <Card withBorder radius="lg" padding="md" className="flex min-h-[260px] items-center justify-center border-border/70 bg-surface-container-low">
        <Loader size="sm" color="cliPrimary" />
      </Card>
    );
  }

  if (!detail) {
    return (
      <Card withBorder radius="lg" padding="md" className="flex min-h-[260px] items-center justify-center border-border/70 bg-surface-container-low">
        <Text size="sm" c="dimmed">{t("providerCatalog.selectDescription")}</Text>
      </Card>
    );
  }

  const { card } = detail;
  const isBasicView = view === "basic";
  const isFluxionProvider = card.id.startsWith("builtin-fluxion-");
  const category = isFluxionProvider
    ? t("providerCatalog.fluxion.category")
    : card.category || t("providerCatalog.uncategorized");
  const websiteUrl = isFluxionProvider ? FLUXION_REGISTER_URL : card.websiteUrl ?? undefined;
  const openWebsite = () => {
    if (!websiteUrl) return;
    void openUrl(websiteUrl).catch(() => toast.error(t("providerCatalog.websiteOpenFailed")));
  };
  const copyFluxionCode = async () => {
    try {
      await navigator.clipboard.writeText("CLIMANAGER");
      toast.success(t("providerCatalog.fluxion.codeCopied"), {
        description: t("providerCatalog.fluxion.codeOpening"),
        duration: 3000,
      });
      window.setTimeout(() => {
        void openUrl(FLUXION_REGISTER_URL).catch(() => toast.error(t("providerCatalog.websiteOpenFailed")));
      }, 3000);
    } catch {
      toast.error(t("providerCatalog.fluxion.codeCopyFailed"));
    }
  };

  return (
      <Card withBorder radius="lg" padding="md" className="min-w-0 overflow-hidden border-border/70 bg-surface-container-low">
      <Stack gap="md" miw={0}>
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Stack gap={4} miw={0}>
            <Group gap="xs" wrap="wrap">
              <Text fw={700} size="lg" truncate>{card.name}</Text>
              {isFluxionProvider && (
                <Badge size="sm" variant="light" color="orange">
                  {t("providerCatalog.fluxion.sponsorBadge")}
                </Badge>
              )}
              {card.isCurrent && <Badge color="cliPrimary">{t("providerCatalog.current")}</Badge>}
            </Group>
            <Text size="sm" c="dimmed">{category}</Text>
            {isFluxionProvider && (
              <Stack gap={2}>
                <Text size="xs" c="dimmed" maw={760}>
                  {t("providerCatalog.fluxion.providerDescription")}
                </Text>
                <Text size="xs" c="orange.8" fw={600}>
                  {t("providerCatalog.fluxion.providerBenefitPrefix")}
                  <code className="sponsor-card__coupon cursor-pointer" onDoubleClick={() => void copyFluxionCode()} title={t("providerCatalog.fluxion.codeCopyHint")}>CLIMANAGER</code>
                  {t("providerCatalog.fluxion.providerBenefitSuffix")}
                </Text>
              </Stack>
            )}
          </Stack>
          <Switch
            color="cliPrimary"
            checked={card.enabled}
            disabled={Boolean(action) || card.isCurrent}
            aria-label={card.enabled ? t("providerCatalog.disable") : t("providerCatalog.enable")}
            onChange={(event) => onEnabledChange(event.currentTarget.checked)}
          />
        </Group>

        <Group gap={6} wrap="wrap">
          <Button size="compact-sm" variant="light" color="cliPrimary" leftSection={<Pencil size={14} />} onClick={onEdit}>
            {t("common.edit")}
          </Button>
          <Button size="compact-sm" variant="light" color="red" leftSection={<Trash2 size={14} />} disabled={Boolean(action) || card.isCurrent} onClick={onDelete}>
            {t("common.delete")}
          </Button>
          {websiteUrl && (
            <Button
              component="button"
              type="button"
              onClick={openWebsite}
              size="compact-sm"
              variant={isFluxionProvider ? "filled" : "subtle"}
              color={isFluxionProvider ? "indigo" : "gray"}
              leftSection={<ExternalLink size={14} />}
            >
              {t("providerCatalog.website")}
            </Button>
          )}
        </Group>

        {isBasicView && (
          <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <InfoItem
              label={t(card.appType === "codex" ? "providerCatalog.requestUrl" : "providerCatalog.baseUrl")}
              value={card.baseUrl || t("providerCatalog.notConfigured")}
            />
            <InfoItem label={t("providerCatalog.model")} value={card.model || t("providerCatalog.notConfigured")} />
            <InfoItem label={t("providerCatalog.apiFormat")} value={card.apiFormat || t("providerCatalog.notConfigured")} />
            <InfoItem label={t("providerCatalog.activeKeyLabel")} value={card.activeKeyLabel || t("providerCatalog.noActiveKey")} />
          </div>
        )}

        {!isBasicView && (
          <Stack gap={6}>
            <Group justify="space-between" align="center" wrap="wrap">
              <Text size="sm" fw={600}>{t("providerCatalog.settingsPreview")}</Text>
              {detail.settingsHasSecret && <Badge size="sm" color="yellow">{t("providerCatalog.secretRedacted")}</Badge>}
            </Group>
            <Group gap={4} role="tablist" aria-label={t("providerCatalog.previewSelector")} wrap="wrap">
              {([
                ["source", "providerCatalog.previewSource"],
                ["common", "providerCatalog.previewCommon"],
                ["provider", "providerCatalog.previewProvider"],
                ["effective", "providerCatalog.previewEffective"],
                ["live", "providerCatalog.previewLive"],
              ] as const).map(([mode, label]) => (
                <Button
                  key={mode}
                  size="compact-xs"
                  variant={previewMode === mode ? "light" : "subtle"}
                  color={previewMode === mode ? "cliPrimary" : "gray"}
                  role="tab"
                  aria-selected={previewMode === mode}
                  onClick={() => setPreviewMode(mode)}
                >
                  {t(label)}
                </Button>
              ))}
            </Group>
            {previewMode === "live" ? (
              <LiveDiffPreview preview={globalPreview} />
            ) : previewMode === "source" ? (
              <pre className="max-h-[min(48vh,520px)] min-h-[180px] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-surface-container-lowest p-3 font-mono text-xs leading-5 text-text-secondary">
                {configPreview || "{}"}
              </pre>
            ) : (
              <NativeProviderCodeEditor
                format={previewMode === "common"
                  ? (commonConfig?.format === "json" ? "json" : "toml")
                  : nativeProviderConfigFormat(card.appType as "claude" | "codex" | "grokbuild")}
                value={configPreview || (nativeProviderConfigFormat(card.appType as "claude" | "codex" | "grokbuild") === "json" ? "{}" : "")}
                path={`native-provider-preview-${card.id}-${previewMode}`}
                ariaLabel={t("providerCatalog.previewEditorLabel")}
                height="min(48vh, 520px)"
                readOnly
              />
            )}
            <Text size="xs" c="dimmed">
              {t(previewMode === "source"
                ? "providerCatalog.previewSourceDescription"
                : previewMode === "common"
                  ? "providerCatalog.previewCommonDescription"
                  : previewMode === "provider"
                    ? "providerCatalog.previewProviderDescription"
                    : previewMode === "live"
                      ? "providerCatalog.previewLiveDescription"
                      : "providerCatalog.previewEffectiveDescription")}
            </Text>
          </Stack>
        )}

        {!isBasicView && <FieldOriginSummary detail={detail} commonConfig={commonConfig} />}

      </Stack>
    </Card>
  );
}

function LiveDiffPreview({ preview }: { preview: NativeProviderGlobalPreview | null }) {
  const { t } = useI18n();
  if (!preview) {
    return <Text size="sm" c="dimmed">{t("providerCatalog.previewLiveUnavailable")}</Text>;
  }
  return (
    <Stack gap={4} className="max-h-48 min-w-0 overflow-auto rounded-lg border border-border/60 bg-surface-container-lowest p-3">
      {preview.targets.map((target) => (
          <Group key={target.target} justify="space-between" align="flex-start" wrap="wrap" gap="xs" className="min-w-0">
          <Stack gap={1} miw={0}>
            <Text size="xs" fw={600} truncate>{target.target}</Text>
            <Text size="xs" c="dimmed" truncate>{target.path}</Text>
            <Text size="xs" c="dimmed" truncate>
              {target.liveFingerprint} → {target.desiredFingerprint}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {t("providerCatalog.global.ownedFields", { fields: target.ownedFields.join(", ") })}
            </Text>
          </Stack>
          <Badge color={target.changed ? "yellow" : "green"} size="sm">
            {target.changed
              ? t(target.action === "create" ? "providerCatalog.global.create" : "providerCatalog.global.update")
              : t("providerCatalog.global.unchanged")}
          </Badge>
        </Group>
      ))}
    </Stack>
  );
}

function FieldOriginSummary({
  detail,
  commonConfig,
}: {
  detail: NativeProviderDetail;
  commonConfig: NativeProviderCommonConfig | null;
}) {
  const { t } = useI18n();
  return (
    <Stack gap={6}>
      <Text size="sm" fw={600}>{t("providerCatalog.fieldOrigins.title")}</Text>
      {ORIGIN_FIELDS.map((field) => {
        const result = originFor(detail, commonConfig, field.keys);
        return (
          <Group key={field.label} justify="space-between" wrap="wrap" className="min-w-0 rounded-lg border border-border/50 bg-surface-container-lowest px-3 py-2">
            <Text size="xs" c="dimmed">{t(field.label)}</Text>
            <Group gap="xs" wrap="nowrap" miw={0} className="min-w-0">
              <Text size="xs" truncate className="min-w-0" title={result.value ?? undefined}>{result.value ?? t("providerCatalog.notConfigured")}</Text>
              <Badge size="xs" color={originColor(result.origin)}>{t(originKey(result.origin))}</Badge>
            </Group>
          </Group>
        );
      })}
      <Group justify="space-between" wrap="wrap" className="min-w-0 rounded-lg border border-border/50 bg-surface-container-lowest px-3 py-2">
        <Text size="xs" c="dimmed">{t("providerCatalog.activeKeyLabel")}</Text>
        <Group gap="xs" wrap="nowrap" miw={0} className="min-w-0">
          <Text size="xs" truncate className="min-w-0">{detail.card.activeKeyLabel ?? t("providerCatalog.noActiveKey")}</Text>
          <Badge size="xs" color="blue">{t("providerCatalog.fieldOrigins.activeKey")}</Badge>
        </Group>
      </Group>
    </Stack>
  );
}

function originKey(origin: "common" | "provider" | "effective" | "none"): TranslationKey {
  switch (origin) {
    case "common": return "providerCatalog.fieldOrigins.common";
    case "provider": return "providerCatalog.fieldOrigins.provider";
    case "effective": return "providerCatalog.fieldOrigins.effective";
    default: return "providerCatalog.fieldOrigins.none";
  }
}

function originColor(origin: "common" | "provider" | "effective" | "none"): string {
  switch (origin) {
    case "common": return "blue";
    case "provider": return "violet";
    case "effective": return "green";
    default: return "gray";
  }
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/50 bg-surface-container-lowest px-3 py-2">
      <Text size="xs" c="dimmed">{label}</Text>
      <Text size="sm" truncate title={value}>{value}</Text>
    </div>
  );
}
