# 方案修订与产品实施验证记录

## 2026-10-07 · 用户认可与提交清理

- 用户反馈“可以了”，授权删除无用文件并提交、关联 #271 #269。此次按已认可范围交付归档；历史未完成的完整环境矩阵、原生 WebView2 与 64,887 性能复测不因此补记 PASS。
- 删除无产品/测试调用方的 `ConflictDiffRow.tsx`、`ConflictResultEditor.tsx`，三栏 Monaco 已完全替代；GitNexus impact 未收录（UNKNOWN），以直接引用核对。删除 `.trellis/tmp` 中六个 issue 抓取缓存。设计原型、有效测试夹具及历史测量证据保留。
- 提交前分支为 master，领先本地 origin/master 2、落后 0；不 fetch/pull/push。提交信息用 Refs #271, #269 关联，不自动关闭 issue。
- 清理后验证：TypeScript 检查 PASS；strict 架构 PASS（1263 source、零违规）；冲突控制器、恢复闸门与列宽定向测试 28/28 PASS。上一轮独立浏览器验证仍适用于保留的三栏实现，本轮不重复启动应用、完整构建或长基准。
- 提交前 `gitnexus_detect_changes(scope=staged)`：35 个已索引符号、25 个流程，风险 CRITICAL；风险来自既有 Git 写入 guard、应用注册与终端标签生命周期，核对均属于本次 Worktree 合并实现范围。新文件未完整收录，不能据此宣称全量影响覆盖。暂存检查发现原型 HTML 空行尾随空格，已仅清除该空格。

## 2026-10-07 · 三栏自适应与拖拽（V1.4.2）

- 用户已批准追加原任务并实施。根因是 Grid 固定 720px 最小总宽与 240px 单栏下限，在文件侧栏占宽后超出终端 pane；栏头不可收缩内容加剧窄列溢出。已改为可收缩比例轨道、独立代码滚动和按栏宽适配标题。
- 发现清单：`worktree-conflicts.css` 布局/溢出；`ConflictPaneLayout` 帧节流预览与 pointer/keyboard 生命周期；`conflictColumnLayout` 比例约束；Workspace → BlockEditor → MonacoEditor 临时列宽传递；中英文 aria。现有 terminal 侧栏拖拽绑定全局偏好，未复用其实现；后端、IPC、草稿协议与 Monaco 模型身份已确认无改动。GitNexus 未收录相关新增组件，风险返回 UNKNOWN，使用契约与定向引用核对。
- `node --test scripts/worktreeConflictColumns.test.mjs scripts/worktreeConflictLayout.browser.test.mjs`：5/5 PASS。纯函数覆盖两分隔线、极端 delta、0/1/120/299/300/480/585.5/1000/2400px 可用宽度、总比例与最小宽度、缩小后恢复偏好。
- 独立 Edge headless 夹具使用真实布局组件/CSS，不启动 CLI-Manager、Vite/HTTP 服务或 Git。覆盖工作区 480/640/800/1000/1400px、中英文、125% CSS zoom；两分隔线鼠标移动、按键/Shift/Home/End、双击/Enter；pointercancel、capture loss、blur、容器变化、隐藏恢复、拖动中卸载。全部三栏不越界；预览不提交；编辑测试输入保留；子面板挂载 3 次、拖动/缩放中 0 次重挂，最终卸载 3 次，无 pageerror。
- `npx tsc --noEmit` PASS；`npm run check:architecture -- --strict` PASS（1,262 source、零超限/新增违规）。本轮浏览器夹具验证布局和子树身份，不加载真实 Monaco，不能代替原生 WebView2/Monaco 的 IME、光标、撤销和完整合并验收；原任务保持 in_progress，原有性能/环境矩阵未完成项不改为通过。

## 当前结论

