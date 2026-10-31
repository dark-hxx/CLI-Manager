//! 按需加载单个冲突文件；草稿永远不改工作文件或暂存区。
use std::{collections::BTreeMap, path::Path};
use git2::{AttrCheckFlags, AttrValue, Repository};
use serde::{Deserialize, Serialize};
use super::{file_io, parser, session_store::{self, Open, Stored}, types::*};

#[derive(Serialize, Deserialize)]
struct Original { file_id: String, source: String, source_hash: String, marker_size: usize }

/// Git 属性特殊值必须经 AttrValue 解码，不能当作普通字符串解引用。
fn attribute<'a>(repo: &'a Repository, path: &str, name: &str) -> Result<AttrValue<'a>> {
    Ok(AttrValue::from_bytes(repo.get_attr_bytes(Path::new(path), name, AttrCheckFlags::FILE_THEN_INDEX)?))
}

/// 对过滤器、编码转换、自定义 merge driver 和锁文件保守降级。
fn policy(repo: &Repository, path: &str) -> Result<(usize, Option<String>, String)> {
    let attrs = ["conflict-marker-size", "filter", "working-tree-encoding", "merge", "diff", "text"]
        .iter().map(|name| attribute(repo, path, name)).collect::<Result<Vec<_>>>()?;
    let hash = file_io::hash(format!("{attrs:?}").as_bytes());
    let size = match attrs[0] {
        AttrValue::Unspecified => Some(7),
        AttrValue::String(value) => value.parse::<usize>().ok().filter(|v| (3..=parser::MAX_LINE_BYTES).contains(v)),
        _ => None,
    };
    let reason = if size.is_none() { Some("marker_size") }
        else if attrs[1..3].iter().any(|v| !matches!(v, AttrValue::Unspecified | AttrValue::False)) { Some("filter_or_encoding") }
        else if matches!(attrs[3], AttrValue::String(_) | AttrValue::Bytes(_)) { Some("merge_driver") }
        else if [attrs[3], attrs[4], attrs[5]].iter().any(|v| matches!(v, AttrValue::False)) { Some("binary_attribute") }
        else { None };
    let name = Path::new(path).file_name().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
    let lock = name.ends_with(".lock") || matches!(name.as_str(), "package-lock.json" | "npm-shrinkwrap.json" | "pnpm-lock.yaml" | "bun.lockb");
    Ok((size.unwrap_or(7), reason.or(lock.then_some("lock_file")).map(str::to_owned), hash))
}

/// 草稿文件损坏必须阻断；缺失才表示尚未编辑。
fn draft(open: &Open, stored: &Stored, id: &str, source_hash: &str) -> Result<Draft> {
    let path = open.path(&stored.manifest.snapshot.session_id, &format!("draft-{id}.json"))?;
    if !path.try_exists()? { return Ok(Draft { source_hash: source_hash.into(), ..Draft::default() }); }
    let value: Draft = file_io::read_json(&path)?;
    if value.source_hash != source_hash { return Err(Error::new("stale", "draft source changed")); }
    Ok(value)
}

/// 独立绑定会话、固定 stage、工作文件、属性和草稿版本，分页标识不随编辑变化。
fn version(stored: &Stored, entry: &FileEntry, work_hash: &str, attr_hash: &str, draft: &Draft) -> Result<String> {
    Ok(file_io::hash(&serde_json::to_vec(&(
        &stored.manifest.snapshot.session_id, stored.manifest.snapshot.revision,
        &entry.file_id, &entry.stages, work_hash, attr_hash, draft,
    ))?))
}

