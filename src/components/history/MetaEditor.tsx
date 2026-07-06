import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { useMemo, useState, type RefObject } from "react";
import { useI18n } from "../../lib/i18n";

interface MetaEditorProps {
  aliasDraft: string;
  tagsDraft: string;
  tagSuggestions: string[];
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
  tagSuggestions,
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
  const { t } = useI18n();
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const selectedTags = useMemo(
    () => new Set(tagsDraft.split(",").map((tag) => tag.trim()).filter(Boolean)),
    [tagsDraft]
  );
  const tagDraftParts = tagsDraft.split(",");
  const activeTagQuery = (tagDraftParts[tagDraftParts.length - 1] ?? "").trim().toLowerCase();
  const visibleTagSuggestions = useMemo(
    () =>
      tagSuggestions
        .filter((tag) => !selectedTags.has(tag))
        .filter((tag) => !activeTagQuery || tag.toLowerCase().includes(activeTagQuery))
        .slice(0, 8),
    [activeTagQuery, selectedTags, tagSuggestions]
  );
  const showTagPicker = tagPickerOpen && visibleTagSuggestions.length > 0;

  const applyTagSuggestion = (tag: string) => {
    const previousTags = tagsDraft
      .split(",")
      .slice(0, -1)
      .map((item) => item.trim())
      .filter(Boolean);
    onTagsDraftChange([...previousTags, tag].join(", "));
    setTagPickerOpen(false);
  };

  return (
    <>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
        <Input
          value={aliasDraft}
          onChange={(e) => onAliasDraftChange(e.target.value)}
          aria-label={t("history.meta.alias")}
          placeholder={t("history.meta.aliasPlaceholder")}
          className="h-7 px-2 text-xs"
        />
        <div className="relative min-w-0">
          <Input
            value={tagsDraft}
            onChange={(e) => {
              onTagsDraftChange(e.target.value);
              setTagPickerOpen(true);
            }}
            onFocus={() => setTagPickerOpen(true)}
            onBlur={() => window.setTimeout(() => setTagPickerOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setTagPickerOpen(false);
            }}
            aria-label={t("history.meta.tags")}
            placeholder={t("history.meta.tagsPlaceholder")}
            className="h-7 px-2 text-xs"
          />
          {showTagPicker && (
            <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 max-h-44 overflow-y-auto rounded-md border border-border bg-bg-secondary p-1 shadow-lg">
              {visibleTagSuggestions.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyTagSuggestion(tag);
                  }}
                  className="block w-full rounded px-2 py-1.5 text-left text-xs text-text-primary hover:bg-bg-tertiary focus:bg-bg-tertiary focus:outline-none"
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={onSaveMeta} className="ui-btn ui-btn-primary h-7 text-xs">
          {t("history.meta.save")}
        </button>
      </div>

      <div className="ui-input mt-2 rounded-md px-2 py-1">
        <div className="flex items-center gap-2">
          <Search size={12} className="text-text-muted" />
          <input
            ref={sessionSearchRef}
            value={sessionQuery}
            onChange={(e) => onSessionQueryChange(e.target.value)}
            aria-label={t("history.meta.search")}
            placeholder={t("history.meta.search")}
            className="flex-1 min-w-0 bg-transparent text-xs outline-none"
          />
        </div>

        <div className="mt-2 flex items-center justify-end gap-2">
          <button onClick={onJumpPrev} aria-label={t("history.meta.prevMatch")} className="ui-btn px-2 py-0.5 text-[11px]" title={t("history.meta.prevMatch")}>
            ↑
          </button>
          <button onClick={onJumpNext} aria-label={t("history.meta.nextMatch")} className="ui-btn px-2 py-0.5 text-[11px]" title={t("history.meta.nextMatch")}>
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
