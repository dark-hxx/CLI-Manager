import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import {
  DESKTOP_PET_CLOSE_MENU_EVENT,
  DESKTOP_PET_CONFIG_EVENT,
  DESKTOP_PET_OUTPUT_ACTIVITY_TTL_MS,
  DESKTOP_PET_OPEN_SETTINGS_EVENT,
  DESKTOP_PET_OPEN_TARGET_EVENT,
  DESKTOP_PET_POSITION_EVENT,
  DESKTOP_PET_READY_EVENT,
  DESKTOP_PET_SIZE_CHANGE_EVENT,
  DESKTOP_PET_SNAPSHOT_EVENT,
  DESKTOP_PET_WINDOW_LABEL,
  deriveDesktopPetSnapshot,
  desktopPetScale,
  normalizeDesktopPetSizePercent,
  type BackgroundPetTask,
  type DesktopPetConfigPayload,
  type DesktopPetOpenTargetPayload,
  type DesktopPetPositionPayload,
  type DesktopPetSizeChangePayload,
  type DesktopPetSnapshot,
} from "../lib/desktopPet";
import {
  desktopPetSnapshotFingerprint,
  sameBackgroundPetTasks,
} from "../lib/desktopPetTransport";
import { debugConsoleInfo } from "../lib/debugConsole";
import { useI18n } from "../lib/i18n";
import { logWarn } from "../lib/logger";
import { useProjectStore } from "../stores/projectStore";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useWorktreeStore } from "../stores/worktreeStore";
import { useRemoteHandoffStore } from "../stores/remoteHandoffStore";

interface UseDesktopPetCoordinatorOptions {
  appReady: boolean;
  terminalFullscreen: boolean;
  onOpenSettings: () => void;
  onActivateSession: (sessionId: string) => Promise<void>;
}

