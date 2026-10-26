# 验证记录（1.4.4）

## 根因与交付边界

Tap 对话刷新原先由 PTY 输出唤醒，固定等待 2 秒，再读取完整历史详情并在前端裁剪；长日志的重复解析、跨桥传输及旧轮次重复渲染叠加，且最后一次 PTY 输出后才落盘的正文可能没有唤醒信号。本轮在日志读取、通知/调度和对话渲染三层修复，不更改原生 PTY 输入、审批、尺寸或桌面光标策略。

## 发现清单复核

| 触点 | 结果 |
| --- | --- |
| `webManagement.executeTerminalTranscript` → 新 IPC → history live reader | 已接入真实入口；读取前后校验项目、Worktree、PTY、CLI ID、来源和 cwd；不是新增未调用的缓存 |
| live reader / projection / canonical parser | 复用规范解析；每项最多保留 40 个源消息位置、1 MiB 投影，单行最多 8 MiB，响应小于 512 KiB；最多 4 项，2 个并发读取许可 |
| history discovery / source scope | 精确 UUID 文件匹配与 canonical root 限制，歧义拒绝；不回退到同 cwd 的其他会话 |
| Web bridge operation lanes | 仅 transcript 可在两条只读 lane 并发，其他操作保持顺序；128 项有界去重；原生队列使用 snapshot，未接纳项目仍留在 native pending，非丢弃式 drain |
| 文件观察器 → Web device/helper → server → browser | 无正文/路径的会话失效通知；设备 HelloOk 与网页查询参数双向协商；保留用户、移动设备 scope、会话认证检查 |
| Tap workspace / Conversation / turns | 400ms 合并、单飞及尾随刷新；5 秒 revision 续租/兜底；隐藏/离开不续租，12 秒租约过期后观察器清理；旧主机不连续全量轮询 |
| Tap 轮次/工具/搜索/翻页 | 稳定复用未变化消息和轮次，折叠过程首次展开才挂载；保留展开状态、搜索命中和阅读锚点 |
| 经典 Web socket consumer | 忽略 Tap 专用通知，不把它当作普通事件或 PTY 输出 |
| 普通 history detail/catalog/stats、Native Terminal renderer、供应商 | 已确认不改其实现和业务语义；规范 transcript 解析做兼容回归 |
| NSIS 与 Web/Tap 资源 | 复用既有完整本地缓存构建；本轮 Rust 有改动，不能只换前端冒充完整修复；实包校验结果交付后补记 |

GitNexus 工具本会话未暴露，按契约降级到 codebase-memory 与源码。2026-10-26 刷新 moderate 索引成功（45,144 节点、117,057 边），关键新符号可检索。`executeTerminalTranscript` 的上游是共享 `executeWebManagementOperation`（CRITICAL）和 `executeOperation`（HIGH），风险已提示。`detect_changes(scope=all, depth=2)` 仅列出 25 个已跟踪修改，遗漏新增文件且 impacted_symbols 为空；不以此认定无风险，新增文件与实际调用关系通过 Git diff、源码、编译和执行测试逐项复核。

## 自动验证

