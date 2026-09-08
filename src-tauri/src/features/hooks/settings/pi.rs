use super::{
    create_live_dir_all, home_dir, live_is_dir, live_is_file, missing_status,
    normalize_selected_dir, path_to_string, read_text_if_exists, remove_live_file,
    status_from_checks, write_text, PiHookModule, ToolChecks, ToolHookSettingsStatus,
    ALL_PI_HOOK_MODULES, PI_EXTENSION_CONFLICT_ERROR, PI_EXTENSION_DIR_NAME,
    PI_EXTENSION_FILE_NAME, PI_EXTENSION_MARKER, PI_MODULE_RUNNING, PI_MODULE_SESSION_START,
    PI_MODULE_STOP,
};
use std::path::{Path, PathBuf};

// 选择显式或默认 Pi 目录，仅在允许时创建缺失目录。
pub(super) fn resolve_pi_dir(
    selected_dir: Option<String>,
    create_if_missing: bool,
) -> Result<Option<PathBuf>, String> {
    if let Some(dir) = selected_dir.and_then(|value| normalize_selected_dir(&value)) {
        if live_is_dir(&dir) {
            return Ok(Some(dir));
        }
        if create_if_missing {
            create_live_dir_all(&dir, "创建 Pi 配置目录失败")?;
            return Ok(Some(dir));
        }
        return Ok(None);
    }

    let Some(home_dir) = home_dir() else {
        return Ok(None);
    };
    let default_dir = home_dir.join(".pi").join("agent");
    if live_is_dir(&default_dir) {
        Ok(Some(default_dir))
    } else if create_if_missing {
        create_live_dir_all(&default_dir, "创建 Pi 配置目录失败")?;
        Ok(Some(default_dir))
    } else {
        Ok(None)
    }
}

// 拼接 Pi 自动加载扩展的托管文件路径。
pub(super) fn pi_extension_path(pi_dir: &Path) -> PathBuf {
    pi_dir
        .join(PI_EXTENSION_DIR_NAME)
        .join(PI_EXTENSION_FILE_NAME)
}

// 返回所选 Pi 生命周期模块的源码标记。
pub(super) fn pi_module_marker(module: PiHookModule) -> &'static str {
    match module {
        PiHookModule::SessionStart => PI_MODULE_SESSION_START,
        PiHookModule::Running => PI_MODULE_RUNNING,
        PiHookModule::Stop => PI_MODULE_STOP,
    }
}

