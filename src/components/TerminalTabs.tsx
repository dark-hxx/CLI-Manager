import { useEffect, useState, useRef, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTerminalStore, type SessionStatus } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import { SplitTerminalView } from "./SplitTerminalView";
import { CommandTemplatePanel } from "./CommandTemplatePanel";
import { CommandHistoryPanel } from "./CommandHistoryPanel";
import { openWindowsTerminal } from "../lib/externalTerminal";
import { Terminal, Plus } from "lucide-react";
import { EmptyState } from "./ui/EmptyState";

const STATUS_COLORS: Record<SessionStatus, string> = {
  running: "#9ece6a",
  exited: "#ff9e64",
  error: "#f7768e",
};

interface SortableTabProps {
  id: string;
  title: string;
  isActive: boolean;
  status: SessionStatus;
  onActivate: () => void;
  onClose: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}

function SortableTab({ id, title, isActive, status, onActivate, onClose, onContextMenu }: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    borderColor: "var(--border)",
    backgroundColor: isActive ? "var(--bg-primary)" : "transparent",
    color: isActive ? "var(--text-primary)" : "var(--text-muted)",
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 px-3 h-full text-[11px] font-medium cursor-pointer border-r shrink-0"
      onClick={onActivate}
      onContextMenu={onContextMenu}
      {...attributes}
      {...listeners}
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: STATUS_COLORS[status] }}
        role="status"
        aria-label={`Terminal ${status}`}
        title={status}
      />
      <span className="truncate max-w-[140px] tracking-wide">{title}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        onPointerDown={(e) => e.stopPropagation()}
        className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded border opacity-60 hover:opacity-100 transition-opacity"
        style={{ color: "var(--text-muted)", borderColor: "var(--border)" }}
      >
        &times;
      </button>
    </div>
  );
}

export function TerminalTabs() {
  const { sessions, activeSessionId, sessionStatuses, splits, setActive, closeSession, createSession, reorderSessions, splitTerminal, unsplitTerminal } = useTerminalStore();
  const projects = useProjectStore((s) => s.projects);
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const [contextMenu, setContextMenu] = useState<null | { sessionId: string; x: number; y: number }>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      reorderSessions(active.id as string, over.id as string);
    }
  }, [reorderSessions]);

  const handleNewTab = async () => {
    if (useExternalTerminal) {
      await openWindowsTerminal([{ title: "Terminal" }]);
      return;
    }
    await createSession(undefined, undefined, "Terminal");
  };

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: Event) => {
      if (contextMenuRef.current && contextMenuRef.current.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    window.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
      window.removeEventListener("keydown", keyHandler);
    };
  }, [contextMenu]);

  const handleContextMenu = (e: ReactMouseEvent, sessionId: string) => {
    e.preventDefault();
    setActive(sessionId);
    setContextMenu({ sessionId, x: e.clientX, y: e.clientY });
  };

  const handleCloseOthers = (sessionId: string) => {
    sessions.filter((s) => s.id !== sessionId).forEach((s) => closeSession(s.id));
  };

  const menuX = contextMenu ? Math.min(contextMenu.x, window.innerWidth - 180) : 0;
  const menuY = contextMenu ? Math.min(contextMenu.y, window.innerHeight - 200) : 0;

  const sessionIds = sessions.map((s) => s.id);

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div
        className="flex items-center h-9 border-b"
        style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--border)" }}
      >
        {/* Scrollable tabs area */}
        <div className="flex-1 flex items-center h-full overflow-x-auto min-w-0">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sessionIds} strategy={horizontalListSortingStrategy}>
              {sessions.map((s) => (
                <SortableTab
                  key={s.id}
                  id={s.id}
                  title={s.title}
                  isActive={s.id === activeSessionId}
                  status={sessionStatuses[s.id] ?? "running"}
                  onActivate={() => setActive(s.id)}
                  onClose={() => closeSession(s.id)}
                  onContextMenu={(e) => handleContextMenu(e, s.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
        {/* Action buttons — outside scroll container so dropdowns are not clipped */}
        <div className="flex items-center shrink-0 px-2 gap-2">
          <button
            onClick={handleNewTab}
            className="flex items-center gap-1.5 px-2.5 h-6 rounded-md text-xs border hover:opacity-100 transition-opacity"
            style={{ color: "var(--text-muted)", borderColor: "var(--border)", backgroundColor: "var(--bg-tertiary)", opacity: 0.9 }}
            title="New terminal"
          >
            <Plus size={12} strokeWidth={2} />
            <Terminal size={14} strokeWidth={1.5} />
            <span>New</span>
          </button>
          <CommandTemplatePanel />
          <CommandHistoryPanel />
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div className="context-menu" style={{ left: menuX, top: menuY }} ref={contextMenuRef} role="menu">
          <button
            className="context-menu-item" role="menuitem"
            onClick={() => { closeSession(contextMenu.sessionId); setContextMenu(null); }}
          >
            关闭终端
          </button>
          <button
            className="context-menu-item" role="menuitem"
            onClick={() => { handleCloseOthers(contextMenu.sessionId); setContextMenu(null); }}
          >
            关闭其它终端
          </button>
          <button
            className="context-menu-item" role="menuitem"
            onClick={() => { handleNewTab(); setContextMenu(null); }}
          >
            新建终端
          </button>
          <div className="my-1 border-t" style={{ borderColor: "var(--border)" }} />
          {splits[contextMenu.sessionId] ? (
            <button
              className="context-menu-item" role="menuitem"
              onClick={() => { unsplitTerminal(contextMenu.sessionId); setContextMenu(null); }}
            >
              取消分屏
            </button>
          ) : (
            <>
              <button
                className="context-menu-item" role="menuitem"
                onClick={() => {
                  const session = sessions.find((s) => s.id === contextMenu.sessionId);
                  const project = session?.projectId ? projects.find((p) => p.id === session.projectId) : undefined;
                  splitTerminal(contextMenu.sessionId, "horizontal", project?.path, project?.shell);
                  setContextMenu(null);
                }}
              >
                水平分屏
              </button>
              <button
                className="context-menu-item" role="menuitem"
                onClick={() => {
                  const session = sessions.find((s) => s.id === contextMenu.sessionId);
                  const project = session?.projectId ? projects.find((p) => p.id === session.projectId) : undefined;
                  splitTerminal(contextMenu.sessionId, "vertical", project?.path, project?.shell);
                  setContextMenu(null);
                }}
              >
                垂直分屏
              </button>
            </>
          )}
        </div>
      )}

      {/* Terminal panel */}
      <div className="flex-1 relative">
        {sessions.map((s) => (
          <div
            key={s.id}
            className="absolute inset-0"
            style={{ display: s.id === activeSessionId ? "block" : "none" }}
          >
            <SplitTerminalView sessionId={s.id} split={splits[s.id]} isActive={s.id === activeSessionId} resolvedTheme={resolvedTheme} terminalThemeName={terminalThemeName} />
          </div>
        ))}
        {sessions.length === 0 && !useExternalTerminal && (
          <div className="flex items-center justify-center h-full">
            <EmptyState
              icon={<Terminal size={40} strokeWidth={1} />}
              title="无活跃终端"
              description="Ctrl+Shift+T 新建终端，或从左侧项目列表双击启动"
              action={{ label: "打开终端", onClick: handleNewTab }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
