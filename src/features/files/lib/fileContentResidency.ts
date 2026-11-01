import type { Project } from "../../../shared/types/index";
import { fileOperationRootKey } from "./fileExplorerOperations";

export function fileContentRoot(project: Project): string {
  const configuredRemoteRoot = (project.remote_path ?? project.path).trim();
  const remoteRoot = configuredRemoteRoot ? configuredRemoteRoot.replace(/\/+$/, "") || "/" : "";
  return project.environment_type === "ssh"
    ? JSON.stringify(["ssh", project.ssh_host_id, remoteRoot])
    : fileOperationRootKey(project.path);
}
export function fileContentKey(project: Project, path: string): string {
  return JSON.stringify([fileContentRoot(project), path]);
}
export const pendingFileSaves = new Map<string, number>();
export function protectFileSave(key: string): () => void {
  pendingFileSaves.set(key, (pendingFileSaves.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (pendingFileSaves.get(key) ?? 1) - 1;
    if (count > 0) pendingFileSaves.set(key, count);
    else pendingFileSaves.delete(key);
  };
}

export interface FileContentCandidate { key: string; bytes: number; active: boolean; protected: boolean }

/** Only reloadable clean contents are a cache; tab identity and drafts remain owned by the workspace. */
export class FileContentResidency {
  private recent = new Map<string, number>();
  private clock = 0;
  constructor(private maxBytes = 32 * 1024 * 1024, private maxFiles = 64) {}

  reclaim(candidates: FileContentCandidate[]): Set<string> {
    const keys = new Set(candidates.map(c => c.key));
    for (const key of this.recent.keys()) if (!keys.has(key)) this.recent.delete(key);
    for (const c of candidates) if (c.active || !this.recent.has(c.key)) this.recent.set(c.key, ++this.clock);
    const reclaimed = new Set<string>();
    let bytes = candidates.reduce((sum, c) => sum + c.bytes, 0), count = candidates.filter(c => c.bytes > 0).length;
    const cold = candidates.filter(c => c.bytes > 0 && !c.active && !c.protected)
      .sort((a, b) => this.recent.get(a.key)! - this.recent.get(b.key)!);
    for (const c of cold) {
      if (bytes <= this.maxBytes && count <= this.maxFiles) break;
      reclaimed.add(c.key); bytes -= c.bytes; count--;
    }
    return reclaimed;
  }
}
