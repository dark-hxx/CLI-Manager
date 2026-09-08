export interface TerminalFileNavigationRequest {
  sessionId: string;
  path: string;
  kind: "file" | "directory";
  lineNumber?: number;
  columnNumber?: number;
}

export const TERMINAL_FILE_NAVIGATION_REQUEST_EVENT = "terminal-file-navigation-request";

export function requestTerminalFileNavigation(request: TerminalFileNavigationRequest): void {
  window.dispatchEvent(new CustomEvent<TerminalFileNavigationRequest>(TERMINAL_FILE_NAVIGATION_REQUEST_EVENT, {
    detail: request,
  }));
}
