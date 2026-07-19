use super::handoff_session::*;
use super::*;

const HANDOFF_NOTIFICATION_ATTEMPTS: usize = 24;
const HANDOFF_NOTIFICATION_RETRY_DELAY: Duration = Duration::from_millis(250);
const HANDOFF_NOTIFICATION_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Clone)]
struct RegisteredWorktree {
    id: String,
    project_id: String,
    name: String,
    path: String,
    provider_overrides: String,
    status: String,
}

#[derive(Debug, Clone)]
struct ResolvedHandoffTarget {
    profile: CcConnectProfile,
    project: RegisteredProject,
    worktree_id: Option<String>,
    worktree_name: Option<String>,
}

struct WeixinTokenTransfer {
    target_path: PathBuf,
    target_snapshot: FileSnapshot,
    user_id: String,
    token: String,
}

impl WeixinTokenTransfer {
    fn apply(&self) -> Result<(), String> {
        let mut document = match fs::read_to_string(&self.target_path) {
            Ok(raw) => serde_json::from_str(&raw)
                .map_err(|err| format!("parse target Weixin context tokens failed: {err}"))?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => empty_json_object(),
            Err(err) => return Err(format!("read target Weixin context tokens failed: {err}")),
        };
        merge_context_token(&mut document, &self.user_id, &self.token)?;
        let payload = serde_json::to_vec_pretty(&document)
            .map_err(|err| format!("serialize target Weixin context tokens failed: {err}"))?;
        write_file_atomically(&self.target_path, &payload, "Weixin handoff context tokens")
    }
}

fn validate_handoff_identifier(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("{label}_invalid"));
    }
    Ok(value.to_string())
}

