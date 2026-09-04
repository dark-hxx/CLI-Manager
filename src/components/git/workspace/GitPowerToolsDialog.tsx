import { openUrl } from "@tauri-apps/plugin-opener";
import { Archive, Boxes, FileClock, GitCompareArrows, GitFork, Network, RefreshCw, SearchCode, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { GitTransport } from "../../../lib/gitTransport";
import type {
  GitBisectStatus,
  GitBlameLine,
  GitBranchInfo,
  GitBranchStatus,
  GitCommitSummary,
  GitFileHistoryEntry,
  GitReflogEntry,
  GitRemoteInfo,
  GitRewriteAction,
  GitRewriteStep,
  GitStashInfo,
  GitSubmoduleInfo,
  GitTagInfo,
} from "../../../lib/types";
import { useI18n } from "../../../lib/i18n";
import { TERM, EmptyHint, panelColorTint } from "../../stats/termStatsUi";

type ToolTab = "stash" | "remotes" | "reflog" | "file" | "rewrite" | "bisect" | "submodules";

interface GitPowerToolsDialogProps {
  open: boolean;
  transport: GitTransport | null;
  repositoryId: string | null;
  branches: GitBranchInfo[];
  tags: GitTagInfo[];
  commits: GitCommitSummary[];
  branchStatus: GitBranchStatus | null;
  onClose: () => void;
  onChanged: () => void;
}

const buttonClass = "ui-focus-ring rounded-sm border px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40";
const inputClass = "rounded-sm border bg-transparent px-2 py-1.5 text-[11px] outline-none";

function remoteWebUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return value;
    if (parsed.protocol === "ssh:") return `https://${parsed.hostname}${parsed.pathname.replace(/\.git$/, "")}`;
  } catch {
    const match = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/.exec(value);
    if (match) return `https://${match[1]}/${match[2].replace(/^\//, "").replace(/\.git$/, "")}`;
  }
  return null;
}