/// 首次打开也必须匹配准备时的 tree，不能把外部编辑当作新草稿基线。
/// Git 按该路径应用换行/clean 规则；只计算 OID，不写对象、工作文件或 index。
fn original_work(open: &Open, stored: &Stored, entry: &FileEntry, work_hash: &str) -> Result<()> {
    let oid = stored.initial_work_tree.as_ref().ok_or_else(|| Error::new("unsupported", "merge baseline unavailable"))?;
    let tree = open.repo.find_tree(git2::Oid::from_str(oid)?)?;
    let expected = match tree.get_path(Path::new(&entry.display_path)) {
        Ok(value) => Some(value),
        Err(error) if error.code() == git2::ErrorCode::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if work_hash == "missing" && expected.is_none() { return Ok(()); }
    let expected = expected.ok_or_else(|| Error::new("stale", "external file appeared at an absent merge path"))?;
    if work_hash == "missing" || !matches!(expected.filemode(), 0o100644 | 0o100755) {
        return Err(Error::new("stale", "working file no longer matches the merge baseline"));
    }
    let output = super::super::run_git_raw(&open.identity.worktree_root,
        ["-c", "core.longpaths=true", "hash-object", "--path", entry.display_path.as_str(), "--", entry.display_path.as_str()])
        .map_err(|e| Error::new("recovery_required", e))?;
    if !output.success || output.stdout.trim() != expected.id().to_string() {
        return Err(Error::new("stale", "working file changed since merge preparation"));
    }
    #[cfg(unix)]
    if open.repo.config()?.get_bool("core.filemode").unwrap_or(true) {
        use std::os::unix::fs::PermissionsExt;
        let path = file_io::safe_path(&open.identity.worktree_root, &entry.display_path)?;
        let executable = std::fs::metadata(path)?.permissions().mode() & 0o111 != 0;
        if executable != (expected.filemode() == 0o100755) {
            return Err(Error::new("stale", "working file mode changed since preparation"));
        }
    }
    Ok(())
}

/// 只读取当前白名单文件；外部 stage-all 不会使原始冲突自动变为已解决。
pub fn detail(open: &Open, stored: &Stored, id: &str) -> Result<Detail> {
    open.owned(stored)?;
    if !matches!(stored.manifest.snapshot.state, State::Resolving | State::Ready) {
        return Err(Error::new("recovery_required", "session is not editable"));
    }
    let entry = session_store::file(open, stored, id)?;
    let mut result = Detail { file_id: id.into(), version: String::new(), capability: "whole_file".into(),
        reason: None, source: None, blocks: Vec::new(), draft: Draft::default(),
        base_exists: entry.stages.iter().any(|s| s.stage == 3),
        worktree_exists: entry.stages.iter().any(|s| s.stage == 2), marker_size: 7 };
    if entry.capability == "external_only" || stored.initial_work_tree.is_none() {
        result.capability = "external_only".into();
        result.reason = entry.reason.clone().or_else(|| Some("missing_merge_baseline".into()));
        result.version = version(stored, &entry, "external", "external", &result.draft)?;
        return Ok(result);
    }
    if session_store::file_index_state(&open.repo, &entry.display_path)? != entry.stages {
        return Err(Error::new("stale", "file index stages changed outside this session"));
    }
    let path = file_io::safe_path(&open.identity.worktree_root, &entry.display_path)?;
    let work_hash = file_io::fingerprint(&path)?;
    original_work(open, stored, &entry, &work_hash)?;
    let (size, mut reason, attr_hash) = policy(&open.repo, &entry.display_path)?;
    result.marker_size = size;
    let bytes = if reason.is_none() && work_hash != "missing" {
        match file_io::bounded(&path, parser::MAX_SOURCE_BYTES) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.code == "limit_exceeded" => { reason = Some("too_large".into()); None }
            Err(error) => return Err(error),
        }
    } else { None };
    let blocks = if let Some(bytes) = &bytes {
        match parser::parse(bytes, size) {
            Ok(blocks) => Some(blocks),
            Err(fallback) => {
                reason = Some(match fallback { parser::Fallback::TooLarge => "too_large", parser::Fallback::Binary => "binary",
                    parser::Fallback::Encoding => "encoding", parser::Fallback::MixedNewlines => "mixed_newlines",
                    parser::Fallback::Malformed => "malformed", parser::Fallback::NoMarkers => "no_markers" }.into());
                None
            }
        }
    } else { None };
    let original_path = open.path(&stored.manifest.snapshot.session_id, &format!("source-{id}.json"))?;
    if original_path.try_exists()? {
        let original: Original = file_io::read_json(&original_path)?;
        if original.file_id != id || original.source_hash != file_io::hash(original.source.as_bytes()) {
            return Err(Error::new("recovery_required", "original source snapshot is corrupt"));
        }
        if original.source_hash != work_hash || original.marker_size != size {
            return Err(Error::new("stale", "working file differs from the saved source snapshot"));
        }
    }
    result.draft = draft(open, stored, id, &work_hash)?;
    if let (Some(bytes), Some(blocks)) = (&bytes, blocks) {
        let source = std::str::from_utf8(bytes).map_err(|e| Error::new("encoding", e))?;
        for block in blocks {
            result.blocks.push(BlockView { id: format!("b-{}-{}-{}", block.start, block.end, &work_hash[..16]),
                start: block.start, end: block.end, base: source[block.base].into(), worktree: source[block.worktree].into(),
                ancestor: block.ancestor.map(|range| source[range].into()) });
        }
        result.source = Some(source.into()); result.capability = "blocks".into();
    }
    result.reason = reason.or((work_hash == "missing").then(|| "missing_working_file".into()));
    result.version = version(stored, &entry, &work_hash, &attr_hash, &result.draft)?;
    if serde_json::to_vec(&result)?.len() > parser::MAX_JSON_BYTES {
        result.source = None; result.blocks.clear(); result.capability = "whole_file".into();
        result.reason = Some("json_limit".into());
        if serde_json::to_vec(&result)?.len() > parser::MAX_JSON_BYTES { return Err(Error::new("limit_exceeded", "draft JSON limit")); }
    }
    open.owned(stored)?;
    if session_store::file_index_state(&open.repo, &entry.display_path)? != entry.stages
        || file_io::fingerprint(&file_io::safe_path(&open.identity.worktree_root, &entry.display_path)?)? != work_hash
        || policy(&Repository::open(&open.identity.worktree_root)?, &entry.display_path)?.2 != attr_hash {
        return Err(Error::new("stale", "file changed while loading detail"));
    }
    if let Some(source) = &result.source {
        if !original_path.try_exists()? {
            file_io::write_json(&original_path, &Original { file_id: id.into(), source: source.clone(), source_hash: work_hash, marker_size: size })?;
        }
    }
    Ok(result)
}

