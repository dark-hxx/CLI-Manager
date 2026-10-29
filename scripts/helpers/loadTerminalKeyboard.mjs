import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);
const modules = new Map();

// Run the actual TypeScript modules with the installed xterm, without a browser
// or generated files in the worktree. Type-only imports disappear at transpile.
export function loadKeyboardModule(name) {
  return loadSourceModule(new URL(`../../src/shared/lib/${name}.ts`, import.meta.url));
}

export function loadSourceModule(url) {
  const path = url instanceof URL ? fileURLToPath(url) : url;
  if (modules.has(path)) return modules.get(path);
  const source = readFileSync(path, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  new Function("require", "exports", outputText)(
    (id) => id.startsWith(".") ? loadSourceModule(resolve(dirname(path), `${id}.ts`)) : require(id), exports,
  );
  modules.set(path, exports);
  return exports;
}

export const { Terminal } = require("@xterm/xterm");
export const { SerializeAddon } = require("@xterm/addon-serialize");
export const write = (terminal, data) => new Promise((resolve) => terminal.write(data, resolve));
