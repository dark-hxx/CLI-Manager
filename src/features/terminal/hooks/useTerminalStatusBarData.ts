import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { HistoryStatsPayload, HistoryStatsSourceItem } from "../../../shared/types/index";
import type { TerminalStatusBarItemKey } from "../../../shared/preferences/settingsStore";
import { fetchHistoryStatsPayload } from "../../history/index";
import { useSystemResources, type SystemResourceSnapshotOptions } from "../../stats/api/useSystemResources";
import { deriveDesktopPetSnapshot, DESKTOP_PET_OUTPUT_ACTIVITY_TTL_MS } from "../../desktop-pet/api/desktopPet";
import { useDaemonTaskInventory } from "../api/daemonTaskInventory";
import { useSessionStore } from "../api/sessionStore";
import { useProjectStore } from "../../projects/api/projectStore";
import { useTerminalStore } from "../state";
import { useAppMemory } from "./useAppMemory";
import { resolveTerminalStatusBarDataNeeds } from "../lib/terminalStatusBarItems";
import { logWarn } from "../../../shared/platform/logger";

const SYSTEM_POLL_INTERVAL_MS = 2000;
const TOKEN_POLL_INTERVAL_MS = 60_000;
const EMPTY_ACTIVITY: Record<string, number> = {};

export interface StatusBarTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costUsd: number;
}

export interface StatusBarTokenStats {
  all: StatusBarTokenTotals;
  claude: StatusBarTokenTotals | null;
  codex: StatusBarTokenTotals | null;
}

// 本地自然日边界；endAt 固定为当天结束，使后端统计缓存键在一天内保持稳定。
function localDayBounds(now = new Date()): { startAt: number; endAt: number } {
  return {
    startAt: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(),
    endAt: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime(),
  };
}

function totalsFromPayload(payload: HistoryStatsPayload): StatusBarTokenTotals {
  const input = payload.total_input_tokens;
  const output = payload.total_output_tokens;
  const cacheRead = payload.total_cache_read_tokens;
  const cacheWrite = payload.total_cache_creation_tokens;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite, costUsd: payload.total_cost_usd };
}

function totalsFromSource(item: HistoryStatsSourceItem | undefined): StatusBarTokenTotals | null {
  if (!item) return null;
  const { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_creation_tokens: cacheWrite } = item;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite, costUsd: item.total_cost_usd };
}

/** 窗口最小化或隐藏到托盘时 WebView 进入 hidden，信息栏借此暂停所有轮询。 */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

// 今日用量取自本地历史统计（后端按索引代际缓存，命中时很轻）；跨过零点时自动换到新的一天。
function useTodayTokenStats(enabled: boolean): StatusBarTokenStats | null {
  const [stats, setStats] = useState<StatusBarTokenStats | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const payload = await fetchHistoryStatsPayload({
          sourceFilter: "all",
          ...localDayBounds(),
        });
        if (cancelled) return;
        const bySource = new Map(payload.source_distribution.map((item) => [item.source, item]));
        setStats({
          all: totalsFromPayload(payload),
          claude: totalsFromSource(bySource.get("claude")),
          codex: totalsFromSource(bySource.get("codex")),
        });
      } catch (error) {
        logWarn(`[terminal-status-bar] load today token stats failed: ${String(error)}`);
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), TOKEN_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return stats;
}

// 复用桌宠的状态归并（Hook + Shell OSC + 输出活跃度 + daemon 后台任务），只统计 AI 终端。
function useAiSessionCounts(enabled: boolean) {
  const projects = useProjectStore((state) => state.projects);
  const persistedSessions = useSessionStore((state) => state.sessions);
  const { sessions, activeSessionId, tabNotifications, tabStatusDetails, ptyOutputActivityAt } = useTerminalStore(
    useShallow((state) => ({
      sessions: state.sessions,
      activeSessionId: state.activeSessionId,
      tabNotifications: state.tabNotifications,
      tabStatusDetails: state.tabStatusDetails,
      ptyOutputActivityAt: enabled ? state.ptyOutputActivityAt : EMPTY_ACTIVITY,
    }))
  );
  const { tasks: backgroundTasks } = useDaemonTaskInventory(enabled);
  const [activityExpiryRevision, setActivityExpiryRevision] = useState(0);

  // 输出活跃度有 TTL，到期后需要重新归并，否则“运行中”会一直停留。
  useEffect(() => {
    if (!enabled) return;
    const now = Date.now();
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const activityAt of Object.values(ptyOutputActivityAt)) {
      const expiresAt = activityAt + DESKTOP_PET_OUTPUT_ACTIVITY_TTL_MS;
      if (expiresAt > now) nextExpiry = Math.min(nextExpiry, expiresAt);
    }
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => setActivityExpiryRevision((revision) => revision + 1),
      Math.max(16, nextExpiry - now + 50)
    );
    return () => window.clearTimeout(timer);
  }, [activityExpiryRevision, enabled, ptyOutputActivityAt]);

  return useMemo(() => {
    if (!enabled) return null;
    const snapshot = deriveDesktopPetSnapshot({
      sessions,
      persistedSessions,
      activeSessionId,
      tabNotifications,
      tabStatusDetails,
      ptyOutputActivityAt,
      projects,
      backgroundTasks,
      agentSessionsOnly: true,
      now: Date.now(),
    });
    const attentionTarget = snapshot.targets.find((target) => target.status === "attention" && !target.daemonOnly);
    return {
      running: snapshot.runningCount,
      attention: snapshot.attentionCount,
      attentionSessionId: attentionTarget?.sessionId ?? null,
    };
    // activityExpiryRevision 仅用于触发 TTL 到期后的重新归并。
  }, [
    activeSessionId,
    activityExpiryRevision,
    backgroundTasks,
    enabled,
    persistedSessions,
    projects,
    ptyOutputActivityAt,
    sessions,
    tabNotifications,
    tabStatusDetails,
  ]);
}

export function useTerminalStatusBarData(visibleKeys: readonly TerminalStatusBarItemKey[]) {
  const documentVisible = useDocumentVisible();
  const needs = useMemo(() => resolveTerminalStatusBarDataNeeds(visibleKeys), [visibleKeys]);
  const systemEnabled = documentVisible && (needs.cpu || needs.memory || needs.gpu || needs.network || needs.disk);
  // 选项对象必须稳定，否则 useSystemResources 的 refresh 每次渲染都会重建并重启定时器。
  const systemOptions = useMemo<SystemResourceSnapshotOptions>(
    () => ({
      system: false,
      cpu: needs.cpu,
      memory: needs.memory,
      gpu: needs.gpu,
      network: needs.network,
      disk: needs.disk,
      processes: false,
    }),
    [needs.cpu, needs.disk, needs.gpu, needs.memory, needs.network]
  );
  const { snapshot } = useSystemResources(systemEnabled, systemOptions, SYSTEM_POLL_INTERVAL_MS);
  const tokens = useTodayTokenStats(documentVisible && needs.tokens);
  const sessionCounts = useAiSessionCounts(documentVisible && needs.sessionCounts);
  const appMemory = useAppMemory(documentVisible && needs.appMemory);

  return { snapshot, tokens, sessionCounts, appMemory };
}
