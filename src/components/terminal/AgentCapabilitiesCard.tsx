import { Alert, Badge, Button, Group, Modal, ScrollArea, Select, Stack, Tabs, Text } from "@mantine/core";
import { Blocks, ChevronRight, PlugZap, RefreshCw, ShieldAlert, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  AgentCapabilitySnapshot,
  AgentRuntimeKind,
  McpActivation,
  McpCapabilityItem,
  McpHealth,
  SkillCapabilityItem,
  SkillState,
} from "../../lib/agentCapabilities";
import type { ProjectEnvironmentType } from "../../lib/types";
import type { OpenCodeHookStatus } from "../../hooks/useAgentCapabilities";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import type { CliToolIconKey } from "../../lib/cliTools";
import { CliToolIcon } from "../CliToolIcon";
import { HeaderPill, StatCard, StatChip, TERM } from "../stats/termStatsUi";

interface AgentCapabilitiesCardProps {
  agent: AgentRuntimeKind | null;
  environment: ProjectEnvironmentType;
  cliSessionId: string;
  snapshot: AgentCapabilitySnapshot | null;
  loading: boolean;
  probing: boolean;
  errorCode: string | null;
  onRefresh: () => void;
  onProbe: () => void;
  openCodeHookStatus: OpenCodeHookStatus | null;
  openCodeHookLoading: boolean;
  openCodeHookError: string | null;
  onInstallOpenCodeHook: () => void;
}

const MCP_COLORS: Record<McpHealth, string> = {
  healthy: TERM.green,
  error: TERM.red,
  checking: TERM.yellow,
  unknown: TERM.dim,
};

const MCP_LABEL_KEYS: Record<McpHealth, TranslationKey> = {
  healthy: "termStats.agentCapabilities.health.healthy",
  error: "termStats.agentCapabilities.health.error",
  checking: "termStats.agentCapabilities.health.checking",
  unknown: "termStats.agentCapabilities.health.unknown",
};

const MCP_ACTIVATION_LABEL_KEYS: Record<McpActivation, TranslationKey> = {
  active: "termStats.agentCapabilities.activation.active",
  disabled: "termStats.agentCapabilities.activation.disabled",
};

const SKILL_LABEL_KEYS: Record<SkillState, TranslationKey> = {
  available: "termStats.agentCapabilities.skill.available",
  disabled: "termStats.agentCapabilities.skill.disabled",
  denied: "termStats.agentCapabilities.skill.denied",
  shadowed: "termStats.agentCapabilities.skill.shadowed",
  invalid: "termStats.agentCapabilities.skill.invalid",
};

const CAPABILITY_TOKEN_KEYS: Record<string, TranslationKey> = {
  user: "termStats.agentCapabilities.scope.user",
  project: "termStats.agentCapabilities.scope.project",
  session: "termStats.agentCapabilities.scope.session",
  native: "termStats.agentCapabilities.source.native",
  plugin: "termStats.agentCapabilities.source.plugin",
  "agent-compatible": "termStats.agentCapabilities.source.agentCompatible",
  "claude-compatible": "termStats.agentCapabilities.source.claudeCompatible",
  "cursor-compatible": "termStats.agentCapabilities.source.cursorCompatible",
  "runtime-evidence": "termStats.agentCapabilities.source.runtimeEvidence",
  remote: "termStats.agentCapabilities.transport.remote",
  stdio: "termStats.agentCapabilities.transport.stdio",
  unknown: "termStats.agentCapabilities.health.unknown",
};

type CapabilityTab = "mcp" | "skills";

const AGENT_ICON_KEYS: Record<AgentRuntimeKind, CliToolIconKey> = {
  claude: "claude-code",
  codex: "codex",
  pi: "pi",
  grok: "grok",
  opencode: "opencode",
};

const AGENT_LABELS: Record<AgentRuntimeKind, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
  grok: "Grok",
  opencode: "OpenCode",
};

function AgentLabel({ agent }: { agent: AgentRuntimeKind }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <CliToolIcon icon={AGENT_ICON_KEYS[agent]} size={11} className="shrink-0 text-current" />
      <span className="truncate">{AGENT_LABELS[agent]}</span>
    </span>
  );
}

