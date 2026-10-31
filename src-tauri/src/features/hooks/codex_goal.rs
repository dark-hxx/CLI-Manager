use crate::ccswitch_db;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::runtime::Builder;
use tokio::time::timeout;

const GOAL_QUERY_TIMEOUT: Duration = Duration::from_millis(600);
const GOAL_DB_BUSY_TIMEOUT: Duration = Duration::from_millis(150);
const MAX_SESSION_ID_BYTES: usize = 256;
const MAX_GOAL_ID_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CodexGoalStatus {
    None,
    Active,
    Paused,
    Blocked,
    BudgetLimited,
    UsageLimited,
    Complete,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CodexGoalHookState {
    Running,
    Attention,
    Completed,
    Failed,
}

impl CodexGoalStatus {
    // 将内部状态转换为跨进程 Hook 载荷使用的固定字符串。
    pub(crate) const fn wire_name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Blocked => "blocked",
            Self::BudgetLimited => "budgetLimited",
            Self::UsageLimited => "usageLimited",
            Self::Complete => "complete",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CodexGoalMetadata {
    pub(crate) status: CodexGoalStatus,
    pub(crate) goal_id: Option<String>,
    pub(crate) diagnostic: Option<&'static str>,
}

impl CodexGoalMetadata {
    // 构造没有匹配 goal 行的明确结果，区别于数据库不可用的 unknown。
    pub(crate) fn none() -> Self {
        Self {
            status: CodexGoalStatus::None,
            goal_id: None,
            diagnostic: None,
        }
    }

    // 构造不允许进入完成分支的不确定结果。
    pub(crate) fn unknown(code: &'static str) -> Self {
        Self {
            status: CodexGoalStatus::Unknown,
            goal_id: None,
            diagnostic: Some(code),
        }
    }
}

#[derive(Clone, Debug)]
struct DatabaseCandidate {
    path: PathBuf,
    is_wsl: bool,
}

#[derive(Debug, Eq, PartialEq)]
enum CandidateResult {
    Missing,
    NoGoal,
    Goal(CodexGoalMetadata),
    Unsupported,
    Failed,
}

// 查询 Codex Stop 对应的 thread_goals，并将所有异常收敛为 unknown。
pub(crate) fn lookup_stop_goal(
    session_id: Option<&str>,
    wsl_distro_name: Option<&str>,
) -> CodexGoalMetadata {
    let Some(session_id) = valid_session_id(session_id) else {
        return CodexGoalMetadata::unknown("session_id_invalid");
    };
    let candidates = database_candidates(wsl_distro_name);
    if candidates.is_empty() {
        return CodexGoalMetadata::unknown("goal_db_path_unavailable");
    }

    let runtime = match Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(_) => return CodexGoalMetadata::unknown("goal_runtime_unavailable"),
    };
    let deadline = Instant::now() + GOAL_QUERY_TIMEOUT;
    runtime.block_on(async {
        for candidate in candidates {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return CodexGoalMetadata::unknown("goal_query_timeout");
            }
            match query_candidate(&candidate, &session_id, remaining).await {
                CandidateResult::Missing => continue,
                CandidateResult::NoGoal => return CodexGoalMetadata::none(),
                CandidateResult::Goal(metadata) => return metadata,
                CandidateResult::Unsupported | CandidateResult::Failed => {
                    return CodexGoalMetadata::unknown("goal_db_query_failed");
                }
            }
        }
        CodexGoalMetadata::unknown("goal_db_missing")
    })
}

// 判断接收端的可选状态字段是否属于当前协议，未知值不得被当作完成。
pub(crate) fn is_valid_wire_status(value: &str) -> bool {
    matches!(
        value,
        "none"
            | "active"
            | "paused"
            | "blocked"
            | "budgetLimited"
            | "usageLimited"
            | "complete"
            | "unknown"
    )
}

// 验证跨进程传递的 goal_id，只允许短的稳定标识字符集。
pub(crate) fn is_valid_wire_goal_id(value: &str) -> bool {
    valid_goal_id(value).is_some()
}

