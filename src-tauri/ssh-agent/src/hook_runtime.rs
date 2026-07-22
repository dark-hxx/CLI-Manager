use crate::layout::resolve_layout;
use crate::{AGENT_VERSION, PROTOCOL_MAJOR, PROTOCOL_MINOR};
use cli_manager_hook_schema::{normalize_hook_input, NormalizedHookInput};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_STDIN_BYTES: usize = 1024 * 1024;
const MAX_SPOOL_EVENTS: u64 = 10_000;
const MAX_SPOOL_BYTES: u64 = 32 * 1024 * 1024;
const SPOOL_TTL_MS: u64 = 24 * 60 * 60 * 1000;
const COMPACT_INTERVAL_MS: u64 = 60 * 1000;
const SPOOL_LOCK_STALE_SECS: u64 = 300;
const MAX_SPOOL_RECORD_BYTES: usize = 1024 * 1024;

const CLAUDE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "AgentToolStart",
    "AgentToolStop",
    "ToolStart",
    "ToolStop",
];
const CODEX_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Stop",
    "SubagentStart",
    "SubagentStop",
];

#[derive(Debug, Clone)]
pub struct HookCommandOptions {
    pub source: String,
    pub event: String,
    pub managed_by: String,
    pub installation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookRunResult {
    Noop,
    Spooled { sequence: u64 },
}

#[derive(Debug, Clone)]
struct HookBinding {
    host_id: String,
    client_instance_id: String,
    project_id: String,
    tab_id: String,
    bridge_epoch: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HookSpoolEvent {
    kind: &'static str,
    event_id: String,
    sequence: u64,
    host_id: String,
    client_instance_id: String,
    installation_id: String,
    project_id: String,
    tab_id: String,
    bridge_epoch: String,
    source: String,
    event: String,
    remote_cwd: String,
    remote_transcript_ref: String,
    agent_version: &'static str,
    protocol_version: String,
    occurred_at: u64,
    #[serde(flatten)]
    input: NormalizedHookInput,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpoolMeta {
    next_sequence: u64,
    count: u64,
    bytes: u64,
    last_compact_at: u64,
}

struct SpoolLock(PathBuf);

impl Drop for SpoolLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn valid_bound_value(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.contains(['\0', '\r', '\n', '/', '\\'])
}

fn binding_from_env() -> Option<HookBinding> {
    let read = |key: &str| {
        std::env::var(key)
            .ok()
            .filter(|value| valid_bound_value(value))
    };
    Some(HookBinding {
        host_id: read("CLI_MANAGER_SSH_HOST_ID")?,
        client_instance_id: read("CLI_MANAGER_SSH_CLIENT_INSTANCE_ID")?,
        project_id: read("CLI_MANAGER_PROJECT_ID")?,
        tab_id: read("CLI_MANAGER_TAB_ID")?,
        bridge_epoch: read("CLI_MANAGER_BRIDGE_EPOCH")?,
    })
}

fn validate_options(options: &HookCommandOptions) -> Result<(), String> {
    if options.managed_by != "cli-manager-ssh-agent" {
        return Err("hook_owner_invalid".to_string());
    }
    Uuid::parse_str(&options.installation_id)
        .map_err(|_| "hook_installation_id_invalid".to_string())?;
    let events = match options.source.as_str() {
        "claude" => CLAUDE_EVENTS,
        "codex" => CODEX_EVENTS,
        _ => return Err("hook_source_invalid".to_string()),
    };
    if !events.contains(&options.event.as_str()) {
        return Err("hook_event_invalid".to_string());
    }
    Ok(())
}

fn read_hook_input(reader: &mut impl Read) -> Result<serde_json::Value, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_STDIN_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "hook_stdin_read_failed".to_string())?;
    if bytes.len() > MAX_STDIN_BYTES {
        return Err("hook_stdin_too_large".to_string());
    }
    serde_json::from_slice(&bytes).map_err(|_| "hook_stdin_invalid".to_string())
}

pub(crate) fn spool_namespace(
    host_id: &str,
    client_instance_id: &str,
    installation_id: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(host_id.as_bytes());
    hasher.update([0]);
    hasher.update(client_instance_id.as_bytes());
    hasher.update([0]);
    hasher.update(installation_id.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn namespace(binding: &HookBinding, installation_id: &str) -> String {
    spool_namespace(
        &binding.host_id,
        &binding.client_instance_id,
        installation_id,
    )
}

fn spool_lock_is_stale(path: &Path) -> bool {
    #[cfg(unix)]
    if let Some(pid) = fs::read_to_string(path)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
    {
        if Path::new("/proc").is_dir() && !Path::new("/proc").join(pid.to_string()).exists() {
            return true;
        }
    }
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > Duration::from_secs(SPOOL_LOCK_STALE_SECS))
}

fn acquire_spool_lock(directory: &Path) -> Result<SpoolLock, String> {
    fs::create_dir_all(directory).map_err(|_| "hook_spool_dir_failed".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(directory, fs::Permissions::from_mode(0o700));
    }
    let path = directory.join("spool.lock");
    for _ in 0..6 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = writeln!(file, "{}", std::process::id());
                return Ok(SpoolLock(path));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if spool_lock_is_stale(&path) {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return Err("hook_spool_lock_failed".to_string()),
        }
    }
    Err("hook_spool_busy".to_string())
}

fn read_meta(path: &Path, spool_path: &Path) -> SpoolMeta {
    let stored = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<SpoolMeta>(&bytes).ok());
    let actual_bytes = fs::metadata(spool_path)
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    match stored {
        Some(meta) if meta.bytes == actual_bytes => meta,
        Some(meta) => {
            let mut rebuilt = rebuild_meta(spool_path);
            rebuilt.next_sequence = rebuilt.next_sequence.max(meta.next_sequence);
            rebuilt.last_compact_at = meta.last_compact_at;
            rebuilt
        }
        None => rebuild_meta(spool_path),
    }
}

