import { readFileSync, writeFileSync, readdirSync } from "node:fs";
const task = ".trellis/tasks/09-07-architecture-convergence";
const { map } = JSON.parse(readFileSync(`${task}/frontend-ownership-plan.json`, "utf8"));
const edits = JSON.parse(readFileSync(`${task}/frontend-path-edits.json`, "utf8"));
let count = 0;
for (const file of readdirSync("scripts").filter(file => file.endsWith(".test.mjs"))) {
  const before = readFileSync(`scripts/${file}`, "utf8");
  const owners = Object.keys(map).filter(owner => before.includes(map[owner]));
  const replacements = new Map();
  for (const owner of owners) for (const edit of edits[owner] ?? []) {
    if (!replacements.has(edit.before)) replacements.set(edit.before, new Set());
    replacements.get(edit.before).add(edit.after);
  }
  let after = before;
  for (const [oldValue, values] of replacements) {
    if (values.size !== 1) continue;
    const newValue = [...values][0];
    // Only exact quoted module specifiers used by transpilation stubs; no regex or assertion weakening.
    after = after.replaceAll(`"${oldValue}"`, `"${newValue}"`);
  }
  if (after !== before) { writeFileSync(`scripts/${file}`, after); count++; }
}
console.log(`Updated exact import fixture paths in ${count} tests.`);
