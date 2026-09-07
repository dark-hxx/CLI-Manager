# 修复 WSL CLI Home 自动解析与手动选择

## Goal

修复“设置 → 供应商设置 → CLI Home”切换到 WSL 后自动解析沿用错误环境身份、且手动模式“选择目录”按钮仍被禁用的问题。自动模式应识别默认 WSL 发行版及其真实 Home；手动模式既可直接编辑 UNC 路径，也可通过目录对话框浏览选择。

## What I already know

- 上一轮仅放开了 WSL Home 文本输入，未满足用户对“选择目录按钮可用”的明确要求。
- 前端环境身份初始值固定为 `host`；切换环境类型时没有清空该本地身份，导致 WSL 自动加载拿 `host` 当发行版名。
- 后端已有按指定发行版读取 `$HOME` 的能力，但 WSL environment ID 为空时会直接报错，无法接管默认发行版探测。
- Tauri 目录对话框的 `OpenDialogOptions` 支持 `defaultPath`，可以用当前 WSL UNC Home 作为初始目录。
- 后端已经接受并验证 WSL UNC Home，无需新增 IPC 或改变持久化格式。
- 当前工作区存在并行供应商页面重构改动，必须精确隔离本任务补丁。

## Requirements

- 从 Local 切换到 WSL 时不得沿用 `host` 身份；自动模式必须探测默认 WSL 发行版及其真实 `$HOME`，返回规范化 `\\wsl.localhost\\<distro>\\...` 路径。
- 后端返回自动探测结果后，前端必须同步实际发行版 identity，避免草稿被误判为其他环境或重复使用空 identity。
- WSL 环境下“选择目录”按钮必须可点击；点击后以当前 WSL Home 为初始位置打开目录选择器。
- 选择目录后写入规范化 WSL UNC 路径并将 Home 草稿切换为手动模式。
- 取消选择不得改变 Home 来源或路径。
- 手动模式的 Home 输入框保持可直接编辑；WSL 自动模式首次编辑仍自动切换为手动模式。
- Local 环境继续使用原生目录对话框；busy 状态继续禁用重复操作。
- 不新增用户可见文案。

## Acceptance Criteria

- [x] 从 Local 切换到 WSL 后，自动模式识别默认发行版而不是把 `host` 当作发行版。
- [x] 自动模式显示默认 WSL 用户的真实 Home UNC 路径，并同步实际发行版 identity。
- [x] WSL 非 busy 状态下“选择目录”按钮不再禁用。
- [x] 目录对话框从当前 WSL UNC Home 打开，并可选择其他 WSL 目录。
- [x] 选中后 Home 字段显示对应 UNC 路径且来源变为手动。
- [x] 取消对话框后草稿保持不变。
- [x] Local 选择目录行为无回归。
- [x] 类型检查、相关 Rust 回归测试与 GitNexus 变更影响检查通过。

## Definition of Done

- 根因、场景矩阵与触点清单已记录。
- 实现、必要测试、契约、`CHANGELOG.md` 与 `docs/功能清单.md` 已同步。
- 本任务补丁与并行工作精确隔离并提交。

## Out of Scope

- 应用内自定义 WSL 文件浏览器、文件搜索、创建/删除/重命名 WSL 目录。
- 修改 WSL Home 的后端校验与持久化格式。

## Technical Notes

- Changelog Target: `[TEMP]`
- 根因陈述：Local/WSL 状态边界只切换了 environment kind，却继续携带本地专用 identity `host`，而 Rust Home 入口又要求调用方预先给出 WSL 发行版，导致自动解析在错误 identity 上运行；同时前端旧契约无条件禁用 WSL 目录对话框。修复必须落在前端环境状态转换、后端默认 WSL identity 生产端和选择器能力边界。
- 技术方案：环境切到 WSL 时清空旧 identity；后端在 identity 缺省时调用默认 WSL，读取 `WSL_DISTRO_NAME` 与 `$HOME`，再沿用现有校验和 UNC 规范化；前端接收结果后同步真实 identity。目录按钮仅在 `busy` 时禁用，并以当前 Home 作为 `defaultPath`。
- 场景矩阵：Local/WSL × auto/manual 均可打开选择器；Local→WSL 自动识别默认发行版；显式输入其他发行版继续按该发行版解析；busy 全部禁用；选择成功切手动；取消/异常保持草稿；WSL 返回 UNC 后由既有后端按发行版、存在性、读写权限验证。
- 触点：`NativeProviderHomeSection.tsx`（选择器状态/初始目录）；`useNativeProviderHome.ts`（环境 identity 状态转换与响应同步）；`src-tauri/src/provider/home.rs`（缺省 WSL identity 探测、校验与测试）；Tauri dialog typings（确认能力，不改）；i18n（无新增文案）；供应商契约/Changelog/功能清单（同步）。

## Technical Approach

保持现有 IPC 签名。Home 后端在缺省 WSL identity 时探测默认发行版和用户 Home；前端同步返回 identity。Local 与 WSL 都复用 Tauri 原生目录对话框，WSL 使用当前 UNC Home 定位；不引入新的浏览组件。

## Decision (ADR-lite)

**Context**: 用户明确要求 WSL 自动识别正确目录，且手动模式同时支持直接编辑和点击选目录；上一轮仅支持手填不满足验收。

**Decision**: 在环境状态转换时移除本地 `host` identity，由 Rust 在缺省 identity 时探测默认 WSL 上下文；同时移除 WSL 目录按钮禁用条件，并传入当前 Home 作为对话框初始路径。

**Consequences**: 自动探测与路径验证仍由 Rust 负责；前端只管理草稿状态。实际 Windows/WSL 原生对话框导航需人工桌面验证。

**Approval**: 用户于 2026-08-11 明确指出按钮必须不再保持禁用。

## Verification

- `npx tsc --noEmit`：通过。
- `cargo test provider::home::tests --lib`：12 个测试通过。
- `cargo check`：通过。
- `rustfmt --edition 2021 --check src-tauri/src/provider/home.rs`：通过。
- `git diff --check`：通过。
- 当前机器默认 WSL 为 `Ubuntu-22.04`，探测到 `HOME=/home/dministrator`，与默认用户 passwd Home 一致。
- 按仓库规范未启动 Tauri 桌面应用；目录对话框在真实桌面中的 WSL 导航仍需人工验收。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
