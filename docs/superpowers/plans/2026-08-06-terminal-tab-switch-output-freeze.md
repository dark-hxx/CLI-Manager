# 多会话持续输出时切换 Tab 卡死实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 限制后台聊天会话的 xterm 输出批次，并跳过隐藏会话的 TUI 后处理，避免持续输出阻塞 Tab 切换，同时保持完整输出和 ACK 契约。

**Architecture:** `useTerminalDisplay` 继续拥有每个会话的 PTY 输出队列，但 live frame 只按完整 frame 边界合并到固定字节预算；每批 write callback 完成后再调度下一批。`terminalTuiColorSync` 增加可见性判断，`XTermTerminal` 仅在可见状态触发颜色同步，切回可见时由现有 visibility effect 补做一次同步。

**Tech Stack:** React hooks、TypeScript、`@xterm/xterm`、Node.js 内置测试运行器、TypeScript 编译器、Vite。

## Global Constraints

- 不修改 daemon、PTY 边界、ConPTY、ACK 时机、Replay/Reset 屏障或 xterm 版本。
- live frame 只在完整 frame 边界合并；单个超预算 frame 独立处理，不在前端二次切割 ANSI/UTF-8。
- ACK 只能来自 xterm `write` callback 之后的现有 `TerminalOutputDelivery.commit()` 路径。
- 隐藏会话继续写入 xterm 并保留完整 buffer，只跳过 TUI 颜色/背景后处理。
- 不新增依赖；所有用户可见 PR 文案使用中文。
- 每个实现步骤遵循先写失败测试、确认失败、再写最小生产代码、确认通过。

---

### Task 1: 锁定有界 live 批处理回归

**Files:**
- Modify: `scripts/terminalReplay.test.mjs`，在现有 `FakeTerminal` 输出队列测试之后增加连续 live frame 场景。
- Create: `scripts/terminalTuiColorSync.test.mjs`，测试隐藏状态不触发 TUI 扫描。

**Interfaces:**
- Consumes: 当前 `useTerminalDisplay().attachPtyOutput()`、`managerStub.emitOutput()`、`FakeTerminal.finishNextWrite()` 和 `createTerminalTuiColorSyncController()`。
- Produces: 对批次上限、write callback 顺序、ACK 顺序和隐藏颜色同步的失败回归。

- [ ] **Step 1: 增加连续 live frame 的失败测试**

在 `scripts/terminalReplay.test.mjs` 使用两个 40 KiB 的 live frame；目标预算为 64 KiB，所以期望第一帧单独写入，第一帧 callback 和下一动画帧之后才写入第二帧：

```js
test("continuous live output yields between bounded xterm writes", async () => {
  managerStub.resetManager();
  const { display, terminal, events, detachViewport } = createDisplay();
  const commits = [];
  const output = display.attachPtyOutput();
  await output.ready;
  const firstText = "a".repeat(40 * 1024);
  const secondText = "b".repeat(40 * 1024);

  managerStub.emitOutput(delivery(frame(3, firstText, 120, 30), commits));
  managerStub.emitOutput(delivery(frame(4, secondText, 120, 30), commits));
  flushNextAnimationFrame();

  assert.deepEqual(events, [`write:${firstText}`]);
  terminal.finishNextWrite();
  flushNextAnimationFrame();
  assert.deepEqual(events, [`write:${firstText}`, `write:${secondText}`]);
  terminal.finishNextWrite();
  assert.deepEqual(commits, [
    { sequence: 3, charCount: firstText.length },
    { sequence: 4, charCount: secondText.length },
  ]);
  output.dispose();
  detachViewport();
});
```

- [ ] **Step 2: 增加隐藏 TUI 同步的失败测试**

创建临时模块替换 `terminalTuiDisplay` 和 `TerminalCliContext`，让 `normalizeTerminalTuiComposerBackground()` 记录调用次数；先以 `isVisible: false` 直接调用 controller 的 `normalize()` 和调度回调，期望调用次数为 0，再切换为 `true`，期望调用次数为 1。测试只验证可见性策略，不依赖真实 DOM 或 xterm renderer：

