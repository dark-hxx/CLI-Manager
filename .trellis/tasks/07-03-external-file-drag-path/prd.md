# 支持外部文件拖拽显示路径

## Goal

支持从系统文件管理器把外部文件拖到终端区域，并在终端输入区显示可用的文件路径，减少手动复制路径。

## Changelog Target

v1.2.5

## What I Already Know

* 用户要“外部文件拖拽，然后显示路径”。
* 现有终端已实现文件拖放处理：`src/components/XTermTerminal.tsx` 通过 `getCurrentWebview().onDragDropEvent` 接收外部文件路径，并使用 `formatShellPathList` 按当前 shell 引号规则写入终端。
* 现有 Windows 主配置 `src-tauri/tauri.conf.json` 将 `dragDropEnabled` 设为 `false`。
* 本地 Tauri 2 配置 schema 说明：`dragDropEnabled` 默认启用；Windows 上禁用它是为了使用前端 HTML5 drag/drop。
* macOS 覆盖配置 `src-tauri/tauri.macos.conf.json` 已将 `dragDropEnabled` 设为 `true`。
* 项目内已有文件树到终端的拖拽路径逻辑：`src/components/files/FileExplorerSidebar.tsx` + `src/lib/terminalFileDrag.ts`。

## Assumptions

* MVP 指“拖到终端区域后，把路径插入/显示到当前终端输入位置”，不是打开文件预览或导入文件。
* 多文件拖入时按空格拼接，并按当前 shell 做路径引用。

## Requirements

* 外部文件拖到终端区域后，终端显示文件路径。
* 只在拖到终端区域时处理，不影响其它区域。
* 保留当前 shell 路径引用规则。

## Decisions

* 用户确认按最小方案直接修改，接受启用 Tauri 原生外部文件拖放的取舍。

## Acceptance Criteria

* [ ] 从系统文件管理器拖入单个文件到终端，终端输入区出现该文件路径。
* [ ] 从系统文件管理器拖入多个文件到终端，终端输入区出现多个路径。
* [ ] 拖到非终端区域不写入终端。
* [ ] TypeScript 检查通过。

## Definition of Done

* 代码改动最小。
* 行为变更记录到 `CHANGELOG.md` 的 `v1.2.5`。
* 产品功能清单按需更新。
* 至少完成静态检查或直接文件检查。

## Out of Scope

* 不实现文件上传、复制文件、打开文件预览。
* 不新增依赖。
* 不改造文件树拖拽体系，除非为兼容外部拖放必须。

## Technical Notes

* 已检查 `src/components/XTermTerminal.tsx`、`src/lib/terminalFileDrag.ts`、`src/lib/aiPathFormatter.ts`、`src/components/files/FileExplorerSidebar.tsx`、`src-tauri/tauri.conf.json`、`src-tauri/tauri.macos.conf.json`。
* 本地依赖文档：`node_modules/@tauri-apps/cli/config.schema.json` 与 `node_modules/@tauri-apps/api/webview.d.ts`。
