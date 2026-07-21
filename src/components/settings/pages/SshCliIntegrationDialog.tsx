import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, ChevronRight, Copy, Download, FolderOpen, RefreshCw, RotateCcw, Save, Trash2, Undo2 } from "lucide-react";
import { buildSshConnectionSpec } from "../../../lib/ssh";
import {
  DEFAULT_SSH_TOOL_CONFIG_ROOT,
  parseStoredSshHookReport,
  resolveSshToolSource,
  validateSshToolConfigRoot,
} from "../../../lib/sshToolIntegration";
import type {
  SshAgentInstallPreview,
  SshAgentOperationResult,
  SshAgentProbeResult,
  SshHost,
  SshRemoteHookConfigReport,
  SshToolSource,
} from "../../../lib/types";
import { useI18n, type TranslationKey } from "../../../lib/i18n";
import { useSshAgentIntegrationStore } from "../../../stores/sshAgentIntegrationStore";
import { useProjectStore } from "../../../stores/projectStore";
import { CliToolIcon } from "../../CliToolIcon";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ConfirmDialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";

interface SshDirectoryEntry {
  name: string;
  path: string;
}

interface Props {
  open: boolean;
  host: SshHost | null;
  hosts: SshHost[];
  onOpenChange: (open: boolean) => void;
}

const SOURCES: SshToolSource[] = ["claude", "codex"];
const AGENT_STATUS_KEYS: Record<string, TranslationKey> = {
  notChecked: "settings.sshHosts.cliIntegration.agent.status.notChecked",
  installed: "settings.sshHosts.cliIntegration.agent.status.installed",
  notInstalled: "settings.sshHosts.cliIntegration.agent.status.notInstalled",
  incompatible: "settings.sshHosts.cliIntegration.agent.status.incompatible",
  corrupt: "settings.sshHosts.cliIntegration.agent.status.corrupt",
  unreachable: "settings.sshHosts.cliIntegration.agent.status.unreachable",
  unsupported: "settings.sshHosts.cliIntegration.agent.status.unsupported",
  authenticationRequired: "settings.sshHosts.cliIntegration.agent.status.authenticationRequired",
};
const AGENT_CODE_KEYS: Record<string, TranslationKey> = {
  ssh_agent_not_installed: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_not_installed",
  ssh_agent_protocol_incompatible: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_protocol_incompatible",
  ssh_agent_identity_invalid: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_identity_invalid",
  ssh_agent_authentication_required: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_authentication_required",
  unsupported_target: "settings.sshHosts.cliIntegration.agent.code.unsupported_target",
  ssh_agent_unreachable: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_unreachable",
  ssh_agent_probe_failed: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_failed",
  ssh_agent_probe_output_too_large: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_output_too_large",
  ssh_agent_probe_output_invalid: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_output_invalid",
  ssh_agent_probe_magic_missing: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_magic_missing",
  ssh_agent_probe_banner_too_large: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_banner_too_large",
  ssh_agent_probe_stdout_contaminated: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_stdout_contaminated",
  ssh_agent_probe_path_invalid: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_path_invalid",
  ssh_agent_probe_magic_invalid: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_magic_invalid",
  home_directory_unavailable: "settings.sshHosts.cliIntegration.agent.code.home_directory_unavailable",
  ssh_interactive_auth_required: "settings.sshHosts.cliIntegration.agent.code.ssh_interactive_auth_required",
  ssh_agent_manifest_signature_invalid: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_manifest_signature_invalid",
  ssh_agent_release_https_required: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_release_https_required",
  ssh_agent_release_http_status: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_release_http_status",
  ssh_agent_release_target_missing: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_release_target_missing",
  ssh_agent_artifact_sha256_mismatch: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_artifact_sha256_mismatch",
  ssh_agent_artifact_size_mismatch: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_artifact_size_mismatch",
  agent_install_locked: "settings.sshHosts.cliIntegration.agent.code.agent_install_locked",
  agent_downgrade_forbidden: "settings.sshHosts.cliIntegration.agent.code.agent_downgrade_forbidden",
  agent_launcher_conflict: "settings.sshHosts.cliIntegration.agent.code.agent_launcher_conflict",
  agent_install_root_mismatch: "settings.sshHosts.cliIntegration.agent.code.agent_install_root_mismatch",
  agent_previous_missing: "settings.sshHosts.cliIntegration.agent.code.agent_previous_missing",
  agent_managed_hooks_present: "settings.sshHosts.cliIntegration.agent.code.agent_managed_hooks_present",
  ssh_agent_identity_required: "settings.sshHosts.cliIntegration.hook.code.identityRequired",
  ssh_agent_identity_changed: "settings.sshHosts.cliIntegration.hook.code.identityChanged",
  hook_config_root_invalid: "settings.sshHosts.cliIntegration.hook.code.rootInvalid",
  hook_config_root_parent_forbidden: "settings.sshHosts.cliIntegration.hook.code.rootInvalid",
  hook_config_root_missing: "settings.sshHosts.cliIntegration.hook.code.rootMissing",
  hook_config_root_not_directory: "settings.sshHosts.cliIntegration.hook.code.rootInvalid",
  hook_config_json_invalid: "settings.sshHosts.cliIntegration.hook.code.jsonInvalid",
  hook_config_json_root_invalid: "settings.sshHosts.cliIntegration.hook.code.jsonInvalid",
  hook_config_hooks_invalid: "settings.sshHosts.cliIntegration.hook.code.jsonInvalid",
  hook_config_event_invalid: "settings.sshHosts.cliIntegration.hook.code.jsonInvalid",
  hook_config_toml_invalid: "settings.sshHosts.cliIntegration.hook.code.tomlInvalid",
  hook_config_toml_features_invalid: "settings.sshHosts.cliIntegration.hook.code.tomlInvalid",
  hook_config_toml_hooks_invalid: "settings.sshHosts.cliIntegration.hook.code.tomlInvalid",
  hook_config_owner_conflict: "settings.sshHosts.cliIntegration.hook.code.ownerConflict",
  hook_config_changed: "settings.sshHosts.cliIntegration.hook.code.changed",
  hook_config_locked: "settings.sshHosts.cliIntegration.hook.code.locked",
  hook_config_recovery_conflict: "settings.sshHosts.cliIntegration.hook.code.recoveryConflict",
  hook_config_root_changed: "settings.sshHosts.cliIntegration.hook.code.rootChanged",
};
const HOOK_STATUS_KEYS: Record<string, TranslationKey> = {
  notChecked: "settings.sshHosts.cliIntegration.hook.status.notChecked",
  notInstalled: "settings.sshHosts.cliIntegration.hook.status.notInstalled",
  partialInstalled: "settings.sshHosts.cliIntegration.hook.status.partialInstalled",
  outdated: "settings.sshHosts.cliIntegration.hook.status.outdated",
  installed: "settings.sshHosts.cliIntegration.hook.status.installed",
  conflict: "settings.sshHosts.cliIntegration.hook.status.conflict",
};
const HOOK_FILE_ROLE_KEYS: Record<string, TranslationKey> = {
  claudeSettings: "settings.sshHosts.cliIntegration.hook.file.claudeSettings",
  codexHooks: "settings.sshHosts.cliIntegration.hook.file.codexHooks",
  codexFeature: "settings.sshHosts.cliIntegration.hook.file.codexFeature",
  unknown: "settings.sshHosts.cliIntegration.hook.file.unknown",
};

