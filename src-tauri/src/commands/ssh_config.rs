use regex::RegexBuilder;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

const CONFIG_FILE_NAME: &str = "config";
const MAX_CONFIG_FILE_BYTES: u64 = 1024 * 1024;
const MAX_CONFIG_FILES: usize = 256;
const MAX_INCLUDE_DEPTH: usize = 16;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigImportHost {
    pub alias: String,
    pub source_file: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigImportWarning {
    pub code: String,
    pub source_file: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigImportPreview {
    pub config_dir: String,
    pub config_file: String,
    pub is_default: bool,
    pub hosts: Vec<SshConfigImportHost>,
    pub warnings: Vec<SshConfigImportWarning>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParseScope {
    Global,
    AllHosts,
    Conditional,
}

#[tauri::command]
pub fn ssh_config_default_directory() -> Result<String, String> {
    Ok(default_ssh_directory()?.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn ssh_config_import_preview(
    config_dir: String,
) -> Result<SshConfigImportPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::app_paths::home_dir_from_env()?;
        build_import_preview(&config_dir, &home)
    })
    .await
    .map_err(|err| format!("ssh_config_import_task_failed: {err}"))?
}

fn default_ssh_directory() -> Result<PathBuf, String> {
    Ok(crate::app_paths::home_dir_from_env()?.join(".ssh"))
}

fn build_import_preview(config_dir: &str, home: &Path) -> Result<SshConfigImportPreview, String> {
    let trimmed = config_dir.trim();
    if trimmed.is_empty() {
        return Err("ssh_config_directory_required".to_string());
    }
    if trimmed.chars().any(|ch| matches!(ch, '\0' | '\r' | '\n')) {
        return Err("ssh_config_directory_invalid".to_string());
    }

    let requested_dir = PathBuf::from(trimmed);
    if !requested_dir.is_absolute() {
        return Err("ssh_config_directory_invalid".to_string());
    }
    let canonical_dir = requested_dir
        .canonicalize()
        .map_err(|_| "ssh_config_directory_not_found".to_string())?;
    if !canonical_dir.is_dir() {
        return Err("ssh_config_directory_not_directory".to_string());
    }

    let config_file = canonical_dir.join(CONFIG_FILE_NAME);
    if !config_file.is_file() {
        return Err("ssh_config_file_not_found".to_string());
    }
    let canonical_file = config_file
        .canonicalize()
        .map_err(|_| "ssh_config_file_not_found".to_string())?;
    let default_dir = home.join(".ssh");
    let normalized_default_dir = default_dir.canonicalize().unwrap_or(default_dir);

    let mut parser = ConfigParser::new(home.to_path_buf());
    parser.parse_file(&canonical_file, ParseScope::Global, 0)?;

    Ok(SshConfigImportPreview {
        config_dir: canonical_dir.to_string_lossy().into_owned(),
        config_file: canonical_file.to_string_lossy().into_owned(),
        is_default: canonical_dir == normalized_default_dir,
        hosts: parser.hosts,
        warnings: parser.warnings,
    })
}

struct ConfigParser {
    home: PathBuf,
    user_config_dir: PathBuf,
    hosts: Vec<SshConfigImportHost>,
    warnings: Vec<SshConfigImportWarning>,
    aliases: HashSet<String>,
    visited: HashSet<PathBuf>,
    stack: HashSet<PathBuf>,
}

impl ConfigParser {
    fn new(home: PathBuf) -> Self {
        Self {
            user_config_dir: home.join(".ssh"),
            home,
            hosts: Vec::new(),
            warnings: Vec::new(),
            aliases: HashSet::new(),
            visited: HashSet::new(),
            stack: HashSet::new(),
        }
    }

    fn parse_file(
        &mut self,
        path: &Path,
        mut scope: ParseScope,
        depth: usize,
    ) -> Result<ParseScope, String> {
        if depth > MAX_INCLUDE_DEPTH {
            return Err("ssh_config_include_limit".to_string());
        }
        let canonical = path
            .canonicalize()
            .map_err(|_| "ssh_config_include_not_found".to_string())?;
        if self.stack.contains(&canonical) {
            return Err("ssh_config_include_cycle".to_string());
        }
        if self.visited.contains(&canonical) {
            return Ok(scope);
        }
        if self.visited.len() >= MAX_CONFIG_FILES {
            return Err("ssh_config_include_limit".to_string());
        }
        let metadata =
            fs::metadata(&canonical).map_err(|_| "ssh_config_read_failed".to_string())?;
        if !metadata.is_file() {
            return Err("ssh_config_include_not_file".to_string());
        }
        if metadata.len() > MAX_CONFIG_FILE_BYTES {
            return Err("ssh_config_file_too_large".to_string());
        }
        let bytes = fs::read(&canonical).map_err(|_| "ssh_config_read_failed".to_string())?;
        let text =
            String::from_utf8(bytes).map_err(|_| "ssh_config_encoding_invalid".to_string())?;
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);

        self.stack.insert(canonical.clone());
        self.visited.insert(canonical.clone());
        let result = self.parse_text(&canonical, text, scope, depth);
        self.stack.remove(&canonical);
        scope = result?;
        Ok(scope)
    }

    fn parse_text(
        &mut self,
        source: &Path,
        text: &str,
        mut scope: ParseScope,
        depth: usize,
    ) -> Result<ParseScope, String> {
        for line in text.lines() {
            let Some((keyword, values)) = parse_directive(line)? else {
                continue;
            };
            match keyword.as_str() {
                "host" => {
                    for alias in values.iter().filter(|value| is_concrete_alias(value)) {
                        let normalized = alias.to_lowercase();
                        if self.aliases.insert(normalized) {
                            self.hosts.push(SshConfigImportHost {
                                alias: alias.clone(),
                                source_file: source.to_string_lossy().into_owned(),
                            });
                        }
                    }
                    scope = if values.len() == 1 && values[0] == "*" {
                        ParseScope::AllHosts
                    } else {
                        ParseScope::Conditional
                    };
                }
                "match" => {
                    scope = if values.len() == 1 && values[0].eq_ignore_ascii_case("all") {
                        ParseScope::AllHosts
                    } else {
                        ParseScope::Conditional
                    };
                }
                "include" if scope != ParseScope::Conditional => {
                    for pattern in values {
                        let included_files = self.expand_include(&pattern)?;
                        for included in included_files {
                            scope = self.parse_file(&included, scope, depth + 1)?;
                        }
                    }
                }
                "include" => self.warnings.push(SshConfigImportWarning {
                    code: "ssh_config_conditional_include_skipped".to_string(),
                    source_file: source.to_string_lossy().into_owned(),
                }),
                _ => {}
            }
        }
        Ok(scope)
    }

    fn expand_include(&self, value: &str) -> Result<Vec<PathBuf>, String> {
        let expanded = expand_environment(value)?;
        let expanded = expanded.replace("%d", &self.home.to_string_lossy());
        let path = if expanded == "~" {
            self.home.clone()
        } else if let Some(relative) = expanded
            .strip_prefix("~/")
            .or_else(|| expanded.strip_prefix("~\\"))
        {
            self.home.join(relative)
        } else {
            let path = PathBuf::from(&expanded);
            if path.is_absolute() {
                path
            } else {
                self.user_config_dir.join(path)
            }
        };
        expand_glob_path(&path)
    }
}

fn parse_directive(line: &str) -> Result<Option<(String, Vec<String>)>, String> {
    let uncommented = strip_comment(line)?;
    let trimmed = uncommented.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let separator = trimmed
        .char_indices()
        .find(|(_, ch)| ch.is_whitespace() || *ch == '=')
        .map(|(index, _)| index)
        .unwrap_or(trimmed.len());
    let keyword = trimmed[..separator].to_ascii_lowercase();
    let values =
        trimmed[separator..].trim_start_matches(|ch: char| ch.is_whitespace() || ch == '=');
    Ok(Some((keyword, split_words(values)?)))
}

fn strip_comment(line: &str) -> Result<String, String> {
    let mut result = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in line.chars() {
        if escaped {
            result.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            result.push(ch);
            escaped = true;
            continue;
        }
        if let Some(current) = quote {
            result.push(ch);
            if ch == current {
                quote = None;
            }
            continue;
        }
        if matches!(ch, '\'' | '"') {
            quote = Some(ch);
            result.push(ch);
        } else if ch == '#' {
            break;
        } else {
            result.push(ch);
        }
    }
    if quote.is_some() || escaped {
        return Err("ssh_config_parse_failed".to_string());
    }
    Ok(result)
}

fn split_words(value: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if chars
                .peek()
                .is_some_and(|next| next.is_whitespace() || matches!(next, '\\' | '\'' | '"' | '#'))
            {
                current.push(chars.next().unwrap());
            } else {
                current.push(ch);
            }
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if matches!(ch, '\'' | '"') {
            quote = Some(ch);
        } else if ch.is_whitespace() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if quote.is_some() {
        return Err("ssh_config_parse_failed".to_string());
    }
    if !current.is_empty() {
        words.push(current);
    }
    Ok(words)
}

fn is_concrete_alias(value: &&String) -> bool {
    !value.is_empty()
        && !value
            .chars()
            .any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '!'))
}

