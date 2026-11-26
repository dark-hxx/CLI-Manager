use crate::{app_paths, shell_resolver, wsl};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

pub(super) const LIMIT: usize = 2 * 1024 * 1024;

pub(super) struct Target {
    pub settings: PathBuf,
    pub library: PathBuf,
    distro: Option<String>,
}

pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// 不允许传任意 home 或文件路径；WSL 发行版作独立 argv，非 Windows 不降级为本机。
fn valid_distro(distro: &str) -> bool {
    !distro.trim().is_empty()
        && !matches!(distro, "." | "..")
        && distro.len() <= 128
        && !distro.starts_with('-')
        && distro
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
}

// 使用不加载配置文件的 sh，命令是内置字面量；路径/摘要各自传 argv，配置正文只经 stdin。
fn guest(
    distro: &str,
    args: &[&str],
    input: Vec<u8>,
    limit: usize,
) -> Result<(i32, Vec<u8>), String> {
    let exe = wsl::find_wsl_exe().ok_or("agy_wsl_unavailable")?;
    let mut cmd = shell_resolver::silent_command(exe.to_str().ok_or("agy_invalid_path")?);
    cmd.args(["-d", distro, "--exec"]).args(args);
    let out = shell_resolver::output_with_input_timeout_bounded(
        cmd,
        input,
        Duration::from_secs(12),
        limit + 1,
        0,
    )
    .map_err(|_| "agy_wsl_unavailable")?;
    if out.stdout.len() > limit || out.stdout_truncated {
        return Err("agy_config_too_large".into());
    }
    Ok((out.status.code().unwrap_or(-1), out.stdout))
}

fn guest_path(distro: &str, args: &[&str]) -> Result<String, String> {
    let (code, out) = guest(distro, args, vec![], 4096)?;
    let value = std::str::from_utf8(&out)
        .map_err(|_| "agy_invalid_path")?
        .trim_end_matches(['\r', '\n']);
    if code != 0
        || !value.starts_with('/')
        || value == "/"
        || value.chars().any(char::is_control)
        || value.split('/').any(|c| c == "." || c == "..")
    {
        return Err("agy_invalid_path".into());
    }
    Ok(value.to_owned())
}

impl Target {
    pub(super) fn resolve(distro: Option<String>) -> Result<Self, String> {
        let host_data = app_paths::cli_manager_data_dir()?
            .join("statusline")
            .join("agy");
        if let Some(distro) = distro {
            if !cfg!(windows) || !valid_distro(&distro) {
                return Err("agy_invalid_distro".into());
            }
            let home = guest_path(&distro, &["printenv", "HOME"])?;
            Ok(Self::wsl_scope(distro, &home, host_data))
        } else {
            let home = app_paths::home_dir_from_env()?;
            if !home.is_absolute() {
                return Err("agy_invalid_path".into());
            }
            Ok(Self::local(home, host_data))
        }
    }
    // Linux 路径按原文交给指定发行版。方案库即便遇到同名 HOME，也不跨工具或发行版共享。
    pub(super) fn wsl_scope(distro: String, home: &str, host_data: PathBuf) -> Self {
        let settings = format!(
            "{}/.gemini/antigravity-cli/settings.json",
            home.trim_end_matches('/')
        );
        let key = digest(format!("wsl:{}:{settings}", distro.to_lowercase()).as_bytes());
        Self {
            settings: settings.into(),
            library: host_data.join(format!("{key}.json")),
            distro: Some(distro),
        }
    }
    pub(super) fn local(home: PathBuf, data: PathBuf) -> Self {
        let settings = home
            .join(".gemini")
            .join("antigravity-cli")
            .join("settings.json");
        let key = digest(format!("local:{}", settings.display()).as_bytes());
        Self {
            settings,
            library: data.join(format!("{key}.json")),
            distro: None,
        }
    }
    pub(super) fn read(&self) -> Result<Option<Vec<u8>>, String> {
        let Some(distro) = self.distro.as_deref() else {
            return local_read(&self.settings);
        };
        let script = r#"if [ -L "$1" ]; then exit 1; elif [ ! -e "$1" ]; then exit 3; fi; [ -f "$1" ] && head -c 2097153 -- "$1""#;
        match guest(
            distro,
            &[
                "sh",
                "-c",
                script,
                "agy",
                self.settings.to_str().ok_or("agy_invalid_path")?,
            ],
            vec![],
            LIMIT,
        )? {
            (0, bytes) => Ok(Some(bytes)),
            (3, _) => Ok(None),
            _ => Err("agy_read_failed".into()),
        }
    }
    pub(super) fn replace(&self, expected: Option<&[u8]>, next: &[u8]) -> Result<(), String> {
        if next.len() > LIMIT {
            return Err("agy_config_too_large".into());
        }
        let Some(distro) = self.distro.as_deref() else {
            return local_replace(&self.settings, expected, next);
        };
        let stamp = expected.map(digest).unwrap_or_else(|| "missing".into());
        let path = self.settings.to_str().ok_or("agy_invalid_path")?;
        match guest(
            distro,
            &["sh", "-c", GUEST_REPLACE, "agy", path, &stamp],
            next.to_vec(),
            0,
        )?
        .0
        {
            0 => Ok(()),
            7 => Err("agy_changed".into()),
            _ => Err("agy_write_failed".into()),
        }
    }
    // WSL 的挂载点由对应发行版自己的 wslpath 决定，互操作或路径不支持时不安装。
    pub(super) fn command(&self, layout: &super::Layout) -> Result<String, String> {
        let exe = std::env::current_exe().map_err(|_| "agy_invalid_path")?;
        let raw = exe.to_str().ok_or("agy_invalid_path")?;
        let raw = if cfg!(windows) {
            raw.strip_prefix(r"\\?\").unwrap_or(raw)
        } else {
            raw
        };
        let token = layout.encode()?;
        if let Some(distro) = self.distro.as_deref() {
            let guest_exe = guest_path(distro, &["wslpath", "-a", "-u", raw])?;
            if guest(distro, &["test", "-x", &guest_exe], vec![], 0)?.0 != 0 {
                return Err("agy_invalid_path".into());
            }
            return command_line(&guest_exe, false, &token);
        }
        command_line(raw, cfg!(windows), &token)
    }
}

fn simple_windows_path(path: &str) -> bool {
    path.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"\\/:_.-~".contains(&b))
}