- 用户已批准产品实现，版本 **V1.4.2**，task 为 **in_progress / P3 验收中**。P1 后端闭环、11 个 IPC 和 P2 全局全屏冲突工作区已经接入。
- 上一批 Rust 冲突模块定向测试 **77/77** 通过，普通写入守卫补充测试 **2/2** 通过；本次索引读取优化后文件模块定向回归 **11/11** 通过（55.64s），含新增精确路径/外部索引更新用例。两次错误过滤实际运行 0 项，不计为通过。使用隔离临时 Git 仓库，不在开发仓库制造冲突。
- 前端控制器、恢复门控、Git 工作区及 diff/大列表回归合计 **54/54** 通过。生产 React + Edge 的真实挂载/交互测试 **1/1** 通过，包括双语、分页、焦点交接、返回说明、入口移除/项目删除回退及 CRLF 编辑；Git IPC 为替身，不等于原生端到端。
- 最新 `npm run build` 通过（含 tsc，Vite 48.09s，包含冲突编辑 Worker 产物），存在既有大 chunk 警告及完成弹窗静态/动态导入混用警告；strict 架构检查：1,250 个 source 文件、超过 2,000 行 0 个、新增违规 0 个。8 个定向 Node 测试文件合计 54/54 通过（4.646s，无跳过），`git diff --check` 通过（仅 CRLF 转换提示）。
- 边界体积浏览器性能复测 **PASS**：5 冷 / 20 暖，2,091,566 bytes、20,000 行、2,000 块、64,887 条元数据；原始结果见 `tests/browser-performance-evidence.json`。初测失败已定位并修复，没有放宽预算或截断数据。
- 新增短窗口/复制测试 **1/1 PASS，9.20s**：900×400 长错误下保存/重试操作可见，Tab 保持在模态内，Escape 不丢弃保存失败草稿，取消后恢复原内容；多行 Unicode/Tab 复制仅包含选择侧，左右横向滚动独立且单纵向滚动、页面无横向溢出。该测试仍为真实 React + Edge / IPC 替身。
- 原生 Git 命令级 1k/10k/64,887 fixture 初测已完成（1246.78s），完整分页计数与唯一性均通过；64,887 文件详情冷/暖 p95 为 2689.4113/2601.7870ms，超过 2 秒预算，性能判定 FAIL，不能因采样测试退出码为 0 写成 PASS。已修正重复全索引映射，复测仅完成 1k/10k；根据用户要求停止耗时基准，64,887 文件复测及原生 WebView2 验收仍待完成，不能宣称性能问题已验收通过。
- 2026-09-30 用户明确要求尽快交付、避免过度测试，并由用户启动所需测试。已停止本轮自行启动的原生基准进程，保留完整初测及部分复测证据；后续不自动编译、启动应用或恢复长时间压测。
- 下面的隔离 Git 实验属于方案语义证据，不能替代产品验收。
- 后续顺序为 P0 契约/fixture → P1 后端安全闭环 → P2 UI 接入 → P3 功能/性能/工程验收。每阶段 gate 未通过不得推进依赖步骤；产品实测未完成不得宣称功能性能正常。

## 关键修正对照

| 风险 | 修订后的约束 |
|---|---|
| 合并方向与UI左右反转 | stage2=Worktree右栏，stage3=目标左栏，API使用语义side和固定OID。 |
| 缺失侧checkout失败/错误处理复杂类型 | modify/delete缺失侧明确删除，复杂rename/symlink/gitlink明确不支持自动写。 |
| 主检出abort失败被忽略、stash错误关闭后绕过 | 检查abort/恢复，持久化恢复闸门；保持禁用+可见原因+只读重检，不把原有改动当失败。 |
| 部分草稿和已解决进度丢失、普通commit绕过 | per-Worktree Gitdir清单/草稿/receipt；入口先probe；普通stage/commit guard，专用双父continue。 |
| 外部merge误接管、多窗口/过期请求覆盖 | 受管操作身份证明、CAS/幂等/短锁和外部变化保守拒绝；崩溃按intent和Git实态恢复。 |
| 文件越界、重编码、截断保存 | fileId白名单+词法/实际路径校验、byte-offset保留、独立容量上限、超限不可编辑。 |
| Radix焦点锁和compact入口缺失 | App共用host、显式返回上下文、先卸载模态再开面板；外部终端入口同样可用。 |
| 虚拟化当成完整性能保证、主文件接近长度上限 | 分页/按需/单飞/有界缓冲+浏览器实测门槛，按职责拆模块且strict检查；不靠扩大老文件实现。 |
| 目标前移仍承诺无冲突 | 主检出重新检查当前OID，新冲突安全恢复后进入新一轮；不复用旧确认、不强推。 |

