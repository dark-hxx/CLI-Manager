import { attachConsole, error, info, warn } from "@tauri-apps/plugin-log";

let initialized = false;

export type PerfMetric =
  | "app.first_screen"
  | "history.open"
  | "history.sessions.load"
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
  "history.sessions.load": {
    targetMs: 650,
    warnMs: 1300,
    desc: "历史会话列表加载",
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

export async function initLogging() {
  if (initialized) return;
  initialized = true;
  try {
    await attachConsole();
  } catch (err) {
    console.warn("Failed to attach Tauri console logger:", err);
  }
  void info("Logger initialized");
}

export function logInfo(message: string, data?: unknown) {
  void info(data ? `${message} ${formatArg(data)}` : message);
}

export function logWarn(message: string, data?: unknown) {
  void warn(data ? `${message} ${formatArg(data)}` : message);
}

export function logError(message: string, data?: unknown) {
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
