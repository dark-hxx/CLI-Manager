# 数据根迁移兼容设计

## 根因与边界

目录复制把全部 Windows 重解析点当成链接拒绝，未区分远程模块可重建的 AF_UNIX 运行端点。cc-connect 强制停止不保证执行 Go APIServer.Stop 的删除；安全迁移不能依赖原服务清理残留。修复位于迁移生产端，不删除用户源文件，不全局放行重解析点。

## 实现

- `copy_directory_recursive` 保留源根参数以获得真实相对路径；只允许精确 `remote-manager/data/run/api.sock` 的端点识别，Windows 名称按文件系统大小写规则比较。
- 独立的 runtime_socket 模块用 Windows FindFirstFileW 的属性与 tag 确认 AF_UNIX；同名普通文件/符号链接/目录联接不跳过。Unix 使用原生 socket 类型，不新增平台的 GUI 数据切换支持。
- 非阻塞 Windows AF_UNIX 连接只确认监听状态，不发送 API 内容；拒绝活动或不确定端点，仅连接拒绝的残留端点可跳过。未知特殊节点仍走既有拒绝。
- cc-connect 增加空闲操作锁 guard，检查受管启动/进程/微信授权状态，保持锁至准备请求完成，防止预检与启动并发；IPC 注入 State 不改变 renderer 参数或返回契约。既有 daemon 活动会话检查保留。
- 设置错误映射覆盖迁移链接错误及状态不确定错误，使用中英文说明；不调整页面布局。
- 保留临时树完整复制/rename 激活、原目录保留、pending 失败回退、非空目标及路径重叠拦截。

## 场景与发现清单

- 源根：默认/自定义/便携；目标：独立空目录/跨盘/非空/父子路径；普通文件/同名普通文件/真实链接或 junction/已关闭端点/活动端点/未知路径特殊节点。
- 服务：已关闭但残留/启动或操作并发/运行/微信授权；终端单个/分屏/多窗口的存活任务仍由既有 daemon 检查。WSL/SSH/Hook 文件不额外迁移，不访问远端真实数据。
- 需改：目录复制、端点判定、cc-connect 空闲 guard、切换 IPC 接入、设置错误映射与翻译；需回归：migration/pending 回退、cc-connect 进程与授权、renderer IPC 参数与错误提示。
- 无关：供应商配置、Codex Hook/代理、终端渲染、数据库 schema、模型网络和项目文件。

## 风险与回滚

GitNexus 未暴露；使用刷新后的 codebase-memory、契约、实际源码及 Git diff。图谱识别 `copy_directory_recursive` 的调用 `migrate_data_root` 为 CRITICAL、pending 应用为 HIGH，已告知用户；图谱对通用 list/map 出现错误匹配，不作为业务判断证据。

仅纯临时夹具验证，不调用用户的切换/安装接口。回滚程序不撤销已经迁移的新数据，切换回默认仍须经过正常迁移界面；原根保持完整。所有未知类型失败关闭，不尝试扫描/终止外部 cc-connect 实例，固定端点活性检查补上监听边界。
