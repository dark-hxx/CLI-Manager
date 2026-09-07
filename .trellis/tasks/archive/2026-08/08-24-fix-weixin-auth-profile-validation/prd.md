# 修复微信授权被其他平台配置阻止

## Goal

微信扫码授权只应依赖微信授权所需的公共配置与微信平台状态；Telegram、飞书或企业微信的未完成配置不得在二维码生成前阻止授权。正常保存/启动 cc-connect 仍保持全部启用平台的严格 allowlist 校验。

## Root-Cause Statement

根因位于授权专用配置与常规连接 Profile 的校验边界：`start_weixin_authorization` 复用 `normalize_profile` 校验全部已启用平台，因而其他平台的空白或无效 `allow_from` 会在微信授权子进程启动前失败；修复应在授权 Profile 构造层隔离并规范化平台状态，而不是吞掉校验错误或修改 cc-connect。

## Requirements

- 微信授权必须继续校验项目、Agent、代理、cc-connect 可执行文件和微信授权配置。
- 微信当前 allowlist 为空、旧格式或无效时允许重新扫码，以扫码结果作为新的明确用户 ID。
- 其他平台已启用但 allowlist 无效时，不阻止微信授权；该平台在授权结果 Profile 中回到禁用状态，凭据和输入值不被清除。
- 其他平台已启用且配置有效时保持启用，不因微信授权被关闭。
- 正常“保存并连接”继续通过 `normalize_profile` 严格拒绝任一启用平台的空白/无效 allowlist。
- 授权结束仍要求 cc-connect 写回非空微信 token 与合法 `@im.wechat` 用户 ID，缺失结果必须失败。
- 不修改 cc-connect 源码或授权命令协议。

## Acceptance Criteria

- [x] 微信为空 + Telegram 启用但 allowlist 为空时，授权预处理成功，Telegram 自动禁用。
- [x] 微信为空 + Telegram/飞书配置有效且启用时，授权后仍保持启用。
- [x] 微信存在无效旧 allowlist 时可以重新授权。
- [x] 正常 Profile 校验仍拒绝启用但空白的非微信平台。
- [x] 微信授权配置仍只启用微信，并将 token/allow_from 留空交给 cc-connect setup 写回。
- [x] Rust 聚焦测试、完整 cc-connect tests、`cargo check`、TypeScript 检查通过。

## Scenario Matrix

- 微信状态：首次授权空值、已有合法 ID、已有无效旧 ID、重新授权。
- 其他平台：全部禁用、启用且有效、启用但空值、多个平台有效/无效混合。
- 进程状态：cc-connect 已停止、正在运行、已有授权进行中。
- 代理：关闭、自动探测、显式 HTTP/SOCKS 代理。
- 二进制：自动检测、显式路径、版本/校验不兼容。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
