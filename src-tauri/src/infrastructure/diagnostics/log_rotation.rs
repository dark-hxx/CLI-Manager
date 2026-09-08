use chrono::{Duration, Local, NaiveDate};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const LOG_MAX_SIZE_BYTES: u64 = 10 * 1024 * 1024;
const LOG_RETENTION_DAYS: i64 = 7;

// 使用 10 MiB 滚动阈值和七个日历日归档保留期创建写入器，会创建目录并清理过期归档。
pub fn create_log_writer(dir: PathBuf, file_name: &str) -> io::Result<DailyRollingLogWriter> {
    DailyRollingLogWriter::new(
        dir,
        file_name.to_string(),
        LOG_MAX_SIZE_BYTES,
        LOG_RETENTION_DAYS,
    )
}

pub struct DailyRollingLogWriter {
    dir: PathBuf,
    active_path: PathBuf,
    archive_prefix: String,
    max_size: u64,
    retention_days: i64,
    current_size: u64,
    file: Option<File>,
}

impl DailyRollingLogWriter {
    // 初始化目录、清理归档并追加打开活动日志；已有文件达到阈值时立即滚动，保留期至少一天。
    fn new(
        dir: PathBuf,
        active_file_name: String,
        max_size: u64,
        retention_days: i64,
    ) -> io::Result<Self> {
        fs::create_dir_all(&dir)?;
        let active_path = dir.join(&active_file_name);
        let archive_prefix = archive_prefix(&active_file_name);
        let mut writer = Self {
            dir,
            active_path,
            archive_prefix,
            max_size,
            retention_days: retention_days.max(1),
            current_size: 0,
            file: None,
        };
        writer.cleanup_expired_archives()?;
        writer.open_file()?;
        if writer.current_size >= writer.max_size {
            writer.rotate()?;
        }
        Ok(writer)
    }

    // 追加打开或创建活动文件，并从元数据刷新当前大小，不截断已有日志。
    fn open_file(&mut self) -> io::Result<()> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.active_path)?;
        self.current_size = file.metadata()?.len();
        self.file = Some(file);
        Ok(())
    }

    // 刷新并释放当前句柄，将活动文件重命名为当天归档，再清理过期项并重开活动文件。
    fn rotate(&mut self) -> io::Result<()> {
        if let Some(mut file) = self.file.take() {
            file.flush()?;
        }
        if self.active_path.exists() {
            let date = Local::now().date_naive();
            let archive_path = self.next_archive_path(date)?;
            fs::rename(&self.active_path, archive_path)?;
        }
        self.cleanup_expired_archives()?;
        self.open_file()
    }

    // 扫描同前缀、同日期归档，以最大序号加一生成路径；不预留文件或提供跨进程互斥。
    fn next_archive_path(&self, date: NaiveDate) -> io::Result<PathBuf> {
        let mut next_index = 1;
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if let Some((archive_date, index)) =
                parse_archive_file_name(&file_name, &self.archive_prefix)
            {
                if archive_date == date {
                    next_index = next_index.max(index + 1);
                }
            }
        }
        Ok(self.dir.join(format_archive_file_name(
            &self.archive_prefix,
            date,
            next_index,
        )))
    }

    // 以本地当天为保留窗口终点执行归档清理，不按文件修改时间计算。
    fn cleanup_expired_archives(&self) -> io::Result<()> {
        self.cleanup_expired_archives_for_date(Local::now().date_naive())
    }

    // 删除名称日期早于保留窗口的同前缀归档；忽略单文件删除失败，目录枚举失败向上传播。
    fn cleanup_expired_archives_for_date(&self, today: NaiveDate) -> io::Result<()> {
        let cutoff = today - Duration::days(self.retention_days - 1);
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if let Some((archive_date, _)) =
                parse_archive_file_name(&file_name, &self.archive_prefix)
            {
                if archive_date < cutoff {
                    let _ = fs::remove_file(path);
                }
            }
        }
        Ok(())
    }
}

impl Write for DailyRollingLogWriter {
    // 整块写入前按预计大小滚动非空文件；单块超过阈值也不拆分，因此阈值不是硬大小上限。
    // 日期只用于归档命名，此方法不会单凭跨日主动滚动。
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.file.is_none() {
            self.open_file()?;
        }
        if self.current_size > 0 && self.current_size + buf.len() as u64 > self.max_size {
            self.rotate()?;
        }
        if let Some(file) = self.file.as_mut() {
            file.write_all(buf)?;
            self.current_size += buf.len() as u64;
        }
        Ok(buf.len())
    }

    // 刷新已有文件句柄；没有活动句柄时无操作，不执行磁盘 sync_data。
    fn flush(&mut self) -> io::Result<()> {
        if let Some(file) = self.file.as_mut() {
            file.flush()?;
        }
        Ok(())
    }
}

