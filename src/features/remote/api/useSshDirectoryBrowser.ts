import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SshHost } from "../../../shared/types/index";
import {
  createSshDirectoryBrowserSession,
  listSshDirectories,
  normalizeSshDirectoryPath,
  releaseSshDirectoryBrowserSession,
  sshDirectoryBrowserConnectionKey,
  type SshDirectoryBrowserSession,
  type SshDirectoryEntry,
} from "../lib/sshRemoteDirectories";

interface UseSshDirectoryBrowserOptions {
  describeError?: (error: unknown) => string;
}

interface PendingSession {
  key: string;
  promise: Promise<SshDirectoryBrowserSession>;
}

const defaultDescribeError = (error: unknown) => String(error);

export function useSshDirectoryBrowser(
  host: SshHost | null,
  hosts: SshHost[],
  options: UseSshDirectoryBrowserOptions = {},
) {
  const connectionKey = useMemo(
    () => sshDirectoryBrowserConnectionKey(host, hosts),
    [host, hosts],
  );
  const describeError = options.describeError ?? defaultDescribeError;
  const [path, setPathState] = useState("/");
  const [entries, setEntries] = useState<SshDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sessionRef = useRef<SshDirectoryBrowserSession | null>(null);
  const pendingSessionRef = useRef<PendingSession | null>(null);
  const requestSequenceRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const connectionKeyRef = useRef(connectionKey);
  const mountedRef = useRef(true);
  connectionKeyRef.current = connectionKey;

  const releaseSession = useCallback((session: SshDirectoryBrowserSession | null) => {
    if (!session) return;
    void releaseSshDirectoryBrowserSession(session).catch(() => undefined);
  }, []);

  const getSession = useCallback(async (): Promise<SshDirectoryBrowserSession> => {
    if (!host) throw new Error("ssh_host_not_found");
    const existing = sessionRef.current;
    if (existing?.connectionKey === connectionKey) return existing;

    const pending = pendingSessionRef.current;
    if (pending?.key === connectionKey) return pending.promise;

    if (existing) {
      sessionRef.current = null;
      releaseSession(existing);
    }
    const promise = createSshDirectoryBrowserSession(connectionKey, host, hosts);
    pendingSessionRef.current = { key: connectionKey, promise };
    try {
      const session = await promise;
      if (!mountedRef.current || connectionKeyRef.current !== connectionKey) {
        releaseSession(session);
        throw new Error("ssh_directory_request_stale");
      }
      sessionRef.current = session;
      return session;
    } finally {
      if (pendingSessionRef.current?.promise === promise) pendingSessionRef.current = null;
    }
  }, [connectionKey, host, hosts, releaseSession]);

  const load = useCallback(async (
    rawPath: string,
    loadOptions: { force?: boolean } = {},
  ): Promise<void> => {
    const normalizedPath = normalizeSshDirectoryPath(rawPath);
    requestAbortRef.current?.abort();
    const requestAbort = new AbortController();
    requestAbortRef.current = requestAbort;
    const requestSequence = ++requestSequenceRef.current;
    const requestConnectionKey = connectionKey;
    setPathState(normalizedPath);
    setLoading(true);
    setError("");
    try {
      const session = await getSession();
      const nextEntries = await listSshDirectories(session, normalizedPath, {
        ...loadOptions,
        signal: requestAbort.signal,
      });
      if (!mountedRef.current
        || requestSequence !== requestSequenceRef.current
        || requestConnectionKey !== connectionKeyRef.current) return;
      setEntries(nextEntries);
    } catch (nextError) {
      if (!mountedRef.current
        || requestSequence !== requestSequenceRef.current
        || requestConnectionKey !== connectionKeyRef.current) return;
      setEntries([]);
      setError(describeError(nextError));
    } finally {
      if (mountedRef.current
        && requestSequence === requestSequenceRef.current
        && requestConnectionKey === connectionKeyRef.current) {
        setLoading(false);
        if (requestAbortRef.current === requestAbort) requestAbortRef.current = null;
      }
    }
  }, [connectionKey, describeError, getSession]);

  const setPath = useCallback((nextPath: string) => {
    setPathState(nextPath);
    setError("");
  }, []);

  const close = useCallback(() => {
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    const closeSequence = ++requestSequenceRef.current;
    setLoading(false);
    const session = sessionRef.current;
    releaseSession(session);
    const pending = pendingSessionRef.current;
    if (pending) {
      void pending.promise.then((created) => {
        if (requestSequenceRef.current === closeSequence) releaseSession(created);
      }).catch(() => undefined);
    }
  }, [releaseSession]);

  useEffect(() => {
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    const existing = sessionRef.current;
    if (existing && existing.connectionKey !== connectionKey) {
      sessionRef.current = null;
      releaseSession(existing);
    }
    requestSequenceRef.current += 1;
    setLoading(false);
    setEntries([]);
    setError("");
  }, [connectionKey, releaseSession]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      requestSequenceRef.current += 1;
      releaseSession(sessionRef.current);
      const pending = pendingSessionRef.current;
      if (pending) void pending.promise.then(releaseSession).catch(() => undefined);
    };
  }, [releaseSession]);

  return {
    path,
    setPath,
    entries,
    loading,
    error,
    load,
    close,
  };
}
