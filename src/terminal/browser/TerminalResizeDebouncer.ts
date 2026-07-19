/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See NOTICE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal } from "@xterm/xterm";

const START_DEBOUNCING_THRESHOLD = 200;
const HORIZONTAL_RESIZE_INTERVAL_MS = 34;
const HIDDEN_RESIZE_IDLE_TIMEOUT_MS = 100;

type ResizeCallback = (value: number) => void;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface TerminalResizeDebouncerOptions {
  now?: () => number;
  requestTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  cancelTimer?: (handle: TimerHandle) => void;
}

export const shouldDebounceTerminalResize = (terminal: Terminal, immediate = false): boolean => (
  !immediate && terminal.buffer.normal.length >= START_DEBOUNCING_THRESHOLD
);

export class TerminalResizeDebouncer {
  private latestCols = 0;
  private latestRows = 0;
  private horizontalTimer: TimerHandle | null = null;
  private horizontalIdleJob: number | null = null;
  private verticalIdleJob: number | null = null;
  private lastHorizontalResizeAt: number | null = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly requestTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancelTimer: (handle: TimerHandle) => void;

  constructor(
    private readonly isVisible: () => boolean,
    private readonly getTerminal: () => Terminal | null,
    private readonly resizeBoth: (cols: number, rows: number) => void,
    private readonly resizeHorizontal: ResizeCallback,
    private readonly resizeVertical: ResizeCallback,
    options: TerminalResizeDebouncerOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.requestTimer = options.requestTimer ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.cancelTimer = options.cancelTimer ?? ((handle) => window.clearTimeout(handle));
  }

  resize(cols: number, rows: number, immediate = false): void {
    if (this.disposed) return;
    const terminal = this.getTerminal();
    if (!terminal) return;

    if (terminal.cols === cols && terminal.rows === rows) {
      this.cancel();
      return;
    }

    this.latestCols = cols;
    this.latestRows = rows;

    if (!shouldDebounceTerminalResize(terminal, immediate)) {
      this.cancel();
      this.resizeBoth(cols, rows);
      return;
    }

    if (!this.isVisible()) {
      this.clearHorizontalTimer();
      this.lastHorizontalResizeAt = null;
      if (this.horizontalIdleJob === null) {
        this.horizontalIdleJob = this.scheduleIdle(() => {
          this.horizontalIdleJob = null;
          if (!this.disposed) this.resizeHorizontal(this.latestCols);
        });
      }
      if (this.verticalIdleJob === null) {
        this.verticalIdleJob = this.scheduleIdle(() => {
          this.verticalIdleJob = null;
          if (!this.disposed) this.resizeVertical(this.latestRows);
        });
      }
      return;
    }

    this.clearIdleJobs();
    if (this.lastHorizontalResizeAt === null) {
      this.lastHorizontalResizeAt = this.now();
      this.resizeBoth(cols, rows);
      return;
    }

    this.resizeVertical(rows);
    const elapsed = this.now() - this.lastHorizontalResizeAt;
    if (elapsed >= HORIZONTAL_RESIZE_INTERVAL_MS) {
      this.clearHorizontalTimer();
      this.applyLatestHorizontalResize();
      return;
    }
    if (this.horizontalTimer !== null) return;
    this.horizontalTimer = this.requestTimer(() => {
      this.horizontalTimer = null;
      this.applyLatestHorizontalResize();
    }, HORIZONTAL_RESIZE_INTERVAL_MS - elapsed);
  }

  flush(): void {
    if (this.disposed || !this.hasPendingResize()) return;
    this.cancel();
    this.lastHorizontalResizeAt = this.now();
    this.resizeBoth(this.latestCols, this.latestRows);
  }

  cancel(): void {
    this.clearHorizontalTimer();
    this.clearIdleJobs();
    this.lastHorizontalResizeAt = null;
  }

  private clearHorizontalTimer(): void {
    if (this.horizontalTimer === null) return;
    this.cancelTimer(this.horizontalTimer);
    this.horizontalTimer = null;
  }

  private clearIdleJobs(): void {
    if (this.horizontalIdleJob !== null) {
      this.cancelIdle(this.horizontalIdleJob);
      this.horizontalIdleJob = null;
    }
    if (this.verticalIdleJob !== null) {
      this.cancelIdle(this.verticalIdleJob);
      this.verticalIdleJob = null;
    }
  }

  private applyLatestHorizontalResize(): void {
    if (this.disposed) return;
    this.lastHorizontalResizeAt = this.now();
    this.resizeHorizontal(this.latestCols);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  private hasPendingResize(): boolean {
    return this.horizontalTimer !== null || this.horizontalIdleJob !== null || this.verticalIdleJob !== null;
  }

  private scheduleIdle(callback: () => void): number {
    if (typeof window.requestIdleCallback === "function") {
      return window.requestIdleCallback(callback, { timeout: HIDDEN_RESIZE_IDLE_TIMEOUT_MS });
    }
    return window.setTimeout(callback, 0);
  }

  private cancelIdle(handle: number): void {
    if (typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(handle);
      return;
    }
    window.clearTimeout(handle);
  }
}
