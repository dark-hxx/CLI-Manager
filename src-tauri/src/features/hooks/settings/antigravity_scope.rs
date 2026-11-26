use cli_manager_hook_schema::antigravity::valid_distro;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

const LIMIT: usize = 1024 * 1024;
const FILE: &str = ".gemini/config/hooks.json";
const IO_ERROR: &str = "antigravity_hook_io_failed";
const UNSAFE: &str = "antigravity_hook_path_unsupported";
const CHANGED: &str = "antigravity_hook_config_changed";

pub(super) struct Scope {
    home: PathBuf,
    // Linux HOME 原文与发行版一同绑定；不以 UNC 或宿主 HOME 回退。
    guest: Option<(String, String)>,
    pub(super) exe: String,
    pub(super) windows_native: bool,
}

// 在指名的 distro 中直接传递 argv；截断、启动失败和超时均不能被当作文件不存在。
fn wsl(
    distro: &str,
    args: &[&str],
    input: &[u8],
    limit: usize,
) -> Result<(Option<i32>, Vec<u8>), String> {
    let exe = crate::wsl::find_wsl_exe().ok_or("antigravity_hook_wsl_unavailable")?;
    let mut cmd = crate::shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    cmd.args(["-d", distro, "--exec"]).args(args);
    let out = crate::shell_resolver::output_with_input_timeout_bounded(
        cmd,
        input.to_vec(),
        Duration::from_secs(8),
        limit,
        0,
    )
    .map_err(|_| IO_ERROR)?;
    if out.stdout_truncated {
        return Err("antigravity_hook_too_large".into());
    }
    Ok((out.status.code(), out.stdout))
}

// HOME 与 wslpath 都必须返回一个明确的绝对路径，绝不把报错内容作为路径。
fn guest_path(distro: &str, args: &[&str]) -> Result<String, String> {
    let (code, stdout) = wsl(distro, args, &[], 8192)?;
    if code != Some(0) {
        return Err(UNSAFE.into());
    }
    let text = std::str::from_utf8(&stdout)
        .map_err(|_| UNSAFE)?
        .trim_end_matches(['\r', '\n']);
    if !text.starts_with('/')
        || text == "/"
        || text.contains('\\')
        || text.chars().any(char::is_control)
        || text.split('/').any(|s| matches!(s, "." | ".."))
    {
        return Err(UNSAFE.into());
    }
    Ok(text.into())
}

// 以 distro 自己的 HOME 校验范围，所有参数单独传入 sh；拒绝文件或中间目录链接。
const GUEST_SCRIPT: &str = r#"
set -eu
[ "$HOME" = "$1" ] && cd "$HOME" || exit 4
dir=.gemini/config
file=$dir/hooks.json
check() {
    for p in .gemini "$dir" "$file"; do [ ! -L "$p" ] || return 4; done
    for p in .gemini "$dir"; do [ ! -e "$p" ] || { [ -d "$p" ] && [ -x "$p" ]; } || return 4; done
    [ ! -e "$file" ] || [ -f "$file" ] || return 4
}
check || exit 4
if [ "$2" = read ]; then
    [ -e "$file" ] || exit 3
    [ "$(wc -c < "$file")" -le 1048576 ] || exit 5
    cat "$file"; exit
fi
umask 077
mkdir -p "$dir"
check || exit 4
stage=$(mktemp "$dir/.cli-manager-agy.XXXXXXXX")
trap 'rm -f "$stage"' EXIT
cat > "$stage"
check || exit 4
if [ "$3" = absent ]; then
    if ! ln "$stage" "$file" 2>/dev/null; then
        [ ! -e "$file" ] || exit 6
        (set -C; cat "$stage" > "$file") 2>/dev/null || exit 6
    fi
else
    [ -f "$file" ] || exit 6
    sum=$(sha256sum < "$file"); [ "${sum%% *}" = "$3" ] || exit 6
    mv -f "$stage" "$file"
fi
"#;

