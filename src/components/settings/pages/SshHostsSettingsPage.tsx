import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, CircleAlert, Pencil, Plus, Server, Trash2, X } from "lucide-react";
import { useI18n, type TranslationKey } from "../../../lib/i18n";
import type { CreateSshHostInput, SshAuthMode, SshHost } from "../../../lib/types";
import { useSshHostStore } from "../../../stores/sshHostStore";
import { useAppConfirm } from "../../ui/useAppConfirm";

interface Props {
  searchValue: string;
}

interface SshClientStatus {
  available: boolean;
  version: string | null;
  error: string | null;
}

interface SshConnectionTestResult {
  success: boolean;
  stages: Array<{ key: string; status: string; detail: string }>;
}

const EMPTY_FORM: CreateSshHostInput = {
  name: "",
  group_name: "",
  host: "",
  port: 22,
  username: "",
  config_alias: "",
  auth_mode: "ssh_config",
  identity_file: "",
  jump_mode: "none",
  jump_host_id: null,
  proxy_type: "none",
  proxy_host: "",
  proxy_port: 0,
  proxy_command: "",
  connect_timeout_sec: 15,
  server_alive_interval_sec: 30,
  server_alive_count_max: 3,
  terminal_encoding: "UTF-8",
  startup_script: "",
  notes: "",
};

const STAGE_LABELS: Record<string, TranslationKey> = {
  client: "settings.sshHosts.stage.client",
  authentication: "settings.sshHosts.stage.authentication",
  connection: "settings.sshHosts.stage.connection",
};

const ERROR_LABELS: Record<string, TranslationKey> = {
  ssh_host_name_required: "settings.sshHosts.error.nameRequired",
  ssh_host_address_required: "settings.sshHosts.error.addressRequired",
  ssh_host_not_found: "settings.sshHosts.error.notFound",
  ssh_host_in_use: "settings.sshHosts.error.inUse",
  ssh_host_jump_self_reference: "settings.sshHosts.error.jumpSelf",
  ssh_proxy_credentials_forbidden: "settings.sshHosts.error.proxyCredentials",
  ssh_host_port_invalid: "settings.sshHosts.error.portInvalid",
  ssh_connect_timeout_invalid: "settings.sshHosts.error.timeoutInvalid",
};

const DETAIL_LABELS: Record<string, TranslationKey> = {
  ssh_connection_ready: "settings.sshHosts.detail.connectionReady",
  ssh_interactive_auth_required: "settings.sshHosts.detail.interactiveRequired",
};

function formFromHost(host: SshHost): CreateSshHostInput {
  return { ...host };
}

