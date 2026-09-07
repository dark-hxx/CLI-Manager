import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const task = ".trellis/tasks/09-07-architecture-convergence";
const { map, aliases, edges } = JSON.parse(readFileSync(`${task}/frontend-ownership-plan.json`, "utf8"));
const edits = JSON.parse(readFileSync(`${task}/frontend-path-edits.json`, "utf8"));
const before = file => execFileSync("git", ["show", `9488d0be:${file}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).replaceAll("\r\n", "\n");
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
let count = 0;
for (const [file, target] of Object.entries(map)) {
  if (aliases[file] || file === "src/shared/types/remoteHandoff.ts") continue;
  let actual = readFileSync(target, "utf8").replaceAll("\r\n", "\n");
  for (const edit of edits[file] ?? []) {
    actual = actual.replaceAll(`"${edit.after}"`, `"${edit.before}"`).replaceAll(`'${edit.after}'`, `'${edit.before}'`);
  }
  let expected = before(file);
  // One deliberately shared wire type moved out of the transport implementation.
  if (file === "src/lib/types.ts") expected = expected.replace('import("./remoteHandoff").RemoteHandoffAgent', 'import("../shared/types/remoteHandoff").RemoteHandoffAgent');
  const statements = text => parse(file, text).statements.filter(node => {
    if (ts.isImportDeclaration(node)) return false;
    if (file === "src/lib/remoteHandoff.ts" && (node.name?.text === "RemoteHandoffAgent"
      || ts.isExportDeclaration(node) && node.isTypeOnly && node.exportClause?.elements.some(item => item.name.text === "RemoteHandoffAgent"))) return false;
    return true;
  }).map(node => node.getText());
  assert.deepEqual(statements(actual), statements(expected), `${file}: declarations, function bodies, exports or JSX changed`);
  count++;
}
const remoteType = parse("remote.ts", before("src/lib/remoteHandoff.ts")).statements.find(node => node.name?.text === "RemoteHandoffAgent").getText();
assert.equal(parse("shared.ts", readFileSync("src/shared/types/remoteHandoff.ts", "utf8")).statements[0].getText(), remoteType);
for (const [file, target] of [
  ["src/components/desktop-pet/PetArtwork.css", "src/features/desktop-pet/styles/PetArtwork.css"],
  ["src/components/git/diffViewer.css", "src/features/git/styles/diffViewer.css"],
  ["src/desktop-pet/desktopPet.css", "src/features/desktop-pet/styles/desktopPet.css"],
]) assert.equal(readFileSync(target, "utf8").replaceAll("\r\n", "\n"), before(file));
console.log(`${count} complete modules match 9488d0be after resolving path edits; shared wire type and 3 stylesheets unchanged.`);

const owners = new Set(Object.values(map));
const expectedEdges = new Set(edges.filter(edge => !aliases[edge.from]).map(edge => `${map[edge.from]} -> ${map[edge.to]}`));
const actualEdges = new Set();
for (const file of owners) {
  const source = parse(file, readFileSync(file, "utf8"));
  function visit(node) {
    let literal;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) literal = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) literal = node.arguments[0];
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal = node.argument.literal;
    if (literal && ts.isStringLiteral(literal) && literal.text.startsWith(".")) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), literal.text));
      const target = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(candidate => owners.has(candidate));
      if (target) actualEdges.add(`${file} -> ${target}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.deepEqual([...actualEdges].sort(), [...expectedEdges].sort(), "resolved static/type/dynamic module graph changed beyond facade removal");
console.log(`${actualEdges.size} resolved module edges preserved; no new runtime cycle or eager aggregate edge introduced.`);
