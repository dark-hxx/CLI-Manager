import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface SystemResourceSnapshot {
  ipAddress: string | null;
  osName: string;
  hostName: string | null;
  uptimeSeconds: number;
  sampledAt: number;
  cpu: {
    usagePercent: number;
    coreCount: number;
  };
  cpuCores: Array<{
    index: number;
    usagePercent: number;
  }>;
  gpu: {
    usagePercent: number;
  } | null;
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    cachedBytes: number;
    freeBytes: number;
  };
  network: {
    uploadBytesPerSec: number;
    downloadBytesPerSec: number;
    totalUploadedBytes: number;
    totalDownloadedBytes: number;
    todayUploadedBytes: number;
    todayDownloadedBytes: number;
  };
  disks: Array<{
    name: string;
    mountPoint: string;
    fileSystem: string;
    totalBytes: number;
    availableBytes: number;
    usedBytes: number;
    readBytesPerSec: number;
    writeBytesPerSec: number;
  }>;
  topProcesses: Array<{
    pid: string;
    name: string;
    command: string;
    displayName: string | null;
    iconDataUrl: string | null;
    cpuUsagePercent: number;
    memoryBytes: number;
    memoryUsagePercent: number;
  }>;
}

export interface SystemResourceSnapshotOptions {
  fullDetail?: boolean;
  system?: boolean;
  cpu?: boolean;
  memory?: boolean;
  network?: boolean;
  disk?: boolean;
  gpu?: boolean;
  processes?: boolean;
}

function defaultIntervalMs(options: boolean | SystemResourceSnapshotOptions): number {
  return typeof options === "boolean" && !options ? 3000 : 2500;
}

export function useSystemResources(
  enabled: boolean,
  options: boolean | SystemResourceSnapshotOptions,
  intervalMs = defaultIntervalMs(options)
) {
  const [snapshot, setSnapshot] = useState<SystemResourceSnapshot | null>(null);
  const [history, setHistory] = useState<SystemResourceSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async (showLoading = false) => {
    if (!enabled || inFlightRef.current) return;
    inFlightRef.current = true;
    if (showLoading) setLoading(true);
    try {
      const payload = typeof options === "boolean" ? { fullDetail: options } : { options };
      const result = await invoke<SystemResourceSnapshot>("system_resources_get_snapshot", payload);
      setSnapshot(result);
      setHistory((prev) => {
        const next = [...prev, result];
        if (next.length > 48) return next.slice(next.length - 48);
        return next;
      });
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      inFlightRef.current = false;
      if (showLoading) setLoading(false);
    }
  }, [enabled, options]);

  useEffect(() => {
    if (!enabled) {
      // 面板切走时只停止轮询，保留 snapshot/history，切回后继续追加
      setLoading(false);
      setError(null);
      return;
    }

    void refresh(true);
    const timer = window.setInterval(() => {
      void refresh(false);
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, refresh]);

  return { snapshot, history, loading, error, refresh };
}
