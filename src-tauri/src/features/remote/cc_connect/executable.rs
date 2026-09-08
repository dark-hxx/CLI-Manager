use super::{
    path_string, update, DetectedBinary, CODEX_APP_SERVER_PROBE_TIMEOUT,
    VERIFIED_V1_4_1_BINARY_SHA256, VERSION_PROBE_TIMEOUT,
};
use crate::shell_resolver::{output_with_timeout, silent_command};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::env;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

// 逐个检查候选文件，优先返回可信兼容版本并保留首个不兼容结果。
pub(super) fn detect_binary_uncached(
    explicit_path: Option<&str>,
) -> Result<DetectedBinary, String> {
    let candidates = executable_candidates(explicit_path)?;
    let mut failures = Vec::new();
    let mut incompatible = None;
    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        match inspect_binary(&candidate) {
            Ok(binary) if binary.compatible => return Ok(binary),
            Ok(binary) => {
                if incompatible.is_none() {
                    incompatible = Some(binary);
                }
            }
            Err(err) => failures.push(format!("{}: {err}", candidate.display())),
        }
    }
    if let Some(binary) = incompatible {
        return Ok(binary);
    }
    if failures.is_empty() {
        Err("cc-connect native executable not found in PATH".to_string())
    } else {
        Err(failures.join("; "))
    }
}

// 从显式路径或环境收集原生候选，按小写路径去重。
pub(super) fn executable_candidates(explicit_path: Option<&str>) -> Result<Vec<PathBuf>, String> {
    let mut raw = Vec::new();
    if let Some(explicit) = explicit_path {
        let path = PathBuf::from(explicit);
        if !path.is_absolute() {
            return Err("cc-connect executable path must be absolute".to_string());
        }
        raw.extend(expand_native_candidate(&path));
    } else {
        if let Some(path) = env::var_os("CC_CONNECT_PATH") {
            raw.extend(expand_native_candidate(&PathBuf::from(path)));
        }
        if let Some(path_value) = env::var_os("PATH") {
            for dir in env::split_paths(&path_value) {
                #[cfg(target_os = "windows")]
                {
                    raw.push(
                        dir.join("node_modules")
                            .join("cc-connect")
                            .join("bin")
                            .join("cc-connect.exe"),
                    );
                    raw.push(dir.join("cc-connect.exe"));
                }
                #[cfg(not(target_os = "windows"))]
                raw.push(dir.join("cc-connect"));
            }
        }
    }
    let mut seen = HashSet::new();
    Ok(raw
        .into_iter()
        .filter(|path| seen.insert(path.to_string_lossy().to_lowercase()))
        .collect())
}

// 在 Windows 展开原生 exe 和 npm 包路径，其他平台保留原路径。
pub(super) fn expand_native_candidate(path: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut candidates = Vec::new();
        if let Some(parent) = path.parent() {
            candidates.push(
                parent
                    .join("node_modules")
                    .join("cc-connect")
                    .join("bin")
                    .join("cc-connect.exe"),
            );
        }
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
        {
            candidates.insert(0, path.to_path_buf());
        }
        candidates
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![path.to_path_buf()]
    }
}

// 规范化并检查文件权限，摘要受信任后才执行版本探测。
pub(super) fn inspect_binary(path: &Path) -> Result<DetectedBinary, String> {
    if !path.is_file() {
        return Err("not a file".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("canonicalize failed: {err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if canonical
            .metadata()
            .map_err(|err| format!("read metadata failed: {err}"))?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err("file is not executable".to_string());
        }
    }
    let sha256 = sha256_file(&canonical)?;
    let Some(trusted_version) = trusted_binary_version(&sha256) else {
        return Ok(DetectedBinary {
            path: canonical,
            version: None,
            sha256,
            compatible: false,
        });
    };
    let mut command = silent_command(&path_string(&canonical));
    command.arg("--version");
    let output = output_with_timeout(command, VERSION_PROBE_TIMEOUT)
        .map_err(|err| format!("version probe failed: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "version probe exited with {}: {}",
            output.status,
            output_text(&output.stdout, &output.stderr)
        ));
    }
    let version_output = output_text(&output.stdout, &output.stderr);
    let (version, compatible) = parse_version(&version_output)
        .ok_or_else(|| format!("unrecognized version output: {version_output}"))?;
    let compatible = compatible && version == trusted_version;
    Ok(DetectedBinary {
        sha256,
        path: canonical,
        version: Some(version),
        compatible,
    })
}

// 查找内置固定摘要或更新信任记录对应的版本。
pub(super) fn trusted_binary_version(sha256: &str) -> Option<String> {
    if VERIFIED_V1_4_1_BINARY_SHA256
        .iter()
        .any(|expected| expected.eq_ignore_ascii_case(sha256))
    {
        return Some("1.4.1".to_string());
    }
    update::trusted_version_for_sha256(sha256).ok().flatten()
}

// 按共享编码检测解码输出，优先返回非空 stdout。
pub(super) fn output_text(stdout: &[u8], stderr: &[u8]) -> String {
    let decode = |bytes: &[u8]| {
        crate::text_encoding::decode_text(bytes)
            .map(|decoded| decoded.content)
            .unwrap_or_else(|_| String::from_utf8_lossy(bytes).into_owned())
            .trim()
            .to_string()
    };
    let stdout = decode(stdout);
    let stderr = decode(stderr);
    if stdout.is_empty() {
        stderr
    } else {
        stdout
    }
}

// 检查帮助文本同时声明 app-server、listen 和 stdio 支持。
pub(super) fn codex_app_server_help_supported(output: &str) -> bool {
    let normalized = output.to_ascii_lowercase();
    normalized.contains("codex app-server")
        && normalized.contains("--listen")
        && normalized.contains("stdio://")
}

// 限时运行本机 Codex 帮助以检查 app-server stdio 能力。
pub(super) fn probe_codex_app_server() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let command = {
        let mut command = silent_command("cmd.exe");
        command.args(["/d", "/s", "/c", "codex app-server --help"]);
        command
    };
    #[cfg(not(target_os = "windows"))]
    let command = {
        let mut command = silent_command("codex");
        command.args(["app-server", "--help"]);
        command
    };
    let output = output_with_timeout(command, CODEX_APP_SERVER_PROBE_TIMEOUT)
        .map_err(|err| format!("Codex app-server probe failed: {err}"))?;
    let help = output_text(&output.stdout, &output.stderr);
    if !output.status.success() {
        return Err(format!(
            "Codex app-server probe exited with {}: {}",
            output.status, help
        ));
    }
    if !codex_app_server_help_supported(&help) {
        return Err("installed Codex CLI does not support app-server stdio transport".to_string());
    }
    Ok(())
}

// 从输出中解析首个语义版本并判断兼容性。
pub(super) fn parse_version(output: &str) -> Option<(String, bool)> {
    let version = output.split_whitespace().find_map(|token| {
        let clean = token
            .trim_matches(|value: char| matches!(value, '(' | ')' | '[' | ']' | ',' | ';'))
            .trim_start_matches(['v', 'V']);
        semver::Version::parse(clean).ok()
    })?;
    let version = version.to_string();
    let compatible = update::is_compatible_version(&version);
    Some((version, compatible))
}

// 流式读取文件并计算大写 SHA-256 摘要。
pub(super) fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|err| format!("open executable failed: {err}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| format!("read executable failed: {err}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:X}", hasher.finalize()))
}
