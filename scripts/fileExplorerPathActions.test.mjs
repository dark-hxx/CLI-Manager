import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const sidebar = read("../src/components/files/FileExplorerSidebar.tsx");
const formatter = read("../src/lib/aiPathFormatter.ts");
const drag = read("../src/lib/terminalFileDrag.ts");
const terminalInput = read("../src/hooks/useTerminalInput.ts");
const pointerDrag = read("../src/hooks/useTerminalFilePointerDrag.tsx");
const terminalTabs = read("../src/components/TerminalTabs.tsx");
const gitPanel = read("../src/components/git/GitChangesPanel.tsx");
const gitTree = read("../src/components/git/GitChangesTree.tsx");
const gitNode = read("../src/components/git/GitTreeNode.tsx");
const attachmentDialog = read("../src/components/settings/pages/SshHostAttachmentDialog.tsx");

test("terminal tab CLI icons inherit the terminal tab foreground color", () => {
  assert.equal((terminalTabs.match(/<CliToolIcon icon=\{cliToolIcon\} size=\{14\} className="text-current" \/>/g) ?? []).length, 3);
});

test("file menus expose relative and absolute path copy actions", () => {
  assert.match(sidebar, /import \{ PathCopyMenu \} from "\.\.\/PathCopyMenu"/);
  assert.equal((sidebar.match(/<PathCopyMenu /g) ?? []).length, 4);
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
