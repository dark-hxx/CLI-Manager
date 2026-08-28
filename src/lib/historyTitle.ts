import type {
  HistoryMessage,
  HistorySessionDetail,
  HistoryTitleCandidate,
} from "./types";
import {
  conversationText,
  isInjectedPromptContent,
  normalizeHistoryMessageRole,
} from "./historyConversation";

export const HISTORY_TITLE_INPUT_MAX_BYTES = 4096;
export const HISTORY_TITLE_OUTPUT_MAX_TOKENS = 64;
export const HISTORY_TITLE_OUTPUT_MAX_BYTES = 256;

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let result = "";
  let usedBytes = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).byteLength;
    if (usedBytes + bytes > maxBytes) break;
    result += character;
    usedBytes += bytes;
  }
  return result;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeCandidateText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isAttachmentOnlyText(value: string): boolean {
  return value
    .replace(/<image\b[^>\r\n]*(?:>|$)|<\/image>|\[Image #\d+\]/gi, "")
    .trim()
    .length === 0;
}

function messageIdentity(message: HistoryMessage, index: number): string {
  if (message.line_index != null) return `line:${message.line_index}`;
  if (message.timestamp?.trim()) return `timestamp:${message.timestamp.trim()}`;
  return `ordinal:${index}`;
}

export async function extractHistoryTitleCandidate(
  detail: HistorySessionDetail,
  sessionKey: string,
): Promise<HistoryTitleCandidate | null> {
  for (const [index, message] of detail.messages.entries()) {
    if (normalizeHistoryMessageRole(message.role) !== "user") continue;
    const normalizedText = normalizeCandidateText(conversationText(message));
    if (!normalizedText || isInjectedPromptContent(normalizedText) || isAttachmentOnlyText(normalizedText)) continue;
    const boundedText = truncateUtf8(normalizedText, HISTORY_TITLE_INPUT_MAX_BYTES);
    if (!boundedText) continue;
    const [contentSha256, inputContentSha256] = await Promise.all([
      sha256Hex(normalizedText),
      sha256Hex(boundedText),
    ]);
    const sourceRef = detail.session_ref;
    const sourceIdentity = [
      sourceRef?.sourceId ?? detail.source,
      sourceRef?.sourceInstanceId ?? detail.file_path,
      sourceRef?.sourceSessionId ?? detail.session_id,
      sourceRef?.transportKind ?? "local",
    ].join(":");
    return {
      text: boundedText,
      identity: `history-title:${sessionKey}:${sourceIdentity}:${messageIdentity(message, index)}:${contentSha256}`,
      contentSha256,
      inputContentSha256,
    };
  }
  return null;
}

export function resolveHistoryDisplayTitle(
  alias: string | null | undefined,
  generatedTitle: string | null | undefined,
  sourceTitle: string | null | undefined,
  sessionId: string,
): string {
  return alias?.trim() || generatedTitle?.trim() || sourceTitle?.trim() || sessionId.trim();
}