export function SshHostsSettingsPage({ searchValue }: Props) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm();
  const hosts = useSshHostStore((state) => state.hosts);
  const loaded = useSshHostStore((state) => state.loaded);
  const fetchHosts = useSshHostStore((state) => state.fetchHosts);
  const createHost = useSshHostStore((state) => state.createHost);
  const updateHost = useSshHostStore((state) => state.updateHost);
  const deleteHost = useSshHostStore((state) => state.deleteHost);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CreateSshHostInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<SshClientStatus | null>(null);
  const [diagnostic, setDiagnostic] = useState<SshConnectionTestResult | null>(null);

  useEffect(() => {
    void fetchHosts();
    void invoke<SshClientStatus>("ssh_client_status").then(setClient).catch(() => {
      setClient({ available: false, version: null, error: "ssh_client_unavailable" });
    });
  }, [fetchHosts]);

  const filteredHosts = useMemo(() => {
    const query = searchValue.trim().toLocaleLowerCase();
    if (!query) return hosts;
    return hosts.filter((host) =>
      [host.name, host.group_name, host.host, host.config_alias, host.username, host.notes]
        .some((value) => value.toLocaleLowerCase().includes(query))
    );
  }, [hosts, searchValue]);

  const groups = useMemo(
    () => Array.from(new Set(hosts.map((host) => host.group_name).filter(Boolean))).sort(),
    [hosts]
  );

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setError(null);
    setDiagnostic(null);
    setEditorOpen(true);
  };

  const openEdit = (host: SshHost) => {
    setEditingId(host.id);
    setForm(formFromHost(host));
    setError(null);
    setDiagnostic(null);
    setEditorOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (editingId) await updateHost(editingId, form);
      else await createHost(form);
      setEditorOpen(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (host: SshHost) => {
    const accepted = await confirm({
      title: t("settings.sshHosts.deleteTitle"),
      message: t("settings.sshHosts.deleteDescription", { name: host.name }),
      danger: true,
    });
    if (!accepted) return;
    try {
      await deleteHost(host.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setError(null);
    setDiagnostic(null);
    try {
      const jumpHost = hosts.find((host) => host.id === form.jump_host_id);
      const result = await invoke<SshConnectionTestResult>("ssh_test_connection", {
        spec: {
          host: form.host ?? "",
          port: form.port ?? 22,
          username: form.username ?? "",
          configAlias: form.config_alias ?? "",
          authMode: form.auth_mode ?? "ssh_config",
          identityFile: form.identity_file ?? "",
          jumpTarget: jumpHost?.config_alias || jumpHost?.host || "",
          proxyCommand: form.proxy_command ?? "",
          connectTimeoutSec: form.connect_timeout_sec ?? 15,
          serverAliveIntervalSec: form.server_alive_interval_sec ?? 30,
          serverAliveCountMax: form.server_alive_count_max ?? 3,
        },
      });
      setDiagnostic(result);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setTesting(false);
    }
  };

  const setValue = <K extends keyof CreateSshHostInput>(key: K, value: CreateSshHostInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const visibleError = error ? t(ERROR_LABELS[error] ?? "settings.sshHosts.error.generic") : null;

  return (
    <div className="space-y-4">
      <div className="ui-surface-low flex items-center justify-between rounded-2xl border border-border px-4 py-3">
        <div className="flex items-center gap-3">
          {client?.available ? <CheckCircle2 className="h-5 w-5 text-primary" /> : <CircleAlert className="h-5 w-5 text-warning" />}
          <div>
            <div className="text-sm font-bold text-text-primary">{t("settings.sshHosts.openSsh")}</div>
            <div className="text-xs text-text-muted">
              {client?.available ? client.version : t("settings.sshHosts.openSshMissing")}
            </div>
          </div>
        </div>
        <button className="ui-button-primary flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold" onClick={openCreate}>
          <Plus className="h-4 w-4" /> {t("settings.sshHosts.add")}
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-surface-lowest">
        {!loaded ? (
          <div className="p-8 text-center text-sm text-text-muted">{t("common.loading")}</div>
        ) : filteredHosts.length === 0 ? (
          <div className="p-10 text-center">
            <Server className="mx-auto mb-3 h-8 w-8 text-text-muted" />
            <div className="font-bold text-text-primary">{t("settings.sshHosts.empty")}</div>
            <div className="mt-1 text-xs text-text-muted">{t("settings.sshHosts.emptyDescription")}</div>
          </div>
        ) : (
          filteredHosts.map((host) => (
            <div key={host.id} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
              <Server className="h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-bold text-text-primary">{host.name}</span>
                  {host.group_name && <span className="ui-badge-neutral">{host.group_name}</span>}
                </div>
                <div className="truncate text-xs text-text-muted">
                  {host.config_alias || `${host.username ? `${host.username}@` : ""}${host.host}:${host.port}`}
                </div>
              </div>
              <span className="ui-badge-neutral">{t(`settings.sshHosts.auth.${host.auth_mode}` as const)}</span>
              <button className="ui-icon-button" aria-label={t("common.edit")} onClick={() => openEdit(host)}><Pencil className="h-4 w-4" /></button>
              <button className="ui-icon-button text-danger" aria-label={t("common.delete")} onClick={() => void remove(host)}><Trash2 className="h-4 w-4" /></button>
            </div>
          ))
        )}
      </div>

      {visibleError && <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{visibleError}</div>}

      {editorOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 p-5">
          <div className="ui-surface-base flex max-h-[calc(100vh-70px)] w-full max-w-[980px] flex-col overflow-hidden rounded-2xl border border-border shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h3 className="text-lg font-bold text-text-primary">{editingId ? t("settings.sshHosts.edit") : t("settings.sshHosts.add")}</h3>
              <button className="ui-icon-button" onClick={() => setEditorOpen(false)} aria-label={t("common.close")}><X className="h-5 w-5" /></button>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 md:grid-cols-2">
              <Field label={t("settings.sshHosts.name")}><input value={form.name} onChange={(event) => setValue("name", event.target.value)} /></Field>
              <Field label={t("settings.sshHosts.group")}><input list="ssh-host-groups" value={form.group_name} onChange={(event) => setValue("group_name", event.target.value)} /><datalist id="ssh-host-groups">{groups.map((group) => <option key={group} value={group} />)}</datalist></Field>
              <Field label={t("settings.sshHosts.configAlias")}><input value={form.config_alias} onChange={(event) => setValue("config_alias", event.target.value)} /></Field>
              <Field label={t("settings.sshHosts.address")}><input value={form.host} onChange={(event) => setValue("host", event.target.value)} /></Field>
              <Field label={t("settings.sshHosts.port")}><input type="number" value={form.port} onChange={(event) => setValue("port", Number(event.target.value))} /></Field>
              <Field label={t("settings.sshHosts.username")}><input value={form.username} onChange={(event) => setValue("username", event.target.value)} /></Field>
              <Field label={t("settings.sshHosts.authMode")}><select value={form.auth_mode} onChange={(event) => setValue("auth_mode", event.target.value as SshAuthMode)}><option value="ssh_config">{t("settings.sshHosts.auth.ssh_config")}</option><option value="agent">{t("settings.sshHosts.auth.agent")}</option><option value="identity_file">{t("settings.sshHosts.auth.identity_file")}</option><option value="password_prompt">{t("settings.sshHosts.auth.password_prompt")}</option><option value="interactive">{t("settings.sshHosts.auth.interactive")}</option></select></Field>
              <Field label={t("settings.sshHosts.identityFile")}><input value={form.identity_file} onChange={(event) => setValue("identity_file", event.target.value)} /></Field>
              <Field label={t("settings.sshHosts.jumpHost")}><select value={form.jump_host_id ?? ""} onChange={(event) => setValue("jump_host_id", event.target.value || null)}><option value="">{t("common.none")}</option>{hosts.filter((host) => host.id !== editingId).map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></Field>
              <Field label={t("settings.sshHosts.proxyCommand")}><input value={form.proxy_command} onChange={(event) => setValue("proxy_command", event.target.value)} /></Field>
              <Field label={t("settings.sshHosts.timeout")}><input type="number" value={form.connect_timeout_sec} onChange={(event) => setValue("connect_timeout_sec", Number(event.target.value))} /></Field>
              <Field label={t("settings.sshHosts.notes")}><input value={form.notes} onChange={(event) => setValue("notes", event.target.value)} /></Field>
              <div className="md:col-span-2">
                <Field label={t("settings.sshHosts.startupScript")}><textarea rows={3} value={form.startup_script} onChange={(event) => setValue("startup_script", event.target.value)} /></Field>
              </div>
              {diagnostic && <div className="md:col-span-2 space-y-2 rounded-xl border border-border p-3">{diagnostic.stages.map((stage) => <div key={stage.key} className="flex items-start gap-2 text-sm"><span className={stage.status === "passed" ? "text-primary" : "text-warning"}>●</span><div><div className="font-bold text-text-primary">{t(STAGE_LABELS[stage.key] ?? "settings.sshHosts.stage.connection")}</div><div className="text-xs text-text-muted">{DETAIL_LABELS[stage.detail] ? t(DETAIL_LABELS[stage.detail]) : stage.detail}</div></div></div>)}</div>}
            </div>
            <div className="flex items-center justify-between border-t border-border px-5 py-4">
              <button className="ui-button-secondary rounded-xl px-4 py-2 text-sm font-bold" disabled={testing} onClick={() => void testConnection()}>{testing ? t("settings.sshHosts.testing") : t("settings.sshHosts.test")}</button>
              <div className="flex gap-2"><button className="ui-button-secondary rounded-xl px-4 py-2 text-sm font-bold" onClick={() => setEditorOpen(false)}>{t("common.cancel")}</button><button className="ui-button-primary rounded-xl px-4 py-2 text-sm font-bold" disabled={saving} onClick={() => void save()}>{saving ? t("common.saving") : t("common.save")}</button></div>
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-xs font-bold text-text-muted [&_input]:mt-2 [&_input]:h-10 [&_input]:w-full [&_input]:rounded-xl [&_input]:border [&_input]:border-border [&_input]:bg-surface-low [&_input]:px-3 [&_input]:text-sm [&_input]:text-text-primary [&_select]:mt-2 [&_select]:h-10 [&_select]:w-full [&_select]:rounded-xl [&_select]:border [&_select]:border-border [&_select]:bg-surface-low [&_select]:px-3 [&_select]:text-sm [&_select]:text-text-primary [&_textarea]:mt-2 [&_textarea]:w-full [&_textarea]:rounded-xl [&_textarea]:border [&_textarea]:border-border [&_textarea]:bg-surface-low [&_textarea]:p-3 [&_textarea]:text-sm [&_textarea]:text-text-primary">{label}{children}</label>;
}
