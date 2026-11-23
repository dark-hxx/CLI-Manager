use super::HistorySessionSummary;
use std::future::Future;

// 先读取已索引的精确绑定会话，避免预览/回放/统计被无关的全库刷新阻塞。
// 标脏后的读取仍先刷新；文本搜索及未命中的绑定查询保留同请求内的刷新可见性。
// 刷新错误由原目录/旧扫描读取路径处理，与既有命令的 best-effort 刷新语义一致。
pub(super) async fn list_sessions_with_query_refresh<L, LF, R, RF>(
    dirty: bool,
    query: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    mut load: L,
    mut refresh: R,
) -> Result<Vec<HistorySessionSummary>, String>
where
    L: FnMut() -> LF,
    LF: Future<Output = Result<Vec<HistorySessionSummary>, String>>,
    R: FnMut() -> RF,
    RF: Future,
{
    if dirty {
        let _ = refresh().await;
        return load().await;
    }

    let sessions = load().await;
    let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) else {
        return sessions;
    };
    let exact_match = limit == Some(1)
        && offset.unwrap_or(0) == 0
        && sessions
            .as_ref()
            .is_ok_and(|items| items.len() == 1 && items[0].session_id == query);
    if exact_match {
        return sessions;
    }

    let _ = refresh().await;
    load().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::future::{pending, ready};
    use std::time::Duration;

    // 只构造查询策略所需摘要，不读取用户目录或启动 Tauri。
    fn summary(session_id: &str) -> HistorySessionSummary {
        HistorySessionSummary {
            file_size: None,
            session_id: session_id.to_string(),
            parent_session_id: None,
            source: "codex".to_string(),
            project_key: "project".to_string(),
            title: "Answer".to_string(),
            file_path: "session.jsonl".to_string(),
            cwd: None,
            created_at: 0,
            updated_at: 0,
            message_count: 1,
            branch: None,
        }
    }

    #[tokio::test]
    async fn indexed_bound_session_does_not_wait_for_global_refresh() {
        // 全局刷新永远不完成时，已索引会话仍必须返回，覆盖截图中的阻塞条件。
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            list_sessions_with_query_refresh(
                false,
                Some(" bound-session "),
                Some(1),
                None,
                || ready(Ok(vec![summary("bound-session")])),
                pending::<()>,
            ),
        )
        .await
        .expect("an indexed bound session must not wait for the refresh")
        .unwrap();
        assert_eq!(result[0].session_id, "bound-session");
    }

    #[tokio::test]
    async fn missing_or_wrong_session_is_reloaded_after_refresh() {
        for first in [None, Some("other-session")] {
            let refreshed = Cell::new(false);
            let reads = Cell::new(0);
            let result = list_sessions_with_query_refresh(
                false,
                Some("bound-session"),
                Some(1),
                Some(0),
                || {
                    reads.set(reads.get() + 1);
                    let id = if refreshed.get() {
                        Some("bound-session")
                    } else {
                        first
                    };
                    ready(Ok(id.map(summary).into_iter().collect()))
                },
                || {
                    refreshed.set(true);
                    ready(())
                },
            )
            .await
            .unwrap();
            assert!(refreshed.get());
            assert_eq!(reads.get(), 2);
            assert_eq!(result[0].session_id, "bound-session");
        }
    }

    #[tokio::test]
    async fn text_search_and_pagination_still_observe_refreshed_titles() {
        for (query, limit, offset) in [
            ("new thread name", Some(1), Some(0)),
            ("bound-session", Some(20), Some(0)),
            ("bound-session", Some(1), Some(1)),
        ] {
            let refreshed = Cell::new(false);
            let result = list_sessions_with_query_refresh(
                false,
                Some(query),
                limit,
                offset,
                || {
                    let mut item = summary("bound-session");
                    item.title = if refreshed.get() {
                        "new thread name"
                    } else {
                        "old name"
                    }
                    .into();
                    ready(Ok(vec![item]))
                },
                || {
                    refreshed.set(true);
                    ready(())
                },
            )
            .await
            .unwrap();
            assert_eq!(result[0].title, "new thread name");
        }
    }

    #[tokio::test]
    async fn dirty_catalog_is_refreshed_before_any_read() {
        let refreshed = Cell::new(false);
        let result = list_sessions_with_query_refresh(
            true,
            Some("bound-session"),
            Some(1),
            None,
            || {
                assert!(
                    refreshed.get(),
                    "deleted or edited sessions must not leak stale data"
                );
                ready(Ok(Vec::new()))
            },
            || {
                refreshed.set(true);
                ready(())
            },
        )
        .await
        .unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn ordinary_listing_returns_without_waiting_and_errors_remain_visible() {
        for query in [None, Some("  ")] {
            let result = list_sessions_with_query_refresh(
                false,
                query,
                Some(20),
                Some(0),
                || ready(Err("catalog unavailable".to_string())),
                || -> std::future::Ready<()> {
                    panic!("ordinary listing must not wait for a query refresh")
                },
            );
            // 显式 Future 类型让此断言同时覆盖原命令的旧扫描回退错误边界。
            let result: Result<Vec<HistorySessionSummary>, String> = result.await;
            assert_eq!(result.err().as_deref(), Some("catalog unavailable"));
        }
    }
}
