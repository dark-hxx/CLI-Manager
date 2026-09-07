# 执行计划：修复 Git 变更面板拖拽文件和目录到终端

## 开工前

1. 运行 trellis-before-dev，读取当前任务的前置规范与检查单。
2. 对将编辑的 GitChangesPanel、GitChangesTree、GitTreeNodeComponent、FileExplorerSidebar 和新共享 Hook 调用 GitNexus impact（upstream）。若索引仍无法解析，记录失败并以已登记的组件/终端契约和 rg 调用点作为替代证据。
3. 确认工作树仅包含本任务的 task 文档；代码修改后再检查实际改动范围。

## 实施步骤

1. 新增共享终端文件指针拖拽 Hook/预览：
   - 抽离 FileExplorerSidebar 的 pointer state、阈值、payload 生命周期、rAF 预览、点击抑制和卸载清理。
   - 支持泛型源条目与可选非终端落点回调，确保 Git 与文件浏览器使用同一实现。
2. 迁移 FileExplorerSidebar：
   - 删除已被共享 Hook 覆盖的本地 pointer state / handler / Portal 预览。
   - 维持现有 native drag 处理器和文件树内部移动：非终端落点仍通过现有 getPointerDropTargetPath + moveDraggedEntry 处理。
3. 接入 Git 面板：
   - 在 GitChangesPanel 以 gitTreeProject 创建一个共享拖拽源；
   - 经 GitChangesTree 传到 GitTreeNode；
   - 文件和目录行绑定 pointer handlers，目录使用压缩链尾路径，排除 button 控件并抑制拖拽后的 Diff/展开 click。
4. 扩展静态回归测试，覆盖共享源、Git 文件/目录行事件、完整 payload 和 FileExplorerSidebar 迁移。
5. 更新 .trellis/spec/frontend/component-guidelines.md，明确文件浏览器与 Git 变更树是同一 terminalFileDrag 生产者契约。
6. 更新 CHANGELOG.md 的 V1.3.8 段和 docs/功能清单.md 的 Git 变更面板小节。

## 验证

运行：

    node --test scripts/fileExplorerPathActions.test.mjs
    npx tsc --noEmit
    npm run build

代码完成后：

1. 使用 trellis-check 完成规范、类型、测试、数据流和复用检查。
2. 使用 GitNexus detect_changes 对比 master，确认只影响预期的前端拖拽源、Git 树、文件浏览器、测试和文档；若 GitNexus 仍不可用，记录降级的 git diff / rg 审查。
3. 不进行 commit 或 push，除非用户另行明确授权。

## 交付说明

用户没有可运行的 macOS 环境，因此应用内手工矩阵无法由用户立即复验。交付中应明确已自动验证的结果和待人工验证的环境矩阵，不把静态断言误报为真实 Tauri 拖放验收。

## 实施结果

- 新增 src/hooks/useTerminalFilePointerDrag.tsx，统一文件浏览器和 Git 文件树的指针阈值、payload、rAF 预览、终端提交、拖后点击抑制与卸载清理。
- GitChangesPanel 以 gitTreeProject（当前 activeRepoPath）作为拖拽源根，并把事件传递至两棵 Git 树；GitTreeNode 对文件叶子和目录行启用拖拽，目录使用显示行的真实链尾路径并保留尾斜杠，行内按钮不作为拖拽手柄。
- FileExplorerSidebar 已迁移到共享 Hook，非终端落点仍回调既有文件树内移动流程。
- 已更新 V1.3.8 Changelog、功能清单和前端文件路径/终端拖拽契约。
- 已将桌面应用版本源统一为 1.3.8（package.json、package-lock.json、Cargo.toml、Cargo.lock、tauri.conf.json）。

## 验证结果

- node --test scripts/fileExplorerPathActions.test.mjs：通过（7/7）。
- npx tsc --noEmit：通过（目录扩展复验）。
- npm run build：通过（目录扩展复验，Vite 生产构建完成）。
- GitNexus detect_changes(compare master)：低风险，识别到 Git tree props 与 terminalFileDrag payload 相关符号，未发现受影响执行流；当前工作树另有并行 Rust/统计/i18n 改动（共 14 个已跟踪变更文件），未在本任务中修改或回滚；新 Hook 为未跟踪新文件，另行进行源码和 diff 审查。
