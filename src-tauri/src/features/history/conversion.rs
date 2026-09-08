use super::super::history_backup::{
    create_file_backup_snapshot, default_backup_root,
    lock_source_mutations,
};
use super::{
    build_session_detail_with_roots, claude_project_key_from_path, codex_config_string,
    codex_runtime_path, collect_subtask_session_file_refs, excerpt, is_subagent_transcript_path,
    project_key_from_cwd, resolve_claude_history_root, resolve_codex_config_root,
    resolve_codex_history_root, resolve_codex_state_db_path, session_file_fingerprint,
    should_register_codex_state_db, CodexThreadRegistration, HistoryConversionResult,
    HistoryMessage, HistoryRoots, HistorySessionDetail, HistorySessionSummary, SessionFileRef,
    CODEX_HISTORY_INDEX_TEXT_MAX_CHARS,
};
use chrono::{DateTime, Datelike, SecondsFormat, Utc};
use log::{debug, warn};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

// 将 Claude 与 Codex 历史转换为新会话文件及索引，并解析回读验证返回身份。
pub(super) fn convert_history_session(
    detail: &HistorySessionDetail,
    target_source: &str,
    roots: &HistoryRoots,
) -> Result<HistoryConversionResult, String> {
    let source = detail.source.trim().to_lowercase();
    let target_source = target_source.trim().to_lowercase();
    if source != "claude" && source != "codex" {
        return Err("unsupported_history_source".to_string());
    }
    if target_source != "claude" && target_source != "codex" {
        return Err("unsupported_target_history_source".to_string());
    }
    if source == target_source {
        return Err("history_conversion_same_source".to_string());
    }

    let session_id = Uuid::new_v4().to_string();
    let cwd = converted_session_cwd(detail);
    let lines = match target_source.as_str() {
        "claude" => build_claude_conversion_lines(detail, &session_id, cwd.as_deref()),
        "codex" => build_codex_conversion_lines(
            detail,
            &session_id,
            cwd.as_deref(),
            &codex_config_string(roots, "model_provider").unwrap_or_else(|| "custom".to_string()),
        ),
        _ => unreachable!(),
    };
    let message_count = detail
        .messages
        .iter()
        .filter(|message| !converted_message_content(message).trim().is_empty())
        .count();
    if message_count == 0 {
        return Err("history_conversion_no_messages".to_string());
    }

    let target_path = match target_source.as_str() {
        "claude" => converted_claude_session_path(detail, roots, &session_id, cwd.as_deref()),
        "codex" => converted_codex_session_path(roots, &session_id),
        _ => unreachable!(),
    };
    write_jsonl_lines(&target_path, &lines)?;
    if target_source == "codex" {
        append_codex_history_index(roots, detail, &session_id)?;
        append_codex_session_index(roots, detail, &session_id, &target_path, cwd.as_deref())?;
    }

    let target_project_key = match target_source.as_str() {
        "claude" => target_path
            .canonicalize()
            .map_err(|_| "history_conversion_target_file_unavailable".to_string())?
            .parent()
            .and_then(Path::file_name)
            .map(|value| value.to_string_lossy().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "history_conversion_target_project_unavailable".to_string())?,
        "codex" => cwd
            .as_deref()
            .and_then(project_key_from_cwd)
            .unwrap_or_else(|| detail.project_key.clone()),
        _ => unreachable!(),
    };
    let file_ref = SessionFileRef {
        source: target_source.clone(),
        project_key: target_project_key,
        path: target_path.clone(),
    };
    let fingerprint = session_file_fingerprint(&file_ref.path);
    let title = codex_history_index_text(detail).unwrap_or_else(|| detail.title.clone());
    let summary = HistorySessionSummary {
        session_id: session_id.clone(),
        parent_session_id: None,
        source: target_source.clone(),
        project_key: file_ref.project_key.clone(),
        title,
        file_path: file_ref.path.to_string_lossy().to_string(),
        cwd: cwd.clone(),
        created_at: fingerprint.created_at,
        updated_at: fingerprint.updated_at,
        message_count,
        branch: detail.branch.clone(),
    };
    let target_detail = build_session_detail_with_roots(&file_ref, false, roots)?;
    if target_detail.source != target_source
        || target_detail.session_id != session_id
        || target_detail.file_path != summary.file_path
    {
        return Err("history_conversion_detail_mismatch".to_string());
    }

    Ok(HistoryConversionResult {
        source,
        target_source: target_source.clone(),
        session_id: session_id.clone(),
        project_key: summary.project_key.clone(),
        file_path: summary.file_path.clone(),
        cwd,
        message_count,
        resume_command: match target_source.as_str() {
            "claude" => format!("claude --resume {session_id}"),
            "codex" => format!("codex resume {session_id}"),
            _ => unreachable!(),
        },
        summary,
        detail: target_detail,
    })
}

