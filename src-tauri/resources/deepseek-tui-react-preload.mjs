import { registerHooks, createRequire } from "node:module";
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const packageName = "@deepseek-harness-tui/dsh-tui";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function targetsTuiProfile() {
  const args = process.argv.slice(2);
  let selected = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") break;
    if (arg === "--profile") { selected = args[++index] === "dsh-tui"; continue; }
    if (arg.startsWith("--profile=")) { selected = arg.slice(10) === "dsh-tui"; continue; }
    if (["--patch", "--from-default-profile"].includes(arg)) { index++; continue; }
    if (["--version", "-V", "--dump-config", "--dump-default-config", "--dump-config-schema"].includes(arg)) return false;
    if (index === 0 && arg === "plugin") return false;
  }
  return selected;
}
function hostAnchor() {
  if (!UUID.test(process.env.CLI_MANAGER_TAB_ID ?? "") || !process.argv[1] || !targetsTuiProfile()) return;
  let directory;
  try { directory = dirname(realpathSync(resolve(process.argv[1]))); } catch { return; }
  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      try { return JSON.parse(readFileSync(manifest, "utf8")).name === "@deepseek-ai/dsh" ? manifest : undefined; } catch { return; }
    }
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
function install(anchor) {
  if (!anchor) return;
  const rawHome = process.env.DSH_HOME ?? "";
  const selectedHome = rawHome.trim() ? rawHome : "";
  const home = selectedHome === "~" ? homedir()
    : /^~[\\/]/.test(selectedHome) ? join(homedir(), selectedHome.slice(2))
    : selectedHome || join(homedir(), ".dsh");
  const profileRoot = realpathSync(join(home, "profiles", "dsh-tui"));
  const profileRequire = createRequire(pathToFileURL(join(home, "profiles", "dsh-tui", "package.json")));
  const profilePackage = profileRequire.resolve(`${packageName}/package.json`);
  // An ordinary installed profile already has a coherent React closure. The
  // compatibility hook is only for TUI source links outside that profile tree.
  const canonical = (path) => {
    const key = realpathSync(path).replaceAll("\\", "/");
    return process.platform === "win32" ? key.toLowerCase() : key;
  };
  if (canonical(profilePackage).startsWith(canonical(profileRoot) + "/")) return;
  let selectedPackage = profilePackage;
  try {
    selectedPackage = createRequire(anchor).resolve(`${packageName}/package.json`);
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND" && error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  }
  // Match the SDK installation-first bundle ownership before its hooks exist.
  const selectedRequire = createRequire(resolve(selectedPackage));
  const requests = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react/compiler-runtime"];
  const targets = new Map(requests.map((request) => [request, pathToFileURL(selectedRequire.resolve(request)).href]));
  const pathKey = (path) => {
    const normalized = resolve(path).replaceAll("\\", "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const owners = new Set();
  const addOwner = (path) => {
    owners.add(pathKey(path));
    owners.add(pathKey(realpathSync(path)));
  };
  addOwner(dirname(profilePackage));
  addOwner(dirname(createRequire(profilePackage).resolve("react-reconciler")));
  addOwner(dirname(selectedPackage));
  let installed = false;
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith("file:") && url.endsWith("/lib/types/dsh-adapter/plugin.js")) {
        const root = fileURLToPath(url).split(/[/\\]lib[/\\]types[/\\]dsh-adapter[/\\]plugin\.js$/)[0];
        const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
        if (manifest.name === packageName) {
          addOwner(root);
          // Register after the SDK router, before the actual TUI dependencies.
          // Keep the loaded source and unrelated Node consumers unchanged.
          if (!installed) {
            installed = true;
            registerHooks({
              resolve(specifier, requestContext, nextResolve) {
                if (targets.has(specifier) && requestContext.parentURL?.startsWith("file:")) {
                  const parent = pathKey(fileURLToPath(requestContext.parentURL));
                  if ([...owners].some((owner) => parent.startsWith(owner + "/"))) {
                    return { url: targets.get(specifier), shortCircuit: true };
                  }
                }
                return nextResolve(specifier, requestContext);
              },
            });
          }
        }
      }
      return nextLoad(url, context);
    },
  });
}
install(hostAnchor());
