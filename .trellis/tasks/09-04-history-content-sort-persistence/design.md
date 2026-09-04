# 技术设计：会话历史内容排序与标题解析

## 1. 设计边界与不变量

本需求拆成两个相互衔接但保持独立的能力：

1. 历史详情六个顺序型页签的正序/倒序视图投影和偏好记忆。
2. Codex 会话名称候选的补充，以及已有标题优先级的统一落实。

排序只作用于前端展示投影，不修改原始消息数组、历史文件、搜索索引、编辑坐标或后端返回结构。后端仍以原始消息索引和既有时间/结构字段作为唯一事实来源。现有 IPC 返回的 title 字段继续复用，不增加 IPC 命令、响应字段或数据库列。

## 2. 前端排序模型

### 2.1 共享类型和设置

在 lib 层新增共享的排序类型和工具，避免设置 store 依赖组件类型：

- HistoryDetailSortDirection：ascending 或 descending。
- HistorySortableDetailView：conversation、transcript、timeline、changes、tools、subtasks。
- HistoryDetailSortDirections：六个页签到方向的完整映射。
- 默认值为六个页签全部 ascending。
- 提供页签是否可排序、方向反转和默认映射校验函数。

Settings 新增 historyDetailSortDirections。加载设置时只接受已知页签和两个合法方向；缺少字段、未知字段或非法值逐项回退到默认值，兼容旧版本设置。

排序写入使用 settings store 的专用 action，而不是改变通用 update 的失败语义：

1. 先更新 Zustand 内存值，使当前页签立即切换。
2. 将快照按调用顺序串行写入 tauri-plugin-store。
3. 写入失败时保留当前内存值、不回滚、不弹 toast，只记录调试日志；后续写入仍可继续。
4. 下次启动由持久化层读取最近一次成功值。这样一次失败不会覆盖上一次成功保存的配置，也不会因为异步写入乱序而恢复到旧方向。

当前 detailView 仍保持组件本地状态；历史工作区重新打开或切换会话时继续进入 conversation。只持久化六个页签的方向，符合“记住用户操作”的本次范围。

### 2.2 消息展示条目

对话和原文不能直接把反转后的数组当作新的消息源。HistoryWorkspace 将当前可见内容投影为带坐标的条目：

    { message: HistoryMessage, messageIndex: number }

ascending：

- 从原始数组头部取当前窗口；
- 可见条目顺序为 0、1、2……。

descending：

- 从原始数组尾部取当前窗口；
- 可见条目顺序为 total-1、total-2、……；
- 扩大窗口时向更早的原始索引扩展，并追加到视觉列表末端。

所有虚拟列表 key、DOM ref、搜索命中、编辑/插入/删除、批量选择、跨页跳转均使用 messageIndex，而不是当前窗口下标。这样倒序只是显示顺序变化，不会改变操作目标。

不使用 CSS column-reverse。这样可以保留现有虚拟滚动的测量和键盘/滚轮语义。切换方向时重置可见窗口和滚动位置；如果有搜索或跳转目标，先按原始索引扩大窗口并定位目标，否则定位到当前方向的第一条。

搜索仍在完整原始消息数组上执行；命中集合保持原始索引，上一条/下一条的导航顺序按当前显示方向排列命中索引。筛选先于排序，任何方向切换都不清除选择、搜索条件或视图职责。

### 2.3 结构化视图

SessionProcessModel 和历史结构化数组继续以 ascending/raw 形式缓存，不在数据层原地 reverse。各视图在 render/useMemo 边界创建副本：

- timeline：先按现有规则得到事件列表，再按方向反转事件列表。
- changes：反转变更记录节点；节点内部的文件名排序、目录层级和 operation 分组保持原规则。
- tools：反转调用、错误线索和疑似事件的显示顺序；错误/调用统计计数与摘要不反转。保留现有的展示条数上限，但 descending 优先取最新一段再反转，避免最新记录被截在不可见部分。
- subtasks：反转子任务记录；主会话 root 固定在树的根位置，树节点内部的非时间层级关系不重排。
- canvas、context：不传入排序状态，也不显示排序控件。

所有视图均先完成已有过滤，再做方向投影；相同时间戳或缺少时间戳时使用现有原始消息索引/稳定数组位置作为 tie-breaker，保证重复刷新结果稳定。

### 2.4 控件和国际化

SessionDetailPane 在页签栏旁只渲染当前可排序页签的一个 toggle button。按钮显示当前方向，使用原生 button，提供双语 tooltip、aria-label、aria-pressed 和键盘操作；切换页签时读取对应映射。

新增 key 放入 src/lib/i18n.ts，至少覆盖 zh-CN 与 en-US，并按项目现有机制让 zh-TW 继承或覆写。不得硬编码按钮、状态或辅助文案。时间渲染继续沿用既有 locale 配置，不引入英文 12 小时制。

