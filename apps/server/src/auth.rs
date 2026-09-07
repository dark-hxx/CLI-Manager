use crate::error::AppError;
use crate::state::AppState;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::http::{header, HeaderMap};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use cli_manager_web_protocol::UserView;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};

pub const SESSION_COOKIE: &str = "cli_manager_session";
pub const SESSION_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

pub fn hash_password(password: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|err| AppError::Internal(format!("password hash failed: {err}")))
}

pub fn verify_password(password: &str, encoded: &str) -> bool {
    let Ok(hash) = PasswordHash::new(encoded) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &hash)
        .is_ok()
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_secret(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn cookie_value(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|item| item.trim().split_once('='))
        .find_map(|(name, value)| (name == SESSION_COOKIE).then(|| value.to_string()))
}

pub fn session_cookie(token: &str, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{}",
        SESSION_TTL_MS / 1000,
        secure
    )
}

pub fn clear_session_cookie(secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!(
        "{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{}",
        secure
    )
}

pub fn normalize_pairing_code(value: &str) -> Result<String, AppError> {
    let normalized: String = value
        .chars()
        .filter(|character| !character.is_ascii_whitespace() && *character != '-')
        .flat_map(char::to_uppercase)
        .collect();
    if !(6..=12).contains(&normalized.len())
        || !normalized
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err(AppError::bad_request(
            "invalid_pairing_code",
            "pairing code must contain 6 to 12 letters or digits",
        ));
    }
    Ok(normalized)
}

pub async fn optional_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<UserView>, AppError> {
    let Some(token) = cookie_value(headers) else {
        return Ok(None);
    };
    state.storage.user_for_session(&hash_secret(&token)).await
}

pub async fn require_user(state: &AppState, headers: &HeaderMap) -> Result<UserView, AppError> {
    optional_user(state, headers)
        .await?
        .ok_or_else(AppError::unauthorized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_roundtrip() {
        let hash = hash_password("correct horse battery staple").unwrap();
        assert!(verify_password("correct horse battery staple", &hash));
        assert!(!verify_password("wrong", &hash));
    }

    #[test]
    fn cookie_is_http_only() {
        let cookie = session_cookie("token", true);
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("Secure"));
        assert!(cookie.contains("SameSite=Strict"));
    }

    #[test]
    fn pairing_code_normalization_is_stable() {
        assert_eq!(normalize_pairing_code("ab-cd 12").unwrap(), "ABCD12");
        assert!(normalize_pairing_code("../bad").is_err());
    }
}
