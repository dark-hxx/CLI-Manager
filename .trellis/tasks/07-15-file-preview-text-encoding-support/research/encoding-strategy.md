# 文本编码兼容策略研究

## 结论

成熟编辑器不会把“自动猜测编码”当成绝对正确结果。通用做法是：确定性规则优先、启发式猜测兜底、显示当前编码、允许用户手动重新打开/转换，并在普通保存时保持当前编码。

## 类似工具

### Visual Studio Code

- 默认 UTF-8，可通过 `files.autoGuessEncoding` 启用启发式猜测。
- 编码猜测并非总是准确，因此提供 `Reopen with Encoding` 和 `Save with Encoding`。
- BOM 可确定 UTF-8 BOM 与 UTF-16；无 BOM 的传统代码页存在歧义。
- 来源：<https://learn.microsoft.com/en-us/powershell/scripting/dev-cross-plat/vscode/understanding-file-encoding>

### IntelliJ IDEA

- 优先级为 BOM → 文件内显式声明 → 文件/目录配置 → 项目配置 → 全局配置。
- 编码不正确时允许选择 `Reload`（仅按新编码重读）或 `Convert`（实际转换文件）。
- 来源：<https://www.jetbrains.com/help/idea/encoding.html>

## Rust 方案

### `encoding_rs` 0.8.35

- 支持 WHATWG Encoding Standard 中的常见传统编码读写，包括 GBK、Big5、Shift_JIS、EUC-KR、Windows-125x 等。
- 可报告解码/编码过程中是否出现错误。
- UTF-16 LE/BE 可解码，但 crate 不提供 UTF-16 编码器；保持 UTF-16 保存需用 Rust 标准库手动写入 `u16` 字节。
- 来源：<https://docs.rs/encoding_rs/latest/encoding_rs/>

### `chardetng` 1.0.0

- 可猜测 GBK、Big5、Shift_JIS、EUC-JP、EUC-KR、Windows-1250~1258 等传统编码。
- UTF-16 不由检测器判断，必须先走 BOM 层。
- 检测结果是启发式猜测，没有“绝对正确”的保证；必须保留手动覆盖入口。
- 来源：<https://docs.rs/chardetng/latest/chardetng/>

### 二进制识别

- BOM 检查必须先于 NUL 字节检查，否则 UTF-16 会被误判为二进制。
- `content_inspector` 0.2.4 采用 BOM + 前 1024 字节 NUL 检查；实现简单但同样是启发式，可在项目内直接实现以避免为少量逻辑增加依赖。
- 来源：<https://docs.rs/content_inspector/0.2.4/content_inspector/>

## 推荐检测顺序

1. 检查 UTF-8 / UTF-16 LE / UTF-16 BE BOM。
2. 严格 UTF-8 解码；纯 ASCII 归为 UTF-8。
3. 在前置样本中检查 NUL 和异常控制字符，排除明显二进制。
4. 使用 `chardetng` 猜测传统编码。
5. 使用 `encoding_rs` 严格验证猜测结果；错误率过高则拒绝自动打开并要求手动选择编码。

## 读写保真

- 读取响应应携带 `encoding`、`bom` 和是否为猜测结果。
- 普通保存按当前编码和 BOM 策略回写。
- 若内容包含目标编码无法表示的字符，禁止静默替换；提示用户改用 UTF-8 或其他编码保存。
- “重新打开编码”只重新解码磁盘字节，不改文件。
- “保存为编码”属于显式转换，允许改变磁盘编码。

## 可行方案

### A. 自动检测 + 手动覆盖（推荐）

- 后端实现完整检测/编解码和原编码保存。
- 编辑器显示当前编码，提供重新打开和保存为指定编码。
- 覆盖自动判断错误场景，达到成熟编辑器的最小闭环。

### B. 仅自动检测与原编码保存

- 改动较小，但编码猜错后用户无法自救。
- 适合作为临时兼容修复，不适合作为长期编辑器能力。

### C. 完整编码配置体系

- 增加全局、项目、目录、文件级默认编码及继承规则。
- 能力接近 JetBrains，但范围明显超出当前文件预览问题。
