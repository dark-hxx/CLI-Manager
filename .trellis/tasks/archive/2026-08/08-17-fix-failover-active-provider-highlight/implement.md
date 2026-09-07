# 实施计划：自动故障转移当前供应商高亮

## 1. 建立失败场景测试

- 在 `src-tauri/src/daemon/route_http.rs` 的现有单元测试区增加身份判定回归覆盖。
- 覆盖“当前供应商不在队列，实际首候选索引为 0 但仍需提交切换”。
- 覆盖当前候选不切换、后续非当前候选切换、自动模式关闭不切换。

验证：

```powershell
cd src-tauri
cargo test route_http
```

## 2. 修复 daemon 成功提交条件

- 为内部 `ProviderSnapshot` 增加 `is_current`，从 `detail.card.is_current` 填充。
- 选中候选时把“是否为请求开始时当前供应商”传到最终响应提交阶段。
- 统一计算是否需要自动热切换，替换流式和非流式分支对 `selected_provider_index > 0` 的依赖。
- 不改变 usage 的 `attempt_index` / `degraded` 语义；这些字段仍描述请求尝试次数，而不是持久化供应商身份。

验证：

```powershell
cd src-tauri
cargo fmt -- --check
cargo test route_http
```

## 3. 全链路回归检查

- 检查 `routing.rs` 当前供应商优先规则、手动热切换和 reset circuit 行为未改变。
- 确认前端继续从 `isCurrent` 生成高亮，不引入队列推测。
- 更新 `CHANGELOG.md` 的 `TEMP` 供应商快捷切换章节和 `docs/功能清单.md` 对应供应商路由条目。
- 保留工作区中此前“移除辅助小字”的改动。

验证：

```powershell
cd src-tauri
cargo check
cargo test
cd ..
npx tsc --noEmit
git diff --check
```

## 4. 影响复核

- 运行 `gitnexus_detect_changes(scope: "unstaged")`。
- 逐项核对变更只影响 daemon 路由成功提交、测试和两份产品记录。
- 若出现 HIGH/CRITICAL 或无关执行流，停止并重新评估。

## 回滚点

- 若身份字段导致候选加载或所有权问题，回滚 `ProviderSnapshot.is_current` 与最终 tuple 传递，不保留半套前端推测逻辑。
- 若完整测试暴露热切换并发协议缺陷，停止在根因修复前，不扩大为 daemon 协议重构。
