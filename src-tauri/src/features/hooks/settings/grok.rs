use super::{
    add_hook_command, add_hook_command_with_matcher, build_command, create_live_dir_all,
    ensure_root_object, exact_command_registered, home_dir, hook_exe_for_dir, live_is_dir,
    live_is_file, missing_status, normalize_selected_dir, path_to_string, read_json,
    read_json_if_exists, read_text_if_exists, registered_exact_command, remove_hook_commands,
    remove_live_file, remove_named_hook_command, status_from_checks, write_json, write_text,
    ClaudeHookModule, ToolChecks, ToolHookSettingsStatus, ALL_CLAUDE_HOOK_MODULES,
    CLAUDE_HOOK_EVENTS, GROK_CONFIG_FILE_NAME, GROK_HOOKS_FILE_NAME,
};
use serde_json::Value;
use std::env;
use std::path::{Path, PathBuf};

// 选择显式路径或 Grok 默认配置根，按调用选项创建缺失目录。
pub(super) fn resolve_grok_dir(
    selected_dir: Option<String>,
    create_if_missing: bool,
) -> Result<Option<PathBuf>, String> {
    if let Some(dir) = selected_dir.and_then(|value| normalize_selected_dir(&value)) {
        if live_is_dir(&dir) {
            return Ok(Some(dir));
        }
        if create_if_missing {
            create_live_dir_all(&dir, "创建 Grok 配置目录失败")?;
            return Ok(Some(dir));
        }
        return Ok(None);
    }

    let default_dir = env::var_os("GROK_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::provider::home::default_config_root("grok"))
        .or_else(|| home_dir().map(|home| home.join(".grok")));
    let Some(default_dir) = default_dir else {
        return Ok(None);
    };
    if live_is_dir(&default_dir) {
        Ok(Some(default_dir))
    } else if create_if_missing {
        create_live_dir_all(&default_dir, "创建 Grok 配置目录失败")?;
        Ok(Some(default_dir))
    } else {
        Ok(None)
    }
}

// 拼接 Grok 专用 hooks/cli-manager.json 路径。
pub(super) fn grok_hooks_path(grok_dir: &Path) -> PathBuf {
    grok_dir.join("hooks").join(GROK_HOOKS_FILE_NAME)
}

// 拼接 Grok 主 TOML 配置文件路径。
pub(super) fn grok_config_path(grok_dir: &Path) -> PathBuf {
    grok_dir.join(GROK_CONFIG_FILE_NAME)
}

// 重建托管 Grok 事件，校验写入并关闭、复核跨工具 Hook 兼容。
pub(super) fn install_grok_hooks(grok_dir: &Path) -> Result<(), String> {
    let exe = hook_exe_for_dir(grok_dir)?;
    let hooks_path = grok_hooks_path(grok_dir);
    if let Some(parent) = hooks_path.parent() {
        create_live_dir_all(parent, "创建 Grok hooks 目录失败")?;
    }
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, GROK_HOOKS_FILE_NAME)?;
    remove_hook_commands(&mut settings, &CLAUDE_HOOK_EVENTS, &[]);
    for module in ALL_CLAUDE_HOOK_MODULES {
        apply_named_hook_module(&mut settings, &exe, "grok", module);
    }
    write_json(&hooks_path, &settings)?;
    verify_grok_hooks_file(&hooks_path, &exe)?;
    disable_grok_cross_vendor_hooks(grok_dir)?;
    verify_grok_cross_vendor_isolation(grok_dir)?;
    Ok(())
}

// 安装所选 Grok 模块，升级旧 attention 注册并强制关闭跨工具兼容。
pub(super) fn install_grok_hook_module(
    grok_dir: &Path,
    module: ClaudeHookModule,
) -> Result<(), String> {
    let exe = hook_exe_for_dir(grok_dir)?;
    let hooks_path = grok_hooks_path(grok_dir);
    if let Some(parent) = hooks_path.parent() {
        create_live_dir_all(parent, "创建 Grok hooks 目录失败")?;
    }
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, GROK_HOOKS_FILE_NAME)?;
    if let ClaudeHookModule::Attention = module {
        remove_named_hook_module(&mut settings, "grok", module);
    }
    apply_named_hook_module(&mut settings, &exe, "grok", module);
    write_json(&hooks_path, &settings)?;
    // Module install still enforces isolation so partial installs cannot leave foreign hooks active.
    disable_grok_cross_vendor_hooks(grok_dir)?;
    Ok(())
}

