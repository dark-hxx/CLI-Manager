# S1.12 终端文字缓存审计（2026-11-01）

## 范围与结论

基于 Cargo.lock 锁定的 `gpui-pre 0.3.10` 下载源码，不以其他版本的 API 推断当前行为。前置审计未修改第三方库；同日后续加入独立合成原生诊断，数据见本文末尾，不等同真实 PTY 或 GPU 呈现验收。

当前 `TerminalModel::styled_lines` → `terminal/render.rs::styled_lines` → `StyledText` 已进入 GPUI 的行布局缓存；同一个 Window 内的 Pane 共享该窗口的文字系统和 glyph atlas。不能因为业务代码未声明 shaping cache 就认为每个 Pane 都独立 shaping，也不应再创建一份长期保留全部终端文字的无界缓存。

S1.12 仍未完整验收：已取得合成 8 Pane 布局对象复用与帧回调记录，仍需真实终端的帧呈现与失效场景记录。字体度量缓存测试不是 shaping/glyph 命中率测试。

## 已核对入口

| 层 | 锁定源码位置（相对 gpui-pre crate 根） | 行为 |
|---|---|---|
| 应用 | `apps/desktop-gpui/src/terminal/model.rs` | snapshot 合并 damage，但每次调用仍重新生成 URL/搜索匹配和所有可见行的文字、样式 runs |
| 元素 | `src/elements/text.rs`：StyledText::request_layout、TextLayout::layout | StyledText 走 window.text_system().shape_text；不是直接调用平台 shaper 绕过缓存 |
| 窗口文字 | `src/text_system.rs`：WindowTextSystem::new、shape_text、layout_line | 每窗口持有 LineLayoutCache；底层 TextSystem 通过 Arc 共享，FontRun 由字体解析结果构造 |
| 行缓存 | `src/text_system/line_layout.rs`：LineLayoutCache、layout_line、layout_wrapped_line、finish_frame | 当前帧查找，然后从前一帧移动命中项；未命中才调用 platform_text_system.layout_line；逐帧交换并清理旧缓存 |
| 字体失效 | 同文件 clear_if_font_generation_changed；`src/text_system.rs` 的 add_fonts | 字体库代次变化会清理行缓存，不能让自建缓存绕开这条失效链路 |
| 字形 | `src/window.rs`：paint_glyph 的 sprite_atlas.get_or_insert_with | 按 RenderGlyphParams 查 atlas，缺失才 rasterize_glyph；每 Window 的 atlas 由平台窗口提供 |
| 栅格边界 | `src/text_system.rs`：TextSystem::raster_bounds | 共用 TextSystem 缓存字形栅格边界，不等同跨窗口共用 GPU atlas |

## 缓存键与边界

- 常规 CacheKey 包含文本、字号、FontRun、wrap_width、force_width；使用文本相等判断，不仅靠调用者内容哈希。
- FontRun 根据解析后的字体和区间形成；颜色/选择/搜索等装饰不应被误当成字体 glyph 内容，但其绘制必须随当前 TextRun 更新。
- RenderGlyphParams 包含 font_id、glyph_id、font_size、subpixel_variant、scale_factor、is_emoji、subpixel_rendering 与 dilation；跨 DPI 不能仅凭字符复用旧栅格图。
- 行缓存是当前/前一帧窗口级缓存，不是应用全局持久 LRU。长期隐藏后恢复可能重新 shaping，这是生命周期边界，不是用无限保留历史行修补的理由。
- 多窗口共享 FontMetricsCache 不代表共享 LineLayoutCache 或 GPU atlas。后续测试日志必须区分窗口，不能把“8 Pane”写成“8 窗口”。
- 隐藏会话仍在后台解析，但不应为其构造可见元素或额外预热 shaping；原有 PTY 订阅/解析生命周期不变。

## 下一批实施与验收

1. 在现有原生渲染测试/诊断入口观测布局复用，计数必须来自实际缓存或布局对象复用，不以相同字符串次数伪造缓存命中率；正常路径不逐字形输出日志。
2. 为 1/2/4/8 Pane 的相同文本、不同文本、快速滚动分别记录冷/热状态，以及 UI 帧时间；区分行准备 CPU 时间和真正窗口帧时间。
3. 补齐字体/字号/行高切换、bold/italic、主题/选择/搜索、宽字符与组合字、DPI、resize/reflow、备用屏和隐藏恢复的失效矩阵。
4. 先基准确认热点。如果热点是应用每帧重新构造文字/runs，优先以 damage 和准确内容键做有界行准备缓存；不要误称其为新增 glyph/shaping 缓存。
5. 若需要跨窗口 shaping 复用，先明确平台字体代次和 GPU 资源生命周期契约，再决定是否扩展框架接口；本轮不复制或修改第三方实现。

## 图分析限制

GitNexus 对 `terminal/render.rs::styled_lines` 的 context 未找到符号，impact 返回 UNKNOWN，不能作为无人调用的依据。已按源码核对 `TerminalModel::styled_lines` 与 `DesktopShell::terminal_pane_previews` 的直接调用；本轮审计不修改函数，后续实现前仍须执行影响分析并报告根壳的高风险传播。

## 同日原生诊断实现与实跑

