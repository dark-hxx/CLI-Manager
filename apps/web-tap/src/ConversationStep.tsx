// 執行過程裡的一個工具步驟：一列摘要（圖示、工具標籤、關鍵參數、增刪行數或結束碼），點開看改動、命令與輸出、
// 任務清單，其他工具照原本過程卡的輸入與輸出呈現。呈現方式移植自 Tap-Code（web/src/Conversation.tsx、DiffView.tsx）。
// 詳情預設收起：即時刷新不會展開，使用者展開後同一個步驟刷新仍保持展開。
import { Fragment, memo, useId, useMemo, useState, type CSSProperties } from "react";
import {
  Bot, ChevronRight, Circle, CircleAlert, CircleCheck, CircleDashed, CircleDot, ClipboardList, FilePen, FilePlus, FileText, FolderSearch,
  Globe, Image, ListChecks, MessageCircleQuestion, Puzzle, Search, Sparkles, SquareTerminal, Wrench, type LucideIcon,
} from "lucide-react";
import type { TranscriptPart } from "./protocol";
import { useHit } from "./ChatSearch";
import { cells, laidOut, parseSgr, runColors } from "./ansi";
import { hunkRows, type Hunk } from "./diff";
import { commandResult, fileName, stepDetailText, type DiffFile, type StepIcon, type StepView, type Todo } from "./tools";
import { fill, type TextKey, type Translate } from "./i18n";

const ICONS: Record<StepIcon, LucideIcon> = {
  read: FileText, edit: FilePen, write: FilePlus, bash: SquareTerminal, search: Search, files: FolderSearch, web: Globe, agent: Bot,
  todo: ListChecks, plan: ClipboardList, image: Image, mcp: Puzzle, skill: Sparkles, ask: MessageCircleQuestion, tool: Wrench,
};
const FILE_OPS: Record<DiffFile["op"], TextKey> = { add: "fileAdded", update: "fileUpdated", delete: "fileDeleted" };
const SIGNS = { add: "+", del: "−", same: " " } as const;

/** 摘要裡的檔案路徑：先顯示檔名，所在目錄淡一點跟在後面（太長時目錄先被截掉）。 */
function PathSummary({ path }: { path: string }) {
  const trimmed = path.replace(/[\\/]+$/, "") || path;
  const name = fileName(trimmed);
  const dir = trimmed.slice(0, Math.max(0, trimmed.length - name.length)).replace(/[\\/]+$/, "");
  return <span className="tap-step-summary is-path" data-find="">
    <span className="tap-step-file">{name}</span>{dir && <span className="tap-step-dir">{dir}</span>}
  </span>;
}

/** 增刪行數；只算到一部分（replace_all）時前面標「約」。 */
function Changes({ changes, t }: { changes: NonNullable<StepView["changes"]>; t: Translate }) {
  if (changes.exactness === "unknown" || (!changes.added && !changes.removed)) return null;
  return <span className="tap-step-changes">
    {changes.exactness === "lower" && <span>{t("approx")}</span>}
    <b className="tap-add">+{changes.added}</b><b className="tap-del">−{changes.removed}</b>
  </span>;
}

/** 一個工具步驟；view 由 tools.ts 推導，同一個步驟刷新時沿用同一個物件，memo 擋得住重繪。 */
function StepRow({ view, t }: { view: StepView; t: Translate }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const detail = useMemo(() => stepDetailText(view), [view]);
  // 搜尋命中展開後才看得到的內容時暫時展開；關掉搜尋就回到使用者原本的選擇。
  const hit = useHit(detail);
  const summaryHit = useHit(view.summary);
  const expanded = open || hit;
  const Icon = ICONS[view.icon];
  const label = view.label ? t(view.label) : view.rawLabel || view.name;
  const todos = view.detail.type === "todos" ? view.detail.items : undefined;
  return <section className={`tap-step${view.failed ? " is-failed" : ""}`} data-anchor={view.id}>
    <button type="button" className={`tap-step-row${summaryHit ? " is-hit" : ""}`} aria-expanded={expanded} aria-controls={bodyId}
      title={view.title} onClick={() => setOpen(!expanded)}>
      <ChevronRight size={13} className={`tap-step-caret${expanded ? " is-open" : ""}`} aria-hidden />
      <Icon size={14} className="tap-step-icon" aria-hidden />
      <span className="tap-step-verb">{label}</span>
      {view.summary && (view.path ? <PathSummary path={view.summary} />
        : <span className="tap-step-summary" data-find="">{view.summary}</span>)}
      <span className="tap-step-meta">
        {view.changes && <Changes changes={view.changes} t={t} />}
        {todos && todos.length > 0 && <span>{fill(t("todoProgress"), { done: todos.filter((item) => item.status === "completed").length, total: todos.length })}</span>}
        {view.exit !== undefined && view.exit !== 0 && <span className="tap-step-exit">{fill(t("exitCode"), { code: view.exit })}</span>}
        {view.failed && <CircleAlert size={14} className="tap-step-failed" role="img" aria-label={t("stepFailed")} />}
      </span>
    </button>
    <div id={bodyId} className="tap-step-detail" hidden={!expanded}>
      {expanded && <StepDetail view={view} t={t} />}
    </div>
  </section>;
}

