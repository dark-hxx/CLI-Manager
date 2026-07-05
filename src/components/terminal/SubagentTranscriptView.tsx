import { memo, useEffect, useMemo, useRef, useState } from "react";
import { debugConsoleWarn } from "../../lib/debugConsole";
import { useI18n } from "../../lib/i18n";
import { getTerminalTheme, isLightTerminalTheme } from "../../lib/terminalThemes";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { MarkdownContent } from "../ui/MarkdownContent";
import { TERM } from "../stats/termStatsUi";

interface Props {
  sessionId: string;
  title?: string;
  /** 面板是否可见（与 XTermTerminal 同条件）；隐藏时不订阅 content、不解析、不滚动。 */
  isVisible: boolean;
}

interface RenderedMessage {
  id: number;
  role: string;
  text: string;
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
}

// 角色配色与统计面板一致：user 绿 / assistant 蓝 / 其余暗色。
const ROLE_COLOR: Record<string, string> = {
  user: TERM.green,
  assistant: TERM.blue,
  tool: TERM.yellow,
};

const SOURCE_LABEL = {
  pending: "Pending",
  "child-jsonl": "Child JSONL",
  "parent-jsonl": "Parent JSONL",
  "lifecycle-only": "Lifecycle only",
} as const;

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

/** 从 Claude transcript 的 message.content（string 或 block 数组）提取可读文本。 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = typeof b.type === "string" ? b.type : "";
    if ((type === "text" || type === "output_text" || type === "input_text") && typeof b.text === "string") {
      parts.push(b.text);
    } else if (type === "thinking" && typeof b.thinking === "string") {
      parts.push(`💭 ${b.thinking}`);
    } else if (type === "tool_use" && typeof b.name === "string") {
      parts.push(`⚙ 调用工具：${b.name}`);
    } else if (type === "function_call" && typeof b.name === "string") {
      const args = typeof b.arguments === "string" && b.arguments.trim() ? `\n${b.arguments}` : "";
      parts.push(`⚙ 调用工具：${b.name}${args}`);
    } else if (type === "function_call_output") {
      const output = typeof b.output === "string" ? b.output : "";
      parts.push(output ? `↳ 工具结果：${output}` : "↳ 工具结果");
    } else if (type === "tool_result") {
      const inner = b.content;
      const text = typeof inner === "string" ? inner : Array.isArray(inner) ? extractText(inner) : "";
      parts.push(text ? `↳ 工具结果：${text}` : "↳ 工具结果");
    }
  }
  return parts.join("\n").trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function parseClaudeTranscriptItem(obj: Record<string, unknown>, id: number): RenderedMessage | null {
  const type = typeof obj.type === "string" ? obj.type : "";
  if (type !== "user" && type !== "assistant") return null;
  const message = asRecord(obj.message);
  if (!message) return null;
  const role = typeof message.role === "string" ? message.role : type;
  const text = extractText(message.content);
  if (!text) return null;
  return { id, role, text };
}

function parseCodexResponseItem(obj: Record<string, unknown>, id: number): RenderedMessage | null {
  if (obj.type !== "response_item") return null;
  const payload = asRecord(obj.payload);
  if (!payload) return null;

  const message = asRecord(payload.message) ?? (payload.type === "message" ? payload : null);
  if (message) {
    const role = typeof message.role === "string" ? message.role : "assistant";
    const text = extractText(message.content);
    if (!text) return null;
    return { id, role, text };
  }

  if (payload.type === "function_call" && typeof payload.name === "string") {
    const args = typeof payload.arguments === "string" && payload.arguments.trim() ? `\n${payload.arguments}` : "";
    return { id, role: "tool", text: `⚙ 调用工具：${payload.name}${args}` };
  }

  if (payload.type === "function_call_output") {
    const output = typeof payload.output === "string" ? payload.output : "";
    return { id, role: "tool", text: output ? `↳ 工具结果：${output}` : "↳ 工具结果" };
  }

  return null;
}

/** 逐行解析 jsonl 片段为可渲染消息（跳过解析失败行），id 从 firstId 起连续分配。 */
function parseTranscriptLines(chunk: string, firstId: number): { messages: RenderedMessage[]; nextId: number } {
  const out: RenderedMessage[] = [];
  let nextId = firstId;
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = parseClaudeTranscriptItem(obj, nextId) ?? parseCodexResponseItem(obj, nextId);
    if (!message) continue;
    out.push(message);
    nextId += 1;
  }
  return { messages: out, nextId };
}

