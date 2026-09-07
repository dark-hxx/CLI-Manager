import { attachConsole, error, info, warn } from "@tauri-apps/plugin-log";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

let initialized = false;
let crashHandlersInstalled = false;
let currentActivity = "app.bootstrap";
let currentActivityData: unknown;
const CRASH_BREADCRUMB_LIMIT = 50;

interface CrashBreadcrumb {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  data?: unknown;
}

interface FrontendCrashDetails {
  kind: string;
  message: string;
  stack?: string;
  componentStack?: string;
  url?: string;
  line?: number;
  column?: number;
}

const crashBreadcrumbs: CrashBreadcrumb[] = [];

export type PerfMetric =
  | "app.first_screen"
  | "history.open"
  | "history.index.warmup"
  | "history.sessions.load"
  | "history.search"
  | "history.session.detail"
  | "stats.open"
  | "stats.load";

interface PerfBudget {
  targetMs: number;
  warnMs: number;
  desc: string;
}

// P2 regression budgets: targetMs as acceptance baseline, warnMs as regression threshold.
export const PERF_BUDGETS: Record<PerfMetric, PerfBudget> = {
  "app.first_screen": {
    targetMs: 1200,
    warnMs: 1800,
    desc: "应用首屏渲染（App 挂载到可交互）",
  },
  "history.open": {
    targetMs: 450,
    warnMs: 900,
    desc: "打开历史工作区（含首次会话预取）",
  },
  "history.index.warmup": {
    targetMs: 900,
    warnMs: 1800,
    desc: "后台同步 Claude/Codex 历史索引",
  },
  "history.sessions.load": {
    targetMs: 200,
    warnMs: 500,
    desc: "历史会话列表加载",
  },
  "history.search": {
    targetMs: 200,
    warnMs: 500,
    desc: "历史会话全文搜索",
  },
  "history.session.detail": {
    targetMs: 260,
    warnMs: 520,
    desc: "单个历史会话详情加载",
  },
  "stats.open": {
    targetMs: 500,
    warnMs: 1000,
    desc: "打开分析看板（含必要会话预载）",
  },
  "stats.load": {
    targetMs: 900,
    warnMs: 1800,
    desc: "看板统计聚合加载（history_get_stats）",
  },
};

function formatArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack || arg.message;
  }
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function redactSensitive(value: string): string {
  return value
    .replace(/(["']?(?:token|password|passwd|secret|api[_-]?key)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1<redacted>")
    .replace(/(--(?:token|password|passwd|secret|api[_-]?key)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1<redacted>");
}

function crashData(data: unknown): unknown {
  if (data === undefined) return undefined;
  const formatted = redactSensitive(formatArg(data));
  return formatted.length > 8_192 ? `${formatted.slice(0, 8_192)}…<truncated>` : formatted;
}

function addCrashBreadcrumb(level: CrashBreadcrumb["level"], message: string, data?: unknown) {
  crashBreadcrumbs.push({
    timestamp: new Date().toISOString(),
    level,
    message: message.slice(0, 1_024),
    data: crashData(data),
  });
  if (crashBreadcrumbs.length > CRASH_BREADCRUMB_LIMIT) {
    crashBreadcrumbs.splice(0, crashBreadcrumbs.length - CRASH_BREADCRUMB_LIMIT);
  }
}

function runtimeContext() {
  return {
    activity: currentActivity,
    data: crashData(currentActivityData),
    windowLabel: (() => {
      try {
        return getCurrentWindow().label;
      } catch {
        return undefined;
      }
    })(),
    visibility: typeof document === "undefined" ? undefined : document.visibilityState,
    focused: typeof document === "undefined" ? undefined : document.hasFocus(),
    breadcrumbs: [...crashBreadcrumbs],
  };
}

function persistCrashContext() {
  void invoke("crash_context_update", { payload: runtimeContext() }).catch(() => undefined);
}

export function recordCrashActivity(activity: string, data?: unknown) {
  currentActivity = activity;
  currentActivityData = data;
  addCrashBreadcrumb("info", activity, data);
  persistCrashContext();
}

export function reportFrontendCrash(details: FrontendCrashDetails) {
  addCrashBreadcrumb("error", details.kind, {
    message: details.message,
    url: details.url,
    line: details.line,
    column: details.column,
  });
  void invoke("frontend_crash_report", {
    payload: {
      ...details,
      message: redactSensitive(details.message),
      stack: details.stack ? redactSensitive(details.stack) : undefined,
      componentStack: details.componentStack ? redactSensitive(details.componentStack) : undefined,
      context: runtimeContext(),
    },
  }).catch(() => undefined);
}

function errorDetails(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    return { message: value.message || value.name, stack: value.stack };
  }
  return { message: formatArg(value) };
}

export function installGlobalCrashHandlers() {
  if (crashHandlersInstalled || typeof window === "undefined") return;
  crashHandlersInstalled = true;

  window.addEventListener("error", (event) => {
    const details = errorDetails(event.error ?? event.message);
    reportFrontendCrash({
      kind: "window_error",
      message: details.message,
      stack: details.stack,
      url: event.filename || window.location.href,
      line: event.lineno || undefined,
      column: event.colno || undefined,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const details = errorDetails(event.reason);
    reportFrontendCrash({
      kind: "unhandled_promise_rejection",
      message: details.message,
      stack: details.stack,
      url: window.location.href,
    });
  });
  document.addEventListener("webglcontextlost", (event) => {
    const target = event.target as HTMLCanvasElement | null;
    reportFrontendCrash({
      kind: "webgl_context_lost",
      message: "A WebGL rendering context was lost",
      url: window.location.href,
      componentStack: target?.className || undefined,
    });
  }, true);
  window.addEventListener("focus", () => {
    addCrashBreadcrumb("info", "window.focus");
    persistCrashContext();
  });
  window.addEventListener("blur", () => {
    addCrashBreadcrumb("info", "window.blur");
    persistCrashContext();
  });
  document.addEventListener("visibilitychange", () => {
    addCrashBreadcrumb("info", "window.visibility_changed", { visibility: document.visibilityState });
    persistCrashContext();
  });
  persistCrashContext();
}

export async function initLogging() {
  if (initialized) return;
  initialized = true;
  try {
    await attachConsole();
  } catch (err) {
    const { useSettingsStore } = await import("../preferences/settingsStore");
    if (useSettingsStore.getState().debugMode) {
      console.warn("Failed to attach Tauri console logger:", err);
    }
  }
  void info("Logger initialized");
}

export function logInfo(message: string, data?: unknown) {
  addCrashBreadcrumb("info", message, data);
  void info(data ? `${message} ${formatArg(data)}` : message);
}

export function logWarn(message: string, data?: unknown) {
  addCrashBreadcrumb("warn", message, data);
  void warn(data ? `${message} ${formatArg(data)}` : message);
}

export function logError(message: string, data?: unknown) {
  currentActivity = "logged_error";
  currentActivityData = { message, data: crashData(data) };
  addCrashBreadcrumb("error", message, data);
  persistCrashContext();
  void error(data ? `${message} ${formatArg(data)}` : message);
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function roundMs(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

export function logPerf(
  metric: PerfMetric,
  durationMs: number,
  data?: Record<string, unknown>
) {
  const budget = PERF_BUDGETS[metric];
  const payload = {
    metric,
    durationMs: roundMs(durationMs),
    targetMs: budget.targetMs,
    warnMs: budget.warnMs,
    status: durationMs > budget.warnMs ? "regression" : durationMs > budget.targetMs ? "near-threshold" : "ok",
    ...data,
  };
  if (durationMs > budget.warnMs) {
    logWarn(`[perf] ${budget.desc}`, payload);
    return;
  }
  logInfo(`[perf] ${budget.desc}`, payload);
}

export function createPerfMarker(metric: PerfMetric, baseData?: Record<string, unknown>) {
  const startAt = nowMs();
  return (extraData?: Record<string, unknown>) => {
    const durationMs = nowMs() - startAt;
    logPerf(metric, durationMs, {
      ...(baseData ?? {}),
      ...(extraData ?? {}),
    });
  };
}