```js
const options = { isVisible: false, isTransparent: false, isLightTheme: false,
  terminalTextColor: undefined, tuiUserColor: undefined, tuiAssistantColor: undefined,
  getContext: () => ({}) };
const controller = createTerminalTuiColorSyncController(() => options);
controller.normalize({});
assert.equal(normalizeCalls, 0);
options.isVisible = true;
controller.normalize({});
assert.equal(normalizeCalls, 1);
```

- [ ] **Step 3: 运行新增测试确认按预期失败**

运行：

```bash
node --test scripts/terminalReplay.test.mjs scripts/terminalTuiColorSync.test.mjs
```

预期：有界 live write 测试失败并显示当前一次写入包含两个 40 KiB frame；隐藏 TUI 测试失败并显示当前 controller 仍执行扫描。基线已有的 Replay 测试保持通过。

### Task 2: 实现有界 live 输出批处理

**Files:**
- Modify: `src/hooks/useTerminalDisplay.ts:24-47`，增加批次预算和 `PendingTerminalWrite.byteLength`。
- Modify: `src/hooks/useTerminalDisplay.ts:252-340`，限制连续 live frame 合并范围。
- Test: `scripts/terminalReplay.test.mjs`。

**Interfaces:**
- Consumes: `TerminalBinaryFrame.data.byteLength` 和现有 `TerminalOutputDelivery.commit()`。
- Produces: `terminal.write()` 每次最多合并 `PTY_LIVE_WRITE_BATCH_BYTES` 的连续 live frame，并继续调用每个 frame 的 commit。

- [ ] **Step 1: 增加原始字节长度和预算常量**

在 `HIDDEN_WEBGL_DISPOSE_DELAY_MS` 旁增加：

```ts
const PTY_LIVE_WRITE_BATCH_BYTES = 64 * 1024;
```

在 `PendingTerminalWrite` 增加：

```ts
byteLength: number;
```

在 `queuePayload()` 推入队列时设置 `byteLength: payload.data.byteLength`。

- [ ] **Step 2: 让 live flush 在 frame 边界达到预算即停止**

保留 Replay/Reset 的单项屏障；将普通 live 分支改为按预算收集：

```ts
const first = ptyPendingChunksRef.current.shift();
if (!first) return;
const pending = [first];
let pendingBytes = first.byteLength;
if (!first.replay && !first.reset) {
  while (ptyPendingChunksRef.current[0]) {
    const next = ptyPendingChunksRef.current[0];
    if (next.replay || next.reset) break;
    if (pending.length > 0 && pendingBytes + next.byteLength > PTY_LIVE_WRITE_BATCH_BYTES) break;
    pending.push(ptyPendingChunksRef.current.shift()!);
    pendingBytes += next.byteLength;
  }
} else {
  // 保持现有 Replay/Reset 尺寸屏障逻辑不变。
}
```

一个超预算的首 frame 会独立处理；后续 frame 会留在队列中，由 write callback 后的下一动画帧继续处理。

- [ ] **Step 3: 运行有界批处理测试确认通过**

运行：

```bash
node --test scripts/terminalReplay.test.mjs
```

预期：连续 live output 测试和全部既有 Replay/Reset/resize 测试通过，两个 frame 的 commit 和 ACK 顺序仍为 3、4。

- [ ] **Step 4: 提交独立的输出队列修复**

```bash
git add src/hooks/useTerminalDisplay.ts scripts/terminalReplay.test.mjs
git commit -m "fix(terminal): bound live output batches"
```

### Task 3: 让隐藏会话跳过 TUI 后处理

**Files:**
- Modify: `src/lib/terminalTuiColorSync.ts:14-68`，在 controller options 中加入 `isVisible` 并在 normalize 入口拦截隐藏状态。
- Modify: `src/components/XTermTerminal.tsx:667-676`，向 controller 提供当前可见性。
- Modify: `src/components/XTermTerminal.tsx:758-761`、`869-870`、`1593-1599`，隐藏状态不调用 normalize/schedule；可见性 effect 保留一次完整同步。
- Test: `scripts/terminalTuiColorSync.test.mjs`。

**Interfaces:**
- Consumes: `isVisibleRef.current`。
- Produces: 隐藏终端的 controller normalize 直接返回；可见性恢复 effect 继续调用现有 normalize/schedule。

- [ ] **Step 1: 增加 controller 的可见性输入和失败行为**

