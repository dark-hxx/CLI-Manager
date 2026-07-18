import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import {
  DESKTOP_PET_CLOSE_MENU_EVENT,
  DESKTOP_PET_CONFIG_EVENT,
  DESKTOP_PET_OPEN_SETTINGS_EVENT,
  DESKTOP_PET_OPEN_TARGET_EVENT,
  DESKTOP_PET_POSITION_EVENT,
  DESKTOP_PET_READY_EVENT,
  DESKTOP_PET_SNAPSHOT_EVENT,
  DESKTOP_PET_WINDOW_LABEL,
  deriveDesktopPetSnapshot,
  desktopPetScale,
  type BackgroundPetTask,
  type DesktopPetConfigPayload,
  type DesktopPetOpenTargetPayload,
  type DesktopPetPositionPayload,
  type DesktopPetSnapshot,
} from "../lib/desktopPet";
import { useI18n } from "../lib/i18n";
import { logWarn } from "../lib/logger";
import { useProjectStore } from "../stores/projectStore";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useTerminalStore } from "../stores/terminalStore";

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
  const persistedSessions = useSessionStore((state) => state.sessions);
  const { sessions, activeSessionId, tabNotifications, tabStatusDetails, ptyOutputActivityAt } = useTerminalStore(
    useShallow((state) => ({
      sessions: state.sessions,
      activeSessionId: state.activeSessionId,
      tabNotifications: state.tabNotifications,
      tabStatusDetails: state.tabStatusDetails,
      ptyOutputActivityAt: state.ptyOutputActivityAt,
    }))
  );
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundPetTask[]>([]);

  const snapshot = useMemo(
    () => deriveDesktopPetSnapshot({
      sessions,
      persistedSessions,
      activeSessionId,
      tabNotifications,
      tabStatusDetails,
      ptyOutputActivityAt,
      projects,
      backgroundTasks,
    }),
    [
      activeSessionId,
      backgroundTasks,
      persistedSessions,
      projects,
      ptyOutputActivityAt,
      sessions,
      tabNotifications,
      tabStatusDetails,
    ]
  );

  const configPayload = useMemo<DesktopPetConfigPayload>(() => ({
    language: language === "en-US" ? "en-US" : "zh-CN",
    settings: desktopPet,
    labels: {
      openMain: t("desktopPet.actions.openMain"),
      openSettings: t("desktopPet.actions.openSettings"),
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
    },
  }), [desktopPet, language, t]);

  const publicSnapshot = useMemo<DesktopPetSnapshot>(() => ({
    ...snapshot,
    sessionTitle: desktopPet.showSessionName ? snapshot.sessionTitle : null,
    projectName: desktopPet.showSessionName ? snapshot.projectName : null,
  }), [desktopPet.showSessionName, snapshot]);

  const sendState = useCallback(async () => {
    await Promise.all([
      emitTo(DESKTOP_PET_WINDOW_LABEL, DESKTOP_PET_CONFIG_EVENT, configPayload),
      emitTo(DESKTOP_PET_WINDOW_LABEL, DESKTOP_PET_SNAPSHOT_EVENT, publicSnapshot),
    ]).catch(() => {});
  }, [configPayload, publicSnapshot]);

  useEffect(() => {
    if (!appReady || !settingsLoaded || !desktopPet.enabled) {
      setBackgroundTasks([]);
      return;
    }
    let disposed = false;
    const refresh = async () => {
      try {
        const tasks = await invoke<BackgroundPetTask[]>("pty_daemon_sessions");
        if (!disposed) setBackgroundTasks(tasks);
      } catch {
        if (!disposed) setBackgroundTasks([]);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [appReady, desktopPet.enabled, settingsLoaded]);

  useEffect(() => {
    if (!appReady || !settingsLoaded) return;
    const enabled = desktopPet.enabled && !(desktopPet.autoHideFullscreen && terminalFullscreen);
    void (async () => {
      await emitTo(DESKTOP_PET_WINDOW_LABEL, DESKTOP_PET_CLOSE_MENU_EVENT).catch(() => {});
      await invoke("desktop_pet_window_sync", {
        config: {
          enabled,
          alwaysOnTop: desktopPet.alwaysOnTop,
          scale: desktopPetScale(desktopPet.size),
          position: desktopPet.position,
        },
      });
    })().catch((err) => logWarn("Failed to synchronize desktop pet window", err));
  }, [appReady, desktopPet, settingsLoaded, terminalFullscreen]);

  useEffect(() => {
    if (!appReady || !settingsLoaded || !desktopPet.enabled) return;
    void sendState();
  }, [appReady, desktopPet.enabled, publicSnapshot, sendState, settingsLoaded]);

  useEffect(() => {
    const unlistenReady = listen(DESKTOP_PET_READY_EVENT, () => {
      void sendState();
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
        await onActivateSession(sessionId);
      })().catch((err) => logWarn("Failed to activate desktop pet target", err));
    });
    const unlistenOpenSettings = listen(DESKTOP_PET_OPEN_SETTINGS_EVENT, () => {
      void invoke("app_show_main_window")
        .then(() => onOpenSettings())
        .catch((err) => logWarn("Failed to open desktop pet settings", err));
    });
    const unlistenPosition = listen<DesktopPetPositionPayload>(DESKTOP_PET_POSITION_EVENT, (event) => {
      const current = useSettingsStore.getState().desktopPet;
      if (current.lockPosition) return;
      const nextPosition = { x: Math.round(event.payload.x), y: Math.round(event.payload.y) };
      if (current.position?.x === nextPosition.x && current.position?.y === nextPosition.y) return;
      void updateSetting("desktopPet", { ...current, position: nextPosition });
    });
    return () => {
      void unlistenReady.then((unlisten) => unlisten());
      void unlistenOpenTarget.then((unlisten) => unlisten());
      void unlistenOpenSettings.then((unlisten) => unlisten());
      void unlistenPosition.then((unlisten) => unlisten());
    };
  }, [onActivateSession, onOpenSettings, sendState, updateSetting]);
}
