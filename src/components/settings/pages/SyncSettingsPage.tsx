import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
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
  Eye,
  EyeOff,
  Folder,
} from "../../icons";
import { toast } from "sonner";

const SYNC_MODE_OPTIONS: { value: SyncMode; label: string; description: string }[] = [
  { value: "cloud", label: "云同步", description: "通过 WebDAV 协议同步到云端" },
  { value: "local", label: "本地同步", description: "将配置打包为 zip 保存到本地目录" },
];

const AUTO_SYNC_OPTIONS: { value: AutoSyncAction; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "upload", label: "上传" },
  { value: "download", label: "下载" },
];

const DOMAIN_OPTIONS: { value: SyncDataDomain; label: string }[] = [
  { value: "projects", label: "项目" },
  { value: "groups", label: "分组" },
  { value: "command_templates", label: "命令模板" },
];

export function SyncSettingsPage() {
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
    deviceName,
    knownDeviceNames,
    autoSyncOnStartup,
    autoSyncOnClose,
    load,
    setConfig,
    clearPassword,
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
    localExport,
    localImport,
  } = useSyncStore();

  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deviceNameInput, setDeviceNameInput] = useState("");
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [previewMode, setPreviewMode] = useState<"upload" | "download" | null>(null);
  const [previewDeviceName, setPreviewDeviceName] = useState("");
  const [selectedDomains, setSelectedDomains] = useState<SyncDataDomain[]>([
    "projects",
    "groups",
    "command_templates",
  ]);
  const [showImportConfirm, setShowImportConfirm] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) {
      void load();
    }
  }, [loaded, load]);

  useEffect(() => {
    if (loaded) {
      setUrl(webdavUrl);
      setUsername(webdavUsername);
      setDeviceNameInput(deviceName);
      setPreviewDeviceName(deviceName);
    }
  }, [loaded, webdavUrl, webdavUsername, deviceName]);

  const handleTest = async () => {
    if (!url.trim() || !username.trim() || !password.trim()) {
      toast.error("请填写完整的连接信息");
      return;
    }

    setTesting(true);
    try {
      const result = await testConnection(url.trim(), username.trim(), password);
      if (result.success) {
        toast.success("连接成功");
        await setConfig(url.trim(), username.trim(), password);
        setShowPassword(false);
      } else {
        toast.error("连接失败", { description: result.message });
      }
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!url.trim()) {
      toast.error("请填写 WebDAV URL");
      return;
    }

    if (password.trim()) {
      await setConfig(url.trim(), username.trim(), password);
      toast.success("配置已保存（包含密码）");
    } else {
      await setConfig(url.trim(), username.trim());
      toast.success("配置已保存");
    }
  };

  const handleSaveDeviceName = async () => {
    try {
      await setDeviceName(deviceNameInput);
      toast.success("设备名称已保存");
    } catch (error) {
      toast.error("保存失败", { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const openPreview = async (mode: "upload" | "download") => {
    if (!hasPassword) {
      toast.error("请先配置并测试 WebDAV 连接");
      return;
    }
    try {
      const nextPreview = await getPreview(previewDeviceName || deviceName);
      if (mode === "download" && nextPreview.remote.missing) {
        toast.error("无法从云端同步");
        return;
      }
      setPreview(nextPreview);
      setPreviewMode(mode);
      setSelectedDomains(["projects", "groups", "command_templates"]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(mode === "upload" ? "读取同步摘要失败" : "读取云端快照失败", { description: message });
    }
  };

  const confirmPreviewAction = async () => {
    if (!previewMode) return;
    if (previewMode === "download" && preview?.remote.missing) {
      toast.error("无法从云端同步");
      return;
    }
    try {
      if (previewMode === "upload") {
        await upload();
        toast.success("上传成功");
      } else {
        await download(true, { deviceName: previewDeviceName || deviceName, domains: selectedDomains });
        toast.success("下载成功");
      }
      setPreview(null);
      setPreviewMode(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(previewMode === "upload" ? "上传失败" : "下载失败", { description: message });
    }
  };

  const toggleDomain = (domain: SyncDataDomain) => {
    setSelectedDomains((current) =>
      current.includes(domain) ? current.filter((item) => item !== domain) : [...current, domain]
    );
  };

  const handlePickLocalDir = async () => {
    try {
      const result = await openDialog({ directory: true, multiple: false, title: "选择本地同步目录" });
      if (typeof result === "string" && result.length > 0) {
        await setLocalSyncDir(result);
      }
    } catch (error) {
      toast.error("选择目录失败", { description: String(error) });
    }
  };

  const handleLocalExport = async () => {
    if (!localSyncDir) {
      toast.error("请先选择本地同步目录");
      return;
    }
    try {
      const path = await localExport();
      toast.success("本地导出成功", { description: path });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("本地导出失败", { description: message });
    }
  };

  const handleLocalImportPick = async () => {
    try {
      const result = await openDialog({
        directory: false,
        multiple: false,
        title: "选择要导入的同步 zip 文件",
        filters: [{ name: "同步包", extensions: ["zip"] }],
        defaultPath: localSyncDir || undefined,
      });
      if (typeof result === "string" && result.length > 0) {
        setShowImportConfirm(result);
      }
    } catch (error) {
      toast.error("选择文件失败", { description: String(error) });
    }
  };

  const confirmLocalImport = async () => {
    const zipPath = showImportConfirm;
    setShowImportConfirm(null);
    if (!zipPath) return;
    try {
      await localImport(zipPath);
      toast.success("本地导入成功");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("本地导入失败", { description: message });
    }
  };

  const formatLastSync = () => {
    if (!lastSyncAt) return "从未同步";
    const date = new Date(lastSyncAt);
    return date.toLocaleString("zh-CN");
  };

  return (
    <div className="space-y-6">
      {/* Conflict Banner */}
      {conflictInfo && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="mt-0.5 shrink-0 text-yellow-500" />
            <div className="flex-1">
              <h3 className="font-medium text-yellow-500">检测到同步冲突</h3>
              <p className="mt-1 text-sm text-on-surface-variant">
                本地和远程都有更新，请选择保留哪个版本。
              </p>
              <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
                <div className="rounded-lg bg-surface-container-high p-3">
                  <div className="font-medium">本地版本</div>
                  <div className="mt-1 text-on-surface-variant">
                    {new Date(conflictInfo.local_modified).toLocaleString("zh-CN")}
                  </div>
                  <div className="mt-2 text-xs">
                    {conflictInfo.local_projects} 个项目 · {conflictInfo.local_groups} 个分组 ·{" "}
                    {conflictInfo.local_templates} 个模板
                  </div>
                </div>
                <div className="rounded-lg bg-surface-container-high p-3">
                  <div className="font-medium">远程版本</div>
                  <div className="mt-1 text-on-surface-variant">
                    {new Date(conflictInfo.remote_modified).toLocaleString("zh-CN")}
                  </div>
                  <div className="mt-2 text-xs">
                    {conflictInfo.remote_projects} 个项目 · {conflictInfo.remote_groups} 个分组 ·{" "}
                    {conflictInfo.remote_templates} 个模板
                  </div>
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => resolveConflict(true)}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
                >
                  保留本地
                </button>
                <button
                  onClick={() => resolveConflict(false)}
                  className="rounded-lg bg-surface-container-highest px-4 py-2 text-sm font-medium text-on-surface transition-opacity hover:opacity-80"
                >
                  使用远程
                </button>
                <button
                  onClick={clearConflict}
                  className="rounded-lg px-4 py-2 text-sm text-on-surface-variant transition-opacity hover:opacity-80"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sync Mode Switch */}
      <section>
        <h3 className="mb-3 text-base font-medium text-on-surface">同步方式</h3>
        <div className="grid grid-cols-2 gap-3">
          {SYNC_MODE_OPTIONS.map((opt) => {
            const active = syncMode === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => void setSyncMode(opt.value)}
                className="ui-interactive ui-focus-ring ui-selection-card rounded-xl border p-3 text-left"
                data-selected={active ? "true" : "false"}
                aria-pressed={active}
              >
                <div className="text-sm font-semibold">{opt.label}</div>
                <div className="mt-0.5 text-[11px] leading-4 text-on-surface-variant">
                  {opt.description}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {syncMode === "cloud" && (
        <>
          {/* WebDAV Configuration */}
          <section>
            <h3 className="mb-4 text-base font-medium text-on-surface">WebDAV 配置</h3>

            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm text-on-surface-variant">服务器地址</label>
                <Input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://dav.example.com/webdav"
                  className="h-9 text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-sm text-on-surface-variant">用户名</label>
                  <Input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="username"
                    className="h-9 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm text-on-surface-variant">密码</label>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="h-9 pr-10 text-sm"
                      aria-label="WebDAV 密码"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface"
                      aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-sm text-on-surface-variant">当前设备名称</label>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={deviceNameInput}
                    onChange={(e) => setDeviceNameInput(e.target.value)}
                    placeholder="当前设备"
                    className="h-9 text-sm"
                  />
                  <button
                    onClick={handleSaveDeviceName}
                    className="whitespace-nowrap rounded-lg bg-surface-container-highest px-4 py-2 text-sm font-medium text-on-surface transition-opacity hover:opacity-80"
                  >
                    保存设备名
                  </button>
                </div>
                <p className="mt-1 text-xs text-on-surface-variant">云端快照会按设备名称隔离，避免不同设备路径互相覆盖。</p>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleTest}
                  disabled={testing || !url.trim() || !username.trim() || !password.trim()}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {testing ? "测试中..." : "测试连接"}
                </button>
                <button
                  onClick={handleSave}
                  className="rounded-lg bg-surface-container-highest px-4 py-2 text-sm font-medium text-on-surface transition-opacity hover:opacity-80"
                >
                  保存配置
                </button>
                {hasPassword && (
                  <button
                    onClick={clearPassword}
                    className="rounded-lg px-4 py-2 text-sm text-error transition-opacity hover:opacity-80"
                  >
                    清除密码
                  </button>
                )}
              </div>

              {hasPassword && (
                <div className="flex items-center gap-2 text-sm text-success">
                  <Check size={16} />
                  <span>已配置 WebDAV 连接</span>
                </div>
              )}
            </div>
          </section>

          {/* Cloud Sync Actions */}
          <section>
            <h3 className="mb-4 text-base font-medium text-on-surface">云端同步操作</h3>

            {!hasPassword && (
              <div className="mb-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-600 dark:text-yellow-400">
                请先完成 WebDAV 配置并点击"测试连接"验证成功后再进行同步操作。
              </div>
            )}

            <div className="mb-4 grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-sm text-on-surface-variant">应用打开时</label>
                <select
                  value={autoSyncOnStartup}
                  onChange={(e) => void setAutoSyncOnStartup(e.target.value as AutoSyncAction)}
                  className="h-9 w-full rounded-lg border border-border bg-surface-container-low px-3 text-sm text-on-surface"
                >
                  {AUTO_SYNC_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm text-on-surface-variant">应用关闭时</label>
                <select
                  value={autoSyncOnClose}
                  onChange={(e) => void setAutoSyncOnClose(e.target.value as AutoSyncAction)}
                  className="h-9 w-full rounded-lg border border-border bg-surface-container-low px-3 text-sm text-on-surface"
                >
                  {AUTO_SYNC_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mb-4">
              <label className="mb-1.5 block text-sm text-on-surface-variant">恢复设备快照</label>
              <select
                value={previewDeviceName}
                onChange={(e) => setPreviewDeviceName(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-surface-container-low px-3 text-sm text-on-surface"
              >
                {knownDeviceNames.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-4">
              <button
                onClick={() => void openPreview("upload")}
                disabled={!hasPassword || status === "syncing"}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {status === "syncing" ? (
                  <span className="animate-spin">同步中</span>
                ) : (
                  <Upload size={16} />
                )}
                上传到云端
              </button>
              <button
                onClick={() => void openPreview("download")}
                disabled={!hasPassword || status === "syncing"}
                className="flex items-center gap-2 rounded-lg bg-surface-container-highest px-4 py-2 text-sm font-medium text-on-surface transition-opacity hover:opacity-80 disabled:opacity-50"
              >
                {status === "syncing" ? (
                  <span className="animate-spin">同步中</span>
                ) : (
                  <Download size={16} />
                )}
                从云端下载
              </button>
            </div>

            <div className="mt-4 flex items-center gap-2 text-sm text-on-surface-variant">
              <Cloud size={16} />
              <span>上次同步：{formatLastSync()}</span>
            </div>
          </section>

          <section className="rounded-lg bg-surface-container-high p-4">
            <h4 className="font-medium text-on-surface">使用说明</h4>
            <ul className="mt-2 space-y-1 text-sm text-on-surface-variant">
              <li>• 支持 WebDAV 协议，可使用坚果云、InfiniCLOUD、群晖 NAS 等服务</li>
              <li>• 上传将覆盖远程配置，下载将覆盖本地配置</li>
              <li>• 建议在切换设备前先上传，在新设备上下载</li>
              <li>• 密码使用系统安全存储，不会被明文保存</li>
            </ul>
          </section>
        </>
      )}

      {syncMode === "local" && (
        <>
          <section>
            <h3 className="mb-4 text-base font-medium text-on-surface">本地同步目录</h3>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={localSyncDir}
                  readOnly
                  placeholder="尚未选择目录"
                  className="h-9 flex-1 text-sm"
                  aria-label="本地同步目录"
                />
                <button
                  onClick={handlePickLocalDir}
                  className="flex items-center gap-2 rounded-lg bg-surface-container-highest px-3 py-2 text-sm font-medium text-on-surface transition-opacity hover:opacity-80"
                >
                  <Folder size={16} />
                  选择目录
                </button>
              </div>
              {localSyncDir && (
                <div className="flex items-center gap-2 text-sm text-success">
                  <Check size={16} />
                  <span>已配置本地同步目录</span>
                </div>
              )}
            </div>
          </section>

          <section>
            <h3 className="mb-4 text-base font-medium text-on-surface">本地同步操作</h3>

            {!localSyncDir && (
              <div className="mb-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-600 dark:text-yellow-400">
                请先选择本地同步目录，再执行导出操作。
              </div>
            )}

            <div className="flex items-center gap-4">
              <button
                onClick={handleLocalExport}
                disabled={!localSyncDir || status === "syncing"}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {status === "syncing" ? (
                  <span className="animate-spin">⏳</span>
                ) : (
                  <Upload size={16} />
                )}
                导出到本地（zip）
              </button>
              <button
                onClick={handleLocalImportPick}
                disabled={status === "syncing"}
                className="flex items-center gap-2 rounded-lg bg-surface-container-highest px-4 py-2 text-sm font-medium text-on-surface transition-opacity hover:opacity-80 disabled:opacity-50"
              >
                {status === "syncing" ? (
                  <span className="animate-spin">⏳</span>
                ) : (
                  <Download size={16} />
                )}
                从 zip 导入
              </button>
            </div>

            <div className="mt-4 flex items-center gap-2 text-sm text-on-surface-variant">
              <Folder size={16} />
              <span>上次同步：{formatLastSync()}</span>
            </div>
          </section>

          <section className="rounded-lg bg-surface-container-high p-4">
            <h4 className="font-medium text-on-surface">使用说明</h4>
            <ul className="mt-2 space-y-1 text-sm text-on-surface-variant">
              <li>• 导出文件名格式：cli-manager-sync-YYYYMMDD-HHmmss.zip（保留历史）</li>
              <li>• 导入时将覆盖本地所有项目、分组和模板配置，操作不可撤销</li>
              <li>• 可将目录指向云盘同步盘（OneDrive / 坚果云 / Dropbox 等）以实现跨设备同步</li>
              <li>• 同步内容仅包括项目、分组、命令模板，不包括 WebDAV 密码与终端会话</li>
            </ul>
          </section>
        </>
      )}

      {preview && previewMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-surface-container-high p-4 shadow-lg">
            <div className="flex items-start gap-3">
              <AlertTriangle size={20} className="mt-0.5 shrink-0 text-yellow-500" />
              <div>
                <h3 className="font-medium text-on-surface">
                  {previewMode === "upload" ? "确认上传到云端" : "确认从云端下载"}
                </h3>
                <p className="mt-1 text-sm text-on-surface-variant">
                  执行前请核对本地与云端摘要。{previewMode === "upload" ? "云端快照缺失时将创建当前设备快照。" : "下载可按数据域选择覆盖范围。"}
                </p>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {[preview.local, preview.remote].map((item, index) => (
                <div key={index === 0 ? "local" : "remote"} className="rounded-lg bg-surface-container-low p-3 text-sm">
                  <div className="font-medium text-on-surface">{index === 0 ? "本地内容" : "云端内容"}</div>
                  <div className="mt-1 text-on-surface-variant">设备：{item.deviceName}</div>
                  <div className="text-on-surface-variant">
                    时间：{item.missing ? "云端暂无快照" : new Date(item.lastModified).toLocaleString("zh-CN")}
                  </div>
                  {item.missing && (
                    <div className="mt-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-2 py-1 text-xs text-yellow-600 dark:text-yellow-400">
                      当前设备云端快照为空，确认上传后会新建快照。
                    </div>
                  )}
                  <div className="mt-2 text-xs text-on-surface-variant">
                    {item.projects} 个项目 · {item.groups} 个分组 · {item.commandTemplates} 个模板
                  </div>
                  <div className="mt-2 space-y-1 text-xs text-on-surface-variant">
                    <div>项目：{item.projectNames.join("、") || "无"}</div>
                    <div>分组：{item.groupNames.join("、") || "无"}</div>
                    <div>模板：{item.templateNames.join("、") || "无"}</div>
                  </div>
                </div>
              ))}
            </div>

            {previewMode === "download" && (
              <div className="mt-4 rounded-lg bg-surface-container-low p-3">
                <div className="mb-2 text-sm font-medium text-on-surface">选择覆盖范围</div>
                <div className="flex flex-wrap gap-2">
                  {DOMAIN_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => toggleDomain(option.value)}
                      data-selected={selectedDomains.includes(option.value) ? "true" : "false"}
                      className="ui-interactive ui-focus-ring ui-selection-card rounded-lg border px-3 py-2 text-sm"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setPreview(null);
                  setPreviewMode(null);
                }}
                className="rounded-lg px-4 py-2 text-sm text-on-surface-variant transition-opacity hover:opacity-80"
              >
                取消
              </button>
              <button
                onClick={() => void confirmPreviewAction()}
                disabled={previewMode === "download" && selectedDomains.length === 0}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                确认执行
              </button>
            </div>
          </div>
        </div>
      )}

      {showImportConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 max-w-sm rounded-lg bg-surface-container-high p-4 shadow-lg">
            <div className="flex items-start gap-3">
              <AlertTriangle size={20} className="mt-0.5 shrink-0 text-yellow-500" />
              <div>
                <h3 className="font-medium text-on-surface">确认导入</h3>
                <p className="mt-1 text-sm text-on-surface-variant break-all">
                  从 <span className="font-mono">{showImportConfirm}</span> 导入将覆盖本地所有项目、分组和模板配置，此操作不可撤销。
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowImportConfirm(null)}
                className="rounded-lg px-4 py-2 text-sm text-on-surface-variant transition-opacity hover:opacity-80"
              >
                取消
              </button>
              <button
                onClick={confirmLocalImport}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                确认导入
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
