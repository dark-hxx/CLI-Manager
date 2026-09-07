use super::{detect_home_dir, resolve_codex_config_root, HistoryRoots};
use std::path::{Path, PathBuf};

pub(super) fn codex_config_string(roots: &HistoryRoots, key: &str) -> Option<String> {
    let raw = fs::read_to_string(resolve_codex_config_root(roots).join("config.toml")).ok()?;
    parse_top_level_toml_string(&raw, key)
}

pub(super) fn parse_top_level_toml_string(raw: &str, key: &str) -> Option<String> {
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            return None;
        }
        let Some((left, right)) = trimmed.split_once('=') else {
            continue;
        };
        if left.trim() != key {
            continue;
        }
        return parse_toml_string_value(right.trim());
    }
    None
}

pub(super) fn parse_toml_string_value(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let quote = raw.chars().next()?;
    if quote == '"' || quote == '\'' {
        let mut escaped = false;
        let mut out = String::new();
        for ch in raw[quote.len_utf8()..].chars() {
            if quote == '"' && escaped {
                out.push(match ch {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    '"' => '"',
                    '\\' => '\\',
                    other => other,
                });
                escaped = false;
                continue;
            }
            if quote == '"' && ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == quote {
                return Some(out);
            }
            out.push(ch);
        }
        return None;
    }
    raw.split('#')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(super) fn expand_codex_config_path(root: &Path, value: &str) -> PathBuf {
    let trimmed = value.trim();
    let expanded = if let Some(rest) = trimmed.strip_prefix("~/") {
        detect_home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(trimmed))
    } else if let Some(rest) = trimmed.strip_prefix("~\\") {
        detect_home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(trimmed))
    } else {
        PathBuf::from(trimmed)
    };
    if expanded.is_absolute() {
        expanded
    } else {
        root.join(expanded)
    }
}
use std::fs;
