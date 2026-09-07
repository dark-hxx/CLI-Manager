import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "./helpers/readComposedSource.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const sidebar = read("../src/features/files/api/FileExplorerSidebar.tsx");
const contextMenu = read("../src/shared/ui/context-menu.tsx");
const componentStyles = read("../src/styles/components.css");
const formatter = read("../src/features/files/api/aiPathFormatter.ts");
const drag = read("../src/features/terminal/api/terminalFileDrag.ts");
const terminalInput = read("../src/features/terminal/hooks/useTerminalInput.ts");
const pointerDrag = read("../src/features/terminal/api/useTerminalFilePointerDrag.tsx");
const terminalTabs = read("../src/features/terminal/hooks/useTerminalTabsController.tsx");
const tabIconSources = [
  read("../src/features/terminal/components/SortableTerminalTabs.tsx"),
  read("../src/features/terminal/components/TerminalTabDragOverlay.tsx"),
].join("\n");
const gitPanel = read("../src/features/git/api/GitChangesPanel.tsx");
const gitTree = read("../src/features/git/components/GitChangesTree.tsx");
const gitNode = read("../src/features/git/components/GitTreeNode.tsx");
const attachmentDialog = read("../src/features/settings/api/SshHostAttachmentDialog.tsx");

test("terminal tab CLI icons inherit the terminal tab foreground color", () => {
  assert.equal((tabIconSources.match(/<CliToolIcon icon=\{cliToolIcon\} size=\{14\} className="text-current" \/>/g) ?? []).length, 3);
});

test("file menus expose relative and absolute path copy actions", () => {
  assert.match(sidebar, /import \{ PathCopyMenu \} from "\.\/PathCopyMenu"/);
  assert.equal((sidebar.match(/<PathCopyMenu /g) ?? []).length, 4);
});

test("file menus portal outside clipping sidebar and panel ancestors", () => {
  assert.match(sidebar, /import \{ Portal \} from "\.\.\/\.\.\/\.\.\/shared\/ui\/Portal"/);
  assert.match(
    sidebar,
    /<Portal>\s*<div ref=\{setMenuPortalContainer\} data-file-explorer-menu-portal="" style=\{panelStyle\} \/>\s*<\/Portal>/,
  );
  assert.doesNotMatch(
    sidebar,
    /<div ref=\{setMenuPortalContainer\} className="ui-file-explorer-sidebar/,
  );
  assert.equal((sidebar.match(/portalContainer=\{menuPortalContainer\}/g) ?? []).length, 4);
});

