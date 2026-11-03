import { useFileExplorerStore } from "./fileExplorerStore";
import { EditorModelResidency, editorModelPath } from "../lib/editorModelResidency";
import type { Project } from "../../../shared/types/index";
import { FileContentResidency, fileContentRoot, fileContentKey, pendingFileSaves, type FileContentCandidate } from "../lib/fileContentResidency";

export const fileEditorModels = new EditorModelResidency();
export { editorModelPath };
export const editorProjectRoot = fileContentRoot;
const contentResidency = new FileContentResidency();
let sweeping = false;

export function syncFileEditorModels() {
  if (sweeping) return;
  const state = useFileExplorerStore.getState();
  const open = new Map<string, boolean>();
  const currentRoot = state.project ? editorProjectRoot(state.project) : null;
  for (const workspace of state.editorWorkspaces) {
    const root = editorProjectRoot(workspace.project);
    if (root === currentRoot) continue;
    for (const file of workspace.openFiles) open.set(editorModelPath(root, file.path), file.content !== file.savedContent);
  }
  if (currentRoot) {
    for (const file of state.openFiles) open.set(editorModelPath(currentRoot, file.path), file.content !== file.savedContent);
  }
  fileEditorModels.sync(open);
  const candidates: FileContentCandidate[] = [];
  const collect = (project: Project, files: typeof state.openFiles, activePath: string | null) => {
    const root = editorProjectRoot(project);
    for (const file of files) {
      const key = fileContentKey(project, file.path);
      candidates.push({ key, bytes: (file.content.length + file.savedContent.length + (file.image?.dataBase64.length ?? 0)) * 2,
        active: activePath === file.path, protected: file.content !== file.savedContent || pendingFileSaves.has(key)
          || fileEditorModels.protected(editorModelPath(root, file.path)) });
    }
  };
  for (const workspace of state.editorWorkspaces) {
    if (editorProjectRoot(workspace.project) !== currentRoot) collect(workspace.project, workspace.openFiles, null);
  }
  if (state.project) collect(state.project, state.openFiles, state.activeFilePath);
  const reclaimed = contentResidency.reclaim(candidates);
  const staleMirror = state.editorWorkspaces.some(workspace => editorProjectRoot(workspace.project) === currentRoot
    && (workspace.openFiles !== state.openFiles || workspace.activeFilePath !== state.activeFilePath));
  if (!reclaimed.size && !staleMirror) return;
  const prune = (project: Project, files: typeof state.openFiles) => {
    if (!files.some(file => reclaimed.has(fileContentKey(project, file.path)))) return files;
    return files.map(file => reclaimed.has(fileContentKey(project, file.path))
      ? { ...file, content: "", savedContent: "", image: null, dehydrated: true } : file);
  };
  const openFiles = state.project ? prune(state.project, state.openFiles) : state.openFiles;
  sweeping = true;
  try {
    useFileExplorerStore.setState({
      openFiles,
      // A current-workspace mirror must not retain closed or pre-edit payloads
      // outside the cache budget; it shares the authoritative current array.
      editorWorkspaces: state.editorWorkspaces.map(workspace => editorProjectRoot(workspace.project) === currentRoot
        ? { ...workspace, openFiles, activeFilePath: state.activeFilePath }
        : { ...workspace, openFiles: prune(workspace.project, workspace.openFiles) }),
    });
  } finally { sweeping = false; }
}

useFileExplorerStore.subscribe(syncFileEditorModels);