// 重新读取文件，验证 SessionStart 精确命令及非空 hooks 对象。
pub(super) fn verify_grok_hooks_file(hooks_path: &Path, exe: &str) -> Result<(), String> {
    if !live_is_file(hooks_path) {
        return Err(format!(
            "Grok Hook 写入失败：文件不存在 {}",
            path_to_string(hooks_path)
        ));
    }
    let settings = read_json(hooks_path)?;
    let expected = build_command(exe, "grok", "SessionStart");
    if !exact_command_registered(&settings, "SessionStart", &expected) {
        return Err(format!(
            "Grok Hook 写入校验失败：未在 {} 找到 SessionStart 命令",
            path_to_string(hooks_path)
        ));
    }
    if !settings
        .get("hooks")
        .and_then(Value::as_object)
        .is_some_and(|hooks| !hooks.is_empty())
    {
        return Err(format!(
            "Grok Hook 写入校验失败：{} 中 hooks 为空",
            path_to_string(hooks_path)
        ));
    }
    Ok(())
}

// 要求 Grok 的 Claude 和 Cursor Hook 兼容开关均为关闭。
pub(super) fn verify_grok_cross_vendor_isolation(grok_dir: &Path) -> Result<(), String> {
    let config_path = grok_config_path(grok_dir);
    if !grok_cross_vendor_hooks_disabled(&config_path)? {
        return Err(format!(
            "Grok 跨工具 Hook 隔离写入失败：请检查 {} 中 compat.claude.hooks / compat.cursor.hooks",
            path_to_string(&config_path)
        ));
    }
    Ok(())
}

// 移除托管 Grok 命令；hooks 消失时尽力删除文件，否则保留其余配置。
pub(super) fn uninstall_grok_hooks(grok_dir: &Path) -> Result<(), String> {
    let hooks_path = grok_hooks_path(grok_dir);
    if !live_is_file(&hooks_path) {
        return Ok(());
    }
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, GROK_HOOKS_FILE_NAME)?;
    remove_hook_commands(&mut settings, &CLAUDE_HOOK_EVENTS, &[]);
    if settings.get("hooks").is_none() {
        let _ = remove_live_file(&hooks_path);
        return Ok(());
    }
    write_json(&hooks_path, &settings)
}

// 移除所选 Grok 模块，保留其余命令并在 hooks 消失时尝试删除文件。
pub(super) fn uninstall_grok_hook_module(
    grok_dir: &Path,
    module: ClaudeHookModule,
) -> Result<(), String> {
    let hooks_path = grok_hooks_path(grok_dir);
    if !live_is_file(&hooks_path) {
        return Ok(());
    }
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, GROK_HOOKS_FILE_NAME)?;
    remove_named_hook_module(&mut settings, "grok", module);
    if settings.get("hooks").is_none() {
        let _ = remove_live_file(&hooks_path);
        return Ok(());
    }
    write_json(&hooks_path, &settings)
}

// 逐行设置 Grok 的 Claude、Cursor Hook 兼容开关为 false 并写回。
pub(super) fn disable_grok_cross_vendor_hooks(grok_dir: &Path) -> Result<(), String> {
    let config_path = grok_config_path(grok_dir);
    let content = read_text_if_exists(&config_path)?.unwrap_or_default();
    let mut next = set_toml_table_bool(&content, "compat.claude", "hooks", false);
    next = set_toml_table_bool(&next, "compat.cursor", "hooks", false);
    if let Some(parent) = config_path.parent() {
        create_live_dir_all(parent, "创建 Grok 配置目录失败")?;
    }
    write_text(&config_path, &next)
}

