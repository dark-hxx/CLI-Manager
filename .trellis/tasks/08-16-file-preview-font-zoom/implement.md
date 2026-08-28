# 实施计划

## 改动

- [x] 在 `FileEditorContent` 中以窄选择器读取 `uiFontFamily` 与 `uiFontSize`，规范化字体值。
- [x] 增加组件级临时字号，通用字号变化时更新基础值。
- [x] 在文本/Markdown 文件预览区域捕获 `Ctrl + 滚轮`，按 1px 步进限制到 8px～32px。
- [x] 将有效字体与字号应用到 Monaco options 和 Markdown 预览容器。
- [x] 更新 `CHANGELOG.md` 的 `V1.3.6` 条目和 `docs/功能清单.md` 的文件预览板块。
- [x] 新增共享字号控件，并挂载到终端、文件预览和终端 Markdown 预览；仅在 Ctrl+滚轮缩放后显示，并在最后一次操作 2 秒后自动隐藏。
- [x] 使终端 Markdown 预览跟随通用 UI 字体/字号，并保留其局部 Ctrl+滚轮缩放。
- [x] 更新 `V1.3.6` 交付记录以涵盖三种展示场景。
- [x] 让文件源码预览的 Monaco Unicode 歧义字符提示跟随当前应用语言，保留 Unicode 高亮。

## 验证

- [ ] `npx tsc --noEmit`（按用户要求未执行）
- [ ] `npm run build`（按用户要求未执行）
- [x] `rg -n "fontSize: 13" src/components/files/FileEditorContent.tsx` 无旧硬编码命中。
- [x] `gitnexus_detect_changes(scope: "all")`：因 `XTermTerminal` 是流程入口而标记其 9 条既有流程；变更仅落在字号提示 UI，未触及 PTY、发送或解码处理。
- [ ] 人工检查：普通滚动、Ctrl 缩放上下限、源码/Markdown 切换、通用字体/字号即时变化、图片/unsupported/Diff 不变。
- [ ] 人工切换 `zh-CN` 与 `en-US`；确认无新增硬编码文案，时间格式不受影响。

## 回滚点

- 单一代码回滚点：`FileEditorContent.tsx`。
- 文档回滚点：删除本次 `V1.3.6` 的两处交付记录。
