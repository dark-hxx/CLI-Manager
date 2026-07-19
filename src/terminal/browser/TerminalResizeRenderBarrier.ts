import type { Terminal } from "@xterm/xterm";

const RESIZE_SETTLE_DELAY_MS = 72;

type TimerHandle = ReturnType<typeof setTimeout>;

export const hasVisibleTerminalFrameContent = (pixels: Uint8ClampedArray): boolean => {
  if (pixels.length < 4) return false;
  let minRed = 255;
  let minGreen = 255;
  let minBlue = 255;
  let minAlpha = 255;
  let maxRed = 0;
  let maxGreen = 0;
  let maxBlue = 0;
  let maxAlpha = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    minRed = Math.min(minRed, pixels[index]);
    minGreen = Math.min(minGreen, pixels[index + 1]);
    minBlue = Math.min(minBlue, pixels[index + 2]);
    minAlpha = Math.min(minAlpha, pixels[index + 3]);
    maxRed = Math.max(maxRed, pixels[index]);
    maxGreen = Math.max(maxGreen, pixels[index + 1]);
    maxBlue = Math.max(maxBlue, pixels[index + 2]);
    maxAlpha = Math.max(maxAlpha, pixels[index + 3]);
  }
  return (
    maxRed - minRed > 2
    || maxGreen - minGreen > 2
    || maxBlue - minBlue > 2
    || maxAlpha - minAlpha > 2
  );
};

interface TerminalResizeFrame {
  syncBounds: () => void;
  refresh: () => void;
  dispose: () => void;
}

export interface TerminalResizeRenderBarrierOptions {
  createFrame?: (terminal: Terminal, container: HTMLElement) => TerminalResizeFrame | null;
  requestTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  cancelTimer?: (handle: TimerHandle) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

const createCanvasTerminalResizeFrame = (
  terminal: Terminal,
  container: HTMLElement,
): TerminalResizeFrame | null => {
  const screen = terminal.screenElement;
  if (!screen) return null;
  const canvases = [...screen.querySelectorAll("canvas")];
  if (canvases.length === 0) return null;

  const overlay = document.createElement("canvas");
  const capture = document.createElement("canvas");
  const probe = document.createElement("canvas");
  probe.width = 64;
  probe.height = 36;
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "absolute",
    pointerEvents: "none",
    zIndex: "5",
    transformOrigin: "left top",
  });

  const screenRect = screen.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const left = Math.max(0, screenRect.left - containerRect.left);
  const top = Math.max(0, screenRect.top - containerRect.top);
  const rightInset = Math.max(0, containerRect.right - screenRect.right);
  const bottomInset = Math.max(0, containerRect.bottom - screenRect.bottom);
  const previousVisibility = screen.style.visibility;

  const syncBounds = () => {
    const bounds = container.getBoundingClientRect();
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    overlay.style.width = `${Math.max(1, bounds.width - left - rightInset)}px`;
    overlay.style.height = `${Math.max(1, bounds.height - top - bottomInset)}px`;
  };

  const captureFrame = () => {
    const currentScreenRect = screen.getBoundingClientRect();
    if (currentScreenRect.width <= 0 || currentScreenRect.height <= 0) return false;
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    capture.width = Math.max(1, Math.round(currentScreenRect.width * pixelRatio));
    capture.height = Math.max(1, Math.round(currentScreenRect.height * pixelRatio));
    const context = capture.getContext("2d");
    if (!context) return false;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, currentScreenRect.width, currentScreenRect.height);
    for (const canvas of canvases) {
      if (canvas.width <= 0 || canvas.height <= 0) continue;
      const canvasRect = canvas.getBoundingClientRect();
      context.drawImage(
        canvas,
        0,
        0,
        canvas.width,
        canvas.height,
        canvasRect.left - currentScreenRect.left,
        canvasRect.top - currentScreenRect.top,
        canvasRect.width,
        canvasRect.height,
      );
    }
    const probeContext = probe.getContext("2d", { willReadFrequently: true });
    if (!probeContext) return false;
    probeContext.clearRect(0, 0, probe.width, probe.height);
    probeContext.drawImage(capture, 0, 0, probe.width, probe.height);
    const pixels = probeContext.getImageData(0, 0, probe.width, probe.height).data;
    return hasVisibleTerminalFrameContent(pixels);
  };

  const refresh = () => {
    if (!captureFrame()) return false;
    overlay.width = capture.width;
    overlay.height = capture.height;
    const context = overlay.getContext("2d");
    if (!context) return false;
    context.drawImage(capture, 0, 0);
    return true;
  };

  try {
    if (!refresh()) return null;
  } catch {
    return null;
  }
  syncBounds();
  container.appendChild(overlay);
  screen.style.visibility = "hidden";

  return {
    syncBounds,
    refresh: () => {
      try {
        refresh();
      } catch {
        // A renderer swap or image canvas can make a single capture fail. Keep
        // the last stable bitmap until the resize barrier settles.
      }
    },
    dispose: () => {
      overlay.remove();
      screen.style.visibility = previousVisibility;
    },
  };
};

