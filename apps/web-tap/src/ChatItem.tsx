// 對話時間軸上的一列：你的訊息、斜杠命令與輸出、回覆、思考、步驟、計劃、收尾列、通知；
// 以及做完的一輪收起來的過程、任務清單。移植自 Tap-Code（web/src/Conversation.tsx）。
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowUpToLine, Check, ChevronRight, Circle, CircleCheck, CircleDot, ClipboardList, Clock, Copy, Info, ListChecks, TriangleAlert, Zap,
  type LucideIcon,
} from "lucide-react";
import { ChatMarkdown, Clamp, ImageCount, Output } from "./ChatText";
import { Steps, Thought } from "./ChatSteps";
import { useHit, useSearching } from "./ChatSearch";
import { scrollToItem } from "./chatScroll";
import { clock, duration, fullTime } from "./format";
import { fill, type Translate } from "./i18n";
import { foldModel, itemText, noticeKey, type Item, type ModelUsed, type Task, type WorkFold } from "./transcript";

/** 複製到剪貼簿；不是安全連線（例如內網的 http）時改用舊的做法。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 改用下方的相容做法。 */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
  document.body.append(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { copied = false; }
  area.remove();
  return copied;
}

/**
 * 一輪回覆的收尾列：複製回覆、回到這一輪的提問、結束時刻、用時與這一輪的增刪行數；
 * 也是兩輪之間的分隔。
 */
function TurnFooter({ item, t }: { item: Extract<Item, { type: "turn" }>; t: Translate }) {
  const { text, ms, at, prompt, added, removed } = item;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return <li className="tap-chat-turn" data-key={item.key}>
    {text && <button type="button" className="tap-turn-action" aria-label={t(copied ? "replyCopied" : "copyReply")}
      title={t(copied ? "copied" : "copyReplyShort")} onClick={() => void copyText(text).then(setCopied)}>
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </button>}
    {prompt && <button type="button" className="tap-turn-action" aria-label={t("toPrompt")} title={t("toPromptShort")}
      onClick={(event) => scrollToItem(prompt, event.currentTarget)}><ArrowUpToLine size={13} aria-hidden /></button>}
    {at !== undefined && <time className="tap-turn-meta" dateTime={new Date(at).toISOString()} title={fill(t("finishedAt"), { time: fullTime(at) })}>
      <span>{clock(at)}</span>
    </time>}
    <span className="tap-turn-meta" title={t("turnTime")} aria-label={fill(t("turnTimeLabel"), { time: duration(ms) })}>
      <Clock size={12} aria-hidden /><span>{duration(ms)}</span>
    </span>
    {added || removed ? <span className="tap-turn-meta tap-turn-changes" aria-label={fill(t("turnChanges"), { added: added ?? 0, removed: removed ?? 0 })}>
      {Boolean(added) && <span className="tap-add">+{added}</span>}
      {Boolean(removed) && <span className="tap-del">−{removed}</span>}
    </span> : null}
  </li>;
}

export const ChatItem = memo(function ChatItem({ item, last, live, inserted, t }: {
  item: Item; last: boolean;
  /** CLI 正在做這一項（只傳給最後一項）。 */
  live: boolean;
  /** 中途插入的訊息（SDK 送進來的一般訊息也算），標上「插入当前回合」。 */
  inserted: boolean;
  t: Translate;
}) {
  switch (item.type) {
    case "user": {
      const insert = item.queued || inserted;
      return <li className={`tap-chat-user${insert ? " is-queued" : ""}`} data-key={item.key}>
        <Clamp className="tap-bubble" text={item.text} lines={12} t={t} />
        {(insert || Boolean(item.images)) && <span className="tap-bubble-meta">
          {item.images ? <ImageCount count={item.images} t={t} /> : null}
          {insert && <span className="tap-bubble-insert"><Zap size={12} aria-hidden />{t("inserted")}</span>}
        </span>}
      </li>;
    }
    case "command":
      return <li className="tap-chat-command" data-key={item.key}><code data-find="">{`${item.name}${item.args ? ` ${item.args}` : ""}`}</code></li>;
    case "output":
      return <li className="tap-chat-output" data-key={item.key}><Output text={item.text} ansi={item.ansi} t={t} /></li>;
    case "assistant":
      return <li className="tap-chat-assistant" data-key={item.key}><ChatMarkdown text={item.text} /></li>;
    case "thought":
      return <Thought item={item} t={t} />;
    case "steps":
      return <Steps item={item} initiallyOpen={last} live={live} t={t} />;
    case "plan":
      return <li className="tap-chat-plan" data-key={item.key}>
        <header>
          <ClipboardList size={15} aria-hidden /><strong>{t("plan")}</strong>
          <span className={`tap-plan-state${item.result ? (item.result.ok ? " is-ok" : " is-no") : ""}`}>
            {t(item.result ? (item.result.ok ? "planApproved" : "planRejected") : "planPending")}
          </span>
        </header>
        <ChatMarkdown text={item.text} />
      </li>;
    case "turn":
      return <TurnFooter item={item} t={t} />;
    case "compact":
      return <li className="tap-chat-divider" data-key={item.key}><span>{t("compacted")}</span></li>;
    case "error":
      return <li className="tap-chat-info is-error" data-key={item.key}>
        <TriangleAlert size={14} aria-hidden />
        <span data-find="">{`${item.text}${item.attempt && item.max ? ` · ${fill(t("retryCount"), { attempt: item.attempt, max: item.max })}` : ""}`}</span>
      </li>;
    case "notice": {
      // 有穩定代碼的通知（中斷、被取代、中止）照介面語言顯示；其他是 CLI 自己寫的文字，照原樣。
      const key = noticeKey(item.code);
      return <li className="tap-chat-info" data-key={item.key}><Info size={14} aria-hidden /><span data-find="">{key ? t(key) : item.text}</span></li>;
    }
  }
});

