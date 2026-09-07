use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

const ASKPASS_ENV: &str = "CLI_MANAGER_SSH_ASKPASS";
const ASKPASS_ADDR_ENV: &str = "CLI_MANAGER_SSH_ASKPASS_ADDR";
const ASKPASS_TOKEN_ENV: &str = "CLI_MANAGER_SSH_ASKPASS_TOKEN";
pub(crate) const ASKPASS_TTY_FALLBACK_ENV: &str = "CLI_MANAGER_SSH_ASKPASS_TTY_FALLBACK";
pub(crate) const ASKPASS_TTY_FALLBACK_ENABLED: &str = "1";
pub(crate) const ASKPASS_TTY_FALLBACK_DISABLED: &str = "0";
const BROKER_TIMEOUT: Duration = Duration::from_secs(5);
const BROKER_LIFETIME: Duration = Duration::from_secs(30);
const BROKER_POLL_INTERVAL: Duration = Duration::from_millis(25);
const MAX_BROKER_TOKEN_BYTES: usize = 128;
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_TERMINAL_PROMPT_CHARS: usize = 1024;
#[cfg(not(test))]
const ASKPASS_DIAGNOSTIC_LOG_FILE: &str = "ssh-askpass.log";

#[cfg(not(test))]
fn write_diagnostic_event(event: &str, details: &str) {
    let Ok(log_dir) = crate::app_paths::logs_dir() else {
        return;
    };
    let Ok(mut writer) =
        crate::log_rotation::create_log_writer(log_dir, ASKPASS_DIAGNOSTIC_LOG_FILE)
    else {
        return;
    };
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let _ = writeln!(
        writer,
        "timestamp_ms={} pid={} event={} {}",
        timestamp_ms,
        std::process::id(),
        event,
        details
    );
}

#[cfg(test)]
fn write_diagnostic_event(_event: &str, _details: &str) {}

/// Invoked by the main executable when OpenSSH launches it as SSH_ASKPASS.
pub fn run_helper_and_exit() -> ! {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let fallback_value = std::env::var(ASKPASS_TTY_FALLBACK_ENV).ok();
    let allow_terminal_fallback = terminal_fallback_enabled(fallback_value.as_deref());
    write_diagnostic_event(
        "helper_started",
        &format!(
            "prompt_kind={} prompt_bytes={} tty_fallback={}",
            prompt_kind(&prompt),
            prompt.len(),
            allow_terminal_fallback
        ),
    );
    let result = answer_prompt_with(
        &prompt,
        allow_terminal_fallback,
        &mut std::io::stdout(),
        request_broker_password,
        read_control_terminal,
    );
    match &result {
        Ok(()) => write_diagnostic_event("helper_finished", "status=ok"),
        Err(error) => write_diagnostic_event(
            "helper_finished",
            &format!("status=error error_kind={:?}", error.kind()),
        ),
    }
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

fn terminal_fallback_enabled(value: Option<&str>) -> bool {
    value == Some(ASKPASS_TTY_FALLBACK_ENABLED)
}

fn answer_prompt_with<W, B, T>(
    prompt: &str,
    allow_terminal_fallback: bool,
    output: &mut W,
    mut request_broker: B,
    mut read_terminal: T,
) -> io::Result<()>
where
    W: Write,
    B: FnMut() -> Option<Vec<u8>>,
    T: FnMut(&str) -> io::Result<Vec<u8>>,
{
    let prompt = sanitize_terminal_prompt(prompt);
    let password_prompt = is_password_prompt(&prompt);
    write_diagnostic_event(
        "prompt_route",
        &format!(
            "prompt_kind={} prompt_bytes={} broker_allowed={} tty_fallback={}",
            prompt_kind(&prompt),
            prompt.len(),
            password_prompt,
            allow_terminal_fallback
        ),
    );
    let broker_response = password_prompt.then(|| request_broker()).flatten();
    if password_prompt {
        write_diagnostic_event(
            "broker_result",
            &format!(
                "status={}",
                if broker_response.is_some() {
                    "ok"
                } else {
                    "unavailable"
                }
            ),
        );
    }
    let (response, source) = match (broker_response, allow_terminal_fallback) {
        (Some(response), _) => (response, "broker"),
        (None, true) => match read_terminal(&prompt) {
            Ok(response) => (response, "terminal"),
            Err(error) => {
                write_diagnostic_event(
                    "terminal_read",
                    &format!("status=error error_kind={:?}", error.kind()),
                );
                return Err(error);
            }
        },
        _ => {
            write_diagnostic_event("response_unavailable", "error_kind=NotConnected");
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "SSH input unavailable",
            ));
        }
    };

    if let Err(error) = output.write_all(&response) {
        write_diagnostic_event(
            "response_write",
            &format!("status=error error_kind={:?}", error.kind()),
        );
        return Err(error);
    }
    if let Err(error) = output.flush() {
        write_diagnostic_event(
            "response_write",
            &format!("status=error error_kind={:?}", error.kind()),
        );
        return Err(error);
    }
    write_diagnostic_event(
        "response_write",
        &format!(
            "status=ok source={} response_bytes={}",
            source,
            response.len()
        ),
    );
    Ok(())
}

