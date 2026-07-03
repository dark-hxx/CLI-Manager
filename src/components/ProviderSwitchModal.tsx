import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { Project } from "../lib/types";
import {
  getClaudeProviderOverride,
  getCodexProviderOverride,
  getProviderSwitchAppType,
  withClaudeProviderOverride,
  withCodexProviderOverride,
} from "../lib/providerSwitching";
import { useI18n } from "../lib/i18n";
import { useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Activity, AlertTriangle, Boxes, Check, ChevronRight, Database, RefreshCw } from "./icons";
import { ProviderBadge, type ProviderBadgeTone } from "./provider/ProviderRow";
import { VendorIcon, inferVendor, type VendorKey } from "./VendorIcon";
import { logError } from "../lib/logger";

interface CcSwitchProvider {
  id: string;
  appType: string;
  name: string;
  category: string | null;
  baseUrl: string | null;
  isCurrent: boolean;
  configParseError: boolean;
  model: string | null;
  apiFormat: string | null;
}

interface ProvidersResponse {
  dbPath: string;
  providers: CcSwitchProvider[];
}

interface ProjectProviderProbe {
  matchedProviderId: string | null;
  hasSettingsFile: boolean;
  baseUrl: string | null;
  localOverrideKeys: string[];
}

interface CodexProviderProfileResponse {
  providerId: string;
  providerName: string;
  profileName: string;
}

interface ClaudeProviderSettingsResponse {
  providerId: string;
  providerName: string;
  settingsPath: string;
}

type ProviderModelTestStatus = "operational" | "degraded" | "failed";

interface ProviderModelTestResult {
  status: ProviderModelTestStatus;
  success: boolean;
  message: string;
  responseTimeMs?: number;
  httpStatus?: number;
  testedAt: number;
  retryCount: number;
}

/** applyingId 的哨兵值：标记"恢复跟随全局"操作进行中 */
const RESET_APPLYING_ID = "__follow_global__";
const MODEL_TEST_BATCH_CONCURRENCY = 3;

const ERROR_HINTS: Record<string, string> = {
  db_not_found: "未找到 cc-switch 数据库文件，请先在 设置 → 供应商 中配置 cc-switch.db。",
  unsupported_format: "cc-switch 数据库路径不是 .db 文件，请到 设置 → 供应商 重新选择。",
  project_not_found: "项目目录不存在或不可访问，请检查项目路径。",
  provider_not_found: "该供应商在 cc-switch 数据库中已不存在，请关闭弹窗后重试。",
  "provider_config_invalid: missing_codex_base_url": "该 Codex 供应商缺少 base_url / OPENAI_BASE_URL 等端点配置，CLI-Manager 无法生成 profile；不需要手动创建文件，请先在 cc-switch 中补全该供应商的 Codex 端点。",
  "provider_config_invalid: missing_codex_api_key": "该 Codex 供应商缺少 API key / token，CLI-Manager 无法注入启动环境；不需要手动创建文件，请先在 cc-switch 中补全密钥。",
  provider_config_invalid: "该供应商配置解析失败，无法应用。",
  settings_parse_failed: "项目 .claude/settings.json 不是合法 JSON，文件未被修改，请先手动修复。",
  settings_write_failed: "写入 settings.json 失败，请检查目录权限。",
  profile_write_failed: "写入 Codex profile 失败，请检查 Codex 配置目录权限。",
};

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  for (const [code, hint] of Object.entries(ERROR_HINTS)) {
    if (message.startsWith(code)) return hint;
  }
  return `操作失败：${message}`;
}

type SwitchBadge = {
  label: string;
  tone: ProviderBadgeTone;
};

function inferProviderVendor(provider: CcSwitchProvider): VendorKey | null {
  return (
    inferVendor(provider.model) ??
    inferVendor(provider.baseUrl) ??
    inferVendor(provider.appType) ??
    inferVendor(provider.name) ??
    inferVendor(provider.category)
  );
}

function providerVendorHint(provider: CcSwitchProvider): string | null {
  return (
    inferProviderVendor(provider) ??
    provider.model ??
    provider.baseUrl ??
    provider.category ??
    provider.name ??
    null
  );
}

