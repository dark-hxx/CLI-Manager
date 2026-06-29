# WSL Path Contracts

> 处理 WSL UNC 路径（`\\wsl.localhost\...`）的 Rust 后端规约。Windows 原生 API 通过 Plan 9 协议访问此类路径不可靠。

---

## 1. Scope / Trigger

- **Trigger**: 任何 Rust 代码需要读写 WSL 文件系统上的文件/目录时，必须遵守本规约。
- **适用场景**: 历史会话扫描、Git 仓库操作、Hook 配置读写、会话文件读取等。

---

## 2. Signatures

### `wsl.rs` — 路径转换工具

```rust
// 判断是否为 WSL UNC 路径
pub fn is_wsl_config_dir(path: &str) -> bool

// 解析 UNC → (distro, linux_path)
// "\\wsl.localhost\Ubuntu\home\venti\.claude" → Some(("Ubuntu", "/home/venti/.claude"))
pub fn parse_wsl_unc_path(path: &str) -> Option<(String, String)>

// Linux → UNC 反向转换
// "/home/venti/.claude" + "Ubuntu" → "\\wsl.localhost\Ubuntu\home\venti\.claude"
pub fn linux_to_unc_wsl_path(linux_path: &str, distro: &str) -> String

// Windows 盘符 → WSL /mnt 形式（仅处理 C:\... 格式）
pub fn windows_path_to_wsl(path: &str) -> Option<String>

// 定位 wsl.exe
pub fn find_wsl_exe() -> Option<PathBuf>
```

### `shell_resolver.rs` — 静默命令构造

```rust
// Windows: Command + CREATE_NO_WINDOW；非 Windows: 等价 Command::new
pub fn silent_command(program: &str) -> Command
```

### `commands/ccusage.rs` — WSL 运行时 / 安装边界

```rust
#[tauri::command]
pub async fn ccusage_get_status(
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
) -> Result<CcusageToolStatus, String>

#[tauri::command]
pub async fn ccusage_install_tools(
    target: String,
    _distro: Option<String>,
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
) -> Result<CcusageToolStatus, String>
```

---

## 3. Contracts

### Plan 9 文件系统限制

| 操作 | Windows 原生 API | WSL UNC 路径行为 | 规避方式 |
|------|-----------------|-----------------|---------|
| 目录枚举 | `fs::read_dir` | **静默失败返回空**（`Err` 被吞掉） | `wsl.exe -d <d> find <path> -type f` |
| 文件元数据 | `fs::metadata` | **可能失败**，mtime/size 不可靠 | `wsl.exe -d <d> stat -c "%s %Y %W" <path>` |
| 读取文件内容 | `File::open` + `BufReader` | **通常可用** | 保持原生方式 |
| libgit2 打开仓库 | `git2::Repository::open` | **Owner (-36) 错误** | 临时关闭 `set_verify_owner_validation` |
| 文件存在检查 | `Path::exists()` / `Path::is_dir()` | **基本可用**但可能误报 | 仅作前置检查，不依赖其精确结果 |

### Batch metadata during WSL history enumeration

When scanning many session files under WSL, do not run `wsl.exe stat` once per file. Batch basic metadata during the `find` pass:

```rust
// Good: one WSL process returns path + size + mtime for every matched file.
wsl.exe -d <distro> find <root> -name "*.jsonl" -type f -printf "%p\t%s\t%T@\n"
```

Cache the parsed fingerprint by the UNC path for the same TTL as the file-list cache. Per-file `wsl.exe stat` is only a fallback when a caller asks for a WSL fingerprint and no fresh batch fingerprint exists.

```rust
// Bad: thousands of session files -> thousands of Windows/WSL process launches.
for path in session_files {
    wsl.exe -d <distro> stat -c "%s %Y %W" path
}
```

### WSL 命令环境变量

```rust
// ccusage / history 扫描中需要传递的 env：
envs.push(("CLAUDE_CONFIG_DIR", path));  // WSL UNC 路径 → 不可靠
// 修复后：检测 WSL → 转为 Linux 路径 → 由 wsl.exe 命令内部解析
```

