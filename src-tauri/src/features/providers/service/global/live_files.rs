use super::{live_path, LivePath, WSL_OPERATION_TIMEOUT};
use crate::{shell_resolver, wsl};
use std::fs;
use std::process::Command;

pub(super) fn wsl_command(distro: &str, program: &str, args: &[&str]) -> Result<Command, String> {
    let exe = wsl::find_wsl_exe().ok_or_else(|| "provider_wsl_unavailable".to_string())?;
    let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg(program)
        .args(args);
    Ok(command)
}

pub(super) fn run_wsl(
    distro: &str,
    program: &str,
    args: &[&str],
) -> Result<std::process::Output, String> {
    shell_resolver::output_with_timeout(wsl_command(distro, program, args)?, WSL_OPERATION_TIMEOUT)
        .map_err(|_| "provider_wsl_operation_failed".to_string())
}

pub(super) fn run_wsl_script(
    distro: &str,
    script: &str,
    args: &[String],
) -> Result<std::process::Output, String> {
    let mut command = wsl_command(distro, "sh", &["-lc", script, "cli-manager"])?;
    command.args(args);
    shell_resolver::output_with_timeout(command, WSL_OPERATION_TIMEOUT)
        .map_err(|_| "provider_wsl_operation_failed".to_string())
}

pub(super) fn run_wsl_script_with_input(
    distro: &str,
    script: &str,
    args: &[String],
    input: &[u8],
) -> Result<(), String> {
    let mut command = wsl_command(distro, "sh", &["-lc", script, "cli-manager"])?;
    command.args(args);
    let output = shell_resolver::output_with_input_timeout_bounded(
        command,
        input.to_vec(),
        WSL_OPERATION_TIMEOUT,
        0,
        0,
    )
    .map_err(|error| {
        if error.kind() == std::io::ErrorKind::TimedOut {
            "provider_wsl_operation_timeout".to_string()
        } else {
            "provider_wsl_operation_failed".to_string()
        }
    })?;
    output
        .status
        .success()
        .then_some(())
        .ok_or_else(|| "provider_wsl_operation_failed".to_string())
}

pub(super) fn wsl_batch_group(paths: &[String]) -> Option<(String, Vec<String>)> {
    let mut distro: Option<String> = None;
    let mut linux_paths = Vec::with_capacity(paths.len());
    for path in paths {
        let (path_distro, linux_path) = wsl::parse_wsl_unc_path(path)?;
        if distro
            .as_deref()
            .is_some_and(|current| !current.eq_ignore_ascii_case(&path_distro))
        {
            return None;
        }
        distro = Some(path_distro);
        linux_paths.push(linux_path);
    }
    Some((distro?, linux_paths))
}

pub(super) fn run_wsl_with_input(
    distro: &str,
    program: &str,
    args: &[&str],
    input: &[u8],
) -> Result<(), String> {
    let command = wsl_command(distro, program, args)?;
    let output = shell_resolver::output_with_input_timeout_bounded(
        command,
        input.to_vec(),
        WSL_OPERATION_TIMEOUT,
        0,
        0,
    )
    .map_err(|error| {
        if error.kind() == std::io::ErrorKind::TimedOut {
            "provider_wsl_operation_timeout".to_string()
        } else {
            "provider_wsl_operation_failed".to_string()
        }
    })?;
    output
        .status
        .success()
        .then_some(())
        .ok_or_else(|| "provider_wsl_operation_failed".to_string())
}

pub(crate) fn read_live(path: &str) -> Result<Option<Vec<u8>>, String> {
    match live_path(path) {
        LivePath::Local(path) => match fs::read(path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("provider_target_read_failed".to_string()),
        },
        LivePath::Wsl { distro, linux_path } => {
            let exists = run_wsl(&distro, "test", &["-e", &linux_path])
                .map_err(|_| "provider_target_read_failed".to_string())?;
            if !exists.status.success() {
                return Ok(None);
            }
            let output = run_wsl(&distro, "cat", &[&linux_path])?;
            if !output.status.success() {
                return Err("provider_target_read_failed".to_string());
            }
            Ok(Some(output.stdout))
        }
    }
}

pub(super) const WSL_BATCH_READ_SCRIPT: &str = r#"
for path do
  if [ -e "$path" ]; then
    size=$(wc -c < "$path") || exit 1
    printf '1 %s\n' "$size"
    cat -- "$path" || exit 1
    printf '\n'
  else
    printf '0 0\n'
  fi
done
"#;