fn expand_environment(value: &str) -> Result<String, String> {
    let mut result = String::new();
    let mut remaining = value;
    while let Some(start) = remaining.find("${") {
        result.push_str(&remaining[..start]);
        let after_start = &remaining[start + 2..];
        let end = after_start
            .find('}')
            .ok_or_else(|| "ssh_config_include_env_invalid".to_string())?;
        let name = &after_start[..end];
        if name.is_empty()
            || !name.chars().enumerate().all(|(index, ch)| {
                ch == '_' || ch.is_ascii_alphanumeric() && (index > 0 || !ch.is_ascii_digit())
            })
        {
            return Err("ssh_config_include_env_invalid".to_string());
        }
        let replacement =
            std::env::var(name).map_err(|_| "ssh_config_include_env_missing".to_string())?;
        result.push_str(&replacement);
        remaining = &after_start[end + 1..];
    }
    result.push_str(remaining);
    Ok(result)
}

fn has_glob(value: &Path) -> bool {
    value
        .to_string_lossy()
        .chars()
        .any(|ch| matches!(ch, '*' | '?' | '['))
}

fn expand_glob_path(path: &Path) -> Result<Vec<PathBuf>, String> {
    if !has_glob(path) {
        if path.is_file() {
            return Ok(vec![path.to_path_buf()]);
        }
        return Err("ssh_config_include_not_found".to_string());
    }

    let mut candidates = vec![PathBuf::new()];
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                for candidate in &mut candidates {
                    candidate.push(prefix.as_os_str());
                }
            }
            Component::RootDir => {
                for candidate in &mut candidates {
                    candidate.push(Path::new(std::path::MAIN_SEPARATOR_STR));
                }
            }
            Component::CurDir => {}
            Component::ParentDir => {
                for candidate in &mut candidates {
                    candidate.push("..");
                }
            }
            Component::Normal(segment) => {
                let segment_text = segment.to_string_lossy();
                if segment_text.chars().any(|ch| matches!(ch, '*' | '?' | '[')) {
                    let matcher = glob_segment_regex(&segment_text)?;
                    let mut expanded = Vec::new();
                    for candidate in candidates {
                        let entries = match fs::read_dir(&candidate) {
                            Ok(entries) => entries,
                            Err(_) => continue,
                        };
                        for entry in entries.flatten() {
                            if matcher.is_match(&entry.file_name().to_string_lossy()) {
                                expanded.push(entry.path());
                            }
                        }
                    }
                    candidates = expanded;
                } else {
                    for candidate in &mut candidates {
                        candidate.push(segment);
                    }
                }
            }
        }
        if candidates.is_empty() {
            break;
        }
    }
    candidates.retain(|candidate| candidate.is_file());
    candidates.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
    candidates.dedup();
    Ok(candidates)
}

