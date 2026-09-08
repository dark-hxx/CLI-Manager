use super::{
    apply_codex_hook_module, cleanup_legacy_scripts, ensure_root_object, hook_exe_for_dir,
    is_cli_manager_command, path_to_string, read_json, read_text_if_exists,
    remove_codex_hook_module, remove_hook_commands, write_json, write_text, CodexHookModule,
    ALL_CODEX_HOOK_COMMAND_MODULES, CODEX_COMMON_CONFIG_HOOKS_MARKER, CODEX_CONFIG_FILE_NAME,
    CODEX_HOOKS_FILE_NAME, CODEX_HOOK_EVENTS, CODEX_LEGACY_SCRIPTS,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

// 重建 Codex 托管事件，开启 hooks 特性、清理旧脚本并写回 JSON。
pub(super) fn install_codex_hooks(codex_dir: &Path) -> Result<(), String> {
    let exe = hook_exe_for_dir(codex_dir)?;
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, "hooks.json")?;
    // 先清掉旧版本注册的条目（含历史 .ps1 命令与本应用 __hook 命令），保证安装即升级
    remove_hook_commands(
        &mut settings,
        &[
            "SessionStart",
            "UserPromptSubmit",
            "PermissionRequest",
            "PreToolUse",
            "PostToolUse",
            "Stop",
            "SubagentStart",
            "SubagentStop",
        ],
        &CODEX_LEGACY_SCRIPTS,
    );
    for module in ALL_CODEX_HOOK_COMMAND_MODULES {
        apply_codex_hook_module(&mut settings, &exe, module);
    }
    ensure_codex_hooks_feature(codex_dir)?;
    // 清理历史 .ps1 脚本文件（若存在），新方案不再依赖脚本文件
    cleanup_legacy_scripts(&codex_dir.join("hooks"), &CODEX_LEGACY_SCRIPTS);
    write_json(&hooks_path, &settings)
}

// 安装所选 Codex 命令模块或单独开启 hooks 特性。
pub(super) fn install_codex_hook_module(
    codex_dir: &Path,
    module: CodexHookModule,
) -> Result<(), String> {
    if matches!(module, CodexHookModule::HooksFeature) {
        return ensure_codex_hooks_feature(codex_dir);
    }
    let exe = hook_exe_for_dir(codex_dir)?;
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, "hooks.json")?;
    apply_codex_hook_module(&mut settings, &exe, module);
    cleanup_legacy_scripts(&codex_dir.join("hooks"), &CODEX_LEGACY_SCRIPTS);
    write_json(&hooks_path, &settings)
}

// 读取 Codex TOML 并将 hooks 特性设置为启用。
pub(super) fn ensure_codex_hooks_feature(codex_dir: &Path) -> Result<(), String> {
    let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
    let content = read_text_if_exists(&config_path)?.unwrap_or_default();
    let next_content = set_toml_feature_hooks_enabled(&content, true);
    write_text(&config_path, &next_content)
}

// 逐行更新 features.hooks；启用可补项补表，禁用不凭空创建。
pub(super) fn set_toml_feature_hooks_enabled(content: &str, enabled: bool) -> String {
    let mut lines: Vec<String> = content.lines().map(ToString::to_string).collect();
    let mut features_header_index = None;
    for (index, line) in lines.iter().enumerate() {
        if line.trim() == "[features]" {
            features_header_index = Some(index);
            break;
        }
    }

    let Some(header_index) = features_header_index else {
        if !enabled {
            return if content.ends_with('\n') {
                content.to_string()
            } else if content.is_empty() {
                String::new()
            } else {
                format!("{content}\n")
            };
        }
        if !lines.is_empty() && lines.last().is_some_and(|line| !line.trim().is_empty()) {
            lines.push(String::new());
        }
        lines.push("[features]".to_string());
        lines.push("hooks = true".to_string());
        return format!("{}\n", lines.join("\n"));
    };

    let mut insert_index = lines.len();
    for index in header_index + 1..lines.len() {
        let trimmed = lines[index].trim();
        if is_toml_table_header(&lines[index]) {
            insert_index = index;
            break;
        }
        if trimmed
            .split_once('=')
            .is_some_and(|(key, _)| key.trim() == "hooks")
        {
            lines[index] = format!("hooks = {}", if enabled { "true" } else { "false" });
            return format!("{}\n", lines.join("\n"));
        }
    }

    if !enabled {
        return format!("{}\n", lines.join("\n"));
    }

    lines.insert(insert_index, "hooks = true".to_string());
    format!("{}\n", lines.join("\n"))
}

