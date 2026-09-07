import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const task = ".trellis/tasks/09-07-architecture-convergence";
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "src"], { encoding: "utf8" }).split("\0")
  .filter(file => /\.[jt]sx?$/.test(file) && existsSync(file));
const sources = new Map(files.map(file => [file, ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)]));
const resolve = (from, value) => {
  if (!value.startsWith(".") && !value.startsWith("@/")) return null;
  const base = value.startsWith("@/") ? `src/${value.slice(2)}` : path.posix.normalize(path.posix.join(path.posix.dirname(from), value));
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(file => sources.has(file)) ?? null;
};
const aliases = {};
for (const [file, source] of sources) {
  if (!/^src\/(components|stores)\//.test(file)) continue;
  if (source.statements.length === 1 && ts.isExportDeclaration(source.statements[0])) {
    const specifier = source.statements[0].moduleSpecifier;
    const target = specifier && resolve(file, specifier.text);
    if (target?.startsWith("src/features/")) aliases[file] = target;
  }
}
const feature = (domain, kind, file) => `src/features/${domain}/${kind}/${path.posix.basename(file)}`;
const sharedLib = new Set([
  "contrast", "pathValidation", "singleFlight", "utils", "markdownNavigation", "markdownSource", "cliTools", "builtinAiCommands",
  "gitDiffLimits", "gitDiffOptions", "terminalThemes", "terminalColor", "terminalPreviewTheme",
  "terminalPaneMarker", "terminalShellProfiles", "desktopPetSize", "cliArgsHistory", "historySort",
  "historySources", "workspaceLayout", "thirdPartyNotifications", "terminalInputSuggestions",
]);
const platformLib = new Set([
  "appPaths", "assetUrl", "db", "debugConsole", "logger", "linuxGraphics", "queryClient", "shell",
  "systemClipboard", "systemFonts", "resourceDiagnosticsLog",
]);
const explicitLib = {
  agentCapabilities: "agents", agentTerminal: "agents", aiClipboard: "files", aiPathFormatter: "files",
  runtimeDiagnostics: "terminal", codexManualInput: "terminal", configModalShellPrefill: "projects",
  desktopPet: "desktop-pet", diffParser: "history", "diffParser.worker": "history", dragInteraction: "workspace",
  externalSessionGrouping: "history", externalTerminal: "terminal", fileExplorerIgnore: "files",
  groupPath: "projects", hookErrors: "settings", liveServerClient: "files", modelPricing: "stats",
  nodeAppearance: "projects", providerSwitching: "providers", remoteHandoff: "remote",
  resumeCliArgs: "history", saveSessionToSidebar: "projects", sessionSnapshotPersistence: "terminal",
  sidebarCommands: "projects", sponsors: "settings", ssh: "remote", statusline: "settings",
  statuslineProfiles: "settings", syncSettings: "sync",
};
const storeDomains = {
  backgroundOperationStore: "terminal", ccusageStore: "stats", commandHistoryStore: "terminal",
  externalSessionSyncStore: "history", fileExplorerStore: "files", gitDiffWorkspaceStore: "git",
  gitStore: "git", gitWorkspaceStore: "git", historySourceSettingsStore: "history", liveServerStore: "files",
  modelPricingStore: "stats", projectStore: "projects", remoteHandoffStore: "remote", replayStore: "terminal",
  sessionStore: "terminal", sshAgentIntegrationStore: "remote", sshHostStore: "remote", syncStore: "sync",
  templateStore: "prompts", terminalCliSession: "terminal", terminalHookBinding: "terminal",
  terminalPaneTree: "terminal", terminalWorkspan: "terminal", updateStore: "settings", worktreeStore: "projects",
};
const rootComponents = {
  AppErrorBoundary: "app", AppFailureState: "app", BackgroundTasksPanel: "terminal", CliToolIcon: "shared",
  CloseConfirmDialog: "terminal", CommandHistoryPanel: "terminal", CommandPalette: "workspace",
  CommandTemplatePanel: "prompts", ConfigModal: "projects", ConfirmDialog: "shared", ExitProgressOverlay: "app",
  ExternalSessionSyncDialog: "history", HistoryWorkspace: "history", icons: "shared", ListClockIcon: "shared",
  NodeAppearanceIcon: "projects", PathCopyMenu: "files", ProviderSwitchModal: "providers",
  RunningTasksExitDialog: "terminal", SettingsModal: "settings", ShellIcon: "shared", ShellSelect: "projects",
  SplitTerminalView: "terminal", ThemeToggle: "settings", VendorIcon: "shared", WindowTitleBar: "app", WorktreeIcon: "shared",
};
const hookDomains = {
  useAgentCapabilities: "agents", useDesktopPetCoordinator: "desktop-pet", useGitTransportLease: "git",
  useKeyboardShortcuts: "workspace", useRemoteHandoffCoordinator: "remote", useSaveSessionToSidebar: "projects",
  useSshDirectoryBrowser: "remote", useSystemResources: "stats",
};
const map = {};
for (const file of files) {
  if (aliases[file]) { map[file] = aliases[file]; continue; }
  const name = path.posix.basename(file).replace(/\.tsx?$/, "");
  if (file === "src/App.tsx") map[file] = "src/app/App.tsx";
  else if (file === "src/desktop-pet/DesktopPetApp.tsx") map[file] = "src/features/desktop-pet/components/DesktopPetApp.tsx";
  else if (file.startsWith("src/features/") || file.startsWith("src/shared/")) map[file] = file;
  else if (file.startsWith("src/terminal/")) map[file] = file.replace("src/terminal/", "src/features/terminal/");
  else if (file.startsWith("src/components/")) {
    const rest = file.slice("src/components/".length), directory = rest.includes("/") ? rest.split("/")[0] : null;
    const domain = directory ? ({ sidebar: "projects", worktree: "projects", provider: "providers", layout: "workspace", ui: "shared" }[directory] ?? directory) : rootComponents[name];
    if (!domain) throw new Error(`Unclassified component: ${file}`);
    map[file] = domain === "shared" ? `src/shared/ui/${directory ? rest.slice(directory.length + 1) : rest}`
      : domain === "app" ? `src/app/components/${rest}`
        : `src/features/${domain}/components/${directory ? rest.slice(directory.length + 1) : rest}`;
  } else if (file.startsWith("src/stores/")) {
    if (name === "settingsStore") map[file] = "src/shared/preferences/settingsStore.ts";
    else { assertDomain(storeDomains[name], file); map[file] = feature(storeDomains[name], "store", file); }
  } else if (file.startsWith("src/hooks/")) {
    if (name === "useFocusTrap") map[file] = "src/shared/hooks/useFocusTrap.ts";
    else { const domain = hookDomains[name] ?? (name.startsWith("useTerminal") ? "terminal" : null); assertDomain(domain, file); map[file] = feature(domain, "hooks", file); }
  } else if (file.startsWith("src/lib/")) {
    if (name === "i18n") map[file] = "src/shared/i18n/index.ts";
    else if (name === "types") map[file] = "src/shared/types/index.ts";
    else if (sharedLib.has(name)) map[file] = `src/shared/lib/${path.posix.basename(file)}`;
    else if (platformLib.has(name) || name.startsWith("monaco")) map[file] = `src/shared/platform/${path.posix.basename(file)}`;
    else {
      const domain = explicitLib[name] ?? ["terminal", "history", "git", "ssh", "desktopPet", "project"].find(prefix => name.startsWith(prefix));
      assertDomain(domain, file);
      map[file] = feature(({ ssh: "remote", desktopPet: "desktop-pet", project: "projects" }[domain] ?? domain), "lib", file);
    }
  } else map[file] = file;
}
function assertDomain(domain, file) { if (!domain) throw new Error(`Unclassified module: ${file}`); }
const edges = [];
for (const [file, source] of sources) {
  function visit(node) {
    let value;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) value = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) value = node.arguments[0];
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) value = node.argument.literal;
    if (value && ts.isStringLiteral(value)) {
      const target = resolve(file, value.text);
      if (target) edges.push({ from: file, to: target, specifier: value.text, typeOnly: Boolean(node.importClause?.isTypeOnly || node.isTypeOnly || ts.isImportTypeNode(node)) });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const domain = file => file.startsWith("src/shared/") ? "shared" : file.startsWith("src/app/") ? "app" : /^src\/features\/([^/]+)/.exec(file)?.[1] ?? "entry";
const violations = edges.filter(edge => domain(map[edge.from]) === "shared" && !["shared", "entry"].includes(domain(map[edge.to])));
const publicConsumers = edges.filter(edge => domain(map[edge.from]) !== domain(map[edge.to]) && map[edge.to].startsWith("src/features/"));
// Expose cohesive modules directly under api/, not a barrel that eagerly loads unrelated UI/state.
// Existing explicit index/state entries retain their current ownership and semantics.
const publicTargets = new Map([...new Set(publicConsumers.map(edge => map[edge.to]))].map(target => {
  const match = /^(src\/features\/[^/]+)\/(.+)$/.exec(target);
  return [target, match[2].includes("/") ? `${match[1]}/api/${path.posix.basename(target)}` : target];
}));
for (const [file, target] of Object.entries(map)) if (publicTargets.has(target)) map[file] = publicTargets.get(target);
const collisions = new Map();
for (const [file, target] of Object.entries(map)) {
  if (aliases[file]) continue;
  if (collisions.has(target)) throw new Error(`Duplicate ownership: ${file}, ${collisions.get(target)} -> ${target}`);
  collisions.set(target, file);
}
writeFileSync(`${task}/frontend-ownership-plan.json`, JSON.stringify({ map, aliases, edges, violations, publicConsumers }, null, 2) + "\n");
console.log(JSON.stringify({ modules: files.length, moves: Object.entries(map).filter(([a,b]) => a !== b).length,
  aliases: Object.keys(aliases).length, sharedViolations: violations.map(edge => [edge.from, edge.to]),
  publicModules: new Set(publicConsumers.map(edge => map[edge.to])).size }, null, 2));
