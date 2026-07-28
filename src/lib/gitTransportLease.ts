import type { Project } from "./types";
import { createLocalGitTransportContextKey } from "./gitTransportIdentity";
import {
  createLocalGitTransport,
  createSshGitTransport,
  type GitTransport,
} from "./gitTransport";
import {
  buildSshRemoteGitContext,
  releaseSshRemoteGitContext,
} from "./sshRemoteGit";
import {
  GitTransportLeaseRegistry,
  type GitTransportLease as RegistryLease,
} from "./gitTransportLeaseRegistry";

export interface GitTransportLease {
  contextKey: string;
  transport: GitTransport;
  release: () => Promise<void>;
}

const registry = new GitTransportLeaseRegistry<GitTransport>();

function toLease(lease: RegistryLease<GitTransport>): GitTransportLease {
  return {
    contextKey: lease.contextKey,
    transport: lease.value,
    release: lease.release,
  };
}

export async function acquireGitTransportLease(project: Project): Promise<GitTransportLease> {
  if (project.environment_type === "ssh") {
    const context = await buildSshRemoteGitContext(project);
    const contextKey = `ssh:${context.contextKey}`;
    return toLease(await registry.acquire(contextKey, async () => ({
      value: { ...createSshGitTransport(context), contextKey },
      dispose: () => releaseSshRemoteGitContext(context),
    })));
  }

  const contextKey = createLocalGitTransportContextKey(project);
  return toLease(await registry.acquire(contextKey, async () => ({
    value: { ...createLocalGitTransport(project.path), contextKey },
    dispose: () => Promise.resolve(),
  })));
}
