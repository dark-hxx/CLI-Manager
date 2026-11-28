import type { TerminalSession } from "../../../shared/types/index";
import { isAgySessionId } from "../../projects/api/agyStartupCommand";
import type { AntigravityBinding, CliHookPayload } from "../types/terminalStoreTypes";

type Target = Pick<TerminalSession, "id" | "kind" | "environmentType" | "cliSessionId">;

/** Only the authenticated raw PTY is eligible. The backend emits Stop/StopFailure only for verified idle terminal events. */
export function advanceAntigravityBinding(
  target: Target | undefined, expectedDistro: string | null, payload: CliHookPayload, previous?: AntigravityBinding,
): { binding: AntigravityBinding; deliver: boolean } | null {
  if (!target || target.id !== payload.tabId || (target.kind ?? "pty") !== "pty" || payload.source !== "antigravity") return null;
  if (payload.environmentType === "ssh" || (target.environmentType !== "local" && target.environmentType !== "wsl")) return null;
  const distro = payload.wslDistroName?.trim().toLowerCase();
  if (target.environmentType === "wsl" ? !distro || distro !== expectedDistro?.trim().toLowerCase() : Boolean(distro)) return null;
  const id = payload.sessionId?.toLowerCase();
  const stamp = payload.timestamp ?? "";
  const at = Date.parse(stamp);
  const subMs = (stamp.match(/\.(\d+)/)?.[1] ?? "").slice(3, 9).padEnd(6, "0");
  if (!isAgySessionId(id) || !Number.isFinite(at)) return null;
  if (previous && (at < previous.at || (at === previous.at && subMs < previous.subMs))) return null;
  const phase = payload.event === "SessionStart" ? "bound" : payload.event === "PreInvocation" ? "running"
    : payload.event === "Stop" ? "done" : payload.event === "StopFailure" ? "failed"
    : payload.event === "Interrupt" ? "canceled" : null;
  if (!phase) return null;
  const currentId = previous?.id ?? target.cliSessionId?.toLowerCase();
  const fork = !!currentId && currentId !== id;
  // A subsequent event may establish an unbound/resumed tab; only SessionStart can switch a live binding.
  if ((fork && phase !== "bound") || previous?.retired.includes(id)) return null;
  if (!fork && previous && phase === "bound") return null;
  const same = !fork && previous?.phase === phase;
  const prevTerminal = previous?.phase === "done" || previous?.phase === "failed" || previous?.phase === "canceled";
  if (previous && at === previous.at && subMs === previous.subMs && (same || prevTerminal)) return null;
  const retired = previous?.retired ?? [];
  return { binding: { id, phase, at, subMs, retired: fork ? [...retired, currentId] : retired }, deliver: !same };
}
