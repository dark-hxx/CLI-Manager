# 文件预览熔断保护

## Goal

避免终端大量输出时打开文件浏览并预览媒体/大文件导致 WebView 卡死和 GPU 飙升。

## Requirements

- 视频文件一律不预览，且不得进入文本读取链路。
- 普通文本/其他文件超过 1 MiB 时拒绝预览。
- 图片超过 5 MiB 或光栅像素超过 12 MP 时拒绝预览。
- 本地、WSL/UNC 与 SSH 项目使用一致的限制；前端基于目录元数据预拦截，后端读取入口兜底。
- 所有用户可见提示兼容 zh-CN、zh-TW 与 en-US。
- 不增加强制打开、缩略图、图片压缩或视频播放器。

## Changelog Target

`[TEMP]`

## Acceptance Criteria

- [ ] 视频点击后显示不可预览提示，不调用文件读取接口。
- [ ] 1 MiB、5 MiB、12 MP 边界值可预览，严格超限时拒绝。
- [ ] 超限图片不会被完整读取、Base64 编码或传入 WebView。
- [ ] 本地与 SSH Agent 均有后端硬限制和测试。
- [ ] TypeScript 类型检查、Rust 检查与相关单元测试通过。

## Notes

- 根因：预览边界仅限制编码后文件字节数，未在 WebView/GPU 解码前限制媒体类型和像素规模。
- GitNexus 影响分析为 LOW；触点为前端文件 Store、本地文件命令和 SSH Agent 文件读取。
