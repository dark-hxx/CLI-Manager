use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use uuid::Uuid;

const SNAPSHOT_SCRIPT: &str = r#"
import sqlite3, sys
source = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=15)
target = sqlite3.connect(sys.argv[2], timeout=15)
try:
    source.backup(target)
finally:
    target.close()
    source.close()
"#;

const WRITE_SETTING_SCRIPT: &str = r#"
import json, sqlite3, sys
request = json.load(sys.stdin)
connection = sqlite3.connect(sys.argv[1], timeout=15)
try:
    connection.execute("BEGIN IMMEDIATE")
    if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").fetchone() is None:
        connection.rollback()
        print("settings_table_missing")
        raise SystemExit(0)
    row = connection.execute("SELECT value FROM settings WHERE key = ?", (request["key"],)).fetchone()
    current = None if row is None else row[0]
    if current != request["expected"]:
        connection.rollback()
        print("conflict")
        raise SystemExit(0)
    if request["upsert"]:
        connection.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (request["key"], request["value"]),
        )
    elif row is not None:
        connection.execute("UPDATE settings SET value = ? WHERE key = ?", (request["value"], request["key"]))
    connection.commit()
    print("ok")
except Exception:
    connection.rollback()
    raise
finally:
    connection.close()
"#;

pub(crate) struct PreparedReadPath {
    path: PathBuf,
    temporary: bool,
}

