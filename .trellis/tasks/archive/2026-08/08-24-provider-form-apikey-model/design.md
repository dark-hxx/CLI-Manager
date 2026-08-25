# Design · 供应商弹框统一维护 apikey 与模型选择

## 1. 核心思路

三处解耦的改动,依赖方向单一(Rust 契约 → 前端 hook → 表单组件),可分层验证:

1. **Rust 侧放宽契约**(向后兼容的加法):`provider_id` 转 `Option`、新增 `api_key: Option<String>`,让「用临时明文 key 取模型」成为合法通路。旧调用方式行为不变。
2. **表单弹框接入密钥**:新增态把 key 随供应商一并创建并激活;编辑态回显激活 key 并允许下拉切换查看对象。
3. **模型候选来源合并**:新增一个纯函数把「接口返回 / 已配置 / 价格表 / 其他供应商」四路来源并成分组候选,兜底模型改用下拉框消费它。

关键判断:**P2 的根因在 Rust 层,不是 UI 层**。只放开前端 `canFetchModels` 不解决任何问题 —— 后端拿不到 key。所以 1 必须先做。

## 2. 边界与契约

### 2.1 IPC 契约变更(唯一的跨边界改动)

`src-tauri/src/provider/models.rs`:

```rust
pub(crate) struct FetchModelsInput {
    pub app_type: String,
    pub provider_id: Option<String>,   // ← String 放宽为 Option
    pub base_url: String,
    pub is_full_url: Option<bool>,
    pub api_format: Option<String>,
    pub api_key_field: Option<String>,
    pub api_key: Option<String>,       // ← 新增:临时明文 key,仅用于本次请求,不落库
}
```

**向后兼容性**:两处都是「必填转可选 + 新增可选字段」,serde 反序列化对旧 payload(只有 `providerId`)完全兼容 → AC6 天然成立。

⚠️ **编译器不会帮我们抓这个契约**:`impact({target:"provider_fetch_models", direction:"upstream"})` 返回 `impactedCount: 0` —— 因为它是 Tauri 命令,真实调用方是前端的 `invoke("provider_fetch_models", ...)` 字符串,不在调用图里。**前后端必须在同一步改完并手工验证**,不能指望 `cargo check` / `tsc` 报错。

### 2.2 密钥解析优先级(`models::fetch`)

```
input.api_key 非空(trim 后)
  ├─ 是 → 直接用,完全不查库取 key
  └─ 否 → 需要 provider_id;查库 → 找 is_active && enabled 的 key → reveal_key
           └─ 任一环缺失 → Err("provider_models_active_key_required")
```

连带影响:`is_full_url` / `api_format` / `api_key_field` 三个回退值原本读 `detail.claude_config` 与 `detail.card`,现在 `detail` 变成 `Option<ProviderDetail>`(仅当 `provider_id` 存在时加载),回退链需改为 `detail.as_ref().and_then(...)`。

### 2.3 安全边界

- **`FetchModelsInput` 当前 `#[derive(Debug, ...)]`,新增 `api_key` 后任何 `{:?}` 都会把明文密钥写进日志**(`CLI_MANAGER_DEBUG=1` 时落到 `cli-manager.log`)。→ 必须**手写 `Debug` impl 把 `api_key` 脱敏**,或去掉 `Debug` derive。这是本次改动引入的新风险,不能漏。
- 明文 key 经 IPC 传入本身**不是新增暴露面**:前端今天已通过 `provider_key_reveal` 拿到明文(`NativeProviderKeyFormModal.tsx:76` 在编辑态就这么做)。
- `HeaderValue::try_from` 对非法字符的 `provider_models_invalid_key` 保护保持不变。

## 3. 数据流

### 3.1 新增态「填 key → 取模型 → 保存」

```
表单 apiKey (仅内存)
  │
  ├─(点「获取模型」)→ useNativeProviderModels.fetchModels({ apiKey, baseUrl, ... , providerId: undefined })
  │                     → invoke("provider_fetch_models") → 走 §2.2 的「是」分支 → 模型列表
  │                                                          ↑ key 不落库
  │
  └─(点「保存」)→ catalog.createProvider(input, apiKey)
                    ├─ invoke("provider_catalog_create", { input })          → created.card.id
                    └─ invoke("provider_key_create", { input: { providerId: created.card.id,
                                                                label: <自动生成>, apiKey,
                                                                activate: true } })
```