// 合并启用标记及托管信任块，新 features 表插在首个已有表之前。
pub(super) fn merge_codex_common_config_toml(
    existing: Option<&str>,
    hook_state_blocks: &[Vec<String>],
) -> String {
    let Some(raw) = existing.filter(|value| !value.trim().is_empty()) else {
        let mut lines = vec![
            "[features]".to_string(),
            format!("hooks = true {CODEX_COMMON_CONFIG_HOOKS_MARKER}"),
        ];
        merge_codex_common_config_hook_state_blocks(&mut lines, hook_state_blocks);
        return format!("{}\n", lines.join("\n"));
    };

    let mut lines: Vec<String> = raw.lines().map(ToString::to_string).collect();
    let mut features_header_index = None;
    for (index, line) in lines.iter().enumerate() {
        if line.trim() == "[features]" {
            features_header_index = Some(index);
            break;
        }
    }

    let Some(header_index) = features_header_index else {
        let insert_index = first_toml_table_header_index(&lines).unwrap_or(lines.len());
        let mut block = Vec::new();
        if insert_index > 0 && !lines[insert_index - 1].trim().is_empty() {
            block.push(String::new());
        }
        block.push("[features]".to_string());
        block.push(format!("hooks = true {CODEX_COMMON_CONFIG_HOOKS_MARKER}"));
        if insert_index < lines.len() {
            block.push(String::new());
        }
        lines.splice(insert_index..insert_index, block);
        merge_codex_common_config_hook_state_blocks(&mut lines, hook_state_blocks);
        return format!("{}\n", lines.join("\n"));
    };

    let mut insert_index = lines.len();
    for index in header_index + 1..lines.len() {
        let trimmed = lines[index].trim();
        if is_toml_table_header(&lines[index]) {
            insert_index = index;
            break;
        }
        if trimmed.split_once('=').is_some_and(|(key, value)| {
            key.trim() == "hooks" && toml_bool_value(value) == Some(true)
        }) {
            merge_codex_common_config_hook_state_blocks(&mut lines, hook_state_blocks);
            return format!("{}\n", lines.join("\n"));
        }
        if trimmed
            .split_once('=')
            .is_some_and(|(key, _)| key.trim() == "hooks")
        {
            lines[index] = format!("hooks = true {CODEX_COMMON_CONFIG_HOOKS_MARKER}");
            merge_codex_common_config_hook_state_blocks(&mut lines, hook_state_blocks);
            return format!("{}\n", lines.join("\n"));
        }
    }

    lines.insert(
        insert_index,
        format!("hooks = true {CODEX_COMMON_CONFIG_HOOKS_MARKER}"),
    );
    merge_codex_common_config_hook_state_blocks(&mut lines, hook_state_blocks);
    format!("{}\n", lines.join("\n"))
}

// 查找首个满足文本表头形状的行索引。
pub(super) fn first_toml_table_header_index(lines: &[String]) -> Option<usize> {
    lines.iter().position(|line| is_toml_table_header(line))
}

// 按裁剪后首尾方括号判断表头形状，不解析完整 TOML。
pub(super) fn is_toml_table_header(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('[') && trimmed.ends_with(']')
}

// 移除旧标记块及同键信任块，再在选定位置插入新托管块。
pub(super) fn merge_codex_common_config_hook_state_blocks(
    lines: &mut Vec<String>,
    hook_state_blocks: &[Vec<String>],
) {
    let hook_state_keys: Vec<String> = hook_state_blocks
        .iter()
        .filter_map(|block| block.first())
        .filter_map(|line| toml_hooks_state_key(line))
        .collect();

    remove_marker_owned_codex_hook_state_blocks(lines);
    remove_codex_hook_state_blocks(lines, &hook_state_keys);
    trim_empty_lines(lines);

    if hook_state_blocks.is_empty() {
        return;
    }

    let insert_index = codex_hook_state_insert_index(lines);
    let mut block = Vec::new();
    if insert_index > 0 && !lines[insert_index - 1].trim().is_empty() {
        block.push(String::new());
    }
    for state_block in hook_state_blocks {
        block.push(CODEX_COMMON_CONFIG_HOOKS_MARKER.to_string());
        block.extend(state_block.iter().cloned());
        block.push(String::new());
    }
    if insert_index < lines.len() && block.last().is_some_and(|line| !line.trim().is_empty()) {
        block.push(String::new());
    }
    lines.splice(insert_index..insert_index, block);
    trim_empty_lines(lines);
}

