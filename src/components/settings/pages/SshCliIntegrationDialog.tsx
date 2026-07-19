import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, ChevronRight, FolderOpen, RotateCcw, Save } from "lucide-react";
import { buildSshConnectionSpec } from "../../../lib/ssh";
import { DEFAULT_SSH_TOOL_CONFIG_ROOT, validateSshToolConfigRoot } from "../../../lib/sshToolIntegration";
import type { SshHost, SshToolSource } from "../../../lib/types";
import { useI18n, type TranslationKey } from "../../../lib/i18n";
import { useSshAgentIntegrationStore } from "../../../stores/sshAgentIntegrationStore";
import { CliToolIcon } from "../../CliToolIcon";
import { Button } from "../../ui/button";
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

export function SshCliIntegrationDialog({ open, host, hosts, onOpenChange }: Props) {
  const { t } = useI18n();
  const preferences = useSshAgentIntegrationStore((state) => state.preferences);
  const fetchAll = useSshAgentIntegrationStore((state) => state.fetchAll);
  const saveHostPreferences = useSshAgentIntegrationStore((state) => state.saveHostPreferences);
  const [roots, setRoots] = useState<Record<SshToolSource, string>>({ claude: "", codex: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [pickerSource, setPickerSource] = useState<SshToolSource | null>(null);
  const [pickerPath, setPickerPath] = useState("/");
  const [directories, setDirectories] = useState<SshDirectoryEntry[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState("");

  const hostPreferences = useMemo(() => {
    const result = new Map<SshToolSource, string>();
    if (!host) return result;
    for (const preference of preferences) {
      if (preference.host_id === host.id) result.set(preference.source, preference.configured_root);
    }
    return result;
  }, [host, preferences]);

  useEffect(() => {
    if (!open || !host) return;
    void fetchAll();
  }, [fetchAll, host, open]);

  useEffect(() => {
    if (!open || !host) return;
    setRoots({
      claude: hostPreferences.get("claude") ?? "",
      codex: hostPreferences.get("codex") ?? "",
    });
    setError("");
  }, [host, hostPreferences, open]);

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

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl p-0">
          <div className="border-b border-border px-5 py-4">
            <DialogTitle>{t("settings.sshHosts.cliIntegration.title", { name: host?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("settings.sshHosts.cliIntegration.description")}</DialogDescription>
          </div>
          <div className="space-y-5 px-5 py-4">
            {SOURCES.map((source) => (
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
              </section>
            ))}
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