fn prompt_kind(prompt: &str) -> &'static str {
    if is_password_prompt(prompt) {
        return "password";
    }
    let prompt = prompt.to_ascii_lowercase();
    if [
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
    .iter()
    .any(|marker| prompt.contains(marker))
    {
        "mfa"
    } else {
        "interactive"
    }
}

fn is_password_prompt(prompt: &str) -> bool {
    let prompt = prompt.to_ascii_lowercase();
    if [
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
    .iter()
    .any(|marker| prompt.contains(marker))
    {
        return false;
    }
    prompt.contains("password") || prompt.contains("passphrase")
}

fn sanitize_terminal_prompt(prompt: &str) -> String {
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

fn request_broker_password() -> Option<Vec<u8>> {
    let address = std::env::var(ASKPASS_ADDR_ENV).ok()?;
    let token = std::env::var(ASKPASS_TOKEN_ENV).ok()?;
    if address.trim().is_empty() || token.trim().is_empty() {
        return None;
    }

    let mut stream = TcpStream::connect(address).ok()?;
    let _ = stream.set_read_timeout(Some(BROKER_TIMEOUT));
    let _ = stream.set_write_timeout(Some(BROKER_TIMEOUT));
    stream.write_all(token.as_bytes()).ok()?;
    stream.write_all(b"\n").ok()?;

    let mut password = Vec::new();
    stream
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut password)
        .ok()?;
    (!password.is_empty() && password.len() <= MAX_RESPONSE_BYTES).then_some(password)
}

fn read_bounded_line<R: BufRead>(reader: &mut R, max_bytes: usize) -> io::Result<Vec<u8>> {
    let mut response = Vec::new();
    reader
        .take((max_bytes + 2) as u64)
        .read_until(b'\n', &mut response)?;
    while matches!(response.last(), Some(b'\r' | b'\n')) {
        response.pop();
    }
    if response.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "SSH input exceeds limit",
        ));
    }
    Ok(response)
}

struct RestoreGuard<F: FnOnce()> {
    restore: Option<F>,
}

impl<F: FnOnce()> RestoreGuard<F> {
    fn new(restore: F) -> Self {
        Self {
            restore: Some(restore),
        }
    }
}

impl<F: FnOnce()> Drop for RestoreGuard<F> {
    fn drop(&mut self) {
        if let Some(restore) = self.restore.take() {
            restore();
        }
    }
}

fn with_restore<T, F, R>(restore: R, action: F) -> io::Result<T>
where
    F: FnOnce() -> io::Result<T>,
    R: FnOnce(),
{
    let _guard = RestoreGuard::new(restore);
    action()
}

