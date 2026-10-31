use super::SessionHandle;
use cli_manager_core::{ssh_shell::posix_quote, wsl};
use serde_json::Value;
use std::{path::PathBuf, time::Duration};

type DropResult<T> = Result<T, &'static str>;
const UNSUPPORTED: &str = "terminal.drop.unsupported";
const INVALID: &str = "terminal.drop.invalid";
const UNAVAILABLE: &str = "terminal.drop.unavailable";

pub(crate) async fn write_paths(
    session_id: &str,
    handle: &SessionHandle,
    paths: &[PathBuf],
) -> DropResult<()> {
    if handle.cancellation.is_cancelled() {
        return Ok(());
    }
    let operation = async {
        let client = handle.connection.client().ok_or(UNAVAILABLE)?;
        let listing = client.list().await.map_err(|_| UNAVAILABLE)?;
        let metadata = listing["sessions"]
            .as_array()
            .and_then(|sessions| {
                sessions.iter().find(|item| {
                    item["sessionId"].as_str() == Some(session_id)
                        && item["alive"].as_bool() == Some(true)
                })
            })
            .ok_or(UNAVAILABLE)?;
        let text = format_paths(paths, metadata)?;
        let mode = handle.model.lock().map_err(|_| UNAVAILABLE)?.input_mode();
        let bytes = cli_manager_term_engine::input::encode_paste(text.as_bytes(), mode);
        if handle.cancellation.is_cancelled() {
            return Ok(());
        }
        client
            .write_bytes(session_id, &bytes)
            .await
            .map_err(|_| UNAVAILABLE)
    };
    tokio::select! {
        _ = handle.cancellation.wait() => Ok(()),
        result = tokio::time::timeout(Duration::from_secs(5), operation) => {
            result.unwrap_or(Err(UNAVAILABLE))
        }
    }
}

fn format_paths(paths: &[PathBuf], metadata: &Value) -> DropResult<String> {
    if metadata["environmentType"].as_str() == Some("ssh")
        || metadata["sshHostId"].as_str().is_some()
    {
        return Err(UNSUPPORTED);
    }
    let shell = metadata["shell"].as_str().unwrap_or(if cfg!(windows) {
        "powershell"
    } else if cfg!(target_os = "macos") {
        "zsh"
    } else {
        "bash"
    });
    paths
        .iter()
        .map(|path| {
            let path = path.to_str().ok_or(INVALID)?;
            if path.is_empty() || path.chars().any(char::is_control) {
                return Err(INVALID);
            }
            match shell {
                "powershell" | "pwsh" => Ok(format!("'{}'", path.replace('\'', "''"))),
                "cmd" => {
                    if path.contains(['%', '!', '"']) {
                        return Err(INVALID);
                    }
                    Ok(format!("\"{path}\""))
                }
                "wsl" => Ok(posix_quote(&wsl_path(path, metadata["cwd"].as_str())?)),
                "bash" if cfg!(windows) => {
                    Ok(posix_quote(&wsl_path(path, metadata["cwd"].as_str())?))
                }
                "gitbash" => {
                    let converted = wsl::windows_path_to_wsl(path).ok_or(UNSUPPORTED)?;
                    if path.trim() != path {
                        return Err(INVALID);
                    }
                    Ok(posix_quote(&converted.replacen("/mnt/", "/", 1)))
                }
                "bash" | "zsh" | "sh" if path.starts_with('/') => Ok(posix_quote(path)),
                _ => Err(UNSUPPORTED),
            }
        })
        .collect::<DropResult<Vec<_>>>()
        .map(|paths| paths.join(" "))
}

