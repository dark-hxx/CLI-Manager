# 路由历史用量异常详情设计

## 范围与边界

本任务只扩展本地 routed usage record 的失败诊断链路：路由器捕获安全的错误摘要，SQLite 记录错误码与安全详情，历史请求日志 command 原样返回这些字段，前端在状态列给出本地化摘要并打开详情 dialog。统计汇总、路由重试/故障切换、session-log parser 和远端历史来源不改变。

## 数据流与契约

```text
route_http failure / error response / stream terminal error
  -> UsageCapture(error_detail?) + stable error_code/status
  -> usage::record_route_usage
  -> usage_records.error_code + error_detail
  -> unified_usage_records
  -> history_list_request_logs / RequestLogItem
  -> RequestLogsView summary + detail Dialog
```

### 持久化字段

* `error_code: Option<String>`：稳定的内部路由错误码；现有字段继续保留并透传。
* `error_detail: Option<String>`：可选、安全的诊断文本；只对新记录写入。它不是原始 HTTP body 的镜像。
* `status_code`、`outcome`、`provider_name`：复用现有字段，在详情中提供上下文。

数据库迁移使用下一连续版本（当前为 v32）：

* 新建库的 `usage_records` 定义包含 `error_detail`。
* 升级库先 `ALTER TABLE ... ADD COLUMN error_detail TEXT`，再重建 `unified_usage_records`。
* 所有创建/重建 view 的 SQL 都显式选择 `error_code`、`error_detail`，避免测试 schema 与生产 schema 漂移。
* 旧行默认 `NULL`，不回填、不删除任何数据。

## 错误详情安全策略

1. 仅从 JSON 错误对象的受控诊断字段提取可显示文本，例如 `error.message`、`error.detail`、顶层 `message` / `detail`；不序列化整个 object/body。
2. 文本先去空白、限制长度，再遮蔽 Bearer token、常见 API-key/token 字段和值以及可识别的密钥前缀；无安全文本时保持 `None`。
3. 网络发送失败、超时、circuit/key skip 与无法读取 body 的路径使用稳定 error code 和现有 HTTP status，不伪造上游消息。
4. 对 SSE 流的终端 error/failed event，从同一受控 JSON 字段提取详情；流超时或取消仍仅提供本地错误码。

## 前端呈现

* `RequestLogItem` 增加可选 `error_code`、`error_detail`，normalizer 对旧 payload 保持 `null`。
* 当 route record 为失败/skip 或具有错误码时，状态单元显示本地化错误摘要（优先映射稳定 code；未知 code 回退到 HTTP 状态/通用失败摘要），不再显示“usage 不适用”。
* 状态单元提供“查看异常详情”按钮；dialog 使用现有 Radix Dialog 原语，显示本地化标题、摘要、provider、HTTP status、错误码及详情文本（如果存在）。
* 正常记录、session-log fallback、成功但遗漏 usage 的记录保持既有 usage-status 展示；旧失败记录可显示已知错误码/status，详情缺失则使用明确的空状态。
* 新增文本添加 `zh-CN` 与 `en-US`，包括按钮/title/aria、详情字段标签、无详情状态和未知错误回退。

## 兼容性与风险

* IPC command 名称和既有字段保持不变，仅增加 optional response fields。
* 同一张 `unified_usage_records` view 仍供统计与列表使用；新字段不参与聚合或去重，统计口径不变。
* API key/secret 脱敏是数据写入前的唯一权威边界；UI 不再尝试自行脱敏或解析原始响应。
* 流式、非流式、预发送 skip 与 retry/failover 共享 `record_route_usage` 持久化路径，必须在每种分支确认不改变 attempt/circuit 语义。

## 验证设计

* Rust unit tests：受控字段提取、长度限制和秘密遮蔽；route record 列表能返回 code/detail；旧 `NULL` 字段兼容；迁移加列并重建 view。
* 前端 type/build：optional payload 字段和详情 dialog 编译；中英文键完整。
* 手动桌面验证：启用路由后制造可复现失败，确认列表摘要、详情 dialog、键盘 Escape/焦点、长详情滚动与成功记录不回归。