/// 部分选择允许保存，但不允许伪造块 ID、超限编辑或隐式替换原始源。
fn validate_choices(detail: &Detail, choices: &BTreeMap<String, Selection>) -> Result<()> {
    if choices.len() > detail.blocks.len() { return Err(Error::new("invalid_draft", "too many choices")); }
    let mut edited_bytes = 0usize; let mut edited_lines = 0usize;
    for (id, selection) in choices {
        if !detail.blocks.iter().any(|block| block.id == *id) { return Err(Error::new("invalid_draft", "unknown block id")); }
        if let Selection::Edited(text) = selection {
            edited_bytes = edited_bytes.saturating_add(text.len());
            edited_lines = edited_lines.saturating_add(text.split(char::from(10)).count());
            if text.as_bytes().contains(&0) || text.split(char::from(10)).any(|line| line.len() > parser::MAX_LINE_BYTES)
                || edited_bytes > parser::MAX_SOURCE_BYTES || edited_lines > parser::MAX_LINES {
                return Err(Error::new("limit_exceeded", "edited text limit"));
            }
        }
    }
    Ok(())
}

/// 原子保存单文件草稿；同一 operationId 只接受相同 payload，旧版本不能覆盖新草稿。
pub fn save_draft(open: &Open, stored: &Stored, id: &str, expected_version: &str, expected_revision: u64,
    choices: BTreeMap<String, Selection>, operation_id: &str) -> Result<Draft> {
    super::session_abort::ensure_no_pending(open, stored)?;
    super::session_write::ensure_no_pending(open, stored)?;
    if open.path(&stored.manifest.snapshot.session_id, "pending-commit.json")?.try_exists()? {
        return Err(Error::new("recovery_required", "pending commit requires reconciliation"));
    }
    file_io::key(operation_id)?;
    let payload = serde_json::to_vec(&(id, expected_version, expected_revision, &choices))?;
    if payload.len() > parser::MAX_JSON_BYTES { return Err(Error::new("limit_exceeded", "draft request JSON limit")); }
    let payload_hash = file_io::hash(&payload);
    let current = detail(open, stored, id)?;
    if current.draft.operation_id == operation_id {
        if current.draft.payload_hash == payload_hash { return Ok(current.draft); }
        return Err(Error::new("stale", "operation id reused with different draft"));
    }
    if current.capability != "blocks" { return Err(Error::new("unsupported", "file does not support block editing")); }
    if current.version != expected_version || current.draft.revision != expected_revision {
        return Err(Error::new("stale", "draft version changed"));
    }
    validate_choices(&current, &choices)?;
    let revision = expected_revision.checked_add(1).ok_or_else(|| Error::new("limit_exceeded", "draft revision overflow"))?;
    let next = Draft { revision, choices, source_hash: current.draft.source_hash, operation_id: operation_id.into(), payload_hash };
    let fresh = detail(open, stored, id)?;
    if fresh.version != expected_version { return Err(Error::new("stale", "file changed before draft save")); }
    file_io::write_json(&open.path(&stored.manifest.snapshot.session_id, &format!("draft-{id}.json"))?, &next)?;
    Ok(next)
}