### 3.2 编辑态「回显 / 切换 / 保存」

```
打开弹框 ─→ selectedKeyId := detail.keys.find(isActive)?.id
             └→ provider_key_reveal(selectedKeyId) → 输入框明文 + 记为 revealedBaseline

切换下拉 ─→ selectedKeyId := <新选中> → provider_key_reveal → 替换输入框 + 更新 baseline
             ⚠️ 不调 provider_key_activate ——「切换只是查看」

保存 ─────→ invoke("provider_catalog_update", ...)
             └─ if 输入框值 !== revealedBaseline
                  → invoke("provider_key_update", { id: selectedKeyId, apiKey })
             ⚠️ 值未变则不发请求,避免无谓触发「密钥已变更,需重新预览应用」
```

`revealedBaseline` 是必须的:没有它无法区分「用户没动」与「用户改了」,会导致每次保存都误报密钥变更。

### 3.3 模型候选合并

```
接口返回 fetched[]         ─┐
表单已配置(model + 5 角色) ─┤
model_prices 表(按 appType 过滤) ─┼→ buildModelCandidates() → 分组去重候选 → Select.data
同 appType 其他供应商 card.model ─┘                              ↑ 保留自由输入
```

## 4. 具体改动

### 4.1 `src-tauri/src/provider/models.rs` —— 契约与解析

- `FetchModelsInput`:按 §2.1 改字段;按 §2.3 脱敏 `Debug`。
- `fetch()`:
  - `detail` 改为 `Option<ProviderDetail>`,仅 `provider_id` 为 `Some` 且非空时 `get_provider`。
  - key 解析按 §2.2 分支;注意原代码把 `input.provider_id` **move** 进 `reveal_key`,改 `Option` 后需 `clone()`。
  - 三处回退(`is_full_url` / `api_format` / `api_key_field`)改走 `detail.as_ref().and_then(...)`。
- `build_models_url` / `parse_model_ids` **不动**,现有 4 个测试必须保持绿(AC7)。
- 新增测试:`api_key` 直传时不需要 `provider_id`(可只测输入校验分支,不发真实网络请求)。

### 4.2 `useNativeProviderModels.ts` —— 放开守卫

- `FetchModelsOptions` 增加 `apiKey?: string`。
- 早退条件由 `if (!options.providerId)` 改为 `if (!options.apiKey?.trim() && !options.providerId)`。
- invoke payload 增加 `apiKey: options.apiKey?.trim() || undefined`。

### 4.3 新增 `providerModelCandidates.ts` —— 纯函数

```ts
export interface ModelCandidateGroup { group: string; items: string[] }

export function buildModelCandidates(input: {
  fetched: string[];
  configured: string[];                  // 当前表单已填的模型值(含 5 角色 + card.model)
  priceTableModels: string[];            // 已按 appType 过滤
  otherProviderModels: string[];
}): ModelCandidateGroup[]
```

- 优先级顺序即 PRD R4 表格顺序;**跨组去重**(先出现的组保留)。
- 值一律先过 `stripOneM()` 再入候选 —— 候选里不该出现带 `[1M]` 后缀的项,后缀由 checkbox 单独控制。
- 纯函数、无 React 依赖 → 可单独推理,不需要 mock。

`priceTableModels` 来源:`useModelPricingStore` 的 `modelPrices: Record<string, ModelPrice>`(store 已有 `loaded` 标志)。按 appType 粗筛(claude → 名字含 `claude`;codex → 含 `gpt`/`codex`),筛不中就整表给 —— 宁可多给候选,也不要给空。

### 4.4 `NativeProviderFormModal.tsx` —— 密钥字段

新增表单状态(**不进 `NativeProviderFormValues`**,因为它不参与 `providerConfig` 文档生成):

| state | 用途 |
|---|---|
| `apiKey: string` | 输入框当前值 |
| `selectedKeyId: string \| null` | 编辑态下拉选中项 |
| `revealedBaseline: string` | §3.2 的变更判定基线 |
| `revealing: boolean` / `revealError: boolean` | 与现有 `NativeProviderKeyFormModal` 一致的 reveal 状态 |