// 将远端或旧载荷的状态字段规范化；缺失值由消费端按来源决定其兼容策略。
pub(crate) fn parse_wire_status(value: Option<&str>) -> Option<CodexGoalStatus> {
    let value = value?.trim();
    if is_valid_wire_status(value) {
        return Some(match value {
            "none" => CodexGoalStatus::None,
            "active" => CodexGoalStatus::Active,
            "paused" => CodexGoalStatus::Paused,
            "blocked" => CodexGoalStatus::Blocked,
            "budgetLimited" => CodexGoalStatus::BudgetLimited,
            "usageLimited" => CodexGoalStatus::UsageLimited,
            "complete" => CodexGoalStatus::Complete,
            "unknown" => CodexGoalStatus::Unknown,
            _ => unreachable!(),
        });
    }

    let compact = value
        .chars()
        .filter(|character| *character != '_' && *character != '-')
        .collect::<String>()
        .to_ascii_lowercase();
    match compact.as_str() {
        "none" => Some(CodexGoalStatus::None),
        "active" => Some(CodexGoalStatus::Active),
        "paused" => Some(CodexGoalStatus::Paused),
        "blocked" => Some(CodexGoalStatus::Blocked),
        "budgetlimited" => Some(CodexGoalStatus::BudgetLimited),
        "usagelimited" => Some(CodexGoalStatus::UsageLimited),
        "complete" => Some(CodexGoalStatus::Complete),
        "unknown" => Some(CodexGoalStatus::Unknown),
        _ => None,
    }
}

// 将 Codex Stop 的 goal 状态收敛为各消费端共用的运行、关注、完成或失败状态。
// 缺失及未知状态必须保持运行态，不能把不确定结果当成完成。
pub(crate) fn classify_codex_stop(value: Option<&str>) -> CodexGoalHookState {
    match parse_wire_status(value) {
        Some(CodexGoalStatus::None | CodexGoalStatus::Complete) => CodexGoalHookState::Completed,
        Some(CodexGoalStatus::Paused | CodexGoalStatus::Blocked) => {
            CodexGoalHookState::Attention
        }
        Some(CodexGoalStatus::BudgetLimited | CodexGoalStatus::UsageLimited) => {
            CodexGoalHookState::Failed
        }
        Some(CodexGoalStatus::Active | CodexGoalStatus::Unknown) | None => {
            CodexGoalHookState::Running
        }
    }
}

// 判断同一 goal 的 Stop 事件是否已经进入不可逆的完成或失败终态。
pub(crate) fn codex_goal_status_is_terminal(value: Option<&str>) -> bool {
    matches!(
        parse_wire_status(value),
        Some(
            CodexGoalStatus::Complete
                | CodexGoalStatus::BudgetLimited
                | CodexGoalStatus::UsageLimited
        )
    )
}

// 只接受短的无控制字符 session ID，避免把任意 stdin 文本送入数据库查询。
fn valid_session_id(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty()
        || value.len() > MAX_SESSION_ID_BYTES
        || value.chars().any(char::is_control)
    {
        return None;
    }
    Some(value.to_string())
}

// 组合数据库候选，当前 goals 库优先于旧 state 库，并保留 WSL 运行身份。
fn database_candidates(wsl_distro_name: Option<&str>) -> Vec<DatabaseCandidate> {
    let mut roots = Vec::new();
    if let Some(root) = non_empty_env("CODEX_SQLITE_HOME") {
        roots.push(PathBuf::from(root));
    }

    let codex_home = resolve_codex_home();
    if let Some(home) = codex_home.as_ref() {
        if let Some(sqlite_home) = configured_sqlite_home(home, wsl_distro_name) {
            roots.push(sqlite_home);
        }
    }
    if let Some(home) = codex_home {
        roots.push(home);
    }

    let mut candidates = Vec::new();
    for root in roots {
        for relative in [
            Path::new("sqlite").join("goals_1.sqlite"),
            Path::new("goals_1.sqlite").to_path_buf(),
            Path::new("sqlite").join("state_5.sqlite"),
            Path::new("state_5.sqlite").to_path_buf(),
        ] {
            let path = root.join(relative);
            let is_wsl = crate::wsl::is_wsl_config_dir(&path.to_string_lossy())
                || (wsl_distro_name.is_some() && is_linux_absolute(&path));
            let path = if is_wsl && !crate::wsl::is_wsl_config_dir(&path.to_string_lossy()) {
                let Some(distro) = wsl_distro_name.filter(|value| !value.trim().is_empty()) else {
                    continue;
                };
                PathBuf::from(crate::wsl::linux_to_unc_wsl_path(
                    &path.to_string_lossy(),
                    distro,
                ))
            } else {
                path
            };
            push_unique_candidate(&mut candidates, path, is_wsl);
        }
    }
    candidates
}

