import { useState, useEffect } from "react";
import {
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  Modal,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  UnstyledButton,
} from "@mantine/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  useSyncStore,
  type AutoSyncAction,
  type SyncDataDomain,
  type SyncMode,
  type SyncPreview,
} from "../../../stores/syncStore";
import {
  Cloud,
  Download,
  Upload,
  AlertTriangle,
  Check,
  Folder,
} from "../../icons";
import { toast } from "sonner";
import { useI18n } from "../../../lib/i18n";

const SYNC_MODE_OPTIONS: { value: SyncMode; label: string; labelEn: string; description: string; descriptionEn: string }[] = [
  { value: "cloud", label: "云同步", labelEn: "Cloud Sync", description: "通过 WebDAV 协议同步到云端", descriptionEn: "Sync to cloud via WebDAV" },
  { value: "local", label: "本地同步", labelEn: "Local Sync", description: "将配置打包为 zip 保存到本地目录", descriptionEn: "Package configuration as a zip in a local directory" },
];

const AUTO_SYNC_OPTIONS: { value: AutoSyncAction; label: string; labelEn: string }[] = [
  { value: "off", label: "关闭", labelEn: "Off" },
  { value: "upload", label: "上传", labelEn: "Upload" },
  { value: "download", label: "下载", labelEn: "Download" },
];

const DOMAIN_OPTIONS: { value: SyncDataDomain; label: string; labelEn: string }[] = [
  { value: "projects", label: "项目", labelEn: "Projects" },
  { value: "groups", label: "分组", labelEn: "Groups" },
  { value: "command_templates", label: "命令模板", labelEn: "Command Templates" },
  { value: "application_settings", label: "应用设置", labelEn: "Application Settings" },
  { value: "model_prices", label: "模型价格", labelEn: "Model Prices" },
  { value: "third_party_hook_notifications", label: "", labelEn: "" },
];

