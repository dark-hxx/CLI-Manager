import { useEffect, useId, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Eye, EyeOff, Play } from "lucide-react";
import { useI18n, type TranslationKey } from "../../../shared/i18n/index";
import { resolveCliToolDescriptor } from "../../../shared/lib/cliTools";
import {
  PROXY_PROTOCOL_OPTIONS,
  buildProxyUrlFromParts,
  mergeNoProxy,
  parseProxyUrlToParts,
  resolveEffectiveProxy,
  sanitizeProxyUrlForDisplay,
  tryParsePastedProxyUrl,
  type ProjectProxyConfig,
  type ProxyProtocol,
  type ProxyScopeMode,
  type ProxyTestConnectionResult,
  type ProxyUrlParts,
  type ProxyUrlValidationCode,
} from "../../../shared/lib/proxySettings";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { Button } from "../../../shared/ui/button";
import { Input } from "../../../shared/ui/input";
import { Select } from "../../../shared/ui/select";

interface ProjectProxySectionProps {
  value: ProjectProxyConfig;
  onChange: (next: ProjectProxyConfig) => void;
  onDraftValidityChange?: (errorCode: ProxyUrlValidationCode | null) => void;
  projectType: "local" | "ssh";
  cliTool: string;
  startupCmd: string;
  forceExpanded?: boolean;
  validationError?: string;
}

function getTestErrorKey(code: string): TranslationKey {
  switch (code) {
    case "proxy_url_empty":
      return "configModal.proxy.error.urlEmpty";
    case "proxy_scheme_unsupported":
      return "configModal.proxy.error.schemeUnsupported";
    case "proxy_host_missing":
      return "configModal.proxy.error.hostMissing";
    case "proxy_port_invalid":
      return "configModal.proxy.error.portInvalid";
    case "proxy_connect_timeout":
      return "configModal.proxy.error.connectTimeout";
    case "proxy_connect_refused":
      return "configModal.proxy.error.connectRefused";
    case "proxy_connect_failed":
      return "configModal.proxy.error.connectFailed";
    default:
      return "configModal.proxy.error.urlInvalid";
  }
}