fn canonical_local_directory(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute() || !path.is_dir() {
        return Err("handoff_work_dir_missing".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("canonicalize handoff work directory failed: {err}"))?;
    #[cfg(target_os = "windows")]
    if user_path_string(&canonical).starts_with(r"\\") {
        return Err("handoff_work_dir_unsupported".to_string());
    }
    Ok(canonical)
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        user_path_string(left).eq_ignore_ascii_case(&user_path_string(right))
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    if paths_equal(path, root) {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        let path = user_path_string(path)
            .replace('\\', "/")
            .to_ascii_lowercase();
        let root = user_path_string(root)
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase();
        path.starts_with(&(root + "/"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.starts_with(root)
    }
}

fn load_registered_worktree(worktree_id: &str) -> Result<Option<RegisteredWorktree>, String> {
    let database_path = crate::app_paths::db_path()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("create worktree query runtime failed: {err}"))?;
    runtime.block_on(async {
        let options = SqliteConnectOptions::new()
            .filename(&database_path)
            .read_only(true)
            .busy_timeout(Duration::from_secs(3));
        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .map_err(|err| format!("open CLI-Manager worktree database failed: {err}"))?;
        let row = sqlx::query(
            "SELECT id, project_id, name, path, provider_overrides, status              FROM worktrees WHERE id = ?",
        )
        .bind(worktree_id)
        .fetch_optional(&mut connection)
        .await
        .map_err(|err| format!("query CLI-Manager worktree failed: {err}"))?;
        let _ = connection.close().await;
        row.map(|row| {
            Ok(RegisteredWorktree {
                id: row
                    .try_get("id")
                    .map_err(|err| format!("read worktree ID failed: {err}"))?,
                project_id: row
                    .try_get("project_id")
                    .map_err(|err| format!("read worktree project failed: {err}"))?,
                name: row
                    .try_get("name")
                    .map_err(|err| format!("read worktree name failed: {err}"))?,
                path: row
                    .try_get("path")
                    .map_err(|err| format!("read worktree path failed: {err}"))?,
                provider_overrides: row
                    .try_get("provider_overrides")
                    .map_err(|err| format!("read worktree Provider override failed: {err}"))?,
                status: row
                    .try_get("status")
                    .map_err(|err| format!("read worktree status failed: {err}"))?,
            })
        })
        .transpose()
    })
}

fn load_provider_catalog_sync(profile: &CcConnectProfile) -> Result<ProviderCatalog, String> {
    let database_path = configured_cc_switch_db_path(Some(profile));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("create Provider query runtime failed: {err}"))?;
    Ok(runtime.block_on(load_provider_catalog(database_path.as_deref())))
}

fn provider_display_name(language: CcConnectLanguage, project: &RegisteredProject) -> String {
    match (
        language,
        project.provider_name.as_deref().map(single_line),
        project.provider_is_global,
    ) {
        (CcConnectLanguage::Zh, Some(name), true) => format!("{name}（全局）"),
        (CcConnectLanguage::En, Some(name), true) => format!("{name} (global)"),
        (_, Some(name), false) => name,
        (CcConnectLanguage::Zh, None, true) => "跟随 Codex 全局配置".to_string(),
        (CcConnectLanguage::En, None, true) => "Codex global configuration".to_string(),
        (CcConnectLanguage::Zh, None, false) => "项目指定 Provider".to_string(),
        (CcConnectLanguage::En, None, false) => "Project Provider override".to_string(),
    }
}

fn resolve_handoff_target(
    base_profile: &CcConnectProfile,
    request: &CcConnectHandoffStartRequest,
) -> Result<ResolvedHandoffTarget, String> {
    let mut project = load_registered_projects(Some(base_profile))?
        .into_iter()
        .find(|project| project.id == request.project_id.trim())
        .ok_or_else(|| "handoff_project_not_registered".to_string())?;
    if project.agent != CcConnectAgent::Codex {
        return Err("handoff_codex_only".to_string());
    }

    let (root_path, worktree_id, worktree_name) = if let Some(worktree_id) = request
        .worktree_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let worktree = load_registered_worktree(worktree_id)?
            .ok_or_else(|| "handoff_worktree_not_registered".to_string())?;
        if worktree.project_id != project.id {
            return Err("handoff_worktree_project_mismatch".to_string());
        }
        if worktree.status != "active" {
            return Err("handoff_worktree_missing".to_string());
        }
        let overrides = worktree.provider_overrides.trim();
        if !overrides.is_empty() && overrides != "{}" {
            let catalog = load_provider_catalog_sync(base_profile)?;
            let (provider_id, provider_name, provider_is_global) =
                project_provider(CcConnectAgent::Codex, overrides, &catalog);
            project.provider_id = provider_id.clone();
            project.codex_provider_id = provider_id;
            project.provider_name = provider_name;
            project.provider_is_global = provider_is_global;
        }
        (
            canonical_local_directory(&worktree.path)?,
            Some(worktree.id),
            Some(single_line(&worktree.name)),
        )
    } else {
        (canonical_local_directory(&project.path)?, None, None)
    };

    let work_dir = canonical_local_directory(&request.work_dir)?;
    if !path_is_within(&work_dir, &root_path) {
        return Err("handoff_work_dir_outside_project".to_string());
    }
    let work_dir = user_path_string(&work_dir);
    project.path = work_dir.clone();

    let mut profile = base_profile.clone();
    profile.project_id = project.id.clone();
    profile.project_name = project.name.clone();
    profile.project_path = work_dir;
    profile.agent = CcConnectAgent::Codex;

    Ok(ResolvedHandoffTarget {
        profile,
        project,
        worktree_id,
        worktree_name,
    })
}

fn source_profile_matches(profile: &CcConnectProfile, record: &PersistedHandoffRecord) -> bool {
    if profile.project_id != record.source_project_id
        || profile.project_name != record.source_project_name
    {
        return false;
    }
    if !platform_profile(profile, record.platform).is_some_and(|item| item.enabled) {
        return false;
    }
    let left = PathBuf::from(&profile.project_path);
    let right = PathBuf::from(&record.source_project_path);
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => paths_equal(&left, &right),
        _ => paths_equal(&left, &right),
    }
}