## 方案阶段已执行的隔离 Git 实验（历史证据）

环境：Windows，`git version 2.50.1.windows.1`；Node驱动真实Git命令，临时独立仓库与linked Worktree，禁止继承用户global/system配置、隐式hooks和GPG签名。未在 CLI-Manager 仓库制造冲突或改变分支。

原始结果：`tests/git-semantics-evidence.json`。临时实验目录：`C:/Users/1/AppData/Local/Temp/cli-manager-plan-git-validation-5rX1Nq`；目录可能被系统清理，因此结果已复制到本任务。

| 核验项 | 实际结果 |
|---|---|
| Worktree合并固定base OID后的stage方向 | PASS：stage2内容为feature，stage3内容为base。 |
| 对称modify/delete的缺失stage | PASS：两种缺失方向均确认；checkout缺失theirs返回非零。 |
| linked Worktree的私有git-dir | PASS：与主检出git-dir不同。 |
| 文件stage后是否仍出现在ls-files-u | PASS：已解决文件消失，证明不能以此重建原始总进度。 |
| 两种缺失侧删除与提交父节点 | PASS：精确删除后无unmerged，提交双父依次为起点Worktree HEAD和固定base OID。 |
| 目标前移是否可能再次冲突 | PASS：相同行新提交再合并产生冲突；abort后恢复目标HEAD与干净status。 |
| Git是否阻止带marker提交 | PASS（风险复现）：外部add-all后commit成功，marker仍在提交中，必须由产品确认/receipt保护。 |

以上7项只证明底层Git语义和原方案风险，不证明拟新增IPC、解析器、路径防护或UI已经实现。

## 方案阶段文档与工程历史基线（不代表当前产品状态）

| 检查 | 状态/证据 |
|---|---|
| R/AC编号唯一、用例覆盖和ID唯一 | PASS：Node机械核验20条R、25条未勾选AC，编号连续且唯一；51条唯一用例的映射列覆盖全部20条R/25条AC，无未知引用。覆盖不代表用例已执行。 |
| task.json/JSONL可解析、引用文件存在 | PASS：task保持planning；implement.jsonl的9条、check.jsonl的12条引用均可解析、无重复且文件存在，含本验证文件。 |
| 文档一致性与已有检查入口 | 人工交叉复核完成；9个任务文件无空文件、冲突标记或编码替换字符；6个引用的已有Node测试脚本及check:architecture/build脚本存在。命令存在不代表已执行产品测试。 |
| npm run check:architecture -- --strict | PASS，退出码0：1189个source文件，超过2000行的文件0个，strict新增违规0个。仅证明当前架构基线，不证明待实现方案已通过编译或性能验收。 |
| 分支与变更范围 | 交付前复核：master领先本地origin/master 2、落后0；未fetch/同步。原任务目录与.trellis/tmp均未跟踪，git diff --stat为空，产品tracked文件无改动；本轮只写任务目录。 |

## 产品实现复验（2026-09-30）

### 浏览器性能修复与证据

- 历史初测：冷选择 p95=130.8ms，主线程出现约 325–430ms 长任务。根因是草稿自动保存回读生成新 blocks 引用，触发整文件行模型、列宽、换行重复扫描；不稳定虚拟测量回调又扩大重测。DOM 虚拟化本身不能消除这些计算。
- 修复：源模型一次性 Worker 构建，按源身份缓存，draft-only 回读复用；测量回调稳定。失败/超时可重试，旧 Worker 终止，关闭/切换不回填过期内容。
- 环境：Windows 10.0.26200、i7-12700H / 20 logical CPUs / 34,044,174,336 bytes RAM、Node 24.18.1、Edge 154.0.4258.37，生产 React 构建。首次样本为新页面冷挂载，不是清除 OS 缓存；暖样本每次实际切换选择值。

