import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Monitor } from "lucide-react";
import type { Project, WorktreeRecord } from "../lib/types";
import {
  getClaudeProviderOverride,
  getCodexProviderOverride,
  getGrokProviderOverride,
  getProviderSwitchAppType,
  withClaudeProviderOverride,
  withCodexProviderOverride,
  withGrokProviderOverride,
  type ProviderSwitchAppType,
} from "../lib/providerSwitching";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { useProjectStore } from "../stores/projectStore";
import { useWorktreeStore } from "../stores/worktreeStore";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { AlertTriangle, Boxes, Check, ChevronRight, Database, Globe, RefreshCw } from "./icons";
import { ProviderBadge, type ProviderBadgeTone } from "./provider/ProviderRow";
import { VendorIcon, inferVendor, type VendorKey } from "./VendorIcon";
import {
  providerErrorCode,
  type NativeProviderCard,
  type NativeProviderGlobalCurrent,
  type NativeProviderHomeState,
} from "./settings/providers/nativeProviderTypes";

interface ProviderScopeResponse {
  appType: string;
  providerId: string;
  providerName: string;
  source: string;
}

function homeModeLabel(
  home: NativeProviderHomeState | null,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
): string {
  if (!home) return t("providerSwitch.homeUnavailable");
  return home.identity.environmentKind === "wsl"
    ? t("providerSwitch.homeWsl")
    : t("providerSwitch.homeLocal");
}

type SwitchBadge = {
  label: string;
  tone: ProviderBadgeTone;
};

function providerTypeLabel(
  appType: ProviderSwitchAppType | null,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
): string {
  if (appType === "claude") return t("providerCatalog.appType.claude");
  if (appType === "codex") return t("providerCatalog.appType.codex");
  if (appType === "grokbuild") return t("providerCatalog.appType.grokbuild");
  return t("providerSwitch.unsupported");
}

function formatError(
  error: unknown,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
): string {
  const code = providerErrorCode(error);
  if (code === "provider_reference_migration_required") {
    return t("providerSwitch.errors.migrationRequired");
  }
  if (code === "provider_not_ready" || code === "provider_key_not_active") {
    return t("providerSwitch.errors.notReady");
  }
  if (code === "provider_current_not_set" || code === "provider_home_active_unavailable") {
    return t("providerSwitch.errors.currentNotSet");
  }
  const message = error instanceof Error ? error.message : String(error);
  return t("providerSwitch.errors.operation", { message });
}

function inferProviderVendor(provider: NativeProviderCard): VendorKey | null {
  return (
    inferVendor(provider.model) ??
    inferVendor(provider.baseUrl) ??
    inferVendor(provider.appType) ??
    inferVendor(provider.name) ??
    inferVendor(provider.category)
  );
}

function providerVendorHint(provider: NativeProviderCard): string | null {
  return (
    inferProviderVendor(provider) ??
    provider.model ??
    provider.baseUrl ??
    provider.category ??
    provider.name ??
    null
  );
}