fn resolve_record_target(
    base_profile: &CcConnectProfile,
    record: &PersistedHandoffRecord,
) -> Result<ResolvedHandoffTarget, String> {
    if !source_profile_matches(base_profile, record) {
        return Err("handoff_source_profile_changed".to_string());
    }
    let request = CcConnectHandoffStartRequest {
        local_session_id: record.local_session_id.clone(),
        cli_session_id: record.cli_session_id.clone(),
        platform: record.platform,
        project_id: record.project_id.clone(),
        worktree_id: record.worktree_id.clone(),
        work_dir: record.work_dir.clone(),
        session_title: None,
    };
    let mut target = resolve_handoff_target(base_profile, &request)?;
    if target.project.name != record.project_name
        || target.worktree_name != record.worktree_name
        || !paths_equal(
            Path::new(&target.profile.project_path),
            Path::new(&record.work_dir),
        )
    {
        return Err("handoff_target_changed".to_string());
    }
    target.project.provider_id = record.provider_id.clone();
    target.project.codex_provider_id = record.provider_id.clone();
    target.project.provider_name = Some(record.provider_name.clone());
    target.project.provider_is_global = record.provider_is_global;
    Ok(target)
}

pub(super) fn effective_target_for_process(
    base_profile: CcConnectProfile,
) -> Result<(CcConnectProfile, RegisteredProject), String> {
    match load_handoff_record()? {
        Some(record) => {
            let target = resolve_record_target(&base_profile, &record)?;
            Ok((target.profile, target.project))
        }
        None => {
            let project = validate_registered_project(&base_profile)?;
            Ok((base_profile, project))
        }
    }
}

pub(super) fn ensure_handoff_inactive() -> Result<(), String> {
    if load_handoff_record()?.is_some() {
        Err(
            "cancel the active remote handoff before changing remote connection settings"
                .to_string(),
        )
    } else {
        Ok(())
    }
}

fn sanitize_weixin_path_segment(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return "default".to_string();
    }
    value
        .chars()
        .map(|character| {
            if matches!(character, '/' | '\\' | ':' | '\0') {
                '_'
            } else {
                character
            }
        })
        .collect()
}

fn weixin_context_token_path(project_name: &str, project_id: &str) -> Result<PathBuf, String> {
    Ok(data_dir()?
        .join("weixin")
        .join(sanitize_weixin_path_segment(project_name))
        .join(sanitize_weixin_path_segment(project_id))
        .join("context_tokens.json"))
}

fn load_weixin_context_token(
    base_profile: &CcConnectProfile,
    platform_session_key: &str,
) -> Result<(String, String), String> {
    let user_id = platform_session_key
        .strip_prefix("weixin:dm:")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "handoff_weixin_session_key_invalid".to_string())?;
    let source_path =
        weixin_context_token_path(&base_profile.project_name, &base_profile.project_id)?;
    let source_raw = fs::read_to_string(&source_path)
        .map_err(|err| format!("read source Weixin context tokens failed: {err}"))?;
    let source: serde_json::Value = serde_json::from_str(&source_raw)
        .map_err(|err| format!("parse source Weixin context tokens failed: {err}"))?;
    let token = context_token(&source, user_id)
        .ok_or_else(|| "handoff_weixin_context_token_missing".to_string())?;
    Ok((user_id.to_string(), token))
}

fn prepare_weixin_token_transfer(
    platform: CcConnectPlatform,
    base_profile: &CcConnectProfile,
    target: &ResolvedHandoffTarget,
    platform_session_key: &str,
) -> Result<Option<WeixinTokenTransfer>, String> {
    if platform != CcConnectPlatform::Weixin {
        return Ok(None);
    }
    let (user_id, token) = load_weixin_context_token(base_profile, platform_session_key)?;
    let target_path =
        weixin_context_token_path(&target.profile.project_name, &target.profile.project_id)?;
    Ok(Some(WeixinTokenTransfer {
        target_snapshot: FileSnapshot::capture(
            target_path.clone(),
            "Weixin handoff context tokens",
        )?,
        target_path,
        user_id,
        token,
    }))
}

