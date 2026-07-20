import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppWindow,
  ArrowLeft,
  Building2,
  EyeOff,
  LockKeyhole,
  MessageCircle,
  MessagesSquare,
  MonitorUp,
  PauseCircle,
  RadioTower,
  Send,
  Settings,
} from "lucide-react";
import { CliCat } from "../components/desktop-pet/CliCat";
import { PetArtwork } from "../components/desktop-pet/PetArtwork";
import {
  DESKTOP_PET_CONFIG_EVENT,
  DESKTOP_PET_CLOSE_MENU_EVENT,
  DESKTOP_PET_HANDOFF_CANCEL_EVENT,
  DESKTOP_PET_HANDOFF_START_EVENT,
  DESKTOP_PET_OPEN_SETTINGS_EVENT,
  DESKTOP_PET_OPEN_TARGET_EVENT,
  DESKTOP_PET_POSITION_EVENT,
  DESKTOP_PET_READY_EVENT,
  DESKTOP_PET_SNAPSHOT_EVENT,
  calculateDesktopPetMenuWindowGeometry,
  createLatestAsyncTaskRunner,
  desktopPetScale,
  type DesktopPetConfigPayload,
  type DesktopPetMenuWindowGeometry,
  type DesktopPetMood,
  type DesktopPetWindowRect,
  type LatestAsyncTaskRunner,
  type DesktopPetSnapshot,
  type DesktopPetTarget,
  type InstalledPet,
} from "../lib/desktopPet";
import { translate } from "../lib/i18n";
import { logWarn } from "../lib/logger";
import type {
  CcConnectHandoffPlatformTarget,
  CcConnectPlatform,
} from "../lib/remoteHandoff";
import { BUILTIN_DESKTOP_PET_ID } from "../stores/settingsStore";
import "./desktopPet.css";

const DEFAULT_CONFIG: DesktopPetConfigPayload = {
  language: "zh-CN",
  visible: false,
  settings: {
    enabled: true,
    petId: BUILTIN_DESKTOP_PET_ID,
    alwaysOnTop: true,
    size: "medium",
    workingBounceEnabled: false,
    workingBounceDistancePx: 5,
    showStatus: true,
    showSessionName: false,
    autoHideFullscreen: true,
    lockPosition: false,
    position: null,
  },
  labels: {
    openMain: translate("zh-CN", "desktopPet.actions.openMain"),
    openSettings: translate("zh-CN", "desktopPet.actions.openSettings"),
    hide: translate("zh-CN", "desktopPet.actions.hide"),
    idle: translate("zh-CN", "desktopPet.mood.idle"),
    working: translate("zh-CN", "desktopPet.mood.working"),
    waiting: translate("zh-CN", "desktopPet.mood.waiting"),
    success: translate("zh-CN", "desktopPet.mood.success"),
    error: translate("zh-CN", "desktopPet.mood.error"),
    sleeping: translate("zh-CN", "desktopPet.mood.sleeping"),
    runningCount: translate("zh-CN", "desktopPet.mood.runningCount"),
    taskList: translate("zh-CN", "desktopPet.actions.taskList"),
    currentTask: translate("zh-CN", "desktopPet.actions.currentTask"),
    unnamedTask: translate("zh-CN", "desktopPet.actions.unnamedTask"),
    openCurrent: translate("zh-CN", "desktopPet.actions.openCurrent"),
    remoteHandoff: translate("zh-CN", "desktopPet.actions.remoteHandoff"),
    cancelHandoff: translate("zh-CN", "desktopPet.actions.cancelHandoff"),
    handoffPlatforms: translate("zh-CN", "desktopPet.actions.handoffPlatforms"),
    handoffSessions: translate("zh-CN", "desktopPet.actions.handoffSessions"),
    handoffBack: translate("zh-CN", "desktopPet.actions.handoffBack"),
    platformReady: translate("zh-CN", "desktopPet.actions.platformReady"),
    platformNotRunning: translate("zh-CN", "desktopPet.actions.platformNotRunning"),
    platformCredentialsMissing: translate(
      "zh-CN",
      "desktopPet.actions.platformCredentialsMissing"
    ),
    platformUserMissing: translate("zh-CN", "desktopPet.actions.platformUserMissing"),
    platformSessionMissing: translate("zh-CN", "desktopPet.actions.platformSessionMissing"),
    platformUnavailable: translate("zh-CN", "desktopPet.actions.platformUnavailable"),
    platformTelegram: translate("zh-CN", "settings.ccConnect.platformTelegram"),
    platformFeishu: translate("zh-CN", "settings.ccConnect.platformFeishu"),
    platformWeixin: translate("zh-CN", "settings.ccConnect.platformWeixin"),
    platformWecom: translate("zh-CN", "settings.ccConnect.platformWecom"),
    handoffPending: translate("zh-CN", "remoteHandoff.overlay.pending"),
    handoffCancelling: translate("zh-CN", "remoteHandoff.overlay.cancelling"),
    handedOff: translate("zh-CN", "desktopPet.actions.handedOff"),
    handoffRecoveryFailed: translate("zh-CN", "desktopPet.actions.handoffRecoveryFailed"),
    noHandoffSessions: translate("zh-CN", "desktopPet.actions.noHandoffSessions"),
  },
};

