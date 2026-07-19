import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { JsonObject, JsonValue, Operation, OperationStatus, ProjectContext } from "./domain";
import type { TranslationKey } from "./i18n";

type T = (key: TranslationKey) => string;
type Area = "ssh" | "file" | "git" | "worktree" | "hook";

const AREAS: Area[] = ["ssh", "file", "git", "worktree", "hook"];

type Props = {
  t: T;
  capabilities: string[];
  projectContext?: ProjectContext;
  operations: Operation[];
  onSubmit: (kind: string, payload: JsonObject) => Promise<Operation>;
};

const AREA_CAPABILITY: Record<Area, string> = {
  ssh: "ssh.management",
  file: "file.management",
  git: "git.management",
  worktree: "worktree.management",
  hook: "hook.management",
};

function csv(value: string): JsonValue[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function isManagementOperation(operation: Operation): boolean {
  return AREAS.some((area) => operation.kind.startsWith(`${area}.`));
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template);
}

function safeErrorMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
}

function managementErrorText(t: T, code: string, message?: unknown) {
  let summary: string;
  if (code === "device_offline") summary = t("deviceOfflineError");
  else if (code === "project_context_required") summary = t("projectContextRequired");
  else if (code === "device_capability_unavailable") summary = t("capabilityUnavailable");
  else if (code === "operation_confirmation_required") summary = t("operationConfirmationRequired");
  else if (code === "unsupported_operation_kind") summary = t("unsupportedOperation");
  else if (code === "invalid_operation_payload") summary = t("invalidOperationPayload");
  else summary = t("requestFailed");
  const details = safeErrorMessage(message);
  return details ? `${summary} (${code}): ${details}` : `${summary} (${code})`;
}

function operationStatusLabel(t: T, status: OperationStatus): string {
  const key: Record<OperationStatus, TranslationKey> = { submitted: "submitted", waiting_device: "waitingDevice", accepted: "accepted", running: "running", succeeded: "succeeded", failed: "failed", rejected: "rejected", timed_out: "timedOut", canceled: "canceled" };
  return t(key[status]);
}

function stringValue(payload: JsonObject, key: string): string {
  return typeof payload[key] === "string" ? payload[key].trim() : "";
}