/// Set `key = bool` under a dotted table header like `compat.claude`.
/// Creates the table if missing. Preserves unrelated lines.
// 按精确表头文本修改首个匹配布尔赋值，缺项或缺表时插入。
pub(super) fn set_toml_table_bool(content: &str, table: &str, key: &str, value: bool) -> String {
    let header = format!("[{table}]");
    let value_text = if value { "true" } else { "false" };
    let assignment = format!("{key} = {value_text}");
    let mut lines: Vec<String> = content.lines().map(ToString::to_string).collect();

    let header_index = lines.iter().position(|line| line.trim() == header);
    let Some(header_index) = header_index else {
        if !lines.is_empty() && !lines.last().map(|l| l.trim().is_empty()).unwrap_or(true) {
            lines.push(String::new());
        }
        lines.push(header);
        lines.push(assignment);
        lines.push(String::new());
        return format_toml_lines(&lines);
    };

    let mut insert_index = lines.len();
    let mut key_line = None;
    for index in header_index + 1..lines.len() {
        let trimmed = lines[index].trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            insert_index = index;
            break;
        }
        if trimmed
            .split_once('=')
            .is_some_and(|(k, _)| k.trim() == key)
        {
            key_line = Some(index);
            break;
        }
    }
    if let Some(index) = key_line {
        lines[index] = assignment;
    } else {
        lines.insert(insert_index, assignment);
    }
    format_toml_lines(&lines)
}

// 以 LF 合并各行并确保结果以换行结束。
pub(super) fn format_toml_lines(lines: &[String]) -> String {
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

// 读取配置并检查两类兼容 Hook 开关是否都明确为 false。
pub(super) fn grok_cross_vendor_hooks_disabled(config_path: &Path) -> Result<bool, String> {
    let Some(content) = read_text_if_exists(config_path)? else {
        return Ok(false);
    };
    Ok(
        toml_table_bool(&content, "compat.claude", "hooks") == Some(false)
            && toml_table_bool(&content, "compat.cursor", "hooks") == Some(false),
    )
}

// 在精确表头范围内读取首个指定键的布尔值，忽略值后的注释。
pub(super) fn toml_table_bool(content: &str, table: &str, key: &str) -> Option<bool> {
    let header = format!("[{table}]");
    let mut in_table = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_table = trimmed == header;
            continue;
        }
        if !in_table {
            continue;
        }
        if let Some((k, v)) = trimmed.split_once('=') {
            if k.trim() == key {
                let value = v.split('#').next().unwrap_or("").trim();
                return match value {
                    "true" => Some(true),
                    "false" => Some(false),
                    _ => None,
                };
            }
        }
    }
    None
}

// 为指定来源添加模块事件，包含审批及子 Agent 的原生事件映射。
pub(super) fn apply_named_hook_module(
    settings: &mut Value,
    exe: &str,
    source: &str,
    module: ClaudeHookModule,
) {
    match module {
        ClaudeHookModule::SessionStart => add_hook_command(
            settings,
            "SessionStart",
            build_command(exe, source, "SessionStart"),
        ),
        ClaudeHookModule::Running => add_hook_command(
            settings,
            "UserPromptSubmit",
            build_command(exe, source, "UserPromptSubmit"),
        ),
        ClaudeHookModule::Attention => add_hook_command_with_matcher(
            settings,
            "PreToolUse",
            "Bash|Edit|Write|MultiEdit",
            build_command(exe, source, "PermissionRequest"),
        ),
        ClaudeHookModule::Stop => {
            add_hook_command(settings, "Stop", build_command(exe, source, "Stop"))
        }
        ClaudeHookModule::Failure => add_hook_command(
            settings,
            "StopFailure",
            build_command(exe, source, "StopFailure"),
        ),
        ClaudeHookModule::Subagent => {
            add_hook_command(
                settings,
                "SubagentStart",
                build_command(exe, source, "SubagentStart"),
            );
            add_hook_command(
                settings,
                "SubagentStop",
                build_command(exe, source, "SubagentStop"),
            );
            add_hook_command_with_matcher(
                settings,
                "PreToolUse",
                "Agent|Task",
                build_command(exe, source, "AgentToolStart"),
            );
            add_hook_command_with_matcher(
                settings,
                "PostToolUse",
                "Agent|Task",
                build_command(exe, source, "AgentToolStop"),
            );
            add_hook_command(
                settings,
                "PreToolUse",
                build_command(exe, source, "ToolStart"),
            );
            add_hook_command(
                settings,
                "PostToolUse",
                build_command(exe, source, "ToolStop"),
            );
        }
    }
}