export class TerminalResizeRenderBarrier {
  private active: { terminal: Terminal; frame: TerminalResizeFrame } | null = null;
  private settleTimer: TimerHandle | null = null;
  private refreshFrameOne: number | null = null;
  private refreshFrameTwo: number | null = null;
  private disposed = false;
  private readonly createFrame: (terminal: Terminal, container: HTMLElement) => TerminalResizeFrame | null;
  private readonly requestTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancelTimer: (handle: TimerHandle) => void;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;

  constructor(options: TerminalResizeRenderBarrierOptions = {}) {
    this.createFrame = options.createFrame ?? createCanvasTerminalResizeFrame;
    this.requestTimer = options.requestTimer ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.cancelTimer = options.cancelTimer ?? ((handle) => window.clearTimeout(handle));
    this.requestFrame = options.requestFrame ?? ((callback) => window.requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle));
  }

  begin(terminal: Terminal, container: HTMLElement): boolean {
    if (this.disposed) return false;
    if (this.active?.terminal !== terminal) this.clearActive();
    if (!this.active) {
      const frame = this.createFrame(terminal, container);
      if (!frame) return false;
      this.active = { terminal, frame };
    }
    this.active.frame.syncBounds();
    this.scheduleSettle();
    return true;
  }

  noteContainerResize(): void {
    if (!this.active || this.disposed) return;
    this.active.frame.syncBounds();
    this.scheduleSettle();
  }

  handleWriteCommitted(terminal: Terminal): void {
    if (this.active?.terminal !== terminal || this.disposed) return;
    this.scheduleRefresh(false);
  }

  cancel(): void {
    this.clearScheduledWork();
    this.clearActive();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  private scheduleSettle(): void {
    if (this.settleTimer !== null) this.cancelTimer(this.settleTimer);
    this.settleTimer = this.requestTimer(() => {
      this.settleTimer = null;
      this.scheduleRefresh(true);
    }, RESIZE_SETTLE_DELAY_MS);
  }

  private scheduleRefresh(revealAfterRefresh: boolean): void {
    this.clearRefreshFrames();
    this.refreshFrameOne = this.requestFrame(() => {
      this.refreshFrameOne = null;
      this.refreshFrameTwo = this.requestFrame(() => {
        this.refreshFrameTwo = null;
        const active = this.active;
        if (!active || this.disposed) return;
        active.frame.refresh();
        if (revealAfterRefresh) this.clearActive();
      });
    });
  }

  private clearRefreshFrames(): void {
    if (this.refreshFrameOne !== null) {
      this.cancelFrame(this.refreshFrameOne);
      this.refreshFrameOne = null;
    }
    if (this.refreshFrameTwo !== null) {
      this.cancelFrame(this.refreshFrameTwo);
      this.refreshFrameTwo = null;
    }
  }

  private clearScheduledWork(): void {
    if (this.settleTimer !== null) {
      this.cancelTimer(this.settleTimer);
      this.settleTimer = null;
    }
    this.clearRefreshFrames();
  }

  private clearActive(): void {
    const active = this.active;
    this.active = null;
    active?.frame.dispose();
  }
}
