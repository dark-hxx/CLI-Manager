# Local Path Opening Contracts

## Scenario: WebView 打开本地路径

### 1. Scope / Trigger

- 前端需要打开用户项目、Worktree、终端识别出的本地目录或文件时适用。
- 不要为任意项目路径配置 WebView `opener` 全盘 scope；本地路径统一通过 Rust command。

### 2. Signatures

```rust
open_folder_in_explorer(
    path: String,
    open_file: Option<bool>,
) -> Result<(), String>
```

前端参数使用 camelCase：

```ts
invoke("open_folder_in_explorer", { path, openFile: true })
```

### 3. Contracts

- `path`：必须指向当前系统中已存在的文件或目录。
- `openFile = true` 且目标是文件：使用系统默认应用打开。
- 其他情况：目录直接打开；文件在系统文件管理器中定位。
- HTTP/HTTPS URL 继续使用前端 `openUrl`，不经过此 command。

### 4. Validation & Error Matrix

| 条件 | 结果 |
|---|---|
| 路径不存在 | 返回 `路径不存在: <path>` |
| 默认应用启动失败 | 返回 `无法打开文件: <error>` |
| 文件管理器启动失败 | 返回 `无法打开文件夹: <error>` |

### 5. Good/Base/Bad Cases

- Good：终端外部文件传 `openFile: true`，由默认应用打开。
- Base：项目或 Worktree 目录仅传 `path`，由文件管理器打开。
- Bad：前端直接调用 `openPath(path)`，只配置 `opener:allow-open-path` 而未配置 scope，会产生 ACL/scope 拒绝。

### 6. Tests Required

- Rust 编译检查必须覆盖 command 参数及 `OpenerExt` 调用。
- TypeScript 类型检查必须覆盖所有 `invoke` 参数。
- 应用内手动验证目录、外部文件和 URL 三条路径。

### 7. Wrong vs Correct

#### Wrong

```ts
await openPath(project.path);
```

#### Correct

```ts
await invoke("open_folder_in_explorer", { path: project.path });
```

## Scenario: Windows Explorer 原生路径参数

### 1. Scope / Trigger

- Windows 终端输出、项目路径或 WSL `/mnt/<drive>` 转换后向 `open_folder_in_explorer` 传入盘符路径时适用。
- 输入可能是 `/F:/repo/file.knxproj`、`F:/repo/file.knxproj` 或 `F:\\repo\\file.knxproj`；规范化只在 Rust 启动 Explorer 的边界执行，不要求每个前端调用方重复处理。

### 2. Signatures

```rust
#[cfg(target_os = "windows")]
fn normalize_windows_explorer_path(path: &str) -> String

#[tauri::command]
pub async fn open_folder_in_explorer(
    path: String,
    open_file: Option<bool>,
) -> Result<(), String>
```

### 3. Contracts

- `/X:/...` 去除仅有的 POSIX 前缀；只有 `X:` 后紧跟 `/` 或 `\\` 的盘符绝对路径才允许去除，`X:relative` 和普通 POSIX 路径不得误转。
- `X:/...` 与 `/X:/...` 在存在性检查和所有 `explorer` argv 中必须变为 `X:\\...`；不能只用规范化结果检查存在性、却把原始正斜杠字符串交给 Explorer。
- 普通 UNC 路径保持不变；WSL UNC 继续复用 `normalize_wsl_unc_path` 处理 verbatim UNC 形式。
- 文件仍使用 `/select, <path>`，目录仍直接打开，`open_file = true` 的默认应用语义不变；不存在路径的报错继续包含调用方传入的原始值。
- 非 Windows 平台继续使用原始 `path`，不引入 Windows 专用改写。

### 4. Validation & Error Matrix

| 输入与条件 | 结果 |
|---|---|
| `/F:/repo/project.knxproj`，目标存在 | 向 Explorer 传 `F:\\repo\\project.knxproj`，并在父目录中选中文件 |
| `F:/repo`，目标存在 | 向 Explorer 传 `F:\\repo` 并直接打开目录 |
| `F:relative` | 不按绝对盘符路径去除或重写 |
| `\\\\server\\share\\file` | 保持 UNC 语义 |
| 路径不存在 | 返回 `路径不存在: <原始 path>` |

### 5. Good/Base/Bad Cases

- Good：终端链接先把 `/F:/...` 解析为 `F:/...`，Rust 边界统一转为 `F:\\...` 后再验证并启动 Explorer。
- Base：已有 `F:\\...` 输入保持不变，文件仍通过 `/select,` 定位。
- Bad：`PathBuf::exists()` 使用可接受正斜杠的路径，但 `Command::new("explorer")` 仍传入 `F:/...`；Explorer 可能把它当作参数并回落到默认目录。

### 6. Tests Required

- Rust 单测断言 `/F:/...`、`F:/...` 和 `F:\\...` 归一化为同一原生盘符路径，并覆盖普通 UNC 保持与 verbatim WSL UNC 归一化。
- `scripts/terminalFileLinks.test.mjs` 断言 `/F:/.../project.knxproj` 被识别且前端解析结果保留正确目标。
- 运行 `cargo check`、`npx tsc --noEmit`；在 Windows Tauri 窗口中手动验证文件选中和目录直接打开。

### 7. Wrong vs Correct

#### Wrong

```rust
let path_buf = PathBuf::from(&path);
Command::new("explorer").args(["/select,", path.as_str()]).spawn()?;
```

#### Correct

```rust
let system_path = normalize_windows_explorer_path(&path);
let path_buf = PathBuf::from(&system_path);
Command::new("explorer")
    .args(["/select,", system_path.as_str()])
    .spawn()?;
```