// 按模块移除对应来源的桥接命令，attention 同时清理旧 Notification 注册。
pub(super) fn remove_named_hook_module(
    settings: &mut Value,
    source: &str,
    module: ClaudeHookModule,
) {
    match module {
        ClaudeHookModule::SessionStart => {
            remove_named_hook_command(settings, "SessionStart", source, "SessionStart")
        }
        ClaudeHookModule::Running => {
            remove_named_hook_command(settings, "UserPromptSubmit", source, "UserPromptSubmit")
        }
        ClaudeHookModule::Attention => {
            // Remove the obsolete Grok Notification registration during module upgrades.
            remove_named_hook_command(settings, "Notification", source, "Notification");
            remove_named_hook_command(settings, "PreToolUse", source, "PermissionRequest");
        }
        ClaudeHookModule::Stop => remove_named_hook_command(settings, "Stop", source, "Stop"),
        ClaudeHookModule::Failure => {
            remove_named_hook_command(settings, "StopFailure", source, "StopFailure")
        }
        ClaudeHookModule::Subagent => {
            for (hook_event, command_event) in [
                ("SubagentStart", "SubagentStart"),
                ("SubagentStop", "SubagentStop"),
                ("PreToolUse", "AgentToolStart"),
                ("PostToolUse", "AgentToolStop"),
                ("PreToolUse", "ToolStart"),
                ("PostToolUse", "ToolStop"),
            ] {
                remove_named_hook_command(settings, hook_event, source, command_event);
            }
        }
    }
}

// 检查 Grok 精确命令和兼容隔离开关，汇总各模块安装状态。
pub(super) fn build_grok_status(
    grok_dir: Option<PathBuf>,
) -> Result<ToolHookSettingsStatus, String> {
    let Some(grok_dir) = grok_dir else {
        return missing_status();
    };

    let hooks_dir = grok_dir.join("hooks");
    let hooks_path = grok_hooks_path(&grok_dir);
    let config_path = grok_config_path(&grok_dir);
    let exe = hook_exe_for_dir(&grok_dir).ok();
    let settings = read_json_if_exists(&hooks_path)?;
    let registered = |event: &str| {
        exe.as_deref().is_some_and(|exe| {
            exact_command_registered(&settings, event, &build_command(exe, "grok", event))
        })
    };
    let isolation_ok = grok_cross_vendor_hooks_disabled(&config_path)?;
    let checks = ToolChecks {
        attention_script_installed: exe.is_some(),
        finished_script_installed: exe.is_some(),
        session_start_hook_installed: registered("SessionStart"),
        running_hook_installed: registered("UserPromptSubmit"),
        attention_hook_installed: registered_exact_command(
            &settings,
            exe.as_deref(),
            "PreToolUse",
            "grok",
            "PermissionRequest",
        ),
        attention_hook_required: true,
        stop_hook_installed: registered("Stop"),
        failure_hook_installed: registered("StopFailure"),
        failure_hook_required: true,
        subagent_start_hook_installed: registered("SubagentStart")
            && registered("SubagentStop")
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PreToolUse",
                "grok",
                "AgentToolStart",
            )
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PostToolUse",
                "grok",
                "AgentToolStop",
            )
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PreToolUse",
                "grok",
                "ToolStart",
            )
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PostToolUse",
                "grok",
                "ToolStop",
            ),
        subagent_start_hook_required: true,
        // Reuse hooks_feature_installed to mean "cross-vendor hook isolation enabled".
        hooks_feature_installed: isolation_ok,
        hooks_trusted: true,
    };

    Ok(status_from_checks(
        Some(grok_dir),
        Some(hooks_dir),
        Some(hooks_path),
        Some(config_path),
        checks,
    ))
}
