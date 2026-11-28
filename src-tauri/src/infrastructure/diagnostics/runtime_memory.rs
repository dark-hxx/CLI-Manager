use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeMemorySnapshot {
    sampled_at_ms: u64,
    status: SampleStatus,
    system: Option<SystemCommitMemory>,
    process: Option<ProcessMemory>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SampleStatus {
    Available,
    Unavailable,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemCommitMemory {
    committed_bytes: u64,
    limit_bytes: u64,
    available_bytes: u64,
    peak_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessMemory {
    pid: u32,
    private_commit_bytes: u64,
    working_set_bytes: u64,
}

/// 系统提交（commit）用量与上限（物理内存 + 页面文件），单位字节。
/// 提交耗尽时新的内存分配直接失败，WebView2 等进程会因此崩溃，与物理内存占用率无关。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SystemCommit {
    pub committed_bytes: u64,
    pub limit_bytes: u64,
}

impl SystemCommit {
    pub fn available_bytes(&self) -> u64 {
        self.limit_bytes.saturating_sub(self.committed_bytes)
    }
}

// 只读一次系统性能计数器，不枚举进程；平台不支持或调用失败时返回 None。
pub(crate) fn system_commit() -> Option<SystemCommit> {
    platform_system_commit().map(|memory| SystemCommit {
        committed_bytes: memory.committed_bytes,
        limit_bytes: memory.limit_bytes,
    })
}

// Sample numeric native counters only. No process enumeration, command lines or frontend dependency.
pub(super) fn sample() -> NativeMemorySnapshot {
    let sampled_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0);
    let (system, process) = platform_sample();
    NativeMemorySnapshot {
        sampled_at_ms,
        status: if !cfg!(target_os = "windows") {
            SampleStatus::Unsupported
        } else if system.is_some() || process.is_some() {
            SampleStatus::Available
        } else {
            SampleStatus::Unavailable
        },
        system,
        process,
    }
}

// Windows performance counters are pages, not bytes or physical RAM usage.
#[cfg(any(target_os = "windows", test))]
fn commit_from_pages(
    total: usize,
    limit: usize,
    peak: usize,
    page_size: usize,
) -> Option<SystemCommitMemory> {
    if page_size == 0 {
        return None;
    }
    let bytes = |pages: usize| {
        u64::try_from(pages)
            .ok()?
            .checked_mul(u64::try_from(page_size).ok()?)
    };
    let committed_bytes = bytes(total)?;
    let limit_bytes = bytes(limit)?;
    Some(SystemCommitMemory {
        committed_bytes,
        limit_bytes,
        available_bytes: limit_bytes.saturating_sub(committed_bytes),
        peak_bytes: bytes(peak)?,
    })
}

#[cfg(target_os = "windows")]
fn platform_system_commit() -> Option<SystemCommitMemory> {
    use std::mem::size_of;
    use windows_sys::Win32::System::ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION};
    let mut performance = PERFORMANCE_INFORMATION::default();
    performance.cb = size_of::<PERFORMANCE_INFORMATION>() as u32;
    // The buffer is an initialized repr(C) struct that lives throughout the native call.
    unsafe { GetPerformanceInfo(&mut performance, performance.cb) != 0 }
        .then(|| {
            commit_from_pages(
                performance.CommitTotal,
                performance.CommitLimit,
                performance.CommitPeak,
                performance.PageSize,
            )
        })
        .flatten()
}

#[cfg(not(target_os = "windows"))]
fn platform_system_commit() -> Option<SystemCommitMemory> {
    None
}

#[cfg(target_os = "windows")]
fn platform_sample() -> (Option<SystemCommitMemory>, Option<ProcessMemory>) {
    use std::mem::size_of;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
    counters.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
    // The buffer is an initialized repr(C) struct that lives throughout the native call.
    // EX begins with PROCESS_MEMORY_COUNTERS; cb requests the extended PrivateUsage field.
    let system = platform_system_commit();
    let process = unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(),
            counters.cb,
        ) != 0
    }
    .then_some(ProcessMemory {
        pid: std::process::id(),
        private_commit_bytes: counters.PrivateUsage as u64,
        working_set_bytes: counters.WorkingSetSize as u64,
    });
    (system, process)
}

#[cfg(not(target_os = "windows"))]
fn platform_sample() -> (Option<SystemCommitMemory>, Option<ProcessMemory>) {
    (None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_units_and_exhaustion_are_not_physical_ram() {
        let sample = commit_from_pages(100, 128, 110, 4096).unwrap();
        assert_eq!(sample.committed_bytes, 409_600);
        assert_eq!(sample.limit_bytes, 524_288);
        assert_eq!(sample.available_bytes, 114_688);
        assert_eq!(sample.peak_bytes, 450_560);
        assert_eq!(
            commit_from_pages(129, 128, 129, 4096)
                .unwrap()
                .available_bytes,
            0
        );
    }

    #[test]
    fn invalid_or_overflowed_counters_are_unavailable_not_zero() {
        assert!(commit_from_pages(1, 2, 1, 0).is_none());
        #[cfg(target_pointer_width = "64")]
        assert!(commit_from_pages(usize::MAX, usize::MAX, usize::MAX, usize::MAX).is_none());
    }

    #[test]
    fn failure_records_have_no_fabricated_memory_values() {
        let record = NativeMemorySnapshot {
            sampled_at_ms: 42,
            status: SampleStatus::Unavailable,
            system: None,
            process: None,
        };
        let value = serde_json::to_value(record).unwrap();
        assert_eq!(value["status"], "unavailable");
        assert!(value["system"].is_null());
        assert!(value["process"].is_null());
    }
}
