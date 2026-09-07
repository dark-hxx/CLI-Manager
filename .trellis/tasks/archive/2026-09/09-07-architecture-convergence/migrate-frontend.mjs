import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const task = ".trellis/tasks/09-07-architecture-convergence";
const plan = JSON.parse(readFileSync(`${task}/frontend-ownership-plan.json`, "utf8"));
const root = path.resolve("src") + path.sep;
const validate = file => {
  const absolute = path.resolve(file);
  assert.ok(absolute.startsWith(root), `Outside source root: ${file}`);
  return absolute;
};
const snapshots = new Map(Object.keys(plan.map).map(file => [file, readFileSync(validate(file), "utf8")]));
const outputs = new Map();
const editsByFile = {};
function resolveModule(from, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;
  const [value, suffix = ""] = specifier.split(/(?=\?)/, 2);
  const base = value.startsWith("@/") ? `src/${value.slice(2)}` : path.posix.normalize(path.posix.join(path.posix.dirname(from), value));
  const resolved = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(candidate => snapshots.has(candidate))
    ?? (existsSync(base) ? base : null);
  return resolved ? { file: resolved, suffix, explicitExtension: value.endsWith(path.posix.extname(resolved)), directory: value.endsWith("/") } : null;
}
function rewrite(file, destination, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edits = [];
  function visit(node) {
    let literal;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) literal = node.moduleSpecifier;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal = node.argument.literal;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.ok(node.arguments[0] && ts.isStringLiteral(node.arguments[0]), `Computed import requires manual review: ${file}`);
      literal = node.arguments[0];
    } else if (ts.isNewExpression(node) && node.expression.getText(source) === "URL" && node.arguments?.[1]?.getText(source) === "import.meta.url") {
      literal = node.arguments[0];
    }
    if (literal && ts.isStringLiteral(literal)) {
      const resolved = resolveModule(file, literal.text);
      if (resolved) {
        let target = plan.map[resolved.file] ?? resolved.file;
        if (!resolved.explicitExtension && /\.tsx?$/.test(target)) target = target.replace(/\.tsx?$/, "");
        let specifier = path.posix.relative(path.posix.dirname(destination), target);
        if (!specifier.startsWith(".")) specifier = `./${specifier}`;
        if (resolved.directory && !specifier.endsWith("/")) specifier += "/";
        specifier += resolved.suffix;
        if (specifier !== literal.text) edits.push({ start: literal.getStart(source) + 1, end: literal.end - 1, before: literal.text, after: specifier });
      } else if (literal.text.startsWith(".")) {
        throw new Error(`Unresolved relative module/asset: ${file} -> ${literal.text}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  let result = text;
  for (const edit of edits.sort((a,b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.after + result.slice(edit.end);
  // The only edits are resolved import/type/worker/asset URL string interiors; all other bytes are retained.
  let restored = result;
  let offset = 0;
  for (const edit of [...edits].reverse()) {
    const at = edit.start + offset;
    assert.equal(restored.slice(at, at + edit.after.length), edit.after);
    offset += edit.after.length - edit.before.length;
  }
  for (const edit of [...edits].reverse()) {
    const at = edit.start;
    restored = restored.slice(0, at) + edit.before + restored.slice(at + edit.after.length);
  }
  assert.equal(restored, text, `${file}: non-path bytes changed`);
  editsByFile[file] = edits;
  return result;
}
for (const [file, text] of snapshots) {
  if (plan.aliases[file]) continue;
  const target = plan.map[file];
  validate(target);
  assert.ok(file === target || !existsSync(target), `Target already exists: ${target}`);
  assert.ok(!outputs.has(target), `Duplicate target: ${target}`);
  outputs.set(target, rewrite(file, target, text));
}
if (!process.argv.includes("--write")) {
  console.log(`Validated ${outputs.size} owners and ${Object.values(editsByFile).reduce((n,e) => n + e.length, 0)} resolved path edits; no source changes. Use --write after review.`);
  process.exit(0);
}
// Every source/destination is explicit, checked inside this workspace, and snapshotted before any rename.
for (const [file, target] of Object.entries(plan.map)) {
  if (plan.aliases[file] || file === target) continue;
  mkdirSync(path.dirname(validate(target)), { recursive: true });
  renameSync(validate(file), validate(target));
}
for (const [target, text] of outputs) writeFileSync(validate(target), text);
for (const file of Object.keys(plan.aliases)) unlinkSync(validate(file));

const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory()
  ? walk(`${directory}/${item.name}`) : [`${directory}/${item.name}`]);
let updatedTests = 0;
for (const file of walk("scripts").filter(file => /\.[cm]?js$/.test(file))) {
  const original = readFileSync(file, "utf8");
  let text = original;
  // Direct source-owner references in tests/helpers follow the exact path map. Do not synthesize monoliths.
  for (const [before, after] of Object.entries(plan.map)) if (before !== after) text = text.replaceAll(before, after);
  if (text !== original) { writeFileSync(file, text); updatedTests++; }
}
writeFileSync(`${task}/frontend-path-edits.json`, JSON.stringify(editsByFile, null, 2) + "\n");
console.log(`Migrated ${outputs.size} owners; removed ${Object.keys(plan.aliases).length} redundant tracked facades; updated ${updatedTests} test/helper path references.`);
