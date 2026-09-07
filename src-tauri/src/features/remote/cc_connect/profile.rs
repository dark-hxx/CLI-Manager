use super::{
    control_work_dir, data_dir, handoff_session, normalize_executable_path_value,
    platform_type, profile_path, user_path_string, weixin_account_dir_at, write_file_atomically,
    CcConnectAgent, CcConnectManager, CcConnectPlatform, CcConnectPlatformProfile,
    CcConnectProfile, CC_CONNECT_PLATFORMS, CONTROL_PROJECT_ID, CONTROL_PROJECT_NAME,
    MAX_TURN_TIME_MINS,
};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self};
use std::path::{Path, PathBuf};

pub(super) fn copy_profile_state_file_if_missing(
    source: &Path,
    target: &Path,
    label: &'static str,
) -> Result<(), String> {
    if target.is_file() || !source.is_file() {
        return Ok(());
    }
    let payload = fs::read(source).map_err(|err| format!("read legacy {label} failed: {err}"))?;
    write_file_atomically(target, &payload, label)
}

pub(super) fn migrate_legacy_profile_state_at(
    profile: &CcConnectProfile,
    control_path: &Path,
    data_root: &Path,
) -> Result<(), String> {
    let legacy_path = PathBuf::from(profile.project_path.trim());
    if legacy_path.is_absolute() && !profile.project_name.trim().is_empty() {
        let sessions_root = data_root.to_path_buf();
        let source = handoff_session::cc_session_store_path(
            &sessions_root,
            &profile.project_name,
            &user_path_string(&legacy_path),
        )?;
        let target = handoff_session::cc_session_store_path(
            &sessions_root,
            CONTROL_PROJECT_NAME,
            &user_path_string(control_path),
        )?;
        copy_profile_state_file_if_missing(&source, &target, "cc-connect control session")?;
    }

    if !profile.project_name.trim().is_empty() && !profile.project_id.trim().is_empty() {
        let source_dir =
            weixin_account_dir_at(data_root, &profile.project_name, &profile.project_id);
        let target_dir = weixin_account_dir_at(data_root, CONTROL_PROJECT_NAME, CONTROL_PROJECT_ID);
        for filename in ["context_tokens.json", "get_updates.buf"] {
            copy_profile_state_file_if_missing(
                &source_dir.join(filename),
                &target_dir.join(filename),
                "Weixin control state",
            )?;
        }
    }
    Ok(())
}

pub(super) fn migrate_legacy_profile_state(
    profile: &CcConnectProfile,
    control_path: &Path,
) -> Result<(), String> {
    migrate_legacy_profile_state_at(profile, control_path, &data_dir()?)
}

pub(super) fn set_control_profile_values(
    profile: &mut CcConnectProfile,
    control_path: &Path,
) -> bool {
    let runtime_project_id = profile
        .runtime_project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let changed = profile.project_id != CONTROL_PROJECT_ID
        || profile.project_name != CONTROL_PROJECT_NAME
        || profile.agent != CcConnectAgent::Codex
        || profile.runtime_project_id != runtime_project_id
        || PathBuf::from(&profile.project_path)
            .canonicalize()
            .map(|path| path != control_path)
            .unwrap_or(true);
    profile.project_id = CONTROL_PROJECT_ID.to_string();
    profile.project_name = CONTROL_PROJECT_NAME.to_string();
    profile.project_path = user_path_string(control_path);
    profile.agent = CcConnectAgent::Codex;
    profile.runtime_project_id = runtime_project_id;
    changed
}

pub(super) fn apply_control_profile(profile: &mut CcConnectProfile) -> Result<bool, String> {
    let control_path = control_work_dir()?;
    let legacy_profile = profile.clone();
    let changed = set_control_profile_values(profile, &control_path);
    if changed {
        migrate_legacy_profile_state(&legacy_profile, &control_path)?;
    }
    Ok(changed)
}

pub(super) fn load_profile() -> Result<Option<CcConnectProfile>, String> {
    let path = profile_path()?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("read cc-connect profile failed: {err}")),
    };
    let mut profile: CcConnectProfile = serde_json::from_str(&raw)
        .map_err(|err| format!("parse cc-connect profile failed: {err}"))?;
    profile.executable_path = normalize_executable_path_value(profile.executable_path.as_deref());
    hydrate_profile_platforms(&mut profile);
    if handoff_session::load_handoff_record()?.is_none() && apply_control_profile(&mut profile)? {
        persist_profile(&profile)?;
    }
    Ok(Some(profile))
}

