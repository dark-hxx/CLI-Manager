# 修复 WSL 历史作用域校验导致实时统计无法读取会话详情

## 背景

在 WSL 项目路径下，实时统计已经能够通过历史索引命中会话文件，但继续读取会话详情时后端返回 `session_file_outside_history_scope`。日志表明同一会话目录同时出现了 `\\wsl$\...` 和 `\\wsl.localhost\...` 两种 UNC 形式，导致历史作用域校验误判。

## 目标

- 修复 WSL 场景下历史会话详情读取失败的问题。
- 保持现有普通 Windows 本地路径校验行为不变。
- 保持历史删除等复用相同校验链路的能力正常。

## 非目标

- 不改前端实时统计轮询逻辑。
- 不改 WSL 会话扫描实现。
- 不改历史索引结构和缓存键。

## 实现要求

- 仅修改后端 Rust 代码，优先收口在历史会话文件校验逻辑。
- 当 `history_base` 与 `requested` 都是 WSL UNC 路径时，先统一到 `(distro, linux_path)` 语义再做作用域判断。
- 仅当 distro 相同且请求路径位于历史根目录内时放行。
- 非 WSL 路径继续保留原有 `PathBuf::starts_with` 行为。
- 补充回归测试，覆盖 `\\wsl$` 与 `\\wsl.localhost` 混用但语义相同的场景。

## 验收

- `history_get_session` 在 WSL `\\wsl$` / `\\wsl.localhost` 混用下不再因作用域误判失败。
- 非历史目录外部路径仍返回 `session_file_outside_history_scope`。
- 相关 Rust 测试通过。
