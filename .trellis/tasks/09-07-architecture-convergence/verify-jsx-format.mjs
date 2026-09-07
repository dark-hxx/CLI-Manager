import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const files = Object.keys(JSON.parse(execFileSync("git", ["show", "6cf6222d:scripts/architecture/baseline.json"], { encoding: "utf8" })).files)
  .filter(file => file.endsWith(".tsx"));
function emittedSemantics(text) {
  const output = ts.transpileModule(text, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const source = ts.createSourceFile("emitted.js", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const result = ts.transform(source, [context => {
    const visit = node => {
      node = ts.visitEachChild(node, visit, context);
      for (const value of Object.values(node)) {
        if (Array.isArray(value) && "pos" in value) value.hasTrailingComma = false;
      }
      if (ts.isParenthesizedExpression(node)) return node.expression;
      if (ts.isStringLiteral(node)) return ts.factory.createStringLiteral(node.text);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
        && ts.isStringLiteral(node.left) && ts.isStringLiteral(node.right)) return ts.factory.createStringLiteral(node.left.text + node.right.text);
      if (ts.isNamedImports(node)) return ts.factory.updateNamedImports(node, ts.factory.createNodeArray(node.elements, false));
      if (ts.isNamedExports(node)) return ts.factory.updateNamedExports(node, ts.factory.createNodeArray(node.elements, false));
      if (ts.isCallExpression(node)) return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, ts.factory.createNodeArray(node.arguments, false));
      if (ts.isArrayLiteralExpression(node)) return ts.factory.updateArrayLiteralExpression(node, ts.factory.createNodeArray(node.elements, false));
      if (ts.isObjectLiteralExpression(node)) return ts.factory.updateObjectLiteralExpression(node, ts.factory.createNodeArray(node.properties, false));
      return node;
    };
    return node => ts.visitNode(node, visit);
  }]);
  const shape = node => {
    const children = [];
    ts.forEachChild(node, child => { children.push(shape(child)); });
    const literal = ts.isIdentifier(node) || ts.isLiteralExpression(node) || ts.isTemplateLiteralToken(node)
      ? node.text : null;
    const declarationKind = ts.isVariableDeclarationList(node) ? node.flags & ts.NodeFlags.BlockScoped : null;
    return [node.kind, literal, declarationKind, children];
  };
  const normalized = JSON.stringify(shape(result.transformed[0]), null, 2);
  result.dispose();
  return normalized;
}
for (const file of files) {
  const before = execFileSync("git", ["show", `6cf6222d:${file}`], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  const after = readFileSync(file, "utf8");
  // Compare the compiled React calls, not raw JSX: whitespace/text child changes must fail.
  const expected = emittedSemantics(before), actual = emittedSemantics(after);
  if (expected !== actual) {
    const expectedLines = expected.split("\n"), actualLines = actual.split("\n");
    const at = expectedLines.findIndex((line, index) => line !== actualLines[index]);
    console.error(JSON.stringify({ file, line: at + 1, before: expectedLines[at], after: actualLines[at] }));
  }
  assert.ok(expected === actual, `${file}: emitted semantics changed`);
  console.log(`${file}: emitted React/JavaScript semantics unchanged`);
}
