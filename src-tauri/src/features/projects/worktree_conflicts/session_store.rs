//! 每个 linked Worktree 独立的会话日志；文件集合分片，不预读冲突内容。
use std::{collections::BTreeMap, fs, path::PathBuf};
use git2::{Repository, RepositoryState, StatusOptions};
use serde::{Deserialize, Serialize};
use crate::repo_operation::{self, OperationLock};
use super::{file_io, types::*};

pub const PAGE_SIZE: usize = 200;
pub(super) const ACTIVE: &str = "cli-manager-conflict-active.json";
const ROOT: &str = "cli-manager/conflict-resolution";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub common_dir: PathBuf,
    pub private_dir: PathBuf,
    pub worktree_root: PathBuf,
    pub branch: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub manifest: Manifest,
    pub identity: Identity,
    pub prepare_payload: String,
    pub index_pages: usize,
    pub index_hash: Option<String>,
    #[serde(default)]
    pub initial_work_tree: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pointer { schema_version: u32, session_id: String }

/// 锁顺序始终为主检出 → linked Worktree；锁不跨越用户交互。
pub struct Open {
    pub repo: Repository,
    pub identity: Identity,
    pub context: Context,
    _main_lock: OperationLock,
    _worktree_lock: OperationLock,
}

impl Open {
    /// 从当前 Git 登记验证项目、分支、私有目录和反向指针，拒绝客户端路径冒充。
    pub fn new(context: &Context) -> Result<Self> {
        let map = |e| Error::new("identity", e);
        super::super::validate_worktree_branch(&context.worktree_branch).map_err(map)?;
        super::super::validate_plain_branch_name(&context.base_branch).map_err(map)?;
        if context.base_branch == context.worktree_branch { return Err(map("identical branches".into())); }
        let main = super::super::open_main_repo(&context.project_path).map_err(map)?;
        if main.is_worktree() { return Err(map("expected primary checkout".into())); }
        let main_lock = repo_operation::begin_ordinary_write(&main).map_err(|e| Error::new("main_recovery_required", e))?;
        let repo = super::super::open_main_repo(&context.worktree_path).map_err(map)?;
        if !repo.is_worktree() { return Err(map("expected linked Worktree".into())); }
        let common_dir = main.path().canonicalize()?;
        let private_dir = repo.path().canonicalize()?;
        let name = private_dir.file_name().and_then(|v| v.to_str()).ok_or_else(|| map("invalid private Git directory".into()))?;
        let expected = file_io::safe_path(&common_dir, &format!("worktrees/{name}"))?;
        if expected != private_dir { return Err(map("worktree belongs to another repository".into())); }
        let worktree_root = repo.workdir().ok_or_else(|| map("missing checkout".into()))?.canonicalize()?;
        file_io::safe_path(&worktree_root, "identity-check")?;
        let backlink = file_io::bounded(&file_io::safe_path(&private_dir, "gitdir")?, 64 * 1024)?;
        let backlink = std::str::from_utf8(&backlink).map_err(|e| map(e.to_string()))?.trim();
        if private_dir.join(backlink).canonicalize()? != worktree_root.join(".git").canonicalize()? {
            return Err(map("worktree backlink mismatch".into()));
        }
        let common = file_io::bounded(&file_io::safe_path(&private_dir, "commondir")?, 64 * 1024)?;
        let common = std::str::from_utf8(&common).map_err(|e| map(e.to_string()))?.trim();
        if private_dir.join(common).canonicalize()? != common_dir { return Err(map("common directory mismatch".into())); }
        let branch = format!("refs/heads/{}", context.worktree_branch);
        if repo.head()?.name() != Some(branch.as_str()) { return Err(map("worktree branch mismatch".into())); }
        let worktree_lock = repo_operation::lock(&private_dir).map_err(|e| Error::new("busy", e))?;
        let identity = Identity { common_dir, private_dir, worktree_root, branch };
        Ok(Self { repo, identity, context: context.clone(), _main_lock: main_lock, _worktree_lock: worktree_lock })
    }

    /// 所有持久化文件路径经词法和 reparse 校验，不接受任意相对路径。
    pub fn path(&self, session: &str, leaf: &str) -> Result<PathBuf> {
        file_io::key(session)?;
        file_io::safe_path(&self.identity.private_dir, &format!("{ROOT}/{session}/{leaf}"))
    }

    /// active 文件存在但无法解码时保持恢复阻断，而不是视为没有会话。
    pub fn active(&self) -> Result<Option<Stored>> {
        let path = file_io::safe_path(&self.identity.private_dir, ACTIVE)?;
        if !path.try_exists()? { return Ok(None); }
        let pointer: Pointer = file_io::read_json(&path)?;
        if pointer.schema_version != 1 { return Err(Error::new("recovery_required", "unsupported pointer schema")); }
        self.load(&pointer.session_id).map(Some)
    }

