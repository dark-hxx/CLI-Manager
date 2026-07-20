import { useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type ReactNode, type UIEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, ChevronDown, ChevronRight, Copy, Folder, KeyRound, Route, Server, SlidersHorizontal, Terminal, X } from "lucide-react";
import { useI18n, type TranslationKey } from "../../../lib/i18n";
import type { CreateSshHostInput, SshAuthMode, SshHost, SshHostGroup, SshJumpMode, SshProxyType } from "../../../lib/types";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../ui/dialog";
import { Select } from "../../ui/select";

type Section = "basic" | "auth" | "routing" | "connection" | "startup";
type Source = "address" | "config";
type SetValue = <K extends keyof CreateSshHostInput>(key: K, value: CreateSshHostInput[K]) => void;

interface Diagnostic { success: boolean; stages: Array<{ key: string; status: string; detail: string }> }
interface Props {
  open: boolean;
  editingId: string | null;
  form: CreateSshHostInput;
  hosts: SshHost[];
  groups: SshHostGroup[];
  source: Source;
  setSource: (source: Source) => void;
  setValue: SetValue;
  diagnostic: Diagnostic | null;
  error: string | null;
  testError: string | null;
  errorCode: string | null;
  password: string;
  credentialStored: boolean;
  testing: boolean;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onTest: () => void;
  onTrustHostKey: () => void;
  onSave: () => void;
  onPasswordChange: (password: string) => void;
}

const SECTIONS: Array<{ id: Section; icon: typeof Server; label: TranslationKey }> = [
  { id: "basic", icon: Server, label: "settings.sshHosts.section.basic" },
  { id: "auth", icon: KeyRound, label: "settings.sshHosts.section.auth" },
  { id: "routing", icon: Route, label: "settings.sshHosts.section.routing" },
  { id: "connection", icon: SlidersHorizontal, label: "settings.sshHosts.section.connection" },
  { id: "startup", icon: Terminal, label: "settings.sshHosts.section.startup" },
];

const STAGE_LABELS: Record<string, TranslationKey> = {
  client: "settings.sshHosts.stage.client",
  proxy: "settings.sshHosts.stage.proxy",
  host_key: "settings.sshHosts.stage.hostKey",
  authentication: "settings.sshHosts.stage.authentication",
  connection: "settings.sshHosts.stage.connection",
  network: "settings.sshHosts.stage.network",
  shell: "settings.sshHosts.stage.shell",
};

const DETAIL_LABELS: Record<string, TranslationKey> = {
  ssh_connection_ready: "settings.sshHosts.detail.connectionReady",
  ssh_interactive_auth_required: "settings.sshHosts.detail.interactiveRequired",
  ssh_client_unavailable: "settings.sshHosts.openSshMissing",
  ssh_host_key_confirmation_required: "settings.sshHosts.detail.hostKeyConfirmationRequired",
  ssh_host_key_changed: "settings.sshHosts.detail.hostKeyChanged",
  ssh_authentication_timeout: "settings.sshHosts.detail.authenticationTimeout",
};

const NO_JUMP_HOST_VALUE = "__none__";

