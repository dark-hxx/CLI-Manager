import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const file = "src/components/TerminalTabs.tsx";
const original = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const source = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nameOf = node => ts.isVariableStatement(node) ? node.declarationList.declarations[0].name.getText(source) : node.name.text;
const imports = source.statements.filter(ts.isImportDeclaration);
const nodes = source.statements.filter(node => !ts.isImportDeclaration(node));
const between = (start, end) => nodes.slice(nodes.findIndex(node => nameOf(node) === start), nodes.findIndex(node => nameOf(node) === end));
const named = (...names) => names.map(name => { const node = nodes.find(node => nameOf(node) === name); assert.ok(node, name); return node; });
const root = "src/features/terminal";
const groups = [
  { file: `${root}/components/lazyTerminalPanels.tsx`, nodes: between("HistoryWorkspace", "normalizeTabMenuHex") },
  { file: `${root}/lib/terminalTabsModel.ts`, nodes: [...between("normalizeTabMenuHex", "SortableTabProps"), ...named("TerminalTabsProps")] },
  { file: `${root}/hooks/useTerminalTabHoverCard.ts`, nodes: named("useTerminalTabHoverCard") },
  { file: `${root}/components/TerminalTabHoverCard.tsx`, nodes: named("TerminalTabHoverCard") },
  { file: `${root}/components/SortableTerminalTabs.tsx`, nodes: named("SortableTabProps", "SortableTab", "SortableWorkspanTab") },
  { file: `${root}/components/TerminalTabDragOverlay.tsx`, nodes: between("DragOverlayTab", "PaneTabBarProps") },
  { file: `${root}/components/PaneTabBar.tsx`, nodes: named("PaneTabBarProps", "PaneTabBar") },
  { file: `${root}/components/PaneLeafView.tsx`, nodes: between("PaneLeafViewProps", "PaneContentDropZones") },
  { file: `${root}/components/PaneContentDropZones.tsx`, nodes: named("PaneContentDropZones") },
  { file: `${root}/components/TerminalTabDialogs.tsx`, nodes: between("SplitProjectPickerProps", "SortableToolbarButton") },
  { file: `${root}/components/TerminalToolbarControls.tsx`, nodes: named("SortableToolbarButton", "CpuCatIndicator") },
  { file, nodes: named("TerminalTabs") },
];
assert.equal(new Set(groups.flatMap(group => group.nodes)).size, nodes.length);
assert.equal(groups.flatMap(group => group.nodes).length, nodes.length);
const identifiers = node => {
  const refs = new Set();
  const visit = child => { if (ts.isIdentifier(child)) refs.add(child.text); ts.forEachChild(child, visit); };
  visit(node);
  return refs;
};
const relative = (from, to) => {
  const result = path.posix.relative(path.posix.dirname(from), to).replace(/\.tsx?$/, "");
  return result.startsWith(".") ? result : `./${result}`;
};
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const outputs = new Map();
for (const group of groups) {
  const refs = new Set(group.nodes.flatMap(node => [...identifiers(node)]));
  const prefix = [];
  for (const item of imports) {
    const clause = item.importClause;
    assert.ok(clause && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name);
    const names = clause.namedBindings.elements.filter(binding => refs.has(binding.name.text));
    if (!names.length) continue;
    const specifier = item.moduleSpecifier.text;
    const target = specifier.startsWith(".")
      ? relative(group.file, path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))) : specifier;
    const updated = ts.factory.updateImportDeclaration(item, item.modifiers,
      ts.factory.updateImportClause(clause, clause.isTypeOnly, undefined, ts.factory.updateNamedImports(clause.namedBindings, names)),
      ts.factory.createStringLiteral(target), item.attributes);
    prefix.push(printer.printNode(ts.EmitHint.Unspecified, updated, source));
  }
  for (const dependency of groups.filter(other => other !== group)) {
    const required = dependency.nodes.filter(node => refs.has(nameOf(node)));
    if (!required.length) continue;
    const names = required.map(node => `${ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? "type " : ""}${nameOf(node)}`);
    prefix.push(`import { ${names.join(", ")} } from "${relative(group.file, dependency.file)}";`);
  }
  const body = group.nodes.map(node => {
    let text = node.getText(source);
    // Only relative lazy import specifiers change; keep lazy() boundaries and bodies otherwise exact.
    const edits = [];
    const visit = child => {
      if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword
        && ts.isStringLiteral(child.arguments[0]) && child.arguments[0].text.startsWith(".")) {
        const literal = child.arguments[0];
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), literal.text));
        edits.push({ start: literal.getStart(source) - node.getStart(source), end: literal.end - node.getStart(source), text: JSON.stringify(relative(group.file, target)) });
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ? text : `export ${text}`;
  }).join("\n\n");
  const output = `${prefix.join("\n")}\n\n${body}\n`.replace(
    /^(import(?: type)? \{ )([^\n]+)( \} from [^\n]+)$/gm,
    (line, start, middle, end) => {
      if (line.length <= 120) return line;
      const rows = [];
      let row = " ";
      for (const name of middle.split(", ")) {
        if (row.length + name.length > 100) { rows.push(row); row = " "; }
        row += ` ${name},`;
      }
      rows.push(row);
      return `${start.trimEnd()}\n${rows.join("\n")}\n${end.trimStart()}`;
    },
  );
  assert.ok(group.file === file || !existsSync(group.file), group.file);
  if (group.file !== file) assert.ok(output.trimEnd().split("\n").length <= 2000, group.file);
  const parsed = ts.createSourceFile(group.file, output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(parsed.parseDiagnostics.length, 0);
  for (let index = 0; index < group.nodes.length; index++) {
    const actual = parsed.statements.filter(node => !ts.isImportDeclaration(node))[index];
    const normalize = text => text.replace(/^export\s+/, "").replace(/import\("(?:\.\.?\/)+([^"()]+)"\)/g, (_, target) => `import("${target.replace(/^components\//, "")}")`);
    assert.equal(normalize(actual.getText(parsed)), normalize(group.nodes[index].getText(source)), nameOf(group.nodes[index]));
  }
  outputs.set(group.file, output);
}
console.log(JSON.stringify([...outputs].map(([file, text]) => ({ file, lines: text.trimEnd().split("\n").length }))));
if (process.argv.includes("--write")) {
  for (const [destination, output] of outputs) {
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, output);
  }
}
