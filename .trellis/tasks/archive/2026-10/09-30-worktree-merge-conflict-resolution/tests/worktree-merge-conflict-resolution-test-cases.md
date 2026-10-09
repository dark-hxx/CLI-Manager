# Worktree 冲突解决 — 验收用例

## 执行约定

- 本文件是实施后的执行清单，所有用例当前状态均为 **NOT_RUN**；方案阶段隔离 Git 实验单独记录于 `../validation.md`，不能替代这里的产品测试。
- P0=数据安全/核心闭环阻断，P1=必要功能/性能/工程门槛。两级全部属于本轮交付 gate，不因优先级不同省略。
- 基础 fixture：临时主仓库分支 main + 注册的 linked Worktree feature，双方在共同祖先后产生提交；每个用例独立复制/生成，记录起始 HEAD、status、index、工作文件字节、stash OID。不得对开发者真实仓库注入故障。
- Git 测试固定 config、禁止隐式用户 hooks/filter；涉及 hook/filter 用例显式安装测试专用脚本。Windows 路径、reparse、WebView2 用例在真实 Windows 执行；条件缺失记 BLOCKED，不记 PASS。
- 每项记录：用例ID、build/commit、环境、实际步骤/结果、日志/截图/采样文件、最终Git状态、PASS/FAIL/BLOCKED。表中“预期”包含后置检查。
- 表内 `R` / `AC` 引用 `../prd.md`；预算引用 `../design.md` §8。每次故障先检查未知文件/非目标仓库未变化。

## 功能与格式

