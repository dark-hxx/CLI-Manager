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

// 将非空环境变量转换为路径，不检查绝对性、存在性或目录类型。
fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

// 要求非空 HOME，优先采用各 XDG 根并拼接 Agent 子目录；runtime 缺省使用 state/run。
// 仅计算布局，不创建或规范化路径，也不保证这些目录可访问。
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

// 依次判断目录和存在性，返回静态状态；跟随符号链接，元数据访问失败也可能显示 missing。
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
    // 验证约定不存在的相对路径被报告为 missing；测试未创建或删除目录。
    fn path_state_reports_missing_paths() {
        assert_eq!(
            path_state(std::path::Path::new("definitely-not-present-agent-path")),
            "missing"
        );
    }
}
