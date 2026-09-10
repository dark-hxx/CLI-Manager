const PI_DIRECT_TOOLS_ADVISORY = /MCP: +(?:7[5-9]|[89]\d|[1-9]\d{2,}) +direct tools resolved\. Each direct tool adds prompt context; README guidance recommends targeted sets of 5-20 tools and using the proxy or an explicit string\[\] when 75\+ direct tools would be registered\.(?:\r\n|\n)/gu;
const PI_DIRECT_TOOLS_ADVISORY_BODY =
  "direct tools resolved. Each direct tool adds prompt context; README guidance recommends targeted sets of 5-20 tools and using the proxy or an explicit string[] when 75+ direct tools would be registered.";
const PI_DIRECT_TOOLS_MARKER = "MCP:";
const MAX_ADVISORY_CANDIDATE_LENGTH = 512;

export interface PiOutputFilter {
  transform(text: string): string;
  reset(): void;
}

// 只有数字计数和固定正文的前缀才进入残尾，其他以 MCP: 开头的文本立即保留。
function isAdvisoryPrefix(candidate: string): boolean {
  if (PI_DIRECT_TOOLS_MARKER.startsWith(candidate)) return true;
  const withoutCarriageReturn = candidate.endsWith("\r") ? candidate.slice(0, -1) : candidate;
  if (withoutCarriageReturn.length > MAX_ADVISORY_CANDIDATE_LENGTH) return false;

  const rest = withoutCarriageReturn.slice(PI_DIRECT_TOOLS_MARKER.length);
  if (/^\s*\d*$/.test(rest)) return true;

  const bodyMatch = rest.match(/^\s*\d+\s+(.*)$/s);
  return bodyMatch !== null && PI_DIRECT_TOOLS_ADVISORY_BODY.startsWith(bodyMatch[1]);
}

function findCandidateStart(text: string): number {
  const markerStart = text.lastIndexOf(PI_DIRECT_TOOLS_MARKER);
  if (markerStart >= 0 && isAdvisoryPrefix(text.slice(markerStart))) return markerStart;

  // 完整标记不成立时，只保留末尾可能跨帧的标记片段。
  let partialMarkerStart = -1;
  for (const prefix of ["M", "MC", "MCP"]) {
    if (text.endsWith(prefix)) partialMarkerStart = text.length - prefix.length;
  }
  return Math.max(markerStart, partialMarkerStart);
}

/** 创建按 PTY 帧增量处理 Pi MCP advisory 的有界过滤器。 */
export function createPiOutputFilter(): PiOutputFilter {
  let pendingCandidate = "";

  return {
    // PTY 可能在 advisory 任意位置分帧；仅缓存可确定属于该提示的短残尾。
    transform(text) {
      const input = `${pendingCandidate}${text}`;
      pendingCandidate = "";
      const filtered = input.replace(PI_DIRECT_TOOLS_ADVISORY, "");
      const candidateStart = findCandidateStart(filtered);

      if (candidateStart < 0) return filtered;
      const candidate = filtered.slice(candidateStart);
      if (!isAdvisoryPrefix(candidate)) return filtered;

      pendingCandidate = candidate;
      return filtered.slice(0, candidateStart);
    },
    // reset 会丢弃未完成的提示，避免旧帧残尾污染新的终端输出。
    reset() {
      pendingCandidate = "";
    },
  };
}