#[cfg(unix)]
fn read_control_terminal(prompt: &str) -> io::Result<Vec<u8>> {
    use nix::libc;
    use std::fs::OpenOptions;
    use std::os::fd::AsRawFd;

    let tty = OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(|error| {
            write_diagnostic_event(
                "terminal_open",
                &format!("platform=unix status=error error_kind={:?}", error.kind()),
            );
            error
        })?;
    let fd = tty.as_raw_fd();
    let mut original = unsafe { std::mem::zeroed::<libc::termios>() };
    if unsafe { libc::tcgetattr(fd, &mut original) } != 0 {
        write_diagnostic_event(
            "terminal_mode",
            &format!(
                "platform=unix operation=get error_os={}",
                io::Error::last_os_error()
            ),
        );
        return Err(io::Error::last_os_error());
    }
    let mut hidden = original;
    hidden.c_lflag &= !(libc::ECHO | libc::ECHONL);
    if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &hidden) } != 0 {
        write_diagnostic_event(
            "terminal_mode",
            &format!(
                "platform=unix operation=disable_echo error_os={}",
                io::Error::last_os_error()
            ),
        );
        return Err(io::Error::last_os_error());
    }
    write_diagnostic_event("terminal_open", "platform=unix status=ok source=dev_tty");

    let result = with_restore(
        move || unsafe {
            libc::tcsetattr(fd, libc::TCSANOW, &original);
        },
        || {
            let mut output = &tty;
            output.write_all(prompt.as_bytes())?;
            output.flush()?;
            read_bounded_line(&mut BufReader::new(&tty), MAX_RESPONSE_BYTES)
        },
    );
    let mut output = &tty;
    let _ = output.write_all(b"\r\n");
    let _ = output.flush();
    match &result {
        Ok(response) => write_diagnostic_event(
            "terminal_read",
            &format!("platform=unix status=ok response_bytes={}", response.len()),
        ),
        Err(error) => write_diagnostic_event(
            "terminal_read",
            &format!("platform=unix status=error error_kind={:?}", error.kind()),
        ),
    }
    result
}

#[cfg(windows)]
fn read_control_terminal(prompt: &str) -> io::Result<Vec<u8>> {
    use std::io::BufReader;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Console::{GetConsoleMode, SetConsoleMode, ENABLE_ECHO_INPUT};

    // OpenSSH keeps the SSH process' stdin/stderr attached to the owning
    // ConPTY when it launches SSH_ASKPASS. Reopening CONIN$/CONOUT$ can bind
    // the helper to a different console input queue instead of this session.
    let input = std::io::stdin();
    let mut output = std::io::stderr();
    let handle = input.as_raw_handle();
    let mut original = 0;
    if unsafe { GetConsoleMode(handle, &mut original) } == 0 {
        write_diagnostic_event(
            "terminal_mode",
            &format!(
                "platform=windows operation=get error_os={}",
                io::Error::last_os_error()
            ),
        );
        return Err(io::Error::last_os_error());
    }
    if unsafe { SetConsoleMode(handle, original & !ENABLE_ECHO_INPUT) } == 0 {
        write_diagnostic_event(
            "terminal_mode",
            &format!(
                "platform=windows operation=disable_echo error_os={}",
                io::Error::last_os_error()
            ),
        );
        return Err(io::Error::last_os_error());
    }
    write_diagnostic_event(
        "terminal_open",
        "platform=windows status=ok source=stdin_stderr",
    );

    let result = with_restore(
        move || unsafe {
            SetConsoleMode(handle, original);
        },
        || {
            output.write_all(prompt.as_bytes())?;
            output.flush()?;
            read_bounded_line(&mut BufReader::new(input.lock()), MAX_RESPONSE_BYTES)
        },
    );
    let _ = output.write_all(b"\r\n");
    let _ = output.flush();
    match &result {
        Ok(response) => write_diagnostic_event(
            "terminal_read",
            &format!(
                "platform=windows status=ok response_bytes={}",
                response.len()
            ),
        ),
        Err(error) => write_diagnostic_event(
            "terminal_read",
            &format!(
                "platform=windows status=error error_kind={:?}",
                error.kind()
            ),
        ),
    }
    result
}

