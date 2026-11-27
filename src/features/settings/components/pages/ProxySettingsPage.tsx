import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Badge, Button, Group, SegmentedControl, Stack, Switch, Text } from "@mantine/core";
import { ChevronDown, Globe, Network, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../../../../shared/i18n/index";
import { PROJECT_CLI_TOOL_OPTIONS, type CliToolDescriptor } from "../../../../shared/lib/cliTools";
import {
  buildProxyUrlFromParts,
  collectProxyCopySources,
  normalizeAgentProxyRule,
  parseProxyUrlToParts,
  sanitizeProxyUrlForDisplay,
  type AgentProxyRule,
  type ProxyCopySource,
  type ProxyScopeMode,
  type ProxySettings,
  type ProxyTestConnectionResult,
  type ProxyUrlParts,
} from "../../../../shared/lib/proxySettings";
import { useSettingsStore } from "../../../../shared/preferences/settingsStore";
import { CliToolIcon } from "../../../../shared/ui/CliToolIcon";
import { ProxyCopyFromMenu } from "../ProxyCopyFromMenu";
import { ProxyEndpointFields, type ProxyEndpointTestState } from "../ProxyEndpointFields";
import { SettingsGlyph } from "../SettingsIcons";

interface AgentDraftState {
  mode: ProxyScopeMode;
  parts: ProxyUrlParts;
  noProxy: string;
}

interface GlobalDraftState {
  enabled: boolean;
  parts: ProxyUrlParts;
  noProxy: string;
}

type AgentFilterMode = "all" | "overridden";

function getValidationErrorKey(code: string): TranslationKey {
  switch (code) {
    case "proxy_url_empty":
      return "settings.proxy.error.urlEmpty";
    case "proxy_scheme_unsupported":
      return "settings.proxy.error.schemeUnsupported";
    case "proxy_host_missing":
      return "settings.proxy.error.hostMissing";
    case "proxy_port_invalid":
      return "settings.proxy.error.portInvalid";
    case "proxy_connect_timeout":
      return "settings.proxy.error.connectTimeout";
    case "proxy_connect_refused":
      return "settings.proxy.error.connectRefused";
    case "proxy_connect_failed":
      return "settings.proxy.error.connectFailed";
    default:
      return "settings.proxy.error.urlInvalid";
  }
}

function agentRuleToDraft(rule?: AgentProxyRule): AgentDraftState {
  const normalized = normalizeAgentProxyRule(rule);
  return {
    mode: normalized.mode,
    parts: parseProxyUrlToParts(normalized.url),
    noProxy: normalized.noProxy,
  };
}

function partsEqual(left: ProxyUrlParts, right: ProxyUrlParts): boolean {
  return (
    left.scheme === right.scheme &&
    left.host.trim() === right.host.trim() &&
    left.port.trim() === right.port.trim() &&
    left.username === right.username &&
    left.password === right.password
  );
}

function globalDraftMatchesSaved(draft: GlobalDraftState, saved: ProxySettings): boolean {
  const savedParts = parseProxyUrlToParts(saved.globalUrl);
  return (
    draft.enabled === saved.globalEnabled &&
    partsEqual(draft.parts, savedParts) &&
    draft.noProxy.trim() === saved.globalNoProxy
  );
}

function agentDraftMatchesSaved(draft: AgentDraftState, savedRule?: AgentProxyRule): boolean {
  const saved = agentRuleToDraft(savedRule);
  return (
    draft.mode === saved.mode &&
    partsEqual(draft.parts, saved.parts) &&
    draft.noProxy.trim() === saved.noProxy
  );
}

export function ProxySettingsPage() {
  const { t } = useI18n();
  const proxySettings = useSettingsStore((s) => s.proxySettings);
  const update = useSettingsStore((s) => s.update);
  const globalCardRef = useRef<HTMLElement | null>(null);

  const [globalExpanded, setGlobalExpanded] = useState(
    () => proxySettings.globalEnabled && !proxySettings.globalUrl.trim(),
  );
  const [globalDraft, setGlobalDraft] = useState<GlobalDraftState | null>(null);
  const [globalError, setGlobalError] = useState("");
  const [globalTest, setGlobalTest] = useState<ProxyEndpointTestState>({ status: "idle" });
  const [savingGlobal, setSavingGlobal] = useState(false);

  const [selectedAgentId, setSelectedAgentId] = useState<string>(() => {
    const overridden = PROJECT_CLI_TOOL_OPTIONS.find((tool) => {
      const rule = proxySettings.agents[tool.id];
      return rule && rule.mode !== "inherit";
    });
    return overridden?.id ?? PROJECT_CLI_TOOL_OPTIONS[0]?.id ?? "";
  });
  const [agentFilter, setAgentFilter] = useState<AgentFilterMode>("all");
  const [agentDrafts, setAgentDrafts] = useState<Record<string, AgentDraftState>>({});
  const [agentErrors, setAgentErrors] = useState<Record<string, string>>({});
  const [agentTests, setAgentTests] = useState<Record<string, ProxyEndpointTestState>>({});
  const [savingAgentId, setSavingAgentId] = useState<string | null>(null);

  const savedGlobal = useMemo<GlobalDraftState>(
    () => ({
      enabled: proxySettings.globalEnabled,
      parts: parseProxyUrlToParts(proxySettings.globalUrl),
      noProxy: proxySettings.globalNoProxy,
    }),
    [proxySettings.globalEnabled, proxySettings.globalNoProxy, proxySettings.globalUrl],
  );

  const effectiveGlobal = globalDraft ?? savedGlobal;
  const globalDirty =
    globalDraft !== null && !globalDraftMatchesSaved(globalDraft, proxySettings);

  const patchGlobalDraft = (patch: Partial<GlobalDraftState>) => {
    setGlobalDraft((prev) => ({ ...(prev ?? savedGlobal), ...patch }));
  };

  const getAgentDraft = (agentId: string): AgentDraftState =>
    agentDrafts[agentId] ?? agentRuleToDraft(proxySettings.agents[agentId]);

  const setAgentDraft = (agentId: string, patch: Partial<AgentDraftState>) => {
    setAgentDrafts((prev) => {
      const current = prev[agentId] ?? agentRuleToDraft(proxySettings.agents[agentId]);
      const next = { ...current, ...patch };
      if (agentDraftMatchesSaved(next, proxySettings.agents[agentId])) {
        const copy = { ...prev };
        delete copy[agentId];
        return copy;
      }
      return { ...prev, [agentId]: next };
    });
  };

  const resetAgentDraft = (agentId: string) => {
    setAgentDrafts((prev) => {
      if (!(agentId in prev)) return prev;
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
    setAgentErrors((prev) => {
      if (!(agentId in prev)) return prev;
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
    setAgentTests((prev) => ({ ...prev, [agentId]: { status: "idle" } }));
  };

  const runConnectivityTest = async (
    parts: ProxyUrlParts,
    setFeedback: (next: ProxyEndpointTestState) => void,
    setFieldError?: (msg: string) => void,
  ) => {
    const built = buildProxyUrlFromParts(parts);
    if (!built.ok) {
      const msg = t(getValidationErrorKey(built.code));
      setFieldError?.(msg);
      setFeedback({ status: "error", message: msg });
      return;
    }
    setFieldError?.("");
    setFeedback({ status: "testing" });
    try {
      const result = await invoke<ProxyTestConnectionResult>("proxy_test_connection", {
        proxyUrl: built.url,
        timeoutMs: 3000,
      });
      if (result.ok) {
        setFeedback({
          status: "ok",
          message: t("settings.proxy.testSuccess", { latency: result.latencyMs ?? 0 }),
        });
      } else {
        const key = getValidationErrorKey(result.errorCode ?? "proxy_connect_failed");
        const message = result.detail ? `${t(key)} (${result.detail})` : t(key);
        setFeedback({ status: "error", message });
      }
    } catch (err) {
      setFeedback({ status: "error", message: String(err) });
    }
  };

  const persistProxySettings = async (next: ProxySettings) => {
    await update("proxySettings", next);
  };

  const handleToggleGlobal = async (enabled: boolean) => {
    const current = globalDraft ?? savedGlobal;
    const hasEndpoint = Boolean(current.parts.host.trim() || current.parts.port.trim());
    let nextUrl = proxySettings.globalUrl;

    if (enabled) {
      if (!hasEndpoint) {
        const msg = t("settings.proxy.error.urlEmpty");
        setGlobalExpanded(true);
        setGlobalError(msg);
        toast.error(msg);
        return;
      }
      const built = buildProxyUrlFromParts(current.parts);
      if (!built.ok) {
        const msg = t(getValidationErrorKey(built.code));
        setGlobalExpanded(true);
        setGlobalError(msg);
        toast.error(msg);
        return;
      }
      nextUrl = built.url;
    } else if (hasEndpoint) {
      const built = buildProxyUrlFromParts(current.parts);
      if (built.ok) {
        nextUrl = built.url;
      }
    }

    setGlobalError("");
    setSavingGlobal(true);
    try {
      await persistProxySettings({
        ...proxySettings,
        globalEnabled: enabled,
        globalUrl: nextUrl,
        globalNoProxy: current.noProxy.trim(),
      });
      setGlobalDraft(null);
      toast.success(t("settings.proxy.toast.saved"));
    } catch (err) {
      toast.error(t("settings.proxy.toast.saveFailed"), { description: String(err) });
    } finally {
      setSavingGlobal(false);
    }
  };

  const handleSaveGlobal = async () => {
    const current = globalDraft ?? savedGlobal;
    const hasEndpoint = Boolean(current.parts.host.trim() || current.parts.port.trim());
    let nextUrl = "";
    if (current.enabled || hasEndpoint) {
      const built = buildProxyUrlFromParts(current.parts);
      if (!built.ok) {
        const msg = t(getValidationErrorKey(built.code));
        setGlobalError(msg);
        toast.error(msg);
        return;
      }
      nextUrl = built.url;
    }
    setGlobalError("");
    setSavingGlobal(true);
    try {
      await persistProxySettings({
        ...proxySettings,
        globalEnabled: current.enabled,
        globalUrl: nextUrl,
        globalNoProxy: current.noProxy.trim(),
      });
      setGlobalDraft(null);
      toast.success(t("settings.proxy.toast.saved"));
    } catch (err) {
      toast.error(t("settings.proxy.toast.saveFailed"), { description: String(err) });
    } finally {
      setSavingGlobal(false);
    }
  };

  const handleResetGlobal = () => {
    setGlobalDraft(null);
    setGlobalError("");
    setGlobalTest({ status: "idle" });
  };

  const handleSaveAgent = async (tool: CliToolDescriptor) => {
    const draft = getAgentDraft(tool.id);
    let nextUrl = "";
    if (draft.mode === "custom") {
      const built = buildProxyUrlFromParts(draft.parts);
      if (!built.ok) {
        const msg = t(getValidationErrorKey(built.code));
        setAgentErrors((prev) => ({ ...prev, [tool.id]: msg }));
        toast.error(msg);
        return;
      }
      nextUrl = built.url;
    }
    setAgentErrors((prev) => {
      const next = { ...prev };
      delete next[tool.id];
      return next;
    });
    const nextAgents = { ...proxySettings.agents };
    if (draft.mode === "inherit") {
      delete nextAgents[tool.id];
    } else if (draft.mode === "direct") {
      nextAgents[tool.id] = { mode: "direct", url: "", noProxy: "" };
    } else {
      nextAgents[tool.id] = {
        mode: "custom",
        url: nextUrl,
        noProxy: draft.noProxy.trim(),
      };
    }

    setSavingAgentId(tool.id);
    try {
      await persistProxySettings({
        ...proxySettings,
        agents: nextAgents,
      });
      setAgentDrafts((prev) => {
        if (!(tool.id in prev)) return prev;
        const copy = { ...prev };
        delete copy[tool.id];
        return copy;
      });
      toast.success(t("settings.proxy.toast.agentSaved", { agent: tool.label }));
    } catch (err) {
      toast.error(t("settings.proxy.toast.saveFailed"), { description: String(err) });
    } finally {
      setSavingAgentId(null);
    }
  };

  const handleCopyToGlobal = (source: ProxyCopySource) => {
    setGlobalExpanded(true);
    patchGlobalDraft({
      parts: { ...source.parts },
      noProxy: source.noProxy,
    });
    setGlobalError("");
    setGlobalTest({ status: "idle" });
    toast.success(t("settings.proxy.toast.copiedFrom", { source: source.label }));
  };

  const handleCopyToAgent = (tool: CliToolDescriptor, source: ProxyCopySource) => {
    setAgentDraft(tool.id, {
      mode: "custom",
      parts: { ...source.parts },
      noProxy: source.noProxy,
    });
    setAgentErrors((prev) => {
      const next = { ...prev };
      delete next[tool.id];
      return next;
    });
    setAgentTests((prev) => ({ ...prev, [tool.id]: { status: "idle" } }));
    toast.success(t("settings.proxy.toast.copiedFrom", { source: source.label }));
  };

  const renderCopySourceIcon = (source: ProxyCopySource) => {
    if (source.kind === "global") {
      return <Globe size={14} />;
    }
    const tool = PROJECT_CLI_TOOL_OPTIONS.find((item) => item.id === source.id);
    return tool ? <CliToolIcon icon={tool.icon} size={14} /> : <Globe size={14} />;
  };

  const globalCopySources = useMemo(
    () =>
      collectProxyCopySources({
        settings: proxySettings,
        agents: PROJECT_CLI_TOOL_OPTIONS,
        globalLabel: t("settings.proxy.copyFrom.globalSource"),
        excludeId: "global",
        agentDrafts,
      }),
    [agentDrafts, proxySettings, t],
  );

  const selectedTool =
    PROJECT_CLI_TOOL_OPTIONS.find((tool) => tool.id === selectedAgentId) ??
    PROJECT_CLI_TOOL_OPTIONS[0];

  const agentCopySources = useMemo(
    () =>
      selectedTool
        ? collectProxyCopySources({
            settings: proxySettings,
            agents: PROJECT_CLI_TOOL_OPTIONS,
            globalLabel: t("settings.proxy.copyFrom.globalSource"),
            excludeId: selectedTool.id,
            globalDraft: globalDraft ? { parts: globalDraft.parts, noProxy: globalDraft.noProxy } : null,
            agentDrafts,
          })
        : [],
    [agentDrafts, globalDraft, proxySettings, selectedTool, t],
  );

  const { customCount, directCount, overriddenCount } = useMemo(() => {
    let custom = 0;
    let direct = 0;
    for (const tool of PROJECT_CLI_TOOL_OPTIONS) {
      const rule = proxySettings.agents[tool.id];
      if (rule?.mode === "custom") custom += 1;
      else if (rule?.mode === "direct") direct += 1;
    }
    return { customCount: custom, directCount: direct, overriddenCount: custom + direct };
  }, [proxySettings.agents]);

  const visibleTools = useMemo(() => {
    if (agentFilter === "all") return PROJECT_CLI_TOOL_OPTIONS;
    return PROJECT_CLI_TOOL_OPTIONS.filter((tool) => {
      const savedMode = proxySettings.agents[tool.id]?.mode ?? "inherit";
      const draftMode = agentDrafts[tool.id]?.mode ?? savedMode;
      return savedMode !== "inherit" || draftMode !== "inherit" || tool.id === selectedTool?.id;
    });
  }, [agentDrafts, agentFilter, proxySettings.agents, selectedTool?.id]);

  const savedGlobalDisplayUrl = sanitizeProxyUrlForDisplay(proxySettings.globalUrl);
  const globalActive = proxySettings.globalEnabled && Boolean(savedGlobalDisplayUrl);
  const globalStatusBadge = (() => {
    if (globalActive) {
      return (
        <Badge
          variant="light"
          color="gray"
          size="sm"
          className="proxy-pill proxy-status-badge"
          data-tone="success"
        >
          {t("settings.proxy.global.statusEnabled", { url: savedGlobalDisplayUrl })}
        </Badge>
      );
    }
    if (effectiveGlobal.enabled) {
      return (
        <Badge
          variant="light"
          color="gray"
          size="sm"
          className="proxy-pill proxy-status-badge"
          data-tone="warning"
        >
          {t("settings.proxy.global.statusPending")}
        </Badge>
      );
    }
    if (savedGlobalDisplayUrl) {
      return (
        <Badge
          variant="light"
          color="gray"
          size="sm"
          className="proxy-pill proxy-status-badge"
          data-tone="neutral"
        >
          {t("settings.proxy.global.statusDisabledSaved", { url: savedGlobalDisplayUrl })}
        </Badge>
      );
    }
    return (
      <Badge
        variant="light"
        color="gray"
        size="sm"
        className="proxy-pill proxy-status-badge"
        data-tone="neutral"
      >
        {t("settings.proxy.global.statusDisabled")}
      </Badge>
    );
  })();

  const renderSavedAgentBadge = (toolId: string) => {
    const saved = proxySettings.agents[toolId];
    if (!saved || saved.mode === "inherit") {
      if (globalActive) {
        return (
          <Badge
            variant="light"
            color="gray"
            size="sm"
            className="proxy-pill proxy-status-badge"
            data-tone="neutral"
          >
            {t("settings.proxy.badge.inheritGlobal", { url: savedGlobalDisplayUrl })}
          </Badge>
        );
      }
      return (
        <Badge
          variant="light"
          color="gray"
          size="sm"
          className="proxy-pill proxy-status-badge"
          data-tone="neutral"
        >
          {t("settings.proxy.badge.inheritNone")}
        </Badge>
      );
    }
    if (saved.mode === "direct") {
      return (
        <Badge
          variant="light"
          color="gray"
          size="sm"
          className="proxy-pill proxy-status-badge"
          data-tone="success"
        >
          {t("settings.proxy.badge.direct")}
        </Badge>
      );
    }
    return (
      <Badge
        variant="light"
        color="gray"
        size="sm"
        className="proxy-pill proxy-status-badge"
        data-tone="primary"
      >
        {t("settings.proxy.badge.custom", { url: sanitizeProxyUrlForDisplay(saved.url) })}
      </Badge>
    );
  };

  const renderRailSummary = (tool: CliToolDescriptor) => {
    const draft = getAgentDraft(tool.id);
    if (draft.mode === "custom") {
      const built = buildProxyUrlFromParts(draft.parts);
      if (built.ok) {
        return { text: sanitizeProxyUrlForDisplay(built.url), tone: "custom" as const };
      }
      return { text: t("settings.proxy.agents.statusCustom"), tone: "custom" as const };
    }
    if (draft.mode === "direct") {
      return { text: t("settings.proxy.agents.statusDirect"), tone: "direct" as const };
    }
    if (proxySettings.globalEnabled && savedGlobalDisplayUrl) {
      return {
        text: t("settings.proxy.badge.inheritGlobal", { url: savedGlobalDisplayUrl }),
        tone: "inherit" as const,
      };
    }
    return { text: t("settings.proxy.agents.statusInherit"), tone: "inherit" as const };
  };

  const selectedDraft = selectedTool ? getAgentDraft(selectedTool.id) : null;
  const selectedDirty = selectedTool
    ? Boolean(
        agentDrafts[selectedTool.id] &&
          !agentDraftMatchesSaved(agentDrafts[selectedTool.id], proxySettings.agents[selectedTool.id]),
      )
    : false;
  const selectedError = selectedTool ? (agentErrors[selectedTool.id] ?? "") : "";
  const selectedTest = selectedTool ? (agentTests[selectedTool.id] ?? { status: "idle" }) : { status: "idle" as const };

  return (
    <div className="proxy-settings-page">
      <section ref={globalCardRef} className="proxy-global-card">
        <div className="proxy-global-header">
          <div className="proxy-global-lead">
            <span
              className="proxy-icon-tile"
              data-active={globalActive ? "true" : undefined}
              aria-hidden="true"
            >
              <SettingsGlyph name="globe" classic={Globe} size={18} />
            </span>
            <div className="proxy-global-copy">
              <div className="proxy-global-title-row">
                <h3 className="proxy-global-title">{t("settings.proxy.global.title")}</h3>
                {globalStatusBadge}
                {globalDirty && (
                  <Badge variant="light" color="gray" size="sm" className="proxy-pill" data-tone="warning">
                    {t("settings.proxy.agents.unsaved")}
                  </Badge>
                )}
              </div>
              <p className="proxy-global-desc">{t("settings.proxy.global.enableDescription")}</p>
            </div>
          </div>

          <div className="proxy-global-controls">
            <Button
              variant="default"
              size="xs"
              rightSection={
                <ChevronDown
                  size={14}
                  style={{
                    transform: globalExpanded ? "rotate(180deg)" : undefined,
                    transition: "transform 150ms ease",
                  }}
                />
              }
              aria-expanded={globalExpanded}
              onClick={() => setGlobalExpanded((prev) => !prev)}
            >
              {t(globalExpanded ? "settings.proxy.global.collapse" : "settings.proxy.global.configure")}
            </Button>
            <Switch
              color="cliPrimary"
              checked={effectiveGlobal.enabled}
              disabled={savingGlobal}
              onChange={(event) => void handleToggleGlobal(event.currentTarget.checked)}
              aria-label={t("settings.proxy.global.enableAria")}
            />
          </div>
        </div>

        {globalExpanded && (
          <div className="proxy-global-body">
            <div className="proxy-global-toolbar">
              <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 0 }}>
                {t("settings.proxy.fields.urlHint")}
              </Text>
              <ProxyCopyFromMenu
                sources={globalCopySources}
                onSelect={handleCopyToGlobal}
                renderIcon={renderCopySourceIcon}
                disabled={savingGlobal}
              />
            </div>

            <ProxyEndpointFields
              parts={effectiveGlobal.parts}
              noProxy={effectiveGlobal.noProxy}
              onPartsChange={(nextParts) => {
                patchGlobalDraft({ parts: nextParts });
                setGlobalError("");
                setGlobalTest({ status: "idle" });
              }}
              onNoProxyChange={(nextNoProxy) => patchGlobalDraft({ noProxy: nextNoProxy })}
              error={globalError}
              testState={globalTest}
              onTestConnection={() =>
                void runConnectivityTest(effectiveGlobal.parts, setGlobalTest, setGlobalError)
              }
              secondaryAction={
                globalDirty ? (
                  <Button
                    variant="subtle"
                    size="xs"
                    color="gray"
                    disabled={savingGlobal}
                    leftSection={<RotateCcw size={13} />}
                    onClick={handleResetGlobal}
                  >
                    {t("settings.proxy.actions.reset")}
                  </Button>
                ) : undefined
              }
              footerAction={
                <Button
                  size="xs"
                  color="cliPrimary"
                  loading={savingGlobal}
                  disabled={!globalDirty && !globalError}
                  leftSection={<Save size={13} />}
                  onClick={() => void handleSaveGlobal()}
                >
                  {t("common.save")}
                </Button>
              }
            />
          </div>
        )}

        <div className="proxy-precedence-bar">
          <Network size={14} className="proxy-precedence-icon" aria-hidden="true" />
          <span>
            {t("settings.proxy.priorityNoticeDescription")} {t("settings.proxy.global.description")}
          </span>
        </div>
      </section>

      <section className="proxy-agents-section">
        <div className="proxy-agents-heading">
          <div className="proxy-agents-heading-copy">
            <h3 className="proxy-agents-title">{t("settings.proxy.agents.title")}</h3>
            <p className="proxy-agents-desc">{t("settings.proxy.agents.description")}</p>
          </div>
          <div className="proxy-agents-toolbar">
            {customCount > 0 && (
              <Badge variant="light" color="gray" size="sm" className="proxy-pill" data-tone="primary">
                {t("settings.proxy.agents.summaryCustom", { count: customCount })}
              </Badge>
            )}
            {directCount > 0 && (
              <Badge variant="light" color="gray" size="sm" className="proxy-pill" data-tone="success">
                {t("settings.proxy.agents.summaryDirect", { count: directCount })}
              </Badge>
            )}
            <SegmentedControl
              size="xs"
              className="proxy-filter-segmented"
              value={agentFilter}
              onChange={(value) => setAgentFilter(value as AgentFilterMode)}
              data={[
                {
                  value: "all",
                  label: t("settings.proxy.agents.filterAll", {
                    count: PROJECT_CLI_TOOL_OPTIONS.length,
                  }),
                },
                {
                  value: "overridden",
                  label: t("settings.proxy.agents.filterOverridden", { count: overriddenCount }),
                },
              ]}
            />
          </div>
        </div>

        <div className="proxy-agent-workspace">
          <div className="proxy-agent-rail" role="listbox" aria-label={t("settings.proxy.agents.title")}>
            {visibleTools.map((tool) => {
              const isSelected = selectedTool?.id === tool.id;
              const draft = getAgentDraft(tool.id);
              const isDirty = Boolean(
                agentDrafts[tool.id] &&
                  !agentDraftMatchesSaved(agentDrafts[tool.id], proxySettings.agents[tool.id]),
              );
              const summary = renderRailSummary(tool);
              const dotState = isDirty ? "dirty" : draft.mode;

              return (
                <button
                  key={tool.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-selected={isSelected ? "true" : undefined}
                  className="proxy-agent-item"
                  onClick={() => setSelectedAgentId(tool.id)}
                >
                  <span className="proxy-agent-icon" aria-hidden="true">
                    <CliToolIcon icon={tool.icon} size={16} />
                  </span>
                  <span className="proxy-agent-meta">
                    <span className="proxy-agent-name-row">
                      <span className="proxy-agent-name">{tool.label}</span>
                      <code className="proxy-agent-cmd">{tool.command}</code>
                    </span>
                    <span className="proxy-agent-sub" data-tone={summary.tone}>
                      {summary.text}
                    </span>
                  </span>
                  <span className="proxy-status-dot" data-state={dotState} aria-hidden="true" />
                </button>
              );
            })}
          </div>

          {selectedTool && selectedDraft && (
            <div className="proxy-agent-detail">
              <div className="proxy-detail-header">
                <div className="proxy-detail-identity">
                  <span className="proxy-detail-icon" aria-hidden="true">
                    <CliToolIcon icon={selectedTool.icon} size={20} />
                  </span>
                  <div className="proxy-detail-title-group">
                    <div className="proxy-detail-name-row">
                      <span className="proxy-detail-name">{selectedTool.label}</span>
                      <code className="proxy-agent-cmd">{selectedTool.command}</code>
                      {selectedDirty && (
                        <Badge variant="light" color="gray" size="sm" className="proxy-pill" data-tone="warning">
                          {t("settings.proxy.agents.unsaved")}
                        </Badge>
                      )}
                    </div>
                    <div className="proxy-detail-badge-row">
                      {renderSavedAgentBadge(selectedTool.id)}
                    </div>
                  </div>
                </div>

                <ProxyCopyFromMenu
                  sources={agentCopySources}
                  onSelect={(source) => handleCopyToAgent(selectedTool, source)}
                  renderIcon={renderCopySourceIcon}
                  disabled={savingAgentId === selectedTool.id}
                />
              </div>

              <Stack gap="md">
                <SegmentedControl
                  fullWidth
                  value={selectedDraft.mode}
                  onChange={(value) => {
                    setAgentDraft(selectedTool.id, { mode: value as ProxyScopeMode });
                    setAgentErrors((prev) => {
                      const next = { ...prev };
                      delete next[selectedTool.id];
                      return next;
                    });
                    setAgentTests((prev) => ({
                      ...prev,
                      [selectedTool.id]: { status: "idle" },
                    }));
                  }}
                  data={[
                    { value: "inherit", label: t("settings.proxy.mode.inherit") },
                    { value: "custom", label: t("settings.proxy.mode.custom") },
                    { value: "direct", label: t("settings.proxy.mode.direct") },
                  ]}
                />

                {selectedDraft.mode === "inherit" && (
                  <Stack gap="sm">
                    <div
                      className="proxy-mode-notice"
                      data-tone={globalActive ? "active" : "inactive"}
                    >
                      <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 0 }}>
                        {globalActive
                          ? t("settings.proxy.inheritPreviewActive", {
                              url: savedGlobalDisplayUrl,
                            })
                          : t("settings.proxy.inheritPreviewInactive")}
                      </Text>
                      {!globalActive && (
                        <Button
                          variant="default"
                          size="xs"
                          onClick={() => {
                            setGlobalExpanded(true);
                            globalCardRef.current?.scrollIntoView({
                              behavior: "smooth",
                              block: "nearest",
                            });
                          }}
                        >
                          {t("settings.proxy.global.configureShortcut")}
                        </Button>
                      )}
                    </div>

                    <Group justify="flex-end" gap="xs" className="proxy-detail-actions">
                      {selectedDirty && (
                        <Button
                          variant="subtle"
                          size="xs"
                          color="gray"
                          disabled={savingAgentId === selectedTool.id}
                          leftSection={<RotateCcw size={13} />}
                          onClick={() => resetAgentDraft(selectedTool.id)}
                        >
                          {t("settings.proxy.actions.reset")}
                        </Button>
                      )}
                      <Button
                        size="xs"
                        color="cliPrimary"
                        loading={savingAgentId === selectedTool.id}
                        disabled={!selectedDirty}
                        leftSection={<Save size={13} />}
                        onClick={() => void handleSaveAgent(selectedTool)}
                      >
                        {t("common.save")}
                      </Button>
                    </Group>
                  </Stack>
                )}

                {selectedDraft.mode === "direct" && (
                  <Stack gap="sm">
                    <div className="proxy-mode-notice" data-tone="direct">
                      <Text size="xs" c="dimmed">
                        {t("settings.proxy.directDescription")}
                      </Text>
                    </div>

                    <Group justify="flex-end" gap="xs" className="proxy-detail-actions">
                      {selectedDirty && (
                        <Button
                          variant="subtle"
                          size="xs"
                          color="gray"
                          disabled={savingAgentId === selectedTool.id}
                          leftSection={<RotateCcw size={13} />}
                          onClick={() => resetAgentDraft(selectedTool.id)}
                        >
                          {t("settings.proxy.actions.reset")}
                        </Button>
                      )}
                      <Button
                        size="xs"
                        color="cliPrimary"
                        loading={savingAgentId === selectedTool.id}
                        disabled={!selectedDirty}
                        leftSection={<Save size={13} />}
                        onClick={() => void handleSaveAgent(selectedTool)}
                      >
                        {t("common.save")}
                      </Button>
                    </Group>
                  </Stack>
                )}

                {selectedDraft.mode === "custom" && (
                  <ProxyEndpointFields
                    parts={selectedDraft.parts}
                    noProxy={selectedDraft.noProxy}
                    onPartsChange={(nextParts) => {
                      setAgentDraft(selectedTool.id, { parts: nextParts });
                      setAgentErrors((prev) => {
                        const next = { ...prev };
                        delete next[selectedTool.id];
                        return next;
                      });
                      setAgentTests((prev) => ({
                        ...prev,
                        [selectedTool.id]: { status: "idle" },
                      }));
                    }}
                    onNoProxyChange={(nextNoProxy) =>
                      setAgentDraft(selectedTool.id, { noProxy: nextNoProxy })
                    }
                    error={selectedError}
                    testState={selectedTest}
                    onTestConnection={() =>
                      void runConnectivityTest(
                        selectedDraft.parts,
                        (next) =>
                          setAgentTests((prev) => ({ ...prev, [selectedTool.id]: next })),
                        (msg) =>
                          setAgentErrors((prev) => ({ ...prev, [selectedTool.id]: msg })),
                      )
                    }
                    secondaryAction={
                      selectedDirty ? (
                        <Button
                          variant="subtle"
                          size="xs"
                          color="gray"
                          disabled={savingAgentId === selectedTool.id}
                          leftSection={<RotateCcw size={13} />}
                          onClick={() => resetAgentDraft(selectedTool.id)}
                        >
                          {t("settings.proxy.actions.reset")}
                        </Button>
                      ) : undefined
                    }
                    footerAction={
                      <Button
                        size="xs"
                        color="cliPrimary"
                        loading={savingAgentId === selectedTool.id}
                        disabled={!selectedDirty && !selectedError}
                        leftSection={<Save size={13} />}
                        onClick={() => void handleSaveAgent(selectedTool)}
                      >
                        {t("common.save")}
                      </Button>
                    }
                  />
                )}
              </Stack>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