- 入口 `cli-manager-gpui.exe --terminal-cache-benchmark` 在用户偏好、项目库、Tokio 服务和 daemon 初始化之前分流；创建独立可见原生窗口，完成后自动退出，90 秒 watchdog 或人工关闭导致样本不完整时返回非零。
- 生产渲染只抽取 prepared_lines，StyledText、光标叠层、字号/行高保持原路径。诊断复用该函数与 term-engine，canvas 调用同一 GPUI shape_text/paint API，显式传实际行宽。它不包含正常壳完整布局、输入或异步 PTY，不能当产品终端帧呈现测试。
- 每组 8 帧 warmup + 60 帧采样。1/2/4/8 Pane 各有静态共用、静态独立、每帧滚动；另有 8 Pane 字号/行高/选择/搜索变化。夹具含颜色、bold/italic、CJK 和组合字符；未测字体族切换、系统字库、DPI、emoji、resize、备用屏或隐藏恢复。
- 对 shape_text 返回的实际 Arc<LineLayout> 观察对象身份，跟踪器只存 Weak，不延长布局/文本存活，容量 4096。结果称布局对象复用率，不是相等文本次数或 glyph atlas 命中率。首次观测和跟踪淘汰可能低估复用，不能反推未复用必定调用平台 shaper。
- 每组 59 个帧回调间隔来自连续采样帧的 render 进入时间；另报每帧准备、每行 shape/paint CPU 分位数。后两者不是整帧总量，不能与回调间隔直接相加。未观测 GPU 完成或 PresentMon，presentation_verified=false。
- Windows debug 下 13 组正常完成、退出 0、errors 全 0。8 Pane 静态共用/独立复用均 100%；滚动 91.67%；外观变化 87.40%。对应回调 p95 为 14.104/14.038/13.890/15.758ms，准备 CPU p95 为 4.341/4.700/4.825/4.607ms。外观变化最大间隔 18.164ms，不宣称稳定 60fps。
- 主机枚举含虚拟显示适配器和 NVIDIA/AMD，未确认 GPUI 实际 adapter，不推广为指定 GPU 承诺。完整数据在 terminal-text-cache-benchmark-2026-11-01.json；本机原始日志在 %TEMP%/cli-gpui-cache-benchmark-3cce621630b94f9a8a3138709b971d9a/benchmark.log。
- 5 项新测试覆盖弱引用身份/等值不同对象、容量边界、分位数、共用/独立夹具及 UTF-8 runs/滚动；GPUI 全 142 项通过，debug 构建通过，严格架构 1579 源文件零超限，diff 检查通过。
- 本夹具准备 CPU 高于热态每行 shape 查询，但这不是完整帧 CPU 总量对比。后续先验证真实终端的 damage/文字和样式构造热点；持久 shaping LRU 仍需解决框架字体库代次、跨窗口和隐藏恢复失效，不因本基准通过而取消验收。

## 同日有界行准备缓存与对照

产品接入应用级 RowPreparationCache，缓存平台无关的文字/runs，复用跨 Pane/窗口相同行；512 项 + 8 MiB 估算条目载荷，LRU 淘汰、超大行绕过。颜色/组合字/flags、字体及完整回退链、调色板和行内装饰均在命中前精确校验；快速指纹碰撞只增加比较，不改变结果。保留 GPUI 的实际字体解析、shaping 和 atlas 生命周期，未新增跨窗口原生 shaping LRU。完整规则见 `.trellis/spec/frontend/gpui-terminal-cache-contracts.md`。

首次实现逐 cell 多字段散列导致 debug 8 Pane 准备中位耗时从 3.99/3.99/4.23/4.18ms 增至 4.17/4.27/4.54/4.49ms，未据高命中率宣称优化成功。随后复用调色板指纹，内容指纹用字符/flags 快速聚合，仍精确比较全部可见字段；正反对照的布局复用率不变。

最终同一 debug exe 顺序运行 cached、uncached，各 13 case 退出 0，原始 JSON 分别在 `terminal-row-cache-cached-2026-11-01.json`、`terminal-row-cache-uncached-2026-11-01.json`。本机日志在 `%TEMP%/cli-gpui-rowcache-final-d3334f5a0bef4f0aa6f548c249260479/`；首轮回归日志保留在 `%TEMP%/cli-gpui-rowcache-4c4d63ed6eb442fa8e17c1d536ce4c8a/`。

| 8 Pane 场景 | uncached 准备 p50/p95 (ms) | cached 准备 p50/p95 (ms) | cached 条目/估算字节 |
|---|---|---|---|
| 共用静态 | 3.960 / 4.251 | 3.737 / 4.214 | 12 / 45,661 |
| 独立静态 | 3.835 / 4.218 | 3.843 / 4.127 | 89 / 341,110 |
| 滚动 | 4.149 / 4.688 | 4.062 / 4.535 | 512 / 1,769,470 |
| 外观变化 | 4.120 / 4.653 | 3.991 / 4.223 | 225 / 868,110 |

缓存计数含 8 warmup + 60 采样帧，每个 8 Pane case 有 6528 次行查询。共用静态命中 6516、miss 12；独立静态 6439/89；滚动 5903/625、淘汰 113；外观变化 6303/225。最多 512 项，全部 bypass=0。耗时只是一对顺序运行，独立静态中位值略升，不能据此给出统计显著的统一加速承诺；真实 PTY 与呈现仍未测。

新增 6 项测试覆盖强制哈希碰撞、色彩/字体/装饰差异、entry/byte 两种淘汰、超大绕过、缓存/新算结果相等、CJK/组合字、选择/搜索/调色板、字号/行高、备用屏/resize/滚动与隐藏光标。GPUI 148 项串行通过，debug 构建通过，严格架构 1580 个源文件零超限。

本轮一次 cargo.exe 在编译输出前以 c0000005 退出，日志为空；确认无 cargo/rustc 存活后重试通过，事件 1000 的故障模块为 unknown。它不同于此前测试进程指向 MozartBreathCore.dll 的记录，未据重试通过认定根因解决，也未修改系统组件。
