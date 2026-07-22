# 重新优化首页设备管理

## Changelog Target

`[TEMP]`

## Goal

重新设计 Web 首页的桌面设备管理区域，通过自适应卡片网格提升多设备扫描效率，并让设备状态与操作入口更清晰，同时保持 CLI-Manager 现有视觉语言与响应式体验。

## What I already know

- 当前首页由 `apps/web/src/views.tsx` 的 `HostHome` 渲染，页面状态与设备选择由 `apps/web/src/App.tsx`、`apps/web/src/useAppModel.ts` 管理。
- 设备卡片已经展示名称、在线状态、主机/系统、CPU、内存、分辨率、最后心跳和可选壁纸。
- 当前布局是 `repeat(auto-fill, minmax(320px, 1fr))` 的卡片网格；单设备只占一列，宽屏存在大面积无效留白。
- 现有首页操作只有配对、刷新、语言、主题、退出和进入设备；尚无搜索、筛选、重命名、解除配对等设备管理动作。
- 设备状态通过 `device.updated` 实时更新；配对表单已有成功/失败状态。
- 用户提供的截图为 1660x937 浅色桌面视口，当前只有一台在线设备。
- 项目要求新增用户可见文案同时覆盖 `zh-CN` 与 `en-US`，时间保持 24 小时制。
- GitNexus 当前索引缺失，将按契约文档与精确检索降级完成触点发现，实施前再补符号影响检查。

## Requirements

- 保持首页作为登录后的设备入口。
- 优化单设备与多设备情况下的信息层级和操作可发现性。
- 支持按设备名称、主机名或平台搜索，并按全部/在线/离线状态筛选。
- 设备区域使用每行多张的自适应卡片网格；窄屏自动退化为单列卡片。
- 设备列表容器固定为 720px 高度；超出范围的卡片在容器内部纵向滚动，工具栏保持固定。
- 每台设备展示名称、在线状态、系统信息、桌面端软件版本和最后心跳，不展示 CPU、内存、架构或分辨率，并提供明确的“进入工作台”主操作。
- 保留配对、刷新、语言、主题和退出入口，不改变其现有业务行为。
- 首页不展示独立的“桌面主机”标题和说明文字；配对入口放在设备搜索框旁边。
- 覆盖空设备、在线/离线、配对中/成功/失败、窄屏和中英文场景。
- 不引入新的 UI 框架或依赖。

## Acceptance Criteria

- [ ] 宽屏每行可展示多张主机卡片，窄屏自动收敛为单列且无横向溢出。
- [ ] 在线状态、最后心跳、设备名称和进入工作台的主操作可快速识别。
- [ ] 搜索与状态筛选可组合使用；无匹配结果时有明确空状态，并可一键清除筛选。
- [ ] 多设备布局可扫描，并在 320/375/768/1024/1440 宽度下无横向溢出。
- [ ] 所有新增文案和 aria 标签均支持中英文。
- [ ] 配对及设备实时状态更新行为不回归。

## Open Questions

- 无。

## Out of Scope (temporary)

- 不新增设备管理 API、数据库迁移、重命名、解除配对或批量操作。
- 不重做进入设备后的 Workbench。
- 不引入分页、分组、自定义排序或设备标签。

## Technical Notes

- 主要候选触点：`apps/web/src/views.tsx`、`apps/web/src/styles.css`、`apps/web/src/i18n.ts`；若扩展设备生命周期，则还会涉及 Web API、服务端存储与协议契约。
- UI 方向应采用克制的运维工具布局：状态不只依赖颜色，操作有明确反馈，移动端避免横向滚动，弹层需保留焦点管理。

## Verification

- `npm run web:typecheck`：通过。
- `git diff --check -- apps/web/src/views.tsx apps/web/src/styles.css apps/web/src/i18n.ts CHANGELOG.md docs/功能清单.md`：通过，仅有仓库现存 LF/CRLF 提示。
- 中英文新增键逐项检索确认一致，TypeScript 翻译键类型检查通过。
- GitNexus：`HostHome` 修改前影响等级为 LOW，无直接调用方和受影响执行流程；工作区整体 `detect_changes` 为 MEDIUM，来源包含并行存在的服务端、桌面端和项目树未提交改动，并非本任务新增跨层影响。
- 未启动 Web 服务、未执行构建或运行时 UI 检查；需人工检查 320/375/768/1024/1440 宽度、浅色/深色、中英文、空设备、无搜索结果及在线状态实时变化。

## Decision (ADR-lite)

**Context**：当前宽屏单设备场景中，设备卡片只占左侧一列，信息层级和空间利用率不足；但现阶段没有必要扩展服务端设备生命周期能力。

**Decision**：采用纯前端设备管理改版，增加搜索和状态筛选，并使用自适应卡片网格复用现有设备数据与交互；不展示统计信息。

**Consequences**：改动集中、风险较低；本次不会提供重命名和解除配对，未来如需完整设备管理需单独设计 API 与权限确认流程。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