function valueList(payload: JsonObject, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function validateOperation(t: T, kind: string, payload: JsonObject): string {
  const required: Record<string, Array<[string, TranslationKey]>> = {
    "ssh.test_connection": [["hostId", "hostId"]],
    "ssh.check_path": [["hostId", "hostId"], ["path", "remotePath"]],
    "ssh.list_directories": [["hostId", "hostId"], ["path", "remotePath"]],
    "ssh.host.create": [["name", "hostName"], ["host", "hostAddress"]],
    "ssh.host.update": [["hostId", "hostId"], ["name", "hostName"], ["host", "hostAddress"], ["username", "username"]],
    "ssh.host.delete": [["hostId", "hostId"]],
    "file.search": [["query", "query"]],
    "file.search_content": [["query", "query"]],
    "file.create": [["name", "name"]],
    "file.create_directory": [["name", "name"]],
    "file.rename": [["path", "relativePath"], ["name", "name"]],
    "file.copy": [["sourcePath", "relativePath"], ["name", "name"]],
    "file.move": [["sourcePath", "relativePath"], ["name", "name"]],
    "file.delete": [["path", "relativePath"]],
    "git.checkout": [["branch", "branch"]],
    "git.create_branch": [["branch", "branch"]],
    "git.commit": [["message", "commitMessage"]],
    "worktree.create": [["taskName", "taskName"]],
    "worktree.check_deps": [["worktreeId", "worktreeId"]],
    "worktree.merge": [["worktreeId", "worktreeId"]],
    "worktree.remove": [["worktreeId", "worktreeId"]],
  };
  const missing = (required[kind] ?? []).filter(([key]) => !stringValue(payload, key)).map(([, label]) => t(label));
  if (["git.stage", "git.unstage", "git.delete_untracked"].includes(kind) && valueList(payload, "paths").length === 0) missing.push(t("pathsCommaSeparated"));
  if (kind === "git.discard" && (!Array.isArray(payload.items) || payload.items.length === 0)) missing.push(t("pathsCommaSeparated"));
  if (missing.length) return fillTemplate(t("requiredFields"), { fields: missing.join(", ") });
  if (kind === "ssh.host.create" || kind === "ssh.host.update") {
    const port = payload.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return t("invalidPortValue");
  }
  return "";
}

function operationTarget(t: T, kind: string, payload: JsonObject, projectContext?: ProjectContext): string {
  const context = projectContext?.cwd || projectContext?.projectKey || t("unknown");
  if (kind.startsWith("ssh.")) return stringValue(payload, "hostId") || stringValue(payload, "host") || t("unknown");
  if (kind === "file.copy" || kind === "file.move") return `${stringValue(payload, "sourcePath")} → ${stringValue(payload, "targetParentPath") || "."}/${stringValue(payload, "name")}`;
  if (kind === "file.rename") return `${stringValue(payload, "path")} → ${stringValue(payload, "name")}`;
  if (kind === "file.create" || kind === "file.create_directory") return `${stringValue(payload, "parentPath") || "."}/${stringValue(payload, "name")}`;
  if (kind.startsWith("file.")) return stringValue(payload, "path") || stringValue(payload, "query") || context;
  if (kind.startsWith("git.")) {
    const discardPaths = Array.isArray(payload.items)
      ? payload.items.flatMap((item) => item && typeof item === "object" && !Array.isArray(item) && typeof item.path === "string" ? [item.path] : [])
      : [];
    return stringValue(payload, "branch") || valueList(payload, "paths").join(", ") || discardPaths.join(", ") || context;
  }
  if (kind.startsWith("worktree.")) return stringValue(payload, "worktreeId") || stringValue(payload, "taskName") || context;
  if (kind.startsWith("hook.")) return stringValue(payload, "target") || t("allTargets");
  return context;
}

function moveTabFocus(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number, setArea: (area: Area) => void) {
  let nextIndex = currentIndex;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % AREAS.length;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + AREAS.length) % AREAS.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = AREAS.length - 1;
  else return;
  event.preventDefault();
  const nextArea = AREAS[nextIndex]!;
  setArea(nextArea);
  const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  tabs?.[nextIndex]?.focus();
}

