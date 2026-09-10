import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// 独立加载真实 store/Worker 调用方；仅替换平台 I/O，保留 Zustand 和领域逻辑。
export function createGitModuleLoader(overrides = {}) {
  const cache = new Map();
  const nativeRequire = createRequire(import.meta.url);
  return function load(file) {
    const absolute = resolve(file);
    if (absolute in overrides) return overrides[absolute];
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const source = readFileSync(absolute, "utf8").replaceAll("import.meta.url", JSON.stringify(pathToFileURL(absolute).href));
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const require = specifier => specifier.startsWith(".")
      ? load(resolve(dirname(absolute), /\.tsx?$/.test(specifier) ? specifier : `${specifier}.ts`))
      : nativeRequire(specifier);
    new Function("require", "module", "exports", output)(require, module, module.exports);
    return module.exports;
  };
}
