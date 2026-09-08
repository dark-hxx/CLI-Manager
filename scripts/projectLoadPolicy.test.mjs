import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveProjectFetchPolicy,
  shouldSidebarBootstrapProjects,
} from "../src/features/projects/lib/projectLoadPolicy.ts";

test("startup project fetch policy skips expensive diagnostics", () => {
  assert.deepEqual(resolveProjectFetchPolicy("startup"), {
    includePathHealth: false,
    refreshProviderBadges: false,
  });
});

test("interactive project fetch policy keeps full diagnostics", () => {
  assert.deepEqual(resolveProjectFetchPolicy("interactive"), {
    includePathHealth: true,
    refreshProviderBadges: true,
  });
});

test("sidebar bootstraps projects only when project store is not loaded", () => {
  assert.equal(shouldSidebarBootstrapProjects(false), true);
  assert.equal(shouldSidebarBootstrapProjects(true), false);
});
