import { useEffect, useMemo, useState } from "react";
import { Button, Card, Checkbox, Group, Modal, PasswordInput, Select, Stack, Switch, Text, TextInput } from "@mantine/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useI18n } from "../../../lib/i18n";
import { useSyncStore, type BackupDomain, type BackupMode, type BackupSnapshotInfo, type BackupSnapshotV3 } from "../../../stores/syncStore";
import { Check, Cloud, Download, Folder, Trash2, Upload } from "../../icons";

const DOMAINS: BackupDomain[] = ["workspace", "preferences", "model_prices", "notifications", "statusline"];
const ERROR_KEY_BY_CODE = {
  backup_validation_failed: "settings.sync.backup.error.validation",
  backup_unsupported_format: "settings.sync.backup.error.unsupported",
  backup_invalid_v3: "settings.sync.backup.error.invalidV3",
  backup_device_name_required: "settings.sync.backup.error.deviceName",
  backup_local_directory_required: "settings.sync.backup.error.localDirectory",
  backup_webdav_required: "settings.sync.backup.error.webdav",
  backup_no_restore_to_undo: "settings.sync.backup.error.noUndo",
  backup_queued: "settings.sync.backup.queued",
} as const;

export function SyncSettingsPage() {
  const { language, t } = useI18n();
  const store = useSyncStore();
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [remoteDir, setRemoteDir] = useState("");
  const [testing, setTesting] = useState(false);
  const [selectedSnapshot, setSelectedSnapshot] = useState<BackupSnapshotInfo | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<BackupSnapshotV3 | null>(null);
  const [selectedDomains, setSelectedDomains] = useState<BackupDomain[]>([...DOMAINS]);
  const [localImportPath, setLocalImportPath] = useState<string | null>(null);
  const [localPreview, setLocalPreview] = useState<BackupSnapshotV3 | null>(null);
  const [deleteSnapshot, setDeleteSnapshot] = useState<BackupSnapshotInfo | null>(null);
  const [legacyImportOpen, setLegacyImportOpen] = useState(false);

  useEffect(() => { if (!store.loaded) void store.load(); }, [store.loaded, store.load]);
  useEffect(() => {
    if (!store.loaded) return;
    setUrl(store.webdavUrl); setUsername(store.webdavUsername); setPassword(store.getSessionPassword());
    setDeviceName(store.deviceName); setRemoteDir(store.remoteDir);
  }, [store.loaded, store.webdavUrl, store.webdavUsername, store.deviceName, store.remoteDir, store.getSessionPassword]);
  useEffect(() => {
    if (store.loaded && store.backupMode === "cloud" && store.hasPassword) void store.listBackups();
  }, [store.loaded, store.backupMode, store.hasPassword, store.listBackups]);

  const domainOptions = useMemo(() => DOMAINS.map((domain) => ({ domain, label: t(`settings.sync.backup.domain.${domain}`) })), [t]);
  const busy = store.status === "backing_up" || store.status === "restoring";
  const formatTime = (value: string) => new Date(value).toLocaleString(language, { hour12: false });
  const errorMessage = (error: unknown) => {
    const code = error instanceof Error ? error.message : String(error);
    const key = ERROR_KEY_BY_CODE[code as keyof typeof ERROR_KEY_BY_CODE];
    return key ? t(key) : code;
  };

  const saveConnection = async (test: boolean) => {
    if (!url.trim()) return toast.error(t("settings.sync.backup.webdavRequired"));
    setTesting(test);
    try {
      if (test) {
        const result = await store.testConnection(url.trim(), username.trim(), password);
        if (!result.success) throw new Error(result.message);
      }
      await store.setConfig(url.trim(), username.trim(), password || undefined);
      toast.success(test ? t("settings.sync.backup.connectionPassed") : t("settings.sync.backup.saved"));
    } catch (error) {
      toast.error(t("settings.sync.backup.operationFailed"), { description: errorMessage(error) });
    } finally { setTesting(false); }
  };

  const saveIdentity = async () => {
    try {
      await store.setDeviceName(deviceName); await store.setRemoteDir(remoteDir.trim());
      toast.success(t("settings.sync.backup.saved"));
    } catch (error) { toast.error(t("settings.sync.backup.operationFailed"), { description: errorMessage(error) }); }
  };

  const createBackup = async () => {
    try {
      const path = await store.createBackup(true);
      toast.success(t("settings.sync.backup.created"), path ? { description: path } : undefined);
      if (store.backupMode === "cloud") await store.listBackups();
    } catch (error) {
      if (error instanceof Error && error.message === "backup_queued") toast.warning(t("settings.sync.backup.queued"));
      else toast.error(t("settings.sync.backup.operationFailed"), { description: errorMessage(error) });
    }
  };

  const pickLocalDir = async () => {
    const result = await openDialog({ directory: true, multiple: false, title: t("settings.sync.backup.chooseDirectory") });
    if (typeof result === "string") await store.setLocalBackupDir(result);
  };

  const pickImport = async () => {
    const result = await openDialog({ directory: false, multiple: false, filters: [{ name: "ZIP", extensions: ["zip"] }] });
    if (typeof result === "string") {
      try {
        const preview = await store.previewLocalImport(result);
        setSelectedDomains([...DOMAINS]); setLocalPreview(preview); setLocalImportPath(result);
      } catch (error) { toast.error(t("settings.sync.backup.operationFailed"), { description: errorMessage(error) }); }
    }
  };

  const restoreCloud = async () => {
    if (!selectedSnapshot || selectedDomains.length === 0) return;
    try {
      await store.restoreBackup(selectedSnapshot.remotePath, selectedDomains);
      toast.success(t("settings.sync.backup.restored")); setSelectedSnapshot(null); setSelectedPreview(null);
    } catch (error) { toast.error(t("settings.sync.backup.operationFailed"), { description: errorMessage(error) }); }
  };

  const openRestorePreview = async (snapshot: BackupSnapshotInfo) => {
    try {
      const preview = await store.previewBackup(snapshot.remotePath);
      setSelectedDomains([...DOMAINS]); setSelectedSnapshot(snapshot); setSelectedPreview(preview);
    } catch (error) { toast.error(t("settings.sync.backup.operationFailed"), { description: errorMessage(error) }); }
  };

  const restoreLocal = async () => {
    if (!localImportPath || selectedDomains.length === 0) return;
    try {
      await store.localImport(localImportPath, selectedDomains);
      toast.success(t("settings.sync.backup.restored")); setLocalImportPath(null); setLocalPreview(null);
    } catch (error) { toast.error(t("settings.sync.backup.operationFailed"), { description: errorMessage(error) }); }
  };

  const domainSelector = (
    <Stack gap="xs">
      <Text size="sm" fw={600}>{t("settings.sync.backup.restoreDomains")}</Text>
      <Group gap="md">
        {domainOptions.map(({ domain, label }) => (
          <Checkbox key={domain} checked={selectedDomains.includes(domain)} label={label}
            onChange={() => setSelectedDomains((current) => current.includes(domain) ? current.filter((item) => item !== domain) : [...current, domain])} />
        ))}
      </Group>
    </Stack>
  );
  const previewSummary = (preview: BackupSnapshotV3) => t("settings.sync.backup.previewSummary", {
    projects: preview.data.workspace.projects.length, groups: preview.data.workspace.groups.length,
    worktrees: preview.data.workspace.worktrees.length, templates: preview.data.workspace.commandTemplates.length,
    settings: Object.keys(preview.data.preferences).length, prices: preview.data.modelPrices.length,
    targets: preview.data.notifications.targets.length,
  });

  return (
    <Stack gap="md">
      <Card className="border border-yellow-500/30 bg-yellow-500/10" p="md" radius="lg">
        <Text size="sm" fw={600} c="yellow">{t("settings.sync.backup.plaintextTitle")}</Text>
        <Text mt={4} size="sm" c="var(--on-surface-variant)">{t("settings.sync.backup.plaintextWarning")}</Text>
      </Card>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="md">
          <Text fw={600}>{t("settings.sync.backup.modeTitle")}</Text>
          <Select<BackupMode> value={store.backupMode} allowDeselect={false}
            data={[{ value: "cloud", label: t("settings.sync.backup.modeCloud") }, { value: "local", label: t("settings.sync.backup.modeLocal") }]}
            onChange={(value) => value && void store.setBackupMode(value)} />
          <Switch checked={store.autoBackupOnClose} onChange={(event) => void store.setAutoBackupOnClose(event.currentTarget.checked)}
            label={t("settings.sync.backup.autoOnClose")} />
        </Stack>
      </section>

      {store.backupMode === "cloud" ? (
        <>
          <section className="ui-surface-card rounded-2xl border border-border p-4">
            <Stack gap="md">
              <Text fw={600}>{t("settings.sync.backup.webdavTitle")}</Text>
              <TextInput label="WebDAV URL" value={url} onChange={(event) => setUrl(event.currentTarget.value)} />
              <Group grow>
                <TextInput label={t("settings.sync.backup.username")} value={username} onChange={(event) => setUsername(event.currentTarget.value)} />
                <PasswordInput label={t("settings.sync.backup.password")} value={password} onChange={(event) => setPassword(event.currentTarget.value)} />
              </Group>
              <Group grow>
                <TextInput label={t("settings.sync.backup.deviceName")} value={deviceName} onChange={(event) => setDeviceName(event.currentTarget.value)} />
                <TextInput label={t("settings.sync.backup.remoteDirectory")} value={remoteDir} onChange={(event) => setRemoteDir(event.currentTarget.value)} placeholder="cli-manager" />
              </Group>
              <Group>
                <Button size="xs" onClick={() => void saveConnection(true)} loading={testing}>{t("settings.sync.backup.testConnection")}</Button>
                <Button size="xs" variant="default" onClick={() => void saveConnection(false)}>{t("settings.sync.backup.saveConnection")}</Button>
                <Button size="xs" variant="default" onClick={() => void saveIdentity()}>{t("settings.sync.backup.saveIdentity")}</Button>
                {store.hasPassword && <Group gap={4} c="var(--success)"><Check size={14} /><Text size="xs">{t("settings.sync.backup.configured")}</Text></Group>}
              </Group>
            </Stack>
          </section>

          <section className="ui-surface-card rounded-2xl border border-border p-4">
            <Stack gap="md">
              <Group justify="space-between">
                <Text fw={600}>{t("settings.sync.backup.cloudSnapshots")}</Text>
                <Group gap="xs">
                  <Button size="xs" leftSection={<Upload size={14} />} disabled={!store.hasPassword || busy} onClick={() => void createBackup()}>{t("settings.sync.backup.createNow")}</Button>
                  <Button size="xs" variant="default" leftSection={<Cloud size={14} />} disabled={!store.hasPassword || busy} onClick={() => void store.listBackups()}>{t("settings.sync.backup.refresh")}</Button>
                  <Button size="xs" variant="subtle" disabled={!store.hasPassword || busy} onClick={() => { setSelectedDomains([...DOMAINS]); setLegacyImportOpen(true); }}>{t("settings.sync.backup.importLegacyCloud")}</Button>
                </Group>
              </Group>
              {store.snapshots.length === 0 ? <Text size="sm" c="var(--on-surface-variant)">{t("settings.sync.backup.empty")}</Text> : store.snapshots.map((snapshot) => (
                <Card key={snapshot.remotePath} className="bg-surface-container-low" p="sm" radius="lg">
                  <Group justify="space-between" wrap="nowrap">
                    <Stack gap={2}>
                      <Text size="sm" fw={600}>{snapshot.manifest.deviceName}</Text>
                      <Text size="xs" c="var(--on-surface-variant)">{formatTime(snapshot.manifest.createdAt)} · {snapshot.manifest.appVersion}</Text>
                    </Stack>
                    <Group gap="xs">
                      <Button size="xs" variant="default" leftSection={<Download size={14} />} onClick={() => void openRestorePreview(snapshot)}>{t("settings.sync.backup.restore")}</Button>
                      <Button size="xs" variant="subtle" color="red" leftSection={<Trash2 size={14} />} onClick={() => setDeleteSnapshot(snapshot)}>{t("settings.sync.backup.delete")}</Button>
                    </Group>
                  </Group>
                </Card>
              ))}
            </Stack>
          </section>
        </>
      ) : (
        <section className="ui-surface-card rounded-2xl border border-border p-4">
          <Stack gap="md">
            <Text fw={600}>{t("settings.sync.backup.localTitle")}</Text>
            <Group wrap="nowrap">
              <TextInput className="flex-1" readOnly value={store.localBackupDir} placeholder={t("settings.sync.backup.noDirectory")} />
              <Button variant="default" leftSection={<Folder size={14} />} onClick={() => void pickLocalDir()}>{t("settings.sync.backup.chooseDirectory")}</Button>
            </Group>
            <Group>
              <Button leftSection={<Upload size={14} />} disabled={!store.localBackupDir || busy} onClick={() => void createBackup()}>{t("settings.sync.backup.exportZip")}</Button>
              <Button variant="default" leftSection={<Download size={14} />} disabled={busy} onClick={() => void pickImport()}>{t("settings.sync.backup.importZip")}</Button>
            </Group>
          </Stack>
        </section>
      )}

      <Button variant="subtle" size="xs" disabled={busy} onClick={() => void store.undoLastRestore().then(() => toast.success(t("settings.sync.backup.undoDone"))).catch((error) => toast.error(t("settings.sync.backup.operationFailed"), { description: errorMessage(error) }))}>
        {t("settings.sync.backup.undoRestore")}
      </Button>

      <Modal opened={Boolean(selectedSnapshot)} onClose={() => { setSelectedSnapshot(null); setSelectedPreview(null); }} title={t("settings.sync.backup.confirmRestore")} centered>
        <Stack gap="md">
          {selectedPreview && <Card className="bg-surface-container-low" p="sm" radius="lg"><Text size="sm">{previewSummary(selectedPreview)}</Text></Card>}
          {domainSelector}<Text size="sm" c="var(--on-surface-variant)">{t("settings.sync.backup.restoreSafetyNote")}</Text><Group justify="flex-end"><Button variant="default" onClick={() => { setSelectedSnapshot(null); setSelectedPreview(null); }}>{t("common.cancel")}</Button><Button color="red" disabled={selectedDomains.length === 0} onClick={() => void restoreCloud()}>{t("settings.sync.backup.confirm")}</Button></Group>
        </Stack>
      </Modal>
      <Modal opened={Boolean(localImportPath)} onClose={() => { setLocalImportPath(null); setLocalPreview(null); }} title={t("settings.sync.backup.confirmImport")} centered>
        <Stack gap="md">{localPreview && <Card className="bg-surface-container-low" p="sm" radius="lg"><Text size="sm">{previewSummary(localPreview)}</Text></Card>}{domainSelector}<Text size="sm" c="var(--on-surface-variant)">{localImportPath}</Text><Text size="sm" c="var(--on-surface-variant)">{t("settings.sync.backup.restoreSafetyNote")}</Text><Group justify="flex-end"><Button variant="default" onClick={() => { setLocalImportPath(null); setLocalPreview(null); }}>{t("common.cancel")}</Button><Button color="red" disabled={selectedDomains.length === 0} onClick={() => void restoreLocal()}>{t("settings.sync.backup.confirm")}</Button></Group></Stack>
      </Modal>
      <Modal opened={Boolean(deleteSnapshot)} onClose={() => setDeleteSnapshot(null)} title={t("settings.sync.backup.confirmDelete")} centered>
        <Stack gap="md">
          <Text size="sm" c="var(--on-surface-variant)">{t("settings.sync.backup.deleteWarning")}</Text>
          <Group justify="flex-end"><Button variant="default" onClick={() => setDeleteSnapshot(null)}>{t("common.cancel")}</Button><Button color="red" onClick={() => { const snapshot = deleteSnapshot; setDeleteSnapshot(null); if (snapshot) void store.deleteBackup(snapshot.remotePath).catch((error) => toast.error(t("settings.sync.backup.operationFailed"), { description: errorMessage(error) })); }}>{t("settings.sync.backup.delete")}</Button></Group>
        </Stack>
      </Modal>
      <Modal opened={legacyImportOpen} onClose={() => setLegacyImportOpen(false)} title={t("settings.sync.backup.confirmLegacyImport")} centered>
        <Stack gap="md">{domainSelector}<Text size="sm" c="var(--on-surface-variant)">{t("settings.sync.backup.legacyImportNote")}</Text><Group justify="flex-end"><Button variant="default" onClick={() => setLegacyImportOpen(false)}>{t("common.cancel")}</Button><Button color="red" disabled={selectedDomains.length === 0} onClick={() => { setLegacyImportOpen(false); void store.importLegacyCloud(selectedDomains).then(() => toast.success(t("settings.sync.backup.restored"))).catch((error) => toast.error(t("settings.sync.backup.operationFailed"), { description: errorMessage(error) })); }}>{t("settings.sync.backup.confirm")}</Button></Group></Stack>
      </Modal>
    </Stack>
  );
}