fn format_handoff_notification(
    record: &PersistedHandoffRecord,
    active: bool,
    language: CcConnectLanguage,
) -> String {
    match (language, active) {
        (CcConnectLanguage::Zh, true) => format!(
            "CLI-Manager 会话已托管\ncliSessionId：{}\n工作目录：{}\n项目：{}\nProvider：{}",
            record.cli_session_id, record.work_dir, record.project_name, record.provider_name
        ),
        (CcConnectLanguage::Zh, false) => format!(
            "CLI-Manager 会话已取消托管\ncliSessionId：{}\n工作目录：{}\n项目：{}\nProvider：{}",
            record.cli_session_id, record.work_dir, record.project_name, record.provider_name
        ),
        (CcConnectLanguage::En, true) => format!(
            "CLI-Manager session is now remotely managed\ncliSessionId: {}\nWorking directory: {}\nProject: {}\nProvider: {}",
            record.cli_session_id, record.work_dir, record.project_name, record.provider_name
        ),
        (CcConnectLanguage::En, false) => format!(
            "CLI-Manager remote management has been cancelled\ncliSessionId: {}\nWorking directory: {}\nProject: {}\nProvider: {}",
            record.cli_session_id, record.work_dir, record.project_name, record.provider_name
        ),
    }
}

fn send_handoff_notification(
    binary: &Path,
    project_name: &str,
    platform_session_key: &str,
    message: &str,
) -> Result<(), String> {
    let data_directory = data_dir()?;
    let mut last_error = "cc-connect notification API was not ready".to_string();
    for _ in 0..HANDOFF_NOTIFICATION_ATTEMPTS {
        let mut command = silent_command(&path_string(binary));
        command
            .arg("send")
            .arg("--project")
            .arg(project_name)
            .arg("--session")
            .arg(platform_session_key)
            .arg("--message")
            .arg(message)
            .arg("--data-dir")
            .arg(&data_directory);
        match output_with_timeout(command, HANDOFF_NOTIFICATION_TIMEOUT) {
            Ok(output) if output.status.success() => return Ok(()),
            Ok(output) => {
                let detail = output_text(&output.stdout, &output.stderr);
                last_error = if detail.trim().is_empty() {
                    format!("cc-connect send exited with {}", output.status)
                } else {
                    detail
                };
            }
            Err(err) => last_error = err.to_string(),
        }
        std::thread::sleep(HANDOFF_NOTIFICATION_RETRY_DELAY);
    }
    Err(format!(
        "send remote handoff notification failed: {last_error}"
    ))
}

fn manager_process_running(manager: &CcConnectManager) -> Result<bool, String> {
    let state = manager
        .process
        .lock()
        .map_err(|_| "cc-connect process lock poisoned".to_string())?;
    Ok(state.process.is_some() && !state.starting)
}

fn validate_record_session_path(record: &PersistedHandoffRecord) -> Result<PathBuf, String> {
    let root = data_dir()?;
    let recorded = PathBuf::from(&record.session_file_path);
    let candidates = cc_session_store_candidates(&root, &record.project_name, &record.work_dir)?;
    if !path_is_within(&recorded, &root)
        || !candidates
            .iter()
            .any(|candidate| paths_equal(candidate, &recorded))
    {
        return Err("handoff_session_path_invalid".to_string());
    }
    Ok(recorded)
}

