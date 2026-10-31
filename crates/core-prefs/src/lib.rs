use serde::{de::DeserializeOwned, Serialize};
pub mod settings;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

static FILE_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

#[derive(Debug, Clone, Copy)]
pub struct PrefsFile(&'static str);

impl PrefsFile {
    pub const SETTINGS: Self = Self("settings.json");

    /// 仅接受文件名，拒绝越过偏好根目录的路径。
    pub fn new(name: &'static str) -> io::Result<Self> {
        if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '\0']) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid preferences filename",
            ));
        }
        Ok(Self(name))
    }
}

#[derive(Debug, Clone)]
pub struct PrefsStore {
    root: PathBuf,
}

impl PrefsStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn path(&self, file: PrefsFile) -> PathBuf {
        self.root.join(file.0)
    }

    pub fn load<T>(&self, file: PrefsFile) -> io::Result<T>
    where
        T: DeserializeOwned + Default,
    {
        let path = self.path(file);
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(T::default()),
            Err(error) => return Err(error),
        };
        serde_json::from_slice(&bytes)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    /// 在文件锁内读改写，避免同一进程中的设置更新互相覆盖。
    pub fn update<T, F>(&self, file: PrefsFile, update: F) -> io::Result<()>
    where
        T: DeserializeOwned + Serialize + Default,
        F: FnOnce(&mut T),
    {
        fs::create_dir_all(&self.root)?;
        let root = self.root.canonicalize()?;
        let path = root.join(file.0);
        let lock = file_lock(&path)?;
        let _guard = lock
            .lock()
            .map_err(|_| io::Error::other("preferences lock poisoned"))?;
        // std 文件锁在进程退出或文件句柄释放时自动解除，不保存任何设置内容。
        let process_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join(format!("{}.lock", file.0)))?;
        process_lock.lock()?;
        let mut value = self.load(file)?;
        update(&mut value);
        self.write_locked(&path, &value)
    }

    fn write_locked<T: Serialize>(&self, path: &Path, value: &T) -> io::Result<()> {
        fs::create_dir_all(&self.root)?;
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)?;
        serde_json::to_writer_pretty(temporary.as_file_mut(), value)
            .map_err(|error| io::Error::other(error.to_string()))?;
        temporary.as_file_mut().write_all(b"\n")?;
        temporary.as_file_mut().sync_all()?;
        temporary.persist(path).map_err(|error| error.error)?;
        sync_directory(&self.root)
    }
}

fn file_lock(path: &Path) -> io::Result<Arc<Mutex<()>>> {
    let locks = FILE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .map_err(|_| io::Error::other("preferences locks poisoned"))?;
    Ok(locks
        .entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    std::fs::File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use tempfile::tempdir;

    #[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
    struct Settings {
        language: String,
        #[serde(flatten)]
        extra: serde_json::Map<String, serde_json::Value>,
    }

    #[test]
    fn missing_file_uses_default_and_unknown_fields_round_trip() {
        let directory = tempdir().unwrap();
        let store = PrefsStore::new(directory.path());
        assert_eq!(
            store.load::<Settings>(PrefsFile::SETTINGS).unwrap(),
            Settings::default()
        );
        store
            .update::<Settings, _>(PrefsFile::SETTINGS, |settings| {
                settings.language = "zh-CN".into();
                settings.extra.insert("futureFlag".into(), true.into());
            })
            .unwrap();
        assert_eq!(
            store.load::<Settings>(PrefsFile::SETTINGS).unwrap().extra["futureFlag"],
            true
        );
        let text = fs::read_to_string(store.path(PrefsFile::SETTINGS)).unwrap();
        assert!(text.ends_with("\n"));
    }

    #[test]
    fn rejects_unsafe_names_and_preserves_corrupt_files() {
        for name in ["", ".", "..", "../settings.json", "C:settings.json", "a\\b"] {
            assert!(PrefsFile::new(name).is_err());
        }
        let directory = tempdir().unwrap();
        let store = PrefsStore::new(directory.path());
        fs::write(store.path(PrefsFile::SETTINGS), "broken json").unwrap();
        assert_eq!(
            store
                .update::<Settings, _>(PrefsFile::SETTINGS, |_| {})
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            fs::read_to_string(store.path(PrefsFile::SETTINGS)).unwrap(),
            "broken json"
        );
    }

    #[test]
    fn update_is_atomic_and_serializes_same_file_updates() {
        let directory = tempdir().unwrap();
        let store = Arc::new(PrefsStore::new(directory.path()));
        let mut threads = Vec::new();
        for _ in 0..8 {
            let store = store.clone();
            threads.push(std::thread::spawn(move || {
                store
                    .update::<Settings, _>(PrefsFile::SETTINGS, |settings| {
                        settings.language.push('x');
                    })
                    .unwrap();
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(
            store
                .load::<Settings>(PrefsFile::SETTINGS)
                .unwrap()
                .language
                .len(),
            8
        );
    }

    #[test]
    fn child_process_update() {
        let Some(root) = std::env::var_os("CLI_MANAGER_PREFS_TEST_ROOT") else {
            return;
        };
        let store = PrefsStore::new(root);
        for _ in 0..10 {
            store
                .update::<Settings, _>(PrefsFile::SETTINGS, |settings| {
                    settings.language.push('x');
                    std::thread::sleep(std::time::Duration::from_millis(2));
                })
                .unwrap();
        }
    }

    #[test]
    fn separate_process_updates_do_not_lose_fields() {
        let directory = tempdir().unwrap();
        let mut children = Vec::new();
        for _ in 0..3 {
            children.push(
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "tests::child_process_update", "--test-threads=1"])
                    .env("CLI_MANAGER_PREFS_TEST_ROOT", directory.path())
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .unwrap(),
            );
        }
        for mut child in children {
            assert!(child.wait().unwrap().success());
        }
        let store = PrefsStore::new(directory.path());
        assert_eq!(
            store
                .load::<Settings>(PrefsFile::SETTINGS)
                .unwrap()
                .language
                .len(),
            30
        );
    }
}
