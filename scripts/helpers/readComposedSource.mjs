import { readFileSync as readRaw } from "node:fs";
import { fileURLToPath } from "node:url";

// Source-contract tests inspect the actual composition graph, not an obsolete monolithic file.
export function readFileSync(file, encoding = "utf8") {
  const source = readRaw(file, encoding);
  const pathname = file instanceof URL ? fileURLToPath(file).replaceAll("\\", "/") : String(file).replaceAll("\\", "/");
  if (pathname.endsWith("/src/styles/components.css")) {
    return source.replace(/@import\s+"([^"]+)";/g, (_, specifier) => readRaw(new URL(specifier, file), encoding));
  }
  if (pathname.endsWith("/src/shared/i18n/index.ts")) {
    const catalogUrl = new URL("./catalogs.ts", file);
    const catalog = readRaw(catalogUrl, encoding);
    const dictionaries = [...catalog.matchAll(/import \{ (?:zh|en) as \w+ \} from "([^"]+)";/g)]
      .map(([, specifier]) => readRaw(new URL(`${specifier}.ts`, catalogUrl), encoding));
    return [source, catalog, ...dictionaries].join("\n");
  }
  return source;
}