function McpRow({ item }: { item: McpCapabilityItem }) {
  const { language, t } = useI18n();
  const disabled = item.activation === "disabled";
  const meta = [item.sourceScope, item.sourceKind, item.transport]
    .map((value) => CAPABILITY_TOKEN_KEYS[value] ? t(CAPABILITY_TOKEN_KEYS[value]) : value)
    .join(" · ");
  return (
    <div className="rounded-lg border border-border p-3">
      <Group justify="space-between" align="flex-start" wrap="nowrap" className="min-w-0">
        <div className="min-w-0 flex-1">
          <Text size="sm" fw={600} truncate>{item.name}</Text>
          <Text size="xs" c="dimmed" truncate title={meta}>{meta}</Text>
        </div>
        <Group gap={4} wrap="nowrap" className="shrink-0">
          <Badge color={disabled ? "gray" : "cyan"} variant="light">
            {t(MCP_ACTIVATION_LABEL_KEYS[item.activation])}
          </Badge>
          {!disabled && (
            <Badge color={item.health === "error" ? "red" : item.health === "healthy" ? "green" : "gray"} variant="light">
              {t(MCP_LABEL_KEYS[item.health])}
            </Badge>
          )}
        </Group>
      </Group>
      {item.lastEvidence && (
        <Text size="xs" c="dimmed" mt={6}>
          {t("termStats.agentCapabilities.lastEvidence", {
            time: new Intl.DateTimeFormat(language, {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
              hourCycle: "h23",
            }).format(new Date(item.lastEvidence)),
          })}
        </Text>
      )}
      {item.errorCode && <Text size="xs" c="red" mt={6}>{t("termStats.agentCapabilities.errorCode", { code: item.errorCode })}</Text>}
    </div>
  );
}

function SkillRow({ item }: { item: SkillCapabilityItem }) {
  const { t } = useI18n();
  const meta = [item.scope, item.sourceKind]
    .map((value) => CAPABILITY_TOKEN_KEYS[value] ? t(CAPABILITY_TOKEN_KEYS[value]) : value)
    .join(" · ");
  return (
    <div className="rounded-lg border border-border p-3">
      <Group justify="space-between" align="flex-start" wrap="nowrap" className="min-w-0">
        <div className="min-w-0 flex-1">
          <Text size="sm" fw={600} truncate>{item.name}</Text>
          {item.description && <Text size="xs" c="dimmed" lineClamp={2} title={item.description}>{item.description}</Text>}
          <Text size="xs" c="dimmed" truncate mt={4} title={`${meta} · ${item.pathLabel}`}>{meta} · {item.pathLabel}</Text>
        </div>
        <Badge className="shrink-0" color={item.state === "available" ? "green" : item.state === "denied" || item.state === "invalid" ? "red" : "gray"} variant="light">
          {t(SKILL_LABEL_KEYS[item.state])}
        </Badge>
      </Group>
      {item.errorCode && <Text size="xs" c="red" mt={6}>{t("termStats.agentCapabilities.errorCode", { code: item.errorCode })}</Text>}
    </div>
  );
}

