# 修复 WSL AI CLI 图片粘贴并扩展工具支持

## Goal

在 Windows 宿主机运行 WSL AI CLI 时，通过内置终端 `Alt+V` 稳定粘贴剪贴板图片，避免 Codex/Claude 依赖 WSL 内缺失的 `wl-paste`、`xclip` 或 PATH 中的 PowerShell；同时覆盖常用图片文件格式，并按能力分级为更多 AI 编程工具提供一致的图片输入。

## Requirements

- 内置终端拦截 `Alt+V`，读取 Windows 剪贴板；剪贴板位图及复制的图片文件统一转换为 PNG 后写入受控附件目录，再向 CLI 粘贴可消费的路径。
- 支持 PNG/APNG、JPEG/JPG/JFIF、GIF（首帧）、WebP、BMP/DIB、TIF/TIFF、ICO 等常用格式；SVG、AVIF 仅在现有解码器可安全解码时接受，否则稳定提示不支持；HEIC/HEIF 明确不支持。
- 剪贴板文件由 Rust 侧读取与校验，限制常规文件、大小、像素及附件数量，拒绝非图片、损坏图片、符号链接和越界输入；不把原始宿主机路径直接交给 WSL CLI。
- 建立工具能力分级：Claude/Codex 使用原生图片路径桥接；Gemini/Qwen/OpenCode/Kimi/Pi 使用 `@/path` 文件引用；Aider 使用 `/add "/path"`；其余已登记工具保持文本粘贴并给出可理解的“不支持图片粘贴”反馈。
- Claude/Codex/OpenCode 等终端上下文必须同时识别会话工具字段与项目工具字段，避免恢复会话时能力判断丢失。
- 所有新增用户可见文案同时提供 zh-CN/en-US 翻译。

## Acceptance Criteria

- [ ] WSL 中不安装额外剪贴板工具时，Codex 与 Claude 可通过 `Alt+V` 粘贴 PNG/JPEG 及复制的常用图片文件。
- [ ] 常用格式按约定转换为 PNG；HEIC/HEIF 和无法安全解码的 SVG/AVIF 不会发送给 CLI，并显示本地化错误。
- [ ] 支持工具按能力分级生成正确输入，不支持工具不发送二进制或宿主机原始路径。
- [ ] 非图片文件、损坏文件、过大文件和过大图片被拒绝，附件仍位于应用受控目录。
- [ ] `npx tsc --noEmit`、`cargo check`、相关 Rust/前端测试通过；手动验证中英文界面文案。
- [ ] `CHANGELOG.md`（TEMP）与 `docs/功能清单.md` 已记录变更。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
