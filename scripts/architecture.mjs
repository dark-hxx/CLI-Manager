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
}).split("\0"))].filter(isSource).filter((file) => existsSync(new URL(`../${file}`, import.meta.url))).sort();
const metrics = [];
const dependencies = [];
const rustRoutes = ["src-tauri/src/lib.rs", "src-tauri/src/commands/mod.rs"].flatMap(file =>
  rustFacadeRoutes(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8")));
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
  const oversized = metrics.filter((metric) => metric.lines > 2000);
  if (flags.has("--report")) {
    console.log("lines\tbytes\t~tokens*\timports\tfile");
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
