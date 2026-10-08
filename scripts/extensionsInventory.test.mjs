import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = readFileSync(new URL('../src-tauri/src/features/extensions/inventory.rs', import.meta.url), 'utf8');
const script = source.match(/const WSL_SCAN: &str = r#"([\s\S]*?)"#;/)?.[1];
assert.ok(script, 'Execute the real embedded WSL scanner, not a reimplementation');
const python = process.platform === 'win32' ? 'python' : 'python3';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cli-manager-inventory-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function addSkill(path) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), '---\nname: fixture\n---\n');
}

function deepBranch(root, directory) {
  let path = join(root, '00-unrelated-cache');
  for (let depth = 2; depth <= 8; depth += 1) path = join(path, `level-${depth}`);
  mkdirSync(path, { recursive: true });
  if (directory) mkdirSync(join(path, 'level-9'));
  else writeFileSync(join(path, 'ordinary.txt'), 'not a Skill');
}

// 前后缀只注入文件系统竞态和 I/O 观测；始终执行产品内嵌的扫描实现。
function runScan(root, { setup = '', after = '' } = {}) {
  const child = spawnSync(python, ['-c', `${setup}\n${script}\n${after}`, root, 'claude', 'plugin'], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(child.error);
  return child;
}

function scan(root, options = {}) {
  const child = runScan(root, options);
  assert.equal(child.status, 0, child.stderr);
  const [inventory, observed] = child.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  return options.after ? { inventory, observed } : inventory;
}

// 统计真实迭代器推进和路径查询；禁止完整列表物化，并检查提前退出仍关闭句柄。
const observedSetup = `
import os
observed = dict(opens=0, next_calls=0, yielded=0, closes=0, stat_calls=0)
real_scandir, real_stat, real_lstat = os.scandir, os.stat, os.lstat
consume_before_child = False
def forbid_listdir(path):
    raise AssertionError('directory enumeration must be lazy')
def counted_stat(path, *args, **kwargs):
    observed['stat_calls'] += 1
    return real_stat(path, *args, **kwargs)
def counted_lstat(path, *args, **kwargs):
    observed['stat_calls'] += 1
    return real_lstat(path, *args, **kwargs)
class ObservedDirectory:
    def __init__(self, entries):
        self.entries = entries
    def __enter__(self):
        self.entries.__enter__()
        return self
    def __exit__(self, kind, value, traceback):
        observed['closes'] += 1
        return self.entries.__exit__(kind, value, traceback)
    def __iter__(self):
        return self
    def __next__(self):
        observed['next_calls'] += 1
        entry = next(self.entries)
        observed['yielded'] += 1
        if consume_before_child:
            globals()['examined'] = MAX_INVENTORY_PATHS - 1
        return entry
def counted_scandir(path):
    observed['opens'] += 1
    return ObservedDirectory(real_scandir(path))
os.listdir, os.scandir = forbid_listdir, counted_scandir
os.stat, os.lstat = counted_stat, counted_lstat
`;
const observedAfter = 'print(json.dumps(dict(observed, examined=examined)))';

test('ordinary deep files do not suppress shallow sibling Skills', (t) => {
  const root = fixture(t);
  deepBranch(root, false);
  addSkill(join(root, '99-valid-skill'));
  const result = scan(root);
  assert.equal(result.limited, false);
  assert.deepEqual(result.entries.map((entry) => entry.name), ['99-valid-skill']);
});

test('real depth truncation retains partial entries and its warning flag', (t) => {
  const root = fixture(t);
  deepBranch(root, true);
  addSkill(join(root, '99-valid-skill'));
  const result = scan(root);
  assert.equal(result.limited, true);
  assert.deepEqual(result.entries.map((entry) => entry.name), ['99-valid-skill']);
});

test('depth-eight Skills are included but depth-nine directories are not traversed', (t) => {
  const root = fixture(t);
  let allowed = join(root, 'allowed');
  let blocked = join(root, 'blocked');
  for (let depth = 2; depth <= 8; depth += 1) {
    allowed = join(allowed, `level-${depth}`);
    blocked = join(blocked, `level-${depth}`);
  }
  addSkill(allowed);
  addSkill(join(blocked, 'too-deep'));
  const result = scan(root);
  assert.equal(result.limited, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].path, allowed);
});

test('output remains capped at 500 entries', (t) => {
  const root = fixture(t);
  for (let index = 0; index <= 500; index += 1) {
    addSkill(join(root, `skill-${String(index).padStart(4, '0')}`));
  }
  const { inventory, observed } = scan(root, { setup: observedSetup, after: observedAfter });
  assert.equal(inventory.limited, true);
  assert.equal(inventory.entries.length, 500);
  assert.equal(observed.next_calls, 500);
  assert.equal(observed.opens, observed.closes);
});

test('path budget bounds scans even when every entry is an ordinary file', (t) => {
  const root = fixture(t);
  for (let index = 0; index < 10000; index += 1) {
    writeFileSync(join(root, `file-${index}.txt`), 'fixture');
  }
  const { inventory, observed } = scan(root, { setup: observedSetup, after: observedAfter });
  assert.equal(inventory.limited, true);
  assert.deepEqual(inventory.entries, []);
  assert.equal(observed.examined, 10000);
  assert.equal(observed.next_calls, 9999, 'Root consumes one path; do not peek at the next child');
  assert.equal(observed.yielded, 9999);
  assert.equal(observed.opens, 1);
  assert.equal(observed.closes, 1);
  assert.ok(observed.stat_calls <= 2, 'Ordinary files reuse DirEntry metadata');
});

