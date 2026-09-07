# 修复 WSL 文件浏览器快速切换标签卡死

## Goal

修复 Windows 11 + WSL 环境下打开文件浏览器后快速切换终端标签时，WSL Git 状态查询持续积压并可能导致应用卡死的问题。

## Changelog Target

`[TEMP]`

## Root Cause

WSL UNC 路径不支持现有文件监听器，前端会退化为每 15 秒刷新；刷新无条件执行 Git 状态查询。非 Git 目录会被重复探测，而 Rust 后端通过 `wsl.exe` 执行 Git 命令时没有超时。快速切换不同 WSL 项目会让不可取消的旧请求继续运行并返回，形成命令积压和过期状态覆盖风险。

## Discovery List

- `src-tauri/src/file_watcher.rs` 对 WSL UNC 路径返回 `wsl_watch_unsupported`。
- `src/components/files/FileExplorerSidebar.tsx` 收到该错误后启用 15 秒轮询。
- `src/stores/fileExplorerStore.ts` 的可见状态刷新始终触发 Git 刷新，并吞掉非 Git 错误，无法停止后续无效探测。
- `src-tauri/src/commands/git.rs` 的 WSL Git 命令使用阻塞 `output()`，没有超时。
- 同一路径标签切换已有幂等保护；本次不重构标签或终端生命周期。

## Requirements

- WSL Git 状态命令必须有 30 秒硬超时，超时后终止子进程并返回错误。
- 后端必须为可识别的“非 Git 仓库”返回稳定错误码 `not_git_repository`。
- 前端必须按规范化项目路径缓存非 Git 状态，自动刷新不得重复探测。
- 手动刷新必须清除当前路径的非 Git 缓存并重新探测。
- 异步 Git 结果只能更新发起请求时仍处于同一文件位置的项目，防止跨项目旧结果覆盖。
- 保留现有用户未提交改动，不改变 IPC 成功返回结构，不新增依赖。

## Acceptance Criteria

- [ ] WSL Git 命令超过 30 秒后被终止，不再无限阻塞。
- [ ] WSL 非 Git 目录首次失败后，15 秒自动刷新不再执行 Git 查询。
- [ ] 用户手动刷新后，非 Git 目录会重新执行一次 Git 查询。
- [ ] 快速切换不同项目时，旧项目 Git 查询结果不会写入新项目状态。
- [ ] 现有 Git 仓库的文件状态显示与刷新行为保持不变。
- [ ] Rust 与前端针对性测试通过，TypeScript 类型检查通过。
- [ ] `CHANGELOG.md` 的 `[TEMP]` 记录本次行为修复。

## Definition of Done

- 针对性测试和静态检查通过。
- GitNexus 变更检测仅覆盖预期符号和流程。
- WSL Git 超时、非 Git 缓存和手动重试契约写入项目规范。

## Technical Approach

复用 `src-tauri/src/shell_resolver.rs` 的 `output_with_timeout`，不新增依赖。后端仅分类明确的非 Git 错误；前端使用模块级路径集合保存负缓存，在自动刷新时短路，在手动刷新时强制重新探测，并在异步结果落库前校验当前项目位置。

## Decision (ADR-lite)

**Context**：无限重试与无超时是已确认的卡死触发链；仅降低轮询频率无法消除积压。

**Decision**：采用“后端硬超时 + 稳定错误码 + 前端非 Git 负缓存 + 结果归属校验”的最小闭环。

**Consequences**：超大型仓库超过 30 秒会显示为空状态；目录后来初始化为 Git 仓库时，需要用户手动刷新重新检测。

## Out of Scope

- 不重构文件监听器以原生支持 WSL UNC。
- 不调整 xterm/WebView2 生命周期或滚动缓冲区。
- 不实现通用 IPC 请求取消框架。
- 不处理诊断报告中未经证实的 WebView2 内存泄漏假设。

## Technical Notes

- 根因分诊：行为性、跨前后端、WSL 特定且具有竞态，走根因修复路径。
- GitNexus 影响分析：`FileExplorerSidebar` 与 `git_get_changes` 均为 LOW；索引较当前工作区旧，修改时以源码直接检查为准。
- 当前 `src/stores/fileExplorerStore.ts` 存在用户未提交改动，必须增量合并。