| 指标（ms） | 冷 p95（5） | 暖 p95（20） | 范围 |
|---|---:|---:|---|
| 元数据返回到列表绘制 | 19.3 | 44.7 | ≤500ms |
| 详情请求到绘制 | 163.4 | 131.5 | ≤2000ms；IPC 为替身 |
| 详情返回后模型/渲染 | 153.6 | 124.2 | 含 Worker 构建/虚拟行绘制 |
| IPC 替身 | 9.8 | 12.4 | 不代表 Tauri IPC |
| 选择到绘制 | 64.7 | 50.2 | ≤100ms |

滚动 p95=34.2ms / max=35.5ms；采样窗口无 >100ms 主线程长任务，内容并发峰值=1。文件行约23、内容行约25。20次关闭后强制 GC：61,438,136→62,327,160 bytes，增量889,024 bytes；DOM703 / listeners345保持不变。JSON 4,240,341 bytes / 最大单行64,014 bytes。只证明本 fixture 的浏览器门槛，不冒充原生 WebView2 RSS。

复验命令：

```powershell
node --test scripts/worktreeConflicts.browser.test.mjs
node --test scripts/worktreeConflicts.boundaries.test.mjs
$env:CONFLICT_PERF_REPORT = '<absolute-task-path>/tests/browser-performance-evidence.json'
node --test scripts/worktreeConflicts.performance.test.mjs
$env:CONFLICT_NATIVE_REPORT = '<absolute-task-path>/tests/native-performance-NEW-RUN.json'
$env:CONFLICT_NATIVE_COUNTS = '1000,10000,64887' # 默认同此；允许定向复测，不能冒充三档结果
cargo test --manifest-path src-tauri/Cargo.toml native_scale_evidence --lib -- --ignored --test-threads=1 --nocapture
```

原生命令采样：每档一次 prepare，5 次新 Rust 进程冷读、一次预热后20次暖读，首/中/末页及详情分别记录 p50/p95/max，并遍历全部页验证计数和唯一性。OS 缓存不清空，进程启动不计入读延迟；50ms采样的 Rust RSS 不含 Git 子进程/WebView2，采样开销计入耗时。debug profile 不能替代发布版端到端指标。

### 原生详情性能根因与修正

原始证据保留在 `tests/native-performance-evidence.json`，不覆盖失败样本。Windows 11 Home China / i7-12700H / Git 2.50.1.windows.1 / debug。

| 冲突文件数 | prepare（ms，一次） | 详情冷 p95（ms） | 详情暖 p95（ms） | 完整可达文件数 |
|---:|---:|---:|---:|---:|
| 1,000 | 2645.0598 | 208.4763 | 182.9342 | 1,000 |
| 10,000 | 24736.6408 | 464.1479 | 383.1853 | 10,000 |
| 64,887 | 249903.8326 | **2689.4113** | **2601.7870** | 64,887 |

- 根因：`session_files::detail` 前后分别调用 `index_state`，为所有路径/阶段创建 BTreeMap 和 OID 字符串，却只比较当前文件。64,887 冲突约 194,661 条索引项被重复转换。
- 修正：`file_index_state` 每次仍 `index.read(true)`，仅通过目标路径查询 stage 0..3，并核对原始路径字节。不是绕过磁盘读取或宣称 O(1) 总 I/O；写入/提交/恢复仍使用完整索引基线。
- 回归：比较目标查询与完整索引的 stage/OID/mode；同一 Repository 句柄下外部暂存、删除、Unicode 路径更新必须可见，NUL 路径不得触发库内 panic。既有外部 stage-all、源文件变化拒绝测试保留。
- GitNexus 对新详情/基准符号未收录，影响分析为 UNKNOWN，不将空结果解释为无调用方。复测报告写入 `tests/native-performance-after-index-lookup.json`。
- 64,887 文件原始 prepare→首屏元数据共 251460.0343ms，必须与 UI 元数据到绘制的 ≤500ms 指标分开呈现，不能隐藏准备耗时。

修正后部分采样（`tests/native-performance-after-index-lookup.json`）：

| 冲突文件数 | prepare（ms，一次） | 详情冷 p95（ms） | 详情暖 p95（ms） | 完整可达文件数 |
|---:|---:|---:|---:|---:|
| 1,000 | 4103.4037 | 562.8910 | 569.9137 | 1,000 |
| 10,000 | 33550.9553 | 612.6141 | 627.7945 | 10,000 |

