//! Opt-in native ConPTY regression for an already activated user Conda environment.
//! Run as the actual Windows user with Conda active and dsh/dsh-tui installed:
//! cargo +1.96.1 test --test windows_conda_path_smoke -- --ignored --nocapture
//! Uses the real profile and production PATH merge; no project PATH override,
//! no model calls, and no global installation or user configuration changes.
#![cfg(target_os = "windows")]

use cli_manager_lib::pty::manager::{PtyEventSink, PtyManager, PtyProcessStatus};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Capture(Mutex<Vec<u8>>);
impl PtyEventSink for Capture {
    fn on_output(&self, _: &str, bytes: &[u8]) {
        self.0.lock().unwrap().extend_from_slice(bytes);
    }
    fn on_status(&self, _: &str, _: PtyProcessStatus) {}
}

struct Close<'a>(&'a PtyManager, &'a str);
impl Drop for Close<'_> {
    fn drop(&mut self) {
        let _ = self.0.close(self.1);
    }
}

#[test]
#[ignore = "requires actual Windows user Conda profile and installed dsh/dsh-tui"]
fn powershell_conda_profile_preserves_global_dsh_commands_after_path_refresh() {
    assert!(
        std::env::var("CONDA_PREFIX").is_ok(),
        "Run from the user's activated Conda environment"
    );
    assert!(
        std::env::var("CONDA_SHLVL")
            .ok()
            .and_then(|level| level.parse::<u32>().ok())
            .unwrap_or(0)
            > 0,
        "The opt-in regression requires activated Conda"
    );
    assert_eq!(
        std::env::var("CONDA_DEFAULT_ENV").ok().as_deref(),
        Some("base"),
        "Run this opt-in regression from the already activated user base environment"
    );
    assert!(
        std::env::var("PATH")
            .unwrap_or_default()
            .to_lowercase()
            .contains(r"appdata\roaming\npm"),
        "The parent must already resolve the user's npm bin directory"
    );

    let manager = PtyManager::new();
    let id = uuid::Uuid::new_v4().to_string();
    let capture = Arc::new(Capture::default());
    let cwd = tempfile::tempdir().unwrap();
    // Deliberately retain real USERPROFILE/HOME and do not inject PATH.
    let env = HashMap::from([(
        "CLI_MANAGER_SHELL_RUNTIME_MONITORING".to_string(),
        "0".to_string(),
    )]);
    manager
        .create(
            &id,
            Some(cwd.path().to_str().unwrap()),
            Some(env),
            Some("powershell"),
            capture.clone(),
        )
        .unwrap();
    let _close = Close(&manager, &id);
    manager.resize(&id, 160, 24, None, None).unwrap();
    let marker = format!("CLI_MANAGER_PATH_CHECK_{}", uuid::Uuid::new_v4().simple());
    let command = format!(
        "[Console]::WriteLine(('{}|npm={{0}}|dsh={{1}}|dshTui={{2}}|base={{3}}' -f ($env:PATH -like '*AppData\\Roaming\\npm*'), [bool](Get-Command dsh -ErrorAction SilentlyContinue), [bool](Get-Command dsh-tui -ErrorAction SilentlyContinue), ($env:CONDA_DEFAULT_ENV -eq 'base')))\r",
        marker
    );
    manager.write(&id, &command).unwrap();
    let controls =
        regex::Regex::new(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))").unwrap();
    let probe = regex::Regex::new(&format!(
        r"^{}\|npm=(?:True|False)\|dsh=(?:True|False)\|dshTui=(?:True|False)\|base=(?:True|False)$",
        regex::escape(&marker)
    ))
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let observed = loop {
        let bytes = capture.0.lock().unwrap().clone();
        let raw = String::from_utf8_lossy(&bytes);
        let text = controls.replace_all(&raw, "");
        if let Some(line) = text
            .split_inclusive('\n')
            .find(|line| line.ends_with('\n') && probe.is_match(line.trim_matches(['\r', '\n'])))
        {
            break line.trim_matches(['\r', '\n']).to_string();
        }
        assert!(
            Instant::now() < deadline,
            "ConPTY did not return the boolean PATH probe; raw output withheld"
        );
        std::thread::sleep(Duration::from_millis(25));
    };
    // Matching a complete standalone computed line excludes echoed probe source.
    assert_eq!(
        observed,
        format!("{marker}|npm=True|dsh=True|dshTui=True|base=True"),
        "The actual PowerShell/Conda profile lost CLI visibility after native PATH refresh"
    );
    println!("ConPTY booleans: npm=True, dsh=True, dsh-tui=True, conda-base=True");
}