// 拒绝子代理直接删除，备份父子 transcript 后逐个删除，失败恢复已删除文件。
pub(super) fn delete_session_tree_with_backup_root(
    file_ref: &SessionFileRef,
    backups_dir: &Path,
) -> Result<usize, String> {
    if is_subagent_transcript_path(&file_ref.path) {
        return Err("history_subagent_mutation_not_allowed".to_string());
    }
    let mut paths = collect_subtask_session_file_refs(file_ref)
        .into_iter()
        .map(|subtask| subtask.path)
        .collect::<Vec<_>>();
    paths.sort();
    paths.push(file_ref.path.clone());

    let mut backups = Vec::with_capacity(paths.len());
    for path in &paths {
        if path.exists() {
            let source_session_id = path
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "session".to_string());
            let backup = create_file_backup_snapshot(
                path,
                backups_dir,
                &file_ref.source,
                &source_session_id,
                "sessionDelete",
            )?;
            backups.push((path.clone(), backup));
        }
    }

    let mut deleted = 0usize;
    let mut deleted_paths = Vec::new();
    for path in paths {
        match fs::remove_file(&path) {
            Ok(()) => {
                deleted = deleted.saturating_add(1);
                deleted_paths.push(path);
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                for deleted_path in deleted_paths.iter().rev() {
                    if let Some((_, backup)) = backups
                        .iter()
                        .find(|(original, _)| original == deleted_path)
                    {
                        if let Err(restore_err) = fs::copy(backup, deleted_path) {
                            let _ = lock_source_mutations(&file_ref.source);
                            return Err(format!(
                                "manualRecoveryRequired: delete={}; restore={}",
                                err, restore_err
                            ));
                        }
                    }
                }
                return Err(format!("failedRolledBack: {err}"));
            }
        }
    }
    Ok(deleted)
}

// 使用默认备份根目录执行会话 transcript 树删除。
pub(super) fn delete_session_tree(file_ref: &SessionFileRef) -> Result<usize, String> {
    let backups_dir = default_backup_root()?;
    delete_session_tree_with_backup_root(file_ref, &backups_dir)
}

// 优先保留详情 cwd，缺失时使用非空项目键作为转换工作目录。
pub(super) fn converted_session_cwd(detail: &HistorySessionDetail) -> Option<String> {
    detail
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let project_key = detail.project_key.trim();
            if project_key.is_empty() {
                None
            } else {
                Some(project_key.to_string())
            }
        })
}

// 保留消息非空时间字符串，缺失时使用当前 UTC 时间。
pub(super) fn conversion_timestamp(message: &HistoryMessage) -> String {
    message
        .timestamp
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(now_rfc3339)
}

// 返回带毫秒精度的当前 UTC RFC3339 时间。
pub(crate) fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

// 助手角色保留为 assistant，其他角色转换为 user。
pub(super) fn converted_message_role(role: &str) -> &'static str {
    if role.eq_ignore_ascii_case("assistant") {
        "assistant"
    } else {
        "user"
    }
}

// 修剪消息正文，并为工具角色添加 Tool 标记。
pub(super) fn converted_message_content(message: &HistoryMessage) -> String {
    let content = message.content.trim();
    if message.role.eq_ignore_ascii_case("tool") {
        format!("[Tool]\n{content}")
    } else {
        content.to_string()
    }
}

// 将非空消息转换为带 UUID 父链的 Claude 文本 JSONL 记录。
pub(super) fn build_claude_conversion_lines(
    detail: &HistorySessionDetail,
    session_id: &str,
    cwd: Option<&str>,
) -> Vec<Value> {
    let mut lines = Vec::new();
    let mut parent_uuid: Option<String> = None;
    for message in &detail.messages {
        let content = converted_message_content(message);
        if content.trim().is_empty() {
            continue;
        }
        let role = converted_message_role(&message.role);
        let uuid = Uuid::new_v4().to_string();
        lines.push(json!({
            "parentUuid": parent_uuid,
            "isSidechain": false,
            "userType": "external",
            "cwd": cwd.unwrap_or_default(),
            "sessionId": session_id,
            "version": "cli-manager-converted",
            "type": role,
            "message": {
                "role": role,
                "content": claude_message_content_value(role, content)
            },
            "uuid": uuid,
            "timestamp": conversion_timestamp(message)
        }));
        parent_uuid = Some(uuid);
    }
    lines
}

