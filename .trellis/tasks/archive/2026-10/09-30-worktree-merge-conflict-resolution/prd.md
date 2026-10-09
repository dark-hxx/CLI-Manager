# Worktree 合并冲突解决

Refs #269, #271

## Goal

### 2026-10-07 追加：三栏自适应与拖拽

用户已批准追加原任务并实施，版本继续 V1.4.2。

- 三栏及文件侧栏随冲突标签的可用宽度适配；窗口缩放、应用缩放与分屏不能把 Worktree 栏推到视口外，长代码只在所属 Monaco 栏内横向滚动。
- 两条分隔线支持鼠标/触控拖动和键盘调宽，保留三栏合理最小宽度；窄到无法满足像素下限时按可用宽度收缩。双击或 Enter 恢复等宽。
- 列宽比例在本次冲突工作区内跨块/文件保留，不新增磁盘偏好。调整、取消拖动、失焦和隐藏恢复不修改草稿，不重建 Monaco 模型。
- 验收覆盖工作区宽度 480/640/800/1000/1400、放大缩小、窄列长标题/中英文、两条分隔线及边界、拖动中取消/失焦/容器变化/卸载。新增 aria 文案双语。
- 本轮不增加文件侧栏拖拽、全应用分屏能力、IPC、Git 写入或持久化协议；原任务其他验收项保持原状态。

Worktree 完成流程在合并产生冲突时，不再只有「中止后回终端手工处理」这一条出路。主检出成功 abort 后恢复原基线（强制合并包括原有未提交改动）；恢复失败时阻断后续危险操作。确认恢复安全后，冲突现场在隔离的 Worktree 中准备，用户可以在应用内的全屏合并视图里按文件、按块取舍，完成后回到完成弹窗重新合并。

同时修复完成弹窗长错误文案不可滚动、stash 恢复类错误禁用合并按钮却缺少可见说明的问题。恢复失败时继续禁用危险操作，不通过重新启用合并按钮绕过恢复检查。

用户已批准按 V1.4.2 进入产品实现，当前 task 为 in_progress。下文为完整实现与验收要求，不代表已全部完成或功能性能测试已经通过；实际通过证据按 `tests/worktree-merge-conflict-resolution-test-cases.md` 和 `validation.md` 登记。

## Background and confirmed facts

### 合并链路现状（已逐行核实）

- 合并核心为 `src-tauri/src/features/projects/worktree.rs:809-1094` 的 `merge_worktree_internal(project_path, worktree_branch, base_branch, allow_dirty)`，被两个 command 共用：`git_worktree_merge`（`allow_dirty=false`，`:1188-1201`）与 `git_worktree_force_merge`（`allow_dirty=true`，`:1205-1218`）。两者都在 `WORKTREE_MERGE_LOCK` 下串行（`:1196` / `:1213`）。
- 主检出脏时普通合并返回 `dirty_main_worktree`（`:822-827`），不执行 checkout 或 merge。**该场景已由强制合并覆盖**，不是本次要解决的问题。
- 当前普通/强制合并在冲突后尝试 `git merge --abort`，前端只获得文件列表；普通路径尚有未检查 abort 返回值的分支。实现需补上失败检查，但不得改变脏主检出的普通/强制合并策略。本次还涉及 Worktree 内的恢复入口、普通提交入口防护及新增 IPC，不能将影响范围描述为只有冲突分支。
- 契约 `worktree-isolation-contracts.md:196` 明确要求冲突必须立即 abort、不得留下半合并状态。**该约束描述的是主检出，本次不改动它。**
- command 注册在 `src-tauri/src/lib.rs:974-976`；新增命令不注册则前端 invoke 直接失败。

### 前端现状

