// Runs in the production page: no test-process polling included in timings.
export async function sampleConflictUI() {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const until = async (predicate) => {
    const start = performance.now();
    while (!predicate()) { if (performance.now() - start > 10000) throw new Error('UI timeout'); await frame(); }
    await frame(); await frame();
  };
  const api = window.__conflictTest;
  api.requests.length = 0; api.longTasks.length = 0;
  document.querySelector('#open-conflicts').click();
  await until(() => document.querySelector('[data-file-index]'));
  const metadata = api.requests.find((request) => request.name.endsWith('conflict_status'));
  const metadataPaint = performance.now() - metadata.returned;
  const fileNodes = document.querySelectorAll('[data-file-index]').length;
  document.querySelector('[data-file-index]').click();
  await until(() => document.querySelectorAll('[data-conflict-pane] .monaco-editor textarea.inputarea').length === 3);
  const request = api.requests.find((item) => item.name.endsWith('conflict_file'));
  const detailPaint = performance.now() - request.start;
  const render = performance.now() - request.returned;
  // Warm samples must change state, not click the already selected choice.
  const button = [...document.querySelectorAll('.conflict-merge-toolbar [aria-pressed]')]
    .find((node) => node.getAttribute('aria-pressed') !== 'true');
  const start = performance.now(); button.click();
  await until(() => button.getAttribute('aria-pressed') === 'true');
  const choicePaint = performance.now() - start;
  const { editor } = await api.monaco();
  const panes = editor.getEditors().filter((pane) => pane.getModel()?.uri.authority === 'conflict');
  const scroll = panes.find((pane) => pane.getModel().uri.path.endsWith('/result'));
  const scrollTimes = [];
  for (const proportion of [.5, 1, 0]) {
    const before = performance.now();
    scroll.setScrollTop((scroll.getScrollHeight() - scroll.getLayoutInfo().height) * proportion);
    await frame(); await frame(); scrollTimes.push(performance.now() - before);
  }
  const rowNodes = Math.max(...[...document.querySelectorAll('[data-conflict-pane]')]
    .map((pane) => pane.querySelectorAll('.view-line').length));
  if (panes.length !== 3) throw new Error('Expected exactly three current-block editor models');
  const close = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Save and return');
  close.click(); await until(() => !document.querySelector('[data-worktree-conflict-workspace]'));
  return { metadataPaint, detailPaint, render, ipcDouble: request.returned - request.start, choicePaint,
    scrollTimes, fileNodes, rowNodes, longTasks: [...api.longTasks], peak: api.harness.controls.peak };
}

export function summarizeConflictPerformance(cold, warm) {
  const stats = (samples) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return { p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
  };
  return { ...Object.fromEntries(['metadataPaint', 'detailPaint', 'render', 'ipcDouble', 'choicePaint']
    .map((key) => [key, { cold: stats(cold.map((s) => s[key])), warm: stats(warm.map((s) => s[key])) }])),
    scroll: stats([...cold, ...warm].flatMap((s) => s.scrollTimes)) };
}
