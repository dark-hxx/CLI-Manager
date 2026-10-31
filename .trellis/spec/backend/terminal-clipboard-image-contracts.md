# Terminal Clipboard Image Contracts (V1.4.1)

## 1. Scope / Trigger

终端截图、浏览器图片粘贴、原生剪贴板图片与 Finder/Explorer 文件复制。修改图片预算、原生适配或终端粘贴路由时适用。反馈的 Snipaste → 微信重新复制场景无现场数据；不要把兼容缺口或合成测试等同于已复现用户根因。

## 2. Signatures

- `cli_manager_core::clipboard_image`（可选 `clipboard-image` feature）：共享 `validate_dimensions` / `decode` / `encode_png` / `first_decodable`，不读取系统剪贴板或依赖 Tauri/GPUI。宿主负责候选格式、版本一致性和线程调度。
- `save_png(data_root: &Path, png: &[u8]) -> Result<PathBuf, String>`：宿主只传共享编码器产生的 PNG 和自身解析的数据根。拒绝空值、超限与非 PNG 签名；目标固定为 `<data_root>/attachments`，拒绝最终目录的链接/重解析点，校验根归属，以同目录临时文件和不覆盖持久化处理并发名称冲突。不写项目目录。
- GPUI `EntityInputHandler::paste` 按文件路径、图片快照、文字顺序分流。图片快照后台解码/编码，不重读系统剪贴板；错误不回退文字，目标 SessionHandle 及取消代次固定，待发送路径复用 shell/WSL 转换和括号粘贴。此入口不等同于 Alt+V 图片专用模式，后者的 CLI 能力模式和 SSH 上传仍需单独接线。

- `clipboard_read_file_paths() -> Result<Vec<String>, String>`：Windows CF_HDROP / macOS public.file-url；其他平台保持原行为。
- `clipboard_attach_image_files(app: AppHandle) -> Result<ClipboardImageAttachments, String>`：AppHandle 由 Tauri 注入；前端不传路径。
- `file_attach_image_data(data_base64: String) -> Result<String, String>`：验证浏览器图片真实内容，返回受管 PNG 本机路径。
- `file_attach_data(file_name, data_base64)`：通用附件，20 MiB，保留原始内容语义。
- `readTerminalClipboard(reader, imageOnly?)`：返回 `{kind: 'paths', paths}` 或 `{kind: 'text', text}`；错误向调用方传播。

## 3. Contracts

- 图片文件/浏览器附件输入 ≤20 MiB；原生剪贴板未压缩表示受 `40_000_000 * 4 + 1 MiB` 预算约束。解码前验证 ≤40,000,000 像素，PNG 结果 ≤20 MiB，必要时按比例缩小，最多五次。
- 文件预览仍 5 MiB/12M，项目文件树导入仍 64 MiB/12M；不通过修改共用预览常量提高附件预算。
- Windows 按 PNG、CF_DIBV5、CF_DIB 尝试。CF_BITMAP 由系统提供 DIB 转换；一种表示损坏继续其他表示。一次仅复制一个表示，解码前释放剪贴板锁；回退前检查序号，锁内延迟渲染更新可接受。
- packed DIB 显式补 BMP 文件头；V4/V5 掩码在头内，不能再次计入像素偏移；INFOHEADER 外置掩码/调色板有长度校验；保留 32-bit BI_RGB 的有效 alpha mask。
- macOS 请求 public.png/public.tiff/public.jpeg，失败可尝试其他表示；使用 objc2 原生 API，无 AppleScript 子进程。Finder 路径仅解析 file URL；已有符号链接/大小检查继续生效。
- ClipboardImageAttachments 的 `paths` 可来自图片位图或文件，`hadFiles` 只表示文件列表存在，`rejectionCode` 与空结果区分。
- Ctrl+V/右键继续“文件路径 → 图片 → 文字”；Alt+V 为图片专用。浏览器事件识别 items/files、空 MIME 图片扩展名，但后端实际解码，不信任扩展名。
- SSH 先上传受管 PNG 再发送远端路径；WSL 继续路径转换。SSH fileAttachAny 保持 20 MiB，旧 fileAttach 保持 5 MiB/12M，不绕过旧 Agent 能力检查。
- HEIC/HEIF、任意私有类型与虚拟文件协议不属于已支持范围。

## 4. Validation / Error Matrix

| Input | Result |
| --- | --- |
| 无图片 | 原生命令空 paths；普通模式可读文字 |
| busy | Windows 五次 ×20ms 有界重试后 `clipboard_busy` |
| 读取失败/内容已改变 | `clipboard_image_read_failed`，不能当无图片 |
| 所有候选损坏 | `clipboard_image_unsupported` |
| 文件/编码字节超限 | `clipboard_image_too_large` / 通用附件 `attachment_too_large` |
| 像素超限 | `clipboard_image_dimensions_too_large` |
| 旧 SSH Agent 不支持大图 | 保持升级错误，不发送本机路径 |

## 5. Good / Base / Bad

- Good：PNG 损坏但 DIB 可读，转换为 PNG 后正常粘贴；只有 PNG 的 macOS 截图也可读取。
- Base：文字、普通文件路径、8K 截图、20 MiB 图片文件均使用对应入口。
- Bad：图片读取出错后静默改粘贴剪贴板文字；无条件信任 `.png`；去掉所有内存/像素限制。

## 6. Required Tests

- `cargo test -p cli-manager-core --features clipboard-image clipboard_image`：共享编解码/回退、像素预算、受管目录、并发不覆盖与无效目标检查。
- `cargo test -p cli-manager-desktop-gpui terminal::clipboard`：文件路径分流、损坏图片拒绝、BMP 快照到共享 PNG 附件、关闭会话取消；真实系统剪贴板仍单列验收。

- `node --test scripts/terminalClipboardImage.test.mjs scripts/wslImagePaste.test.mjs scripts/webTerminalClipboard.test.mjs scripts/webTerminalImageBridge.test.mjs`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib clipboard_image`：真实 PNG/TIFF/DIB 编解码、损坏首选回退、空/错误区分、8K/40M、V5 alpha、20MiB/+1 边界。
- 真实 Windows/macOS 剪贴板与用户 Snipaste 实测单列，合成测试不能替代系统剪贴板验收。

## 7. Wrong vs Correct

- Wrong：所有 PNG 错误直接返回。Correct：保留错误，尝试同一版本剪贴板的其他表示。
- Wrong：前端获取 40M RGBA 再经 IPC 传回。Correct：原生数据在后端验证/编码，仅返回路径。
- Wrong：DIBV5 总是 header + 12 个掩码字节。Correct：V4/V5 掩码已在 header 内，仅 INFOHEADER 需要外置掩码。
