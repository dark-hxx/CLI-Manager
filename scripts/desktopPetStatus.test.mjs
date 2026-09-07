import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-status-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/features/desktop-pet/lib/desktopPetStatus.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "desktopPetStatus.ts",
}).outputText;
const outputPath = join(tempDir, "desktopPetStatus.mjs");
writeFileSync(outputPath, output, "utf8");
const status = await import(pathToFileURL(outputPath).href);

function resolve(overrides = {}) {
  return status.resolveDesktopPetOpenSessionStatus({
    frontendStatus: "none",
    outputActivityAt: 0,
    now: 10_000,
    ...overrides,
  });
}

test("explicit completed and failed states cannot be reopened by later PTY output", () => {
  assert.deepEqual(resolve({
    frontendStatus: "done",
    frontendDetails: { status: "done", updatedAt: new Date(8_000).toISOString() },
    outputActivityAt: 9_500,
  }), { status: "done", updatedAt: 8_000 });
  assert.deepEqual(resolve({
    frontendStatus: "failed",
    frontendDetails: { status: "failed", updatedAt: new Date(8_500).toISOString() },
    outputActivityAt: 9_800,
  }), { status: "failed", updatedAt: 8_500 });
});

test("attention and daemon lifecycle states remain authoritative", () => {
  assert.deepEqual(resolve({
    frontendStatus: "attention",
    frontendDetails: { status: "attention", updatedAt: new Date(9_000).toISOString() },
    outputActivityAt: 9_900,
  }), { status: "attention", updatedAt: 9_000 });
  assert.deepEqual(resolve({
    daemonTask: {
      sessionId: "session-1",
      alive: true,
      taskStatus: "done",
      taskUpdatedAtMs: 9_200,
      createdAtMs: 1_000,
    },
    outputActivityAt: 9_900,
  }), { status: "done", updatedAt: 9_200 });
});

test("recent PTY output only supplies a short-lived hint when no lifecycle state exists", () => {
  assert.deepEqual(resolve({ outputActivityAt: 9_500 }), {
    status: "running",
    updatedAt: 9_500,
  });
  assert.deepEqual(resolve({ outputActivityAt: 3_999 }), {
    status: "none",
    updatedAt: 0,
  });
});
