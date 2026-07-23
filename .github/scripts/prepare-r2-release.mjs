import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const [inputDir, outputDir, publicBaseUrl, tag] = process.argv.slice(2);

if (![inputDir, outputDir, publicBaseUrl, tag].every(Boolean)) {
  throw new Error("usage: prepare-r2-release.mjs <input-dir> <output-dir> <public-base-url> <tag>");
}

const baseUrl = new URL(publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`);
if (baseUrl.protocol !== "https:" || baseUrl.search || baseUrl.hash || baseUrl.username || baseUrl.password) {
  throw new Error("R2 public base URL must be an HTTPS URL without credentials, query, or fragment");
}

const releaseUrl = (name) => new URL(`CLI-Manager/releases/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`, baseUrl).toString();

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function copyReleaseFiles() {
  await mkdir(outputDir, { recursive: true });
  const entries = await readdir(inputDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    await copyFile(join(inputDir, entry.name), join(outputDir, entry.name));
  }
}

async function rewriteDesktopManifest() {
  const path = join(outputDir, "latest.json");
  const value = await readJson(path);
  if (!value.platforms || typeof value.platforms !== "object") {
    throw new Error("Tauri latest.json has no platforms object");
  }
  for (const [platform, update] of Object.entries(value.platforms)) {
    if (!update || typeof update.url !== "string") {
      throw new Error(`Tauri latest.json platform is missing url: ${platform}`);
    }
    update.url = releaseUrl(basename(new URL(update.url).pathname));
  }
  await writeJson(path, value);
}

async function rewriteAgentManifest() {
  const path = join(outputDir, "ssh-agent-release-manifest.json");
  const value = await readJson(path);
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    throw new Error("SSH Agent release manifest has no artifacts");
  }
  for (const artifact of value.artifacts) {
    if (typeof artifact.url !== "string" || !artifact.url) {
      throw new Error("SSH Agent artifact is missing url");
    }
    artifact.url = releaseUrl(basename(new URL(artifact.url).pathname));
  }
  await writeJson(path, value);
}

await copyReleaseFiles();

const sourceFiles = await Promise.all(
  ["latest.json", "ssh-agent-release-manifest.json"].map(async (name) => {
    try {
      return (await stat(join(inputDir, name))).isFile();
    } catch {
      return false;
    }
  }),
);

if (sourceFiles[0]) await rewriteDesktopManifest();
if (sourceFiles[1]) await rewriteAgentManifest();

console.log(`Prepared R2 release copy for ${tag}: ${sourceFiles.filter(Boolean).length} manifest(s)`);