impl CcConnectManager {
    fn handoff_platform_targets(&self) -> Result<Vec<CcConnectHandoffPlatformTarget>, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.refresh_process_state();
        let running = manager_process_running(self)?;
        let profile = match load_profile()? {
            Some(profile) => profile,
            None => return Ok(Vec::new()),
        };
        let source_session_path =
            cc_session_store_path(&data_dir()?, &profile.project_name, &profile.project_path)?;
        let source_document = read_session_document(&source_session_path)?;
        let handoff_active = load_handoff_record()?.is_some();
        enabled_platforms(&profile)
            .into_iter()
            .map(|item| {
                let credentials_ready = credentials_ready(item.platform).unwrap_or(false);
                let allow_from = normalize_allow_from(item.platform, &item.allow_from)
                    .map_err(|_| "handoff_platform_user_missing".to_string());
                let mut session_result = match &allow_from {
                    Ok(allow_from) => {
                        resolve_platform_session_key(&source_document, item.platform, allow_from)
                    }
                    Err(error) => Err(error.clone()),
                };
                if item.platform == CcConnectPlatform::Weixin {
                    if let Ok(session_key) = &session_result {
                        if load_weixin_context_token(&profile, session_key).is_err() {
                            session_result = Err("handoff_platform_session_missing".to_string());
                        }
                    }
                }
                let session_ready = session_result.is_ok();
                let unavailable_reason = if handoff_active {
                    Some("handoff_active".to_string())
                } else if !running {
                    Some("cc_connect_not_running".to_string())
                } else if !credentials_ready {
                    Some("handoff_credentials_missing".to_string())
                } else if let Err(error) = &allow_from {
                    Some(error.clone())
                } else if let Err(error) = &session_result {
                    Some(error.clone())
                } else {
                    None
                };
                Ok(CcConnectHandoffPlatformTarget {
                    platform: item.platform,
                    enabled: true,
                    credentials_ready,
                    session_ready,
                    ready: unavailable_reason.is_none(),
                    unavailable_reason,
                })
            })
            .collect()
    }

    fn handoff_status_with_warning(
        &self,
        warning: Option<String>,
    ) -> Result<CcConnectHandoffStatus, String> {
        self.refresh_process_state();
        let running = manager_process_running(self)?;
        let record = load_handoff_record()?;
        let warning = warning.or_else(|| {
            (record.is_some() && !running).then_some("cc_connect_not_running".to_string())
        });
        Ok(CcConnectHandoffStatus {
            active: record.is_some(),
            running,
            info: record.as_ref().map(CcConnectHandoffInfo::from),
            warning,
        })
    }

    fn handoff_start(
        &self,
        request: CcConnectHandoffStartRequest,
    ) -> Result<CcConnectHandoffStatus, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.refresh_process_state();
        ensure_handoff_inactive()?;
        if !manager_process_running(self)? {
            return Err("cc_connect_not_running".to_string());
        }

        let local_session_id =
            validate_handoff_identifier(&request.local_session_id, "local_session_id")?;
        let cli_session_id =
            validate_handoff_identifier(&request.cli_session_id, "cli_session_id")?;
        let base_profile =
            load_profile()?.ok_or_else(|| "cc-connect profile is not configured".to_string())?;
        let selected_platform = platform_profile(&base_profile, request.platform)
            .filter(|item| item.enabled)
            .ok_or_else(|| "handoff_platform_disabled".to_string())?;
        let selected_allow_from =
            normalize_allow_from(selected_platform.platform, &selected_platform.allow_from)
                .map_err(|_| "handoff_platform_user_missing".to_string())?;
        if !credentials_ready(request.platform)? {
            return Err("handoff_credentials_missing".to_string());
        }
        let target = resolve_handoff_target(&base_profile, &request)?;
        let binary = self.detect(base_profile.executable_path.as_deref(), true)?;
        if !binary.compatible {
            return Err("cc_connect_version_unsupported".to_string());
        }

        self.stop_inner()?;
        let preparation = (|| {
            let sessions_root = data_dir()?;
            let source_session_path = cc_session_store_path(
                &sessions_root,
                &base_profile.project_name,
                &base_profile.project_path,
            )?;
            let source_document = read_session_document(&source_session_path)?;
            let platform_session_key = resolve_platform_session_key(
                &source_document,
                request.platform,
                &selected_allow_from,
            )?;
            let target_session_path = cc_session_store_path(
                &sessions_root,
                &target.profile.project_name,
                &target.profile.project_path,
            )?;
            if !path_is_within(&target_session_path, &sessions_root) {
                return Err("handoff_session_path_invalid".to_string());
            }
            let mut target_document = read_session_document(&target_session_path)?;
            let (cc_session_id, previous_active_session_id) = inject_handoff_session(
                &mut target_document,
                &platform_session_key,
                &cli_session_id,
                request.session_title.as_deref(),
            )?;
            let token_transfer = prepare_weixin_token_transfer(
                request.platform,
                &base_profile,
                &target,
                &platform_session_key,
            )?;
            let record = PersistedHandoffRecord {
                schema_version: HANDOFF_SCHEMA_VERSION,
                local_session_id,
                cli_session_id,
                project_id: target.project.id.clone(),
                project_name: target.project.name.clone(),
                worktree_id: target.worktree_id.clone(),
                worktree_name: target.worktree_name.clone(),
                work_dir: target.profile.project_path.clone(),
                provider_id: target.project.codex_provider_id.clone(),
                provider_name: provider_display_name(base_profile.language, &target.project),
                provider_is_global: target.project.provider_is_global,
                platform: request.platform,
                platform_session_key,
                cc_session_id,
                session_file_path: user_path_string(&target_session_path),
                previous_active_session_id,
                source_project_id: base_profile.project_id.clone(),
                source_project_name: base_profile.project_name.clone(),
                source_project_path: base_profile.project_path.clone(),
                started_at_ms: now_millis(),
            };
            let session_snapshot =
                FileSnapshot::capture(target_session_path.clone(), "cc-connect handoff session")?;
            let record_snapshot =
                FileSnapshot::capture(handoff_path()?, "cc-connect handoff record")?;
            let config_snapshot = FileSnapshot::capture(config_path()?, "cc-connect config")?;
            Ok((
                target_session_path,
                target_document,
                token_transfer,
                record,
                session_snapshot,
                record_snapshot,
                config_snapshot,
            ))
        })();
        let (
            target_session_path,
            target_document,
            token_transfer,
            record,
            session_snapshot,
            record_snapshot,
            config_snapshot,
        ) = match preparation {
            Ok(prepared) => prepared,
            Err(preparation_error) => {
                return match self.start_inner() {
                    Ok(()) => Err(preparation_error),
                    Err(restart_error) => Err(format!(
                        "{preparation_error}; restart original cc-connect failed: {restart_error}"
                    )),
                };
            }
        };

        let start_result = (|| {
            write_session_document(&target_session_path, &target_document)?;
            if let Some(transfer) = token_transfer.as_ref() {
                transfer.apply()?;
            }
            persist_handoff_record(&record)?;
            self.start_inner()?;
            send_handoff_notification(
                &binary.path,
                &record.project_name,
                &record.platform_session_key,
                &format_handoff_notification(&record, true, base_profile.language),
            )
        })();

        if let Err(start_error) = start_result {
            let mut rollback_errors = Vec::new();
            if let Err(err) = self.stop_inner() {
                rollback_errors.push(err);
            }
            if let Err(err) = record_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Err(err) = session_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Some(transfer) = token_transfer.as_ref() {
                if let Err(err) = transfer.target_snapshot.restore() {
                    rollback_errors.push(err);
                }
            }
            if let Err(err) = config_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Err(err) = self.start_inner() {
                rollback_errors.push(format!("restart original cc-connect failed: {err}"));
            }
            return if rollback_errors.is_empty() {
                Err(start_error)
            } else {
                Err(format!(
                    "{start_error}; rollback failed: {}",
                    rollback_errors.join("; ")
                ))
            };
        }

        self.append_system_log(format!(
            "remote handoff started for CLI session {}",
            record.cli_session_id
        ));
        self.handoff_status_with_warning(None)
    }

    fn handoff_cancel(&self) -> Result<CcConnectHandoffStatus, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "cc-connect operation lock poisoned".to_string())?;
        self.refresh_process_state();
        let Some(record) = load_handoff_record()? else {
            return self.handoff_status_with_warning(None);
        };
        let base_profile =
            load_profile()?.ok_or_else(|| "cc-connect profile is not configured".to_string())?;
        let session_path = validate_record_session_path(&record)?;
        let binary = self.detect(base_profile.executable_path.as_deref(), true)?;
        self.stop_inner()?;
        let snapshots = (|| {
            Ok((
                FileSnapshot::capture(session_path.clone(), "cc-connect handoff session")?,
                FileSnapshot::capture(handoff_path()?, "cc-connect handoff record")?,
                FileSnapshot::capture(config_path()?, "cc-connect config")?,
            ))
        })();
        let (session_snapshot, record_snapshot, config_snapshot) = match snapshots {
            Ok(snapshots) => snapshots,
            Err(snapshot_error) => {
                return match self.start_inner() {
                    Ok(()) => Err(snapshot_error),
                    Err(restart_error) => Err(format!(
                        "{snapshot_error}; restart handed-off cc-connect failed: {restart_error}"
                    )),
                };
            }
        };
        let ownership_result = (|| {
            if let Some(mut document) = read_existing_session_document(&session_path)? {
                if cleanup_handoff_session(
                    &mut document,
                    &record.platform_session_key,
                    &record.cc_session_id,
                    &record.cli_session_id,
                    record.previous_active_session_id.as_deref(),
                )? {
                    write_session_document(&session_path, &document)?;
                }
            }
            remove_handoff_record()
        })();

        if let Err(cancel_error) = ownership_result {
            let mut rollback_errors = Vec::new();
            if let Err(err) = session_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Err(err) = record_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Err(err) = config_snapshot.restore() {
                rollback_errors.push(err);
            }
            if let Err(err) = self.start_inner() {
                rollback_errors.push(format!("restart handed-off cc-connect failed: {err}"));
            }
            return if rollback_errors.is_empty() {
                Err(cancel_error)
            } else {
                Err(format!(
                    "{cancel_error}; rollback failed: {}",
                    rollback_errors.join("; ")
                ))
            };
        }

        let mut warnings = Vec::new();
        if let Err(err) = self.start_inner() {
            warnings.push(format!("restart original cc-connect failed: {err}"));
        } else if let Err(err) = send_handoff_notification(
            &binary.path,
            &base_profile.project_name,
            &record.platform_session_key,
            &format_handoff_notification(&record, false, base_profile.language),
        ) {
            warnings.push(err);
        }
        self.append_system_log(format!(
            "remote handoff cancelled for CLI session {}",
            record.cli_session_id
        ));
        self.handoff_status_with_warning((!warnings.is_empty()).then(|| warnings.join("; ")))
    }
}

