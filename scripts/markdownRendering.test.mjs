import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/components/ui/MarkdownContent.tsx", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const packageLock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
);

test("shared Markdown renderer enables KaTeX math without enabling raw HTML", () => {
  assert.match(source, /import rehypeKatex from "rehype-katex"/);
  assert.match(source, /import remarkMath from "remark-math"/);
  assert.match(source, /import "katex\/dist\/katex\.min\.css"/);
  assert.match(source, /remarkPlugins=\{remarkPlugins\}/);
  assert.match(source, /rehypePlugins=\{rehypePlugins\}/);
  assert.match(source, /skipHtml/);
});

test("math packages are direct dependencies with lockfile entries", () => {
  assert.equal(packageJson.dependencies["remark-math"], "^6.0.0");
  assert.equal(packageJson.dependencies["rehype-katex"], "^7.0.1");
  assert.equal(packageJson.dependencies.katex, "^0.16.47");

  const rootDependencies = packageLock.packages[""].dependencies;
  assert.equal(rootDependencies["remark-math"], "^6.0.0");
  assert.equal(rootDependencies["rehype-katex"], "^7.0.1");
  assert.equal(rootDependencies.katex, "^0.16.47");
});
