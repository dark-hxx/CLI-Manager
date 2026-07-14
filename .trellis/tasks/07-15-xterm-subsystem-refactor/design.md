# XTermTerminal.tsx 重构设计方案（终版）

> 本文档是经过一轮 review 修正后的**终版**设计。它记录的不仅是"拆到哪里"，
> 更是"为什么这样拆才是最优解"——包括被否掉的方案和否掉的理由。

## 1. 问题陈述：为什么改不动

当前 `XTermTerminal.tsx`（3822 行）的核心矛盾不是"文件长"，而是**耦合结构**：

1. **上帝 effect（E12，911-3479 行，约 2570 行）**：整个终端的生命周期、
   输入、输出、渲染、可见性、OSC 全塞在一个 `useEffect` 里。terminal 实例
   作为闭包常量被 45 个内部函数共享。
2. **40+ 个 ref 平铺在组件顶层**：没有归属，谁都能读谁都能写。改一个 ref 的
   写入时机，可能悄悄影响另一个读它的函数。
3. **15 个闭包 `let` 变量**：靠"effect 随 sessionId 重建"来隐式重置。这个重置
   语义是隐性的，一旦把逻辑挪出去就容易丢。

结论：**改 A 影响 B 的根源是"共享闭包常量 terminal"+"无 ref 所有权契约"**。
不解决这两点，纯搬迁只是把 2570 行拆到几个文件里，耦合一点没少。

## 2. 目标架构

```
XTermTerminal.tsx (编排层 ~100 行 + JSX ~800 行)
  │
  ├─ useTerminalOsc()      → attach(terminal): Disposable    [域 D]
  ├─ useTerminalDisplay()  → attach(terminal): Disposable    [域 J+C]
  └─ useTerminalInput()    → attach(terminal): Disposable    [域 F+G+H+B]

依赖方向（单向，无环）：
  Input ──enqueueActiveWrite──▶ Display ──normalize*──▶ Osc
```

三个子系统各自是一个 **controller-shaped hook**：

- 它是 React hook（能持有 state、用于 UI 桥接，比如搜索命中数、建议气泡）
- 但它对外暴露的是**命令式接口** `attach(terminal): Disposable`
- terminal 实例由编排层创建后**同步传入**，hook 内部不持有"terminal 就绪"的
  异步状态

### 为什么是 3 个而不是 5 个（J+C 合并的理由）

review 前的方案把 J（Renderer：WebGL/主题/背景）和 C（Viewport：可见性/写队列/
fit）拆成两个 hook。否掉，原因：

1. **共享可变 ref 所有权**：`webglAddonRef` 既被 Renderer 创建/销毁，又被
   Viewport 的可见性恢复读取。拆开后这个 ref 要么放编排层（污染编排层），
   要么互相 import（假解耦）。
2. **共享行为**：`syncWebglRenderer` 被两边调用。切 tab 恢复（C）时要重建
   WebGL（J），主题变化（J）时要触发 fit（C）。它们的调用链是缠绕的。
3. **高内聚**：两者都围绕"终端的视觉呈现"这一件事。合并成 `useTerminalDisplay`
   后，`webglAddonRef` / `activeWrite*` / `inactiveBuffer*` 全部成为它的**私有
   ref**，编排层和其他子系统碰不到。

> 教训：拆分的边界应该落在"内聚度低"的地方，而不是"功能名词不同"的地方。
> J 和 C 是两个名词，但它们是一件事。

## 3. 三个关键设计决策（及被否方案）

### 决策一：同步 attach，而非 `terminalReady` state 编排

**被否方案**：编排层用 `const [terminalReady, setTerminalReady] = useState(false)`，
terminal 创建后 `setTerminalReady(true)`，各子系统 `useEffect(() => { if
(terminalReady) attach() }, [terminalReady])`。

**否掉理由**：`setState` 触发的是**下一次渲染**，attach 发生在渲染后的 effect 里。
从 terminal 创建到 attach 之间存在异步 gap。PTY 输出监听（`pty-output-{id}`）如果
在这个 gap 里就位，早期输出会打到一个还没 attach 写队列的 terminal 上 → **首屏
输出丢失**。

**终版方案**：编排层在**同一个 useEffect 内**，创建 terminal 后**立即同步**依次
调用 `osc.attach(t)` → `display.attach(t)` → `input.attach(t)`，再绑定 PTY 监听。
全程无 await、无 setState 中转。attach 返回 Disposable，编排层收集后在 cleanup
里逆序 dispose。