    /// 读取必须重新验证持久化身份，不能将目录内别的会话当成当前操作。
    pub fn load(&self, session: &str) -> Result<Stored> {
        let stored: Stored = file_io::read_json(&self.path(session, "manifest.json")?)?;
        if stored.manifest.schema_version != 1 || stored.manifest.snapshot.session_id != session
            || stored.identity != self.identity || stored.manifest.context.base_branch != self.context.base_branch {
            return Err(Error::new("identity", "session identity mismatch"));
        }
        Ok(stored)
    }

    /// manifest 替换失败时旧版本仍完整，调用者不得先报告成功。
    pub fn save(&self, stored: &Stored) -> Result<()> {
        file_io::write_json(&self.path(&stored.manifest.snapshot.session_id, "manifest.json")?, stored)
    }

    /// 受管操作必须同时满足固定 HEAD、唯一 MERGE_HEAD 及无其他 Git 操作。
    pub fn owned(&self, stored: &Stored) -> Result<()> {
        let pointer: Pointer = file_io::read_json(&file_io::safe_path(&self.identity.private_dir, ACTIVE)?)?;
        if pointer.schema_version != 1 || pointer.session_id != stored.manifest.snapshot.session_id {
            return Err(Error::new("stale", "active session changed"));
        }
        if stored.identity != self.identity || self.repo.head()?.target().map(|v| v.to_string()) != Some(stored.manifest.snapshot.head_oid.clone()) {
            return Err(Error::new("stale", "HEAD or Worktree identity changed"));
        }
        self.no_foreign_locks()?;
        let merge = file_io::bounded(&file_io::safe_path(&self.identity.private_dir, "MERGE_HEAD")?, 256)
            .map_err(|e| Error::new("stale", e.detail))?;
        if std::str::from_utf8(&merge).ok().map(str::trim) != Some(stored.manifest.snapshot.base_oid.as_str())
            || self.repo.state() != RepositoryState::Merge {
            return Err(Error::new("foreign_operation", "MERGE_HEAD does not belong to this session"));
        }
        let original = file_io::bounded(&file_io::safe_path(&self.identity.private_dir, "ORIG_HEAD")?, 256)?;
        if std::str::from_utf8(&original).ok().map(str::trim) != Some(stored.manifest.snapshot.head_oid.as_str()) {
            return Err(Error::new("foreign_operation", "ORIG_HEAD does not belong to this session"));
        }
        Ok(())
    }

    /// 应用锁不替代 Git 锁；绝不删除或按年龄强占外部 index/ref 锁。
    pub fn no_foreign_locks(&self) -> Result<()> {
        for marker in ["index.lock", "HEAD.lock", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "sequencer"] {
            if file_io::safe_path(&self.identity.private_dir, marker)?.try_exists()? {
                return Err(Error::new("foreign_operation", marker));
            }
        }
        let branch_lock = file_io::safe_path(&self.identity.common_dir, &format!("{}.lock", self.identity.branch))?;
        if branch_lock.try_exists()? { return Err(Error::new("busy", "branch ref locked")); }
        Ok(())
    }
}

/// 一次索引扫描只读取路径/mode/OID；不启动每文件 Git，也不读取文件内容。
pub fn index_state(repo: &Repository) -> Result<IndexState> {
    let mut index = repo.index()?;
    index.read(true)?;
    let mut result: IndexState = BTreeMap::new();
    for entry in index.iter() {
        let path = std::str::from_utf8(&entry.path).map_err(|e| Error::new("unsupported", e))?.to_string();
        result.entry(path).or_default().push(Stage { oid: entry.id.to_string(), mode: entry.mode, stage: ((entry.flags >> 12) & 3) as u8 });
    }
    Ok(result)
}

/// 固定语义内容的哈希不受 index mtime、stat 缓存或扩展顺序影响。
pub fn index_hash(state: &IndexState) -> Result<String> { Ok(file_io::hash(&serde_json::to_vec(state)?)) }

/// 详情只比较当前路径；仍强制重读磁盘索引，不能复用跨请求的缓存。
/// 避免为整个索引分配路径/OID 字符串和 BTreeMap；写入门禁继续使用 index_state。
pub fn file_index_state(repo: &Repository, path: &str) -> Result<Vec<Stage>> {
    if path.contains('\0') { return Err(Error::new("invalid_path", "index path contains NUL")); }
    let mut index = repo.index()?;
    index.read(true)?;
    let mut result = Vec::with_capacity(3);
    for stage in 0..=3 {
        if let Some(entry) = index.get_path(std::path::Path::new(path), stage) {
            if entry.path != path.as_bytes() {
                return Err(Error::new("stale", "index path identity differs from the manifest"));
            }
            result.push(Stage { oid: entry.id.to_string(), mode: entry.mode, stage: ((entry.flags >> 12) & 3) as u8 });
        }
    }
    Ok(result)
}

