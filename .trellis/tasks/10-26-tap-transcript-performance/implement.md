# 执行计划

## 评审闸机

- [x] 用户同意创建任务、同步最新主干并开修复分支。
- [x] 同步到 `ed788614`，创建 `fix/tap-transcript-performance`；完成分诊、源码核对与上下游发现清单。
- [x] 写入 PRD、设计与本执行计划；已进入 in_progress。
- [x] 用户已批准实施与版本 1.4.4；已运行 `task.py start`。

## 实施顺序

1. 在隔离日志/浏览器 fixture 建立基线，记录全量输出语义及分段耗时；先证明热路径重复工作，不以 Safari 推测替代测量。
2. 完成 Rust 有界增量 transcript 与真实调用入口，保留授权根、精确身份、cwd、分页和截断边界；做规范解析差分测试。
3. 接通 revision 通知/单飞读取与独立有界只读调度；覆盖文件晚写、最后落盘、取消与重连，保留 operation 状态和写操作顺序。
4. 完成 Tap 能力协商、约 400ms 合并、稳定消息/轮次和折叠内容按需处理；覆盖切会话、旧页、搜索、展开状态与滚动锚点。
5. 与基线同 fixture 对照性能；单独测原生彩色画面/文本重排，不将未修复的原生渲染问题宣称解决。
6. 更新领域契约、对应版本 CHANGELOG 与功能清单；刷新索引、定向影响审查，完成验证记录后提交。未获明确要求不推送、不安装或操作用户服务；如后续要求打包，仅 NSIS，先提交再构建与实包校验。

## 验证门槛

- 定向 Node：transcript projection、设备/会话生命周期、read lane 并发边界、原有 Web/PTY 重连与输入回归。
- Rust：增量/全量差分、未变化零正文重读、追加读取量、半行/UTF-8、截断/替换、文件/来源越界、缓存预算、订阅清理、同文件单飞。
- 浏览器：真实入口接线的隔离 fixture，旧/新主机、长对话、多标签、后台/可见、慢管理写、最终回复延迟落盘；保留现有对话用例。
- `npx tsc --noEmit`、`npm run web:typecheck`、`npm run tap:typecheck`、定向 `npm run tap:test`、受影响 Rust compile/test；独立 `npm run check:architecture -- --strict` 与 `git diff --check`。
- 真实移动 Safari/网络/真实 CLI 无法覆盖时如实标注，不改真实供应商或复用用户日志做压力写入。

## 当前状态

实现与隔离验证已完成，结果、性能证据和未覆盖项见 `verification.md`；正在进行提交前范围核对，随后完整缓存构建 1.4.4 NSIS 并解包校验。真实 iPhone Safari 与原生彩色终端帧率不冒充已测项。
