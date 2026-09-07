import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";

export const MAX_LINES = 2000;
export const MAX_LINE_LENGTH = 500;
// Only generated/platform scaffolding and vendored code are exempt. No application domain is exempt.
export const EXCLUDED_PREFIXES = [
  ".trellis/", ".agents/", ".claude/", ".codex/",
  "vendor/", "vendor-patches/", "src-tauri/gen/",
];

export function isSource(file) {
  return /\.(?:rs|[cm]?[jt]sx?|css|py|ps1|sh)$/.test(file)
    && !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export function measure(file, source) {
  const lines = source === "" ? [] : source.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const longLines = {};
  for (const line of lines) {
    if (line.length <= MAX_LINE_LENGTH) continue;
    const hash = createHash("sha256").update(line.trim()).digest("hex").slice(0, 16);
    longLines[hash] = (longLines[hash] ?? 0) + 1;
  }
  return {
    file, lines: lines.length, bytes: Buffer.byteLength(source),
    estimatedTokens: Math.ceil(Buffer.byteLength(source) / 4),
    maxLineLength: Math.max(0, ...lines.map((line) => line.length)), longLines,
  };
}

export function imports(file, source) {
  const result = new Set();
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        result.add(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.arguments.length > 0
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === "require")
        && ts.isStringLiteral(node.arguments[0])) result.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  } else if (file.endsWith(".css")) {
    for (const match of source.matchAll(/@import\s+["']([^"']+)["']/g)) result.add(match[1]);
  } else if (file.endsWith(".rs")) {
    for (const match of source.matchAll(/\bcrate::(app|features|shared|infrastructure)::([\w:]+)/g)) {
      result.add(`crate::${match[1]}::${match[2]}`);
    }
  }
  return [...result];
}

function layer(file) {
  const match = /^(src|src-tauri\/src)\/(app|features|shared|infrastructure)(?:\/([^/]+))?/.exec(file);
  return match && { root: match[1], name: match[2], domain: match[2] === "features" ? match[3] : null };
}

export function dependencyViolations(file, specifiers) {
  const from = layer(file);
  if (!from) return [];
  const violations = [];
  for (const specifier of specifiers) {
    const target = specifier.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
      : specifier.startsWith("@/") ? `src/${specifier.slice(2)}`
        : specifier.startsWith("crate::") ? `src-tauri/src/${specifier.slice(7).replaceAll("::", "/")}` : null;
    if (!target) continue;
    const to = layer(target);
    let reason;
    if (from.name === "shared" && to && ["features", "app"].includes(to.name)) reason = "shared cannot depend on app/features";
    if (from.name === "features" && to?.name === "app") reason = "features cannot depend on app";
    if (from.name === "features" && to?.name === "features" && from.domain !== to.domain) {
      const entry = `${to.root}/features/${to.domain}`;
      // Rust's public entry exports named items via crate::features::domain::item.
      const rustPublicItem = to.root === "src-tauri/src" && target.slice(entry.length + 1).split("/").length === 1;
      if (target !== entry && !rustPublicItem && ![`${entry}/index`, `${entry}/index.ts`, `${entry}/index.tsx`].includes(target)) {
        reason = "cross-feature imports must use a public entry";
      }
    }
    if (reason) violations.push(`${file} -> ${specifier}: ${reason}`);
  }
  return violations;
}

export function baselineFor(metrics) {
  return Object.fromEntries(metrics.flatMap((metric) => {
    const entry = {};
    if (metric.lines > MAX_LINES) entry.lines = metric.lines;
    if (Object.keys(metric.longLines).length) entry.longLines = metric.longLines;
    return Object.keys(entry).length ? [[metric.file, entry]] : [];
  }));
}

export function checkMetrics(metrics, baseline = {}) {
  const errors = [];
  for (const metric of metrics) {
    const allowed = baseline[metric.file] ?? {};
    if (metric.lines > Math.max(MAX_LINES, allowed.lines ?? 0)) errors.push(`${metric.file}: ${metric.lines} lines (limit ${allowed.lines ?? MAX_LINES})`);
    for (const [hash, count] of Object.entries(metric.longLines)) {
      if (count > (allowed.longLines?.[hash] ?? 0)) errors.push(`${metric.file}: new/duplicated line over ${MAX_LINE_LENGTH} characters (${hash})`);
    }
  }
  return errors;
}