```ts
useEffect(() => {
  const t = new Terminal(opts);
  t.open(containerRef.current!);

  const dOsc = osc.attach(t);       // 先 Osc（Display 写入前的转换）
  const dDisplay = display.attach(t); // 再 Display（Input 依赖它的写队列）
  const dInput = input.attach(t);     // 最后 Input

  restoreSnapshot(t);                 // 快照恢复
  const unlisten = bindPtyOutput(sessionId, t);

  return () => {
    unlisten();
    dInput.dispose(); dDisplay.dispose(); dOsc.dispose(); // 逆序
    t.dispose();
  };
}, [sessionId]);
```

### 决策二：controller-shaped hook，而非纯声明式 React hook

**被否方案**：把每个子系统写成"纯 React"——用 `useEffect` 响应 props/state 变化
自动同步到 terminal。

**否掉理由**：xterm.js 本质是**命令式**的（`write`/`resize`/`dispose` 是调用，
不是声明）。硬套声明式范式，会为了"让 effect 依赖数组正确"而制造大量时序陷阱
（effect 执行顺序、清理时机、StrictMode 双调用）。

**终版方案**：hook 内部**可以**用 state 做 UI 桥接（搜索命中数、建议气泡位置这类
要渲染的东西），但**终端操作走命令式** `attach/dispose`。React 负责"UI 层的状态"，
命令式接口负责"terminal 实例的生命周期"。两者不混。

### 决策三：ref 所有权契约（解决"改 A 影响 B"的核心）

每个跨子系统可见的 ref 明确标注**谁拥有写、谁只读**，写进代码注释。私有 ref 直接
移进对应 hook 内部，物理上其他子系统访问不到。

| ref | 拥有者（写） | 只读方 | 位置 |
|---|---|---|---|
| `terminalRef` | 编排层 | 全部 | 编排层 |
| `isVisibleRef` | 编排层（镜像 prop） | Display | 编排层 |
| `isComposingRef` | Input | Display（抑制 fit） | Input，只读暴露 |
| `inputBuffer` / `inputCursorIndexRef` | Input | — | Input 私有 |
| `webglAddonRef` / `activeWrite*` / `inactiveBuffer*` | Display | — | Display 私有 |

> 关键：把 `webglAddonRef`、`inactiveBufferRef` 这类从组件顶层"平铺 ref"下沉为
> hook 私有 ref，是"改 A 物理上不能影响 B"这句话能成立的技术保证。

## 4. 三条明文契约

重构后跨子系统的耦合只剩三条，全部写进代码注释，作为"合法耦合"备案。任何新人改动
只要不碰这三条，就不可能跨子系统串味。

### 契约 A：`isComposingRef` 是 Input → Display 的行为契约

IME 组字期间（`compositionstart` ~ `compositionend`），Display 的 `fitWhenStable`
必须跳过 fit。否则输入法候选框会因终端尺寸重算而抖动。

- 写方：Input（`onData`/composition 事件）
- 读方：Display（`fitWhenStable` 前置判断）
- 备案理由：这是输入子系统对显示子系统提出的一个显式行为约束，无法用私有化消除，
  故明文契约化，而非视作"隐性耦合"。

### 契约 B：`useTerminalInput.attach()` 第一步必须集中重置内部状态

Input 内部有 15 个随 sessionId 重建的状态（选区相关 2 个 + 建议相关 13 个，原为闭包
`let`，重构后升为 ref）。原逻辑靠"E12 随 sessionId 重跑 → 闭包 let 自动归零"实现重置。
升 ref 后 ref 不会自动归零，故 `attach()` 第一行必须调用 `resetInputState()` 显式清零。

- 风险点：这是步骤 4 的最高风险来源。漏重置 → 切 session 后选区错乱/建议残留/IME 串味。
- 验证锚点：切 session 后首次输入、首次选区、首次建议必须与旧行为逐一比对。

### 契约 C：输出方向归 Display，输入方向归 Input

- `pty-output-{sessionId}` 事件监听 → Display（数据从后端流向屏幕）
- `terminal.onData` 回调 → Input（数据从键盘流向后端）

这条契约划清了"谁监听什么"，避免两个子系统抢注同一事件。cleanup 时各自解绑各自的
句柄，对称性由所属 hook 自己保证。

## 5. 施工顺序（5 个独立 commit）

严格串行，每步独立 commit，步骤 1-4 禁止行为变更（纯重构），仅步骤 5 允许改行为。

