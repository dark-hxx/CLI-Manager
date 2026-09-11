import { useEffect, useId, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseTranscriptLines } from "../../../src/shared/lib/subagentTranscriptMessages";
import type { WebSubagentSnapshot } from "./domain";
import type { TranslationKey } from "./i18n";

type T = (key: TranslationKey) => string;

export function SubagentPanel({ agents, active, t }: { agents: WebSubagentSnapshot[]; active: boolean; t: T }) {
  const [expanded, setExpanded] = useState(() => typeof matchMedia !== "undefined" && matchMedia("(min-width: 900px)").matches);
  const [selectedId, setSelectedId] = useState<string>();
  const id = useId();
  const selected = agents.find((agent) => agent.sessionId === selectedId) ?? agents[0];
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const messages = useMemo(() => active && expanded && selected
    ? parseTranscriptLines(selected.content, 1, { toolCall: t("subagentToolCall"), toolResult: t("subagentToolResult") }).messages
    : [], [active, expanded, selected?.content, t]);
  useEffect(() => {
    followingRef.current = true;
    setFollowing(true);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [selected?.sessionId]);
  useEffect(() => {
    if (active && expanded && followingRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [active, expanded, selected?.content]);
  if (!selected) return null;
  const tabId = (sessionId: string) => `${id}-tab-${sessionId}`;
  const select = (sessionId: string) => {
    setSelectedId(sessionId);
    document.getElementById(tabId(sessionId))?.focus();
  };
  return <aside className={`web-subagent-panel${expanded ? " expanded" : " collapsed"}`} aria-label={t("subagents")}>
    <header><button type="button" aria-expanded={expanded} aria-controls={`${id}-body`} onClick={() => setExpanded(!expanded)} title={t(expanded ? "subagentCollapse" : "subagentExpand")}>
      <span aria-hidden="true">{expanded ? "▾" : "▸"}</span> {t("subagents")} ({agents.length})
    </button><span className="web-subagent-readonly">{t("subagentReadOnly")}</span></header>
    <div id={`${id}-body`} className="web-subagent-body" hidden={!expanded}>
      <div className="web-subagent-tabs" role="tablist" aria-label={t("subagents")}>
        {agents.map((agent, index) => <button key={agent.sessionId} id={tabId(agent.sessionId)} type="button" role="tab" aria-selected={agent.sessionId === selected.sessionId} aria-controls={`${id}-content`} tabIndex={agent.sessionId === selected.sessionId ? 0 : -1} onClick={() => setSelectedId(agent.sessionId)} onKeyDown={(event) => {
          let next = index;
          if (event.key === "ArrowRight") next = (index + 1) % agents.length;
          else if (event.key === "ArrowLeft") next = (index - 1 + agents.length) % agents.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = agents.length - 1;
          else return;
          event.preventDefault(); select(agents[next].sessionId);
        }} title={agent.title}><span className={agent.ended ? "ended" : "running"} aria-hidden="true">●</span> {agent.title}</button>)}
      </div>
      <div className="web-subagent-status" role="status">{t(selected.ended ? "subagentEnded" : "subagentRunning")}{selected.truncated && <span>{t("subagentTruncated")}</span>}</div>
      <div ref={scrollRef} id={`${id}-content`} className="web-subagent-transcript" role="tabpanel" aria-labelledby={tabId(selected.sessionId)} tabIndex={0} onScroll={() => {
        const element = scrollRef.current;
        if (!element) return;
        const next = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        followingRef.current = next; setFollowing(next);
      }}>
        {messages.length ? messages.map((message) => <article key={`${selected.sessionId}:${message.id}`} className="web-subagent-message">
          <strong>{t(message.role === "user" ? "subagentUser" : message.role === "assistant" ? "assistant" : "subagentTool")}</strong>
          <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt }) => <span>{alt}</span> }}>{message.text}</Markdown>
        </article>) : <p className="web-subagent-empty">{t(selected.ended ? "subagentNoContent" : selected.sourceKind === "lifecycle-only" ? "subagentLifecycleOnly" : "subagentWaiting")}</p>}
      </div>
      {!following && <button type="button" className="web-subagent-follow" onClick={() => {
        followingRef.current = true; setFollowing(true);
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }}>{t("scrollToBottom")}</button>}
    </div>
  </aside>;
}
