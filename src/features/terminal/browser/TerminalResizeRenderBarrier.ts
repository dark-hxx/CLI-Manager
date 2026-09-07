import type { Terminal } from "@xterm/xterm";

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
  dispose: () => void;
}

export interface TerminalResizeCaptureElements {
  screen: HTMLElement;
  canvases: HTMLCanvasElement[];
}

export const resolveTerminalResizeCaptureElements = (
  terminal: Terminal,
): TerminalResizeCaptureElements | null => {
  const root = terminal.element;
  const screen = terminal.screenElement ?? root?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;

  const screenCanvases = [...screen.querySelectorAll<HTMLCanvasElement>("canvas")];
  const rootCanvases = root
    ? [...root.querySelectorAll<HTMLCanvasElement>("canvas")].filter(
      (canvas) => !canvas.classList.contains("xterm-decoration-overview-ruler"),
    )
    : [];
  const canvases = screenCanvases.length > 0 ? screenCanvases : rootCanvases;
  return canvases.length > 0 ? { screen, canvases } : null;
};

export interface TerminalResizeRenderBarrierOptions {
  createFrame?: (terminal: Terminal, container: HTMLElement) => TerminalResizeFrame | null;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

const createCanvasTerminalResizeFrame = (
  terminal: Terminal,
  container: HTMLElement,
): TerminalResizeFrame | null => {
  const captureElements = resolveTerminalResizeCaptureElements(terminal);
  if (!captureElements) return null;
  const { screen, canvases } = captureElements;

  const overlayViewport = document.createElement("div");
  const overlay = document.createElement("canvas");
  const capture = document.createElement("canvas");
  const probe = document.createElement("canvas");
  probe.width = 64;
  probe.height = 36;
  overlayViewport.setAttribute("aria-hidden", "true");
  Object.assign(overlayViewport.style, {
    position: "absolute",
    pointerEvents: "none",
    zIndex: "5",
    overflow: "hidden",
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
    overlayViewport.style.left = `${left}px`;
    overlayViewport.style.top = `${top}px`;
    overlayViewport.style.width = `${Math.max(1, bounds.width - left - rightInset)}px`;
    overlayViewport.style.height = `${Math.max(1, bounds.height - top - bottomInset)}px`;
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
  overlay.style.display = "block";
  overlay.style.width = `${screenRect.width}px`;
  overlay.style.height = `${screenRect.height}px`;
  syncBounds();
  overlayViewport.appendChild(overlay);
  container.appendChild(overlayViewport);
  screen.style.visibility = "hidden";

  return {
    syncBounds,
    dispose: () => {
      overlayViewport.remove();
      screen.style.visibility = previousVisibility;
    },
  };
};

export class TerminalResizeRenderBarrier {
  private active: { terminal: Terminal; frame: TerminalResizeFrame } | null = null;
  private revealFrameOne: number | null = null;
  private revealFrameTwo: number | null = null;
  private disposed = false;
  private readonly createFrame: (terminal: Terminal, container: HTMLElement) => TerminalResizeFrame | null;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;

  constructor(options: TerminalResizeRenderBarrierOptions = {}) {
    this.createFrame = options.createFrame ?? createCanvasTerminalResizeFrame;
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
    this.scheduleReveal();
    return true;
  }

  noteContainerResize(): void {
    if (!this.active || this.disposed) return;
    this.active.frame.syncBounds();
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

  private scheduleReveal(): void {
    this.clearRevealFrames();
    this.revealFrameOne = this.requestFrame(() => {
      this.revealFrameOne = null;
      this.revealFrameTwo = this.requestFrame(() => {
        this.revealFrameTwo = null;
        if (!this.active || this.disposed) return;
        this.clearActive();
      });
    });
  }

  private clearRevealFrames(): void {
    if (this.revealFrameOne !== null) {
      this.cancelFrame(this.revealFrameOne);
      this.revealFrameOne = null;
    }
    if (this.revealFrameTwo !== null) {
      this.cancelFrame(this.revealFrameTwo);
      this.revealFrameTwo = null;
    }
  }

  private clearScheduledWork(): void {
    this.clearRevealFrames();
  }

  private clearActive(): void {
    const active = this.active;
    this.active = null;
    active?.frame.dispose();
  }
}
