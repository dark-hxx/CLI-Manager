import { useId, useState } from "react";
import { Brain, ChevronRight, Wrench } from "lucide-react";
import type { TranscriptMessage } from "./protocol";
import type { Translate } from "./i18n";

/**
 * Read-only recorded activity. Receiving new output never opens a disclosure.
 * hit：對話搜尋命中這張卡的內容時由上層傳入，暫時展開；關掉搜尋就回到使用者原本的選擇。
 */
export function ConversationActivity({ message, t, hit = false }: { message: TranscriptMessage; t: Translate; hit?: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const parts = message.parts ?? [];
  if (!parts.length) return <small className="tap-truncated">{t("activityTruncated")}</small>;
  const expanded = open || hit;
  const reasoning = parts[0]?.kind === "reasoning";
  const call = parts.find((part) => part.kind === "tool_call");
  const name = call?.toolName ?? parts.find((part) => part.toolName)?.toolName;
  const label = t(reasoning ? "reasoningDetails" : call ? "toolCall" : "toolResult");
  return <section className="tap-activity" data-anchor={message.id}>
    <button type="button" className="tap-activity-toggle" aria-expanded={expanded} aria-controls={bodyId}
      onClick={() => setOpen(!expanded)}>
      <ChevronRight size={14} className={expanded ? "is-open" : undefined} aria-hidden />
      {reasoning ? <Brain size={15} aria-hidden /> : <Wrench size={15} aria-hidden />}
      <span>{label}{name ? ` · ${name}` : ""}</span><small>{t(expanded ? "collapse" : "expand")}</small>
    </button>
    <div id={bodyId} className="tap-activity-body" hidden={!expanded}>
      {expanded && parts.map((part) => <div className="tap-activity-part" key={part.id}>
        {!reasoning && <p>{t(part.kind === "tool_call" ? "toolInput" : "toolOutput")}</p>}
        <pre data-find=""><code>{part.text}</code></pre>
        {part.truncated && <small className="tap-truncated">{t("truncated")}</small>}
      </div>)}
    </div>
  </section>;
}