- 新增态:`PasswordInput`,复用 i18n `providerCatalog.apiKeyLabel` / `apiKeyPlaceholder`。
- 编辑态:`TextInput`(明文,与现有编辑密钥弹框一致)+ 右侧 `Select` 列 `providerDetail.keys`;`Select` 下方给「激活项请到 API 密钥 Tab 修改」说明(新 i18n key)。
- `opened` 的 `useEffect` 里追加 reveal 逻辑,**沿用现有 `cancelled` 竞态守卫写法**(`NativeProviderKeyFormModal.tsx:61-93`)。
- `canFetchModels` 改为:`Boolean(values.baseUrl.trim()) && (Boolean(apiKey.trim()) || Boolean(providerDetail?.keys.some(k => k.isActive && k.enabled)))`。
- `fetchProviderModels()` 传 `apiKey`。
- `handleSubmit` 把 apiKey 相关信息随 `onSubmit` 上抛 —— 需扩展 `onSubmit` 签名(见 4.5)。

### 4.5 `useNativeProviderCatalog.ts` + `NativeProviderSettingsPage.tsx` —— 提交链路

**问题**:`createProvider` 目前是 `Promise<void>`,把 `invoke` 返回的 `created` 吞掉了(`useNativeProviderCatalog.ts:164-169`),拿不到新供应商 id 去建密钥。

**方案**:`createProvider(input, initialApiKey?: string)` —— 在**同一个 `runAction("create-provider")` 内**串联两个 invoke。理由:loading 态与 `errorCode` 的现有语义不用改,错误只有一个出口。

```ts
const createProvider = useCallback(async (input, initialApiKey?: string) => {
  await runAction("create-provider", async () => {
    const created = await invoke<NativeProviderDetail>("provider_catalog_create", { input });
    const apiKey = initialApiKey?.trim();
    if (apiKey) {
      await invoke<NativeProviderKeySummary>("provider_key_create", {
        input: { providerId: created.card.id, appType: input.appType,
                 label: <自动生成>, apiKey, activate: true },
      });
    }
    await refreshSelection(created.card.id);
  });
}, [refreshSelection, runAction]);
```

⚠️ **部分失败必须处理**:供应商已建成、`provider_key_create` 失败 → 直接重试提交会**建出重复供应商**。处理:catch 到 key 创建失败时,仍 `refreshSelection(created.card.id)` 让供应商落到列表,并把表单切到 `edit` 模式绑定该供应商(`setFormMode("edit")` + 选中它),错误提示引导用户重填密钥。这是本设计里最容易被漏掉的一条。

`handleSaveProvider` 连带调整:
- 新增态传 `apiKey`;
- 原「新建后自动弹详情弹框接着配密钥」的行为(`NativeProviderSettingsPage.tsx:238` 注释)**改为条件触发** —— 只在**未提供 apiKey** 时才 `setDetailOpened(true)`,否则已经配好了,弹出来是噪音。
- 编辑态在 `updateProvider` 之后按 §3.2 决定是否 `updateKey`。

### 4.6 `NativeClaudeConfigSection.tsx` —— 兜底模型下拉

- 行 275-281 的兜底模型 `TextInput` → `Select`,配置与 5 角色模型一致:`searchable` + 允许自由输入;`data` 来自 4.3 的分组候选。
- 5 个角色模型的 `Select`(行 242-259)同步改为消费分组候选,并**去掉 `availableModels.length > 0` 的条件分支** —— 有了价格表兜底,候选几乎不会全空;真为空时 `Select` 的自由输入等价于原 `TextInput`,不需要两套渲染分支。
- 新增 props:`modelCandidates: ModelCandidateGroup[]` 替代原 `availableModels: string[]`。

### 4.7 `NativeProviderAdvancedConfigSection.tsx` —— 仅跟随契约

codex/grokbuild 的「模型映射」列表已有 `Select`(行 121-126),**行为不变**;只需跟随 4.6 的 props 改名(`availableModels` → `modelCandidates`)保持一致,不引入分组候选(PRD Non-Goals)。

### 4.8 `src/lib/i18n.ts` —— 新增 key(zh ≈1528 区块 / en ≈5480 区块 成对加)

| key | 用途 |
|---|---|
| `providerCatalog.keySelectLabel` | 编辑态下拉框 label |
| `providerCatalog.keySelectHint` | 「激活项请到 API 密钥 Tab 修改」 |
| `providerCatalog.models.groupFetched` / `groupConfigured` / `groupPriceTable` / `groupOtherProviders` | 候选分组标题 |

可复用不新增:`providerCatalog.apiKeyLabel` / `apiKeyPlaceholder` / `apiKeyRequired` / `apiKeyKeepExisting` / `models.fetch*`。