impl PreparedReadPath {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for PreparedReadPath {
    fn drop(&mut self) {
        if self.temporary {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn wsl_target(path: &Path) -> Result<(String, String), String> {
    crate::wsl::parse_wsl_unc_path(&path.to_string_lossy())
        .ok_or_else(|| "invalid_wsl_db_path".to_string())
}

pub(crate) fn wsl_file_exists(path: &Path) -> Result<bool, String> {
    let (distro, linux_path) = wsl_target(path)?;
    let wsl = crate::wsl::find_wsl_exe().ok_or_else(|| "wsl_unavailable".to_string())?;
    let mut command = crate::shell_resolver::silent_command(wsl.to_string_lossy().as_ref());
    command
        .arg("-d")
        .arg(distro)
        .args(["--exec", "test", "-f"])
        .arg(linux_path);
    crate::shell_resolver::output_with_timeout(command, Duration::from_secs(15))
        .map(|output| output.status.success())
        .map_err(|err| format!("wsl_db_check_failed: {err}"))
}

fn run_wsl_python(distro: &str, script: &str, args: &[&str]) -> Result<String, String> {
    let wsl = crate::wsl::find_wsl_exe().ok_or_else(|| "wsl_unavailable".to_string())?;
    let mut command = crate::shell_resolver::silent_command(wsl.to_string_lossy().as_ref());
    command
        .arg("-d")
        .arg(distro)
        .args(["--exec", "python3", "-c", script])
        .args(args);
    let output = crate::shell_resolver::output_with_timeout(command, Duration::from_secs(15))
        .map_err(|err| format!("wsl_sqlite_failed: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.contains("python3") && stderr.contains("not found") {
            return Err("wsl_sqlite_runtime_unavailable".to_string());
        }
        return Err(if stderr.is_empty() {
            "wsl_sqlite_failed".to_string()
        } else {
            format!("wsl_sqlite_failed: {stderr}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_wsl_python_with_stdin(
    distro: &str,
    script: &str,
    args: &[&str],
    stdin: &[u8],
) -> Result<String, String> {
    let wsl = crate::wsl::find_wsl_exe().ok_or_else(|| "wsl_unavailable".to_string())?;
    let mut command = crate::shell_resolver::silent_command(wsl.to_string_lossy().as_ref());
    command
        .arg("-d")
        .arg(distro)
        .args(["--exec", "python3", "-c", script])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "wsl_sqlite_runtime_unavailable".to_string())?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "wsl_sqlite_stdin_unavailable".to_string())?
        .write_all(stdin)
        .map_err(|_| "wsl_sqlite_stdin_failed".to_string())?;
    let output = child
        .wait_with_output()
        .map_err(|_| "wsl_sqlite_failed".to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "wsl_sqlite_failed".to_string()
        } else {
            format!("wsl_sqlite_failed: {stderr}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) async fn prepare_read_path(path: &Path) -> Result<PreparedReadPath, String> {
    if !crate::wsl::is_wsl_config_dir(&path.to_string_lossy()) {
        return Ok(PreparedReadPath {
            path: path.to_path_buf(),
            temporary: false,
        });
    }

    let (distro, linux_path) = wsl_target(path)?;
    let snapshot = std::env::temp_dir().join(format!("cli-manager-ccswitch-{}.db", Uuid::new_v4()));
    let snapshot_wsl = crate::wsl::windows_path_to_wsl(&snapshot.to_string_lossy())
        .ok_or_else(|| "wsl_snapshot_path_unavailable".to_string())?;
    let result = tokio::task::spawn_blocking(move || {
        run_wsl_python(&distro, SNAPSHOT_SCRIPT, &[&linux_path, &snapshot_wsl])
    })
    .await
    .map_err(|err| format!("wsl_sqlite_failed: {err}"))?;
    if let Err(err) = result {
        let _ = std::fs::remove_file(&snapshot);
        return Err(err);
    }
    Ok(PreparedReadPath {
        path: snapshot,
        temporary: true,
    })
}

#[derive(serde::Serialize)]
struct SettingWriteRequest<'a> {
    key: &'a str,
    expected: Option<&'a str>,
    value: &'a str,
    upsert: bool,
}

pub(crate) async fn write_wsl_setting(
    path: &Path,
    key: &str,
    expected: Option<&str>,
    value: &str,
    upsert: bool,
) -> Result<bool, String> {
    let (distro, linux_path) = wsl_target(path)?;
    let request = serde_json::to_vec(&SettingWriteRequest {
        key,
        expected,
        value,
        upsert,
    })
    .map_err(|error| format!("wsl_sqlite_request_failed: {error}"))?;
    let result = tokio::task::spawn_blocking(move || {
        run_wsl_python_with_stdin(&distro, WRITE_SETTING_SCRIPT, &[&linux_path], &request)
    })
    .await
    .map_err(|error| format!("wsl_sqlite_failed: {error}"))??;
    match result.as_str() {
        "ok" => Ok(true),
        "settings_table_missing" => Ok(false),
        "conflict" => Err("db_write_conflict".to_string()),
        _ => Err(format!("wsl_sqlite_invalid_response: {result}")),
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use sqlx::{Connection, Row, SqliteConnection};

    #[tokio::test]
    #[ignore = "requires CLI_MANAGER_TEST_WSL_DISTRO and a working WSL Python sqlite3 runtime"]
    async fn wsl_database_snapshot_is_read_only() {
        let distro = std::env::var("CLI_MANAGER_TEST_WSL_DISTRO").unwrap();
        let linux_path = format!("/tmp/cli-manager-ccswitch-test-{}.db", Uuid::new_v4());
        run_wsl_python(
            &distro,
            "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)'); c.execute('INSERT INTO settings VALUES (?, ?)', ('common_config_claude', 'before')); c.commit(); c.close()",
            &[&linux_path],
        )
        .unwrap();
        let unc = PathBuf::from(crate::wsl::linux_to_unc_wsl_path(&linux_path, &distro));

        let prepared = prepare_read_path(&unc).await.unwrap();
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(prepared.path())
            .read_only(true);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        let before: String = sqlx::query("SELECT value FROM settings WHERE key = ?1")
            .bind("common_config_claude")
            .fetch_one(&mut connection)
            .await
            .unwrap()
            .try_get("value")
            .unwrap();
        assert_eq!(before, "before");
        drop(connection);
        drop(prepared);

        let _ = run_wsl_python(
            &distro,
            "import os,sys; os.remove(sys.argv[1]) if os.path.exists(sys.argv[1]) else None",
            &[&linux_path],
        );
    }
}