// agy 1.3.5 无法稳定启动带双引号的 Windows 可执行路径。复杂路径用系统自带的 PowerShell
// 启动固定 helper 并继承原始管道，不经过文本转码、不传递/执行用户的 statusLine.command。
pub(super) fn command_line(exe: &str, windows: bool, token: &str) -> Result<String, String> {
    if exe.is_empty()
        || exe.chars().any(char::is_control)
        || token.is_empty()
        || !token
            .bytes()
            .all(|x| x.is_ascii_alphanumeric() || matches!(x, b'-' | b'_'))
    {
        return Err("agy_invalid_path".into());
    }
    let args = format!("__agy_statusline {token}");
    if !windows {
        return Ok(format!("'{}' {args}", exe.replace('\'', "'\\''")));
    }
    if simple_windows_path(exe) {
        return Ok(format!("{exe} {args}"));
    }
    if exe.contains('"') {
        return Err("agy_invalid_path".into());
    }
    let root = PathBuf::from(std::env::var_os("SystemRoot").ok_or("agy_invalid_path")?);
    let ps = root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let path = ps.to_str().ok_or("agy_invalid_path")?;
    if !ps.is_absolute() || !ps.is_file() || !simple_windows_path(path) {
        return Err("agy_invalid_path".into());
    }
    use base64::{engine::general_purpose::STANDARD, Engine};
    let script = format!(
        "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';\
         $s=[Diagnostics.ProcessStartInfo]::new();$s.FileName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}'));\
         $s.Arguments='{args}';$s.UseShellExecute=$false;$p=[Diagnostics.Process]::Start($s);$p.WaitForExit();exit $p.ExitCode",
        STANDARD.encode(exe.as_bytes())
    );
    let encoded = STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let line = format!("{path} -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}");
    if line.len() > 8191 {
        return Err("agy_invalid_path".into());
    }
    Ok(line)
}

// 暂存文件默认仅当前用户可读。已有文件保留权限；摘要变化时不发布暂存内容。
const GUEST_REPLACE: &str = r#"
set -eu
umask 077
p=$1
mkdir -p -- "${p%/*}"
t=$(mktemp -- "${p%/*}/.agy-XXXXXXXX")
trap 'rm -f -- "$t"' EXIT
cat > "$t"
[ ! -L "$p" ] || exit 7
if [ -e "$p" ]; then
  [ -f "$p" ] || exit 7
  sum=$(sha256sum < "$p"); [ "${sum%% *}" = "$2" ] || exit 7
  chmod --reference="$p" -- "$t"
else
  [ "$2" = missing ] || exit 7
fi
mv -fT -- "$t" "$p"
"#;

// 读权限/格式错误不能当作文件不存在；拒绝符号链接、设备和过大的文件。
pub(super) fn local_read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => meta,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        _ => return Err("agy_read_failed".into()),
    };
    if meta.len() > LIMIT as u64 {
        return Err("agy_config_too_large".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|f| f.take(LIMIT as u64 + 1).read_to_end(&mut bytes))
        .map_err(|_| "agy_read_failed")?;
    if bytes.len() > LIMIT {
        return Err("agy_config_too_large".into());
    }
    Ok(Some(bytes))
}

// 同目录新文件原子替换。绝不先删除用户文件；发布前再核对原字节，失败清理自己创建的暂存。
pub(super) fn local_replace(
    path: &Path,
    expected: Option<&[u8]>,
    next: &[u8],
) -> Result<(), String> {
    if next.len() > LIMIT {
        return Err("agy_config_too_large".into());
    }
    let parent = path.parent().ok_or("agy_invalid_path")?;
    fs::create_dir_all(parent).map_err(|_| "agy_write_failed")?;
    let temp = parent.join(format!(".agy-{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|_| "agy_write_failed")?;
    let result = (|| {
        file.write_all(next).map_err(|_| "agy_write_failed")?;
        if expected.is_some() {
            file.set_permissions(fs::metadata(path).map_err(|_| "agy_changed")?.permissions())
                .map_err(|_| "agy_write_failed")?;
        }
        file.sync_all().map_err(|_| "agy_write_failed")?;
        drop(file);
        if local_read(path)?.as_deref() != expected {
            return Err("agy_changed".into());
        }
        fs::rename(&temp, path).map_err(|_| "agy_write_failed".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
