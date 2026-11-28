mod render;
mod target;
#[cfg(test)]
mod tests;

pub use render::{run_and_exit, Layout};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;
use target::{digest, local_read, local_replace, Target};

static MUTATIONS: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
enum Block {
    Missing,
    Present(Value),
}

impl Block {
    fn value(&self) -> Option<&Value> {
        match self {
            Self::Missing => None,
            Self::Present(v) => Some(v),
        }
    }
    fn replace_in(&self, root: &mut Map<String, Value>) {
        match self {
            Self::Missing => {
                root.remove("statusLine");
            }
            Self::Present(v) => {
                root.insert("statusLine".into(), v.clone());
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Native,
    Custom,
    Stacked,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct Owner {
    original: Block,
    installed: Block,
    layout: Layout,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Pending {
    desired: Block,
    next: Option<Owner>,
}

#[derive(Default, Serialize, Deserialize)]
struct Library {
    profiles: BTreeMap<String, Layout>,
    selected: Option<String>,
    owner: Option<Owner>,
    pending: Option<Pending>,
}

struct Loaded {
    external_bytes: Option<Vec<u8>>,
    library_bytes: Option<Vec<u8>>,
    root: Map<String, Value>,
    current: Block,
    library: Library,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    revision: String,
    path: String,
    ownership: &'static str,
    mode: Mode,
    command: Option<String>,
    profiles: BTreeMap<String, Layout>,
    selected: Option<String>,
    layout: Layout,
}

// CAS 使用读取时看到的状态栏块和独立方案库字节；其他设置在点击应用时重新读入并保留。
impl Loaded {
    fn read(target: &Target) -> Result<Self, String> {
        let external_bytes = target.read()?;
        let root: Map<String, Value> = match external_bytes.as_deref() {
            Some(bytes) => {
                serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes))
                    .map_err(|_| "agy_invalid_config")?
            }
            None => Map::new(),
        };
        let current = root
            .get("statusLine")
            .cloned()
            .map(Block::Present)
            .unwrap_or(Block::Missing);
        let library_bytes = local_read(&target.library)?;
        let mut library: Library = match library_bytes.as_deref() {
            Some(bytes) => serde_json::from_slice(bytes).map_err(|_| "agy_invalid_library")?,
            None => Library::default(),
        };
        // 崩溃恢复只在内存核对，不因首次查看产生写入。尚未发布的 pending 保留旧所有权。
        if let Some(pending) = library.pending.take() {
            if current == pending.desired {
                library.owner = pending.next;
            }
        }
        Ok(Self {
            external_bytes,
            library_bytes,
            root,
            current,
            library,
        })
    }
    fn ownership(&self) -> &'static str {
        match &self.library.owner {
            Some(owner) if owner.installed == self.current => "managed",
            Some(_) => "drifted",
            None if self.current != Block::Missing => "external",
            None => "native",
        }
    }
    fn status(&self, target: &Target) -> Status {
        let data = self.current.value();
        let command = data
            .and_then(|v| v.get("command"))
            .and_then(Value::as_str)
            .filter(|cmd| !cmd.is_empty());
        let mode = if command.is_none()
            || data.and_then(|v| v.get("enabled")).and_then(Value::as_bool) == Some(false)
        {
            Mode::Native
        } else if data
            .and_then(|v| v.get("stack_with_default"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            Mode::Stacked
        } else {
            Mode::Custom
        };
        let layout = self
            .library
            .selected
            .as_ref()
            .and_then(|s| self.library.profiles.get(s))
            .or_else(|| self.library.owner.as_ref().map(|owner| &owner.layout))
            .cloned()
            .unwrap_or_default();
        // 各目标使用独立配置库路径，拒绝把上一个发行版的确认用于当前发行版。
        let revision = digest(
            &serde_json::to_vec(&(
                target.library.to_string_lossy(),
                &self.current,
                self.library_bytes.as_deref().map(digest),
            ))
            .expect("JSON fields"),
        );
        Status {
            revision,
            path: target.settings.display().to_string(),
            command: command.map(str::to_owned),
            ownership: self.ownership(),
            mode,
            profiles: self.library.profiles.clone(),
            selected: self.library.selected.clone(),
            layout,
        }
    }
    fn save_library(&mut self, target: &Target) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&self.library).map_err(|_| "agy_invalid_library")?;
        local_replace(&target.library, self.library_bytes.as_deref(), &bytes)?;
        self.library_bytes = Some(bytes);
        Ok(())
    }
    // 先持久化原块和意图，后发布外部文件；进程中断时，下一次读取按现存块恢复旧或新所有权。
    fn publish(
        &mut self,
        target: &Target,
        desired: Block,
        next: Option<Owner>,
    ) -> Result<(), String> {
        if self.current == desired {
            // 内容已相同也可能需要接管或解除所有权；永不为此重写用户文件。
            if self.library.owner != next {
                self.library.owner = next;
                self.save_library(target)?;
            }
            return Ok(());
        }
        desired.replace_in(&mut self.root);
        let mut bytes = if self
            .external_bytes
            .as_deref()
            .is_some_and(|b| b.starts_with(b"\xef\xbb\xbf"))
        {
            b"\xef\xbb\xbf".to_vec()
        } else {
            vec![]
        };
        serde_json::to_writer_pretty(&mut bytes, &self.root).map_err(|_| "agy_invalid_config")?;
        bytes.push(b'\n');
        self.library.pending = Some(Pending {
            desired: desired.clone(),
            next: next.clone(),
        });
        self.save_library(target)?;
        target.replace(self.external_bytes.as_deref(), &bytes)?;
        self.library.owner = next;
        self.library.pending = None;
        self.save_library(target)
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Change {
    SaveProfile {
        name: String,
        layout: Layout,
    },
    SelectProfile {
        name: String,
    },
    Apply {
        mode: Mode,
        layout: Layout,
        confirmed: bool,
    },
    Restore,
}

// 只合并/复原 statusLine，已有自定义和外部漂移都要求对当前快照明确确认；恢复严格要求仍由本应用管理。
fn change(target: &Target, revision: &str, op: Change) -> Result<Status, String> {
    let mut loaded = Loaded::read(target)?;
    if loaded.status(target).revision != revision {
        return Err("agy_changed".into());
    }
    match op {
        Change::SaveProfile { name, layout } => {
            layout.validate()?;
            let name = name.trim();
            if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
                return Err("agy_invalid_name".into());
            }
            if loaded.library.profiles.len() >= 64 && !loaded.library.profiles.contains_key(name) {
                return Err("agy_profile_limit".into());
            }
            loaded.library.profiles.insert(name.to_owned(), layout);
            loaded.library.selected = Some(name.to_owned());
            loaded.save_library(target)?;
        }
        Change::SelectProfile { name } => {
            if !loaded.library.profiles.contains_key(&name) {
                return Err("agy_changed".into());
            }
            loaded.library.selected = Some(name);
            loaded.save_library(target)?;
        }
        Change::Apply {
            mode,
            layout,
            confirmed,
        } => {
            layout.validate()?;
            let ownership = loaded.ownership();
            if matches!(ownership, "external" | "drifted") && !confirmed {
                return Err("agy_confirm_required".into());
            }
            if mode == Mode::Native && loaded.status(target).mode == Mode::Native {
                return Ok(loaded.status(target));
            }
            let mut block = loaded
                .current
                .value()
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            block.insert("enabled".into(), json!(mode != Mode::Native));
            if mode != Mode::Native {
                block.insert("command".into(), json!(target.command(&layout)?));
                block.insert("type".into(), json!("command"));
                block.insert("stack_with_default".into(), json!(mode == Mode::Stacked));
            }
            let desired = Block::Present(Value::Object(block));
            let original = if ownership == "managed" {
                loaded.library.owner.as_ref().unwrap().original.clone()
            } else {
                loaded.current.clone()
            };
            let owner = Owner {
                original,
                installed: desired.clone(),
                layout,
            };
            loaded.publish(target, desired, Some(owner))?;
        }
        Change::Restore => {
            if loaded.ownership() != "managed" {
                return Err("agy_not_owned".into());
            }
            let original = loaded.library.owner.as_ref().unwrap().original.clone();
            loaded.publish(target, original, None)?;
        }
    }
    Ok(Loaded::read(target)?.status(target))
}

// 配置读取可能启动指定发行版；不阻塞 GUI，且读取不会创建方案或写入目标。
#[tauri::command]
pub async fn agy_statusline_load(distro: Option<String>) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = Target::resolve(distro)?;
        let _lock = MUTATIONS.lock().map_err(|_| "agy_write_failed")?;
        Ok(Loaded::read(&target)?.status(&target))
    })
    .await
    .map_err(|_| "agy_read_failed".to_owned())?
}

// 同一进程内按序发布。重复窗口、旧预览和确认框均不能覆盖重新读取后已经变化的块。
#[tauri::command]
pub async fn agy_statusline_change(
    distro: Option<String>,
    revision: String,
    op: Change,
) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = Target::resolve(distro)?;
        let _lock = MUTATIONS.lock().map_err(|_| "agy_write_failed")?;
        change(&target, &revision, op)
    })
    .await
    .map_err(|_| "agy_write_failed".to_owned())?
}

// 样例没有外部命令、路径访问或 transcript 读取。实际 helper 调用相同的 render。
#[tauri::command]
pub fn agy_statusline_preview(layout: Layout, width: u16) -> Result<String, String> {
    let sample = json!({"model":{"display_name":"Gemini"}, "workspace":{"current_dir":"/work/demo"}, "agent_state":"working", "terminal_width":width,
        "context_window":{"used_percentage":14.2, "total_input_tokens":12400, "total_output_tokens":380}});
    render::render(&layout, &sample)
}