pub(super) fn persist_profile(profile: &CcConnectProfile) -> Result<(), String> {
    let path = profile_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create remote manager dir failed: {err}"))?;
    }
    let payload = serde_json::to_string_pretty(profile)
        .map_err(|err| format!("serialize cc-connect profile failed: {err}"))?;
    write_file_atomically(&path, payload.as_bytes(), "cc-connect profile")
}

pub(super) fn profile_platforms(profile: &CcConnectProfile) -> Vec<CcConnectPlatformProfile> {
    if profile.platforms.is_empty() {
        return vec![CcConnectPlatformProfile {
            platform: profile.platform,
            enabled: true,
            allow_from: profile.allow_from.clone(),
        }];
    }
    profile.platforms.clone()
}

pub(super) fn hydrate_profile_platforms(profile: &mut CcConnectProfile) {
    let legacy_platform = profile.platform;
    let legacy_allow_from = profile.allow_from.clone();
    let had_platforms = !profile.platforms.is_empty();
    let mut configured = BTreeMap::new();
    for platform in profile.platforms.drain(..) {
        configured.entry(platform.platform).or_insert(platform);
    }
    if !had_platforms {
        configured.insert(
            legacy_platform,
            CcConnectPlatformProfile {
                platform: legacy_platform,
                enabled: true,
                allow_from: legacy_allow_from,
            },
        );
    }
    profile.platforms = CC_CONNECT_PLATFORMS
        .into_iter()
        .map(|platform| {
            configured
                .remove(&platform)
                .unwrap_or(CcConnectPlatformProfile {
                    platform,
                    enabled: false,
                    allow_from: String::new(),
                })
        })
        .collect();
    profile.allow_from = profile
        .platforms
        .iter()
        .find(|item| item.platform == profile.platform)
        .map(|item| item.allow_from.clone())
        .unwrap_or_default();
}

pub(super) fn enabled_platforms(profile: &CcConnectProfile) -> Vec<CcConnectPlatformProfile> {
    profile_platforms(profile)
        .into_iter()
        .filter(|item| item.enabled)
        .collect()
}

pub(super) fn platform_profile(
    profile: &CcConnectProfile,
    platform: CcConnectPlatform,
) -> Option<CcConnectPlatformProfile> {
    profile_platforms(profile)
        .into_iter()
        .find(|item| item.platform == platform)
}

pub(super) fn set_platform_allow_from(
    profile: &mut CcConnectProfile,
    platform: CcConnectPlatform,
    allow_from: String,
) {
    hydrate_profile_platforms(profile);
    if let Some(item) = profile
        .platforms
        .iter_mut()
        .find(|item| item.platform == platform)
    {
        item.allow_from = allow_from.clone();
    }
    if profile.platform == platform {
        profile.allow_from = allow_from;
    }
}

pub(super) fn prepare_weixin_authorization_platforms(
    profile: &mut CcConnectProfile,
) -> Result<String, String> {
    if profile.platform != CcConnectPlatform::Weixin {
        return Err("select the Weixin platform before authorization".to_string());
    }
    hydrate_profile_platforms(profile);

    let existing_allow_from = platform_profile(profile, CcConnectPlatform::Weixin)
        .map(|item| item.allow_from)
        .and_then(|value| normalize_allow_from(CcConnectPlatform::Weixin, &value).ok())
        .unwrap_or_default();

    for item in &mut profile.platforms {
        if item.platform == CcConnectPlatform::Weixin {
            item.enabled = true;
            item.allow_from = "authorization-pending@im.wechat".to_string();
        } else if item.enabled && normalize_allow_from(item.platform, &item.allow_from).is_err() {
            // An unfinished draft for another platform cannot participate in a
            // runnable profile. Preserve its values, but keep Weixin setup
            // isolated instead of rejecting the QR authorization.
            item.enabled = false;
        }
    }
    profile.allow_from = "authorization-pending@im.wechat".to_string();
    Ok(existing_allow_from)
}

