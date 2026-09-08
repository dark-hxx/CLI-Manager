import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// One-time, declaration-preserving extraction. No React state or effect is reordered.
const file = "src/components/sidebar/index.tsx";
const original = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const host = ts.createCompilerHost({ noResolve: true, jsx: ts.JsxEmit.ReactJSX });
host.readFile = name => name.replaceAll("\\", "/").endsWith(file) ? original : ts.sys.readFile(name);
const program = ts.createProgram([file], { noResolve: true, jsx: ts.JsxEmit.ReactJSX }, host);
const source = program.getSourceFile(file);
const checker = program.getTypeChecker();
const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === "Sidebar");
assert.ok(component);
const returned = component.body.statements.at(-1);
assert.ok(ts.isReturnStatement(returned));
const confirmation = component.body.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations[0].name.getText(source) === "confirmDialog");
const confirmationInitializer = confirmation.declarationList.declarations[0].initializer;
const imports = source.statements.filter(ts.isImportDeclaration);
const helpers = source.statements.filter(node => !ts.isImportDeclaration(node) && node !== component);
const nameOf = node => ts.isVariableStatement(node) ? node.declarationList.declarations[0].name.getText(source) : node.name.text;
const identifiers = node => {
  const result = new Set();
  const visit = current => { if (ts.isIdentifier(current)) result.add(current.text); ts.forEachChild(current, visit); };
  visit(node);
  return result;
};
function capturedNames(node) {
  const result = new Set();
  const visit = current => {
    if (ts.isIdentifier(current)) {
      const symbol = ts.isShorthandPropertyAssignment(current.parent)
        ? checker.getShorthandAssignmentValueSymbol(current.parent) : checker.getSymbolAtLocation(current);
      const declaration = symbol?.valueDeclaration;
      if (declaration && (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration) || ts.isParameter(declaration))
        && declaration.getSourceFile() === source
        && declaration.pos >= component.pos && declaration.end < node.getStart(source)) result.add(current.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return [...result];
}
const viewNames = capturedNames(returned);
const confirmNames = capturedNames(confirmationInitializer);
const root = "src/features/projects";
const files = {
  model: `${root}/lib/sidebarModel.ts`,
  confirmation: `${root}/lib/sidebarDeleteConfirmation.ts`,
  controller: `${root}/hooks/useSidebarController.tsx`,
  view: `${root}/components/SidebarView.tsx`,
};
const relative = (from, to) => {
  const result = path.posix.relative(path.posix.dirname(from), to).replace(/\.tsx?$/, "");
  return result.startsWith(".") ? result : `./${result}`;
};
const parse = text => ts.createSourceFile("generated.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
function importsFor(destination, body, includeHelpers = true) {
  const refs = identifiers(parse(body));
  const result = [];
  for (const item of imports) {
    const clause = item.importClause;
    assert.ok(clause && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name);
    const names = clause.namedBindings.elements.filter(binding => refs.has(binding.name.text));
    if (!names.length) continue;
    const specifier = item.moduleSpecifier.text;
    const target = specifier.startsWith(".")
      ? relative(destination, path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))) : specifier;
    const updated = ts.factory.updateImportDeclaration(item, item.modifiers,
      ts.factory.updateImportClause(clause, clause.isTypeOnly, undefined, ts.factory.updateNamedImports(clause.namedBindings, names)),
      ts.factory.createStringLiteral(target), item.attributes);
    result.push(printer.printNode(ts.EmitHint.Unspecified, updated, source));
  }
  if (includeHelpers) {
    const names = helpers.filter(node => refs.has(nameOf(node))).map(node =>
      `${ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? "type " : ""}${nameOf(node)}`);
    if (refs.has("SidebarConfirmAction")) names.push("type SidebarConfirmAction");
    if (names.length) result.push(`import { ${names.join(", ")} } from "${relative(destination, files.model)}";`);
  }
  return result.join("\n");
}
const confirmState = component.body.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations[0].name.getText(source) === "[confirmAction, setConfirmAction]");
const actionType = confirmState.declarationList.declarations[0].initializer.typeArguments[0];
const modelBody = helpers.map(node => `export ${node.getText(source)}`).join("\n\n")
  + `\n\nexport type SidebarConfirmAction = ${actionType.getText(source)};\n`;
