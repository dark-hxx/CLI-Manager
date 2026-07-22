# Technical Design

## Boundaries

- 删除 `src/lib/syncedHistoryContext.ts`，消除上下文拼装、文件写入和启动参数注入能力。
- `src/components/sidebar/index.tsx` 的项目分屏与外部终端启动直接使用项目原始启动命令。
- `src/stores/terminalStore.ts` 的同步历史终端直接启动对应 CLI，不再生成隐式上下文。
- `src/stores/externalSessionSyncStore.ts` 不再把已存在且已被用户移到根级的项目重新包装为同名分组。
- 同一 Store 在 `syncProjectCandidates` 成功后，将选中的项目 key 写入既有 `ignoredProjectKeys`；加载旧同步状态时从 `syncedSessions` 补齐历史项目 key，不新增存储结构或历史文件扫描。
- `mergeFontFamilyOptions` 接受可选的值规范化函数；通用界面字体保持现有 CSS 栈规范化，终端字体传入 `normalizeTerminalFontFamily`，确保当前值与所有候选值使用同一标准。
- 系统字体族名在拼接 fallback 前先作为单个 CSS 字体族序列化，避免名称中的逗号被误拆成多个字体。
- `syncProjectCandidates` 以 Zustand 中同步更新的 `syncingProjects` 作为业务入口锁；按钮禁用只负责交互反馈，不能代替 Store 重入保护。

## Compatibility

- 历史扫描、历史列表、项目同步元数据以及显式 resume 不依赖上下文注入文件，继续保留。
- 首次同步缺失项目仍走现有创建分组/项目分支。
- 已生成文件保持原样；升级后不读取、不更新、不删除。
- 已同步项目的忽略状态复用现有 `ignoredProjectKeys` 持久化字段。

## Trade-off

新建干净会话不再自动获得旧会话背景。这是明确接受的行为变化，用于换取可预测的启动命令、用户控制和更少的隐式数据注入。

字体选项合并保持一个共享函数，不增加字体别名表或单字体特判。
