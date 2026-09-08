import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GITHUB_UPDATER_URL =
  "https://github.com/dark-hxx/CLI-Manager/releases/latest/download/latest.json";
const INSTALLER_BASE_URL_PATTERN = /^R2_PUBLIC_BASE_URL="[^"]*"$/gm;

// 仅接受无凭据、路径、查询或片段的 HTTPS 源，并规范化尾斜杠。
export function normalizeR2PublicBaseUrl(value) {
  const candidate = value?.trim();
  if (!candidate) {
    throw new Error("R2_PUBLIC_BASE_URL is required");
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("R2_PUBLIC_BASE_URL must be a valid URL");
  }

  const isOriginOnly = candidate === url.origin || candidate === `${url.origin}/`;
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
    || !isOriginOnly
  ) {
    throw new Error(
      "R2_PUBLIC_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment",
    );
  }
  return url.origin;
}

// 从统一 R2 源派生前后端发布环境与保留 GitHub 回退的更新配置。
export function buildReleaseEnvironment(value) {
  const baseUrl = normalizeR2PublicBaseUrl(value);
  const updaterUrl = `${baseUrl}/CLI-Manager/releases/latest/latest.json`;
  const agentManifestUrl =
    `${baseUrl}/CLI-Manager/releases/ssh-agent/latest/ssh-agent-release-manifest.json`;
  return {
    R2_PUBLIC_BASE_URL: baseUrl,
    VITE_R2_PUBLIC_BASE_URL: baseUrl,
    CLI_MANAGER_R2_AGENT_MANIFEST_URL: agentManifestUrl,
    TAURI_CONFIG: JSON.stringify({
      plugins: {
        updater: {
          endpoints: [updaterUrl, GITHUB_UPDATER_URL],
        },
      },
    }),
  };
}

// 将派生发布变量追加到 GitHub Actions 环境文件并返回变量映射。
export async function exportActionsEnvironment(value, environmentFile) {
  if (!environmentFile) {
    throw new Error("GITHUB_ENV is required");
  }
  const environment = buildReleaseEnvironment(value);
  // 将每个环境变量转换为 Actions 接受的单行名称赋值。
  const lines = Object.entries(environment).map(([name, item]) => `${name}=${item}`);
  await appendFile(environmentFile, `${lines.join("\n")}\n`, "utf8");
  return environment;
}

// 要求安装脚本恰有一处 R2 源赋值，再将替换后的副本写入输出路径。
export async function renderInstaller(inputPath, outputPath, value) {
  const baseUrl = normalizeR2PublicBaseUrl(value);
  const source = await readFile(inputPath, "utf8");
  const matches = source.match(INSTALLER_BASE_URL_PATTERN) ?? [];
  if (matches.length !== 1) {
    throw new Error("install-ssh-agent.sh must contain exactly one R2_PUBLIC_BASE_URL assignment");
  }
  const rendered = source.replace(
    INSTALLER_BASE_URL_PATTERN,
    `R2_PUBLIC_BASE_URL="${baseUrl}"`,
  );
  await writeFile(outputPath, rendered, "utf8");
}

// 按 CLI 子命令导出 Actions 变量或渲染安装脚本，拒绝未知操作。
async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "export-actions-env":
      await exportActionsEnvironment(process.env.R2_PUBLIC_BASE_URL, process.env.GITHUB_ENV);
      console.log(
        `Configured release origin: ${normalizeR2PublicBaseUrl(process.env.R2_PUBLIC_BASE_URL)}`,
      );
      break;
    case "render-installer": {
      const [inputPath, outputPath] = args;
      if (!inputPath || !outputPath) {
        throw new Error("usage: r2-release-config.mjs render-installer <input> <output>");
      }
      await renderInstaller(inputPath, outputPath, process.env.R2_PUBLIC_BASE_URL);
      break;
    }
    default:
      throw new Error(
        "usage: r2-release-config.mjs <export-actions-env|render-installer> [input output]",
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