| 步骤 | 内容 | 行为变化 | 验证锚点 |
|---|---|---|---|
| 1 | 编排骨架：E12 → "创建 terminal + 同步 attach"形态（暂不拆子系统，只重组结构） | 否 | 切 tab / 快照恢复 / 首屏输出不丢 / onData 已绑定 |
| 2 | 抽 `useTerminalOsc`（D 剩余的有状态部分） | 否 | OSC 状态灯 / cwd 更新 / Codex 颜色 |
| 3 | 抽 `useTerminalDisplay`（J+C 合并） | 否 | 主题 / 背景 / WebGL / 切 tab / 隐藏重放 / resize |
| 4 | 抽 `useTerminalInput`（F/G/H/B + 集中重置） | 否 | 中文 IME / 选区 / 建议 / Ctrl+C / 切 session |
| 5 | 修 a/b（在已经干净的 Display 内） | **是** | 切 tab 无重绘扫描 / Codex 切回无滚动跳 |

**为什么先 1 后 2-4**：步骤 1 只改"terminal 实例怎么被持有、事件何时绑定"，不动子系统
内部逻辑，是风险最高但最基础的一步——把上帝 effect 掰成"骨架 + 待填的 attach 槽位"。
骨架站稳后，2-4 只是把逻辑从骨架搬进各自 hook，每步可独立 tsc + 手动验证。

**为什么先 Osc 后 Display**：Display 写入前要经过 Osc 的 `normalize*` 转换（单向依赖
Display → Osc），先抽 Osc 让 Display 抽离时依赖已就位。

## 6. bug a/b 根因与修法（步骤 5）

### bug a：切 tab 从左上到右下重绘一次

**根因**：`planTerminalVisibilityRestore`（`lib/terminalVisibility.ts:46`）里
`shouldRefreshViewport = becameVisible`，无条件为真。于是无积压的 tab 切换也触发整屏
refresh + 分行揭示，而揭示门槛 `MIN_FULL_VIEWPORT_COVERAGE_ROWS=1` 只要 ≥1 行渲染完成
就揭示 → 用户看到"揭示后剩余行还在逐行画" = 左上到右下扫描。

**修法**：无积压（`inactiveBufferLength === 0` 且写队列空）时 `shouldRefreshViewport = false`，
只做 fit，不整屏刷。内容没变就不该整屏重绘。修改点集中在纯函数
`planTerminalVisibilityRestore`，可直接补单测覆盖各分支。

### bug b：Codex TUI 切回时滚动条从顶跳到底

**根因**：全屏 TUI 隐藏期间输出被塞进 `inactiveBufferRef`（`XTermTerminal.tsx:2842`），
切回时整段重放 write（`:3403`）。TUI 输出是"面向当时屏幕状态的增量重绘指令"，脱离
上下文重放 → 中间态滚动跳动。

**修法**：全屏 TUI 会话（判定 `isCodexSession()` 或 alt-screen 激活）隐藏期不累积
inactive buffer，切回时让 TUI 自己重绘当前帧。备选：重放时不逐帧 `scrollToBottom`，
仅重放完成后一次性定位。首选前者——不累积从源头消除脱上下文重放。

## 7. cleanup 对称性（迁移红线）

E12 当前 cleanup 负责释放：6 个 disposable（onData / onResize / onSelectionChange /
onRender / 各 addon）、10+ 个 DOM 监听（composition / paste / wheel / contextmenu 等）、
2 个 Tauri/snapshot 句柄（pty-output listener + snapshot 定时器）。

重构后每个句柄归属它所在的子系统 hook，由该 hook 的 `attach()` 返回的 `Disposable`
统一释放。编排层 cleanup 只需按 attach 逆序调用各 Disposable，不再手工逐个解绑。
**迁移红线：任何一个句柄迁移时都不可遗漏或改变释放时机，否则泄漏 / 重复绑定。**

## 8. 验证策略

- 步骤 1-4：每步 `npx tsc --noEmit` + 手动跑该步"验证锚点"列出的全部功能，通过才 commit。
- 步骤 5：额外验证 a/b 修复效果，并给 `planTerminalVisibilityRestore` 补单测。
- 全程回归基线：中文 IME、选区复制、命令建议、Ctrl+C、切 tab、切 session、快照恢复、
  Codex 全屏 TUI 进出、resize、主题/背景切换。

## 9. 成功标准

1. 步骤 1-4 后 `XTermTerminal.tsx` 从 3822 行降到 ~1200 行（编排 ~100 + JSX ~800 + 工具函数）。
2. 三个新 hook：`useTerminalDisplay.ts`（~600）、`useTerminalInput.ts`（~700）、`useTerminalOsc.ts`（~150）。
3. 步骤 1-4 全部功能零行为变化（tsc + 手动验证通过）。
4. 步骤 5 后 a/b 消失。
5. 终态可复述为一句话：**改 Display 内部逻辑，物理上碰不到 Input 的任何 ref/句柄，反之亦然。**
