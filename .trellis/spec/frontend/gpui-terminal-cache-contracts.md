# GPUI 终端缓存契约

## 责任边界

- `terminal/row_cache.rs` 只缓存平台无关的 SharedString 和 TextRun 准备结果，应用内所有可见 Pane/窗口共用，首次终端渲染时懒创建，不枚举系统字体，不持久化到磁盘。
- `terminal/render.rs::prepared_lines` 是产品与原生诊断共用的行准备入口。生产始终经 StyledText 进入 GPUI 文字系统；行 shaping、字库代次变化和每窗口 glyph atlas 资源生命周期仍归 GPUI。
- 行准备缓存不是跨窗口 ShapedLine LRU；不能把它的命中计数写成 shaping/glyph atlas 的命中率，也不能把合成诊断的帧回调间隔视作 GPU 呈现时间。

## 键与失效

- 存储可见单元格的字符、前景/背景色、flags 和全部组合字符；不强引用 CellExtra/OSC8 元数据。当前渲染不消费的 hyperlink/underline_color 不进入键，未来新增消费必须同时扩展键和测试。
- 存储完整 Font（含字体族、fallback/features、weight/style）、颜色表快照、行内选择范围、URL/搜索范围和方块光标列。颜色表按锁定 Alacritty/vte 的最后 NamedColor 索引读取，不硬编码数组长度。
- 指纹只作候选桶定位，颜色/组合字符未进入快速内容指纹也必须在命中前逐项精确比较。不得仅凭哈希相同复用；碰撞测试强制相同 fingerprint 验证内容隔离。
- 相同内容从一行滚动到另一行时可共享；交互范围先转换为行内坐标，逆向选择与原产品包含边界保持一致。
- 字号与行高不影响 TextRun 的准备结果，不作为键；每帧重新应用字体大小/行高，框架按实际字号重新 shape。bar/underline 和隐藏光标的几何每帧计算，不缓存旧坐标。字体库变化仍由 GPUI 对描述解析和 shaping 缓存代次处理。
- resize/reflow、备用屏、主屏恢复和 replay 更新通过实际可见 cells 参与比较，不仅依赖 damage 标志或 session revision。

## 容量与生命周期

- 最多 512 项，估算保留条目载荷最多 8 MiB；载荷包含缓存单元格、组合字符、文字、runs、字体/回退和颜色快照的保守计费。分配器、HashMap 桶和临时/调用方结果不属于这个数值，因此不是进程内存上限。
- 命中刷新最近使用序号，容量或载荷超限先淘汰最久未使用项。单行估算载荷超过预算时返回准备结果但不插入、不清空已有热项。
- 缓存没有 session 所属关系，会话关闭后最近文字可留在这个有界内存缓存，直到淘汰或应用退出。无磁盘文件或日志正文；不得改为无限保留终端历史。
- 原生诊断的 Arc 布局身份观察另用 Weak、有界 4096 项，不改变框架布局对象存活时间。

## 验证

- 定向测试：`cargo test -p cli-manager-desktop-gpui -j 1 terminal:: -- --test-threads=1`。
- 原生诊断：`cli-manager-gpui.exe --terminal-cache-benchmark`；加 `--terminal-cache-uncached` 可绕过行准备缓存，两者仍走相同引擎/行准备/shape_text/paint 路径。
- `[gpui-terminal-row-cache]` 计数包含 warmup 与采样，区别于只统计采样帧的布局身份复用；每个 case 重置行准备缓存，生产应用中没有这种逐 case 重置。
- 必须保留真实 PTY、完整壳分屏、DPI、多窗口、字库变动、隐藏恢复与 GPU 呈现的独立门禁，单元/合成测试不关闭它们。
