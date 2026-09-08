export const SIDEBAR_TOGGLE_REQUEST_EVENT = "cli-manager:sidebar-toggle-request";
export const SIDEBAR_EXPAND_REQUEST_EVENT = "cli-manager:sidebar-expand-request";
export const SIDEBAR_STATE_CHANGE_EVENT = "cli-manager:sidebar-state-change";

export interface SidebarStateChangeDetail {
  collapsed: boolean;
  compactMode: boolean;
}

export function requestSidebarToggle(): void {
  window.dispatchEvent(new Event(SIDEBAR_TOGGLE_REQUEST_EVENT));
}

export function requestSidebarExpand(): void {
  window.dispatchEvent(new Event(SIDEBAR_EXPAND_REQUEST_EVENT));
}

export function notifySidebarStateChange(detail: SidebarStateChangeDetail): void {
  window.dispatchEvent(new CustomEvent<SidebarStateChangeDetail>(SIDEBAR_STATE_CHANGE_EVENT, { detail }));
}
