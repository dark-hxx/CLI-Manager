import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const archive = '.trellis/tasks/archive/2026-09/09-07-architecture-convergence';
const { map, routes } = JSON.parse(readFileSync(`${archive}/rust-ownership-plan.json`, 'utf8'));
const edits = JSON.parse(readFileSync(`${archive}/rust-path-edits.json`, 'utf8'));
const normalize = value => value.replaceAll('\r\n', '\n');
let files = 0;
let resources = 0;
let namespaces = 0;
for (const [oldFile, newFile] of Object.entries(map)) {
  const oldSource = normalize(execFileSync('git', ['show', `8cf2a86c:${oldFile}`], { encoding: 'utf8', maxBuffer: 4e6 }));
  let actual = normalize(readFileSync(newFile, 'utf8'));
  for (const edit of edits[oldFile] ?? []) {
    const oldResolved = path.posix.normalize(path.posix.join(path.posix.dirname(oldFile), edit.before));
    const newResolved = path.posix.normalize(path.posix.join(path.posix.dirname(newFile), edit.after));
    assert.equal(newResolved, map[oldResolved] ?? oldResolved, `Changed resource identity: ${oldFile}`);
    assert.ok(existsSync(newResolved), `Missing resource: ${newResolved}`);
    assert.ok(actual.includes(`"${edit.after}"`), `Missing replacement: ${newFile}`);
    actual = actual.replaceAll(`"${edit.after}"`, `"${edit.before}"`);
    resources++;
  }
  for (const [key, route] of Object.entries(routes)) {
    if (!key.startsWith(`${oldFile}:`)) continue;
    assert.equal(map[route.source], route.target, `Route no longer points at the original owner: ${key}`);
    const name = key.slice(oldFile.length + 1);
    const relative = path.posix.relative(path.posix.dirname(newFile), route.target);
    const declaration = `#[path = "${relative}"]\n`;
    assert.ok(['', 'pub ', 'pub(crate) ', 'pub(super) '].some(visibility =>
      actual.includes(`${declaration}${visibility}mod ${name};`)), `Wrong namespace/visibility adjacency: ${key}`);
    actual = actual.replace(declaration, '');
    namespaces++;
  }
  assert.equal(actual, oldSource, `Unexpected code/cfg/import/visibility change: ${newFile}`);
  files++;
}
console.log(JSON.stringify({ files, resources, namespaces, result: 'pass' }));
