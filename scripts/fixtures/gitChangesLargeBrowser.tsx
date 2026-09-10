import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { GitChangesTree } from "../../src/features/git/components/GitChangesTree";
import { useGitStore } from "../../src/features/git/store/gitStore";
import { buildGitTreesAsync } from "../../src/features/git/lib/gitTreeBuilder";
import type { GitFileChange, GitTreeNode } from "../../src/shared/types/index";

const root = createRoot(document.getElementById("root")!);
const failures: string[] = [];
const reports: unknown[] = [];
let selectedFile = "";
let stageCount = 0;
let dragPath = "";
const changes: GitFileChange[] = Array.from({ length: 64887 }, (_, i) => ({
  path: `file-${String(i).padStart(5, "0")}.ts`, status: "M", staged: false, added: 1, deleted: 1,
}));

// 运行真实虚拟树/行/复选框/右键组件；仅宿主平台服务被测试启动器替换。
function Fixture({ tree, untrackedTree }: { tree: GitTreeNode[]; untrackedTree: GitTreeNode[] }) {
  const scrollElementRef = useRef<HTMLDivElement>(null);
  return <>
    <input id="responsive-input" />
    <div id="scroll" ref={scrollElementRef} style={{ height: 520, width: 450, overflowY: "auto", position: "relative" }}>
      <GitChangesTree tree={tree} untrackedTree={untrackedTree} project={null} scrollElementRef={scrollElementRef}
        onFileClick={path => { selectedFile = path; }} onOpenSourceFile={() => {}}
        onRequestDiscard={() => {}} onRequestDeleteUntracked={() => {}} onToggleStage={() => { stageCount++; }}
        onToggleStagePaths={paths => { stageCount = paths.length; }}
        onFilePointerDown={(_event, source) => { dragPath = source.path; }}
        onFilePointerMove={() => {}} onFilePointerUp={() => {}} onFilePointerCancel={() => {}} />
    </div>
  </>;
}

const pause = () => new Promise(resolve => setTimeout(resolve, 80));
function check(condition: unknown, message: string) { if (!condition) failures.push(message); }
const mounted = () => document.querySelectorAll("[data-git-change-row]").length;
const row = (key: string) => {
  const separator = key.indexOf(":");
  const treeId = key.slice(0, separator), path = key.slice(separator + 1);
  return [...document.querySelectorAll<HTMLElement>("[data-git-change-row]")].find(element =>
    element.dataset.gitChangeRow?.startsWith(`${treeId}:node:`) && element.dataset.gitChangeRow.endsWith(`:${path}`));
};

async function run() {
  let heartbeatCount = 0;
  const heartbeat = setInterval(() => { heartbeatCount++; }, 5);
  const started = performance.now();
  const forest = await buildGitTreesAsync(changes, "all", "directory", new AbortController().signal);
  const built = performance.now();
  clearInterval(heartbeat);
  check(heartbeatCount > 0, "main thread schedules input while Worker builds");
  root.render(<Fixture {...forest} />);
  await pause();
  check(mounted() > 0 && mounted() < 100, "flat initial mounted count");
  check(!!row("tracked:file-00000.ts"), "first file reachable");
  const firstRow = row("tracked:file-00000.ts")!;
  firstRow.querySelector<HTMLElement>("[data-state]")?.click();
  check(selectedFile === "file-00000.ts", "file opens diff callback");
  firstRow.querySelector<HTMLElement>('button[role="checkbox"]')?.click();
  check(stageCount === 1, "stage checkbox");
  const initialMounted = mounted();
  firstRow.querySelector<HTMLElement>("[data-state]")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100, button: 2 }));
  await pause();
  check(!!document.querySelector('[role="menu"]'), "context menu opens");
  const scroll = document.getElementById("scroll")!;
  scroll.scrollTop = scroll.scrollHeight;
  scroll.dispatchEvent(new Event("scroll"));
  await pause();
  check(!!row("tracked:file-64886.ts"), "last file reachable");
  check(!!row("tracked:file-00000.ts"), "open menu keeps offscreen owner mounted");
  document.querySelector('[role="menu"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await pause();
  check(mounted() > 0 && mounted() < 100, "flat tail mounted count");
  reports.push({ files: changes.length, buildMs: built - started, heartbeatCount, initialMounted, tailMounted: mounted(), domElements: document.querySelectorAll("*").length });

  // 滚动后折叠/替换成两分区，目录批量操作必须处理所有不可见文件。
  const directoryChanges = changes.map(file => ({ ...file, path: `root/a/${file.path}` }));
  const directories = await buildGitTreesAsync(directoryChanges, "all", "directory", new AbortController().signal);
  root.render(<Fixture {...directories} />);
  await pause();
  scroll.scrollTop = 0;
  scroll.dispatchEvent(new Event("scroll"));
  await pause();
  row("tracked:root")?.querySelector<HTMLElement>('button[role="checkbox"]')?.click();
  check(stageCount === changes.length, "directory stage includes offscreen descendants");
  const directory = row("tracked:root")?.querySelector<HTMLElement>("[data-state]");
  directory?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
  check(dragPath === "root/a", "compressed directory drag uses chain leaf");
  window.dispatchEvent(new PointerEvent("pointerup"));
  directory?.click();
  await pause();
  check(mounted() === 2, "collapse removes descendants");
  check(scroll.scrollTop === 0, "collapse clamps scroll");
  directory?.click();
  await pause();
  check(mounted() > 2 && mounted() < 100, "expand remains virtual");

  useGitStore.getState().reset();
  const mixed = await buildGitTreesAsync([
    { ...changes[0], path: "tracked.ts" },
    ...changes.slice(0, 1000).map(file => ({ ...file, path: `new/${file.path}`, status: "U" as const })),
  ], "all", "directory", new AbortController().signal);
  root.render(<Fixture {...mixed} />);
  await pause();
  const untracked = row("untracked:new");
  untracked?.querySelector<HTMLElement>('button[role="checkbox"]')?.click();
  await pause();
  check(useGitStore.getState().selectedUntracked.size === 1000, "untracked directory selects all files");
  check(row("untracked:new")?.querySelector('button[role="checkbox"]')?.getAttribute("aria-checked") === "true", "directory checked state");
  check(mounted() < 100, "mixed sections remain virtual");

  // 使用项目真实 Git 字典，验证新树分区和菜单在两种语言下仍取原有键。
  for (const language of ["zh-CN", "en-US"]) {
    (window as unknown as { testLanguage: string }).testLanguage = language;
    root.render(<Fixture key={language} {...mixed} />);
    await pause();
    const text = document.body.textContent ?? "";
    check(!text.includes("git.section."), `${language} section translations`);
    reports.push({ language, sectionLabels: [...document.querySelectorAll('[data-git-change-row$=":section"]')].map(element => element.textContent) });
  }
  const input = document.getElementById("responsive-input") as HTMLInputElement;
  input.value = "responsive";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  check(input.value === "responsive", "input remains usable");
}

run().catch(error => failures.push(String(error))).finally(() => {
  (window as unknown as { testResult: unknown }).testResult = { failures, reports };
  root.unmount();
  const result = document.createElement("pre");
  result.id = "test-result";
  result.textContent = JSON.stringify({ failures, reports });
  document.body.append(result);
});
