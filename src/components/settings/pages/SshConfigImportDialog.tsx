import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Check, FolderOpen, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../../../lib/i18n";
import type { SshConfigImportPreview, SshHost, SshHostGroup } from "../../../lib/types";
import { useSshHostStore } from "../../../stores/sshHostStore";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog";
import { Select } from "../../ui/select";

interface Props {
  open: boolean;
  hosts: SshHost[];
  groups: SshHostGroup[];
  onOpenChange: (open: boolean) => void;
}

const ROOT_GROUP_VALUE = "__root__";

const ERROR_LABELS: Record<string, TranslationKey> = {
  ssh_config_directory_required: "settings.sshHosts.import.error.directoryRequired",
  ssh_config_directory_invalid: "settings.sshHosts.import.error.directoryInvalid",
  ssh_config_directory_not_found: "settings.sshHosts.import.error.directoryNotFound",
  ssh_config_directory_not_directory: "settings.sshHosts.import.error.notDirectory",
  ssh_config_file_not_found: "settings.sshHosts.import.error.configNotFound",
  ssh_config_read_failed: "settings.sshHosts.import.error.readFailed",
  ssh_config_file_too_large: "settings.sshHosts.import.error.fileTooLarge",
  ssh_config_encoding_invalid: "settings.sshHosts.import.error.encodingInvalid",
  ssh_config_parse_failed: "settings.sshHosts.import.error.parseFailed",
  ssh_config_include_cycle: "settings.sshHosts.import.error.includeCycle",
  ssh_config_include_limit: "settings.sshHosts.import.error.includeLimit",
  ssh_config_include_not_found: "settings.sshHosts.import.error.includeNotFound",
  ssh_config_include_not_file: "settings.sshHosts.import.error.includeNotFile",
  ssh_config_include_env_invalid: "settings.sshHosts.import.error.includeEnvInvalid",
  ssh_config_include_env_missing: "settings.sshHosts.import.error.includeEnvMissing",
  ssh_config_include_pattern_invalid: "settings.sshHosts.import.error.includePatternInvalid",
  ssh_group_parent_not_found: "settings.sshHosts.error.groupParentNotFound",
  ssh_group_schema_unavailable: "settings.sshHosts.error.groupSchemaUnavailable",
};

function errorCode(error: unknown): string {
  const value = String(error);
  const match = Object.keys(ERROR_LABELS).find((code) => value.includes(code));
  return match ?? value;
}

function flattenGroups(groups: SshHostGroup[]): Array<{ id: string; label: string }> {
  const children = new Map<string | null, SshHostGroup[]>();
  for (const group of groups) {
    children.set(group.parent_id, [...(children.get(group.parent_id) ?? []), group]);
  }
  const result: Array<{ id: string; label: string }> = [];
  const visit = (parentId: string | null, prefix: string, ancestors: Set<string>) => {
    const siblings = [...(children.get(parentId) ?? [])]
      .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name));
    for (const group of siblings) {
      if (ancestors.has(group.id)) continue;
      const label = prefix ? `${prefix} / ${group.name}` : group.name;
      result.push({ id: group.id, label });
      visit(group.id, label, new Set([...ancestors, group.id]));
    }
  };
  visit(null, "", new Set());
  return result;
}

