import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const { map } = JSON.parse(readFileSync(".trellis/tasks/09-07-architecture-convergence/frontend-ownership-plan.json", "utf8"));
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory()
  ? walk(`${dir}/${item.name}`) : [`${dir}/${item.name}`]);
let count = 0;
for (const file of ["AGENTS.md", ...walk(".trellis/spec").filter(file => file.endsWith(".md"))]) {
  const before = readFileSync(file, "utf8");
  let after = before;
  for (const [oldPath, newPath] of Object.entries(map)) if (oldPath !== newPath) after = after.replaceAll(oldPath, newPath);
  if (after !== before) { writeFileSync(file, after); count++; }
}
console.log(`Updated exact source-owner paths in ${count} instruction/spec files; historical task records retained.`);