// 优先取文件名去扩展名后的非空 UTF-8 名称作为归档前缀，否则保留传入文本。
fn archive_prefix(file_name: &str) -> String {
    Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(file_name)
        .to_string()
}

// 生成前缀-年月日-序号.log，序号至少两位而非限制为两位。
fn format_archive_file_name(prefix: &str, date: NaiveDate, index: u32) -> String {
    format!("{}-{}-{index:02}.log", prefix, date.format("%Y%m%d"))
}

// 解析匹配前缀和 .log 后缀的日期与无符号序号，无效格式或日期返回 None。
fn parse_archive_file_name(file_name: &str, prefix: &str) -> Option<(NaiveDate, u32)> {
    let archive_part = file_name
        .strip_prefix(prefix)?
        .strip_prefix('-')?
        .strip_suffix(".log")?;
    let (date_part, index_part) = archive_part.split_once('-')?;
    if date_part.len() != 8 || index_part.is_empty() {
        return None;
    }
    let date = NaiveDate::parse_from_str(date_part, "%Y%m%d").ok()?;
    let index = index_part.parse::<u32>().ok()?;
    Some((date, index))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // 验证归档名称格式及日期、序号的反向解析。
    fn archive_name_uses_date_and_daily_index() {
        let date = NaiveDate::from_ymd_opt(2026, 7, 2).unwrap();

        assert_eq!(
            format_archive_file_name("cli-manager", date, 1),
            "cli-manager-20260702-01.log"
        );
        assert_eq!(
            parse_archive_file_name("cli-manager-20260702-12.log", "cli-manager"),
            Some((date, 12))
        );
    }

    #[test]
    // 验证序号只累加当天匹配归档，另一日期从 1 开始。
    fn next_archive_index_resets_by_date() {
        let dir = tempfile::tempdir().unwrap();
        let today = Local::now().date_naive();
        let yesterday = today - Duration::days(1);
        fs::write(
            dir.path()
                .join(format_archive_file_name("cli-manager", yesterday, 3)),
            "",
        )
        .unwrap();
        fs::write(
            dir.path()
                .join(format_archive_file_name("cli-manager", today, 1)),
            "",
        )
        .unwrap();
        let writer = DailyRollingLogWriter::new(
            dir.path().to_path_buf(),
            "cli-manager.log".to_string(),
            10,
            LOG_RETENTION_DAYS,
        )
        .unwrap();

        assert_eq!(
            writer
                .next_archive_path(today)
                .unwrap()
                .file_name()
                .unwrap()
                .to_string_lossy(),
            format_archive_file_name("cli-manager", today, 2)
        );
        let tomorrow = today + Duration::days(1);
        assert_eq!(
            writer
                .next_archive_path(tomorrow)
                .unwrap()
                .file_name()
                .unwrap()
                .to_string_lossy(),
            format_archive_file_name("cli-manager", tomorrow, 1)
        );
    }

    #[test]
    // 验证七日保留窗口包含当天及前六天，更早归档被删除。
    fn cleanup_keeps_recent_seven_calendar_days() {
        let dir = tempfile::tempdir().unwrap();
        let today = Local::now().date_naive();
        let expired = today - Duration::days(LOG_RETENTION_DAYS);
        let kept = today - Duration::days(LOG_RETENTION_DAYS - 1);
        let expired_file_name = format_archive_file_name("cli-manager", expired, 1);
        let kept_file_name = format_archive_file_name("cli-manager", kept, 1);
        fs::write(dir.path().join(&expired_file_name), "old").unwrap();
        fs::write(dir.path().join(&kept_file_name), "kept").unwrap();
        let writer = DailyRollingLogWriter::new(
            dir.path().to_path_buf(),
            "cli-manager.log".to_string(),
            10,
            LOG_RETENTION_DAYS,
        )
        .unwrap();

        writer.cleanup_expired_archives_for_date(today).unwrap();

        assert!(!dir.path().join(expired_file_name).exists());
        assert!(dir.path().join(kept_file_name).exists());
    }
}
