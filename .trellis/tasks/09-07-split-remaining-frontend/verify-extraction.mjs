import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

const parse = (file, text) => ts.createSourceFile(file, text.replaceAll("\r\n", "\n"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const before = file => parse(file, execFileSync("git", ["show", `b9b00a04:${file}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
const read = file => parse(file, readFileSync(file, "utf8"));
const filesUnder = dir => readdirSync(dir, { withFileTypes: true }).flatMap(item =>
  item.isDirectory() ? filesUnder(`${dir}/${item.name}`) : /\.tsx?$/.test(item.name) ? [`${dir}/${item.name}`] : []);
const declarations = source => source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node));
const nameOf = node => ts.isVariableStatement(node) ? node.declarationList.declarations[0].name.getText() : node.name?.text;
const body = node => node.getText().replace(/^export\s+/, "");
let count = 0;
for (const [original, domain] of [
  ["src/stores/historyStore.ts", "history"],
  ["src/components/settings/pages/HookSettingsPage.tsx", "settings"],
]) {
  const actual = filesUnder(`src/features/${domain}`).flatMap(file => declarations(read(file)));
  for (const node of declarations(before(original))) {
    const matches = actual.filter(other => nameOf(other) === nameOf(node));
    assert.equal(matches.length, 1, nameOf(node));
    assert.equal(body(matches[0]), body(node), nameOf(node));
    count++;
  }
}
const sidebar = before("src/components/sidebar/index.tsx");
const component = sidebar.statements.find(node => node.name?.text === "Sidebar");
const model = read("src/features/projects/lib/sidebarModel.ts");
for (const node of declarations(sidebar).filter(node => node !== component)) {
  assert.equal(body(declarations(model).find(other => nameOf(other) === nameOf(node))), body(node), nameOf(node));
  count++;
}
const controller = read("src/features/projects/hooks/useSidebarController.tsx")
  .statements.find(node => node.name?.text === "useSidebarController");
const oldStatements = [...component.body.statements];
const newStatements = [...controller.body.statements];
const returned = oldStatements.pop();
newStatements.pop();
assert.equal(newStatements.length, oldStatements.length);
for (let i = 0; i < oldStatements.length; i++) {
  const original = oldStatements[i];
  const name = nameOf(original);
  if (name === "confirmDialog") continue;
  if (name === "[confirmAction, setConfirmAction]") {
    const oldCall = original.declarationList.declarations[0].initializer;
    assert.equal(newStatements[i].getText(), original.getText().replace(oldCall.typeArguments[0].getText(), "SidebarConfirmAction"));
  } else assert.equal(newStatements[i].getText(), original.getText(), `Sidebar statement ${i}: ${name}`);
  count++;
}
const view = read("src/features/projects/components/SidebarView.tsx").statements.find(node => node.name?.text === "SidebarView");
assert.equal(view.body.statements[0].getText(), returned.getText());
const confirmation = oldStatements.find(node => nameOf(node) === "confirmDialog").declarationList.declarations[0].initializer;
const factory = read("src/features/projects/lib/sidebarDeleteConfirmation.ts").statements.find(node => node.name?.text === "createSidebarDeleteConfirmation");
assert.equal(factory.body.statements[0].expression.getText(), confirmation.getText());
console.log(`${count} declarations/statements and complete sidebar JSX/delete initializer preserved; hook order unchanged.`);