export const ConversationStep = memo(StepRow);

function StepDetail({ view, t }: { view: StepView; t: Translate }) {
  const detail = view.detail;
  if (detail.type === "command") return <CommandView command={detail.command} description={detail.description} stdin={detail.stdin}
    results={view.results} exit={view.exit} t={t} />;
  if (detail.type === "diff") return <>
    <DiffView files={detail.files} showFiles={detail.showFiles} truncated={detail.truncated || view.parts[0]!.truncated === true} t={t} />
    <Outputs results={view.results} failed={view.failed} t={t} />
  </>;
  if (detail.type === "todos") return <>
    <TodoList items={detail.items} explanation={detail.explanation} t={t} />
    <Outputs results={view.results} failed={view.failed} t={t} />
  </>;
  return <PartList parts={view.parts} t={t} />;
}

/** 原本過程卡的呈現：每一塊標出是輸入或輸出，原文照登，被截斷的明確標示。 */
function PartList({ parts, t }: { parts: TranscriptPart[]; t: Translate }) {
  return <>{parts.map((part) => <div className="tap-activity-part" key={part.id}>
    <p>{t(part.kind === "tool_call" ? "toolInput" : "toolOutput")}</p>
    <pre data-find=""><code>{part.text}</code></pre>
    {part.truncated && <small className="tap-truncated">{t("truncated")}</small>}
  </div>)}</>;
}

/** 改檔步驟的工具輸出（Claude 的「已更新」回報、Codex 的 Success…）：預設收起；CLI 明確記錄失敗時一打開就看得到錯誤。 */
function Outputs({ results, failed, t }: { results: TranscriptPart[]; failed: boolean; t: Translate }) {
  const [open, setOpen] = useState(failed);
  const bodyId = useId();
  const hit = useHit(useMemo(() => results.map((part) => part.text).join("\n"), [results]));
  const expanded = open || hit;
  if (!results.length) return null;
  return <div className="tap-step-outputs">
    <button type="button" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setOpen(!expanded)}>
      <ChevronRight size={12} className={expanded ? "is-open" : undefined} aria-hidden />{t("toolOutput")}
    </button>
    <div id={bodyId} hidden={!expanded}>{expanded && <PartList parts={results} t={t} />}</div>
  </div>;
}

/** 差異：多個檔案時每個檔案一個標題（新增、修改、刪除與路徑）；行號只在確定時顯示，其餘只標 +、−。 */
function DiffView({ files, showFiles, truncated, t }: { files: DiffFile[]; showFiles: boolean; truncated: boolean; t: Translate }) {
  return <div className="tap-diff">
    {files.map((file, index) => <section className="tap-diff-file" key={`${index}:${file.path}`}>
      {showFiles && <header className="tap-diff-head">
        <span className={`tap-diff-op is-${file.op}`}>{t(FILE_OPS[file.op])}</span>
        <span className="tap-diff-path" data-find="">{file.moved ? `${file.path} → ${file.moved}` : file.path}</span>
        {(file.added > 0 || file.removed > 0) && <span className="tap-step-changes">
          <b className="tap-add">+{file.added}</b><b className="tap-del">−{file.removed}</b>
        </span>}
      </header>}
      {file.hunks.map((hunk, at) => <HunkView key={at} hunk={hunk} t={t} />)}
      {!file.hunks.some((hunk) => hunk.lines.length) && file.op !== "delete" && <p className="tap-diff-empty">{t("noChanges")}</p>}
    </section>)}
    {truncated && <small className="tap-truncated">{t("truncated")}</small>}
  </div>;
}