## 3. Codex thread_name 标题链路

### 3.1 统一候选优先级

前端保持一个解析入口，候选顺序固定为：

    手工 alias
      > 有效的 AI 生成标题
      > Codex session_index.jsonl.thread_name
      > 现有来源标题/首条用户消息
      > 会话 ID

后端把匹配到的 thread_name 写入现有 title 来源值。这样历史列表、详情标题和搜索结果继续共用现有 title 字段和前端标题解析链；AI 标题成功或清除、alias 修改后立即重算当前内存视图。没有有效 AI 标题时，thread_name 才会自然显示。

“有效”至少要求 trim 后非空；空白、解析失败、ID 不匹配和跨来源误匹配均视为不可用。

### 3.2 本地、WSL 和 SSH

增加按来源实例隔离的 CodexThreadNameIndex：

- Windows 本地：从对应 Codex config root/session_index.jsonl 读取。
- WSL：使用已有 WSL 命令/路径解析能力在对应 distro 和 config root 内读取，不把 Linux UNC 文件当作普通 Windows 文件静默处理。
- SSH：由远端 ssh-agent 在对应远程 config root 内读取，并随远程历史摘要返回。

JSONL 逐行解析，只提取 id 和 thread_name；同一范围内重复 id 采用最后一条有效非空名称，符合索引追加更新的使用方式。索引不存在、超出安全读取上限、单行损坏或整体读取失败时跳过异常内容并继续加载历史。

索引 key 必须绑定已有来源实例和会话范围：本地路径、WSL distro/路径、SSH 连接身份/远端路径等纳入匹配边界。任何 lookup 都使用 source identity + session id，禁止仅凭裸 session id 合并本地、WSL、SSH 或不同远端的会话。

### 3.3 刷新和缓存失效

每次历史刷新为一个来源范围加载一次名称索引，并记录可比较的索引 fingerprint（文件元数据/已有远端 fingerprint；不可取得时使用本次读取结果的安全摘要）。名称索引 fingerprint 变化时：

- legacy history index 不复用受影响 Codex 会话的旧 title；
- V2 catalog 使用现有 history_meta/解析版本复用机制，使受影响的 Codex 行重新解析或更新 title；
- 直接读取详情时使用当前 resolver，确保重新打开详情可以看到最新名称。

为兼容旧缓存，相关 parser/adapter 版本递增；不删除原始文件，也不需要数据库迁移。刷新失败只触发既有来源标题回退，不影响其他来源和其他会话。

## 4. 数据流

### 排序

    settingsStore
        -> HistoryWorkspace 当前六页签方向
        -> SessionDetailPane 排序控件/虚拟消息条目
        -> timeline/changes/tools/subtasks 的局部投影

缓存的 process model、搜索结果和操作 API 均保持 raw/ascending 坐标；只有最后一层决定视觉顺序。

### 标题

    local/WSL/SSH Codex session_index.jsonl
        -> 按来源范围建立 CodexThreadNameIndex
        -> 历史 summary/detail/search 的既有 title
        -> alias/AI/source/session-id 统一解析
        -> 列表、详情、搜索结果

## 5. 失败与兼容策略

- 旧设置没有排序映射：六个页签默认 ascending。
- 设置写入失败：当前 UI 继续使用新方向，后续启动读取最近一次成功持久化值。
- Codex 索引缺失/损坏/权限不足：沿用现有标题链，不阻塞历史扫描。
- Codex 索引与会话身份不匹配：视为未命中，不显示他源 thread_name。
- 空数据、重复时间戳、无时间戳、旧快照和长列表：使用稳定坐标和既有空态/虚拟化逻辑。
- 标题文件外部变化：下一次历史刷新或重新打开详情生效；不新增后台 watcher。

## 6. 验证设计

前端验证：

- 六个可排序页签分别测试正序、倒序、重复切换、换会话、关闭再开和重启恢复。
- 对话/原文测试虚拟列表尾部加载、倒序扩展、搜索前后命中、跨视图跳转、编辑/插入/删除和批量删除的 raw messageIndex。
- 结构化视图测试过滤后反转、统计不变、文件名/树层级不误反转。
- 测试非法/缺失设置与 store 写入失败。
- 手动切换 zh-CN、zh-TW、en-US，检查控件可访问性和 24 小时制。

后端验证：

- session_index.jsonl 合法、重复 id、空名称、损坏行、超限文件、缺失文件和不匹配 ID。
- Windows 本地、WSL、SSH 的来源隔离与 fallback。
- thread_name 变更触发缓存刷新；历史列表、详情、搜索共享新 title。
- alias > AI > thread_name > source/fallback 的完整优先级。

