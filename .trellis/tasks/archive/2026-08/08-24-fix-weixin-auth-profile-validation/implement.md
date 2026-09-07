# 实施计划

1. 添加授权专用 Profile 准备函数，保持常规 `normalize_profile` 严格语义。
2. 将 `start_weixin_authorization` 改为使用专用准备函数。
3. 增加多平台空值、合法配置、旧微信 ID 和正常严格校验回归测试。
4. 更新 `[TEMP]` CHANGELOG、功能清单、cc-connect 契约和 verification。
5. 执行聚焦测试、编译、格式与变更范围检查。