fn wsl_path(path: &str, cwd: Option<&str>) -> DropResult<String> {
    if path.trim() != path {
        return Err(INVALID);
    }
    if let Some((distro, linux_path)) = wsl::parse_wsl_unc_path(path) {
        let target_distro = cwd
            .and_then(wsl::parse_wsl_unc_path)
            .map(|(distro, _)| distro);
        return if target_distro.is_some_and(|target| target.eq_ignore_ascii_case(&distro)) {
            Ok(linux_path)
        } else {
            Err(UNSUPPORTED)
        };
    }
    wsl::windows_path_to_wsl(path).ok_or(UNSUPPORTED)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn format(shell: &str, paths: &[&str]) -> DropResult<String> {
        format_paths(
            &paths.iter().map(PathBuf::from).collect::<Vec<_>>(),
            &json!({"shell":shell}),
        )
    }

    #[test]
    fn powershell_quotes_multiple_unicode_paths_and_apostrophes() {
        assert_eq!(
            format("pwsh", &[r"C:\项目\a b.txt", r"D:\it's.txt"]).unwrap(),
            "'C:\\项目\\a b.txt' 'D:\\it''s.txt'"
        );
    }

    #[test]
    fn wsl_converts_drives_and_escapes_posix_quotes() {
        assert_eq!(
            format("wsl", &[r"D:\it's $(echo x).txt"]).unwrap(),
            "'/mnt/d/it'\\''s $(echo x).txt'"
        );
    }

    #[test]
    fn wsl_unc_requires_matching_known_distro() {
        let path = PathBuf::from(r"\\wsl.localhost\Ubuntu\home\me\a b");
        assert_eq!(
            format_paths(
                &[path.clone()],
                &json!({"shell":"wsl", "cwd":r"\\wsl$\ubuntu\home"})
            )
            .unwrap(),
            "'/home/me/a b'"
        );
        for cwd in [r"\\wsl$\Debian\home", r"C:\work"] {
            assert_eq!(
                format_paths(&[path.clone()], &json!({"shell":"wsl","cwd":cwd})),
                Err(UNSUPPORTED)
            );
        }
    }

    #[test]
    fn cmd_rejects_expansion_and_all_shells_reject_control_characters() {
        assert_eq!(
            format("cmd", &[r"C:\a & b.txt"]).unwrap(),
            "\"C:\\a & b.txt\""
        );
        for path in [r"C:\%PATH%.txt", r"C:\!name!.txt", "C:\\bad\"name"] {
            assert_eq!(format("cmd", &[path]), Err(INVALID));
        }
        for shell in ["pwsh", "cmd", "wsl", "gitbash", "bash"] {
            assert_eq!(format(shell, &["C:\\file\nexit"]), Err(INVALID));
        }
    }

    #[test]
    fn rejects_remote_unknown_shell_and_unmapped_paths_atomically() {
        assert_eq!(format("fish", &[r"C:\file"]), Err(UNSUPPORTED));
        assert_eq!(
            format("wsl", &[r"C:\ok", r"\\server\share\file"]),
            Err(UNSUPPORTED)
        );
        assert_eq!(
            format_paths(
                &[PathBuf::from(r"C:\file")],
                &json!({"shell":"pwsh","environmentType":"ssh"})
            ),
            Err(UNSUPPORTED)
        );
        assert_eq!(format("gitbash", &[r"C:\a b"]).unwrap(), "'/c/a b'");
    }

    #[tokio::test]
    async fn cancelled_target_does_not_attempt_to_find_a_client() {
        use super::super::{model, AttachCancellation, TerminalConnection};
        use std::sync::Arc;
        let cancellation = Arc::new(AttachCancellation::new());
        cancellation.cancel();
        let handle = SessionHandle::new(
            model("closed-target".into()).unwrap(),
            cancellation,
            Arc::new(TerminalConnection::new()),
        );
        assert_eq!(
            write_paths("closed-target", &handle, &[PathBuf::from(r"C:\file")]).await,
            Ok(())
        );
    }

    #[cfg(windows)]
    #[test]
    fn powershell_parses_inserted_arguments_without_expanding_path_content() {
        let expected = [r"C:\项目\a b.txt", r"D:\it's $HOME ` & ; #.txt"];
        let text = format("powershell", &expected).unwrap();
        let script = format!(
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); function Capture-Paths {{ ConvertTo-Json -InputObject @($args) -Compress }}; Capture-Paths {text}"
        );
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let actual: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(actual, expected);
    }
}
