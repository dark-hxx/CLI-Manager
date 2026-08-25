import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Alert, Badge, Checkbox, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { AlertTriangle, Database, Eye, FileDown, RefreshCw } from "lucide-react";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { useProjectStore } from "@/stores/projectStore";
import { NativeProviderButton as Button } from "./NativeProviderButton";
import { issueScopeLabel } from "./nativeProviderImportDisplay";
import {
  providerErrorCode,
  type NativeProviderImportIssue,
  type NativeProviderImportPreview,
  type NativeProviderImportResult,
  type NativeProviderCard,
  type NativeProviderAppType,
} from "./nativeProviderTypes";

interface NativeProviderImportSectionProps {
  appType: NativeProviderAppType;
  providers: NativeProviderCard[];
  onCommitted: () => Promise<void> | void;
}

const ERROR_KEYS: Partial<Record<string, TranslationKey>> = {
  provider_import_preview_required: "providerCatalog.import.errors.previewRequired",
  provider_import_source_changed: "providerCatalog.import.errors.sourceChanged",
  provider_import_conflict: "providerCatalog.import.errors.conflict",
  provider_import_source_invalid: "providerCatalog.import.errors.sourceInvalid",
  provider_import_database_error: "providerCatalog.import.errors.database",
  provider_import_issue_not_found: "providerCatalog.import.errors.issueNotFound",
};

const REASON_KEYS: Partial<Record<string, TranslationKey>> = {
  empty_or_oauth_credential: "providerCatalog.import.reasons.emptyOrOauthCredential",
  unsupported_app_type: "providerCatalog.import.reasons.unsupportedAppType",
  invalid_settings: "providerCatalog.import.reasons.invalidSettings",
  no_usable_credential: "providerCatalog.import.reasons.noUsableCredential",
  unmapped_provider: "providerCatalog.import.reasons.unmappedProvider",
};

function errorText(error: unknown, t: (key: TranslationKey) => string): string {
  const code = providerErrorCode(error);
  return t(ERROR_KEYS[code] ?? "providerCatalog.import.errors.generic");
}

function reasonText(reason: string | null | undefined, t: (key: TranslationKey) => string): string {
  return t(REASON_KEYS[reason ?? ""] ?? "providerCatalog.import.reasons.unknown");
}

function appTypeLabel(appType: string, t: (key: TranslationKey) => string): string {
  if (appType === "claude") return t("providerCatalog.appType.claude");
  if (appType === "codex") return t("providerCatalog.appType.codex");
  if (appType === "grokbuild") return t("providerCatalog.appType.grokbuild");
  return appType;
}

