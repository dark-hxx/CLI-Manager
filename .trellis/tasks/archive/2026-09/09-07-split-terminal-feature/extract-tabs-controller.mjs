import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const file = "src/components/TerminalTabs.tsx";
const original = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const host = ts.createCompilerHost({ noResolve: true, jsx: ts.JsxEmit.ReactJSX });
host.readFile = name => name.replaceAll("\\", "/").endsWith(file) ? original : ts.sys.readFile(name);
const program = ts.createProgram([file], { noResolve: true, jsx: ts.JsxEmit.ReactJSX }, host);
const source = program.getSourceFile(file);
const checker = program.getTypeChecker();
const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === "TerminalTabs");
assert.ok(component);
const returned = component.body.statements.at(-1);
assert.ok(ts.isReturnStatement(returned));
const toolbar = component.body.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations[0].name.getText(source) === "renderToolbarActions");
const toolbarInitializer = toolbar.declarationList.declarations[0].initializer;
const emptyState = component.body.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations[0].name.getText(source) === "scopedEmptyState");
const emptyInitializer = emptyState.declarationList.declarations[0].initializer;
function captures(node) {
  const refs = new Set();
  const visit = child => {
    if (ts.isIdentifier(child)) {
      const symbol = ts.isShorthandPropertyAssignment(child.parent)
        ? checker.getShorthandAssignmentValueSymbol(child.parent) : checker.getSymbolAtLocation(child);
      const declaration = symbol?.valueDeclaration;
      if (declaration && (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration) || ts.isParameter(declaration))
        && declaration.getSourceFile() === source && declaration.pos >= component.pos && declaration.end < node.getStart(source)) refs.add(child.text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return [...refs];
}
const viewNames = captures(returned);
const toolbarNames = captures(toolbarInitializer);
const emptyNames = captures(emptyInitializer);
const emptyTypes = {
  hasScopedTerminalFilter: "boolean", terminalScopeValue: "TerminalScope",
  scopedWorktree: "WorktreeRecord | null | undefined", scopedProject: "Project | null | undefined",
  scopedGroup: "Group | null | undefined", t: 'ReturnType<typeof useI18n>["t"]',
  handleOpenScopedTerminal: "() => void",
};
for (const name of emptyNames) assert.ok(emptyTypes[name], name);
const toolbarTypes = {
  t: 'ReturnType<typeof useI18n>["t"]',
  fullscreen: "boolean", sessionHistoryShortcutHint: "string", filePanelProject: "Project | null",
  terminalSidePanelSide: '"left" | "right"', onToggleFullscreen: "(() => void) | undefined",
  terminalActionSidebarStyle: "CSSProperties", terminalPopoverStyle: "CSSProperties",
  terminalToolbarVisibility: 'ReturnType<typeof useSettingsStore.getState>["terminalToolbarVisibility"]',
  terminalToolbarOrder: "string[]", activeToolbarDragId: "string | null", backgroundTasks: "BackgroundTaskMeta[]",
  toolbarSensors: "ReturnType<typeof useSensors>", handleToolbarDragStart: "(event: DragStartEvent) => void",
  handleToolbarDragEnd: "(event: DragEndEvent) => void",
};
for (const name of toolbarNames) {
  if (name.startsWith("handle") || name === "refreshBackgroundTasks") toolbarTypes[name] ??= "() => void";
  if (name.endsWith("Active") || name.endsWith("Enabled") || name.endsWith("Visible") || name === "historyOpen" || name === "sidePanelMerged") toolbarTypes[name] ??= "boolean";
  assert.ok(toolbarTypes[name], name);
}
const imports = source.statements.filter(ts.isImportDeclaration);
const parse = text => ts.createSourceFile("generated.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const identifiers = node => {
  const refs = new Set();
  const visit = child => { if (ts.isIdentifier(child)) refs.add(child.text); ts.forEachChild(child, visit); };
  visit(node); return refs;
};
const relative = (from, to) => {
  const result = path.posix.relative(path.posix.dirname(from), to).replace(/\.tsx?$/, "");
  return result.startsWith(".") ? result : `./${result}`;
};
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
function prefix(destination, body) {
  const refs = identifiers(parse(body));
  return imports.flatMap(item => {
    const clause = item.importClause;
    assert.ok(clause && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name);
    const names = clause.namedBindings.elements.filter(binding => refs.has(binding.name.text));
    if (!names.length) return [];
    const specifier = item.moduleSpecifier.text;
    const target = specifier.startsWith(".")
      ? relative(destination, path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))) : specifier;
    return [printer.printNode(ts.EmitHint.Unspecified, ts.factory.updateImportDeclaration(item, item.modifiers,
      ts.factory.updateImportClause(clause, clause.isTypeOnly, undefined, ts.factory.updateNamedImports(clause.namedBindings, names)),
      ts.factory.createStringLiteral(target), item.attributes), source)];
  }).join("\n");
}
const root = "src/features/terminal";
const controllerFile = `${root}/hooks/useTerminalTabsController.tsx`;
const viewFile = `${root}/components/TerminalTabsView.tsx`;
const toolbarFile = `${root}/hooks/useTerminalToolbarRenderer.tsx`;
const emptyFile = `${root}/hooks/useScopedTerminalEmptyState.ts`;
const emptyBody = `interface ScopedTerminalEmptyStateContext {\n${emptyNames.map(name => `  ${name}: ${emptyTypes[name]};`).join("\n")}\n}\n\n`
  + `export function useScopedTerminalEmptyState({\n${emptyNames.map(name => `  ${name},`).join("\n")}\n}: ScopedTerminalEmptyStateContext) {\n  return ${emptyInitializer.getText(source)};\n}\n`;
