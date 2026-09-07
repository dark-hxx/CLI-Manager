# Windows 便携版与自定义数据目录设计

## 1. 架构原则

- 数据根目录必须在数据库、日志、Store、历史缓存和 PTY daemon 初始化之前确定。
- 现有 `app_get_data_paths` 字段保持兼容；新状态与切换操作使用独立 IPC，避免扩大关键路径改动。
- 所有 GUI、Hook、Statusline 和 daemon 进程共享同一套启动期路径解析规则。
- 切换只在完整重启后生效，不尝试热切换已打开的 SQLite/Store 句柄。
- 不新增依赖。

## 2. 分发身份与默认路径

### 2.1 身份判定

按以下顺序解析分发类型：

1. 现有 `CLI_MANAGER_DISTRIBUTION=aur` 保持最高优先级。
2. Windows 可执行文件同目录存在 `portable.flag` 时判定为 `portable`。
3. 其他情况为现有 `standalone`。

安装版与便携版继续使用相同 identifier、版本号和单实例域。

### 2.2 默认数据根目录

| 分发类型 | 默认数据根目录 |
|---|---|
| standalone | `%USERPROFILE%\\.cli-manager` |
| portable | `<exe-dir>\\data` |
| aur / 非 Windows | 保持现有行为 |

用户选择的自定义目录就是数据根目录，不追加额外目录名。

## 3. Bootstrap 配置

数据目录指针不能存放在被重定向的 `settings.json` 中，使用独立 Bootstrap 文件：

| 分发类型 | Bootstrap 文件 |
|---|---|
| standalone Windows | `%LOCALAPPDATA%\\com.cli-manager.app\\data-root.json` |
| portable Windows | `<exe-dir>\\data-root.json` |

`portable.flag` 只标识便携分发，`data-root.json` 仅在用户配置自定义目录或存在待处理切换时创建，避免新版 ZIP 覆盖用户配置。

建议 schema：

```json
{
  "version": 1,
  "customDataDir": "D:\\CLI-Manager-Data",
  "pendingSwitch": {
    "targetMode": "custom",
    "targetDir": "D:\\CLI-Manager-Data",
    "sourceDir": "C:\\Users\\user\\.cli-manager",
    "migrate": true
  },
  "lastError": null
}
```

- `customDataDir = null` 表示使用当前分发的默认目录。
- Bootstrap 文件使用临时文件 + rename 原子写入。
- 自定义目录必须是规范化后的绝对路径。

## 4. 启动流程

```text
GUI 启动
  → 检测分发类型与 Bootstrap 文件
  → 处理 pendingSwitch
      → migrate=true：在数据层初始化前迁移完整目录
      → migrate=false：仅更新 active customDataDir
  → 原子保存 Bootstrap 结果
  → 固定本进程 data root
  → 初始化日志 / SQLite / Store / daemon / WebView
```

- `run()` 在首次调用 `cli_manager_data_dir()` 前处理 pending switch。
- `__hook` / `__statusline` 等短命子命令不执行 pending migration，只读取当前已生效目录，避免外部 Hook 抢先迁移。
- GUI 成功应用切换后，新拉起的 daemon 与后续 Hook 进程自然读取新目录。
- 本进程解析结果可缓存；切换命令只写 pending 状态，不改变当前进程路径。

## 5. 切换与迁移

### 5.1 新 IPC

建议增加独立命令：

- `app_get_data_storage_status()`：返回分发类型、当前模式、当前路径、默认路径、上次切换错误。
- `app_inspect_data_dir(targetDir)`：规范化路径并返回是否为空、是否可写、是否与当前路径相同。
- `app_prepare_data_dir_switch(targetMode, targetDir, migrate)`：校验运行状态，写入 pending switch，返回可重启状态。

### 5.2 路径校验

- 仅接受绝对目录路径。
- canonicalize 后存储，拒绝文件、盘符根目录、当前数据目录本身。
- 拒绝 source/target 互为父子，避免递归复制。
- 使用独占临时文件验证可写性并立即删除。
- 用户选择路径属于不可信输入，校验放在 Rust 边界；前端校验只用于即时提示。

### 5.3 运行中任务保护

