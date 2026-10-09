use super::{model::ExtensionCli, skill_repository};
use cli_manager_agent_capabilities::{discovery_layout, AgentKind};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, path::Path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillInventory {
    entries: Vec<InventoryEntry>,
    warnings: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InventoryEntry {
    cli: ExtensionCli,
    name: String,
    path: String,
    source_kind: String,
    status: String,
    link_target: Option<String>,
    import_path: Option<String>,
    managed: bool,
}

// Read-only discovery uses the same user roots as session diagnostics; no active session is needed.
pub(crate) async fn inspect() -> Result<SkillInventory, String> {
    let home = crate::provider::home::active()?;
    let records = skill_repository::list_installations().await?;
    let mut inventory = SkillInventory {
        entries: Vec::new(),
        warnings: Vec::new(),
    };
    for (cli, agent, root) in [
        (
            ExtensionCli::Claude,
            AgentKind::Claude,
            &home.targets.claude_config_dir,
        ),
        (
            ExtensionCli::Codex,
            AgentKind::Codex,
            &home.targets.codex_config_dir,
        ),
        (
            ExtensionCli::Grok,
            AgentKind::Grok,
            &home.targets.grok_config_dir,
        ),
    ] {
        let layout = discovery_layout(
            agent,
            Path::new(&home.home_path),
            Path::new(&home.home_path),
            Some(Path::new(root)),
        );
        for root in layout.skill_roots.into_iter().filter(|r| r.scope == "user") {
            let mut found = Vec::new();
            let scan = if home.identity.environment_kind == "wsl" {
                scan_wsl(
                    &root.path.to_string_lossy(),
                    &home.identity.environment_id,
                    cli,
                    root.source_kind,
                )
                .and_then(|(entries, limited)| {
                    found = entries;
                    if limited {
                        Err("extensions_inventory_limit".into())
                    } else {
                        Ok(())
                    }
                })
            } else {
                scan_local(
                    &root.path,
                    cli,
                    root.source_kind,
                    0,
                    &mut BTreeSet::new(),
                    &mut found,
                )
            };
            if let Err(code) = scan {
                inventory
                    .warnings
                    .push(format!("{}: {} ({code})", cli.key(), root.path.display()));
            }
            for entry in &mut found {
                entry.managed = records.iter().any(|r| {
                    r.cli == cli
                        && r.environment_kind == home.identity.environment_kind
                        && r.environment_id == home.identity.environment_id
                        && same_path(&r.target_path.to_string_lossy(), &entry.path)
                });
            }
            inventory.entries.extend(found);
        }
    }
    inventory.entries.sort_by(|a, b| {
        a.cli
            .cmp(&b.cli)
            .then(a.name.cmp(&b.name))
            .then(a.path.cmp(&b.path))
    });
    inventory
        .entries
        .dedup_by(|a, b| a.cli == b.cli && same_path(&a.path, &b.path));
    Ok(inventory)
}

fn same_path(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        a.replace('/', "\\")
            .eq_ignore_ascii_case(&b.replace('/', "\\"))
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

const MAX_INVENTORY_DEPTH: usize = 8;
const MAX_INVENTORY_ENTRIES: usize = 500;
const MAX_INVENTORY_PATHS: usize = 10_000;

struct ScanBudget<'a> {
    examined: usize,
    depth_limited: bool,
    visited: &'a mut BTreeSet<std::path::PathBuf>,
}

impl ScanBudget<'_> {
    // 在打开目录和推进迭代器前检查硬预算，不为判断是否结束而额外枚举一项。
    fn ensure_capacity(&self, output_len: usize) -> Result<(), String> {
        if output_len >= MAX_INVENTORY_ENTRIES || self.examined >= MAX_INVENTORY_PATHS {
            Err("extensions_inventory_limit".into())
        } else {
            Ok(())
        }
    }
}

// 枚举后的目录项可被删除或替换成文件；仅忽略这两种失效快照，保留权限等真实错误。
fn missing_scan_path(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

// Preserve partial warnings without letting a depth cutoff suppress bounded sibling discovery.
fn scan_local(
    path: &Path,
    cli: ExtensionCli,
    kind: &str,
    depth: usize,
    visited: &mut BTreeSet<std::path::PathBuf>,
    output: &mut Vec<InventoryEntry>,
) -> Result<(), String> {
    let mut budget = ScanBudget {
        examined: 0,
        depth_limited: false,
        visited,
    };
    scan_local_bounded(path, cli, kind, depth, &mut budget, output)?;
    if budget.depth_limited {
        Err("extensions_inventory_limit".into())
    } else {
        Ok(())
    }
}

// 深度只截断当前分支；硬预算先于目录枚举检查，失效条目不打断兄弟扫描，链接不递归。
fn scan_local_bounded(
    path: &Path,
    cli: ExtensionCli,
    kind: &str,
    depth: usize,
    budget: &mut ScanBudget<'_>,
    output: &mut Vec<InventoryEntry>,
) -> Result<(), String> {
    budget.ensure_capacity(output.len())?;
    budget.examined += 1;
    let metadata = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if missing_scan_path(&e) => return Ok(()),
        Err(_) => return Err("extensions_inventory_unreadable".into()),
    };
    let link = is_link(&metadata);
    if !metadata.is_dir() && !link {
        return Ok(());
    }
    if depth > MAX_INVENTORY_DEPTH {
        budget.depth_limited = true;
        return Ok(());
    }
    let resolved = fs::canonicalize(path).ok();
    let manifest = path.join("SKILL.md").is_file();
    if manifest || link {
        output.push(InventoryEntry {
            cli,
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path: path.to_string_lossy().into_owned(),
            source_kind: if path.components().any(|p| p.as_os_str() == ".system") {
                "builtin".into()
            } else {
                kind.into()
            },
            status: if manifest {
                "present"
            } else if resolved.is_none() {
                "missing"
            } else {
                "unscanned"
            }
            .into(),
            link_target: if link {
                resolved.as_ref().map(|p| p.to_string_lossy().into_owned())
            } else {
                None
            },
            import_path: if manifest {
                resolved.as_ref().map(|p| p.to_string_lossy().into_owned())
            } else {
                None
            },
            managed: false,
        });
        return Ok(());
    }
    if let Some(resolved) = resolved {
        if !budget.visited.insert(resolved) {
            return Ok(());
        }
    }
    budget.ensure_capacity(output.len())?;
    let mut children = match fs::read_dir(path) {
        Ok(children) => children,
        Err(error) if missing_scan_path(&error) => return Ok(()),
        Err(_) => return Err("extensions_inventory_unreadable".into()),
    };
    loop {
        budget.ensure_capacity(output.len())?;
        match children.next() {
            Some(Ok(entry)) => {
                scan_local_bounded(&entry.path(), cli, kind, depth + 1, budget, output)?;
            }
            Some(Err(error)) if missing_scan_path(&error) => budget.examined += 1,
            Some(Err(_)) => return Err("extensions_inventory_unreadable".into()),
            None => return Ok(()),
        }
    }
}

