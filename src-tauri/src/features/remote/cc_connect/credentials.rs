use super::{
    enabled_platforms, profile_platforms, CcConnectPlatform, CcConnectPlatformStatus,
    CcConnectProfile, CcConnectSaveProfileRequest, CC_CONNECT_PLATFORMS, FEISHU_APP_ID_ACCOUNT,
    FEISHU_APP_ID_ENV, FEISHU_APP_SECRET_ACCOUNT, FEISHU_APP_SECRET_ENV, TELEGRAM_TOKEN_ACCOUNT,
    TELEGRAM_TOKEN_ENV, WECOM_BOT_ID_ACCOUNT, WECOM_BOT_ID_ENV, WECOM_BOT_SECRET_ACCOUNT,
    WECOM_BOT_SECRET_ENV, WEIXIN_TOKEN_ACCOUNT, WEIXIN_TOKEN_ENV,
};

#[cfg(target_os = "windows")]
pub(super) fn set_credential(account: &str, value: &str) -> Result<(), String> {
    crate::credential_store::entry(account)?
        .set_password(value)
        .map_err(|err| format!("save cc-connect credential failed: {err}"))
}
#[cfg(target_os = "windows")]
pub(super) fn get_credential(account: &str) -> Result<Option<String>, String> {
    match crate::credential_store::entry(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("read cc-connect credential failed: {err}")),
    }
}
#[cfg(target_os = "windows")]
pub(super) fn delete_credential(account: &str) -> Result<(), String> {
    match crate::credential_store::entry(account)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("delete cc-connect credential failed: {err}")),
    }
}
#[cfg(not(target_os = "windows"))]
pub(super) fn set_credential(_account: &str, _value: &str) -> Result<(), String> {
    Err("secure cc-connect credential storage is only available on Windows".to_string())
}
#[cfg(not(target_os = "windows"))]
pub(super) fn get_credential(_account: &str) -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(not(target_os = "windows"))]
pub(super) fn delete_credential(_account: &str) -> Result<(), String> {
    Ok(())
}

pub(super) fn save_request_credentials(
    request: &CcConnectSaveProfileRequest,
) -> Result<(), String> {
    let credentials = [
        (TELEGRAM_TOKEN_ACCOUNT, request.telegram_token.as_deref()),
        (FEISHU_APP_ID_ACCOUNT, request.feishu_app_id.as_deref()),
        (
            FEISHU_APP_SECRET_ACCOUNT,
            request.feishu_app_secret.as_deref(),
        ),
        (WEIXIN_TOKEN_ACCOUNT, request.weixin_token.as_deref()),
        (WECOM_BOT_ID_ACCOUNT, request.wecom_bot_id.as_deref()),
        (
            WECOM_BOT_SECRET_ACCOUNT,
            request.wecom_bot_secret.as_deref(),
        ),
    ];
    for (account, value) in credentials {
        if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
            set_credential(account, value)?;
        }
    }
    Ok(())
}

pub(super) fn credentials_ready(platform: CcConnectPlatform) -> Result<bool, String> {
    Ok(match platform {
        CcConnectPlatform::Telegram => {
            get_credential(TELEGRAM_TOKEN_ACCOUNT)?.is_some_and(|value| !value.trim().is_empty())
        }
        CcConnectPlatform::Feishu => {
            get_credential(FEISHU_APP_ID_ACCOUNT)?.is_some_and(|value| !value.trim().is_empty())
                && get_credential(FEISHU_APP_SECRET_ACCOUNT)?
                    .is_some_and(|value| !value.trim().is_empty())
        }
        CcConnectPlatform::Weixin => {
            get_credential(WEIXIN_TOKEN_ACCOUNT)?.is_some_and(|value| !value.trim().is_empty())
        }
        CcConnectPlatform::Wecom => {
            get_credential(WECOM_BOT_ID_ACCOUNT)?.is_some_and(|value| !value.trim().is_empty())
                && get_credential(WECOM_BOT_SECRET_ACCOUNT)?
                    .is_some_and(|value| !value.trim().is_empty())
        }
    })
}

pub(super) fn credential_environment(
    platform: CcConnectPlatform,
) -> Result<(Vec<(String, String)>, Vec<String>), String> {
    match platform {
        CcConnectPlatform::Telegram => {
            let token = get_credential(TELEGRAM_TOKEN_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Telegram credential is missing".to_string())?;
            Ok((
                vec![(TELEGRAM_TOKEN_ENV.to_string(), token.clone())],
                vec![token],
            ))
        }
        CcConnectPlatform::Feishu => {
            let app_id = get_credential(FEISHU_APP_ID_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Feishu app ID is missing".to_string())?;
            let app_secret = get_credential(FEISHU_APP_SECRET_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Feishu app secret is missing".to_string())?;
            Ok((
                vec![
                    (FEISHU_APP_ID_ENV.to_string(), app_id.clone()),
                    (FEISHU_APP_SECRET_ENV.to_string(), app_secret.clone()),
                ],
                vec![app_id, app_secret],
            ))
        }
        CcConnectPlatform::Weixin => {
            let token = get_credential(WEIXIN_TOKEN_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Weixin token is missing".to_string())?;
            Ok((
                vec![(WEIXIN_TOKEN_ENV.to_string(), token.clone())],
                vec![token],
            ))
        }
        CcConnectPlatform::Wecom => {
            let bot_id = get_credential(WECOM_BOT_ID_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "WeCom bot ID is missing".to_string())?;
            let bot_secret = get_credential(WECOM_BOT_SECRET_ACCOUNT)?
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "WeCom bot secret is missing".to_string())?;
            Ok((
                vec![
                    (WECOM_BOT_ID_ENV.to_string(), bot_id.clone()),
                    (WECOM_BOT_SECRET_ENV.to_string(), bot_secret.clone()),
                ],
                vec![bot_id, bot_secret],
            ))
        }
    }
}

pub(super) fn credentials_ready_for_profile(profile: &CcConnectProfile) -> Result<bool, String> {
    let enabled = enabled_platforms(profile);
    if enabled.is_empty() {
        return Ok(false);
    }
    for item in enabled {
        if !credentials_ready(item.platform)? {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn credential_environment_for_profile(
    profile: &CcConnectProfile,
) -> Result<(Vec<(String, String)>, Vec<String>), String> {
    let enabled = enabled_platforms(profile);
    if enabled.is_empty() {
        return Err("at least one messaging platform must be enabled".to_string());
    }
    let mut environment = Vec::new();
    let mut secrets = Vec::new();
    for item in enabled {
        let (mut platform_environment, mut platform_secrets) =
            credential_environment(item.platform)?;
        environment.append(&mut platform_environment);
        secrets.append(&mut platform_secrets);
    }
    Ok((environment, secrets))
}

pub(super) fn platform_statuses(
    profile: Option<&CcConnectProfile>,
) -> Vec<CcConnectPlatformStatus> {
    let configured = profile.map(profile_platforms).unwrap_or_default();
    CC_CONNECT_PLATFORMS
        .into_iter()
        .map(|platform| CcConnectPlatformStatus {
            platform,
            enabled: configured
                .iter()
                .find(|item| item.platform == platform)
                .is_some_and(|item| item.enabled),
            credentials_ready: credentials_ready(platform).unwrap_or(false),
        })
        .collect()
}
