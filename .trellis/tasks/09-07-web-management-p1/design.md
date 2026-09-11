# 技术设计

## 分阶段交付

1. **P1-0 运行时配置**：为独立 Axum Web 服务增加 bind 地址/端口的统一解析；支持环境变量和命令行覆盖，并让 Vite 代理读取同一配置。
2. **P1-1 项目上下文**：复用 P0 的 ID-only 工作区快照；前端把项目/Worktree 选择作为所有文件、Diff、Git 操作的唯一上下文。
3. **P1-2 文件与 Diff**：在右侧工具 Dock 增加文件树、预览、搜索和 Diff 状态；结果按 operation 状态更新，内容按需加载。
4. **P1-3 Git 与 Worktree**：复用桌面端现有 Git/Worktree action bus，先实现只读状态，再接入暂存、提交和高风险网络/分支操作。
5. **P1-4 收口**：补齐 capability 门禁、离线只读、请求幂等、版本冲突、移动端、键盘和中英文测试。

## 端口配置模型

- `CLI_MANAGER_WEB_BIND` 作为部署环境覆盖，值为 `host:port`，默认 `127.0.0.1:8787`。
- 可选 `CLI_MANAGER_WEB_BIND_FILE` 指向用户可编辑的 TOML 配置文件；环境变量优先于文件，命令行显式 `--bind` 优先级最高。
- 配置值统一解析为 `SocketAddr`，非回环监听必须启用 Secure Cookie；健康日志只输出最终 bind，不打印凭据。
- `apps/web/vite.config.ts` 读取 `VITE_WEB_SERVER_URL`，开发代理不再固定使用 8787；生产 Web 由 Axum 静态服务提供。

## 数据流与失败处理

浏览器 -> Web API/WS（ID + 相对路径） -> 桌面 operation queue -> 本地项目/Git/File command -> operation.updated -> 浏览器。

所有写操作只在收到桌面终态回执后显示成功；设备离线或 capability 缺失时在提交前阻止请求。服务器端持久化最近快照用于只读展示，并标记 `live/cached/stale`，不得由 Web 生成项目事实。
