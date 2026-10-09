import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConflictPaneLayout } from '../../src/features/projects/components/conflicts/ConflictPaneLayout';
import { DEFAULT_CONFLICT_COLUMNS } from '../../src/features/projects/lib/conflictColumnLayout';
import { zh } from '../../src/shared/i18n/messages/projects.zh-CN';
import { en } from '../../src/shared/i18n/messages/projects.en-US';

const state = { mounts: 0, unmounts: 0, commits: 0, sizes: DEFAULT_CONFLICT_COLUMNS };

// A stable editable child detects remounts without loading Monaco, Tauri or a service.
function Pane({ name }: { name: string }) {
  useEffect(() => { state.mounts++; return () => { state.unmounts++; }; }, []);
  return <section className="conflict-code-pane">
    <header className="conflict-code-heading">
      <div className="conflict-code-caption"><span title={name}>{name}</span>
        <code>feature/a-very-long-branch-name-that-must-not-push-the-next-column</code><small>Read only / 只读</small>
      </div>
      <button className="conflict-accept-arrow"><span>引入</span>→</button>
    </header>
    <div className="conflict-result-actions"><span className="conflict-result-status">尚未选择 / Not chosen</span>
      <div className="conflict-result-choices"><button className="ui-btn">接受左侧 / Accept left</button><button className="ui-btn">接受右侧 / Accept right</button></div>
    </div>
    <input aria-label={name} defaultValue="preserved draft" style={{ minWidth: 0, width: '100%', boxSizing: 'border-box' }} />
    <pre style={{ overflow: 'auto', minWidth: 0 }}>{'long-code-line-'.repeat(100)}</pre>
  </section>;
}

function Fixture() {
  const [width, setWidth] = useState(1000);
  const [zoom, setZoom] = useState(1);
  const [shown, setShown] = useState(true);
  const [mounted, setMounted] = useState(true);
  const [language, setLanguage] = useState<'zh-CN' | 'en-US'>('zh-CN');
  const [sizes, setSizes] = useState(DEFAULT_CONFLICT_COLUMNS);
  const messages = language === 'zh-CN' ? zh : en;
  Object.assign(window, { conflictLayoutTest: { state, setWidth, setZoom, setShown, setMounted, setLanguage } });
  return <div style={{ width, zoom }}>
    <section className="conflict-workspace" style={{ display: shown ? 'flex' : 'none', height: 650, flexDirection: 'column' }}>
      <header className="conflict-workspace-header">Conflict workspace / 解决冲突</header>
      <div className="conflict-file-toolbar"><span>Previous / Next</span><span>Accept target / Accept Worktree</span></div>
      <div className="conflict-workspace-body" style={{ display: 'grid', flex: 1, minHeight: 0 }}>
        <aside style={{ minWidth: 0 }}>Files / 冲突文件</aside>
        <div className="conflict-merge-grid-scroll">
          {mounted && <ConflictPaneLayout sizes={sizes} chosen={false}
            onSizesChange={(value) => { state.commits++; state.sizes = value; setSizes(value); }}
            labels={[messages['worktree.conflict.resizeBaseResult'], messages['worktree.conflict.resizeResultWorktree']]}
            resizeHint={messages['worktree.conflict.resizeHint']}>
            <Pane name="Target branch / 目标分支" /><Pane name="Merge result / 合并结果" /><Pane name="Worktree / 当前分支" />
          </ConflictPaneLayout>}
        </div>
      </div>
    </section>
  </div>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