// 助手正文包装为 text 块数组，其他角色使用字符串正文。
pub(super) fn claude_message_content_value(role: &str, content: String) -> Value {
    if role == "assistant" {
        json!([{ "type": "text", "text": content }])
    } else {
        Value::String(content)
    }
}

// 生成 Codex 会话元数据、上下文及每条消息的响应项与 UI 事件。
pub(super) fn build_codex_conversion_lines(
    detail: &HistorySessionDetail,
    session_id: &str,
    cwd: Option<&str>,
    model_provider: &str,
) -> Vec<Value> {
    let created_at = detail
        .messages
        .first()
        .map(conversion_timestamp)
        .unwrap_or_else(now_rfc3339);
    let mut lines = vec![
        json!({
            "timestamp": created_at,
            "type": "session_meta",
            "payload": {
                "session_id": session_id,
                "id": session_id,
                "timestamp": created_at,
                "cwd": cwd.unwrap_or_default(),
                "originator": "cli-manager",
                "cli_version": "cli-manager-converted",
                "model_provider": model_provider,
                "source": "cli",
                "thread_source": "user"
            }
        }),
        json!({
            "timestamp": created_at,
            "type": "turn_context",
            "payload": {
                "cwd": cwd.unwrap_or_default(),
                "model": detail
                    .usage
                    .current_model
                    .as_deref()
                    .or(detail.usage.dominant_model.as_deref())
                    .unwrap_or("converted-history")
            }
        }),
    ];

    for message in &detail.messages {
        let content = converted_message_content(message);
        if content.trim().is_empty() {
            continue;
        }
        let role = converted_message_role(&message.role);
        let block_type = if role == "assistant" {
            "output_text"
        } else {
            "input_text"
        };
        let timestamp = conversion_timestamp(message);
        lines.push(json!({
            "timestamp": timestamp,
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": role,
                "content": [
                    {
                        "type": block_type,
                        "text": content
                    }
                ]
            }
        }));
        lines.push(codex_ui_event_message(role, &content, &timestamp));
    }
    lines
}

// 按转换后角色生成 Codex agent_message 或 user_message 事件。
pub(super) fn codex_ui_event_message(role: &str, content: &str, timestamp: &str) -> Value {
    if role == "assistant" {
        json!({
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {
                "type": "agent_message",
                "message": content
            }
        })
    } else {
        json!({
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {
                "type": "user_message",
                "message": content
            }
        })
    }
}

// 根据 cwd 或项目键确定 Claude 项目目录并选择尚不存在的文件名。
pub(super) fn converted_claude_session_path(
    detail: &HistorySessionDetail,
    roots: &HistoryRoots,
    session_id: &str,
    cwd: Option<&str>,
) -> PathBuf {
    let project_key = cwd
        .map(claude_project_key_from_path)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            let project_key = detail.project_key.trim();
            if project_key.is_empty() {
                "default".to_string()
            } else {
                project_key.to_string()
            }
        });
    unique_jsonl_path(
        resolve_claude_history_root(roots).join(project_key),
        session_id,
    )
}

// 在当前 UTC 年月日目录下构造带时间和会话 ID 的 rollout 候选路径。
pub(super) fn converted_codex_session_path(roots: &HistoryRoots, session_id: &str) -> PathBuf {
    let now = Utc::now();
    let dir = resolve_codex_history_root(roots)
        .join(format!("{:04}", now.year()))
        .join(format!("{:02}", now.month()))
        .join(format!("{:02}", now.day()));
    let timestamp = now.format("%Y-%m-%dT%H-%M-%S");
    unique_jsonl_path(dir, &format!("rollout-{timestamp}-{session_id}"))
}

