import { memo, useMemo, useState, type ReactNode } from "react";
import type { RenderedMessage } from "../lib/subagentTranscriptMessages";
import "./subagent-conversation.css";

export type ConversationLabel = "conversation" | "records" | "parent" | "child" | "user" | "assistant"
  | "final" | "progress" | "context" | "tool_call" | "tool_result" | "reasoning" | "unknown"
  | "details" | "expand" | "collapse" | "empty" | "encrypted";
type Labels = (key: ConversationLabel) => string;
interface Props {
  messages: RenderedMessage[];
  label: Labels;
  renderMarkdown: (text: string) => ReactNode;
}

const LONG_TEXT = 1600;
const ConversationMessage = memo(function ConversationMessage({ message, label, renderMarkdown }: {
  message: RenderedMessage; label: Labels; renderMarkdown: Props["renderMarkdown"];
}) {
  const [expanded, setExpanded] = useState(false);
  const long = message.text.length > LONG_TEXT;
  const dialogue = message.kind === "text" && ["user", "assistant"].includes(message.role);
  const name = message.actor !== "unknown" ? label(message.actor)
    : dialogue ? label(message.role === "user" ? "user" : "assistant") : label(message.kind === "text" ? "unknown" : message.kind);
  return <article className="subagent-chat-message" data-side={dialogue && message.role === "user" ? "right" : "left"}
    data-kind={message.kind} data-actor={message.actor}>
    <div className="subagent-chat-meta">
      <strong>{name}</strong>
      {dialogue && message.phase && <span className="subagent-chat-phase">{label(message.phase)}</span>}
      {message.timestamp && Number.isFinite(Date.parse(message.timestamp)) && <time dateTime={message.timestamp}>
        {new Date(message.timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}
      </time>}
    </div>
    <div className="subagent-chat-bubble">
      {dialogue ? renderMarkdown(long && !expanded ? message.text.slice(0, LONG_TEXT) + "…" : message.text)
        : <pre>{long && !expanded ? message.text.slice(0, LONG_TEXT) + "…" : message.text}</pre>}
      {message.notice === "encrypted" && <p className="subagent-chat-empty">{label("encrypted")}</p>}
      {long && <button type="button" className="subagent-chat-expand" aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}>{label(expanded ? "collapse" : "expand")}</button>}
    </div>
  </article>;
});

function ExecutionGroup({ messages, label, renderMarkdown }: Props) {
  const [open, setOpen] = useState(false);
  const kinds = [...new Set(messages.map(message => message.kind === "text" ? "unknown" : message.kind))];
  return <section className="subagent-chat-details">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span aria-hidden="true">{open ? "▾" : "▸"}</span> {label("details")} · {messages.length}
      <span className="subagent-chat-detail-kinds">{kinds.map(kind => label(kind)).join(" / ")}</span>
    </button>
    {open && messages.map(message => <ConversationMessage key={message.id} message={message} label={label} renderMarkdown={renderMarkdown} />)}
  </section>;
}

/** Presentation only: collapsed records never mount Markdown or hide/delete source data. */
export function SubagentConversation({ messages, label, renderMarkdown }: Props) {
  const [mode, setMode] = useState<"conversation" | "records">("conversation");
  const groups = useMemo(() => {
    const result: { details: boolean; messages: RenderedMessage[] }[] = [];
    for (const message of messages) {
      const details = message.kind !== "text" || !["user", "assistant"].includes(message.role);
      const last = result[result.length - 1];
      if (details && last?.details) last.messages.push(message);
      else result.push({ details, messages: [message] });
    }
    return result;
  }, [messages]);
  return <div className="subagent-chat">
    <div className="subagent-chat-modes" role="group" aria-label={label("conversation")}>
      {(["conversation", "records"] as const).map(value => <button type="button" key={value}
        aria-pressed={mode === value} onClick={() => setMode(value)}>{label(value)}</button>)}
    </div>
    {mode === "conversation" ? <>
      {!groups.some(group => !group.details) && <p className="subagent-chat-empty">{label("empty")}</p>}
      {groups.map(group => group.details
        ? <ExecutionGroup key={group.messages[0].id} messages={group.messages} label={label} renderMarkdown={renderMarkdown} />
        : <ConversationMessage key={group.messages[0].id} message={group.messages[0]} label={label} renderMarkdown={renderMarkdown} />)}
    </> : messages.map(message => <ConversationMessage key={message.id} message={message} label={label} renderMarkdown={renderMarkdown} />)}
  </div>;
}
