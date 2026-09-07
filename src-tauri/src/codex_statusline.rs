use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
const CONFIG_FILE: &str = "config.toml";
const TUI_TABLE: &str = "tui";
const STATUS_LINE_KEY: &str = "status_line";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatuslineConfig {
    pub config_dir: String,
    pub config_path: String,
    pub items: Vec<String>,
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "home_dir_unavailable".to_string())
}

fn resolve_config_dir(config_dir: Option<String>) -> Result<PathBuf, String> {
    match config_dir
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        Some(value) => Ok(PathBuf::from(value)),
        None => crate::provider::home::default_config_root("codex")
            .or_else(|| home_dir().ok().map(|home| home.join(".codex")))
            .ok_or_else(|| "home_dir_unavailable".to_string()),
    }
}

fn table_name(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') && !trimmed.starts_with("[[") {
        Some(trimmed[1..trimmed.len() - 1].trim())
    } else {
        None
    }
}

fn assignment(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('[') {
        return None;
    }
    let (key, value) = trimmed.split_once('=')?;
    Some((key.trim(), value.trim()))
}

fn parse_string_array(raw: &str) -> Option<Vec<String>> {
    let value = raw.split('#').next()?.trim();
    if !value.starts_with('[') || !value.ends_with(']') {
        return None;
    }
    let mut items = Vec::new();
    let mut chars = value[1..value.len() - 1].chars().peekable();
    while let Some(ch) = chars.next() {
        if ch.is_whitespace() || ch == ',' {
            continue;
        }
        if ch != '"' {
            return None;
        }
        let mut item = String::new();
        let mut escaped = false;
        for next in chars.by_ref() {
            if escaped {
                item.push(match next {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    other => other,
                });
                escaped = false;
            } else if next == '\\' {
                escaped = true;
            } else if next == '"' {
                break;
            } else {
                item.push(next);
            }
        }
        items.push(item);
    }
    Some(items)
}

