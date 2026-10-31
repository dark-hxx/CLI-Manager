pub const MAX_TERMINAL_PROMPT_CHARS: usize = 1024;

/// 仅精确字符串 `1` 允许 SSH AskPass 回退到控制终端。
pub fn terminal_fallback_enabled(value: Option<&str>) -> bool {
    value == Some("1")
}

/// 按英文关键词区分密码、MFA 和普通交互提示。
pub fn prompt_kind(prompt: &str) -> &'static str {
    if is_password_prompt(prompt) {
        return "password";
    }
    let prompt = prompt.to_ascii_lowercase();
    if mfa_markers().iter().any(|marker| prompt.contains(marker)) {
        "mfa"
    } else {
        "interactive"
    }
}

/// 排除 MFA/OTP 提示后识别 password/passphrase 请求。
pub fn is_password_prompt(prompt: &str) -> bool {
    let prompt = prompt.to_ascii_lowercase();
    if mfa_markers().iter().any(|marker| prompt.contains(marker)) {
        return false;
    }
    prompt.contains("password") || prompt.contains("passphrase")
}

/// 统一换行并删除其他控制字符，最多保留指定上限的提示字符。
pub fn sanitize_terminal_prompt(prompt: &str) -> String {
    let mut sanitized = String::new();
    let mut chars = prompt.chars().peekable();
    let mut written = 0;
    while written < MAX_TERMINAL_PROMPT_CHARS {
        let Some(ch) = chars.next() else {
            break;
        };
        match ch {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                sanitized.push('\n');
                written += 1;
            }
            '\n' => {
                sanitized.push('\n');
                written += 1;
            }
            value if !value.is_control() => {
                sanitized.push(value);
                written += 1;
            }
            _ => {}
        }
    }
    sanitized
}

fn mfa_markers() -> [&'static str; 9] {
    [
        "one-time",
        "one time",
        "otp",
        "mfa",
        "verification",
        "authenticator",
        "security code",
        "passcode",
        "pin",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_password_mfa_and_interactive_prompts() {
        assert_eq!(prompt_kind("Password: "), "password");
        assert_eq!(prompt_kind("One-time code: "), "mfa");
        assert_eq!(prompt_kind("Confirm login: "), "interactive");
        assert!(!is_password_prompt("MFA password: "));
    }

    #[test]
    fn sanitizes_prompt_controls_and_bounds_characters() {
        assert_eq!(sanitize_terminal_prompt("a\r\nb\u{7}c"), "a\nbc");
        assert_eq!(
            sanitize_terminal_prompt(&"x".repeat(1025)).chars().count(),
            1024
        );
    }

    #[test]
    fn requires_exact_fallback_flag() {
        assert!(terminal_fallback_enabled(Some("1")));
        assert!(!terminal_fallback_enabled(Some(" true ")));
        assert!(!terminal_fallback_enabled(None));
    }
}
