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
  Maximize2,
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
  DESKTOP_PET_SIZE_CHANGE_EVENT,
  DESKTOP_PET_SNAPSHOT_EVENT,
  DESKTOP_PET_SIZE_MAX_PERCENT,
  DESKTOP_PET_SIZE_MIN_PERCENT,
  DESKTOP_PET_SIZE_STEP_PERCENT,
  DESKTOP_PET_MENU_MAX_VISIBLE_PLATFORMS,
  DESKTOP_PET_MENU_MAX_VISIBLE_TARGETS,
  calculateDesktopPetMenuWindowGeometry,
  createLatestAsyncTaskRunner,
  desktopPetScale,
  normalizeDesktopPetSizePercent,
  resizeDesktopPetCollapsedWindowBounds,
  stepDesktopPetSizePercent,
  type DesktopPetConfigPayload,
  type DesktopPetMenuWindowGeometry,
  type DesktopPetMood,
  type DesktopPetWindowRect,
  type LatestAsyncTaskRunner,
  type DesktopPetSnapshot,
  type DesktopPetTarget,
  type InstalledPet,
  localizedPetText,
} from "../lib/desktopPet";
import { convertChineseForLanguage, getCurrentLanguage, translate } from "../lib/i18n";
import { logWarn } from "../lib/logger";
import type {
  CcConnectHandoffPlatformTarget,
  CcConnectPlatform,
} from "../lib/remoteHandoff";
import { BUILTIN_DESKTOP_PET_ID } from "../stores/settingsStore";
import "./desktopPet.css";

function buildDesktopPetLabels(language: DesktopPetConfigPayload["language"]): DesktopPetConfigPayload["labels"] {
  return {
    openMain: translate(language, "desktopPet.actions.openMain"),
    openSettings: translate(language, "desktopPet.actions.openSettings"),
    size: translate(language, "desktopPet.settings.size"),
    hide: translate(language, "desktopPet.actions.hide"),
    idle: translate(language, "desktopPet.mood.idle"),
    working: translate(language, "desktopPet.mood.working"),
    waiting: translate(language, "desktopPet.mood.waiting"),
    success: translate(language, "desktopPet.mood.success"),
    error: translate(language, "desktopPet.mood.error"),
    sleeping: translate(language, "desktopPet.mood.sleeping"),
    runningCount: translate(language, "desktopPet.mood.runningCount"),
    taskList: translate(language, "desktopPet.actions.taskList"),
    currentTask: translate(language, "desktopPet.actions.currentTask"),
    unnamedTask: translate(language, "desktopPet.actions.unnamedTask"),
    openCurrent: translate(language, "desktopPet.actions.openCurrent"),
    remoteHandoff: translate(language, "desktopPet.actions.remoteHandoff"),
    cancelHandoff: translate(language, "desktopPet.actions.cancelHandoff"),
    handoffPlatforms: translate(language, "desktopPet.actions.handoffPlatforms"),
    handoffSessions: translate(language, "desktopPet.actions.handoffSessions"),
    handoffBack: translate(language, "desktopPet.actions.handoffBack"),
    platformReady: translate(language, "desktopPet.actions.platformReady"),
    platformNotRunning: translate(language, "desktopPet.actions.platformNotRunning"),
    platformCredentialsMissing: translate(
      language,
      "desktopPet.actions.platformCredentialsMissing"
    ),
    platformUserMissing: translate(language, "desktopPet.actions.platformUserMissing"),
    platformSessionMissing: translate(language, "desktopPet.actions.platformSessionMissing"),
    platformUnavailable: translate(language, "desktopPet.actions.platformUnavailable"),
    platformTelegram: translate(language, "settings.ccConnect.platformTelegram"),
    platformFeishu: translate(language, "settings.ccConnect.platformFeishu"),
    platformWeixin: translate(language, "settings.ccConnect.platformWeixin"),
    platformWecom: translate(language, "settings.ccConnect.platformWecom"),
    handoffPending: translate(language, "remoteHandoff.overlay.pending"),
    handoffCancelling: translate(language, "remoteHandoff.overlay.cancelling"),
    handedOff: translate(language, "desktopPet.actions.handedOff"),
    handoffRecoveryFailed: translate(language, "desktopPet.actions.handoffRecoveryFailed"),
    noHandoffSessions: translate(language, "desktopPet.actions.noHandoffSessions"),
  };
}