fn rebuild_meta(spool_path: &Path) -> SpoolMeta {
    let bytes = fs::read(spool_path).unwrap_or_default();
    let mut next_sequence = 1;
    let mut count = 0;
    for line in bytes
        .split(|value| *value == b'\n')
        .filter(|line| !line.is_empty())
    {
        count += 1;
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) {
            if let Some(sequence) = value.get("sequence").and_then(serde_json::Value::as_u64) {
                next_sequence = next_sequence.max(sequence.saturating_add(1));
            }
        }
    }
    SpoolMeta {
        next_sequence,
        count,
        bytes: bytes.len() as u64,
        last_compact_at: 0,
    }
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec(value).map_err(|_| "hook_spool_meta_invalid".to_string())?;
    let mut file =
        File::create(&temporary).map_err(|_| "hook_spool_meta_write_failed".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "hook_spool_meta_write_failed".to_string())?;
    fs::rename(temporary, path).map_err(|_| "hook_spool_meta_promote_failed".to_string())
}

fn line_timestamp(line: &[u8]) -> u64 {
    serde_json::from_slice::<serde_json::Value>(line)
        .ok()
        .and_then(|value| value.get("occurredAt").and_then(serde_json::Value::as_u64))
        .unwrap_or_default()
}

fn compact_spool(
    spool_path: &Path,
    now: u64,
    incoming_len: u64,
    max_events: u64,
    max_bytes: u64,
    next_sequence_floor: u64,
) -> Result<(SpoolMeta, u64), String> {
    if max_events < 2 || max_bytes == 0 {
        return Err("hook_spool_limits_invalid".to_string());
    }
    let bytes = fs::read(spool_path).unwrap_or_default();
    if bytes.len() as u64 > MAX_SPOOL_BYTES.saturating_mul(2) {
        let corrupt = spool_path.with_extension(format!("oversize-{}", Uuid::new_v4().simple()));
        fs::rename(spool_path, corrupt).map_err(|_| "hook_spool_oversize_failed".to_string())?;
        let gap = serde_json::to_vec(&serde_json::json!({
            "kind": "gap",
            "sequence": next_sequence_floor.max(1),
            "dropped": 1,
            "reason": "spool_oversize",
            "occurredAt": now,
        }))
        .map_err(|_| "hook_spool_gap_invalid".to_string())?;
        let mut output = gap;
        output.push(b'\n');
        fs::write(spool_path, &output)
            .map_err(|_| "hook_spool_compact_write_failed".to_string())?;
        return Ok((
            SpoolMeta {
                next_sequence: next_sequence_floor.max(1).saturating_add(1),
                count: 1,
                bytes: output.len() as u64,
                last_compact_at: now,
            },
            next_sequence_floor.max(1).saturating_add(1),
        ));
    }
    let cutoff = now.saturating_sub(SPOOL_TTL_MS);
    let mut lines: Vec<Vec<u8>> = bytes
        .split(|value| *value == b'\n')
        .filter(|line| !line.is_empty() && line_timestamp(line) >= cutoff)
        .map(Vec::from)
        .collect();
    let original_count = bytes
        .split(|value| *value == b'\n')
        .filter(|line| !line.is_empty())
        .count() as u64;
    let mut dropped = original_count.saturating_sub(lines.len() as u64);
    while (lines.len() as u64)
        .saturating_add(1)
        .saturating_add(u64::from(dropped > 0))
        > max_events
    {
        lines.remove(0);
        dropped += 1;
    }
    let mut retained_bytes = lines.iter().map(|line| line.len() as u64 + 1).sum::<u64>();
    loop {
        let next_sequence = lines
            .iter()
            .filter_map(|line| serde_json::from_slice::<serde_json::Value>(line).ok())
            .filter_map(|value| value.get("sequence").and_then(serde_json::Value::as_u64))
            .max()
            .unwrap_or_default()
            .saturating_add(1)
            .max(next_sequence_floor)
            .max(1);
        let gap_len = if dropped > 0 {
            serde_json::to_vec(&serde_json::json!({
                "kind": "gap",
                "sequence": next_sequence,
                "dropped": dropped,
                "reason": "spool_limit",
                "occurredAt": now,
            }))
            .map_err(|_| "hook_spool_gap_invalid".to_string())?
            .len() as u64
                + 1
        } else {
            0
        };
        if retained_bytes
            .saturating_add(gap_len)
            .saturating_add(incoming_len)
            <= max_bytes
        {
            break;
        }
        let Some(line) = lines.first() else {
            return Err("hook_spool_event_too_large".to_string());
        };
        retained_bytes = retained_bytes.saturating_sub(line.len() as u64 + 1);
        lines.remove(0);
        dropped += 1;
    }
    let mut next_sequence = lines
        .iter()
        .filter_map(|line| serde_json::from_slice::<serde_json::Value>(line).ok())
        .filter_map(|value| value.get("sequence").and_then(serde_json::Value::as_u64))
        .max()
        .unwrap_or_default()
        .saturating_add(1)
        .max(next_sequence_floor)
        .max(1);
    if dropped > 0 {
        let gap = serde_json::to_vec(&serde_json::json!({
            "kind": "gap",
            "sequence": next_sequence,
            "dropped": dropped,
            "reason": "spool_limit",
            "occurredAt": now,
        }))
        .map_err(|_| "hook_spool_gap_invalid".to_string())?;
        next_sequence = next_sequence.saturating_add(1);
        lines.push(gap);
    }
    let mut output = Vec::new();
    for line in &lines {
        output.extend_from_slice(line);
        output.push(b'\n');
    }
    let temporary = spool_path.with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
    fs::write(&temporary, &output).map_err(|_| "hook_spool_compact_write_failed".to_string())?;
    fs::rename(temporary, spool_path)
        .map_err(|_| "hook_spool_compact_promote_failed".to_string())?;
    Ok((
        SpoolMeta {
            next_sequence,
            count: lines.len() as u64,
            bytes: output.len() as u64,
            last_compact_at: now,
        },
        next_sequence,
    ))
}

