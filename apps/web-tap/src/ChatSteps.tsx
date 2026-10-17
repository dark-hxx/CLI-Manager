// 對話裡 CLI 的工作過程：思考、工具步驟（摘要、可展開的命令、改動與輸出）、連續命令合成的一組。
// 移植自 Tap-Code（web/src/Conversation.tsx）。
import { useMemo, useState } from "react";
import {
  Bot, Brain, ChevronRight, CircleAlert, FilePen, FileText, FolderSearch, Globe, LoaderCircle, Puzzle, Search, Sparkles,
  SquareTerminal, Wrench, type LucideIcon,
} from "lucide-react";
import { Clamp, Diff, ImageCount } from "./ChatText";
import { useHit } from "./ChatSearch";
import { duration } from "./format";
import { fill, type TextKey, type Translate } from "./i18n";
import { detailText, EDIT_TOOLS, groupCommands, stepsText, type Item, type StepEntry, type ToolStep } from "./transcript";

const ICONS: Record<string, LucideIcon> = {
  Read: FileText, Edit: FilePen, MultiEdit: FilePen, Write: FilePen, NotebookEdit: FilePen, Bash: SquareTerminal, BashOutput: SquareTerminal,
  Grep: Search, Glob: FolderSearch, WebFetch: Globe, WebSearch: Search, Agent: Bot, Task: Bot, Skill: Sparkles,
};
const iconFor = (name: string) => ICONS[name] || (name.startsWith("mcp__") ? Puzzle : Wrench);

const TOOL_LABELS: Record<string, TextKey> = {
  Read: "toolRead", Edit: "toolEdit", MultiEdit: "toolEdit", Write: "toolWrite", NotebookEdit: "toolNotebook", Bash: "toolBash",
  BashOutput: "toolBashOutput", KillShell: "toolStop", TaskStop: "toolStop", Grep: "toolGrep", Glob: "toolGlob", WebFetch: "toolFetch",
  WebSearch: "toolWebSearch", Agent: "toolAgent", Task: "toolAgent", Skill: "toolSkill", EnterPlanMode: "toolPlanMode",
  ToolSearch: "toolSearchTools", LSP: "toolLsp",
};

/** 工具的動詞（「读取」「运行」…）；MCP 工具一律標 MCP，不認得的照工具名稱。 */
export function toolLabel(name: string, t: Translate): string {
  const key = TOOL_LABELS[name];
  if (key) return t(key);
  return name.startsWith("mcp__") ? "MCP" : name;
}

function StepDetail({ step, t }: { step: ToolStep; t: Translate }) {
  const result = step.result;
  return <div className="tap-step-detail">
    {step.name === "Bash" && <pre className="tap-code is-command" data-find="">{`$ ${step.detail || step.summary}`}</pre>}
    {(step.name === "Agent" || step.name === "Task") && step.detail && <Clamp className="tap-code is-prompt" text={step.detail} lines={6} t={t} />}
    {result?.diff && result.diff.length > 0 && <Diff hunks={result.diff} truncated={result.truncated} t={t} />}
    {result?.text && <Clamp className={`tap-code is-output${result.ok ? "" : " is-error"}`} text={result.text} lines={10} t={t} />}
  </div>;
}

function ToolRow({ step, live, t }: { step: ToolStep; live: boolean; t: Translate }) {
  const [open, setOpen] = useState(false);
  const Icon = iconFor(step.name);
  const result = step.result;
  const edit = EDIT_TOOLS.has(step.name);
  const found = useHit(useMemo(() => detailText(step), [step]));
  const expandable = Boolean(result?.text) || Boolean(result?.diff?.length) || step.name === "Bash" || Boolean(step.detail);
  const state = !result ? (live ? "running" : "unknown") : result.ok ? "done" : "error";
  const mcp = step.name.startsWith("mcp__");
  const label = mcp ? step.summary.split(" · ")[0] || "MCP" : toolLabel(step.name, t);
  const summary = mcp ? step.summary.split(" · ").slice(1).join(" · ") : step.summary;
  const summaryHit = useHit(summary);
  const expanded = open || (expandable && found);
  return <li className={`tap-step is-${state}`}>
    <button type="button" className={`tap-step-row${summaryHit ? " is-hit" : ""}`} aria-expanded={expandable ? expanded : undefined}
      disabled={!expandable} onClick={() => setOpen(!expanded)}>
      <Icon size={13} aria-hidden />
      <span className="tap-step-verb">{label}</span>
      {summary && <span className="tap-step-summary" data-find="">{summary}</span>}
      <span className="tap-step-meta">
        {edit && result?.ok && (result.added || result.removed)
          ? <><b className="tap-add">+{result.added ?? 0}</b><b className="tap-del">−{result.removed ?? 0}</b></> : null}
        {result?.images ? <ImageCount count={result.images} t={t} /> : null}
        {state === "running" && <LoaderCircle size={14} className="tap-spin" aria-label={t("stepRunning")} />}
        {state === "error" && <CircleAlert size={14} aria-label={t("stepFailed")} />}
      </span>
    </button>
    {expanded && <StepDetail step={step} t={t} />}
  </li>;
}

/**
 * 連續執行的幾條命令：摺起來是「运行了 N 条命令」，還在跑時顯示最後一條和轉圈；
 * 展開後一條一條列出（每條照常可以再展開看輸出）。搜尋命中其中一條時自動展開。
 */