| ID / 优先级 | 覆盖 | 前置与步骤 | 预期及后置检查 |
|---|---|---|---|
| TC-F-001 / P0 | R1, AC1 | 主检出干净；通过普通完成合并制造冲突，等待返回，再读 status/HEAD/MERGE_HEAD。 | abort 成功后主检出恢复原 HEAD、status 为空、无 MERGE_HEAD；返回冲突而非成功合并。 |
| TC-F-002 / P0 | R1, AC1 | 主检出分别有 staged、unstaged、untracked；强制合并冲突并正常恢复。 | 原修改与暂存语义恢复，保留 stash OID，不因恢复后的原改动误报 dirty 错误，不自动 drop。 |
| TC-F-003 / P0 | R2, R4, R12, AC2, AC4, AC15 | a.txt 两侧分别写 BASE 和 WORKTREE；prepare 后打开，选择目标分支或 Worktree 各跑一份 fixture。 | 左栏 BASE/stage3，右栏 WORKTREE/stage2；保存内容与所选真实分支相符，按钮/进度不显示 ours/theirs/左侧右侧。 |
| TC-F-004 / P0 | R4, AC4 | 同一文件含3个冲突块和公共片段，执行整取任一存在侧。 | 工作文件、index OID/mode符合该侧及Git过滤语义，公共片段不会从另一侧混入；仅该文件暂存。 |
| TC-F-005 / P0 | R4, R18, AC4, AC21 | 3块仅选择2块并保存草稿，再尝试 finalize；最后确认第3块。 | 前半程工作文件/index原样，finalize拒绝；全部确认才精确暂存并记receipt，进度只加1。 |
| TC-F-006 / P0 | R4, R18, AC4, AC19 | 单块手动编辑Unicode并确认；源含BOM/CRLF/无末尾换行，另做LF和重复相同块fixture。 | 块ID不串选；未编辑区域逐字节相同；BOM、换行、尾换行保持，输出符合编辑内容。 |
| TC-F-007 / P1 | R7, AC5 | 列出 package-lock.json、pnpm-lock.yaml、yarn.lock、Cargo.lock及含NUL的binary；逐个打开。 | pending阶段不开放块编辑，后端分类后只提供合法整取与说明；binary字节不塞入详情JSON。 |
| TC-E-001 / P0 | R8, AC4, AC6 | base删/feature改与feature删/base改各一份；分别选择存在侧和缺失侧。 | 两种缺失侧都删除并精确暂存，存在侧恢复正确版本；不checkout不存在stage，不留下unmerged。 |
| TC-E-002 / P1 | R8, AC6 | add/add分别生成有标记和无可解析标记两种现场。 | 有标记正常块编辑，无标记按实际capability降级；不按add/add类型一律拒绝或判无冲突。 |
| TC-E-003 / P0 | R8, AC6 | 在unmerged index仍存在时，外部工具移除工作文件标记；重新probe/detail。 | 仍是冲突；有外部修改判stale，没有可解析块时只给安全降级；不能伪报已解决。 |
| TC-E-004 / P0 | R8, R16, AC6, AC18 | 构造rename/rename组、symlink mode120000、gitlink160000。 | external_only且说明原因，不暴露无法执行的整取按钮、不部分处理路径组、原状态不变。 |
| TC-E-005 / P0 | R6, R18, AC19 | 分别输入非UTF8、混合换行、畸形/嵌套/未闭合标记，尝试编辑保存。 | 非支持格式不可写入截断/重编码结果；混合换行不能无损编辑则禁用手动；整取可用性准确。 |
| TC-E-006 / P1 | R8, R18, AC19 | 两段、diff3、attributes conflict-marker-size=11；公共区含合法类似marker文本。 | 正确识别原始块/ancestor/两侧；合法公共文本不误杀；新增未处理冲突文本不得当确认结果提交。 |
| TC-E-007 / P0 | R6, R18, AC19, AC23 | 对2MiB、20k行、64KiB单行、2000块、8MiB JSON各造边界-1/边界/边界+1，并测试编辑后扩容及大量JSON转义。 | 各阈值独立生效；超限返回不可编辑元数据，源和输出都检查，无“截断但可保存”路径。 |
| TC-F-008 / P0 | R14, R18, AC21 | resolving中调用普通stage-all/commit；再用外部Git add-all暂存marker后调用专用continue。 | 普通命令后端拒绝，不仅UI禁用；专用continue因缺receipt/未确认块拒绝；正确完成后双父OID和tree匹配。 |
| TC-F-009 / P0 | R19, AC7, AC22 | Worktree完成本轮后，在目标分支改相同行并提交，再执行完成合并。 | 保留双方新增提交；若冲突主检出先安全abort，再针对新OID新建会话；无强推/旧receipt复用。 |
| TC-F-010 / P1 | R10, R11, R13, AC8, AC9, AC14 | 400px高窗口显示长路径/长错误，鼠标和键盘滚到底部。 | body可滚动、footer可达；取消在解决冲突左侧，无终端按钮；禁用按钮旁有常驻原因和可访问名称。 |
| TC-F-011 / P1 | R3, R5, R15, AC3, AC16 | 普通/compact/分屏/Sidebar/外部终端逐个进入；多行块+手动编辑+窗口缩放并滚动首中末。 | 所有入口可达同一App host；只有一个纵向容器，左右行对齐，无互抄scroll、块高度错位或选区丢失。 |
| TC-F-012 / P1 | R12, AC12, AC14, AC15 | 设置切zh-CN/en-US，遍历正常/错误/降级/aria/进度/恢复重检及长分支名。 | 无硬编码/缺key；真实分支名准确，不暴露实现术语；时间仍24小时，长文案不遮按钮。 |
| TC-F-013 / P1 | R9, R20, AC11, AC24, AC25 | strict架构、定向测试、类型/构建、Rust编译、跨层契约检查，并核对实际执行数。 | 无新增TerminalSessionKind/SQLite/依赖/架构豁免；手写文件≤2000行；零匹配测试和未执行gate不能记PASS。 |
| TC-F-014 / P1 | R14, R15, AC2, AC16, AC24 | 从真实Tauri前端调用每个新增IPC，对照Rust注册名/参数和错误分支。 | 无unknown command/参数错名；错误typed code可识别；普通非merge的stage/commit调用者行为不回归。 |
| TC-F-015 / P0 | R1, R19, AC7, AC22 | Worktree continue成功但主检出未合并/恢复失败时点击清理；再完整成功后重试。 | 前者拒绝且文件/分支保留；后者沿用已合并、stash恢复、注册身份等既有清理条件。 |
| TC-F-016 / P0 | R1, R11, R17, AC1, AC9, AC20 | 恢复错误后关闭/重启；执行只读重检；分别测试自动证明恢复、外部手动恢复、仍有unmerged。 | 重开不解禁；可证明安全才解除，无法证明需显式确认原改动且保留诊断；未完成操作仍拒绝；不apply/drop/remerge。 |
| TC-F-017 / P0 | R18, AC19, AC20 | 文件有clean/smudge过滤、CRLF属性/可执行位，分别整取/块解；注入filter失败。 | 与Git checkout/add语义一致；无法安全保持则降级；失败不记receipt，不能手写blob绕过filter或损坏mode。 |
| TC-F-018 / P0 | R1, R2, R17, AC2, AC10, AC17 | prepare前Worktree有staged/unstaged/untracked阻挡、目标无变化/已祖先/可快进；分别调用。 | 脏或外来操作拒绝且不自动stash；noop/ff/成功按实态返回，不伪造冲突面板；起点OID变化拒绝旧请求。 |