- `npm run tap:test`：117/117 通过，涵盖新旧主机、单飞、延迟落盘、隐藏/可见、设备代次、消息稳定引用及原有搜索/工具/滚动/输入测试。
- `node --test scripts/webOperationLanes.test.mjs src/features/terminal/lib/webTerminalTranscript.integration.test.mjs src/features/terminal/lib/webTerminalTranscript.test.mjs src/shared/lib/webBrowserSocket.test.mjs`：16/16 通过，包含独立 lane、错误释放/容量、精确绑定及 I/O 期间重绑保护。
- 桌面 `npx tsc --noEmit`、`npm run web:typecheck`、`npm run tap:typecheck` 均通过；桌面和 Web/Tap 生产构建通过。
- `cargo test --manifest-path apps/server/Cargo.toml --lib`：59/59 通过，包含浏览器设备 scope、认证与 listener 生命周期回归。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib web_daemon::tests`：15/15 通过。
- Rust `live_transcript`：6/6 通过；半行/UTF-8、无换行尾部、截断重置、错误 ID/cwd/根范围、歧义定位、有界响应、旧页、最后落盘通知与租约过期。
- Rust canonical `transcript_activity`：4/4 通过；web-protocol：8/8 通过。
- `node scripts/verifyTapTranscriptProjection.mjs .codex/tap-transcript-fixture.json`：Claude/Codex × 普通/详细模式共 4 组跨语言差分通过，与原 TS 投影一致，不输出加密 reasoning/signature。
- `node --test scripts/tapTranscript.browser.test.mjs`：隔离 Edge/Chromium 浏览器通过；390px 中文及 1280px 英文，走真实 Conversation 与 socket adapter，模拟最后日志通知，旧 DOM 无 mutation、展开状态保留、旧页可加载，无页面错误。
- `npm run check:architecture -- --strict`：1,427 个源码文件，0 个超过 2,000 行，0 个新违规；新 Rust reader/projection/测试定向 rustfmt 检查通过；`git diff --check` 通过。

## 性能证据与限制

隔离合成 Claude 日志 20,000 条、8,308,890 字节，Rust debug 构建最近一次测量：原全量扫描约 1,661ms，新路径首次扫描约 1,489ms；首次仍需要扫描，不能声称大幅加速。热路径 20 次未变化检查共约 2.1ms，正文与指纹读取量均为 0；追加 234 字节时约 0.36ms，只读新增 234 字节正文及不超过 320 字节指纹，而非重读 8.3MB。结果为本机样本，不是延迟 SLA。

隔离浏览器设置 25ms 合成桥接 RTT，日志通知至 DOM 可见中文 840.5ms、英文 824.0ms，包含 400ms 合并窗口及真实浏览器渲染；未变化旧轮次 DOM mutation 为 0。1,000 轮中仅末轮变化时复用 999 个轮次；不把分组微基准当作端到端渲染提升比例。

未使用真实用户会话正文做压力测试，未安装/启动用户应用、重启服务或修改供应商。未完成真实 iPhone Safari、跨网 RTT、真实 CLI 落盘延迟和 WSL 实机测量；WSL 沿用已有来源发现边界。原生彩色终端与文本重排的帧率未在本轮作实机对照，该独立渲染卡顿不声明已修复。同文件互斥、缓存总项数和租约基于实现与定向测试复核，不宣称做过完整生产多浏览器压力测试。

## 发布与回滚

沿用 1.4.4，先提交功能/测试/契约/记录，再仅构建 NSIS；不推送、不自动安装。无需数据迁移或新配置，旧主机和旧网页按能力协商保持兼容；整包回退到此前备份的 1.4.4 NSIS 即可回滚代码。真实 Safari 验收由用户安装后进行。

## NSIS 实包结果

- 源码提交：`4fc1e018db6d8595dbb1ec0c7714df012e478671`；工作区干净后执行 `npm run tauri:build:local -- --bundles nsis`，仅生成 1 个 NSIS 包，不生成 MSI。
- 安装包：`src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.4.4_x64-setup.exe`，31,641,299 字节，2026-10-26 10:19:30 +08:00。
- SHA256：`0C4176E8BEB8E489242F95C243650A2DE5270FEAF087BC662976E487966D05DC`。
- 完整构建包含本轮 Rust 主程序及 3 个 helper；主程序 release 3m28s、helper 6m27s，非复用旧后端换壳。构建仅有既有 chunk 大小、标识后缀、STATIC_VCRUNTIME 弃用和 linker 信息警告。
- 7-Zip 完整性测试及非安装式解包通过；19 个 Web/Tap 资源（含 15 个 Tap 文件）的相对路径和 SHA256 与本轮产物逐项一致，11 个 HTML/CSS/manifest 引用均存在。
- 主程序及 3 个 helper 与 release 产物字节核对通过；主程序仅允许并验证 Tauri 的 `__TAURI_BUNDLE_TYPE_VAR_` 标记在安装包为 `NSS`、构建目录为 `UNK` 的 3 字节差异，其余完全一致。
- 已核对包生成时间晚于本轮开始、SHA256 与备份旧包不同且构建源码提交不变。详细构建、完整性、解包日志及 JSON 指纹在本地 ignored `.codex/tap-transcript-*`，未安装或启动产物，等待真实 Safari 验收。

## 补充验证：手机阅读与原生视口

- 隔离复现原问题：390px 手机和短 PC 面板均已解析全部 67 行，但可见高度约 640px、原生屏幕约 1,072px，末行 DOM/正文存在却被裁在可见底边之外。不是正文只传输了一半；不以增大传输字节量解决显示裁剪。
- `npm run tap:test`：120/120，通过新增双向滚轮/单指触摸、缩放透传、手动滚动暂停/恢复、内层历史不回拉及清理测试；原生命令测试接入真实视口辅助函数，仍只发送一次前缀、不带回车。
- `node --test scripts/tapTerminal.browser.test.mjs scripts/tapTranscript.browser.test.mjs`：2/2，通过真实 Terminal/stream/frame encoder/xterm 及原有 Conversation/socket 回归。390px 与 1800px、191×67 网格末行完整可见，桌面 resize 调用始终为 0；同时覆盖窄屏长单词无横向溢出、手动上滚、字号/高度、隐藏恢复、双向触摸、原生菜单/直接键入及恢复、中英文按钮、显式选择跨视口保持、手机小网格默认重排与 Web-owned fit。
- Tap 类型检查和生产构建通过；独立 strict 架构检查 1,431 个源码文件、0 超限、0 新违规；`git diff --check` 通过。没有 Rust、桌面/经典 Web 源码变更，不重跑无关全量 Rust 构建。
- 试验发现单测假 DOM 不会像浏览器一样夹紧 scrollTop，已修正夹具；旧命令测试补齐新依赖及 rAF 调度。随后测试还发现程序化滚动标记未消费会误判用户回到底部，已修复并由暂停/恢复用例覆盖。不是删除失败断言绕过测试。
- 浏览器为隔离 Edge/Chromium；真实 iPhone Safari、原生软键盘、惯性触摸尚待用户实机测试。测试的触摸为浏览器合成事件，高度变化模拟键盘挤占，不等于真机验证。未写入用户 PTY 或启动桌面应用。
- 前端源码提交、NSIS 解包及复用后端哈希核对结果于打包后追加。
- 增强浏览器断言同时要求原生容器非 hidden，避免把隐藏层的正确几何当作可见；显式选择原生后再测字号/高度。真实 xterm 额外写入 90 行后，外层顶部继续滚轮可进入原生历史；小网格自动模式覆盖触摸横屏及桌面/手机视口往返。最后单独终端浏览器回归再次通过。

### 前端重新封装 NSIS 结果

- 先提交 `d8fdf36b4317462dd4b55c552a0c9be25a9a14fe`，干净工作区运行 `npm run tap:build`，然后用官方 `tauri bundle --bundles nsis` 封装既有 release 主程序，不编译 Rust。`CARGO_TARGET_DIR=src-tauri/target/local`；叠加既有 `tauri.local.conf.json` 和本地 ignored 配置，仅将 `beforeBundleCommand` 置 null，避免重复构建未修改的 helper；正式打包配置不变。
- 停用 helper 构建前已核对主程序、3 个 helper 与上一轮已验证 NSIS 完全一致（仅主程序 release 的 UNK / NSIS 的 NSS 标记区别）；既有 4 个经典 Web 资源也与旧包一致。旧安装包完整备份并核对 SHA256 后才覆盖。
- 安装包：`src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.4.4_x64-setup.exe`，31,644,365 字节，2026-10-26 11:15:07 +08:00。
- SHA256：`472B12C9F42AA879720AEA4868A7ECF96979DB790AF9C5F30C150FD5B80B4ED2`，与前一包不同，生成时间晚于本轮开始。
- 7-Zip 完整性测试及非安装式解包通过；19 个 Web/Tap 文件（其中 Tap 15 个）的路径/哈希逐项匹配本轮产物，11 个 HTML/CSS/manifest 静态引用存在，经典 Web 4 个资源未变。
- 新旧两个 NSIS 中的主程序和全部 3 个 helper 字节完全相同，证明复用 `4fc1e018` 后端；打包前后 release 原始 SHA256 均未变，仅新 Tap 资源替换。主程序构建目录/NSIS 之间仍仅有已验证的 NSS/UNK 3 字节标记差异。
- 解包与详细指纹在 ignored `.codex/tap-viewport-nsis-*` 和 `.codex/tap-viewport-package-verification.json`。仅交付 NSIS，不生成 MSI；未安装、未启动用户应用、未推送。用户需安装后刷新网页，真实 Safari 验收仍未完成。
