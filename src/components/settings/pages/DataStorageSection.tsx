import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { Alert, Badge, Box, Button, Card, Group, Loader, Stack, Text } from "@mantine/core";
import { AlertTriangle, FolderOpen, HardDrive, Info, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../../../lib/i18n";
import { getOsPlatform } from "../../../lib/shell";
import { useBackgroundOperationStore } from "../../../stores/backgroundOperationStore";
import { useSshAgentIntegrationStore } from "../../../stores/sshAgentIntegrationStore";
import { useTerminalStore } from "../../../stores/terminalStore";
import { useUpdateStore } from "../../../stores/updateStore";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";

type DataStorageMode = "default" | "custom";

interface DataStorageStatus {
  supported: boolean;
  distribution: "standalone" | "portable" | "aur";
  mode: DataStorageMode;
  currentDataDir: string;
  defaultDataDir: string;
  bootstrapPath: string | null;
  lastError: string | null;
}

interface DataStorageInspection {
  targetDir: string;
  exists: boolean;
  empty: boolean;
  writable: boolean;
  sameAsCurrent: boolean;
}

interface SwitchRequest {
  mode: DataStorageMode;
  inspection: DataStorageInspection;
}

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

function dataStorageErrorMessage(error: unknown, t: Translate): string {
  const raw = String(error);
  if (raw.includes("data_storage_tasks_active")) return t("settings.dataStorage.error.tasksActive");
  if (raw.includes("data_storage_target_not_empty")) return t("settings.dataStorage.error.targetNotEmpty");
  if (raw.includes("data_storage_target_not_writable")) return t("settings.dataStorage.error.targetNotWritable");
  if (raw.includes("data_storage_source_target_overlap")) return t("settings.dataStorage.error.pathOverlap");
  if (raw.includes("data_storage_target_is_current")) return t("settings.dataStorage.error.samePath");
  if (raw.includes("data_storage_path_is_symlink") || raw.includes("data_storage_bootstrap_is_symlink")) {
    return t("settings.dataStorage.error.symlink");
  }
  return raw;
}

export function DataStorageSection() {
  const { t } = useI18n();
  const [status, setStatus] = useState<DataStorageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [switchRequest, setSwitchRequest] = useState<SwitchRequest | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [isWindows, setIsWindows] = useState<boolean | null>(null);
  const activeTerminalCount = useTerminalStore((state) =>
    state.sessions.filter((session) => {
      const sessionStatus = state.sessionStatuses[session.id];
      return sessionStatus !== "exited" && sessionStatus !== "error";
    }).length
  );
  const hasRunningBackgroundOperation = useBackgroundOperationStore((state) =>
    Object.values(state.operations).some((operation) => operation.status === "running")
  );
  const hasRunningAgentInstall = useSshAgentIntegrationStore((state) =>
    Object.values(state.agentInstallJobs).some((job) => job.status === "running")
  );
  const updateBusy = useUpdateStore((state) => state.checking || state.downloading || state.installing);
  const tasksActive = activeTerminalCount > 0
    || hasRunningBackgroundOperation
    || hasRunningAgentInstall
    || updateBusy;

  useEffect(() => {
    let cancelled = false;
    void getOsPlatform().then(async (platform) => {
      if (cancelled) return;
      if (platform !== "windows") {
        setIsWindows(false);
        setLoading(false);
        return;
      }
      setIsWindows(true);
      try {
        const nextStatus = await invoke<DataStorageStatus>("app_get_data_storage_status");
        if (!cancelled) setStatus(nextStatus);
      } catch (error) {
        if (!cancelled) setLoadError(dataStorageErrorMessage(error, t));
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const distributionLabel = useMemo(() => {
    if (status?.distribution === "portable") return t("settings.dataStorage.distributionPortable");
    return t("settings.dataStorage.distributionInstalled");
  }, [status?.distribution, t]);

  const inspectTarget = async (mode: DataStorageMode, targetDir: string) => {
    if (tasksActive) {
      toast.error(t("settings.dataStorage.error.tasksActive"));
      return;
    }
    setInspecting(true);
    try {
      const inspection = await invoke<DataStorageInspection>("app_inspect_data_dir", { targetDir });
      if (inspection.sameAsCurrent) {
        toast.info(t("settings.dataStorage.error.samePath"));
        return;
      }
      setSwitchRequest({ mode, inspection });
    } catch (error) {
      toast.error(t("settings.dataStorage.inspectFailed"), {
        description: dataStorageErrorMessage(error, t),
      });
    } finally {
      setInspecting(false);
    }
  };

  const chooseCustomDirectory = async () => {
    if (!status || inspecting || switching) return;
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: status.currentDataDir,
        title: t("settings.dataStorage.chooseDialogTitle"),
      });
      if (typeof selected !== "string") return;
      await inspectTarget("custom", selected);
    } catch (error) {
      toast.error(t("settings.dataStorage.inspectFailed"), {
        description: dataStorageErrorMessage(error, t),
      });
    }
  };

  const restoreDefaultDirectory = async () => {
    if (!status || status.mode === "default" || inspecting || switching) return;
    await inspectTarget("default", status.defaultDataDir);
  };

  const prepareSwitchAndRelaunch = async (migrate: boolean) => {
    if (!switchRequest || switching || tasksActive || !switchRequest.inspection.writable) return;
    setSwitching(true);
    try {
      await invoke<string>("app_prepare_data_dir_switch", {
        targetMode: switchRequest.mode,
        targetDir: switchRequest.mode === "custom" ? switchRequest.inspection.targetDir : null,
        migrate,
      });
      await relaunch();
    } catch (error) {
      toast.error(t("settings.dataStorage.switchFailed"), {
        description: dataStorageErrorMessage(error, t),
      });
      setSwitching(false);
    }
  };

  if (isWindows !== true) return null;

  return (
    <>
      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
            <Group gap="sm" align="flex-start" wrap="nowrap" style={{ minWidth: 0 }}>
              <Box mt={2} c="var(--primary)">
                <HardDrive size={18} />
              </Box>
              <Box style={{ minWidth: 0 }}>
                <Text size="sm" fw={600} c="var(--on-surface)">
                  {t("settings.dataStorage.title")}
                </Text>
                <Text mt={3} size="xs" lh={1.55} c="var(--text-muted)">
                  {t("settings.dataStorage.description")}
                </Text>
              </Box>
            </Group>
            {status && (
              <Group gap="xs">
                <Badge variant="light" color={status.distribution === "portable" ? "teal" : "blue"}>
                  {distributionLabel}
                </Badge>
                <Badge variant="light" color={status.mode === "custom" ? "violet" : "gray"}>
                  {status.mode === "custom"
                    ? t("settings.dataStorage.modeCustom")
                    : t("settings.dataStorage.modeDefault")}
                </Badge>
              </Group>
            )}
          </Group>

          {loading ? (
            <Group justify="center" py="md">
              <Loader size="sm" />
            </Group>
          ) : loadError ? (
            <Alert color="red" icon={<AlertTriangle size={16} />}>
              {loadError}
            </Alert>
          ) : status ? (
            <>
              <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
                <Stack gap="sm">
                  <Box>
                    <Text size="xs" fw={600} c="var(--on-surface-variant)">
                      {t("settings.dataStorage.currentPath")}
                    </Text>
                    <Text mt={4} size="xs" ff="monospace" c="var(--on-surface)" style={{ overflowWrap: "anywhere" }}>
                      {status.currentDataDir}
                    </Text>
                  </Box>
                  <Box>
                    <Text size="xs" fw={600} c="var(--on-surface-variant)">
                      {t("settings.dataStorage.defaultPath")}
                    </Text>
                    <Text mt={4} size="xs" ff="monospace" c="var(--text-muted)" style={{ overflowWrap: "anywhere" }}>
                      {status.defaultDataDir}
                    </Text>
                  </Box>
                </Stack>
              </Card>

              {status.lastError && (
                <Alert color="red" icon={<AlertTriangle size={16} />} title={t("settings.dataStorage.lastErrorTitle")}>
                  <Text size="xs" style={{ overflowWrap: "anywhere" }}>{status.lastError}</Text>
                </Alert>
              )}

              {tasksActive && (
                <Alert color="yellow" icon={<Info size={16} />}>
                  {t("settings.dataStorage.tasksActiveHint")}
                </Alert>
              )}

              <Group gap="sm" wrap="wrap">
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<FolderOpen size={14} />}
                  loading={inspecting}
                  disabled={tasksActive || switching}
                  onClick={() => void chooseCustomDirectory()}
                >
                  {t("settings.dataStorage.chooseCustom")}
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<RotateCcw size={14} />}
                  loading={inspecting}
                  disabled={status.mode === "default" || tasksActive || switching}
                  onClick={() => void restoreDefaultDirectory()}
                >
                  {t("settings.dataStorage.restoreDefault")}
                </Button>
              </Group>
            </>
          ) : null}
        </Stack>
      </section>

      <Dialog
        open={switchRequest !== null}
        onOpenChange={(open) => {
          if (!open && !switching) setSwitchRequest(null);
        }}
      >
        <DialogContent className="max-w-[520px]" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("settings.dataStorage.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {switchRequest?.inspection.empty
                ? t("settings.dataStorage.confirmEmptyDescription")
                : t("settings.dataStorage.confirmNonEmptyDescription")}
            </DialogDescription>
          </DialogHeader>
          {switchRequest && (
            <Stack gap="sm">
              <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
                <Text size="xs" ff="monospace" style={{ overflowWrap: "anywhere" }}>
                  {switchRequest.inspection.targetDir}
                </Text>
              </Card>
              {!switchRequest.inspection.writable && (
                <Alert color="red" icon={<AlertTriangle size={16} />}>
                  {t("settings.dataStorage.error.targetNotWritable")}
                </Alert>
              )}
            </Stack>
          )}
          <DialogFooter className="flex-wrap">
            <Button variant="default" disabled={switching} onClick={() => setSwitchRequest(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="light"
              disabled={switching || tasksActive || !switchRequest?.inspection.writable}
              onClick={() => void prepareSwitchAndRelaunch(false)}
            >
              {switching ? t("settings.dataStorage.switching") : t("settings.dataStorage.useWithoutMigration")}
            </Button>
            {switchRequest?.inspection.empty && (
              <Button
                loading={switching}
                disabled={tasksActive || !switchRequest.inspection.writable}
                onClick={() => void prepareSwitchAndRelaunch(true)}
              >
                {t("settings.dataStorage.migrateAndRestart")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
