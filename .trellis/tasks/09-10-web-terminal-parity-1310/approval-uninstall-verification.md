# 1.3.10 审批与卸载修复

根因：Web PTY 输入绕过桌面提醒更新；NSIS 使用32位辅助进程，路径查询失败被误判为无进程。

触点：useWebDeviceBridge 输入成功后复用 markAttentionInputHandled；仅无其他 attention/done/failed 时清理任务栏。宠物继续消费既有状态，未改宠物渲染。hooks.nsh 选择 Sysnative；cleanup.ps1 使用有限权限查询，无法验证时失败；无线程的已终止进程对象不阻塞卸载。

验证：Web 输入成功、多会话保留提醒、写入失败三项通过；卸载路径隔离、认证关闭、其他副本保护、根目录拒绝四项通过；真实 NSIS 安装/临时卸载副本执行测试通过。测试使用独立目录的替身进程，没有卸载用户应用。真实手机和宠物视觉验证未执行。

GitNexus 未暴露，采用源码调用点与 Git diff 复核；内置 apply_patch 沙箱失败，使用同一原生补丁入口。延续现有任务和1.3.10版本。
