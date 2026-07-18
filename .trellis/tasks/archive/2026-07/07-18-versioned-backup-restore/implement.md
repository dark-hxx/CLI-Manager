# Implementation Plan

1. 刷新 GitNexus 并对同步 store、WebDAV client、同步 commands、退出自动同步和设置页执行 upstream impact。
2. 增加 V3 数据类型、设置穷尽分类、旧快照转换与内容哈希。
3. 扩展 WebDAV PROPFIND/DELETE，实现历史列表、上传、下载、保留 10 份与本地 ZIP。
4. 改造前端 store：采集、outbox、启动重试、退出备份、预览、按域恢复和 safety rollback。
5. 改造同步设置页和状态指示器，删除自动下载/冲突交互，补齐中英文文案。
6. 更新同步/状态栏契约、功能清单和 `[TEMP]` CHANGELOG。
7. 执行 TypeScript、Rust check/test 和 GitNexus detect_changes，修复回归。
