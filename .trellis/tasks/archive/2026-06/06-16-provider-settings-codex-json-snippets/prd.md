# 供应商设置页增强：Codex 配置解析 + 原始 JSON 查看 + 配置片段支持

## 背景

当前供应商设置页（V1.0.9 已完成 P0+P1+P2 优化）存在以下问题：

1. **Codex 配置未解析**：`parse_settings_config` 只解析 `ANTHROPIC_*` 前缀环境变量，Codex 使用的 `OPENAI_*` / `GOOGLE_*` 等配置无法正确提取 BASE_URL 和模型信息。
2. **缺少原始配置查看**：用户无法查看 `settings_config` 的完整 JSON（cc-switch 编辑配置时可以看到），不利于排查配置问题或手动复制。
3. **配置片段未支持**：cc-switch 数据库有 `config_snippets` 表，用于存储可复用的通用配置片段，当前未读取展示。

## 目标

1. 扩展配置解析逻辑支持多 app_type（claude / codex / cursor / gemini 等）
2. 在供应商详情面板添加原始配置 JSON 查看区
3. 新增配置片段列表页，支持查看、搜索、复制通用配置片段

## 需求详细

### 需求 1：Codex 等多 app_type 配置解析支持

#### 现状问题
```rust
// src-tauri/src/commands/ccswitch.rs:68-92
fn parse_settings_config(raw: &str) -> Option<ParsedConfig> {
    // 只解析 ANTHROPIC_BASE_URL / ANTHROPIC_MODEL
    if key == "ANTHROPIC_BASE_URL" {
        parsed.base_url = Some(text.clone());
    } else if key == "ANTHROPIC_MODEL" {
        parsed.model = Some(text.clone());
    }
    // ...
}
```

Codex 配置示例：
```json
{
  "env": {
    "OPENAI_BASE_URL": "https://api.openai.com/v1",
    "OPENAI_API_KEY": "sk-xxx",
    "OPENAI_MODEL": "gpt-4"
  }
}
```

当前解析后 `base_url` 和 `model` 为 `None`，前端显示空白。

#### 解决方案

**后端改动**：`src-tauri/src/commands/ccswitch.rs`

1. 扩展 `parse_settings_config` 函数，根据环境变量前缀动态识别：
   - `ANTHROPIC_*` → Claude
   - `OPENAI_*` → Codex (OpenAI)
   - `GOOGLE_*` → Gemini
   - `DEEPSEEK_*` → DeepSeek
   - 其他自定义前缀

2. 实现逻辑：
```rust
fn parse_settings_config(raw: &str) -> Option<ParsedConfig> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let mut parsed = ParsedConfig {
        base_url: None,
        model: None,
        masked_env: BTreeMap::new(),
    };
    
    if let Some(env) = value.get("env").and_then(Value::as_object) {
        // 检测环境变量前缀，找到 BASE_URL 和 MODEL
        for (key, raw_value) in env {
            let text = env_value_text(raw_value);
            
            // 通用模式匹配：*_BASE_URL / *_API_BASE / *_ENDPOINT
            if key.ends_with("_BASE_URL") || key.ends_with("_API_BASE") || key.ends_with("_ENDPOINT") {
                parsed.base_url = Some(text.clone());
            }
            // 通用模式匹配：*_MODEL
            else if key.ends_with("_MODEL") {
                parsed.model = Some(text.clone());
            }
            
            // 掩码处理与插入 masked_env
            let display = if is_secret_env_key(key) {
                mask_secret(&text)
            } else {
                text
            };
            parsed.masked_env.insert(key.clone(), display);
        }
    }
    Some(parsed)
}
```

**前端改动**：无需修改，自动生效。

#### 验收标准
- [ ] Codex 供应商（`OPENAI_BASE_URL` / `OPENAI_MODEL`）正确解析并显示
- [ ] Gemini 供应商（`GOOGLE_*`）正确解析
- [ ] 自定义前缀供应商（如 `DEEPSEEK_BASE_URL`）正确解析
- [ ] Claude 供应商（`ANTHROPIC_*`）保持兼容，无回归

---

### 需求 2：原始配置 JSON 查看

#### 功能描述

在供应商详情面板（`ProviderDetailPanel`）底部新增"原始配置"折叠区：
- 默认折叠，显示"查看原始配置"按钮
- 展开后显示格式化的 `settings_config` JSON
- 右上角添加"复制 JSON"按钮

