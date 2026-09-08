import { useEffect, useMemo, useState } from "react";
import { FolderGit2, GitBranch } from "lucide-react";
import type { HistorySessionDetail, HistorySessionView } from "../../../shared/types/index";
import { useI18n } from "../../../shared/i18n/index";
import { fetchTodayProjectStats, type TodayProjectStats } from "../index";
import {
  TERM,
  StatCard,
  SourcePill,
  Row,
  StatChip,
  EmptyHint,
  calculateTokenStats,
  formatDuration,
  truncatePath,
} from "../../stats/api/termStatsUi";
import { TokenUsageCard, ModelContextCard, TrendCard, ToolsCard, TodayUsageCard } from "../../stats/api/termStatsCards";

interface SessionStatsPanelProps {
  activeView: HistorySessionView | null;
  activeSession: HistorySessionDetail | null;
  open: boolean;
}

function SessionInfoCard({
  view,
  session,
}: {
  view: HistorySessionView;
  session: HistorySessionDetail;
}) {
  const { t } = useI18n();
  const folderPath = view.file_path ? truncatePath(view.file_path, 3) : "—";
  const branch = view.branch || "—";
  const duration = formatDuration(session.updated_at - session.created_at);

  return (
    <StatCard
      icon={<FolderGit2 size={13} />}
      iconColor={TERM.cyan}
      title={t("termStats.session")}
      headerRight={
        <SourcePill source={view.source} />
      }
    >
      <Row label={t("termStats.project")} value={view.project_key} title={view.project_key} />
      <Row label={t("termStats.path")} value={folderPath} color={TERM.dim} title={view.file_path} />
      <div className="flex items-baseline justify-between gap-2 text-[11px] leading-5">
        <span className="flex shrink-0 items-center gap-1" style={{ color: TERM.dim }}>
          <GitBranch size={10} />
          {t("termStats.branch")}
        </span>
        <span className="truncate text-right" style={{ color: TERM.magenta }} title={branch}>
          {branch}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <StatChip dotColor={TERM.cyan} label={t("termStats.messageCount")} value={String(session.messages.length)} />
        <StatChip dotColor={TERM.green} label={t("termStats.duration")} value={duration} />
      </div>
    </StatCard>
  );
}

function TodaySection({ projectKey }: { projectKey: string }) {
  const [stats, setStats] = useState<TodayProjectStats | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchTodayProjectStats(projectKey).then((result) => {
      if (cancelled) return;
      setStats(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectKey]);

  return <TodayUsageCard stats={stats} loading={loading} />;
}

export function SessionStatsPanel({ activeView, activeSession, open }: SessionStatsPanelProps) {
  const { t } = useI18n();
  const stats = useMemo(() => calculateTokenStats(activeSession), [activeSession]);

  if (!open) return null;

  return (
    <aside
      className="flex w-[290px] shrink-0 flex-col gap-2 overflow-y-auto border-l border-border p-2 font-mono"
      style={{ backgroundColor: TERM.bg }}
    >
      {activeView && activeSession ? (
        <>
          <SessionInfoCard view={activeView} session={activeSession} />
          <TokenUsageCard stats={stats} />
          <TrendCard session={activeSession} />
          <ModelContextCard stats={stats} session={activeSession} />
          <ToolsCard session={activeSession} />
          <TodaySection projectKey={activeView.project_key} />
        </>
      ) : (
        <EmptyHint text={t("history.stats.empty")} />
      )}
    </aside>
  );
}
