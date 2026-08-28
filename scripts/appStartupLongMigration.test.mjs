import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../src/App.tsx");
const i18n = read("../src/lib/i18n.ts");

test("slow startup work remains a loading state instead of becoming a false failure", () => {
  assert.match(app, /setStartupStageSlow\(true\)/);
  assert.match(app, /Application startup stage is still running/);
  assert.doesNotMatch(app, /setInitError\(`startup_timeout:/);
  assert.doesNotMatch(app, /Application startup stage timed out/);
});

test("database migration has a distinct stage and a bilingual long-running notice", () => {
  assert.match(app, /runStartupStage\("database"/);
  assert.match(app, /t\("app\.init\.loadingDatabase"\)/);
  assert.match(app, /t\("app\.init\.loadingDatabaseSlow"\)/);
  assert.equal((i18n.match(/"app\.init\.loadingDatabase"/g) ?? []).length, 2);
  assert.equal((i18n.match(/"app\.init\.loadingDatabaseSlow"/g) ?? []).length, 2);
});