/// 只有干净起点才能准备；不自动 stash，不接管外部未完成操作。
pub fn prepare(context: &Context, expected_head: &str, expected_base: &str, operation_id: &str) -> Result<Snapshot> {
    file_io::key(operation_id)?;
    let open = Open::new(context)?;
    let payload = file_io::hash(&serde_json::to_vec(&(expected_head, expected_base, &context.base_branch, &context.worktree_branch))?);
    if let Some(stored) = open.active()? {
        if stored.manifest.operation_id != operation_id { return Err(Error::new("busy", "active conflict session exists")); }
        if stored.prepare_payload != payload { return Err(Error::new("stale", "operation id payload mismatch")); }
        if stored.manifest.snapshot.state == State::Preparing { return super::session_prepare::reconcile(&open, &stored); }
        if !matches!(stored.manifest.snapshot.state, State::Resolving | State::Ready) {
            return Err(Error::new("recovery_required", "preparation requires inspection; merge is not replayed"));
        }
        open.owned(&stored)?;
        return Ok(stored.manifest.snapshot);
    }
    repo_operation::ensure_idle(&open.repo).map_err(|e| Error::new("foreign_operation", e))?;
    open.no_foreign_locks()?;
    let head = open.repo.head()?.peel_to_commit()?.id();
    let base = open.repo.find_reference(&format!("refs/heads/{}", context.base_branch))?.peel_to_commit()?.id();
    if head.to_string() != expected_head || base.to_string() != expected_base { return Err(Error::new("stale", "branch tips changed")); }
    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true);
    if !open.repo.statuses(Some(&mut options))?.is_empty() { return Err(Error::new("dirty_worktree", "commit or preserve changes before preparing")); }
    if head == base || open.repo.graph_descendant_of(head, base)? { return Err(Error::new("no_conflicts", "target is already an ancestor")); }
    let id = uuid::Uuid::new_v4().to_string();
    let manifest_path = open.path(&id, "manifest.json")?;
    fs::create_dir_all(manifest_path.parent().ok_or_else(|| Error::new("path_invalid", "missing session directory"))?)?;
    let snapshot = Snapshot { session_id: id.clone(), revision: 1, state: State::Preparing,
        worktree_branch: context.worktree_branch.clone(), base_branch: context.base_branch.clone(), head_oid: head.to_string(), base_oid: base.to_string(),
        total: 0, resolved: 0, unresolved: 0, draft_count: 0, list_snapshot_id: uuid::Uuid::new_v4().to_string() };
    let mut stored = Stored { manifest: Manifest { schema_version: 1, snapshot, context: context.clone(), operation_id: operation_id.into(), pending_tree: None, completed_oid: None },
        identity: open.identity.clone(), prepare_payload: payload, index_pages: 0, index_hash: None, initial_work_tree: None };
    open.save(&stored)?;
    file_io::write_json(&file_io::safe_path(&open.identity.private_dir, ACTIVE)?, &Pointer { schema_version: 1, session_id: id.clone() })?;
    // intent 已持久化后才运行 Git；失败或崩溃留 preparing，重试不重复 merge。
    let output = super::super::run_git_raw(&open.identity.worktree_root,
        ["-c", "merge.conflictStyle=diff3", "merge", "--no-ff", "--no-commit", "--no-edit", "--no-overwrite-ignore", "--", expected_base])
        .map_err(|e| Error::new("recovery_required", e))?;
    open.owned(&stored)?;
    let initial = index_state(&open.repo)?;
    let conflicts: Vec<_> = initial.iter().filter(|(_, stages)| stages.iter().any(|v| v.stage != 0)).collect();
    if !output.success && conflicts.is_empty() { return Err(Error::new("recovery_required", output.stderr)); }
    // ort 已生成的冲突工作树含 marker；只记 OID，不在初始枚举读取每个工作文件。
    // 老 Git/其他 merge 策略没有此证据时只读降级，不能解决或自动中止。
    stored.initial_work_tree = if conflicts.is_empty() {
        // 成功的 --no-commit 合并不保证生成 AUTO_MERGE；无冲突 index 即工作树基线。
        let mut index = open.repo.index()?;
        index.read(true)?;
        Some(index.write_tree()?.to_string())
    } else {
        match open.repo.find_reference("AUTO_MERGE") {
            Ok(reference) => Some(reference.peel_to_tree()?.id().to_string()),
            Err(error) if error.code() == git2::ErrorCode::NotFound => None,
            Err(error) => return Err(error.into()),
        }
    };
    let reasons = super::session_capabilities::classify(&open.repo, expected_head, expected_base, &initial)?;
    for (page, entries) in conflicts.chunks(PAGE_SIZE).enumerate() {
        let entries: Vec<_> = entries.iter().enumerate().map(|(offset, (path, stages))| {
            let reason = if file_io::relative(path).is_err() || stages.iter().any(|v| !matches!(v.mode, 0o100644 | 0o100755)) {
                Some("unsupported_path_or_mode".into())
            } else { reasons.get(*path).cloned() };
            FileEntry { file_id: format!("f-{page}-{offset}-{}", uuid::Uuid::new_v4()), display_path: (*path).clone(), stages: (*stages).clone(),
                capability: if reason.is_some() { "external_only" } else { "pending" }.into(),
                reason, resolved: false }
        }).collect();
        file_io::write_json(&open.path(&id, &format!("files-{page}.json"))?, &entries)?;
    }
    let entries: Vec<_> = initial.iter().collect();
    for (page, entries) in entries.chunks(PAGE_SIZE).enumerate() {
        file_io::write_json(&open.path(&id, &format!("index-{page}.json"))?, &entries)?;
    }
    stored.index_pages = entries.len().div_ceil(PAGE_SIZE);
    stored.index_hash = Some(index_hash(&initial)?);
    stored.manifest.snapshot.total = conflicts.len();
    stored.manifest.snapshot.unresolved = conflicts.len();
    stored.manifest.snapshot.revision += 1;
    stored.manifest.snapshot.state = if conflicts.is_empty() { State::Ready } else { State::Resolving };
    open.owned(&stored)?;
    if index_hash(&index_state(&open.repo)?)? != stored.index_hash.clone().unwrap_or_default() { return Err(Error::new("stale", "index changed during preparation")); }
    super::session_prepare::checkpoint(&open, &stored)?;
    open.owned(&stored)?;
    if index_hash(&index_state(&open.repo)?)? != stored.index_hash.clone().unwrap_or_default() { return Err(Error::new("stale", "index changed while saving preparation checkpoint")); }
    open.save(&stored)?;
    Ok(stored.manifest.snapshot)
}

