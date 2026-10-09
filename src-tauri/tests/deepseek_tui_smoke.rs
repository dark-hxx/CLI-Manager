//! Opt-in real Windows ConPTY test. No credentials or model requests.
//! Set CLI_MANAGER_DSH_TUI_SMOKE_HOST (official lib/bin.js),
//! CLI_MANAGER_DSH_TUI_SMOKE_HOME (isolated DSH_HOME), and
//! CLI_MANAGER_DSH_TUI_SMOKE_USER_HOME (isolated preferences directory).
//! Optional CLI_MANAGER_DSH_TUI_SMOKE_LAUNCHER selects an installed bin/dsh-tui.js
//! instead of the direct official host. It must find dsh on the inherited PATH.
//! CLI_MANAGER_DSH_TUI_SMOKE_PRELOAD=1 stages the formal managed React preload
//! and applies it only inside a PowerShell try/finally command scope.
#![cfg(target_os = "windows")]
use cli_manager_lib::pty::manager::{PtyEventSink, PtyManager, PtyProcessStatus};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Sink(Mutex<Vec<u8>>);
impl PtyEventSink for Sink {
    fn on_output(&self, _: &str, data: &[u8]) {
        self.0.lock().unwrap().extend(data);
    }
    fn on_status(&self, _: &str, _: PtyProcessStatus) {}
}
impl Sink {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
    fn wait(&self, predicate: impl Fn(&str) -> bool) -> String {
        let deadline = Instant::now() + Duration::from_secs(40);
        loop {
            let text = self.text();
            if predicate(&text) {
                return text;
            }
            if Instant::now() >= deadline {
                let home = PathBuf::from(std::env::var("CLI_MANAGER_DSH_TUI_SMOKE_HOME").unwrap());
                let _ = std::fs::write(home.parent().unwrap().join("conpty-failure.log"), &text);
                panic!("TUI readiness timeout; inspect .tmp/dsh-smoke/conpty-failure.log");
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn session(text: &str, tab: &str) -> Option<String> {
    let prefix = format!("\x1b]777;cli-manager-dsh-tui;{tab};");
    text.split(&prefix)
        .skip(1)
        .filter_map(|suffix| {
            let candidate = suffix.split(['\x07', '\x1b']).next()?;
            uuid::Uuid::parse_str(candidate)
                .ok()
                .map(|_| candidate.to_owned())
        })
        .last()
}
// Neither item is sent as input: require actual help-body content, not /help echo.
fn help_visible(text: &str) -> bool {
    text.contains("/resume —") && text.contains("/compact —")
}

struct Close<'a>(&'a PtyManager, &'a str);
impl Drop for Close<'_> {
    fn drop(&mut self) {
        let _ = self.0.close(self.1);
    }
}

#[test]
#[ignore = "requires a built official host and installed TUI profile in isolated directories"]
fn real_tui_conpty_initial_input_resize_stop_and_exact_resume() {
    let launcher = std::env::var("CLI_MANAGER_DSH_TUI_SMOKE_LAUNCHER").ok();
    let host = if launcher.is_none() {
        Some(std::env::var("CLI_MANAGER_DSH_TUI_SMOKE_HOST").expect("set smoke host"))
    } else {
        None
    };
    let home = std::env::var("CLI_MANAGER_DSH_TUI_SMOKE_HOME").expect("set isolated DSH_HOME");
    let user_home =
        std::env::var("CLI_MANAGER_DSH_TUI_SMOKE_USER_HOME").expect("set isolated HOME");
    let staging = PathBuf::from(&home).parent().unwrap().join("bridge");
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(
        staging.join("bridge.mjs"),
        include_str!("../resources/deepseek-tui-bridge.mjs"),
    )
    .unwrap();
    std::fs::write(
        staging.join("bridge.yml"),
        "- insert:\n    - id: cli-manager-deepseek-tui-bridge\n      name: ./bridge.mjs\n",
    )
    .unwrap();
    let preload = staging.join("react-preload.mjs");
    std::fs::write(
        &preload,
        include_str!("../resources/deepseek-tui-react-preload.mjs"),
    )
    .unwrap();
    let preload_enabled = std::env::var("CLI_MANAGER_DSH_TUI_SMOKE_PRELOAD").as_deref() == Ok("1");
    let preload_option = format!(" --import={}", url::Url::from_file_path(&preload).unwrap());
    let patch = staging.join("bridge.yml").to_string_lossy().into_owned();
    let project = staging.parent().unwrap().join("project with spaces");
    std::fs::create_dir_all(&project).unwrap();
    let command = if let Some(launcher) = launcher {
        format!("node {} --patch {}\r", quote(&launcher), quote(&patch))
    } else {
        format!(
            "node {} --profile dsh-tui --patch {}\r",
            quote(host.as_deref().unwrap()),
            quote(&patch)
        )
    };
    let command = if preload_enabled {
        format!(
            "& {{ $cliManagerSmokeNodeOptions = $env:NODE_OPTIONS; try {{ $env:NODE_OPTIONS = [string]$cliManagerSmokeNodeOptions + {}; {} }} finally {{ $env:NODE_OPTIONS = $cliManagerSmokeNodeOptions }} }}\r",
            quote(&preload_option),
            command.trim_end(),
        )
    } else {
        command
    };
    let run = |saved: Option<&str>| {
        let tab = uuid::Uuid::new_v4().to_string();
        let mut env = HashMap::from([
            ("DSH_HOME".to_owned(), home.clone()),
            ("HOME".to_owned(), user_home.clone()),
            ("USERPROFILE".to_owned(), user_home.clone()),
            ("CLI_MANAGER_TAB_ID".to_owned(), tab.clone()),
            (
                "DSH_TUI_RESUME_SESSION".to_owned(),
                saved.unwrap_or("").to_owned(),
            ),
            ("NODE_ENV".to_owned(), "production".to_owned()),
            ("DSH_TELEMETRY_MODE".to_owned(), "DISABLED".to_owned()),
        ]);
        for (key, _) in std::env::vars().filter(|(key, _)| key.to_uppercase().contains("API_KEY")) {
            env.insert(key, String::new());
        }
        let manager = PtyManager::new();
        let sink = Arc::new(Sink::default());
        manager
            .create(
                &tab,
                Some(project.to_str().unwrap()),
                Some(env),
                Some("powershell"),
                sink.clone(),
            )
            .unwrap();
        let _close = Close(&manager, &tab);
        manager.resize(&tab, 110, 32, None, None).unwrap();
        let selected_command = if saved.is_none() {
            format!("$env:DSH_TUI_RESUME_SESSION=$null; {command}")
        } else {
            command.clone()
        };
        manager.write(&tab, &selected_command).unwrap();
        let first_screen =
            sink.wait(|text| session(text, &tab).is_some() || text.contains("New session"));
        if session(&first_screen, &tab).is_none() {
            manager.write(&tab, "\r").unwrap();
        }
        let rendered = sink.wait(|text| session(text, &tab).is_some());
        eprintln!("TUI foreground session captured for tab {tab}");
        let actual = session(&rendered, &tab).unwrap();
        assert!(
            rendered.contains("\x1b["),
            "real TUI should render ANSI content"
        );
        if let Some(expected) = saved {
            assert_eq!(actual, expected, "resume must preserve exact Session UUID");
        }
        std::thread::sleep(Duration::from_secs(5));
        manager.write(&tab, "\x1b").unwrap();
        std::thread::sleep(Duration::from_millis(500));
        manager.resize(&tab, 80, 24, None, None).unwrap();
        manager.write(&tab, "/help\r").unwrap();
        sink.wait(help_visible);
        manager.write(&tab, "\x1b").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        manager
            .write(&tab, "\x1b[200~CLI_MANAGER_PASTE_CHECK\x1b[201~")
            .unwrap();
        sink.wait(|text| text.contains("CLI_MANAGER_PASTE_CHECK"));
        manager.write(&tab, "\x03").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        manager.write(&tab, "\x03").unwrap();
        std::thread::sleep(Duration::from_millis(500));
        manager.write(&tab, "\x03").unwrap();
        std::thread::sleep(Duration::from_millis(500));
        manager
            .write(&tab, "Write-Output ('TUI_' + 'SMOKE_RETURNED')\r")
            .unwrap();
        let stopped = sink.wait(|text| text.contains("TUI_SMOKE_RETURNED"));
        eprintln!("TUI input/resize/stop verified for tab {tab}");
        std::fs::write(
            staging.parent().unwrap().join(format!("conpty-{tab}.log")),
            stopped,
        )
        .unwrap();
        actual
    };
    let initial = run(None);
    run(Some(&initial));
    std::thread::scope(|scope| {
        let first = scope.spawn(|| run(None));
        let second = scope.spawn(|| run(None));
        assert_ne!(
            first.join().unwrap(),
            second.join().unwrap(),
            "same-cwd live tabs must own distinct fresh Session UUIDs"
        );
    });
}

/// Exercise the production default: type the native command with no manager code.
#[test]
#[ignore = "requires an already installed native dsh-tui and explicit smoke home/preferences"]
fn real_native_launcher_render_input_resize_stop() {
    let home = std::env::var("CLI_MANAGER_DSH_TUI_SMOKE_HOME").expect("set existing DSH_HOME");
    let user_home =
        std::env::var("CLI_MANAGER_DSH_TUI_SMOKE_USER_HOME").expect("set isolated preferences");
    assert!(
        PathBuf::from(&home)
            .join("profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/bin/dsh-tui.js")
            .is_file(),
        "profile must be installed before the smoke; never bootstrap"
    );
    let root = PathBuf::from(&user_home)
        .parent()
        .unwrap()
        .join("native-command");
    let project = root.join(format!("project with spaces {}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&project).unwrap();
    let log = root.join("conpty.log");
    let manager = PtyManager::new();
    let sink = Arc::new(Sink::default());
    let tab = uuid::Uuid::new_v4().to_string();
    let env = HashMap::from([
        ("DSH_HOME".to_owned(), home),
        ("CLI_MANAGER_TAB_ID".to_owned(), tab.clone()),
        ("HOME".to_owned(), user_home.clone()),
        ("USERPROFILE".to_owned(), user_home),
        ("NODE_ENV".to_owned(), "production".to_owned()),
        ("DSH_TELEMETRY_MODE".to_owned(), "DISABLED".to_owned()),
    ]);
    manager
        .create(
            &tab,
            Some(project.to_str().unwrap()),
            Some(env),
            Some("powershell"),
            sink.clone(),
        )
        .unwrap();
    let _close = Close(&manager, &tab);
    native_wait(&sink, &log, |text| text.contains("PS "));
    manager.resize(&tab, 110, 32, None, None).unwrap();
    manager.write(&tab, "dsh-tui\r").unwrap();
    native_wait(&sink, &log, |text| {
        text.contains("New session") || text.contains("新会话") || text.contains("Context loaded")
    });
    std::thread::sleep(Duration::from_secs(5));
    manager.write(&tab, "\x1b").unwrap();
    std::thread::sleep(Duration::from_millis(500));
    manager.resize(&tab, 80, 24, None, None).unwrap();
    manager.write(&tab, "/help\r").unwrap();
    native_wait(&sink, &log, help_visible);
    manager.write(&tab, "\x1b").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    manager
        .write(&tab, "\x1b[200~CLI_MANAGER_NATIVE_PASTE\x1b[201~")
        .unwrap();
    native_wait(&sink, &log, |text| {
        text.contains("CLI_MANAGER_NATIVE_PASTE")
    });
    let before_stop = sink.text().len();
    for _ in 0..3 {
        manager.write(&tab, "\x03").unwrap();
        std::thread::sleep(Duration::from_millis(500));
    }
    // Wait for the shell before issuing a shell probe; never submit it to a model.
    let result = native_wait(&sink, &log, |text| {
        text.get(before_stop..)
            .is_some_and(|tail| tail.contains("PS "))
    });
    assert!(!result.contains("crashed:") && !result.contains("Cannot read properties of null"));
    assert!(
        session(&result, &tab).is_none(),
        "native startup must not mount the manager bridge"
    );
    std::fs::write(log, result).unwrap();
    eprintln!("Bare dsh-tui: real render/help/paste/resize/Ctrl+C passed");
}

fn native_wait(sink: &Sink, log: &std::path::Path, predicate: impl Fn(&str) -> bool) -> String {
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        let text = sink.text();
        if text.contains("crashed:")
            || text.contains("Cannot read properties of null")
            || Instant::now() >= deadline
        {
            std::fs::write(log, text).unwrap();
            panic!("native launcher failed; inspect {}", log.display());
        }
        if predicate(&text) {
            return text;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Diagnostic A/B evidence only: assertions remain in the functional smoke above.
#[test]
#[ignore = "requires explicit isolated diagnostic profile and installed launcher"]
fn diagnose_installed_launcher_host_and_bridge_matrix() {
    let launcher =
        std::env::var("CLI_MANAGER_DSH_TUI_SMOKE_LAUNCHER").expect("set installed launcher");
    let host_bin = std::env::var("CLI_MANAGER_DSH_TUI_DIAG_HOST_BIN_DIR")
        .expect("set isolated compatible host bin directory");
    let home = std::env::var("CLI_MANAGER_DSH_TUI_SMOKE_HOME").unwrap();
    let user_home = std::env::var("CLI_MANAGER_DSH_TUI_SMOKE_USER_HOME").unwrap();
    let root = PathBuf::from(&home).parent().unwrap().to_path_buf();
    let project = root.join("project with spaces");
    let patch = root.join("bridge/bridge.yml");
    assert!(patch.is_file(), "run prepared isolated smoke fixture first");
    let inherited_path = std::env::var("PATH").unwrap();
    let selected_cases = std::env::var("CLI_MANAGER_DSH_TUI_DIAG_CASES").ok();
    let probe_options = std::env::var("CLI_MANAGER_DSH_TUI_DIAG_NODE_OPTIONS").ok();
    let mut reports = Vec::new();
    for (label, isolated, bridge) in [
        ("global-bridge", false, true),
        ("isolated-bridge", true, true),
        ("global-plain", false, false),
        ("isolated-plain", true, false),
    ] {
        if selected_cases
            .as_deref()
            .is_some_and(|selected| !selected.split(',').any(|case| case.trim() == label))
        {
            continue;
        }
        let tab = uuid::Uuid::new_v4().to_string();
        let mut env = HashMap::from([
            ("DSH_HOME".to_owned(), home.clone()),
            ("HOME".to_owned(), user_home.clone()),
            ("USERPROFILE".to_owned(), user_home.clone()),
            ("CLI_MANAGER_TAB_ID".to_owned(), tab.clone()),
            ("DSH_TUI_RESUME_SESSION".to_owned(), String::new()),
            ("NODE_ENV".to_owned(), "production".to_owned()),
            ("DSH_TELEMETRY_MODE".to_owned(), "DISABLED".to_owned()),
        ]);
        if isolated {
            env.insert("PATH".to_owned(), format!("{host_bin};{inherited_path}"));
        }
        if let Some(probe) = &probe_options {
            let existing = std::env::var("NODE_OPTIONS").unwrap_or_default();
            env.insert("NODE_OPTIONS".to_owned(), format!("{existing} {probe}"));
            env.insert(
                "CLI_MANAGER_DSH_PROBE_DIR".to_owned(),
                root.join(format!("probe-{label}"))
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        for (key, _) in std::env::vars().filter(|(key, _)| key.to_uppercase().contains("API_KEY")) {
            env.insert(key, String::new());
        }
        let manager = PtyManager::new();
        let sink = Arc::new(Sink::default());
        manager
            .create(
                &tab,
                Some(project.to_str().unwrap()),
                Some(env),
                Some("powershell"),
                sink.clone(),
            )
            .unwrap();
        let _close = Close(&manager, &tab);
        manager.resize(&tab, 110, 32, None, None).unwrap();
        sink.wait(|text| text.contains("PS "));
        let patch_arg = if bridge {
            format!(" --patch {}", quote(&patch.to_string_lossy()))
        } else {
            String::new()
        };
        manager
            .write(
                &tab,
                &format!(
                    "$env:DSH_TUI_RESUME_SESSION=$null; node {}{patch_arg}\r",
                    quote(&launcher)
                ),
            )
            .unwrap();
        std::thread::sleep(Duration::from_secs(8));
        let initial = sink.text();
        // Enter only selects the startup New-session row; no model prompt is supplied.
        if initial.contains("New session") || initial.contains("新会话") {
            manager.write(&tab, "\r").unwrap();
            std::thread::sleep(Duration::from_secs(2));
        }
        manager.write(&tab, "\x1b").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        manager.resize(&tab, 80, 24, None, None).unwrap();
        manager.write(&tab, "/help\r").unwrap();
        std::thread::sleep(Duration::from_secs(5));
        let screen = sink.text();
        let status_before = manager.status_all().get(&tab).map(|s| s.status.clone());
        for _ in 0..3 {
            manager.write(&tab, "\x03").unwrap();
            std::thread::sleep(Duration::from_millis(500));
        }
        manager
            .write(&tab, "Write-Output ('DIAGNOSTIC_' + 'RETURNED')\r")
            .unwrap();
        std::thread::sleep(Duration::from_secs(2));
        let stopped = sink.text();
        let bytes = stopped.as_bytes();
        // Raw output is bounded, isolated and ignored; no environment or credentials are printed.
        std::fs::write(
            root.join(format!("diagnostic-{label}.log")),
            &bytes[..bytes.len().min(262_144)],
        )
        .unwrap();
        let report = serde_json::json!({
            "case": label,
            "isolatedHost": isolated,
            "managedBridge": bridge,
            "foregroundUuid": session(&screen, &tab).is_some(),
            "helpVisible": help_visible(&screen),
            "outputBytes": bytes.len(),
            "returnedToPowerShell": stopped.contains("DIAGNOSTIC_RETURNED"),
            "processStatusBeforeStop": status_before,
            "processStatusAfterStop": manager.status_all().get(&tab).map(|s| s.status.clone()),
            "cursorQuery": screen.contains("\x1b[6n"),
            "deviceQuery": screen.contains("\x1b[c") || screen.contains("\x1b[>c"),
        });
        eprintln!("{report}");
        reports.push(report);
    }
    assert!(
        !reports.is_empty(),
        "diagnostic filter must select an existing case"
    );
    std::fs::write(
        root.join("diagnostic-host-bridge-matrix.json"),
        serde_json::to_vec_pretty(&reports).unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "requires installed launcher and isolated CMD TUI profile"]
fn real_tui_cmd_preload_scope_restores_options_and_returns() {
    let home = std::env::var("CLI_MANAGER_DSH_TUI_SMOKE_HOME").expect("set isolated DSH_HOME");
    let user_home =
        std::env::var("CLI_MANAGER_DSH_TUI_SMOKE_USER_HOME").expect("set isolated HOME");
    let root = PathBuf::from(&home).parent().unwrap().to_path_buf();
    let staging = root.join("cmd bridge !");
    std::fs::create_dir_all(&staging).unwrap();
    let preload = staging.join("react-preload.mjs");
    std::fs::write(
        &preload,
        include_str!("../resources/deepseek-tui-react-preload.mjs"),
    )
    .unwrap();
    let preload_url = url::Url::from_file_path(&preload)
        .unwrap()
        .to_string()
        .replace('!', "%21");
    let wrapper = staging.join("node-options.cmd");
    std::fs::write(
        &wrapper,
        include_str!("../resources/deepseek-tui-node-options.cmd")
            .replace("{{PRELOAD_URL}}", &preload_url.replace('%', "%%")),
    )
    .unwrap();
    std::fs::write(
        staging.join("bridge.mjs"),
        include_str!("../resources/deepseek-tui-bridge.mjs"),
    )
    .unwrap();
    let patch = staging.join("bridge.yml");
    std::fs::write(
        &patch,
        "- insert:\n    - id: cli-manager-deepseek-tui-bridge\n      name: ./bridge.mjs\n",
    )
    .unwrap();
    let require_file = staging.join("existing!require.cjs");
    let require_source = if std::env::var("CLI_MANAGER_DSH_TUI_SMOKE_CMD_TRACE").as_deref()
        == Ok("1")
    {
        let trace_path = staging.join("node-options-metadata.jsonl");
        let _ = std::fs::remove_file(&trace_path);
        format!(
            "require('node:fs').appendFileSync({},JSON.stringify({{pid:process.pid,entry:process.argv[1],managedImport:(process.env.NODE_OPTIONS||'').includes('react-preload.mjs'),originalOptions:process.env.NODE_OPTIONS===process.env.CM_EXPECTED_NODE_OPTIONS,tabUuid:/^[0-9a-f-]{{36}}$/i.test(process.env.CLI_MANAGER_TAB_ID||'')}})+'\\n');\n",
            serde_json::to_string(&trace_path.to_string_lossy()).unwrap(),
        )
    } else {
        "// Existing user NODE_OPTIONS fixture; no side effects.\n".to_owned()
    };
    std::fs::write(&require_file, require_source).unwrap();
    let original_options = format!(
        "--no-deprecation --require=\"{}\"",
        require_file.to_string_lossy().replace('\\', "/")
    );
    let tab = uuid::Uuid::new_v4().to_string();
    let mut env = HashMap::from([
        ("DSH_HOME".to_owned(), home),
        ("HOME".to_owned(), user_home.clone()),
        ("USERPROFILE".to_owned(), user_home),
        ("CLI_MANAGER_TAB_ID".to_owned(), tab.clone()),
        ("DSH_TUI_RESUME_SESSION".to_owned(), String::new()),
        ("NODE_ENV".to_owned(), "production".to_owned()),
        ("DSH_TELEMETRY_MODE".to_owned(), "DISABLED".to_owned()),
        ("NODE_OPTIONS".to_owned(), original_options.clone()),
        ("CM_EXPECTED_NODE_OPTIONS".to_owned(), original_options),
    ]);
    for (key, _) in std::env::vars().filter(|(key, _)| key.to_uppercase().contains("API_KEY")) {
        env.insert(key, String::new());
    }
    let manager = PtyManager::new();
    let sink = Arc::new(Sink::default());
    let project = root.join("project with spaces");
    manager
        .create(
            &tab,
            Some(project.to_str().unwrap()),
            Some(env),
            Some("cmd"),
            sink.clone(),
        )
        .unwrap();
    let _close = Close(&manager, &tab);
    manager.resize(&tab, 110, 32, None, None).unwrap();
    manager
        .write(
            &tab,
            &format!(
                "set \"DSH_TUI_RESUME_SESSION=\"\r\n\"{}\" dsh-tui --patch \"{}\"\r\n",
                wrapper.display(),
                patch.display()
            ),
        )
        .unwrap();
    let first = sink.wait(|text| session(text, &tab).is_some() || text.contains("New session"));
    if session(&first, &tab).is_none() {
        manager.write(&tab, "\r").unwrap();
    }
    sink.wait(|text| session(text, &tab).is_some());
    std::thread::sleep(Duration::from_secs(5));
    manager.write(&tab, "\x1b").unwrap();
    std::thread::sleep(Duration::from_millis(500));
    manager.resize(&tab, 80, 24, None, None).unwrap();
    manager.write(&tab, "/help\r").unwrap();
    sink.wait(help_visible);
    manager.write(&tab, "\x1b").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    manager
        .write(&tab, "\x1b[200~CLI_MANAGER_CMD_PASTE\x1b[201~")
        .unwrap();
    sink.wait(|text| text.contains("CLI_MANAGER_CMD_PASTE"));
    let mut answered_prompts = 0;
    for _ in 0..3 {
        manager.write(&tab, "\x03").unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let prompt_count = sink.text().matches("(Y/N)").count();
        if prompt_count > answered_prompts {
            // Respond once to each newly observed prompt in this owned PTY.
            answered_prompts = prompt_count;
            manager.write(&tab, "y\r").unwrap();
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    manager.write(&tab, "powershell -NoProfile -Command \"[Console]::WriteLine(('CM_'+'OPTIONS_RESTORED='+($env:NODE_OPTIONS -ceq $env:CM_EXPECTED_NODE_OPTIONS)))\"\r\n").unwrap();
    let stopped = sink.wait(|text| {
        text.contains("CM_OPTIONS_RESTORED=True") || text.contains("CM_OPTIONS_RESTORED=False")
    });
    std::fs::write(root.join("conpty-cmd-scoped.log"), &stopped).unwrap();
    assert!(
        stopped.contains("CM_OPTIONS_RESTORED=True"),
        "CMD must return and exactly restore original options with spaces/quotes/bang"
    );
}
