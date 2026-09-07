import type { HistorySessionSummary } from "../../../shared/types/index";
import type { CodexLaunchSessionSelection } from "../../history/api/resumeCliArgs";

const SSH_SESSION_CLOCK_SKEW_MS = 60_000;

type SshCodexSessionBindingSelection =
  | { status: "resolved"; sessionId: string; sourceInstanceId: string }
  | { status: "not_found" }
  | { status: "ambiguous" };

function normalizedSessionId(summary: HistorySessionSummary): string {
  return summary.session_ref?.sourceSessionId?.trim() || summary.session_id.trim();
}

export function selectUniqueSshCodexSessionBinding(input: {
  summaries: HistorySessionSummary[];
  terminalStartedAtMs: number;
  terminalActivityAtMs: number;
  nowMs: number;
  alreadyBoundSessionIds: ReadonlySet<string>;
  launchSelection?: CodexLaunchSessionSelection;
}): SshCodexSessionBindingSelection {
  const earliestCreatedAt = input.terminalStartedAtMs - SSH_SESSION_CLOCK_SKEW_MS;
  const earliestUpdatedAt = Math.max(
    input.terminalStartedAtMs,
    input.terminalActivityAtMs || input.terminalStartedAtMs,
  ) - SSH_SESSION_CLOCK_SKEW_MS;
  const latestPlausibleAt = input.nowMs + SSH_SESSION_CLOCK_SKEW_MS;
  const launchSelection = input.launchSelection ?? { kind: "new" };
  if (launchSelection.kind === "interactive") {
    return { status: "not_found" };
  }
  const candidates = input.summaries.filter((summary) => {
    const sessionId = normalizedSessionId(summary);
    return summary.source === "codex"
      && summary.session_ref?.transportKind === "ssh"
      && Boolean(sessionId)
      && !/\s/.test(sessionId)
      && summary.message_count > 0
      && Number.isFinite(summary.created_at)
      && Number.isFinite(summary.updated_at)
      && summary.created_at <= latestPlausibleAt
      && summary.updated_at <= latestPlausibleAt;
  });

  let matches: HistorySessionSummary[];
  if (launchSelection.kind === "explicit") {
    const requestedSessionId = launchSelection.sessionId.trim();
    if (!requestedSessionId || /[\s\0\r\n]/.test(requestedSessionId)) {
      return { status: "not_found" };
    }
    matches = candidates.filter((summary) => (
      normalizedSessionId(summary) === requestedSessionId
      && !input.alreadyBoundSessionIds.has(requestedSessionId)
    ));
  } else if (launchSelection.kind === "last") {
    const latestUpdatedAt = candidates.reduce(
      (latest, summary) => Math.max(latest, summary.updated_at),
      Number.NEGATIVE_INFINITY,
    );
    matches = candidates.filter((summary) => summary.updated_at === latestUpdatedAt);
    if (matches.some((summary) => (
      input.alreadyBoundSessionIds.has(normalizedSessionId(summary))
    ))) {
      return { status: matches.length === 1 ? "not_found" : "ambiguous" };
    }
  } else {
    matches = candidates.filter((summary) => {
      const sessionId = normalizedSessionId(summary);
      return !input.alreadyBoundSessionIds.has(sessionId)
        && summary.created_at >= earliestCreatedAt
        && summary.updated_at >= earliestUpdatedAt;
    });
  }

  if (matches.length === 0) return { status: "not_found" };
  if (matches.length !== 1) return { status: "ambiguous" };
  const match = matches[0];
  return {
    status: "resolved",
    sessionId: normalizedSessionId(match),
    sourceInstanceId: match.session_ref?.sourceInstanceId?.trim() || "",
  };
}
