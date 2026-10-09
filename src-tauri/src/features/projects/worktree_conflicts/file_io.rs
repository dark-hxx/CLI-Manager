use super::types::{Error, Result};
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}};

/// 使用内容指纹，不能以 mtime 代替 CAS 校验。
pub fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

/// UUID 等内部键只允许 ASCII 字母、数字及连字符，禁止用客户端键构造任意路径。
pub fn key(value: &str) -> Result<&str> {
    if value.is_empty() || value.len() > 128 || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(Error::new("path_invalid", "invalid opaque key"));
    }
    Ok(value)
}

/// 先做跨平台词法校验，阻止 Windows 设备名、ADS、路径穿越和 Git 元数据访问。
pub fn relative(path: &str) -> Result<()> {
    if path.is_empty() || path.contains(['\0', '\\', ':']) || path.starts_with('/') {
        return Err(Error::new("path_invalid", "invalid repository relative path"));
    }
    for part in path.split('/') {
        let upper = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let device = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
            || ((upper.starts_with("COM") || upper.starts_with("LPT")) && upper.len() == 4 && matches!(upper.as_bytes()[3], b'1'..=b'9'));
        if part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git")
            || part.ends_with(['.', ' ']) || part.chars().any(|c| c < ' ' || "<>|?*".contains(c)) || device {
            return Err(Error::new("path_invalid", "unsafe path component"));
        }
    }
    Ok(())
}

/// Windows junction/reparse 和符号链接均拒绝，不跟随到仓库外。
fn unsafe_metadata(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; metadata.file_attributes() & 0x400 != 0 || metadata.file_type().is_symlink() }
    #[cfg(not(windows))]
    { metadata.file_type().is_symlink() }
}

/// 即使目标已删除，也检查最近存在父目录；逐级验证后只返回仓库内路径。
pub fn safe_path(root: &Path, relative_path: &str) -> Result<PathBuf> {
    relative(relative_path)?;
    if unsafe_metadata(&fs::symlink_metadata(root)?) { return Err(Error::new("path_invalid", "unsafe root")); }
    let canonical_root = root.canonicalize()?;
    let mut cursor = canonical_root.clone();
    for part in relative_path.split('/') {
        cursor.push(part);
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) => {
                if unsafe_metadata(&metadata) || !cursor.canonicalize()?.starts_with(&canonical_root) { return Err(Error::new("path_invalid", "reparse or escaped path")); }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(cursor)
}

/// 最多读取 limit+1 字节，大小变化或超限不返回可编辑截断内容。
pub fn bounded(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let file = File::open(path)?;
    if file.metadata()?.len() > limit as u64 { return Err(Error::new("limit_exceeded", "file byte limit")); }
    let mut result = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut result)?;
    if result.len() > limit { return Err(Error::new("limit_exceeded", "file byte limit")); }
    Ok(result)
}

/// 流式指纹不把大二进制文件带入 IPC 或内存缓存。
pub fn fingerprint(path: &Path) -> Result<String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok("missing".into()),
        Err(e) => return Err(e.into()),
    };
    let mut digest = Sha256::new();
    let mut bytes = [0u8; 64 * 1024];
    loop { let n = file.read(&mut bytes)?; if n == 0 { break; } digest.update(&bytes[..n]); }
    Ok(format!("{:x}", digest.finalize()))
}

/// 同目录临时文件 flush+sync 后替换；失败时保留旧文件，不执行删旧再改名。
pub fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(|| Error::new("path_invalid", "missing parent"))?;
    let temporary = parent.join(format!(".cli-manager-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new().create_new(true).write(true).open(&temporary)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

/// JSON 编码后的字节数独立受限，转义膨胀不能越过传输预算。
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > super::parser::MAX_JSON_BYTES { return Err(Error::new("limit_exceeded", "serialized JSON limit")); }
    atomic(path, &bytes)
}

/// 持久化记录的缺失由调用者判断，损坏不能静默当成默认值。
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    Ok(serde_json::from_slice(&bounded(path, super::parser::MAX_JSON_BYTES)?)?)
}
