import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Folder,
  FolderPlus,
  Import as ImportIcon,
  Pencil,
  Plus,
  Server,
  Terminal,
  Trash2,
} from "lucide-react";
import { useI18n, type TranslationKey } from "../../../lib/i18n";
import type {
  CreateSshHostInput,
  SshHost,
  SshHostGroup,
} from "../../../lib/types";
import { buildSshConnectionSpec } from "../../../lib/ssh";
import { useSshHostStore } from "../../../stores/sshHostStore";
import { useTerminalStore } from "../../../stores/terminalStore";
import { useAppConfirm } from "../../ui/useAppConfirm";
import { useAppPrompt } from "../../ui/useAppPrompt";
import { SshHostEditor } from "./SshHostEditor";
import { SshConfigImportDialog } from "./SshConfigImportDialog";

interface Props { searchValue: string; onTerminalOpened?: () => void }
interface SshClientStatus { available: boolean; version: string | null; error: string | null }
interface SshConnectionTestResult { success: boolean; stages: Array<{ key: string; status: string; detail: string }> }
const EMPTY_FORM: CreateSshHostInput = {
  name: "", group_name: "", host: "", port: 22, username: "", config_alias: "", config_file: "",
  auth_mode: "credential_ref", identity_file: "", jump_mode: "none", jump_host_id: null,
  proxy_type: "none", proxy_host: "", proxy_port: 0, proxy_command: "",
  connect_timeout_sec: 15, server_alive_interval_sec: 30, server_alive_count_max: 3,
  terminal_encoding: "UTF-8", startup_script: "", notes: "",
};

const ERROR_LABELS: Record<string, TranslationKey> = {
  ssh_host_name_required: "settings.sshHosts.error.nameRequired",
  ssh_host_address_required: "settings.sshHosts.error.addressRequired",
  ssh_host_not_found: "settings.sshHosts.error.notFound",
  ssh_host_in_use: "settings.sshHosts.error.inUse",
  ssh_host_jump_self_reference: "settings.sshHosts.error.jumpSelf",
  ssh_proxy_credentials_forbidden: "settings.sshHosts.error.proxyCredentials",
  ssh_proxy_address_invalid: "settings.sshHosts.error.proxyAddressInvalid",
  ssh_host_port_invalid: "settings.sshHosts.error.portInvalid",
  ssh_connect_timeout_invalid: "settings.sshHosts.error.timeoutInvalid",
  ssh_identity_file_required: "settings.sshHosts.error.identityRequired",
  ssh_jump_host_required: "settings.sshHosts.error.jumpRequired",
  ssh_proxy_command_required: "settings.sshHosts.error.proxyCommandRequired",
  ssh_password_required: "settings.sshHosts.error.passwordRequired",
  ssh_credential_ref_required: "settings.sshHosts.error.credentialRefRequired",
  ssh_group_name_required: "settings.sshHosts.error.groupNameRequired",
  ssh_group_name_duplicate: "settings.sshHosts.error.groupNameDuplicate",
  ssh_group_parent_not_found: "settings.sshHosts.error.groupParentNotFound",
  ssh_group_schema_unavailable: "settings.sshHosts.error.groupSchemaUnavailable",
  ssh_config_file_invalid: "settings.sshHosts.import.error.configFileInvalid",
  ssh_config_file_not_found: "settings.sshHosts.import.error.configFileUnavailable",
};

function formFromHost(host: SshHost): CreateSshHostInput { return { ...host }; }