export function SshHostEditor(props: Props) {
  const { t } = useI18n();
  const [activeSection, setActiveSection] = useState<Section>("basic");
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const wasTestingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<Section, HTMLElement | null>>({ basic: null, auth: null, routing: null, connection: null, startup: null });

  useEffect(() => {
    if (!props.open) return;
    setActiveSection("basic");
    setDiagnosticOpen(false);
    wasTestingRef.current = false;
    scrollRef.current?.scrollTo({ top: 0 });
  }, [props.open, props.editingId]);

  useEffect(() => {
    if (!props.open) {
      setDiagnosticOpen(false);
      wasTestingRef.current = false;
      return;
    }
    if (props.testing) {
      setDiagnosticOpen(false);
    } else if (wasTestingRef.current && (props.testError || props.diagnostic?.success === false)) {
      setDiagnosticOpen(true);
    }
    wasTestingRef.current = props.testing;
  }, [props.open, props.testing, props.testError, props.diagnostic]);

  useEffect(() => {
    if (!props.errorCode) return;
    const section: Section = props.errorCode.includes("identity") || props.errorCode.includes("auth")
      ? "auth"
      : props.errorCode.includes("jump") || props.errorCode.includes("proxy")
        ? "routing"
        : props.errorCode.includes("timeout") || props.errorCode.includes("alive") || props.errorCode.includes("encoding")
          ? "connection"
          : "basic";
    scrollToSection(section);
  }, [props.errorCode]);

  const scrollToSection = (section: Section) => {
    setActiveSection(section);
    sectionRefs.current[section]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const containerTop = event.currentTarget.getBoundingClientRect().top + 16;
    let current: Section = "basic";
    for (const item of SECTIONS) {
      const element = sectionRefs.current[item.id];
      if (element && element.getBoundingClientRect().top <= containerTop + 96) current = item.id;
    }
    setActiveSection(current);
  };

  const changeSource = (next: Source) => {
    props.setSource(next);
  };

  return (
    <>
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex h-[min(700px,calc(100vh-32px))] w-[min(900px,calc(100vw-32px))] max-w-[900px] flex-col overflow-hidden p-0">
        <DialogTitle className="shrink-0 border-b border-border px-5 py-3 text-base font-bold">{props.editingId ? t("settings.sshHosts.edit") : t("settings.sshHosts.add")}</DialogTitle>
        <div className="shrink-0 border-b border-border bg-surface-low px-3 py-1.5">
          <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label={t("settings.sshHosts.sectionNavigation")}>
            {SECTIONS.map(({ id, icon: Icon, label }) => <button key={id} type="button" role="tab" aria-selected={activeSection === id} className={`ui-focus-ring flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition-colors ${activeSection === id ? "bg-primary/15 text-primary ring-1 ring-primary/40" : "text-text-muted hover:bg-surface-container-high hover:text-text-primary"}`} onClick={() => scrollToSection(id)}><Icon className="h-3.5 w-3.5" />{t(label)}</button>)}
          </div>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4" onScroll={handleScroll}>
          {props.error && <div className="mb-4 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{props.error}</div>}
          <FormSection section="basic" title={t("settings.sshHosts.section.basic")} description={t("settings.sshHosts.section.basicDescription")} sectionRefs={sectionRefs}>
            <BasicFields form={props.form} groups={props.groups} source={props.source} setSource={changeSource} setValue={props.setValue} />
          </FormSection>
          <FormSection section="auth" title={t("settings.sshHosts.section.auth")} description={t("settings.sshHosts.section.authDescription")} sectionRefs={sectionRefs}>
            {props.source === "config" ? <ConfigManagedInfo text={t("settings.sshHosts.configAuthManaged")} /> : <AuthFields form={props.form} password={props.password} credentialStored={props.credentialStored} setValue={props.setValue} onPasswordChange={props.onPasswordChange} />}
          </FormSection>
          <FormSection section="routing" title={t("settings.sshHosts.section.routing")} description={t("settings.sshHosts.section.routingDescription")} sectionRefs={sectionRefs}>
            {props.source === "config" ? <ConfigManagedInfo text={t("settings.sshHosts.configRoutingManaged")} /> : <RoutingFields form={props.form} hosts={props.hosts} editingId={props.editingId} setValue={props.setValue} />}
          </FormSection>
          <FormSection section="connection" title={t("settings.sshHosts.section.connection")} description={t("settings.sshHosts.section.connectionDescription")} sectionRefs={sectionRefs}>
            <ConnectionFields form={props.form} setValue={props.setValue} />
          </FormSection>
          <FormSection section="startup" title={t("settings.sshHosts.section.startup")} description={t("settings.sshHosts.section.startupDescription")} sectionRefs={sectionRefs}>
            <StartupFields form={props.form} setValue={props.setValue} />
          </FormSection>
        </div>
        <DialogFooter className="shrink-0 flex items-center justify-between border-t border-border px-5 py-3">
          <div className="flex min-w-0 items-center gap-3"><button type="button" className="ui-button-secondary h-9 shrink-0 rounded-lg px-3 text-sm font-bold" disabled={props.testing} onClick={props.onTest}>{props.testing ? t("settings.sshHosts.testing") : t("settings.sshHosts.test")}</button><TestStatus testing={props.testing} diagnostic={props.diagnostic} error={props.testError} onOpenDiagnostic={() => setDiagnosticOpen(true)} /></div>
          <div className="flex gap-2"><button type="button" className="ui-button-secondary h-9 rounded-lg px-3 text-sm font-bold" onClick={() => props.onOpenChange(false)}>{t("common.cancel")}</button><button type="button" className="ui-button-primary h-9 rounded-lg px-4 text-sm font-bold" disabled={props.saving} onClick={props.onSave}>{props.saving ? t("common.saving") : t("common.save")}</button></div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <DiagnosticModal
      open={props.open && diagnosticOpen}
      diagnostic={props.diagnostic}
      error={props.testError}
      onOpenChange={setDiagnosticOpen}
      onTrustHostKey={() => {
        setDiagnosticOpen(false);
        props.onTrustHostKey();
      }}
    />
    </>
  );
}

function BasicFields({ form, groups, source, setSource, setValue }: { form: CreateSshHostInput; groups: SshHostGroup[]; source: Source; setSource: (source: Source) => void; setValue: SetValue }) {
  const { t } = useI18n();
  return <div className="space-y-3"><FieldRow label={t("settings.sshHosts.name")} required><input autoFocus value={form.name} onChange={(e) => setValue("name", e.target.value)} placeholder={t("settings.sshHosts.placeholder.name")} /></FieldRow><FieldRow label={t("settings.sshHosts.group")}><SshGroupCombobox groups={groups} value={form.group_id ?? null} onChange={(group) => { setValue("group_id", group?.id ?? null); setValue("group_name", group?.name ?? ""); }} /></FieldRow><FieldRow label={t("settings.sshHosts.connectionSource")}><div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-surface-low p-0.5" role="tablist"><ChoiceButton selected={source === "address"} onClick={() => setSource("address")}>{t("settings.sshHosts.source.address")}</ChoiceButton><ChoiceButton selected={source === "config"} onClick={() => setSource("config")}>{t("settings.sshHosts.source.config")}</ChoiceButton></div></FieldRow>{source === "address" ? <FieldRow label={t("settings.sshHosts.address")} required><div className="grid grid-cols-[minmax(0,1fr)_110px] gap-2"><input value={form.host} onChange={(e) => setValue("host", e.target.value)} placeholder="gpu-01.internal" /><input type="number" min={1} max={65535} value={form.port} onChange={(e) => setValue("port", Number(e.target.value))} aria-label={t("settings.sshHosts.port")} /></div></FieldRow> : <FieldRow label={t("settings.sshHosts.configAlias")} required><input value={form.config_alias} onChange={(e) => setValue("config_alias", e.target.value)} placeholder="my-server" /></FieldRow>}</div>;
}

function AuthFields({ form, password, credentialStored, setValue, onPasswordChange }: { form: CreateSshHostInput; password: string; credentialStored: boolean; setValue: SetValue; onPasswordChange: (password: string) => void }) {
  const { t } = useI18n();
  const authMode = form.auth_mode === "ssh_config" || !form.auth_mode ? "agent" : form.auth_mode;
  return <div className="space-y-3"><FieldRow label={t("settings.sshHosts.authMode")} description={t(`settings.sshHosts.authHint.${authMode}` as const)} required><Select className="h-9 text-sm" value={authMode} onChange={(e) => { const value = e.target.value as SshAuthMode; setValue("auth_mode", value); if (value !== "identity_file") setValue("identity_file", ""); if (value !== "credential_ref") onPasswordChange(""); }}><option value="agent">{t("settings.sshHosts.auth.agent")}</option><option value="identity_file">{t("settings.sshHosts.auth.identity_file")}</option><option value="credential_ref">{t("settings.sshHosts.auth.credential_ref")}</option><option value="password_prompt">{t("settings.sshHosts.auth.password_prompt")}</option><option value="interactive">{t("settings.sshHosts.auth.interactive")}</option></Select></FieldRow><FieldRow label={t("settings.sshHosts.username")} required><input value={form.username} onChange={(e) => setValue("username", e.target.value)} placeholder="root" /></FieldRow>{authMode === "identity_file" && <FieldRow label={t("settings.sshHosts.identityFile")} required><div className="flex gap-2"><input className="min-w-0 flex-1" value={form.identity_file} onChange={(e) => setValue("identity_file", e.target.value)} placeholder="C:\\Users\\me\\.ssh\\id_ed25519" /><button type="button" className="ui-button-secondary shrink-0 rounded-xl px-3 text-xs" onClick={async () => { const selected = await open({ multiple: false, directory: false, title: t("settings.sshHosts.chooseIdentityFile") }); if (typeof selected === "string") setValue("identity_file", selected); }}>{t("common.browse")}</button></div></FieldRow>}{authMode === "credential_ref" && <FieldRow label={t("settings.sshHosts.loginPassword")} description={credentialStored ? t("settings.sshHosts.credentialStoredHint") : t("settings.sshHosts.credentialMissingHint")} required={!credentialStored}><input type="password" autoComplete="new-password" value={password} onChange={(e) => onPasswordChange(e.target.value)} placeholder={credentialStored ? t("settings.sshHosts.passwordKeepPlaceholder") : t("settings.sshHosts.passwordPlaceholder")} /></FieldRow>}<FieldRow label={t("settings.sshHosts.authOrder")}><InfoBox>{t("settings.sshHosts.authOrder")}</InfoBox></FieldRow></div>;
}

function RoutingFields({ form, hosts, editingId, setValue }: { form: CreateSshHostInput; hosts: SshHost[]; editingId: string | null; setValue: SetValue }) {
  const { t } = useI18n();
  return <div className="space-y-3"><FieldRow label={t("settings.sshHosts.jumpMode")}><Select className="h-9 text-sm" value={form.jump_mode} disabled={form.proxy_type !== "none"} onChange={(e) => { const value = e.target.value as SshJumpMode; setValue("jump_mode", value); if (value === "none") setValue("jump_host_id", null); }}><option value="none">{t("settings.sshHosts.jump.none")}</option><option value="host">{t("settings.sshHosts.jump.host")}</option><option value="proxy_jump">{t("settings.sshHosts.jump.proxyJump")}</option></Select></FieldRow>{form.jump_mode !== "none" && <FieldRow label={t("settings.sshHosts.jumpHost")} description={form.proxy_type !== "none" ? t("settings.sshHosts.proxyOverridesJump") : undefined} required><Select className="h-9 text-sm" disabled={form.proxy_type !== "none"} value={form.jump_host_id ?? NO_JUMP_HOST_VALUE} onChange={(e) => setValue("jump_host_id", e.target.value === NO_JUMP_HOST_VALUE ? null : e.target.value)}><option value={NO_JUMP_HOST_VALUE}>{t("common.none")}</option>{hosts.filter((host) => host.id !== editingId).map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</Select></FieldRow>}<ProxySettings form={form} setValue={setValue} /></div>;
}

function ProxySettings({ form, setValue }: { form: CreateSshHostInput; setValue: SetValue }) {
  const { t } = useI18n();
  const initialUrl = formatProxyUrl(form);
  const [proxyUrl, setProxyUrl] = useState(initialUrl);
  const proxyDisabled = form.proxy_type === "none";
  const legacyProxy = form.proxy_type === "proxy_command";

  useEffect(() => {
    if (form.proxy_type !== "none") setProxyUrl(formatProxyUrl(form));
  }, [form.proxy_host, form.proxy_port, form.proxy_type]);

  const applyProxyUrl = (value: string) => {
    setProxyUrl(value);
    const parsed = parseProxyUrl(value);
    if (parsed) {
      setValue("proxy_type", parsed.type);
      setValue("proxy_host", parsed.host);
      setValue("proxy_port", parsed.port);
      setValue("proxy_command", "");
      return;
    }
    const inferredType: SshProxyType = value.trim().toLowerCase().startsWith("http://") ? "http" : "socks5";
    setValue("proxy_type", inferredType);
    setValue("proxy_host", value.trim());
    setValue("proxy_port", 0);
    setValue("proxy_command", "");
  };

  const setDisabled = (disabled: boolean) => {
    if (disabled) {
      setValue("proxy_type", "none");
      return;
    }
    const parsed = parseProxyUrl(proxyUrl);
    setValue("proxy_type", parsed?.type ?? "socks5");
    setValue("proxy_host", parsed?.host ?? "");
    setValue("proxy_port", parsed?.port ?? 0);
    setValue("proxy_command", "");
  };

  return <div className="overflow-hidden rounded-xl border border-border bg-surface-lowest"><div className="grid grid-cols-[minmax(180px,0.8fr)_minmax(280px,1.2fr)] gap-6 px-4 py-4"><div><div className="text-sm font-bold text-text-primary">{t("settings.sshHosts.proxySettings")}</div><div className="mt-1 text-[11px] leading-relaxed text-text-muted">{t("settings.sshHosts.proxyDescription")}</div></div><div className="self-center"><input disabled={proxyDisabled} value={proxyUrl} onChange={(event) => applyProxyUrl(event.target.value)} placeholder={legacyProxy ? t("settings.sshHosts.proxyLegacyConfigured") : t("settings.sshHosts.proxyUrlPlaceholder")} aria-label={t("settings.sshHosts.proxyUrl")} className="h-9 w-full rounded-lg border border-border bg-surface-low px-3 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-55" /></div></div><div className="flex items-center justify-between border-t border-border px-4 py-3"><span className="text-xs font-bold text-text-primary">{t("settings.sshHosts.proxyDisabled")}</span><button type="button" role="switch" aria-checked={proxyDisabled} aria-label={t("settings.sshHosts.proxyDisabled")} onClick={() => setDisabled(!proxyDisabled)} className={`ui-focus-ring relative h-6 w-11 rounded-full transition-colors ${proxyDisabled ? "bg-primary" : "bg-surface-container-highest"}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${proxyDisabled ? "left-[22px]" : "left-0.5"}`} /></button></div></div>;
}

function formatProxyUrl(form: CreateSshHostInput): string {
  if (form.proxy_type === "none") return "";
  if (form.proxy_type === "proxy_command") return "";
  if (!form.proxy_host?.trim()) return "";
  if (form.proxy_host.includes("://")) return form.proxy_host;
  const type = form.proxy_type === "http" ? "http" : "socks5";
  const port = form.proxy_port && form.proxy_port > 0 ? `:${form.proxy_port}` : "";
  return `${type}://${form.proxy_host}${port}`;
}

function parseProxyUrl(value: string): { type: "http" | "socks5"; host: string; port: number } | null {
  try {
    const parsed = new URL(value.trim());
    const type = parsed.protocol === "http:" ? "http" : parsed.protocol === "socks5:" ? "socks5" : null;
    if (!type || !parsed.hostname || parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) return null;
    const port = parsed.port ? Number(parsed.port) : type === "http" ? 8080 : 1080;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { type, host: parsed.hostname, port };
  } catch {
    return null;
  }
}

function ConnectionFields({ form, setValue }: { form: CreateSshHostInput; setValue: SetValue }) {
  const { t } = useI18n();
  return <div className="space-y-3"><FieldRow label={t("settings.sshHosts.timeout")} required><input type="number" min={1} max={300} value={form.connect_timeout_sec} onChange={(e) => setValue("connect_timeout_sec", Number(e.target.value))} /></FieldRow><FieldRow label={t("settings.sshHosts.keepAliveInterval")}><input type="number" min={0} value={form.server_alive_interval_sec} onChange={(e) => setValue("server_alive_interval_sec", Number(e.target.value))} /></FieldRow><FieldRow label={t("settings.sshHosts.keepAliveCount")}><input type="number" min={1} max={100} value={form.server_alive_count_max} onChange={(e) => setValue("server_alive_count_max", Number(e.target.value))} /></FieldRow></div>;
}

function StartupFields({ form, setValue }: { form: CreateSshHostInput; setValue: SetValue }) {
  const { t } = useI18n();
  return <div className="space-y-3"><FieldRow label={t("settings.sshHosts.startupScript")}><textarea rows={2} className="min-h-16" value={form.startup_script} onChange={(e) => setValue("startup_script", e.target.value)} placeholder="source ~/.profile" /></FieldRow><FieldRow label={t("settings.sshHosts.notes")}><textarea rows={2} className="min-h-16" value={form.notes} onChange={(e) => setValue("notes", e.target.value)} /></FieldRow></div>;
}

function FormSection({ section, title, description, sectionRefs, children }: { section: Section; title: string; description: string; sectionRefs: MutableRefObject<Record<Section, HTMLElement | null>>; children: ReactNode }) {
  return <section ref={(element) => { sectionRefs.current[section] = element; }} className="scroll-mt-4 border-b border-border py-5 first:pt-0 last:border-b-0"><div className="mb-4"><h4 className="text-sm font-bold text-text-primary">{title}</h4><p className="mt-1 text-xs text-text-muted">{description}</p></div>{children}</section>;
}

function FieldRow({ label, description, required, children }: { label: string; description?: string; required?: boolean; children: ReactNode }) {
  return <div className="grid grid-cols-[minmax(180px,0.8fr)_minmax(280px,1.2fr)] gap-6 rounded-xl border border-border bg-surface-lowest px-4 py-3"><div><div className="text-xs font-bold text-text-primary">{label}{required && <span className="ml-1 text-danger">*</span>}</div>{description && <div className="mt-1 text-[11px] leading-relaxed text-text-muted">{description}</div>}</div><div className="[&_input]:h-9 [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:border-border [&_input]:bg-surface-low [&_input]:px-3 [&_input]:text-sm [&_input]:text-text-primary [&_select]:h-9 [&_select]:w-full [&_select]:rounded-lg [&_select]:border [&_select]:border-border [&_select]:bg-surface-low [&_select]:px-3 [&_select]:text-sm [&_select]:text-text-primary [&_textarea]:w-full [&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:border-border [&_textarea]:bg-surface-low [&_textarea]:p-3 [&_textarea]:text-sm [&_textarea]:text-text-primary">{children}</div></div>;
}

function SshGroupCombobox({ groups, value, onChange }: { groups: SshHostGroup[]; value: string | null; onChange: (group: SshHostGroup | null) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const options = useMemo(() => {
    const children = new Map<string | null, SshHostGroup[]>();
    for (const group of groups) children.set(group.parent_id, [...(children.get(group.parent_id) ?? []), group]);
    const flattened: Array<{ group: SshHostGroup; path: string; depth: number; hasChildren: boolean }> = [];
    const visit = (parentId: string | null, prefix: string, depth: number, ancestors: Set<string>) => {
      for (const group of (children.get(parentId) ?? []).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))) {
        if (ancestors.has(group.id)) continue;
        const path = prefix ? `${prefix} / ${group.name}` : group.name;
        flattened.push({ group, path, depth, hasChildren: (children.get(group.id) ?? []).length > 0 });
        visit(group.id, path, depth + 1, new Set([...ancestors, group.id]));
      }
    };
    visit(null, "", 0, new Set());
    return flattened;
  }, [groups]);
  const selected = options.find((item) => item.group.id === value) ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = normalizedQuery ? options.filter((item) => item.path.toLocaleLowerCase().includes(normalizedQuery)) : options;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return <div ref={rootRef} className="relative min-w-0 max-w-full"><input className="min-w-0 truncate pr-10" role="combobox" aria-haspopup="tree" aria-expanded={open} aria-controls={listboxId} value={open ? query : selected?.path ?? ""} placeholder={t("settings.sshHosts.groupSelectPlaceholder")} onFocus={() => { setQuery(""); setOpen(true); }} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} /><button type="button" aria-label={t("settings.sshHosts.groupOpen")} className="ui-focus-ring absolute right-1 top-[18px] flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-text-muted hover:bg-surface-container-highest" onMouseDown={(event) => event.preventDefault()} onClick={() => { setQuery(""); setOpen((current) => !current); }}><ChevronDown size={12} className={open ? "rotate-180" : ""} /></button>{open && <div id={listboxId} role="tree" aria-label={t("settings.sshHosts.group")} className="ui-select-popover absolute left-0 top-full z-[70] mt-1 max-h-52 w-full max-w-full overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-surface-container-high py-1 text-xs shadow-lg"><button type="button" role="treeitem" aria-level={1} aria-selected={!value} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(null); setOpen(false); }} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-text-muted hover:bg-surface-container-highest"><span className="h-3.5 w-3.5 shrink-0" /><Folder className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">{t("settings.sshHosts.groupNone")}</span>{!value && <Check size={12} className="shrink-0" />}</button>{filtered.map((item) => <button key={item.group.id} type="button" role="treeitem" aria-level={item.depth + 1} aria-selected={item.group.id === value} title={item.path} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(item.group); setOpen(false); }} className="flex w-full min-w-0 items-center gap-2 py-2 pr-3 text-left text-text-primary hover:bg-surface-container-highest" style={{ paddingLeft: 12 + item.depth * 18 }}><span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{item.hasChildren && <ChevronRight className="h-3 w-3 rotate-90 text-text-muted" />}</span><Folder className="h-3.5 w-3.5 shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate">{item.group.name}</span>{item.group.id === value && <Check size={12} className="shrink-0 text-primary" />}</button>)}</div>}</div>;
}

