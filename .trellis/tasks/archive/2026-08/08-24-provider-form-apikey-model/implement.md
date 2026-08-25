# Implement · 供应商弹框统一维护 apikey 与模型选择

**前置**:先读 `prd.md` → `design.md`。改动前对每个要动的符号跑 `impact`(design §8 已记录四个主要符号的结论,新增符号仍需现跑)。

**依赖顺序**:Step 1(Rust 契约)→ Step 2(前端 hook)→ Step 3(纯函数)→ Step 4-6(组件)→ Step 7(i18n)。每个 Step 结束都必须是可编译状态,即回滚点。

**校验命令**:
- 前端:`npx tsc --noEmit`(前端唯一静态校验,每步必跑)
- Rust:`cd src-tauri && cargo check` / `cargo test`
- 实机:`npm run tauri dev`

---

## Step 1 · Rust 契约放宽(先做,后续前端才有可调的接口)

- [x] 1.1 `src-tauri/src/provider/models.rs`:`FetchModelsInput.provider_id` 由 `String` 改 `Option<String>`,新增 `api_key: Option<String>`(design §2.1)
- [x] 1.2 **去掉 `Debug` derive 并手写脱敏 `Debug` impl**,确保 `api_key` 不会被 `{:?}` 写进 `cli-manager.log`(design §2.3,**本步最易漏且是安全项**)
- [x] 1.3 `fetch()`:`detail` 改为 `Option<ProviderDetail>`,仅当 `provider_id` 为 `Some` 且 trim 后非空时才 `get_provider`
- [x] 1.4 `fetch()`:按 design §2.2 实现 key 解析二分支;注意 `input.provider_id` 原本是 move 进 `reveal_key`,现需 `clone()`
- [x] 1.5 `fetch()`:`is_full_url` / `api_format` / `api_key_field` 三处回退改走 `detail.as_ref().and_then(...)`
- [x] 1.6 确认 `build_models_url` / `parse_model_ids` **未被改动**
- [x] 1.7 新增测试:`api_key` 直传且无 `provider_id` 时输入校验通过;`api_key` 与 `provider_id` 均缺失时返回 `provider_models_active_key_required`
- [x] 1.8 校验:`cargo check` 通过、`cargo test` 全绿(现有 4 个测试不得回归)

**回滚点 A**:此步是纯加法,单独 merge 也不改变任何现有行为。

---

## Step 2 · 前端取模型 hook 放开守卫

- [x] 2.1 `useNativeProviderModels.ts`:`FetchModelsOptions` 增加 `apiKey?: string`
- [x] 2.2 早退条件改为 `if (!options.apiKey?.trim() && !options.providerId)`
- [x] 2.3 invoke payload 增加 `apiKey: options.apiKey?.trim() || undefined`
- [x] 2.4 校验:`npx tsc --noEmit`
- [x] 2.5 **手工验证 IPC 契约**(design §2.1:编译器抓不到):`npm run tauri dev` → 任意已有供应商点「获取模型」→ 确认仍成功(即 AC6 不回归)

---

## Step 3 · 模型候选纯函数

- [x] 3.1 新建 `src/components/settings/providers/providerModelCandidates.ts`,实现 `ModelCandidateGroup` 与 `buildModelCandidates()`(design §4.3)
- [x] 3.2 四路来源按 PRD R4 优先级排序,**跨组去重**(先出现的组保留)
- [x] 3.3 所有候选值入表前过 `stripOneM()` —— 候选里不得出现 `[1M]` 后缀
- [x] 3.4 `priceTableModels` 的 appType 粗筛:claude → 名字含 `claude`;codex/grokbuild → 含 `gpt`/`codex`;**筛不中则整表返回**(宁多勿空)
- [x] 3.5 `stripOneM` 目前是 `NativeClaudeConfigSection.tsx` 的模块内私有函数 —— 需先决定:提取到共享位置,还是在新模块内复制。**优先提取**(避免两份实现漂移);提取时对 `stripOneM`/`hasOneM`/`withOneM` 跑 `impact` 确认无其它消费者
- [x] 3.6 校验:`npx tsc --noEmit`

---

## Step 4 · 表单弹框:密钥字段(核心步)