// 选择 features 表之后、下个表之前的位置插入信任块。
pub(super) fn codex_hook_state_insert_index(lines: &[String]) -> usize {
    let Some(features_index) = lines.iter().position(|line| line.trim() == "[features]") else {
        return first_toml_table_header_index(lines).unwrap_or(lines.len());
    };
    for index in features_index + 1..lines.len() {
        if is_toml_table_header(&lines[index]) {
            return index;
        }
    }
    lines.len()
}

// 删除紧随托管标记的信任表及其后直到下个表头的内容。
pub(super) fn remove_marker_owned_codex_hook_state_blocks(lines: &mut Vec<String>) {
    let mut next = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        if lines[index].trim() == CODEX_COMMON_CONFIG_HOOKS_MARKER
            && lines
                .get(index + 1)
                .and_then(|line| toml_hooks_state_key(line))
                .is_some()
        {
            index += 2;
            while index < lines.len() && !is_toml_table_header(&lines[index]) {
                index += 1;
            }
            continue;
        }
        next.push(lines[index].clone());
        index += 1;
    }
    *lines = next;
}

// 按解析后的信任键删除指定表块及相邻前置托管标记。
pub(super) fn remove_codex_hook_state_blocks(lines: &mut Vec<String>, hook_state_keys: &[String]) {
    if hook_state_keys.is_empty() {
        return;
    }

    let mut next = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let remove_block = toml_hooks_state_key(&lines[index])
            .is_some_and(|key| hook_state_keys.iter().any(|expected| expected == &key));
        if remove_block {
            if next
                .last()
                .is_some_and(|line: &String| line.trim() == CODEX_COMMON_CONFIG_HOOKS_MARKER)
            {
                next.pop();
            }
            index += 1;
            while index < lines.len() && !is_toml_table_header(&lines[index]) {
                index += 1;
            }
            continue;
        }
        next.push(lines[index].clone());
        index += 1;
    }
    *lines = next;
}

// 原地移除首尾空白行，不改变中间行。
pub(super) fn trim_empty_lines(lines: &mut Vec<String>) {
    while lines.first().is_some_and(|line| line.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
}

// 按当前 hooks 文件路径、事件名和数组位置生成托管命令信任键。
pub(super) fn codex_cli_manager_hook_state_keys(
    settings: &Value,
    hooks_path: &Path,
) -> Vec<String> {
    let hooks_path = path_to_string(hooks_path);
    let Some(hooks) = settings.get("hooks").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut keys = Vec::new();
    for event in CODEX_HOOK_EVENTS {
        let Some(event_name) = codex_hook_state_event_name(event) else {
            continue;
        };
        let Some(entries) = hooks.get(event).and_then(Value::as_array) else {
            continue;
        };
        for (entry_index, entry) in entries.iter().enumerate() {
            let Some(commands) = entry.get("hooks").and_then(Value::as_array) else {
                continue;
            };
            for (hook_index, hook) in commands.iter().enumerate() {
                if is_cli_manager_command(hook, &CODEX_LEGACY_SCRIPTS) {
                    keys.push(format!(
                        "{hooks_path}:{event_name}:{entry_index}:{hook_index}"
                    ));
                }
            }
        }
    }
    keys
}

// 将受支持的 Codex 原生事件映射为信任状态使用的蛇形名称。
pub(super) fn codex_hook_state_event_name(event: &str) -> Option<&'static str> {
    match event {
        "PermissionRequest" => Some("permission_request"),
        "PreToolUse" => Some("pre_tool_use"),
        "PostToolUse" => Some("post_tool_use"),
        "SessionStart" => Some("session_start"),
        "UserPromptSubmit" => Some("user_prompt_submit"),
        "Stop" => Some("stop"),
        "SubagentStart" => Some("subagent_start"),
        "SubagentStop" => Some("subagent_stop"),
        _ => None,
    }
}