const DEFAULT_LANGUAGE = getCurrentLanguage();

const DEFAULT_CONFIG: DesktopPetConfigPayload = {
  language: DEFAULT_LANGUAGE,
  visible: false,
  settings: {
    enabled: true,
    petId: BUILTIN_DESKTOP_PET_ID,
    alwaysOnTop: true,
    size: 100,
    showActionMenu: true,
    openOnHover: true,
    workingBounceEnabled: false,
    workingBounceDistancePx: 5,
    showStatus: true,
    showSessionName: false,
    autoHideFullscreen: true,
    lockPosition: false,
    position: null,
  },
  labels: buildDesktopPetLabels(DEFAULT_LANGUAGE),
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

function moodLabel(labels: DesktopPetConfigPayload["labels"], mood: DesktopPetMood): string {
  return labels[mood];
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

function targetStatusLabel(
  labels: DesktopPetConfigPayload["labels"],
  target: DesktopPetTarget
): string {
  if (target.handoffPhase === "pending") return labels.handoffPending;
  if (target.handoffPhase === "cancelling") return labels.handoffCancelling;
  if (target.handoffPhase === "recovery_failed") {
    return labels.handoffRecoveryFailed;
  }
  if (target.handedOff) return labels.handedOff;
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
  return moodLabel(labels, mood);
}

function platformLabel(
  labels: DesktopPetConfigPayload["labels"],
  platform: CcConnectPlatform
): string {
  return {
    telegram: labels.platformTelegram,
    feishu: labels.platformFeishu,
    weixin: labels.platformWeixin,
    wecom: labels.platformWecom,
  }[platform];
}

function platformStatusLabel(
  labels: DesktopPetConfigPayload["labels"],
  target: CcConnectHandoffPlatformTarget
): string {
  if (target.ready) return labels.platformReady;
  if (target.unavailableReason === "cc_connect_not_running") {
    return labels.platformNotRunning;
  }
  if (target.unavailableReason === "handoff_credentials_missing") {
    return labels.platformCredentialsMissing;
  }
  if (target.unavailableReason === "handoff_platform_user_missing") {
    return labels.platformUserMissing;
  }
  if (target.unavailableReason === "handoff_platform_session_missing") {
    return labels.platformSessionMissing;
  }
  return labels.platformUnavailable;
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
  petScale: number;
  workArea: DesktopPetWindowRect | null;
}

interface DesktopPetMenuWindowRequest {
  open: boolean;
  petScale: number;
  secondaryItemCount: number;
  secondaryHeaderHeight: number;
  showActionMenu: boolean;
  maxVisibleItems: number;
}

const DESKTOP_PET_HOVER_OPEN_DELAY_MS = 200;
const DESKTOP_PET_HOVER_CLOSE_DELAY_MS = 350;
const DESKTOP_PET_SIZE_WHEEL_COMMIT_DELAY_MS = 250;
const DESKTOP_PET_SIZE_ADJUSTMENT_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

function setDesktopPetWindowBounds(bounds: DesktopPetWindowRect): Promise<void> {
  return invoke("desktop_pet_window_set_bounds", { bounds });
}

function targetFanStyle(index: number, count: number, maxVisibleItems: number): CSSProperties {
  const visibleCount = Math.min(Math.max(count, 1), Math.max(1, maxVisibleItems));
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
  const [previewSize, setPreviewSize] = useState<number | null>(null);
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
  const maxVisibleSecondaryItems = targetMode === "platforms"
    ? DESKTOP_PET_MENU_MAX_VISIBLE_PLATFORMS
    : DESKTOP_PET_MENU_MAX_VISIBLE_TARGETS;
  const secondaryListScrollable = secondaryItemCount > maxVisibleSecondaryItems;
  const canOpenMenu = config.settings.showActionMenu || snapshot.targets.length > 0;
  const effectiveSize = previewSize ?? config.settings.size;
  const petScale = desktopPetScale(config.settings.size);
  const moveTimerRef = useRef<number | null>(null);
  const dragResetTimerRef = useRef<number | null>(null);
  const userDraggingRef = useRef(false);
  const lockPositionRef = useRef(config.settings.lockPosition);
  const menuOpenRef = useRef(menuOpen);
  const previewSizeRef = useRef<number | null>(previewSize);
  const sizeAdjustingRef = useRef(false);
  const sizeWheelCommitTimerRef = useRef<number | null>(null);
  const sizeControlRef = useRef<HTMLDivElement | null>(null);
  const sizeWheelHandlerRef = useRef<(event: WheelEvent) => void>(() => {});
  const closeAfterSizeAdjustmentRef = useRef(false);
  const hoverOpenTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const hoverSuppressedUntilLeaveRef = useRef(false);
  const expectedProgrammaticPositionRef = useRef<{ x: number; y: number } | null>(null);
  const pendingDragAfterMenuCloseRef = useRef(false);
  const closeMenuRef = useRef<(suppressHover?: boolean) => void>(() => {});
  const collapsedWindowGeometryRef = useRef<CollapsedPetWindowGeometry | null>(null);
  const menuWindowTaskRef = useRef<LatestAsyncTaskRunner<DesktopPetMenuWindowRequest> | null>(null);
  menuOpenRef.current = menuOpen;
  previewSizeRef.current = previewSize;
  lockPositionRef.current = config.settings.lockPosition;

  const stopUserDragTracking = () => {
    userDraggingRef.current = false;
    if (dragResetTimerRef.current !== null) {
      window.clearTimeout(dragResetTimerRef.current);
      dragResetTimerRef.current = null;
    }
  };

  const startNativeDragging = () => {
    if (lockPositionRef.current) return;
    expectedProgrammaticPositionRef.current = null;
    if (moveTimerRef.current !== null) {
      window.clearTimeout(moveTimerRef.current);
      moveTimerRef.current = null;
    }
    stopUserDragTracking();
    userDraggingRef.current = true;
    dragResetTimerRef.current = window.setTimeout(() => {
      userDraggingRef.current = false;
      dragResetTimerRef.current = null;
    }, 5000);
    void getCurrentWindow().startDragging().catch(() => {
      stopUserDragTracking();
    });
  };

  const setManagedDesktopPetWindowBounds = (bounds: DesktopPetWindowRect) => {
    // SetWindowPos emits onMoved too; never persist menu geometry as a user drag.
    stopUserDragTracking();
    expectedProgrammaticPositionRef.current = { x: bounds.x, y: bounds.y };
    return setDesktopPetWindowBounds(bounds);
  };

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
                petScale: request.petScale,
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
              request.secondaryHeaderHeight,
              {
                showActionMenu: request.showActionMenu,
                maxVisibleItems: request.maxVisibleItems,
              }
            );
            if (!context.isLatest()) return;

            setMenuGeometry(geometry);
            await setManagedDesktopPetWindowBounds({
              x: geometry.x,
              y: geometry.y,
              width: geometry.physicalWidth,
              height: geometry.physicalHeight,
            });
          } catch (error) {
            if (context.isLatest()) {
              if (collapsed) {
                await setManagedDesktopPetWindowBounds(collapsed.bounds).catch(() => {});
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

        await setManagedDesktopPetWindowBounds(collapsed.bounds);
        if (!context.isLatest()) return;
        collapsedWindowGeometryRef.current = null;
        setMenuGeometry(null);
        if (pendingDragAfterMenuCloseRef.current) {
          pendingDragAfterMenuCloseRef.current = false;
          startNativeDragging();
        }
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
      if (!disposed) {
        setConfig(event.payload);
        if (!sizeAdjustingRef.current) {
          previewSizeRef.current = null;
          setPreviewSize(null);
        }
      }
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
        closeMenuRef.current(true);
      }
    });
    const appWindow = getCurrentWindow();
    const unlistenMoved = appWindow.onMoved(({ payload }) => {
      const expected = expectedProgrammaticPositionRef.current;
      if (
        expected
        && Math.abs(payload.x - expected.x) <= 1
        && Math.abs(payload.y - expected.y) <= 1
      ) {
        expectedProgrammaticPositionRef.current = null;
        return;
      }
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
      if (hoverOpenTimerRef.current !== null) window.clearTimeout(hoverOpenTimerRef.current);
      if (hoverCloseTimerRef.current !== null) window.clearTimeout(hoverCloseTimerRef.current);
      if (sizeWheelCommitTimerRef.current !== null) {
        window.clearTimeout(sizeWheelCommitTimerRef.current);
      }
      menuWindowTaskRef.current?.dispose();
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
      petScale,
      secondaryItemCount,
      secondaryHeaderHeight,
      showActionMenu: config.settings.showActionMenu,
      maxVisibleItems: maxVisibleSecondaryItems,
    });
  }, [
    config.settings.showActionMenu,
    maxVisibleSecondaryItems,
    menuOpen,
    petScale,
    secondaryHeaderHeight,
    secondaryItemCount,
  ]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenuRef.current(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!config.settings.enabled) {
      closeMenuRef.current(true);
    }
  }, [config.settings.enabled]);

  useEffect(() => {
    if (config.settings.openOnHover || hoverOpenTimerRef.current === null) return;
    window.clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = null;
  }, [config.settings.openOnHover]);

  useEffect(() => {
    if (config.settings.showActionMenu) return;
    if (targetMode !== "open") {
      setTargetMode("open");
      setSelectedPlatform(null);
    }
    if (snapshot.targets.length === 0) {
      if (hoverOpenTimerRef.current !== null) {
        window.clearTimeout(hoverOpenTimerRef.current);
        hoverOpenTimerRef.current = null;
      }
      if (menuOpen) closeMenuRef.current(true);
    }
  }, [config.settings.showActionMenu, menuOpen, snapshot.targets.length, targetMode]);

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

  const labels = useMemo(() => buildDesktopPetLabels(config.language), [config.language]);
  const localizeDisplayText = (text: string | null | undefined): string =>
    text ? convertChineseForLanguage(config.language, text) : "";
  const detail = config.settings.showSessionName
    ? distinctDisplayLabels(
        localizeDisplayText(snapshot.projectName),
        localizeDisplayText(snapshot.sessionTitle)
      ).join(" · ")
    : "";
  const runningDetail = snapshot.runningCount > 1
    ? `${snapshot.runningCount} ${labels.runningCount}`
    : "";
  const stageSize = Math.round(144 * petScale);
  const renderingActive = config.visible && documentVisible;
  const rootStyle = {
    "--pet-scale": petScale,
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

  const clearHoverOpenTimer = () => {
    if (hoverOpenTimerRef.current === null) return;
    window.clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = null;
  };

  const clearHoverCloseTimer = () => {
    if (hoverCloseTimerRef.current === null) return;
    window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = null;
  };

  const clearSizeWheelCommitTimer = () => {
    if (sizeWheelCommitTimerRef.current === null) return;
    window.clearTimeout(sizeWheelCommitTimerRef.current);
    sizeWheelCommitTimerRef.current = null;
  };

  const beginSizeAdjustment = () => {
    sizeAdjustingRef.current = true;
    closeAfterSizeAdjustmentRef.current = false;
    clearHoverCloseTimer();
  };

  const commitSizePreview = () => {
    clearSizeWheelCommitTimer();
    const size = previewSizeRef.current;
    const shouldCloseAfterAdjustment = closeAfterSizeAdjustmentRef.current;
    sizeAdjustingRef.current = false;
    closeAfterSizeAdjustmentRef.current = false;
    if (size !== null) {
      let collapsed = collapsedWindowGeometryRef.current;
      const nextScale = desktopPetScale(size);
      if (collapsed && collapsed.petScale !== nextScale) {
        collapsed = {
          ...collapsed,
          bounds: resizeDesktopPetCollapsedWindowBounds(
            collapsed.bounds,
            collapsed.scaleFactor,
            nextScale,
            collapsed.workArea
          ),
          petScale: nextScale,
        };
        collapsedWindowGeometryRef.current = collapsed;
      }
      previewSizeRef.current = null;
      setPreviewSize(null);
      setConfig((current) => ({
        ...current,
        settings: { ...current.settings, size },
      }));
      if (collapsed) {
        void emitTo("main", DESKTOP_PET_SIZE_CHANGE_EVENT, {
          size,
          x: collapsed.bounds.x,
          y: collapsed.bounds.y,
        }).catch((err) => logWarn("Failed to persist desktop pet size", err));
      }
    }
    if (shouldCloseAfterAdjustment && menuOpenRef.current) {
      clearHoverCloseTimer();
      hoverCloseTimerRef.current = window.setTimeout(() => {
        hoverCloseTimerRef.current = null;
        closeMenuRef.current(false);
      }, DESKTOP_PET_HOVER_CLOSE_DELAY_MS);
    }
  };

  const closeMenu = (suppressHover = true) => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    closeAfterSizeAdjustmentRef.current = false;
    commitSizePreview();
    if (suppressHover) hoverSuppressedUntilLeaveRef.current = true;
    setMenuOpen(false);
    setTargetMode("open");
    setSelectedPlatform(null);
  };
  closeMenuRef.current = closeMenu;

  const scheduleHoverOpen = () => {
    clearHoverCloseTimer();
    if (
      !config.settings.openOnHover
      || !canOpenMenu
      || hoverSuppressedUntilLeaveRef.current
      || menuOpenRef.current
      || userDraggingRef.current
      || sizeAdjustingRef.current
    ) {
      return;
    }
    clearHoverOpenTimer();
    hoverOpenTimerRef.current = window.setTimeout(() => {
      hoverOpenTimerRef.current = null;
      if (
        !config.settings.openOnHover
        || !canOpenMenu
        || hoverSuppressedUntilLeaveRef.current
        || menuOpenRef.current
        || userDraggingRef.current
        || sizeAdjustingRef.current
      ) {
        return;
      }
      setTargetMode("open");
      setSelectedPlatform(null);
      setMenuOpen(true);
    }, DESKTOP_PET_HOVER_OPEN_DELAY_MS);
  };

  const scheduleHoverClose = () => {
    hoverSuppressedUntilLeaveRef.current = false;
    clearHoverOpenTimer();
    if (sizeAdjustingRef.current) {
      closeAfterSizeAdjustmentRef.current = true;
      return;
    }
    if (!menuOpenRef.current) return;
    clearHoverCloseTimer();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      closeMenuRef.current(false);
    }, DESKTOP_PET_HOVER_CLOSE_DELAY_MS);
  };

  const handleSizePreview = (value: number): boolean => {
    const currentSize = previewSizeRef.current ?? config.settings.size;
    const size = normalizeDesktopPetSizePercent(value, currentSize);
    if (size === currentSize) return false;
    previewSizeRef.current = size;
    setPreviewSize(size);
    return true;
  };

  const scheduleSizeWheelCommit = () => {
    clearSizeWheelCommitTimer();
    sizeWheelCommitTimerRef.current = window.setTimeout(() => {
      sizeWheelCommitTimerRef.current = null;
      commitSizePreview();
    }, DESKTOP_PET_SIZE_WHEEL_COMMIT_DELAY_MS);
  };

  const handleSizeWheel = (event: WheelEvent) => {
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const currentSize = previewSizeRef.current ?? config.settings.size;
    const size = stepDesktopPetSizePercent(currentSize, event.deltaY < 0 ? 1 : -1);
    if (size === currentSize && previewSizeRef.current === null) return;
    beginSizeAdjustment();
    handleSizePreview(size);
    scheduleSizeWheelCommit();
  };
  sizeWheelHandlerRef.current = handleSizeWheel;

  useEffect(() => {
    const sizeControl = sizeControlRef.current;
    if (!sizeControl || !menuGeometry) return;
    const handleWheel = (event: WheelEvent) => sizeWheelHandlerRef.current(event);
    sizeControl.addEventListener("wheel", handleWheel, { passive: false });
    return () => sizeControl.removeEventListener("wheel", handleWheel);
  }, [menuGeometry]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || config.settings.lockPosition) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, [data-pet-interactive]")) return;
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    if (menuOpen) {
      pendingDragAfterMenuCloseRef.current = true;
      closeMenu(true);
      return;
    }
    startNativeDragging();
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
      data-show-action-menu={config.settings.showActionMenu ? "true" : "false"}
      data-rendering-active={renderingActive ? "true" : "false"}
      style={rootStyle}
      onPointerEnter={clearHoverCloseTimer}
      onPointerLeave={scheduleHoverClose}
      onPointerDown={handlePointerDown}
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("button, input, [data-pet-interactive]")) return;
        clearHoverOpenTimer();
        openTarget();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        clearHoverOpenTimer();
        clearHoverCloseTimer();
        if (menuOpen) {
          closeMenu(true);
        } else if (canOpenMenu) {
          hoverSuppressedUntilLeaveRef.current = false;
          setTargetMode("open");
          setSelectedPlatform(null);
          setMenuOpen(true);
        }
      }}
      aria-label={moodLabel(labels, displayMood)}
    >
      <div className="desktop-pet-anchor">
        {config.settings.showStatus ? (
          <section className="desktop-pet-status" aria-live="polite">
            <strong>{moodLabel(labels, displayMood)}</strong>
            {detail ? <span title={detail}>{detail}</span> : null}
            {runningDetail ? <small>{runningDetail}</small> : null}
          </section>
        ) : null}

        <div
          className="desktop-pet-stage"
          title={moodLabel(labels, displayMood)}
          onPointerEnter={scheduleHoverOpen}
          onPointerLeave={() => {
            if (!menuOpenRef.current) clearHoverOpenTimer();
          }}
        >
          {installedPet ? (
            <PetArtwork
              pet={installedPet}
              mood={displayMood}
              width={stageSize}
              height={stageSize}
              alt={localizedPetText(installedPet.manifest.name, config.language)}
              animated={renderingActive}
              onError={() => setInstalledPet(null)}
            />
          ) : (
            <CliCat className="desktop-pet-cat" ariaLabel={moodLabel(labels, displayMood)} />
          )}
          {snapshot.attentionCount > 0 ? (
            <span className="desktop-pet-badge" aria-label={moodLabel(labels, "waiting")}>!</span>
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
              ? labels.handoffPlatforms
              : targetMode === "handoff"
                ? labels.handoffSessions
                : labels.taskList
          }
        >
          {targetMode === "platforms" && handoffPlatforms.length > 0 ? (
            <div
              className="desktop-pet-target-list desktop-pet-platform-list"
              data-scrollable={secondaryListScrollable || undefined}
            >
              <div className="desktop-pet-secondary-header">
                <button
                  type="button"
                  role="menuitem"
                  aria-label={labels.handoffBack}
                  title={labels.handoffBack}
                  onClick={() => {
                    setTargetMode("open");
                    setSelectedPlatform(null);
                  }}
                >
                  <ArrowLeft size={14} aria-hidden="true" />
                </button>
                <strong>{labels.handoffPlatforms}</strong>
              </div>
              {handoffPlatforms.map((platform, index) => {
                const name = platformLabel(labels, platform.platform);
                const status = platformStatusLabel(labels, platform);
                return (
                  <button
                    key={platform.platform}
                    type="button"
                    role="menuitem"
                    className="desktop-pet-platform"
                    data-ready={platform.ready || undefined}
                    disabled={!platform.ready}
                    style={targetFanStyle(
                      index,
                      handoffPlatforms.length,
                      DESKTOP_PET_MENU_MAX_VISIBLE_PLATFORMS
                    )}
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
          ) : menuTargets.length > 0 ? (
            <div
              className="desktop-pet-target-list"
              data-scrollable={secondaryListScrollable || undefined}
            >
            {targetMode === "handoff" ? (
              <div className="desktop-pet-secondary-header">
                <button
                  type="button"
                  role="menuitem"
                  aria-label={labels.handoffBack}
                  title={labels.handoffBack}
                  onClick={() => {
                    setTargetMode("platforms");
                    setSelectedPlatform(null);
                  }}
                >
                  <ArrowLeft size={14} aria-hidden="true" />
                </button>
                <strong>
                  {selectedPlatform
                    ? platformLabel(labels, selectedPlatform)
                    : labels.handoffSessions}
                </strong>
              </div>
            ) : null}
            {menuTargets.map((target, index) => {
              const identityLabels = distinctDisplayLabels(
                localizeDisplayText(target.projectName),
                localizeDisplayText(target.sessionTitle)
              );
              const primary = identityLabels[0] || `${labels.unnamedTask} ${index + 1}`;
              const secondary = identityLabels[1] ?? null;
              const status = targetStatusLabel(labels, target);
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
                  style={targetFanStyle(
                    index,
                    menuTargets.length,
                    DESKTOP_PET_MENU_MAX_VISIBLE_TARGETS
                  )}
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
                    <span className="desktop-pet-target-current">{labels.currentTask}</span>
                  ) : null}
                </button>
              );
            })}
            </div>
          ) : null}
          {config.settings.showActionMenu ? (
          <div className="desktop-pet-menu-actions">
            <button
              type="button"
              role="menuitem"
              disabled={!snapshot.sessionId}
              onClick={() => openTarget()}
            >
              <MonitorUp size={14} aria-hidden="true" />
              <span>{labels.openCurrent}</span>
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
              <span>{labels.remoteHandoff}</span>
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
                <span>{labels.cancelHandoff}</span>
              </button>
            ) : null}
            <button type="button" role="menuitem" onClick={openMainWindow}>
              <AppWindow size={14} aria-hidden="true" />
              <span>{labels.openMain}</span>
            </button>
            <div
              ref={sizeControlRef}
              className="desktop-pet-size-control"
              role="group"
              aria-label={labels.size}
              data-pet-interactive
              onPointerEnter={clearHoverCloseTimer}
            >
              <div className="desktop-pet-size-control-header">
                <Maximize2 size={13} aria-hidden="true" />
                <span>{labels.size}</span>
                <output>{effectiveSize}%</output>
              </div>
              <input
                type="range"
                min={DESKTOP_PET_SIZE_MIN_PERCENT}
                max={DESKTOP_PET_SIZE_MAX_PERCENT}
                step={DESKTOP_PET_SIZE_STEP_PERCENT}
                value={effectiveSize}
                aria-label={labels.size}
                aria-valuetext={`${effectiveSize}%`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  clearSizeWheelCommitTimer();
                  beginSizeAdjustment();
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerUp={(event) => {
                  event.stopPropagation();
                  commitSizePreview();
                }}
                onPointerCancel={commitSizePreview}
                onLostPointerCapture={commitSizePreview}
                onChange={(event) => handleSizePreview(Number(event.currentTarget.value))}
                onKeyDown={(event) => {
                  if (DESKTOP_PET_SIZE_ADJUSTMENT_KEYS.has(event.key)) {
                    clearSizeWheelCommitTimer();
                    beginSizeAdjustment();
                  }
                }}
                onKeyUp={commitSizePreview}
                onBlur={commitSizePreview}
              />
            </div>
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
              <span>{labels.openSettings}</span>
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
              <span>{labels.hide}</span>
            </button>
          </div>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