#[cfg(not(any(unix, windows)))]
fn read_control_terminal(_prompt: &str) -> io::Result<Vec<u8>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "control terminal is unsupported",
    ))
}

/// Starts a one-shot local broker. The password itself never enters the child
/// environment; only a random token and loopback address do.
pub fn prepare(account: &str) -> Result<HashMap<String, String>, String> {
    let password = crate::credential_store::get(account)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "ssh_credential_missing".to_string())?;
    let env = prepare_with_password(password)?;
    write_diagnostic_event("broker_prepared", "status=ok");
    Ok(env)
}

fn prepare_with_password(password: String) -> Result<HashMap<String, String>, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|err| format!("ssh askpass broker bind failed: {err}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|err| format!("ssh askpass broker setup failed: {err}"))?;
    let address = listener
        .local_addr()
        .map_err(|err| format!("ssh askpass broker address failed: {err}"))?;
    let token = uuid::Uuid::new_v4().to_string();
    let expected_token = token.clone();
    thread::spawn(move || {
        let deadline = Instant::now() + BROKER_LIFETIME;
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(BROKER_TIMEOUT));
                    let _ = stream.set_write_timeout(Some(BROKER_TIMEOUT));
                    let token_matches =
                        read_bounded_line(&mut BufReader::new(&mut stream), MAX_BROKER_TOKEN_BYTES)
                            .is_ok_and(|received| received == expected_token.as_bytes());
                    if token_matches {
                        let _ = stream.write_all(password.as_bytes());
                        return;
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(BROKER_POLL_INTERVAL);
                }
                Err(_) => return,
            }
        }
    });

    let executable = std::env::current_exe()
        .map_err(|err| format!("resolve SSH askpass executable failed: {err}"))?;
    let mut env = HashMap::new();
    env.insert(ASKPASS_ENV.to_string(), "1".to_string());
    env.insert(ASKPASS_ADDR_ENV.to_string(), address.to_string());
    env.insert(ASKPASS_TOKEN_ENV.to_string(), token);
    env.insert(
        "SSH_ASKPASS".to_string(),
        executable.to_string_lossy().into_owned(),
    );
    env.insert("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string());
    env.insert("DISPLAY".to_string(), "cli-manager-askpass".to_string());
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::{
        answer_prompt_with, is_password_prompt, prepare_with_password, read_bounded_line,
        sanitize_terminal_prompt, terminal_fallback_enabled, with_restore, ASKPASS_ADDR_ENV,
        ASKPASS_TOKEN_ENV, MAX_BROKER_TOKEN_BYTES, MAX_RESPONSE_BYTES, MAX_TERMINAL_PROMPT_CHARS,
    };
    use std::cell::{Cell, RefCell};
    use std::io::{self, BufReader, Cursor, Read, Write};
    use std::net::{Shutdown, TcpStream};

    #[test]
    fn one_shot_broker_requires_a_matching_token_without_consuming_invalid_attempts() {
        let env = prepare_with_password("top-secret".to_string()).unwrap();
        let mut invalid_stream = TcpStream::connect(env.get(ASKPASS_ADDR_ENV).unwrap()).unwrap();
        invalid_stream.write_all(b"wrong-token\n").unwrap();
        invalid_stream.shutdown(Shutdown::Write).unwrap();
        let mut invalid_value = String::new();
        invalid_stream.read_to_string(&mut invalid_value).unwrap();
        assert!(invalid_value.is_empty());

        let mut stream = TcpStream::connect(env.get(ASKPASS_ADDR_ENV).unwrap()).unwrap();
        stream
            .write_all(format!("{}\n", env.get(ASKPASS_TOKEN_ENV).unwrap()).as_bytes())
            .unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        let mut value = String::new();
        stream.read_to_string(&mut value).unwrap();
        assert_eq!(value, "top-secret");
    }

    #[test]
    fn one_shot_broker_rejects_an_oversized_token() {
        let env = prepare_with_password("top-secret".to_string()).unwrap();
        let mut stream = TcpStream::connect(env.get(ASKPASS_ADDR_ENV).unwrap()).unwrap();
        let mut oversized = vec![b'x'; MAX_BROKER_TOKEN_BYTES + 1];
        oversized.push(b'\n');
        stream.write_all(&oversized).unwrap();
        stream.shutdown(Shutdown::Write).unwrap();

        let mut value = Vec::new();
        stream.read_to_end(&mut value).unwrap();
        assert!(value.is_empty());

        let mut valid_stream = TcpStream::connect(env.get(ASKPASS_ADDR_ENV).unwrap()).unwrap();
        valid_stream
            .write_all(format!("{}\n", env.get(ASKPASS_TOKEN_ENV).unwrap()).as_bytes())
            .unwrap();
        valid_stream.shutdown(Shutdown::Write).unwrap();
        let mut valid_value = String::new();
        valid_stream.read_to_string(&mut valid_value).unwrap();
        assert_eq!(valid_value, "top-secret");
    }

    #[test]
    fn only_password_and_passphrase_prompts_may_use_saved_credentials() {
        assert!(is_password_prompt("Password:"));
        assert!(is_password_prompt("Enter passphrase for key:"));
        assert!(!is_password_prompt("Please Enter MFA Code."));
        assert!(!is_password_prompt("One-time password:"));
        assert!(!is_password_prompt("OTP password:"));
        assert!(!is_password_prompt("Verification code:"));
        assert!(!is_password_prompt("PIN:"));
    }

    #[test]
    fn terminal_fallback_requires_the_exact_enabled_value() {
        assert!(terminal_fallback_enabled(Some("1")));
        for value in [None, Some("0"), Some("true"), Some("1 "), Some("")] {
            assert!(!terminal_fallback_enabled(value));
        }
    }

    #[test]
    fn saved_password_wins_without_touching_the_terminal() {
        let broker_calls = Cell::new(0);
        let terminal_calls = Cell::new(0);
        let mut output = Vec::new();

        answer_prompt_with(
            "Password:",
            false,
            &mut output,
            || {
                broker_calls.set(broker_calls.get() + 1);
                Some(b"saved-password".to_vec())
            },
            |_| {
                terminal_calls.set(terminal_calls.get() + 1);
                Ok(b"manual-password".to_vec())
            },
        )
        .unwrap();

        assert_eq!(output, b"saved-password");
        assert_eq!(broker_calls.get(), 1);
        assert_eq!(terminal_calls.get(), 0);
    }

    #[test]
    fn mfa_skips_the_broker_and_reads_the_interactive_terminal() {
        let broker_calls = Cell::new(0);
        let terminal_prompt = RefCell::new(String::new());
        let mut output = Vec::new();

        answer_prompt_with(
            "Please Enter MFA Code.",
            true,
            &mut output,
            || {
                broker_calls.set(broker_calls.get() + 1);
                Some(b"must-not-be-used".to_vec())
            },
            |prompt| {
                terminal_prompt.replace(prompt.to_string());
                Ok(b"123456".to_vec())
            },
        )
        .unwrap();

        assert_eq!(broker_calls.get(), 0);
        assert_eq!(terminal_prompt.borrow().as_str(), "Please Enter MFA Code.");
        assert_eq!(output, b"123456");
    }

    #[test]
    fn consumed_broker_falls_back_to_manual_password_in_interactive_mode() {
        let terminal_calls = Cell::new(0);
        let mut output = Vec::new();

        answer_prompt_with(
            "Password:",
            true,
            &mut output,
            || None,
            |_| {
                terminal_calls.set(terminal_calls.get() + 1);
                Ok(b"corrected-password".to_vec())
            },
        )
        .unwrap();

        assert_eq!(terminal_calls.get(), 1);
        assert_eq!(output, b"corrected-password");
    }

    #[test]
    fn one_shot_mode_fails_without_reading_a_control_terminal() {
        for prompt in ["Password:", "Please Enter MFA Code."] {
            let terminal_calls = Cell::new(0);
            let mut output = Vec::new();
            let result = answer_prompt_with(
                prompt,
                false,
                &mut output,
                || None,
                |_| {
                    terminal_calls.set(terminal_calls.get() + 1);
                    Ok(b"must-not-be-read".to_vec())
                },
            );

            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::NotConnected);
            assert_eq!(terminal_calls.get(), 0);
            assert!(output.is_empty());
        }
    }

    #[test]
    fn interactive_terminal_failure_returns_no_helper_response() {
        let mut output = Vec::new();
        let result = answer_prompt_with(
            "Please Enter MFA Code.",
            true,
            &mut output,
            || None,
            |_| Err(io::Error::new(io::ErrorKind::NotFound, "no terminal")),
        );

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::NotFound);
        assert!(output.is_empty());
    }

    #[test]
    fn terminal_prompt_and_helper_response_use_separate_outputs() {
        let terminal_output = RefCell::new(Vec::new());
        let mut helper_output = Vec::new();

        answer_prompt_with(
            "\x1b]52;c;ignored\x07MFA Code:\r\n",
            true,
            &mut helper_output,
            || None,
            |prompt| {
                terminal_output
                    .borrow_mut()
                    .extend_from_slice(prompt.as_bytes());
                Ok(b"654321".to_vec())
            },
        )
        .unwrap();

        assert_eq!(
            terminal_output.borrow().as_slice(),
            b"]52;c;ignoredMFA Code:\n"
        );
        assert_eq!(helper_output, b"654321");
    }

    #[test]
    fn terminal_prompt_filters_controls_normalizes_newlines_and_is_bounded() {
        let sanitized = sanitize_terminal_prompt("\x1b[31mMFA\x1b[0m\r\nCode\x07:\rNext\t");
        assert_eq!(sanitized, "[31mMFA[0m\nCode:\nNext");
        assert!(sanitized.chars().all(|ch| ch == '\n' || !ch.is_control()));

        let oversized = "界".repeat(MAX_TERMINAL_PROMPT_CHARS + 1);
        assert_eq!(
            sanitize_terminal_prompt(&oversized).chars().count(),
            MAX_TERMINAL_PROMPT_CHARS
        );
    }

    #[test]
    fn terminal_input_is_bounded_and_strips_line_endings() {
        for input in [b"123456\n".as_slice(), b"123456\r\n".as_slice()] {
            let mut reader = BufReader::new(Cursor::new(input));
            assert_eq!(
                read_bounded_line(&mut reader, MAX_RESPONSE_BYTES).unwrap(),
                b"123456"
            );
        }

        let mut maximum = vec![b'x'; MAX_RESPONSE_BYTES];
        maximum.extend_from_slice(b"\r\n");
        let mut reader = BufReader::new(Cursor::new(maximum));
        assert_eq!(
            read_bounded_line(&mut reader, MAX_RESPONSE_BYTES)
                .unwrap()
                .len(),
            MAX_RESPONSE_BYTES
        );

        let oversized = vec![b'x'; MAX_RESPONSE_BYTES + 1];
        let mut reader = BufReader::new(Cursor::new(oversized));
        assert_eq!(
            read_bounded_line(&mut reader, MAX_RESPONSE_BYTES)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn terminal_mode_restore_runs_for_success_eof_and_error() {
        for action in [
            Ok(b"value".to_vec()),
            Ok(Vec::new()),
            Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed")),
        ] {
            let restored = Cell::new(false);
            let _ = with_restore(|| restored.set(true), || action);
            assert!(restored.get());
        }
    }
}