const contextTypes = {
  confirmAction: "SidebarConfirmAction",
  t: 'ReturnType<typeof useI18n>["t"]',
  closeSession: 'ReturnType<typeof useTerminalStore.getState>["closeSession"]',
  deleteProject: 'ReturnType<typeof useProjectStore.getState>["deleteProject"]',
  deleteGroup: 'ReturnType<typeof useProjectStore.getState>["deleteGroup"]',
  removeSyncedSessions: 'ReturnType<typeof useExternalSessionSyncStore.getState>["removeSyncedSessions"]',
  setConfirmAction: "Dispatch<SetStateAction<SidebarConfirmAction>>",
  selectedId: "string | null",
  setSelectedId: "Dispatch<SetStateAction<string | null>>",
  setSelectedProjectIds: "Dispatch<SetStateAction<Set<string>>>",
  setSelectedGroupIds: "Dispatch<SetStateAction<Set<string>>>",
  groups: "Group[]",
  projects: "Project[]",
};
assert.deepEqual(new Set(confirmNames), new Set(Object.keys(contextTypes)));
const confirmBody = `interface SidebarDeleteContext {\n${confirmNames.map(name => `  ${name}: ${contextTypes[name]};`).join("\n")}\n}\n\n`
  + `export function createSidebarDeleteConfirmation({\n${confirmNames.map(name => `  ${name},`).join("\n")}\n}: SidebarDeleteContext) {\n`
  + `  return ${confirmationInitializer.getText(source)};\n}\n`;
const controllerHead = component.getText(source).slice(0, component.body.getStart(source) - component.getStart(source))
  .replace("function Sidebar(", "function useSidebarController(");
let controllerBody = original.slice(component.body.getStart(source) + 1, returned.getStart(source));
controllerBody = controllerBody.replace(confirmation.getText(source),
  `const confirmDialog = createSidebarDeleteConfirmation({\n${confirmNames.map(name => `    ${name},`).join("\n")}\n  });`);
controllerBody = controllerBody.replace(actionType.getText(source), "SidebarConfirmAction");
const controller = `${controllerHead}{${controllerBody}return {\n${viewNames.map(name => `    ${name},`).join("\n")}\n  };\n}\n`;
const view = `export function SidebarView({\n${viewNames.map(name => `  ${name},`).join("\n")}\n}: ReturnType<typeof useSidebarController>) {\n  ${returned.getText(source)}\n}\n`;
const outputs = new Map([
  [files.model, `${importsFor(files.model, modelBody, false)}\n\n${modelBody}`],
  [files.confirmation, `import type { Dispatch, SetStateAction } from "react";\n${importsFor(files.confirmation, confirmBody)}\n\n${confirmBody}`],
  [files.controller, `${importsFor(files.controller, controller)}\nimport { createSidebarDeleteConfirmation } from "../lib/sidebarDeleteConfirmation";\n\n${controller}`],
  [files.view, `import type { useSidebarController } from "../hooks/useSidebarController";\n${importsFor(files.view, view)}\n\n${view}`],
  [`${root}/components/Sidebar.tsx`, 'import { useSidebarController } from "../hooks/useSidebarController";\nimport { SidebarView } from "./SidebarView";\nimport type { SidebarProps } from "../lib/sidebarModel";\n\nexport function Sidebar(props: SidebarProps) {\n  return <SidebarView {...useSidebarController(props)} />;\n}\n'],
  [`${root}/index.ts`, 'export { Sidebar } from "./components/Sidebar";\n'],
]);
// Preserve the complete JSX and confirmation initializer byte for byte.
assert.ok(outputs.get(files.view).includes(returned.getText(source)));
assert.ok(outputs.get(files.confirmation).includes(confirmationInitializer.getText(source)));
for (const helper of helpers) assert.ok(outputs.get(files.model).includes(helper.getText(source)));
for (const [destination, output] of outputs) {
  assert.ok(!existsSync(destination), destination);
  assert.equal(parse(output).parseDiagnostics.length, 0, destination);
}
console.log(JSON.stringify({ files: [...outputs].map(([file, output]) => ({ file, lines: output.trimEnd().split("\n").length })), viewNames, confirmNames }));
if (process.argv.includes("--write")) {
  for (const [destination, output] of outputs) {
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, output);
  }
  writeFileSync(file, 'export { Sidebar } from "@/features/projects";\n');
}
