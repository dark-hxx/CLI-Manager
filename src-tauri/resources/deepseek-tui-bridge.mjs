/** CLI-Manager host adapter for the verified dsh-TUI 0.12 Channel read contract.
 * Reads only the foreground Session UUID; no agent actions or shared last-session file.
 * The internal registry is version-gated by native preflight and shares the TUI's
 * composition-root identity. Changes in this upstream seam must fail explicitly.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "cli-manager-deepseek-tui-bridge";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Subscribe to registration identity and the active channel, releasing both on dispose. */
export function attachDeepSeekTuiBridge(ctx, registry, env = process.env, write = (text) => process.stdout.write(text)) {
  const terminalId = env.CLI_MANAGER_TAB_ID;
  if (!UUID.test(terminalId ?? "")) return () => undefined;
  let channelRelease;
  let registration;
  let lastSessionId;
  let disposed = false;
  const releaseChannel = () => {
    channelRelease?.();
    channelRelease = undefined;
  };
  const observe = () => {
    if (disposed || registry.getTuiChannelRegistration(ctx)?.token !== registration?.token) return;
    const sessionId = registration?.channel?.sessionId;
    if (typeof sessionId !== "string" || !UUID.test(sessionId) || sessionId === lastSessionId) return;
    lastSessionId = sessionId;
    write(`\x1b]777;cli-manager-dsh-tui;${terminalId};${sessionId}\x07`);
  };
  const bind = (next) => {
    if (disposed || next?.token === registration?.token) return;
    releaseChannel();
    registration = next;
    lastSessionId = undefined;
    if (!next) return;
    if (typeof next.channel?.subscribe !== "function") throw new Error("deepseek_tui_bridge_unsupported");
    channelRelease = next.channel.subscribe(observe);
    observe();
  };
  const releaseRegistration = registry.onTuiChannelRegistration(ctx, bind);
  bind(registry.getTuiChannelRegistration(ctx));
  return () => {
    if (disposed) return;
    disposed = true;
    releaseRegistration();
    releaseChannel();
  };
}

export async function apply(ctx) {
  if (!UUID.test(process.env.CLI_MANAGER_TAB_ID ?? "")) return;
  const rawHome = process.env.DSH_HOME ?? "";
  const selectedHome = rawHome.trim() ? rawHome : "";
  const home = selectedHome === "~" ? homedir()
    : /^~[\\/]/.test(selectedHome) ? join(homedir(), selectedHome.slice(2))
    : selectedHome || join(homedir(), ".dsh");
  const profile = join(home, "profiles", "dsh-tui");
  const require = createRequire(pathToFileURL(join(profile, "package.json")));
  const packageFile = require.resolve("@deepseek-harness-tui/dsh-tui/package.json");
  const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
  if (!/^0\.12\.\d+(?:[-+].*)?$/.test(manifest.version ?? "")) throw new Error("deepseek_tui_bridge_unsupported");
  const registryUrl = new URL("./lib/types/adapter/channel/host-registry.js", pathToFileURL(packageFile));
  const registry = await import(registryUrl.href);
  if (typeof registry.getTuiChannelRegistration !== "function" || typeof registry.onTuiChannelRegistration !== "function") {
    throw new Error("deepseek_tui_bridge_unsupported");
  }
  const dispose = attachDeepSeekTuiBridge(ctx, registry);
  ctx.effect(() => dispose);
}