function AgentCapabilitiesModal({
  opened,
  onClose,
  agent,
  cliSessionId,
  snapshot,
  loading,
  probing,
  errorCode,
  onRefresh,
  onProbe,
  environment,
  openCodeHookStatus,
  openCodeHookLoading,
  openCodeHookError,
  onInstallOpenCodeHook,
  activeTab,
  onTabChange,
}: AgentCapabilitiesCardProps & {
  opened: boolean;
  onClose: () => void;
  activeTab: CapabilityTab;
  onTabChange: (tab: CapabilityTab) => void;
}) {
  const { language, t } = useI18n();
  const [mcpFilter, setMcpFilter] = useState<string>("all");
  const [skillFilter, setSkillFilter] = useState<string>("all");
  const mcp = useMemo(() => snapshot?.mcp.filter((item) => (
    mcpFilter === "all" || item.health === mcpFilter || item.activation === mcpFilter
  )) ?? [], [mcpFilter, snapshot?.mcp]);
  const skills = useMemo(() => snapshot?.skills.filter((item) => skillFilter === "all" || item.state === skillFilter) ?? [], [skillFilter, snapshot?.skills]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      centered
      size="min(920px, 94vw)"
      title={t("termStats.agentCapabilities.modalTitle")}
    >
      <Stack gap="sm">
        <Group justify="space-between" align="center">
          <Group gap="xs">
            {agent && <Badge variant="light" color="cliPrimary"><AgentLabel agent={agent} /></Badge>}
            <Text size="xs" c="dimmed" ff="monospace">{cliSessionId || t("termStats.agentCapabilities.unbound")}</Text>
          </Group>
          <Group gap="xs">
            <Button size="xs" variant="default" leftSection={<RefreshCw size={13} />} loading={loading} onClick={onRefresh}>
              {t("termStats.agentCapabilities.refresh")}
            </Button>
            <Button size="xs" leftSection={<PlugZap size={13} />} loading={probing} onClick={onProbe} disabled={!snapshot || snapshot.bridgeStatus !== "ready"}>
              {t("termStats.agentCapabilities.probe")}
            </Button>
          </Group>
        </Group>
        {snapshot && (
          <Text size="xs" c="dimmed">
            {t("termStats.agentCapabilities.capturedAt", {
              time: new Intl.DateTimeFormat(language, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
                hourCycle: "h23",
              }).format(new Date(snapshot.capturedAt)),
            })}
          </Text>
        )}

        {!cliSessionId && (
          <Alert color="yellow" icon={<ShieldAlert size={16} />}>
            <Stack gap="xs">
              <Text size="sm">{t("termStats.agentCapabilities.bridgeMissing")}</Text>
              {agent === "opencode" && environment === "local" && (
                <>
                  {openCodeHookStatus?.status === "installed" ? (
                    <Text size="xs">{t("termStats.agentCapabilities.openCodeRestart")}</Text>
                  ) : openCodeHookStatus?.status === "conflict" ? (
                    <Text size="xs" c="red">{t("termStats.agentCapabilities.openCodeConflict")}</Text>
                  ) : (
                    <Button
                      size="xs"
                      variant="light"
                      loading={openCodeHookLoading}
                      onClick={onInstallOpenCodeHook}
                      className="self-start"
                    >
                      {t("termStats.agentCapabilities.openCodeInstall")}
                    </Button>
                  )}
                  {openCodeHookError && (
                    <Text size="xs" c="red">{t("termStats.agentCapabilities.openCodeInstallFailed", { code: openCodeHookError })}</Text>
                  )}
                </>
              )}
            </Stack>
          </Alert>
        )}
        {snapshot?.bridgeStatus === "upgradeRequired" && <Alert color="yellow" icon={<ShieldAlert size={16} />}>{t("termStats.agentCapabilities.sshUpgrade")}</Alert>}
        {snapshot?.configChanged && <Alert color="yellow">{t("termStats.agentCapabilities.configChanged")}</Alert>}
        {errorCode && <Alert color="red">{t("termStats.agentCapabilities.loadFailed", { code: errorCode })}</Alert>}
        {snapshot?.diagnostics.map((diagnostic, index) => (
          <Alert key={`${diagnostic.code}-${index}`} color={diagnostic.level === "error" ? "red" : diagnostic.level === "warning" ? "yellow" : "blue"}>
            {t("termStats.agentCapabilities.diagnostic", { code: diagnostic.code })}
          </Alert>
        ))}

        <Tabs
          value={activeTab}
          onChange={(value) => onTabChange(value === "skills" ? "skills" : "mcp")}
          keepMounted={false}
        >
          <Tabs.List aria-label={t("termStats.agentCapabilities.tabsLabel")}>
            <Tabs.Tab value="mcp" leftSection={<PlugZap size={14} />}>{t("termStats.agentCapabilities.mcpTab")}</Tabs.Tab>
            <Tabs.Tab value="skills" leftSection={<Wrench size={14} />}>{t("termStats.agentCapabilities.skillsTab")}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="mcp" pt="sm">
            <Stack gap="sm">
              <Select
                size="xs"
                value={mcpFilter}
                onChange={(value) => setMcpFilter(value ?? "all")}
                aria-label={t("termStats.agentCapabilities.mcpFilter")}
                data={[
                  { value: "all", label: t("termStats.agentCapabilities.filter.all") },
                  { value: "healthy", label: t(MCP_LABEL_KEYS.healthy) },
                  { value: "error", label: t(MCP_LABEL_KEYS.error) },
                  { value: "unknown", label: t(MCP_LABEL_KEYS.unknown) },
                  { value: "disabled", label: t("termStats.agentCapabilities.activation.disabled") },
                ]}
              />
              <ScrollArea h={420} type="auto">
                <Stack gap="xs" pr="xs">
                  {mcp.length > 0 ? mcp.map((item) => <McpRow key={`${item.name}-${item.sourceScope}`} item={item} />) : <Text size="sm" c="dimmed">{t("termStats.agentCapabilities.noMcp")}</Text>}
                </Stack>
              </ScrollArea>
            </Stack>
          </Tabs.Panel>
          <Tabs.Panel value="skills" pt="sm">
            <Stack gap="sm">
              <Select
                size="xs"
                value={skillFilter}
                onChange={(value) => setSkillFilter(value ?? "all")}
                aria-label={t("termStats.agentCapabilities.skillFilter")}
                data={[
                  { value: "all", label: t("termStats.agentCapabilities.filter.all") },
                  ...Object.entries(SKILL_LABEL_KEYS).map(([value, key]) => ({ value, label: t(key) })),
                ]}
              />
              <ScrollArea h={420} type="auto">
                <Stack gap="xs" pr="xs">
                  {skills.length > 0 ? skills.map((item) => <SkillRow key={`${item.name}-${item.pathLabel}`} item={item} />) : <Text size="sm" c="dimmed">{t("termStats.agentCapabilities.noSkills")}</Text>}
                </Stack>
              </ScrollArea>
            </Stack>
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </Modal>
  );
}