## 恢复、并发与失败

| ID / 优先级 | 覆盖 | 前置与步骤 | 预期及后置检查 |
|---|---|---|---|
| TC-ERR-001 / P0 | R1, R11, AC1, AC9 | 故障注入让普通主检出abort失败，再点击解决冲突/合并/清理，关闭重开。 | 明确recovery_required，所有危险路径后端拒绝；保留现场和诊断，不报告主检出干净。 |
| TC-ERR-002 / P0 | R1, R11, AC1, AC9 | 强制合并后注入stash restore失败；退出应用后重新进入。 | 保留stash OID、恢复闸门；禁用理由常驻；取消/重检可用，不因临时UI state重置绕过。 |
| TC-ST-001 / P1 | R15, AC13, AC16 | Radix完成弹窗点击解决冲突后Tab/Escape，再关闭面板；过程中原finishTarget被父级清空。 | 弹窗先卸载，焦点/inert解除，显式上下文保留；返回原Worktree步骤和合理焦点，无被遮挡的不可交互面板。 |
| TC-ST-002 / P0 | R9, R18, AC13, AC20 | 3块保存2块草稿，关闭并重启；同时测试保存失败时关闭选择取消/明确放弃。 | 已保存选择恢复，工作文件/index仍未stage；未保存修改不静默丢失，放弃只影响未保存部分。 |
| TC-ST-003 / P0 | R9, R14, R18, AC13, AC20, AC21 | 先解决部分文件重开，再全部stage但未continue时重启。 | 总数不因ls-files-u缩小；先probe并恢复正确resolved/ready，绝不跳普通commit/直接主合并。 |
| TC-ST-004 / P0 | R17, AC17 | 外部启动merge/rebase/cherry-pick；或有MERGE_HEAD但无/损坏本应用清单。 | foreign/recovery_required，禁止接管/覆盖/自动abort；显示可理解诊断。 |
| TC-ST-005 / P0 | R17, R18, AC17 | 打开详情后分别外部改HEAD、MERGE_HEAD、同mtime文件字节、stage OID；发旧save/take/finalize。 | CAS拒绝，外部改动保留，旧UI结果不覆盖；不能只按mtime判断。 |
| TC-ST-006 / P0 | R17, AC17 | 两窗口/两实例同时保存同文件或continue；重复同operationId，同ID换payload；另建index.lock。 | 写操作串行/明确busy或stale；同ID幂等且不同payload拒绝；不删除外部锁、不重复提交。 |
| TC-ST-007 / P0 | R17, R18, AC20 | 在prepare intent后、merge后、文件写后、stage后receipt前各故障退出。 | 重启按Git+intent证明完成阶段；可证明才reconcile，不确定进入恢复态；不会重复merge或丢失原始集合。 |
| TC-ERR-003 / P0 | R18, AC20 | 原子替换时磁盘满/权限拒绝；写成功后git add失败；草稿替换失败。 | 旧完整清单可读，dirty保留，未成功stage不增加进度；写后失败有恢复日志且不自动覆盖外部修改。 |
| TC-ERR-004 / P0 | R19, AC20 | 全部确认后安装失败pre-commit/commit-msg hook并continue，再修复hook重试。 | 显式失败、保留ready和receipt；不绕过hook，不误标completed；重试成功是双父提交。 |
| TC-ST-008 / P0 | R17, R19, AC20, AC21 | 提交成功后丢IPC响应/manifest更新，再同ID重试或重启。 | 校验tree和双父OID证明完成，只读补记，不产生第二次提交；不能仅HEAD变了就认成功。 |
| TC-ST-009 / P0 | R17, R18, AC17, AC20 | 自有受管冲突调用abort；另做外部修改介入或foreign后调用abort。 | 自有且未含未知改动恢复起点并记aborted；其余拒绝，不能reset/删除未知文件；关闭面板本身不abort。 |
| TC-ST-010 / P1 | R6, R17, AC17, AC23 | 控制响应顺序A→B→A，切换100次、刷新100次，慢内容请求在关闭后返回。 | 在途内容峰值≤1（含后端实际工作）；epoch拒绝旧响应、关闭释放，不以仅前端忽略假装取消。 |
| TC-ST-011 / P0 | R17, R18, AC17, AC20, AC21 | 部分receipt后外部改已解决文件/index，或将无关文件stage，再continue。 | 完整语义index比较发现偏离；不得混入无关改动或沿用过期receipt。 |
| TC-ST-012 / P1 | R9, R15, AC13, AC16, AC17 | 面板打开期间删除项目/Worktree记录或改变选择，关闭/continue返回。 | 原上下文不能串到新对象；后端身份校验拒绝，UI提示已不可用并安全收回焦点。 |

