import type { HistorySessionDetail } from "../../../shared/types/index";
import { normalizeDetail } from "./historyNormalization";

export function normalizeHistoryPage(raw: unknown): HistorySessionDetail {
  const page = raw as { detail: unknown; offset: number; revision: string; complete: boolean };
  if (!page || typeof page.revision !== "string" || !Number.isSafeInteger(page.offset) || page.offset < 0) {
    throw new Error("history_page_invalid");
  }
  const detail = normalizeDetail(page.detail);
  return page.complete ? detail : { ...detail, message_page: { revision: page.revision } };
}

export function appendHistoryPage(current: HistorySessionDetail, incoming: HistorySessionDetail, offset: number): HistorySessionDetail {
  if (!current.message_page || current.message_page.revision !== incoming.message_page?.revision
    || current.messages.length !== offset || current.message_count !== incoming.message_count
    || current.session_id !== incoming.session_id || current.file_path !== incoming.file_path
    || current.source !== incoming.source || current.project_key !== incoming.project_key
    || !incoming.messages.length || offset + incoming.messages.length > current.message_count) {
    throw new Error("history_page_changed");
  }
  return { ...current, messages: [...current.messages, ...incoming.messages] };
}
