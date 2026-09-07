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

test("provider detail close hands focus to the catalog page instead of its row", () => {
  const pageSource = read("../src/components/settings/pages/NativeProviderSettingsPage.tsx");
  const detailModalSource = read("../src/components/settings/providers/NativeProviderDetailModal.tsx");
  const formModalSource = read("../src/components/settings/providers/NativeProviderFormModal.tsx");

  assert.match(detailModalSource, /returnFocus=\{false\}/);
  assert.match(detailModalSource, /onExitTransitionEnd=\{onExitTransitionEnd\}/);
  assert.match(
    pageSource,
    /const focusCatalogPage = useCallback\(\(\) => \{[\s\S]*?detailCloseFocusRef\.current[\s\S]*?activeSurfaceControl\?\.focus\(\{ preventScroll: true \}\);[\s\S]*?\}, \[surface\]\);/,
  );
  assert.match(
    pageSource,
    /const surfaceNavigationRef = useRef<HTMLDivElement \| null>\(null\);/,
  );
  assert.match(pageSource, /input\[type="radio"\]:checked/);
  assert.match(pageSource, /<Stack ref=\{pageRef\} gap="md">/);
  assert.match(pageSource, /<SegmentedControl\s+ref=\{surfaceNavigationRef\}/);
  assert.doesNotMatch(pageSource, /page\.focus\(\{ preventScroll: true \}\)/);
  assert.match(pageSource, /onExitTransitionEnd=\{focusCatalogPage\}/);
  assert.doesNotMatch(formModalSource, /returnFocus=\{false\}/);
});