#[derive(Deserialize)]
struct WslInventory {
    entries: Vec<InventoryEntry>,
    limited: bool,
}

// All WSL traversal runs inside the selected distro, with bounded output and no installation scripts.
fn scan_wsl(
    path: &str,
    distro: &str,
    cli: ExtensionCli,
    kind: &str,
) -> Result<(Vec<InventoryEntry>, bool), String> {
    let linux = crate::wsl::parse_wsl_unc_path(path)
        .map(|(_, p)| p)
        .unwrap_or_else(|| path.replace('\\', "/"));
    let executable = crate::wsl::find_wsl_exe().ok_or("extensions_wsl_unavailable")?;
    let mut command = crate::shell_resolver::silent_command(executable.to_string_lossy().as_ref());
    command.args([
        "-d",
        distro,
        "--exec",
        "python3",
        "-c",
        WSL_SCAN,
        &linux,
        cli.key(),
        kind,
    ]);
    let output = crate::shell_resolver::output_with_timeout_bounded(
        command,
        std::time::Duration::from_secs(15),
        1024 * 1024,
    )
    .map_err(|_| "extensions_inventory_unreadable")?;
    if !output.status.success() {
        return Err("extensions_inventory_unreadable".into());
    }
    let mut inventory: WslInventory =
        serde_json::from_slice(&output.stdout).map_err(|_| "extensions_inventory_invalid")?;
    for entry in &mut inventory.entries {
        entry.path = crate::wsl::linux_to_unc_wsl_path(&entry.path, distro);
        entry.import_path = entry
            .import_path
            .as_ref()
            .map(|p| crate::wsl::linux_to_unc_wsl_path(p, distro));
    }
    Ok((inventory.entries, inventory.limited))
}

// 内嵌 exhausted/visit：预算先于目录枚举，普通文件复用 DirEntry，目录复查链接类型并跳过消失路径。
const WSL_SCAN: &str = r#"
import os, sys, json, stat
root, cli, kind = sys.argv[1:]
result = []
MAX_INVENTORY_DEPTH = 8
MAX_INVENTORY_ENTRIES = 500
MAX_INVENTORY_PATHS = 10000
examined = 0
limited = False
stopped = False

def exhausted():
    global limited, stopped
    if len(result) >= MAX_INVENTORY_ENTRIES or examined >= MAX_INVENTORY_PATHS:
        limited = stopped = True
    return stopped

def visit(path, depth, entry=None):
    global examined, limited
    if exhausted(): return
    examined += 1
    try:
        if entry is None or entry.is_dir(follow_symlinks=False):
            mode = os.lstat(path).st_mode
            linked, directory = stat.S_ISLNK(mode), stat.S_ISDIR(mode)
        else:
            linked, directory = entry.is_symlink(), False
    except (FileNotFoundError, NotADirectoryError):
        return
    if not directory and not linked: return
    if depth > MAX_INVENTORY_DEPTH:
        limited = True
        return
    manifest = os.path.isfile(os.path.join(path, 'SKILL.md'))
    if manifest or linked:
        result.append(dict(cli=cli, name=os.path.basename(path), path=path,
            sourceKind='builtin' if '.system' in path.split('/') else kind,
            status='present' if manifest else ('missing' if not os.path.exists(path) else 'unscanned'),
            linkTarget=os.path.realpath(path) if linked else None,
            importPath=os.path.realpath(path) if manifest else None, managed=False))
        return
    if exhausted(): return
    try:
        with os.scandir(path) as children:
            while not exhausted():
                try:
                    child = next(children)
                except StopIteration:
                    return
                visit(child.path, depth + 1, child)
    except (FileNotFoundError, NotADirectoryError):
        return
visit(root, 0)
print(json.dumps(dict(entries=result, limited=limited)))
"#;

#[cfg(test)]
#[path = "inventory_tests.rs"]
mod tests;