- [x] 4.1 `NativeProviderFormModal.tsx` 新增 4 个 state:`apiKey` / `selectedKeyId` / `revealedBaseline` / `revealing`+`revealError`(design §4.4 表格)。**不要塞进 `NativeProviderFormValues`** —— 它不参与 `providerConfig` 文档生成
- [x] 4.2 新增态渲染 `PasswordInput`;编辑态渲染 `TextInput` + 右侧 `Select`(列 `providerDetail.keys`)
- [x] 4.3 编辑态 `Select` 下方加「激活项请到 API 密钥 Tab 修改」说明(Step 7 的新 i18n key)
- [x] 4.4 `Select` 选项:禁用的 key **也列出但标注禁用**(design §5 场景表决议)
- [x] 4.5 `opened` 的 `useEffect` 追加:选中激活 key → `provider_key_reveal` → 填输入框 + 设 `revealedBaseline`。**沿用 `NativeProviderKeyFormModal.tsx:61-93` 的 `cancelled` 竞态守卫写法**,不要另造
- [x] 4.6 切换 `Select` → 重新 reveal 所选 key、替换输入框、更新 `revealedBaseline`;**确认没有调用 `provider_key_activate`**(语义:切换只是查看)
- [x] 4.7 `canFetchModels` 改为 `Boolean(values.baseUrl.trim()) && (Boolean(apiKey.trim()) || Boolean(providerDetail?.keys.some(k => k.isActive && k.enabled)))`
- [x] 4.8 `fetchProviderModels()` 传入 `apiKey`
- [x] 4.9 `onSubmit` 签名扩展以上抛 apiKey / selectedKeyId / 是否变更;同步改 `NativeProviderFormModalProps`
- [x] 4.10 校验:`npx tsc --noEmit`(此时 `NativeProviderSettingsPage` 会因签名不匹配报错,属预期,Step 5 修)

---

## Step 5 · 提交链路(含部分失败处理)

- [x] 5.1 `useNativeProviderCatalog.ts`:`createProvider(input, initialApiKey?)`,在**同一个 `runAction("create-provider")` 内**串 `provider_catalog_create` → `provider_key_create({ activate: true })`(design §4.5)
- [x] 5.2 key 的 `label` 用自动生成的固定串(新 i18n key 或常量)。**不做唯一性校验、不加去重后缀**(prd D3),允许与已有 label 重名
- [x] 5.3 apiKey 留空时**跳过** `provider_key_create`,只建供应商(prd D1)
- [x] 5.4 **部分失败处理**(design §4.5 ⚠️):`provider_key_create` 失败时仍 `refreshSelection(created.card.id)`,并把表单切到 `edit` 模式绑定该供应商,错误提示引导重填密钥。**禁止让用户重试 create 建出重复供应商**
- [x] 5.5 `NativeProviderSettingsPage.tsx` 的 `handleSaveProvider`:新增态传 `apiKey`
- [x] 5.6 同处:原「新建后自动弹详情弹框」(L238 注释)改为**仅在未提供 apiKey 时**才 `setDetailOpened(true)` —— 留空的场景恰好保留原行为,引导用户去 Tab 补密钥
- [x] 5.7 编辑态:`updateProvider` 之后,按 `apiKey !== revealedBaseline` 决定是否 `updateKey({ id: selectedKeyId, apiKey })`。**值未变则不发请求**(否则误触发「密钥已变更,需重新预览应用」)
- [x] 5.8 校验:`npx tsc --noEmit` 通过

---

## Step 6 · 兜底模型改下拉 + 候选接入

- [x] 6.1 `NativeClaudeConfigSection.tsx`:props 由 `availableModels: string[]` 改为 `modelCandidates: ModelCandidateGroup[]`
- [x] 6.2 行 275-281 兜底模型 `TextInput` → `Select`(`searchable` + 允许自由输入),data 用分组候选
- [x] 6.3 行 242-259 五个角色模型的 `Select`:**去掉 `availableModels.length > 0` 的二分支渲染**,统一走 `Select`(design §4.6)
- [x] 6.4 确认下拉选中值正确参与 `withOneM()` 拼接,`[1M]` checkbox 行为不变
- [x] 6.5 `NativeProviderAdvancedConfigSection.tsx`:仅跟随 props 改名,**模型映射列表行为不变**,不引入分组候选(PRD Non-Goals)
- [x] 6.6 `NativeProviderFormModal.tsx`:接 `useModelPricingStore` 取 `modelPrices`、接 `catalog.providers` 取同类供应商模型,调 `buildModelCandidates()` 传下去
- [x] 6.7 确认 `providerConfigManual === true` 时模型选择**不覆盖**用户手写文档(PRD R5,沿用现有 `updateValue` 判定)
- [x] 6.8 校验:`npx tsc --noEmit`

