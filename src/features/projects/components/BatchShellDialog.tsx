import { useEffect, useId, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../../shared/ui/dialog";
import { Button } from "../../../shared/ui/button";
import { Select } from "../../../shared/ui/select";
import { Check } from "../../../shared/ui/icons";
import { toast } from "sonner";
import { useProjectStore } from "../api/projectStore";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { useI18n } from "../../../shared/i18n/index";
import { getOsPlatform, normalizeShellKey, type OsPlatform } from "../../../shared/platform/shell";
import { getEnabledTerminalShellOptions, resolvePreferredShellOption } from "../../../shared/lib/terminalShellProfiles";
import { getShellOptions, type Project } from "../../../shared/types/index";

interface BatchShellDialogProps {
  /** 打开时预勾选的项目 id 集合（右键项目=多选集合或该项目；右键分组=组内全部项目） */
  preselectedIds: ReadonlySet<string>;
  onClose: () => void;
}

export function BatchShellDialog({ preselectedIds, onClose }: BatchShellDialogProps) {
  const { t } = useI18n();
  const projects = useProjectStore((s) => s.projects);
  const groups = useProjectStore((s) => s.groups);
  const batchUpdateProjectShell = useProjectStore((s) => s.batchUpdateProjectShell);
  const defaultShell = useSettingsStore((s) => s.defaultShell);
  const terminalShellProfiles = useSettingsStore((s) => s.terminalShellProfiles);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(projects.filter((p) => preselectedIds.has(p.id)).map((p) => p.id))
  );
  const [osPlatform, setOsPlatform] = useState<OsPlatform>("unknown");
  const [shell, setShell] = useState("");
  const [applying, setApplying] = useState(false);
  const shellFieldId = useId();

  useEffect(() => {
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
  }, [defaultShell, terminalShellProfiles]);

  const shellOptions = useMemo(
    () => getEnabledTerminalShellOptions(osPlatform, terminalShellProfiles),
    [osPlatform, terminalShellProfiles]
  );

  const shellLabelFor = useMemo(() => {
    const options = getShellOptions(osPlatform);
    return (value: string) => {
      const normalized = normalizeShellKey(value);
      return options.find((opt) => opt.value === normalized)?.label ?? value;
    };
  }, [osPlatform]);

  const sections = useMemo(() => {
    const knownGroupIds = new Set(groups.map((g) => g.id));
    const byGroup = new Map<string | null, Project[]>();
    for (const project of projects) {
      const key = project.group_id && knownGroupIds.has(project.group_id) ? project.group_id : null;
      const list = byGroup.get(key);
      if (list) list.push(project);
      else byGroup.set(key, [project]);
    }
    const result: Array<{ key: string; name: string; projects: Project[] }> = [];
    for (const group of groups) {
      const list = byGroup.get(group.id);
      if (list?.length) result.push({ key: group.id, name: group.name, projects: list });
    }
    const ungrouped = byGroup.get(null);
    if (ungrouped?.length) {
      result.push({ key: "__ungrouped__", name: t("batchShell.ungrouped"), projects: ungrouped });
    }
    return result;
  }, [groups, projects, t]);

  const selectedCount = selectedIds.size;

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(projects.map((p) => p.id)));
  const clearAll = () => setSelectedIds(new Set());

  const handleApply = async () => {
    if (selectedCount === 0 || !shell.trim() || applying) return;
    setApplying(true);
    try {
      await batchUpdateProjectShell(Array.from(selectedIds), shell);
      toast.success(t("sidebar.toast.batchShellSuccess", { count: selectedCount }));
      onClose();
    } catch (err) {
      toast.error(t("sidebar.toast.batchShellFailed"), { description: String(err) });
      setApplying(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !applying) onClose();
      }}
    >
      <DialogContent className="max-w-[560px] p-0" showCloseButton={!applying}>
        <div className="border-b border-border/70 px-5 py-4">
          <DialogTitle>{t("batchShell.title")}</DialogTitle>
          <DialogDescription className="mt-1">{t("batchShell.description")}</DialogDescription>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
          <div className="text-sm text-on-surface-variant">
            {t("batchShell.selectedSummary", { count: selectedCount })}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={applying || projects.length === 0} onClick={selectAll}>
              {t("batchShell.selectAll")}
            </Button>
            <Button variant="ghost" size="sm" disabled={applying || projects.length === 0} onClick={clearAll}>
              {t("batchShell.clearAll")}
            </Button>
          </div>
        </div>

        <div className="max-h-[400px] overflow-y-auto px-3 py-3">
          <div className="space-y-4">
            {sections.map((section) => (
              <section key={section.key} className="space-y-1">
                <div className="px-3 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                  {section.name}
                </div>
                <div className="space-y-1">
                  {section.projects.map((project) => (
                    <label
                      key={project.id}
                      className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-surface-container-highest/70"
                    >
                      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(project.id)}
                          disabled={applying}
                          onChange={() => toggle(project.id)}
                          className="peer h-5 w-5 appearance-none rounded border border-border bg-surface-container-lowest transition-colors checked:border-[var(--color-primary)] checked:bg-[var(--color-primary)] disabled:opacity-60"
                          aria-label={t("batchShell.selectProjectAria", { name: project.name })}
                        />
                        <Check
                          size={13}
                          strokeWidth={2.4}
                          className="pointer-events-none absolute text-white opacity-0 transition-opacity peer-checked:opacity-100"
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-on-surface">{project.name}</span>
                        <span className="mt-0.5 block truncate text-xs text-on-surface-variant" title={project.environment_type === "ssh" ? project.remote_path : project.path}>
                          {project.environment_type === "ssh" ? project.remote_path : project.path}
                        </span>
                      </span>
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-on-surface-variant ring-1 ring-border/70">
                        {shellLabelFor(project.shell)}
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>

        <DialogFooter className="border-t border-border/70 px-5 py-4">
          <div className="mr-auto flex items-center gap-2">
            <label htmlFor={shellFieldId} className="shrink-0 text-xs text-on-surface-variant">
              {t("batchShell.shellLabel")}
            </label>
            <Select
              id={shellFieldId}
              value={shell}
              disabled={applying}
              onChange={(e) => setShell(e.target.value)}
              className="w-40 text-sm"
            >
              {shellOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </Select>
          </div>
          <Button variant="outline" disabled={applying} onClick={onClose}>
            {t("batchShell.cancel")}
          </Button>
          <Button
            variant="default"
            disabled={applying || selectedCount === 0 || !shell.trim()}
            onClick={() => void handleApply()}
          >
            {applying ? t("batchShell.applying") : t("batchShell.apply", { count: selectedCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