function CommandGroup({ entry, live, t }: { entry: Extract<StepEntry, { type: "commands" }>; live: boolean; t: Translate }) {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => entry.steps.map(detailText).join("\n"), [entry.steps]);
  const hit = useHit(text);
  const expanded = open || hit;
  const last = entry.steps[entry.steps.length - 1]!;
  const running = live && entry.steps.some((step) => !step.result);
  const failed = entry.steps.filter((step) => step.result && !step.result.ok).length;
  return <li className={`tap-step is-group${failed ? " is-error" : ""}`}>
    <button type="button" className="tap-step-row" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
      <SquareTerminal size={13} aria-hidden />
      <span className="tap-step-verb">{fill(t("commandsRan"), { n: entry.count })}</span>
      {running && !expanded && <span className="tap-step-summary">{last.summary}</span>}
      <span className="tap-step-meta">
        {failed > 0 && <span className="tap-step-failed">{fill(t("commandsFailed"), { n: failed })}</span>}
        {running && <LoaderCircle size={14} className="tap-spin" aria-label={t("stepRunning")} />}
        <ChevronRight size={12} className="tap-step-caret" aria-hidden />
      </span>
    </button>
    {expanded && <ol className="tap-steps is-nested">
      {entry.steps.map((step) => <ToolRow key={step.key} step={step} live={live} t={t} />)}
    </ol>}
  </li>;
}

function ThinkingRow({ text, ms, t }: { text: string; ms?: number; t: Translate }) {
  // 預設展開；很長的先顯示 6 行。
  const [state, setOpen] = useState(true);
  const hit = useHit(text);
  const open = state || hit;
  return <li className="tap-step is-thinking">
    <button type="button" className="tap-step-row" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Brain size={13} aria-hidden />
      <span className="tap-step-verb">{t("thinking")}</span>
      {!open && <span className="tap-step-summary">{text.split("\n")[0]}</span>}
      {Boolean(ms) && <span className="tap-step-meta">{duration(ms!)}</span>}
    </button>
    {open && <Clamp className="tap-step-detail tap-thinking-text" text={text} lines={6} t={t} />}
  </li>;
}

/** 一段工作開頭的思考。Claude Code 預設不存思考內容，這時只顯示花了多久，不能展開。 */
export function Thought({ item, t }: { item: Extract<Item, { type: "thought" }>; t: Translate }) {
  // 預設展開（摺成一行預覽反而難讀）；很長的先顯示 8 行，按「展开」看全文。
  const [state, setOpen] = useState(true);
  const hit = useHit(item.text);
  const open = state || hit;
  const label = item.ms ? fill(t("thoughtFor"), { time: duration(item.ms) }) : t("thinking");
  if (!item.text) return <li className="tap-chat-thought" data-key={item.key}>
    <span className="tap-thought-head"><Brain size={12} aria-hidden /><span>{label}</span></span>
  </li>;
  return <li className={`tap-chat-thought${open ? " is-open" : ""}`} data-key={item.key}>
    <button type="button" className="tap-thought-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <ChevronRight size={12} aria-hidden />
      <span>{label}</span>
      {!open && <span className="tap-thought-preview">{item.text.split("\n")[0]}</span>}
    </button>
    {open && <Clamp className="tap-thought-body tap-thinking-text" text={item.text} lines={8} t={t} />}
  </li>;
}

/** 一段連續的工具步驟：最新的一段預設展開，其餘收成「N 个步骤」；搜尋命中裡面的字時自動展開。 */
export function Steps({ item, initiallyOpen, live, t }: {
  item: Extract<Item, { type: "steps" }>; initiallyOpen: boolean; live: boolean; t: Translate;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const text = useMemo(() => stepsText(item.steps), [item.steps]);
  const entries = useMemo(() => groupCommands(item.steps), [item.steps]);
  const hit = useHit(text);
  const expanded = (open ?? initiallyOpen) || hit;
  const tools = item.steps.filter((step): step is ToolStep => step.type === "tool");
  const times = item.steps.flatMap((step) => [step.at, step.type === "tool" ? step.result?.at : undefined])
    .filter((value): value is number => typeof value === "number");
  const span = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
  const errors = tools.filter((step) => step.result && !step.result.ok).length;
  return <li className={`tap-chat-steps${expanded ? " is-open" : ""}`} data-key={item.key}>
    <button type="button" className="tap-steps-head" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
      <ChevronRight size={12} aria-hidden />
      <span>{tools.length === 1 ? t("stepOne") : fill(t("stepCount"), { n: tools.length })}</span>
      {span >= 1000 && <span className="tap-steps-time">{duration(span)}</span>}
      {errors > 0 && <span className="tap-steps-error">{fill(t("stepsFailed"), { n: errors })}</span>}
    </button>
    {expanded && <ol className="tap-steps">
      {entries.map((entry) => entry.type === "commands" ? <CommandGroup key={entry.key} entry={entry} live={live} t={t} />
        : entry.step.type === "thinking" ? <ThinkingRow key={entry.step.key} text={entry.step.text} ms={entry.step.ms} t={t} />
        : <ToolRow key={entry.step.key} step={entry.step} live={live} t={t} />)}
    </ol>}
  </li>;
}