const HTTP_INSTALL_SCRIPT_URL = "https://github.com/dark-hxx/CLI-Manager/releases/latest/download/install-ssh-agent.sh";

export function SshCliIntegrationDialog({ open, host, hosts, onOpenChange }: Props) {
  const { t } = useI18n();
  const preferences = useSshAgentIntegrationStore((state) => state.preferences);
  const installations = useSshAgentIntegrationStore((state) => state.installations);
  const fetchAll = useSshAgentIntegrationStore((state) => state.fetchAll);
  const saveHostPreferences = useSshAgentIntegrationStore((state) => state.saveHostPreferences);
  const recordAgentProbe = useSshAgentIntegrationStore((state) => state.recordAgentProbe);
  const recordAgentOperation = useSshAgentIntegrationStore((state) => state.recordAgentOperation);
  const integrations = useSshAgentIntegrationStore((state) => state.integrations);
  const recordHookReport = useSshAgentIntegrationStore((state) => state.recordHookReport);
  const projects = useProjectStore((state) => state.projects);
  const fetchProjects = useProjectStore((state) => state.fetchProjects);
  const [roots, setRoots] = useState<Record<SshToolSource, string>>({ claude: "", codex: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [pickerSource, setPickerSource] = useState<SshToolSource | null>(null);
  const [pickerPath, setPickerPath] = useState("/");
  const [directories, setDirectories] = useState<SshDirectoryEntry[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<SshAgentProbeResult | null>(null);
  const [probeError, setProbeError] = useState("");
  const [agentInstallDir, setAgentInstallDir] = useState("");
  const [agentManifestUrl, setAgentManifestUrl] = useState("");
  const [allowHttp, setAllowHttp] = useState(false);
  const [agentOperation, setAgentOperation] = useState<"preview" | "install" | "rollback" | "uninstall" | null>(null);
  const [installPreview, setInstallPreview] = useState<SshAgentInstallPreview | null>(null);
  const [allowDowngrade, setAllowDowngrade] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"rollback" | "uninstall" | null>(null);
  const [scriptCopied, setScriptCopied] = useState(false);
  const [hookReports, setHookReports] = useState<Partial<Record<SshToolSource, SshRemoteHookConfigReport>>>({});
  const [hookErrors, setHookErrors] = useState<Partial<Record<SshToolSource, string>>>({});
  const [hookOperation, setHookOperation] = useState<{ source: SshToolSource; action: "inspect" | "preview" | "apply" } | null>(null);
  const [hookPreview, setHookPreview] = useState<{
    source: SshToolSource;
    action: "install" | "uninstall";
    configuredRoot: string;
    integrationId?: string;
    expectedCanonicalRoot?: string;
    scopeKind: "hostPrimary" | "projectOverride" | "retainedRoot";
    report: SshRemoteHookConfigReport;
  } | null>(null);

  const hostPreferences = useMemo(() => {
    const result = new Map<SshToolSource, string>();
    if (!host) return result;
    for (const preference of preferences) {
      if (preference.host_id === host.id) result.set(preference.source, preference.configured_root);
    }
    return result;
  }, [host, preferences]);
  const installation = useMemo(
    () => host ? installations.find((item) => item.host_id === host.id) ?? null : null,
    [host, installations],
  );
  const storedHookReports = useMemo(() => {
    const result: Partial<Record<SshToolSource, SshRemoteHookConfigReport>> = {};
    if (!host) return result;
    for (const integration of integrations) {
      if (integration.host_id !== host.id || integration.scope_kind !== "hostPrimary") continue;
      const report = parseStoredSshHookReport(integration.hook_record_json);
      if (report) result[integration.source] = report;
    }
    return result;
  }, [host, integrations]);
  const agentIdentity = useMemo(() => ({
    installationId: probeResult?.installationId || installation?.installation_id || "",
    remoteMachineId: probeResult?.remoteMachineId || installation?.remote_machine_id || "",
    path: probeResult?.installPath || installation?.install_path || "",
    ready: (probeResult?.status ?? installation?.status) === "installed",
  }), [installation, probeResult]);

  useEffect(() => {
    if (!open || !host) return;
    void fetchAll();
    void fetchProjects();
  }, [fetchAll, fetchProjects, host, open]);

  useEffect(() => {
    if (!open || !host) return;
    setRoots({
      claude: hostPreferences.get("claude") ?? "",
      codex: hostPreferences.get("codex") ?? "",
    });
    setError("");
  }, [host, hostPreferences, open]);

  useEffect(() => {
    if (!open) return;
    setProbeResult(null);
    setProbeError("");
    setInstallPreview(null);
    setAllowDowngrade(false);
    setConfirmAction(null);
    setScriptCopied(false);
    setHookReports({});
    setHookErrors({});
    setHookOperation(null);
    setHookPreview(null);
  }, [host?.id, open]);

  useEffect(() => {
    if (!open) return;
    setAgentInstallDir(installation?.install_root ?? "");
    setAgentManifestUrl(installation?.manifest_url ?? "");
  }, [installation?.host_id, installation?.install_root, installation?.manifest_url, open]);

  const agentErrorText = (value: unknown) => {
    const raw = String(value);
    const code = raw.split(":", 1)[0];
    if (code === "ssh_agent_release_http_status") {
      return t(AGENT_CODE_KEYS[code], { status: raw.slice(code.length + 1) || "-" });
    }
    return AGENT_CODE_KEYS[code]
      ? t(AGENT_CODE_KEYS[code])
      : t("settings.sshHosts.cliIntegration.agent.operationFailed", { code: raw });
  };

  const probeAgent = async () => {
    if (!host) return;
    setProbing(true);
    setProbeError("");
    try {
      const result = await invoke<SshAgentProbeResult>("ssh_agent_probe", {
        hostId: host.id,
        spec: buildSshConnectionSpec(host, hosts),
        agentPath: installation?.install_path || null,
      });
      await recordAgentProbe(host.id, result);
      setProbeResult(result);
    } catch (nextError) {
      setProbeError(agentErrorText(nextError));
    } finally {
      setProbing(false);
    }
  };

  const previewAgentInstall = async () => {
    if (!host) return;
    setAgentOperation("preview");
    setProbeError("");
    try {
      const preview = await invoke<SshAgentInstallPreview>("ssh_agent_install_preview", {
        hostId: host.id,
        spec: buildSshConnectionSpec(host, hosts),
        manifestUrl: agentManifestUrl.trim() || null,
        installDir: agentInstallDir.trim() || null,
        currentVersion: installation?.agent_version || null,
        allowHttp,
      });
      setInstallPreview(preview);
      setAllowDowngrade(false);
    } catch (nextError) {
      setProbeError(agentErrorText(nextError));
    } finally {
      setAgentOperation(null);
    }
  };

  const applyAgentResult = async (result: SshAgentOperationResult) => {
    if (!host) return;
    await recordAgentOperation(host.id, result);
    if (result.action === "uninstalled" || result.action === "purged") {
      setProbeResult({
        status: "notInstalled",
        code: "ssh_agent_not_installed",
        installationId: "",
        remoteMachineId: "",
        installPath: "",
        agentVersion: "",
        protocolVersion: "",
        target: "",
        supported: false,
        detail: "",
      });
      return;
    }
    setProbeResult({
      status: "installed",
      code: "ok",
      installationId: result.installationId,
      remoteMachineId: result.remoteMachineId,
      installPath: result.installPath,
      agentVersion: result.agentVersion,
      protocolVersion: result.protocolVersion,
      target: result.target,
      supported: true,
      detail: "",
    });
  };

  const installAgent = async () => {
    if (!host || !installPreview) return;
    setAgentOperation("install");
    setProbeError("");
    try {
      const result = await invoke<SshAgentOperationResult>("ssh_agent_install", {
        hostId: host.id,
        spec: buildSshConnectionSpec(host, hosts),
        manifestUrl: agentManifestUrl.trim() || null,
        installDir: agentInstallDir.trim() || null,
        allowHttp,
        allowDowngrade,
      });
      await applyAgentResult(result);
      setInstallPreview(null);
    } catch (nextError) {
      setProbeError(agentErrorText(nextError));
    } finally {
      setAgentOperation(null);
    }
  };

  const runAgentManagement = async (action: "rollback" | "uninstall") => {
    if (!host) return;
    setConfirmAction(null);
    setAgentOperation(action);
    setProbeError("");
    try {
      const result = await invoke<SshAgentOperationResult>(`ssh_agent_${action}`, {
        hostId: host.id,
        spec: buildSshConnectionSpec(host, hosts),
        agentPath: installation?.install_path || null,
        ...(action === "uninstall" ? { purge: false } : {}),
      });
      await applyAgentResult(result);
    } catch (nextError) {
      setProbeError(agentErrorText(nextError));
    } finally {
      setAgentOperation(null);
    }
  };

  const copyHttpInstallCommand = async () => {
    const command = `curl -fL -o install-ssh-agent.sh ${HTTP_INSTALL_SCRIPT_URL}\nless install-ssh-agent.sh\nsh install-ssh-agent.sh`;
    try {
      await navigator.clipboard.writeText(command);
      setScriptCopied(true);
    } catch (nextError) {
      setProbeError(agentErrorText(nextError));
    }
  };

  const loadDirectories = async (source: SshToolSource, path: string) => {
    if (!host) return;
    const normalizedPath = path.trim() || "/";
    setPickerSource(source);
    setPickerPath(normalizedPath);
    setPickerLoading(true);
    setPickerError("");
    try {
      const entries = await invoke<SshDirectoryEntry[]>("ssh_list_directories", {
        spec: buildSshConnectionSpec(host, hosts),
        path: normalizedPath,
      });
      setDirectories(entries);
    } catch (nextError) {
      setDirectories([]);
      setPickerError(String(nextError));
    } finally {
      setPickerLoading(false);
    }
  };

  const save = async () => {
    if (!host) return;
    for (const source of SOURCES) {
      const validationError = validateSshToolConfigRoot(roots[source]);
      if (validationError) {
        setError(t(`settings.sshHosts.cliIntegration.${validationError}` as TranslationKey));
        return;
      }
    }
    setSaving(true);
    setError("");
    try {
      await saveHostPreferences(host.id, roots);
      onOpenChange(false);
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setSaving(false);
    }
  };

  const reset = (source: SshToolSource) => {
    setRoots((current) => ({ ...current, [source]: "" }));
  };

  const currentHookReport = (source: SshToolSource) => {
    const report = hookReports[source] ?? storedHookReports[source];
    return report?.configuredConfigRoot === roots[source].trim() ? report : null;
  };

  const hookArgs = (source: SshToolSource, configuredRoot = roots[source]) => {
    if (!host || !agentIdentity.ready || !agentIdentity.installationId || !agentIdentity.remoteMachineId || !agentIdentity.path) {
      throw new Error("ssh_agent_identity_required");
    }
    const validationError = validateSshToolConfigRoot(configuredRoot);
    if (validationError) throw new Error(validationError);
    return {
      hostId: host.id,
      spec: buildSshConnectionSpec(host, hosts),
      agentPath: agentIdentity.path,
      expectedInstallationId: agentIdentity.installationId,
      expectedRemoteMachineId: agentIdentity.remoteMachineId,
      source,
      configuredConfigRoot: configuredRoot.trim(),
    };
  };

  const inspectHook = async (
    source: SshToolSource,
    configuredRoot = roots[source],
    scopeKind: "hostPrimary" | "projectOverride" = "hostPrimary",
  ) => {
    if (!host) return;
    setHookOperation({ source, action: "inspect" });
    setHookErrors((current) => ({ ...current, [source]: "" }));
    try {
      const report = await invoke<SshRemoteHookConfigReport>("ssh_agent_hook_inspect", hookArgs(source, configuredRoot));
      if (scopeKind === "projectOverride" || configuredRoot.trim() === (hostPreferences.get(source) ?? "").trim()) {
        await recordHookReport(host.id, host.username, configuredRoot, report, undefined, scopeKind);
      }
      if (scopeKind === "hostPrimary") {
        setHookReports((current) => ({ ...current, [source]: report }));
      }
    } catch (nextError) {
      setHookErrors((current) => ({ ...current, [source]: agentErrorText(nextError) }));
    } finally {
      setHookOperation(null);
    }
  };

  const previewHookChange = async (
    source: SshToolSource,
    action: "install" | "uninstall",
    configuredRoot = roots[source],
    integrationId?: string,
    expectedCanonicalRoot?: string,
    scopeKind: "hostPrimary" | "projectOverride" | "retainedRoot" = "hostPrimary",
  ) => {
    setHookOperation({ source, action: "preview" });
    setHookErrors((current) => ({ ...current, [source]: "" }));
    try {
      const report = await invoke<SshRemoteHookConfigReport>("ssh_agent_hook_preview", {
        ...hookArgs(source, configuredRoot),
        action,
        expectedCanonicalRoot,
      });
      setHookPreview({ source, action, configuredRoot, integrationId, expectedCanonicalRoot, scopeKind, report });
    } catch (nextError) {
      setHookErrors((current) => ({ ...current, [source]: agentErrorText(nextError) }));
    } finally {
      setHookOperation(null);
    }
  };

  const applyHookChange = async () => {
    if (!host || !hookPreview) return;
    const {
      source,
      action,
      configuredRoot,
      integrationId,
      expectedCanonicalRoot,
      scopeKind,
      report: preview,
    } = hookPreview;
    setHookOperation({ source, action: "apply" });
    setHookErrors((current) => ({ ...current, [source]: "" }));
    try {
      const report = await invoke<SshRemoteHookConfigReport>("ssh_agent_hook_apply", {
        ...hookArgs(source, configuredRoot),
        action,
        expectedCanonicalRoot,
        expectedFiles: preview.configFiles.map(({ role, canonicalPath, fingerprint }) => ({ role, canonicalPath, fingerprint })),
      });
      if (integrationId) {
        await recordHookReport(host.id, host.username, configuredRoot, report, integrationId);
      } else if (scopeKind === "projectOverride") {
        await recordHookReport(host.id, host.username, configuredRoot, report, undefined, "projectOverride");
      } else {
        await saveHostPreferences(host.id, roots);
        await recordHookReport(host.id, host.username, configuredRoot, report);
      }
      if (!integrationId && scopeKind === "hostPrimary") {
        setHookReports((current) => ({ ...current, [source]: report }));
      }
      setHookPreview(null);
    } catch (nextError) {
      setHookErrors((current) => ({ ...current, [source]: agentErrorText(nextError) }));
    } finally {
      setHookOperation(null);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto p-0">
          <div className="border-b border-border px-5 py-4">
            <DialogTitle>{t("settings.sshHosts.cliIntegration.title", { name: host?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("settings.sshHosts.cliIntegration.description")}</DialogDescription>
          </div>
          <div className="space-y-5 px-5 py-4">
            <section className="space-y-3 border-b border-border pb-5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-text-primary">cli-manager-ssh-agent</h3>
                  <p className="text-xs text-text-muted">
                    {t(AGENT_STATUS_KEYS[probeResult?.status ?? installation?.status ?? "notChecked"] ?? AGENT_STATUS_KEYS.notChecked)}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => void probeAgent()} disabled={probing}>
                  <RefreshCw className={`h-4 w-4 ${probing ? "animate-spin" : ""}`} />
                  {probing ? t("settings.sshHosts.cliIntegration.agent.probing") : t("settings.sshHosts.cliIntegration.agent.probe")}
                </Button>
              </div>
              {(probeResult?.agentVersion || installation?.agent_version) && (
                <div className="grid gap-2 text-xs text-text-muted sm:grid-cols-2">
                  <div>{t("settings.sshHosts.cliIntegration.agent.version", { value: probeResult?.agentVersion || installation?.agent_version || "-" })}</div>
                  <div>{t("settings.sshHosts.cliIntegration.agent.protocol", { value: probeResult?.protocolVersion || installation?.protocol_version || "-" })}</div>
                  <div>{t("settings.sshHosts.cliIntegration.agent.target", { value: probeResult?.target || installation?.target || "-" })}</div>
                  <div className="truncate font-mono" title={probeResult?.installPath || installation?.install_path || ""}>
                    {t("settings.sshHosts.cliIntegration.agent.path", { value: probeResult?.installPath || installation?.install_path || "-" })}
                  </div>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="ui-config-form-label" htmlFor="ssh-agent-install-root">
                    {t("settings.sshHosts.cliIntegration.agent.installRoot")}
                  </label>
                  <Input
                    id="ssh-agent-install-root"
                    value={agentInstallDir}
                    onChange={(event) => setAgentInstallDir(event.target.value)}
                    placeholder="~/.local/share/cli-manager-ssh-agent"
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="ui-config-form-label" htmlFor="ssh-agent-manifest-url">
                    {t("settings.sshHosts.cliIntegration.agent.manifestUrl")}
                  </label>
                  <Input
                    id="ssh-agent-manifest-url"
                    value={agentManifestUrl}
                    onChange={(event) => setAgentManifestUrl(event.target.value)}
                    placeholder={t("settings.sshHosts.cliIntegration.agent.officialSource")}
                    className="font-mono text-sm"
                  />
                </div>
              </div>
              <label className="flex items-start gap-2 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={allowHttp}
                  onChange={(event) => setAllowHttp(event.target.checked)}
                  className="mt-0.5"
                />
                <span>{t("settings.sshHosts.cliIntegration.agent.allowHttp")}</span>
              </label>
              <p className="text-xs text-text-muted">{t("settings.sshHosts.cliIntegration.agent.noHookChange")}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => void previewAgentInstall()} disabled={agentOperation !== null}>
                  <Download className="h-4 w-4" />
                  {agentOperation === "preview" ? t("settings.sshHosts.cliIntegration.agent.preparing") : t("settings.sshHosts.cliIntegration.agent.previewInstall")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmAction("rollback")}
                  disabled={agentOperation !== null || !installation?.previous_version}
                >
                  <Undo2 className="h-4 w-4" />
                  {t("settings.sshHosts.cliIntegration.agent.rollback")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmAction("uninstall")}
                  disabled={agentOperation !== null || (probeResult?.status ?? installation?.status) !== "installed"}
                >
                  <Trash2 className="h-4 w-4" />
                  {t("settings.sshHosts.cliIntegration.agent.uninstall")}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => void copyHttpInstallCommand()}>
                  <Copy className="h-4 w-4" />
                  {scriptCopied ? t("settings.sshHosts.cliIntegration.agent.copied") : t("settings.sshHosts.cliIntegration.agent.copyScript")}
                </Button>
              </div>
              {probeResult?.code && probeResult.code !== "ok" && (
                <p className="text-xs text-warning">
                  {AGENT_CODE_KEYS[probeResult.code] ? t(AGENT_CODE_KEYS[probeResult.code]) : probeResult.code}
                </p>
              )}
              {(probeError || probeResult?.detail) && (
                <p className="break-words text-xs text-danger">{probeError || probeResult?.detail}</p>
              )}
            </section>
            {SOURCES.map((source) => {
              const report = currentHookReport(source);
              const hookStatus = report?.status ?? "notChecked";
              const hookBusy = hookOperation?.source === source;
              const retainedIntegrations = integrations.filter((integration) => (
                integration.host_id === host?.id
                && integration.source === source
                && integration.scope_kind === "retainedRoot"
                && integration.cleanup_state === "cleanupAvailable"
              ));
              const projectOverrideGroups = Array.from(projects.reduce((groups, project) => {
                const root = project.cli_config_root?.trim();
                if (project.environment_type !== "ssh"
                  || project.ssh_host_id !== host?.id
                  || resolveSshToolSource(project.cli_tool) !== source
                  || !root) return groups;
                const names = groups.get(root) ?? [];
                names.push(project.name);
                groups.set(root, names);
                return groups;
              }, new Map<string, string[]>()).entries());
              return (
              <section key={source} className="space-y-3 border-b border-border pb-5 last:border-b-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <CliToolIcon icon={source === "claude" ? "claude-code" : "codex"} size={18} />
                  <h3 className="text-sm font-semibold text-text-primary">{source === "claude" ? "Claude" : "Codex"}</h3>
                </div>
                <label className="ui-config-form-label" htmlFor={`ssh-${source}-config-root`}>
                  {t("settings.sshHosts.cliIntegration.configRoot")}
                </label>
                <div className="flex gap-2">
                  <Input
                    id={`ssh-${source}-config-root`}
                    value={roots[source]}
                    onChange={(event) => setRoots((current) => ({ ...current, [source]: event.target.value }))}
                    placeholder={DEFAULT_SSH_TOOL_CONFIG_ROOT[source]}
                    className="min-w-0 flex-1 font-mono text-sm"
                  />
                  <Button type="button" variant="outline" size="sm" onClick={() => void loadDirectories(source, roots[source].startsWith("/") ? roots[source] : "/")}>
                    <FolderOpen className="h-4 w-4" />
                    {t("common.browse")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => reset(source)}
                    title={t("settings.sshHosts.cliIntegration.restoreDefault")}
                    aria-label={t("settings.sshHosts.cliIntegration.restoreDefault")}
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-text-muted">
                  {t("settings.sshHosts.cliIntegration.defaultPath", { path: DEFAULT_SSH_TOOL_CONFIG_ROOT[source] })}
                </p>
                <div className="space-y-2 border-t border-border pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-text-primary">{t("settings.sshHosts.cliIntegration.hook.title")}</span>
                    <span className={hookStatus === "installed" ? "ui-badge-success" : ["conflict", "outdated", "partialInstalled"].includes(hookStatus) ? "ui-badge-warning" : "ui-badge-neutral"}>
                      {t(HOOK_STATUS_KEYS[hookStatus] ?? HOOK_STATUS_KEYS.notChecked)}
                    </span>
                  </div>
                  <p className="text-xs text-text-muted">
                    {t("settings.sshHosts.cliIntegration.hook.path", { path: report?.canonicalConfigRoot ?? t("settings.sshHosts.cliIntegration.hook.notChecked") })}
                  </p>
                  {report?.configFiles.map((file) => (
                    <div key={file.role} className="truncate font-mono text-[11px] text-text-muted" title={file.canonicalPath}>
                      {t(HOOK_FILE_ROLE_KEYS[file.role] ?? HOOK_FILE_ROLE_KEYS.unknown)}: {file.canonicalPath}
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => void inspectHook(source)} disabled={hookBusy || !agentIdentity.ready}>
                      <RefreshCw className={`h-4 w-4 ${hookOperation?.action === "inspect" && hookBusy ? "animate-spin" : ""}`} />
                      {t("settings.sshHosts.cliIntegration.hook.inspect")}
                    </Button>
                    <Button type="button" size="sm" onClick={() => void previewHookChange(source, "install")} disabled={hookBusy || !agentIdentity.ready}>
                      <Download className="h-4 w-4" />
                      {t("settings.sshHosts.cliIntegration.hook.install")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void previewHookChange(source, "uninstall", roots[source], undefined, report?.canonicalConfigRoot)}
                      disabled={hookBusy || !agentIdentity.ready || !report}
                    >
                      <Trash2 className="h-4 w-4" />
                      {t("settings.sshHosts.cliIntegration.hook.uninstall")}
                    </Button>
                  </div>
                  {!agentIdentity.ready && <p className="text-xs text-text-muted">{t("settings.sshHosts.cliIntegration.hook.requiresAgent")}</p>}
                  {hookErrors[source] && <p className="break-words text-xs text-danger">{hookErrors[source]}</p>}
                </div>
                {retainedIntegrations.length > 0 && (
                  <div className="space-y-2 border-t border-border pt-3">
                    <div className="text-xs font-semibold text-text-primary">{t("settings.sshHosts.cliIntegration.hook.retainedRoots")}</div>
                    {retainedIntegrations.map((integration) => {
                      const retainedReport = parseStoredSshHookReport(integration.hook_record_json);
                      return (
                        <div key={integration.integration_id} className="space-y-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
                          <div className="break-all font-mono text-[11px] text-text-muted">{integration.canonical_root}</div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="ui-badge-neutral">
                              {t(HOOK_STATUS_KEYS[retainedReport?.status ?? "notChecked"] ?? HOOK_STATUS_KEYS.notChecked)}
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={hookBusy || !agentIdentity.ready || !retainedReport}
                              onClick={() => void previewHookChange(
                                source,
                                "uninstall",
                                integration.configured_root,
                                integration.integration_id,
                                integration.canonical_root,
                              )}
                            >
                              <Trash2 className="h-4 w-4" />
                              {t("settings.sshHosts.cliIntegration.hook.cleanup")}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {projectOverrideGroups.length > 0 && (
                  <div className="space-y-2 border-t border-border pt-3">
                    <div className="text-xs font-semibold text-text-primary">{t("settings.sshHosts.cliIntegration.hook.projectOverrides")}</div>
                    {projectOverrideGroups.map(([configuredRoot, projectNames]) => {
                      const integration = integrations.find((candidate) => (
                        candidate.host_id === host?.id
                        && candidate.source === source
                        && candidate.scope_kind === "projectOverride"
                        && candidate.configured_root === configuredRoot
                      ));
                      const overrideReport = integration ? parseStoredSshHookReport(integration.hook_record_json) : null;
                      return (
                        <div key={configuredRoot} className="space-y-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
                          <div className="text-xs text-text-primary">{projectNames.join(", ")}</div>
                          <div className="break-all font-mono text-[11px] text-text-muted">{integration?.canonical_root || configuredRoot}</div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="ui-badge-neutral">
                              {t(HOOK_STATUS_KEYS[overrideReport?.status ?? "notChecked"] ?? HOOK_STATUS_KEYS.notChecked)}
                            </span>
                            <Button type="button" variant="outline" size="sm" disabled={hookBusy || !agentIdentity.ready} onClick={() => void inspectHook(source, configuredRoot, "projectOverride")}>
                              <RefreshCw className="h-4 w-4" />
                              {t("settings.sshHosts.cliIntegration.hook.inspect")}
                            </Button>
                            <Button type="button" size="sm" disabled={hookBusy || !agentIdentity.ready} onClick={() => void previewHookChange(source, "install", configuredRoot, undefined, undefined, "projectOverride")}>
                              <Download className="h-4 w-4" />
                              {t("settings.sshHosts.cliIntegration.hook.install")}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={hookBusy || !agentIdentity.ready || !overrideReport}
                              onClick={() => void previewHookChange(
                                source,
                                "uninstall",
                                configuredRoot,
                                undefined,
                                overrideReport?.canonicalConfigRoot,
                                "projectOverride",
                              )}
                            >
                              <Trash2 className="h-4 w-4" />
                              {t("settings.sshHosts.cliIntegration.hook.uninstall")}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
              );
            })}
            {error && <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
          </div>
          <DialogFooter className="border-t border-border px-5 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="button" onClick={() => void save()} disabled={saving}>
              <Save className="h-4 w-4" />
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={installPreview !== null} onOpenChange={(nextOpen) => { if (!nextOpen && agentOperation !== "install") setInstallPreview(null); }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-xl p-0" showCloseButton={agentOperation !== "install"}>
          <div className="border-b border-border px-5 py-4">
            <DialogTitle>{t("settings.sshHosts.cliIntegration.agent.previewTitle")}</DialogTitle>
            <DialogDescription>{t("settings.sshHosts.cliIntegration.agent.previewDescription")}</DialogDescription>
          </div>
          {installPreview && (
            <div className="grid gap-3 px-5 py-4 text-sm sm:grid-cols-2">
              <div><span className="text-text-muted">{t("settings.sshHosts.cliIntegration.agent.operation")}</span><div>{t(`settings.sshHosts.cliIntegration.agent.action.${installPreview.action}` as TranslationKey)}</div></div>
              <div><span className="text-text-muted">{t("settings.sshHosts.cliIntegration.agent.versionLabel")}</span><div>{installPreview.version}</div></div>
              <div><span className="text-text-muted">{t("settings.sshHosts.cliIntegration.agent.targetLabel")}</span><div>{installPreview.target}</div></div>
              <div><span className="text-text-muted">{t("settings.sshHosts.cliIntegration.agent.size")}</span><div>{(installPreview.artifactSize / 1024 / 1024).toFixed(1)} MB</div></div>
              <div className="sm:col-span-2"><span className="text-text-muted">{t("settings.sshHosts.cliIntegration.agent.installRoot")}</span><div className="break-all font-mono text-xs">{installPreview.installRoot}</div></div>
              <div className="sm:col-span-2"><span className="text-text-muted">SHA-256</span><div className="break-all font-mono text-xs">{installPreview.artifactSha256}</div></div>
              <div className="sm:col-span-2"><span className="text-text-muted">Manifest</span><div className="break-all font-mono text-xs">{installPreview.manifestUrl}</div></div>
              {installPreview.action === "downgrade" && (
                <label className="flex items-start gap-2 text-warning sm:col-span-2">
                  <input type="checkbox" checked={allowDowngrade} onChange={(event) => setAllowDowngrade(event.target.checked)} className="mt-0.5" />
                  <span>{t("settings.sshHosts.cliIntegration.agent.allowDowngrade")}</span>
                </label>
              )}
            </div>
          )}
          <DialogFooter className="border-t border-border px-5 py-4">
            <Button type="button" variant="outline" onClick={() => setInstallPreview(null)} disabled={agentOperation === "install"}>{t("common.cancel")}</Button>
            <Button type="button" onClick={() => void installAgent()} disabled={agentOperation === "install" || (installPreview?.action === "downgrade" && !allowDowngrade)}>
              <Download className="h-4 w-4" />
              {agentOperation === "install" ? t("settings.sshHosts.cliIntegration.agent.installing") : t("settings.sshHosts.cliIntegration.agent.confirmInstall")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={hookPreview !== null} onOpenChange={(nextOpen) => { if (!nextOpen && hookOperation?.action !== "apply") setHookPreview(null); }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-xl p-0" showCloseButton={hookOperation?.action !== "apply"}>
          <div className="border-b border-border px-5 py-4">
            <DialogTitle>{t("settings.sshHosts.cliIntegration.hook.previewTitle")}</DialogTitle>
            <DialogDescription>{t("settings.sshHosts.cliIntegration.hook.previewDescription")}</DialogDescription>
          </div>
          {hookPreview && (
            <div className="space-y-3 px-5 py-4 text-sm">
              <div>
                <span className="text-text-muted">{t("settings.sshHosts.cliIntegration.hook.canonicalRoot")}</span>
                <div className="break-all font-mono text-xs">{hookPreview.report.canonicalConfigRoot}</div>
              </div>
              {hookPreview.report.willCreateConfigRoot && (
                <p className="text-xs text-warning">{t("settings.sshHosts.cliIntegration.hook.createRootNotice")}</p>
              )}
              <div className="text-xs text-text-muted">
                {t("settings.sshHosts.cliIntegration.hook.managedCount", {
                  current: hookPreview.report.managedEntries,
                  required: hookPreview.report.requiredEntries,
                })}
              </div>
              <div className="space-y-2">
                {hookPreview.report.changes.map((change) => (
                  <div key={change.role} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-text-primary">{t(HOOK_FILE_ROLE_KEYS[change.role] ?? HOOK_FILE_ROLE_KEYS.unknown)}</span>
                      <span className="ui-badge-neutral">{t(`settings.sshHosts.cliIntegration.hook.change.${change.action}` as TranslationKey)}</span>
                    </div>
                    <div className="break-all font-mono text-[11px] text-text-muted">{change.canonicalPath}</div>
                    <div className="font-mono text-[10px] text-text-muted">
                      {change.beforeFingerprint.slice(0, 12)}{" -> "}{change.afterFingerprint.slice(0, 12)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <DialogFooter className="border-t border-border px-5 py-4">
            <Button type="button" variant="outline" onClick={() => setHookPreview(null)} disabled={hookOperation?.action === "apply"}>{t("common.cancel")}</Button>
            <Button
              type="button"
              variant={hookPreview?.action === "uninstall" ? "destructive" : "default"}
              onClick={() => void applyHookChange()}
              disabled={hookOperation?.action === "apply"}
            >
              {hookPreview?.action === "uninstall" ? <Trash2 className="h-4 w-4" /> : <Download className="h-4 w-4" />}
              {hookOperation?.action === "apply"
                ? t("settings.sshHosts.cliIntegration.hook.applying")
                : t(hookPreview?.action === "uninstall" ? "settings.sshHosts.cliIntegration.hook.confirmUninstall" : "settings.sshHosts.cliIntegration.hook.confirmInstall")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction === "rollback" ? t("settings.sshHosts.cliIntegration.agent.rollbackTitle") : t("settings.sshHosts.cliIntegration.agent.uninstallTitle")}
        message={confirmAction === "rollback" ? t("settings.sshHosts.cliIntegration.agent.rollbackMessage") : t("settings.sshHosts.cliIntegration.agent.uninstallMessage")}
        confirmText={confirmAction === "rollback" ? t("settings.sshHosts.cliIntegration.agent.rollback") : t("settings.sshHosts.cliIntegration.agent.uninstall")}
        cancelText={t("common.cancel")}
        danger={confirmAction === "uninstall"}
        zIndex={80}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => { if (confirmAction) void runAgentManagement(confirmAction); }}
      />

      <Dialog open={pickerSource !== null} onOpenChange={(nextOpen) => { if (!nextOpen) setPickerSource(null); }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-xl p-0">
          <div className="border-b border-border px-4 py-3">
            <DialogTitle>{t("settings.sshHosts.cliIntegration.pickerTitle")}</DialogTitle>
            <DialogDescription className="sr-only">{t("settings.sshHosts.cliIntegration.pickerDescription")}</DialogDescription>
          </div>
          <div className="space-y-3 p-4">
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => {
                const parent = pickerPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
                if (pickerSource) void loadDirectories(pickerSource, parent);
              }} title={t("common.parentDirectory")} aria-label={t("common.parentDirectory")}>
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Input value={pickerPath} onChange={(event) => setPickerPath(event.target.value)} className="flex-1 font-mono text-sm" />
              <Button type="button" variant="outline" onClick={() => { if (pickerSource) void loadDirectories(pickerSource, pickerPath); }}>{t("common.refresh")}</Button>
            </div>
            <div className="max-h-72 min-h-48 overflow-y-auto rounded-md border border-border p-1">
              {pickerLoading && <div className="p-4 text-sm text-text-muted">{t("common.loading")}</div>}
              {!pickerLoading && pickerError && <div className="p-4 text-sm text-danger">{pickerError}</div>}
              {!pickerLoading && !pickerError && directories.map((entry) => (
                <button key={entry.path} type="button" onClick={() => setPickerPath(entry.path)} onDoubleClick={() => { if (pickerSource) void loadDirectories(pickerSource, entry.path); }} className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-surface-container-highest">
                  <span className="truncate">{entry.name}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <Button type="button" variant="outline" onClick={() => setPickerSource(null)}>{t("common.cancel")}</Button>
            <Button type="button" onClick={() => {
              if (pickerSource) setRoots((current) => ({ ...current, [pickerSource]: pickerPath.trim() || "/" }));
              setPickerSource(null);
            }}>{t("configModal.ssh.selectCurrentDirectory")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