pub(super) fn parse_wsl_batch_reads(
    stdout: &[u8],
    expected: usize,
) -> Result<Vec<Option<Vec<u8>>>, String> {
    let mut offset = 0;
    let mut values = Vec::with_capacity(expected);
    for _ in 0..expected {
        let header_end = stdout[offset..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| offset + index)
            .ok_or_else(|| "provider_target_read_failed".to_string())?;
        let header = std::str::from_utf8(&stdout[offset..header_end])
            .map_err(|_| "provider_target_read_failed".to_string())?;
        let mut fields = header.split_whitespace();
        let exists = fields.next() == Some("1");
        let length = fields
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .ok_or_else(|| "provider_target_read_failed".to_string())?;
        if fields.next().is_some() {
            return Err("provider_target_read_failed".to_string());
        }
        offset = header_end + 1;
        if !exists {
            if length != 0 {
                return Err("provider_target_read_failed".to_string());
            }
            values.push(None);
            continue;
        }
        let end = offset
            .checked_add(length)
            .ok_or_else(|| "provider_target_read_failed".to_string())?;
        if end >= stdout.len() || stdout[end] != b'\n' {
            return Err("provider_target_read_failed".to_string());
        }
        values.push(Some(stdout[offset..end].to_vec()));
        offset = end + 1;
    }
    if offset != stdout.len() {
        return Err("provider_target_read_failed".to_string());
    }
    Ok(values)
}

pub(super) fn read_live_many(paths: &[String]) -> Result<Vec<Option<Vec<u8>>>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    if let Some((distro, linux_paths)) = wsl_batch_group(paths) {
        let output = run_wsl_script(&distro, WSL_BATCH_READ_SCRIPT, &linux_paths)?;
        if !output.status.success() {
            return Err("provider_target_read_failed".to_string());
        }
        return parse_wsl_batch_reads(&output.stdout, paths.len());
    }
    paths.iter().map(|path| read_live(path)).collect()
}

pub(crate) fn live_is_file(path: &str) -> bool {
    match live_path(path) {
        LivePath::Local(path) => path.is_file(),
        LivePath::Wsl { distro, linux_path } => run_wsl(&distro, "test", &["-f", &linux_path])
            .ok()
            .is_some_and(|output| output.status.success()),
    }
}

pub(crate) fn live_is_dir(path: &str) -> bool {
    match live_path(path) {
        LivePath::Local(path) => path.is_dir(),
        LivePath::Wsl { distro, linux_path } => run_wsl(&distro, "test", &["-d", &linux_path])
            .ok()
            .is_some_and(|output| output.status.success()),
    }
}

pub(crate) fn create_live_dir_all(path: &str) -> Result<(), String> {
    match live_path(path) {
        LivePath::Local(path) => {
            fs::create_dir_all(path).map_err(|_| "provider_target_directory_failed".to_string())
        }
        LivePath::Wsl { distro, linux_path } => {
            let output = run_wsl(&distro, "mkdir", &["-p", &linux_path])?;
            if output.status.success() {
                Ok(())
            } else {
                Err("provider_target_directory_failed".to_string())
            }
        }
    }
}