fn append_spool_with_limits(
    state_dir: &Path,
    binding: &HookBinding,
    installation_id: &str,
    mut event: HookSpoolEvent,
    now: u64,
    max_events: u64,
    max_bytes: u64,
) -> Result<u64, String> {
    let directory = state_dir
        .join("spool")
        .join(namespace(binding, installation_id));
    let _lock = acquire_spool_lock(&directory)?;
    let spool_path = directory.join("events.jsonl");
    let meta_path = directory.join("meta.json");
    let mut meta = read_meta(&meta_path, &spool_path);
    event.sequence = meta.next_sequence.max(1);
    let estimated_len = serde_json::to_vec(&event)
        .map_err(|_| "hook_spool_event_invalid".to_string())?
        .len() as u64
        + 1
        + 20;
    if now.saturating_sub(meta.last_compact_at) >= COMPACT_INTERVAL_MS
        || meta.count.saturating_add(1) > max_events
        || meta.bytes.saturating_add(estimated_len) > max_bytes
    {
        let (compacted, _) = compact_spool(
            &spool_path,
            now,
            estimated_len,
            max_events,
            max_bytes,
            meta.next_sequence,
        )?;
        meta = compacted;
    }
    event.sequence = meta.next_sequence.max(1);
    let mut line =
        serde_json::to_vec(&event).map_err(|_| "hook_spool_event_invalid".to_string())?;
    line.push(b'\n');
    if meta.count.saturating_add(1) > max_events
        || meta.bytes.saturating_add(line.len() as u64) > max_bytes
    {
        return Err("hook_spool_limits_exceeded".to_string());
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&spool_path)
        .and_then(|mut file| file.write_all(&line).and_then(|_| file.sync_data()))
        .map_err(|_| "hook_spool_append_failed".to_string())?;
    meta.next_sequence = event.sequence.saturating_add(1);
    meta.count = meta.count.saturating_add(1);
    meta.bytes = meta.bytes.saturating_add(line.len() as u64);
    write_json_atomic(&meta_path, &meta)?;
    Ok(event.sequence)
}

