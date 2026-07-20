import {
  AlertCircle,
  Bot,
  FileCode2,
  GitBranch,
  Maximize2,
  Minus,
  Network,
  Plus,
  Terminal,
  User,
  Wrench,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { HistorySessionDetail } from "../../lib/types";
import { useI18n, type AppLanguage, type TranslationKey } from "../../lib/i18n";
import { formatTime } from "./historyViewUtils";
import type { SessionProcessModel } from "./sessionEvents";
import {
  buildSessionCanvasModel,
  type SessionCanvasEdge,
  type SessionCanvasFilter,
  type SessionCanvasNode,
  type SessionCanvasNodeKind,
} from "./sessionCanvasModel";

interface SessionCanvasViewProps {
  session: HistorySessionDetail | null;
  model: SessionProcessModel;
  onJumpToMessage: (messageIndex: number) => void;
  onOpenDiff: () => void;
}

interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 1.6;
const FIT_PADDING = 56;

const FILTERS: Array<{ id: SessionCanvasFilter; labelKey: TranslationKey }> = [
  { id: "all", labelKey: "common.all" },
  { id: "tool", labelKey: "history.timeline.filter.tool" },
  { id: "file", labelKey: "history.timeline.filter.file" },
  { id: "test", labelKey: "history.canvas.filter.test" },
  { id: "error", labelKey: "history.timeline.filter.error" },
  { id: "subtask", labelKey: "history.canvas.filter.subtask" },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function kindLabelKey(kind: SessionCanvasNodeKind): TranslationKey {
  return `history.canvas.kind.${kind}` as TranslationKey;
}

function nodeIcon(kind: SessionCanvasNodeKind, size = 14) {
  if (kind === "start") return <Network size={size} />;
  if (kind === "turn") return <User size={size} />;
  if (kind === "file") return <FileCode2 size={size} />;
  if (kind === "test") return <Terminal size={size} />;
  if (kind === "error") return <AlertCircle size={size} />;
  if (kind === "subtask") return <GitBranch size={size} />;
  if (kind === "tool") return <Wrench size={size} />;
  return <Bot size={size} />;
}

function formatTimestamp(timestamp: string | null, language: AppLanguage): string {
  if (!timestamp) return "-";
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? formatTime(parsed, language) : timestamp;
}

function nodeBounds(nodes: SessionCanvasNode[]) {
  if (nodes.length === 0) return { minX: 0, minY: 0, width: 1, height: 1 };
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function edgePath(edge: SessionCanvasEdge, nodes: Map<string, SessionCanvasNode>): string {
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) return "";

  if (edge.kind === "main") {
    const x1 = source.x + source.width;
    const y1 = source.y + source.height / 2;
    const x2 = target.x;
    const y2 = target.y + target.height / 2;
    const control = Math.max(32, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + control} ${y1}, ${x2 - control} ${y2}, ${x2} ${y2}`;
  }

  const above = target.y < source.y;
  const x1 = source.x + source.width / 2;
  const y1 = above ? source.y : source.y + source.height;
  const x2 = target.x + target.width / 2;
  const y2 = above ? target.y + target.height : target.y;
  const control = Math.max(32, Math.abs(y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + (above ? -control : control)}, ${x2} ${y2 + (above ? control : -control)}, ${x2} ${y2}`;
}

export function SessionCanvasView({ session, model, onJumpToMessage, onOpenDiff }: SessionCanvasViewProps) {
  const { t, language } = useI18n();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ pointerId: number; clientX: number; clientY: number; originX: number; originY: number } | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingTransformRef = useRef<ViewTransform | null>(null);
  const transformRef = useRef<ViewTransform>({ x: 0, y: 0, scale: 1 });
  const [filter, setFilter] = useState<SessionCanvasFilter>("all");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [transform, setTransform] = useState<ViewTransform>(transformRef.current);

  const canvasModel = useMemo(() => buildSessionCanvasModel(session, model, t), [model, session, t]);
  const nodeMap = useMemo(() => new Map(canvasModel.nodes.map((node) => [node.id, node])), [canvasModel.nodes]);
  const visibleNodes = useMemo(
    () => canvasModel.nodes.filter((node) => node.kind === "start" || node.kind === "turn" || filter === "all" || node.kind === filter),
    [canvasModel.nodes, filter]
  );
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => canvasModel.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    [canvasModel.edges, visibleNodeIds]
  );
  const selectedNode = selectedNodeId && visibleNodeIds.has(selectedNodeId) ? nodeMap.get(selectedNodeId) ?? null : null;
  const bounds = useMemo(() => nodeBounds(visibleNodes), [visibleNodes]);
  const sceneWidth = Math.max(1, ...canvasModel.nodes.map((node) => node.x + node.width + 56));
  const sceneHeight = Math.max(1, ...canvasModel.nodes.map((node) => node.y + node.height + 56));

  const queueTransform = useCallback((next: ViewTransform) => {
    transformRef.current = next;
    pendingTransformRef.current = next;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const pending = pendingTransformRef.current;
      if (pending) setTransform(pending);
    });
  }, []);

  const fitView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || visibleNodes.length === 0) return;
    const rect = viewport.getBoundingClientRect();
    const availableWidth = Math.max(1, rect.width - FIT_PADDING * 2);
    const availableHeight = Math.max(1, rect.height - FIT_PADDING * 2);
    const scale = clamp(Math.min(availableWidth / bounds.width, availableHeight / bounds.height, 1), MIN_SCALE, MAX_SCALE);
    queueTransform({
      x: (rect.width - bounds.width * scale) / 2 - bounds.minX * scale,
      y: (rect.height - bounds.height * scale) / 2 - bounds.minY * scale,
      scale,
    });
  }, [bounds, queueTransform, visibleNodes.length]);

  const zoomAt = useCallback((nextScale: number, clientX?: number, clientY?: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const current = transformRef.current;
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    const localX = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const localY = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    const sceneX = (localX - current.x) / current.scale;
    const sceneY = (localY - current.y) / current.scale;
    queueTransform({
      x: localX - sceneX * scale,
      y: localY - sceneY * scale,
      scale,
    });
  }, [queueTransform]);

  useEffect(() => {
    setSelectedNodeId(null);
    setFilter("all");
  }, [session?.session_id]);

  useEffect(() => {
    const frame = requestAnimationFrame(fitView);
    return () => cancelAnimationFrame(frame);
  }, [fitView, filter, session?.session_id]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitView());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitView]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest("[data-canvas-panel]")) return;
      event.preventDefault();
      const current = transformRef.current;
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * 0.002);
        zoomAt(current.scale * factor, event.clientX, event.clientY);
        return;
      }
      queueTransform({
        ...current,
        x: current.x - event.deltaX,
        y: current.y - event.deltaY,
      });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [queueTransform, zoomAt]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-canvas-node], [data-canvas-panel]")) return;
    const current = transformRef.current;
    panRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      originX: current.x,
      originY: current.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    queueTransform({
      ...transformRef.current,
      x: pan.originX + event.clientX - pan.clientX,
      y: pan.originY + event.clientY - pan.clientY,
    });
  };

  const finishPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  if (!session || canvasModel.nodes.length === 0) {
    return <div className="ui-session-process-empty">{t("history.canvas.empty")}</div>;
  }

  const pixelRatio = window.devicePixelRatio || 1;
  const translateX = Math.round(transform.x * pixelRatio) / pixelRatio;
  const translateY = Math.round(transform.y * pixelRatio) / pixelRatio;

  return (
    <div className="ui-session-canvas-view">
      <div className="ui-session-canvas-toolbar">
        <div className="ui-session-process-summary">
          <span>{t("history.canvas.summaryTurns", { count: canvasModel.turnCount })}</span>
          <span>{t("history.canvas.summaryBranches", { count: canvasModel.branchCount })}</span>
        </div>
        <div className="ui-session-canvas-filters" aria-label={t("history.canvas.filtersAria")}>
          {FILTERS.map((item) => (
            <button key={item.id} type="button" data-active={filter === item.id} onClick={() => setFilter(item.id)}>
              {t(item.labelKey)}
            </button>
          ))}
        </div>
        <div className="ui-session-canvas-controls">
          <button type="button" onClick={() => zoomAt(transformRef.current.scale - 0.1)} aria-label={t("history.canvas.zoomOut")} title={t("history.canvas.zoomOut")}>
            <Minus size={13} />
          </button>
          <span aria-label={t("history.canvas.zoomLevel", { value: Math.round(transform.scale * 100) })}>
            {Math.round(transform.scale * 100)}%
          </span>
          <button type="button" onClick={() => zoomAt(transformRef.current.scale + 0.1)} aria-label={t("history.canvas.zoomIn")} title={t("history.canvas.zoomIn")}>
            <Plus size={13} />
          </button>
          <button type="button" onClick={fitView} aria-label={t("history.canvas.fitView")} title={t("history.canvas.fitView")}>
            <Maximize2 size={13} />
          </button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className="ui-session-canvas-viewport"
        role="region"
        aria-label={t("history.canvas.viewportAria")}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPan}
        onPointerCancel={finishPan}
      >
        <div
          className="ui-session-canvas-stage"
          style={{ transform: `translate3d(${translateX}px, ${translateY}px, 0)` }}
        >
          <div
            className="ui-session-canvas-scene"
            style={{
              width: sceneWidth * transform.scale,
              height: sceneHeight * transform.scale,
            }}
          >
            <svg
              className="ui-session-canvas-edges"
              width={sceneWidth * transform.scale}
              height={sceneHeight * transform.scale}
              viewBox={`0 0 ${sceneWidth} ${sceneHeight}`}
              aria-hidden="true"
            >
              {visibleEdges.map((edge) => (
                <path
                  key={edge.id}
                  d={edgePath(edge, nodeMap)}
                  data-kind={edge.kind}
                  data-active={selectedNodeId === edge.source || selectedNodeId === edge.target}
                />
              ))}
            </svg>

            {visibleNodes.map((node) => {
              return (
                <button
                  key={node.id}
                  type="button"
                  data-canvas-node
                  data-kind={node.kind}
                  data-selected={selectedNodeId === node.id}
                  className="ui-session-canvas-node"
                  style={{
                    left: node.x * transform.scale,
                    top: node.y * transform.scale,
                    width: node.width * transform.scale,
                    height: node.height * transform.scale,
                    fontSize: `${transform.scale}rem`,
                  }}
                  aria-label={t("history.canvas.nodeAria", { kind: t(kindLabelKey(node.kind)), title: node.title })}
                  onClick={() => setSelectedNodeId(node.id)}
                >
                  <span className="ui-session-canvas-node-head">
                    <span className="ui-session-canvas-node-kind">
                      {nodeIcon(node.kind, 14 * transform.scale)}
                      {t(kindLabelKey(node.kind))}
                    </span>
                    <time>{formatTimestamp(node.timestamp, language)}</time>
                  </span>
                  <strong>{node.title}</strong>
                  <span className="ui-session-canvas-node-summary">{node.summary}</span>
                  <span className="ui-session-canvas-node-meta">
                    {node.kind === "turn" && t("history.canvas.messageCount", { count: node.count })}
                    {node.totalTokens > 0 && <b>{t("history.canvas.tokenCount", { count: node.totalTokens })}</b>}
                    {node.status && <b>{node.status}</b>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {selectedNode && (
          <aside className="ui-session-canvas-panel" data-canvas-panel aria-label={t("history.canvas.detailsAria")}>
            <div className="ui-session-canvas-panel-head">
              <span>{nodeIcon(selectedNode.kind)}</span>
              <div>
                <small>{t(kindLabelKey(selectedNode.kind))}</small>
                <strong>{selectedNode.title}</strong>
              </div>
              <button type="button" onClick={() => setSelectedNodeId(null)} aria-label={t("common.close")} title={t("common.close")}>
                <X size={14} />
              </button>
            </div>
            <p>{selectedNode.summary}</p>
            {selectedNode.filePath && <code>{selectedNode.filePath}</code>}
            <div className="ui-session-canvas-panel-meta">
              <span>{formatTimestamp(selectedNode.timestamp, language)}</span>
              {selectedNode.status && <span>{selectedNode.status}</span>}
              {(selectedNode.additions > 0 || selectedNode.deletions > 0) && (
                <span className="ui-session-canvas-diff-count">+{selectedNode.additions} / -{selectedNode.deletions}</span>
              )}
            </div>
            {selectedNode.details.length > 0 && (
              <ul>
                {selectedNode.details.slice(0, 10).map((detail, index) => <li key={`${selectedNode.id}-${index}`}>{detail}</li>)}
                {selectedNode.details.length > 10 && (
                  <li>{t("history.canvas.moreDetails", { count: selectedNode.details.length - 10 })}</li>
                )}
              </ul>
            )}
            <div className="ui-session-canvas-panel-actions">
              {selectedNode.messageIndex !== null && (
                <button type="button" onClick={() => onJumpToMessage(selectedNode.messageIndex!)}>
                  {t("history.canvas.jumpTranscript")}
                </button>
              )}
              {selectedNode.kind === "file" && (
                <button type="button" onClick={onOpenDiff}>
                  {t("history.files.openDiff")}
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