fn glob_segment_regex(pattern: &str) -> Result<regex::Regex, String> {
    let mut regex = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '*' => regex.push_str(".*"),
            '?' => regex.push('.'),
            '[' => {
                let Some(relative_end) = chars[index + 1..].iter().position(|ch| *ch == ']') else {
                    return Err("ssh_config_include_pattern_invalid".to_string());
                };
                let end = index + 1 + relative_end;
                regex.push('[');
                let mut class_start = index + 1;
                if chars.get(class_start) == Some(&'!') {
                    regex.push('^');
                    class_start += 1;
                }
                for ch in &chars[class_start..end] {
                    if matches!(ch, '\\' | ']' | '^') {
                        regex.push('\\');
                    }
                    regex.push(*ch);
                }
                regex.push(']');
                index = end;
            }
            ch => regex.push_str(&regex::escape(&ch.to_string())),
        }
        index += 1;
    }
    regex.push('$');
    RegexBuilder::new(&regex)
        .case_insensitive(cfg!(target_os = "windows"))
        .build()
        .map_err(|_| "ssh_config_include_pattern_invalid".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, content: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn parses_bom_crlf_multiple_aliases_and_skips_patterns() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let ssh_dir = home.join(".ssh");
        write(
            &ssh_dir.join("config"),
            b"\xef\xbb\xbfHost prod prod-alt\r\n  HostName example.com\r\nHost * dev-* !blocked\r\n",
        );

        let preview = build_import_preview(ssh_dir.to_str().unwrap(), home).unwrap();

        assert_eq!(
            preview
                .hosts
                .iter()
                .map(|host| host.alias.as_str())
                .collect::<Vec<_>>(),
            vec!["prod", "prod-alt"]
        );
        assert!(preview.is_default);
    }

    #[test]
    fn follows_relative_glob_includes_in_lexical_order() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let ssh_dir = home.join(".ssh");
        write(&ssh_dir.join("config"), b"Include conf.d/*.conf\n");
        write(&ssh_dir.join("conf.d/20-b.conf"), b"Host beta\n");
        write(&ssh_dir.join("conf.d/10-a.conf"), b"Host alpha\n");

        let preview = build_import_preview(ssh_dir.to_str().unwrap(), home).unwrap();

        assert_eq!(
            preview
                .hosts
                .iter()
                .map(|host| host.alias.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "beta"]
        );
    }

    #[test]
    fn rejects_recursive_include_cycles() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let ssh_dir = home.join(".ssh");
        write(&ssh_dir.join("config"), b"Include cycle.conf\n");
        write(&ssh_dir.join("cycle.conf"), b"Include config\n");

        assert_eq!(
            build_import_preview(ssh_dir.to_str().unwrap(), home).unwrap_err(),
            "ssh_config_include_cycle"
        );
    }

    #[test]
    fn skips_conditional_includes_with_warning() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let ssh_dir = home.join(".ssh");
        write(
            &ssh_dir.join("config"),
            b"Host prod\n  Include conditional.conf\nHost visible\n",
        );
        write(&ssh_dir.join("conditional.conf"), b"Host hidden\n");

        let preview = build_import_preview(ssh_dir.to_str().unwrap(), home).unwrap();

        assert_eq!(
            preview
                .hosts
                .iter()
                .map(|host| host.alias.as_str())
                .collect::<Vec<_>>(),
            vec!["prod", "visible"]
        );
        assert_eq!(preview.warnings.len(), 1);
        assert_eq!(
            preview.warnings[0].code,
            "ssh_config_conditional_include_skipped"
        );
    }

    #[test]
    fn rejects_missing_config_file() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let ssh_dir = home.join(".ssh");
        fs::create_dir_all(&ssh_dir).unwrap();

        assert_eq!(
            build_import_preview(ssh_dir.to_str().unwrap(), home).unwrap_err(),
            "ssh_config_file_not_found"
        );
    }

    #[test]
    fn preserves_windows_path_separators_in_tokens() {
        assert_eq!(
            split_words(r#"C:\Users\dev\.ssh\conf.d\*.conf"#).unwrap(),
            vec![r#"C:\Users\dev\.ssh\conf.d\*.conf"#]
        );
    }
}
