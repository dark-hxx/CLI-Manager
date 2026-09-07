export type WebDeviceActionTarget = "project" | "group" | "worktree" | "selection";

export type WebDeviceActionRequest = {
  action: string;
  targetType: WebDeviceActionTarget;
  targetId?: string;
  targetIds?: string[];
};

type WebDeviceActionHandler = (request: WebDeviceActionRequest) => Promise<unknown> | unknown;

let handler: WebDeviceActionHandler | null = null;

export function registerWebDeviceActionHandler(nextHandler: WebDeviceActionHandler): () => void {
  handler = nextHandler;
  return () => {
    if (handler === nextHandler) handler = null;
  };
}

export async function requestWebDeviceAction(request: WebDeviceActionRequest): Promise<unknown> {
  if (!handler) {
    throw { code: "desktop_ui_unavailable", message: "desktop UI is not ready" };
  }
  return handler(request);
}