// 读取 CODEX_HOME、Provider Home 或用户默认目录，不创建目录或启动 CLI。
fn resolve_codex_home() -> Option<PathBuf> {
    non_empty_env("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| crate::provider::home::default_config_root("codex"))
        .or_else(|| {
            crate::app_paths::home_dir_from_env()
                .ok()
                .map(|home| home.join(".codex"))
        })
}

// 解析 Codex 配置中的顶层 sqlite_home，表内同名字段不参与路径推断。
fn configured_sqlite_home(root: &Path, wsl_distro_name: Option<&str>) -> Option<PathBuf> {
    let raw = fs::read_to_string(root.join("config.toml")).ok()?;
    let value = raw
        .lines()
        .take_while(|line| !line.trim_start().starts_with('['))
        .find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == "sqlite_home").then(|| parse_toml_string(value.trim()))?
        })?;
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
        let base = root.parent().map(Path::to_path_buf).or_else(|| {
            crate::app_paths::home_dir_from_env().ok()
        })?;
        return Some(base.join(value.trim_start_matches('~').trim_start_matches(['/', '\\'])));
    }
    if is_linux_absolute_text(value) && wsl_distro_name.is_some() {
        return Some(PathBuf::from(value));
    }
    let candidate = PathBuf::from(value);
    Some(if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    })
}

// 解析双引号或单引号 TOML 字符串；路径值异常时返回 None。
fn parse_toml_string(value: &str) -> Option<String> {
    let value = value.split('#').next()?.trim();
    if value.len() < 2 {
        return None;
    }
    let quote = value.as_bytes()[0];
    if !matches!(quote, b'"' | b'\'') || value.as_bytes().last().copied() != Some(quote) {
        return None;
    }
    Some(value[1..value.len() - 1].to_string())
}

// 判断路径是否为 Linux 绝对路径；Windows 主机的 Path API 不适合作为该判断依据。
fn is_linux_absolute(path: &Path) -> bool {
    is_linux_absolute_text(&path.to_string_lossy())
}

fn is_linux_absolute_text(path: &str) -> bool {
    path.starts_with('/') && !path.starts_with("//")
}

// 按规范化文本去重候选，不对用户数据库执行 canonicalize 或写入操作。
fn push_unique_candidate(candidates: &mut Vec<DatabaseCandidate>, path: PathBuf, is_wsl: bool) {
    let key = path.to_string_lossy().to_ascii_lowercase();
    if candidates
        .iter()
        .any(|candidate| candidate.path.to_string_lossy().to_ascii_lowercase() == key)
    {
        return;
    }
    candidates.push(DatabaseCandidate { path, is_wsl });
}

// 读取单个候选数据库；文件不存在可继续尝试低优先级布局，schema/IO 异常则停止猜测。
async fn query_candidate(
    candidate: &DatabaseCandidate,
    session_id: &str,
    query_timeout: Duration,
) -> CandidateResult {
    let result = timeout(
        query_timeout,
        query_candidate_inner(candidate, session_id, query_timeout),
    )
    .await;
    match result {
        Ok(result) => result,
        Err(_) => CandidateResult::Failed,
    }
}

// 准备本机或 WSL 快照后执行一次参数化查询，并在连接释放后清理快照。
async fn query_candidate_inner(
    candidate: &DatabaseCandidate,
    session_id: &str,
    query_timeout: Duration,
) -> CandidateResult {
    if !candidate.is_wsl && !candidate.path.is_file() {
        return CandidateResult::Missing;
    }
    let prepared = match ccswitch_db::prepare_read_path_with_timeout(
        &candidate.path,
        query_timeout,
    )
    .await
    {
        Ok(prepared) => prepared,
        Err(error) if error == "wsl_sqlite_not_found" => return CandidateResult::Missing,
        Err(_) => return CandidateResult::Failed,
    };
    let options = SqliteConnectOptions::new()
        .filename(prepared.path())
        .read_only(true)
        .create_if_missing(false)
        .busy_timeout(GOAL_DB_BUSY_TIMEOUT);
    let mut connection = match SqliteConnection::connect_with(&options).await {
        Ok(connection) => connection,
        Err(_) => return CandidateResult::Failed,
    };
    let row = match sqlx::query(
        "SELECT goal_id, status FROM thread_goals WHERE thread_id = ?1 LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(&mut connection)
    .await
    {
        Ok(row) => row,
        Err(error) if is_missing_goal_table(&error) => return CandidateResult::Unsupported,
        Err(_) => return CandidateResult::Failed,
    };
    let Some(row) = row else {
        return CandidateResult::NoGoal;
    };
    let status = match row.try_get::<String, _>("status") {
        Ok(status) => status,
        Err(_) => return CandidateResult::Failed,
    };
    let Some(status) = parse_db_status(&status) else {
        return CandidateResult::Failed;
    };
    let goal_id = match row.try_get::<Option<String>, _>("goal_id") {
        Ok(goal_id) => match goal_id {
            Some(goal_id) => match valid_goal_id(&goal_id) {
                Some(goal_id) => Some(goal_id),
                None => return CandidateResult::Failed,
            },
            None => None,
        },
        Err(_) => return CandidateResult::Failed,
    };
    CandidateResult::Goal(CodexGoalMetadata {
        status,
        goal_id,
        diagnostic: None,
    })
}

// 识别缺少 thread_goals 表的兼容数据库，不把它误判为“没有 goal”。
fn is_missing_goal_table(error: &sqlx::Error) -> bool {
    error
        .to_string()
        .to_ascii_lowercase()
        .contains("no such table")
}

// 将 Codex 数据库的 snake_case/camelCase 状态映射为稳定内部状态。
fn parse_db_status(value: &str) -> Option<CodexGoalStatus> {
    parse_wire_status(Some(value))
}

// goal_id 只保留可安全跨进程传递的短标识，异常字段让整个查询结果失效。
fn valid_goal_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_GOAL_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return None;
    }
    Some(value.to_string())
}