const DEFAULT_SNAPSHOT: DesktopPetSnapshot = {
  mood: "sleeping",
  sessionId: null,
  daemonOnly: false,
  sessionTitle: null,
  projectName: null,
  runningCount: 0,
  attentionCount: 0,
  updatedAt: Date.now(),
  targets: [],
  handoff: null,
  handoffPlatforms: [],
  handoffBusy: false,
};

function moodLabel(config: DesktopPetConfigPayload, mood: DesktopPetMood): string {
  return config.labels[mood];
}

function localPetName(pet: InstalledPet, language: DesktopPetConfigPayload["language"]): string {
  return language === "en-US" ? pet.manifest.name["en-US"] : pet.manifest.name["zh-CN"];
}

function distinctDisplayLabels(...values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const value of values) {
    const label = value?.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

function targetStatusLabel(config: DesktopPetConfigPayload, target: DesktopPetTarget): string {
  if (target.handoffPhase === "pending") return config.labels.handoffPending;
  if (target.handoffPhase === "cancelling") return config.labels.handoffCancelling;
  if (target.handoffPhase === "recovery_failed") {
    return config.labels.handoffRecoveryFailed;
  }
  if (target.handedOff) return config.labels.handedOff;
  const mood: DesktopPetMood =
    target.status === "running"
      ? "working"
      : target.status === "attention"
        ? "waiting"
        : target.status === "done"
          ? "success"
          : target.status === "failed"
            ? "error"
            : "idle";
  return moodLabel(config, mood);
}

function platformLabel(
  config: DesktopPetConfigPayload,
  platform: CcConnectPlatform
): string {
  return {
    telegram: config.labels.platformTelegram,
    feishu: config.labels.platformFeishu,
    weixin: config.labels.platformWeixin,
    wecom: config.labels.platformWecom,
  }[platform];
}

function platformStatusLabel(
  config: DesktopPetConfigPayload,
  target: CcConnectHandoffPlatformTarget
): string {
  if (target.ready) return config.labels.platformReady;
  if (target.unavailableReason === "cc_connect_not_running") {
    return config.labels.platformNotRunning;
  }
  if (target.unavailableReason === "handoff_credentials_missing") {
    return config.labels.platformCredentialsMissing;
  }
  if (target.unavailableReason === "handoff_platform_user_missing") {
    return config.labels.platformUserMissing;
  }
  if (target.unavailableReason === "handoff_platform_session_missing") {
    return config.labels.platformSessionMissing;
  }
  return config.labels.platformUnavailable;
}

function PlatformIcon({ platform }: { platform: CcConnectPlatform }) {
  const Icon = {
    telegram: Send,
    feishu: MessagesSquare,
    weixin: MessageCircle,
    wecom: Building2,
  }[platform];
  return <Icon size={15} aria-hidden="true" />;
}

interface CollapsedPetWindowGeometry {
  bounds: DesktopPetWindowRect;
  scaleFactor: number;
  workArea: DesktopPetWindowRect | null;
}

interface DesktopPetMenuWindowRequest {
  open: boolean;
  secondaryItemCount: number;
  secondaryHeaderHeight: number;
}

function setDesktopPetWindowBounds(bounds: DesktopPetWindowRect): Promise<void> {
  return invoke("desktop_pet_window_set_bounds", { bounds });
}

function targetFanStyle(index: number, count: number): CSSProperties {
  const visibleCount = Math.min(Math.max(count, 1), 5);
  const slot = Math.min(index, visibleCount - 1);
  const center = (visibleCount - 1) / 2;
  const normalized = center <= 0 ? 0 : (slot - center) / center;
  return {
    "--fan-angle": `${normalized * 2.4}deg`,
    "--fan-shift": `${(1 - Math.abs(normalized)) * 18}px`,
    "--fan-delay": `${Math.min(index, 8) * 28}ms`,
    zIndex: count - index,
  } as CSSProperties;
}

export default function DesktopPetApp() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [snapshot, setSnapshot] = useState(DEFAULT_SNAPSHOT);
  const [displayMood, setDisplayMood] = useState<DesktopPetMood>(DEFAULT_SNAPSHOT.mood);
  const [installedPet, setInstalledPet] = useState<InstalledPet | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [targetMode, setTargetMode] = useState<"open" | "platforms" | "handoff">("open");
  const [selectedPlatform, setSelectedPlatform] = useState<CcConnectPlatform | null>(null);
  const [menuGeometry, setMenuGeometry] = useState<DesktopPetMenuWindowGeometry | null>(null);
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const menuTargets = targetMode === "handoff"
    ? snapshot.targets.filter((target) => target.handoffEligible)
    : snapshot.targets;
  const handoffPlatforms = useMemo(
    () => snapshot.handoffPlatforms.filter((platform) => platform.enabled),
    [snapshot.handoffPlatforms]
  );
  const secondaryItemCount = targetMode === "platforms"
    ? handoffPlatforms.length
    : menuTargets.length;
  const secondaryHeaderHeight = targetMode === "open" ? 0 : 34;
  const moveTimerRef = useRef<number | null>(null);
  const dragResetTimerRef = useRef<number | null>(null);
  const userDraggingRef = useRef(false);
  const collapsedWindowGeometryRef = useRef<CollapsedPetWindowGeometry | null>(null);
  const menuWindowTaskRef = useRef<LatestAsyncTaskRunner<DesktopPetMenuWindowRequest> | null>(null);
  if (!menuWindowTaskRef.current) {
    menuWindowTaskRef.current = createLatestAsyncTaskRunner<DesktopPetMenuWindowRequest>(
      async (request, context) => {
        if (request.open) {
          let collapsed = collapsedWindowGeometryRef.current;
          try {
            if (!collapsed) {
              const appWindow = getCurrentWindow();
              const [position, size, scaleFactor, monitor] = await Promise.all([
                appWindow.outerPosition(),
                appWindow.outerSize(),
                appWindow.scaleFactor(),
                currentMonitor().catch(() => null),
              ]);
              collapsed = {
                bounds: {
                  x: position.x,
                  y: position.y,
                  width: size.width,
                  height: size.height,
                },
                scaleFactor,
                workArea: monitor
                  ? {
                      x: monitor.workArea.position.x,
                      y: monitor.workArea.position.y,
                      width: monitor.workArea.size.width,
                      height: monitor.workArea.size.height,
                    }
                  : null,
              };
              collapsedWindowGeometryRef.current = collapsed;
            }

            const geometry = calculateDesktopPetMenuWindowGeometry(
              collapsed.bounds,
              collapsed.scaleFactor,
              request.secondaryItemCount,
              collapsed.workArea,
              request.secondaryHeaderHeight
            );
            if (!context.isLatest()) return;

            setMenuGeometry(geometry);
            await setDesktopPetWindowBounds({
              x: geometry.x,
              y: geometry.y,
              width: geometry.physicalWidth,
              height: geometry.physicalHeight,
            });
          } catch (error) {
            if (context.isLatest()) {
              if (collapsed) {
                await setDesktopPetWindowBounds(collapsed.bounds).catch(() => {});
              }
              collapsedWindowGeometryRef.current = null;
              setMenuGeometry(null);
              setMenuOpen(false);
              setTargetMode("open");
              setSelectedPlatform(null);
            }
            throw error;
          }
          return;
        }

        if (!context.isLatest()) return;
        const collapsed = collapsedWindowGeometryRef.current;
        if (!collapsed) {
          setMenuGeometry(null);
          return;
        }

        await setDesktopPetWindowBounds(collapsed.bounds);
        if (!context.isLatest()) return;
        collapsedWindowGeometryRef.current = null;
        setMenuGeometry(null);
      },
      (error) => {
        logWarn("Failed to resize desktop pet menu window", error);
      }
    );
  }

  useEffect(() => {
    const rootElements = [document.documentElement, document.body, document.getElementById("root")];
    rootElements.forEach((element) => {
      if (element) element.style.background = "transparent";
    });
    document.documentElement.dataset.window = "desktop-pet";
    const handleVisibilityChange = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    let disposed = false;
    const unlistenConfig = listen<DesktopPetConfigPayload>(DESKTOP_PET_CONFIG_EVENT, (event) => {
      if (!disposed) setConfig(event.payload);
    });
    const unlistenSnapshot = listen<DesktopPetSnapshot>(DESKTOP_PET_SNAPSHOT_EVENT, (event) => {
      if (!disposed) {
        setSnapshot({
          ...event.payload,
          handoffPlatforms: event.payload.handoffPlatforms ?? [],
        });
      }
    });
    const unlistenCloseMenu = listen(DESKTOP_PET_CLOSE_MENU_EVENT, () => {
      if (!disposed) {
        setMenuOpen(false);
        setTargetMode("open");
        setSelectedPlatform(null);
      }
    });
    const appWindow = getCurrentWindow();
    const unlistenMoved = appWindow.onMoved(({ payload }) => {
      if (!userDraggingRef.current) return;
      if (moveTimerRef.current !== null) window.clearTimeout(moveTimerRef.current);
      moveTimerRef.current = window.setTimeout(() => {
        userDraggingRef.current = false;
        moveTimerRef.current = null;
        if (dragResetTimerRef.current !== null) {
          window.clearTimeout(dragResetTimerRef.current);
          dragResetTimerRef.current = null;
        }
        void emitTo("main", DESKTOP_PET_POSITION_EVENT, { x: payload.x, y: payload.y });
      }, 400);
    });
    void emit(DESKTOP_PET_READY_EVENT);
    return () => {
      disposed = true;
      if (moveTimerRef.current !== null) window.clearTimeout(moveTimerRef.current);
      if (dragResetTimerRef.current !== null) window.clearTimeout(dragResetTimerRef.current);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void unlistenConfig.then((unlisten) => unlisten());
      void unlistenSnapshot.then((unlisten) => unlisten());
      void unlistenCloseMenu.then((unlisten) => unlisten());
      void unlistenMoved.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    menuWindowTaskRef.current?.schedule({
      open: menuOpen,
      secondaryItemCount,
      secondaryHeaderHeight,
    });
  }, [menuOpen, secondaryHeaderHeight, secondaryItemCount]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setTargetMode("open");
        setSelectedPlatform(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!config.settings.enabled) {
      setMenuOpen(false);
      setTargetMode("open");
      setSelectedPlatform(null);
    }
  }, [config.settings.enabled]);

  useEffect(() => {
    if (targetMode === "platforms" && handoffPlatforms.length === 0) {
      setTargetMode("open");
      setSelectedPlatform(null);
      return;
    }
    if (
      targetMode === "handoff"
      && (
        !selectedPlatform
        || !snapshot.targets.some((target) => target.handoffEligible)
        || !handoffPlatforms.some(
          (platform) => platform.platform === selectedPlatform && platform.ready
        )
      )
    ) {
      setTargetMode(handoffPlatforms.length > 0 ? "platforms" : "open");
      setSelectedPlatform(null);
    }
  }, [handoffPlatforms, selectedPlatform, snapshot.targets, targetMode]);

  useEffect(() => {
    if (snapshot.mood !== "success") {
      setDisplayMood(snapshot.mood);
      return;
    }
    const remaining = 3500 - Math.max(0, Date.now() - snapshot.updatedAt);
    if (remaining <= 0) {
      setDisplayMood("idle");
      return;
    }
    setDisplayMood("success");
    const timer = window.setTimeout(() => setDisplayMood("idle"), remaining);
    return () => window.clearTimeout(timer);
  }, [snapshot.mood, snapshot.updatedAt]);

  useEffect(() => {
    if (config.settings.petId === BUILTIN_DESKTOP_PET_ID) {
      setInstalledPet(null);
      return;
    }
    let cancelled = false;
    void invoke<InstalledPet | null>("desktop_pet_get_installed", { petId: config.settings.petId })
      .then((pet) => {
        if (!cancelled) setInstalledPet(pet);
      })
      .catch(() => {
        if (!cancelled) setInstalledPet(null);
      });
    return () => {
      cancelled = true;
    };
  }, [config.settings.petId]);

  const detail = config.settings.showSessionName
    ? distinctDisplayLabels(snapshot.projectName, snapshot.sessionTitle).join(" · ")
    : "";
  const runningDetail = snapshot.runningCount > 1
    ? `${snapshot.runningCount} ${config.labels.runningCount}`
    : "";
  const petScale = desktopPetScale(config.settings.size);
  const stageSize = Math.round(144 * petScale);
  const renderingActive = config.visible && documentVisible;
  const rootStyle = {
    "--pet-stage-size": `${stageSize}px`,
    "--pet-cat-width": `${Math.round(132 * petScale)}px`,
    "--pet-cat-height": `${Math.round(96 * petScale)}px`,
    "--pet-work-bounce-offset": `${-config.settings.workingBounceDistancePx}px`,
    ...(menuGeometry
      ? {
          "--pet-anchor-x": `${menuGeometry.anchorX}px`,
          "--pet-anchor-y": `${menuGeometry.anchorY}px`,
          "--pet-anchor-width": `${menuGeometry.anchorWidth}px`,
          "--pet-anchor-height": `${menuGeometry.anchorHeight}px`,
          "--pet-menu-panel-width": `${menuGeometry.panelWidth}px`,
          "--pet-target-list-height": `${menuGeometry.targetListHeight}px`,
        }
      : {}),
  } as CSSProperties;

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || config.settings.lockPosition || menuOpen) return;
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    userDraggingRef.current = true;
    if (dragResetTimerRef.current !== null) window.clearTimeout(dragResetTimerRef.current);
    dragResetTimerRef.current = window.setTimeout(() => {
      userDraggingRef.current = false;
      dragResetTimerRef.current = null;
    }, 5000);
    void getCurrentWindow().startDragging().catch(() => {
      userDraggingRef.current = false;
      if (dragResetTimerRef.current !== null) {
        window.clearTimeout(dragResetTimerRef.current);
        dragResetTimerRef.current = null;
      }
    });
  };

  const closeMenu = () => {
    setMenuOpen(false);
    setTargetMode("open");
    setSelectedPlatform(null);
  };

  const openTarget = (target?: DesktopPetTarget) => {
    closeMenu();
    void emitTo("main", DESKTOP_PET_OPEN_TARGET_EVENT, {
      sessionId: target?.sessionId ?? snapshot.sessionId,
      daemonOnly: target?.daemonOnly ?? snapshot.daemonOnly,
    }).catch((err) => logWarn("Failed to request desktop pet target activation", err));
  };

  const requestHandoff = (target: DesktopPetTarget) => {
    if (!selectedPlatform) return;
    closeMenu();
    void emitTo("main", DESKTOP_PET_HANDOFF_START_EVENT, {
      sessionId: target.sessionId,
      platform: selectedPlatform,
    }).catch((err) => logWarn("Failed to request remote handoff", err));
  };

  const selectHandoffPlatform = (target: CcConnectHandoffPlatformTarget) => {
    if (!target.ready) return;
    setSelectedPlatform(target.platform);
    setTargetMode("handoff");
  };

  const cancelHandoff = () => {
    closeMenu();
    void emitTo("main", DESKTOP_PET_HANDOFF_CANCEL_EVENT).catch((err) => {
      logWarn("Failed to request remote handoff cancellation", err);
    });
  };

  const openMainWindow = () => {
    closeMenu();
    void invoke("app_show_main_window").catch((err) => {
      logWarn("Failed to open CLI-Manager from desktop pet", err);
    });
  };

  return (
    <main
      className="desktop-pet-root"
      data-mood={displayMood}
      data-work-bounce={
        config.settings.workingBounceEnabled && config.settings.workingBounceDistancePx > 0
          ? "true"
          : undefined
      }
      data-menu-open={menuGeometry ? "true" : undefined}
      data-menu-horizontal={menuGeometry?.horizontalPlacement}
      data-menu-vertical={menuGeometry?.verticalPlacement}
      data-rendering-active={renderingActive ? "true" : "false"}
      style={rootStyle}
      onPointerDown={handlePointerDown}
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        openTarget();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (menuOpen) {
          closeMenu();
        } else {
          setTargetMode("open");
          setSelectedPlatform(null);
          setMenuOpen(true);
        }
      }}
      aria-label={moodLabel(config, displayMood)}
    >
      <div className="desktop-pet-anchor">
        {config.settings.showStatus ? (
          <section className="desktop-pet-status" aria-live="polite">
            <strong>{moodLabel(config, displayMood)}</strong>
            {detail ? <span title={detail}>{detail}</span> : null}
            {runningDetail ? <small>{runningDetail}</small> : null}
          </section>
        ) : null}

        <div className="desktop-pet-stage" title={moodLabel(config, displayMood)}>
          {installedPet ? (
            <PetArtwork
              pet={installedPet}
              mood={displayMood}
              width={stageSize}
              height={stageSize}
              alt={localPetName(installedPet, config.language)}
              animated={renderingActive}
              onError={() => setInstalledPet(null)}
            />
          ) : (
            <CliCat className="desktop-pet-cat" ariaLabel={moodLabel(config, displayMood)} />
          )}
          {snapshot.attentionCount > 0 ? (
            <span className="desktop-pet-badge" aria-label={moodLabel(config, "waiting")}>!</span>
          ) : null}
        </div>
      </div>

      {menuOpen && menuGeometry ? (
        <div
          className="desktop-pet-menu"
          data-has-targets={secondaryItemCount > 0 || undefined}
          role="menu"
          aria-label={
            targetMode === "platforms"
              ? config.labels.handoffPlatforms
              : targetMode === "handoff"
                ? config.labels.handoffSessions
                : config.labels.taskList
          }
        >
          {targetMode === "platforms" && handoffPlatforms.length > 0 ? (
            <div className="desktop-pet-target-list desktop-pet-platform-list">
              <div className="desktop-pet-secondary-header">
                <button
                  type="button"
                  role="menuitem"
                  aria-label={config.labels.handoffBack}
                  title={config.labels.handoffBack}
                  onClick={() => {
                    setTargetMode("open");
                    setSelectedPlatform(null);
                  }}
                >
                  <ArrowLeft size={14} aria-hidden="true" />
                </button>
                <strong>{config.labels.handoffPlatforms}</strong>
              </div>
              {handoffPlatforms.map((platform, index) => {
                const name = platformLabel(config, platform.platform);
                const status = platformStatusLabel(config, platform);
                return (
                  <button
                    key={platform.platform}
                    type="button"
                    role="menuitem"
                    className="desktop-pet-platform"
                    data-ready={platform.ready || undefined}
                    disabled={!platform.ready}
                    style={targetFanStyle(index, handoffPlatforms.length)}
                    onClick={() => selectHandoffPlatform(platform)}
                    title={[name, status].join(" · ")}
                  >
                    <PlatformIcon platform={platform.platform} />
                    <span className="desktop-pet-target-copy">
                      <strong>{name}</strong>
                      <small>{status}</small>
                    </span>
                    <span className="desktop-pet-platform-state" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          ) : menuTargets.length > 0 ? <div className="desktop-pet-target-list">
            {targetMode === "handoff" ? (
              <div className="desktop-pet-secondary-header">
                <button
                  type="button"
                  role="menuitem"
                  aria-label={config.labels.handoffBack}
                  title={config.labels.handoffBack}
                  onClick={() => {
                    setTargetMode("platforms");
                    setSelectedPlatform(null);
                  }}
                >
                  <ArrowLeft size={14} aria-hidden="true" />
                </button>
                <strong>
                  {selectedPlatform
                    ? platformLabel(config, selectedPlatform)
                    : config.labels.handoffSessions}
                </strong>
              </div>
            ) : null}
            {menuTargets.map((target, index) => {
              const identityLabels = distinctDisplayLabels(target.projectName, target.sessionTitle);
              const primary = identityLabels[0] || `${config.labels.unnamedTask} ${index + 1}`;
              const secondary = identityLabels[1] ?? null;
              const status = targetStatusLabel(config, target);
              return (
                <button
                  key={target.sessionId}
                  type="button"
                  role="menuitem"
                  className="desktop-pet-target"
                  data-status={target.status}
                  data-active={target.active || undefined}
                  data-handed-off={target.handedOff || undefined}
                  data-recovery-failed={
                    target.handoffPhase === "recovery_failed" || undefined
                  }
                  aria-current={target.active ? "true" : undefined}
                  style={targetFanStyle(index, menuTargets.length)}
                  onClick={() => (
                    targetMode === "handoff" ? requestHandoff(target) : openTarget(target)
                  )}
                  title={[...identityLabels, status].join(" · ")}
                >
                  {target.handoffPhase ? (
                    <LockKeyhole className="desktop-pet-target-lock" size={14} aria-hidden="true" />
                  ) : (
                    <span className="desktop-pet-target-indicator" aria-hidden="true" />
                  )}
                  <span className="desktop-pet-target-copy">
                    <strong>{primary}</strong>
                    <small>
                      {secondary ? `${secondary} · ` : ""}
                      {status}
                    </small>
                  </span>
                  {target.active ? (
                    <span className="desktop-pet-target-current">{config.labels.currentTask}</span>
                  ) : null}
                </button>
              );
            })}
          </div> : null}
          <div className="desktop-pet-menu-actions">
            <button
              type="button"
              role="menuitem"
              disabled={!snapshot.sessionId}
              onClick={() => openTarget()}
            >
              <MonitorUp size={14} aria-hidden="true" />
              <span>{config.labels.openCurrent}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-active={targetMode !== "open" || undefined}
              disabled={
                snapshot.handoffBusy
                || Boolean(snapshot.handoff)
                || !snapshot.targets.some((target) => target.handoffEligible)
                || handoffPlatforms.length === 0
              }
              onClick={() => {
                if (targetMode === "open") {
                  setSelectedPlatform(null);
                  setTargetMode("platforms");
                } else if (targetMode === "platforms") {
                  setSelectedPlatform(null);
                  setTargetMode("open");
                } else {
                  setSelectedPlatform(null);
                  setTargetMode("platforms");
                }
              }}
            >
              <RadioTower size={14} aria-hidden="true" />
              <span>{config.labels.remoteHandoff}</span>
            </button>
            {snapshot.handoff ? (
              <button
                type="button"
                role="menuitem"
                className="desktop-pet-menu-danger"
                disabled={snapshot.handoffBusy}
                onClick={cancelHandoff}
              >
                <PauseCircle size={14} aria-hidden="true" />
                <span>{config.labels.cancelHandoff}</span>
              </button>
            ) : null}
            <button type="button" role="menuitem" onClick={openMainWindow}>
              <AppWindow size={14} aria-hidden="true" />
              <span>{config.labels.openMain}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu();
                void emitTo("main", DESKTOP_PET_OPEN_SETTINGS_EVENT).catch((err) => {
                  logWarn("Failed to request desktop pet settings", err);
                });
              }}
            >
              <Settings size={14} aria-hidden="true" />
              <span>{config.labels.openSettings}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu();
                setConfig((current) => ({ ...current, visible: false }));
                void invoke("desktop_pet_window_hide").catch((err) => {
                  logWarn("Failed to hide desktop pet window", err);
                });
              }}
            >
              <EyeOff size={14} aria-hidden="true" />
              <span>{config.labels.hide}</span>
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
