# 修复系统资源 CPU 核心与线程数显示

## Goal

修正系统资源面板把逻辑处理器数量误显示为物理核心数量的问题，准确展示物理核心数与逻辑线程数。

## Requirements

- 后端分别返回物理核心数和逻辑处理器数。
- 物理核心数优先使用 `sysinfo::System::physical_core_count()`，无法获取时回退到逻辑处理器数。
- 系统信息卡显示“物理核心数 / 逻辑线程数”。
- CPU 明细继续展示每个逻辑处理器的使用率，并使用“线程”文案。
- 新增或修改的用户可见文案必须同时支持 `zh-CN` 与 `en-US`。

## Acceptance Criteria

- [x] 10 核 16 线程的 CPU 在系统信息卡显示“10 核 / 16 线程”。
- [x] CPU 明细入口显示 16 个线程，展开后仍有 16 条逻辑处理器使用率。
- [x] 物理核心数不可用时，界面仍能显示有效数量。
- [x] TypeScript 类型检查通过。
- [x] Rust 编译检查通过。

## Technical Approach

- 扩展 `CpuSnapshot`，分别序列化 `physicalCoreCount` 与 `logicalProcessorCount`。
- 前端更新快照类型与两处资源卡展示，不改变采样频率和 CPU 使用率计算。

## Out of Scope

- 不调整 CPU 使用率采样算法。
- 不重构 `cpuCores` 明细数据结构。
- 不增加依赖。

## Changelog Target

`[TEMP]`

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