export function ManagementPanel({ t, capabilities, projectContext, operations, onSubmit }: Props) {
  const [area, setArea] = useState<Area>("ssh");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [lastOperationId, setLastOperationId] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({ port: "22", pullStrategy: "ff-only", target: "all", status: "M" });
  const [deleteBranch, setDeleteBranch] = useState(false);
  const latest = useMemo(
    () => operations.find((operation) => operation.id === lastOperationId && isManagementOperation(operation)),
    [lastOperationId, operations],
  );
  const supported = capabilities.includes(AREA_CAPABILITY[area]);

  const field = (key: string) => fields[key] ?? "";
  const update = (key: string, value: string) => setFields((current) => ({ ...current, [key]: value }));
  const run = async (kind: string, payload: JsonObject = {}, risky = false) => {
    if (working) return;
    const validationError = validateOperation(t, kind, payload);
    if (validationError) {
      setMessage(validationError);
      return;
    }
    if (risky && !window.confirm(fillTemplate(t("confirmRiskyOperation"), { operation: kind, target: operationTarget(t, kind, payload, projectContext) }))) return;
    setWorking(true);
    setMessage("");
    try {
      const operation = await onSubmit(kind, risky ? { ...payload, confirmed: true } : payload);
      setLastOperationId(operation.id);
      setMessage(t("operationSubmitted"));
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "request_failed";
      const errorMessage = error && typeof error === "object" && "message" in error ? error.message : undefined;
      setMessage(managementErrorText(t, code, errorMessage));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="management-panel">
      <p className="muted">{t("managementHint")}</p>
      <div className="management-tabs" role="tablist" aria-label={t("management")} aria-orientation="horizontal">
        {AREAS.map((item, index) => (
          <button key={item} id={`management-tab-${item}`} type="button" role="tab" aria-selected={area === item} aria-controls="management-tabpanel" tabIndex={area === item ? 0 : -1} disabled={working} className={area === item ? "active" : ""} onClick={() => setArea(item)} onKeyDown={(event) => moveTabFocus(event, index, setArea)}>
            {t(({ ssh: "sshManagement", file: "fileManagement", git: "gitManagement", worktree: "worktreeManagement", hook: "hookManagement" } as const)[item])}
          </button>
        ))}
      </div>

      <section id="management-tabpanel" role="tabpanel" aria-labelledby={`management-tab-${area}`} tabIndex={0}>
        {!supported ? <p className="form-error" role="alert">{t("capabilityUnavailable")}</p> : (
          <div className="management-form">
            {area === "ssh" && <SshControls t={t} field={field} update={update} run={run} busy={working} />}
            {area === "file" && <FileControls t={t} field={field} update={update} run={run} busy={working} disabled={!projectContext} />}
            {area === "git" && <GitControls t={t} field={field} update={update} run={run} busy={working} disabled={!projectContext} />}
            {area === "worktree" && <WorktreeControls t={t} field={field} update={update} run={run} busy={working} disabled={!projectContext} deleteBranch={deleteBranch} setDeleteBranch={setDeleteBranch} />}
            {area === "hook" && <HookControls t={t} field={field} update={update} run={run} busy={working} />}
          </div>
        )}
      </section>

      {working && <p role="status">{t("running")}</p>}
      {message && <p className="composer-feedback" role="status">{message}</p>}
      <section className="management-result" aria-live="polite">
        <h3>{t("operationResult")}</h3>
        {!latest ? <p className="muted">{t("noManagementOperation")}</p> : <>
          <div className="operation-grid"><span>{t("operationKind")}</span><strong>{latest.kind}</strong><span>{t("operationStatus")}</span><strong>{operationStatusLabel(t, latest.status)}</strong><span>ID</span><code>{latest.id}</code></div>
          {latest.error && <p className="form-error" role="alert">{managementErrorText(t, latest.error.code, latest.error.message)}</p>}
          {latest.result !== null && <pre>{JSON.stringify(latest.result, null, 2)}</pre>}
        </>}
      </section>
    </div>
  );
}

type ControlProps = { t: T; field: (key: string) => string; update: (key: string, value: string) => void; run: (kind: string, payload?: JsonObject, risky?: boolean) => void; busy: boolean };

function Input({ label, value, onChange, placeholder = "" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label><span>{label}</span><input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></label>;
}

function Action({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
  return <button className="secondary-button" type="button" disabled={disabled} onClick={onClick}>{label}</button>;
}

function SshControls({ t, field, update, run, busy }: ControlProps) {
  return <>
    <div className="management-actions"><Action disabled={busy} label={t("listHosts")} onClick={() => run("ssh.hosts.list")} /><Action disabled={busy} label={t("clientStatus")} onClick={() => run("ssh.client_status")} /></div>
    <div className="management-grid"><Input label={t("hostId")} value={field("hostId")} onChange={(value) => update("hostId", value)} /><Input label={t("remotePath")} value={field("path")} onChange={(value) => update("path", value)} placeholder="/" /><label className="checkbox-row"><input type="checkbox" checked={field("acceptNewHostKey") === "true"} onChange={(event) => update("acceptNewHostKey", String(event.target.checked))} />{t("acceptNewHostKey")}</label></div>
    <div className="management-actions"><Action disabled={busy} label={t("testConnection")} onClick={() => run("ssh.test_connection", { hostId: field("hostId"), acceptNewHostKey: field("acceptNewHostKey") === "true" }, field("acceptNewHostKey") === "true")} /><Action disabled={busy} label={t("checkPath")} onClick={() => run("ssh.check_path", { hostId: field("hostId"), path: field("path") })} /><Action disabled={busy} label={t("listDirectories")} onClick={() => run("ssh.list_directories", { hostId: field("hostId"), path: field("path") || "/" })} /></div>
    <div className="management-grid"><Input label={t("hostName")} value={field("hostName")} onChange={(value) => update("hostName", value)} /><Input label={t("hostAddress")} value={field("host")} onChange={(value) => update("host", value)} /><Input label={t("port")} value={field("port")} onChange={(value) => update("port", value)} /><Input label={t("username")} value={field("sshUsername")} onChange={(value) => update("sshUsername", value)} /></div>
    <div className="management-actions"><Action disabled={busy} label={t("createHost")} onClick={() => run("ssh.host.create", { name: field("hostName"), host: field("host"), port: Number(field("port")), username: field("sshUsername"), authMode: "agent" }, true)} /><Action disabled={busy} label={t("updateHost")} onClick={() => run("ssh.host.update", { hostId: field("hostId"), name: field("hostName"), host: field("host"), port: Number(field("port")), username: field("sshUsername") }, true)} /><Action disabled={busy} label={t("deleteHost")} onClick={() => run("ssh.host.delete", { hostId: field("hostId") }, true)} /></div>
  </>;
}

function FileControls({ t, field, update, run, busy, disabled }: ControlProps & { disabled: boolean }) {
  return <>
    {disabled && <p className="form-error">{t("projectContextRequired")}</p>}
    <div className="management-grid"><Input label={t("relativePath")} value={field("path")} onChange={(value) => update("path", value)} /><Input label={t("query")} value={field("query")} onChange={(value) => update("query", value)} /><Input label={t("name")} value={field("name")} onChange={(value) => update("name", value)} /><Input label={t("targetPath")} value={field("targetPath")} onChange={(value) => update("targetPath", value)} /></div>
    <div className="management-actions"><Action disabled={busy || disabled} label={t("listFiles")} onClick={() => run("file.list", { path: field("path") })} /><Action disabled={busy || disabled} label={t("searchFiles")} onClick={() => run("file.search", { query: field("query") })} /><Action disabled={busy || disabled} label={t("searchContent")} onClick={() => run("file.search_content", { query: field("query") })} /></div>
    <div className="management-actions"><Action disabled={busy || disabled} label={t("createFile")} onClick={() => run("file.create", { parentPath: field("path"), name: field("name") }, true)} /><Action disabled={busy || disabled} label={t("createDirectory")} onClick={() => run("file.create_directory", { parentPath: field("path"), name: field("name") }, true)} /><Action disabled={busy || disabled} label={t("rename")} onClick={() => run("file.rename", { path: field("path"), name: field("name") }, true)} /><Action disabled={busy || disabled} label={t("copy")} onClick={() => run("file.copy", { sourcePath: field("path"), targetParentPath: field("targetPath"), name: field("name") }, true)} /><Action disabled={busy || disabled} label={t("move")} onClick={() => run("file.move", { sourcePath: field("path"), targetParentPath: field("targetPath"), name: field("name") }, true)} /><Action disabled={busy || disabled} label={t("deleteAction")} onClick={() => run("file.delete", { path: field("path") }, true)} /></div>
  </>;
}

function GitControls({ t, field, update, run, busy, disabled }: ControlProps & { disabled: boolean }) {
  return <>
    {disabled && <p className="form-error">{t("projectContextRequired")}</p>}
    <div className="management-actions"><Action disabled={busy || disabled} label={t("gitStatus")} onClick={() => run("git.status")} /><Action disabled={busy || disabled} label={t("branches")} onClick={() => run("git.branches")} /><Action disabled={busy || disabled} label={t("fetch")} onClick={() => run("git.fetch", {}, true)} /></div>
    <div className="management-grid"><Input label={t("branch")} value={field("branch")} onChange={(value) => update("branch", value)} /><Input label={t("pathsCommaSeparated")} value={field("paths")} onChange={(value) => update("paths", value)} /><Input label={t("statusCode")} value={field("status")} onChange={(value) => update("status", value)} /><Input label={t("commitMessage")} value={field("message")} onChange={(value) => update("message", value)} /></div>
    <div className="management-actions"><Action disabled={busy || disabled} label={t("checkout")} onClick={() => run("git.checkout", { branch: field("branch"), remote: false }, true)} /><Action disabled={busy || disabled} label={t("createBranch")} onClick={() => run("git.create_branch", { branch: field("branch") }, true)} /><Action disabled={busy || disabled} label={t("stage")} onClick={() => run("git.stage", { paths: csv(field("paths")) }, true)} /><Action disabled={busy || disabled} label={t("unstage")} onClick={() => run("git.unstage", { paths: csv(field("paths")) }, true)} /><Action disabled={busy || disabled} label={t("commit")} onClick={() => run("git.commit", { message: field("message") }, true)} /><Action disabled={busy || disabled} label={t("pull")} onClick={() => run("git.pull", { strategy: field("pullStrategy") }, true)} /><Action disabled={busy || disabled} label={t("push")} onClick={() => run("git.push", {}, true)} /><Action disabled={busy || disabled} label={t("discard")} onClick={() => run("git.discard", { items: csv(field("paths")).map((path) => ({ path, status: field("status") || "M" })) }, true)} /><Action disabled={busy || disabled} label={t("deleteUntracked")} onClick={() => run("git.delete_untracked", { paths: csv(field("paths")) }, true)} /></div>
  </>;
}

function WorktreeControls({ t, field, update, run, busy, disabled, deleteBranch, setDeleteBranch }: ControlProps & { disabled: boolean; deleteBranch: boolean; setDeleteBranch: (value: boolean) => void }) {
  return <>
    {disabled && <p className="form-error">{t("projectContextRequired")}</p>}
    <div className="management-grid"><Input label={t("taskName")} value={field("taskName")} onChange={(value) => update("taskName", value)} /><Input label={t("worktreeId")} value={field("worktreeId")} onChange={(value) => update("worktreeId", value)} /><label className="checkbox-row"><input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} />{t("deleteBranch")}</label></div>
    <div className="management-actions"><Action disabled={busy || disabled} label={t("listWorktrees")} onClick={() => run("worktree.list")} /><Action disabled={busy || disabled} label={t("createWorktree")} onClick={() => run("worktree.create", { taskName: field("taskName") }, true)} /><Action disabled={busy || disabled} label={t("checkDeps")} onClick={() => run("worktree.check_deps", { worktreeId: field("worktreeId") })} /><Action disabled={busy || disabled} label={t("mergeWorktree")} onClick={() => run("worktree.merge", { worktreeId: field("worktreeId") }, true)} /><Action disabled={busy || disabled} label={t("removeWorktree")} onClick={() => run("worktree.remove", { worktreeId: field("worktreeId"), deleteBranch }, true)} /></div>
  </>;
}

function HookControls({ t, field, update, run, busy }: ControlProps) {
  return <>
    <label><span>{t("hookTarget")}</span><select value={field("target")} onChange={(event) => update("target", event.target.value)}><option value="all">{t("allTargets")}</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
    <div className="management-actions"><Action disabled={busy} label={t("hookStatus")} onClick={() => run("hook.status", { target: field("target") })} /><Action disabled={busy} label={t("install")} onClick={() => run("hook.install", { target: field("target") }, true)} /><Action disabled={busy} label={t("repair")} onClick={() => run("hook.repair", { target: field("target") }, true)} /><Action disabled={busy} label={t("testAction")} onClick={() => run("hook.test", { target: field("target") })} /><Action disabled={busy} label={t("uninstall")} onClick={() => run("hook.uninstall", { target: field("target") }, true)} /></div>
  </>;
}
