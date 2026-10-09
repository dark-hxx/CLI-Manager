/** Non-PTY tabs may veto removal until their draft is safely persisted. */
const closeGuards = new Map<string, () => Promise<boolean>>();
const closing = new Set<string>();

export function registerWorkspaceViewCloseGuard(id: string, guard: () => Promise<boolean>): () => void {
  closeGuards.set(id, guard);
  return () => { if (closeGuards.get(id) === guard) closeGuards.delete(id); };
}

export function releaseWorkspaceViewCloseGuard(id: string): void {
  closeGuards.delete(id);
}

export async function requestWorkspaceViewClose(id: string): Promise<boolean> {
  if (closing.has(id)) return false;
  const guard = closeGuards.get(id);
  if (!guard) return true;
  closing.add(id);
  try { return await guard(); }
  finally { closing.delete(id); }
}
