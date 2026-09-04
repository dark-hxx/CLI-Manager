import {
  ChevronDown,
  ChevronRight,
  Cloud,
  GitBranch,
  Search,
  Tag,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { GitBranchInfo, GitBranchStatus } from "../../../lib/types";
import { useI18n } from "../../../lib/i18n";
import { TERM, panelColorTint } from "../../stats/termStatsUi";

interface GitRefTreeProps {
  branches: GitBranchInfo[];
  status: GitBranchStatus | null;
  tags: string[];
  loading: boolean;
}

function RefSection({
  icon,
  title,
  children,
  defaultOpen = true,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <button
        type="button"
        className="ui-focus-ring flex h-7 w-full items-center gap-1.5 px-2 text-left text-[11px] font-semibold"
        style={{ color: TERM.fg }}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {icon}
        <span className="truncate">{title}</span>
      </button>
      {open && children}
    </section>
  );
}

function RefRow({
  name,
  current = false,
}: {
  name: string;
  current?: boolean;
}) {
  return (
    <div
      className="flex h-7 items-center gap-1.5 px-3 pl-8 text-[11px]"
      style={{
        color: current ? TERM.cyan : TERM.fg,
        backgroundColor: current
          ? panelColorTint(TERM.cyan, 10)
          : "transparent",
      }}
      title={name}
    >
      <GitBranch size={11} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
    </div>
  );
}

export function GitRefTree({
  branches,
  status,
  tags,
  loading,
}: GitRefTreeProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleBranches = useMemo(
    () =>
      normalizedFilter
        ? branches.filter((branch) =>
            branch.name.toLocaleLowerCase().includes(normalizedFilter),
          )
        : branches,
    [branches, normalizedFilter],
  );
  const visibleTags = useMemo(
    () =>
      normalizedFilter
        ? tags.filter((tag) =>
            tag.toLocaleLowerCase().includes(normalizedFilter),
          )
        : tags,
    [normalizedFilter, tags],
  );
  const localBranches = useMemo(
    () => visibleBranches.filter((branch) => branch.branchType === "local"),
    [visibleBranches],
  );
  const remoteGroups = useMemo(() => {
    const groups = new Map<string, GitBranchInfo[]>();
    visibleBranches
      .filter((branch) => branch.branchType === "remote")
      .forEach((branch) => {
        const remote =
          branch.remote ||
          branch.name.split("/")[0] ||
          t("git.workspace.remoteFallback");
        groups.set(remote, [...(groups.get(remote) ?? []), branch]);
      });
    return [...groups.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
  }, [t, visibleBranches]);

  return (
    <aside
      className="ui-thin-scroll h-full min-h-0 overflow-y-auto border-r"
      style={{ borderColor: TERM.border, backgroundColor: TERM.card }}
    >
      <div className="border-b px-3 py-2" style={{ borderColor: TERM.border }}>
        <div
          className="text-[10px] font-semibold uppercase"
          style={{ color: TERM.dim }}
        >
          {t("git.workspace.currentBranch")}
        </div>
        <div
          className="mt-1 flex items-center gap-1.5 text-xs"
          style={{ color: TERM.cyan }}
        >
          <GitBranch size={13} />
          <span className="truncate">
            {status?.detached
              ? t("git.workspace.detached")
              : status?.branch || t("git.workspace.noBranch")}
          </span>
        </div>
        <label
          className="mt-2 flex items-center rounded-sm border px-2"
          style={{ borderColor: TERM.border, backgroundColor: TERM.bg }}
        >
          <Search size={11} className="shrink-0" style={{ color: TERM.dim }} />
          <input
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-[10px] outline-none"
            placeholder={t("git.workspace.filterRefs")}
            aria-label={t("git.workspace.filterRefs")}
            style={{ color: TERM.fg }}
          />
        </label>
      </div>

      {loading && branches.length === 0 ? (
        <div className="px-3 py-4 text-[11px]" style={{ color: TERM.dim }}>
          {t("common.loading")}
        </div>
      ) : (
        <>
          <RefSection
            icon={<GitBranch size={12} />}
            title={t("git.workspace.localBranches")}
          >
            {localBranches.length > 0 ? (
              localBranches.map((branch) => (
                <RefRow
                  key={branch.name}
                  name={branch.name}
                  current={branch.current}
                />
              ))
            ) : (
              <div
                className="px-3 py-2 pl-8 text-[10px]"
                style={{ color: TERM.dim }}
              >
                {t("git.workspace.noRefs")}
              </div>
            )}
          </RefSection>

          <RefSection
            icon={<Cloud size={12} />}
            title={t("git.workspace.remotes")}
          >
            {remoteGroups.length > 0 ? (
              remoteGroups.map(([remote, remoteBranches]) => (
                <RefSection
                  key={remote}
                  icon={<Cloud size={11} />}
                  title={remote}
                  defaultOpen={false}
                >
                  {remoteBranches.map((branch) => (
                    <RefRow key={branch.name} name={branch.name} />
                  ))}
                </RefSection>
              ))
            ) : (
              <div
                className="px-3 py-2 pl-8 text-[10px]"
                style={{ color: TERM.dim }}
              >
                {t("git.workspace.noRefs")}
              </div>
            )}
          </RefSection>

          {visibleTags.length > 0 && (
            <RefSection
              icon={<Tag size={12} />}
              title={t("git.workspace.tags")}
              defaultOpen={false}
            >
              {visibleTags.map((tag) => (
                <div
                  key={tag}
                  className="flex h-7 items-center gap-1.5 px-3 pl-8 text-[11px]"
                  style={{ color: TERM.fg }}
                  title={tag}
                >
                  <Tag size={11} className="shrink-0" />
                  <span className="truncate">{tag}</span>
                </div>
              ))}
            </RefSection>
          )}
        </>
      )}
    </aside>
  );
}