两档详情命令耗时低于 2 秒，但不能替代原生端到端指标，也不能据此宣称所有规模性能改善；64,887 档复测中止，原始超预算证据保持有效。优化后的 11 项文件回归、strict 架构检查（1,250 个 source、零超限/新增违规）及 `git diff --check` 已通过，不再重复编译或运行全量测试。

## 产品 gate 当前状态

| Gate | 状态 | 进入/退出要求 |
|---|---|---|
| 新增Rust/IPC功能及安全测试 | 定向 PASS，矩阵待逐项核对 | 77 项模块测试及 2 项补充普通写入守卫通过，11 个 IPC 注册编译通过。 |
| UI/模态/compact/外部终端/双语 | Edge 自动化部分 PASS | 真实全局 host、双语、返回上下文和焦点通过；原生窗口/托盘完整矩阵待验收。 |
| 崩溃/恢复/多窗口/外部Git竞争 | Rust 定向覆盖，原生矩阵未完成 | 不将模拟或定向测试冒充所有持久化边界故障注入。 |
| 大列表/文件性能、DOM、内存、并发 | 浏览器门槛 PASS；原生仍待验收 | 初测 64,887 档详情超预算，修正后仅有 1k/10k 部分复测；按用户要求停止长测，WebView2 未测。 |
| 定向前后端回归、tsc/build/cargo | PASS（已执行范围） | Rust 定向、Node 54 项、tsc/build、strict 架构检查已通过；后续改动需复验。 |
| 产品交付 | NOT_READY | 所有关键gate通过且有证据后才能进入；当前不勾选任何产品AC。 |

## 下一步

### 2026-09-30：冲突工作区可发现性与闭环修正（待人工验收）

- 根因：入口沿用弱化按钮；打开工作区只做 probe，没有自动 prepare 或选中首个冲突；隔离提交与目标分支合并缺少明确衔接，用户停留在空白准备页。
- 修正：突出入口，明确打开时单飞准备并自动选中文件，显示三步指引，逐文件确认后加载当前页下一冲突；明确提交后经现有恢复与身份校验链继续目标合并。保存返回不合并，清理独立。
- 补充定向回归用例：初始化/准备单飞、外部或恢复会话不接管、卸载后不准备、逐文件推进且不隐式提交。按用户要求本轮不编译、不启动、不运行完整测试或大型性能 fixture；新增用例尚未执行。
- 本轮实际验证：`npm run check:architecture -- --strict` PASS（1,250 个 source、零超限、零新增违规）；改动范围 `git diff --check` PASS；两个回归脚本 `node --check` 语法检查 PASS。脚本语法通过不代表回归用例已运行，TS 类型/编译和原生交互均未复验。保留未提交改动与任务 in_progress，不执行提交或归档。
- 最短人工路径：完成弹窗点击“解决冲突并合并” → 自动出现文件和左右内容 → 逐块选择并确认文件 → 全部解决后填写提交说明 → “提交并合并到目标分支” → 目标分支合并成功后才进入独立清理步骤。
- 返回验证：处理中“保存并返回”不得提交或合并；重新进入应保留草稿。外部合并/恢复阻断不得被自动准备绕过。

后端契约记录已补齐：`.trellis/spec/backend/worktree-conflict-resolution-contracts.md` 覆盖 11 个冲突 IPC、2 个主检出恢复 IPC、版本/草稿/CAS、分页与性能边界；原 Worktree 契约中无条件“冲突后恢复干净”的表述已修正为验证成功才可报告，失败持续阻断。本次仅修改文档，不编译或启动测试。

由用户启动开发版后，优先人工确认冲突入口与返回、选择/编辑/保存后继续合并、关闭重开草稿恢复三个核心流程；根据实际异常再做定向修正，不默认重跑全量矩阵或大型 fixture。64,887 档与原生 WebView2 性能保留待验收状态，后续运行由用户安排。维持 in_progress，不自动编译、启动、提交、同步分支或归档任务；未完成的原生验收不以浏览器或命令级通过代替。

### 2026-09-30：常驻合并结果编辑区（V1.4.2，待人工验收）

