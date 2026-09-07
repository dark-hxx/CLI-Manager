import { useCallback, useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../../../stores/settingsStore";
import {
  TERMINAL_TAB_HOVER_DELAY_MS, TERMINAL_TAB_HOVER_CLOSE_DELAY_MS, TERMINAL_TAB_HOVER_CARD_WIDTH,
  TERMINAL_TAB_HOVER_CARD_ESTIMATED_HEIGHT, clampNumber,
} from "../lib/terminalTabsModel";

export function useTerminalTabHoverCard(
  tabElementRef: { current: HTMLElement | null },
  disabled: boolean
) {
  const [hoverCardPosition, setHoverCardPosition] = useState<{ left: number; top: number } | null>(null);
  const hoverOpenTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const enabled = useSettingsStore((s) => s.terminalTabHoverInfoEnabled);

  const clearHoverOpenTimer = useCallback(() => {
    if (hoverOpenTimerRef.current === null) return;
    window.clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = null;
  }, []);

  const clearHoverCloseTimer = useCallback(() => {
    if (hoverCloseTimerRef.current === null) return;
    window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = null;
  }, []);

  const hideHoverCard = useCallback(() => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    setHoverCardPosition(null);
  }, [clearHoverCloseTimer, clearHoverOpenTimer]);

  const keepHoverCardOpen = useCallback(() => {
    clearHoverCloseTimer();
  }, [clearHoverCloseTimer]);

  const scheduleHideHoverCard = useCallback(() => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      setHoverCardPosition(null);
    }, TERMINAL_TAB_HOVER_CLOSE_DELAY_MS);
  }, [clearHoverCloseTimer, clearHoverOpenTimer]);

  const scheduleHoverCard = useCallback(() => {
    if (!enabled || disabled) return;
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    hoverOpenTimerRef.current = window.setTimeout(() => {
      hoverOpenTimerRef.current = null;
      const rect = tabElementRef.current?.getBoundingClientRect();
      if (!rect) return;

      const maxLeft = Math.max(8, window.innerWidth - TERMINAL_TAB_HOVER_CARD_WIDTH - 8);
      const maxTop = Math.max(8, window.innerHeight - TERMINAL_TAB_HOVER_CARD_ESTIMATED_HEIGHT - 8);
      setHoverCardPosition({
        left: clampNumber(rect.left, 8, maxLeft),
        top: clampNumber(rect.bottom + 6, 8, maxTop),
      });
    }, TERMINAL_TAB_HOVER_DELAY_MS);
  }, [clearHoverCloseTimer, clearHoverOpenTimer, disabled, enabled, tabElementRef]);

  useEffect(() => () => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
  }, [clearHoverCloseTimer, clearHoverOpenTimer]);

  useEffect(() => {
    if (!enabled || disabled) hideHoverCard();
  }, [disabled, enabled, hideHoverCard]);

  return {
    enabled,
    hoverCardPosition,
    hideHoverCard,
    keepHoverCardOpen,
    scheduleHideHoverCard,
    scheduleHoverCard,
  };
}