// 仅读取非空环境变量，避免把空配置根当作有效候选。
fn non_empty_env(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Executor;

    #[test]
    // 验证 Codex 数据库状态和 Hook 载荷状态都能规范化，未知值不进入完成状态。
    fn parses_supported_goal_statuses() {
        assert_eq!(
            parse_wire_status(Some("usage_limited")),
            Some(CodexGoalStatus::UsageLimited)
        );
        assert_eq!(
            parse_wire_status(Some("budgetLimited")),
            Some(CodexGoalStatus::BudgetLimited)
        );
        assert_eq!(parse_wire_status(Some("finished")), None);
        assert!(!is_valid_wire_status("finished"));
        assert_eq!(
            classify_codex_stop(Some("active")),
            CodexGoalHookState::Running
        );
        assert_eq!(
            classify_codex_stop(Some("complete")),
            CodexGoalHookState::Completed
        );
        assert_eq!(
            classify_codex_stop(Some("blocked")),
            CodexGoalHookState::Attention
        );
        assert_eq!(classify_codex_stop(None), CodexGoalHookState::Running);
    }

    #[test]
    // 验证 session/goal 标识的控制字符和长度边界不会进入数据库或载荷。
    fn rejects_invalid_identifiers() {
        assert!(valid_session_id(Some("thread-1")).is_some());
        assert!(valid_session_id(Some("thread\n1")).is_none());
        assert!(valid_goal_id("goal.1_ok-2").is_some());
        assert!(valid_goal_id("goal/1").is_none());
    }

    #[test]
    // 验证配置中的 sqlite_home 只读取顶层简单字符串，并按 Codex 根目录解析相对路径。
    fn resolves_configured_sqlite_home() {
        let root = PathBuf::from(r"C:\Users\me\.codex");
        let config = "sqlite_home = \"sqlite-data\"\n[features]\nhooks = true\n";
        let value = config
            .lines()
            .take_while(|line| !line.trim_start().starts_with('['))
            .find_map(|line| {
                let (key, value) = line.split_once('=')?;
                (key.trim() == "sqlite_home").then(|| parse_toml_string(value.trim()))?
            })
            .unwrap();
        assert_eq!(root.join(value), PathBuf::from(r"C:\Users\me\.codex\sqlite-data"));
    }

    #[tokio::test]
    // 验证只读查询能区分无 goal 行、有效 goal 状态和缺表数据库。
    async fn queries_goal_rows_without_writing() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("goals_1.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        connection
            .execute(
                "CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, goal_id TEXT, status TEXT)",
            )
            .await
            .unwrap();
        sqlx::query("INSERT INTO thread_goals (thread_id, goal_id, status) VALUES (?1, ?2, ?3)")
            .bind("thread-1")
            .bind("goal-1")
            .bind("active")
            .execute(&mut connection)
            .await
            .unwrap();
        drop(connection);

        let candidate = DatabaseCandidate {
            path,
            is_wsl: false,
        };
        assert_eq!(
            query_candidate(&candidate, "missing", GOAL_QUERY_TIMEOUT).await,
            CandidateResult::NoGoal
        );
        assert_eq!(
            query_candidate(&candidate, "thread-1", GOAL_QUERY_TIMEOUT).await,
            CandidateResult::Goal(CodexGoalMetadata {
                status: CodexGoalStatus::Active,
                goal_id: Some("goal-1".to_string()),
                diagnostic: None,
            })
        );
    }
}