// 创建配置目录并为转换会话追加 Codex history.jsonl 记录。
pub(super) fn append_codex_history_index(
    roots: &HistoryRoots,
    detail: &HistorySessionDetail,
    session_id: &str,
) -> Result<(), String> {
    let path = resolve_codex_config_root(roots).join("history.jsonl");
    let parent = path
        .parent()
        .ok_or_else(|| "history_conversion_invalid_codex_history_path".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;

    let text = codex_history_index_text(detail)
        .unwrap_or_else(|| format!("Converted {} session", detail.source));
    let ts = codex_history_index_timestamp(detail);
    let line = json!({
        "session_id": session_id,
        "ts": ts,
        "text": text
    });
    append_jsonl_line(&path, &line)
}

// 优先选择转换后的首条用户正文，再回退首条非空消息并限制字符数。
pub(super) fn codex_history_index_text(detail: &HistorySessionDetail) -> Option<String> {
    detail
        .messages
        .iter()
        .find(|message| {
            !converted_message_content(message).trim().is_empty()
                && converted_message_role(&message.role) == "user"
        })
        .or_else(|| {
            detail
                .messages
                .iter()
                .find(|message| !converted_message_content(message).trim().is_empty())
        })
        .map(converted_message_content)
        .map(|content| excerpt(&content, CODEX_HISTORY_INDEX_TEXT_MAX_CHARS))
        .filter(|content| !content.trim().is_empty())
}

// 取首条消息的 RFC3339 秒时间，无法解析时使用当前秒数。
pub(super) fn codex_history_index_timestamp(detail: &HistorySessionDetail) -> i64 {
    detail
        .messages
        .first()
        .map(conversion_timestamp)
        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
        .map(|value| value.timestamp())
        .unwrap_or_else(|| Utc::now().timestamp())
}

// 为转换会话追加带标题、cwd 和 rollout 路径的 Codex 标题索引记录。
pub(super) fn append_codex_session_index(
    roots: &HistoryRoots,
    detail: &HistorySessionDetail,
    session_id: &str,
    rollout_path: &Path,
    cwd: Option<&str>,
) -> Result<(), String> {
    let path = resolve_codex_config_root(roots).join("session_index.jsonl");
    let parent = path
        .parent()
        .ok_or_else(|| "history_conversion_invalid_codex_session_index_path".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;

    let thread_name = codex_history_index_text(detail)
        .unwrap_or_else(|| format!("Converted {} session", detail.source));
    let updated_at = detail
        .messages
        .last()
        .map(conversion_timestamp)
        .unwrap_or_else(now_rfc3339);
    let line = json!({
        "id": session_id,
        "thread_name": thread_name,
        "updated_at": updated_at,
        "cwd": cwd.unwrap_or_default(),
        "rollout_path": codex_runtime_path(rollout_path)
    });
    append_jsonl_line(&path, &line)
}

// 以一次 write_all 追加含末尾换行的序列化 JSON 记录并刷新缓冲。
pub(super) fn append_jsonl_line(path: &Path, line: &Value) -> Result<(), String> {
    let mut encoded = serde_json::to_string(line).map_err(|err| err.to_string())?;
    encoded.push('\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| err.to_string())?;
    file.write_all(encoded.as_bytes())
        .map_err(|err| err.to_string())?;
    file.flush().map_err(|err| err.to_string())
}

// 结合源详情、转换结果及 Codex 配置构造状态库注册字段。
pub(super) fn build_codex_thread_registration(
    roots: &HistoryRoots,
    detail: &HistorySessionDetail,
    result: &HistoryConversionResult,
) -> CodexThreadRegistration {
    let first_timestamp = detail
        .messages
        .first()
        .map(conversion_timestamp)
        .unwrap_or_else(now_rfc3339);
    let last_timestamp = detail
        .messages
        .last()
        .map(conversion_timestamp)
        .unwrap_or_else(|| first_timestamp.clone());
    let created_at_ms =
        rfc3339_millis(&first_timestamp).unwrap_or_else(|| Utc::now().timestamp_millis());
    let updated_at_ms = rfc3339_millis(&last_timestamp).unwrap_or(created_at_ms);
    let first_user_message = codex_history_index_text(detail).unwrap_or_default();
    let model = detail
        .usage
        .current_model
        .as_deref()
        .or(detail.usage.dominant_model.as_deref())
        .map(str::to_string)
        .or_else(|| codex_config_string(roots, "model"))
        .unwrap_or_else(|| "converted-history".to_string());
    let model_provider =
        codex_config_string(roots, "model_provider").unwrap_or_else(|| "custom".to_string());

    CodexThreadRegistration {
        state_db_path: resolve_codex_state_db_path(roots),
        session_id: result.session_id.clone(),
        rollout_path: codex_runtime_path(Path::new(&result.file_path)),
        created_at: created_at_ms / 1000,
        updated_at: updated_at_ms / 1000,
        created_at_ms,
        updated_at_ms,
        cwd: result.cwd.clone().unwrap_or_default(),
        title: first_user_message.clone(),
        first_user_message: first_user_message.clone(),
        preview: first_user_message,
        model,
        model_provider,
    }
}

// 将修剪后的 RFC3339 字符串转换为 Unix 毫秒时间。
pub(super) fn rfc3339_millis(timestamp: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(timestamp.trim())
        .ok()
        .map(|value| value.timestamp_millis())
}

// 仅对现有本地 Codex 状态库插入或更新线程注册，WSL 或缺库时跳过。
pub(super) async fn register_codex_thread(
    registration: &CodexThreadRegistration,
) -> Result<(), String> {
    if !should_register_codex_state_db(&registration.state_db_path) {
        debug!(
            "skip Windows-side Codex state registration for WSL database: {}",
            registration.state_db_path.to_string_lossy()
        );
        return Ok(());
    }
    if !registration.state_db_path.exists() {
        warn!(
            "skip Codex state registration: state db not found: {}",
            registration.state_db_path.to_string_lossy()
        );
        return Ok(());
    }
    let mut conn = open_sqlite_readwrite(&registration.state_db_path).await?;
    let sandbox_policy = json!({ "type": "disabled" }).to_string();
    sqlx::query(
        "INSERT INTO threads (
            id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
            sandbox_policy, approval_mode, tokens_used, has_user_event, archived, cli_version,
            first_user_message, memory_mode, model, thread_source, preview, recency_at,
            created_at_ms, updated_at_ms, recency_at_ms
        ) VALUES (
            ?1, ?2, ?3, ?4, 'cli', ?5, ?6, ?7,
            ?8, 'never', 0, 1, 0, 'cli-manager-converted',
            ?9, 'enabled', ?10, 'user', ?11, ?12,
            ?13, ?14, ?15
        )
        ON CONFLICT(id) DO UPDATE SET
            rollout_path = excluded.rollout_path,
            updated_at = excluded.updated_at,
            model_provider = excluded.model_provider,
            cwd = excluded.cwd,
            title = excluded.title,
            first_user_message = excluded.first_user_message,
            model = excluded.model,
            preview = excluded.preview,
            recency_at = excluded.recency_at,
            updated_at_ms = excluded.updated_at_ms,
            recency_at_ms = excluded.recency_at_ms",
    )
    .bind(&registration.session_id)
    .bind(&registration.rollout_path)
    .bind(registration.created_at)
    .bind(registration.updated_at)
    .bind(&registration.model_provider)
    .bind(&registration.cwd)
    .bind(&registration.title)
    .bind(sandbox_policy)
    .bind(&registration.first_user_message)
    .bind(&registration.model)
    .bind(&registration.preview)
    .bind(registration.updated_at)
    .bind(registration.created_at_ms)
    .bind(registration.updated_at_ms)
    .bind(registration.updated_at_ms)
    .execute(&mut conn)
    .await
    .map_err(|err| format!("codex_state_register_failed: {err}"))?;
    Ok(())
}

// 使用十五秒忙等待打开可写 SQLite 连接并映射连接错误。
pub(super) async fn open_sqlite_readwrite(path: &Path) -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .busy_timeout(Duration::from_secs(15));
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|err| format!("db_open_failed: {err}"))
}

// 递增数字后缀直到候选 JSONL 路径不存在，不执行文件创建。
pub(super) fn unique_jsonl_path(dir: PathBuf, stem: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.jsonl"));
    let mut index = 1usize;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}-{index}.jsonl"));
        index += 1;
    }
    candidate
}

// 创建父目录并创建或截断目标文件，逐行写入 JSON 与换行后刷新。
pub(super) fn write_jsonl_lines(path: &Path, lines: &[Value]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "history_conversion_invalid_target_path".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let mut file = File::create(path).map_err(|err| err.to_string())?;
    for line in lines {
        let encoded = serde_json::to_string(line).map_err(|err| err.to_string())?;
        file.write_all(encoded.as_bytes())
            .map_err(|err| err.to_string())?;
        file.write_all(b"\n").map_err(|err| err.to_string())?;
    }
    file.flush().map_err(|err| err.to_string())
}
