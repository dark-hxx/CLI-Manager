# 设计与影响

## 根因

Tap 的模块命名跨越 Windows 大小写不敏感文件系统与 TypeScript 扩展名解析边界：`TurnRail.tsx` 和 `turnRail.ts` 的模块名仅大小写不同，`./TurnRail` 优先匹配到工具模块 `.ts`，触发 TS2305/TS1261/TS1149。修复应消除命名歧义，而非关闭大小写检查或跳过 Tap 打包。

## 最小方案

将组件文件原样移动为 `ConversationTurnRail.tsx`，保留 `TurnRail` 导出及 `turnRail.ts` 工具模块，更新对话页和测试依赖的组件模块路径。不改任何函数或交互。

## 发现清单

- [x] `apps/web-tap/src/TurnRail.tsx`：文件移动，内容完全保留。
- [x] `apps/web-tap/src/Conversation.tsx`：唯一生产调用入口，仅更新导入路径。
- [x] `activity.test.mjs`、`conversation.test.mjs`、`timeline.test.mjs`：更新组件模块 mock 路径。
- [x] `turnRail.ts`、`turnRail.test.mjs`、`turnRail.css`：纯逻辑及样式引用正确，与修改无关，保持原样。
- [x] 根 `web:build`、Tap tsconfig：经典 Web → Tap 构建顺序正确，不修改。初轮对 Tauri 资源封装的判断仅依据配置与构建成功，未验证安装目标层级，已被下述实机结果纠正。
- [x] 桌面、经典 Web、Rust、协议及 Unicode 行为：无调用路径或行为调整，保持原样。

## 影响分析与工具降级

GitNexus MCP 未暴露；按契约降级为刷新后的 codebase-memory 索引、Web Service Contracts 和定向源码检索。修复前索引识别 `TurnRail` 为导出的 memo 组件变量，但未给出 JSX 调用方，已人工复核 `Conversation` 的实际 JSX 和三个测试依赖表。修复后重新索引识别到唯一直接调用方 `Conversation`，工具按直接调用关系标为 CRITICAL，已向用户告知；实际变更仅模块路径，组件内容哈希完全一致，类型检查和 113 项测试通过，无桌面/后端调用影响。

## 场景与回滚

大小写敏感与不敏感平台均采用不歧义路径；测试 harness 与生产模块解析同时更新。窗口焦点、分屏、CLI、Hook 与移动端交互不受文件移动影响。回滚本提交即恢复文件及引用，无数据迁移。未修改模块业务或传输契约，现有类型检查规则仍保持启用，无需另增业务契约。

## 追加：资源封装根因与方案

Tauri 的资源映射把 glob 匹配的每个文件按文件名直接放入目标目录；`../apps/web/dist/tap/**/*` 因而丢失 `assets/`、`fonts/` 层级。`/tap` HTML 能返回，但它引用的脚本与 CSS 404。修复将 glob 改为源目录映射，由 Tauri 的目录遍历保留相对路径，不能在服务端新增错误路径兜底或改前端引用规避。

已核对本机实际使用的 `tauri-utils 2.8.3`：`ResourcePaths::resource_from_path` 的 Glob 分支只保留文件名，Walk 分支保留相对目录。在现有本地打包 Node 测试中固定目录映射契约，再用真实 NSIS 解包结果验证目录和内容，不复制打包器实现、不增加 Rust 测试编译和依赖。

### 追加发现清单与影响

- [x] `src-tauri/tauri.conf.json`：仅替换 Tap 的资源源路径，目标目录不变；影响正式/本地 Tauri 产物中的 Tap 文件布局。
- [x] `apps/web/dist/tap`：构建产物层级正确，无需改 Vite base、HTML 或 CSS。
- [x] `apps/server/src/lib.rs`：`/tap/assets` 对应 `tap/assets`，路由正确且缺失资源应继续返回 404，不修改。
- [x] `F:\cli-manager\apps\web\dist\tap`：用户安装版确实没有 assets/fonts 子目录，文件被平铺；仅读取，不修补生产安装目录。
- [x] 经典 Web、ConPTY、SSH Agent、卸载钩子及 helper 映射：本轮不修改。
- [x] 回归测试与实际 NSIS 解包：配置回归防止平铺 glob；解包逐项比对构建源树，缺失、错误路径或内容不符均判失败，不启动安装器或用户应用。

GitNexus 未暴露，codebase-memory 索引排除了 scripts，配置映射也不是可调用符号；按契约及真实依赖源码、安装文件与 HTTP 证据完成影响复核。没有修改既有函数或方法，无业务调用链变更。运行位置（源码构建树/安装后资源树）是触发条件，测试必须覆盖资源布局，而不是仅覆盖源码目录。焦点、分屏、CLI、Hook 状态与此问题无关。

本轮只有封装映射与测试/文档变化，桌面、经典 Web、Tap 与 Rust 业务源码均与上轮完整构建一致。使用官方 `tauri bundle` 加原本地配置，在 `CARGO_TARGET_DIR=src-tauri/target/local` 下直接复用已验证的 1.4.4 二进制和前端产物；该命令重新读取当前资源映射、执行既有 beforeBundleCommand，仅封装 NSIS，不重新编译未变代码。