function TestStatus({ testing, diagnostic, error, onOpenDiagnostic }: { testing: boolean; diagnostic: Diagnostic | null; error: string | null; onOpenDiagnostic: () => void }) {
  const { t } = useI18n();
  if (!testing && !diagnostic && !error) return null;
  const success = diagnostic?.success === true;
  const tone = testing ? "text-amber-500" : success ? "text-emerald-500" : "text-red-500";
  const label = testing ? t("settings.sshHosts.testing") : success ? t("settings.sshHosts.testPassed") : t("settings.sshHosts.testFailed");
  const message = error ? `${label}: ${error}` : label;
  const content = <><span>●</span><span className="truncate">{message}</span></>;
  if (!testing && !success) return <button type="button" title={message} className={`ui-focus-ring flex min-w-0 max-w-80 cursor-pointer items-center gap-1.5 truncate rounded-md px-1.5 py-1 text-xs font-bold transition-colors hover:bg-danger/10 ${tone}`} onClick={onOpenDiagnostic}>{content}</button>;
  return <div title={message} className={`flex min-w-0 max-w-80 items-center gap-1.5 truncate text-xs font-bold ${tone}`}>{content}</div>;
}

function ChoiceButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) { return <button type="button" role="tab" aria-selected={selected} className={selected ? "ui-button-primary rounded-md px-3 py-1.5 text-xs font-bold" : "rounded-md px-3 py-1.5 text-xs font-bold text-text-muted hover:bg-surface-container-high"} onClick={onClick}>{children}</button>; }
function ConfigManagedInfo({ text }: { text: string }) { return <InfoBox>{text}</InfoBox>; }
function InfoBox({ children }: { children: ReactNode }) { return <div className="rounded-xl border border-border bg-surface-low px-3 py-2 text-xs leading-relaxed text-text-muted">{children}</div>; }

