use super::{
    compute_diff_line_stats, compute_wsl_diff_line_stats, is_nested_repo_entry,
    is_not_git_repository_error, normalize_path, open_git_repo, parse_git2_status,
    parse_wsl_git_status, run_wsl_git, should_skip_diff_line_stats, GitFileChange,
    NOT_GIT_REPOSITORY_CODE,
};
use git2::StatusOptions;
use std::path::Path;

pub(super) fn git_get_changes_native(
    project_path: &str,
    started_at: std::time::Instant,
) -> Result<Vec<GitFileChange>, String> {
    let path = Path::new(project_path);

    if !path.exists() {
        let err_msg = format!("路径不存在: {}", project_path);
        log::error!("[git_get_changes] {}", err_msg);
        return Err(err_msg);
    }

    log::debug!("[git_get_changes] 路径存在，尝试打开 Git 仓库");

    let repo = open_git_repo(path).map_err(|e| {
        // 目录不是 Git 仓库是正常场景（用户打开普通目录），返回稳定错误码让前端渲染友好空态；
        // 所有权/权限等真实故障继续暴露原始错误，避免被当成「不是仓库」而丢掉排查线索。
        if is_not_git_repository_error(&e) {
            log::debug!(
                "[git_get_changes] 目录不是 Git 仓库: project_path={}",
                project_path
            );
            return NOT_GIT_REPOSITORY_CODE.to_string();
        }
        let err_msg = format!("Git 仓库无法访问: {}", e);
        log::error!("[git_get_changes] {}", err_msg);
        err_msg
    })?;

    log::debug!("[git_get_changes] Git 仓库打开成功");

    let mut opts = StatusOptions::new();
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);

    let status_started_at = std::time::Instant::now();
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| {
        let err_msg = format!("获取 Git 状态失败: {}", e);
        log::error!("[git_get_changes] {}", err_msg);
        err_msg
    })?;

    log::debug!(
        "[git_get_changes] 获取到 {} 个状态条目 status_elapsed_ms={}",
        statuses.len(),
        status_started_at.elapsed().as_millis()
    );

    let skipped_line_stats = should_skip_diff_line_stats(statuses.len());
    let stats = if skipped_line_stats {
        log::warn!(
            "[git_get_changes] 状态条目过多({}), 跳过行数统计以避免面板长时间 loading",
            statuses.len()
        );
        std::collections::HashMap::new()
    } else {
        compute_diff_line_stats(&repo)
    };

    let mut changes = Vec::new();

    for entry in statuses.iter() {
        let status = entry.status();
        let file_path = entry.path().unwrap_or("").to_string();

        if file_path.is_empty() {
            continue;
        }

        if is_nested_repo_entry(&repo, &file_path) {
            continue;
        }

        let (status_char, staged) = parse_git2_status(status);
        let (added, deleted) = stats
            .get(&normalize_path(&file_path))
            .copied()
            .unwrap_or((0, 0));

        changes.push(GitFileChange {
            path: file_path,
            status: status_char.to_string(),
            staged,
            added,
            deleted,
        });
    }

    log::debug!(
        "[git_get_changes] 查询完成，返回 {} 个变更文件 line_stats={} elapsed_ms={}",
        changes.len(),
        if skipped_line_stats {
            "skipped"
        } else {
            "computed"
        },
        started_at.elapsed().as_millis()
    );

    Ok(changes)
}

pub(super) fn git_get_changes_wsl(
    project_path: &str,
    distro: &str,
    linux_path: &str,
    started_at: std::time::Instant,
) -> Result<Vec<GitFileChange>, String> {
    log::debug!(
        "[git_get_changes:wsl] 检测到 WSL UNC 路径, 使用 wsl.exe git 热路径: project_path={} distro={} linux_path={}",
        project_path,
        distro,
        linux_path
    );

    let status_started_at = std::time::Instant::now();
    let status_stdout = run_wsl_git(
        distro,
        linux_path,
        &["status", "--porcelain=v1", "-z", "-unormal"],
    )
    .map_err(|e| {
        if e == "not_git_repository" {
            log::debug!("[git_get_changes:wsl] 非 Git 仓库: project_path={project_path}");
            return e;
        }
        let err_msg = format!("获取 WSL Git 状态失败: {e}");
        log::error!("[git_get_changes:wsl] {}", err_msg);
        err_msg
    })?;
    let mut changes = parse_wsl_git_status(&status_stdout);

    // 过滤嵌套子仓库目录条目（与 libgit2 链路 is_nested_repo_entry 语义一致）：
    // 尾部 '/' 且 <UNC根>/<路径>/.git 存在（目录或 gitlink 文件均命中）→ 跳过。
    // fs 检查经 UNC 路径进行，保持 parse_wsl_git_status 为纯函数（见 issue #85）。
    let unc_root = Path::new(project_path);
    changes.retain(|change| {
        !change.path.ends_with('/') || !unc_root.join(&change.path).join(".git").exists()
    });

    log::debug!(
        "[git_get_changes:wsl] 获取到 {} 个状态条目 status_elapsed_ms={}",
        changes.len(),
        status_started_at.elapsed().as_millis()
    );

    let skipped_line_stats = should_skip_diff_line_stats(changes.len());
    let stats = if skipped_line_stats {
        log::warn!(
            "[git_get_changes:wsl] 状态条目过多({}), 跳过行数统计以避免面板长时间 loading",
            changes.len()
        );
        std::collections::HashMap::new()
    } else {
        match compute_wsl_diff_line_stats(distro, linux_path) {
            Ok(stats) => stats,
            Err(e) => {
                log::warn!("[git_get_changes:wsl] diff 行数统计降级为 0: {e}");
                std::collections::HashMap::new()
            }
        }
    };

    for change in &mut changes {
        if let Some((added, deleted)) = stats.get(&normalize_path(&change.path)).copied() {
            change.added = added;
            change.deleted = deleted;
        }
    }

    log::debug!(
        "[git_get_changes:wsl] 查询完成，返回 {} 个变更文件 line_stats={} elapsed_ms={}",
        changes.len(),
        if skipped_line_stats {
            "skipped"
        } else {
            "computed"
        },
        started_at.elapsed().as_millis()
    );
    Ok(changes)
}
