import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";
import { resolveRustFacade, rustReferences } from "./rust.mjs";

export const MAX_LINES = 2000;
export const MAX_LINE_LENGTH = 500;
// Only generated/platform scaffolding and vendored code are exempt. No application domain is exempt.
export const EXCLUDED_PREFIXES = [
  ".trellis/", ".agents/", ".claude/", ".codex/",
  "vendor/", "vendor-patches/", "src-tauri/gen/",
];

// 按扩展名和显式排除目录识别需要结构检查的代码文件。
export function isSource(file) {
  return /\.(?:rs|[cm]?[jt]sx?|css|py|ps1|sh)$/.test(file)
    // 判断文件是否位于工具生成或第三方排除目录。
    && !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

// 计算物理行数、UTF-8 字节与长行摘要，token 数只是字节除四的估算。
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
    // 将每行映射为字符长度以求最长行，空文件长度为零。
    maxLineLength: Math.max(0, ...lines.map((line) => line.length)), longLines,
  };
}

// 按语言提取静态依赖标识，JS/TS 使用语法树，Rust 先屏蔽非代码。
export function imports(file, source) {
  const result = new Set();
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    // 遍历声明、类型导入和字面量动态导入或 require，忽略非字面量依赖。
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        result.add(node.moduleSpecifier.text);
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
        && ts.isStringLiteral(node.argument.literal)) result.add(node.argument.literal.text);
      if (ts.isCallExpression(node) && node.arguments.length > 0
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === "require")
        && ts.isStringLiteral(node.arguments[0])) result.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  } else if (file.endsWith(".css")) {
    for (const match of source.matchAll(/@import\s+["']([^"']+)["']/g)) result.add(match[1]);
  } else if (file.endsWith(".rs")) {
    for (const reference of rustReferences(source)) result.add(reference);
  }
  return [...result];
}

// 从物理路径识别应用、功能、共享或基础设施层及功能域。
function layer(file) {
  const match = /^(src|src-tauri\/src)\/(app|features|shared|infrastructure)(?:\/([^/]+))?/.exec(file);
  return match && { root: match[1], name: match[2], domain: match[2] === "features" ? match[3] : null };
}

// 解析相对路径与兼容入口，报告违反层级或跨功能公开入口规则的依赖。
export function dependencyViolations(file, specifiers, rustRoutes = []) {
  const from = layer(file);
  if (!from) return [];
  const violations = [];
  for (const specifier of specifiers) {
    const facade = specifier.startsWith("crate::") ? resolveRustFacade(specifier, rustRoutes) : null;
    const target = facade?.target ?? (specifier.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
      : specifier.startsWith("@/") ? `src/${specifier.slice(2)}`
        : specifier.startsWith("crate::") ? `src-tauri/src/${specifier.slice(7).replaceAll("::", "/")}` : null);
    if (!target) continue;
    const to = layer(target);
    let reason;
    if (from.root === "src" && /^src\/(?:components|hooks|stores|lib|terminal)\//.test(target)) {
      reason = "new layers cannot depend on retired implementation directories";
    }
    if (from.name === "shared" && to && ["features", "app"].includes(to.name)) reason = "shared cannot depend on app/features";
    if (from.name === "features" && to?.name === "app") reason = "features cannot depend on app";
    if (from.name === "features" && to?.name === "features" && from.domain !== to.domain) {
      const entry = `${to.root}/features/${to.domain}`;
      // Rust's public entry exports named items via crate::features::domain::item.
      const rustPublicItem = to.root === "src-tauri/src" && (Boolean(facade) || target.slice(entry.length + 1).split("/").length === 1);
      const relativeEntry = target.slice(entry.length + 1);
      const frontendPublicModule = to.root === "src" && (
        /^(?:index|state)(?:\.tsx?)?$/.test(relativeEntry)
        || /^api\/[^/]+(?:\.tsx?)?$/.test(relativeEntry)
      );
      if (target !== entry && !rustPublicItem && !frontendPublicModule) {
        reason = "cross-feature imports must use a public entry";
      }
    }
    if (reason) violations.push(`${file} -> ${specifier}: ${reason}`);
  }
  return violations;
}

// 仅保留已有超行数及长行债务，生成迁移基线。
export function baselineFor(metrics) {
  // 将有存量违规的文件度量映射为基线项，无违规文件不写入。
  return Object.fromEntries(metrics.flatMap((metric) => {
    const entry = {};
    if (metric.lines > MAX_LINES) entry.lines = metric.lines;
    if (Object.keys(metric.longLines).length) entry.longLines = metric.longLines;
    return Object.keys(entry).length ? [[metric.file, entry]] : [];
  }));
}

// 检查文件行数和长行出现次数是否超出硬限制或已有基线。
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