// 同一个真实 guest 脚本在临时 HOME 执行；Windows 的 Git Bash 合约测试不冒充真实 WSL。
#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    #[test]
    #[cfg_attr(windows, ignore = "requires Git Bash, not a real WSL distribution")]
    fn antigravity_guest_script_refuses_wrong_home_and_stale_shared_document() {
        let tmp = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let sh = crate::shell_resolver::resolve_git_bash_exe().expect("Git Bash");
        #[cfg(not(windows))]
        let sh = PathBuf::from("/bin/sh");
        let run = |wrong: bool, action: &str, old: &str, input: &[u8]| {
            let mut command = Command::new(&sh);
            command.current_dir(tmp.path());
            let home_arg = if wrong {
                "/not-the-selected-home"
            } else {
                "$HOME"
            };
            let script=format!("HOME=$PWD; export HOME; PATH=/usr/bin:/bin; export PATH; set -- \"{home_arg}\" \"$@\";\n{GUEST_SCRIPT}");
            command.args(["-c", &script, "fixture", action, old]);
            crate::shell_resolver::output_with_input_timeout_bounded(
                command,
                input.to_vec(),
                Duration::from_secs(10),
                2048,
                2048,
            )
            .unwrap()
        };
        let path = tmp.path().join(FILE);
        assert_eq!(run(false, "read", "", b"").status.code(), Some(3));
        assert!(!path.parent().unwrap().exists());
        assert_eq!(run(true, "publish", "absent", b"x").status.code(), Some(4));
        assert!(!path.exists());
        assert!(run(false, "publish", "absent", b"before").status.success());
        assert_eq!(run(false, "read", "", b"").stdout, b"before");
        assert_eq!(
            run(false, "publish", "absent", b"new").status.code(),
            Some(6)
        );
        assert_eq!(
            run(false, "publish", "bad-digest", b"new").status.code(),
            Some(6)
        );
        assert_eq!(fs::read(&path).unwrap(), b"before");
        let old = format!("{:x}", Sha256::digest(b"before"));
        assert!(run(false, "publish", &old, b"after").status.success());
        assert_eq!(fs::read(&path).unwrap(), b"after");
    }
}

impl Scope {
    pub(super) fn resolve(distro: Option<&str>) -> Result<Self, String> {
        let raw_exe = super::super::cli_manager_exe()?;
        let exe = if cfg!(windows) {
            super::strip_windows_verbatim(&raw_exe)
        } else {
            raw_exe
        };
        if let Some(name) = distro {
            if !cfg!(windows) || !valid_distro(name) {
                return Err("antigravity_hook_wsl_unavailable".into());
            }
            let home = guest_path(name, &["printenv", "HOME"])?;
            let program = guest_path(name, &["wslpath", "-a", "-u", &exe])?;
            if wsl(name, &["test", "-x", &program], &[], 0)?.0 != Some(0) {
                return Err(UNSAFE.into());
            }
            return Ok(Self {
                home: PathBuf::from(crate::wsl::linux_to_unc_wsl_path(&home, name)),
                guest: Some((name.into(), home)),
                exe: program,
                windows_native: false,
            });
        }
        Self::local(
            super::super::home_dir().ok_or("home_dir_unavailable")?,
            exe,
            cfg!(windows),
        )
    }

    pub(super) fn local(home: PathBuf, exe: String, windows_native: bool) -> Result<Self, String> {
        if !home.is_absolute()
            || !home.is_dir()
            || crate::wsl::is_wsl_config_dir(&home.to_string_lossy())
        {
            return Err(UNSAFE.into());
        }
        Ok(Self {
            home,
            guest: None,
            exe,
            windows_native,
        })
    }

    pub(super) fn distro(&self) -> Option<&str> {
        self.guest.as_ref().map(|(name, _)| name.as_str())
    }

    pub(super) fn config_display(&self) -> String {
        if let Some((distro, home)) = &self.guest {
            let linux = format!("{}/{FILE}", home.trim_end_matches('/'));
            return crate::wsl::linux_to_unc_wsl_path(&linux, distro);
        }
        let mut path = self.home.clone();
        for part in FILE.split('/') {
            path.push(part);
        }
        path.to_string_lossy().into_owned()
    }