// 检查至少一条托管 Hook 存在，且其信任状态未禁用、哈希均匹配。
pub(super) fn codex_cli_manager_hooks_trusted(
    settings: &Value,
    hooks_path: &Path,
    config_path: &Path,
) -> Result<bool, String> {
    let Some(config) = read_text_if_exists(config_path)? else {
        return Ok(false);
    };
    let config: toml::Value = toml::from_str(&config)
        .map_err(|err| format!("解析 {} 失败: {err}", path_to_string(config_path)))?;
    let state = config
        .get("hooks")
        .and_then(|value| value.get("state"))
        .and_then(toml::Value::as_table);
    let Some(hooks) = settings.get("hooks").and_then(Value::as_object) else {
        return Ok(false);
    };

    let mut found = false;
    for event in CODEX_HOOK_EVENTS {
        let Some(event_name) = codex_hook_state_event_name(event) else {
            continue;
        };
        let Some(entries) = hooks.get(event).and_then(Value::as_array) else {
            continue;
        };
        for (entry_index, entry) in entries.iter().enumerate() {
            let Some(commands) = entry.get("hooks").and_then(Value::as_array) else {
                continue;
            };
            for (hook_index, hook) in commands.iter().enumerate() {
                if !is_cli_manager_command(hook, &CODEX_LEGACY_SCRIPTS) {
                    continue;
                }
                found = true;
                let key = format!(
                    "{}:{event_name}:{entry_index}:{hook_index}",
                    path_to_string(hooks_path)
                );
                let Some(entry_state) = state.and_then(|state| state.get(&key)) else {
                    return Ok(false);
                };
                if entry_state.get("enabled").and_then(toml::Value::as_bool) == Some(false) {
                    return Ok(false);
                }
                let trusted_hash = entry_state
                    .get("trusted_hash")
                    .and_then(toml::Value::as_str);
                if trusted_hash != Some(codex_hook_trusted_hash(event, entry, hook)?.as_str()) {
                    return Ok(false);
                }
            }
        }
    }
    Ok(found)
}

// 规范化命令默认值及参与匹配的字段，计算带前缀的 SHA-256 信任哈希。
pub(super) fn codex_hook_trusted_hash(
    event: &str,
    group: &Value,
    hook: &Value,
) -> Result<String, String> {
    let mut normalized_hook = serde_json::Map::new();
    normalized_hook.insert("type".to_string(), json!("command"));
    normalized_hook.insert(
        "command".to_string(),
        hook.get("command").cloned().unwrap_or(Value::Null),
    );
    let timeout = hook
        .get("timeout")
        .and_then(Value::as_u64)
        .unwrap_or(600)
        .max(1);
    normalized_hook.insert("timeout".to_string(), json!(timeout));
    normalized_hook.insert(
        "async".to_string(),
        json!(hook.get("async").and_then(Value::as_bool).unwrap_or(false)),
    );
    if let Some(status_message) = hook.get("statusMessage") {
        normalized_hook.insert("statusMessage".to_string(), status_message.clone());
    }

    let mut normalized_group = serde_json::Map::new();
    normalized_group.insert(
        "event_name".to_string(),
        json!(codex_hook_state_event_name(event)),
    );
    if matches!(
        event,
        "PermissionRequest"
            | "PreToolUse"
            | "PostToolUse"
            | "SessionStart"
            | "SubagentStart"
            | "SubagentStop"
    ) {
        if let Some(matcher) = group.get("matcher") {
            normalized_group.insert("matcher".to_string(), matcher.clone());
        }
    }
    normalized_group.insert(
        "hooks".to_string(),
        Value::Array(vec![Value::Object(normalized_hook)]),
    );
    let canonical = serde_json::to_vec(&Value::Object(normalized_group))
        .map_err(|err| format!("序列化 Codex hook 信任数据失败: {err}"))?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical)))
}

// 借助 TOML 解析取得单个信任表的实际键值，兼容不同引号形式。
pub(super) fn toml_hooks_state_key(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if !trimmed.starts_with("[hooks.state.") || !is_toml_table_header(trimmed) {
        return None;
    }

    let probe = format!("{trimmed}\n__cli_manager_probe = true");
    let parsed: toml::Value = toml::from_str(&probe).ok()?;
    let state = parsed.get("hooks")?.get("state")?.as_table()?;
    (state.len() == 1)
        .then(|| state.keys().next().cloned())
        .flatten()
}