test('an exhausted path budget does not open the last examined child directory', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'wide-directory'));
  writeFileSync(join(root, 'wide-directory', 'unexamined.txt'), 'fixture');
  // 模拟先前兄弟已消耗预算，边界目录本身仍可分类，但不可再打开它的迭代器。
  const { inventory, observed } = scan(root, {
    setup: `${observedSetup}\nconsume_before_child = True`, after: observedAfter,
  });
  assert.equal(inventory.limited, true);
  assert.equal(observed.examined, 10000);
  assert.equal(observed.next_calls, 1);
  assert.equal(observed.opens, 1);
  assert.equal(observed.closes, 1);
});

for (const kind of ['file', 'directory', 'replaced-directory']) {
  test(`a disappearing ${kind} preserves earlier and later sibling Skills`, (t) => {
    const root = fixture(t);
    addSkill(join(root, 'before'));
    addSkill(join(root, 'after'));
    if (kind === 'file') writeFileSync(join(root, 'vanishing'), 'fixture');
    else mkdirSync(join(root, 'vanishing'));
    // 同时覆盖旧 listdir 和新 scandir，在枚举完成、候选项处理之前改变真实文件。
    const setup = `
import os, sys
race_kind = ${JSON.stringify(kind)}
real_listdir, real_scandir = os.listdir, os.scandir
def remove_candidate(path):
    if race_kind == 'file':
        os.unlink(path)
    else:
        os.rmdir(path)
        if race_kind == 'replaced-directory':
            with open(path, 'w') as output:
                output.write('now an ordinary file')
def racing_listdir(path):
    names = real_listdir(path)
    if path == sys.argv[1]:
        remove_candidate(os.path.join(path, 'vanishing'))
    return names
class RacingDirectory:
    def __init__(self, entries):
        self.entries = entries
    def __enter__(self):
        self.entries.__enter__()
        return self
    def __exit__(self, *error):
        return self.entries.__exit__(*error)
    def __iter__(self):
        return self
    def __next__(self):
        entry = next(self.entries)
        if entry.name == 'vanishing':
            remove_candidate(entry.path)
        return entry
def racing_scandir(path):
    return RacingDirectory(real_scandir(path))
os.listdir, os.scandir = racing_listdir, racing_scandir
`;
    const result = scan(root, { setup });
    assert.equal(result.limited, false);
    assert.deepEqual(result.entries.map((entry) => entry.name).sort(), ['after', 'before']);
  });
}

test('fresh link metadata overrides a cached directory type without recursion', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'changed-directory'));
  // 模拟枚举时是目录、处理时 lstat 已是链接；禁止打开该候选项，验证元数据边界。
  const setup = `
import os, stat
real_lstat, real_scandir, real_realpath = os.lstat, os.scandir, os.path.realpath
def latest_lstat(path, *args, **kwargs):
    metadata = real_lstat(path, *args, **kwargs)
    if os.path.basename(path) == 'changed-directory':
        values = list(metadata)
        values[0] = stat.S_IFLNK | 0o777
        return os.stat_result(values)
    return metadata
def guarded_scandir(path):
    if os.path.basename(path) == 'changed-directory':
        raise AssertionError('must not recurse into the replacement link')
    return real_scandir(path)
def resolved_path(path, *args, **kwargs):
    if os.path.basename(path) == 'changed-directory':
        return path + '-resolved-link'
    return real_realpath(path, *args, **kwargs)
os.lstat, os.scandir, os.path.realpath = latest_lstat, guarded_scandir, resolved_path
`;
  const result = scan(root, { setup });
  assert.equal(result.limited, false);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].name, 'changed-directory');
  assert.equal(result.entries[0].status, 'unscanned');
  assert.ok(result.entries[0].linkTarget.endsWith('-resolved-link'));
});

test('real directory access failures are not silently reported as complete scans', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'unreadable'));
  const setup = `
import os
real_listdir, real_scandir = os.listdir, os.scandir
def denied_listdir(path):
    if os.path.basename(path) == 'unreadable':
        raise PermissionError('fixture access denied')
    return real_listdir(path)
def denied_scandir(path):
    if os.path.basename(path) == 'unreadable':
        raise PermissionError('fixture access denied')
    return real_scandir(path)
os.listdir, os.scandir = denied_listdir, denied_scandir
`;
  const child = runScan(root, { setup });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /PermissionError: fixture access denied/);
});

test('missing root is an empty complete scan', (t) => {
  const root = fixture(t);
  assert.deepEqual(scan(join(root, 'missing')), { entries: [], limited: false });
});

test('directory links and dangling links are discovered without recursion', {
  skip: process.platform === 'win32' ? 'POSIX symlink test; real WSL transport not exercised here' : false,
}, (t) => {
  const root = fixture(t);
  symlinkSync(root, join(root, 'loop'), 'dir');
  symlinkSync(join(root, 'missing'), join(root, 'dangling'), 'dir');
  const result = scan(root);
  assert.equal(result.limited, false);
  assert.equal(result.entries.length, 2);
  assert.ok(result.entries.some((entry) => entry.status === 'missing'));
});