// 生成启用指定生命周期模块的 TypeScript 扩展及模块标记。
pub(super) fn pi_extension_source(modules: &[PiHookModule]) -> String {
    let session_start = modules
        .iter()
        .any(|module| matches!(module, PiHookModule::SessionStart));
    let running = modules
        .iter()
        .any(|module| matches!(module, PiHookModule::Running));
    let stop = modules
        .iter()
        .any(|module| matches!(module, PiHookModule::Stop));

    // 内嵌 nonEmpty：修剪可选字符串，空值返回 null，不读写外部状态。
    // 内嵌 postHookEvent：缺少回调环境即返回；携带令牌 POST 到本机 Hook，吞掉请求异常并在 finally 清理计时器。
    // 内嵌 setTimeout 回调：一秒后中止该次 fetch，不启动重试；中止异常由 postHookEvent 捕获。
    // 内嵌 titleFor：将三种通知事件映射为固定标题，无外部副作用。
    // 内嵌 readSessionId：调用可选会话管理器取得 ID，调用异常或空 ID 返回 null。
    // 内嵌默认扩展函数：仅为启用模块注册 Pi 监听器，不等待通知请求，也不捕获注册异常。
    // 内嵌 session_start 回调：读取会话 ID，异步发送 SessionStart，不阻塞 Pi 生命周期。
    // 内嵌 agent_start 回调：读取会话 ID，异步发送 UserPromptSubmit，由发送函数处理网络失败。
    // 内嵌 agent_settled 回调：读取会话 ID，异步发送 Stop，由发送函数处理网络失败。
    let mut source = format!(
        r#"// {marker}
// Managed by CLI-Manager. Do not edit manually; reinstall from Hook settings.
// Bridges Pi Agent lifecycle events into CLI-Manager tab notifications / live stats.

import type {{ ExtensionAPI }} from "@earendil-works/pi-coding-agent";

const MARKER = "{marker}";
const ENABLED = {{
  sessionStart: {session_start},
  running: {running},
  stop: {stop},
}};

type NotifyEvent = "SessionStart" | "UserPromptSubmit" | "Stop";
const HOOK_TIMEOUT_MS = 1_000;

function nonEmpty(value: string | undefined | null): string | null {{
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}}

async function postHookEvent(event: NotifyEvent, sessionId: string | null, message?: string | null) {{
  const tabId = nonEmpty(process.env.CLI_MANAGER_TAB_ID);
  const port = nonEmpty(process.env.CLI_MANAGER_NOTIFY_PORT);
  const token = nonEmpty(process.env.CLI_MANAGER_NOTIFY_TOKEN);
  if (!tabId || !port || !token) return;

  const payload = {{
    tabId,
    source: "pi",
    event,
    title: titleFor(event),
    message: message ?? null,
    sessionId,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
  }};

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HOOK_TIMEOUT_MS);
  try {{
    await fetch(`http://127.0.0.1:${{port}}/api/claude-hook`, {{
      method: "POST",
      headers: {{
        Authorization: `Bearer ${{token}}`,
        "Content-Type": "application/json",
      }},
      body: JSON.stringify(payload),
      signal: controller.signal,
    }});
  }} catch {{
    // Hook bridge failures must never interrupt Pi.
  }} finally {{
    clearTimeout(timeout);
  }}
}}

function titleFor(event: NotifyEvent): string {{
  switch (event) {{
    case "SessionStart":
      return "Pi Agent session started";
    case "UserPromptSubmit":
      return "Pi Agent running";
    case "Stop":
      return "Pi Agent done";
  }}
}}

function readSessionId(ctx: {{ sessionManager?: {{ getSessionId?: () => string | undefined }} }}): string | null {{
  try {{
    return nonEmpty(ctx.sessionManager?.getSessionId?.() ?? null);
  }} catch {{
    return null;
  }}
}}

export default function (pi: ExtensionAPI) {{
  if (ENABLED.sessionStart) {{
    pi.on("session_start", (_event, ctx) => {{
      void postHookEvent("SessionStart", readSessionId(ctx));
    }});
  }}

  if (ENABLED.running) {{
    pi.on("agent_start", (_event, ctx) => {{
      void postHookEvent("UserPromptSubmit", readSessionId(ctx));
    }});
  }}

  if (ENABLED.stop) {{
    pi.on("agent_settled", (_event, ctx) => {{
      void postHookEvent("Stop", readSessionId(ctx));
    }});
  }}

  void MARKER;
}}
"#,
        marker = PI_EXTENSION_MARKER,
        session_start = if session_start { "true" } else { "false" },
        running = if running { "true" } else { "false" },
        stop = if stop { "true" } else { "false" },
    );

    for module in modules {
        source.push_str(&format!("// {}\n", pi_module_marker(*module)));
    }
    source
}