- 完成弹窗 `src/features/projects/api/WorktreeFinishDialog.tsx`：`step` 为 `review | merge | cleanup | done`。
- 弹窗宽度固定 `max-w-[520px]`（`:296`），内容容器（`:302`）**没有 `max-h` / `overflow-auto`**，只有内部若干 `<pre>` 各自限高。长错误块累计超过视口后整个弹窗溢出且无法滚动 —— 这是 #269 的直接成因。
- `mergeBlockedByRestore` 对三类恢复错误禁用合并按钮；这是安全限制，问题在于缺少清晰原因与恢复引导。关闭重开不能视为主检出已恢复的证据。
- 强制合并按钮只在 `error.code === "dirty_main_worktree"` 时渲染（`:349`）；冲突发生后错误码变为 `merge_conflict`，按钮消失。
- Store：`src/features/projects/api/worktreeStore.ts:332-350`（`mergeWorktree` / `forceMergeWorktree`），`:355-364` 已有「按 `worktreeId` 找出关联终端会话」的先例。
- 终端入口的既有模式在 `src/features/projects/hooks/useSidebarController.tsx:942-948`；这说明外部终端与 compact 用户不会总是经过 TerminalTabs。新冲突面板必须覆盖这些用户的完成入口，但不改造 `openWindowsTerminal` 或新增弹窗终端按钮。

### 可复用的既有能力（本次的关键前提）

- 按用户修订要求，冲突解决接入既有原生标签系统，新增 `TerminalSessionKind = "worktree-conflict"`，不再给整个终端工作区套额外标签栏。原终端、文件标签、分屏和默认空状态必须保持。
  **生命周期：标签无 PTY、不进入终端恢复记录；全局宿主保留草稿所有者，内容停靠原生 pane。切换标签不得销毁编辑器；关闭先保存，失败保留；Esc 不关闭。紧凑模式打开入口切回标准工作区。**
- split diff 与行对齐：项目使用 `react-diff-view`，`viewType="split"` 本身即左右对齐。`src/features/git/components/diff/gitDiffVirtualization.ts:7-20` 的 `countGitDiffRenderRows` 已把 `delete`+`insert` 合并为一渲染行（左格 + 右格），`DIFF_ROW_HEIGHT=24`、`HUNK_HEADER_HEIGHT=28`，虚拟化在 `GitDiffHunkList`。
- 横向滚动同步已有 `useGitDiffHorizontalScroll`（`syncCodeCells`）。**纵向同步无需实现**——split 两侧本就在同一虚拟行内，只要不拆成两个滚动容器。
- 按侧的行选中语义已存在：`gitDiffSelection.ts:153-205` 的 `scope = viewMode === "split" ? side : "unified"`。

### 环境与工具事实

- 本次审查中 GitNexus 查询提示 FTS 索引缺失，目标符号未找到，按闸机降级为契约与定向源码核对；不将缺少索引结果当作没有调用者。实现前重新进行符号 impact 分析。
- 本轮只读检查：`master` 相对本地记录的 `origin/master` 领先 2 个提交，无已跟踪文件改动；任务目录及 `.trellis/tmp/` 未跟踪。未 fetch，未进行分支同步。旧方案关于其他会话文件损坏、cargo 无法编译的描述未经本轮重验，不沿用为当前阻塞结论；本轮也未运行 cargo，不能据此声称编译通过。

## Requirements

