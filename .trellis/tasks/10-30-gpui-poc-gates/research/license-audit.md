# 许可证审查进度（2026-10-30）

结论：当前锁定依赖的自动检查通过，声明清单未发现必须选择 GPL-only 的第三方依赖。资源授权和所有发布内容的人工复核尚未关闭；这不是完整发布授权结论，检查点 A 保持未完成。

## 证据与检查范围

- 工程：`spikes/gpui-poc`；声明表：`research/dependency-licenses.md`（897 包：890 外部、7 本地（P7 可选依赖加入前），包含其他平台依赖）。
- 工具：cargo-deny 0.20.2；`cargo deny --format json check licenses bans` 退出 0。
- licenses：0 errors、0 warnings；bans：0 errors、75 warnings（多版本）。默认 feature 图，不是 all-features 的无条件授权保证。
- `deny.toml` 只给七个本地成员 `poc-compat`、`poc-checkpoint`、`poc-input`、`poc-daemon`、`poc-term`、`poc-preview`、`poc-webview-probe` 逐包精确放行 AGPL-3.0-or-later；第三方仍需满足允许列表。禁止引入 `terminal_view` / `terminal` 包。
- 原始 JSONL 为可重建本地附件，忽略入库；保留紧凑 summary。完整声明表不能代替源码/资源证据。

## 逐项判读

| 包/内容 | 源码或声明证据 | 本次判定 |
|---|---|---|
| gpui-pre / sum-tree / ztracing / collections / util / refineable 等快照包 | 发布包中的 LICENSE-APACHE；20 个 0.3.10 包根许可 SHA-256 均为 `752daf2fb234ca4a1fa372c073fe127f44b7b90fd2529ae44273a64f9d53da7a` | 根许可全文核对为 Apache-2.0；仍需分离源码和资源 |
| gpui-component 0.8.1 | LICENSE-APACHE 为 Longbridge Apache-2.0；README 对文档散文及原创插图另述 CC BY 4.0 | 软件根许可核对完成；文档声明未随 registry 包提供，已从该包固定上游 revision 的仓库根取得并核对；声明不等于 CC BY 4.0 法律条款全文 |
| enum-iterator 2.3.0 / derive 1.5.0 | LICENSE 为 0BSD | 增加精确 SPDX `0BSD`，不是包级宽泛豁免 |
| target-lexicon 0.12.16 | LICENSE 有 LLVM exception | 增加 `Apache-2.0 WITH LLVM-exception` |
| r-efi 5.3.0 / 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later | 存在宽松授权选项，不因包含 LGPL 字样判失败 |
| self_cell 1.3.0 | Apache-2.0 OR GPL-2.0-only | 可选 Apache，不是 GPL-only |
| Windows alpha_correction.hlsl / wgpu shaders.wgsl | 头部明确 Microsoft Corporation、MIT，来源固定到 microsoft/terminal commit | 发布 notices 必须单列微软 MIT；包根 Apache 不覆盖独立声明 |
| gpui-kit-assets 0.8.1 图标 | LICENSE-LUCIDE：Lucide ISC + 派生 Feather 图标 MIT（Cole Bemis） | 必须保留两段归属和许可，不能只输出 Cargo 中的 Apache |
| gpui-pre/src/platform.rs 及 apple/vendor 副本 | 1692–1694 行，微软 dwrite.cpp 固定 commit、Microsoft copyright、MIT | 微软来源不限于 shader；纳入同一 MIT notice 清单 |
| gpui-pre-macos/src/display_link.rs | sys 模块引用 BrainiumLLC/display-link 的 LICENSE-MIT | 上游 MIT 快照已保存；原始复制版本未知，保留来源追溯项 |
| gpui-pre-macos/src/platform.rs | 引用 Ghostty PR 8625 | 保存 PR 合并 commit 的 MIT 许可；保留 Mitchell Hashimoto / Ghostty contributors 归属 |
| gpui-pre-linux/x11 | clipboard 声明 Arboard Apache OR MIT；client 引用 winit 0.29.11 | Arboard 可选 Apache；保存 winit 对应 commit 的 Apache 许可，Linux 未在本机编译 |
| Kotlin highlights.scm | 首行说明改编自 tree-sitter-kotlin-sg / nvim-treesitter | 当前组件 features 为空，未启用 tree-sitter；未来启用前补固定来源与授权证据 |
| gpui-pre/examples/svg/dragon.svg | 文件头 CC BY-SA 3.0、Wikimedia 来源 | 示例资源单列；当前构建七成员，不构建 GPUI 示例或把示例复制到产品，不据根 Apache 认定授权 |

## 可重建的资源与 feature 证据

