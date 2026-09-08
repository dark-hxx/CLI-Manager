import type { HistorySessionSummary } from "../../../shared/types/index";

type HistorySessionIdentity = Pick<
  HistorySessionSummary,
  "source" | "session_id" | "file_path" | "session_ref"
>;

function normalizeIdentityPath(value: string): string {
  let normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\//, "")
    .replace(/\/+$/g, "");
  if (/^[a-z]:\//i.test(normalized) || normalized.startsWith("//")) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

export function sameHistorySessionIdentity(
  left: HistorySessionIdentity,
  right: HistorySessionIdentity
): boolean {
  const source = left.source.trim().toLowerCase();
  const rightSource = right.source.trim().toLowerCase();
  const sessionId = left.session_id.trim().toLowerCase();
  const rightSessionId = right.session_id.trim().toLowerCase();
  if (!source || !sessionId || source !== rightSource || sessionId !== rightSessionId) {
    return false;
  }

  const leftTransport = left.session_ref?.transportKind.trim().toLowerCase() ?? "";
  const rightTransport = right.session_ref?.transportKind.trim().toLowerCase() ?? "";
  if (leftTransport === "ssh" || rightTransport === "ssh") {
    const leftRef = left.session_ref;
    const rightRef = right.session_ref;
    if (!leftRef || !rightRef || leftTransport !== "ssh" || rightTransport !== "ssh") {
      return false;
    }

    const leftRefSource = leftRef.sourceId.trim().toLowerCase();
    const rightRefSource = rightRef.sourceId.trim().toLowerCase();
    const leftRefSessionId = leftRef.sourceSessionId.trim().toLowerCase();
    const rightRefSessionId = rightRef.sourceSessionId.trim().toLowerCase();
    const leftInstanceId = leftRef.sourceInstanceId.trim();
    const rightInstanceId = rightRef.sourceInstanceId.trim();
    return Boolean(leftRefSource && leftRefSessionId && leftInstanceId && rightInstanceId)
      && leftRefSource === source
      && rightRefSource === rightSource
      && leftRefSessionId === sessionId
      && rightRefSessionId === rightSessionId
      && leftInstanceId === rightInstanceId;
  }

  const filePath = normalizeIdentityPath(left.file_path);
  return Boolean(filePath)
    && filePath === normalizeIdentityPath(right.file_path);
}
