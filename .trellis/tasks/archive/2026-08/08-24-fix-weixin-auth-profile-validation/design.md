# 微信授权 Profile 校验修复设计

## 设计

新增授权专用 Profile 准备函数，位于 `normalize_profile` 与 `start_weixin_authorization` 同一后端模块：

1. hydrate 多平台配置。
2. 微信平台强制启用，并临时使用合法占位 ID 通过公共 Profile 规范化；旧微信 allowlist 无效时视为待重新授权，而不是失败。
3. 非微信平台若启用且 allowlist 无效，则仅将 `enabled` 设为 false，保留其 allowlist 文本和凭据；有效平台保持原状态。
4. 调用现有 `normalize_profile` 复用项目、代理、二进制与公共字段校验。
5. 规范化完成后恢复微信原有合法 allowlist 或空值。授权临时配置仍由 `build_weixin_authorization_config` 仅启用微信，并把 token/allow_from 清空交给 cc-connect setup。
6. 扫码完成后合并新微信 ID并走现有严格 `save_profile_locked`；由于未完成的其他平台已被禁用，持久化可成功，完整平台不受影响。

## 发现清单

- `start_weixin_authorization`：错误触发点和修复接入点，修改。
- `normalize_profile`：常规保存/启动严格校验，复用且不放宽。
- `build_weixin_authorization_config`：授权临时配置只启用微信并清空凭据，复核、不改变协议。
- `finish_weixin_authorization` / `save_profile_locked`：扫码结果持久化，复核，依赖准备后的有效 Profile。
- `parse_weixin_authorization_result`：继续强制 token 与 `@im.wechat` ID，确认无关。
- `CcConnectSettingsPage.startWeixinAuthorization`：原样传递多平台草稿并展示后端错误，确认无需修改。
- `cc-connect` 源码与 CLI 协议：不修改。

GitNexus MCP/CLI 当前不可用，`npx --offline` 无缓存；使用 `rg`、源码、Git blame 和现有测试降级。影响范围局限于微信授权准备和随后 Profile 保存，正常连接校验不变。

## 验证

- 单元测试锁定无效其他平台禁用、有效其他平台保留、无效旧微信 ID可重新授权。
- 保留/扩展授权 TOML 测试，确认临时配置不含凭据。
- 运行 `cargo test commands::cc_connect::tests --lib`、`cargo check`、`cargo fmt --check`、TypeScript 检查和 `git diff --check`。
