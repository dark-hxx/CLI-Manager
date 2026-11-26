import { isAgyCommand } from "../../../shared/lib/cliTools";
import type { Project, TerminalSession } from "../../../shared/types/index";

/** Respect explicit/custom startup commands and never infer the CLI from titles or current output. */
export function isAntigravityPty(tab: TerminalSession | null | undefined, project?: Project | null): boolean {
  if (!tab || (tab.kind ?? "pty") !== "pty" || tab.sshHostId || tab.environmentType === "ssh" || project?.environment_type === "ssh") return false;
  // Launch snapshots the resolved agy command. A project preset can change after the PTY starts.
  return isAgyCommand(tab.startupCmd);
}