pub(crate) fn read_spool_batch(
    state_dir: &Path,
    namespace: &str,
    after_sequence: u64,
    limit: usize,
) -> Result<Vec<serde_json::Value>, String> {
    let spool_path = state_dir.join("spool").join(namespace).join("events.jsonl");
    let file = match File::open(&spool_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("hook_spool_read_failed".to_string()),
    };
    if file
        .metadata()
        .map_err(|_| "hook_spool_read_failed".to_string())?
        .len()
        > MAX_SPOOL_BYTES.saturating_mul(2)
    {
        return Err("hook_spool_oversize".to_string());
    }
    let mut reader = BufReader::new(file);
    let mut events = Vec::new();
    let limit = limit.clamp(1, 256);
    while events.len() < limit {
        let mut line = Vec::new();
        let read = (&mut reader)
            .take(MAX_SPOOL_RECORD_BYTES as u64 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| "hook_spool_read_failed".to_string())?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_SPOOL_RECORD_BYTES || !line.ends_with(b"\n") {
            return Err("hook_spool_record_too_large".to_string());
        }
        line.pop();
        if line.ends_with(b"\r") {
            line.pop();
        }
        if line.is_empty() {
            continue;
        }
        let value = serde_json::from_slice::<serde_json::Value>(&line)
            .map_err(|_| "hook_spool_record_invalid".to_string())?;
        let sequence = value
            .get("sequence")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "hook_spool_record_invalid".to_string())?;
        if sequence > after_sequence {
            events.push(value);
        }
    }
    Ok(events)
}

fn write_unacked_spool(
    input: File,
    temporary: &Path,
    through_sequence: u64,
) -> Result<(u64, u64), String> {
    let output = File::create(temporary).map_err(|_| "hook_spool_ack_write_failed".to_string())?;
    let mut reader = BufReader::new(input);
    let mut writer = BufWriter::new(output);
    let mut count = 0u64;
    let mut retained_bytes = 0u64;
    loop {
        let mut line = Vec::new();
        let read = (&mut reader)
            .take(MAX_SPOOL_RECORD_BYTES as u64 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| "hook_spool_ack_read_failed".to_string())?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_SPOOL_RECORD_BYTES || !line.ends_with(b"\n") {
            return Err("hook_spool_record_too_large".to_string());
        }
        let sequence = serde_json::from_slice::<serde_json::Value>(&line)
            .map_err(|_| "hook_spool_record_invalid".to_string())?
            .get("sequence")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "hook_spool_record_invalid".to_string())?;
        if sequence <= through_sequence {
            continue;
        }
        writer
            .write_all(&line)
            .map_err(|_| "hook_spool_ack_write_failed".to_string())?;
        count = count.saturating_add(1);
        retained_bytes = retained_bytes.saturating_add(line.len() as u64);
    }
    writer
        .flush()
        .map_err(|_| "hook_spool_ack_write_failed".to_string())?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|_| "hook_spool_ack_write_failed".to_string())?;
    Ok((count, retained_bytes))
}

