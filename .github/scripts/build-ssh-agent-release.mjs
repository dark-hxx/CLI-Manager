import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const [version, tag, outputDir, x64Input, arm64Input] = process.argv.slice(2);
if (![version, tag, outputDir, x64Input, arm64Input].every(Boolean)) {
  throw new Error("usage: build-ssh-agent-release.mjs <version> <tag> <output-dir> <x64-bin> <arm64-bin>");
}
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("invalid agent version");
}
const desktopTag = /^V\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
if (tag !== `ssh-agent-v${version}` && !desktopTag.test(tag)) {
  throw new Error("release tag must be a desktop V tag or match ssh-agent-v<version>");
}

await mkdir(outputDir, { recursive: true });
const repository = process.env.GITHUB_REPOSITORY || "dark-hxx/CLI-Manager";
const releaseBase = `https://github.com/${repository}/releases/download/${tag}`;
const [trustedKey, tauriConfigText, installerText] = await Promise.all([
  readFile("src-tauri/ssh-agent-public-key.txt", "utf8"),
  readFile("src-tauri/tauri.conf.json", "utf8"),
  readFile("scripts/install-ssh-agent.sh", "utf8"),
]);
const tauriConfig = JSON.parse(tauriConfigText);
const updaterKey = Buffer.from(tauriConfig.plugins.updater.pubkey, "base64").toString("utf8");
const normalizeKey = (value) => value.replace(/\r\n/g, "\n").trim();
const normalizedTrustedKey = normalizeKey(trustedKey);
const publicKeyLine = normalizedTrustedKey.split("\n")[1];
const installerKey = installerText.match(/^PUBLIC_KEY="([^"]+)"$/m)?.[1];
if (normalizeKey(updaterKey) !== normalizedTrustedKey || installerKey !== publicKeyLine) {
  throw new Error("SSH Agent, installer, and Tauri updater public keys must match");
}

async function artifact(target, input) {
  const name = `cli-manager-ssh-agent-${target}`;
  const output = join(outputDir, name);
  await copyFile(input, output);
  const [bytes, metadata] = await Promise.all([readFile(output), stat(output)]);
  return {
    target,
    url: `${releaseBase}/${basename(output)}`,
    size: metadata.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const artifacts = await Promise.all([
  artifact("linux-x86_64", x64Input),
  artifact("linux-aarch64", arm64Input),
]);
const manifest = {
  schemaVersion: 1,
  channel: "temp",
  version,
  protocolMin: 1,
  protocolMax: 1,
  publishedAt: new Date().toISOString(),
  artifacts,
};
await writeFile(
  join(outputDir, "ssh-agent-release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
