# 供应商弹框统一维护 apikey 与模型选择

来源:GitHub issue [#214](https://github.com/dark-hxx/CLI-Manager/issues/214) 「[Feature]: 供应商维护的交互感觉有点奇怪」(enhancement / @ushaio / 2026-08-17)

## Goal

把 **baseUrl + apiKey + model** 收敛到「新增/编辑供应商」同一个弹框里一起维护,并让「获取模型」在新增态就能用;同时把 Claude 的**默认兜底模型**从自由输入框升级为可选择的下拉框,候选列表在接口拿不到时有明确的降级来源。

用户原话(issue):

> 一般不都是供应商 baseurl、key、model 一起维护的吗,但这里确实分开维护,且模型选择的逻辑不是很明确,当前是基于 cc-switch 的激活供应商使用的。

## 现状(问题所在)

### P1 新增/编辑弹框没有 apiKey 字段,密钥在另一处维护

`NativeProviderFormModal.tsx` 的字段只有:名称、baseUrl、模型、官网、分类、claudeConfig/advanced、providerConfig、备注、通用配置开关 —— **没有 apiKey**。

密钥维护在完全独立的位置:`NativeProviderDetailModal` →「API 密钥」Tab → `NativeProviderKeySection` → `NativeProviderKeyFormModal`。

用户实际路径:新建 → 保存 → 重开详情 → 切 Tab → 加密钥 → 激活。这就是 issue 所说的「分开维护」。

### P2 「获取模型」在新增态必然不可用,根因在 Rust 层

- `NativeProviderFormModal.tsx:344,357` → `canFetchModels={Boolean(provider?.id)}`,新增态按钮直接禁用。
- `useNativeProviderModels.ts:21-24` → 无 `providerId` 即早退 `provider_models_active_key_required`。
- **根因** `src-tauri/src/provider/models.rs:24-33`:`FetchModelsInput.provider_id` 是必填(非 `Option`),`fetch()` 先查库取 provider、再找 `is_active && enabled` 的 key、再 `reveal_key`。**当前不存在「用临时 key 取模型」的通路。**

即:这不是 UI 开关问题,是 IPC 契约缺口。

### P3 默认兜底模型是输入框,不是下拉框

`NativeClaudeConfigSection.tsx:275-281` 的兜底模型(`claudeConfig.model`)用 `TextInput`;而其上方 5 个角色模型(sonnet/opus/fable/haiku/subagent,行 242-259)**在 `availableModels.length > 0` 时已经是 `Select`**。兜底模型是唯一漏掉的一个。

### P4 接口拿不到模型时没有任何候选

`availableModels.length === 0` 时全部退化为纯文本输入,用户只能手敲模型 ID。项目里其实已有可用的模型清单来源(见 R4),但没被接进来。

## Requirements

### R1 新增态:apiKey 随供应商一起创建并自动激活

- 弹框新增「API 密钥」字段,新增态用 `PasswordInput`(与现有 `NativeProviderKeyFormModal` 新增态一致)。
- 保存流程:`provider_catalog_create` 成功后,若 apiKey 非空则紧接 `provider_key_create({ label: <自动生成>, apiKey, activate: true })`,使其成为该供应商**第一个且激活**的密钥。
- label 自动生成(不额外增加用户输入负担),后续改名走「API 密钥」Tab;**label 不做唯一性校验**,允许重名。
- **apiKey 非必填**:留空则只建供应商、不建密钥,与今天行为完全一致,保住「先建壳、后补密钥」的能力。

### R2 编辑态:回显激活 key,下拉框可切换查看对象

语义已拍板 —— **下拉框只切换「查看/编辑哪个 key 的值」,不改变激活状态**:

- 打开弹框时,下拉框默认选中**激活 key**,输入框通过 `provider_key_reveal` 回显其明文。
- 切换下拉框 → 重新 reveal 所选 key 并替换输入框内容;**不触发激活变更**。
- 输入框内容被修改后保存 → `provider_key_update({ id: <所选 keyId>, apiKey })`,即「改所选 key 的值」。
- 字段旁需明确标注「激活项请到 API 密钥 Tab 修改」,避免用户误以为切换即切激活。
- 编辑态输入框沿用 `TextInput`(明文可见),与现有编辑密钥弹框保持一致,不引入新的显隐规则。
- 下拉框**只列已有 key**,不混入「+ 新增密钥」项(会污染"只是查看"的语义);无 key 的供应商在编辑态退化为 R1 的新增行为。

### R3 「获取模型」在有临时 key 时即可用

- 放开可用条件:`baseUrl` 非空 **且**(表单 apiKey 非空 **或** 该供应商已有激活 key)。
- 表单里填了 apiKey 但尚未保存时,用**表单里的临时 key**发请求,该 key 不落库。
- 三个 appType(claude / codex / grokbuild)的取模型入口都要同步放开 —— Claude 走 `NativeClaudeConfigSection`,其余走 `NativeProviderAdvancedConfigSection`,两者共用同一个 `onFetchModels`/`canFetchModels` 契约。

### R4 兜底模型改下拉框,并定义候选来源优先级

- `NativeClaudeConfigSection` 的兜底模型改为与 5 个角色模型同款的可搜索下拉框,**且必须允许自由输入**(不能锁死用户,供应商模型 ID 千奇百怪)。
- 候选列表按来源分组、按优先级排列:

  | 优先级 | 来源 | 依据 |
  |---|---|---|
  | 1 | `/v1/models` 接口返回 | `provider_fetch_models`,本次请求结果置顶 |
  | 2 | 当前表单已配置的模型值 | `claudeConfig.model` + 5 个角色模型 + `card.model`,零成本永远可用 |
  | 3 | `model_prices` 表 + builtin seed | SQLite `model_prices`(migration 内)/ `src/lib/modelPricing.ts` 37 条 builtin;后端 `commands/model_pricing.rs` 已从 OpenRouter `/api/v1/models` 同步 —— **项目里唯一已在维护且会自动更新的模型清单** |
  | 4 | 同 appType 其他供应商已用的模型 | `provider_catalog_list` 聚合 `card.model`,贴近用户真实在用 |

- 明确**不新增**写死的 preset 模型列表:纯增维护负担且必然过期。
- 接口请求失败时给出可读错误,但**不清空**已有候选(2/3/4 仍应可选)。

### R5 保留既有能力不回归

- 「API 密钥」Tab 的完整密钥管理(增删改、启停、激活、排序、替换、reveal)保持不变 —— 本需求是**新增一条快捷通路**,不是替换。
- `providerConfig` 手动编辑过(`providerConfigManual === true`)后,模型选择**不得**回头覆盖用户手写的配置文档,沿用现有 `updateValue` 的判定。
- `[1M]` 后缀开关(`withOneM`/`stripOneM`/`hasOneM`)语义不变;下拉框选中的值需正确参与 `[1M]` 拼接。
- 「一键同步」(`quickSet`)行为不变。
- 从 cc-switch 导入的 key(label 形如 `Imported from CC Switch`)在下拉框中正常可选。

## Non-Goals

- 不改动密钥的加密/存储机制,不改 `provider_key_reveal` 的权限模型。
- 不改动 `model_prices` 的同步逻辑与 OpenRouter 数据源。
- 不改动全局配置应用(`provider_global_*`)的漂移检测与预览/应用流程 —— 仅需确认改 key 后仍正确进入「需重新预览应用」状态。
- 不改 `/v1/models` 的 URL 推导规则与响应解析(`build_models_url` / `parse_model_ids` 保持原样)。
- 不合并「API 密钥」Tab 到表单弹框,不删除该 Tab。
- 不为 codex/grokbuild 的「模型映射」列表引入候选来源分组(本轮只做 Claude 兜底模型;映射列表已有 Select,行为不变)。

## Acceptance Criteria

### AC1 新增态一次建成可用供应商
新增 Claude 供应商,填 名称 + baseUrl + apiKey → 保存 → 该供应商详情页「API 密钥」Tab 出现 1 个密钥且为激活态;`card.activeKeyLabel` 非空。

### AC2 新增态可直接获取模型
新增态填入 baseUrl + 有效 apiKey → 「获取模型」按钮可点击 → 成功返回模型列表 → 兜底模型与 5 个角色模型的下拉框都能选到接口返回的模型。**全程未保存供应商。**

### AC3 编辑态回显与切换
编辑一个有 ≥2 个 key 的供应商 → 输入框回显激活 key 明文、下拉框选中激活 key → 切换到另一个 key → 输入框换成该 key 的明文 → 保存 → **激活 key 未变**,被选中那个 key 的值按输入框内容更新。

### AC4 兜底模型下拉可选可自由输入
兜底模型字段:接口成功时能从下拉选;接口失败时仍能从「已配置 / 价格表 / 其他供应商」三组候选中选;任何时候都能手敲一个不在列表里的模型 ID 并保存成功。

### AC5 无 key 供应商不被破坏
编辑一个 0 个 key 的供应商 → 下拉框为空、输入框可填 → 保存后创建并激活第一个 key(等价 R1)。

### AC6 契约向后兼容
`provider_fetch_models` 在**只传 providerId、不传 apiKey**时行为与改动前完全一致(仍从激活 key 取)。

### AC7 静态校验
`npx tsc --noEmit` 通过;`cd src-tauri && cargo check` 通过;`cargo test` 全绿(`models.rs` 现有 4 个测试不得回归)。

## 已确认决策

- **D1 · apiKey 非必填**:新增态留空 → 只建供应商不建密钥(保留今天「先建壳、后补密钥」的能力);填了 → 一并创建并激活。见 R1 / AC5。
- **D2 · 版本号 `V1.3.8`**:完成闸机需把本需求写入 `CHANGELOG.md` 与 `docs/功能清单.md` 的 `V1.3.8` 小节。
- **D3 · key label 不校验唯一性**:自动生成固定 label 即可,不需要去重后缀,允许重名。
- **D4 · 编辑态下拉语义**:只切换「查看/编辑哪个 key 的值」,**不改变激活状态**。见 R2。