- 后端通过 daemon session 列表确认不存在 alive session，并请求 idle daemon 退出。
- 前端同时检查 `backgroundOperationStore` 和 SSH Agent 安装任务等运行中操作。
- 任一层发现运行中任务都拒绝准备切换，不自动终止。

### 5.4 自动迁移

- 仅允许迁移到空目标目录。
- 在新进程数据层打开前执行，确保 SQLite、WAL、SHM 和 Store 已关闭。
- 复制整个源目录，包括数据库族、Store、日志、缓存、附件、备份和其他子目录。
- 复制到目标同级临时目录；全部成功后删除空目标目录并 rename，避免把半成品当作有效数据根目录。
- 遇到 symlink/reparse point、复制失败或 rename 失败时终止迁移，不切换 active root，并记录可展示错误。
- 目标非空时不允许自动迁移；用户只能选择“不迁移并重启”。

### 5.5 失败恢复

- pending migration 失败时继续保留旧 active root，清除 pending，并写入 `lastError`。
- 启动后在“数据存储”区块展示错误；这属于显式恢复，不是静默回退。
- 显式配置的自定义目录在正常启动时不可用或不可写，阻止数据层启动并显示明确启动错误，不回退到默认目录。

## 6. 前端交互

在 `GeneralSettingsPage` 最底部渲染独立 `DataStorageSection`：

- 当前分发：安装版 / 便携版。
- 当前模式：默认 / 自定义。
- 当前实际数据路径。
- “选择自定义目录”。
- “恢复默认目录”。

选择目标后弹出应用内确认对话框：

- 空目标：`迁移当前数据并重启`、`不迁移，直接重启`、`取消`。
- 非空目标：只允许 `直接使用并重启`、`取消`，明确提示不会合并数据。
- 存在运行中任务：禁用切换并提示先关闭任务。

所有文案、按钮、aria 标签和错误同时维护 `zh-CN` 与 `en-US`；`zh-TW` 继续走现有转换机制。

## 7. 路径消费者收口

- `app_paths.rs` 成为 CLI-Manager 本地数据根目录唯一权威。
- `hook_client.rs` 的失败日志改用 `app_paths::logs_dir()`，删除直接拼接 `~/.cli-manager`。
- 桌宠资源 scope 在 Tauri setup 中仅动态允许 `<resolved-data-root>/pets`；保留外部 `$HOME/.codex/pets` scope，不扩大到整个自定义目录。
- `DesktopPetSettingsPage` 的托管路径展示改为实际 `<dataDir>/pets`，不再硬编码 `~/.cli-manager/pets`。
- 外部 `.claude`、`.codex`、WSL、SSH 和项目目录路径保持不变。

## 8. 更新分流

- `AppDistribution` 扩展为 `standalone | portable | aur`。
- portable 仍使用签名 updater manifest 检查版本与读取发布说明。
- portable UI 不调用 `download()` / `install()`，主操作直接打开对应 Release 页面。
- standalone 保持现有下载、安装、重启流程；AUR 保持包管理器流程。

## 9. Windows 便携 ZIP

Release Windows job 在正常 Tauri build 后组装：

```text
CLI-Manager/
  cli-manager.exe
  cli-manager-codex-proxy.exe
  portable.flag
  resources/
    conpty/...
    ssh-agent/...
    icon.ico
```

- 复用 `src-tauri/target/release/resources`，不重复维护资源清单。
- 产物命名包含版本、Windows、x64、portable。
- Windows build 将 ZIP 作为 artifact 交给 publish job，随后上传 GitHub Release；发布说明增加便携版条目。
- portable ZIP 不进入 Tauri updater 的安装资产选择逻辑。

## 10. 兼容与风险

- `app_get_data_paths` 现有字段和调用方式不变，所有消费者自动获得新根目录。
- 开发版继续使用 `sessions.dev.json` 与 `history-cache-dev`。
- 最大风险是共享路径语义变化。GitNexus 对 `getCliManagerDataPaths` 和 `GeneralSettingsPage` 均报告 CRITICAL，因此实现必须保持 IPC shape、限制通用页改动为一个新 section，并重点回归 SQLite、Store、历史缓存、桌宠、Hook、daemon。
- 回滚时删除 portable artifact 生成步骤和新 UI；未配置自定义目录的安装版仍保持原 `<home>/.cli-manager` 行为。
