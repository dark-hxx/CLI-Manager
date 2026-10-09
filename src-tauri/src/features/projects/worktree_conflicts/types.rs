use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub project_path: String,
    pub worktree_path: String,
    pub worktree_branch: String,
    pub base_branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State { Preparing, Resolving, Ready, Committing, Completed, Aborting, Aborted, RecoveryRequired }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Side { BaseBranch, Worktree }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Error { pub code: String, pub detail: String }
pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// 创建稳定错误码，底层诊断仅作为 detail 透传。
    pub fn new(code: &str, detail: impl ToString) -> Self { Self { code: code.into(), detail: detail.to_string() } }
}

impl From<std::io::Error> for Error {
    /// IO 错误不会伪装成已经成功的写入。
    fn from(error: std::io::Error) -> Self { Self::new("io_failed", error) }
}
impl From<git2::Error> for Error {
    /// 保留 Git 诊断，不依赖本地化 stderr 判断成功。
    fn from(error: git2::Error) -> Self { Self::new("git_failed", error) }
}
impl From<serde_json::Error> for Error {
    /// 损坏的持久化记录须显式恢复，不能按没有会话继续写。
    fn from(error: serde_json::Error) -> Self { Self::new("recovery_required", error) }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Stage { pub oid: String, pub mode: u32, pub stage: u8 }
pub type IndexState = BTreeMap<String, Vec<Stage>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub file_id: String,
    pub display_path: String,
    pub stages: Vec<Stage>,
    pub capability: String,
    pub reason: Option<String>,
    pub resolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub session_id: String,
    pub revision: u64,
    pub state: State,
    pub worktree_branch: String,
    pub base_branch: String,
    pub head_oid: String,
    pub base_oid: String,
    pub total: usize,
    pub resolved: usize,
    pub unresolved: usize,
    pub draft_count: usize,
    pub list_snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub snapshot: Snapshot,
    pub context: Context,
    pub operation_id: String,
    pub pending_tree: Option<String>,
    pub completed_oid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockView {
    pub id: String,
    pub start: usize,
    pub end: usize,
    pub base: String,
    pub worktree: String,
    pub ancestor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "text", rename_all = "snake_case")]
pub enum Selection { BaseBranch, Worktree, Both, Edited(String) }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub revision: u64,
    pub choices: BTreeMap<String, Selection>,
    pub source_hash: String,
    pub operation_id: String,
    pub payload_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub file_id: String,
    pub version: String,
    pub capability: String,
    pub reason: Option<String>,
    pub source: Option<String>,
    pub blocks: Vec<BlockView>,
    pub draft: Draft,
    pub base_exists: bool,
    pub worktree_exists: bool,
    pub marker_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub file_id: String,
    pub stage: Option<Stage>,
    pub work_hash: String,
    pub operation_id: String,
    pub payload_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub snapshot: Snapshot,
    pub files: Vec<FileEntry>,
    pub next_cursor: Option<usize>,
}