pub(crate) fn ack_spool(
    state_dir: &Path,
    namespace: &str,
    through_sequence: u64,
) -> Result<(), String> {
    let directory = state_dir.join("spool").join(namespace);
    if !directory.exists() {
        return Ok(());
    }
    let _lock = acquire_spool_lock(&directory)?;
    let spool_path = directory.join("events.jsonl");
    let meta_path = directory.join("meta.json");
    let current_meta = read_meta(&meta_path, &spool_path);
    let input = match File::open(&spool_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("hook_spool_ack_read_failed".to_string()),
    };
    let temporary = spool_path.with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
    let (count, retained_bytes) = match write_unacked_spool(input, &temporary, through_sequence) {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    };
    fs::rename(temporary, &spool_path).map_err(|_| "hook_spool_ack_promote_failed".to_string())?;
    write_json_atomic(
        &meta_path,
        &SpoolMeta {
            next_sequence: current_meta.next_sequence,
            count,
            bytes: retained_bytes,
            last_compact_at: current_meta.last_compact_at,
        },
    )
}

#[cfg(unix)]
fn notify_bridge(runtime_dir: &Path, namespace: &str, sequence: u64) {
    use std::os::unix::net::UnixDatagram;
    let path = runtime_dir.join(format!("hook-{namespace}.sock"));
    if let Ok(socket) = UnixDatagram::unbound() {
        let _ = socket.send_to(sequence.to_string().as_bytes(), path);
    }
}

#[cfg(not(unix))]
fn notify_bridge(_runtime_dir: &Path, _namespace: &str, _sequence: u64) {}

fn build_event(
    options: &HookCommandOptions,
    binding: &HookBinding,
    mut input: NormalizedHookInput,
    cwd: String,
    now: u64,
) -> HookSpoolEvent {
    input.message = None;
    HookSpoolEvent {
        kind: "hookEvent",
        event_id: Uuid::new_v4().to_string(),
        sequence: 0,
        host_id: binding.host_id.clone(),
        client_instance_id: binding.client_instance_id.clone(),
        installation_id: options.installation_id.clone(),
        project_id: binding.project_id.clone(),
        tab_id: binding.tab_id.clone(),
        bridge_epoch: binding.bridge_epoch.clone(),
        source: options.source.clone(),
        event: options.event.clone(),
        remote_cwd: cwd,
        remote_transcript_ref: input.transcript_path.clone().unwrap_or_default(),
        agent_version: AGENT_VERSION,
        protocol_version: format!("{PROTOCOL_MAJOR}.{PROTOCOL_MINOR}"),
        occurred_at: now,
        input,
    }
}