/** 「Opus 5.5 Max 快速」：思考強度小一號、淡一點；開了快速模式才標出來（文案依介面語言）。 */
export function ModelTag({ used, t }: { used: ModelUsed; t: Translate }) {
  return <span className="tap-work-model">
    {used.model}
    {used.effort && <small className="tap-work-effort">{used.effort}</small>}
    {used.fast && <small className="tap-work-fast">{t("fastMode")}</small>}
  </span>;
}

/**
 * 做完的一輪裡收起來的過程（參考 Codex）：一列「工作了 X」，後面一條細線把過程和最後的回答分開；
 * 展開後照原樣列出思考、步驟與過程中說的話。搜尋命中裡面的內容時自動展開。
 * 裡面的步驟等展開才畫（長對話有上百個收起來的過程，每次更新都把它們建一遍很浪費）。
 */
export const WorkFoldRows = memo(function WorkFoldRows({ fold, items, answer, renderRow, t }: {
  fold: WorkFold; items: Item[];
  /** 摺疊之後的第一項（最後的回答）。 */
  answer?: Item;
  renderRow: (item: Item, index: number) => ReactNode;
  t: Translate;
}) {
  const [open, setOpen] = useState(false);
  // 搜尋時才算裡面的字（命中就展開）；平常不必每次更新都重算整段。
  const searching = useSearching();
  const text = useMemo(() => searching ? items.map((item) => itemText(item, t)).join("\n") : "", [searching, items, t]);
  const hit = useHit(text);
  const expanded = open || hit;
  const used = useMemo(() => foldModel(answer, items), [answer, items]);
  return <>
    <li className={`tap-chat-work${expanded ? " is-open" : ""}`} data-key={fold.key}>
      <button type="button" className="tap-steps-head" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        <ChevronRight size={12} aria-hidden />
        {used && <ModelTag used={used} t={t} />}
        <span className="tap-steps-time">{fold.ms && fold.ms >= 1000 ? fill(t("workedFor"), { time: duration(fold.ms) }) : t("workProcess")}</span>
      </button>
    </li>
    {expanded && items.map((item, offset) => renderRow(item, fold.start + offset))}
  </>;
}, (previous, next) => previous.fold.key === next.fold.key && previous.fold.start === next.fold.start && previous.fold.end === next.fold.end
  && previous.fold.ms === next.fold.ms && previous.items === next.items && previous.answer === next.answer
  && previous.renderRow === next.renderRow && previous.t === next.t);

const TASK_ICONS: Record<string, LucideIcon> = { completed: CircleCheck, in_progress: CircleDot };

/** CLI 的任務清單：收起時一行「任务 2/5」與進行中的那一項，點開看全部。 */
export function Tasks({ tasks, t }: { tasks: Task[]; t: Translate }) {
  const [open, setOpen] = useState(false);
  const done = tasks.filter((task) => task.status === "completed").length;
  const current = tasks.find((task) => task.status === "in_progress");
  return <div className={`tap-chat-tasks${open ? " is-open" : ""}`}>
    <button type="button" className="tap-tasks-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <ListChecks size={15} aria-hidden />
      <strong>{fill(t("tasks"), { done, total: tasks.length })}</strong>
      {current && <span>{current.subject}</span>}
      <ChevronRight size={12} aria-hidden />
    </button>
    {open && <ul>
      {tasks.map((task) => {
        const Icon = TASK_ICONS[task.status] || Circle;
        return <li key={task.id} className={`is-${task.status}`}><Icon size={14} aria-hidden /><span>{task.subject}</span></li>;
      })}
    </ul>}
  </div>;
}
