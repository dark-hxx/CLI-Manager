// One-time mechanical extraction. Requires the original monoliths; refuses to overwrite outputs.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import postcss from "postcss";

const root = process.cwd();
const outputs = new Map();
const original = readFileSync("src/lib/i18n.ts", "utf8");
const ast = ts.createSourceFile("i18n.ts", original, ts.ScriptTarget.Latest, true);
const declarations = new Map();
for (const statement of ast.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  for (const declaration of statement.declarationList.declarations) {
    if (["zh", "en"].includes(declaration.name.getText(ast))) declarations.set(declaration.name.getText(ast), { statement, declaration });
  }
}
assert.equal(declarations.size, 2);
const groups = {};
const domainMap = {
  sidebar: "projects", configModal: "projects", groupEdit: "projects", worktree: "projects", batchShell: "projects",
  history: "history", historySources: "history", externalSessionSync: "history", subagentTranscript: "history",
  providerCatalog: "providers", providerSwitch: "providers", providerQuickSwitch: "providers",
  terminal: "terminal", aiReplay: "terminal", termStats: "terminal", saveSession: "terminal", fontSize: "terminal",
  desktopPet: "desktop-pet", git: "git", files: "files", stats: "analytics", ccusage: "analytics", requestLogs: "analytics",
  remoteHandoff: "agent-integrations", notifications: "agent-integrations", remoteCapabilities: "agent-integrations",
  commandTemplate: "command-tools", commandHistory: "command-tools", systemResources: "analytics",
};
function domain(key) {
  const [prefix, section] = key.split(".");
  if (prefix === "settings") {
    if (section === "sshHosts") return "ssh";
    if (["ccConnect", "hooks", "statusline", "statuslineProfiles", "codexStatusline"].includes(section)) return "agent-integrations";
    if (section === "sync") return "sync";
    return "settings";
  }
  return domainMap[prefix] ?? "common";
}
const originalMaps = {};
for (const [locale, { declaration }] of declarations) {
  const object = ts.isAsExpression(declaration.initializer) ? declaration.initializer.expression : declaration.initializer;
  assert.ok(ts.isObjectLiteralExpression(object));
  originalMaps[locale] = {};
  for (const property of object.properties) {
    assert.ok(ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name) && ts.isStringLiteral(property.initializer));
    const key = property.name.text;
    assert.ok(!(key in originalMaps[locale]), `duplicate ${key}`);
    originalMaps[locale][key] = property.initializer.text;
    const group = domain(key);
    groups[group] ??= { zh: [], en: [] };
    const value = property.initializer.text;
    const text = property.getText(ast);
    if (text.split(/\r?\n/).some((line) => line.length > 480)) {
      const parts = Array.from(value).reduce((all, character) => {
        if (!all.length || all.at(-1).length >= 140) all.push("");
        all[all.length - 1] += character;
        return all;
      }, []);
      groups[group][locale].push(`  ${JSON.stringify(key)}:\n    ${parts.map((part) => JSON.stringify(part)).join(" +\n    ")},`);
    } else groups[group][locale].push(`  ${text},`);
  }
}
assert.deepEqual(Object.keys(originalMaps.zh).sort(), Object.keys(originalMaps.en).sort());
const imports = [];
for (const group of Object.keys(groups).sort()) {
  const identifier = group.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  const base = `src/shared/i18n/messages/${group}`;
  outputs.set(`${base}.zh-CN.ts`, `export const zh = {\n${groups[group].zh.join("\n")}\n} as const;\n`);
  outputs.set(`${base}.en-US.ts`, `import type { zh } from "./${group}.zh-CN";\n\nexport const en: Record<keyof typeof zh, string> = {\n${groups[group].en.join("\n")}\n};\n`);
  imports.push(`import { zh as ${identifier}Zh } from "./messages/${group}.zh-CN";`, `import { en as ${identifier}En } from "./messages/${group}.en-US";`);
}
const ids = Object.keys(groups).sort().map((group) => group.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()));
outputs.set("src/shared/i18n/catalogs.ts", `${imports.join("\n")}\n\nexport const zh = {\n${ids.map((id) => `  ...${id}Zh,`).join("\n")}\n} as const;\n\nexport const en: Record<keyof typeof zh, string> = {\n${ids.map((id) => `  ...${id}En,`).join("\n")}\n};\n`);
let runtime = original;
for (const { statement } of [...declarations.values()].reverse()) runtime = runtime.slice(0, statement.getStart(ast)) + runtime.slice(statement.end);
outputs.set("src/lib/i18n.ts", `import { zh, en } from "../shared/i18n/catalogs";\n${runtime}`);

const cssFile = "src/styles/components.css";
const css = readFileSync(cssFile, "utf8");
const parsed = postcss.parse(css);
const sections = [
  [1, "surfaces-command-panels"], [524, "terminal-empty-tabs"], [1101, "project-tree"],
  [2090, "focus-controls"], [3213, "history-scroll-markdown"], [4268, "history-transcript-diff"],
  [4545, "workspace-chrome"], [5176, "terminal-actions-panes"], [5980, "notifications-actions"],
  [6350, "history-messages"], [6923, "history-transcript"], [7179, "history-tabs-canvas"],
  [7603, "history-process"], [7937, "history-files"], [8132, "terminal-background"], [8342, "file-editor"],
];
// Resolve section starts to complete top-level CSS nodes (never split a rule or media query).
const starts = sections.map(([line]) => parsed.nodes.findIndex((node) => node.source.start.line >= line));
const extractedRules = [];
for (let i = 0; i < sections.length; i++) {
  const nodes = parsed.nodes.slice(starts[i], starts[i + 1] ?? parsed.nodes.length);
  const content = nodes.map((node) => node.raws.before + node.toString()).join("").trimStart() + "\n";
  assert.ok(content.split(/\r?\n/).length <= 2000);
  const moved = content.replaceAll('url("../../src-tauri/', 'url("../../../src-tauri/');
  outputs.set(`src/styles/components/${sections[i][1]}.css`, moved);
  extractedRules.push(...postcss.parse(moved.replaceAll('url("../../../src-tauri/', 'url("../../src-tauri/')).nodes.map((node) => node.toString()));
}
assert.deepEqual(extractedRules, parsed.nodes.map((node) => node.toString()), "CSS rule order/content changed");
outputs.set(cssFile, sections.map(([, name]) => `@import "./components/${name}.css";`).join("\n") + "\n");

// Evaluate only emitted literal dictionary declarations to verify exact maps before writing.
for (const locale of ["zh", "en"]) {
  const reconstructed = {};
  for (const group of Object.keys(groups)) {
    const body = groups[group][locale].join("\n");
    Object.assign(reconstructed, Function(`"use strict"; return ({${body}});`)());
  }
  assert.deepEqual(reconstructed, originalMaps[locale], `${locale} dictionary changed`);
}
for (const [file, content] of outputs) {
  assert.ok(content.split(/\r?\n/).length <= 2000, file);
  if (!["src/lib/i18n.ts", cssFile].includes(file)) assert.ok(!existsSync(file), `output exists: ${file}`);
}
for (const [file, content] of outputs) {
  const target = path.resolve(root, file);
  assert.ok(target.startsWith(root + path.sep));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}
console.log(`Extracted ${outputs.size} files; ${Object.keys(originalMaps.zh).length} keys per language and ${parsed.nodes.length} ordered CSS nodes verified equal.`);