- 根因：手动编辑框藏在虚拟列表的冲突块操作之后，用户看到的两侧仍是只读原文；切入手动编辑还会默认使用 Worktree 内容，丢掉此前选择的编辑起点。
- 发现与修正：ConflictBlockEditor 的产品调用入口为 WorktreeConflictWorkspace；新增 ConflictResultEditor，把当前块结果固定在原文列表之外，允许直接删改、复制粘贴任意一侧的行，并通过前后导航或点击原文切换块。共用 conflictChoiceText 保留已有单侧、双方或手动编辑结果，空字符串是有效删除结果；未选择时只展示双方拼接预览，不计为已解决。
- 数据与性能边界：继续使用既有 edited 草稿、CAS 保存和精确暂存协议，不修改后端或 IPC。只编辑当前冲突块，非冲突文本不变；DOM 使用 LF、保存恢复源换行，避免 CRLF 输入反馈挪动光标；自动保存不卸载编辑框，切换块时隔离撤销栈，原文继续虚拟化。混合换行文件不开放手动编辑。
- GitNexus 未收录该新增组件，影响评估为 UNKNOWN；以领域契约与局部引用核对调用方，不把索引空结果当作零风险。保留已有未提交改动与 master 领先上游 2 个提交的状态，不同步分支。
- 本轮实际检查：strict 架构检查 PASS（1,251 个 source、零超限、零新增违规）；受检查的已跟踪文件 git diff --check PASS；两个回归脚本 node --check PASS。补充了常驻编辑、未选择预览、保留原选择、混合左右行与空编辑用例，但未执行；没有编译、类型检查、启动应用或浏览器测试，交互与性能尚待用户验收。
- 最短人工路径：打开冲突文件 → 下方直接看到当前冲突块合并结果 → 删除不要的内容，或从左侧复制第 2–3 行、从右侧复制第 7–8 行并粘贴组合 → 确认并暂存此文件 → 全部文件解决后点击提交并合并到目标分支。两侧原文保持只读；仅查看预览不得自动确认文件。
- 补充人工观察：输入中等待自动保存，光标应留在原位；保存并返回后重开应恢复内容；多块文件切换前后块不得串用草稿；先保留目标分支再进入手动编辑应沿用目标内容。保持任务 in_progress，产品 gate 不因静态检查通过而改为完成。

### 2026-09-30：冲突工作区顶部精简（V1.4.2，待人工验收）

- 分诊：表现层最小修复。顶部重复堆叠说明、步骤和状态，文件工具栏重复展示长分支名；仅调整布局与文案，不变更控制器、持久化、IPC 或 Git 操作。
- 标题与帮助入口、分支方向与进度分层展示；原操作说明移入默认收起的“使用帮助”。文件路径和短标签按钮合并为工具栏，完整分支名保留在悬停说明及原文列头，窄窗口自动换行。错误、重检要求及危险操作确认仍直接显示；可编辑结果区域保持不变。
- GitNexus 未收录 WorktreeConflictWorkspace，影响评估 UNKNOWN；局部引用确认产品入口为 WorktreeConflictHost，另有测试 fixture。master 领先上游 2 个提交及既有未提交改动保留，不执行同步。
- 待用户人工确认：重开工作区后顶部不再出现大段说明；展开/收起“使用帮助”；长分支名与窄窗口不挤压按钮；切换明暗主题及中英文后仍可读；选择内容、确认文件与显式提交合并流程保持原行为。未编译、启动应用或执行浏览器测试。
- 本轮实际检查：strict 架构检查 PASS（1,251 个 source，零超限、零新增违规）；本轮范围内已跟踪文件 git diff --check PASS（仅提示既有 LF/CRLF 转换）。主题变量存在，中英文短标签已同步；未运行类型检查、编译或运行时测试，未将静态结果代替视觉验收。

### 2026-10-07：块解决状态与应用结果（V1.4.2）