function ProviderSwitchListButton({
  selected,
  disabled = false,
  onClick,
  icon,
  name,
  subtitle,
  subtitleTitle,
  badges = [],
  trailing,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: ReactNode;
  name: string;
  subtitle?: string;
  subtitleTitle?: string;
  badges?: SwitchBadge[];
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-selected={selected ? "true" : "false"}
      aria-pressed={selected}
      className="ui-focus-ring flex w-full items-center gap-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        appearance: "none",
        padding: "9px 10px",
        borderRadius: 14,
        backgroundColor: selected
          ? "color-mix(in srgb, var(--primary) 10%, var(--surface-container-lowest))"
          : "var(--surface-container-lowest)",
        border: selected
          ? "1px solid color-mix(in srgb, var(--primary) 42%, transparent)"
          : "1px solid color-mix(in srgb, var(--border) 22%, transparent)",
        boxShadow: selected
          ? "0 4px 14px color-mix(in srgb, var(--primary) 12%, transparent)"
          : "none",
        color: "inherit",
        cursor: disabled ? "not-allowed" : "pointer",
        font: "inherit",
      }}
      onMouseEnter={(event) => {
        if (!selected && !disabled) {
          event.currentTarget.style.backgroundColor = "var(--surface-container-low)";
        }
      }}
      onMouseLeave={(event) => {
        if (!selected) {
          event.currentTarget.style.backgroundColor = "var(--surface-container-lowest)";
        }
      }}
    >
      <span
        className="inline-flex shrink-0 items-center justify-center"
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          backgroundColor: "var(--surface-container-high)",
          color: "var(--on-surface)",
        }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-[13px] font-bold"
          style={{ color: selected ? "var(--primary)" : "var(--on-surface)" }}
        >
          {name}
        </span>
        {subtitle && (
          <span className="mt-0.5 block truncate text-[10px] text-text-muted" title={subtitleTitle ?? subtitle}>
            {subtitle}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {trailing ??
          badges.map((badge) => (
            <ProviderBadge key={`${badge.tone}-${badge.label}`} tone={badge.tone}>
              {badge.label}
            </ProviderBadge>
          ))}
        <ChevronRight size={16} style={{ color: "var(--text-muted)" }} />
      </span>
    </button>
  );
}

function getOverride(project: Project, appType: ProviderSwitchAppType | null) {
  if (appType === "claude") return getClaudeProviderOverride(project);
  if (appType === "codex") return getCodexProviderOverride(project);
  if (appType === "grokbuild") return getGrokProviderOverride(project);
  return undefined;
}

function withOverride(
  raw: string | null | undefined,
  appType: ProviderSwitchAppType,
  provider: NativeProviderCard | null,
): string {
  const reference = provider
    ? {
        schemaVersion: 2,
        source: "cli-manager" as const,
        appType,
        providerId: provider.id,
        providerName: provider.name,
        vendorHint: providerVendorHint(provider),
      }
    : null;
  if (appType === "claude") return withClaudeProviderOverride(raw, reference);
  if (appType === "codex") return withCodexProviderOverride(raw, reference);
  return withGrokProviderOverride(raw, reference);
}

interface Props {
  project: Project;
  worktree?: WorktreeRecord;
  onClose: () => void;
}