### WSL Bun / bunx 探测契约

```rust
// Good: WSL 中的 bun / bunx 通过 sh -lc 注入 ~/.bun/bin
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
exec bun --version
```

- 后端不得假设 WSL 的非交互命令会自动加载 `~/.profile` / `~/.bashrc`。
- 对 `bun` / `bunx` 的 WSL 探测与执行，必须显式补上 `BUN_INSTALL` 与 `PATH`。
- `ccusage_install_tools(target="wsl")` 现在是**手动安装边界**：命令必须直接返回“去设置页按提示手动安装”的错误，不能再代替用户执行 `curl` / `sudo` / `apt` / `bun install`。
- 前端展示给用户的 WSL 手动安装命令，应优先使用 `~/.bun/bin/bun ...` 形式，避免刚装完 Bun 时因为 PATH 尚未刷新而出现 `bun: command not found`。

---

## 4. Validation & Error Matrix

| 条件 | 错误信息 |
|------|---------|
| `is_wsl_config_dir` 返回 false | 非 WSL 路径，走原生 fs API |
| `parse_wsl_unc_path` 返回 None | 不是有效 WSL UNC 路径 |
| `find_wsl_exe` 返回 None | wsl.exe 未安装或不在 PATH/SystemRoot |
| `wsl.exe find` 返回非 0 | `wsl_find_session_files: wsl find failed for {path}` (debug log) |
| `wsl.exe stat` 返回非 0 或解析失败 | fingerprint 回退为 `{0, 0, 0}`（强制重新扫描） |
| `set_verify_owner_validation` 后仍失败 | `打开 WSL Git 仓库失败: {e}` |
| `ccusage_install_tools(target="wsl")` | 直接返回“WSL 环境不再支持应用内自动安装，请在设置页手动安装” |
| WSL 已安装 Bun 但 shell 启动文件未生效 | `bun --version` / `bunx` 仍应通过显式注入 `~/.bun/bin` 成功 |

---

## 5. Good / Base / Bad Cases

### Good: WSL 感知的目录扫描

```rust
fn collect_claude_session_files(root: &Path) -> Vec<SessionFileRef> {
    let root_str = root.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&root_str) {
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&root_str) {
            return collect_wsl_claude_session_files(&linux_path, &distro);
        }
    }
    // 原生路径：保持原有逻辑
    if !root.exists() { return Vec::new(); }
    // ... fs::read_dir ...
}
```

### Base: 错误时优雅降级

```rust
fn wsl_session_fingerprint(linux_path: &str, distro: &str) -> SessionFileFingerprint {
    // stat 失败 → 返回零值 fingerprint，触发重新扫描
    // 不影响功能，仅失去缓存加速
}
```

### Good: WSL Bun 状态检测不依赖 shell 初始化

```rust
fn wsl_command_with_bun_path_output(...) -> Result<Output, String> {
    let script = r#"export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}";
export PATH="$BUN_INSTALL/bin:$PATH";
exec bunx ccusage daily --json --offline"#;
    wsl_command_output(distro, "sh", &["-lc", script], &[])
}
```

### Bad: 静默吞掉错误

```rust
// DON'T — 历史遗留的反模式
fn read_dir_entries(dir: &Path) -> Vec<fs::DirEntry> {
    match fs::read_dir(dir) {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),  // ← WSL UNC 路径静默返回空，无日志
    }
}
```

**Fix**: 在函数开头加 WSL 检测，分流到 wsl.exe 命令路径；或在错误分支至少输出 `log::warn!`。

### Bad: 把 WSL 安装当成宿主机静默代执行

```rust
// DON'T — 会触发 unzip/sudo/password/PATH 一系列不可控副作用
wsl.exe -d Ubuntu --exec sh -lc "curl -fsSL https://bun.sh/install | bash"
```