const toolbarBody = `interface TerminalToolbarContext {\n${toolbarNames.map(name => `  ${name}: ${toolbarTypes[name]};`).join("\n")}\n}\n\n`
  + `export function useTerminalToolbarRenderer({\n${toolbarNames.map(name => `  ${name},`).join("\n")}\n}: TerminalToolbarContext) {\n  return ${toolbarInitializer.getText(source)};\n}\n`;
const head = component.getText(source).slice(0, component.body.getStart(source) - component.getStart(source))
  .replace("function TerminalTabs(", "function useTerminalTabsController(");
const oldStatements = original.slice(component.body.getStart(source) + 1, returned.getStart(source));
const statements = oldStatements.replace(toolbar.getText(source),
  `const renderToolbarActions = useTerminalToolbarRenderer({\n${toolbarNames.map(name => `    ${name},`).join("\n")}\n  });`)
  .replace(emptyState.getText(source), `const scopedEmptyState = useScopedTerminalEmptyState({\n${emptyNames.map(name => `    ${name},`).join("\n")}\n  });`);
const controller = `${head}{${statements}return {\n${viewNames.map(name => `    ${name},`).join("\n")}\n  };\n}\n`;
const view = `export function TerminalTabsView({\n${viewNames.map(name => `  ${name},`).join("\n")}\n}: ReturnType<typeof useTerminalTabsController>) {\n  ${returned.getText(source)}\n}\n`;
const outputs = new Map([
  [controllerFile, `${prefix(controllerFile, controller)}\nimport { useTerminalToolbarRenderer } from "./useTerminalToolbarRenderer";\nimport { useScopedTerminalEmptyState } from "./useScopedTerminalEmptyState";\n\n${controller}`],
  [viewFile, `import type { useTerminalTabsController } from "../hooks/useTerminalTabsController";\n${prefix(viewFile, view)}\n\n${view}`],
  [toolbarFile, `${prefix(toolbarFile, toolbarBody)}\n\n${toolbarBody}`],
  [emptyFile, `import type { Group, TerminalScope } from "../../../lib/types";\n${prefix(emptyFile, emptyBody)}\n\n${emptyBody}`],
  [`${root}/components/TerminalTabs.tsx`, 'import { useTerminalTabsController } from "../hooks/useTerminalTabsController";\nimport { TerminalTabsView } from "./TerminalTabsView";\nimport type { TerminalTabsProps } from "../lib/terminalTabsModel";\n\nexport function TerminalTabs(props: TerminalTabsProps = {}) {\n  return <TerminalTabsView {...useTerminalTabsController(props)} />;\n}\n'],
]);
for (const [destination, output] of outputs) {
  const formatted = output.replace(/^(import(?: type)? \{ )([^\n]+)( \} from [^\n]+)$/gm, (line, start, middle, end) => {
    if (line.length <= 120) return line;
    const rows = []; let row = " ";
    for (const name of middle.split(", ")) {
      if (row.length + name.length > 100) { rows.push(row); row = " "; }
      row += ` ${name},`;
    }
    rows.push(row);
    return `${start.trimEnd()}\n${rows.join("\n")}\n${end.trimStart()}`;
  });
  assert.ok(!existsSync(destination), destination);
  assert.equal(parse(formatted).parseDiagnostics.length, 0, destination);
  assert.ok(formatted.trimEnd().split("\n").length <= 2000, destination);
  outputs.set(destination, formatted);
}
assert.ok(outputs.get(toolbarFile).includes(toolbarInitializer.getText(source)));
assert.ok(outputs.get(emptyFile).includes(emptyInitializer.getText(source)));
assert.ok(outputs.get(viewFile).includes(returned.getText(source)));
const newController = parse(outputs.get(controllerFile)).statements.find(node => node.name?.text === "useTerminalTabsController");
for (let index = 0; index < component.body.statements.length - 1; index++) {
  if (component.body.statements[index] === toolbar || component.body.statements[index] === emptyState) continue;
  assert.equal(newController.body.statements[index].getText(), component.body.statements[index].getText(source), `statement ${index}`);
}
console.log(JSON.stringify({ files: [...outputs].map(([file, text]) => ({ file, lines: text.trimEnd().split("\n").length })), toolbarNames, viewNames }));
if (process.argv.includes("--write")) {
  for (const [destination, output] of outputs) { mkdirSync(path.dirname(destination), { recursive: true }); writeFileSync(destination, output); }
  writeFileSync(file, 'export { TerminalTabs } from "@/features/terminal";\n');
  const entry = `${root}/index.ts`;
  writeFileSync(entry, readFileSync(entry, "utf8") + 'export { TerminalTabs } from "./components/TerminalTabs";\n');
}