> 顺带记录(不在本轮范围):`providerCatalog.apiKeyPlaceholder` 文案「保存后不会再次显示明文」与编辑态实际会 reveal 明文的行为不符 —— 这个不一致今天就存在。

## 5. 场景枚举(fix-triage-guide §5)

| 维度 | 取值 | 需确认 |
|---|---|---|
| appType | claude / codex / grokbuild | 三条渲染分支都要有 apiKey 字段;取模型入口都放开 |
| 表单模式 | create / edit | edit 需 reveal;create 不需要 |
| key 数量 | 0 / 1 / 多个 | 0 个时编辑态退化为新增(AC5);多个时下拉可切 |
| key 状态 | 激活+启用 / 启用未激活 / 禁用 | 下拉是否列出禁用 key?→ **列出但标注禁用**,因为用户可能就是要改它的值 |
| baseUrl | 空 / 非法 / `isFullUrl=true` / 结尾 `/v1` / 结尾 `/models` | 空则取模型不可用;其余由 `build_models_url` 覆盖(已有测试) |
| apiFormat × apiKeyField | anthropic+API_KEY → `x-api-key`;其余 → `Bearer` | 临时 key 路径必须走同一套 header 判定 |
| `/v1/models` 结果 | 成功 / 401 / 超时 / 空数组 / 非 JSON | 失败时**不清空** 2/3/4 组候选(R4) |
| reveal 失败 | keyring 不可用 | 复用现有 `revealError` 提示;不应阻塞其余字段编辑 |
| 全局配置已应用的供应商 | 改 key 后 | 应进入「密钥已变更,请重新预览并应用」(issue 截图 2 已有该提示);值未变则不应误触发 |
| 环境 | local / WSL(home identity) | 不涉及 home 解析改动,但改 key 后的全局漂移判定要在两种环境都成立 |
| `providerConfigManual` | true / false | true 时模型选择**不得**覆盖用户手写文档(R5) |
| 通用配置开关 | 开 / 关 | 与本改动无耦合,回归确认即可 |
| cc-switch 导入的 key | label `Imported from CC Switch` | 下拉正常可选(issue 截图 2 的实际数据) |
| `[1M]` 后缀 | 有 / 无 | 候选值一律 strip;后缀由 checkbox 控制(4.3) |
| 部分失败 | provider 建成 + key 失败 | 按 4.5 切 edit 模式,禁止重试建重复供应商 |

## 6. 兼容性与回滚

- **Rust 侧是纯加法**(必填转可选 + 新增可选字段),旧前端 payload 行为不变 → 前端可单独回滚,不需要同时回退 Rust。
- 无 SQLite migration、无 `capabilities/default.json` 变更、无新增 Tauri 命令(`provider_key_create` / `provider_key_update` / `provider_key_reveal` 都已在 `invoke_handler![]` 注册)。
- 回滚点:按 implement.md 的 Step 边界,任一 Step 结束都是可编译状态。

## 7. 已知取舍

- **下拉框不含「+ 新增密钥」项**:用户已拍板「切换只是查看」,混入新增项会让语义摇摆。代价是编辑态想加第二个 key 仍需去 Tab,可接受 —— 本需求解决的是「主路径要一起维护」,不是「取代密钥管理」。
- **价格表按名字粗筛 appType**:`model_prices` 没有 appType 字段。筛不中就整表给,宁可候选多也不要空。
- **临时 key 走 IPC 明文**:与现有 `provider_key_reveal` 同级别暴露面,不是新增风险;但 `Debug` 脱敏(§2.3)是硬要求。
- **`createProvider` 签名变更**:`impact` 显示只有 `NativeProviderSettingsPage` 一个调用方,LOW risk。

## 8. impact 分析结论(CLAUDE.md 强制项)

| 目标 | direction | impactedCount | risk | 直接调用方 |
|---|---|---|---|---|
| `NativeProviderFormModal` | upstream | 2 | LOW | `NativeProviderSettingsPage` |
| `useNativeProviderModels` | upstream | 3 | LOW | `NativeProviderFormModal` |
| `NativeClaudeConfigSection` | upstream | 3 | LOW | `NativeProviderFormModal` |
| `provider_fetch_models` | upstream | 0 | LOW | 无(IPC 边界,见 §2.1 警告) |

受影响执行流均为 `NativeProviderSettingsPage` / `SettingsModal`,**无 HIGH/CRITICAL 风险**,不需要额外告警。
