import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { baselineFor, checkMetrics, dependencyViolations, imports, isSource, measure } from "./architecture/core.mjs";
import { rustFacadeRoutes } from "./architecture/rust.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (!["--report", "--strict", "--baseline-json"].includes(flag)) throw new Error(`Unknown architecture option: ${flag}`);
}
// Include non-ignored new source files so an untracked implementation cannot bypass the check.
const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
// 在 Git 跟踪及未忽略候选中只保留磁盘仍存在的代码文件。
}).split("\0"))].filter(isSource).filter((file) => existsSync(new URL(`../${file}`, import.meta.url))).sort();
const metrics = [];
const dependencies = [];
// 从两个 Rust 注册入口展开物理实现路由。
const rustRoutes = ["src-tauri/src/lib.rs", "src-tauri/src/commands/mod.rs"].flatMap(file =>
  rustFacadeRoutes(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8")));
// 按命名空间前缀从长到短排序，优先匹配具体入口。
rustRoutes.sort((a,b) => b.prefix.length - a.prefix.length);
for (const file of files) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const specifiers = imports(file, source);
  metrics.push({ ...measure(file, source), dependencies: specifiers.length });
  dependencies.push(...dependencyViolations(file, specifiers, rustRoutes));
}
if (flags.has("--baseline-json")) {
  console.log(JSON.stringify({ version: 1, files: baselineFor(metrics) }, null, 2));
} else {
  const baseline = flags.has("--strict") ? {} : JSON.parse(readFileSync(new URL("./architecture/baseline.json", import.meta.url), "utf8")).files;
  const errors = [...checkMetrics(metrics, baseline), ...dependencies];
  // 筛选物理行数超过硬上限的文件用于汇总。
  const oversized = metrics.filter((metric) => metric.lines > 2000);
  if (flags.has("--report")) {
    console.log("lines\tbytes\t~tokens*\timports\tfile");
    // 筛选大文件并按行数降序报告，过滤和排序回调不修改度量。
    for (const metric of metrics.filter((item) => item.lines > 1200).sort((a, b) => b.lines - a.lines)) {
      console.log(`${metric.lines}\t${metric.bytes}\t${metric.estimatedTokens}\t${metric.dependencies}\t${metric.file}`);
    }
    console.log("* UTF-8 bytes / 4 is a sizing heuristic, not tokenizer billing.");
  }
  console.log(`Architecture: ${files.length} source files; ${oversized.length} above 2000 lines; ${errors.length} new violations${flags.has("--strict") ? " (strict)" : " (migration baseline)"}.`);
  if (errors.length) {
    for (const error of errors.slice(0, 40)) console.error(error);
    if (errors.length > 40) console.error(`... ${errors.length - 40} more violations`);
    if (!flags.has("--report")) process.exitCode = 1;
  }
}
