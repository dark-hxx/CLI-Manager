use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

const ASKPASS_ENV: &str = "CLI_MANAGER_SSH_ASKPASS";
const ASKPASS_ADDR_ENV: &str = "CLI_MANAGER_SSH_ASKPASS_ADDR";
const ASKPASS_TOKEN_ENV: &str = "CLI_MANAGER_SSH_ASKPASS_TOKEN";

/// Invoked by the main executable when OpenSSH launches it as SSH_ASKPASS.
pub fn run_helper_and_exit() -> ! {
    let prompt = std::env::args()
        .nth(1)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let is_secret_prompt = prompt.contains("password") || prompt.contains("passphrase");
    if !is_secret_prompt {
        std::process::exit(1);
    }
    let address = match std::env::var(ASKPASS_ADDR_ENV) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => std::process::exit(1),
    };
    let token = match std::env::var(ASKPASS_TOKEN_ENV) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => std::process::exit(1),
    };
    let mut stream = match TcpStream::connect(address) {
        Ok(stream) => stream,
        Err(_) => std::process::exit(1),
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    if stream.write_all(token.as_bytes()).is_err() || stream.write_all(b"\n").is_err() {
        std::process::exit(1);
    }
    let mut password = Vec::new();
    if stream.read_to_end(&mut password).is_err() || password.is_empty() {
        std::process::exit(1);
    }
    let _ = std::io::stdout().write_all(&password);
    std::process::exit(0);
}

/// Starts a one-shot local broker. The password itself never enters the child
/// environment; only a random token and loopback address do.
pub fn prepare(account: &str) -> Result<HashMap<String, String>, String> {
    let password = crate::credential_store::get(account)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "ssh_credential_missing".to_string())?;
    prepare_with_password(password)
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
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    let mut received = String::new();
                    if BufReader::new(&mut stream).read_line(&mut received).is_ok()
                        && received.trim() == expected_token
                    {
                        let _ = stream.write_all(password.as_bytes());
                    }
                    return;
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(25));
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
    use super::{prepare_with_password, ASKPASS_ADDR_ENV, ASKPASS_TOKEN_ENV};
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpStream};

    #[test]
    fn one_shot_broker_returns_secret_only_for_matching_token() {
        let env = prepare_with_password("top-secret".to_string()).unwrap();
        let mut stream = TcpStream::connect(env.get(ASKPASS_ADDR_ENV).unwrap()).unwrap();
        stream
            .write_all(format!("{}\n", env.get(ASKPASS_TOKEN_ENV).unwrap()).as_bytes())
            .unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        let mut value = String::new();
        stream.read_to_string(&mut value).unwrap();
        assert_eq!(value, "top-secret");
    }
}