    // 禁止 config 链接、目录联接或非普通文件引导到另一个作用域。
    fn checked_path(&self) -> Result<PathBuf, String> {
        let mut path = self.home.clone();
        for part in FILE.split('/') {
            path.push(part);
            match fs::symlink_metadata(&path) {
                Ok(meta) => {
                    #[cfg(windows)]
                    {
                        use std::os::windows::fs::MetadataExt;
                        if meta.file_attributes() & 0x400 != 0 {
                            return Err(UNSAFE.into());
                        }
                    }
                    if meta.is_symlink()
                        || (if part == "hooks.json" {
                            !meta.is_file()
                        } else {
                            !meta.is_dir()
                        })
                    {
                        return Err(UNSAFE.into());
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err(IO_ERROR.into()),
            }
        }
        Ok(path)
    }

    pub(super) fn read(&self) -> Result<Option<Vec<u8>>, String> {
        if let Some((distro, home)) = &self.guest {
            return match wsl(
                distro,
                &["sh", "-c", GUEST_SCRIPT, "agy-hook", home, "read"],
                &[],
                LIMIT,
            )? {
                (Some(0), bytes) => Ok(Some(bytes)),
                (Some(3), _) => Ok(None),
                (Some(4), _) => Err(UNSAFE.into()),
                (Some(5), _) => Err("antigravity_hook_too_large".into()),
                _ => Err(IO_ERROR.into()),
            };
        }
        let file = match fs::File::open(self.checked_path()?) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(IO_ERROR.into()),
        };
        let mut bytes = Vec::new();
        file.take((LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| IO_ERROR)?;
        if bytes.len() > LIMIT {
            return Err("antigravity_hook_too_large".into());
        }
        Ok(Some(bytes))
    }

    // 同目录私有暂存、复查旧字节后发布；首次安装不覆盖竞争创建的文件。
    pub(super) fn publish(&self, before: Option<&[u8]>, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > LIMIT {
            return Err("antigravity_hook_too_large".into());
        }
        if let Some((distro, home)) = &self.guest {
            let digest = before
                .map(|v| format!("{:x}", Sha256::digest(v)))
                .unwrap_or_else(|| "absent".into());
            return match wsl(
                distro,
                &[
                    "sh",
                    "-c",
                    GUEST_SCRIPT,
                    "agy-hook",
                    home,
                    "publish",
                    &digest,
                ],
                bytes,
                0,
            )?
            .0
            {
                Some(0) => Ok(()),
                Some(4) => Err(UNSAFE.into()),
                Some(6) => Err(CHANGED.into()),
                _ => Err(IO_ERROR.into()),
            };
        }
        let path = self.checked_path()?;
        let parent = path.parent().ok_or(UNSAFE)?;
        fs::create_dir_all(parent).map_err(|_| IO_ERROR)?;
        self.checked_path()?;
        let stage = parent.join(format!(".cli-manager-agy.{}.tmp", Uuid::new_v4()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&stage).map_err(|_| IO_ERROR)?;
        let result = self.publish_stage(file, &path, &stage, before, bytes);
        let _ = fs::remove_file(stage);
        result
    }

    fn publish_stage(
        &self,
        mut file: fs::File,
        path: &Path,
        stage: &Path,
        before: Option<&[u8]>,
        bytes: &[u8],
    ) -> Result<(), String> {
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| IO_ERROR)?;
        drop(file);
        if self.read()?.as_deref() != before {
            return Err(CHANGED.into());
        }
        if before.is_none() {
            return match fs::hard_link(stage, path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(CHANGED.into()),
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
                    ) || (cfg!(windows) && matches!(e.raw_os_error(), Some(1 | 50))) =>
                {
                    let mut opts = fs::OpenOptions::new();
                    opts.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        opts.mode(0o600);
                    }
                    let mut dest = opts.open(path).map_err(|err| {
                        if err.kind() == std::io::ErrorKind::AlreadyExists {
                            CHANGED.to_string()
                        } else {
                            IO_ERROR.to_string()
                        }
                    })?;
                    let written = dest.write_all(bytes).and_then(|()| dest.sync_all());
                    drop(dest);
                    if written.is_err() {
                        let _ = fs::remove_file(path);
                        return Err(IO_ERROR.into());
                    }
                    Ok(())
                }
                Err(_) => Err(IO_ERROR.into()),
            };
        }
        crate::provider::global::replace_live_from_stage(
            &path.to_string_lossy(),
            &stage.to_string_lossy(),
        )
    }
}
