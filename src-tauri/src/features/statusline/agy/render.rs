use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Item {
    Model,
    Directory,
    State,
    Context,
    Input,
    Output,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Layout {
    pub items: Vec<Item>,
    pub color: bool,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            items: vec![
                Item::Model,
                Item::Directory,
                Item::State,
                Item::Context,
                Item::Input,
                Item::Output,
            ],
            color: true,
        }
    }
}

impl Layout {
    // 只允许固定的显示项，没有 shell、自定义文本、文件路径或其他可执行配置。
    pub(super) fn validate(&self) -> Result<(), String> {
        if self.items.len() > 6
            || self
                .items
                .iter()
                .enumerate()
                .any(|(i, item)| self.items[..i].contains(item))
        {
            return Err("agy_invalid_layout".into());
        }
        Ok(())
    }
    pub(super) fn encode(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_vec(self)
            .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
            .map_err(|_| "agy_invalid_layout".into())
    }
}

// 只渲染可打印字段；不允许载荷中的 ESC、控制符或双向文本控制改变终端显示。
fn text(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    let clean: String = value
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(512)
        .collect();
    (!clean.trim().is_empty()).then_some(clean)
}

fn field(item: Item, data: &Value) -> Option<(String, u8)> {
    Some(match item {
        Item::Model => (
            text(data.pointer("/model/display_name"))
                .or_else(|| text(data.pointer("/model/id")))?,
            36,
        ),
        Item::Directory => (
            text(data.pointer("/workspace/current_dir")).or_else(|| text(data.get("cwd")))?,
            34,
        ),
        Item::State => (text(data.get("agent_state"))?, 32),
        Item::Context => {
            let percent = data.pointer("/context_window/used_percentage")?.as_f64()?;
            if !(0.0..=100.0).contains(&percent) {
                return None;
            }
            (format!("{percent:.1}%"), 33)
        }
        Item::Input => (
            format!(
                "↓{}",
                data.pointer("/context_window/total_input_tokens")?
                    .as_u64()?
            ),
            35,
        ),
        Item::Output => (
            format!(
                "↑{}",
                data.pointer("/context_window/total_output_tokens")?
                    .as_u64()?
            ),
            35,
        ),
    })
}

// 保守预算：非 ASCII 最多按双格计，窄屏先换行，单项过宽时截断；SGR 不占预算。
fn fit(value: &str, limit: usize) -> (String, usize) {
    let mut result = String::new();
    let mut used = 0;
    for c in value.chars() {
        let size = if c.is_ascii() { 1 } else { 2 };
        if used + size > limit {
            break;
        }
        result.push(c);
        used += size;
    }
    (result, used)
}

// 预览与真实 helper 共用同一渲染器；缺字段跳过，实际报告的 0 保留。
pub fn render(layout: &Layout, data: &Value) -> Result<String, String> {
    layout.validate()?;
    let width = data
        .get("terminal_width")
        .and_then(Value::as_u64)
        .unwrap_or(100)
        .clamp(1, 1000) as usize;
    let mut output = String::new();
    let mut used = 0;
    for (value, color) in layout.items.iter().filter_map(|item| field(*item, data)) {
        let (part, cells) = fit(&value, width);
        if part.is_empty() {
            continue;
        }
        if used > 0 {
            if used + 3 + cells > width {
                output.push('\n');
                used = 0;
            } else {
                output.push_str(" | ");
                used += 3;
            }
        }
        if layout.color {
            output.push_str(&format!("\x1b[{color}m{part}\x1b[0m"));
        } else {
            output.push_str(&part);
        }
        used += cells;
    }
    Ok(output)
}

// 布局内联在受管理命令，WSL 互操作调用宿主 helper 也不需打开宿主或 guest 的配置文件。
pub(super) fn from_stream(encoded: &str, input: impl Read) -> Option<String> {
    if encoded.len() > 1024 {
        return None;
    }
    let layout = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    let mut bytes = Vec::new();
    input.take(256 * 1024 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 256 * 1024 {
        return None;
    }
    render(&layout, &serde_json::from_slice(&bytes).ok()?).ok()
}

// stdin 载荷仅在内存中存在；错误静默退出，不启动 WebView、不记录会话或调用其他程序。
pub fn run_and_exit(encoded: Option<&str>) -> ! {
    if let Some(output) = encoded.and_then(|arg| from_stream(arg, std::io::stdin().lock())) {
        use std::io::Write;
        let mut stdout = std::io::stdout().lock();
        let _ = stdout
            .write_all(output.as_bytes())
            .and_then(|_| stdout.flush());
    }
    std::process::exit(0)
}
