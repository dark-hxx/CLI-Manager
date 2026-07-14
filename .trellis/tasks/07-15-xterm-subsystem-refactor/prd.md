# XTermTerminal 子系统化重构

## Changelog Target

[TEMP]

## Goal

对 `XTermTerminal.tsx`（3822 行）进行架构级重构，将当前"一个上帝 effect（E12，2570 行）持有 terminal 实例 + 40 个 ref 在同一闭包共享"的结构，重构为"编排层 + 3 个子系统（Display/Input/Osc）+ 明确的 ref 所有权契约"，使得**修改 A 子系统的内部逻辑物理上不能影响 B 子系统**。

同时修复两个可见性相关 bug：
- **a**：切换 tab 时从左上到右下重绘一次（无积压时不应整屏 refresh）
- **b**：Codex TUI 切回时滚动条从顶部跳到底部（全屏 TUI 不应重放隐藏期输出）

## Requirements

### 架构目标

1. **编排层**：E12 退化为"创建 terminal → 按序同步 attach 各子系统 → 快照恢复 → cleanup"的薄 effect（~100 行），不再持有 2500 行闭包逻辑。
2. **子系统化**：拆为 3 个 controller-shaped hook（持有 React state 桥接 UI，返回 `attach(terminal): Disposable` 命令式接口）：
   - `useTerminalDisplay`（J+C 合并）：WebGL/主题/背景/写队列/fit/可见性恢复
   - `useTerminalInput`（F/G/H/B）：影子缓冲/选区/建议/IME/转发
   - `useTerminalOsc`（D）：OSC 解析，作为 Display 写入前的转换步骤
3. **ref 所有权契约**：跨子系统共享的 ref 明确"谁拥有、谁只读"：
   - `terminalRef`：编排层创建，各 hook 只读
   - `isComposingRef`：Input 拥有写，Display 只读（抑制 fit）
   - `isVisibleRef`：编排层镜像 prop，Renderer/Viewport 只读
   - `inputBuffer`/`inputCursorIndexRef`：Input 完全私有
   - `webglAddonRef`/`activeWrite*`/`inactiveBuffer*`：Display 完全私有
4. **单向依赖**：Input 依赖 Display（`enqueueActiveWrite`），Display 依赖 Osc（`normalize*`），无循环。
5. **三条明文契约**（代码注释标注）：
   - `isComposingRef` 是 Input→Display 的行为契约：组字期间抑制 fit，避免输入法候选框尺寸抖动
   - `useTerminalInput.attach()` 第一步必须集中重置 15 个内部状态（选区 2 + 建议 13 个 let→ref）
   - `pty-output` 监听归 Display（输出方向），`onData` 归 Input（输入方向）

### 施工顺序（5 个独立 commit）

| 步骤 | 内容 | 行为变化 | 验证 |
|---|---|---|
| 1 | 编排骨架：E12 → "创建 + 同步 attach"形态（先不拆子系统，只改结构） | 否 | 切 tab/快照恢复/首屏输出不丢 |
| 2 | 抽 `useTerminalOsc`（D 剩余） | 否 | OSC 状态灯/cwd/Codex 颜色 |
| 3 | 抽 `useTerminalDisplay`（J+C 合并） | 否 | 主题/背景/WebGL/切 tab/隐藏重放/resize |
| 4 | 抽 `useTerminalInput`（F/G/H/B + 集中重置） | 否 | 中文 IME/选区/建议/Ctrl+C/切 session |
| 5 | 修复 a/b（在干净的 Display 里） | **是** | 切 tab 无重绘扫描/Codex 无滚动跳 |

### bug a 根因与修法

**根因**：`planTerminalVisibilityRestore` 的 `shouldRefreshViewport = becameVisible`（无条件），导致无积压的 tab 切换也走整屏 refresh + 揭示，而揭示门槛只需 ≥1 行渲染完成（`MIN_FULL_VIEWPORT_COVERAGE_ROWS=1`），用户看到"揭示后剩余行还在逐行画" = 左上到右下扫描。

**修法**：无积压时 `shouldRefreshViewport = false`，只做 fit。或：提高揭示门槛，严格等整屏（但 a 方案更合理——内容没变就别整屏刷）。

### bug b 根因与修法

**根因**：Codex 全屏 TUI 隐藏期间的输出被塞进 `inactiveBufferRef`，切回时整段重放 write。TUI 输出是"面向当时屏幕状态的增量重绘指令"，脱离上下文重放 → 中间态滚动跳动。

**修法**：全屏 TUI 会话（判定：`isCodexSession` 或 alt-screen 激活）不累积 inactive buffer，切回时让 TUI 自己重绘当前帧。或：重放时不逐帧 scrollToBottom，只在重放完成后一次性定位。

## Non-Goals

- 不改 JSX 渲染结构（背景层/绘制层/搜索框/右键菜单保持原样）
- 不改已抽出的 K（Search）/L（ContextMenu）/D 的 lib（`terminalOscParse`）
- 不把 hook 改成纯类（controller-shaped hook 是折中方案，保留 React state 便利）
- 不改 PTY 后端、shell 集成、WebDAV 同步、Git 操作等其他模块

## Success Criteria

1. 步骤 1-4 完成后，`XTermTerminal.tsx` 从 3822 行降到 ~1200 行（编排层 ~100，JSX ~800，剩余工具函数）
2. 三个新 hook 文件创建：`src/hooks/useTerminalDisplay.ts`（~600 行）、`src/hooks/useTerminalInput.ts`（~700 行）、`src/hooks/useTerminalOsc.ts`（~150 行）
3. 所有现有功能保持不变（tsc 通过 + 手动验证通过）
4. 步骤 5 完成后，a/b 两个 bug 消失

## Constraints

- 每步独立 commit，禁止攒着
- 步骤 1-4 禁止改行为（纯重构），步骤 5 才允许行为变更
- cleanup 对称性严格保持：6 个 disposable + 10+ DOM 监听 + 2 个 Tauri/snapshot 句柄，迁移时不可遗漏
- 15 个闭包 let→ref 的重置语义必须精确保持"随 sessionId 重建"

## References

- 已完成的第2层抽离：
  - `f1980a6` 域K 搜索 → `useTerminalSearch`
  - `4419f91` 域L 右键菜单 → `useTerminalContextMenu`
  - `cde76a5` 域D OSC 解析 → `lib/terminalOscParse`
- 第1层纯函数抽离：`fa85bb4` 及更早 commit
- Review 结论：
  - 放弃 `terminalReady` state 编排，采用同步 attach
  - J（Renderer）与 C（Viewport）合并为 `useTerminalDisplay`（共享 `webglAddonRef` 所有权）
  - 采用 controller-shaped hook（hook 持有 state，返回 attach/dispose 命令式接口）

## Risks

- **步骤 1 最高风险**：改变 terminal 实例持有方式 + 事件绑定时序，可能短暂引入"首屏输出丢失"/"onData 未绑定"等时序 bug
- **步骤 4 次高风险**：15 个 let→ref 生命周期语义变化，若重置逻辑有误 → 选区错乱/建议竞态/IME 串味
- 所有步骤都必须"改完→tsc→手动验证全量功能"，不能跳验证

## Open Questions

- 步骤 1 的 attach 调用顺序是否需要可配置？当前设计：Display → Input，是因为 Input 依赖 Display 的 `enqueueActiveWrite`。若未来有新子系统，顺序如何管理？
- `isComposingRef` 也被域 C 的 `fitWhenStable` 读取，这个跨界是否该重新设计？还是承认它就是一个合理的跨子系统契约？（当前结论：承认，明文契约化）
