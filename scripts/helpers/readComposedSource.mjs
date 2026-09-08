import { readFileSync as readRaw } from "node:fs";
import { fileURLToPath } from "node:url";

// Source-contract tests inspect the actual composition graph, not an obsolete monolithic file.
// 按实际组合关系读取源码，展开组件样式及翻译字典供契约断言使用。
export function readFileSync(file, encoding = "utf8") {
  const source = readRaw(file, encoding);
  const pathname = file instanceof URL ? fileURLToPath(file).replaceAll("\\", "/") : String(file).replaceAll("\\", "/");
  if (pathname.endsWith("/src/styles/components.css")) {
    // 将每条样式导入替换为相应文件内容，保持导入顺序。
    return source.replace(/@import\s+"([^"]+)";/g, (_, specifier) => readRaw(new URL(specifier, file), encoding));
  }
  if (pathname.endsWith("/src/shared/i18n/index.ts")) {
    const catalogUrl = new URL("./catalogs.ts", file);
    const catalog = readRaw(catalogUrl, encoding);
    const dictionaries = [...catalog.matchAll(/import \{ (?:zh|en) as \w+ \} from "([^"]+)";/g)]
      // 读取翻译目录中每个导入的字典实现。
      .map(([, specifier]) => readRaw(new URL(`${specifier}.ts`, catalogUrl), encoding));
    return [source, catalog, ...dictionaries].join("\n");
  }
  return source;
}
