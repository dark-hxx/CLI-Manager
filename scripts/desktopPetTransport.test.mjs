import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-transport-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/lib/desktopPetTransport.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "desktopPetTransport.ts",
}).outputText;
const outputPath = join(tempDir, "desktopPetTransport.mjs");
writeFileSync(outputPath, output, "utf8");
const transport = await import(pathToFileURL(outputPath).href);

function snapshot(overrides = {}) {
  return {
    mood: "working",
    sessionId: "session-1",
    daemonOnly: false,
    sessionTitle: "Task",
    projectName: "Project",
    runningCount: 1,
    attentionCount: 0,
    updatedAt: 1000,
    targets: [{
      sessionId: "session-1",
      daemonOnly: false,
      sessionTitle: "Task",
      projectName: "Project",
      status: "running",
      active: true,
      updatedAt: 1000,
      handoffEligible: false,
      handedOff: false,
      handoffPhase: null,
    }],
    handoff: null,
    handoffPlatforms: [],
    handoffBusy: false,
    ...overrides,
  };
}

test("running output timestamps do not trigger a new desktop pet delivery", () => {
  const first = snapshot();
  const next = snapshot({
    updatedAt: 2000,
    targets: [{ ...first.targets[0], updatedAt: 2000 }],
  });
  assert.equal(
    transport.desktopPetSnapshotFingerprint(first),
    transport.desktopPetSnapshotFingerprint(next),
  );
});

test("visible desktop pet state changes still trigger delivery", () => {
  const first = snapshot();
  const next = snapshot({
    mood: "waiting",
    attentionCount: 1,
    targets: [{ ...first.targets[0], status: "attention" }],
  });
  assert.notEqual(
    transport.desktopPetSnapshotFingerprint(first),
    transport.desktopPetSnapshotFingerprint(next),
  );
});

test("success timestamps remain meaningful for the success timeout", () => {
  const first = snapshot({ mood: "success", updatedAt: 1000 });
  const next = snapshot({ mood: "success", updatedAt: 2000 });
  assert.notEqual(
    transport.desktopPetSnapshotFingerprint(first),
    transport.desktopPetSnapshotFingerprint(next),
  );
});

test("background daemon polling reuses unchanged task arrays", () => {
  const tasks = [{
    sessionId: "session-1",
    cwd: "/work",
    alive: true,
    taskStatus: "running",
    taskUpdatedAtMs: 1000,
    createdAtMs: 500,
  }];
  assert.equal(transport.sameBackgroundPetTasks(tasks, structuredClone(tasks)), true);
  assert.equal(
    transport.sameBackgroundPetTasks(tasks, [{ ...tasks[0], taskStatus: "done" }]),
    false,
  );
});