/// 原始集合只从落盘页读取；外部 stage-all 不会让冲突总数消失。
pub fn page(open: &Open, stored: &Stored, snapshot_id: &str, cursor: usize, limit: usize) -> Result<Page> {
    let stored = &open.load(&stored.manifest.snapshot.session_id)?;
    open.owned(stored)?;
    let snapshot = &stored.manifest.snapshot;
    if snapshot.list_snapshot_id != snapshot_id { return Err(Error::new("stale", "list snapshot changed")); }
    if limit == 0 || limit > PAGE_SIZE || cursor > snapshot.total { return Err(Error::new("limit_exceeded", "invalid page bounds")); }
    let end = cursor.saturating_add(limit).min(snapshot.total);
    let mut files = Vec::with_capacity(end - cursor);
    for number in cursor / PAGE_SIZE..end.div_ceil(PAGE_SIZE) {
        let entries: Vec<FileEntry> = file_io::read_json(&open.path(&snapshot.session_id, &format!("files-{number}.json"))?)?;
        for (offset, entry) in entries.into_iter().enumerate() {
            let index = number * PAGE_SIZE + offset;
            if index >= cursor && index < end {
                let mut entry = entry;
                let receipt = open.path(&snapshot.session_id, &format!("receipt-{}.json", file_io::key(&entry.file_id)?))?;
                if receipt.try_exists()? {
                    let receipt: Receipt = file_io::read_json(&receipt)?;
                    if receipt.file_id != entry.file_id { return Err(Error::new("recovery_required", "receipt identity mismatch")); }
                    entry.resolved = true;
                }
                files.push(entry);
            }
        }
    }
    if files.len() != end - cursor { return Err(Error::new("recovery_required", "incomplete file collection")); }
    open.owned(stored)?;
    Ok(Page { snapshot: snapshot.clone(), files, next_cursor: (end < snapshot.total).then_some(end) })
}

/// fileId 只定位原始集合中的记录；伪造页号/路径不能突破会话白名单。
pub fn file(open: &Open, stored: &Stored, id: &str) -> Result<FileEntry> {
    file_io::key(id)?;
    let mut parts = id.split('-');
    if parts.next() != Some("f") { return Err(Error::new("path_invalid", "unknown file id")); }
    let page = parts.next().and_then(|v| v.parse::<usize>().ok()).ok_or_else(|| Error::new("path_invalid", "invalid file id"))?;
    if page >= stored.manifest.snapshot.total.div_ceil(PAGE_SIZE) { return Err(Error::new("path_invalid", "unknown file id")); }
    let entries: Vec<FileEntry> = file_io::read_json(&open.path(&stored.manifest.snapshot.session_id, &format!("files-{page}.json"))?)?;
    entries.into_iter().find(|v| v.file_id == id).ok_or_else(|| Error::new("path_invalid", "file not in original collection"))
}