export function AgentCapabilitiesCard(props: AgentCapabilitiesCardProps) {
  const { t } = useI18n();
  const [opened, setOpened] = useState(false);
  const [activeTab, setActiveTab] = useState<CapabilityTab>("mcp");
  const { agent, cliSessionId, snapshot, loading, errorCode } = props;
  const mcp = snapshot?.mcpSummary;
  const skills = snapshot?.skillSummary;
  const openDetails = (tab: CapabilityTab) => {
    setActiveTab(tab);
    setOpened(true);
  };

  return (
    <>
      <StatCard
        icon={<Blocks size={13} />}
        iconColor={TERM.cyan}
        title={t("termStats.agentCapabilities.title")}
        headerRight={agent ? <HeaderPill color={TERM.cyan}><AgentLabel agent={agent} /></HeaderPill> : undefined}
      >
        <button
          type="button"
          className="ui-focus-ring w-full cursor-pointer rounded-lg text-left transition-opacity hover:opacity-90"
          onClick={() => openDetails("mcp")}
          aria-label={t("termStats.agentCapabilities.openDetails")}
        >
          <div className="mb-2 flex items-center justify-between gap-2 text-[10px]" style={{ color: TERM.dim }}>
            <span className="truncate font-mono">{cliSessionId || t("termStats.agentCapabilities.unbound")}</span>
            <ChevronRight size={12} className="shrink-0" />
          </div>
          {!agent ? (
            <Text size="xs" c="dimmed">{t("termStats.agentCapabilities.unsupported")}</Text>
          ) : !cliSessionId ? (
            <Text size="xs" c="yellow">{t("termStats.agentCapabilities.bridgeMissingShort")}</Text>
          ) : errorCode && !snapshot ? (
            <Text size="xs" c="red">{t("termStats.agentCapabilities.loadFailedShort")}</Text>
          ) : loading && !snapshot ? (
            <Text size="xs" c="dimmed">{t("termStats.agentCapabilities.loading")}</Text>
          ) : null}
        </button>
        {agent && cliSessionId && (!loading || snapshot) && (!errorCode || snapshot) && (
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              className="ui-focus-ring cursor-pointer rounded-lg text-left transition-opacity hover:opacity-90"
              onClick={() => openDetails("mcp")}
              aria-label={t("termStats.agentCapabilities.openMcpDetails")}
            >
              <StatChip dotColor={mcp?.error ? TERM.red : mcp?.healthy ? TERM.green : TERM.dim} label={t("termStats.agentCapabilities.mcpActive")} value={String(mcp?.active ?? 0)} />
            </button>
            <button
              type="button"
              className="ui-focus-ring cursor-pointer rounded-lg text-left transition-opacity hover:opacity-90"
              onClick={() => openDetails("skills")}
              aria-label={t("termStats.agentCapabilities.openSkillsDetails")}
            >
              <StatChip dotColor={(skills?.invalid ?? 0) > 0 ? TERM.red : TERM.cyan} label={t("termStats.agentCapabilities.skillsAvailable")} value={String(skills?.available ?? 0)} />
            </button>
          </div>
        )}
        {snapshot && (
          <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
            {(["healthy", "error", "unknown"] as const).map((health) => (
              <span key={health} className="inline-flex items-center gap-1" style={{ color: MCP_COLORS[health] }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: MCP_COLORS[health] }} />
                {t(MCP_LABEL_KEYS[health])} {snapshot.mcpSummary[health]}
              </span>
            ))}
          </div>
        )}
      </StatCard>
      <AgentCapabilitiesModal
        {...props}
        opened={opened}
        onClose={() => setOpened(false)}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
    </>
  );
}
