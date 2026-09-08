import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from "node:fs";
import path from "node:path";

const task = ".trellis/tasks/09-07-architecture-convergence";
const { map, routes } = JSON.parse(readFileSync(`${task}/rust-ownership-plan.json`, "utf8"));
const sourceRoot = path.resolve("src-tauri/src") + path.sep;
function validated(file) {
  const absolute = path.resolve(file);
  assert.ok(absolute.startsWith(sourceRoot), `Outside Rust source root: ${file}`);
  return absolute;
}
const outputs = new Map(), edits = {};
for (const [file, target] of Object.entries(map)) {
  const source = readFileSync(validated(file), "utf8");
  validated(target);
  assert.ok(file === target || !existsSync(target), `Target exists: ${target}`);
  let after = source;
  const changedPaths = [];
  // Only compiler-owned source/resource paths; do not rewrite user paths or fixture strings.
  after = after.replace(/(?:include_(?:str|bytes)!\s*\(\s*"|#\[path\s*=\s*")([^"\r\n]+)(?=")/g, (whole, value) => {
    const original = path.posix.normalize(path.posix.join(path.posix.dirname(file), value));
    assert.ok(existsSync(original), `Unresolved embedded source/resource: ${file} -> ${value}`);
    const resolved = map[original] ?? original;
    const next = path.posix.relative(path.posix.dirname(target), resolved);
    if (value !== next) changedPaths.push({ before: value, after: next, resolved });
    return whole.slice(0, whole.length - value.length) + next;
  });
  const registryRoutes = Object.entries(routes).filter(([key]) => key.startsWith(`${file}:`));
  for (const [key, route] of registryRoutes) {
    const name = key.slice(file.length + 1);
    const expression = new RegExp(`^((?:pub(?:\\([^)]*\\))?\\s+)?mod ${name};)`, "m");
    assert.ok(expression.test(after), `Missing facade declaration: ${key}`);
    const relative = path.posix.relative(path.posix.dirname(target), route.target);
    after = after.replace(expression, `#[path = "${relative}"]\n$1`);
  }
  edits[file] = changedPaths;
  outputs.set(target, after);
}
if (!process.argv.includes("--write")) {
  console.log(`Validated ${outputs.size} Rust owners, ${Object.keys(routes).length} namespace routes and ${Object.values(edits).flat().length} embedded path edits; no source moved.`);
  process.exit(0);
}
for (const [file, target] of Object.entries(map)) {
  if (file === target) continue;
  mkdirSync(path.dirname(validated(target)), { recursive: true });
  renameSync(validated(file), validated(target));
}
for (const [file, text] of outputs) writeFileSync(validated(file), text);
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory()
  ? walk(`${directory}/${item.name}`) : [`${directory}/${item.name}`]);
let tests = 0;
for (const file of walk("scripts").filter(file => /\.[cm]?js$/.test(file))) {
  const original = readFileSync(file, "utf8");
  let after = original;
  for (const [from, to] of Object.entries(map)) if (from !== to) after = after.replaceAll(from, to);
  if (after !== original) { writeFileSync(file, after); tests++; }
}
writeFileSync(`${task}/rust-path-edits.json`, JSON.stringify(edits, null, 2) + "\n");
console.log(`Moved ${Object.entries(map).filter(([a,b]) => a !== b).length} Rust sources with stable logical namespaces; updated ${tests} test/helper owner paths.`);
