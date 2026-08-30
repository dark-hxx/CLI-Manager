import { useEffect, useId, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { Input } from "../ui/input";
import { Check } from "../icons";
import { FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { useProjectStore } from "../../stores/projectStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useI18n } from "../../lib/i18n";
import { getOsPlatform, normalizeShellKey, type OsPlatform } from "../../lib/shell";
import { getEnabledTerminalShellOptions, resolvePreferredShellOption } from "../../lib/terminalShellProfiles";
import { getShellOptions, type Group, type Project } from "../../lib/types";
import { resolveGroupBoundPath } from "../../lib/groupPath";
import { findInheritedDescendants } from "../../lib/groupPath";
import { useAppConfirm } from "../ui/useAppConfirm";
import { pathExists } from "../../lib/pathValidation";

interface Props { group: Group; groups: Group[]; projects: Project[]; onClose: () => void; }

export function GroupEditDialog({ group, groups, projects, onClose }: Props) {
  const { t } = useI18n();
  const updateGroup = useProjectStore((s) => s.updateGroup);
  const materializeInheritedDescendants = useProjectStore((s) => s.materializeInheritedDescendants);
  const batchUpdateProjectShell = useProjectStore((s) => s.batchUpdateProjectShell);
  const defaultShell = useSettingsStore((s) => s.defaultShell);
  const terminalShellProfiles = useSettingsStore((s) => s.terminalShellProfiles);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const groupIds = new Set([group.id]); let changed = true;
    while (changed) { changed = false; for (const item of groups) if (item.parent_id && groupIds.has(item.parent_id) && !groupIds.has(item.id)) { groupIds.add(item.id); changed = true; } }
    return new Set(projects.filter((p) => p.group_id && groupIds.has(p.group_id)).map((p) => p.id));
  });
  const [shell, setShell] = useState("");
  const [boundPath, setBoundPath] = useState(group.bound_path ?? "");
  const parentBoundPath = useMemo(() => resolveGroupBoundPath(groups, group.parent_id), [group.parent_id, groups]);
  const isRootGroup = group.parent_id === null;
  const [boundPathMode, setBoundPathMode] = useState<"inherit" | "custom">(
    isRootGroup || Boolean(group.bound_path?.trim()) ? "custom" : "inherit"
  );
  const [osPlatform, setOsPlatform] = useState<OsPlatform>("unknown");
  const [applying, setApplying] = useState(false);
  const { confirm, confirmDialog } = useAppConfirm({ zIndex: 240 });
  const shellFieldId = useId();

  useEffect(() => { let cancelled = false; void getOsPlatform().then((platform) => { if (cancelled) return; setOsPlatform(platform); setShell(resolvePreferredShellOption(platform, defaultShell, terminalShellProfiles)); }); return () => { cancelled = true; }; }, [defaultShell, terminalShellProfiles]);
  const shellOptions = useMemo(() => getEnabledTerminalShellOptions(osPlatform, terminalShellProfiles), [osPlatform, terminalShellProfiles]);
  const shellLabelFor = useMemo(() => { const options = getShellOptions(osPlatform); return (value: string) => options.find((opt) => opt.value === normalizeShellKey(value))?.label ?? value; }, [osPlatform]);
  const sections = useMemo(() => {
    const known = new Set(groups.map((g) => g.id)); const byGroup = new Map<string | null, Project[]>();
    for (const project of projects) { const key = project.group_id && known.has(project.group_id) ? project.group_id : null; byGroup.set(key, [...(byGroup.get(key) ?? []), project]); }
    const result = groups.flatMap((g) => { const list = byGroup.get(g.id); return list?.length ? [{ key: g.id, name: g.name, projects: list }] : []; });
    const ungrouped = byGroup.get(null);
    if (ungrouped?.length) result.push({ key: "__ungrouped__", name: t("batchShell.ungrouped"), projects: ungrouped });
    return result;
  }, [groups, projects, t]);
  const toggle = (id: string) => setSelectedIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const handleBrowse = async () => { const selected = await open({ directory: true, title: t("groupEdit.chooseBoundPath") }); if (typeof selected === "string") setBoundPath(selected); };
  const effectiveBoundPath = boundPathMode === "inherit" ? parentBoundPath : boundPath;
  const updateBoundPath = { bound_path: boundPathMode === "inherit" ? "" : boundPath.trim() };
  const savePathWithCascade = async () => {
    const normalizedPath = boundPath.trim();
    if (boundPathMode === "custom" && normalizedPath) {
      if (!(await pathExists(normalizedPath))) {
        toast.error(t("groupEdit.pathValidationFailed"), { description: t("groupEdit.pathUnavailable") });
        return false;
      }
    }
    const clearingOwnBinding = boundPathMode === "custom" && !boundPath.trim() && Boolean(group.bound_path?.trim());
    if (clearingOwnBinding) {
      const descendants = findInheritedDescendants(group.id, groups, projects);
      const affectedCount = descendants.groupIds.length + descendants.projectIds.length;
      if (affectedCount > 0) {
        const accepted = await confirm({
          title: t("groupEdit.clearBindingTitle"),
          message: t("groupEdit.clearBindingMessage", { count: affectedCount, path: resolveGroupBoundPath(groups, group.id) }),
          confirmText: t("common.confirm"),
          cancelText: t("common.cancel"),
        });
        if (!accepted) return false;
        await materializeInheritedDescendants(group.id, resolveGroupBoundPath(groups, group.id));
      }
    }
    await updateGroup(group.id, updateBoundPath);
    return true;
  };
  const handleApply = async () => {
    if (selectedIds.size === 0 || !shell.trim() || applying) return; setApplying(true);
    try { if (await savePathWithCascade()) { await batchUpdateProjectShell(Array.from(selectedIds), shell); toast.success(t("groupEdit.saved")); onClose(); } else setApplying(false); }
    catch (err) { toast.error(t("groupEdit.saveFailed"), { description: String(err) }); setApplying(false); }
  };
  const handleSavePath = async () => {
    if (applying) return;
    setApplying(true);
    try { if (await savePathWithCascade()) { toast.success(t("groupEdit.saved")); onClose(); } else setApplying(false); }
    catch (err) { toast.error(t("groupEdit.saveFailed"), { description: String(err) }); setApplying(false); }
  };
  return <>
  <Dialog open onOpenChange={(next) => { if (!next && !applying) onClose(); }}>
    <DialogContent className="max-w-[560px] p-0" showCloseButton={!applying}>
      <div className="border-b border-border/70 px-5 py-4"><DialogTitle>{t("groupEdit.title", { name: group.name })}</DialogTitle><DialogDescription className="mt-1">{t("groupEdit.description")}</DialogDescription></div>
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3"><div className="text-sm text-on-surface-variant">{t("batchShell.selectedSummary", { count: selectedIds.size })}</div><div className="flex items-center gap-2"><Button variant="ghost" size="sm" disabled={applying || projects.length === 0} onClick={() => setSelectedIds(new Set(projects.map((p) => p.id)))}>{t("batchShell.selectAll")}</Button><Button variant="ghost" size="sm" disabled={applying || projects.length === 0} onClick={() => setSelectedIds(new Set())}>{t("batchShell.clearAll")}</Button></div></div>
      <div className="max-h-[340px] overflow-y-auto px-3 py-3"><div className="space-y-4">{sections.map((section) => <section key={section.key} className="space-y-1"><div className="px-3 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">{section.name}</div><div className="space-y-1">{section.projects.map((project) => <label key={project.id} className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-surface-container-highest/70"><span className="relative flex h-5 w-5 shrink-0 items-center justify-center"><input type="checkbox" checked={selectedIds.has(project.id)} disabled={applying} onChange={() => toggle(project.id)} className="peer h-5 w-5 appearance-none rounded border border-border bg-surface-container-lowest transition-colors checked:border-[var(--color-primary)] checked:bg-[var(--color-primary)] disabled:opacity-60" aria-label={t("batchShell.selectProjectAria", { name: project.name })} /><Check size={13} strokeWidth={2.4} className="pointer-events-none absolute text-white opacity-0 transition-opacity peer-checked:opacity-100" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-on-surface">{project.name}</span><span className="mt-0.5 block truncate text-xs text-on-surface-variant" title={project.path}>{project.path}</span></span><span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-on-surface-variant ring-1 ring-border/70">{shellLabelFor(project.shell)}</span></label>)}</div></section>)}</div></div>
      <div className="border-t border-border/60 px-5 py-3"><label className="ui-config-form-label">{t("groupEdit.boundPath")}</label><div className="flex items-center gap-2">{!isRootGroup && <Select value={boundPathMode} onChange={(e) => setBoundPathMode(e.target.value as "inherit" | "custom")} disabled={applying} className="w-32 shrink-0 text-sm"><option value="inherit">{t("groupEdit.inherit")}</option><option value="custom">{t("configModal.pathMode.custom")}</option></Select>}<div className="relative min-w-0 flex-1"><Input value={effectiveBoundPath} onChange={(e) => setBoundPath(e.target.value)} disabled={applying || boundPathMode === "inherit"} placeholder={t("groupEdit.boundPathPlaceholder")} className="pr-10 text-sm" /><button type="button" className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-text-muted hover:text-primary disabled:opacity-50" onClick={() => void handleBrowse()} disabled={applying || boundPathMode === "inherit"} aria-label={t("groupEdit.chooseBoundPath")} title={t("groupEdit.chooseBoundPath")}><FolderOpen className="h-4 w-4" /></button></div></div></div>
      <DialogFooter className="border-t border-border/70 px-5 py-4"><div className="mr-auto flex items-center gap-2"><label htmlFor={shellFieldId} className="shrink-0 text-xs text-on-surface-variant">{t("batchShell.shellLabel")}</label><Select id={shellFieldId} value={shell} disabled={applying} onChange={(e) => setShell(e.target.value)} className="w-40 text-sm">{shellOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}</Select></div><Button variant="outline" disabled={applying} onClick={() => void handleSavePath()}>{t("groupEdit.savePath")}</Button><Button variant="outline" disabled={applying} onClick={onClose}>{t("batchShell.cancel")}</Button><Button variant="default" disabled={applying || selectedIds.size === 0 || !shell.trim()} onClick={() => void handleApply()}>{applying ? t("batchShell.applying") : t("batchShell.apply", { count: selectedIds.size })}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
  {confirmDialog}
  </>;
}
