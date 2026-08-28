# 修复供应商弹框层级与 KNX 路径跳转：设计

## Boundary Map

1. 供应商删除：`NativeProviderDetailModal` → `NativeProviderSettingsPage.handleDeleteProvider` → `useAppConfirm` → `ConfirmDialog` portal。
2. 文件路径打开：终端文本 `/F:/...` → `findTerminalFileLinks` → `resolveTerminalFileSystemPath` → `open_folder_in_explorer` IPC → Windows Explorer。

两个缺陷都应在各自的责任边界修复：前者在拥有嵌套确认框的页面，后者在将本地路径交给操作系统的 Rust command。两者不共享代码或状态。

## Provider Dialog Design

- 在 `NativeProviderSettingsPage` 调用 `useAppConfirm` 时显式传入 `zIndex: 220`。
- `ConfirmDialog` 已将这个值同时应用到遮罩与内容；220 是同一供应商详情内 `NativeProviderGlobalSection` 已使用的局部层级，足以高于 Mantine 父 Modal，且不改变通用确认框默认层级。
- 不改变删除确认 Promise、关闭逻辑、i18n key 或 provider 删除 IPC。

### Scenario Matrix

| 场景 | 预期 |
|---|---|
| 供应商详情 Basic / Effective Tab | 删除确认框位于详情 Modal 之上。 |
| Claude / Codex / Grok Build 类型 | 共用同一页面拥有者，层级一致。 |
| 展开、折叠或窄屏设置面板 | portal 层级与布局无关，仍可操作。 |
| 键盘 Esc、取消、确认 | 仅关闭确认框；确认后保持既有删除和详情关闭语义。 |
| 全局应用确认 | 已有独立 `zIndex: 220`，不变。 |

## KNX Path Design

- 保持前端 `/X:/` 链接检测和 `F:/...` IPC 输出不变，它们已正确描述目标文件。
- 在 `open_folder_in_explorer` 的 Windows 分支入口新增一个局部规范化函数：只去除 `/X:/` 的 POSIX 前缀，然后复用 `wsl::normalize_wsl_unc_path` 将 Windows/UNC 字符串转换为 Explorer 所需的反斜杠形式。
- 用同一规范化结果构造 `PathBuf`、检查存在性并传递给 Explorer，因此文件继续使用 `/select,` 选中，目录继续直接打开，`open_file=true` 继续由默认应用打开。
- 非 Windows 分支不改变；WSL UNC 已由现有 normalizer 保持兼容；SSH 终端本来不提供本地文件链接。

### Scenario Matrix

| 场景 | 预期 |
|---|---|
| `/F:/.../project.knxproj` | 变为 `F:\\...\\project.knxproj`，Explorer 选中文件。 |
| `F:/...` / `F:\\...` | 同样成为可打开的原生 Windows 路径。 |
| 普通目录 | 直接打开目录。 |
| UNC / WSL UNC | 现有网络、WSL UNC 规范化保持。 |
| `/mnt/f/...` | 保留前端已有的 `/mnt` → Windows 盘符转换。 |
| SSH / 远程终端 | 不启用本地文件链接，保持不变。 |

## Compatibility and Rollback

- 不变更 Tauri command 签名、权限或 WebView 文件访问范围。
- 回滚点仅限一个页面的 `zIndex` 参数与 `shell.rs` 的 Windows 路径归一化，均为局部、可逆变更。
