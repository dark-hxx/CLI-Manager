# 设计：PTY daemon 断连诊断与重连提示

## 目标

把 `PtyHost WebSocket disconnected` 从“裸错误”变成“可定位、可恢复”的诊断链路。

## 方案

1. `PtyHostSocket` 负责连接生命周期日志。
2. 断开时统一记录 close / error / heartbeat timeout 的上下文。
3. 重连时记录开始、成功、失败。
4. `XTermTerminal` 只处理用户提示，不接管 transport 逻辑。
5. i18n 只补少量终端断连提示文案。

## 风险

- 日志过多会增加噪音，所以只打关键生命周期点。
- 前端提示变化会影响用户感知，需要保持文案简短。
