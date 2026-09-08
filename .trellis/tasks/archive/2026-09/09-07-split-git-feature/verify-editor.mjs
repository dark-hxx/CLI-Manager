import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const parse = text => ts.createSourceFile("editor.tsx", text.replaceAll("\r\n", "\n"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const read = file => parse(readFileSync(file, "utf8"));
const before = parse(execFileSync("git", ["show", "6cf6222d:src/components/files/FileEditorPane.tsx"], { encoding: "utf8" }));
const original = before.statements.find(node => node.name?.text === "FileEditorPane");
const controller = read("src/features/files/hooks/useFileEditorController.ts");
const control = controller.statements.find(node => node.name?.text === "useFileEditorController");
const navigation = read("src/features/files/hooks/useFileEditorMarkdownNavigation.ts")
  .statements.find(node => node.name?.text === "useFileEditorMarkdownNavigation");
const view = read("src/features/files/components/FileEditorPaneView.tsx")
  .statements.find(node => node.name?.text === "FileEditorPaneView");
const expanded = [...control.body.statements].slice(0, -1).flatMap(node =>
  ts.isVariableStatement(node) && node.declarationList.declarations[0].initializer?.expression?.getText() === "useFileEditorMarkdownNavigation"
    ? [...navigation.body.statements].slice(1, -1) : [node]);
assert.deepEqual(expanded.map(node => node.getText()), [...original.body.statements].slice(0, -1).map(node => node.getText()));
assert.equal(view.body.statements.at(-1).getText(), original.body.statements.at(-1).getText());
const types = read("src/features/files/types/fileEditorModel.ts");
for (const node of before.statements.filter(node => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))) {
  assert.equal(types.statements.find(other => other.name?.text === node.name.text).getText().replace(/^export /, ""), node.getText());
}
const theme = read("src/features/files/lib/fileEditorTheme.ts").statements.find(node => node.name?.text === "isDarkHexColor");
assert.equal(theme.getText().replace(/^export /, ""), before.statements.find(node => node.name?.text === "isDarkHexColor").getText());
assert.equal(controller.statements.filter(node => ts.isExpressionStatement(node) && node.expression.getText() === "configureMonaco()").length, 1);
console.log(`${expanded.length} editor statements, hook order, complete JSX, model types and theme helper match 6cf6222d.`);
