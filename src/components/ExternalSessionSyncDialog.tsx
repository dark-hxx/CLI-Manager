import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Select } from "./ui/select";
import { ConfirmDialog } from "./ConfirmDialog";
import { Check, RefreshCw } from "./icons";
import { useExternalSessionSyncStore, type ExternalSessionProjectCandidate, type ExternalSessionSource } from "../stores/externalSessionSyncStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { getOsPlatform, type OsPlatform } from "../lib/shell";
import { getEnabledTerminalShellOptions, resolvePreferredShellOption } from "../lib/terminalShellProfiles";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

function sourceLabel(source: ExternalSessionSource): string {
  return source === "codex" ? "Codex" : "Claude";
}

function formatRelativeTime(ms: number, t: Translate): string {
  if (!ms) return "";
  const diff = Math.max(0, Date.now() - ms);
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;
  const week = day * 7;
  const month = day * 30;
  if (diff < minute) return t("externalSessionSync.relative.justNow");
  if (diff < hour) return t("externalSessionSync.relative.minutesAgo", { count: Math.max(1, Math.floor(diff / minute)) });
  if (diff < day) return t("externalSessionSync.relative.hoursAgo", { count: Math.max(1, Math.floor(diff / hour)) });
  if (diff < week) return t("externalSessionSync.relative.daysAgo", { count: Math.max(1, Math.floor(diff / day)) });
  if (diff < month) return t("externalSessionSync.relative.weeksAgo", { count: Math.max(1, Math.floor(diff / week)) });
  return t("externalSessionSync.relative.monthsAgo", { count: Math.max(1, Math.floor(diff / month)) });
}

function ProjectRow({
  project,
  checked,
  disabled,
  onToggle,
  onIgnore,
  t,
}: {
  project: ExternalSessionProjectCandidate;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  onIgnore: () => void;
  t: Translate;
}) {
  const latestTitle = project.sessions[0]?.title ?? project.name;
  return (
    <div className="flex items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-surface-container-highest/70">
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
        <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={onToggle}
            className="peer h-5 w-5 appearance-none rounded border border-border bg-surface-container-lowest transition-colors checked:border-[var(--color-primary)] checked:bg-[var(--color-primary)] disabled:opacity-60"
            aria-label={t("externalSessionSync.selectProjectAria", { name: project.name })}
          />
          <Check
            size={13}
            strokeWidth={2.4}
            className="pointer-events-none absolute text-white opacity-0 transition-opacity peer-checked:opacity-100"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-on-surface">{project.name}</span>
            <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-on-surface-variant ring-1 ring-border/70">
              {sourceLabel(project.source)}
            </span>
            <span className="shrink-0 text-xs text-on-surface-variant">
              {t("externalSessionSync.sessionCount", { count: project.sessionCount })}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-on-surface-variant" title={project.cwd}>
            {project.cwd}
          </span>
          <span className="mt-0.5 block truncate text-xs text-on-surface-variant/80" title={latestTitle}>
            {latestTitle}
          </span>
        </span>
      </label>
      <span className="shrink-0 text-xs text-on-surface-variant">{formatRelativeTime(project.updatedAt, t)}</span>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={onIgnore}>
        {t("externalSessionSync.ignore")}
      </Button>
    </div>
  );
}