function HunkView({ hunk, t }: { hunk: Hunk; t: Translate }) {
  const rows = useMemo(() => hunkRows(hunk), [hunk]);
  const numbered = hunk.newStart !== undefined;
  return <div className={`tap-hunk${numbered ? " is-numbered" : ""}`}>
    {(hunk.header || hunk.replaceAll) && <div className="tap-hunk-head">
      {hunk.replaceAll && <span>{t("replaceAll")}</span>}{hunk.header && <code data-find="">{hunk.header}</code>}
    </div>}
    {rows.map((row, index) => <div className={`tap-hunk-line is-${row.tone}`} key={index}>
      {numbered && <span className="tap-hunk-num" aria-hidden>{row.number ?? ""}</span>}
      <span className="tap-hunk-sign">{SIGNS[row.tone]}</span>
      <span className="tap-hunk-text" data-find="">{row.text || " "}</span>
    </div>)}
  </div>;
}

/** 帶 SGR 的輸出轉成行內樣式（不碰 HTML）；非 ASCII 的字各佔固定的 1 或 2 欄，表格與框線才對得齊。 */
function AnsiText({ text }: { text: string }) {
  return <>{parseSgr(text).map((run, index) => {
    const { fg, bg } = runColors(run);
    const style: CSSProperties = {};
    if (fg) style.color = fg;
    if (bg) style.backgroundColor = bg;
    if (run.bold) style.fontWeight = 700;
    if (run.dim) style.opacity = 0.6;
    if (run.italic) style.fontStyle = "italic";
    const lines = [run.underline && "underline", run.strike && "line-through"].filter(Boolean);
    if (lines.length) style.textDecoration = lines.join(" ");
    const content = cells(run.text).map((cell, at) => typeof cell === "string" ? cell
      : <span key={at} className={`tap-ansi-cell${cell.wide ? " is-wide" : ""}`}>{cell.char}</span>);
    return Object.keys(style).length ? <span key={index} style={style}>{content}</span> : <Fragment key={index}>{content}</Fragment>;
  })}</>;
}

/** 命令與輸出：同一個深色終端區塊，命令在上、輸出照終端顏色在下；靠空白排版的輸出不換行，改成左右捲動。 */
function CommandView({ command, description, stdin, results, exit, t }: {
  command: string; description?: string; stdin?: string; results: TranscriptPart[]; exit?: number; t: Translate;
}) {
  const outputs = useMemo(() => results.map((part) => ({ part, body: commandResult(part.text).body.replace(/\n+$/, "") })), [results]);
  return <div className="tap-command">
    {description && <p className="tap-command-note" data-find="">{description}</p>}
    <div className="tap-term">
      {command && <pre className="tap-term-command" data-find=""><span className="tap-term-prompt" aria-hidden>$ </span>{command}</pre>}
      {stdin && <pre className="tap-term-command" data-find=""><span className="tap-term-prompt" aria-hidden>› </span>{stdin}</pre>}
      {outputs.map(({ part, body }) => <Fragment key={part.id}>
        {body && <pre className={`tap-term-output${laidOut(body) ? " is-laid" : ""}`} data-find=""><AnsiText text={body} /></pre>}
        {part.truncated && <small className="tap-term-note">{t("truncated")}</small>}
      </Fragment>)}
      {exit !== undefined && <small className={`tap-term-note${exit === 0 ? "" : " is-error"}`}>{fill(t("exitCode"), { code: exit })}</small>}
    </div>
  </div>;
}

/** 任務清單（TodoWrite、update_plan）：完成的劃掉，進行中的用品牌色；不認得的狀態照原文標出。 */
function TodoList({ items, explanation, t }: { items: Todo[]; explanation?: string; t: Translate }) {
  return <div className="tap-todos">
    {explanation && <p className="tap-command-note" data-find="">{explanation}</p>}
    <ul>{items.map((item, index) => {
      const known = item.status === "completed" || item.status === "in_progress" || item.status === "pending";
      const Icon = item.status === "completed" ? CircleCheck : item.status === "in_progress" ? CircleDot : known ? Circle : CircleDashed;
      const status = item.status === "completed" ? t("todoCompleted") : item.status === "in_progress" ? t("todoInProgress")
        : known ? t("todoPending") : item.status;
      return <li key={index} className={`is-${known ? item.status : "other"}`}>
        <Icon size={14} role="img" aria-label={status} />
        <span data-find="">{item.text}</span>
        {!known && <small>{item.status}</small>}
      </li>;
    })}</ul>
  </div>;
}
