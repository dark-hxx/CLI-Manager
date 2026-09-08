import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
assert.ok(files.length, 'Pass explicitly reviewed source files');
const auditManifest = '.trellis/tasks/09-07-audit-architecture-refactor/rust-audit/Cargo.toml';
const oldSources = files.map(file => ({ file, source: execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' }).replaceAll('\r\n', '\n') }));
const newSources = files.map(file => ({ file, source: readFileSync(file, 'utf8').replaceAll('\r\n', '\n') }));
const parse = sources => JSON.parse(execFileSync(
  'cargo', ['run', '--quiet', '--manifest-path', auditManifest, '--'],
  { input: JSON.stringify(sources), encoding: 'utf8', maxBuffer: 32e6 },
));
const before = parse(oldSources), after = parse(newSources);
let methods = 0, addedComments = 0, removedBlankLines = 0;
for (let i = 0; i < files.length; i++) {
  const diff = execFileSync('git', ['diff', '--unified=0', 'HEAD', '--', files[i]], { encoding: 'utf8' });
  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-')) {
      assert.match(line, /^-\s*$/u, `${files[i]}: only blank lines may be deleted`);
      removedBlankLines++;
    }
    if (line.startsWith('+')) {
      assert.match(line, /^\+\s*\/\/[^/!]/u, `${files[i]}: only ordinary line comments may be added`);
      addedComments++;
    }
  }
  const comparable = report => report.methods.map(({line, end, ...method}) => method);
  assert.deepEqual(comparable(after[i]), comparable(before[i]), `${files[i]}: method tokens/attributes/signatures changed`);
  assert.deepEqual(after[i].unexpanded_macros.map(({line, ...value}) => value),
    before[i].unexpanded_macros.map(({line, ...value}) => value));
  const lines = newSources[i].source.split('\n');
  for (const method of after[i].methods) {
    // 允许说明紧贴函数或其连续单行属性之前，避免破坏既有源码契约测试的属性邻接。
    let preceding = method.line - 2;
    while (/^\s*#\[[^\r\n]*\]\s*$/u.test(lines[preceding] ?? '')) preceding--;
    assert.match(lines[preceding] ?? '', /^\s*\/\/\S?\s*\S/u,
      `${files[i]}:${method.line} ${method.name}: missing preceding method/attribute explanation`);
  }
  methods += after[i].methods.length;
}
console.log(JSON.stringify({ files: files.length, methods, addedComments, removedBlankLines, result: 'comments/blank spacing only; method tokens unchanged' }));
