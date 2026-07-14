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

### Verbatim UNC normalization before WSL scope checks

Windows `canonicalize()` may rewrite a WSL UNC path to verbatim UNC form:

```text
\\wsl.localhost\Ubuntu\home\venti\.codex\sessions
=> \\?\UNC\wsl.localhost\Ubuntu\home\venti\.codex\sessions
```

When history/session code compares a requested file against a WSL history root, normalize `\\?\UNC\wsl.localhost\...` and `\\?\UNC\wsl$\...` back to standard UNC form before calling `parse_wsl_unc_path`. Otherwise the code falls back to plain `PathBuf::starts_with`, and valid WSL session files can be misclassified as `session_file_outside_history_scope`.

```rust
// Bad: thousands of session files -> thousands of Windows/WSL process launches.
for path in session_files {
    wsl.exe -d <distro> stat -c "%s %Y %W" path
}
```

### Host-independent Linux path validation

When Rust code validates an explicit Linux path while running on Windows, do not use `Path::is_absolute()` or `Path::components()` as the authority. On Windows, `/home/me/.claude/...` is not a native absolute path, so host-native path APIs can reject a valid Linux transcript path after it is converted to WSL UNC.

```rust
// Good: validate Linux scope by slash-separated Linux components.
let components: Vec<&str> = linux_path
    .trim()
    .split('/')
    .filter(|part| !part.is_empty())
    .collect();
let safe = linux_path.trim().starts_with('/')
    && !components.iter().any(|part| *part == "." || *part == "..")
    && components.windows(2).any(|w| w == [".claude", "projects"]);
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
- `path_within_history_scope` 接受 `\\wsl$` / `\\wsl.localhost` / `\\?\UNC\wsl*` 三种等价前缀，且仍拒绝历史根目录外部路径
- Linux transcript scope validation must be host-independent: on Windows hosts, `/home/.../.claude/projects/...` and `/home/.../.codex/sessions/...` are still accepted after WSL conversion, while `.` / `..` components are rejected.
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

---

## Scenario: WSL Codex history validation and conversion

### 1. Scope / Trigger

- Trigger: opening, editing, deleting, resuming, or converting a Codex rollout whose config root is under `\\wsl.localhost\...`.
- Goal: Windows-side history validation remains strict without confusing the date directory with the rollout's real project, and conversion never writes Codex's WSL SQLite state through 9P.

### 2. Signatures

```rust
fn resolve_session_file_ref(...) -> Result<SessionFileRef, String>
fn catalog_path_within_roots(source: &str, file_path: &str, roots: &HistoryRoots) -> bool
fn codex_runtime_path(path: &Path) -> String
fn should_register_codex_state_db(path: &Path) -> bool
```

- Existing Tauri command signatures remain unchanged.
- `HistoryConversionResult.file_path` remains a Windows-readable path for the frontend.

### 3. Contracts

- WSL Codex inventory may initially derive `project_key` from `sessions/<year>/...`, but validation must reconcile the matched file with the rollout `cwd` before comparing the requested project key.
- Source and canonical path must match before reading the rollout for project reconciliation; do not parse every candidate file.
- The SQLite catalog and legacy index are caches, not path authorities. Seeded rows, list results, and search results must be filtered against the currently configured source root before reaching the frontend.
- When the configured Codex root changes from native Windows to WSL, an old `C:\...\.codex\sessions\...` row must be omitted rather than passed to detail validation and surfaced as `session_file_outside_history_scope`.
- Codex-owned `session_index.jsonl` and state metadata must store the Linux rollout path (`/home/...`), not the Windows UNC path.
- A WSL `state_5.sqlite` is owned by the Codex process inside Linux. Windows `sqlx` must not open it read-write, even with `busy_timeout`, because WAL/SHM locking is not reliable across Plan 9.
- WSL conversion remains successful after writing rollout/history/session indexes. The explicit `codex resume <id>` command lets Codex discover the rollout and repair its state DB inside WSL.
- Native Windows Codex state registration remains strict and unchanged.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Matched Codex path, enumerated key `2026`, rollout `cwd=/data/tabGo`, requested key `tabGo` | Accept and return `project_key=tabGo` |
| Matched path but reconciled project key differs | `session_file_not_indexed` |
| Source or canonical path differs | `session_file_not_indexed` |
| Cached native Codex path while the active Codex root is WSL | Omit it from legacy seeding, list results, and search results |
| WSL state DB path | Skip Windows-side SQL registration and return success |
| Native state DB write fails | Preserve `codex_state_register_failed` |

### 5. Good / Base / Bad Cases

- Good: only the path-matched Codex rollout is opened to reconcile `cwd`; viewing and editing WSL history work without scanning all rollout contents.
- Good: a background catalog refresh may still be running, but stale rows outside the active source root never enter the visible list or search results.
- Base: an old rollout has no `cwd`; validation falls back to its enumerated project key.
- Bad: compare `project_key` before comparing canonical paths, because WSL date directories produce `2026` while the catalog stores the real project name.
- Bad: trust `roots_key` alone when reading cached catalog rows; old or concurrently refreshed cache data can still contain a path from the previous runtime root.
- Bad: copy or directly update a live WSL WAL database through UNC.

### 6. Tests Required

- A Codex candidate with path-derived key `2026` and rollout `cwd=/data/tabGo` accepts requested key `tabGo` and rejects an unrelated key.
- Catalog scope filtering accepts the active WSL rollout, rejects a native Windows rollout under WSL roots, and accepts canonical native paths under native roots.
- WSL standard and verbatim UNC rollout paths convert to the same Linux runtime path; native paths remain unchanged.
- WSL state DB paths disable direct registration; native state DB paths keep it enabled.
- Run `cargo test history --lib`, `cargo check`, and `npx tsc --noEmit`.
- On Windows with Codex running in WSL, verify conversion succeeds while `state_5.sqlite-wal/-shm` are open and `codex resume <id>` loads the converted rollout.

### 7. Wrong vs Correct

#### Wrong

```rust
if candidate.source != source || candidate.project_key != project_key {
    continue;
}
return cached_rows;
SqliteConnection::connect(state_db_on_wsl_unc).await?;
```

#### Correct

```rust
if candidate.source == source && candidate_path == requested {
    let project_key = project_key_from_rollout_cwd(&candidate_path)
        .unwrap_or(candidate.project_key);
    // Compare the authoritative key only for the matched path.
}

cached_rows.retain(|row| {
    catalog_path_within_roots(&row.source, &row.file_path, roots)
});

if should_register_codex_state_db(&state_db_path) {
    register_codex_thread_native(...).await?;
}
```
