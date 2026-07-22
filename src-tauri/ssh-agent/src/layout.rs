use serde::Serialize;
use std::env;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLayout {
    pub home: PathBuf,
    pub data_dir: PathBuf,
    pub state_dir: PathBuf,
    pub runtime_dir: PathBuf,
    pub installation_record: PathBuf,
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn resolve_layout() -> Result<AgentLayout, &'static str> {
    let home = env_path("HOME").ok_or("home_directory_unavailable")?;
    let data_base = env_path("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local/share"));
    let state_base = env_path("XDG_STATE_HOME").unwrap_or_else(|| home.join(".local/state"));
    let state_dir = state_base.join("cli-manager-ssh-agent");
    let runtime_dir = env_path("XDG_RUNTIME_DIR")
        .map(|path| path.join("cli-manager-ssh-agent"))
        .unwrap_or_else(|| state_dir.join("run"));

    Ok(AgentLayout {
        home,
        data_dir: data_base.join("cli-manager-ssh-agent"),
        installation_record: state_dir.join("installation.json"),
        state_dir,
        runtime_dir,
    })
}

pub fn path_state(path: &Path) -> &'static str {
    if path.is_dir() {
        "available"
    } else if path.exists() {
        "not_directory"
    } else {
        "missing"
    }
}

#[cfg(test)]
mod tests {
    use super::path_state;

    #[test]
    fn path_state_reports_missing_paths() {
        assert_eq!(
            path_state(std::path::Path::new("definitely-not-present-agent-path")),
            "missing"
        );
    }
}