pub(crate) fn target_writable(path: &str) -> bool {
    match live_path(path) {
        LivePath::Local(path) => match fs::metadata(&path) {
            Ok(metadata) => metadata.is_file() && !metadata.permissions().readonly(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => path
                .parent()
                .and_then(|parent| {
                    let existing = parent.ancestors().find(|candidate| candidate.is_dir())?;
                    fs::metadata(existing).ok()
                })
                .map(|metadata| !metadata.permissions().readonly())
                .unwrap_or(false),
            Err(_) => false,
        },
        LivePath::Wsl { distro, linux_path } => {
            let parent =
                linux_path
                    .rsplit_once('/')
                    .map(|(parent, _)| if parent.is_empty() { "/" } else { parent });
            match run_wsl(&distro, "test", &["-e", &linux_path]) {
                Ok(output) if output.status.success() => {
                    run_wsl(&distro, "test", &["-f", &linux_path])
                        .ok()
                        .filter(|output| output.status.success())
                        .and_then(|_| run_wsl(&distro, "test", &["-w", &linux_path]).ok())
                        .map(|output| output.status.success())
                        .unwrap_or(false)
                }
                Ok(_) => parent
                    .map(|_| wsl_writable_parent(&distro, &linux_path))
                    .unwrap_or(false),
                Err(_) => false,
            }
        }
    }
}

pub(super) const WSL_BATCH_WRITABLE_SCRIPT: &str = r#"
for path do
  if [ -e "$path" ]; then
    if [ -f "$path" ] && [ -w "$path" ]; then printf '1\n'; else printf '0\n'; fi
    continue
  fi
  parent=${path%/*}
  [ -z "$parent" ] && parent=/
  while [ ! -d "$parent" ] && [ "$parent" != "/" ]; do
    next=${parent%/*}
    [ -z "$next" ] && next=/
    [ "$next" = "$parent" ] && parent=/ || parent=$next
  done
  if [ -d "$parent" ] && [ -w "$parent" ]; then printf '1\n'; else printf '0\n'; fi
done
"#;

pub(super) fn target_writable_many(paths: &[String]) -> Vec<bool> {
    if paths.is_empty() {
        return Vec::new();
    }
    if let Some((distro, linux_paths)) = wsl_batch_group(paths) {
        let Ok(output) = run_wsl_script(&distro, WSL_BATCH_WRITABLE_SCRIPT, &linux_paths) else {
            return vec![false; paths.len()];
        };
        if !output.status.success() {
            return vec![false; paths.len()];
        }
        let Ok(stdout) = String::from_utf8(output.stdout) else {
            return vec![false; paths.len()];
        };
        let values = stdout.lines().map(|line| line == "1").collect::<Vec<_>>();
        if values.len() == paths.len() {
            return values;
        }
        return vec![false; paths.len()];
    }
    paths.iter().map(|path| target_writable(path)).collect()
}

pub(super) fn wsl_writable_parent(distro: &str, linux_path: &str) -> bool {
    let mut current = linux_path
        .rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .unwrap_or("/")
        .to_string();
    loop {
        if run_wsl(distro, "test", &["-d", &current])
            .ok()
            .is_some_and(|output| output.status.success())
        {
            return run_wsl(distro, "test", &["-w", &current])
                .ok()
                .is_some_and(|output| output.status.success());
        }
        if current == "/" {
            return false;
        }
        current = current
            .rsplit_once('/')
            .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
            .unwrap_or("/")
            .to_string();
    }
}

pub(super) fn ensure_parent(path: &str) -> Result<(), String> {
    match live_path(path) {
        LivePath::Local(path) => path
            .parent()
            .ok_or_else(|| "provider_target_parent_invalid".to_string())
            .and_then(|parent| {
                fs::create_dir_all(parent)
                    .map_err(|_| "provider_target_directory_failed".to_string())
            }),
        LivePath::Wsl { distro, linux_path } => {
            let parent = linux_path
                .rsplit_once('/')
                .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
                .ok_or_else(|| "provider_target_parent_invalid".to_string())?;
            let output = run_wsl(&distro, "mkdir", &["-p", parent])?;
            if output.status.success() {
                Ok(())
            } else {
                Err("provider_target_directory_failed".to_string())
            }
        }
    }
}

pub(crate) fn write_live(path: &str, bytes: &[u8]) -> Result<(), String> {
    ensure_parent(path)?;
    match live_path(path) {
        LivePath::Local(path) => {
            fs::write(path, bytes).map_err(|_| "provider_target_write_failed".to_string())
        }
        LivePath::Wsl { distro, linux_path } => run_wsl_with_input(
            &distro,
            "sh",
            &["-c", "cat > \"$1\"", "cli-manager", &linux_path],
            bytes,
        ),
    }
}

pub(super) const WSL_BATCH_WRITE_SCRIPT: &str = r#"
for path do
  parent=${path%/*}
  [ -n "$parent" ] && mkdir -p "$parent" || exit 1
  IFS= read -r length || exit 1
  case "$length" in
    ''|*[!0-9]*) exit 1 ;;
  esac
  head -c "$length" > "$path" || exit 1
done
"#;

pub(super) fn write_live_many(paths: &[String], payloads: &[Vec<u8>]) -> Result<(), String> {
    if paths.len() != payloads.len() {
        return Err("provider_target_write_failed".to_string());
    }
    if paths.is_empty() {
        return Ok(());
    }
    if let Some((distro, linux_paths)) = wsl_batch_group(paths) {
        let mut input = Vec::new();
        for payload in payloads {
            input.extend_from_slice(payload.len().to_string().as_bytes());
            input.push(b'\n');
            input.extend_from_slice(payload);
        }
        return run_wsl_script_with_input(&distro, WSL_BATCH_WRITE_SCRIPT, &linux_paths, &input);
    }
    for (path, payload) in paths.iter().zip(payloads) {
        write_live(path, payload)?;
    }
    Ok(())
}

pub(crate) fn remove_live(path: &str) -> Result<(), String> {
    match live_path(path) {
        LivePath::Local(path) => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("provider_target_restore_failed".to_string()),
        },
        LivePath::Wsl { distro, linux_path } => {
            let output = run_wsl(&distro, "rm", &["-f", &linux_path])?;
            if output.status.success() {
                Ok(())
            } else {
                Err("provider_target_restore_failed".to_string())
            }
        }
    }
}