把 `TerminalTuiColorSyncOptions` 增加：

```ts
isVisible: boolean;
```

并在 `normalize()` 读取 options 后立即加入：

```ts
if (!options.isVisible) return;
```

在 `XTermTerminal` 的 `getOptions` 返回值中加入 `isVisible: isVisibleRef.current`。

- [ ] **Step 2: 收紧写入、主题和 render/scroll 触发点**

调用点统一使用当前可见性：

```ts
displayAfterWriteRef.current = (terminal) => {
  if (!isVisibleRef.current) return;
  tuiColorSync.normalize(terminal);
  tuiColorSync.schedule(terminal);
};
```

主题 effect 和 `terminal.onRender`、`terminal.onScroll` 也只在 `isVisibleRef.current` 为真时触发同步；已有 `isVisible` effect 在切回可见时保留 `normalize()` 和 `schedule()`，作为唯一补偿入口。

- [ ] **Step 3: 运行隐藏状态回归和已有终端测试**

运行：

```bash
node --test scripts/terminalTuiColorSync.test.mjs scripts/terminalReplay.test.mjs scripts/terminalVisibility.test.mjs
```

预期：隐藏 controller 不调用 TUI 扫描，可见 controller 调用一次；所有终端 Replay、resize 和 visibility 测试通过。

- [ ] **Step 4: 提交隐藏后处理修复**

```bash
git add src/lib/terminalTuiColorSync.ts src/components/XTermTerminal.tsx scripts/terminalTuiColorSync.test.mjs
git commit -m "fix(terminal): skip hidden TUI post-processing"
```

### Task 4: 全量验证和交付

**Files:**
- Modify: `.trellis/tasks/08-06-fix-terminal-tab-switch-output-freeze/design.md` only if implementation evidence requires a factual correction。
- Create: `.trellis/tasks/08-06-fix-terminal-tab-switch-output-freeze/pr-body.md`，记录中文 PR 描述。
- Test: `scripts/terminalReplay.test.mjs`、`scripts/terminalTuiColorSync.test.mjs` 以及项目现有 Node 测试。

**Interfaces:**
- Consumes: Task 2 和 Task 3 的可验证行为。
- Produces: 可审查的中文 PR 分支和验证记录。

- [ ] **Step 1: 运行所有现有 Node 回归测试**

运行：

```powershell
Get-ChildItem scripts -Filter '*.test.mjs' | ForEach-Object { node --test $_.FullName }
```

预期：所有测试进程退出码为 0；若发现与本次改动无关的基线失败，记录测试文件和原始错误，不修改无关代码。

- [ ] **Step 2: 运行静态检查、构建和 diff 检查**

运行：

```bash
npx tsc --noEmit
npm run build
git diff --check
git status --short
```

预期：TypeScript 无错误，Vite 构建退出码为 0，diff 无空白错误，工作区只包含设计/计划、三个实现文件和两个测试文件（以及交付阶段新增的中文 PR body）。

- [ ] **Step 3: 执行人工场景验证**

在本地 Vite/Tauri 窗口中打开至少三个聊天会话，让一个会话持续产生 Claude/Codex 高频输出，在输出过程中反复切换 Tab、分屏和 Workspan；确认 UI 可响应、切回后输出完整且 TUI 颜色正常。再验证普通 shell、Replay 和断线重连场景。

- [ ] **Step 4: 运行变更影响检查并请求代码审查**

GitNexus 当前不可用，因此用 `rg`、`git diff --stat` 和人工调用链检查确认触点只在终端显示层；审查重点是 frame 边界、ACK 顺序、隐藏可见切换和重挂载行为。代码审查通过后再继续推送。

- [ ] **Step 5: 合并提交并创建中文 PR**

```bash
git push -u origin codex/fix-terminal-tab-switch-output-freeze
gh pr create --repo dark-hxx/CLI-Manager \
  --base master \
  --head nova-bryan:codex/fix-terminal-tab-switch-output-freeze \
  --title "修复：多会话持续输出时切换 Tab 卡死" \
  --body-file .trellis/tasks/08-06-fix-terminal-tab-switch-output-freeze/pr-body.md
```

PR body 必须使用中文，包含问题现象、根因、两项修复、ACK/Replay 保持不变、自动化测试、构建结果和人工验证范围。