---

## Step 7 · i18n(zh / en 成对)

- [x] 7.1 `src/lib/i18n.ts` zh 区块(≈1528)加 design §4.8 表格的 6 个 key
- [x] 7.2 en 区块(≈5480)加**完全对应**的 6 个 key —— 漏一个会在运行时露出 raw key
- [x] 7.3 校验:`npx tsc --noEmit`(`TranslationKey` 是联合类型,漏 en 会报错)

---

## Step 8 · 全场景实机验证(按 AC 逐条)

- [x] 8.1 **AC1** 新增 Claude 供应商填 名称+baseUrl+apiKey → 保存 → 「API 密钥」Tab 有 1 个激活密钥,`activeKeyLabel` 非空
- [x] 8.2 **AC2** 新增态填 baseUrl+有效 apiKey → 「获取模型」可点 → 返回列表 → 兜底模型与 5 角色模型都能选到;**全程未保存**
- [x] 8.3 **AC3** 编辑 ≥2 key 的供应商 → 回显激活 key → 切到另一个 → 明文随之切换 → 保存 → **激活 key 未变**,被选中 key 的值已更新
- [x] 8.4 **AC4** 断网/填错 key 使取模型失败 → 兜底模型仍能从「已配置/价格表/其他供应商」选 → 也能手敲任意 ID 保存成功
- [x] 8.5 **AC5** 编辑 0 个 key 的供应商 → 下拉为空、输入框可填 → 保存后创建并激活第一个 key
- [x] 8.6 **AC6** 已有供应商(不填表单 apiKey)点「获取模型」→ 仍从激活 key 取,行为与改动前一致
- [x] 8.7 三个 appType 各过一遍新增+编辑(claude / codex / grokbuild)
- [x] 8.8 全局配置已应用的供应商:改 key 值 → 出现「密钥已变更,请重新预览并应用」;**不改 key 值只改别的字段 → 不应出现该提示**
- [x] 8.9 cc-switch 导入的 key(label `Imported from CC Switch`)在下拉中正常可选
- [x] 8.10 部分失败演练:构造 `provider_key_create` 失败(如超长 label)→ 确认不产生重复供应商
- [x] 8.11 `CLI_MANAGER_DEBUG=1` 跑一次取模型 → **`grep` 日志确认无明文密钥**(Step 1.2 的验证)

---

## Step 9 · 完成闸机

- [x] 9.1 `npx tsc --noEmit` 通过
- [x] 9.2 `cd src-tauri && cargo check` 通过
- [x] 9.3 `cd src-tauri && cargo test` 全绿
- [x] 9.4 `detect_changes({scope:"compare", base_ref:"master"})` —— 确认影响面与 design §8 一致,无意外符号/执行流
- [x] 9.5 更新 `CHANGELOG.md` 的 **`V1.3.8`** 小节(prd D2)
- [x] 9.6 更新 `docs/功能清单.md` 对应功能小节
- [x] 9.7 提交(需用户确认后再 commit)

---

## 实现期内部决策(不需要用户拍板,但要在动手时定下来)

- **Step 3.5**:`stripOneM` / `hasOneM` / `withOneM` 目前是 `NativeClaudeConfigSection.tsx` 的模块内私有函数。提取到 `providerModelCandidates.ts` 还是新建共享 util —— 取决于 `impact` 结果;**不要复制两份实现**。

> 用户已拍板项见 `prd.md` 的「已确认决策」D1–D4(apiKey 非必填 / 版本号 V1.3.8 / label 不校验唯一 / 下拉只切查看)。

---

## 完成记录

- 提交:`f96b4aab feat(provider): maintain api key and model choice in one form`
- Step 8 实机验证由用户在自己的构建上完成并确认通过;Grok 403 经比对确认为密钥/数据差异,非本任务代码问题,已为其留下 warn/debug 诊断日志。
- 未覆盖:Rust「先判状态再解析」缺单测(需 mock HTTP server,dev-deps 仅有 tempfile,未擅自加依赖)。
