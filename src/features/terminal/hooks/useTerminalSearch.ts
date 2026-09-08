import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";

export interface SearchResultState {
  resultIndex: number;
  resultCount: number;
}

const EMPTY_SEARCH_RESULT: SearchResultState = { resultIndex: 0, resultCount: 0 };

// Colors for the SearchAddon match decorations. These are the only theme values
// the search behaviour itself needs; the search-bar chrome colors stay in the
// component because they are shared with the context menu and suggestion ghost.
export interface TerminalSearchDecorationColors {
  matchBackground: string;
  activeMatchBackground: string;
  accent: string;
}

export interface UseTerminalSearchResult {
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  searchTerm: string;
  searchMatched: boolean | null;
  searchResult: SearchResultState;
  searchInputRef: RefObject<HTMLInputElement | null>;
  /** Wire this to searchAddon.onDidChangeResults in the terminal-creation effect. */
  handleSearchResults: (event: { resultIndex: number; resultCount: number }) => void;
  runTerminalSearch: (term: string, direction: "next" | "previous", incremental?: boolean) => void;
  handleSearchTermChange: (value: string) => void;
  openSearch: () => void;
  closeTerminalSearch: () => void;
}

// Terminal in-buffer search (Ctrl+F). Owns the search UI state and the
// SearchAddon-driven find/clear logic. The SearchAddon instance itself is
// created and disposed by the terminal-creation effect (its lifecycle is tied
// to the Terminal), so this hook only reads it via searchAddonRef.
export function useTerminalSearch(
  terminalRef: RefObject<Terminal | null>,
  searchAddonRef: RefObject<SearchAddon | null>,
  decorationColors: TerminalSearchDecorationColors,
): UseTerminalSearchResult {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchMatched, setSearchMatched] = useState<boolean | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResultState>(EMPTY_SEARCH_RESULT);

  useEffect(() => {
    if (!searchOpen) return;
    const rafId = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [searchOpen]);

  const handleSearchResults = useCallback((event: { resultIndex: number; resultCount: number }) => {
    setSearchResult({ resultIndex: event.resultIndex, resultCount: event.resultCount });
  }, []);

  const createSearchOptions = (incremental: boolean): ISearchOptions => ({
    incremental,
    decorations: {
      matchBackground: decorationColors.matchBackground,
      matchBorder: decorationColors.matchBackground,
      matchOverviewRuler: decorationColors.matchBackground,
      activeMatchBackground: decorationColors.activeMatchBackground,
      activeMatchBorder: decorationColors.accent,
      activeMatchColorOverviewRuler: decorationColors.accent,
    },
  });

  const clearTerminalSearch = () => {
    searchAddonRef.current?.clearDecorations();
    setSearchMatched(null);
    setSearchResult(EMPTY_SEARCH_RESULT);
  };

  const runTerminalSearch = (term: string, direction: "next" | "previous", incremental = false) => {
    const searchAddon = searchAddonRef.current;
    if (!term || !searchAddon) {
      clearTerminalSearch();
      return;
    }
    const matched = direction === "previous"
      ? searchAddon.findPrevious(term, createSearchOptions(false))
      : searchAddon.findNext(term, createSearchOptions(incremental));
    setSearchMatched(matched);
  };

  const handleSearchTermChange = (value: string) => {
    setSearchTerm(value);
    runTerminalSearch(value, "next", true);
  };

  // Focus explicitly here (not only via the searchOpen effect) so pressing
  // Ctrl+F while search is already open — but focus has moved back to the
  // terminal — still refocuses the input. The effect only fires on the
  // false->true transition, which does not happen on a repeat press.
  const openSearch = () => {
    setSearchOpen(true);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  };

  const closeTerminalSearch = () => {
    setSearchOpen(false);
    setSearchTerm("");
    clearTerminalSearch();
    window.requestAnimationFrame(() => terminalRef.current?.focus());
  };

  return {
    searchOpen,
    setSearchOpen,
    searchTerm,
    searchMatched,
    searchResult,
    searchInputRef,
    handleSearchResults,
    runTerminalSearch,
    handleSearchTermChange,
    openSearch,
    closeTerminalSearch,
  };
}
