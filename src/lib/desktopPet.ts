import type {
  Project,
  RemoteHandoffPhase,
  TerminalSession,
  WorktreeRecord,
} from "./types";
import {
  getRemoteHandoffEligibility,
  type CcConnectHandoffInfo,
  type CcConnectHandoffPlatformTarget,
} from "./remoteHandoff";
import type {
  SessionStatus,
  TabNotificationState,
  TabStatusDetails,
} from "../stores/terminalStore";
import type { DesktopPetSettings, LanguagePreference } from "../stores/settingsStore";

export const DESKTOP_PET_WINDOW_LABEL = "desktop-pet";
export const DESKTOP_PET_CONFIG_EVENT = "desktop-pet-config";
export const DESKTOP_PET_SNAPSHOT_EVENT = "desktop-pet-snapshot";
export const DESKTOP_PET_READY_EVENT = "desktop-pet-ready";
export const DESKTOP_PET_OPEN_TARGET_EVENT = "desktop-pet-open-target";
export const DESKTOP_PET_OPEN_SETTINGS_EVENT = "desktop-pet-open-settings";
export const DESKTOP_PET_CLOSE_MENU_EVENT = "desktop-pet-close-menu";
export const DESKTOP_PET_POSITION_EVENT = "desktop-pet-position";
export const DESKTOP_PET_HANDOFF_START_EVENT = "remote-handoff-start-request";
export const DESKTOP_PET_HANDOFF_CANCEL_EVENT = "remote-handoff-cancel-request";

export type DesktopPetMood = "idle" | "working" | "waiting" | "success" | "error" | "sleeping";

export interface PetLocalizedText {
  "zh-CN": string;
  "en-US": string;
}

export interface PetStateAsset {
  file: string;
  row?: number;
  frames?: number;
}

export interface PetManifest {
  schemaVersion: number;
  id: string;
  version: string;
  name: PetLocalizedText;
  description: PetLocalizedText;
  author: string;
  license: string;
  engine: "image-v1" | "codex-sprite";
  canvas: { width: number; height: number };
  states: Partial<Record<DesktopPetMood, PetStateAsset>> & { idle: PetStateAsset };
  spriteVersionNumber?: 1 | 2;
}

export interface PetCatalogEntry {
  id: string;
  version: string;
  name: PetLocalizedText;
  description: PetLocalizedText;
  author: string;
  license: string;
  minAppVersion: string;
  previewUrl: string;
  previewDataUrl?: string | null;
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
}

export interface PetCatalogResponse {
  items: PetCatalogEntry[];
  source: "remote" | "cache" | "bundled" | string;
  warning?: string | null;
}

export interface InstalledPet {
  manifest: PetManifest;
  baseDir: string;
  source: "cli-manager" | "codex";
  format: "clipet" | "codex";
  removable: boolean;
}

export interface BackgroundPetTask {
  sessionId: string;
  cwd?: string | null;
  alive: boolean;
  taskStatus?: TabNotificationState | null;
  taskUpdatedAtMs?: number | null;
  createdAtMs: number;
}

export interface DesktopPetTarget {
  sessionId: string;
  daemonOnly: boolean;
  sessionTitle: string | null;
  projectName: string | null;
  status: TabNotificationState;
  active: boolean;
  updatedAt: number;
  handoffEligible: boolean;
  handedOff: boolean;
  handoffPhase: RemoteHandoffPhase | null;
}

export interface DesktopPetSnapshot {
  mood: DesktopPetMood;
  sessionId: string | null;
  daemonOnly: boolean;
  sessionTitle: string | null;
  projectName: string | null;
  runningCount: number;
  attentionCount: number;
  updatedAt: number;
  targets: DesktopPetTarget[];
  handoff: CcConnectHandoffInfo | null;
  handoffPlatforms: CcConnectHandoffPlatformTarget[];
  handoffBusy: boolean;
}

export interface DesktopPetConfigPayload {
  language: "zh-CN" | "en-US";
  settings: DesktopPetSettings;
  labels: {
    openMain: string;
    openSettings: string;
    hide: string;
    idle: string;
    working: string;
    waiting: string;
    success: string;
    error: string;
    sleeping: string;
    runningCount: string;
    taskList: string;
    currentTask: string;
    unnamedTask: string;
    openCurrent: string;
    remoteHandoff: string;
    cancelHandoff: string;
    handoffPlatforms: string;
    handoffSessions: string;
    handoffBack: string;
    platformReady: string;
    platformNotRunning: string;
    platformCredentialsMissing: string;
    platformUserMissing: string;
    platformSessionMissing: string;
    platformUnavailable: string;
    platformTelegram: string;
    platformFeishu: string;
    platformWeixin: string;
    platformWecom: string;
    handoffPending: string;
    handoffCancelling: string;
    handedOff: string;
    handoffRecoveryFailed: string;
    noHandoffSessions: string;
  };
}