pub(super) fn normalize_profile(
    manager: &CcConnectManager,
    mut profile: CcConnectProfile,
) -> Result<CcConnectProfile, String> {
    hydrate_profile_platforms(&mut profile);
    if profile.max_turn_time_mins > MAX_TURN_TIME_MINS {
        return Err(format!(
            "max_turn_time_mins must be between 0 and {MAX_TURN_TIME_MINS}"
        ));
    }
    apply_control_profile(&mut profile)?;
    profile.cc_switch_db_path = profile
        .cc_switch_db_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    profile.codex_config_dir = profile
        .codex_config_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|path| {
            if !path.is_absolute() {
                return Err("codex_config_dir_invalid".to_string());
            }
            Ok(user_path_string(&path))
        })
        .transpose()?;
    let mut enabled_count = 0usize;
    for item in &mut profile.platforms {
        item.allow_from = item.allow_from.trim().to_string();
        if item.enabled {
            enabled_count += 1;
            item.allow_from = normalize_profile_allow_from(item.platform, &item.allow_from)?;
        }
    }
    if enabled_count == 0 {
        return Err("at least one messaging platform must be enabled".to_string());
    }
    profile.allow_from = profile
        .platforms
        .iter()
        .find(|item| item.platform == profile.platform)
        .map(|item| item.allow_from.clone())
        .unwrap_or_default();
    if profile.proxy_enabled {
        profile.proxy_url = normalize_proxy_url(profile.proxy_url.as_deref())?;
    }
    profile.executable_path = normalize_executable_path_value(profile.executable_path.as_deref());
    if let Some(explicit_path) = profile.executable_path.as_deref() {
        let binary = manager.detect(Some(explicit_path), true)?;
        profile.executable_path = Some(user_path_string(&binary.path));
    }
    Ok(profile)
}

pub(super) fn normalize_proxy_url(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let url = reqwest::Url::parse(raw).map_err(|_| "proxy URL is invalid".to_string())?;
    if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h") {
        return Err("proxy URL must use http, https, socks5, or socks5h".to_string());
    }
    if url.host_str().is_none() {
        return Err("proxy URL host is required".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("proxy URL credentials are not allowed".to_string());
    }
    Ok(Some(url.to_string()))
}

pub(super) fn normalize_allow_from(
    platform: CcConnectPlatform,
    raw: &str,
) -> Result<String, String> {
    let mut seen = HashSet::new();
    let mut values = Vec::new();
    for value in raw
        .split(|ch| matches!(ch, ',' | ';' | '\n' | '\r'))
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if value == "*" {
            return Err("allow_from wildcard is forbidden".to_string());
        }
        let valid = match platform {
            CcConnectPlatform::Telegram => value.chars().all(|ch| ch.is_ascii_digit()),
            CcConnectPlatform::Feishu => value.starts_with("ou_") && value.len() > 3,
            CcConnectPlatform::Weixin => {
                value.ends_with("@im.wechat") && value.len() > "@im.wechat".len()
            }
            CcConnectPlatform::Wecom => {
                value.len() <= 256 && !value.chars().any(char::is_whitespace)
            }
        };
        if !valid {
            return Err(match platform {
                CcConnectPlatform::Telegram => {
                    "Telegram allow_from must contain numeric user IDs".to_string()
                }
                CcConnectPlatform::Feishu => {
                    "Feishu allow_from must contain ou_ open IDs".to_string()
                }
                CcConnectPlatform::Weixin => {
                    "Weixin allow_from must contain user IDs ending in @im.wechat".to_string()
                }
                CcConnectPlatform::Wecom => {
                    "WeCom allow_from must contain explicit user IDs".to_string()
                }
            });
        }
        if seen.insert(value.to_string()) {
            values.push(value.to_string());
        }
    }
    if values.is_empty() {
        return Err("allow_from must contain at least one explicit user ID".to_string());
    }
    Ok(values.join(","))
}

pub(super) fn normalize_profile_allow_from(
    platform: CcConnectPlatform,
    raw: &str,
) -> Result<String, String> {
    normalize_allow_from(platform, raw).map_err(|error| {
        let reason = match error.as_str() {
            "allow_from must contain at least one explicit user ID" => "required",
            "allow_from wildcard is forbidden" => "wildcard",
            _ => "invalid",
        };
        format!("platform_allow_from_{reason}:{}", platform_type(platform))
    })
}

pub(super) fn profile_issue_codes(profile: &CcConnectProfile) -> Vec<String> {
    let mut issues = Vec::new();
    let enabled = enabled_platforms(profile);
    if enabled.is_empty() {
        issues.push("platform_missing".to_string());
    } else if enabled
        .iter()
        .any(|item| normalize_allow_from(item.platform, &item.allow_from).is_err())
    {
        issues.push("allowlist_invalid".to_string());
    }
    if profile.proxy_enabled && normalize_proxy_url(profile.proxy_url.as_deref()).is_err() {
        issues.push("proxy_invalid".to_string());
    }
    issues
}
