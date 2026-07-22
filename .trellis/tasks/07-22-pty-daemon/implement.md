# 实施顺序

1. 更新 `src/terminal/transport/PtyHostSocket.ts`
   - 补充 connect / auth / disconnect / reconnect / heartbeat 日志
   - 保留现有自动重连逻辑
   - 不改 daemon 启动模型
2. 更新 `src/components/XTermTerminal.tsx`
   - 对断连类写入失败显示更准确的提示
3. 更新 `src/lib/i18n.ts`
   - 补终端断连提示的 `zh-CN` / `en-US`
4. 更新 `CHANGELOG.md`
   - 写入 `V1.3.1`
5. 验证
   - `npx tsc --noEmit`
   - `git diff --check`