`audit-license-evidence.py` 对锁定的 25 个 GPUI 包扫描 2742 个文本候选文件，记录 32 个含匹配行的文件（含普通注释误报），不把启发式扫描当完整人工审查。新增三份机器可读附件：

- `source-attributions.json`：来源匹配行、包内路径、文件 SHA-256。
- `asset-candidates.json`：1868 个资源/构建候选；其中 106 个来自 default-icons.txt 的默认图标输入、7 个构建定义、6 个示例候选、1749 个其他资源候选。候选不等于最终发布内容。
- `resolved-gpui-features.json`：默认全平台 metadata 图；组件、base、assets 的 features 为空，无 tree-sitter/syntect。它不证明 Windows 专属可达性或二进制链接内容。

`source-review.md` 已逐项记录这 32 个命中的人工判读，并回读上下文、核对全部文件哈希：16 个仅为普通派生说明或测试字符串，另 16 个包含包级声明、独立来源或资源许可线索。组件 README 的文档授权分层已单列；本 PoC 未导入其散文和插图。该进展不等于所有外部依赖的资源已逐文件审完。

Windows release build.rs 使用 fxc 编译 shaders.hlsl 和 color_text_raster.hlsl；alpha_correction.hlsl 为着色器输入。assets build.rs 从 SVG 生成枚举/字节访问及 106 个默认图标的 RustEmbed 声明；兼容窗口仅画文字；后续 poc-input 已调用组件初始化并实例化 Input/Editor。未按运行路径清点实际图标，不据调用范围推断最终链接器是否保留资源字节。扫描范围中没有发现字体文件；GPUI 示例 README 描述动态下载 OFL 字体，本 PoC 未执行该示例，未来加入字体仍须单审。

`export-upstream-licenses.py` 保存微软、display-link、Ghostty、winit 四份固定 commit 上游全文，以及 Oklab 作者站点的 MIT 许可快照，另从 gpui-component 0.8.1 的 `.cargo_vcs_info.json` 固定 revision 保存仓库根 `LICENSE-DOCS.md`。共六份许可/声明快照和 `upstream-licenses/sources.json` 哈希；文档声明是 CC BY 4.0 的适用范围说明，不是该许可的法律条款全文。Oklab 明确标记非固定 revision；display-link 也不能声称确定了 GPUI 复制时的版本。这些附件用于审查，尚不是完整发布 NOTICE。

着色器及图标的追加复核见 `shader-review.md`。HLSL、Metal、WGSL 都引用 Oklab，已保存作者链接的 MIT 全文；WGSL 的 Stack Exchange 链接现已通过官方 API 取得 Tynach（2017-09-07，CC BY-SA 3.0）和 Pieter-Jan Briers（2021-06-12，CC BY-SA 4.0）的答案及修订元数据。两个答案各命中五项归一化表达；复制版本、适用授权和兼容性仍待处置，不能以包根 Apache 或非 GPL 为由免审。证据由 `export-shader-source-review.py` 导出。当前 Windows 目标未选入 gpui-pre-wgpu，不将其推断为全平台免审。来源扫描已覆盖纯 URL 着色器注释，避免漏掉这类引用。

## 源码与资源后续清单

P7 可选分配器增量另见 [allocator.md](allocator.md)：899 包显式 feature 清单及 deny 检查通过，回读 Rust wrapper 与 vendored mimalloc v3 两层 MIT 声明及 hash。默认图保持 897 包；动态 WebView2Loader 仅为本地 SDK 构建输入，没有复制或分发，分发前还需确认 SDK 的适用条款。

1. 根许可证 hash 已保存于 `spikes/gpui-poc/research/license-evidence.md`，可用 `audit-license-evidence.py` 重建；继续确认第三方文件头和 NOTICE 没有未覆盖例外。hash 相同仅证明文本相同，不自动证明包内所有文件授权一致。
2. 对实际启用的组件 assets、tree-sitter 语法、字体等形成发布内容清单。兼容窗口只画文本，input 已初始化组件；未导入 GPUI 示例字体或示例 SVG，实际组件图标内容仍需清点，不应据兼容窗口的范围免审后续资源。
3. 保留 Windows HLSL 微软 MIT notices 和图标 ISC/MIT notices。Apple Metal、wgpu shaders 的包级授权及独立头需继续核对。
4. 后续每加一个 PoC 依赖或 feature，重新导出、运行 deny，并增量复核。不能把现在的 0 errors 推广到未来终端/托盘/编辑器全部依赖。
5. macOS 编译环境缺失，依赖声明已纳入清单，但本机未编译其 SDK / Metal 链路；用户要求暂缓此测试，不阻塞 Windows 隔离研究，仍不计通过。

没有因不可替代 GPL-only 判定 No-Go，也没有把未完成的人工审核标成通过。当前不分发 PoC 二进制。
