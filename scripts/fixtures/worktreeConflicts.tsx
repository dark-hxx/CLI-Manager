// Real React/UI/i18n; only the native Git transport is replaced. Never changes a repository.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorktreeConflictWorkspace } from '../../src/features/projects/components/conflicts/WorktreeConflictWorkspace';
import { WorktreeConflictHost } from '../../src/features/projects/api/WorktreeConflictHost';
import { WorktreeConflictPane } from '../../src/features/projects/api/WorktreeConflictPane';
import { useTerminalStore } from '../../src/features/terminal/state';
import { WorktreeFinishDialog } from '../../src/features/projects/api/WorktreeFinishDialog';
import { useProjectStore } from '../../src/features/projects/api/projectStore';
import { useWorktreeStore } from '../../src/features/projects/api/worktreeStore';
import { useWorktreeConflictStore } from '../../src/features/projects/api/worktreeConflictStore';
import { useSettingsStore } from '../../src/shared/preferences/settingsStore';
import { createHarness, context } from './worktreeConflictHarness.mjs';
import { makeStressConflict } from './worktreeConflictStress.mjs';
import '../../src/App.css';

const query = new URLSearchParams(location.search);
const harness = createHarness({ total: Number(query.get('total') ?? 64887), blockCount: Number(query.get('blocks') ?? 4) });
if (query.has('stress')) Object.assign(harness.detail('file-0'), makeStressConflict());
const requests: { name: string; start: number; returned: number }[] = [];
window.__TAURI_INTERNALS__ = { invoke: async (name, args) => {
  if (name === 'git_worktree_recovery_probe') return { blocked: false, hasJournal: false, canConfirm: false, stateToken: null, revision: null, phase: null, stashOid: null, reason: null };
  if (name === 'git_get_changes') return [{ path: 'changed.txt', status: 'M' }];
  const start = performance.now();
  const result = await harness.invoke(name, args);
  requests.push({ name, start, returned: performance.now() });
  return result;
} };
useSettingsStore.setState({ language: 'en-US' });
const target = { project: { id: 'project', path: context.projectPath, name: 'Project' },
  worktree: { id: 'worktree', project_id: 'project', name: 'Feature', path: context.worktreePath, branch: context.worktreeBranch, base_branch: context.baseBranch },
  step: 'merge', message: 'original commit message', focus: null };
const longTasks: number[] = [];
useProjectStore.setState({ projects: [target.project] });
useWorktreeStore.setState({ worktrees: [target.worktree] });
new PerformanceObserver((list) => { longTasks.push(...list.getEntries().map((item) => item.duration)); }).observe({ type: 'longtask', buffered: true });
// Exercise the native session model without allocating a real terminal in the fixture.
function FixtureTabs() {
  const sessions = useTerminalStore((state) => state.sessions);
  const activeId = useTerminalStore((state) => state.activeSessionId);
  return <div className="flex min-h-0 flex-1 flex-col">
    <div role="tablist">{sessions.map((session) => <span key={session.id}>
      <button role="tab" aria-selected={activeId === session.id} onClick={() => useTerminalStore.getState().setActive(session.id)}>{session.title}</button>
      <button aria-label="Close conflict tab" onClick={() => { void useTerminalStore.getState().closeSession(session.id); }}>×</button>
    </span>)}</div>
    {sessions.filter((session) => session.kind === 'worktree-conflict').map((session) => <div key={session.id} className="min-h-0 flex-1" style={{ display: activeId === session.id ? 'flex' : 'none' }}>
      <WorktreeConflictPane sessionId={session.id} />
    </div>)}
  </div>;
}
function Fixture() {
  const [open, setOpen] = useState(false);
  const [returns, setReturns] = useState(0);
  const [compact, setCompact] = useState(false);
  const hosted = query.has('host');
  window.__conflictTest = { harness, longTasks, requests, language: (language: string) => useSettingsStore.setState({ language }),
    monaco: () => import('monaco-editor'),
    open: () => setOpen(true), close: () => setOpen(false), returns, compact: () => setCompact(true),
    host: () => useWorktreeConflictStore.getState(), removeProject: () => useProjectStore.setState({ projects: [] }) };
  return <main id="main-content" tabIndex={-1} className="flex h-screen min-h-0 flex-col">
    {!compact && <button id="open-conflicts" onClick={() => setOpen(true)}>Open conflict workspace</button>}
    {hosted ? <>
      <FixtureTabs />
      {open && <WorktreeFinishDialog open project={target.project} worktree={target.worktree} onClose={() => setOpen(false)} />}
      <WorktreeConflictHost />
    </> : open && <WorktreeConflictWorkspace target={target} sessionId="fixture-conflict" onTabClosed={() => setOpen(false)} onReturn={() => { setReturns((count) => count + 1); setOpen(false); }} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
