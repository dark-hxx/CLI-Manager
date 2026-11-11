# 设计

## 边界
cc-connect 生命周期进入 App、桌宠、terminalStore、daemon Hook sink、快照 GC 和数据目录切换。直接删目录会破坏 Tap 的共享启动器和 Codex 代理。

- 将 launcher 路径解析抽到 infrastructure，Web conversation 真实接入新入口。
- 保留 codex-proxy 共享协议/profile/启动能力及 helper；只清理不再调用的托管分支。
- 设置替换为只组合现有 WebServer/WebDevice 的远程连接页，读取兼容旧设置页 ID。
- 删除专属 API/store/coordinator/overlay、平台菜单及 Rust 生命周期注册。
- 旧托管快照以安全退役方式兼容，不自动启动可能被外部占用的会话；源数据不主动删除，socket 安全迁移兼容保留。
- 清理专属通知/同步设置、无调用类型、测试及现行宣传；历史记录保留。

## 场景
本地/WSL/SSH，Codex/Claude/普通 shell，单/多标签/分屏，桌宠显示/隐藏，退出/后台续跑，Hook 有/无，旧/空配置，旧托管快照，开发/安装数据隔离及迁移。

## 风险与工具
GitNexus 未暴露；刷新 codebase-memory，配合契约/源码/Git diff。App 和 Web launch 上游调用被标记 CRITICAL/HIGH，已提示；IPC 空 caller 不能证明无依赖。

## 发布与回滚
沿用 1.4.4，仅 NSIS；先本地提交，再缓存完整构建。旧安装包可回滚，用户数据无破坏迁移。

## 触点复核
- 后端入口：移除专属 command 路由、19 个 IPC、manager state、启动/单实例参数和退出回调。
- 公共启动：Web conversation 调用 infrastructure 的真实 CLI 解析；保留代理 helper、完整 profile、凭据环境隔离及 Windows 安全参数校验。
- Hook：移除专属托管队列/转发，保留普通 dispatcher、审批仲裁、状态更新及广播。
- 供应商与存储：保留普通 profile 写入；旧 handoff.json 仅读取快照引用，损坏时拒绝回收；daemon 存活会话检查和固定 socket 安全迁移不变。
- 前端入口：远程连接直接挂载已有 Web 服务与配对区；旧 cc-connect tab ID 仅作持久化兼容，不启动旧模块。
- 桌宠：去掉平台及托管操作，保留任务列表、主窗口/会话跳转、几何/渲染调度和普通状态。
- 终端：清除托管运行态/遮罩/锁；旧记录先备份再退出恢复，分屏和 Workspan 按现有恢复映射过滤失效 ID。
- 配置与产品说明：移除专属通知、同步字段、翻译和宣传；历史变更/归档不重写。
- 确认无关且不修改：配对协议、Web/Tap 路由资源、SSH Agent/认证/文件/Git、普通终端启动、数据库结构及历史原文件。

## 索引降级
实现后 fast 重建索引及提交前 detect_changes 均返回 Transport closed。图仍可能是旧快照，不能据此判断删除安全；使用真实 Git 全量差异、契约、源码调用复核和跨层测试代替。GitNexus MCP 未暴露，未声称完成其影响检测。
