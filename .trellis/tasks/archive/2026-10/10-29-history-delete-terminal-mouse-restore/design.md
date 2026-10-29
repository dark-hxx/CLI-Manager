# 设计与分诊

## 根因
1. Store 在源删除与元数据清理成功后仍 await 下一条详情；详情发现 catalog dirty 又 await 串行全库刷新。09:02:47 日志单条 FTS 删除达 22.03 秒。删除锁及弹窗因错误的完成边界一直持有；下一条错误甚至计为删除失败。
2. xterm SerializeAddon 只保存鼠标 tracking，不保存 DEFAULT/SGR/SGR_PIXELS 编码。真实浏览器已复现 SGR 原终端序列化后恢复为 legacy ESC[M。

## 最小充分修复
- 源删除成功后结算并更新列表；自动详情另行加载并独立记录错误，保留同步取得删除执行权及 finally 释放。
- dirty 详情直接按原路径/来源校验读取目标，catalog 刷新后台执行；缓存详情必须确认文件仍存在和指纹匹配。OpenCode locator 不当普通文件处理。
- 统一快照序列化适配器补足真实 mouse encoding 和 tracking 的显式开启/关闭状态，前后顺序保证新终端与原有终端重放均一致，尾部保留完整状态。
- xterm 暂无公开 encoding getter，封装只读内部 MouseStateService 访问并对未知值失败关闭；真实安装版 xterm 浏览器测试约束升级边界。不修改 node_modules。
- 旧快照不可凭空找回丢失编码：只在明确的 snapshot/checkpoint 边界暂停不完整快照的鼠标跟踪，直到应用重新声明模式；不得猜 SGR，也不得改原始 replay/live 的合法 legacy 鼠标。新快照保真，不受此兼容措施影响。旧 daemon 用持久快照的精确尾部身份识别已知 checkpoint，不对普通输出做启发式识别。

## 触点与风险
- HistoryWorkspace/ConfirmDialog：确认只消费现有 pending，保留保护，不改共享行为。
- historyStore、history_get_session、catalog/session_detail：修完成边界、dirty 读取和缺失源验证；源备份/删除/回滚确认无关，保留。
- useXTermController 的定时/卸载快照、静态恢复、useTerminalDisplay 的 attach/reconnect、daemon SessionBuffer checkpoint：核对全部生产入口。
- Web/Tap 消费同一 checkpoint 字节，无需新增 wire 契约；query responder 所有权、写屏障、历史尺寸、ACK 顺序保持。
- 受影响共享终端恢复链路为高风险，实施前已告知。GitNexus 未开放，使用领域契约、codebase-memory 与源码/测试交叉核对；memory 对 TS 动态 Store 调用缺边，以源码为准。

## 发布与回滚
桌面 JS 嵌入主程序，不能只重封旧 exe；复用 Cargo 缓存重建主程序和必要 helper 后 NSIS。可用上一验证包回滚程序，不删除用户历史/工作区数据；旧缺编码 checkpoint 不承诺恢复不可知的原模式。
