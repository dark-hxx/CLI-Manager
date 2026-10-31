# 着色器与图标资源复核（2026-10-30）

范围是锁定 registry 包的源码、引用注释与构建输入，不是最终二进制资源清单或法律意见。全部候选路径与 SHA-256 由 `spikes/gpui-poc/research/asset-candidates.json` 固定。

## 着色器

| 包 / 文件 | 已核对证据 | 状态 |
|---|---|---|
| gpui-pre-windows / alpha_correction.hlsl | 文件头明确微软来源、固定 commit 与 MIT；全文快照 microsoft-terminal.txt | 来源和许可证据已保存 |
| gpui-pre-windows / shaders.hlsl | include alpha_correction；188 行引用 Oklab，附近包含双向色彩变换矩阵 | 微软和 Oklab 许可需随派生内容保留 |
| gpui-pre-windows / color_text_raster.hlsl | include alpha_correction；未发现其他来源 URL 或独立许可头 | 根 Apache 与被包含的微软来源分开记录 |
| gpui-pre-apple / shaders.metal | 959 行引用同一 Oklab 文章，附近矩阵对应作者示例；build.rs 经 xcrun metal / metallib 编译，或 runtime_shaders 拼接 | Oklab 证据已保存；macOS 构建未执行 |
| gpui-pre-wgpu / shaders.wgsl | 31–33 行微软 MIT；209 行 Game Development Stack Exchange 链接；277 行 Oklab | 微软/Oklab 已收录；Stack Exchange 两个答案的许可与表达相似证据已保存，复制关系及兼容性待处置 |
| gpui-pre-wgpu / shaders_storage.wgsl、shaders_subpixel.wgsl、shaders_webgl.wgsl | 已逐行检查来源/授权/URL 注释，未发现额外独立许可声明 | 暂按包根 Apache 记录，不能以无声明证明无第三方来源 |

Oklab 原始页面 `https://bottosson.github.io/posts/oklab/` 在 C++ 示例前说明代码可用公有领域或 MIT，并链接 `https://bottosson.github.io/misc/License.txt`。本次保存作者 MIT 全文，copyright 为 2020 Björn Ottosson，SHA-256 为 `3929a10fc5ae2932be781b4c076fb806b62ccab45a6991c0ebc151d06e8c5888`。附件 `spikes/gpui-poc/research/upstream-licenses/oklab.txt`；sources.json 记录获取时间、来源页和 `revisionPinned=false`。这是当前作者站点的审核快照，原始复制版本尚不明，不能称固定 commit。

WGSL 的链接为 `https://gamedev.stackexchange.com/questions/92015/optimized-linear-to-srgb-glsl`，位于 srgb_to_linear 前；后续线性/非线性变换使用分段公式。网页请求曾返回 HTTP 403，现已通过 Stack Exchange 官方 API 取得两个相关答案及修订元数据，记录在 `spikes/gpui-poc/research/shader-source-review.json`：

| 答案 / 作者 | 创建时间（UTC） | API 许可声明 | 第 1 版 revision GUID |
|---|---|---|---|
| 148088 / Tynach | 2017-09-07 04:35:17 | CC BY-SA 3.0 | 18FD5D6C-3469-4583-BB20-F8E723796A83 |
| 194038 / Pieter-Jan Briers | 2021-06-12 12:48:30 | CC BY-SA 4.0 | 17B0E2DC-21A6-47A4-A17D-DEFA8953FEBE |

`export-shader-source-review.py` 从官方 answers/revisions API 保存作者、链接、许可、revision、获取时间和响应/正文哈希，不转载答案散文。锁定 WGSL 文件 SHA-256 为 `bf22f0bd45bdc2da6fc88e5c678e03549941d270d6d85f5a2d1044f875f75729`。将 GLSL/WGSL 的向量语法、变量名和 mix/select 显式归一化后，两个答案各与 WGSL 209–229 行命中五项选定表达：双向 pow 变换、两个线性分支和分支选择。该比较未证明阈值、分支语义或 alpha 处理完全一致，也不证明作者关系、实际复制版本或表达的法律保护范围。

因此，待办已从“取得原文证据”收窄为“确定实际来源及适用授权，处置 CC BY-SA 的兼容性与分发义务”；不能据包根 Apache 或非 GPL 判定通过。若确认存在不兼容，需评估上游澄清或替代实现，当前仍无充分依据作最终 Go / No-Go。

`cargo tree --locked --manifest-path spikes/gpui-poc/Cargo.toml --target x86_64-pc-windows-msvc --invert gpui-pre-wgpu` 返回 nothing to print。该包存在于全平台锁定图，但不在当前 Windows 默认目标依赖树；它仍属于全平台审核范围，不能把 Windows 未启用当成全部平台审查通过。

## 图标

1868 个候选中，1830 个 SVG 全位于 gpui-kit-assets 0.8.1 的 assets/icons；无 SVG 自带 metadata、title、desc、注释或额外非 W3C URL 的命中。106 个是默认图标构建输入。包内 LICENSE-LUCIDE 同时提供 Lucide ISC 与 Feather 派生图标的 Cole Bemis MIT 归属及全文，应整体保留；未逐个证明图标与上游某一 revision 的一一对应。

当前窗口未注册组件资源源，也未渲染图标；这不证明 release 链接裁剪掉了所有图标。后续实际启用资源后，需建立最终打包清单。GPUI 的六个示例图像/SVG 候选与这些图标分开，dragon.svg 的 CC BY-SA 声明保持独立待分发复核。

## 扫描修正

原扫描仅匹配 copyright / adapted / license 等文字，漏掉只有 Reference 或 URL 的着色器注释。已扩展为捕获着色器内全部 HTTP(S) 引用，来源匹配文件由 30 增为 32，资源候选仍为 1868。扫描器只是定位证据，未替代完整人工审核；检查点 A 保持未关闭。
