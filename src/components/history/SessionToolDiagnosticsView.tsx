import { AlertTriangle, Gauge, Wrench } from "lucide-react";
import type { HistoryToolCount, HistoryToolEvent } from "../../lib/types";
import { useI18n } from "../../lib/i18n";
import { sortHistoryItems, type HistoryDetailSortDirection } from "../../lib/historySort";
import type { SessionProcessModel } from "./sessionEvents";

interface SessionToolDiagnosticsViewProps {
  model: SessionProcessModel;
  direction: HistoryDetailSortDirection;
  builtinCalls: HistoryToolCount[];
  mcpCalls: HistoryToolCount[];
  skillCalls: HistoryToolCount[];
  toolEvents: HistoryToolEvent[];
  onJumpToMessage: (messageIndex: number) => void;
}

function ToolCountSection({ title, items }: { title: string; items: HistoryToolCount[] }) {
  if (items.length === 0) return null;
  return (
    <section className="ui-session-process-card">
      <div className="ui-session-process-card-title">
        <Wrench size={14} />
        {title}
      </div>
      <div className="ui-session-tool-counts">
        {items.map((item) => (
          <span key={item.name} title={item.name}>
            {item.name}<b>{item.count}</b>
          </span>
        ))}
      </div>
    </section>
  );
}

export function SessionToolDiagnosticsView({
  model,
  direction,
  builtinCalls,
  mcpCalls,
  skillCalls,
  toolEvents,
  onJumpToMessage,
}: SessionToolDiagnosticsViewProps) {
  const { t } = useI18n();
  const hasCounts = builtinCalls.length > 0 || mcpCalls.length > 0 || skillCalls.length > 0;
  const hasEvents = toolEvents.length > 0 || model.toolEvents.length > 0 || model.errorEvents.length > 0;
  const orderedToolEvents = sortHistoryItems(toolEvents, direction);
  const orderedErrorEvents = sortHistoryItems(model.errorEvents, direction);
  const orderedSuspectedEvents = sortHistoryItems(model.toolEvents, direction).slice(0, 80);

  if (!hasCounts && !hasEvents) {
    return <div className="ui-session-process-empty">{t("history.tools.empty")}</div>;
  }

  return (
    <div className="ui-session-process-view">
      <div className="ui-session-process-grid">
        <ToolCountSection title={t("history.tools.builtin")} items={builtinCalls} />
        <ToolCountSection title="MCP" items={mcpCalls} />
        <ToolCountSection title={t("history.tools.skillCommand")} items={skillCalls} />
        <section className="ui-session-process-card">
          <div className="ui-session-process-card-title">
            <Gauge size={14} />
            {t("history.tools.durationData")}
          </div>
          <div className="ui-session-process-empty compact">
            {toolEvents.some((event) => event.duration_ms)
              ? t("history.tools.durationShown")
              : t("history.tools.durationMissing")}
          </div>
        </section>
      </div>

      {toolEvents.length > 0 && (
        <section className="ui-session-process-card mt-2">
          <div className="ui-session-process-card-title">
            <Wrench size={14} />
            {t("history.tools.structuredCalls")}
          </div>
          <div className="ui-session-diagnostic-list">
            {orderedToolEvents.map((event, index) => (
              <button
                key={event.call_id ?? `${event.name}-${index}`}
                type="button"
                onClick={() => event.message_index !== null && event.message_index !== undefined && onJumpToMessage(event.message_index)}
              >
                <span>
                  {event.name}
                  {event.status ? ` · ${event.status}` : ""}
                  {event.duration_ms ? ` · ${event.duration_ms}ms` : ""}
                </span>
                <small>{event.output_summary ?? event.input_summary ?? event.category}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      {orderedErrorEvents.length > 0 && (
        <section className="ui-session-process-card mt-2">
          <div className="ui-session-process-card-title danger">
            <AlertTriangle size={14} />
            {t("history.tools.errorClues")}
          </div>
          <div className="ui-session-diagnostic-list">
            {orderedErrorEvents.map((event) => (
              <button
                key={event.id}
                type="button"
                onClick={() => event.messageIndex !== null && onJumpToMessage(event.messageIndex)}
              >
                <span>{event.title}</span>
                <small>{event.detail}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      {orderedSuspectedEvents.length > 0 && (
        <section className="ui-session-process-card mt-2">
          <div className="ui-session-process-card-title">
            <Wrench size={14} />
            {t("history.tools.suspectedEvents")}
          </div>
          <div className="ui-session-diagnostic-list">
            {orderedSuspectedEvents.map((event) => (
              <button
                key={event.id}
                type="button"
                onClick={() => event.messageIndex !== null && onJumpToMessage(event.messageIndex)}
              >
                <span>{event.toolName ?? event.title}</span>
                <small>{event.detail}</small>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
