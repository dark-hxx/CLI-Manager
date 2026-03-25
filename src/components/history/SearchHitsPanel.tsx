import type { HistorySearchHit } from "../../lib/types";

interface SearchHitsPanelProps {
  searchHits: HistorySearchHit[];
  onOpenHit: (hit: HistorySearchHit) => void;
}

export function SearchHitsPanel({ searchHits, onOpenHit }: SearchHitsPanelProps) {
  if (searchHits.length === 0) return null;

  return (
    <div className="border-b border-border pb-2">
      <div className="px-3 py-2 text-[11px] font-semibold text-text-muted">
        搜索命中 {searchHits.length} 条
      </div>
      {searchHits.map((hit, idx) => (
        <button
          key={`${hit.file_path}-${idx}`}
          onClick={() => onOpenHit(hit)}
          className="ui-list-row w-full border-t border-border px-3 py-2 text-left"
        >
          <div className="truncate text-xs font-semibold text-text-primary">{hit.title}</div>
          <div className="mt-0.5 truncate text-[11px] text-text-secondary">{hit.snippet}</div>
          <div className="ui-dev-label mt-1 text-[10px] text-text-muted">
            {hit.source} · {hit.project_key} · {hit.role}
          </div>
        </button>
      ))}
    </div>
  );
}