#[tauri::command]
pub async fn cc_connect_handoff_status(
    manager: State<'_, CcConnectManager>,
) -> Result<CcConnectHandoffStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.handoff_status_with_warning(None))
        .await
        .map_err(|err| format!("cc-connect handoff status task failed: {err}"))?
}

#[tauri::command]
pub async fn cc_connect_handoff_platforms(
    manager: State<'_, CcConnectManager>,
) -> Result<Vec<CcConnectHandoffPlatformTarget>, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.handoff_platform_targets())
        .await
        .map_err(|err| format!("cc-connect handoff platform task failed: {err}"))?
}

#[tauri::command]
pub async fn cc_connect_handoff_start(
    manager: State<'_, CcConnectManager>,
    request: CcConnectHandoffStartRequest,
) -> Result<CcConnectHandoffStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.handoff_start(request))
        .await
        .map_err(|err| format!("cc-connect handoff start task failed: {err}"))?
}

#[tauri::command]
pub async fn cc_connect_handoff_cancel(
    manager: State<'_, CcConnectManager>,
) -> Result<CcConnectHandoffStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.handoff_cancel())
        .await
        .map_err(|err| format!("cc-connect handoff cancel task failed: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_handoff_identifiers() {
        assert_eq!(
            validate_handoff_identifier("abc-123_def", "session").unwrap(),
            "abc-123_def"
        );
        assert!(validate_handoff_identifier("../bad", "session").is_err());
        assert!(validate_handoff_identifier("has space", "session").is_err());
    }

    #[test]
    fn notification_contains_the_handoff_identity() {
        let record = PersistedHandoffRecord {
            schema_version: HANDOFF_SCHEMA_VERSION,
            local_session_id: "local-1".to_string(),
            cli_session_id: "thread-1".to_string(),
            project_id: "project-1".to_string(),
            project_name: "CLI-Manager".to_string(),
            worktree_id: None,
            worktree_name: None,
            work_dir: r"F:\repo".to_string(),
            provider_id: Some("provider-1".to_string()),
            provider_name: "Provider A".to_string(),
            provider_is_global: false,
            platform: CcConnectPlatform::Telegram,
            platform_session_key: "telegram:1:1".to_string(),
            cc_session_id: "s1".to_string(),
            session_file_path: r"F:\data\sessions\CLI-Manager_hash.json".to_string(),
            previous_active_session_id: None,
            source_project_id: "project-1".to_string(),
            source_project_name: "CLI-Manager".to_string(),
            source_project_path: r"F:\repo".to_string(),
            started_at_ms: 1,
        };
        let message = format_handoff_notification(&record, true, CcConnectLanguage::Zh);
        assert!(message.contains("thread-1"));
        assert!(message.contains(r"F:\repo"));
        assert!(message.contains("Provider A"));
        assert!(
            format_handoff_notification(&record, false, CcConnectLanguage::En)
                .contains("cancelled")
        );
    }
}
