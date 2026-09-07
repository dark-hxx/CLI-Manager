import { readFileSync, writeFileSync } from "node:fs";
const task = ".trellis/tasks/09-07-architecture-convergence";
const { map, aliases } = JSON.parse(readFileSync(`${task}/frontend-ownership-plan.json`, "utf8"));
const edits = JSON.parse(readFileSync(`${task}/frontend-path-edits.json`, "utf8"));
let count = 0;
for (const [file, changes] of Object.entries(edits)) {
  if (aliases[file]) continue;
  let source = readFileSync(map[file], "utf8");
  let changed = false;
  for (const edit of changes) {
    if (!/\.tsx?$/.test(edit.after) || /\.tsx?$/.test(edit.before)) continue;
    const next = edit.after.replace(/\.tsx?$/, "");
    source = source.replaceAll(`"${edit.after}"`, `"${next}"`).replaceAll(`'${edit.after}'`, `'${next}'`);
    edit.after = next;
    changed = true; count++;
  }
  if (changed) writeFileSync(map[file], source);
}
writeFileSync(`${task}/frontend-path-edits.json`, JSON.stringify(edits, null, 2) + "\n");
console.log(`Preserved ${count} extensionless locale/worker imports.`);
