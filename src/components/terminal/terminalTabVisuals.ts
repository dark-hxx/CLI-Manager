import type { TabNotificationState } from "../../stores/terminalStore";

export const TAB_NOTIFICATION_COLORS: Record<TabNotificationState, string> = {
  none: "#565f89",
  running: "#8b5cf6",
  attention: "#ff9e64",
  done: "#8fbf7f",
  failed: "#f7768e",
};

export const PULSING_TAB_STATES = new Set<TabNotificationState>(["running", "attention"]);