fn parse_status_line(content: &str) -> Result<Vec<String>, String> {
    let mut current_table = "";
    for line in content.lines() {
        if let Some(table) = table_name(line) {
            current_table = table;
            continue;
        }
        if current_table == TUI_TABLE {
            if let Some((key, value)) = assignment(line) {
                if key == STATUS_LINE_KEY {
                    return parse_string_array(value)
                        .ok_or_else(|| "codex_statusline_invalid_array".to_string());
                }
            }
        }
    }
    Ok(Vec::new())
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn status_line_assignment(items: &[String]) -> String {
    format!(
        "{STATUS_LINE_KEY} = [{}]",
        items
            .iter()
            .map(|item| toml_string(item))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn set_status_line(content: &str, items: &[String]) -> String {
    let mut lines: Vec<String> = content.lines().map(str::to_string).collect();
    let mut tui_start = None;
    let mut tui_end = lines.len();
    for (index, line) in lines.iter().enumerate() {
        if let Some(table) = table_name(line) {
            if table == TUI_TABLE {
                tui_start = Some(index);
            } else if tui_start.is_some() {
                tui_end = index;
                break;
            }
        }
    }
    let next_assignment = status_line_assignment(items);
    if let Some(start) = tui_start {
        for index in start + 1..tui_end {
            if assignment(&lines[index])
                .map(|(key, _)| key == STATUS_LINE_KEY)
                .unwrap_or(false)
            {
                lines[index] = next_assignment;
                return finish_lines(lines, content);
            }
        }
        lines.insert(start + 1, next_assignment);
        return finish_lines(lines, content);
    }
    if !lines.is_empty()
        && !lines
            .last()
            .map(|line| line.trim().is_empty())
            .unwrap_or(false)
    {
        lines.push(String::new());
    }
    lines.push("[tui]".to_string());
    lines.push(next_assignment);
    finish_lines(lines, content)
}

fn finish_lines(lines: Vec<String>, original: &str) -> String {
    let mut next = lines.join("\n");
    if original.ends_with('\n') || next.is_empty() {
        next.push('\n');
    }
    next
}

fn is_wsl_path(path: &Path) -> bool {
    crate::wsl::is_wsl_config_dir(&path.to_string_lossy())
}

fn read_config(path: &Path) -> Result<String, String> {
    if is_wsl_path(path) {
        let bytes = crate::provider::global::read_live(&path.to_string_lossy())
            .map_err(|error| format!("codex_config_read_failed: {error}"))?;
        return bytes
            .map(|bytes| {
                String::from_utf8(bytes)
                    .map_err(|error| format!("codex_config_read_failed: {error}"))
            })
            .transpose()
            .map(|content| content.unwrap_or_default());
    }

    if path.exists() {
        fs::read_to_string(path).map_err(|err| format!("codex_config_read_failed: {err}"))
    } else {
        Ok(String::new())
    }
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    if is_wsl_path(path) {
        return atomic_write_wsl(path, content);
    }

    let parent = path
        .parent()
        .ok_or_else(|| "codex_config_path_invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("codex_config_create_dir_failed: {err}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temp = parent.join(format!(
        ".{CONFIG_FILE}.{}.{}.tmp",
        std::process::id(),
        stamp
    ));
    fs::write(&temp, content).map_err(|err| format!("codex_config_write_failed: {err}"))?;
    if path.exists() {
        let backup = parent.join(format!("{CONFIG_FILE}.cli-manager-statusline.bak"));
        fs::copy(path, backup).map_err(|err| format!("codex_config_backup_failed: {err}"))?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        #[cfg(target_os = "windows")]
        if path.exists() {
            fs::remove_file(path).map_err(|err| format!("codex_config_replace_failed: {err}"))?;
            fs::rename(&temp, path).map_err(|err| format!("codex_config_replace_failed: {err}"))?;
            return Ok(());
        }
        let _ = fs::remove_file(&temp);
        return Err(format!("codex_config_replace_failed: {error}"));
    }
    Ok(())
}

fn atomic_write_wsl(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "codex_config_path_invalid".to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temp = parent.join(format!(
        ".{CONFIG_FILE}.{}.{}.tmp",
        std::process::id(),
        stamp
    ));
    let temp_string = temp.to_string_lossy();
    if let Err(error) = crate::provider::global::write_live(&temp_string, content.as_bytes()) {
        return Err(format!("codex_config_write_failed: {error}"));
    }

    let path_string = path.to_string_lossy();
    let existing = match crate::provider::global::read_live(&path_string) {
        Ok(value) => value,
        Err(error) => {
            let _ = crate::provider::global::remove_live(&temp_string);
            return Err(format!("codex_config_read_failed: {error}"));
        }
    };
    if let Some(existing) = existing {
        let backup = parent.join(format!("{CONFIG_FILE}.cli-manager-statusline.bak"));
        let backup_string = backup.to_string_lossy();
        if let Err(error) = crate::provider::global::write_live(&backup_string, &existing) {
            let _ = crate::provider::global::remove_live(&temp_string);
            return Err(format!("codex_config_backup_failed: {error}"));
        }
    }

    if let Err(error) = crate::provider::global::replace_live_from_stage(&path_string, &temp_string)
    {
        let _ = crate::provider::global::remove_live(&temp_string);
        return Err(format!("codex_config_replace_failed: {error}"));
    }
    Ok(())
}

#[tauri::command]
pub fn codex_statusline_load(config_dir: Option<String>) -> Result<CodexStatuslineConfig, String> {
    let dir = resolve_config_dir(config_dir)?;
    let path = dir.join(CONFIG_FILE);
    let content = read_config(&path)?;
    let items = canonicalize_items(parse_status_line(&content)?);
    Ok(CodexStatuslineConfig {
        config_dir: dir.to_string_lossy().to_string(),
        config_path: path.to_string_lossy().to_string(),
        items,
    })
}

#[tauri::command]
pub fn codex_statusline_save(
    config_dir: Option<String>,
    items: Vec<String>,
) -> Result<CodexStatuslineConfig, String> {
    validate_items(&items)?;
    let items = canonicalize_items(items);
    let dir = resolve_config_dir(config_dir)?;
    let path = dir.join(CONFIG_FILE);
    let content = read_config(&path)?;
    atomic_write(&path, &set_status_line(&content, &items))?;
    codex_statusline_load(Some(dir.to_string_lossy().to_string()))
}

pub(crate) fn validate_items(items: &[String]) -> Result<(), String> {
    if items.iter().any(|item| canonical_item_id(item).is_none()) {
        return Err("codex_statusline_unknown_item".to_string());
    }
    Ok(())
}

fn statusline_item_ids() -> &'static [&'static str] {
    &[
        "model",
        "model-with-reasoning",
        "reasoning",
        "current-dir",
        "project-name",
        "hostname",
        "git-branch",
        "pull-request-number",
        "branch-changes",
        "run-state",
        "permissions",
        "approval-mode",
        "context-remaining",
        "context-used",
        "five-hour-limit",
        "weekly-limit",
        "codex-version",
        "context-window-size",
        "used-tokens",
        "total-input-tokens",
        "total-output-tokens",
        "thread-credits",
        "estimated-thread-cost",
        "thread-id",
        "fast-mode",
        "raw-output",
        "thread-title",
        "workspace-headline",
        "task-progress",
    ]
}

fn canonical_item_id(item: &str) -> Option<&'static str> {
    if let Some(&id) = statusline_item_ids().iter().find(|id| **id == item) {
        return Some(id);
    }
    match item {
        "model-name" => Some("model"),
        "project" | "project-root" => Some("project-name"),
        "status" => Some("run-state"),
        "approval" => Some("approval-mode"),
        "context-usage" => Some("context-used"),
        "session-id" => Some("thread-id"),
        _ => None,
    }
}

pub(crate) fn canonicalize_items(items: Vec<String>) -> Vec<String> {
    items
        .into_iter()
        .map(|item| match canonical_item_id(&item) {
            Some(canonical) => canonical.to_string(),
            None => item,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tui_status_line() {
        let raw = "model = \"gpt\"\n\n[tui]\nstatus_line = [\"model\", \"git-branch\"]\n";
        assert_eq!(parse_status_line(raw).unwrap(), vec!["model", "git-branch"]);
    }

    #[test]
    fn updates_tui_without_touching_other_tables() {
        let raw = "model = \"gpt\"\n\n[tui]\nnotifications = true\n\n[features]\nhooks = true\n";
        let next = set_status_line(raw, &["model".to_string(), "context-used".to_string()]);
        assert!(next
            .contains("[tui]\nstatus_line = [\"model\", \"context-used\"]\nnotifications = true"));
        assert!(next.contains("[features]\nhooks = true"));
    }

    #[test]
    fn creates_tui_table_when_missing() {
        let next = set_status_line("model = \"gpt\"\n", &["model".to_string()]);
        assert_eq!(
            next,
            "model = \"gpt\"\n\n[tui]\nstatus_line = [\"model\"]\n"
        );
    }

    #[test]
    fn accepts_all_current_codex_statusline_item_ids() {
        let items = statusline_item_ids()
            .iter()
            .map(|item| (*item).to_string())
            .collect::<Vec<_>>();
        assert!(validate_items(&items).is_ok());
    }

    #[test]
    fn accepts_official_legacy_aliases_and_canonicalizes_them() {
        let aliases = vec![
            "model-name".to_string(),
            "project-root".to_string(),
            "status".to_string(),
            "approval".to_string(),
            "context-usage".to_string(),
            "session-id".to_string(),
        ];
        assert!(validate_items(&aliases).is_ok());
        assert_eq!(
            canonicalize_items(aliases),
            vec![
                "model",
                "project-name",
                "run-state",
                "approval-mode",
                "context-used",
                "thread-id",
            ]
        );
    }

    #[test]
    fn rejects_non_official_thread_name_item() {
        assert_eq!(
            validate_items(&["thread-name".to_string()]).unwrap_err(),
            "codex_statusline_unknown_item"
        );
    }
}
