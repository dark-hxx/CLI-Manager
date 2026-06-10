# 会话历史项目筛选与 Tab 切换保持

## 背景

会话历史页已经支持按来源过滤，并且后端/前端 store 已具备按 `projectPath` 过滤历史会话的能力。现在需要在页面左上角暴露项目筛选，让用户可以手动切换项目范围；同时从某个终端 Tab 打开历史页时，应默认回显该 Tab 所属项目。

补充约束：如果“会话历史”Tab 已经打开，从其它终端 Tab 切换回历史 Tab 时，不应再次查询，也不应把筛选切换到当前终端项目；应保持历史页当前内容不变。

## 需求

1. 历史页面左上角新增“项目筛选”下拉框。
2. 下拉框包含：
   - `全部项目`
   - 当前项目列表中的每个项目，显示项目名，值使用项目路径。
3. 从终端 Tab 点击工具栏“会话历史”进入时：
   - 如果该终端有项目，项目筛选默认回显该项目。
   - 会话列表按该项目过滤。
   - 来源筛选继续按项目配置的 CLI 工具默认推导。
4. 用户手动选择项目后：
   - 更新项目筛选。
   - 重新加载历史会话。
   - 全局搜索结果也按新项目范围刷新。
5. 用户选择“全部项目”后：
   - 清空项目筛选。
   - 重新加载全部项目历史。
6. 已打开“会话历史”Tab 后，普通 Tab 切换回历史 Tab：
   - 不调用 `openHistory()`。
   - 不重新查询。
   - 不改变来源筛选和项目筛选。
   - 保持当前列表、搜索、详情内容。

## 实现范围

- `src/stores/historyStore.ts`
  - 新增 `setProjectPathFilter(projectPath: string | null)`。
  - 复用现有 `projectPathFilter`，不新增重复状态。

- `src/components/HistoryWorkspace.tsx`
  - 读取 `projectPathFilter`、`setProjectPathFilter`。
  - 读取 `useProjectStore().projects`。
  - 将项目筛选 props 传给 `HistoryListPane`。
  - 将 `projectPathFilter` 加入全局搜索和分页重置 effect 依赖。

- `src/components/history/HistoryListPane.tsx`
  - 在来源 Select 旁新增项目 Select。
  - 使用 `projectPathFilter ?? ""` 作为 value。
  - 空字符串映射为 `null`。

- `src/components/TerminalTabs.tsx`
  - 拆分主动打开历史页与激活已存在历史 Tab。
  - 工具栏“会话历史”按钮继续按当前终端项目调用 `openHistory({ sourceFilter, projectPath })`。
  - 历史 Tab 自身点击、Tab 列表选择历史 Tab 时只激活，不重新查询。

## 非目标

- 不修改 Rust 后端过滤逻辑。
- 不新增后端命令。
- 不新增筛选持久化。
- 不新增项目搜索输入。
- 不抽象新的通用筛选组件。

## 验收标准

1. `npx tsc --noEmit` 通过。
2. `cargo check --manifest-path src-tauri/Cargo.toml` 通过。
3. 从项目终端 Tab 点击“会话历史”后，项目筛选回显该项目。
4. 手动切换项目筛选后，列表重新加载并按项目过滤。
5. 切回“全部项目”后，列表恢复全项目。
6. 历史 Tab 已打开时，从其它终端 Tab 切回历史 Tab，不重新查询、不改变当前筛选和内容。
