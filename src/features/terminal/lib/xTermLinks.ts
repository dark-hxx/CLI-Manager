import { Terminal, type IBufferRange, type IDisposable, type IViewportRange } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { translateCurrent } from "../../../shared/i18n/index";
import {
  normalizeTerminalRelativePath, resolveTerminalFileSystemPath, type TerminalFileLinkMatch,
} from "./terminalFileLinks";
import { requestTerminalFileNavigation } from "./terminalFileNavigation";
import { findProjectByPath, findWorktreeByPath } from "../api/terminalProject";
import { projectSupportsCapability } from "../../projects/api/projectCapabilities";
import { useProjectStore } from "../../projects/api/projectStore";
import { useTerminalStore } from "../state";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { toast } from "sonner";
import { logError } from "../../../shared/platform/logger";

export const getTerminalRenderedCellSize = (terminal: Terminal, terminalContainer: HTMLElement, fallbackFontSize: number) => {
  const renderedCell = (
    terminal as typeof terminal & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    }
  )._core?._renderService?.dimensions?.css?.cell;
  const renderedWidth = renderedCell?.width;
  const renderedHeight = renderedCell?.height;
  if (
    typeof renderedWidth === "number" && Number.isFinite(renderedWidth) && renderedWidth > 0
    && typeof renderedHeight === "number" && Number.isFinite(renderedHeight) && renderedHeight > 0
  ) {
    return {
      width: renderedWidth,
      height: renderedHeight,
    };
  }
  const screen = terminalContainer.querySelector(".xterm-screen") as HTMLElement | null;
  const rect = (screen ?? terminalContainer).getBoundingClientRect();
  return {
    width: rect.width > 0 ? rect.width / Math.max(1, terminal.cols) : Math.max(1, fallbackFontSize * 0.6),
    height: rect.height > 0 ? rect.height / Math.max(1, terminal.rows) : Math.max(1, fallbackFontSize * 1.2),
  };
};

export type TerminalLinkIconKind = "link" | "file" | "directory" | "relative-file" | "relative-directory";

export type TerminalPathKind = "file" | "directory" | "missing";

export interface TerminalLinkHoverIcon extends IDisposable {
  hide(): void;
  showBufferRange(kind: TerminalLinkIconKind, range: IBufferRange): void;
  showViewportRange(kind: TerminalLinkIconKind, range: IViewportRange): void;
}

export const createTerminalLinkHoverIcon = (
  terminal: Terminal,
  terminalContainer: HTMLElement,
  fallbackFontSize: number,
): TerminalLinkHoverIcon => {
  const element = document.createElement("div");
  element.className = "terminal-link-hover-icon xterm-hover";
  element.setAttribute("aria-hidden", "true");
  element.hidden = true;
  terminal.element?.appendChild(element);

  const showAt = (kind: TerminalLinkIconKind, x: number, y: number) => {
    const terminalElement = terminal.element;
    const screen = terminalElement?.querySelector<HTMLElement>(".xterm-screen");
    if (!terminalElement || !screen || y < 0 || y >= terminal.rows) {
      element.hidden = true;
      return;
    }

    const terminalRect = terminalElement.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const cell = getTerminalRenderedCellSize(terminal, terminalContainer, fallbackFontSize);
    const left = screenRect.left - terminalRect.left + x * cell.width - 10;
    const top = screenRect.top - terminalRect.top + y * cell.height - 8;
    element.dataset.kind = kind;
    element.style.setProperty("--terminal-link-icon-fg", terminal.options.theme?.foreground ?? "#d8dee9");
    element.style.setProperty("--terminal-link-icon-bg", terminal.options.theme?.background ?? "#111827");
    element.style.transform = `translate3d(${Math.max(2, left)}px, ${Math.max(2, top)}px, 0)`;
    element.hidden = false;
  };

  return {
    hide: () => {
      element.hidden = true;
    },
    showBufferRange: (kind, range) => {
      showAt(
        kind,
        range.start.x - 1,
        range.start.y - terminal.buffer.active.viewportY - 1,
      );
    },
    showViewportRange: (kind, range) => {
      showAt(kind, range.start.x, range.start.y);
    },
    dispose: () => {
      element.remove();
    },
  };
};