test("Radix menu content remains measurable by its Popper wrapper", () => {
  assert.equal(
    (contextMenu.match(/context-menu radix-context-menu-content/g) ?? []).length,
    2,
  );
  assert.match(
    componentStyles,
    /\.context-menu\.radix-context-menu-content\s*\{\s*position:\s*relative;/,
  );
  assert.match(componentStyles, /\.context-menu\s*\{\s*position:\s*fixed;/);
});

test("an open file context menu highlights its trigger row", () => {
  assert.equal((sidebar.match(/<ContextMenuTrigger asChild>/g) ?? []).length, 4);
  assert.match(
    componentStyles,
    /\.ui-file-tree-row\[data-selected="true"\],\s*\.ui-file-tree-row\[data-state="open"\]/,
  );
  assert.match(
    componentStyles,
    /\.ui-file-tree-row\[data-ignored="true"\]\[data-selected="true"\],\s*\.ui-file-tree-row\[data-ignored="true"\]\[data-state="open"\]/,
  );
});

test("absolute file paths use the local root or SSH remote root", () => {
  assert.match(formatter, /project\.environment_type === "ssh" \? project\.remote_path : project\.path/);
  assert.ok(formatter.includes("normalizedPath.replace(/\\//g, separator)"));
});

test("file drags carry source context and absolute fallback data", () => {
  assert.match(drag, /export const TERMINAL_FILE_DRAG_MIME/);
  assert.match(drag, /absolutePath: formatAbsoluteProjectFilePath\(project, relativePath, kind\)/);
  assert.match(drag, /zone\.paste\(currentDrag\)/);
  assert.match(sidebar, /event\.dataTransfer\.setData\(TERMINAL_FILE_DRAG_MIME, JSON\.stringify\(payload\)\)/);
});

test("terminal drops choose relative text only for the same project location", () => {
  assert.match(terminalInput, /isSameProjectFileLocation\(payload\.source, targetProject\)/);
  assert.match(terminalInput, /payload\.absolutePath \|\| payload\.text/);
  assert.match(terminalInput, /projectWithWorktreePath\(project, worktree\)/);
  assert.match(terminalInput, /parseTerminalFileDragPayload\(event\.dataTransfer\?\.getData\(TERMINAL_FILE_DRAG_MIME\)\)/);
});

test("terminal file drags preserve the file panel and leave a command separator", () => {
  assert.match(drag, /suppressNextFilePanelProjectSync = true/);
  assert.match(terminalInput, /markTerminalFileDragPanelSyncSuppression\(\)/);
  assert.match(terminalTabs, /consumeTerminalFileDragPanelSyncSuppression\(\)/);
  assert.match(terminalInput, /appendTerminalFileDragSeparator\(resolveTerminalFileDragText\(payload\)\)/);
  assert.match(terminalInput, /payload \? appendTerminalFileDragSeparator\(text\) : text/);
});

test("Git change files and directories share the terminal pointer-drag source", () => {
  assert.match(pointerDrag, /export function useTerminalFilePointerDrag/);
  assert.match(pointerDrag, /createTerminalFileDragPayload\(project, state\.source\.path, state\.source\.kind\)/);
  assert.match(pointerDrag, /commitTerminalFileDragDrop\(\)/);
  assert.match(sidebar, /useTerminalFilePointerDrag<ProjectFileEntry>/);
  assert.match(sidebar, /onDropOutsideTerminal: handlePointerDropOutsideTerminal/);
  assert.match(gitPanel, /useTerminalFilePointerDrag\(\{\s*project: gitTreeProject,/s);
  assert.match(gitTree, /onFilePointerDown/);
  assert.match(gitNode, /draggable=\{false\}/);
  assert.match(gitNode, /event\.target instanceof Element && event\.target\.closest\("button"\)/);
  assert.match(gitNode, /onFilePointerDown\(event, \{ path: node\.path, kind: "file" \}\)/);
  assert.match(gitNode, /onFilePointerDown\(event, \{ path: displayNode\.path, kind: "directory" \}\)/);
  assert.match(formatter, /kind === "directory" && normalizedPath \? `\$\{path\}\/` : path/);
  assert.match(formatter, /kind === "directory" && normalizedPath \? `\$\{absolutePath\}\$\{separator\}` : absolutePath/);
  assert.match(gitNode, /toggleDir\(displayCollapseKey\)/);
  assert.match(gitNode, /isTerminalFilePointerDragClickHandled/);
});

test("SSH Host attachment local pane browses Desktop and reuses File Explorer icons", () => {
  assert.match(attachmentDialog, /import \{ dirname as localDirname, desktopDir, join as joinLocalPath \} from "@tauri-apps\/api\/path"/);
  assert.match(attachmentDialog, /invoke<ProjectFileEntry\[\]>\("file_list_dir", \{ rootPath: localPath, relativePath: "" \}\)/);
  assert.match(attachmentDialog, /getMaterialFolderIcon\(entry\.name, false\)/);
  assert.match(attachmentDialog, /getMaterialFileIcon\(entry\.name\)/);
  assert.match(attachmentDialog, /setLocalPath\(nextPath\)/);
  assert.match(attachmentDialog, /addPathsToQueue\(\[path\]\)/);
});

test("SSH Host attachment panes share aligned headers and bounded scrolling lists", () => {
  assert.equal((attachmentDialog.match(/h-\[108px\] shrink-0/g) ?? []).length, 2);
  assert.equal((attachmentDialog.match(/h-\[360px\] shrink-0 overflow-y-auto/g) ?? []).length, 2);
  assert.match(attachmentDialog, /src=\{entry\.kind === "directory" \? getMaterialFolderIcon\(entry\.name, false\) : getMaterialFileIcon\(entry\.name\)\}/);
});
