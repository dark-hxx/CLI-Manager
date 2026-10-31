import { spawnSync } from 'node:child_process';

const cases = [
  {
    name: 'git-5000-files-incremental-status',
    test: 'git::tests::incremental_status_handles_five_thousand_untracked_files_without_full_scan',
    marker: /5,000-file incremental status \+ merge \+ visible window: ([0-9.]+)(ns|µs|ms|s)/,
    budgetMs: 200,
  },
  {
    name: 'history-20-files-incremental-refresh',
    test: 'history::tests::incremental_history_delta_updates_twenty_files_within_ui_budget',
    marker: /20-file incremental transcript refresh: ([0-9.]+)(ns|µs|ms|s)/,
    budgetMs: 300,
  },
];

function durationMs(value, unit) {
  const number = Number(value);
  if (unit === 'ns') return number / 1_000_000;
  if (unit === 'µs') return number / 1_000;
  if (unit === 's') return number * 1_000;
  return number;
}

const results = [];
for (const item of cases) {
  const run = spawnSync(
    process.platform === 'win32' ? 'cargo.exe' : 'cargo',
    [
      'test',
      '-p',
      'cli-manager-desktop-gpui',
      item.test,
      '--',
      '--nocapture',
    ],
    { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
  );
  const output = String(run.stdout ?? '') + '\n' + String(run.stderr ?? '');
  if (run.status !== 0) {
    process.stderr.write(output);
    throw new Error(item.name + ' failed with exit code ' + run.status);
  }
  const match = output.match(item.marker);
  if (!match) {
    process.stderr.write(output);
    throw new Error(item.name + ' did not emit its benchmark marker');
  }
  const elapsedMs = durationMs(match[1], match[2]);
  results.push({
    name: item.name,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    budgetMs: item.budgetMs,
    passed: elapsedMs < item.budgetMs,
  });
}

if (results.some((result) => !result.passed)) {
  console.error(JSON.stringify({ results }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ results }, null, 2));
}
