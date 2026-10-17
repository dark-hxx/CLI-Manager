// 對話裡的文字區塊：可收起的長文字、帶終端顏色的命令輸出、改動、Markdown 回覆與圖片張數。
// 移植自 Tap-Code（web/src/Conversation.tsx、DiffView.tsx、markdown.ts）。
import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Image, ImageOff } from "lucide-react";
import { cells, laidOut, parseSgr, runColors } from "./ansi";
import { hunkRows } from "./diff";
import { useHit } from "./ChatSearch";
import { fill, type Translate } from "./i18n";
import type { Hunk } from "./transcript";

/**
 * 太長的純文字先收起，點一下展開；搜尋到裡面的字時自動展開。children 是畫好的內容
 * （例如帶顏色的命令輸出），text 仍用來判斷長短與搜尋；laid 時不換行、改成左右捲動。
 */
export function Clamp({ text, lines, className, children, laid = false, t }: {
  text: string; lines: number; className: string; children?: ReactNode; laid?: boolean; t: Translate;
}) {
  const [open, setOpen] = useState(false);
  const hit = useHit(text);
  const long = text.split("\n").length > lines || text.length > lines * 90;
  // 不換行的輸出右邊還有內容時，右緣淡出提示可以左右捲動。
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!laid || !element) return;
    const update = () => setMore(element.scrollLeft + element.clientWidth < element.scrollWidth - 2);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, [laid]);
  return <div className={`${className}${long && !open && !hit ? " is-clamped" : ""}`} style={{ "--lines": lines } as CSSProperties}>
    <div ref={box} className={`tap-clamp-text${laid ? " is-laid" : ""}${more ? " has-more" : ""}`} data-find="">{children ?? text}</div>
    {long && !hit && <button type="button" className="tap-clamp-toggle" onClick={() => setOpen(!open)}>{t(open ? "collapse" : "expand")}</button>}
  </div>;
}

/**
 * 命令輸出照終端的顏色顯示（SGR 由主機過濾過，這裡只轉成行內樣式，不碰 HTML）；
 * 非 ASCII 的字各佔固定的 1 或 2 欄，/context 的格子與右邊的圖例才對得齊。
 */
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

/** 命令的輸出（/context、`!` 命令…）：深色的終端區塊，靠空白排版的不換行、可以左右捲動。 */
export function Output({ text, ansi, t }: { text: string; ansi?: string; t: Translate }) {
  const laid = useMemo(() => laidOut(text), [text]);
  const content = useMemo(() => <AnsiText text={ansi ?? text} />, [ansi, text]);
  return <Clamp className="tap-code is-output is-term" text={text} lines={laid ? 15 : 6} laid={laid} t={t}>{content}</Clamp>;
}

/** unified diff：每一行標出行號（刪除的行用舊檔的行號），新增綠、刪除紅。 */
export function Diff({ hunks, truncated, t }: { hunks: Hunk[]; truncated?: boolean; t: Translate }) {
  return <div className="tap-hunks">
    {hunks.map((hunk, index) => <div className="tap-hunk" key={index}>
      {hunkRows(hunk).map((row, line) => <div className={`tap-hunk-line is-${row.tone}`} key={line}>
        <span className="tap-hunk-num">{row.number}</span>
        <span className="tap-hunk-text" data-find="">{row.text || " "}</span>
      </div>)}
    </div>)}
    {truncated && <p className="tap-hunk-more">{t("diffTruncated")}</p>}
  </div>;
}

/** 附圖只標張數：這一版不向主機讀圖，標籤也不能點。 */
export function ImageCount({ count, t }: { count: number; t: Translate }) {
  return <span className="tap-image-count"><Image size={12} aria-hidden />{fill(t("images"), { n: count })}</span>;
}

/** 回覆裡的 Markdown 圖片（`![說明](路徑)`）：不載入，只留說明文字或檔名。 */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  let name = src ?? "";
  try { name = decodeURI(name); } catch { /* 保留原樣 */ }
  name = name.split(/[\\/]/).pop() || name;
  return <span className="tap-md-image" title={src}><ImageOff size={13} aria-hidden />{alt || name}</span>;
}

const PLUGINS = [remarkGfm];
// CLI 的回覆是 Markdown：原始 HTML 一律當文字顯示，網址交給 react-markdown 的安全處理，連結開新分頁。
// 表格可能比手機寬，只讓表格自己捲動，頁面不會被撐寬。
const COMPONENTS: Components = {
  a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  table: ({ children }) => <div className="tap-md-table"><table>{children}</table></div>,
  img: ({ src, alt }) => <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} />,
};

/** 一段 Markdown 回覆；內容沒變時不重新解析。 */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return <div className="tap-md" data-find=""><Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>{text}</Markdown></div>;
});