export let expiredAttachmentsCleanup: Promise<number> | null = null;

export const cleanupExpiredAttachmentsOnce = () => {
  if (expiredAttachmentsCleanup) return expiredAttachmentsCleanup;
  expiredAttachmentsCleanup = invoke<number>("file_cleanup_expired_attachments").catch((err) => {
    expiredAttachmentsCleanup = null;
    throw err;
  });
  return expiredAttachmentsCleanup;
};

export const openHttpUrl = (sessionId: string, uri: string) => {
  if (!/^https?:\/\//i.test(uri)) return;
  void openUrl(uri).catch((err) => logError("Failed to open terminal link", { sessionId, uri, err }));
};

export const getTerminalFileLinkContext = (sessionId: string, rawPath: string) => {
  const terminalState = useTerminalStore.getState();
  const session = terminalState.sessions.find((item) => item.id === sessionId) ?? null;
  const projectState = useProjectStore.getState();
  const currentProject = session?.projectId
    ? projectState.projects.find((item) => item.id === session.projectId) ?? null
    : findProjectByPath(projectState.projects, session?.cwd);
  const currentWorktree = session?.worktreeId
    ? projectState.worktrees.find((item) => item.id === session.worktreeId) ?? null
    : findWorktreeByPath(projectState.worktrees, session?.cwd);
  const currentRootPath = currentWorktree?.path ?? currentProject?.path ?? session?.cwd ?? null;
  return {
    supportsFiles: projectSupportsCapability(currentProject, "files"),
    rootPath: currentRootPath,
    systemPath: resolveTerminalFileSystemPath(rawPath, currentRootPath),
  };
};

export const resolveRelativeTerminalSystemPath = (rootPath: string, relativePath: string) => (
  `${rootPath.replace(/[\\/]+$/u, "")}\\${relativePath.replace(/\//g, "\\")}`
);

export const openTerminalFilePath = async (sessionId: string, rawPath: string) => {
  const context = getTerminalFileLinkContext(sessionId, rawPath);
  if (!context.supportsFiles) {
    toast.info(translateCurrent("remoteCapabilities.unsupportedTitle"), {
      description: translateCurrent("remoteCapabilities.unsupportedDescription"),
    });
    return;
  }
  if (!context.systemPath) return;

  void invoke("open_folder_in_explorer", { path: context.systemPath }).catch((err) => {
    logError("Failed to open terminal file", { sessionId, path: context.systemPath, err });
    toast.error(translateCurrent("files.toast.openFileFailed"), { description: String(err) });
  });
};

export const openTerminalRelativeFilePath = async (sessionId: string, match: TerminalFileLinkMatch) => {
  if (!useSettingsStore.getState().terminalToolbarVisibility.files) return;
  const context = getTerminalFileLinkContext(sessionId, match.path);
  const relativePath = normalizeTerminalRelativePath(match.path);
  if (!context.supportsFiles || !context.rootPath || !relativePath) return;

  try {
    const kind = await invoke<TerminalPathKind>("file_get_path_kind", {
      path: resolveRelativeTerminalSystemPath(context.rootPath, relativePath),
    });
    if (kind !== "file" && kind !== "directory") return;
    requestTerminalFileNavigation({
      sessionId,
      path: relativePath,
      kind,
      ...(match.lineNumber ? { lineNumber: match.lineNumber } : {}),
      ...(match.columnNumber ? { columnNumber: match.columnNumber } : {}),
    });
  } catch {
    // 路径不存在、权限不足或会话已关闭时不产生终端噪声。
  }
};
