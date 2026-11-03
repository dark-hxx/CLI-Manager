import { parseTranscriptLines, type RenderedMessage, type TranscriptParserState } from "../../../shared/lib/subagentTranscriptMessages";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { SubagentConversation, type ConversationLabel } from "../../../shared/ui/SubagentConversation";
import { debugConsoleWarn } from "../../../shared/platform/debugConsole";
import { useI18n } from "../../../shared/i18n/index";
import { useTerminalPreviewTheme } from "../api/useTerminalPreviewTheme";
import { useTerminalStore } from "../state";
import { MarkdownContent } from "../../../shared/ui/MarkdownContent";
import { TERM } from "../../stats/api/termStatsUi";

interface Props {
  sessionId: string;
  title?: string;
  /** 面板是否可见（与 XTermTerminal 同条件）；隐藏时不订阅 content、不解析、不滚动。 */
  isVisible: boolean;
}

/** 增量解析缓存：resetSeq 不变且 content 只增长时，仅解析新增后缀。 */
interface TranscriptParseCache {
  sessionId: string;
  contentLen: number;
  resetSeq: number;
  /** 下一条消息应使用的 id（保证跨增量解析递增稳定，memo 行 key 可靠）。 */
  nextId: number;
  /** 因渲染上限从头裁剪掉的消息条数（累计）。 */
  omittedCount: number;
  messages: RenderedMessage[];
  state: TranscriptParserState;
}

const SOURCE_COLOR = {
  pending: TERM.blue,
  "child-jsonl": TERM.green,
  "parent-jsonl": TERM.yellow,
  "lifecycle-only": TERM.dim,
} as const;
const TRANSCRIPT_PARSE_MAX_CHARS = 2 * 1024 * 1024;
/** 渲染上限：超出后从头裁剪，避免超长转录把 DOM/Markdown 渲染成本推向无界。 */
const MAX_RENDERED_MESSAGES = 300;

const EMPTY_MESSAGES: RenderedMessage[] = [];
const MIN_SUBAGENT_SCROLLBAR_THUMB = 24;

interface ScrollbarMetrics {
  visible: boolean;
  thumbHeight: number;
  thumbTop: number;
}

/** 全量解析累积的 jsonl 文本（超过 2MB 仅解析尾部并记录诊断日志）。 */
function parseTranscript(content: string): ReturnType<typeof parseTranscriptLines> {
  const parseContent = content.length > TRANSCRIPT_PARSE_MAX_CHARS
    ? content.slice(-TRANSCRIPT_PARSE_MAX_CHARS)
    : content;
  if (parseContent.length !== content.length) {
    debugConsoleWarn("[oom-diagnostics:webview]", {
      area: "subagentTranscript",
      phase: "parseTailOnly",
      contentChars: content.length,
      parsedChars: parseContent.length,
      droppedChars: content.length - parseContent.length,
      thresholdExceeded: true,
    });
  }
  return parseTranscriptLines(parseContent, 1);
}

/** 按渲染上限从头裁剪消息列表，返回裁剪后的列表与本次新增的省略条数。 */
function capRenderedMessages(messages: RenderedMessage[]): { messages: RenderedMessage[]; overflow: number } {
  const overflow = Math.max(0, messages.length - MAX_RENDERED_MESSAGES);
  return { messages: overflow > 0 ? messages.slice(overflow) : messages, overflow };
}

/**
 * 子 Agent 转录只读视图：渲染由后端 tail 推送、累积在 store 的转录内容。
 * 仅当用户停在底部时自动跟随滚动，避免打断向上翻阅。
 * 性能策略：resetSeq 不变时仅增量解析新增后缀；隐藏（isVisible=false）时不订阅
 * content 更新，直接渲染最近一次解析缓存，切回可见后一次性追平。
 */