function modelTestColor(result: ProviderModelTestResult | undefined): string {
  if (!result) return "var(--text-muted)";
  if (result.status === "operational") return "var(--success)";
  if (result.status === "degraded") return "var(--warning)";
  return "var(--danger)";
}

function failedModelTestResult(message: string): ProviderModelTestResult {
  return {
    status: "failed",
    success: false,
    message,
    testedAt: Math.floor(Date.now() / 1000),
    retryCount: 0,
  };
}

/**
 * 供应商行内的模型测试按钮。
 *
 * 前置条件：父级负责判断供应商配置是否可解析、是否正在切换或测试。
 * 后置结果：点击只触发真实模型测试，不触发行级供应商切换。
 * 副作用：阻止事件冒泡，避免模型测试按钮复用行内空间时误触发切换。
 */
function ProviderModelTestButton({
  title,
  disabled,
  testing,
  result,
  onClick,
}: {
  title: string;
  disabled: boolean;
  testing: boolean;
  result?: ProviderModelTestResult;
  onClick: () => void;
}) {
  const Icon = testing ? RefreshCw : Activity;
  return (
    <button
      type="button"
      className="ui-focus-ring absolute right-8 top-1/2 z-10 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-45"
      style={{
        backgroundColor: "color-mix(in srgb, var(--surface-container-high) 86%, transparent)",
        border: "1px solid color-mix(in srgb, var(--border) 28%, transparent)",
        color: modelTestColor(result),
      }}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      <Icon size={14} strokeWidth={2} className={testing ? "animate-spin" : undefined} />
    </button>
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
      onMouseEnter={(e) => {
        if (!selected && !disabled) e.currentTarget.style.backgroundColor = "var(--surface-container-low)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = "var(--surface-container-lowest)";
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

function buildCodexProbe(project: Project): ProjectProviderProbe {
  const override = getCodexProviderOverride(project);
  return {
    matchedProviderId: override?.providerId ?? null,
    hasSettingsFile: true,
    baseUrl: override ? "codex-profile" : null,
    localOverrideKeys: [],
  };
}

function buildClaudeProbe(project: Project, legacyProbe?: ProjectProviderProbe | null): ProjectProviderProbe {
  const override = getClaudeProviderOverride(project);
  return {
    matchedProviderId: override?.providerId ?? legacyProbe?.matchedProviderId ?? null,
    hasSettingsFile: Boolean(override) || Boolean(legacyProbe?.hasSettingsFile),
    baseUrl: override ? "claude-settings" : legacyProbe?.baseUrl ?? null,
    localOverrideKeys: legacyProbe?.localOverrideKeys ?? [],
  };
}

interface Props {
  project: Project;
  onClose: () => void;
}

export function ProviderSwitchModal({ project, onClose }: Props) {
  const { t } = useI18n();
  const appType = getProviderSwitchAppType(project);
  const ccSwitchDbPath = useSettingsStore((s) => s.ccSwitchDbPath);
  const codexConfigDir = useSettingsStore((s) => s.codexHookConfigDir);
  const [providers, setProviders] = useState<CcSwitchProvider[]>([]);
  const [probe, setProbe] = useState<ProjectProviderProbe | null>(null);
  const [activeCodexProfileName, setActiveCodexProfileName] = useState<string | null>(
    () => getCodexProviderOverride(project)?.profileName ?? null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [testingModelIds, setTestingModelIds] = useState<Set<string>>(() => new Set());
  const [modelTestResults, setModelTestResults] = useState<Record<string, ProviderModelTestResult>>({});
  const [batchTesting, setBatchTesting] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!appType) {
        setProviders([]);
        setProbe(null);
        setError("当前项目 CLI 工具不支持供应商切换。");
        return;
      }
      const dbPath = ccSwitchDbPath ?? undefined;
      const [listRes, probeRes] = await Promise.all([
        invoke<ProvidersResponse>("ccswitch_list_providers", { dbPath }),
        appType === "claude"
          ? invoke<ProjectProviderProbe>("ccswitch_get_project_provider", {
              projectPath: project.path,
              dbPath,
            }).catch((err): ProjectProviderProbe | null => {
              // 探测失败不阻塞供应商列表展示；真正的错误在切换时再呈现
              logError("ccswitch project provider probe failed", { path: project.path, err });
              return null;
            })
          : Promise.resolve(buildCodexProbe(project)),
      ]);
      setProviders(listRes.providers.filter((p) => p.appType === appType));
      setProbe(appType === "claude" ? buildClaudeProbe(project, probeRes) : probeRes);
      if (appType === "codex") {
        setActiveCodexProfileName(getCodexProviderOverride(project)?.profileName ?? null);
      }
    } catch (err) {
      setProviders([]);
      setProbe(null);
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [appType, ccSwitchDbPath, project]);

  useEffect(() => {
    void load();
  }, [load]);

  const showModelTestToast = (provider: CcSwitchProvider, result: ProviderModelTestResult) => {
    const responseTimeMs = result.responseTimeMs ?? 0;
    if (result.status === "operational") {
      toast.success(t("providerSwitch.modelTest.reachable", { name: provider.name, ms: responseTimeMs }));
    } else if (result.status === "degraded") {
      toast.warning(t("providerSwitch.modelTest.slow", { name: provider.name, ms: responseTimeMs }));
    } else {
      toast.error(t("providerSwitch.modelTest.unreachable", { name: provider.name }), {
        description: result.message,
      });
    }
  };

  /**
   * 对单个供应商做真实模型测试。
   *
   * 前置条件：供应商列表已从 cc-switch 读取，且后端可按 providerId 读取完整配置。
   * 后置结果：保存本次测试结果用于行内图标着色；调用方决定是否展示单项 toast。
   * 副作用：会触发一次最小模型请求，可能产生极少量 token 消耗；不修改项目或 cc-switch 数据库。
   */
  const testProviderModel = async (
    provider: CcSwitchProvider,
    options: { showToast?: boolean } = { showToast: true },
  ): Promise<ProviderModelTestResult> => {
    if (!appType) {
      const result = failedModelTestResult("unsupported_app_type");
      setModelTestResults((current) => ({ ...current, [provider.id]: result }));
      return result;
    }
    if (provider.configParseError) {
      const result = failedModelTestResult(t("providerSwitch.modelTest.configInvalid"));
      setModelTestResults((current) => ({ ...current, [provider.id]: result }));
      if (options.showToast !== false) showModelTestToast(provider, result);
      return result;
    }
    if (!provider.baseUrl) {
      const result = failedModelTestResult(t("providerSwitch.modelTest.missingBaseUrl"));
      setModelTestResults((current) => ({ ...current, [provider.id]: result }));
      if (options.showToast !== false) showModelTestToast(provider, result);
      return result;
    }

    setTestingModelIds((current) => new Set(current).add(provider.id));
    try {
      const result = await invoke<ProviderModelTestResult>("ccswitch_test_provider_model", {
        appType,
        providerId: provider.id,
        dbPath: ccSwitchDbPath ?? undefined,
      });
      setModelTestResults((current) => ({ ...current, [provider.id]: result }));
      if (options.showToast !== false) showModelTestToast(provider, result);
      return result;
    } catch (err) {
      const result = failedModelTestResult(String(err));
      setModelTestResults((current) => ({ ...current, [provider.id]: result }));
      if (options.showToast !== false) {
        toast.error(t("providerSwitch.modelTest.error", { name: provider.name }), {
          description: result.message,
        });
      }
      return result;
    } finally {
      setTestingModelIds((current) => {
        const next = new Set(current);
        next.delete(provider.id);
        return next;
      });
    }
  };

  /**
   * 批量测试当前 CLI 类型下的所有供应商。
   *
   * 前置条件：供应商列表已加载完成，且当前弹窗已解析出 appType。
   * 后置结果：每个供应商都会写入一次行内测试结果，并在结束时只弹一次汇总 toast。
   * 副作用：会并发发起真实模型请求；并发数固定为 3，避免一次性触发供应商限流。
   */
  const testAllProviderModels = async () => {
    if (batchTesting || testingModelIds.size > 0 || applyingId !== null || !appType || providers.length === 0) return;

    setBatchTesting(true);
    setBatchProgress({ done: 0, total: providers.length });

    const results: ProviderModelTestResult[] = new Array(providers.length);
    let nextIndex = 0;
    const runWorker = async () => {
      while (nextIndex < providers.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await testProviderModel(providers[index], { showToast: false });
        setBatchProgress((current) =>
          current
            ? { ...current, done: Math.min(current.done + 1, current.total) }
            : current,
        );
      }
    };

    try {
      const workers = Array.from(
        { length: Math.min(MODEL_TEST_BATCH_CONCURRENCY, providers.length) },
        () => runWorker(),
      );
      await Promise.all(workers);

      const normal = results.filter((item) => item?.status === "operational").length;
      const slow = results.filter((item) => item?.status === "degraded").length;
      const failed = results.length - normal - slow;
      const summary = t("providerSwitch.modelTest.batchSummary", {
        total: results.length,
        normal,
        slow,
        failed,
      });
      if (failed > 0) {
        toast.warning(t("providerSwitch.modelTest.batchDone"), { description: summary });
      } else {
        toast.success(t("providerSwitch.modelTest.batchDone"), { description: summary });
      }
    } finally {
      setBatchTesting(false);
      setBatchProgress(null);
    }
  };

  const applyProvider = async (provider: CcSwitchProvider) => {
    if (applyingId || batchTesting || !appType) return;
    setApplyingId(provider.id);
    let shouldReload = true;
    try {
      if (appType === "claude") {
        const result = await invoke<ClaudeProviderSettingsResponse>("ccswitch_prepare_claude_provider", {
          projectId: project.id,
          providerId: provider.id,
          dbPath: ccSwitchDbPath ?? undefined,
        });
        await useProjectStore.getState().updateProject(project.id, {
          provider_overrides: withClaudeProviderOverride(project.provider_overrides, {
            providerId: result.providerId,
            providerName: result.providerName,
            settingsPath: result.settingsPath,
            vendorHint: providerVendorHint(provider),
          }),
        });
        setProbe({
          matchedProviderId: result.providerId,
          hasSettingsFile: true,
          baseUrl: "claude-settings",
          localOverrideKeys: probe?.localOverrideKeys ?? [],
        });
        shouldReload = false;
        toast.success("已切换供应商", {
          description: `${provider.name} 已生成 Claude settings，新开内部终端后生效。`,
        });
      } else {
        const result = await invoke<CodexProviderProfileResponse>("ccswitch_prepare_codex_provider", {
          providerId: provider.id,
          dbPath: ccSwitchDbPath ?? undefined,
          codexConfigDir: codexConfigDir ?? undefined,
        });
        await useProjectStore.getState().updateProject(project.id, {
          provider_overrides: withCodexProviderOverride(project.provider_overrides, {
            providerId: result.providerId,
            providerName: result.providerName,
            profileName: result.profileName,
            vendorHint: providerVendorHint(provider),
          }),
        });
        setProbe({
          matchedProviderId: result.providerId,
          hasSettingsFile: true,
          baseUrl: "codex-profile",
          localOverrideKeys: [],
        });
        setActiveCodexProfileName(result.profileName);
        shouldReload = false;
        toast.success("已切换供应商", {
          description: `${provider.name} 已生成 Codex profile，新开内部终端后生效。`,
        });
      }
      if (shouldReload) await load();
      void useProjectStore.getState().refreshProviderBadges();
    } catch (err) {
      toast.error("切换供应商失败", { description: formatError(err) });
    } finally {
      setApplyingId(null);
    }
  };

  const resetToGlobal = async () => {
    if (applyingId || batchTesting || !appType) return;
    setApplyingId(RESET_APPLYING_ID);
    let shouldReload = true;
    try {
      if (appType === "claude") {
        await useProjectStore.getState().updateProject(project.id, {
          provider_overrides: withClaudeProviderOverride(project.provider_overrides, null),
        });
        setProbe({
          matchedProviderId: null,
          hasSettingsFile: Boolean(probe?.hasSettingsFile),
          baseUrl: null,
          localOverrideKeys: probe?.localOverrideKeys ?? [],
        });
        shouldReload = false;
      } else {
        await useProjectStore.getState().updateProject(project.id, {
          provider_overrides: withCodexProviderOverride(project.provider_overrides, null),
        });
        setProbe(buildCodexProbe({ ...project, provider_overrides: withCodexProviderOverride(project.provider_overrides, null) }));
        setActiveCodexProfileName(null);
        shouldReload = false;
      }
      toast.success("已恢复跟随全局", {
        description: "已移除项目级供应商配置，新开终端后生效。",
      });
      if (shouldReload) await load();
      void useProjectStore.getState().refreshProviderBadges();
    } catch (err) {
      toast.error("恢复全局失败", { description: formatError(err) });
    } finally {
      setApplyingId(null);
    }
  };

  // Claude/Codex 都以 provider_overrides 记录判断项目级覆盖；legacy Claude path probe 只用于兼容显示。
  const hasOverride = probe != null && (probe.baseUrl != null || probe.matchedProviderId != null);
  const followGlobal = probe != null && !hasOverride;
  const globalCurrentName = providers.find((p) => p.isCurrent)?.name ?? null;
  const localOverrideKeys = appType === "claude" ? probe?.localOverrideKeys ?? [] : [];
  const hasCustomProviderStartup = (appType === "codex" || appType === "claude") && project.startup_cmd.trim().length > 0;

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
            切换供应商
          </DialogTitle>
          {!loading && !error && providers.length > 0 && (
            <button
              type="button"
              className="ui-focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                backgroundColor: "color-mix(in srgb, var(--primary) 10%, var(--surface-container-lowest))",
                border: "1px solid color-mix(in srgb, var(--primary) 28%, transparent)",
                color: "var(--primary)",
              }}
              title={t("providerSwitch.modelTest.batchAction")}
              aria-label={t("providerSwitch.modelTest.batchAction")}
              disabled={batchTesting || testingModelIds.size > 0 || applyingId !== null}
              onClick={() => void testAllProviderModels()}
            >
              {batchTesting ? (
                <RefreshCw size={13} strokeWidth={2} className="animate-spin" />
              ) : (
                <Activity size={13} strokeWidth={2} />
              )}
              <span>
                {batchTesting && batchProgress
                  ? t("providerSwitch.modelTest.batchProgress", {
                      done: batchProgress.done,
                      total: batchProgress.total,
                    })
                  : t("providerSwitch.modelTest.batchAction")}
              </span>
            </button>
          )}
        </div>
        <p className="mb-3 break-all text-xs text-text-muted" title={project.path}>
          {project.name} · {project.path}
        </p>

        {error && (
          <div className="mb-3 rounded bg-danger/15 px-2 py-1.5 text-xs text-danger">{error}</div>
        )}

        {!loading && localOverrideKeys.length > 0 && (
          <div className="mb-3 flex items-start gap-1.5 rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-text-secondary">
            <AlertTriangle size={14} strokeWidth={1.5} className="mt-0.5 shrink-0 text-warning" />
            <span className="min-w-0 break-all">
              检测到 settings.local.json 中配置了 {localOverrideKeys.join("、")}
              ，其优先级更高，会覆盖此处的切换结果。
            </span>
          </div>
        )}

        {!loading && hasCustomProviderStartup && probe?.matchedProviderId && (
          <div className="mb-3 flex items-start gap-1.5 rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-text-secondary">
            <AlertTriangle size={14} strokeWidth={1.5} className="mt-0.5 shrink-0 text-warning" />
            <span className="min-w-0 break-all">
              该项目配置了自定义启动命令，CLI-Manager 不会自动改写；请手动加入 {appType === "codex" ? `--profile ${activeCodexProfileName ?? "cli-manager-..."}` : `--settings ${getClaudeProviderOverride(project)?.settingsPath ?? "<settings-file>"}`}。
            </span>
          </div>
        )}

        {loading && (
          <div className="py-6 text-center text-sm text-text-muted">加载中…</div>
        )}

        {!loading && !error && (
          <div className="mb-1">
            <ProviderSwitchListButton
              selected={followGlobal}
              disabled={applyingId !== null || batchTesting}
              onClick={() => {
                if (!followGlobal) void resetToGlobal();
              }}
              icon={<Database size={18} strokeWidth={2.1} />}
              name="跟随全局供应商"
              subtitle={globalCurrentName ? `当前全局：${globalCurrentName}` : `cc-switch 未设置 ${appType ?? "当前 CLI"} 全局当前供应商`}
              trailing={
                applyingId === RESET_APPLYING_ID ? (
                  <span className="text-xs text-text-muted">恢复中…</span>
                ) : followGlobal ? (
                  <Check size={14} strokeWidth={2} style={{ color: "var(--primary)" }} />
                ) : undefined
              }
            />
          </div>
        )}

        {!loading && !error && appType === "claude" && hasOverride && probe?.matchedProviderId == null && (
          <p className="mb-2 text-xs text-text-muted">
            项目为自定义配置（未匹配到 cc-switch 供应商）。
          </p>
        )}

        {!loading && !error && providers.length === 0 && (
          <div className="py-6 text-center text-sm text-text-muted">
            cc-switch 中没有 {appType ?? "当前 CLI"} 供应商。
          </div>
        )}

        {!loading && providers.length > 0 && (
          <div className="ui-thin-scroll max-h-[50vh] space-y-2.5 overflow-y-auto pr-0">
            {providers.map((provider) => {
              const matched = probe?.matchedProviderId === provider.id;
              const vendor = inferProviderVendor(provider);
              const subtitle = provider.baseUrl ?? provider.category ?? undefined;
              const modelTestResult = modelTestResults[provider.id];
              const testingModel = testingModelIds.has(provider.id);
              const badges: SwitchBadge[] = [];
              if (applyingId === provider.id) {
                badges.push({ label: "切换中…", tone: "neutral" });
              } else if (matched) {
                badges.push({ label: "ACTIVE", tone: "primary" });
              } else if (provider.isCurrent) {
                badges.push({ label: "当前", tone: "primary" });
              } else if (provider.category) {
                badges.push({ label: provider.category, tone: "neutral" });
              }
              if (provider.configParseError) badges.push({ label: "配置解析失败", tone: "danger" });
              const modelTestTitle = provider.configParseError
                ? t("providerSwitch.modelTest.configInvalid")
                : !provider.baseUrl
                  ? t("providerSwitch.modelTest.missingBaseUrl")
                  : testingModel
                    ? t("providerSwitch.modelTest.checking")
                    : modelTestResult
                      ? modelTestResult.success
                        ? t("providerSwitch.modelTest.lastReachable", {
                            ms: modelTestResult.responseTimeMs ?? 0,
                            status: modelTestResult.httpStatus ?? "-",
                          })
                        : t("providerSwitch.modelTest.lastFailed", {
                            message: modelTestResult.message,
                          })
                      : t("providerSwitch.modelTest.action");

              return (
                <div key={provider.id} className="relative">
                  <ProviderSwitchListButton
                    selected={matched}
                    disabled={applyingId !== null || batchTesting || provider.configParseError}
                    onClick={() => void applyProvider(provider)}
                    icon={<VendorIcon vendor={vendor} size={21} fallback={Boxes} />}
                    name={provider.name}
                    subtitle={subtitle}
                    subtitleTitle={provider.baseUrl ?? provider.category ?? undefined}
                    trailing={
                      <span className="mr-7 flex items-center gap-1.5">
                        {badges.map((badge) => (
                          <ProviderBadge key={`${badge.tone}-${badge.label}`} tone={badge.tone}>
                            {badge.label}
                          </ProviderBadge>
                        ))}
                      </span>
                    }
                  />
                  <ProviderModelTestButton
                    title={modelTestTitle}
                    disabled={applyingId !== null || batchTesting || provider.configParseError || !provider.baseUrl || testingModel}
                    testing={testingModel}
                    result={modelTestResult}
                    onClick={() => void testProviderModel(provider)}
                  />
                </div>
              );
            })}
          </div>
        )}

        {!loading && appType === "claude" && probe && !probe.hasSettingsFile && (
          <p className="mt-3 text-xs text-text-muted">
            该项目暂无项目级供应商配置，切换后将生成 CLI-Manager settings 文件。
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