export function SshConfigImportDialog({ open: dialogOpen, hosts, groups, onOpenChange }: Props) {
  const { t } = useI18n();
  const importConfigHosts = useSshHostStore((state) => state.importConfigHosts);
  const [configDir, setConfigDir] = useState("");
  const [preview, setPreview] = useState<SshConfigImportPreview | null>(null);
  const [selectedAliases, setSelectedAliases] = useState<Set<string>>(new Set());
  const [groupId, setGroupId] = useState(ROOT_GROUP_VALUE);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existingAliases = useMemo(
    () => new Set(hosts.map((host) => host.config_alias.trim().toLowerCase()).filter(Boolean)),
    [hosts],
  );
  const groupOptions = useMemo(() => flattenGroups(groups), [groups]);
  const availableHosts = useMemo(
    () => preview?.hosts.filter((host) => !existingAliases.has(host.alias.toLowerCase())) ?? [],
    [existingAliases, preview],
  );
  const selectedImportableAliases = useMemo(
    () => availableHosts.filter((host) => selectedAliases.has(host.alias)).map((host) => host.alias),
    [availableHosts, selectedAliases],
  );
  const allSelected = availableHosts.length > 0
    && availableHosts.every((host) => selectedAliases.has(host.alias));

  const scan = async (directory: string) => {
    if (scanning || importing) return;
    setScanning(true);
    setError(null);
    setPreview(null);
    setSelectedAliases(new Set());
    try {
      const result = await invoke<SshConfigImportPreview>("ssh_config_import_preview", {
        configDir: directory,
      });
      setConfigDir(result.configDir);
      setPreview(result);
      setSelectedAliases(new Set(
        result.hosts
          .filter((host) => !existingAliases.has(host.alias.toLowerCase()))
          .map((host) => host.alias),
      ));
    } catch (nextError) {
      setError(errorCode(nextError));
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    if (!dialogOpen) return;
    let cancelled = false;
    setPreview(null);
    setSelectedAliases(new Set());
    setGroupId(ROOT_GROUP_VALUE);
    setError(null);
    void invoke<string>("ssh_config_default_directory")
      .then((directory) => {
        if (cancelled) return;
        setConfigDir(directory);
        return scan(directory);
      })
      .catch((nextError) => {
        if (!cancelled) setError(errorCode(nextError));
      });
    return () => {
      cancelled = true;
    };
  // The open transition intentionally owns initial scanning.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  const toggleAlias = (alias: string) => {
    setSelectedAliases((current) => {
      const next = new Set(current);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedAliases(allSelected ? new Set() : new Set(availableHosts.map((host) => host.alias)));
  };

  const chooseDirectory = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: configDir || undefined,
      title: t("settings.sshHosts.import.chooseDirectory"),
    });
    if (typeof selected !== "string") return;
    setConfigDir(selected);
    await scan(selected);
  };

  const runImport = async () => {
    if (!preview || selectedImportableAliases.length === 0 || importing) return;
    const attemptedCount = selectedImportableAliases.length;
    setImporting(true);
    setError(null);
    try {
      const result = await importConfigHosts({
        aliases: selectedImportableAliases,
        config_file: preview.isDefault ? "" : preview.configFile,
        group_id: groupId === ROOT_GROUP_VALUE ? null : groupId,
      });
      toast.success(t("settings.sshHosts.import.result", {
        success: result.imported,
        failed: 0,
        skipped: result.skipped,
      }));
      onOpenChange(false);
    } catch (nextError) {
      const code = errorCode(nextError);
      setError(code);
      toast.error(t("settings.sshHosts.import.result", {
        success: 0,
        failed: attemptedCount,
        skipped: 0,
      }));
    } finally {
      setImporting(false);
    }
  };

  const visibleError = error ? (ERROR_LABELS[error] ? t(ERROR_LABELS[error]) : error) : null;

  return (
    <Dialog open={dialogOpen} onOpenChange={(next) => !importing && onOpenChange(next)}>
      <DialogContent className="flex max-h-[min(760px,90vh)] max-w-[760px] flex-col p-0" showCloseButton={!importing}>
        <div className="shrink-0 border-b border-border px-5 py-4">
          <DialogTitle>{t("settings.sshHosts.import.title")}</DialogTitle>
          <DialogDescription className="mt-1">{t("settings.sshHosts.import.description")}</DialogDescription>
        </div>

        <div className="shrink-0 space-y-3 border-b border-border px-5 py-4">
          <label className="block text-xs font-bold text-text-primary" htmlFor="ssh-config-import-directory">
            {t("settings.sshHosts.import.directory")}
          </label>
          <div className="flex gap-2">
            <input
              id="ssh-config-import-directory"
              value={configDir}
              disabled={scanning || importing}
              onChange={(event) => setConfigDir(event.target.value)}
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface-low px-3 font-mono text-xs text-text-primary"
            />
            <Button variant="outline" size="sm" disabled={scanning || importing} onClick={() => void chooseDirectory()}>
              <FolderOpen className="h-4 w-4" />
              {t("common.browse")}
            </Button>
            <Button variant="outline" size="sm" disabled={scanning || importing || !configDir.trim()} onClick={() => void scan(configDir)}>
              <RefreshCw className={`h-4 w-4 ${scanning ? "animate-spin" : ""}`} />
              {t("settings.sshHosts.import.scan")}
            </Button>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(220px,0.55fr)] gap-3">
            <div className="truncate font-mono text-[11px] text-text-muted" title={preview?.configFile}>
              {preview?.configFile ?? t("settings.sshHosts.import.configFilePending")}
            </div>
            <Select
              value={groupId}
              disabled={importing}
              onChange={(event) => setGroupId(event.target.value)}
              aria-label={t("settings.sshHosts.import.group")}
              className="h-9 text-sm"
            >
              <option value={ROOT_GROUP_VALUE}>{t("settings.sshHosts.groupNone")}</option>
              {groupOptions.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
            </Select>
          </div>
          {visibleError && <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{visibleError}</div>}
          {preview?.warnings.map((warning, index) => (
            <div key={`${warning.code}-${warning.sourceFile}-${index}`} className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t("settings.sshHosts.import.warning.conditionalInclude", { file: warning.sourceFile })}</span>
            </div>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
            <label className="flex items-center gap-2 text-xs font-bold text-text-primary">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={availableHosts.length === 0 || scanning || importing}
                onChange={toggleAll}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              {t("settings.sshHosts.import.selectAll")}
            </label>
            <span className="text-xs text-text-muted">
              {t("settings.sshHosts.import.selectedSummary", { selected: selectedImportableAliases.length, total: availableHosts.length })}
            </span>
          </div>
          <div className="min-h-[220px] flex-1 overflow-y-auto px-3 py-3">
            {scanning ? (
              <div className="flex min-h-[220px] items-center justify-center gap-2 text-sm text-text-muted">
                <RefreshCw className="h-4 w-4 animate-spin" />
                {t("settings.sshHosts.import.scanning")}
              </div>
            ) : !preview || preview.hosts.length === 0 ? (
              <div className="flex min-h-[220px] items-center justify-center text-sm text-text-muted">
                {t("settings.sshHosts.import.empty")}
              </div>
            ) : (
              <div className="space-y-1">
                {preview.hosts.map((host) => {
                  const duplicate = existingAliases.has(host.alias.toLowerCase());
                  const checked = selectedAliases.has(host.alias);
                  return (
                    <label key={`${host.alias}-${host.sourceFile}`} className={`flex items-center gap-3 rounded-md px-3 py-2 ${duplicate ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-surface-container-high"}`}>
                      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={duplicate || importing}
                          onChange={() => toggleAlias(host.alias)}
                          aria-label={t("settings.sshHosts.import.selectHostAria", { name: host.alias })}
                          className="peer h-5 w-5 appearance-none rounded border border-border bg-surface-low transition-colors checked:border-primary checked:bg-primary disabled:opacity-60"
                        />
                        <Check className="pointer-events-none absolute h-3.5 w-3.5 text-white opacity-0 peer-checked:opacity-100" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold text-text-primary">{host.alias}</span>
                        <span className="mt-0.5 block truncate font-mono text-[11px] text-text-muted" title={host.sourceFile}>{host.sourceFile}</span>
                      </span>
                      {duplicate && <span className="shrink-0 text-xs font-bold text-text-muted">{t("settings.sshHosts.import.exists")}</span>}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-4">
          <Button variant="outline" disabled={importing} onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button disabled={importing || scanning || selectedImportableAliases.length === 0 || !preview} onClick={() => void runImport()}>
            {importing ? t("settings.sshHosts.import.importing") : t("settings.sshHosts.import.confirm", { count: selectedImportableAliases.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
