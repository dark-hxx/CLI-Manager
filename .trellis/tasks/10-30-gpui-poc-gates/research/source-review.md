# 来源扫描命中人工判读（2026-10-30）

本次逐项回读锁定 registry 文件的命中行及相邻上下文，并重算 32 个文件 SHA-256，全部与 `spikes/gpui-poc/research/source-attributions.json` 一致。版本、路径、行号和完整文件哈希以该附件为准。

32 个文件中，16 个只有普通派生说明或测试字符串；另外 16 个含包级声明、独立来源或资源许可线索。“误报”仅针对扫描命中，不表示已审核整个文件的来源。已记录表示存在可复核证据，不表示完整分发授权已经关闭；扫描不能发现没有声明的复制内容。

| 锁定包 | 包内文件 | 命中行 | 判读 | 依据 / 后续 |
|---|---|---|---|---|
| gpui-base 0.8.1 | `README.md` | 5, 348 | 包级声明 | Apache 声明，与根许可核对；非独立来源命中。 |
| gpui-base 0.8.1 | `src/input/base/state.rs` | 711, 9204 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-base 0.8.1 | `src/root.rs` | 75 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-base 0.8.1 | `src/scrollbar.rs` | 1029 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-base 0.8.1 | `src/text/format/markdown.rs` | 1929 | 本次命中为误报 | 普通数据/布局/标识派生说明；markdown 的 copyright 是测试字符串，不是文件授权头。 |
| gpui-base 0.8.1 | `src/text/node.rs` | 2302, 4050 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-base 0.8.1 | `src/text/state.rs` | 416 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-base 0.8.1 | `src/text/style.rs` | 371 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-base 0.8.1 | `src/text/text_view.rs` | 74 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-component 0.8.1 | `README.md` | 262 | 分层声明已记录 | 源码/代码示例 Apache；文档散文及原创插图另述 CC BY 4.0，见下文。 |
| gpui-component 0.8.1 | `src/chart/bar_chart.rs` | 270, 299 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-component 0.8.1 | `src/highlighter/languages/kotlin/highlights.scm` | 1 | 来源待处置 | tree-sitter-kotlin-sg / nvim-treesitter 改编；未启用 tree-sitter，固定来源仍待补。 |
| gpui-component 0.8.1 | `src/sidebar/mod.rs` | 509 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-component 0.8.1 | `src/text/compat.rs` | 101 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-pre 0.3.10 | `examples/README.md` | 49 | 示例待分发审核 | Noto Sans Devanagari 动态下载说明，声明 OFL；未运行下载示例。 |
| gpui-pre 0.3.10 | `examples/svg/dragon.svg` | 4 | 示例待分发审核 | Wikimedia 来源、CC BY-SA 3.0；未复制进 PoC。 |
| gpui-pre 0.3.10 | `src/_accessibility.rs` | 113, 181 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-pre 0.3.10 | `src/elements/text.rs` | 44 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-pre 0.3.10 | `src/geometry.rs` | 187 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-pre 0.3.10 | `src/platform.rs` | 1188, 1692, 1693, 1694 | 独立来源已记录 | 微软 MIT 与固定 commit；同时含普通 derived from 注释。 |
| gpui-pre-apple 0.3.10 | `src/shaders.metal` | 959 | 独立来源已记录 | Oklab 作者 MIT 快照，非原始复制 revision；macOS 未编译。 |
| gpui-pre-apple 0.3.10 | `vendor/gpui/src/geometry.rs` | 187 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-pre-apple 0.3.10 | `vendor/gpui/src/platform.rs` | 1188, 1692, 1693, 1694 | 独立来源已记录 | 微软 MIT 与固定 commit；同核心副本分开保留路径。 |
| gpui-pre-linux 0.3.10 | `src/linux/x11/client.rs` | 2222 | 独立来源已记录 | winit 0.29.11 链接；对应 commit Apache 全文已保存。 |
| gpui-pre-linux 0.3.10 | `src/linux/x11/clipboard.rs` | 2, 3, 4, 6, 8, 10, 12 | 独立声明已记录 | Arboard 归属、Apache OR MIT 头及 Zed Apache 头。 |
| gpui-pre-macos 0.3.10 | `src/display_link.rs` | 356, 357 | 来源待处置 | display-link MIT 快照已保存；实际复制 revision 未定。 |
| gpui-pre-macos 0.3.10 | `src/platform.rs` | 1290 | 独立来源已记录 | Ghostty PR 8625 合并 commit 的 MIT 全文已保存。 |
| gpui-pre-reqwest 0.12.15 | `README.md` | 5, 71, 73, 74 | 包级声明 | Apache OR MIT 包级声明；非新增独立来源。 |
| gpui-pre-web 0.3.10 | `src/events.rs` | 1420 | 本次命中为误报 | 命中处为数据、布局、标识或缓存的普通派生说明，无第三方来源或独立授权声明。 |
| gpui-pre-wgpu 0.3.10 | `src/shaders.wgsl` | 31, 32, 33, 209, 277 | 来源待处置 | 微软/Oklab 已记录；Stack Exchange CC BY-SA 3.0/4.0 的实际来源与兼容性待处置。 |
| gpui-pre-windows 0.3.10 | `src/alpha_correction.hlsl` | 1, 2, 3 | 独立来源已记录 | 微软 MIT、固定 commit；见上游许可快照。 |
| gpui-pre-windows 0.3.10 | `src/shaders.hlsl` | 188 | 独立来源已记录 | Oklab 作者 MIT 快照，非原始复制 revision。 |

## 组件文档的单独声明

gpui-component 0.8.1 README 第 262–264 行将软件源码及文档代码示例列为 Apache-2.0，另将 GPUI Kit 有权授权的文档散文和原创插图（包含中文翻译）列为 CC BY 4.0，并声明既有 Apache 权限、旧 revision 和第三方内容的边界。这里记录包内原始声明，不扩展解释其适用范围。

发布包实际提供 `LICENSE-APACHE`，SHA-256 为 `d1b0449e5478c574ba4f686c2656df7fe77d66821a61f8b6ed3378a58ed9a811`；不存在名为 `LICENSE` 的文件，README 所链接的 `LICENSE-DOCS.md` 也未随该 registry 包提供。已由该包 `.cargo_vcs_info.json` 定位上游 commit `99576db58ec8103417c41a092e891b4022d24e7e`，在仓库根取得 `LICENSE-DOCS.md`，保存为 `spikes/gpui-poc/research/upstream-licenses/gpui-kit-docs.txt`；路径与哈希见同目录 sources.json。对应声明缺失待办已关闭：该声明链接 CC BY 4.0，明确软件、网站实现和文档代码示例仍为 Apache，并保留第三方与旧 revision 的边界。这份声明不是 CC BY 4.0 法律条款全文。本 PoC 未导入这些散文或插图；以后复制时仍需针对具体内容核对归属，不以软件包 Apache 声明替代。

## 尚未关闭

- WGSL 的 Stack Exchange 来源已取得答案及 revision 元数据，实际复制关系、适用许可及兼容性未定，详见 `shader-review.md`。
- display-link 原始复制 revision、Kotlin query 固定来源以及未来实际资源发布清单仍待补。
- 这份清单只完成现有 32 个扫描命中的判读，不代表 889 个外部依赖的所有资源已经逐文件人工审查。
- macOS 原生编译仍缺环境；检查点 A 保持未关闭。
