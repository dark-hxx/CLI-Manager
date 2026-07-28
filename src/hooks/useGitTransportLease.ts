import { useEffect, useMemo, useState } from "react";
import { debugConsoleWarn } from "../lib/debugConsole";
import {
  acquireGitTransportLease,
  type GitTransportLease,
} from "../lib/gitTransportLease";
import type { Project } from "../lib/types";
import { createGitDiffWorkspaceContext } from "../stores/gitDiffWorkspaceStore";
import { useSshAgentIntegrationStore } from "../stores/sshAgentIntegrationStore";

interface GitTransportLeaseState {
  lease: GitTransportLease | null;
  loading: boolean;
  error: unknown;
}

const IDLE_STATE: GitTransportLeaseState = {
  lease: null,
  loading: false,
  error: null,
};

export function useGitTransportLease(
  project: Project | null,
  enabled = true,
): GitTransportLeaseState {
  const installationIdentity = useSshAgentIntegrationStore((state) => {
    if (project?.environment_type !== "ssh") return "";
    return state.installations
      .filter((installation) => installation.host_id === project.ssh_host_id)
      .map((installation) => [
        installation.installation_id,
        installation.install_path,
        installation.remote_machine_id,
        installation.status,
      ].join("\u0000"))
      .sort()
      .join("\u0001");
  });
  const projectIdentity = useMemo(
    () => project ? createGitDiffWorkspaceContext(project).key : null,
    [project],
  );
  const [state, setState] = useState<GitTransportLeaseState>(IDLE_STATE);

  useEffect(() => {
    if (!enabled || !project || !projectIdentity) {
      setState(IDLE_STATE);
      return;
    }

    let cancelled = false;
    let acquired: GitTransportLease | null = null;
    setState({ lease: null, loading: true, error: null });
    void acquireGitTransportLease(project)
      .then((lease) => {
        acquired = lease;
        if (cancelled) {
          void lease.release().catch(() => undefined);
          acquired = null;
          return;
        }
        setState({ lease, loading: false, error: null });
      })
      .catch((error) => {
        if (!cancelled) setState({ lease: null, loading: false, error });
      });

    return () => {
      cancelled = true;
      if (!acquired) return;
      void acquired.release().catch((error) => {
        debugConsoleWarn("[GitTransportLease] Failed to release transport:", error);
      });
      acquired = null;
    };
  }, [enabled, installationIdentity, project, projectIdentity]);

  return state;
}