- R1. 本应用发起的主检出合并冲突后必须立即尝试 abort 并检查结果。普通干净基线恢复到原状态；强制合并保留既有 stash 恢复语义，恢复后的原有改动不等于错误。abort/恢复失败必须显式阻断后续合并和准备操作，保留诊断，不能报告干净或自动清理用户现场。
- R2. 只在主检出安全检查通过后，Rust 解析并固定目标分支 OID，在已验证的 linked Worktree 内用 diff3 合并该 OID。该方向中 stage 2 / ours 是 Worktree，stage 3 / theirs 是目标分支；界面左栏=目标分支=theirs，右栏=Worktree=ours。不能按冲突标记的出现顺序决定左右标签。
- R3. 提供一个**全屏、左右双栏、纵向天然对齐**的合并视图，复用现有 `react-diff-view` split 渲染与虚拟化，供用户按文件、按块选择保留哪一边。
- R4. 逐文件层必须支持「整取左侧 / 整取右侧」；逐块层必须支持对每个冲突块选择一侧或手动编辑。两层都不允许前端拼接 shell 命令。
- R5. 纵向滚动不得通过监听两个滚动容器互相赋值实现；必须复用单容器双格结构，避免滚动漂移与反馈循环。
- R6. 文件列表只读批量元数据、分页虚拟化；内容按需读取单文件，同一时刻最多一个编辑缓冲区和一个内容请求在途。后端先检查原始字节、行数、单行长度、冲突块数及序列化响应上限，再开放编辑；超过阈值只返回降级元数据，不返回可保存的截断内容。阈值及实测门槛见设计 §8。
- R7. 二进制文件、lockfile（`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `Cargo.lock` 等）不提供逐块入口，只提供整取并给出说明；判定规则由后端产出，前端不重复实现。
- R8. 冲突状态以 index unmerged entries 为依据，不能以有无文本标记判断。add/add 可能有标记也可能无标记；无标记、二进制及不支持的格式返回明确能力。modify/delete 选择缺失侧表示删除，不执行必然失败的 checkout；不支持的重命名组、symlink、gitlink 不得部分处理后声称成功。
- R9. UI store 不持久化，关闭释放组件与缓冲区，不写 SQLite、不新增 `TerminalSessionKind`。为满足 AC13，操作会话清单与已确认保存的逐块草稿保存在该 Worktree 独立 gitdir 下；重启重新探测 Git 与清单后恢复，不持久化弹窗/焦点/滚动位置。未确认保存的修改必须阻止无提示关闭。
- R10. 修复 #269：完成弹窗内容区限高可滚动，长错误文案与底部按钮在任意窗口高度下都可达。
- R11. stash 恢复类错误（`force_merge_restore_conflict` / `_restore_failed` / `_abort_failed`）下被禁用的合并按钮必须给出**可见的禁用原因**，不能只呈现为一个无说明的灰按钮。
- R12. 新增/修改的文案、错误提示、无障碍标签同时覆盖 `zh-CN` 与 `en-US`；合并视图用**分支名**而非「左侧/右侧」或 `ours`/`theirs` 表述。
- R13. 冲突态主操作按钮命名为**「解决冲突」**；弹窗内不出现「降级」「合并视图」等实现术语，也不额外提供终端入口（`取消` 已是恒定渲染的既有出口，侧栏 Worktree 右键新建终端同样可用）。
- R14. 完成入口必须先探测 merge/recovery 状态，再进入普通 review/commit；托管现场可直接恢复，外部合并只读提示。普通 stage-all/commit 后端在 merge 未结束时拒绝危险操作，防止把冲突标记提交为单父提交。专用 continue 必须核验解决凭证并生成正确的双父提交。
- R15. 面板与完成弹窗使用显式交接：保存返回上下文，卸载原模态层/焦点锁后打开全局面板；关闭、abort 或 continue 后分别恢复正确状态。紧凑模式、外部终端、分屏、多窗口入口均可达，不依赖 TerminalTabs 挂载。
- R16. 所有文件操作由后端根据 session ID + 文件 ID 定位；每次校验实际 Worktree 注册、仓库身份、相对路径、canonical containment、符号链接/reparse point 及文件类型。客户端不能指定任意文件路径或 Git 参数。
- R17. prepare 不接管任意 `MERGE_HEAD`；会话绑定 Worktree HEAD、目标 OID、Gitdir、原始 stage 集合。每次写入验证会话版本、index 与文件指纹；外部修改或多窗口旧请求返回 stale 状态，不覆盖、不自动 abort。应用间短锁不覆盖用户交互，也不能宣称阻止所有外部 Git 竞争。
- R18. 原始冲突集合和已解决凭证持久化，不能由 `ls-files -u` 推断历史进度。部分块选择只保存草稿，不暂存；所有块经确认且版本核验后才原子写入并暂存。BOM、换行、尾换行与未修改字节保持，不通过 `lines.join()` 重建整个文件。失败不得显示已解决。
- R19. continue 前后保留可恢复状态。目标分支前移时重新检查当前 OID，复用既有主检出合并流程；新冲突需针对新 OID 新建一轮解决，不能保证一次解决后永不冲突，也不能强制覆盖目标分支。
- R20. 将功能、安全、恢复与性能作为进入交付的独立闸门。方案审查通过只允许进入实现，不等于实机验收通过；未实现/未执行/环境缺失必须记录为待验证或阻塞，不能标记通过。

## Scenario matrix to verify

按闸机 §5，结合本项目已记录的坑（#227 `.git` 为文件、#257 大规模渲染）逐项确认。

| 维度 | 必须确认的场景 |
| --- | --- |
| Worktree 状态 | 主仓库 / linked Worktree（`.git` 为**文件**）/ Worktree 目录已缺失（`status="missing"`）/ 分支不匹配 |
| Worktree 内容状态 | 干净 / 未提交改动 / 托管合并 / 外部合并 / 会话记录与 Git 不一致 / 全部暂存但未提交 |
| 冲突类型 | 普通文本 / 双方向 modify-delete / 有或无标记的 add/add / 二进制 / lockfile / symlink / gitlink / 重命名组 |
| 冲突规模 | 单文件 / 多文件 / 单文件极大（数万行）/ 冲突块极多 |
| 终端与呈现 | 内置终端 / 外部终端（`useExternalTerminal`）/ 紧凑侧栏（`compactMode`）/ 分屏 / 多窗口 |
| 窗口状态 | 正常 / 最小化到托盘 / 全屏（`fullscreen`） |
| 合并结果 | not merged（abort 后）/ merged / merged=false 且 stash 未恢复 |
| CLI Hook | 装 / 未装（本轮不依赖 hook，也不从弹窗起终端；伪 tab 不得触发隔离） |
| 生命周期 | 单块草稿保存后关闭 / 文件暂存后重启 / 准备或写入中崩溃 / commit hook 失败 / continue 成功响应丢失 |
| 竞争与文件安全 | 外部 Git/编辑器改动 / 两窗口写同文件 / A→B→A 旧响应 / 目标分支前移 / 路径逃逸 / Windows junction / 空间不足 |

## Acceptance Criteria

- [ ] AC1 普通干净主检出冲突并成功 abort 后 status 为空、无 MERGE_HEAD；强制合并恢复原有改动。abort/restore 失败显式报错并阻断，绝不伪报干净。
- [ ] AC2 冲突后用户可在完成弹窗一键进入合并视图；进入后 Worktree 内出现 diff3 标记冲突现场，主检出不受影响。
- [ ] AC3 合并视图左右双栏纵向严格对齐，滚动任一侧两侧同步位移，无漂移；不出现两个独立滚动条。
- [ ] AC4 左栏选择写入目标分支内容，右栏写入 Worktree 内容；部分块仅保存草稿，全部确认后才能暂存；对称 modify/delete 选择缺失侧正确删除。
- [ ] AC5 lockfile 与二进制文件在列表中不渲染逐块入口，并有明确说明文案。
- [ ] AC6 有 unmerged entries 但无标记时不显示无冲突，按能力降级；有标记 add/add 正常解析，不按冲突类型一律禁用。
- [ ] AC7 解决完成回到完成弹窗重新合并可正常完成，随后清理流程不变。
- [ ] AC8 完成弹窗内容区在长文案下可滚动；窗口高度不足时底部按钮仍可达（#269）。
- [ ] AC9 stash 恢复类错误继续禁用危险按钮，按钮旁有常驻可见原因，并补齐 title/aria；取消可用，关闭重开不会绕过后端安全检查。
- [ ] AC10 Worktree 目录缺失时进入合并视图被拒绝并给出明确提示，不产生 Filesystem 误操作。
- [ ] AC11 新增原生 `worktree-conflict` 标签类别，不新增外层工作区标签栏；现有终端/文件内容正常显示，冲突标签不创建/关闭 PTY、不参与终端恢复，切换保留草稿，关闭失败保留界面，Esc 不退出。
- [ ] AC12 `zh-CN` / `en-US` 文案齐备，无缺失 key。
- [ ] AC13 关闭不 abort；已保存块草稿、已暂存文件及总进度关闭/重启后可恢复。未保存修改提示保存或明确放弃；恢复入口在普通 review/commit 之前。
- [ ] AC14 冲突态页脚主按钮为「解决冲突」，`取消` 仍在其左侧；弹窗内不存在终端入口按钮。按钮及说明文案中不出现「降级」「合并视图」等实现术语。
- [ ] AC15 合并视图的栏头、按钮、进度文案均使用**实际分支名**，不出现「左侧/右侧」「ours/theirs」。
- [ ] AC16 模态层卸载后才打开面板，键盘焦点可用；关闭/continue 后恢复原 Worktree 的完成上下文；compact 与外部终端同样可用。
- [ ] AC17 外部 merge、HEAD/MERGE_HEAD/index/文件指纹变化、过期会话、多窗口重复写入均拒绝旧写入且保留现场；不自动接管或 abort。
- [ ] AC18 路径遍历、绝对路径、Windows 前缀/ADS、Git 元数据、symlink/junction 与缺失父目录逃逸测试全部拒绝，未修改工作区之外文件。
- [ ] AC19 BOM、CRLF/LF、无尾换行、Unicode、重复块往返无损；不支持编码、超长行、大文件或畸形标记只读降级，无截断保存。
- [ ] AC20 部分暂存、全部暂存、写成功但 add 失败、空间不足、崩溃、commit hook 失败/成功响应丢失均可恢复，进度与 Git 一致。
- [ ] AC21 普通 stage-all/commit 在未完成 merge 时拒绝；专用 continue 拒绝未经确认的 marker 结果，并校验双父提交及 merge 状态清理。
- [ ] AC22 目标分支前移时不丢提交、不强推；重新合并如有新冲突可重入新一轮，普通/强制合并原有规则不变。
- [ ] AC23 大规模列表、编辑上限、快速切换、托盘恢复和重复打开的性能实测满足设计 §8；保留耗时/挂载量/内存/并发证据，无浏览器不算通过。
- [ ] AC24 独立 strict 架构检查、定向前后端测试、类型/构建检查和中英文实机检查通过；新增模块拆分，不向临近 2000 行的文件继续堆叠实现。
- [ ] AC25 所有 R/AC 均映射到可执行测试，实际结果与方案阶段区分；关键失败或未验证项存在时不得宣称功能性能正常或进入交付。

## 2026-10-07 · 冲突块状态交互修订（用户已确认）

- 采用 JetBrains 式分层状态：逐块选择或手动编辑即更新块解决进度；当前文件全部块处理完自动显示“冲突已解决”，保留继续编辑能力。
- 用户明确选择：点击“应用结果”才写入文件；不自动确认、暂存或切到下一文件。
- 文件列表区分已解决待应用与已应用，全局进度明确为已应用文件数；保存/应用失败不得提前计入已应用，仍使用原重检与错误处理。
- 中英文一致，窄窗口提示/按钮可换行。原生 Monaco/WebView2 与完整 Git 合并仍属原任务未完成验收。

## 明确不做（范围外）

- 不实现自动对所有文件统一 ours/theirs 的无人确认解决；不影响用户逐文件明确选择实际分支的整取动作。
- 不做「让 AI 解决」按钮；已有侧栏终端功能保持原样，不作为本轮新增弹窗按钮。
- 不在应用内实现自研 diff3 引擎——三方合并交给 git。
- 不为 WSL / SSH Worktree 增加支持。
- 不改动普通合并与强制合并在 `dirty_main_worktree` 上的既有行为。
- 不自动处理外部创建的 merge/rebase/cherry-pick，不自动修复用户仓库；不支持的文件类型保留现场并给出原因。
- 不新增 SQLite 迁移；编辑器复用既有 Monaco 依赖。新增的原生冲突标签仅是视图类型，不创建终端进程；工作区恢复仅限本功能的 Gitdir 元数据和草稿。
