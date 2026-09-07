import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

const parse = (file, text) => ts.createSourceFile(file, text.replaceAll("\r\n", "\n"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const read = file => parse(file, readFileSync(file, "utf8"));
const before = file => parse(file, execFileSync("git", ["show", `2d1eb7fe:${file}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory()
  ? walk(`${dir}/${item.name}`) : /\.tsx?$/.test(item.name) ? [`${dir}/${item.name}`] : []);
const declarations = source => source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node));
const nameOf = node => ts.isVariableStatement(node) ? node.declarationList.declarations[0].name.getText() : node.name?.text;
const actual = walk("src/features/terminal").flatMap(file => declarations(read(file)));
const normalize = text => text.replace(/^export\s+/, "")
  .replace(/import\("(?:\.\.?\/)+([^"()]+)"\)/g, (_, target) => `import("${target.replace(/^components\//, "")}")`);
let count = 0;
for (const [original, componentName, hookName, viewName] of [
  ["src/components/XTermTerminal.tsx", "XTermTerminal", "useXTermController", "XTermView"],
  ["src/components/TerminalTabs.tsx", "TerminalTabs", "useTerminalTabsController", "TerminalTabsView"],
]) {
  const source = before(original);
  const component = declarations(source).find(node => nameOf(node) === componentName);
  for (const node of declarations(source).filter(node => node !== component)) {
    const matches = actual.filter(other => nameOf(other) === nameOf(node));
    assert.equal(matches.length, 1, nameOf(node));
    assert.equal(normalize(matches[0].getText()), normalize(node.getText()), nameOf(node));
    count++;
  }
  const hook = actual.find(node => nameOf(node) === hookName);
  const view = actual.find(node => nameOf(node) === viewName);
  assert.equal(component.body.statements.at(-1).getText(), view.body.statements.at(-1).getText());
  const previousStatements = [...component.body.statements].slice(0, -1);
  const currentStatements = [...hook.body.statements].slice(0, -1);
  assert.equal(previousStatements.length, currentStatements.length);
  for (let index = 0; index < previousStatements.length; index++) {
    const node = previousStatements[index];
    const name = nameOf(node);
    const extractedHook = name === "renderToolbarActions" ? "useTerminalToolbarRenderer"
      : name === "scopedEmptyState" ? "useScopedTerminalEmptyState" : null;
    if (extractedHook) {
      const child = actual.find(node => nameOf(node) === extractedHook);
      assert.equal(child.body.statements[0].expression.getText(), node.declarationList.declarations[0].initializer.getText());
      assert.match(currentStatements[index].getText(), new RegExp(`= ${extractedHook}\\(`));
    } else {
      // Explicit literal-union annotation prevents return-object widening; no expression change.
      const current = currentStatements[index].getText().replace('const terminalThemeTone: "light" | "dark" =', "const terminalThemeTone =");
      assert.equal(current, node.getText(), `${componentName} statement ${index}: ${name}`);
    }
    count++;
  }
}
console.log(`${count} declarations/statements and both complete JSX returns match 2d1eb7fe; extracted callback/memo bodies and dependencies unchanged.`);