// 只对指定托管键保留最后一个信任表块，无重复时不生成新文本。
pub(super) fn deduplicate_codex_hook_state_blocks(
    config: &str,
    expected_keys: &[String],
) -> Option<String> {
    if expected_keys.is_empty() {
        return None;
    }

    let lines: Vec<String> = config.lines().map(ToString::to_string).collect();
    let mut seen_keys = Vec::new();
    let mut remove_ranges = Vec::new();
    for index in (0..lines.len()).rev() {
        let Some(key) = toml_hooks_state_key(&lines[index]) else {
            continue;
        };
        if !expected_keys.iter().any(|expected| expected == &key) {
            continue;
        }
        if !seen_keys.iter().any(|seen| seen == &key) {
            seen_keys.push(key);
            continue;
        }

        let start = index
            .checked_sub(1)
            .filter(|previous| lines[*previous].trim() == CODEX_COMMON_CONFIG_HOOKS_MARKER)
            .unwrap_or(index);
        let end = lines
            .iter()
            .enumerate()
            .skip(index + 1)
            .find_map(|(next, line)| is_toml_table_header(line).then_some(next))
            .unwrap_or(lines.len());
        remove_ranges.push(start..end);
    }
    if remove_ranges.is_empty() {
        return None;
    }

    let mut next_lines: Vec<String> = lines
        .into_iter()
        .enumerate()
        .filter_map(|(index, line)| {
            (!remove_ranges.iter().any(|range| range.contains(&index))).then_some(line)
        })
        .collect();
    trim_empty_lines(&mut next_lines);
    Some(format!("{}\n", next_lines.join("\n")))
}

// 转义 TOML 基本字符串中的反斜杠与双引号。
pub(super) fn toml_escape_basic_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

// 去除行尾注释并读取精确 true 或 false 字面量。
pub(super) fn toml_bool_value(value: &str) -> Option<bool> {
    match value.split('#').next().unwrap_or("").trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

// 按行检查 features 表中的 hooks 赋值是否精确为 true。
pub(super) fn codex_hooks_feature_installed(config_path: &Path) -> Result<bool, String> {
    let Some(content) = read_text_if_exists(config_path)? else {
        return Ok(false);
    };
    let mut in_features = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if is_toml_table_header(line) {
            in_features = trimmed == "[features]";
            continue;
        }
        if in_features
            && trimmed.split_once('=').is_some_and(|(key, value)| {
                key.trim() == "hooks" && toml_bool_value(value) == Some(true)
            })
        {
            return Ok(true);
        }
    }
    Ok(false)
}

// 清理旧脚本并移除托管 Codex 命令，保留特性开关和其他 JSON 内容。
pub(super) fn uninstall_codex_hooks(codex_dir: &Path) -> Result<(), String> {
    cleanup_legacy_scripts(&codex_dir.join("hooks"), &CODEX_LEGACY_SCRIPTS);

    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, "hooks.json")?;
    remove_hook_commands(
        &mut settings,
        &[
            "SessionStart",
            "UserPromptSubmit",
            "PermissionRequest",
            "PreToolUse",
            "PostToolUse",
            "Stop",
            "SubagentStart",
            "SubagentStop",
        ],
        &CODEX_LEGACY_SCRIPTS,
    );
    write_json(&hooks_path, &settings)
}

// 移除指定 Codex 命令模块，或单独关闭 hooks 特性。
pub(super) fn uninstall_codex_hook_module(
    codex_dir: &Path,
    module: CodexHookModule,
) -> Result<(), String> {
    if matches!(module, CodexHookModule::HooksFeature) {
        return disable_codex_hooks_feature(codex_dir);
    }
    cleanup_legacy_scripts(&codex_dir.join("hooks"), &CODEX_LEGACY_SCRIPTS);
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let mut settings = read_json(&hooks_path)?;
    ensure_root_object(&settings, "hooks.json")?;
    remove_codex_hook_module(&mut settings, module);
    write_json(&hooks_path, &settings)
}

// 读取 Codex 配置并写回关闭 hooks 特性的结果。
pub(super) fn disable_codex_hooks_feature(codex_dir: &Path) -> Result<(), String> {
    let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
    let content = read_text_if_exists(&config_path)?.unwrap_or_default();
    let next_content = set_toml_feature_hooks_enabled(&content, false);
    write_text(&config_path, &next_content)
}