## 文件安全

| ID / 优先级 | 覆盖 | 前置与步骤 | 预期及后置检查 |
|---|---|---|---|
| TC-E-008 / P0 | R16, AC18 | 直接IPC提交伪造fileId、../、绝对/drive-relative、UNC/device、ADS、NUL、.git/common-dir路径。 | 拒绝不在原始集合的ID及不安全路径；工作区外/Git元数据的预置canary字节不变。 |
| TC-E-009 / P0 | R16, R17, AC18 | 文件/父目录为symlink/junction/reparse；文件缺失且最近父目录越界；校验后替换路径再写。 | 实际路径校验及复核拒绝或保守恢复，不写出根目录；记录外部TOCTOU不能绝对消除的边界，不伪称应用锁控制外部进程。 |
| TC-E-010 / P1 | R16, AC18, AC19 | 合法文件名含空格、Unicode、前导-、括号、pathspec通配符；整取和删除。 | NUL协议+literal参数仅处理指定文件，其他同名模式匹配文件不变，无shell插值。 |
| TC-E-011 / P0 | R16, R17, AC10, AC18 | 删除/移动Worktree目录，伪造同名目录/分支，登记关系不匹配，共同仓库不匹配。 | 注册三参与canonical身份校验拒绝，未知目录内容不变，不仅检查exists。 |

## 性能与覆盖闸门

所有性能项遵守design §8采样和硬件记录要求；数据规模/上限是验收输入，不是虚构实测。

| ID / 优先级 | 覆盖 | 前置与步骤 | 预期及后置检查 |
|---|---|---|---|
| TC-P-001 / P1 | R6, R20, AC23, AC25 | 1k/10k/64,887元数据项，520px视口；分页滚动首中末并测真实Git枚举与前端渲染。 | ≤40挂载行（最多额外1焦点行）；各页可达，计数正确；元数据返回→交互p95≤500ms，另记端到端及峰值内存，无每文件Git进程。 |
| TC-P-002 / P1 | R6, R20, AC19, AC23 | 接近2MiB/20k行/2000块但每项均合法的多组fixture；每组5冷20热打开。 | 请求→可交互p95≤2s，JSON≤8MiB，分项耗时/内存记录；无超限读入后才降级。 |
| TC-P-003 / P1 | R3, R5, R6, AC3, AC23 | 高密度冲突块连续点击/键盘选择、滚动和调整编辑器高度，采trace。 | 选择→绘制p95≤100ms，无应用>100ms长任务；对齐不漂、虚拟边界不重复丢块。 |
| TC-P-004 / P1 | R6, R9, AC13, AC23 | 稳定基线后打开/关闭20次，切文件100次，仪器GC后比较heap、DOM、Worker/listener，并记录WebView2 RSS。 | 堆增量≤max(10MiB,10%)，无线性泄漏；活动缓冲1份、在途内容1个；关闭后无残留订阅。 |
| TC-P-005 / P1 | R6, AC23 | 最小化托盘/失焦隐藏后观察请求，再恢复；大列表Worker取消/超时。 | 隐藏不轮询，恢复单次合并刷新；>5000一次性元数据才用Worker，15s超时按1000条yield，取消不触发回退。 |
| TC-P-006 / P1 | R6, R7, AC5, AC19, AC23 | 大二进制/超长单行/JSON高转义文件打开、整取、取消与重开。 | 降级无巨型内容JSON/DOM；大文件流式处理，取消有明确状态，不阻塞UI或伪造已解决。 |

## 覆盖检查与通过条件

- `R1–R20`、`AC1–AC25` 必须至少出现在一项用例的覆盖栏，ID唯一；新增需求必须同步补用例。
- 每个case用例中的多种变体均需执行，不能用一个成功样本代表整行。
- 所有P0/P1实际PASS且有证据，架构/类型/构建/Rust/语言/实测gate通过，才允许产品交付；FAIL/BLOCKED/NOT_RUN 任一存在均不得宣布功能性能正常。
- 方案阶段只检查矩阵覆盖和 Git 语义；产品实现已获用户批准并进入 P3。实际执行结果统一见 `../validation.md`，浏览器 IPC 替身、Rust 命令级测试和原生 WebView2 验收分别记录，部分变体通过不等于整项用例 PASS。