export function ExternalSessionSyncDialog() {
  const { t } = useI18n();
  const open = useExternalSessionSyncStore((state) => state.dialogOpen);
  const mode = useExternalSessionSyncStore((state) => state.dialogMode);
  const candidates = useExternalSessionSyncStore((state) => state.projectCandidates);
  const scanning = useExternalSessionSyncStore((state) => state.scanningProjects);
  const syncing = useExternalSessionSyncStore((state) => state.syncingProjects);
  const closeProjectDialog = useExternalSessionSyncStore((state) => state.closeProjectDialog);
  const syncProjectCandidates = useExternalSessionSyncStore((state) => state.syncProjectCandidates);
  const ignoreProjectCandidates = useExternalSessionSyncStore((state) => state.ignoreProjectCandidates);
  const defaultShell = useSettingsStore((state) => state.defaultShell);
  const terminalShellProfiles = useSettingsStore((state) => state.terminalShellProfiles);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [osPlatform, setOsPlatform] = useState<OsPlatform>("unknown");
  const [shell, setShell] = useState("");
  const [ignoreConfirmationOpen, setIgnoreConfirmationOpen] = useState(false);
  const dialogWasOpenRef = useRef(false);
  const shellFieldId = useId();

  useEffect(() => {
    if (!open) {
      dialogWasOpenRef.current = false;
      return;
    }
    const candidateKeys = new Set(candidates.map((candidate) => candidate.key));
    setSelectedKeys((current) => dialogWasOpenRef.current
      ? new Set(Array.from(current).filter((key) => candidateKeys.has(key)))
      : candidateKeys);
    dialogWasOpenRef.current = true;
  }, [candidates, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const platform = await getOsPlatform();
      if (cancelled) return;
      setOsPlatform(platform);
      setShell(resolvePreferredShellOption(platform, defaultShell, terminalShellProfiles));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, defaultShell, terminalShellProfiles]);

  const shellOptions = useMemo(
    () => getEnabledTerminalShellOptions(osPlatform, terminalShellProfiles),
    [osPlatform, terminalShellProfiles]
  );

  const groups = useMemo(() => ({
    codex: candidates.filter((candidate) => candidate.source === "codex"),
    claude: candidates.filter((candidate) => candidate.source === "claude"),
  }), [candidates]);
  const selectedCount = selectedKeys.size;
  const totalSessionCount = candidates
    .filter((candidate) => selectedKeys.has(candidate.key))
    .reduce((sum, candidate) => sum + candidate.sessionCount, 0);
  const disabled = scanning || syncing;

  const toggleProject = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => setSelectedKeys(new Set(candidates.map((candidate) => candidate.key)));
  const clearAll = () => setSelectedKeys(new Set());

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !disabled) void closeProjectDialog();
      }}
    >
      <DialogContent className="max-w-[680px] p-0" showCloseButton={!disabled}>
        <div className="border-b border-border/70 px-5 py-4">
          <DialogTitle>{t("externalSessionSync.title")}</DialogTitle>
          <DialogDescription className="mt-1">
            {mode === "initial"
              ? t("externalSessionSync.initialDescription")
              : t("externalSessionSync.manualDescription")}
          </DialogDescription>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
          <div className="text-sm text-on-surface-variant">
            {t("externalSessionSync.selectedSummary", { projectCount: selectedCount, sessionCount: totalSessionCount })}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={disabled || candidates.length === 0} onClick={selectAll}>
              {t("externalSessionSync.selectAll")}
            </Button>
            <Button variant="ghost" size="sm" disabled={disabled || candidates.length === 0} onClick={clearAll}>
              {t("externalSessionSync.clearAll")}
            </Button>
          </div>
        </div>

        <div className="max-h-[440px] overflow-y-auto px-3 py-3">
          {scanning ? (
            <div className="flex min-h-[180px] items-center justify-center gap-2 text-sm text-on-surface-variant">
              <RefreshCw size={15} className="animate-spin" />
              {t("externalSessionSync.scanning")}
            </div>
          ) : candidates.length === 0 ? (
            <div className="flex min-h-[180px] items-center justify-center text-sm text-on-surface-variant">
              {t("externalSessionSync.empty")}
            </div>
          ) : (
            <div className="space-y-4">
              {(["codex", "claude"] as ExternalSessionSource[]).map((source) => {
                const items = groups[source];
                if (items.length === 0) return null;
                return (
                  <section key={source} className="space-y-1">
                    <div className="px-3 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                      {sourceLabel(source)}
                    </div>
                    <div className="space-y-1">
                      {items.map((project) => (
                        <ProjectRow
                          key={project.key}
                          project={project}
                          checked={selectedKeys.has(project.key)}
                          disabled={disabled}
                          onToggle={() => toggleProject(project.key)}
                          onIgnore={() => void ignoreProjectCandidates([project.key])}
                          t={t}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-border/70 px-5 py-4">
          <div className="mr-auto flex items-center gap-2">
            <label htmlFor={shellFieldId} className="shrink-0 text-xs text-on-surface-variant">
              {t("externalSessionSync.shellLabel")}
            </label>
            <Select
              id={shellFieldId}
              value={shell}
              disabled={disabled}
              onChange={(e) => setShell(e.target.value)}
              className="w-40 text-sm"
            >
              {shellOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </Select>
          </div>
          <Button variant="outline" disabled={disabled} onClick={() => void closeProjectDialog()}>
            {t("externalSessionSync.cancel")}
          </Button>
          <Button
            variant="outline"
            disabled={disabled || selectedCount === 0}
            onClick={() => setIgnoreConfirmationOpen(true)}
          >
            {t("externalSessionSync.ignore")}
          </Button>
          <Button
            variant="default"
            disabled={disabled || candidates.length === 0}
            onClick={() => void syncProjectCandidates(Array.from(selectedKeys), shell.trim() || undefined)}
          >
            {syncing ? t("externalSessionSync.syncing") : t("externalSessionSync.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={ignoreConfirmationOpen}
        title={t("externalSessionSync.ignoreConfirmTitle")}
        message={t("externalSessionSync.ignoreConfirmMessage", { count: selectedCount })}
        confirmText={t("externalSessionSync.ignore")}
        cancelText={t("externalSessionSync.cancel")}
        danger
        zIndex={70}
        onConfirm={() => {
          setIgnoreConfirmationOpen(false);
          void ignoreProjectCandidates(Array.from(selectedKeys));
        }}
        onClose={() => setIgnoreConfirmationOpen(false)}
      />
    </Dialog>
  );
}