function DiagnosticModal({ open, diagnostic, error, onTrustHostKey, onOpenChange }: { open: boolean; diagnostic: Diagnostic | null; error?: string | null; onTrustHostKey: () => void; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const formatDetail = (detail: string) => {
    const [code, ...rest] = detail.split("\n");
    const translated = DETAIL_LABELS[code] ? t(DETAIL_LABELS[code]) : code;
    return [translated, ...rest.filter(Boolean)].join("\n");
  };
  const trustRequired = diagnostic?.stages.some((stage) => stage.detail.startsWith("ssh_host_key_confirmation_required")) === true;
  const logText = [error, ...(diagnostic?.stages.map((stage) => `${t(STAGE_LABELS[stage.key] ?? "settings.sshHosts.stage.connection")}: ${formatDetail(stage.detail)}`) ?? [])].filter(Boolean).join("\n");
  const copyLog = async () => {
    await navigator.clipboard.writeText(logText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent showCloseButton={false} overlayClassName="z-[60]" className="z-[60] flex h-[min(640px,calc(100vh-48px))] w-[min(720px,calc(100vw-48px))] max-w-[720px] flex-col overflow-hidden p-0"><header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3"><div className="min-w-0"><DialogTitle className="truncate text-base font-bold">{t("settings.sshHosts.diagnostic.title")}</DialogTitle><DialogDescription className="sr-only">{t("settings.sshHosts.diagnostic.logTitle")}</DialogDescription></div><div className="flex shrink-0 items-center gap-1"><button type="button" className="ui-focus-ring flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs text-text-muted transition-colors hover:bg-surface-container-highest hover:text-text-primary" title={copied ? t("settings.sshHosts.diagnostic.copied") : t("common.copy")} aria-label={copied ? t("settings.sshHosts.diagnostic.copied") : t("common.copy")} onClick={() => void copyLog()}>{copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}<span>{copied ? t("settings.sshHosts.diagnostic.copied") : t("common.copy")}</span></button><button type="button" className="ui-icon-button h-8 w-8 cursor-pointer" title={t("common.close")} aria-label={t("common.close")} onClick={() => onOpenChange(false)}><X className="h-4 w-4" /></button></div></header><div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-surface-low px-5 py-4">{error && <div className="whitespace-pre-wrap break-words rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 font-mono text-xs leading-relaxed text-danger">{error}</div>}{diagnostic?.stages.map((stage) => { const tone = stage.status === "passed" ? "text-emerald-500" : stage.status === "failed" ? "text-red-500" : "text-amber-500"; return <section key={stage.key} className="rounded-xl border border-border bg-surface-lowest px-4 py-3"><div className="flex items-center gap-2"><span className={tone}>●</span><h4 className={`text-sm font-bold ${tone}`}>{t(STAGE_LABELS[stage.key] ?? "settings.sshHosts.stage.connection")}</h4></div><pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-muted">{formatDetail(stage.detail)}</pre></section>; })}</div>{trustRequired && <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border bg-surface-lowest px-5 py-3"><div className="text-xs leading-relaxed text-warning">{t("settings.sshHosts.hostKeyTrustDescription")}</div><button type="button" className="ui-button-primary h-9 shrink-0 cursor-pointer rounded-lg px-4 text-xs font-bold" onClick={onTrustHostKey}>{t("settings.sshHosts.trustHostKeyAndRetry")}</button></footer>}</DialogContent></Dialog>;
}