export function SyncSettingsPage() {
  const { language, t } = useI18n();
  const text = (zh: string, en: string) => (language === "zh-CN" ? zh : en);
  const {
    webdavUrl,
    webdavUsername,
    hasPassword,
    status,
    lastSyncAt,
    conflictInfo,
    loaded,
    syncMode,
    localSyncDir,
    remoteDir,
    deviceName,
    knownDeviceNames,
    autoSyncOnStartup,
    autoSyncOnClose,
    load,
    setConfig,
    clearPassword,
    getSessionPassword,
    testConnection,
    setDeviceName,
    setAutoSyncOnStartup,
    setAutoSyncOnClose,
    upload,
    download,
    getPreview,
    resolveConflict,
    clearConflict,
    setSyncMode,
    setLocalSyncDir,
    setRemoteDir,
    localExport,
    localImport,
  } = useSyncStore();

  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deviceNameInput, setDeviceNameInput] = useState("");
  const [remoteDirInput, setRemoteDirInput] = useState("");
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [previewMode, setPreviewMode] = useState<"upload" | "download" | null>(null);
  const [previewDeviceName, setPreviewDeviceName] = useState("");
  const [selectedDomains, setSelectedDomains] = useState<SyncDataDomain[]>([
    "projects",
    "groups",
    "command_templates",
    "application_settings",
    "model_prices",
    "third_party_hook_notifications",
  ]);
  const [showImportConfirm, setShowImportConfirm] = useState<string | null>(null);
  const syncModeOptions = SYNC_MODE_OPTIONS.map((option) => ({
    ...option,
    label: language === "zh-CN" ? option.label : option.labelEn,
    description: language === "zh-CN" ? option.description : option.descriptionEn,
  }));
  const autoSyncOptions = AUTO_SYNC_OPTIONS.map((option) => ({
    value: option.value,
    label: language === "zh-CN" ? option.label : option.labelEn,
  }));
  const domainOptions = DOMAIN_OPTIONS.map((option) => ({
    value: option.value,
    label: option.value === "third_party_hook_notifications"
      ? t("settings.sync.domain.thirdPartyHookNotifications")
      : language === "zh-CN" ? option.label : option.labelEn,
  }));
  const formatDateTime = (value: string | number | Date) => new Date(value).toLocaleString(language, { hour12: false });

  useEffect(() => {
    if (!loaded) {
      void load();
    }
  }, [loaded, load]);

  useEffect(() => {
    if (loaded) {
      setUrl(webdavUrl);
      setUsername(webdavUsername);
      setPassword(getSessionPassword());
      setDeviceNameInput(deviceName);
      setRemoteDirInput(remoteDir);
      setPreviewDeviceName(deviceName);
    }
  }, [loaded, webdavUrl, webdavUsername, hasPassword, getSessionPassword, deviceName, remoteDir]);

  const handleTest = async () => {
    if (!url.trim() || !username.trim() || !password.trim()) {
      toast.error(text("请填写完整的连接信息", "Fill in the full connection information"));
      return;
    }

    setTesting(true);
    try {
      const result = await testConnection(url.trim(), username.trim(), password);
      if (result.success) {
        toast.success(text("连接成功", "Connection successful"));
        await setConfig(url.trim(), username.trim(), password);
        setShowPassword(false);
      } else {
        toast.error(text("连接失败", "Connection failed"), { description: result.message });
      }
    } catch (error) {
      toast.error(text("保存失败", "Save failed"), { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!url.trim()) {
      toast.error(text("请填写 WebDAV URL", "Enter the WebDAV URL"));
      return;
    }

    try {
      if (password.trim()) {
        await setConfig(url.trim(), username.trim(), password);
        toast.success(text("配置已保存（包含密码）", "Configuration saved with password"));
      } else {
        await setConfig(url.trim(), username.trim());
        toast.success(text("配置已保存", "Configuration saved"));
      }
    } catch (error) {
      toast.error(text("保存失败", "Save failed"), { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleSaveDeviceName = async () => {
    try {
      await setDeviceName(deviceNameInput);
      toast.success(text("设备名称已保存", "Device name saved"));
    } catch (error) {
      toast.error(text("保存失败", "Save failed"), { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleSaveRemoteDir = async () => {
    try {
      await setRemoteDir(remoteDirInput.trim());
      toast.success(text("远程目录已保存", "Remote directory saved"));
    } catch (error) {
      toast.error(text("保存失败", "Save failed"), { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const openPreview = async (mode: "upload" | "download") => {
    if (!hasPassword) {
      toast.error(text("请先配置并测试 WebDAV 连接", "Configure and test the WebDAV connection first"));
      return;
    }
    try {
      const nextPreview = await getPreview(previewDeviceName || deviceName);
      if (mode === "download" && nextPreview.remote.missing) {
        toast.error(text("无法从云端同步", "Cannot sync from cloud"));
        return;
      }
      setPreview(nextPreview);
      setPreviewMode(mode);
      setSelectedDomains([
        "projects",
        "groups",
        "command_templates",
        "application_settings",
        "model_prices",
        "third_party_hook_notifications",
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(mode === "upload" ? text("读取同步摘要失败", "Failed to read sync summary") : text("读取云端快照失败", "Failed to read cloud snapshot"), { description: message });
    }
  };

  const confirmPreviewAction = async () => {
    if (!previewMode) return;
    if (previewMode === "download" && preview?.remote.missing) {
      toast.error(text("无法从云端同步", "Cannot sync from cloud"));
      return;
    }
    try {
      if (previewMode === "upload") {
        await upload();
        toast.success(text("上传成功", "Upload successful"));
      } else {
        await download(true, { deviceName: previewDeviceName || deviceName, domains: selectedDomains });
        toast.success(text("下载成功", "Download successful"));
      }
      setPreview(null);
      setPreviewMode(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(previewMode === "upload" ? text("上传失败", "Upload failed") : text("下载失败", "Download failed"), { description: message });
    }
  };

  const toggleDomain = (domain: SyncDataDomain) => {
    setSelectedDomains((current) =>
      current.includes(domain) ? current.filter((item) => item !== domain) : [...current, domain]
    );
  };

  const handlePickLocalDir = async () => {
    try {
      const result = await openDialog({ directory: true, multiple: false, title: text("选择本地同步目录", "Choose local sync directory") });
      if (typeof result === "string" && result.length > 0) {
        await setLocalSyncDir(result);
      }
    } catch (error) {
      toast.error(text("选择目录失败", "Failed to choose directory"), { description: String(error) });
    }
  };

  const handleLocalExport = async () => {
    if (!localSyncDir) {
      toast.error(text("请先选择本地同步目录", "Choose a local sync directory first"));
      return;
    }
    try {
      const path = await localExport();
      toast.success(text("本地导出成功", "Local export successful"), { description: path });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(text("本地导出失败", "Local export failed"), { description: message });
    }
  };

  const handleLocalImportPick = async () => {
    try {
      const result = await openDialog({
        directory: false,
        multiple: false,
        title: text("选择要导入的同步 zip 文件", "Choose sync zip file to import"),
        filters: [{ name: text("同步包", "Sync Package"), extensions: ["zip"] }],
        defaultPath: localSyncDir || undefined,
      });
      if (typeof result === "string" && result.length > 0) {
        setShowImportConfirm(result);
      }
    } catch (error) {
      toast.error(text("选择文件失败", "Failed to choose file"), { description: String(error) });
    }
  };

  const confirmLocalImport = async () => {
    const zipPath = showImportConfirm;
    setShowImportConfirm(null);
    if (!zipPath) return;
    try {
      await localImport(zipPath);
      toast.success(text("本地导入成功", "Local import successful"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(text("本地导入失败", "Local import failed"), { description: message });
    }
  };

  const formatLastSync = () => {
    if (!lastSyncAt) return text("从未同步", "Never synced");
    return formatDateTime(lastSyncAt);
  };

  return (
    <Stack gap="md">
      {conflictInfo && (
        <Card className="border border-yellow-500/30 bg-yellow-500/10" p="md" radius="lg">
          <Group align="flex-start" gap="sm" wrap="nowrap">
            <ThemeIcon variant="light" color="yellow" size="sm">
              <AlertTriangle size={16} />
            </ThemeIcon>
            <Stack gap="sm" className="flex-1">
              <Box>
                <Text fw={600} c="yellow">
                  {text("检测到同步冲突", "Sync Conflict Detected")}
                </Text>
                <Text mt={4} size="sm" c="var(--on-surface-variant)">
                  {text("本地和远程都有更新，请选择保留哪个版本。", "Both local and remote data changed. Choose which version to keep.")}
                </Text>
              </Box>
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                <Card className="bg-surface-container-high" p="sm" radius="lg">
                  <Text fw={600}>{text("本地版本", "Local Version")}</Text>
                  <Text mt={4} size="sm" c="var(--on-surface-variant)">
                    {formatDateTime(conflictInfo.local_modified)}
                  </Text>
                  <Text mt={8} size="xs">
                    {text(
                      `${conflictInfo.local_projects} 个项目 · ${conflictInfo.local_groups} 个分组 · ${conflictInfo.local_templates} 个模板`,
                      `${conflictInfo.local_projects} projects · ${conflictInfo.local_groups} groups · ${conflictInfo.local_templates} templates`
                    )}
                  </Text>
                </Card>
                <Card className="bg-surface-container-high" p="sm" radius="lg">
                  <Text fw={600}>{text("远程版本", "Remote Version")}</Text>
                  <Text mt={4} size="sm" c="var(--on-surface-variant)">
                    {formatDateTime(conflictInfo.remote_modified)}
                  </Text>
                  <Text mt={8} size="xs">
                    {text(
                      `${conflictInfo.remote_projects} 个项目 · ${conflictInfo.remote_groups} 个分组 · ${conflictInfo.remote_templates} 个模板`,
                      `${conflictInfo.remote_projects} projects · ${conflictInfo.remote_groups} groups · ${conflictInfo.remote_templates} templates`
                    )}
                  </Text>
                </Card>
              </SimpleGrid>
              <Group gap="xs">
                <Button size="xs" color="cliPrimary" onClick={() => resolveConflict(true)}>
                  {text("保留本地", "Keep Local")}
                </Button>
                <Button size="xs" variant="default" color="gray" onClick={() => resolveConflict(false)}>
                  {text("使用远程", "Use Remote")}
                </Button>
                <Button size="xs" variant="subtle" color="gray" onClick={clearConflict}>
                  {text("取消", "Cancel")}
                </Button>
              </Group>
            </Stack>
          </Group>
        </Card>
      )}

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="sm">
          <Text size="sm" fw={600} c="var(--on-surface)">
            {text("同步方式", "Sync Mode")}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
          {syncModeOptions.map((opt) => {
            const active = syncMode === opt.value;
            return (
              <UnstyledButton
                key={opt.value}
                onClick={() => void setSyncMode(opt.value)}
                className="ui-interactive ui-focus-ring ui-selection-card rounded-xl border text-left"
                data-selected={active ? "true" : "false"}
                aria-pressed={active}
                w="100%"
                style={{
                  display: "block",
                  minHeight: 76,
                  minWidth: 0,
                  padding: "14px 16px",
                  whiteSpace: "normal",
                }}
              >
                <Stack gap={4} style={{ minWidth: 0 }}>
                  <Text size="sm" fw={600} c="var(--on-surface)" style={{ lineHeight: 1.25 }}>
                    {opt.label}
                  </Text>
                  <Text size="xs" lh={1.45} c="var(--on-surface-variant)" style={{ overflowWrap: "anywhere" }}>
                    {opt.description}
                  </Text>
                </Stack>
              </UnstyledButton>
            );
          })}
          </SimpleGrid>
        </Stack>
      </section>

      {syncMode === "cloud" && (
        <>
          <section className="ui-surface-card rounded-2xl border border-border p-4">
            <Stack gap="md">
              <Text size="sm" fw={600} c="var(--on-surface)">
                {text("WebDAV 配置", "WebDAV Configuration")}
              </Text>

              <TextInput
                  label={text("服务器地址", "Server URL")}
                  type="url"
                  value={url}
                  onChange={(event) => setUrl(event.currentTarget.value)}
                  placeholder="https://dav.example.com/webdav"
                  size="sm"
                  aria-label={text("WebDAV 服务器地址", "WebDAV server URL")}
              />

              <Box>
                <Group align="flex-end" gap="xs" wrap="nowrap">
                  <TextInput
                    label={text("远程目录", "Remote Directory")}
                    type="text"
                    value={remoteDirInput}
                    onChange={(event) => setRemoteDirInput(event.currentTarget.value)}
                    placeholder={text("cli-manager（默认）", "cli-manager (default)")}
                    size="sm"
                    className="flex-1"
                    aria-label={text("远程目录", "Remote Directory")}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    color="gray"
                    onClick={handleSaveRemoteDir}
                  >
                    {text("保存目录", "Save Directory")}
                  </Button>
                </Group>
                <Text mt={4} size="xs" c="var(--on-surface-variant)">
                  {text("自定义云端存储目录，留空则使用默认 cli-manager。修改后重新上传/下载以切换命名空间。", "Customize the cloud storage directory. Leave blank to use cli-manager. Upload/download again after changing namespace.")}
                </Text>
              </Box>

              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                <TextInput
                    label={text("用户名", "Username")}
                    type="text"
                    value={username}
                    onChange={(event) => setUsername(event.currentTarget.value)}
                    placeholder="username"
                    size="sm"
                    aria-label={text("WebDAV 用户名", "WebDAV username")}
                />
                <PasswordInput
                    label={text("密码", "Password")}
                    value={password}
                    onChange={(event) => setPassword(event.currentTarget.value)}
                    placeholder="••••••••"
                    visible={showPassword}
                    onVisibilityChange={setShowPassword}
                    size="sm"
                    aria-label={text("WebDAV 密码", "WebDAV password")}
                />
              </SimpleGrid>

              <Box>
                <Group align="flex-end" gap="xs" wrap="nowrap">
                  <TextInput
                    label={text("当前设备名称", "Current Device Name")}
                    type="text"
                    value={deviceNameInput}
                    onChange={(event) => setDeviceNameInput(event.currentTarget.value)}
                    placeholder={text("当前设备", "Current device")}
                    size="sm"
                    className="flex-1"
                    aria-label={text("当前设备名称", "Current Device Name")}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    color="gray"
                    onClick={handleSaveDeviceName}
                  >
                    {text("保存设备名", "Save Device Name")}
                  </Button>
                </Group>
                <Text mt={4} size="xs" c="var(--on-surface-variant)">
                  {text("云端快照会按设备名称隔离，避免不同设备路径互相覆盖。", "Cloud snapshots are isolated by device name to avoid overwriting paths across devices.")}
                </Text>
              </Box>

              <Group gap="xs">
                <Button
                  size="xs"
                  color="cliPrimary"
                  onClick={handleTest}
                  disabled={testing || !url.trim() || !username.trim() || !password.trim()}
                >
                  {testing ? text("测试中...", "Testing...") : text("测试连接", "Test Connection")}
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  color="gray"
                  onClick={handleSave}
                >
                  {text("保存配置", "Save Configuration")}
                </Button>
                {hasPassword && (
                  <Button
                    size="xs"
                    variant="subtle"
                    color="red"
                    onClick={clearPassword}
                  >
                    {text("清除密码", "Clear Password")}
                  </Button>
                )}
              </Group>

              {hasPassword && (
                <Group gap="xs" c="var(--success)">
                  <Check size={16} />
                  <Text size="sm">{text("已配置 WebDAV 连接", "WebDAV connection configured")}</Text>
                </Group>
              )}
            </Stack>
          </section>

          <section className="ui-surface-card rounded-2xl border border-border p-4">
            <Stack gap="md">
              <Text size="sm" fw={600} c="var(--on-surface)">
                {text("云端同步操作", "Cloud Sync Actions")}
              </Text>
            {!hasPassword && (
              <Card className="border border-yellow-500/30 bg-yellow-500/10" p="sm" radius="lg">
                <Text size="sm" c="yellow">
                  {text("请先完成 WebDAV 配置并点击\"测试连接\"验证成功后再进行同步操作。", "Complete WebDAV configuration and pass Test Connection before syncing.")}
                </Text>
              </Card>
            )}

            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
              <Select<AutoSyncAction>
                  label={text("应用打开时", "When App Opens")}
                  value={autoSyncOnStartup}
                  onChange={(value) => {
                    if (value) void setAutoSyncOnStartup(value);
                  }}
                  data={autoSyncOptions}
                  allowDeselect={false}
                  size="sm"
              />
              <Select<AutoSyncAction>
                  label={text("应用关闭时", "When App Closes")}
                  value={autoSyncOnClose}
                  onChange={(value) => {
                    if (value) void setAutoSyncOnClose(value);
                  }}
                  data={autoSyncOptions}
                  allowDeselect={false}
                  size="sm"
              />
            </SimpleGrid>

            <Select<string>
                label={text("恢复设备快照", "Restore Device Snapshot")}
                value={previewDeviceName}
                onChange={(value) => setPreviewDeviceName(value ?? "")}
                data={knownDeviceNames.map((name) => ({ value: name, label: name }))}
                allowDeselect={false}
                size="sm"
            />

            <Group gap="sm">
              <Button
                size="sm"
                color="cliPrimary"
                leftSection={status === "syncing" ? undefined : <Upload size={16} />}
                onClick={() => void openPreview("upload")}
                disabled={!hasPassword || status === "syncing"}
              >
                {status === "syncing" ? text("同步中", "Syncing") : text("上传到云端", "Upload to Cloud")}
              </Button>
              <Button
                size="sm"
                variant="default"
                color="gray"
                leftSection={status === "syncing" ? undefined : <Download size={16} />}
                onClick={() => void openPreview("download")}
                disabled={!hasPassword || status === "syncing"}
              >
                {status === "syncing" ? text("同步中", "Syncing") : text("从云端下载", "Download from Cloud")}
              </Button>
            </Group>

            <Group gap="xs" c="var(--on-surface-variant)">
              <Cloud size={16} />
              <Text size="sm">{text("上次同步：", "Last sync: ")}{formatLastSync()}</Text>
            </Group>
            </Stack>
          </section>

          <Card className="border border-border bg-surface-container-high" p="md" radius="lg">
            <Text fw={600} c="var(--on-surface)">{text("使用说明", "Notes")}</Text>
            <Stack mt="xs" gap={4}>
              <Text size="sm" c="var(--on-surface-variant)">{text("支持 WebDAV 协议，可使用坚果云、InfiniCLOUD、群晖 NAS 等服务。", "Supports WebDAV services such as Nutstore, InfiniCLOUD, and Synology NAS.")}</Text>
              <Text size="sm" c="var(--on-surface-variant)">{text("上传将覆盖远程配置，下载将覆盖本地配置。", "Upload overwrites remote configuration; download overwrites local configuration.")}</Text>
              <Text size="sm" c="var(--on-surface-variant)">{text("建议在切换设备前先上传，在新设备上下载。", "Upload before switching devices, then download on the new device.")}</Text>
              <Text size="sm" c="var(--on-surface-variant)">{text("密码使用系统安全存储，不会被明文保存。", "Passwords use system secure storage and are not saved as plain text.")}</Text>
              <Text size="sm" c="yellow" fw={600}>{t("settings.sync.webdavPlaintextWarning")}</Text>
            </Stack>
          </Card>
        </>
      )}

      {syncMode === "local" && (
        <>
          <section className="ui-surface-card rounded-2xl border border-border p-4">
            <Stack gap="md">
              <Text size="sm" fw={600} c="var(--on-surface)">
                {text("本地同步目录", "Local Sync Directory")}
              </Text>
              <Group align="flex-end" gap="xs" wrap="nowrap">
                <TextInput
                  label={text("目录", "Directory")}
                  type="text"
                  value={localSyncDir}
                  readOnly
                  placeholder={text("尚未选择目录", "No directory selected")}
                  className="flex-1"
                  size="sm"
                  aria-label={text("本地同步目录", "Local Sync Directory")}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  color="gray"
                  leftSection={<Folder size={16} />}
                  onClick={handlePickLocalDir}
                >
                  {text("选择目录", "Choose Directory")}
                </Button>
              </Group>
              {localSyncDir && (
                <Group gap="xs" c="var(--success)">
                  <Check size={16} />
                  <Text size="sm">{text("已配置本地同步目录", "Local sync directory configured")}</Text>
                </Group>
              )}
            </Stack>
          </section>

          <section className="ui-surface-card rounded-2xl border border-border p-4">
            <Stack gap="md">
              <Text size="sm" fw={600} c="var(--on-surface)">
                {text("本地同步操作", "Local Sync Actions")}
              </Text>

            {!localSyncDir && (
              <Card className="border border-yellow-500/30 bg-yellow-500/10" p="sm" radius="lg">
                <Text size="sm" c="yellow">
                  {text("请先选择本地同步目录，再执行导出操作。", "Choose a local sync directory before exporting.")}
                </Text>
              </Card>
            )}

            <Group gap="sm">
              <Button
                size="sm"
                color="cliPrimary"
                leftSection={status === "syncing" ? undefined : <Upload size={16} />}
                onClick={handleLocalExport}
                disabled={!localSyncDir || status === "syncing"}
              >
                {status === "syncing" ? text("同步中", "Syncing") : text("导出到本地（zip）", "Export to Local (zip)")}
              </Button>
              <Button
                size="sm"
                variant="default"
                color="gray"
                leftSection={status === "syncing" ? undefined : <Download size={16} />}
                onClick={handleLocalImportPick}
                disabled={status === "syncing"}
              >
                {status === "syncing" ? text("同步中", "Syncing") : text("从 zip 导入", "Import from zip")}
              </Button>
            </Group>

            <Group gap="xs" c="var(--on-surface-variant)">
              <Folder size={16} />
              <Text size="sm">{text("上次同步：", "Last sync: ")}{formatLastSync()}</Text>
            </Group>
            </Stack>
          </section>

          <Card className="border border-border bg-surface-container-high" p="md" radius="lg">
            <Text fw={600} c="var(--on-surface)">{text("使用说明", "Notes")}</Text>
            <Stack mt="xs" gap={4}>
              <Text size="sm" c="var(--on-surface-variant)">{text("导出文件名格式：cli-manager-sync-YYYYMMDD-HHmmss.zip（保留历史）。", "Export file name: cli-manager-sync-YYYYMMDD-HHmmss.zip (history kept).")}</Text>
              <Text size="sm" c="var(--on-surface-variant)">{t("settings.sync.localImportOverwriteNote")}</Text>
              <Text size="sm" c="var(--on-surface-variant)">{t("settings.sync.localImportScope")}</Text>
              <Text size="sm" c="var(--on-surface-variant)">{text("可将目录指向云盘同步盘（OneDrive / 坚果云 / Dropbox 等）以实现跨设备同步。", "Point the directory to a cloud drive folder such as OneDrive, Nutstore, or Dropbox for cross-device sync.")}</Text>
              <Text size="sm" c="yellow" fw={600}>{t("settings.sync.localPlaintextWarning")}</Text>
            </Stack>
          </Card>
        </>
      )}

      <Modal
        opened={Boolean(preview && previewMode)}
        onClose={() => {
          setPreview(null);
          setPreviewMode(null);
        }}
        title={previewMode === "upload" ? text("确认上传到云端", "Confirm Upload to Cloud") : text("确认从云端下载", "Confirm Download from Cloud")}
        size="xl"
        centered
      >
        {preview && previewMode && (
          <Stack gap="md">
            <Group align="flex-start" gap="sm" wrap="nowrap">
              <ThemeIcon variant="light" color="yellow" size="sm">
                <AlertTriangle size={16} />
              </ThemeIcon>
              <Text size="sm" c="var(--on-surface-variant)">
                  {text("执行前请核对本地与云端摘要。", "Review local and cloud summaries before continuing.")}
                  {previewMode === "upload"
                    ? text("云端快照缺失时将创建当前设备快照。", "If the cloud snapshot is missing, the current device snapshot will be created.")
                    : text("下载可按数据域选择覆盖范围。", "Download can limit overwrite scope by data domain.")}
              </Text>
            </Group>

            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
              {[preview.local, preview.remote].map((item, index) => (
                <Card key={index === 0 ? "local" : "remote"} className="bg-surface-container-low" p="sm" radius="lg">
                  <Text fw={600} c="var(--on-surface)">{index === 0 ? text("本地内容", "Local Content") : text("云端内容", "Cloud Content")}</Text>
                  <Text mt={4} size="sm" c="var(--on-surface-variant)">{text("设备：", "Device: ")}{item.deviceName}</Text>
                  <Text size="sm" c="var(--on-surface-variant)">
                    {text("时间：", "Time: ")}{item.missing ? text("云端暂无快照", "No cloud snapshot") : formatDateTime(item.lastModified)}
                  </Text>
                  {item.missing && (
                    <Card mt="xs" className="border border-yellow-500/30 bg-yellow-500/10" p="xs" radius="md">
                      <Text size="xs" c="yellow">
                      {text("当前设备云端快照为空，确认上传后会新建快照。", "The current device has no cloud snapshot. Upload will create one.")}
                      </Text>
                    </Card>
                  )}
                  <Text mt="xs" size="xs" c="var(--on-surface-variant)">
                    {t("settings.sync.previewCounts", {
                      projects: item.projects,
                      groups: item.groups,
                      templates: item.commandTemplates,
                      settings: item.applicationSettings,
                      prices: item.modelPrices,
                      targets: item.thirdPartyHookTargets,
                    })}
                  </Text>
                  <Stack mt="xs" gap={4}>
                    <Text size="xs" c="var(--on-surface-variant)">{text("项目：", "Projects: ")}{item.projectNames.join(language === "zh-CN" ? "、" : ", ") || text("无", "None")}</Text>
                    <Text size="xs" c="var(--on-surface-variant)">{text("分组：", "Groups: ")}{item.groupNames.join(language === "zh-CN" ? "、" : ", ") || text("无", "None")}</Text>
                    <Text size="xs" c="var(--on-surface-variant)">{text("模板：", "Templates: ")}{item.templateNames.join(language === "zh-CN" ? "、" : ", ") || text("无", "None")}</Text>
                  </Stack>
                </Card>
              ))}
            </SimpleGrid>

            {previewMode === "download" && (
              <Card className="bg-surface-container-low" p="sm" radius="lg">
                <Stack gap="xs">
                  <Text size="sm" fw={600} c="var(--on-surface)">{text("选择覆盖范围", "Choose Overwrite Scope")}</Text>
                  <Group gap="sm">
                  {domainOptions.map((option) => (
                    <Checkbox
                      key={option.value}
                      checked={selectedDomains.includes(option.value)}
                      onChange={() => toggleDomain(option.value)}
                      label={option.label}
                      color="cliPrimary"
                    />
                  ))}
                  </Group>
                </Stack>
              </Card>
            )}

            <Group justify="flex-end" gap="xs">
              <Button
                size="xs"
                variant="default"
                color="gray"
                onClick={() => {
                  setPreview(null);
                  setPreviewMode(null);
                }}
              >
                {text("取消", "Cancel")}
              </Button>
              <Button
                size="xs"
                color="cliPrimary"
                onClick={() => void confirmPreviewAction()}
                disabled={previewMode === "download" && selectedDomains.length === 0}
              >
                {text("确认执行", "Confirm")}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal
        opened={Boolean(showImportConfirm)}
        onClose={() => setShowImportConfirm(null)}
        title={text("确认导入", "Confirm Import")}
        size="sm"
        centered
      >
        {showImportConfirm && (
          <Stack gap="md">
            <Group align="flex-start" gap="sm" wrap="nowrap">
              <ThemeIcon variant="light" color="yellow" size="sm">
                <AlertTriangle size={16} />
              </ThemeIcon>
              <Text size="sm" c="var(--on-surface-variant)" style={{ overflowWrap: "anywhere" }}>
                {t("settings.sync.localImportOverwrite", { path: showImportConfirm })}
              </Text>
            </Group>
            <Group justify="flex-end" gap="xs">
              <Button size="xs" variant="default" color="gray" onClick={() => setShowImportConfirm(null)}>
                {text("取消", "Cancel")}
              </Button>
              <Button size="xs" color="red" onClick={confirmLocalImport}>
                {text("确认导入", "Import")}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