pub fn run_hook(
    options: HookCommandOptions,
    reader: &mut impl Read,
) -> Result<HookRunResult, String> {
    validate_options(&options)?;
    let Some(binding) = binding_from_env() else {
        return Ok(HookRunResult::Noop);
    };
    let raw = read_hook_input(reader)?;
    let Some(input) = normalize_hook_input(&options.event, &raw) else {
        return Ok(HookRunResult::Noop);
    };
    let cwd = raw
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|path| path.to_string_lossy().to_string())
        })
        .unwrap_or_default();
    let now = now_ms();
    let event = build_event(&options, &binding, input, cwd, now);
    let layout = resolve_layout().map_err(str::to_string)?;
    let sequence = append_spool_with_limits(
        &layout.state_dir,
        &binding,
        &options.installation_id,
        event,
        now,
        MAX_SPOOL_EVENTS,
        MAX_SPOOL_BYTES,
    )?;
    notify_bridge(
        &layout.runtime_dir,
        &namespace(&binding, &options.installation_id),
        sequence,
    );
    Ok(HookRunResult::Spooled { sequence })
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::acquire_spool_lock;
    use super::{
        ack_spool, append_spool_with_limits, build_event, read_spool_batch, spool_namespace,
        validate_options, write_json_atomic, HookBinding, HookCommandOptions, HookRunResult,
        SpoolMeta,
    };
    use cli_manager_hook_schema::normalize_hook_input;
    use serde_json::json;
    use std::fs;

    fn options() -> HookCommandOptions {
        HookCommandOptions {
            source: "claude".into(),
            event: "Stop".into(),
            managed_by: "cli-manager-ssh-agent".into(),
            installation_id: "00000000-0000-4000-8000-000000000001".into(),
        }
    }

    fn binding() -> HookBinding {
        HookBinding {
            host_id: "host".into(),
            client_instance_id: "client".into(),
            project_id: "project".into(),
            tab_id: "tab".into(),
            bridge_epoch: "epoch".into(),
        }
    }

    #[test]
    fn validates_owner_source_event_and_installation() {
        validate_options(&options()).unwrap();
        let mut invalid = options();
        invalid.managed_by = "other".into();
        assert_eq!(
            validate_options(&invalid).unwrap_err(),
            "hook_owner_invalid"
        );
        invalid = options();
        invalid.event = "Unknown".into();
        assert_eq!(
            validate_options(&invalid).unwrap_err(),
            "hook_event_invalid"
        );
    }

    #[test]
    fn spool_namespace_isolates_hosts_clients_and_installations() {
        let base = spool_namespace("host-a", "client-a", "installation-a");
        assert_ne!(
            base,
            spool_namespace("host-b", "client-a", "installation-a")
        );
        assert_ne!(
            base,
            spool_namespace("host-a", "client-b", "installation-a")
        );
        assert_ne!(
            base,
            spool_namespace("host-a", "client-a", "installation-b")
        );
    }

    #[test]
    fn bounded_spool_inserts_gap_and_keeps_newest_events() {
        let temp = tempfile::tempdir().unwrap();
        let options = options();
        let binding = binding();
        for index in 0..5 {
            let input =
                normalize_hook_input("Stop", &json!({ "session_id": index.to_string() })).unwrap();
            let event = build_event(&options, &binding, input, "/repo".into(), 1000 + index);
            append_spool_with_limits(
                temp.path(),
                &binding,
                &options.installation_id,
                event,
                1000 + index,
                3,
                1024 * 1024,
            )
            .unwrap();
        }
        let spool = fs::read_to_string(
            fs::read_dir(temp.path().join("spool"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path()
                .join("events.jsonl"),
        )
        .unwrap();
        assert!(spool.contains("\"kind\":\"gap\""));
        assert!(spool.contains("\"sessionId\":\"4\""));
        assert!(spool.lines().count() <= 3);
        let sequences: Vec<u64> = spool
            .lines()
            .map(|line| {
                serde_json::from_str::<serde_json::Value>(line).unwrap()["sequence"]
                    .as_u64()
                    .unwrap()
            })
            .collect();
        assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn byte_limited_spool_counts_gap_within_quota() {
        let temp = tempfile::tempdir().unwrap();
        let options = options();
        let binding = binding();
        let max_bytes = 900;
        for index in 0..5 {
            let input =
                normalize_hook_input("Stop", &json!({ "session_id": index.to_string() })).unwrap();
            let event = build_event(&options, &binding, input, "/repo".into(), 1000 + index);
            append_spool_with_limits(
                temp.path(),
                &binding,
                &options.installation_id,
                event,
                1000 + index,
                100,
                max_bytes,
            )
            .unwrap();
        }
        let namespace = spool_namespace(
            &binding.host_id,
            &binding.client_instance_id,
            &options.installation_id,
        );
        let spool_path = temp
            .path()
            .join("spool")
            .join(namespace)
            .join("events.jsonl");
        let spool = fs::read_to_string(&spool_path).unwrap();
        assert!(spool.contains("\"kind\":\"gap\""));
        assert!(spool.contains("\"sessionId\":\"4\""));
        assert!(fs::metadata(spool_path).unwrap().len() <= max_bytes);
    }

    #[test]
    fn hook_result_shape_remains_noop_or_spooled() {
        assert_eq!(HookRunResult::Noop, HookRunResult::Noop);
        assert_eq!(
            HookRunResult::Spooled { sequence: 2 },
            HookRunResult::Spooled { sequence: 2 }
        );
    }

    #[test]
    fn spool_batch_ack_removes_only_confirmed_sequences() {
        let temp = tempfile::tempdir().unwrap();
        let options = options();
        let binding = binding();
        for index in 0..3 {
            let input = normalize_hook_input("Stop", &json!({ "session_id": index })).unwrap();
            let event = build_event(&options, &binding, input, "/repo".into(), 1000 + index);
            append_spool_with_limits(
                temp.path(),
                &binding,
                &options.installation_id,
                event,
                1000 + index,
                10,
                1024 * 1024,
            )
            .unwrap();
        }
        let namespace = spool_namespace(
            &binding.host_id,
            &binding.client_instance_id,
            &options.installation_id,
        );
        let first = read_spool_batch(temp.path(), &namespace, 0, 2).unwrap();
        assert_eq!(first.len(), 2);
        let ack = first[1]["sequence"].as_u64().unwrap();
        ack_spool(temp.path(), &namespace, ack).unwrap();
        let remaining = read_spool_batch(temp.path(), &namespace, 0, 10).unwrap();
        assert_eq!(remaining.len(), 1);
        assert!(remaining[0]["sequence"].as_u64().unwrap() > ack);
    }

    #[test]
    fn malformed_spool_is_not_silently_dropped_by_read_or_ack() {
        let temp = tempfile::tempdir().unwrap();
        let namespace = "malformed";
        let directory = temp.path().join("spool").join(namespace);
        fs::create_dir_all(&directory).unwrap();
        let spool_path = directory.join("events.jsonl");
        fs::write(&spool_path, b"{not-json}\n").unwrap();
        assert_eq!(
            read_spool_batch(temp.path(), namespace, 0, 10).unwrap_err(),
            "hook_spool_record_invalid"
        );
        assert_eq!(
            ack_spool(temp.path(), namespace, 1).unwrap_err(),
            "hook_spool_record_invalid"
        );
        assert_eq!(fs::read(&spool_path).unwrap(), b"{not-json}\n");
        assert!(fs::read_dir(&directory).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("events.tmp-")
        }));
    }

    #[cfg(unix)]
    #[test]
    fn stale_spool_lock_is_recovered() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("spool.lock"), u32::MAX.to_string()).unwrap();
        let lock = acquire_spool_lock(temp.path()).unwrap();
        drop(lock);
        assert!(!temp.path().join("spool.lock").exists());
    }

    #[test]
    fn stale_meta_cannot_reuse_an_appended_sequence() {
        let temp = tempfile::tempdir().unwrap();
        let options = options();
        let binding = binding();
        let first = build_event(
            &options,
            &binding,
            normalize_hook_input("Stop", &json!({ "session_id": "first" })).unwrap(),
            "/repo".into(),
            1000,
        );
        append_spool_with_limits(
            temp.path(),
            &binding,
            &options.installation_id,
            first,
            1000,
            10,
            1024 * 1024,
        )
        .unwrap();
        let namespace = spool_namespace(
            &binding.host_id,
            &binding.client_instance_id,
            &options.installation_id,
        );
        let directory = temp.path().join("spool").join(&namespace);
        write_json_atomic(
            &directory.join("meta.json"),
            &SpoolMeta {
                next_sequence: 1,
                count: 0,
                bytes: 0,
                last_compact_at: 0,
            },
        )
        .unwrap();
        let second = build_event(
            &options,
            &binding,
            normalize_hook_input("Stop", &json!({ "session_id": "second" })).unwrap(),
            "/repo".into(),
            1001,
        );
        append_spool_with_limits(
            temp.path(),
            &binding,
            &options.installation_id,
            second,
            1001,
            10,
            1024 * 1024,
        )
        .unwrap();
        let batch = read_spool_batch(temp.path(), &namespace, 0, 10).unwrap();
        let sequences: Vec<u64> = batch
            .iter()
            .filter_map(|event| event["sequence"].as_u64())
            .collect();
        assert_eq!(sequences, vec![1, 2]);
    }
}