#### 实现方案

**后端改动**：`src-tauri/src/commands/ccswitch.rs`

在 `CcSwitchProvider` 结构体新增字段：
```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcSwitchProvider {
    // ... 现有字段
    /// 原始 settings_config JSON 文本（脱敏后的密钥仍为明文，前端只用于展示，不用于实际应用）
    raw_settings_config: String,
}
```

在 `provider_from_row` 中填充：
```rust
fn provider_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<CcSwitchProvider, String> {
    let settings_config: String = row.try_get("settings_config").map_err(map_err)?;
    // ... 解析逻辑
    
    Ok(CcSwitchProvider {
        // ... 现有字段
        raw_settings_config: settings_config, // 原样返回
    })
}
```

**前端改动**：`src/components/settings/pages/ProviderSettingsPage.tsx`

在 `ProviderDetailPanel` 组件底部添加：
```tsx
function ProviderDetailPanel({ provider }: { provider: CcSwitchProvider }) {
  const [rawConfigExpanded, setRawConfigExpanded] = useState(false);
  
  // 格式化 JSON（可能解析失败则显示原始文本）
  const formattedJson = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(provider.rawSettingsConfig), null, 2);
    } catch {
      return provider.rawSettingsConfig;
    }
  }, [provider.rawSettingsConfig]);
  
  return (
    <Card>
      {/* ... 现有内容 */}
      
      <Divider />
      
      <Box>
        <Group justify="space-between" mb="xs">
          <Text size="xs" c="var(--text-muted)">原始配置</Text>
          {rawConfigExpanded && (
            <CopyButton value={provider.rawSettingsConfig} label="已复制配置" />
          )}
        </Group>
        
        {!rawConfigExpanded ? (
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => setRawConfigExpanded(true)}
          >
            查看原始配置
          </Button>
        ) : (
          <>
            <Box className="rounded-md bg-surface-container-lowest/70 px-3 py-2 max-h-[300px] overflow-y-auto">
              <Text
                component="pre"
                size="xs"
                ff="var(--font-ui-mono)"
                c="var(--on-surface)"
                className="whitespace-pre-wrap break-all"
              >
                {formattedJson}
              </Text>
            </Box>
            <Button
              size="compact-xs"
              variant="subtle"
              mt="xs"
              onClick={() => setRawConfigExpanded(false)}
            >
              收起
            </Button>
          </>
        )}
      </Box>
    </Card>
  );
}
```

**类型定义更新**：`src/components/settings/pages/ProviderSettingsPage.tsx`

```tsx
interface CcSwitchProvider {
  // ... 现有字段
  rawSettingsConfig: string;
}
```

#### 验收标准
- [ ] 供应商详情底部显示"查看原始配置"按钮
- [ ] 点击展开显示格式化的 JSON（缩进 2 空格）
- [ ] JSON 解析失败时显示原始文本（容错）
- [ ] 展开状态下右上角有"复制 JSON"按钮，点击复制成功
- [ ] 点击"收起"按钮折叠区域
- [ ] 切换供应商时自动重置为折叠状态

---

### 需求 3：配置片段支持

#### 功能描述

新增"配置片段"标签页（与"供应商"并列），展示 cc-switch 数据库 `config_snippets` 表内容：
- 列表展示所有配置片段（名称、描述）
- 点击片段显示详情（JSON 内容）
- 支持搜索片段（按名称、描述）
- 支持复制片段 JSON

#### 数据库结构（推测）

```sql
CREATE TABLE config_snippets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  config_json TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);
```

#### 实现方案

**后端改动**：`src-tauri/src/commands/ccswitch.rs`

1. 新增数据结构：
```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcSwitchConfigSnippet {
    id: String,
    name: String,
    description: Option<String>,
    config_json: String,
    created_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcSwitchConfigSnippetsResponse {
    db_path: String,
    snippets: Vec<CcSwitchConfigSnippet>,
}
```