export function GitPowerToolsDialog({ open, transport, repositoryId, branches, tags, commits, branchStatus, onClose, onChanged }: GitPowerToolsDialogProps) {
  const { language, t } = useI18n();
  const [tab, setTab] = useState<ToolTab>("stash");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stashes, setStashes] = useState<GitStashInfo[]>([]);
  const [remotes, setRemotes] = useState<GitRemoteInfo[]>([]);
  const [reflog, setReflog] = useState<GitReflogEntry[]>([]);
  const [fileHistory, setFileHistory] = useState<GitFileHistoryEntry[]>([]);
  const [blame, setBlame] = useState<GitBlameLine[]>([]);
  const [submodules, setSubmodules] = useState<GitSubmoduleInfo[]>([]);
  const [bisect, setBisect] = useState<GitBisectStatus>({ active: false, summary: "" });
  const [stashMessage, setStashMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [remoteName, setRemoteName] = useState("origin");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [filePath, setFilePath] = useState("");
  const [fileMode, setFileMode] = useState<"history" | "blame">("history");
  const [restoreBranch, setRestoreBranch] = useState("");
  const [rewriteCount, setRewriteCount] = useState(2);
  const [rewriteSteps, setRewriteSteps] = useState<GitRewriteStep[]>([]);
  const [bisectGood, setBisectGood] = useState("");
  const [bisectBad, setBisectBad] = useState("HEAD");
  const [remoteBranch, setRemoteBranch] = useState("");

  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-US", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), [language]);
  const canRewrite = commits.length > rewriteCount;

  const reload = useCallback(async () => {
    if (!open || !transport || repositoryId === null) return;
    setLoading(true);
    setError(null);
    try {
      if (tab === "stash") setStashes((await transport.listStashes(repositoryId)).value);
      if (tab === "remotes") setRemotes((await transport.listRemotes(repositoryId)).value);
      if (tab === "reflog") setReflog((await transport.listReflog(repositoryId)).value);
      if (tab === "bisect") setBisect((await transport.getBisectStatus(repositoryId)).value);
      if (tab === "submodules") setSubmodules((await transport.listSubmodules(repositoryId)).value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [open, repositoryId, tab, transport]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const selected = commits.slice(0, Math.max(0, rewriteCount)).reverse();
    setRewriteSteps(selected.map((commit) => ({ action: "pick", commitId: commit.id, message: commit.title })));
  }, [commits, rewriteCount]);

  const mutate = useCallback(async (operation: () => Promise<unknown>, confirmKey?: string) => {
    if (busy) return;
    if (confirmKey && !window.confirm(t(confirmKey as Parameters<typeof t>[0]))) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
      toast.success(t("git.tools.operationDone"));
      onChanged();
      await reload();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast.error(t("git.tools.operationFailed"), { description: message });
    } finally {
      setBusy(false);
    }
  }, [busy, onChanged, reload, t]);

  const loadFileData = useCallback(async (mode: "history" | "blame") => {
    if (!transport || repositoryId === null || !filePath.trim()) return;
    setLoading(true); setError(null); setFileMode(mode);
    try {
      if (mode === "history") setFileHistory((await transport.fileHistory(repositoryId, filePath.trim())).value);
      else setBlame((await transport.blameFile(repositoryId, filePath.trim())).value);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, [filePath, repositoryId, transport]);

  if (!open) return null;
  const tabs: { id: ToolTab; icon: React.ReactNode; label: string }[] = [
    { id: "stash", icon: <Archive size={13} />, label: t("git.tools.stash") },
    { id: "remotes", icon: <Network size={13} />, label: t("git.tools.remotes") },
    { id: "reflog", icon: <FileClock size={13} />, label: t("git.tools.reflog") },
    { id: "file", icon: <SearchCode size={13} />, label: t("git.tools.file") },
    { id: "rewrite", icon: <GitCompareArrows size={13} />, label: t("git.tools.rewrite") },
    { id: "bisect", icon: <GitFork size={13} />, label: t("git.tools.bisect") },
    { id: "submodules", icon: <Boxes size={13} />, label: t("git.tools.submodules") },
  ];
  const remoteNames = remotes.map((remote) => remote.name);

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/65 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="flex h-[min(760px,86vh)] w-[min(1040px,94vw)] min-h-0 overflow-hidden rounded-md border shadow-2xl" style={{ backgroundColor: TERM.bg, borderColor: TERM.border }} aria-label={t("git.tools.title")}>
        <nav className="w-44 shrink-0 border-r p-2" style={{ borderColor: TERM.border, backgroundColor: TERM.card }}>
          <div className="mb-2 px-2 py-1 text-[11px] font-semibold" style={{ color: TERM.fg }}>{t("git.tools.title")}</div>
          {tabs.map((item) => <button key={item.id} type="button" className="ui-focus-ring flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-[11px]" style={{ color: tab === item.id ? TERM.cyan : TERM.fg, backgroundColor: tab === item.id ? panelColorTint(TERM.cyan, 10) : "transparent" }} onClick={() => setTab(item.id)}>{item.icon}<span>{item.label}</span></button>)}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-10 shrink-0 items-center border-b px-3" style={{ borderColor: TERM.border }}>
            <h2 className="text-xs font-semibold" style={{ color: TERM.fg }}>{tabs.find((item) => item.id === tab)?.label}</h2>
            <button type="button" className="ui-focus-ring ml-auto rounded p-1.5" style={{ color: TERM.dim }} onClick={() => void reload()} title={t("common.refresh")}><RefreshCw size={13} className={loading ? "animate-spin" : ""} /></button>
            <button type="button" className="ui-focus-ring rounded p-1.5" style={{ color: TERM.dim }} onClick={onClose} title={t("common.close")}><X size={14} /></button>
          </header>
          {error && <div className="border-b px-3 py-2 text-[11px]" style={{ color: TERM.red, borderColor: panelColorTint(TERM.red, 35), backgroundColor: panelColorTint(TERM.red, 8) }}>{error}</div>}
          <div className="ui-thin-scroll min-h-0 flex-1 overflow-auto p-3 text-[11px]">
            {tab === "stash" && <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2"><input className={`${inputClass} min-w-64 flex-1`} style={{ color: TERM.fg, borderColor: TERM.border }} value={stashMessage} onChange={(event) => setStashMessage(event.currentTarget.value)} placeholder={t("git.stash.messagePlaceholder")} /><label className="flex items-center gap-1.5" style={{ color: TERM.dim }}><input type="checkbox" checked={includeUntracked} onChange={(event) => setIncludeUntracked(event.currentTarget.checked)} />{t("git.stash.includeUntracked")}</label><button className={buttonClass} style={{ color: TERM.green, borderColor: panelColorTint(TERM.green, 40) }} disabled={busy || !transport || repositoryId === null} onClick={() => void mutate(() => transport!.createStash(repositoryId!, stashMessage, includeUntracked))}>{t("git.stash.create")}</button></div>
              {stashes.length === 0 ? <EmptyHint text={loading ? t("common.loading") : t("git.stash.empty")} /> : stashes.map((stash) => <div key={stash.selector} className="flex items-center gap-2 border-b py-2" style={{ borderColor: panelColorTint(TERM.border, 65) }}><span className="font-mono" style={{ color: TERM.yellow }}>{stash.selector}</span><span className="min-w-0 flex-1 truncate" title={stash.message}>{stash.message}</span><span style={{ color: TERM.dim }}>{dateFormatter.format(new Date(stash.createdAt))}</span><button className={buttonClass} style={{ borderColor: TERM.border }} onClick={() => void mutate(() => transport!.stashAction(repositoryId!, "apply", stash.selector))}>{t("git.stash.apply")}</button><button className={buttonClass} style={{ borderColor: TERM.border }} onClick={() => void mutate(() => transport!.stashAction(repositoryId!, "pop", stash.selector), "git.stash.popConfirm")}>{t("git.stash.pop")}</button><button className={buttonClass} style={{ color: TERM.red, borderColor: panelColorTint(TERM.red, 40) }} onClick={() => void mutate(() => transport!.stashAction(repositoryId!, "drop", stash.selector), "git.stash.dropConfirm")}>{t("common.delete")}</button></div>)}
            </div>}

            {tab === "remotes" && <div className="space-y-3">
              <div className="grid grid-cols-[140px_minmax(240px,1fr)_auto] gap-2"><input className={inputClass} style={{ color: TERM.fg, borderColor: TERM.border }} value={remoteName} onChange={(event) => setRemoteName(event.currentTarget.value)} placeholder={t("git.remote.name")} /><input className={inputClass} style={{ color: TERM.fg, borderColor: TERM.border }} value={remoteUrl} onChange={(event) => setRemoteUrl(event.currentTarget.value)} placeholder={t("git.remote.url")} /><button className={buttonClass} style={{ color: TERM.green, borderColor: panelColorTint(TERM.green, 40) }} disabled={!remoteName.trim() || !remoteUrl.trim()} onClick={() => void mutate(() => transport!.remoteAction(repositoryId!, "add", remoteName.trim(), remoteUrl.trim()))}>{t("common.add")}</button></div>
              {remotes.map((remote) => <div key={remote.name} className="border-b py-2" style={{ borderColor: panelColorTint(TERM.border, 65) }}><div className="flex items-center gap-2"><strong style={{ color: TERM.cyan }}>{remote.name}</strong><code className="min-w-0 flex-1 truncate" title={remote.fetchUrl}>{remote.fetchUrl}</code>{remoteWebUrl(remote.fetchUrl) && <button className={buttonClass} style={{ borderColor: TERM.border }} onClick={() => void openUrl(remoteWebUrl(remote.fetchUrl)!)}>{t("git.remote.open")}</button>}<button className={buttonClass} style={{ borderColor: TERM.border }} onClick={() => void mutate(() => transport!.remoteAction(repositoryId!, "fetch", remote.name))}>{t("git.branch.fetch")}</button><button className={buttonClass} style={{ borderColor: TERM.border }} onClick={() => { const value=window.prompt(t("git.remote.url"),remote.fetchUrl); if(value)void mutate(()=>transport!.remoteAction(repositoryId!,"set-url",remote.name,value)); }}>{t("git.remote.editUrl")}</button><button className={buttonClass} style={{ borderColor: TERM.border }} onClick={() => { const value=window.prompt(t("git.remote.name"),remote.name); if(value&&value!==remote.name)void mutate(()=>transport!.remoteAction(repositoryId!,"rename",remote.name,value)); }}>{t("git.remote.rename")}</button><button className={buttonClass} style={{ color: TERM.red, borderColor: panelColorTint(TERM.red,40) }} onClick={() => void mutate(() => transport!.remoteAction(repositoryId!, "remove", remote.name), "git.remote.removeConfirm")}>{t("common.delete")}</button></div></div>)}
              <div className="flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: TERM.border }}><select className={inputClass} style={{ color: TERM.fg, borderColor: TERM.border, backgroundColor: TERM.bg }} value={remoteName} onChange={(event)=>setRemoteName(event.currentTarget.value)}>{remoteNames.map((name)=><option key={name}>{name}</option>)}</select><select className={`${inputClass} min-w-48`} style={{ color: TERM.fg, borderColor: TERM.border, backgroundColor: TERM.bg }} value={remoteBranch} onChange={(event)=>setRemoteBranch(event.currentTarget.value)}><option value="">{t("git.remote.selectBranch")}</option>{branches.map((branch)=><option key={branch.name} value={branch.branchType === "remote" ? branch.name.split("/").slice(1).join("/") : branch.name}>{branch.name}</option>)}</select><button className={buttonClass} style={{ color: TERM.red, borderColor: panelColorTint(TERM.red,40) }} disabled={!remoteBranch} onClick={()=>void mutate(()=>transport!.deleteRemoteBranch(repositoryId!,remoteName,remoteBranch),"git.remote.deleteBranchConfirm")}>{t("git.remote.deleteBranch")}</button><button className={buttonClass} style={{ color: TERM.red, borderColor: panelColorTint(TERM.red,40) }} disabled={!branchStatus?.branch} onClick={()=>void mutate(()=>transport!.forcePushWithLease(repositoryId!,remoteName,branchStatus!.branch!),"git.remote.forceLeaseConfirm")}>{t("git.remote.forceLease")}</button></div>
            </div>}

            {tab === "reflog" && <div className="space-y-1">{reflog.length === 0 ? <EmptyHint text={loading?t("common.loading"):t("git.reflog.empty")} /> : reflog.map((entry)=><div key={`${entry.selector}:${entry.oid}`} className="grid grid-cols-[100px_90px_minmax(180px,1fr)_150px_auto] items-center gap-2 border-b py-2" style={{borderColor:panelColorTint(TERM.border,65)}}><code style={{color:TERM.yellow}}>{entry.selector}</code><code>{entry.shortId}</code><span className="truncate" title={entry.message}>{entry.action}: {entry.message}</span><span style={{color:TERM.dim}}>{dateFormatter.format(new Date(entry.authoredAt))}</span><button className={buttonClass} style={{borderColor:TERM.border}} onClick={()=>{const name=window.prompt(t("git.reflog.branchName"),restoreBranch||`recovery-${entry.shortId}`);if(name){setRestoreBranch(name);void mutate(()=>transport!.restoreReflog(repositoryId!,entry.selector,name));}}}>{t("git.reflog.restore")}</button></div>)}</div>}

            {tab === "file" && <div className="space-y-3"><div className="flex gap-2"><input className={`${inputClass} min-w-64 flex-1`} style={{color:TERM.fg,borderColor:TERM.border}} value={filePath} onChange={(event)=>setFilePath(event.currentTarget.value)} placeholder={t("git.file.pathPlaceholder")} /><button className={buttonClass} style={{borderColor:TERM.border}} onClick={()=>void loadFileData("history")}>{t("git.file.history")}</button><button className={buttonClass} style={{borderColor:TERM.border}} onClick={()=>void loadFileData("blame")}>{t("git.file.blame")}</button></div>{fileMode==="history"?(fileHistory.length===0?<EmptyHint text={t("git.file.empty")} />:<div>{fileHistory.map((entry)=><div key={entry.id} className="grid grid-cols-[90px_minmax(180px,1fr)_130px_150px] gap-2 border-b py-2" style={{borderColor:panelColorTint(TERM.border,65)}}><code>{entry.shortId}</code><span className="truncate">{entry.title}</span><span className="truncate">{entry.author}</span><span style={{color:TERM.dim}}>{dateFormatter.format(new Date(entry.authoredAt))}</span></div>)}</div>):(blame.length===0?<EmptyHint text={t("git.file.empty")} />:<pre className="min-w-max text-[10px] leading-5">{blame.map((line)=><div key={line.lineNumber} className="grid grid-cols-[50px_80px_120px_minmax(300px,1fr)] gap-2"><span style={{color:TERM.dim}}>{line.lineNumber}</span><code>{line.commitId.slice(0,8)}</code><span className="truncate">{line.author}</span><code>{line.content}</code></div>)}</pre>)}</div>}

            {tab === "rewrite" && <div className="space-y-3"><div className="flex items-center gap-2"><label style={{color:TERM.dim}}>{t("git.rewrite.lastCommits")}</label><input type="number" min={2} max={Math.min(20,Math.max(2,commits.length-1))} value={rewriteCount} onChange={(event)=>setRewriteCount(Math.max(2,Number(event.currentTarget.value)||2))} className={`${inputClass} w-20`} style={{color:TERM.fg,borderColor:TERM.border}} /><span style={{color:TERM.dim}}>{canRewrite?t("git.rewrite.base",{commit:commits[rewriteCount]?.shortId??""}):t("git.rewrite.needMore")}</span></div>{rewriteSteps.map((step,index)=><div key={step.commitId} className="grid grid-cols-[110px_90px_minmax(240px,1fr)] items-center gap-2"><select className={inputClass} style={{color:TERM.fg,borderColor:TERM.border,backgroundColor:TERM.bg}} value={step.action} onChange={(event)=>setRewriteSteps((current)=>current.map((item,itemIndex)=>itemIndex===index?{...item,action:event.currentTarget.value as GitRewriteAction}:item))}>{(["pick","reword","squash","fixup","drop"] as const).map((action)=><option key={action}>{action}</option>)}</select><code>{step.commitId.slice(0,8)}</code><input className={inputClass} style={{color:TERM.fg,borderColor:TERM.border}} value={step.message} disabled={step.action!=="reword"&&step.action!=="squash"} onChange={(event)=>setRewriteSteps((current)=>current.map((item,itemIndex)=>itemIndex===index?{...item,message:event.currentTarget.value}:item))} /></div>)}<button className={buttonClass} style={{color:TERM.red,borderColor:panelColorTint(TERM.red,40)}} disabled={!canRewrite||busy} onClick={()=>void mutate(()=>transport!.rewriteCommits(repositoryId!,commits[rewriteCount].id,rewriteSteps),"git.rewrite.confirm")}>{t("git.rewrite.execute")}</button></div>}

            {tab === "bisect" && <div className="space-y-3"><div className="rounded-sm border p-3" style={{borderColor:TERM.border,color:bisect.active?TERM.yellow:TERM.dim}}>{bisect.active?t("git.bisect.active"):t("git.bisect.inactive")}</div>{!bisect.active?<div className="flex gap-2"><input className={`${inputClass} flex-1`} style={{color:TERM.fg,borderColor:TERM.border}} value={bisectGood} onChange={(event)=>setBisectGood(event.currentTarget.value)} placeholder={t("git.bisect.goodRef")} /><input className={`${inputClass} flex-1`} style={{color:TERM.fg,borderColor:TERM.border}} value={bisectBad} onChange={(event)=>setBisectBad(event.currentTarget.value)} placeholder={t("git.bisect.badRef")} /><button className={buttonClass} style={{color:TERM.green,borderColor:panelColorTint(TERM.green,40)}} onClick={()=>void mutate(()=>transport!.bisectAction(repositoryId!,"start",bisectGood,bisectBad),"git.bisect.startConfirm")}>{t("git.bisect.start")}</button></div>:<div className="flex gap-2"><button className={buttonClass} style={{borderColor:TERM.border}} onClick={()=>void mutate(()=>transport!.bisectAction(repositoryId!,"good"))}>{t("git.bisect.markGood")}</button><button className={buttonClass} style={{borderColor:TERM.border}} onClick={()=>void mutate(()=>transport!.bisectAction(repositoryId!,"bad"))}>{t("git.bisect.markBad")}</button><button className={buttonClass} style={{borderColor:TERM.border}} onClick={()=>void mutate(()=>transport!.bisectAction(repositoryId!,"skip"))}>{t("git.bisect.skip")}</button><button className={buttonClass} style={{color:TERM.red,borderColor:panelColorTint(TERM.red,40)}} onClick={()=>void mutate(()=>transport!.bisectAction(repositoryId!,"reset"),"git.bisect.resetConfirm")}>{t("git.bisect.reset")}</button></div>}<pre className="whitespace-pre-wrap text-[10px]" style={{color:TERM.dim}}>{bisect.summary}</pre></div>}

            {tab === "submodules" && <div className="space-y-3"><div className="flex gap-2"><button className={buttonClass} style={{borderColor:TERM.border}} onClick={()=>void mutate(()=>transport!.submoduleAction(repositoryId!,"init"))}>{t("git.submodule.init")}</button><button className={buttonClass} style={{borderColor:TERM.border}} onClick={()=>void mutate(()=>transport!.submoduleAction(repositoryId!,"update"))}>{t("git.submodule.update")}</button><button className={buttonClass} style={{borderColor:TERM.border}} onClick={()=>void mutate(()=>transport!.submoduleAction(repositoryId!,"sync"))}>{t("git.submodule.sync")}</button></div>{submodules.length===0?<EmptyHint text={loading?t("common.loading"):t("git.submodule.empty")} />:submodules.map((module)=><div key={module.path} className="grid grid-cols-[140px_minmax(160px,1fr)_110px_auto] items-center gap-2 border-b py-2" style={{borderColor:panelColorTint(TERM.border,65)}}><strong>{module.name}</strong><span className="truncate" title={module.path}>{module.path}</span><code>{module.commitId.slice(0,8)||module.status}</code><button className={buttonClass} style={{borderColor:TERM.border}} onClick={()=>void mutate(()=>transport!.submoduleAction(repositoryId!,"update",module.path))}>{t("git.submodule.update")}</button></div>)}</div>}
          </div>
          <footer className="flex h-10 shrink-0 items-center border-t px-3 text-[10px]" style={{borderColor:TERM.border,color:TERM.dim}}><span>{t("git.tools.safetyHint")}</span><span className="ml-auto">{tags.length} {t("git.workspace.tags")} · {branches.length} {t("git.workspace.branches")}</span></footer>
        </div>
      </section>
    </div>
  );
}