export function SubagentTranscriptView({ sessionId, title, isVisible }: Props) {
  const { t } = useI18n();
  const { tone: terminalCodeTheme, panelStyle } = useTerminalPreviewTheme();
  const label = useCallback((key: ConversationLabel) => t(`subagentTranscript.${key}`), [t]);
  const renderMarkdown = useCallback((text: string) => <MarkdownContent content={text} variant="terminal"
    terminalCodeTheme={terminalCodeTheme} className="subagent-transcript-markdown" />, [terminalCodeTheme]);
  // 隐藏时返回 undefined（稳定值）：转录追加不再触发本组件重渲染。
  const transcript = useTerminalStore((s) => (isVisible ? s.subagentTranscripts[sessionId] : undefined));
  // header 状态用独立原始值 selector 订阅，隐藏时也保持正确。
  const ended = useTerminalStore((s) => s.subagentTranscripts[sessionId]?.ended ?? false);
  const sourceKind = useTerminalStore((s) => s.subagentTranscripts[sessionId]?.source.kind);

  const parseCacheRef = useRef<TranscriptParseCache | null>(null);
  const [parseSnapshot, setParseSnapshot] = useState<TranscriptParseCache | null>(null);

  useEffect(() => {
    if (!isVisible || !transcript) return;

    const { content, resetSeq } = transcript;
    const cache = parseCacheRef.current;
    let nextCache: TranscriptParseCache | null = null;

    if (!cache || cache.sessionId !== sessionId || cache.resetSeq !== resetSeq || content.length < cache.contentLen) {
      // reset / 前部裁剪 / 首次解析：走全量路径（保留 2MB 上限与诊断日志）。
      const parsed = parseTranscript(content);
      const capped = capRenderedMessages(parsed.messages);
      nextCache = {
        sessionId,
        contentLen: content.length,
        resetSeq,
        nextId: parsed.nextId,
        omittedCount: capped.overflow,
        messages: capped.messages,
        state: parsed.state,
      };
    } else if (content.length > cache.contentLen) {
      // 纯尾部追加：仅解析新增部分（Rust tail 保证推送为完整行），id 续号。
      const appended = parseTranscriptLines(content.slice(cache.contentLen), cache.nextId, undefined, cache.state);
      const merged = appended.messages.length > 0 ? [...cache.messages, ...appended.messages] : cache.messages;
      const capped = capRenderedMessages(merged);
      nextCache = {
        sessionId,
        contentLen: content.length,
        resetSeq,
        nextId: appended.nextId,
        omittedCount: cache.omittedCount + capped.overflow,
        messages: capped.messages,
        state: appended.state,
      };
    }

    if (!nextCache) return;
    parseCacheRef.current = nextCache;
    setParseSnapshot(nextCache);
  }, [isVisible, sessionId, transcript]);

  const messages = parseSnapshot?.sessionId === sessionId ? parseSnapshot.messages : EMPTY_MESSAGES;
  const omittedCount = parseSnapshot?.omittedCount ?? 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const scrollbarTrackRef = useRef<HTMLDivElement>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement>(null);
  const scrollbarDragRef = useRef<{ pointerId: number; startY: number; startScrollTop: number } | null>(null);
  const [scrollbarDragging, setScrollbarDragging] = useState(false);
  const [scrollbarVisible, setScrollbarVisible] = useState(false);
  const scrollbarMetricsRef = useRef<ScrollbarMetrics>({ visible: false, thumbHeight: 0, thumbTop: 0 });
  const atBottomRef = useRef(true);

  const syncScrollbar = useCallback(() => {
    const scrollElement = scrollRef.current;
    const trackElement = scrollbarTrackRef.current;
    if (!scrollElement || !trackElement) return;

    const viewportHeight = scrollElement.clientHeight;
    const contentHeight = scrollElement.scrollHeight;
    const trackHeight = trackElement.clientHeight;
    const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
    const visible = viewportHeight > 0 && trackHeight > 0 && maxScrollTop > 1;
    const thumbElement = scrollbarThumbRef.current;

    if (!visible) {
      scrollbarMetricsRef.current = { visible: false, thumbHeight: 0, thumbTop: 0 };
      if (thumbElement) {
        thumbElement.style.height = "0px";
        thumbElement.style.transform = "translateY(0px)";
      }
      setScrollbarVisible((current) => (current ? false : current));
      return;
    }

    const thumbHeight = Math.min(
      trackHeight,
      Math.max(MIN_SUBAGENT_SCROLLBAR_THUMB, Math.round(trackHeight * viewportHeight / contentHeight)),
    );
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = maxScrollTop > 0
      ? Math.round((scrollElement.scrollTop / maxScrollTop) * maxThumbTop)
      : 0;

    scrollbarMetricsRef.current = { visible, thumbHeight, thumbTop };
    if (thumbElement) {
      thumbElement.style.height = `${thumbHeight}px`;
      thumbElement.style.transform = `translateY(${thumbTop}px)`;
    }
    setScrollbarVisible((current) => (current === visible ? current : visible));
  }, []);

  // 仅可见时跟随滚动；从隐藏切回可见且此前停在底部时补一次 scrollToBottom。
  useLayoutEffect(() => {
    if (!isVisible) return;
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
    syncScrollbar();
  }, [isVisible, messages, syncScrollbar]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    const contentElement = scrollContentRef.current;
    if (!scrollElement) return;

    const resizeObserver = new ResizeObserver(syncScrollbar);
    resizeObserver.observe(scrollElement);
    if (contentElement) resizeObserver.observe(contentElement);
    syncScrollbar();
    return () => resizeObserver.disconnect();
  }, [syncScrollbar]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    syncScrollbar();
  };

  const handleScrollbarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || !scrollbarMetricsRef.current.visible) return;
    event.preventDefault();
    event.stopPropagation();
    scrollbarDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: scrollElement.scrollTop,
    };
    setScrollbarDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleScrollbarPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = scrollbarDragRef.current;
    const scrollElement = scrollRef.current;
    const trackElement = scrollbarTrackRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !scrollElement || !trackElement) return;

    const maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    const maxThumbTop = Math.max(1, trackElement.clientHeight - scrollbarMetricsRef.current.thumbHeight);
    const nextScrollTop = drag.startScrollTop
      + ((event.clientY - drag.startY) / maxThumbTop) * maxScrollTop;
    scrollElement.scrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
    syncScrollbar();
  };

  const handleScrollbarPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = scrollbarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    scrollbarDragRef.current = null;
    setScrollbarDragging(false);
  };

  return (
    <div
      className="subagent-transcript-shell flex h-full min-h-0 flex-col text-xs"
      style={{ ...panelStyle, backgroundColor: TERM.bg, color: TERM.fg }}
    >
      <div
        className="flex items-center gap-2 px-3 py-1.5"
        style={{ borderBottom: `1px solid ${TERM.border}`, color: TERM.dim }}
      >
        <span className="truncate text-[11px]">{title ?? t("subagentTranscript.title")}</span>
        {sourceKind && (
          <span
            className="shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wide"
            style={{ borderColor: SOURCE_COLOR[sourceKind], color: SOURCE_COLOR[sourceKind] }}
          >
            {t(`subagentTranscript.source.${sourceKind}`)}
          </span>
        )}
        <span
          className="ml-auto shrink-0 text-[10px]"
          style={{ color: ended ? TERM.dim : TERM.green }}
        >
          {t(ended ? "subagentTranscript.ended" : "subagentTranscript.running")}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={handleScroll} className="ui-terminal-native-scroll h-full min-h-0 overflow-x-hidden overflow-y-auto px-3 py-2">
          <div ref={scrollContentRef}>
            {((transcript?.truncatedBytes ?? 0) > 0 || (transcript?.content.length ?? 0) > TRANSCRIPT_PARSE_MAX_CHARS) && (
              <div className="py-1 text-center text-[10px]" style={{ color: TERM.dim }}>{t("subagentTranscript.truncated")}</div>
            )}
            {messages.length === 0 ? (
              <div className="mx-auto flex max-w-md flex-col items-center gap-2 py-10 text-center text-[11px]" style={{ color: TERM.dim }}>
                {sourceKind === "pending" ? (
                  <>
                    <div style={{ color: TERM.blue }}>{t("subagentTranscript.pending")}</div>
                  </>
                ) : sourceKind === "parent-jsonl" ? (
                  <>
                    <div style={{ color: TERM.yellow }}>{t("subagentTranscript.parentOnly")}</div>
                  </>
                ) : sourceKind === "lifecycle-only" ? (
                  <>
                    <div>{t("subagentTranscript.lifecycleOnly")}</div>
                  </>
                ) : (
                  <div>{t("subagentTranscript.waiting")}</div>
                )}
              </div>
            ) : (
              <>
                {omittedCount > 0 && (
                  <div className="py-1 text-center text-[10px]" style={{ color: TERM.dim }}>
                    {t("subagentTranscript.omittedMessages", { count: omittedCount })}
                  </div>
                )}
                <SubagentConversation key={`${sessionId}:${parseSnapshot?.resetSeq}`} messages={messages}
                  label={label} renderMarkdown={renderMarkdown} />
              </>
            )}
          </div>
        </div>
        <div
          ref={scrollbarTrackRef}
          className="ui-subagent-scrollbar"
          data-visible={scrollbarVisible ? "true" : "false"}
          data-dragging={scrollbarDragging ? "true" : "false"}
          aria-hidden="true"
        >
          <div
            ref={scrollbarThumbRef}
            className="ui-subagent-scrollbar-thumb"
            onPointerDown={handleScrollbarPointerDown}
            onPointerMove={handleScrollbarPointerMove}
            onPointerUp={handleScrollbarPointerUp}
            onPointerCancel={handleScrollbarPointerUp}
          />
        </div>
      </div>
    </div>
  );
}
