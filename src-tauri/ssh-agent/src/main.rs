use cli_manager_hook_schema::HookConfigRequest;
use cli_manager_ssh_agent::hook_runtime::{run_hook, HookCommandOptions};
use cli_manager_ssh_agent::installer::{install_current_exe, rollback, uninstall, InstallOptions};
use cli_manager_ssh_agent::layout::{path_state, resolve_layout};
use cli_manager_ssh_agent::protocol::run_bridge;
use cli_manager_ssh_agent::target_supported;
use cli_manager_ssh_agent::version_report;
use serde_json::json;
use std::io::{self, BufReader, BufWriter, Read};
use uuid::Uuid;

fn option_value(options: &[String], name: &str) -> Result<Option<String>, String> {
    let Some(index) = options.iter().position(|value| value == name) else {
        return Ok(None);
    };
    options
        .get(index + 1)
        .cloned()
        .map(Some)
        .ok_or_else(|| format!("missing_option_value:{name}"))
}

fn print_json(value: serde_json::Value) {
    println!(
        "{}",
        serde_json::to_string(&value).expect("serialize agent output")
    );
}

fn read_json_stdin<T: serde::de::DeserializeOwned>() -> Result<T, String> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "agent_stdin_read_failed".to_string())?;
    if bytes.len() > 64 * 1024 {
        return Err("agent_stdin_too_large".to_string());
    }
    serde_json::from_slice(&bytes).map_err(|_| "agent_stdin_json_invalid".to_string())
}

fn status_report() -> serde_json::Value {
    match resolve_layout() {
        Ok(layout) => {
            let installation = cli_manager_ssh_agent::installer::read_installation_record(&layout);
            let diagnostic = installation.as_ref().err().cloned();
            let mut report = json!({
                "version": version_report(),
                "layout": layout,
                "installation": installation.as_ref().ok().and_then(|value| value.as_ref()),
                "state": {
                    "dataDir": path_state(&layout.data_dir),
                    "stateDir": path_state(&layout.state_dir),
                    "runtimeDir": path_state(&layout.runtime_dir),
                    "installationRecord": match installation {
                        Ok(Some(_)) => "available",
                        Ok(None) => "missing",
                        Err(_) => "invalid",
                    },
                }
            });
            if let Some(diagnostic) = diagnostic {
                report["diagnostic"] = json!(diagnostic);
            }
            report
        }
        Err(code) => json!({
            "version": version_report(),
            "layout": null,
            "state": { "layout": "unavailable" },
            "diagnostic": code,
        }),
    }
}

fn doctor_report() -> serde_json::Value {
    let mut report = status_report();
    let supported = target_supported();
    let layout_diagnostic = report
        .get("diagnostic")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    report["supported"] = json!(supported);
    report["code"] = json!(if !supported {
        "unsupported_target".to_string()
    } else {
        layout_diagnostic.unwrap_or_else(|| "ok".to_string())
    });
    report
}

