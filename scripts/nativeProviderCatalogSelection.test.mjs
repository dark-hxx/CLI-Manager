import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("provider catalog only marks a row selected while its detail dialog is open", () => {
  const pageSource = read("../src/components/settings/pages/NativeProviderSettingsPage.tsx");
  const cardSource = read("../src/components/settings/providers/NativeProviderCard.tsx");

  assert.match(
    pageSource,
    /selectedProviderId=\{detailOpened \? catalog\.selectedProviderId : null\}/,
  );
  assert.match(cardSource, /aria-current=\{selected \? "true" : undefined\}/);
});