- 用户确认采用 JetBrains 式交互：每块选择/编辑后自动识别为已解决，全部块完成显示“冲突已解决”；明确点击“应用结果”才写入/暂存，全局统计已应用文件数。
- 根因及发现清单见 design.md“块解决与文件应用状态”：UI 混淆了草稿选择与后端文件凭据，控制器/IPC/Rust 路径核对后未改动。GitNexus 对新组件返回 UNKNOWN，契约与直接引用核对范围。
- `node --test scripts/worktreeMergeConflicts.test.mjs scripts/worktreeConflictProgress.browser.test.mjs`：20/20 PASS。新增覆盖多块/空编辑/无块/陈旧选择键、接受右侧立即更新状态、自动保存不写文件、切换文件后从草稿恢复、保存/应用失败不增加进度。
- Edge 独立页面加载真实 FileList、FileConfirmation、Controller 与双语字典（仅 i18n hook/IPC 使用夹具）：zh-CN/en-US 均验证 1/2 禁用应用、2/2 显示已解决待应用、显式应用后文件数 +1；保存失败保留错误并禁用应用。无服务、无应用启动、无真实 Git 写入，不等同 Monaco/WebView2 或完整合并验收。
- `npx tsc --noEmit` PASS；`npm run check:architecture -- --strict` PASS（1265 source，零超限、零违规）；冲突 CSS PostCSS 解析 PASS；已跟踪文件 `git diff --check` PASS（仅 LF/CRLF 提示）。V1.4.2 CHANGELOG、功能清单与契约同步。
- 真实设置页语言切换、Monaco 光标/IME/撤销、原生主题观感与最终 Git 合并仍待用户验收；不启动应用、生产构建或长基准。保留既有未提交工作，未提交或同步 Git，原任务仍为 in_progress。

### 2026-09-30：Monaco 三栏直接编辑（V1.4.2，待人工验收）

- 根因与触点：原双栏 renderer 只有只读原文，独立下方 textarea 并不满足在代码对比区域内直接编辑的需求。用户已批准替换编辑器；产品入口仍为 WorktreeConflictWorkspace → ConflictBlockEditor，新增懒加载 ConflictMonacoEditor，复用现有 Monaco 依赖和 worker 配置，不改后端或 IPC。
- 现在每个冲突块显示目标原文只读 / 中央合并结果可编辑 / Worktree 原文只读，移除旧输入框和手动编辑按钮；支持源文本选区复制、结果直接输入/删改、撤销/重做、前后及下一未处理块。未操作的拼接预览不生成选择，空编辑仍是有效删除；确认文件与显式提交合并流程不变。
- 性能边界：只挂载当前块的三个模型，切块、切文件及关闭释放；文件列表与代码视口有界。编辑器延迟加载，超过 128 Ki 字符或 2,000 个 LF 换行的大块采用纯文本，单行高亮上限 2,000 字符，禁用 minimap/建议等昂贵功能。复用源内容 Worker 模型、300ms 防抖和串行 CAS；相同内容的保存回读不重设文本、光标、IME 或撤销栈。
- 字节边界：编辑器采用 LF，写入恢复源换行；通过向空模型插入文本保留字面 BOM，非冲突内容仍由后端保留。混合换行继续禁用直接编辑。
- GitNexus 未索引本轮涉及的新增组件/fixture，影响为 UNKNOWN；按契约与局部引用核对，未把空结果当作安全证明。保留既有未提交修改及 master 领先上游 2 个提交的状态，不执行提交或同步。
- 实际检查：strict 架构检查 PASS（1,253 个 source，零超限、零新增违规）；本轮四个修改/新增 mjs 文件 node --check PASS；指定已跟踪文件 git diff --check PASS，仅既有 LF/CRLF 提示。按用户要求未编译、类型检查、启动应用或执行浏览器测试；运行时、视觉与性能尚未验证。
- 回归脚本已适配三栏模型输入、来源只读/选区、混合行及 CRLF、草稿失败保留、关闭释放、最多三个编辑器和每栏最大可见行数；脚本仅做语法检查，不能声称用例通过。此前双栏 renderer 的性能数据不覆盖本次替换，需重新采样。
- 用户最短验收：启动后打开冲突文件 → 从左侧复制所需行、从右侧复制所需行到中间结果，直接删改 → 等自动保存期间观察光标，试 Ctrl+Z / Ctrl+Y → 保存返回再打开确认草稿 → 确认文件后显式提交并合并。另抽查多块切换、整块删除、明暗主题及中英文；任务保持 in_progress，不以静态检查替代产品验收。
