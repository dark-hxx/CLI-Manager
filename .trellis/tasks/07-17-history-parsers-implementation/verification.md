# 验证

每个批次至少执行：

```powershell
& '.\node_modules\.bin\tsc.cmd' --noEmit
npm.cmd run build
Set-Location src-tauri
cargo test commands::history
cargo check
```

来源级验收必须另外覆盖：

- fixture parser 单测。
- 首次索引、未变跳过、修改、删除、parser version 变化。
- list/detail/search/stats 集成查询。
- 来源筛选 UI。
- 未知/损坏格式写 failure 且不影响其他来源。