/** 全量解析累积的 jsonl 文本（超过 2MB 仅解析尾部并记录诊断日志）。 */
function parseTranscript(content: string): { messages: RenderedMessage[]; nextId: number } {
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

interface TranscriptMessageRowProps {
  message: RenderedMessage;
  terminalCodeTheme: "light" | "dark";
}

/** 单条消息行：message 对象跨渲染引用稳定，memo 避免历史消息重复走 Markdown 解析。 */
const TranscriptMessageRow = memo(function TranscriptMessageRow({ message, terminalCodeTheme }: TranscriptMessageRowProps) {
  return (
    <li className="subagent-transcript-message" data-role={message.role}>
      <div
        className="subagent-transcript-role"
        style={{ color: ROLE_COLOR[message.role] ?? TERM.dim }}
      >
        {message.role}
      </div>
      <MarkdownContent
        content={message.text}
        variant="terminal"
        terminalCodeTheme={terminalCodeTheme}
        className="subagent-transcript-markdown"
      />
    </li>
  );
});

/**
 * 子 Agent 转录只读视图：渲染由后端 tail 推送、累积在 store 的转录内容。
 * 仅当用户停在底部时自动跟随滚动，避免打断向上翻阅。
 * 性能策略：resetSeq 不变时仅增量解析新增后缀；隐藏（isVisible=false）时不订阅
 * content 更新，直接渲染最近一次解析缓存，切回可见后一次性追平。
 */
export function SubagentTranscriptView({ sessionId, title, isVisible }: Props) {
  const { t } = useI18n();
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const terminalThemeMode = useSettingsStore((s) => s.terminalThemeMode);
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
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
      };
    } else if (content.length > cache.contentLen) {
      // 纯尾部追加：仅解析新增部分（Rust tail 保证推送为完整行），id 续号。
      const appended = parseTranscriptLines(content.slice(cache.contentLen), cache.nextId);
      const merged = appended.messages.length > 0 ? [...cache.messages, ...appended.messages] : cache.messages;
      const capped = capRenderedMessages(merged);
      nextCache = {
        sessionId,
        contentLen: content.length,
        resetSeq,
        nextId: appended.nextId,
        omittedCount: cache.omittedCount + capped.overflow,
        messages: capped.messages,
      };
    }

    if (!nextCache) return;
    parseCacheRef.current = nextCache;
    setParseSnapshot(nextCache);
  }, [isVisible, sessionId, transcript]);

  const messages = parseSnapshot?.messages ?? EMPTY_MESSAGES;
  const omittedCount = parseSnapshot?.omittedCount ?? 0;

  const terminalCodeTheme = useMemo<"light" | "dark">(() => {
    const effectiveTerminalThemeName = terminalThemeMode === "follow-app" ? "auto" : terminalThemeName;
    const terminalTheme = getTerminalTheme(
      effectiveTerminalThemeName,
      resolvedTheme,
      lightThemePalette,
      darkThemePalette
    );
    return isLightTerminalTheme(terminalTheme) ? "light" : "dark";
  }, [darkThemePalette, lightThemePalette, resolvedTheme, terminalThemeMode, terminalThemeName]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // 仅可见时跟随滚动；从隐藏切回可见且此前停在底部时补一次 scrollToBottom。
  useEffect(() => {
    if (!isVisible) return;
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [isVisible, messages]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div
      className="subagent-transcript-shell flex h-full min-h-0 flex-col text-xs"
      style={{ backgroundColor: TERM.bg, color: TERM.fg }}
    >
      <div
        className="flex items-center gap-2 px-3 py-1.5"
        style={{ borderBottom: `1px solid ${TERM.border}`, color: TERM.dim }}
      >
        <span className="truncate text-[11px]">{title ?? "子 Agent 转录"}</span>
        {sourceKind && (
          <span
            className="shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wide"
            style={{ borderColor: SOURCE_COLOR[sourceKind], color: SOURCE_COLOR[sourceKind] }}
          >
            {SOURCE_LABEL[sourceKind]}
          </span>
        )}
        <span
          className="ml-auto shrink-0 text-[10px]"
          style={{ color: ended ? TERM.dim : TERM.green }}
        >
          {ended ? "已结束" : "● 运行中"}
        </span>
      </div>
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {messages.length === 0 ? (
          <div className="mx-auto flex max-w-md flex-col items-center gap-2 py-10 text-center text-[11px]" style={{ color: TERM.dim }}>
            {sourceKind === "pending" ? (
              <>
                <div style={{ color: TERM.blue }}>已捕获子 Agent 事件，正在等待独立 transcript。</div>
                <div>CLI-Manager 只会按当前父会话关联发现对应 transcript，不会扫描无关终端输出。</div>
              </>
            ) : sourceKind === "parent-jsonl" ? (
              <>
                <div style={{ color: TERM.yellow }}>Claude Code 未暴露独立子 Agent transcript。</div>
                <div>当前只检测到父会话 transcript；为避免重复显示主会话内容，此视图仅保留子任务状态。</div>
              </>
            ) : sourceKind === "lifecycle-only" ? (
              <>
                <div>Claude Code 当前没有暴露可读取的子 Agent transcript。</div>
                <div>此视图仅显示启动、运行、完成或失败状态。</div>
              </>
            ) : (
              <div>等待子 Agent 输出…</div>
            )}
          </div>
        ) : (
          <ul className="subagent-transcript-list">
            {omittedCount > 0 && (
              <li className="py-1 text-center text-[10px]" style={{ color: TERM.dim }}>
                {t("subagentTranscript.omittedMessages", { count: omittedCount })}
              </li>
            )}
            {messages.map((m) => (
              <TranscriptMessageRow key={m.id} message={m} terminalCodeTheme={terminalCodeTheme} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