export function ProjectProxySection({
  value,
  onChange,
  onDraftValidityChange,
  projectType,
  cliTool,
  startupCmd,
  forceExpanded = false,
  validationError,
}: ProjectProxySectionProps) {
  const { t } = useI18n();
  const proxySettings = useSettingsStore((s) => s.proxySettings);
  const [expanded, setExpanded] = useState(false);
  const [parts, setParts] = useState<ProxyUrlParts>(() => parseProxyUrlToParts(value.url));
  const [authExpanded, setAuthExpanded] = useState(() => Boolean(parts.username || parts.password));
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const lastEmittedUrlRef = useRef(value.url);

  const sectionId = useId();
  const modeFieldId = useId();
  const protocolFieldId = useId();
  const hostFieldId = useId();
  const portFieldId = useId();
  const usernameFieldId = useId();
  const passwordFieldId = useId();
  const noProxyFieldId = useId();

  useEffect(() => {
    if (forceExpanded) setExpanded(true);
  }, [forceExpanded]);

  useEffect(() => {
    if (value.url === lastEmittedUrlRef.current) return;
    lastEmittedUrlRef.current = value.url;
    const nextParts = parseProxyUrlToParts(value.url);
    setParts(nextParts);
    if (nextParts.username || nextParts.password) {
      setAuthExpanded(true);
    }
  }, [value.url]);

  const updateParts = (nextParts: ProxyUrlParts) => {
    setParts(nextParts);
    setTestStatus(null);
    const built = buildProxyUrlFromParts(nextParts);
    if (built.ok) {
      lastEmittedUrlRef.current = built.url;
      onDraftValidityChange?.(null);
      onChange({ ...value, url: built.url });
    } else {
      lastEmittedUrlRef.current = "";
      onDraftValidityChange?.(built.code);
      onChange({ ...value, url: "" });
    }
  };

  const handleHostChange = (rawHost: string) => {
    const pasted = tryParsePastedProxyUrl(rawHost);
    if (pasted) {
      if (pasted.username || pasted.password) {
        setAuthExpanded(true);
      }
      updateParts(pasted);
      return;
    }
    updateParts({ ...parts, host: rawHost });
  };

  const effectivePlan = useMemo(
    () =>
      resolveEffectiveProxy({
        projectProxyConfig: value,
        cliTool,
        startupCmd,
        environmentType: projectType === "ssh" ? "ssh" : "local",
        settings: proxySettings,
      }),
    [cliTool, projectType, proxySettings, startupCmd, value],
  );

  const summaryText = useMemo(() => {
    if (value.mode === "direct") return t("configModal.proxy.summary.direct");
    if (value.mode === "custom") {
      const sanitized = sanitizeProxyUrlForDisplay(value.url);
      return sanitized
        ? t("configModal.proxy.summary.custom", { url: sanitized })
        : t("configModal.proxy.summary.customPending");
    }
    if (projectType === "ssh") {
      return t("configModal.proxy.summary.sshUnset");
    }
    if (effectivePlan.kind === "direct") {
      const agentLabel =
        resolveCliToolDescriptor(effectivePlan.agentId)?.label ?? effectivePlan.agentId ?? "";
      return t("configModal.proxy.summary.inheritAgentDirect", { agent: agentLabel });
    }
    if (effectivePlan.kind === "proxy") {
      const sanitized = sanitizeProxyUrlForDisplay(effectivePlan.url);
      if (effectivePlan.source === "agent") {
        const agentLabel =
          resolveCliToolDescriptor(effectivePlan.agentId)?.label ?? effectivePlan.agentId ?? "";
        return t("configModal.proxy.summary.inheritAgent", { agent: agentLabel, url: sanitized });
      }
      return t("configModal.proxy.summary.inheritGlobal", { url: sanitized });
    }
    return t("configModal.proxy.summary.none");
  }, [effectivePlan, projectType, t, value.mode, value.url]);

  const handleTestConnection = async () => {
    const built = buildProxyUrlFromParts(parts);
    if (!built.ok) {
      onDraftValidityChange?.(built.code);
      setTestStatus({ ok: false, message: t(getTestErrorKey(built.code)) });
      return;
    }
    setTesting(true);
    setTestStatus(null);
    try {
      const result = await invoke<ProxyTestConnectionResult>("proxy_test_connection", {
        proxyUrl: built.url,
        timeoutMs: 3000,
      });
      if (result.ok) {
        setTestStatus({
          ok: true,
          message: t("configModal.proxy.testSuccess", { latency: result.latencyMs ?? 0 }),
        });
      } else {
        const key = getTestErrorKey(result.errorCode ?? "proxy_connect_failed");
        const message = result.detail ? `${t(key)} (${result.detail})` : t(key);
        setTestStatus({ ok: false, message });
      }
    } catch (err) {
      setTestStatus({ ok: false, message: String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border/70 bg-bg-secondary/60">
      <button
        type="button"
        className="ui-focus-ring flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left"
        aria-expanded={expanded}
        aria-controls={sectionId}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-text-secondary">
            {t("configModal.proxy.title")}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-text-muted">
            {summaryText}
          </div>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-text-muted transition-transform ${expanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {expanded && (
        <div id={sectionId} className="space-y-3 border-t border-border/60 px-3 py-3">
          <div>
            <label htmlFor={modeFieldId} className="ui-config-form-label">
              {t("configModal.proxy.modeLabel")}
            </label>
            <Select
              id={modeFieldId}
              value={value.mode}
              onChange={(event) => {
                const nextMode = event.target.value as ProxyScopeMode;
                setTestStatus(null);
                if (nextMode === "custom") {
                  const built = buildProxyUrlFromParts(parts);
                  onDraftValidityChange?.(built.ok ? null : built.code);
                  onChange({ ...value, mode: nextMode, url: built.ok ? built.url : "" });
                } else {
                  onDraftValidityChange?.(null);
                  onChange({ ...value, mode: nextMode });
                }
              }}
              className="text-sm"
            >
              <option value="inherit">{t("configModal.proxy.mode.inherit")}</option>
              <option value="custom">{t("configModal.proxy.mode.custom")}</option>
              <option value="direct">{t("configModal.proxy.mode.direct")}</option>
            </Select>
          </div>

          {value.mode === "inherit" && (
            <p className="text-[11px] leading-relaxed text-text-muted">
              {projectType === "ssh"
                ? t("configModal.proxy.sshInheritHint")
                : t("configModal.proxy.inheritHint", { summary: summaryText })}
            </p>
          )}

          {value.mode === "direct" && (
            <p className="text-[11px] leading-relaxed text-text-muted">
              {t("configModal.proxy.directHint")}
            </p>
          )}

          {value.mode === "custom" && (
            <div className="space-y-3">
              <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_5.25rem] gap-2">
                <div>
                  <label htmlFor={protocolFieldId} className="ui-config-form-label">
                    {t("configModal.proxy.protocolLabel")}
                  </label>
                  <Select
                    id={protocolFieldId}
                    value={parts.scheme}
                    onChange={(event) =>
                      updateParts({ ...parts, scheme: event.target.value as ProxyProtocol })
                    }
                    className="text-sm"
                  >
                    {PROXY_PROTOCOL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </Select>
                </div>

                <div>
                  <label htmlFor={hostFieldId} className="ui-config-form-label">
                    {t("configModal.proxy.hostLabel")} <span className="text-danger">*</span>
                  </label>
                  <Input
                    id={hostFieldId}
                    type="text"
                    value={parts.host}
                    onChange={(event) => handleHostChange(event.target.value)}
                    placeholder="127.0.0.1"
                    className="font-mono text-sm"
                  />
                </div>

                <div>
                  <label htmlFor={portFieldId} className="ui-config-form-label">
                    {t("configModal.proxy.portLabel")} <span className="text-danger">*</span>
                  </label>
                  <Input
                    id={portFieldId}
                    type="text"
                    inputMode="numeric"
                    value={parts.port}
                    onChange={(event) =>
                      updateParts({
                        ...parts,
                        port: event.target.value.replace(/[^\d]/g, ""),
                      })
                    }
                    placeholder="7897"
                    className="font-mono text-sm"
                  />
                </div>
              </div>

              <div>
                <button
                  type="button"
                  className="ui-focus-ring inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-text-muted hover:text-text-primary"
                  aria-expanded={authExpanded}
                  onClick={() => setAuthExpanded((prev) => !prev)}
                >
                  <span>{t("configModal.proxy.authToggle")}</span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${authExpanded ? "rotate-180" : ""}`}
                    aria-hidden="true"
                  />
                </button>

                {authExpanded && (
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div>
                      <label htmlFor={usernameFieldId} className="ui-config-form-label">
                        {t("configModal.proxy.usernameLabel")}
                      </label>
                      <Input
                        id={usernameFieldId}
                        type="text"
                        value={parts.username}
                        onChange={(event) =>
                          updateParts({ ...parts, username: event.target.value })
                        }
                        placeholder={t("configModal.proxy.usernamePlaceholder")}
                        autoComplete="off"
                        className="font-mono text-sm"
                      />
                    </div>
                    <div>
                      <label htmlFor={passwordFieldId} className="ui-config-form-label">
                        {t("configModal.proxy.passwordLabel")}
                      </label>
                      <div className="relative">
                        <Input
                          id={passwordFieldId}
                          type={showPassword ? "text" : "password"}
                          value={parts.password}
                          onChange={(event) =>
                            updateParts({ ...parts, password: event.target.value })
                          }
                          placeholder={t("configModal.proxy.passwordPlaceholder")}
                          autoComplete="off"
                          className="pr-9 font-mono text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((prev) => !prev)}
                          aria-label={t(
                            showPassword
                              ? "configModal.proxy.hidePassword"
                              : "configModal.proxy.showPassword",
                          )}
                          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-text-muted hover:text-text-primary"
                        >
                          {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label htmlFor={noProxyFieldId} className="ui-config-form-label">
                  {t("configModal.proxy.noProxyLabel")}
                </label>
                <Input
                  id={noProxyFieldId}
                  type="text"
                  value={value.noProxy}
                  onChange={(event) => onChange({ ...value, noProxy: event.target.value })}
                  placeholder="localhost,127.0.0.1,.corp.local"
                  className="font-mono text-sm"
                />
                <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                  {t("configModal.proxy.noProxyHint", {
                    effective: mergeNoProxy(value.noProxy),
                  })}
                </p>
              </div>

              {validationError && (
                <p className="text-[11px] text-danger">{validationError}</p>
              )}

              {projectType === "ssh" && (
                <p className="text-[11px] leading-relaxed text-text-muted">
                  {t("configModal.proxy.sshCustomHint")}
                </p>
              )}

              {(projectType === "local" || testStatus) && (
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 text-[11px]">
                    {testStatus && (
                      <span className={testStatus.ok ? "text-primary" : "text-danger"}>
                        {testStatus.message}
                      </span>
                    )}
                  </div>
                  {projectType === "local" && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={testing}
                      onClick={() => void handleTestConnection()}
                      className="h-8 shrink-0 px-2.5 text-xs"
                    >
                      <Play className="mr-1 h-3 w-3" />
                      {testing ? t("configModal.proxy.testing") : t("configModal.proxy.testConnection")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