function hostFromForm(form: CreateSshHostInput, id: string): SshHost {
  return {
    id, name: form.name, group_name: form.group_name ?? "", group_id: form.group_id ?? null, host: form.host ?? "", port: form.port ?? 22,
    username: form.username ?? "", config_alias: form.config_alias ?? "", config_file: form.config_file ?? "", auth_mode: form.auth_mode ?? "ssh_config",
    identity_file: form.identity_file ?? "", credential_ref: form.credential_ref ?? "", jump_mode: form.jump_mode ?? "none",
    jump_host_id: form.jump_host_id ?? null, proxy_type: form.proxy_type ?? "none", proxy_host: form.proxy_host ?? "",
    proxy_port: form.proxy_port ?? 0, proxy_command: form.proxy_command ?? "", connect_timeout_sec: form.connect_timeout_sec ?? 15,
    server_alive_interval_sec: form.server_alive_interval_sec ?? 30, server_alive_count_max: form.server_alive_count_max ?? 3,
    terminal_encoding: form.terminal_encoding ?? "UTF-8", startup_script: form.startup_script ?? "", notes: form.notes ?? "",
    sort_order: 0, created_at: "", updated_at: "",
  };
}

export function SshHostsSettingsPage({ searchValue, onTerminalOpened }: Props) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm();
  const { prompt, promptDialog } = useAppPrompt();
  const hosts = useSshHostStore((state) => state.hosts);
  const groups = useSshHostStore((state) => state.groups);
  const loaded = useSshHostStore((state) => state.loaded);
  const loadError = useSshHostStore((state) => state.loadError);
  const fetchHosts = useSshHostStore((state) => state.fetchHosts);
  const createHost = useSshHostStore((state) => state.createHost);
  const updateHost = useSshHostStore((state) => state.updateHost);
  const deleteHost = useSshHostStore((state) => state.deleteHost);
  const createGroup = useSshHostStore((state) => state.createGroup);
  const deleteGroup = useSshHostStore((state) => state.deleteGroup);
  const createSession = useTerminalStore((state) => state.createSession);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CreateSshHostInput>(EMPTY_FORM);
  const [source, setSource] = useState<"address" | "config">("address");
  const [addressDraft, setAddressDraft] = useState<Partial<CreateSshHostInput>>({});
  const [configDraft, setConfigDraft] = useState<Partial<CreateSshHostInput>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [client, setClient] = useState<SshClientStatus | null>(null);
  const [diagnostic, setDiagnostic] = useState<SshConnectionTestResult | null>(null);
  const [password, setPassword] = useState("");
  const [credentialStored, setCredentialStored] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    void fetchHosts();
    void invoke<SshClientStatus>("ssh_client_status").then(setClient).catch(() => {
      setClient({ available: false, version: null, error: "ssh_client_unavailable" });
    });
  }, [fetchHosts]);

  const filteredHosts = useMemo(() => {
    const query = searchValue.trim().toLocaleLowerCase();
    if (!query) return hosts;
    return hosts.filter((host) => [host.name, host.group_name, host.host, host.config_alias, host.username, host.notes]
      .some((value) => value.toLocaleLowerCase().includes(query)));
  }, [hosts, searchValue]);

  const setValue = <K extends keyof CreateSshHostInput>(key: K, value: CreateSshHostInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (source === "address") setAddressDraft((current) => ({ ...current, [key]: value }));
    else setConfigDraft((current) => ({ ...current, [key]: value }));
    setError(null);
    setTestError(null);
  };

  const changeSource = (next: "address" | "config") => {
    if (next === source) return;
    if (source === "address") setAddressDraft({ ...form }); else setConfigDraft({ ...form });
    const target = next === "address" ? addressDraft : configDraft;
    setForm((current) => ({
      ...target,
      name: current.name,
      group_name: current.group_name,
      group_id: current.group_id,
      connect_timeout_sec: current.connect_timeout_sec,
      server_alive_interval_sec: current.server_alive_interval_sec,
      server_alive_count_max: current.server_alive_count_max,
      terminal_encoding: current.terminal_encoding,
      startup_script: current.startup_script,
      notes: current.notes,
      auth_mode: next === "config" ? "ssh_config" : (target.auth_mode === "ssh_config" ? "credential_ref" : target.auth_mode),
    }));
    setSource(next);
  };

  const openCreate = (group: SshHostGroup | null = null) => {
    const initialForm = {
      ...EMPTY_FORM,
      group_id: group?.id ?? null,
      group_name: group?.name ?? "",
    };
    setEditingId(null); setForm(initialForm); setAddressDraft(initialForm); setConfigDraft(initialForm); setSource("address"); setPassword(""); setCredentialStored(false); setError(null); setTestError(null); setDiagnostic(null); setEditorOpen(true);
  };
  const openEdit = (host: SshHost) => {
    const configManaged = Boolean(host.config_alias.trim());
    setEditingId(host.id);
    const base = formFromHost(host);
    const addressForm = { ...base, auth_mode: host.auth_mode === "ssh_config" ? "credential_ref" as const : host.auth_mode };
    const configForm = { ...base, host: "", auth_mode: "ssh_config" as const, identity_file: "", jump_mode: "none" as const, jump_host_id: null, proxy_type: "none" as const, proxy_command: "" };
    setForm(configManaged ? configForm : addressForm);
    setAddressDraft(addressForm);
    setConfigDraft(configForm);
    setSource(configManaged ? "config" : "address");
    setPassword("");
    setCredentialStored(false);
    if (host.auth_mode === "credential_ref") {
      void invoke<boolean>("ssh_password_status", { hostId: host.id })
        .then(setCredentialStored)
        .catch(() => setCredentialStored(false));
    }
    setError(null); setTestError(null); setDiagnostic(null); setEditorOpen(true);
  };

  const validate = (): string | null => {
    if (!form.name?.trim()) return "ssh_host_name_required";
    if (source === "address" && !form.host?.trim()) return "ssh_host_address_required";
    if (source === "config" && !form.config_alias?.trim()) return "ssh_host_address_required";
    if (source === "address" && (!Number.isInteger(form.port) || (form.port ?? 0) < 1 || (form.port ?? 0) > 65535)) return "ssh_host_port_invalid";
    if (form.auth_mode === "identity_file" && !form.identity_file?.trim()) return "ssh_identity_file_required";
    if (form.auth_mode === "credential_ref" && !credentialStored && !password) return "ssh_password_required";
    if (form.jump_mode !== "none" && !form.jump_host_id) return "ssh_jump_host_required";
    if (form.proxy_type === "proxy_command" && !form.proxy_command?.trim()) return "ssh_proxy_command_required";
    if ((form.proxy_type === "http" || form.proxy_type === "socks5") && form.proxy_host?.includes("@")) return "ssh_proxy_credentials_forbidden";
    if ((form.proxy_type === "http" || form.proxy_type === "socks5")
      && (!form.proxy_host?.trim() || !Number.isInteger(form.proxy_port) || (form.proxy_port ?? 0) < 1 || (form.proxy_port ?? 0) > 65535)) return "ssh_proxy_address_invalid";
    if (!Number.isInteger(form.connect_timeout_sec) || (form.connect_timeout_sec ?? 0) < 1 || (form.connect_timeout_sec ?? 0) > 300) return "ssh_connect_timeout_invalid";
    return null;
  };

  const formatError = (value: string): string => {
    const key = ERROR_LABELS[value];
    return key ? t(key) : value;
  };

  const save = async () => {
    const validationError = validate();
    if (validationError) { setError(validationError); return; }
    setSaving(true); setError(null);
    try {
      if (editingId) {
        const previous = hosts.find((host) => host.id === editingId);
        let credentialRef = form.credential_ref ?? previous?.credential_ref ?? "";
        if (form.auth_mode === "credential_ref" && password) {
          credentialRef = await invoke<string>("ssh_save_password", { hostId: editingId, password });
        }
        await updateHost(editingId, { ...form, credential_ref: form.auth_mode === "credential_ref" ? credentialRef : "" });
        if (previous?.credential_ref && form.auth_mode !== "credential_ref") {
          await invoke("ssh_delete_password", { hostId: editingId });
        }
      } else {
        const created = await createHost({ ...form, credential_ref: "" });
        try {
          if (form.auth_mode === "credential_ref") {
            const credentialRef = await invoke<string>("ssh_save_password", { hostId: created.id, password });
            await updateHost(created.id, { auth_mode: "credential_ref", credential_ref: credentialRef });
          }
        } catch (credentialError) {
          await deleteHost(created.id).catch(() => undefined);
          throw credentialError;
        }
      }
      setPassword("");
      setEditorOpen(false);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
    finally { setSaving(false); }
  };

  const testConnection = async (acceptNewHostKey = false) => {
    const validationError = validate();
    if (validationError) { setTestError(formatError(validationError)); return; }
    setTesting(true); setError(null); setTestError(null); setDiagnostic(null);
    let temporaryCredentialHostId: string | null = null;
    try {
      let testForm = form;
      if (form.auth_mode === "credential_ref" && password) {
        temporaryCredentialHostId = crypto.randomUUID();
        const credentialRef = await invoke<string>("ssh_save_password", { hostId: temporaryCredentialHostId, password });
        testForm = { ...form, credential_ref: credentialRef };
      }
      const result = await invoke<SshConnectionTestResult>("ssh_test_connection", {
        spec: buildSshConnectionSpec(hostFromForm(testForm, editingId ?? temporaryCredentialHostId ?? "draft"), hosts),
        acceptNewHostKey,
      });
      setDiagnostic(result);
    } catch (nextError) {
      setTestError(formatError(nextError instanceof Error ? nextError.message : String(nextError)));
    }
    finally {
      if (temporaryCredentialHostId) {
        await invoke("ssh_delete_password", { hostId: temporaryCredentialHostId }).catch(() => undefined);
      }
      setTesting(false);
    }
  };

  const remove = async (host: SshHost) => {
    if (!await confirm({ title: t("settings.sshHosts.deleteTitle"), message: t("settings.sshHosts.deleteDescription", { name: host.name }), danger: true })) return;
    try {
      await deleteHost(host.id);
      if (host.credential_ref) await invoke("ssh_delete_password", { hostId: host.id });
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
  };

  const addGroup = async (parent: SshHostGroup | null) => {
    const name = await prompt({ title: parent ? t("settings.sshHosts.groupAddChildTitle", { name: parent.name }) : t("settings.sshHosts.groupAddTitle"), placeholder: t("settings.sshHosts.groupNamePlaceholder") });
    if (!name) return;
    try {
      await createGroup(name, parent?.id ?? null);
      if (parent) setCollapsedGroups((current) => { const next = new Set(current); next.delete(parent.id); return next; });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  const removeGroup = async (group: SshHostGroup) => {
    if (!await confirm({ title: t("settings.sshHosts.groupDeleteTitle"), message: t("settings.sshHosts.groupDeleteDescription", { name: group.name }), danger: true })) return;
    try { await deleteGroup(group.id); }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
  };

  const openTerminal = async (host: SshHost) => {
    setError(null);
    try {
      await createSession(undefined, undefined, host.name, undefined, undefined, undefined, undefined, undefined, host.id);
      onTerminalOpened?.();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  const visibleError = error ? formatError(error) : null;
  const visibleLoadError = loadError ? t("settings.sshHosts.loadFailed", { error: formatError(loadError) }) : null;

  return (
    <div className="space-y-4">
      <div className="ui-surface-low flex items-center justify-between rounded-2xl border border-border px-4 py-3">
        <div className="flex items-center gap-3">
          {client?.available ? <CheckCircle2 className="h-5 w-5 text-primary" /> : <CircleAlert className="h-5 w-5 text-warning" />}
          <div><div className="text-sm font-bold text-text-primary">{t("settings.sshHosts.openSsh")}</div><div className="text-xs text-text-muted">{client?.available ? client.version : t("settings.sshHosts.openSshMissing")}</div></div>
        </div>
        <div className="flex items-center gap-2"><button className="ui-button-secondary flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold" onClick={() => void addGroup(null)}><FolderPlus className="h-4 w-4" />{t("settings.sshHosts.groupAdd")}</button><button className="ui-button-secondary flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold" onClick={() => setImportOpen(true)}><ImportIcon className="h-4 w-4" />{t("settings.sshHosts.import.action")}</button><button className="ui-button-primary flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold" onClick={() => openCreate(null)}><Plus className="h-4 w-4" />{t("settings.sshHosts.add")}</button></div>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-surface-lowest">
        {!loaded ? <div className="p-8 text-center text-sm text-text-muted">{t("common.loading")}</div> : filteredHosts.length === 0 && groups.length === 0 ? (
          <div className="p-10 text-center"><Server className="mx-auto mb-3 h-8 w-8 text-text-muted" /><div className="font-bold text-text-primary">{t("settings.sshHosts.empty")}</div><div className="mt-1 text-xs text-text-muted">{t("settings.sshHosts.emptyDescription")}</div></div>
        ) : <SshHostTree groups={groups} hosts={filteredHosts} collapsed={collapsedGroups} onToggle={(id) => setCollapsedGroups((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} onAddHost={openCreate} onAddGroup={(group) => void addGroup(group)} onDeleteGroup={(group) => void removeGroup(group)} onOpenTerminal={(host) => void openTerminal(host)} onEditHost={openEdit} onDeleteHost={(host) => void remove(host)} />}
      </div>
      {visibleLoadError && <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">{visibleLoadError}</div>}
      {visibleError && !editorOpen && <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{visibleError}</div>}
      <SshConfigImportDialog open={importOpen} hosts={hosts} groups={groups} onOpenChange={setImportOpen} />
      <SshHostEditor
        open={editorOpen}
        editingId={editingId}
        form={form}
        hosts={hosts}
        groups={groups}
        source={source}
        setSource={changeSource}
        setValue={setValue}
        diagnostic={diagnostic}
        error={visibleError}
        testError={testError}
        errorCode={error}
        password={password}
        credentialStored={credentialStored}
        testing={testing}
        saving={saving}
        onOpenChange={setEditorOpen}
        onTest={() => void testConnection()}
        onTrustHostKey={() => void testConnection(true)}
        onSave={() => void save()}
        onPasswordChange={setPassword}
      />
      {confirmDialog}{promptDialog}
    </div>
  );
}

function SshHostTree({ groups, hosts, collapsed, onToggle, onAddHost, onAddGroup, onDeleteGroup, onOpenTerminal, onEditHost, onDeleteHost }: {
  groups: SshHostGroup[];
  hosts: SshHost[];
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onAddHost: (group: SshHostGroup) => void;
  onAddGroup: (group: SshHostGroup) => void;
  onDeleteGroup: (group: SshHostGroup) => void;
  onOpenTerminal: (host: SshHost) => void;
  onEditHost: (host: SshHost) => void;
  onDeleteHost: (host: SshHost) => void;
}) {
  const { t } = useI18n();
  const groupIds = new Set(groups.map((group) => group.id));
  const childGroups = new Map<string | null, SshHostGroup[]>();
  for (const group of groups) childGroups.set(group.parent_id, [...(childGroups.get(group.parent_id) ?? []), group]);
  const hostsByGroup = new Map<string | null, SshHost[]>();
  for (const host of hosts) {
    const groupId = host.group_id && groupIds.has(host.group_id) ? host.group_id : null;
    hostsByGroup.set(groupId, [...(hostsByGroup.get(groupId) ?? []), host]);
  }
  const renderGroup = (group: SshHostGroup, depth: number, ancestors: Set<string>): ReactNode => {
    if (ancestors.has(group.id)) return null;
    const childSet = new Set([...ancestors, group.id]);
    const children = (childGroups.get(group.id) ?? []).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    const groupHosts = (hostsByGroup.get(group.id) ?? []).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    const isCollapsed = collapsed.has(group.id);
    return <div key={group.id} className="border-b border-border last:border-b-0"><div className="flex h-11 items-center gap-2 bg-surface-low px-3" style={{ paddingLeft: 12 + depth * 18 }}><button type="button" className="ui-icon-button h-7 w-7" aria-label={isCollapsed ? t("settings.sshHosts.groupExpand") : t("settings.sshHosts.groupCollapse")} onClick={() => onToggle(group.id)}><ChevronRight className={`h-4 w-4 transition-transform ${isCollapsed ? "" : "rotate-90"}`} /></button><Folder className="h-4 w-4 shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate text-sm font-bold text-text-primary">{group.name}</span><span className="text-xs text-text-muted">{groupHosts.length}</span><button type="button" className="ui-icon-button text-primary" title={t("settings.sshHosts.groupAddHost")} aria-label={t("settings.sshHosts.groupAddHost")} onClick={() => onAddHost(group)}><Plus className="h-4 w-4" /></button><button type="button" className="ui-icon-button" title={t("settings.sshHosts.groupAddChild")} aria-label={t("settings.sshHosts.groupAddChild")} onClick={() => onAddGroup(group)}><FolderPlus className="h-4 w-4" /></button><button type="button" className="ui-icon-button text-danger" title={t("settings.sshHosts.groupDelete")} aria-label={t("settings.sshHosts.groupDelete")} onClick={() => onDeleteGroup(group)}><Trash2 className="h-4 w-4" /></button></div>{!isCollapsed && <>{children.map((child) => renderGroup(child, depth + 1, childSet))}{groupHosts.map((host) => <SshHostRow key={host.id} host={host} depth={depth + 1} onOpenTerminal={onOpenTerminal} onEdit={onEditHost} onDelete={onDeleteHost} />)}</>}</div>;
  };
  const roots = (childGroups.get(null) ?? []).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const ungrouped = (hostsByGroup.get(null) ?? []).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  return <>{roots.map((group) => renderGroup(group, 0, new Set()))}{ungrouped.length > 0 && <div><div className="flex h-10 items-center gap-2 border-b border-border bg-surface-low px-4"><Folder className="h-4 w-4 text-text-muted" /><span className="text-xs font-bold text-text-muted">{t("settings.sshHosts.groupNone")}</span></div>{ungrouped.map((host) => <SshHostRow key={host.id} host={host} depth={1} onOpenTerminal={onOpenTerminal} onEdit={onEditHost} onDelete={onDeleteHost} />)}</div>}</>;
}

function SshHostRow({ host, depth, onOpenTerminal, onEdit, onDelete }: { host: SshHost; depth: number; onOpenTerminal: (host: SshHost) => void; onEdit: (host: SshHost) => void; onDelete: (host: SshHost) => void }) {
  const { t } = useI18n();
  return <div className="flex items-center gap-3 border-t border-border px-4 py-2.5" style={{ paddingLeft: 16 + depth * 18 }}><Server className="h-4 w-4 shrink-0 text-primary" /><div className="min-w-0 flex-1"><div className="truncate text-sm font-bold text-text-primary">{host.name}</div><div className="truncate text-xs text-text-muted">{host.config_alias || `${host.username ? `${host.username}@` : ""}${host.host}:${host.port}`}</div></div><span className="ui-badge-neutral">{t(`settings.sshHosts.auth.${host.auth_mode}` as const)}</span><button className="ui-icon-button" aria-label={t("settings.sshHosts.openTerminal")} title={t("settings.sshHosts.openTerminal")} onClick={() => onOpenTerminal(host)}><Terminal className="h-4 w-4" /></button><button className="ui-icon-button" aria-label={t("common.edit")} onClick={() => onEdit(host)}><Pencil className="h-4 w-4" /></button><button className="ui-icon-button text-danger" aria-label={t("common.delete")} onClick={() => onDelete(host)}><Trash2 className="h-4 w-4" /></button></div>;
}