fn bridge_protocol(options: &[String]) -> Result<&str, String> {
    let index = options
        .iter()
        .position(|value| value == "--protocol")
        .ok_or_else(|| "bridge_protocol_required".to_string())?;
    options
        .get(index + 1)
        .map(String::as_str)
        .ok_or_else(|| "bridge_protocol_required".to_string())
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "version".to_string());
    match command.as_str() {
        "version" => {
            print_json(serde_json::to_value(version_report()).map_err(|error| error.to_string())?)
        }
        "status" => print_json(status_report()),
        "doctor" => print_json(doctor_report()),
        "hook" => {
            let options: Vec<String> = args.collect();
            let parsed = (|| {
                Ok::<_, String>(HookCommandOptions {
                    source: option_value(&options, "--source")?
                        .ok_or_else(|| "hook_source_required".to_string())?,
                    event: option_value(&options, "--event")?
                        .ok_or_else(|| "hook_event_required".to_string())?,
                    managed_by: option_value(&options, "--managed-by")?
                        .ok_or_else(|| "hook_owner_required".to_string())?,
                    installation_id: option_value(&options, "--installation-id")?
                        .ok_or_else(|| "hook_installation_id_required".to_string())?,
                })
            })();
            if let Ok(options) = parsed {
                let stdin = io::stdin();
                let _ = run_hook(options, &mut stdin.lock());
            }
        }
        "hook-config" => {
            let action = args
                .next()
                .ok_or_else(|| "hook_config_action_required".to_string())?;
            let request: HookConfigRequest = read_json_stdin()?;
            let report = match action.as_str() {
                "inspect" => cli_manager_ssh_agent::hook_config::inspect(request)?,
                "preview-install" => cli_manager_ssh_agent::hook_config::preview(request, true)?,
                "preview-uninstall" => cli_manager_ssh_agent::hook_config::preview(request, false)?,
                "install" => cli_manager_ssh_agent::hook_config::apply(request, true)?,
                "uninstall" => cli_manager_ssh_agent::hook_config::apply(request, false)?,
                _ => return Err("hook_config_action_invalid".to_string()),
            };
            print_json(serde_json::to_value(report).map_err(|error| error.to_string())?);
        }
        "install" => {
            let options: Vec<String> = args.collect();
            let result = install_current_exe(InstallOptions {
                install_dir: option_value(&options, "--install-dir")?.map(Into::into),
                source: option_value(&options, "--source")?.unwrap_or_else(|| "manual".into()),
                manifest_url: option_value(&options, "--manifest-url")?.unwrap_or_default(),
                artifact_sha256: option_value(&options, "--artifact-sha256")?.unwrap_or_default(),
                allow_downgrade: options.iter().any(|value| value == "--allow-downgrade"),
            })?;
            print_json(serde_json::to_value(result).map_err(|error| error.to_string())?);
        }
        "rollback" => {
            let options: Vec<String> = args.collect();
            let result = rollback(option_value(&options, "--install-dir")?.map(Into::into))?;
            print_json(serde_json::to_value(result).map_err(|error| error.to_string())?);
        }
        "uninstall" => {
            let options: Vec<String> = args.collect();
            let result = uninstall(
                option_value(&options, "--install-dir")?.map(Into::into),
                options.iter().any(|value| value == "--purge"),
            )?;
            print_json(serde_json::to_value(result).map_err(|error| error.to_string())?);
        }
        "bridge" => {
            let options: Vec<String> = args.collect();
            if !options.iter().any(|value| value == "--stdio") {
                return Err("bridge_stdio_required".to_string());
            }
            if bridge_protocol(&options)? != "1" {
                return Err("bridge_protocol_incompatible".to_string());
            }
            let nonce = Uuid::new_v4().simple().to_string();
            let stdin = io::stdin();
            let stdout = io::stdout();
            run_bridge(
                &mut BufReader::new(stdin.lock()),
                &mut BufWriter::new(stdout.lock()),
                &nonce,
            )?;
        }
        _ => return Err(format!("unknown_command:{command}")),
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::{bridge_protocol, doctor_report, option_value, status_report};

    #[test]
    fn bridge_requires_an_explicit_compatible_protocol() {
        assert_eq!(
            bridge_protocol(&["--stdio".into()]).unwrap_err(),
            "bridge_protocol_required"
        );
        assert_eq!(
            bridge_protocol(&["--stdio".into(), "--protocol".into(), "1".into()]).unwrap(),
            "1"
        );
    }

    #[test]
    fn status_and_doctor_remain_structured_without_a_layout() {
        assert_eq!(
            status_report()["version"]["agentName"],
            "cli-manager-ssh-agent"
        );
        let doctor = doctor_report();
        assert!(doctor["supported"].is_boolean());
        assert!(doctor["code"].is_string());
    }

    #[test]
    fn options_require_values() {
        assert_eq!(
            option_value(&["--install-dir".into()], "--install-dir").unwrap_err(),
            "missing_option_value:--install-dir"
        );
        assert_eq!(
            option_value(
                &["--install-dir".into(), "/opt/agent".into()],
                "--install-dir"
            )
            .unwrap(),
            Some("/opt/agent".into())
        );
    }
}
