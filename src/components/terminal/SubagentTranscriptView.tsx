import { useEffect, useMemo, useRef } from "react";
import { getTerminalTheme, isLightTerminalTheme } from "../../lib/terminalThemes";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { MarkdownContent } from "../ui/MarkdownContent";
import { TERM } from "../stats/termStatsUi";

interface Props {
  sessionId: string;
  title?: string;
}

interface RenderedMessage {
  id: number;
  role: string;
  text: string;
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

/** 解析累积的 jsonl 文本为可渲染消息列表（跳过解析失败行）。 */
function parseTranscript(content: string): RenderedMessage[] {
  const parseContent = content.length > TRANSCRIPT_PARSE_MAX_CHARS
    ? content.slice(-TRANSCRIPT_PARSE_MAX_CHARS)
    : content;
  if (parseContent.length !== content.length) {
    console.warn("[oom-diagnostics:webview]", {
      area: "subagentTranscript",
      phase: "parseTailOnly",
      contentChars: content.length,
      parsedChars: parseContent.length,
      droppedChars: content.length - parseContent.length,
      thresholdExceeded: true,
    });
  }
  const out: RenderedMessage[] = [];
  let id = 0;
  for (const line of parseContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const nextId = id + 1;
    const message = parseClaudeTranscriptItem(obj, nextId) ?? parseCodexResponseItem(obj, nextId);
    if (!message) continue;
    id = nextId;
    out.push(message);
  }
  return out;
}

/**
 * 子 Agent 转录只读视图：渲染由后端 tail 推送、累积在 store 的转录内容。
 * 仅当用户停在底部时自动跟随滚动，避免打断向上翻阅。
 */
export function SubagentTranscriptView({ sessionId, title }: Props) {
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const terminalThemeMode = useSettingsStore((s) => s.terminalThemeMode);
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const transcript = useTerminalStore((s) => s.subagentTranscripts[sessionId]);
  const content = transcript?.content ?? "";
  const source = transcript?.source;
  const messages = useMemo(() => parseTranscript(content), [content]);
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

  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [content]);

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
        {source && (
          <span
            className="shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wide"
            style={{ borderColor: SOURCE_COLOR[source.kind], color: SOURCE_COLOR[source.kind] }}
          >
            {SOURCE_LABEL[source.kind]}
          </span>
        )}
        <span
          className="ml-auto shrink-0 text-[10px]"
          style={{ color: transcript?.ended ? TERM.dim : TERM.green }}
        >
          {transcript?.ended ? "已结束" : "● 运行中"}
        </span>
      </div>
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {messages.length === 0 ? (
          <div className="mx-auto flex max-w-md flex-col items-center gap-2 py-10 text-center text-[11px]" style={{ color: TERM.dim }}>
            {source?.kind === "pending" ? (
              <>
                <div style={{ color: TERM.blue }}>已捕获子 Agent 事件，正在等待独立 transcript。</div>
                <div>CLI-Manager 只会按当前父会话关联发现对应 transcript，不会扫描无关终端输出。</div>
              </>
            ) : source?.kind === "parent-jsonl" ? (
              <>
                <div style={{ color: TERM.yellow }}>Claude Code 未暴露独立子 Agent transcript。</div>
                <div>当前只检测到父会话 transcript；为避免重复显示主会话内容，此视图仅保留子任务状态。</div>
              </>
            ) : source?.kind === "lifecycle-only" ? (
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
            {messages.map((m) => (
              <li key={m.id} className="subagent-transcript-message" data-role={m.role}>
                <div
                  className="subagent-transcript-role"
                  style={{ color: ROLE_COLOR[m.role] ?? TERM.dim }}
                >
                  {m.role}
                </div>
                <MarkdownContent
                  content={m.text}
                  variant="terminal"
                  terminalCodeTheme={terminalCodeTheme}
                  className="subagent-transcript-markdown"
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