export function ProviderSwitchModal({ project, worktree, onClose }: Props) {
  const { t } = useI18n();
  const appType = getProviderSwitchAppType(project);
  const targetProviderOverrides = worktree?.provider_overrides ?? project.provider_overrides;
  const targetProject = useMemo<Project>(
    () => ({
      ...project,
      name: worktree ? `${project.name} · ${worktree.name}` : project.name,
      path: worktree?.path ?? project.path,
      provider_overrides: targetProviderOverrides,
    }),
    [project, targetProviderOverrides, worktree],
  );
  const [providers, setProviders] = useState<NativeProviderCard[]>([]);
  const [probe, setProbe] = useState<ProviderScopeResponse | null>(null);
  const [home, setHome] = useState<NativeProviderHomeState | null>(null);
  const [globalCurrent, setGlobalCurrent] = useState<NativeProviderGlobalCurrent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const updateTargetProviderOverrides = useCallback(
    async (providerOverrides: string) => {
      if (worktree) {
        await useWorktreeStore.getState().updateWorktreeProviderOverrides(worktree.id, providerOverrides);
        return;
      }
      await useProjectStore.getState().updateProject(project.id, { provider_overrides: providerOverrides });
    },
    [project.id, worktree],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setProbe(null);
    if (!appType) {
      setProviders([]);
      setError(t("providerSwitch.unsupported"));
      setLoading(false);
      return;
    }
    if (appType === "grokbuild") {
      setProviders([]);
      setError(t("providerSwitch.grokUnsupported"));
      setLoading(false);
      return;
    }

    try {
      const [list, activeHome] = await Promise.all([
        invoke<NativeProviderCard[]>("provider_catalog_list", { appType }),
        invoke<NativeProviderHomeState>("provider_home_active_get"),
      ]);
      setProviders(list.filter((provider) => provider.appType === appType));
      setHome(activeHome);
      const [resolvedResult, currentResult] = await Promise.allSettled([
        invoke<ProviderScopeResponse>("provider_scope_resolve", {
          input: {
            appType,
            projectId: project.id,
            worktreeId: worktree?.id ?? null,
            providerId: null,
          },
        }),
        invoke<NativeProviderGlobalCurrent>("provider_global_current", {
          input: {
            appType,
            homeIdentity: activeHome.identity,
          },
        }),
      ]);
      if (resolvedResult.status === "fulfilled") {
        setProbe(resolvedResult.value);
      } else {
        setError(formatError(resolvedResult.reason, t));
      }
      if (currentResult.status === "fulfilled") {
        setGlobalCurrent(currentResult.value);
      } else {
        setError(formatError(currentResult.reason, t));
      }
    } catch (listError) {
      setProviders([]);
      setError(formatError(listError, t));
    } finally {
      setLoading(false);
    }
  }, [appType, project.id, t, worktree?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyProvider = async (provider: NativeProviderCard) => {
    if (applyingId || !appType || appType === "grokbuild") return;
    setApplyingId(provider.id);
    try {
      const nextProviderOverrides = withOverride(targetProviderOverrides, appType, provider);
      await updateTargetProviderOverrides(nextProviderOverrides);
      setProbe({
        appType,
        providerId: provider.id,
        providerName: provider.name,
        source: worktree ? "worktree" : "project",
      });
      toast.success(t("providerSwitch.applySuccess"), {
        description: t("providerSwitch.applyDescription", { name: provider.name }),
      });
      await useProjectStore.getState().refreshProviderBadges();
    } catch (applyError) {
      toast.error(t("providerSwitch.applyFailed"), { description: formatError(applyError, t) });
    } finally {
      setApplyingId(null);
    }
  };

  const resetToGlobal = async () => {
    if (applyingId || !appType) return;
    setApplyingId("__follow_global__");
    try {
      const nextProviderOverrides = withOverride(targetProviderOverrides, appType, null);
      await updateTargetProviderOverrides(nextProviderOverrides);
      const resolved = await invoke<ProviderScopeResponse>("provider_scope_resolve", {
        input: {
          appType,
          projectId: project.id,
          worktreeId: worktree?.id ?? null,
          providerId: null,
        },
      });
      setProbe(resolved);
      toast.success(worktree ? t("providerSwitch.worktreeResetSuccess") : t("providerSwitch.resetSuccess"), {
        description: t("providerSwitch.resetDescription"),
      });
      await useProjectStore.getState().refreshProviderBadges();
    } catch (resetError) {
      toast.error(t("providerSwitch.resetFailed"), { description: formatError(resetError, t) });
    } finally {
      setApplyingId(null);
    }
  };

  const hasOverride = probe?.source === "project" || probe?.source === "worktree";
  const followGlobal = probe?.source === "global";
  const globalCurrentName = globalCurrent?.providerName ?? providers.find((provider) => provider.isCurrent)?.name ?? null;
  const hasCustomProviderStartup = Boolean(project.startup_cmd.trim());
  const override = getOverride(targetProject, appType);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-[480px] p-4">
        <div className="mb-1 flex items-center justify-between gap-3 pr-8">
          <DialogTitle className="text-base font-semibold text-text-primary">
            {t("providerSwitch.title")}
          </DialogTitle>
          {appType && (
            <span className="text-xs text-text-muted">{providerTypeLabel(appType, t)}</span>
          )}
        </div>
        {appType !== "grokbuild" && (
          <div
            className="mb-2 flex items-center gap-1.5 text-[11px] text-text-muted"
            aria-label={t("providerSwitch.homeModeAria", { mode: homeModeLabel(home, t) })}
          >
            {home?.identity.environmentKind === "wsl" ? <Globe size={14} /> : <Monitor size={14} />}
            <span>{homeModeLabel(home, t)}</span>
            {home?.identity.environmentKind === "wsl" && home.identity.environmentId && (
              <span className="truncate" title={home.identity.environmentId}>· {home.identity.environmentId}</span>
            )}
          </div>
        )}
        <p className="mb-3 break-all text-xs text-text-muted" title={targetProject.path}>
          {targetProject.name} · {targetProject.path}
        </p>

        {error && (
          <div className="mb-3 rounded bg-danger/15 px-2 py-1.5 text-xs text-danger">{error}</div>
        )}

        {!loading && appType !== "grokbuild" && hasCustomProviderStartup && hasOverride && (
          <div className="mb-3 flex items-start gap-1.5 rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-text-secondary">
            <AlertTriangle size={14} strokeWidth={1.5} className="mt-0.5 shrink-0 text-warning" />
            <span className="min-w-0 break-all">{t("providerSwitch.customStartup")}</span>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-text-muted">
            <RefreshCw size={15} className="animate-spin" />
            {t("providerSwitch.loading")}
          </div>
        )}

        {!loading && !error && (
          <div className="mb-1">
            <ProviderSwitchListButton
              selected={followGlobal}
              disabled={applyingId !== null}
              onClick={() => {
                if (!followGlobal) void resetToGlobal();
              }}
              icon={<Database size={18} strokeWidth={2.1} />}
              name={worktree ? t("providerSwitch.followProjectGlobal") : t("providerSwitch.followGlobal")}
              subtitle={
                globalCurrentName
                  ? t("providerSwitch.globalCurrent", { name: globalCurrentName })
                  : t("providerSwitch.globalNotSet")
              }
              trailing={
                applyingId === "__follow_global__" ? (
                  <span className="text-xs text-text-muted">{t("providerSwitch.resetting")}</span>
                ) : followGlobal ? (
                  <Check size={14} strokeWidth={2} style={{ color: "var(--primary)" }} />
                ) : undefined
              }
            />
          </div>
        )}

        {!loading && !error && providers.length === 0 && (
          <div className="py-6 text-center text-sm text-text-muted">
            {t("providerSwitch.empty", { appType: providerTypeLabel(appType, t) })}
          </div>
        )}

        {!loading && providers.length > 0 && (
          <div className="ui-thin-scroll max-h-[50vh] space-y-2.5 overflow-y-auto pr-0">
            {providers.map((provider) => {
              const selected = probe?.providerId === provider.id && (hasOverride || probe?.source === "global");
              const vendor = inferProviderVendor(provider);
              const subtitle = provider.baseUrl ?? provider.category ?? undefined;
              const badges: SwitchBadge[] = [];
              if (applyingId === provider.id) {
                badges.push({ label: t("providerSwitch.switching"), tone: "neutral" });
              } else if (selected) {
                badges.push({ label: t("providerSwitch.active"), tone: "primary" });
              } else if (provider.isCurrent) {
                badges.push({ label: t("providerCatalog.current"), tone: "primary" });
              }
              if (!provider.enabled) {
                badges.push({ label: t("providerCatalog.disabled"), tone: "neutral" });
              } else if (!provider.activeKeyLabel) {
                badges.push({ label: t("providerSwitch.noActiveKey"), tone: "danger" });
              }
              if (!provider.settingsValid) {
                badges.push({ label: t("providerCatalog.invalidConfig"), tone: "danger" });
              }

              return (
                <ProviderSwitchListButton
                  key={provider.id}
                  selected={selected}
                  disabled={
                    applyingId !== null ||
                    !provider.enabled ||
                    !provider.settingsValid ||
                    !provider.activeKeyLabel
                  }
                  onClick={() => void applyProvider(provider)}
                  icon={<VendorIcon vendor={vendor} size={21} fallback={Boxes} />}
                  name={provider.name}
                  subtitle={subtitle}
                  subtitleTitle={provider.baseUrl ?? provider.category ?? undefined}
                  badges={badges}
                />
              );
            })}
          </div>
        )}

        {!loading && appType !== "grokbuild" && override && hasCustomProviderStartup && (
          <p className="mt-3 text-xs text-text-muted">{t("providerSwitch.customStartupHint")}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