**Fix**: WSL 安装改成手动说明 + 状态检测；应用内只允许宿主机 Windows 的 Bun 安装继续走确认流程。

---

## 6. Tests Required

- `parse_wsl_unc_path` 正常解析、`\\wsl$\` 变体、非 WSL 路径拒绝
- `linux_to_unc_wsl_path` 往返一致性、尾部斜杠处理
- `wsl_find_session_files` 的 find 输出解析（纯解析单测覆盖 path/size/mtime；真实 WSL find 作为集成测试）
- `open_git_repo` 在 WSL UNC 路径下成功打开仓库（需要 WSL 环境）
- `session_matches_project_path` 同时匹配 Windows 盘符 + WSL /mnt + WSL UNC→Linux 三种 project_key
- `ccusage_get_status` 在 WSL 已装 Bun、但未加载 shell PATH 时仍能检测到 `bun` / `bunx`
- `ccusage_install_tools(target="wsl")` 返回手动安装错误，不得启动任何安装命令
- 前端设置页的 WSL 状态按钮在 `ready / manual / unavailable / multi-distro` 四种状态下文案一致

---

## 7. Wrong vs Correct

### Wrong: 直接使用原生 API 操作 WSL UNC 路径

```rust
// DON'T — Plan 9 协议下不可靠
let entries = fs::read_dir("\\\\wsl.localhost\\Ubuntu\\home\\venti\\.claude\\projects")?;
// Outcome: 可能返回空，可能抛权限错误
```

### Correct: 检测 WSL → 走 wsl.exe

```rust
let path_str = path.to_string_lossy();
if crate::wsl::is_wsl_config_dir(&path_str) {
    // 走 wsl.exe 命令
    let (distro, linux_path) = crate::wsl::parse_wsl_unc_path(&path_str).unwrap();
    let output = silent_command("wsl.exe")
        .args(["-d", &distro, "find", &linux_path, "-name", "*.jsonl", "-type", "f"])
        .output()?;
    // 解析 output.stdout
} else {
    // 走原生 fs API
    let entries = fs::read_dir(path)?;
}
```

### Correct: libgit2 WSL 绕过

```rust
fn open_git_repo(path: &Path) -> Result<Repository, String> {
    match Repository::open(path) {
        Ok(repo) => return Ok(repo),
        Err(_) if !is_wsl_config_dir(&path.to_string_lossy()) => return Err(...),
        _ => {}
    }
    // WSL: 临时关闭所有权验证
    unsafe { git2::opts::set_verify_owner_validation(false)?; }
    let result = Repository::open(path);
    unsafe { git2::opts::set_verify_owner_validation(true); }  // 立即恢复
    result
}
```

### Wrong: 直接信任 `wsl.exe --exec bun`

```rust
// DON'T — 非交互命令拿不到 ~/.bun/bin
wsl.exe -d Ubuntu --exec env bun --version
```

### Correct: 显式补 `~/.bun/bin`

```rust
wsl.exe -d Ubuntu --exec sh -lc \
  'export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"; export PATH="$BUN_INSTALL/bin:$PATH"; exec bun --version'
```

---

## Design Decision: wsl.exe over UNC

**Context**: 在 Windows 端访问 WSL 文件系统中的文件。

**Options Considered**:
1. 始终走 `\\wsl.localhost\...` UNC 路径（依赖 Plan 9 协议）
2. 检测 WSL UNC 后切换到 `wsl.exe` 命令
3. 挂载 WSL 目录为 Windows 驱动器号

**Decision**: 选择 Option 2。Plan 9 协议在目录枚举和元数据读取上不可靠（实证：fs::read_dir 静默失败、libgit2 Owner 错误），驱动器映射引入额外配置复杂度。`wsl.exe` 始终可用且直接访问 Linux 文件系统。

**Security**: `wsl.exe` 命令仅在 `is_wsl_config_dir` 确认后执行；libgit2 所有权验证关闭窗口为微秒级，WSL 是本机文件系统非远程共享。
