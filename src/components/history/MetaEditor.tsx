import { Search } from "lucide-react";
import type { RefObject } from "react";

interface MetaEditorProps {
  aliasDraft: string;
  tagsDraft: string;
  sessionQuery: string;
  sessionSearchRef: RefObject<HTMLInputElement | null>;
  matchCursor: number;
  matchCount: number;
  onAliasDraftChange: (value: string) => void;
  onTagsDraftChange: (value: string) => void;
  onSessionQueryChange: (value: string) => void;
  onSaveMeta: () => void;
  onJumpPrev: () => void;
  onJumpNext: () => void;
}

export function MetaEditor({
  aliasDraft,
  tagsDraft,
  sessionQuery,
  sessionSearchRef,
  matchCursor,
  matchCount,
  onAliasDraftChange,
  onTagsDraftChange,
  onSessionQueryChange,
  onSaveMeta,
  onJumpPrev,
  onJumpNext,
}: MetaEditorProps) {
  return (
    <>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          value={aliasDraft}
          onChange={(e) => onAliasDraftChange(e.target.value)}
          aria-label="会话别名"
          placeholder="会话别名（重命名）"
          className="ui-input px-2 py-1 text-xs outline-none"
        />
        <input
          value={tagsDraft}
          onChange={(e) => onTagsDraftChange(e.target.value)}
          aria-label="会话标签（逗号分隔）"
          placeholder="标签，逗号分隔"
          className="ui-input px-2 py-1 text-xs outline-none"
        />
      </div>

      <div className="mt-2">
        <button onClick={onSaveMeta} className="ui-btn ui-btn-primary text-xs">
          保存元数据
        </button>
      </div>

      <div className="ui-input mt-2 rounded-md px-2 py-1">
        <div className="flex items-center gap-2">
          <Search size={12} className="text-text-muted" />
          <input
            ref={sessionSearchRef}
            value={sessionQuery}
            onChange={(e) => onSessionQueryChange(e.target.value)}
            aria-label="会话内搜索"
            placeholder="会话内搜索"
            className="flex-1 min-w-0 bg-transparent text-xs outline-none"
          />
        </div>

        <div className="mt-2 flex items-center justify-end gap-2">
          <button onClick={onJumpPrev} aria-label="上一个匹配" className="ui-btn px-2 py-0.5 text-[11px]" title="上一个匹配">
            ↑
          </button>
          <button onClick={onJumpNext} aria-label="下一个匹配" className="ui-btn px-2 py-0.5 text-[11px]" title="下一个匹配">
            ↓
          </button>
          <span className="shrink-0 text-[10px] text-text-muted">
            {matchCount === 0 ? "0" : `${Math.min(matchCursor + 1, matchCount)}/${matchCount}`}
          </span>
        </div>
      </div>
    </>
  );
}