export interface DesktopPetPositionPayload {
  x: number;
  y: number;
}

export interface DesktopPetOpenTargetPayload {
  sessionId: string | null;
  daemonOnly: boolean;
}

export interface DesktopPetWindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopPetMenuWindowGeometry {
  logicalWidth: number;
  logicalHeight: number;
  x: number;
  y: number;
  anchorWidth: number;
  anchorHeight: number;
  panelWidth: number;
  targetListHeight: number;
}

const DESKTOP_PET_MENU_TARGET_EXTRA_WIDTH = 440;
const DESKTOP_PET_MENU_ACTIONS_EXTRA_WIDTH = 190;
const DESKTOP_PET_MENU_CARD_HEIGHT = 58;
const DESKTOP_PET_MENU_CARD_STEP = 54;
const DESKTOP_PET_MENU_CARD_BREATHING_ROOM = 12;
const DESKTOP_PET_MENU_MAX_VISIBLE_TARGETS = 5;
const DESKTOP_PET_MENU_VERTICAL_CHROME = 28;
export const DESKTOP_PET_OUTPUT_ACTIVITY_TTL_MS = 6000;
const DESKTOP_PET_OUTPUT_ACTIVITY_FINAL_GRACE_MS = 1200;

function clampWindowCoordinate(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function calculateDesktopPetMenuWindowGeometry(
  collapsed: DesktopPetWindowRect,
  scaleFactor: number,
  targetCount: number,
  workArea?: DesktopPetWindowRect | null,
  secondaryHeaderHeight = 0
): DesktopPetMenuWindowGeometry {
  const safeScaleFactor = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const anchorWidth = collapsed.width / safeScaleFactor;
  const anchorHeight = collapsed.height / safeScaleFactor;
  const visibleTargets = Math.min(
    Math.max(0, Math.floor(targetCount)),
    DESKTOP_PET_MENU_MAX_VISIBLE_TARGETS
  );
  const requestedTargetListHeight = visibleTargets > 0
    ? DESKTOP_PET_MENU_CARD_HEIGHT
      + (visibleTargets - 1) * DESKTOP_PET_MENU_CARD_STEP
      + DESKTOP_PET_MENU_CARD_BREATHING_ROOM
      + Math.max(0, secondaryHeaderHeight)
    : 0;
  const requestedPanelWidth = visibleTargets > 0
    ? DESKTOP_PET_MENU_TARGET_EXTRA_WIDTH
    : DESKTOP_PET_MENU_ACTIONS_EXTRA_WIDTH;
  let logicalWidth = anchorWidth + requestedPanelWidth;
  let logicalHeight = Math.max(
    anchorHeight,
    224,
    requestedTargetListHeight > 0
      ? requestedTargetListHeight + DESKTOP_PET_MENU_VERTICAL_CHROME
      : anchorHeight
  );
  if (workArea) {
    logicalWidth = Math.min(logicalWidth, workArea.width / safeScaleFactor);
    logicalHeight = Math.min(logicalHeight, workArea.height / safeScaleFactor);
  }
  const panelWidth = Math.max(0, logicalWidth - anchorWidth);
  const targetListHeight = Math.min(
    requestedTargetListHeight,
    Math.max(0, logicalHeight - DESKTOP_PET_MENU_VERTICAL_CHROME)
  );
  const physicalWidth = Math.round(logicalWidth * safeScaleFactor);
  const physicalHeight = Math.round(logicalHeight * safeScaleFactor);
  const desiredX = collapsed.x - Math.max(0, physicalWidth - collapsed.width);
  const desiredY = collapsed.y - Math.max(0, physicalHeight - collapsed.height);

  if (!workArea) {
    return {
      logicalWidth,
      logicalHeight,
      x: desiredX,
      y: desiredY,
      anchorWidth,
      anchorHeight,
      panelWidth,
      targetListHeight,
    };
  }

  return {
    logicalWidth,
    logicalHeight,
    x: clampWindowCoordinate(
      desiredX,
      workArea.x,
      workArea.x + workArea.width - physicalWidth
    ),
    y: clampWindowCoordinate(
      desiredY,
      workArea.y,
      workArea.y + workArea.height - physicalHeight
    ),
    anchorWidth,
    anchorHeight,
    panelWidth,
    targetListHeight,
  };
}

const STATUS_PRIORITY: Record<TabNotificationState, number> = {
  none: 0,
  done: 1,
  running: 2,
  failed: 3,
  attention: 4,
};

function moodFromStatus(status: TabNotificationState): DesktopPetMood {
  if (status === "running") return "working";
  if (status === "attention") return "waiting";
  if (status === "done") return "success";
  if (status === "failed") return "error";
  return "idle";
}

function timestampFromDetails(details: TabStatusDetails | undefined): number {
  if (!details?.updatedAt) return 0;
  const parsed = Date.parse(details.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function daemonTaskStatus(task: BackgroundPetTask): TabNotificationState {
  const explicitStatus = explicitDaemonTaskStatus(task);
  if (explicitStatus) return explicitStatus;
  return task.alive ? "running" : "done";
}

function daemonTaskUpdatedAt(task: BackgroundPetTask): number {
  if (explicitDaemonTaskStatus(task)) {
    return task.taskUpdatedAtMs ?? task.createdAtMs;
  }
  return task.alive ? 0 : task.createdAtMs;
}

function explicitDaemonTaskStatus(task: BackgroundPetTask | undefined): TabNotificationState | null {
  if (
    task?.taskStatus === "running" ||
    task?.taskStatus === "attention" ||
    task?.taskStatus === "done" ||
    task?.taskStatus === "failed"
  ) {
    return task.taskStatus;
  }
  return null;
}

function resolveOpenSessionStatus(
  sessionId: string,
  tabNotifications: Record<string, TabNotificationState>,
  tabStatusDetails: Record<string, TabStatusDetails>,
  daemonTask: BackgroundPetTask | undefined,
  outputActivityAt: number,
  now: number
): { status: TabNotificationState; updatedAt: number } {
  const frontendStatus = tabNotifications[sessionId] ?? "none";
  const frontendUpdatedAt = timestampFromDetails(tabStatusDetails[sessionId]);
  const daemonStatus = explicitDaemonTaskStatus(daemonTask);
  const daemonUpdatedAt = daemonTask?.taskUpdatedAtMs ?? daemonTask?.createdAtMs ?? 0;

  const resolved = daemonStatus && (frontendUpdatedAt === 0 || daemonUpdatedAt >= frontendUpdatedAt)
    ? { status: daemonStatus, updatedAt: daemonUpdatedAt }
    : { status: frontendStatus, updatedAt: frontendUpdatedAt };
  const recentOutput = outputActivityAt > 0
    && now >= outputActivityAt
    && now - outputActivityAt <= DESKTOP_PET_OUTPUT_ACTIVITY_TTL_MS;
  const activityCanOverride = resolved.status === "none"
    || ((resolved.status === "done" || resolved.status === "failed")
      && outputActivityAt >= resolved.updatedAt + DESKTOP_PET_OUTPUT_ACTIVITY_FINAL_GRACE_MS);
  if (recentOutput && activityCanOverride) {
    return { status: "running", updatedAt: outputActivityAt };
  }
  return resolved;
}

interface DeriveDesktopPetSnapshotInput {
  sessions: TerminalSession[];
  persistedSessions: TerminalSession[];
  activeSessionId: string | null;
  tabNotifications: Record<string, TabNotificationState>;
  sessionStatuses: Record<string, SessionStatus>;
  tabStatusDetails: Record<string, TabStatusDetails>;
  ptyOutputActivityAt: Record<string, number>;
  projects: Project[];
  worktrees: WorktreeRecord[];
  backgroundTasks: BackgroundPetTask[];
  activeHandoff: CcConnectHandoffInfo | null;
  handoffBusy: boolean;
}

function compareDesktopPetTargets(left: DesktopPetTarget, right: DesktopPetTarget): number {
  const priority = STATUS_PRIORITY[right.status] - STATUS_PRIORITY[left.status];
  if (priority !== 0) return priority;
  if (left.active !== right.active) return left.active ? -1 : 1;
  return right.updatedAt - left.updatedAt;
}

function snapshotFromTargets(
  targets: DesktopPetTarget[],
  now: number,
  handoff: CcConnectHandoffInfo | null,
  handoffBusy: boolean
): DesktopPetSnapshot {
  if (targets.length === 0) {
    return {
      mood: "sleeping",
      sessionId: null,
      daemonOnly: false,
      sessionTitle: null,
      projectName: null,
      runningCount: 0,
      attentionCount: 0,
      updatedAt: now,
      targets: [],
      handoff,
      handoffPlatforms: [],
      handoffBusy,
    };
  }

  const candidates = [...targets].sort(compareDesktopPetTargets);
  const selected = candidates[0];
  return {
    mood: moodFromStatus(selected.status),
    sessionId: selected.sessionId,
    daemonOnly: selected.daemonOnly,
    sessionTitle: selected.sessionTitle,
    projectName: selected.projectName,
    runningCount: candidates.filter((candidate) => candidate.status === "running").length,
    attentionCount: candidates.filter((candidate) => candidate.status === "attention").length,
    updatedAt: selected.updatedAt || now,
    targets: candidates,
    handoff,
    handoffPlatforms: [],
    handoffBusy,
  };
}

export function deriveDesktopPetSnapshot(input: DeriveDesktopPetSnapshotInput): DesktopPetSnapshot {
  const now = Date.now();
  const openPtySessions = input.sessions.filter((session) => !session.kind || session.kind === "pty");
  const openIds = new Set(openPtySessions.map((session) => session.id));
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  const worktreeById = new Map(input.worktrees.map((worktree) => [worktree.id, worktree]));
  const persistedById = new Map(input.persistedSessions.map((session) => [session.id, session]));
  const backgroundById = new Map(input.backgroundTasks.map((task) => [task.sessionId, task]));
  const candidates: DesktopPetTarget[] = openPtySessions.map((session) => {
    const { status, updatedAt } = resolveOpenSessionStatus(
      session.id,
      input.tabNotifications,
      input.tabStatusDetails,
      backgroundById.get(session.id),
      input.ptyOutputActivityAt[session.id] ?? 0,
      now
    );
    const project = session.projectId ? projectById.get(session.projectId) : undefined;
    const handoffPhase = session.remoteHandoff?.phase
      ?? (input.activeHandoff?.localSessionId === session.id ? "active" : null);
    const handedOff = handoffPhase !== null && handoffPhase !== "recovery_failed";
    const eligibility = getRemoteHandoffEligibility({
      session,
      project,
      worktree: session.worktreeId ? worktreeById.get(session.worktreeId) ?? null : null,
      notification: status,
      processStatus: input.sessionStatuses[session.id],
      activeHandoff: input.activeHandoff,
    });
    return {
      sessionId: session.id,
      daemonOnly: false,
      status,
      updatedAt,
      sessionTitle: session.title || null,
      projectName: project?.name ?? null,
      active: session.id === input.activeSessionId,
      handoffEligible: eligibility.eligible,
      handedOff,
      handoffPhase,
    };
  });
  for (const task of input.backgroundTasks) {
    if (openIds.has(task.sessionId)) continue;
    const persisted = persistedById.get(task.sessionId);
    const project = persisted?.projectId ? projectById.get(persisted.projectId) : undefined;
    candidates.push({
      sessionId: task.sessionId,
      daemonOnly: true,
      status: daemonTaskStatus(task),
      updatedAt: daemonTaskUpdatedAt(task),
      sessionTitle: persisted?.title || task.cwd || null,
      projectName: project?.name ?? null,
      active: false,
      handoffEligible: false,
      handedOff: false,
      handoffPhase: null,
    });
  }
  if (
    input.activeHandoff
    && !candidates.some((candidate) => candidate.sessionId === input.activeHandoff?.localSessionId)
  ) {
    candidates.push({
      sessionId: input.activeHandoff.localSessionId,
      daemonOnly: false,
      status: "none",
      updatedAt: input.activeHandoff.startedAtMs,
      sessionTitle: null,
      projectName: input.activeHandoff.projectName,
      active: false,
      handoffEligible: false,
      handedOff: true,
      handoffPhase: "active",
    });
  }

  return snapshotFromTargets(candidates, now, input.activeHandoff, input.handoffBusy);
}

export function desktopPetScale(size: DesktopPetSettings["size"]): number {
  if (size === "small") return 0.8;
  if (size === "large") return 1.25;
  return 1;
}

export function localizedPetText(text: PetLocalizedText, language: LanguagePreference): string {
  return language === "en-US" ? text["en-US"] : text["zh-CN"];
}

export function joinPetAssetPath(baseDir: string, relativePath: string): string {
  const separator = baseDir.includes("\\") ? "\\" : "/";
  return `${baseDir.replace(/[\\/]$/, "")}${separator}${relativePath.replace(/^[\\/]/, "")}`;
}