export function NativeProviderImportSection({ appType, providers, onCommitted }: NativeProviderImportSectionProps) {
  const { t } = useI18n();
  const projects = useProjectStore((state) => state.projects);
  const worktrees = useProjectStore((state) => state.worktrees);
  const projectsLoaded = useProjectStore((state) => state.loaded);
  const fetchProjects = useProjectStore((state) => state.fetchAll);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [preview, setPreview] = useState<NativeProviderImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [allowSecrets, setAllowSecrets] = useState(false);
  const [allowUpdates, setAllowUpdates] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<NativeProviderImportIssue[]>([]);
  const [repairProviderIds, setRepairProviderIds] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!projectsLoaded) {
      void fetchProjects("interactive").catch(() => undefined);
    }
  }, [fetchProjects, projectsLoaded]);

  useEffect(() => {
    void invoke<NativeProviderImportIssue[]>("provider_import_issues")
      .then(setIssues)
      .catch(() => undefined);
  }, []);

  const updateCount = useMemo(
    () => preview?.providers.filter((provider) => provider.action === "update").length ?? 0,
    [preview],
  );
  const secretCount = useMemo(
    () => preview?.providers.reduce((total, provider) => total + provider.keys.filter((key) => key.hasSecret).length, 0) ?? 0,
    [preview],
  );
  const visibleIssues = issues.filter((issue) => issue.appType === appType);

  const chooseSource = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: t("providerCatalog.import.databaseFilter"), extensions: ["db"] }],
      });
      if (typeof selected === "string" && selected.trim()) {
        setSourcePath(selected);
        setPreview(null);
        setError(null);
      }
    } catch (selectError) {
      setError(errorText(selectError, t));
    }
  };

  const discover = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await invoke<NativeProviderImportPreview>("provider_import_preview", {
        input: { sourcePath },
      });
      setPreview(next);
      setAllowUpdates(next.providers.some((provider) => provider.action === "update"));
      setIssues(await invoke<NativeProviderImportIssue[]>("provider_import_issues"));
    } catch (discoverError) {
      setPreview(null);
      setError(errorText(discoverError, t));
    } finally {
      setLoading(false);
    }
  };

  const commit = async () => {
    if (!preview) {
      setError(t("providerCatalog.import.errors.previewRequired"));
      return;
    }
    setCommitting(true);
    setError(null);
    try {
      const result = await invoke<NativeProviderImportResult>("provider_import_commit", {
        input: {
          sourcePath: preview.sourcePath,
          expectedFingerprint: preview.sourceFingerprint,
          allowSecrets,
          allowUpdates,
        },
      });
      toast.success(t("providerCatalog.import.committed"), {
        description: t("providerCatalog.import.committedDescription", {
          providers: result.imported + result.updated,
          keys: result.keysImported,
        }),
      });
      await onCommitted();
      setIssues(await invoke<NativeProviderImportIssue[]>("provider_import_issues"));
      await discover();
    } catch (commitError) {
      setError(errorText(commitError, t));
    } finally {
      setCommitting(false);
    }
  };

  const resolveIssue = async (issue: NativeProviderImportIssue) => {
    const providerId = repairProviderIds[issue.id]?.trim();
    if (!providerId) return;
    setError(null);
    try {
      await invoke<void>("provider_import_resolve_issue", {
        input: { issueId: issue.id, providerId },
      });
      toast.success(t("providerCatalog.import.resolveSuccess"));
      setIssues(await invoke<NativeProviderImportIssue[]>("provider_import_issues"));
      await onCommitted();
    } catch (resolveError) {
      setError(errorText(resolveError, t));
    }
  };

  const issuePanel = visibleIssues.length > 0 ? (
    <Alert color="yellow" variant="light" icon={<AlertTriangle size={16} />} mt="sm">
      <Text size="xs" fw={600}>{t("providerCatalog.import.repairTitle", { count: visibleIssues.length })}</Text>
      <Stack gap={2} mt={4}>
        {visibleIssues.slice(0, 5).map((issue) => (
          <Group key={issue.id} gap="xs" align="flex-end" wrap="nowrap">
            <Stack gap={2} className="min-w-0 flex-1">
              <Text
                size="xs"
                fw={600}
                truncate
                title={`${issueScopeLabel(issue, projects, worktrees, t)} · ${issue.scopeKind}:${issue.scopeId}`}
              >
                {issueScopeLabel(issue, projects, worktrees, t)}
              </Text>
              <Text size="xs" c="dimmed" truncate title={issue.sourceProviderId}>
                {appTypeLabel(issue.appType, t)} · {issue.sourceProviderId}
              </Text>
              <Text size="xs" c="dimmed" truncate title={reasonText(issue.reason, t)}>
                {reasonText(issue.reason, t)}
              </Text>
            </Stack>
            <Select
              size="xs"
              className="w-44 shrink-0"
              placeholder={t("providerCatalog.import.resolveProvider")}
              data={providers.map((provider) => ({ value: provider.id, label: provider.name }))}
              value={repairProviderIds[issue.id] ?? null}
              onChange={(value) => {
                setRepairProviderIds((current) => ({ ...current, [issue.id]: value ?? "" }));
              }}
              searchable
              clearable
            />
            <Button
              size="compact-xs"
              variant="light"
              disabled={!repairProviderIds[issue.id]}
              onClick={() => void resolveIssue(issue)}
            >
              {t("providerCatalog.import.resolve")}
            </Button>
          </Group>
        ))}
      </Stack>
      {visibleIssues.length > 5 && <Text size="xs" mt={4}>{t("providerCatalog.import.moreIssues", { count: visibleIssues.length - 5 })}</Text>}
    </Alert>
  ) : null;

  return (
    <section className="rounded-xl border border-default bg-surface-container-lowest p-4">
      <Group justify="space-between" align="flex-start" gap="md">
        <div>
          <Group gap="xs">
            <Database size={17} />
            <Text fw={700}>{t("providerCatalog.import.title")}</Text>
          </Group>
          <Text size="xs" c="dimmed" mt={4}>
            {t("providerCatalog.import.description")}
          </Text>
        </div>
        <Group gap="xs">
          <Button variant="light" size="xs" leftSection={<FileDown size={14} />} onClick={() => void chooseSource()}>
            {t("providerCatalog.import.choose")}
          </Button>
          <Button size="xs" leftSection={loading ? <RefreshCw size={14} className="animate-spin" /> : <Eye size={14} />} disabled={loading} onClick={() => void discover()}>
            {loading ? t("providerCatalog.import.discovering") : t("providerCatalog.import.preview")}
          </Button>
        </Group>
      </Group>

      <TextInput
        mt="sm"
        label={t("providerCatalog.import.sourcePathLabel")}
        placeholder={t("providerCatalog.import.defaultSource")}
        value={sourcePath ?? ""}
        onChange={(event) => {
          setSourcePath(event.currentTarget.value || null);
          setPreview(null);
          setError(null);
        }}
      />

      {error && (
        <Alert color="red" variant="light" icon={<AlertTriangle size={16} />} mt="sm">
          {error}
        </Alert>
      )}

      {issuePanel}

      {preview && (
        <Stack gap="xs" mt="sm">
          <Group gap="xs" wrap="wrap">
            <Text size="xs">{t("providerCatalog.import.providerCount", { count: preview.providers.length })}</Text>
            <Text size="xs">{t("providerCatalog.import.commonConfigCount", { count: preview.commonConfigs.length })}</Text>
            <Text size="xs">{t("providerCatalog.import.secretCount", { count: secretCount })}</Text>
            <Text size="xs">{t("providerCatalog.import.scopeCount", { count: preview.scopes.length })}</Text>
          </Group>
          <Text size="xs" c="dimmed" className="break-all">
            {t("providerCatalog.import.fingerprint", { value: preview.sourceFingerprint })}
          </Text>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-default p-2">
            {preview.providers.map((provider) => (
              <div key={`${provider.appType}:${provider.sourceId}`} className="flex items-center justify-between gap-2 py-1 text-xs">
                <Stack gap={1} className="min-w-0">
                  <Group gap="xs" wrap="nowrap">
                    <span className="min-w-0 truncate">
                      {appTypeLabel(provider.appType, t)} · {provider.name}
                    </span>
                    {provider.isCurrent && <Badge size="xs" color="yellow">{t("providerCatalog.import.currentCandidate")}</Badge>}
                  </Group>
                  {provider.keys.length > 0 && (
                    <Text size="xs" c="dimmed" truncate>
                      {t("providerCatalog.import.keySummary", {
                        value: provider.keys.map((key) => `${key.label}${key.isActive ? ` (${t("providerCatalog.import.activeKey")})` : ""}`).join(" · "),
                      })}
                    </Text>
                  )}
                  <details className="mt-1 max-w-full">
                    <summary className="cursor-pointer text-xs text-text-muted">
                      {t("providerCatalog.import.documentPreview")}
                      {provider.settingsHasSecret && (
                        <Badge size="xs" color="yellow" ml={4}>
                          {t("providerCatalog.import.sensitiveRedacted")}
                        </Badge>
                      )}
                    </summary>
                    <pre className="mt-1 max-h-32 max-w-full overflow-auto rounded border border-default bg-surface-container-lowest p-2 text-[11px] leading-4 text-text-secondary">
                      {provider.settingsPreview}
                    </pre>
                  </details>
                </Stack>
                <span className="shrink-0 text-text-muted">
                  {provider.action === "skip"
                    ? t("providerCatalog.import.action.skip")
                    : provider.action === "update"
                      ? t("providerCatalog.import.action.update")
                      : provider.action === "unchanged"
                        ? t("providerCatalog.import.action.unchanged")
                        : t("providerCatalog.import.action.create")}
                </span>
              </div>
            ))}
          </div>
          {preview.commonConfigs.length > 0 && (
            <div className="rounded-lg border border-default p-2">
              <Text size="xs" fw={600} mb={4}>{t("providerCatalog.import.commonPreview")}</Text>
              <Stack gap={4}>
                {preview.commonConfigs.map((common) => (
                  <details key={common.appType}>
                    <summary className="cursor-pointer text-xs text-text-muted">
                      {appTypeLabel(common.appType, t)} · {common.format}
                      {common.hasSecret && (
                        <Badge size="xs" color="yellow" ml={4}>
                          {t("providerCatalog.import.sensitiveRedacted")}
                        </Badge>
                      )}
                    </summary>
                    <pre className="mt-1 max-h-32 overflow-auto rounded border border-default bg-surface-container-lowest p-2 text-[11px] leading-4 text-text-secondary">
                      {common.sanitizedValue}
                    </pre>
                  </details>
                ))}
              </Stack>
            </div>
          )}
          <Checkbox
            checked={allowSecrets}
            onChange={(event) => setAllowSecrets(event.currentTarget.checked)}
            label={t("providerCatalog.import.allowSecrets")}
            description={t("providerCatalog.import.allowSecretsDescription")}
          />
          {updateCount > 0 && (
            <Checkbox
              checked={allowUpdates}
              onChange={(event) => setAllowUpdates(event.currentTarget.checked)}
              label={t("providerCatalog.import.allowUpdates", { count: updateCount })}
            />
          )}
          <Button size="xs" loading={committing} disabled={committing} onClick={() => void commit()}>
            {t("providerCatalog.import.commit")}
          </Button>
        </Stack>
      )}
    </section>
  );
}