2. 新增命令：
```rust
#[tauri::command]
pub async fn ccswitch_list_config_snippets(
    app: tauri::AppHandle,
    db_path: Option<String>,
) -> Result<CcSwitchConfigSnippetsResponse, String> {
    let path = resolve_db_path(&app, db_path)?;
    let mut conn = open_db_readonly(&path).await?;
    
    let rows = sqlx::query(
        "SELECT id, name, description, config_json, created_at \
         FROM config_snippets ORDER BY name"
    )
    .fetch_all(&mut conn)
    .await
    .map_err(|err| format!("db_query_failed: {err}"))?;
    
    let snippets = rows.iter().map(|row| {
        let map_err = |err: sqlx::Error| format!("db_query_failed: {err}");
        Ok(CcSwitchConfigSnippet {
            id: row.try_get("id").map_err(map_err)?,
            name: row.try_get("name").map_err(map_err)?,
            description: row.try_get("description").map_err(map_err)?,
            config_json: row.try_get("config_json").map_err(map_err)?,
            created_at: row.try_get("created_at").map_err(map_err)?,
        })
    }).collect::<Result<Vec<_>, _>>()?;
    
    let _ = conn.close().await;
    
    Ok(CcSwitchConfigSnippetsResponse {
        db_path: path.to_string_lossy().into_owned(),
        snippets,
    })
}
```

3. 注册命令：`src-tauri/src/lib.rs`
```rust
.invoke_handler(tauri::generate_handler![
    // ... 现有命令
    ccswitch_list_config_snippets,
])
```

**前端改动**：`src/components/settings/pages/ProviderSettingsPage.tsx`

在设置页导航添加"配置片段"标签（或在供应商页内用 Tabs 切换）。

新增组件 `ConfigSnippetsPanel`：
```tsx
function ConfigSnippetsPanel({ searchValue }: { searchValue: string }) {
  const ccSwitchDbPath = useSettingsStore((s) => s.ccSwitchDbPath);
  const [snippets, setSnippets] = useState<CcSwitchConfigSnippet[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSnippetId, setSelectedSnippetId] = useState<string | null>(null);
  
  const loadSnippets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await invoke<CcSwitchConfigSnippetsResponse>(
        "ccswitch_list_config_snippets",
        { dbPath: ccSwitchDbPath ?? undefined }
      );
      setSnippets(response.snippets);
    } catch (err) {
      setSnippets([]);
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [ccSwitchDbPath]);
  
  useEffect(() => {
    void loadSnippets();
  }, [loadSnippets]);
  
  const visibleSnippets = useMemo(() => {
    const keyword = searchValue.trim().toLowerCase();
    if (!keyword) return snippets;
    return snippets.filter((s) =>
      [s.name, s.description]
        .filter((f): f is string => typeof f === "string")
        .some((f) => f.toLowerCase().includes(keyword))
    );
  }, [snippets, searchValue]);
  
  const selectedSnippet = visibleSnippets.find((s) => s.id === selectedSnippetId) ?? null;
  
  return (
    // 类似供应商页布局：左侧列表 + 右侧详情
  );
}
```

详情面板显示：
- 名称、描述
- 格式化的 config_json
- 复制 JSON 按钮

#### 验收标准
- [ ] 设置页新增"配置片段"入口（标签或独立页）
- [ ] 成功读取并展示 `config_snippets` 表数据
- [ ] 列表显示片段名称和描述
- [ ] 点击片段显示详情（格式化 JSON）
- [ ] 搜索功能可按名称、描述筛选
- [ ] 详情面板有"复制 JSON"按钮
- [ ] 数据库未连接或表不存在时优雅降级（显示提示）

---

## 非目标

- **不做**：配置片段的创建/编辑/删除（只读展示）
- **不做**：配置片段一键应用到供应商/项目（未来可扩展）
- **不做**：Codex 项目级供应商切换（当前只支持 claude 项目）

## 技术约束

- 保持后端只读权限（cc-switch 数据库仅读取）
- 前端保持现有组件架构
- 配置片段功能独立，不影响现有供应商页

## 实施顺序

1. **第一阶段**：Codex 配置解析支持（后端改动最小，收益明显）
2. **第二阶段**：原始配置 JSON 查看（前后端联动，用户体验提升）
3. **第三阶段**：配置片段支持（新增功能，独立模块）

## 开发工时估算

- 需求 1（Codex 解析）：1-1.5 小时
- 需求 2（原始 JSON 查看）：1-1.5 小时
- 需求 3（配置片段）：2-2.5 小时
- **总计**：4-5.5 小时

## 附录

### 相关文件
- `src-tauri/src/commands/ccswitch.rs`（后端核心）
- `src-tauri/src/lib.rs`（命令注册）
- `src/components/settings/pages/ProviderSettingsPage.tsx`（前端主体）
- `src/components/SettingsModal.tsx`（设置页导航，可能需要调整）