// 识别源码模块标记或启用字段，并兼容旧式全量托管扩展。
pub(super) fn read_pi_modules(content: &str) -> Vec<PiHookModule> {
    let mut modules = Vec::new();
    if content.contains(PI_MODULE_SESSION_START) || content.contains("sessionStart: true") {
        modules.push(PiHookModule::SessionStart);
    }
    if content.contains(PI_MODULE_RUNNING) || content.contains("running: true") {
        modules.push(PiHookModule::Running);
    }
    if content.contains(PI_MODULE_STOP) || content.contains("stop: true") {
        modules.push(PiHookModule::Stop);
    }
    if modules.is_empty()
        && content.contains(PI_EXTENSION_MARKER)
        && content.contains(r#"source: "pi""#)
    {
        modules.extend_from_slice(&ALL_PI_HOOK_MODULES);
    }
    modules
}

// 安装全部 Pi 生命周期模块。
pub(super) fn install_pi_hooks(pi_dir: &Path) -> Result<(), String> {
    install_pi_modules(pi_dir, &ALL_PI_HOOK_MODULES)
}

// 读取现有模块并补入所选模块，再经归属检查重写扩展。
pub(super) fn install_pi_hook_module(pi_dir: &Path, module: PiHookModule) -> Result<(), String> {
    let path = pi_extension_path(pi_dir);
    let mut modules = if live_is_file(&path) {
        let content = read_text_if_exists(&path)?
            .ok_or_else(|| format!("读取 {} 失败: 文件不存在", path_to_string(&path)))?;
        read_pi_modules(&content)
    } else {
        Vec::new()
    };
    if !modules
        .iter()
        .any(|item| std::mem::discriminant(item) == std::mem::discriminant(&module))
    {
        modules.push(module);
    }
    install_pi_modules(pi_dir, &modules)
}

// 仅删除包含 Pi 托管标记的扩展文件。
pub(super) fn uninstall_pi_hooks(pi_dir: &Path) -> Result<(), String> {
    let path = pi_extension_path(pi_dir);
    if live_is_file(&path) {
        let content = read_text_if_exists(&path)?
            .ok_or_else(|| format!("读取 {} 失败: 文件不存在", path_to_string(&path)))?;
        if content.contains(PI_EXTENSION_MARKER) {
            remove_live_file(&path)?;
        }
    }
    Ok(())
}

// 从托管扩展去除指定模块；无剩余模块时删除文件。
pub(super) fn uninstall_pi_hook_module(pi_dir: &Path, module: PiHookModule) -> Result<(), String> {
    let path = pi_extension_path(pi_dir);
    if !live_is_file(&path) {
        return Ok(());
    }
    let content = read_text_if_exists(&path)?
        .ok_or_else(|| format!("读取 {} 失败: 文件不存在", path_to_string(&path)))?;
    if !content.contains(PI_EXTENSION_MARKER) {
        return Ok(());
    }
    let modules: Vec<PiHookModule> = read_pi_modules(&content)
        .into_iter()
        .filter(|item| std::mem::discriminant(item) != std::mem::discriminant(&module))
        .collect();
    if modules.is_empty() {
        remove_live_file(&path)?;
        return Ok(());
    }
    install_pi_modules(pi_dir, &modules)
}

// 模块为空时卸载，否则创建扩展目录并在归属检查后写入源码。
pub(super) fn install_pi_modules(pi_dir: &Path, modules: &[PiHookModule]) -> Result<(), String> {
    if modules.is_empty() {
        return uninstall_pi_hooks(pi_dir);
    }
    let extensions_dir = pi_dir.join(PI_EXTENSION_DIR_NAME);
    create_live_dir_all(
        &extensions_dir,
        &format!("创建 {} 失败", path_to_string(&extensions_dir)),
    )?;
    let path = pi_extension_path(pi_dir);
    ensure_pi_extension_writable(&path)?;
    let source = pi_extension_source(modules);
    write_text(&path, &source)?;
    Ok(())
}

// 允许新建或改写托管扩展，拒绝覆盖无标记的已有内容。
pub(super) fn ensure_pi_extension_writable(path: &Path) -> Result<(), String> {
    match read_text_if_exists(path)? {
        Some(content) if !content.contains(PI_EXTENSION_MARKER) => {
            Err(PI_EXTENSION_CONFLICT_ERROR.to_string())
        }
        Some(_) | None => Ok(()),
    }
}

// 只从归属明确的扩展读取模块，并按 Pi 所需事件汇总安装状态。
pub(super) fn build_pi_status(pi_dir: Option<PathBuf>) -> Result<ToolHookSettingsStatus, String> {
    let Some(pi_dir) = pi_dir else {
        return missing_status();
    };

    let extension_path = pi_extension_path(&pi_dir);
    let hooks_dir = pi_dir.join(PI_EXTENSION_DIR_NAME);
    let content = if live_is_file(&extension_path) {
        read_text_if_exists(&extension_path)?
            .ok_or_else(|| format!("读取 {} 失败: 文件不存在", path_to_string(&extension_path)))?
    } else {
        String::new()
    };
    let owned = content.contains(PI_EXTENSION_MARKER);
    let modules = if owned {
        read_pi_modules(&content)
    } else {
        Vec::new()
    };
    let session_start = modules
        .iter()
        .any(|module| matches!(module, PiHookModule::SessionStart));
    let running = modules
        .iter()
        .any(|module| matches!(module, PiHookModule::Running));
    let stop = modules
        .iter()
        .any(|module| matches!(module, PiHookModule::Stop));

    let checks = ToolChecks {
        attention_script_installed: owned,
        finished_script_installed: owned,
        session_start_hook_installed: session_start,
        running_hook_installed: running,
        attention_hook_installed: false,
        attention_hook_required: false,
        stop_hook_installed: stop,
        failure_hook_installed: false,
        failure_hook_required: false,
        subagent_start_hook_installed: false,
        subagent_start_hook_required: false,
        hooks_feature_installed: owned,
        hooks_trusted: owned,
    };

    Ok(status_from_checks(
        Some(pi_dir),
        Some(hooks_dir),
        Some(extension_path),
        None,
        checks,
    ))
}