export function useDesktopPetCoordinator({
  appReady,
  terminalFullscreen,
  onOpenSettings,
  onActivateSession,
}: UseDesktopPetCoordinatorOptions) {
  const { language, t } = useI18n();
  const desktopPet = useSettingsStore((state) => state.desktopPet);
  const settingsLoaded = useSettingsStore((state) => state.loaded);
  const updateSetting = useSettingsStore((state) => state.update);
  const projects = useProjectStore((state) => state.projects);
  const worktrees = useWorktreeStore((state) => state.worktrees);
  const remoteHandoffStatus = useRemoteHandoffStore((state) => state.status);
  const remoteHandoffPlatforms = useRemoteHandoffStore((state) => state.platforms);
  const remoteHandoffBusy = useRemoteHandoffStore((state) => state.busy);
  const persistedSessions = useSessionStore((state) => state.sessions);
  const {
    sessions,
    activeSessionId,
    sessionStatuses,
    tabNotifications,
    tabStatusDetails,
    ptyOutputActivityAt,
  } = useTerminalStore(
    useShallow((state) => ({
      sessions: state.sessions,
      activeSessionId: state.activeSessionId,
      sessionStatuses: state.sessionStatuses,
      tabNotifications: state.tabNotifications,
      tabStatusDetails: state.tabStatusDetails,
      ptyOutputActivityAt: state.ptyOutputActivityAt,
    }))
  );
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundPetTask[]>([]);
  const [activityExpiryRevision, setActivityExpiryRevision] = useState(0);
  const petWindowVisible = appReady
    && settingsLoaded
    && desktopPet.enabled
    && !(desktopPet.autoHideFullscreen && terminalFullscreen);

  useEffect(() => {
    if (!petWindowVisible) return;
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
  }, [activityExpiryRevision, petWindowVisible, ptyOutputActivityAt]);

  const snapshot = useMemo(
    () => deriveDesktopPetSnapshot({
      sessions,
      persistedSessions,
      activeSessionId,
      sessionStatuses,
      tabNotifications,
      tabStatusDetails,
      ptyOutputActivityAt,
      projects,
      worktrees,
      backgroundTasks,
      activeHandoff: remoteHandoffStatus.info,
      handoffBusy: remoteHandoffBusy,
      now: Date.now(),
    }),
    [
      activeSessionId,
      activityExpiryRevision,
      backgroundTasks,
      persistedSessions,
      projects,
      ptyOutputActivityAt,
      remoteHandoffBusy,
      remoteHandoffStatus.info,
      sessions,
      sessionStatuses,
      tabNotifications,
      tabStatusDetails,
      worktrees,
    ]
  );

  const configPayload = useMemo<DesktopPetConfigPayload>(() => ({
    language,
    visible: petWindowVisible,
    settings: desktopPet,
    labels: {
      openMain: t("desktopPet.actions.openMain"),
      openSettings: t("desktopPet.actions.openSettings"),
      size: t("desktopPet.settings.size"),
      hide: t("desktopPet.actions.hide"),
      idle: t("desktopPet.mood.idle"),
      working: t("desktopPet.mood.working"),
      waiting: t("desktopPet.mood.waiting"),
      success: t("desktopPet.mood.success"),
      error: t("desktopPet.mood.error"),
      sleeping: t("desktopPet.mood.sleeping"),
      runningCount: t("desktopPet.mood.runningCount"),
      taskList: t("desktopPet.actions.taskList"),
      currentTask: t("desktopPet.actions.currentTask"),
      unnamedTask: t("desktopPet.actions.unnamedTask"),
      openCurrent: t("desktopPet.actions.openCurrent"),
      remoteHandoff: t("desktopPet.actions.remoteHandoff"),
      cancelHandoff: t("desktopPet.actions.cancelHandoff"),
      handoffPlatforms: t("desktopPet.actions.handoffPlatforms"),
      handoffSessions: t("desktopPet.actions.handoffSessions"),
      handoffBack: t("desktopPet.actions.handoffBack"),
      platformReady: t("desktopPet.actions.platformReady"),
      platformNotRunning: t("desktopPet.actions.platformNotRunning"),
      platformCredentialsMissing: t("desktopPet.actions.platformCredentialsMissing"),
      platformUserMissing: t("desktopPet.actions.platformUserMissing"),
      platformSessionMissing: t("desktopPet.actions.platformSessionMissing"),
      platformUnavailable: t("desktopPet.actions.platformUnavailable"),
      platformTelegram: t("settings.ccConnect.platformTelegram"),
      platformFeishu: t("settings.ccConnect.platformFeishu"),
      platformWeixin: t("settings.ccConnect.platformWeixin"),
      platformWecom: t("settings.ccConnect.platformWecom"),
      handoffPending: t("remoteHandoff.overlay.pending"),
      handoffCancelling: t("remoteHandoff.overlay.cancelling"),
      handedOff: t("desktopPet.actions.handedOff"),
      handoffRecoveryFailed: t("desktopPet.actions.handoffRecoveryFailed"),
      noHandoffSessions: t("desktopPet.actions.noHandoffSessions"),
    },
  }), [desktopPet, language, petWindowVisible, t]);

  const publicSnapshot = useMemo<DesktopPetSnapshot>(() => ({
    ...snapshot,
    handoffPlatforms: remoteHandoffPlatforms,
    sessionTitle: desktopPet.showSessionName ? snapshot.sessionTitle : null,
    projectName: desktopPet.showSessionName ? snapshot.projectName : null,
  }), [desktopPet.showSessionName, remoteHandoffPlatforms, snapshot]);

  const configPayloadRef = useRef(configPayload);
  const publicSnapshotRef = useRef(publicSnapshot);
  const lastSentConfigKeyRef = useRef<string | null>(null);
  const lastSentSnapshotKeyRef = useRef<string | null>(null);
  const stateSendInFlightRef = useRef(false);
  const stateSendPendingRef = useRef(false);
  const stateSendForceRef = useRef(false);
  const deliveryStatsRef = useRef({ requests: 0, emitted: 0, skipped: 0, coalesced: 0 });
  const onActivateSessionRef = useRef(onActivateSession);
  const onOpenSettingsRef = useRef(onOpenSettings);
  const updateSettingRef = useRef(updateSetting);
  const petAppliedWindowConfigKeyRef = useRef<string | null>(null);
  const petWindowVisibleRef = useRef(petWindowVisible);
  configPayloadRef.current = configPayload;
  publicSnapshotRef.current = publicSnapshot;
  onActivateSessionRef.current = onActivateSession;
  onOpenSettingsRef.current = onOpenSettings;
  updateSettingRef.current = updateSetting;
  petWindowVisibleRef.current = petWindowVisible;

  const sendState = useCallback(async (force = false) => {
    const stats = deliveryStatsRef.current;
    stats.requests += 1;
    stateSendPendingRef.current = true;
    stateSendForceRef.current = stateSendForceRef.current || force;
    if (stateSendInFlightRef.current) {
      stats.coalesced += 1;
      return;
    }

    stateSendInFlightRef.current = true;
    try {
      while (stateSendPendingRef.current) {
        stateSendPendingRef.current = false;
        const forceNext = stateSendForceRef.current;
        stateSendForceRef.current = false;
        const currentConfig = configPayloadRef.current;
        const currentSnapshot = publicSnapshotRef.current;
        const configKey = JSON.stringify(currentConfig);
        const snapshotKey = desktopPetSnapshotFingerprint(currentSnapshot);
        const sendConfig = forceNext || lastSentConfigKeyRef.current !== configKey;
        if (forceNext && !currentConfig.visible) {
          // A hidden pet window may have reloaded after its last visible snapshot.
          lastSentSnapshotKeyRef.current = null;
        }
        const sendSnapshot = currentConfig.visible
          && (forceNext || lastSentSnapshotKeyRef.current !== snapshotKey);
        if (!sendConfig && !sendSnapshot) {
          stats.skipped += 1;
          continue;
        }

        const deliveries: Promise<void>[] = [];
        if (sendConfig) {
          deliveries.push(
            emitTo(DESKTOP_PET_WINDOW_LABEL, DESKTOP_PET_CONFIG_EVENT, currentConfig)
          );
        }
        if (sendSnapshot) {
          deliveries.push(
            emitTo(DESKTOP_PET_WINDOW_LABEL, DESKTOP_PET_SNAPSHOT_EVENT, currentSnapshot)
          );
        }
        try {
          await Promise.all(deliveries);
          if (sendConfig) lastSentConfigKeyRef.current = configKey;
          if (sendSnapshot) lastSentSnapshotKeyRef.current = snapshotKey;
          stats.emitted += deliveries.length;
        } catch {
          break;
        }
      }
    } finally {
      stateSendInFlightRef.current = false;
      if (stats.requests % 120 === 0) {
        debugConsoleInfo("[desktop-pet:delivery]", { ...stats });
      }
    }
  }, []);

  useEffect(() => {
    if (!petWindowVisible) {
      setBackgroundTasks((current) => (current.length === 0 ? current : []));
      return;
    }
    let disposed = false;
    const refresh = async () => {
      try {
        const tasks = await invoke<BackgroundPetTask[]>("pty_daemon_sessions");
        if (!disposed) {
          setBackgroundTasks((current) => (
            sameBackgroundPetTasks(current, tasks) ? current : tasks
          ));
        }
      } catch {
        if (!disposed) {
          setBackgroundTasks((current) => (current.length === 0 ? current : []));
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [petWindowVisible]);

  useEffect(() => {
    if (!appReady || !settingsLoaded) return;
    const windowConfigKey = desktopPetWindowConfigKey(
      desktopPet.size,
      desktopPet.position,
      desktopPet.alwaysOnTop,
      petWindowVisible
    );
    // Pet-side resize/drag already applied these exact native bounds.
    if (petAppliedWindowConfigKeyRef.current === windowConfigKey) {
      petAppliedWindowConfigKeyRef.current = null;
      return;
    }
    void (async () => {
      await emitTo(DESKTOP_PET_WINDOW_LABEL, DESKTOP_PET_CLOSE_MENU_EVENT).catch(() => {});
      await invoke("desktop_pet_window_sync", {
        config: {
          enabled: petWindowVisible,
          alwaysOnTop: desktopPet.alwaysOnTop,
          scale: desktopPetScale(desktopPet.size),
          position: desktopPet.position,
        },
      });
    })().catch((err) => logWarn("Failed to synchronize desktop pet window", err));
  }, [
    appReady,
    desktopPet.alwaysOnTop,
    desktopPet.position,
    desktopPet.size,
    petWindowVisible,
    settingsLoaded,
  ]);

  useEffect(() => {
    if (!appReady || !settingsLoaded) return;
    void sendState();
  }, [appReady, configPayload, publicSnapshot, sendState, settingsLoaded]);

  useEffect(() => {
    const unlistenReady = listen(DESKTOP_PET_READY_EVENT, () => {
      void sendState(true);
    });
    const unlistenOpenTarget = listen<DesktopPetOpenTargetPayload>(DESKTOP_PET_OPEN_TARGET_EVENT, (event) => {
      void (async () => {
        await invoke("app_show_main_window");
        const sessionId = event.payload.sessionId;
        if (!sessionId) return;
        if (event.payload.daemonOnly) {
          const restored = await useTerminalStore.getState().attachDaemonSession(sessionId);
          if (!restored) return;
        }
        await onActivateSessionRef.current(sessionId);
      })().catch((err) => logWarn("Failed to activate desktop pet target", err));
    });
    const unlistenOpenSettings = listen(DESKTOP_PET_OPEN_SETTINGS_EVENT, () => {
      void invoke("app_show_main_window")
        .then(() => onOpenSettingsRef.current())
        .catch((err) => logWarn("Failed to open desktop pet settings", err));
    });
    const unlistenPosition = listen<DesktopPetPositionPayload>(DESKTOP_PET_POSITION_EVENT, (event) => {
      const current = useSettingsStore.getState().desktopPet;
      if (current.lockPosition) return;
      const nextPosition = { x: Math.round(event.payload.x), y: Math.round(event.payload.y) };
      if (current.position?.x === nextPosition.x && current.position?.y === nextPosition.y) return;
      const key = desktopPetWindowConfigKey(
        current.size,
        nextPosition,
        current.alwaysOnTop,
        petWindowVisibleRef.current
      );
      petAppliedWindowConfigKeyRef.current = key;
      void updateSettingRef.current("desktopPet", { ...current, position: nextPosition }).catch((err) => {
        if (petAppliedWindowConfigKeyRef.current === key) {
          petAppliedWindowConfigKeyRef.current = null;
        }
        logWarn("Failed to persist desktop pet position", err);
      });
    });
    const unlistenSizeChange = listen<DesktopPetSizeChangePayload>(
      DESKTOP_PET_SIZE_CHANGE_EVENT,
      (event) => {
        if (
          !Number.isFinite(event.payload.size)
          || !Number.isFinite(event.payload.x)
          || !Number.isFinite(event.payload.y)
        ) {
          return;
        }
        const current = useSettingsStore.getState().desktopPet;
        const size = normalizeDesktopPetSizePercent(event.payload.size, current.size);
        const position = {
          x: Math.round(event.payload.x),
          y: Math.round(event.payload.y),
        };
        if (
          current.size === size
          && current.position?.x === position.x
          && current.position?.y === position.y
        ) {
          return;
        }
        const key = desktopPetWindowConfigKey(
          size,
          position,
          current.alwaysOnTop,
          petWindowVisibleRef.current
        );
        petAppliedWindowConfigKeyRef.current = key;
        void updateSettingRef.current("desktopPet", { ...current, size, position }).catch((err) => {
          if (petAppliedWindowConfigKeyRef.current === key) {
            petAppliedWindowConfigKeyRef.current = null;
          }
          logWarn("Failed to persist desktop pet size", err);
        });
      }
    );
    return () => {
      void unlistenReady.then((unlisten) => unlisten());
      void unlistenOpenTarget.then((unlisten) => unlisten());
      void unlistenOpenSettings.then((unlisten) => unlisten());
      void unlistenPosition.then((unlisten) => unlisten());
      void unlistenSizeChange.then((unlisten) => unlisten());
    };
  }, [sendState]);
}

function desktopPetWindowConfigKey(
  size: number,
  position: { x: number; y: number } | null,
  alwaysOnTop: boolean,
  visible: boolean
): string {
  return [
    size,
    position?.x ?? "default",
    position?.y ?? "default",
    alwaysOnTop ? "top" : "normal",
    visible ? "visible" : "hidden",
  ].join(":");
}
