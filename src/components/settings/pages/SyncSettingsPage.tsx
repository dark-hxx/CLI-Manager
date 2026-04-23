import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { useSyncStore } from "../../../stores/syncStore";
import { Cloud, Download, Upload, AlertTriangle, Check, Eye, EyeOff } from "../../icons";
import { toast } from "sonner";

export function SyncSettingsPage() {
  const {
    webdavUrl,
    webdavUsername,
    hasPassword,
    status,
    lastSyncAt,
    conflictInfo,
    loaded,
    load,
    setConfig,
    clearPassword,
    testConnection,
    upload,
    download,
    resolveConflict,
    clearConflict,
  } = useSyncStore();

  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);

  useEffect(() => {
    if (!loaded) {
      void load();
    }
  }, [loaded, load]);

  useEffect(() => {
    if (loaded) {
      setUrl(webdavUrl);
      setUsername(webdavUsername);
    }
  }, [loaded, webdavUrl, webdavUsername]);

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

    // If password field has value, save it too
    if (password.trim()) {
      await setConfig(url.trim(), username.trim(), password);
      toast.success("配置已保存（包含密码）");
    } else {
      await setConfig(url.trim(), username.trim());
      toast.success("配置已保存");
    }
  };

  const handleUpload = async () => {
    if (!hasPassword) {
      toast.error("请先配置并测试 WebDAV 连接");
      return;
    }
    try {
      await upload();
      if (useSyncStore.getState().status === "success") {
        toast.success("上传成功");
      } else {
        toast.error("上传失败，请检查网络连接和 WebDAV 配置");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("上传失败", { description: message });
    }
  };

  const handleDownload = async () => {
    if (!hasPassword) {
      toast.error("请先配置并测试 WebDAV 连接");
      return;
    }
    setShowDownloadConfirm(true);
  };

  const confirmDownload = async () => {
    setShowDownloadConfirm(false);
    try {
      await download();
      if (useSyncStore.getState().status === "success") {
        toast.success("下载成功");
      } else {
        toast.error("下载失败，请检查网络连接和 WebDAV 配置");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("下载失败", { description: message });
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

      {/* Sync Actions */}
      <section>
        <h3 className="mb-4 text-base font-medium text-on-surface">同步操作</h3>

        {!hasPassword && (
          <div className="mb-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-600 dark:text-yellow-400">
            请先完成 WebDAV 配置并点击"测试连接"验证成功后再进行同步操作。
          </div>
        )}

        <div className="flex items-center gap-4">
          <button
            onClick={handleUpload}
            disabled={!hasPassword || status === "syncing"}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {status === "syncing" ? (
              <span className="animate-spin">⏳</span>
            ) : (
              <Upload size={16} />
            )}
            上传到云端
          </button>
          <button
            onClick={handleDownload}
            disabled={!hasPassword || status === "syncing"}
            className="flex items-center gap-2 rounded-lg bg-surface-container-highest px-4 py-2 text-sm font-medium text-on-surface transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            {status === "syncing" ? (
              <span className="animate-spin">⏳</span>
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

      {/* Help */}
      <section className="rounded-lg bg-surface-container-high p-4">
        <h4 className="font-medium text-on-surface">使用说明</h4>
        <ul className="mt-2 space-y-1 text-sm text-on-surface-variant">
          <li>• 支持 WebDAV 协议，可使用坚果云、InfiniCLOUD、群晖 NAS 等服务</li>
          <li>• 上传将覆盖远程配置，下载将覆盖本地配置</li>
          <li>• 建议在切换设备前先上传，在新设备上下载</li>
          <li>• 密码使用系统安全存储，不会被明文保存</li>
        </ul>
      </section>

      {/* Download Confirmation Dialog */}
      {showDownloadConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 max-w-sm rounded-lg bg-surface-container-high p-4 shadow-lg">
            <div className="flex items-start gap-3">
              <AlertTriangle size={20} className="mt-0.5 shrink-0 text-yellow-500" />
              <div>
                <h3 className="font-medium text-on-surface">确认下载</h3>
                <p className="mt-1 text-sm text-on-surface-variant">
                  从云端下载将覆盖本地所有项目、分组和模板配置，此操作不可撤销。
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowDownloadConfirm(false)}
                className="rounded-lg px-4 py-2 text-sm text-on-surface-variant transition-opacity hover:opacity-80"
              >
                取消
              </button>
              <button
                onClick={confirmDownload}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                确认下载
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}