import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const originalPath = "src/components/files/FileEditorPane.tsx";
const original = readFileSync(originalPath, "utf8").replaceAll("\r\n", "\n");
const parse = text => ts.createSourceFile("source.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const source = parse(original);
const component = source.statements.find(node => node.name?.text === "FileEditorPane");
assert.ok(component?.body);
const body = component.body.statements;
const nameOf = node => ts.isVariableStatement(node) ? node.declarationList.declarations[0].name.getText() : node.name?.text;
const first = body.findIndex(node => nameOf(node) === "reportMarkdownNavigationError");
const last = body.findIndex(node => nameOf(node) === "handleMarkdownFragmentHandled");
assert.ok(first > 0 && last > first);
const navigation = original.slice(body[first].getFullStart(), body[last].end).trim();
const jsx = body.at(-1).getText();
const types = source.statements.filter(node => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node));
const helper = source.statements.find(node => node.name?.text === "isDarkHexColor");
const inheritedImports = source.statements.filter(ts.isImportDeclaration);
const printer = ts.createPrinter();

function write(file, content, extras = "") {
  // Retain only original imports referenced by this extracted owner; preserve their order.
  const identifiers = new Set();
  function visit(node) { if (ts.isIdentifier(node)) identifiers.add(node.text); ts.forEachChild(node, visit); }
  visit(parse(content + extras));
  const imports = inheritedImports.flatMap(node => {
    const clause = node.importClause;
    if (!clause) return [];
    const defaultName = clause.name && identifiers.has(clause.name.text) ? clause.name : undefined;
    const bindings = clause.namedBindings;
    const elements = bindings && ts.isNamedImports(bindings)
      ? bindings.elements.filter(element => identifiers.has(element.name.text)) : [];
    if (!defaultName && !elements.length) return [];
    const newClause = ts.factory.updateImportClause(clause, clause.isTypeOnly, defaultName,
      elements.length ? ts.factory.createNamedImports(elements) : undefined);
    const target = node.moduleSpecifier.text;
    let specifier = target;
    if (target.startsWith(".")) {
      specifier = path.posix.relative(path.posix.dirname(file), path.posix.normalize(path.posix.join(path.posix.dirname(originalPath), target)));
      if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    }
    return [printer.printNode(ts.EmitHint.Unspecified, ts.factory.updateImportDeclaration(node,
      node.modifiers, newClause, ts.factory.createStringLiteral(specifier), node.attributes), source)];
  });
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${imports.join("\n")}\n${extras}\n${content}\n`);
}

write("src/features/files/types/fileEditorModel.ts", types.map(node => `export ${node.getText()}`).join("\n\n"));
write("src/features/files/lib/fileEditorTheme.ts", `export ${helper.getText()}`);

const navigationParams = ["t", "visibleFile", "revealPath", "editorRef", "markdownNavigationRef",
  "markdownNavigationIdRef", "nextMarkdownModeRef", "pendingMarkdownNavigation",
  "setPendingMarkdownNavigation", "previewMode", "setPreviewMode", "editorReadyNonce"];
write("src/features/files/hooks/useFileEditorMarkdownNavigation.ts", `interface NavigationOptions {
  t: ReturnType<typeof useI18n>["t"];
  visibleFile: ActiveProjectFile | null;
  revealPath: ReturnType<typeof useFileExplorerStore.getState>["revealPath"];
  editorRef: RefObject<MonacoEditor | null>;
  markdownNavigationRef: RefObject<(href: string, mode: MarkdownNavigationMode) => void>;
  markdownNavigationIdRef: RefObject<number>;
  nextMarkdownModeRef: RefObject<{ path: string; mode: MarkdownNavigationMode } | null>;
  pendingMarkdownNavigation: PendingMarkdownNavigation | null;
  setPendingMarkdownNavigation: Dispatch<SetStateAction<PendingMarkdownNavigation | null>>;
  previewMode: MarkdownNavigationMode;
  setPreviewMode: Dispatch<SetStateAction<MarkdownNavigationMode>>;
  editorReadyNonce: number;
}

export function useFileEditorMarkdownNavigation(options: NavigationOptions) {
  const { ${navigationParams.join(", ")} } = options;
  ${navigation}
  return { handleMarkdownLinkActivate, handleMarkdownFragmentHandled };
}`, `import type { Dispatch, RefObject, SetStateAction } from "react";
import type { MonacoEditor, MarkdownNavigationMode, PendingMarkdownNavigation } from "../types/fileEditorModel";`);

const viewNames = ["activeDiff", "t", "visibleFile", "session", "project", "dirty", "previewMode",
  "setPreviewMode", "copyActiveAiPath", "copyActiveAiContext", "save", "requestClose", "visibleFiles",
  "activeFilePath", "diffContext", "diffWorkspace", "setActiveFilePath", "requestCloseFiles", "editorProject",
  "language", "editorTheme", "handleEditorMount", "setActiveContent", "handleMarkdownLinkActivate",
  "pendingMarkdownNavigation", "handleMarkdownFragmentHandled", "pendingAction", "setPendingAction",
  "discardAndRun", "saveAndRun"];
const grouped = names => {
  const lines = []; let line = "";
  for (const name of names) { if (line.length + name.length > 95) { lines.push(line); line = ""; } line += `${name}, `; }
  if (line) lines.push(line);
  return lines.map(line => `    ${line.trimEnd()}`).join("\n");
};
const replacement = `\n  const { handleMarkdownLinkActivate, handleMarkdownFragmentHandled } = useFileEditorMarkdownNavigation({\n${grouped(navigationParams)}\n  });`;
const controlBody = original.slice(component.body.getStart() + 1, body[first].getFullStart())
  + replacement + original.slice(body[last].end, body.at(-1).getFullStart());
write("src/features/files/hooks/useFileEditorController.ts", `configureMonaco();

export function useFileEditorController({ session, isActive, terminalThemeBackground, onClose }: FileEditorPaneProps) {${controlBody}
  return {\n${grouped(viewNames)}\n  };
}`, `import type { FileEditorPaneProps, PendingAction, MonacoEditor, MarkdownNavigationMode, PendingMarkdownNavigation } from "../types/fileEditorModel";
import { isDarkHexColor } from "../lib/fileEditorTheme";
import { useFileEditorMarkdownNavigation } from "./useFileEditorMarkdownNavigation";`);
write("src/features/files/components/FileEditorPaneView.tsx", `type FileEditorPaneViewProps = ReturnType<typeof useFileEditorController>;

export function FileEditorPaneView(props: FileEditorPaneViewProps) {
  const {\n${grouped(viewNames)}\n  } = props;
  ${jsx}
}`, `import type { useFileEditorController } from "../hooks/useFileEditorController";`);
write("src/features/files/components/FileEditorPane.tsx", `export function FileEditorPane(props: FileEditorPaneProps) {
  return <FileEditorPaneView {...useFileEditorController(props)} />;
}`, `import type { FileEditorPaneProps } from "../types/fileEditorModel";
import { useFileEditorController } from "../hooks/useFileEditorController";
import { FileEditorPaneView } from "./FileEditorPaneView";`);
writeFileSync("src/features/files/index.ts", 'export { FileEditorPane } from "./components/FileEditorPane";\n');
writeFileSync(originalPath, 'export { FileEditorPane } from "../../features/files";\n');
