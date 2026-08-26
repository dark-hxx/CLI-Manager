import {
  Badge,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import { Copy, FolderOpen, Wrench } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { NativeProviderButton as Button } from "./NativeProviderButton";
import type { NativeProviderAppType, NativeProviderEnvironmentReport } from "./nativeProviderTypes";
import type { UseNativeProviderHomeResult } from "./useNativeProviderHome";
import { PathItem } from "./NativeProviderPathItem";

type EnvironmentState = Pick<
  UseNativeProviderHomeResult,
  "report" | "loading" | "action" | "inspectEnvironment" | "repair"
>;

interface NativeProviderEnvironmentSectionProps {
  appType: NativeProviderAppType;
  state: EnvironmentState;
}

export function NativeProviderEnvironmentSection({
  appType,
  state,
}: NativeProviderEnvironmentSectionProps) {
  const { t } = useI18n();
  const report = state.report;
  const busy = Boolean(state.action) || state.loading;
  const appCliName = appType === "grokbuild" ? "grok" : appType;
  const cli = report?.cli.filter((item) => item.name === appCliName) ?? [];
  const targetPrefix = appType === "grokbuild" ? "grokbuild" : appType;
  const targets = report?.targets.filter((target) => target.name.startsWith(`${targetPrefix}.`)) ?? [];
  const conflictVariable = appType === "claude"
    ? "CLAUDE_CONFIG_DIR"
    : appType === "codex"
      ? "CODEX_HOME"
      : "GROK_HOME";
  const conflicts = report?.conflicts.filter((conflict) => conflict.variable === conflictVariable) ?? [];
  const alignmentRoots = report
    ? appType === "claude"
      ? [
          ["claudeHook", t("providerCatalog.environment.claudeHook"), report.alignment.claudeHookRoot],
          ["claudeHistory", t("providerCatalog.environment.claudeHistory"), report.alignment.claudeHistoryRoot],
        ]
      : appType === "codex"
        ? [
            ["codexHook", t("providerCatalog.environment.codexHook"), report.alignment.codexHookRoot],
            ["codexHistory", t("providerCatalog.environment.codexHistory"), report.alignment.codexHistoryRoot],
          ]
        : [
            ["grokHook", t("providerCatalog.environment.grokHook"), report.alignment.grokHookRoot],
            ["grokHistory", t("providerCatalog.environment.grokHistory"), report.alignment.grokHistoryRoot],
          ]
    : [];

  const openTarget = async (path: string) => {
    try {
      await invoke("provider_environment_open_target", { path, openFile: false });
    } catch {
      toast.error(t("providerCatalog.environment.openFailed"));
    }
  };

  const copyDiagnostics = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(safeDiagnostics(report), null, 2));
      toast.success(t("providerCatalog.environment.copySuccess"));
    } catch {
      toast.error(t("providerCatalog.environment.copyFailed"));
    }
  };

  return (
    <Card withBorder radius="lg" padding="md" className="border-border/70 bg-surface-container-low">
      <Stack gap="sm">
        <Group justify="space-between">
          <Stack gap={2}>
            <Text fw={600}>{t("providerCatalog.environment.title")}</Text>
            <Text size="xs" c="dimmed">{t("providerCatalog.environment.description")}</Text>
          </Stack>
          <Group gap="xs">
            {report?.pendingRecovery && <Badge color="red">{t("providerCatalog.environment.recoveryPending")}</Badge>}
            {report && (
              <Button
                size="compact-sm"
                variant="subtle"
                color="gray"
                leftSection={<Copy size={14} />}
                onClick={() => void copyDiagnostics()}
              >
                {t("providerCatalog.environment.copyDiagnostics")}
              </Button>
            )}
            <Button
              size="compact-sm"
              variant="light"
              leftSection={<Wrench size={14} />}
              loading={state.action === "inspect-environment"}
              disabled={busy}
              onClick={() => void state.inspectEnvironment()}
            >
              {t("providerCatalog.environment.inspect")}
            </Button>
            {report?.pendingRecovery && (
              <Button
                size="compact-sm"
                variant="subtle"
                loading={state.action === "repair"}
                disabled={busy}
                onClick={() => void state.repair()}
              >
                {t("providerCatalog.environment.repair")}
              </Button>
            )}
          </Group>
        </Group>
        {report && (
          <Stack gap="sm">
            <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="xs">
              <Card withBorder radius="md" padding="xs" className="border-border/50 bg-surface-container-lowest">
                <Text size="xs" c="dimmed">{t("providerCatalog.environment.homeSourceLabel")}</Text>
                <Text size="sm" fw={600} mt={2}>
                  {report.home.source === "manual"
                    ? t("providerCatalog.home.sourceManual")
                    : t("providerCatalog.home.sourceAuto")}
                </Text>
              </Card>
              <Card withBorder radius="md" padding="xs" className="border-border/50 bg-surface-container-lowest">
                <Text size="xs" c="dimmed">{t("providerCatalog.environment.currentProvider")}</Text>
                <Group gap="xs" mt={2} wrap="nowrap">
                  <Text size="sm" fw={600} truncate className="min-w-0">
                    {report.currentProvider.providerName ?? t("providerCatalog.environment.notSet")}
                  </Text>
                  <Badge size="sm" color={report.currentProvider.activeKeyPresent ? "green" : "yellow"}>
                    {report.currentProvider.activeKeyPresent
                      ? t("providerCatalog.environment.keyReady")
                      : t("providerCatalog.environment.keyMissing")}
                  </Badge>
                </Group>
              </Card>
              <Card withBorder radius="md" padding="xs" className="border-border/50 bg-surface-container-lowest">
                <Text size="xs" c="dimmed">{t("providerCatalog.environment.cliVersions")}</Text>
                <Text size="sm" fw={600} mt={2}>{cli.filter((item) => item.available).length}/{cli.length}</Text>
              </Card>
            </SimpleGrid>

            <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="xs">
              {cli.map((item) => (
                <PathItem
                  key={item.name}
                  label={item.name}
                  path={item.available
                    ? [item.executable ?? "", item.version ?? ""].filter(Boolean).join(" · ")
                    : t("providerCatalog.environment.unavailable")}
                />
              ))}
            </SimpleGrid>

            <Stack gap="xs">
              <Text size="xs" fw={600}>{t("providerCatalog.environment.targetsTitle")}</Text>
              <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
                {targets.map((target) => (
                  <Card key={target.name} withBorder radius="md" padding="xs" className="border-border/50 bg-surface-container-lowest">
                    <Group justify="space-between" align="flex-start" gap="xs" wrap="nowrap">
                      <Stack gap={2} miw={0}>
                        <Text size="xs" fw={600} truncate>{target.name}</Text>
                        <Text size="xs" c="dimmed" truncate title={target.path}>{target.path}</Text>
                      </Stack>
                      <Badge size="sm" color={target.syntax === "valid" ? "green" : "yellow"}>
                        {target.syntax === "valid"
                          ? t("providerCatalog.environment.valid")
                          : target.syntax === "missing"
                            ? t("providerCatalog.environment.missing")
                            : t("providerCatalog.environment.invalid")}
                      </Badge>
                    </Group>
                    <Group justify="space-between" gap="xs" mt="xs" wrap="wrap">
                      <Group gap={4} wrap="wrap">
                        <Badge size="sm" color={target.readable ? "green" : "red"}>
                          {target.readable
                            ? t("providerCatalog.environment.readable")
                            : t("providerCatalog.environment.notReadable")}
                        </Badge>
                        <Badge size="sm" color={target.writable ? "green" : "red"}>
                          {target.writable
                            ? t("providerCatalog.environment.writable")
                            : t("providerCatalog.environment.notWritable")}
                        </Badge>
                      </Group>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        leftSection={<FolderOpen size={13} />}
                        disabled={!target.exists}
                        aria-label={t("providerCatalog.environment.openTarget")}
                        onClick={() => void openTarget(target.path)}
                      >
                        {t("providerCatalog.environment.openTarget")}
                      </Button>
                    </Group>
                  </Card>
                ))}
              </SimpleGrid>
            </Stack>

            <Stack gap="xs">
              <Group justify="space-between" wrap="nowrap">
                <Text size="xs" fw={600}>{t("providerCatalog.environment.roots")}</Text>
                <Badge size="sm" color={report.alignment.automaticRootsAligned ? "green" : "yellow"}>
                  {report.alignment.automaticRootsAligned
                    ? t("providerCatalog.environment.rootsAligned")
                    : t("providerCatalog.environment.rootsExplicit")}
                </Badge>
              </Group>
              <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
                {alignmentRoots.map(([id, label, path]) => (
                  <Card key={id} withBorder radius="md" padding="xs" className="border-border/50 bg-surface-container-lowest">
                    <Group justify="space-between" align="flex-start" gap="xs" wrap="nowrap">
                      <Stack gap={2} miw={0}>
                        <Text size="xs" fw={600}>{label}</Text>
                        <Text size="xs" c="dimmed" truncate title={path}>{path}</Text>
                      </Stack>
                      {report.alignment.explicitRoots.includes(id) && (
                        <Badge size="sm" color="yellow">{t("providerCatalog.environment.explicit")}</Badge>
                      )}
                    </Group>
                  </Card>
                ))}
              </SimpleGrid>
            </Stack>

            {conflicts.length > 0 && (
              <Stack gap="xs">
                <Text size="xs" fw={600}>{t("providerCatalog.environment.conflicts")}</Text>
                <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="xs">
                  {conflicts.map((conflict) => (
                    <Card key={conflict.variable} withBorder radius="md" padding="xs" className="border-border/50 bg-surface-container-lowest">
                      <Group justify="space-between" gap="xs" wrap="nowrap">
                        <Text size="xs" fw={600} truncate>{conflict.variable}</Text>
                        <Badge size="sm" color={!conflict.present || conflict.matchesHome ? "green" : "yellow"}>
                          {!conflict.present
                            ? t("providerCatalog.environment.notSet")
                            : conflict.matchesHome
                              ? t("providerCatalog.environment.matchesHome")
                              : t("providerCatalog.environment.conflict")}
                        </Badge>
                      </Group>
                    </Card>
                  ))}
                </SimpleGrid>
              </Stack>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

function safeDiagnostics(report: NativeProviderEnvironmentReport) {
  return {
    home: report.home,
    cli: report.cli,
    targets: report.targets,
    currentProvider: report.currentProvider,
    conflicts: report.conflicts,
    alignment: report.alignment,
    pendingRecovery: report.pendingRecovery,
  };
}
