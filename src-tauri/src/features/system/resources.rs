#[cfg(target_os = "windows")]
use base64::{engine::general_purpose, Engine as _};
use chrono::{Local, NaiveDate};
use local_ip_address::local_ip;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(target_os = "windows")]
use std::{ffi::c_void, mem::size_of, os::windows::ffi::OsStrExt, ptr, slice};
use sysinfo::{
    CpuRefreshKind, Disks, Networks, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind,
    System, UpdateKind,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, HICON};

const TOP_PROCESS_LIMIT: usize = 5;
const EXPENSIVE_REFRESH_INTERVAL: Duration = Duration::from_secs(8);
const PROCESS_PRESENTATION_CACHE_LIMIT: usize = 96;
#[cfg(target_os = "windows")]
const PROCESS_ICON_SIZE: i32 = 16;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemResourceSnapshotOptions {
    full_detail: Option<bool>,
    system: Option<bool>,
    cpu: Option<bool>,
    memory: Option<bool>,
    network: Option<bool>,
    disk: Option<bool>,
    gpu: Option<bool>,
    processes: Option<bool>,
}

#[derive(Clone, Copy)]
struct SamplingOptions {
    system: bool,
    cpu: bool,
    memory: bool,
    network: bool,
    disk: bool,
    gpu: bool,
    processes: bool,
}

impl SamplingOptions {
    // 字段级选项优先；嵌套 fullDetail 覆盖旧参数，基础项默认开启，额外项默认跟随 fullDetail。
    fn from_args(
        full_detail: Option<bool>,
        options: Option<SystemResourceSnapshotOptions>,
    ) -> Self {
        let full_detail = options
            .as_ref()
            .and_then(|value| value.full_detail)
            .or(full_detail)
            .unwrap_or(true);
        let default_extra = full_detail;
        let default_core = true;
        let options = options.as_ref();

        Self {
            system: options
                .and_then(|value| value.system)
                .unwrap_or(default_core),
            cpu: options.and_then(|value| value.cpu).unwrap_or(default_core),
            memory: options
                .and_then(|value| value.memory)
                .unwrap_or(default_core),
            network: options
                .and_then(|value| value.network)
                .unwrap_or(default_extra),
            disk: options
                .and_then(|value| value.disk)
                .unwrap_or(default_extra),
            gpu: options.and_then(|value| value.gpu).unwrap_or(default_extra),
            processes: options
                .and_then(|value| value.processes)
                .unwrap_or(default_extra),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemResourceSnapshot {
    ip_address: Option<String>,
    os_name: String,
    host_name: Option<String>,
    uptime_seconds: u64,
    sampled_at: u64,
    cpu: CpuSnapshot,
    cpu_cores: Vec<CpuCoreSnapshot>,
    gpu: Option<GpuSnapshot>,
    memory: MemorySnapshot,
    network: NetworkSnapshot,
    disks: Vec<DiskSnapshot>,
    top_processes: Vec<ProcessSnapshot>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CpuSnapshot {
    usage_percent: f32,
    physical_core_count: usize,
    logical_processor_count: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CpuCoreSnapshot {
    index: usize,
    usage_percent: f32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GpuSnapshot {
    usage_percent: f32,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    total_bytes: u64,
    used_bytes: u64,
    available_bytes: u64,
    cached_bytes: u64,
    free_bytes: u64,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSnapshot {
    upload_bytes_per_sec: u64,
    download_bytes_per_sec: u64,
    total_uploaded_bytes: u64,
    total_downloaded_bytes: u64,
    today_uploaded_bytes: u64,
    today_downloaded_bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiskSnapshot {
    name: String,
    mount_point: String,
    file_system: String,
    total_bytes: u64,
    available_bytes: u64,
    used_bytes: u64,
    read_bytes_per_sec: u64,
    write_bytes_per_sec: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshot {
    pid: String,
    name: String,
    command: String,
    display_name: Option<String>,
    icon_data_url: Option<String>,
    cpu_usage_percent: f32,
    memory_bytes: u64,
    memory_usage_percent: f32,
}

#[derive(Clone, Default)]
struct ProcessPresentation {
    display_name: Option<String>,
    icon_data_url: Option<String>,
}

struct ResourceCollector {
    system: System,
    networks: Networks,
    disks: Disks,
    gpu: Option<GpuCollector>,
    memory: MemoryCollector,
    cached_ip_address: Option<String>,
    cached_network: NetworkSnapshot,
    network_daily_baseline: Option<NetworkDailyBaseline>,
    cached_disks: Vec<DiskSnapshot>,
    cached_gpu: Option<GpuSnapshot>,
    cached_top_processes: Vec<ProcessSnapshot>,
    process_presentation_cache: HashMap<String, ProcessPresentation>,
    last_system_refresh: Option<Instant>,
    last_network_refresh: Option<Instant>,
    last_disk_refresh: Option<Instant>,
    last_gpu_refresh: Option<Instant>,
    last_process_refresh: Option<Instant>,
}

impl ResourceCollector {
    // 初始化 CPU/平台内存采样器及空缓存，网络/磁盘列表和 GPU 查询随后按需加载。
    fn new() -> Self {
        Self {
            system: System::new_with_specifics(
                RefreshKind::nothing().with_cpu(CpuRefreshKind::everything()),
            ),
            networks: Networks::new(),
            disks: Disks::new(),
            gpu: None,
            memory: MemoryCollector::new(),
            cached_ip_address: None,
            cached_network: NetworkSnapshot::default(),
            network_daily_baseline: None,
            cached_disks: Vec::new(),
            cached_gpu: None,
            cached_top_processes: Vec::new(),
            process_presentation_cache: HashMap::new(),
            last_system_refresh: None,
            last_network_refresh: None,
            last_disk_refresh: None,
            last_gpu_refresh: None,
            last_process_refresh: None,
        }
    }

    // 按选项刷新 CPU/内存，其余昂贵项按独立时钟复用缓存；关闭项返回空值但不清除旧缓存。
    // 保留物理核与逻辑线程区分；进程排行会额外读取前五项命令行/程序路径，不能用作脱敏日志。
    fn snapshot(&mut self, options: SamplingOptions) -> SystemResourceSnapshot {
        if options.cpu {
            self.system.refresh_cpu_usage();
        }
        if options.memory {
            self.system.refresh_memory();
        }

        let now = Instant::now();
        if options.system && self.should_refresh_system(now) {
            self.cached_ip_address = local_ip().ok().map(|ip| ip.to_string());
            self.last_system_refresh = Some(now);
        }
        if options.processes && self.should_refresh_processes(now) {
            self.system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing()
                    .with_memory()
                    .with_cpu()
                    .without_tasks(),
            );
            let top_pids = collect_top_process_pids(&self.system);
            if !top_pids.is_empty() {
                self.system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&top_pids),
                    false,
                    ProcessRefreshKind::nothing()
                        .with_cmd(UpdateKind::OnlyIfNotSet)
                        .with_exe(UpdateKind::OnlyIfNotSet)
                        .without_tasks(),
                );
            }
            self.cached_top_processes = collect_top_processes(
                &self.system,
                &top_pids,
                &mut self.process_presentation_cache,
            );
            self.last_process_refresh = Some(now);
        }
        if options.disk && self.should_refresh_disks(now) {
            let elapsed_secs = self
                .last_disk_refresh
                .map(|last| now.duration_since(last).as_secs_f64().max(0.001))
                .unwrap_or(0.001);
            self.disks.refresh(self.disks.list().is_empty());
            self.cached_disks = collect_disks(&self.disks, elapsed_secs);
            self.last_disk_refresh = Some(now);
        }
        if options.network && self.should_refresh_network(now) {
            self.cached_network = self.sample_network(now);
        }
        if options.gpu && self.should_refresh_gpu(now) {
            self.cached_gpu = self.gpu.get_or_insert_with(GpuCollector::new).sample();
            self.last_gpu_refresh = Some(now);
        }

        let cpu_cores = if options.cpu {
            self.system
                .cpus()
                .iter()
                .enumerate()
                .map(|(index, cpu)| CpuCoreSnapshot {
                    index: index + 1,
                    usage_percent: clamp_percent(cpu.cpu_usage()),
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        let logical_processor_count = self.system.cpus().len();
        let physical_core_count = System::physical_core_count()
            .filter(|count| *count > 0)
            .unwrap_or(logical_processor_count);

        SystemResourceSnapshot {
            ip_address: if options.system {
                self.cached_ip_address.clone()
            } else {
                None
            },
            os_name: System::long_os_version()
                .or_else(System::name)
                .unwrap_or_else(|| "Unknown".to_string()),
            host_name: System::host_name(),
            uptime_seconds: System::uptime(),
            sampled_at: current_epoch_millis(),
            cpu: CpuSnapshot {
                usage_percent: if options.cpu {
                    clamp_percent(self.system.global_cpu_usage())
                } else {
                    0.0
                },
                physical_core_count,
                logical_processor_count,
            },
            cpu_cores,
            gpu: if options.gpu {
                self.cached_gpu.clone()
            } else {
                None
            },
            memory: if options.memory {
                self.memory.sample(&self.system)
            } else {
                MemorySnapshot::default()
            },
            network: if options.network {
                self.cached_network.clone()
            } else {
                NetworkSnapshot::default()
            },
            disks: if options.disk {
                self.cached_disks.clone()
            } else {
                Vec::new()
            },
            top_processes: if options.processes {
                self.cached_top_processes.clone()
            } else {
                Vec::new()
            },
        }
    }

    // 以八秒公共间隔限制本机 IP 的再次探测，首次允许刷新。
    fn should_refresh_system(&self, now: Instant) -> bool {
        should_refresh(self.last_system_refresh, now)
    }

    // 网络使用独立的一秒刷新间隔，未采样过时立即刷新。
    fn should_refresh_network(&self, now: Instant) -> bool {
        self.last_network_refresh
            .map(|last| now.duration_since(last) >= Duration::from_secs(1))
            .unwrap_or(true)
    }

    // 磁盘缓存为空时立即重试，否则遵循八秒昂贵采样间隔。
    fn should_refresh_disks(&self, now: Instant) -> bool {
        self.cached_disks.is_empty() || should_refresh(self.last_disk_refresh, now)
    }

    // GPU 查询按八秒间隔刷新，即使上次没有采到值也等待此间隔。
    fn should_refresh_gpu(&self, now: Instant) -> bool {
        should_refresh(self.last_gpu_refresh, now)
    }

    // 进程排行榜为空时立即重采，否则复用八秒内缓存。
    fn should_refresh_processes(&self, now: Instant) -> bool {
        self.cached_top_processes.is_empty() || should_refresh(self.last_process_refresh, now)
    }

    // 刷新网络接口并饱和汇总传输计数，以实际间隔换算速率；首轮速率为零，同时建立日内基线。
    fn sample_network(&mut self, now: Instant) -> NetworkSnapshot {
        let previous_refresh = self.last_network_refresh;
        let elapsed_secs = now
            .duration_since(previous_refresh.unwrap_or(now))
            .as_secs_f64()
            .max(0.001);

        self.networks.refresh(true);
        self.last_network_refresh = Some(now);

        let mut received = 0_u64;
        let mut transmitted = 0_u64;
        let mut total_received = 0_u64;
        let mut total_transmitted = 0_u64;
        for (_, data) in &self.networks {
            received = received.saturating_add(data.received());
            transmitted = transmitted.saturating_add(data.transmitted());
            total_received = total_received.saturating_add(data.total_received());
            total_transmitted = total_transmitted.saturating_add(data.total_transmitted());
        }
        let (today_uploaded_bytes, today_downloaded_bytes) =
            self.today_network_totals(total_transmitted, total_received);

        NetworkSnapshot {
            upload_bytes_per_sec: previous_refresh
                .map(|_| bytes_per_second(transmitted, elapsed_secs))
                .unwrap_or(0),
            download_bytes_per_sec: previous_refresh
                .map(|_| bytes_per_second(received, elapsed_secs))
                .unwrap_or(0),
            total_uploaded_bytes: total_transmitted,
            total_downloaded_bytes: total_received,
            today_uploaded_bytes,
            today_downloaded_bytes,
        }
    }

    // 以本地日历日期更新当前采集器的网络累计基线，仅保存在内存，不恢复应用启动前流量。
    fn today_network_totals(
        &mut self,
        total_uploaded_bytes: u64,
        total_downloaded_bytes: u64,
    ) -> (u64, u64) {
        network_daily_totals(
            &mut self.network_daily_baseline,
            Local::now().date_naive(),
            total_uploaded_bytes,
            total_downloaded_bytes,
        )
    }
}

#[derive(Clone, Copy)]
struct NetworkDailyBaseline {
    day: NaiveDate,
    total_uploaded_bytes: u64,
    total_downloaded_bytes: u64,
}

// 返回相对日内基线的收发增量；首次、跨日或任一计数低于基线时同时重置两项基线。
fn network_daily_totals(
    baseline: &mut Option<NetworkDailyBaseline>,
    day: NaiveDate,
    total_uploaded_bytes: u64,
    total_downloaded_bytes: u64,
) -> (u64, u64) {
    let baseline_value = match *baseline {
        Some(value)
            if value.day == day
                && total_uploaded_bytes >= value.total_uploaded_bytes
                && total_downloaded_bytes >= value.total_downloaded_bytes =>
        {
            value
        }
        _ => {
            let value = NetworkDailyBaseline {
                day,
                total_uploaded_bytes,
                total_downloaded_bytes,
            };
            *baseline = Some(value);
            value
        }
    };

    (
        total_uploaded_bytes.saturating_sub(baseline_value.total_uploaded_bytes),
        total_downloaded_bytes.saturating_sub(baseline_value.total_downloaded_bytes),
    )
}

// 判断首次或距上次采样至少八秒；调用方应传入不早于上次刷新的单调时间。
fn should_refresh(last_refresh: Option<Instant>, now: Instant) -> bool {
    last_refresh
        .map(|last| now.duration_since(last) >= EXPENSIVE_REFRESH_INTERVAL)
        .unwrap_or(true)
}

// 从已刷新磁盘列表生成容量与 IO 速率快照，不另行刷新设备；已用空间采用饱和减法。
fn collect_disks(disks: &Disks, elapsed_secs: f64) -> Vec<DiskSnapshot> {
    disks
        .iter()
        .map(|disk| {
            let total = disk.total_space();
            let available = disk.available_space();
            let usage = disk.usage();
            DiskSnapshot {
                name: disk.name().to_string_lossy().to_string(),
                mount_point: disk.mount_point().to_string_lossy().to_string(),
                file_system: disk.file_system().to_string_lossy().to_string(),
                total_bytes: total,
                available_bytes: available,
                used_bytes: total.saturating_sub(available),
                read_bytes_per_sec: bytes_per_second(usage.read_bytes, elapsed_secs),
                write_bytes_per_sec: bytes_per_second(usage.written_bytes, elapsed_secs),
            }
        })
        .collect()
}

// 对系统快照全部进程按 CPU 降序、内存次序排序取前五 PID，不限定本应用进程树。
fn collect_top_process_pids(system: &System) -> Vec<Pid> {
    let mut processes = system
        .processes()
        .iter()
        .map(|(pid, process)| (*pid, process))
        .collect::<Vec<_>>();

    processes.sort_by(|(_, a), (_, b)| {
        b.cpu_usage()
            .partial_cmp(&a.cpu_usage())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.memory().cmp(&a.memory()))
    });

    processes
        .into_iter()
        .take(TOP_PROCESS_LIMIT)
        .map(|(pid, _)| pid)
        .collect()
}

// 按给定 PID 顺序构造展示行，拼接命令行并补充缓存图标/名称；已消失进程跳过，数据未脱敏。
fn collect_top_processes(
    system: &System,
    top_pids: &[Pid],
    presentation_cache: &mut HashMap<String, ProcessPresentation>,
) -> Vec<ProcessSnapshot> {
    let total_memory = system.total_memory().max(1);

    top_pids
        .iter()
        .filter_map(|pid| system.process(*pid).map(|process| (*pid, process)))
        .map(|(pid, process)| {
            let memory_bytes = process.memory();
            let name = process.name().to_string_lossy().to_string();
            let command = process
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            let presentation = process_presentation(process.exe(), &name, presentation_cache);
            ProcessSnapshot {
                pid: pid.to_string(),
                name,
                command,
                display_name: presentation.display_name,
                icon_data_url: presentation.icon_data_url,
                cpu_usage_percent: process.cpu_usage().max(0.0),
                memory_bytes,
                memory_usage_percent: clamp_percent(
                    (memory_bytes as f32 / total_memory as f32) * 100.0,
                ),
            }
        })
        .collect()
}

// 以可执行路径或名称缓存展示信息，包括缺失结果；达到 96 项时整体清空，不采用 LRU 淘汰。
fn process_presentation(
    exe_path: Option<&Path>,
    process_name: &str,
    cache: &mut HashMap<String, ProcessPresentation>,
) -> ProcessPresentation {
    let cache_key = exe_path
        .map(|path| path.to_string_lossy().to_string())
        .or_else(|| normalize_display_text(process_name).map(|name| format!("name:{name}")));

    if let Some(key) = cache_key.as_ref() {
        if let Some(cached) = cache.get(key) {
            return cached.clone();
        }
    }

    let presentation = ProcessPresentation {
        display_name: process_display_name(exe_path),
        icon_data_url: process_icon_data_url(exe_path),
    };

    if let Some(key) = cache_key {
        if cache.len() >= PROCESS_PRESENTATION_CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(key, presentation.clone());
    }

    presentation
}

// Windows 优先取版本资源描述，其余情况回退可执行文件主名；没有路径不以进程名补齐。
fn process_display_name(exe_path: Option<&Path>) -> Option<String> {
    #[cfg(target_os = "windows")]
    if let Some(path) = exe_path {
        if let Some(display_name) = windows_file_display_name(path) {
            return Some(display_name);
        }
    }

    exe_path
        .and_then(|path| path.file_stem())
        .and_then(|stem| normalize_display_text(&stem.to_string_lossy()))
}

#[cfg(target_os = "windows")]
// 提取程序小图标并编码为 BMP Data URL，缺失路径或提取失败返回 None。
fn process_icon_data_url(exe_path: Option<&Path>) -> Option<String> {
    let path = exe_path?;
    windows_file_icon_bmp(path).map(|bytes| {
        format!(
            "data:image/bmp;base64,{}",
            general_purpose::STANDARD.encode(bytes)
        )
    })
}

#[cfg(not(target_os = "windows"))]
// 非 Windows 不提供进程图标，交由前端使用无图标展示。
fn process_icon_data_url(_exe_path: Option<&Path>) -> Option<String> {
    None
}

// 去除首尾空白，将空展示文本转换为 None，不修改内部空白或大小写。
fn normalize_display_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Clone, Copy)]
struct LangAndCodePage {
    language: u16,
    code_page: u16,
}

#[cfg(target_os = "windows")]
// 读取文件版本资源，按声明语言/代码页及英语回退组合寻找 FileDescription，再尝试 ProductName。
fn windows_file_display_name(path: &Path) -> Option<String> {
    let wide_path = path_wide_null(path);
    let mut handle = 0_u32;
    let size = unsafe { GetFileVersionInfoSizeW(wide_path.as_ptr(), &mut handle) };
    if size == 0 {
        return None;
    }

    let mut data = vec![0_u8; size as usize];
    if unsafe {
        GetFileVersionInfoW(
            wide_path.as_ptr(),
            0,
            size,
            data.as_mut_ptr() as *mut c_void,
        )
    } == 0
    {
        return None;
    }

    let mut pairs = windows_version_translations(&data);
    pairs.extend([(0x0409, 0x04b0), (0x0409, 0x04e4)]);
    for (language, code_page) in pairs {
        for field in ["FileDescription", "ProductName"] {
            let key = format!("\\StringFileInfo\\{language:04x}{code_page:04x}\\{field}");
            if let Some(value) = windows_version_string(&data, &key) {
                return Some(value);
            }
        }
    }

    None
}

#[cfg(target_os = "windows")]
// 从有效 Windows 版本资源缓冲提取语言/代码页对，查询失败或无完整条目时返回空列表。
fn windows_version_translations(data: &[u8]) -> Vec<(u16, u16)> {
    let mut value_ptr: *mut c_void = ptr::null_mut();
    let mut len = 0_u32;
    let subblock = wide_null("\\VarFileInfo\\Translation");
    if unsafe {
        VerQueryValueW(
            data.as_ptr() as *const c_void,
            subblock.as_ptr(),
            &mut value_ptr,
            &mut len,
        )
    } == 0
        || value_ptr.is_null()
    {
        return Vec::new();
    }

    let count = (len as usize) / size_of::<LangAndCodePage>();
    if count == 0 {
        return Vec::new();
    }

    unsafe { slice::from_raw_parts(value_ptr as *const LangAndCodePage, count) }
        .iter()
        .map(|pair| (pair.language, pair.code_page))
        .collect()
}

#[cfg(target_os = "windows")]
// 按子键读取版本资源 UTF-16 字符串，截到首个 NUL 并过滤空文本；缓冲由系统版本 API 提供。
fn windows_version_string(data: &[u8], key: &str) -> Option<String> {
    let mut value_ptr: *mut c_void = ptr::null_mut();
    let mut len = 0_u32;
    let subblock = wide_null(key);
    if unsafe {
        VerQueryValueW(
            data.as_ptr() as *const c_void,
            subblock.as_ptr(),
            &mut value_ptr,
            &mut len,
        )
    } == 0
        || value_ptr.is_null()
        || len == 0
    {
        return None;
    }

    let raw = unsafe { slice::from_raw_parts(value_ptr as *const u16, len as usize) };
    let end = raw
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(raw.len());
    normalize_display_text(&String::from_utf16_lossy(&raw[..end]))
}

#[cfg(target_os = "windows")]
// 获取 Shell 小图标并转为 16×16 BMP，转换后销毁获得的 HICON，不将句柄交给调用方。
fn windows_file_icon_bmp(path: &Path) -> Option<Vec<u8>> {
    let wide_path = path_wide_null(path);
    let mut info = SHFILEINFOW::default();
    let result = unsafe {
        SHGetFileInfoW(
            wide_path.as_ptr(),
            0,
            &mut info,
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_SMALLICON,
        )
    };
    if result == 0 || info.hIcon.is_null() {
        return None;
    }

    let bytes = unsafe { icon_to_bmp_bytes(info.hIcon, PROCESS_ICON_SIZE) };
    unsafe {
        DestroyIcon(info.hIcon);
    }
    bytes
}

#[cfg(target_os = "windows")]
// 将有效 HICON 绘制到顶向下 32 位 DIB 并复制像素，正常收尾恢复选中对象并释放位图/DC。
// 调用方须保证图标有效、尺寸为可分配的正值，并自行管理传入 HICON 的生命周期。
unsafe fn icon_to_bmp_bytes(icon: HICON, size: i32) -> Option<Vec<u8>> {
    let hdc = CreateCompatibleDC(ptr::null_mut());
    if hdc.is_null() {
        return None;
    }

    let mut bitmap_info = BITMAPINFO::default();
    bitmap_info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
    bitmap_info.bmiHeader.biWidth = size;
    bitmap_info.bmiHeader.biHeight = -size;
    bitmap_info.bmiHeader.biPlanes = 1;
    bitmap_info.bmiHeader.biBitCount = 32;
    bitmap_info.bmiHeader.biCompression = BI_RGB;

    let mut bits: *mut c_void = ptr::null_mut();
    let bitmap = CreateDIBSection(
        hdc,
        &bitmap_info,
        DIB_RGB_COLORS,
        &mut bits,
        ptr::null_mut(),
        0,
    );
    if bitmap.is_null() || bits.is_null() {
        DeleteDC(hdc);
        return None;
    }

    let previous = SelectObject(hdc, bitmap as HGDIOBJ);
    let drawn = DrawIconEx(hdc, 0, 0, icon, size, size, 0, ptr::null_mut(), DI_NORMAL) != 0;

    let bytes = if drawn {
        let pixel_len = (size as usize) * (size as usize) * 4;
        let pixels = slice::from_raw_parts(bits as *const u8, pixel_len).to_vec();
        Some(build_bmp_data(size, &pixels))
    } else {
        None
    };

    if !previous.is_null() {
        SelectObject(hdc, previous);
    }
    DeleteObject(bitmap as HGDIOBJ);
    DeleteDC(hdc);

    bytes
}

#[cfg(target_os = "windows")]
// 将现有 32 位顶向下像素拼为 BMP 文件头、信息头与数据；不校验尺寸和像素长度的一致性。
fn build_bmp_data(size: i32, pixels: &[u8]) -> Vec<u8> {
    let header_size = 14_u32 + size_of::<BITMAPINFOHEADER>() as u32;
    let file_size = header_size + pixels.len() as u32;
    let mut out = Vec::with_capacity(file_size as usize);

    out.extend_from_slice(b"BM");
    out.extend_from_slice(&file_size.to_le_bytes());
    out.extend_from_slice(&0_u16.to_le_bytes());
    out.extend_from_slice(&0_u16.to_le_bytes());
    out.extend_from_slice(&header_size.to_le_bytes());
    out.extend_from_slice(&(size_of::<BITMAPINFOHEADER>() as u32).to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&(-size).to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&32_u16.to_le_bytes());
    out.extend_from_slice(&BI_RGB.to_le_bytes());
    out.extend_from_slice(&(pixels.len() as u32).to_le_bytes());
    out.extend_from_slice(&0_i32.to_le_bytes());
    out.extend_from_slice(&0_i32.to_le_bytes());
    out.extend_from_slice(&0_u32.to_le_bytes());
    out.extend_from_slice(&0_u32.to_le_bytes());
    out.extend_from_slice(pixels);

    out
}

#[cfg(target_os = "windows")]
// 以 Windows 原生宽字符编码路径并追加 NUL，供 Win32 API 使用，不规范化路径。
fn path_wide_null(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

// 用字节增量除以采样秒数并四舍五入为非负整数，正常调用方负责提供正的时间间隔。
fn bytes_per_second(bytes: u64, elapsed_secs: f64) -> u64 {
    ((bytes as f64) / elapsed_secs).round().max(0.0) as u64
}

// 将有限百分比限制到 0~100，NaN/无穷大归零，用于面板的归一化展示字段。
fn clamp_percent(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

// 返回 epoch 毫秒时间戳，限制到 u64 最大值；时间回退到 epoch 之前时返回 0。
fn current_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

static COLLECTOR: OnceLock<Mutex<ResourceCollector>> = OnceLock::new();

#[tauri::command]
// IPC 惰性初始化全局采集器并持锁同步采样，复用刷新缓存；锁中毒时返回明确错误。
pub fn system_resources_get_snapshot(
    full_detail: Option<bool>,
    options: Option<SystemResourceSnapshotOptions>,
) -> Result<SystemResourceSnapshot, String> {
    let collector = COLLECTOR.get_or_init(|| Mutex::new(ResourceCollector::new()));
    let mut collector = collector
        .lock()
        .map_err(|_| "system_resource_collector_poisoned".to_string())?;
    Ok(collector.snapshot(SamplingOptions::from_args(full_detail, options)))
}

#[cfg(target_os = "windows")]
struct MemoryCollector {
    inner: Option<MemoryPdhQuery>,
}

#[cfg(not(target_os = "windows"))]
struct MemoryCollector;

#[cfg(not(target_os = "windows"))]
impl MemoryCollector {
    // 非 Windows 无额外平台句柄，内存数据直接复用 sysinfo 快照。
    fn new() -> Self {
        Self
    }

    // 非 Windows 从系统快照取内存量并估算缓存，所有分项不超过总量，差值使用饱和减法。
    fn sample(&mut self, system: &System) -> MemorySnapshot {
        let total = system.total_memory();
        let used = system.used_memory().min(total);
        let available = system.available_memory().min(total);
        let free = system.free_memory().min(total);
        let cached = total.saturating_sub(used).saturating_sub(free);

        MemorySnapshot {
            total_bytes: total,
            used_bytes: used,
            available_bytes: available,
            cached_bytes: cached,
            free_bytes: free,
        }
    }
}

#[cfg(target_os = "windows")]
impl MemoryCollector {
    // Windows 尝试建立 PDH 内存查询，失败保留 None，此实例后续不重新初始化。
    fn new() -> Self {
        Self {
            inner: MemoryPdhQuery::new().ok(),
        }
    }

    // 总量/已用/可用来自 sysinfo，缓存/空闲优先 PDH；PDH 失败时缓存为零、空闲回退 sysinfo。
    fn sample(&mut self, system: &System) -> MemorySnapshot {
        let total = system.total_memory();
        let used = system.used_memory().min(total);
        let available = system.available_memory().min(total);
        let counters = self.inner.as_mut().and_then(MemoryPdhQuery::sample);

        MemorySnapshot {
            total_bytes: total,
            used_bytes: used,
            available_bytes: available,
            cached_bytes: counters
                .as_ref()
                .map_or(0, |value| value.cached_bytes.min(total)),
            free_bytes: counters.map_or_else(
                || system.free_memory().min(total),
                |value| value.free_bytes.min(total),
            ),
        }
    }
}

#[cfg(target_os = "windows")]
struct MemoryPdhSample {
    cached_bytes: u64,
    free_bytes: u64,
}

#[cfg(target_os = "windows")]
struct MemoryPdhQuery {
    query: windows_sys::Win32::System::Performance::PDH_HQUERY,
    cache_counter: windows_sys::Win32::System::Performance::PDH_HCOUNTER,
    free_counter: windows_sys::Win32::System::Performance::PDH_HCOUNTER,
}

// PDH handles are only accessed through ResourceCollector's global Mutex.
#[cfg(target_os = "windows")]
unsafe impl Send for MemoryPdhQuery {}

#[cfg(target_os = "windows")]
impl MemoryPdhQuery {
    // 建立缓存与空闲页计数器并预采样；添加计数器失败时关闭已打开查询，预采样失败不阻止返回。
    fn new() -> Result<Self, ()> {
        use windows_sys::Win32::System::Performance::{
            PdhAddEnglishCounterW, PdhCollectQueryData, PdhOpenQueryW, PDH_HCOUNTER, PDH_HQUERY,
        };

        let mut query: PDH_HQUERY = std::ptr::null_mut();
        let mut cache_counter: PDH_HCOUNTER = std::ptr::null_mut();
        let mut free_counter: PDH_HCOUNTER = std::ptr::null_mut();
        let cache_path = wide_null(r"\Memory\Cache Bytes");
        let free_path = wide_null(r"\Memory\Free & Zero Page List Bytes");

        unsafe {
            if PdhOpenQueryW(std::ptr::null(), 0, &mut query) != 0 {
                return Err(());
            }
            if PdhAddEnglishCounterW(query, cache_path.as_ptr(), 0, &mut cache_counter) != 0 {
                let _ = windows_sys::Win32::System::Performance::PdhCloseQuery(query);
                return Err(());
            }
            if PdhAddEnglishCounterW(query, free_path.as_ptr(), 0, &mut free_counter) != 0 {
                let _ = windows_sys::Win32::System::Performance::PdhCloseQuery(query);
                return Err(());
            }
            let _ = PdhCollectQueryData(query);
        }

        Ok(Self {
            query,
            cache_counter,
            free_counter,
        })
    }

    // 刷新查询并要求两个内存计数器均有效，任一失败则本次样本整体缺失。
    fn sample(&mut self) -> Option<MemoryPdhSample> {
        use windows_sys::Win32::System::Performance::PdhCollectQueryData;

        unsafe {
            if PdhCollectQueryData(self.query) != 0 {
                return None;
            }
        }

        Some(MemoryPdhSample {
            cached_bytes: read_pdh_u64(self.cache_counter)?,
            free_bytes: read_pdh_u64(self.free_counter)?,
        })
    }
}

#[cfg(target_os = "windows")]
impl Drop for MemoryPdhQuery {
    // 释放内存 PDH 查询及其关联计数器，忽略关闭失败。
    fn drop(&mut self) {
        unsafe {
            let _ = windows_sys::Win32::System::Performance::PdhCloseQuery(self.query);
        }
    }
}

#[cfg(target_os = "windows")]
// 按大整数读取 PDH 计数器，拒绝调用失败、非零状态和负值，不把无效计数伪装成零。
fn read_pdh_u64(counter: windows_sys::Win32::System::Performance::PDH_HCOUNTER) -> Option<u64> {
    use windows_sys::Win32::System::Performance::{
        PdhGetFormattedCounterValue, PDH_FMT_COUNTERVALUE, PDH_FMT_LARGE,
    };

    let mut value = PDH_FMT_COUNTERVALUE::default();
    let mut value_type = 0_u32;
    unsafe {
        if PdhGetFormattedCounterValue(counter, PDH_FMT_LARGE, &mut value_type, &mut value) != 0 {
            return None;
        }
        if value.CStatus != 0 {
            return None;
        }
        let bytes = value.Anonymous.largeValue;
        (bytes >= 0).then_some(bytes as u64)
    }
}

#[cfg(target_os = "windows")]
struct GpuCollector {
    inner: Option<GpuPdhQuery>,
}

#[cfg(not(target_os = "windows"))]
struct GpuCollector;

#[cfg(not(target_os = "windows"))]
impl GpuCollector {
    // 非 Windows 创建无状态 GPU 占位采集器，不访问系统 GPU API。
    fn new() -> Self {
        Self
    }

    // 非 Windows 当前未实现 GPU 采样，稳定返回 None。
    fn sample(&mut self) -> Option<GpuSnapshot> {
        None
    }
}

#[cfg(target_os = "windows")]
impl GpuCollector {
    // Windows 尝试一次建立 GPU PDH 查询，初始化失败后此实例保持不可用。
    fn new() -> Self {
        Self {
            inner: GpuPdhQuery::new().ok(),
        }
    }

    // 对成功取得的引擎利用率合计做 0~100 限制；查询不存在或读取失败则不返回 GPU 数值。
    fn sample(&mut self) -> Option<GpuSnapshot> {
        let query = self.inner.as_mut()?;
        query.sample().map(|usage_percent| GpuSnapshot {
            usage_percent: clamp_percent(usage_percent),
        })
    }
}

#[cfg(target_os = "windows")]
struct GpuPdhQuery {
    query: windows_sys::Win32::System::Performance::PDH_HQUERY,
    counter: windows_sys::Win32::System::Performance::PDH_HCOUNTER,
}

// PDH handles are only accessed through ResourceCollector's global Mutex.
#[cfg(target_os = "windows")]
unsafe impl Send for GpuPdhQuery {}

#[cfg(target_os = "windows")]
impl GpuPdhQuery {
    // 打开所有 GPU Engine 利用率通配计数器并预采样，添加失败释放查询；预采样错误暂不传播。
    fn new() -> Result<Self, ()> {
        use windows_sys::Win32::System::Performance::{
            PdhAddEnglishCounterW, PdhCollectQueryData, PdhOpenQueryW, PDH_HCOUNTER, PDH_HQUERY,
        };

        let mut query: PDH_HQUERY = std::ptr::null_mut();
        let mut counter: PDH_HCOUNTER = std::ptr::null_mut();
        let counter_path = wide_null(r"\GPU Engine(*)\Utilization Percentage");

        unsafe {
            if PdhOpenQueryW(std::ptr::null(), 0, &mut query) != 0 {
                return Err(());
            }
            if PdhAddEnglishCounterW(query, counter_path.as_ptr(), 0, &mut counter) != 0 {
                let _ = windows_sys::Win32::System::Performance::PdhCloseQuery(query);
                return Err(());
            }
            let _ = PdhCollectQueryData(query);
        }

        Ok(Self { query, counter })
    }

    // 刷新 GPU 查询，两阶段获取计数数组并累加有效项的非负利用率，不在此层限制总和为 100。
    fn sample(&mut self) -> Option<f32> {
        use windows_sys::Win32::System::Performance::{
            PdhCollectQueryData, PdhGetFormattedCounterArrayW, PDH_FMT_COUNTERVALUE_ITEM_W,
            PDH_FMT_DOUBLE, PDH_MORE_DATA,
        };

        unsafe {
            if PdhCollectQueryData(self.query) != 0 {
                return None;
            }

            let mut buffer_size = 0_u32;
            let mut item_count = 0_u32;
            let status = PdhGetFormattedCounterArrayW(
                self.counter,
                PDH_FMT_DOUBLE,
                &mut buffer_size,
                &mut item_count,
                std::ptr::null_mut(),
            );
            if status != PDH_MORE_DATA || buffer_size == 0 || item_count == 0 {
                return None;
            }

            let mut buffer = vec![0_u8; buffer_size as usize];
            let items = buffer.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(
                self.counter,
                PDH_FMT_DOUBLE,
                &mut buffer_size,
                &mut item_count,
                items,
            ) != 0
            {
                return None;
            }

            let values = std::slice::from_raw_parts(items, item_count as usize);
            let usage = values
                .iter()
                .filter(|item| item.FmtValue.CStatus == 0)
                .map(|item| item.FmtValue.Anonymous.doubleValue.max(0.0))
                .sum::<f64>();
            Some(usage as f32)
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for GpuPdhQuery {
    // 关闭 GPU PDH 查询以释放系统资源，不在析构中传播错误。
    fn drop(&mut self) {
        unsafe {
            let _ = windows_sys::Win32::System::Performance::PdhCloseQuery(self.query);
        }
    }
}

#[cfg(target_os = "windows")]
// 将字符串编码为以 NUL 结尾的 UTF-16，供版本资源及 PDH 子键调用使用。
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // 验证传输字节按实际秒数转换为速率，而非直接当作每秒字节。
    fn bytes_per_second_uses_elapsed_time() {
        assert_eq!(bytes_per_second(2_000, 2.0), 1_000);
    }

    #[test]
    // 验证负值、超百值和 NaN 的面板百分比归一化行为。
    fn clamp_percent_bounds_values() {
        assert_eq!(clamp_percent(-1.0), 0.0);
        assert_eq!(clamp_percent(120.0), 100.0);
        assert_eq!(clamp_percent(f32::NAN), 0.0);
    }

    #[test]
    // 验证日内增量及低于基线/跨日时两项计数一起归零。
    fn network_daily_totals_use_day_baseline_and_reset_on_counter_drop() {
        let day = NaiveDate::from_ymd_opt(2026, 7, 9).unwrap();
        let mut baseline = None;

        assert_eq!(network_daily_totals(&mut baseline, day, 100, 200), (0, 0));
        assert_eq!(network_daily_totals(&mut baseline, day, 150, 260), (50, 60));
        assert_eq!(network_daily_totals(&mut baseline, day, 90, 300), (0, 0));
        assert_eq!(
            network_daily_totals(
                &mut baseline,
                NaiveDate::from_ymd_opt(2026, 7, 10).unwrap(),
                120,
                330
            ),
            (0, 0)
        );
    }

    #[test]
    // 验证旧 fullDetail=false 仍保留系统/CPU/内存，同时关闭四项额外采样。
    fn sampling_options_keep_legacy_full_detail_behavior() {
        let options = SamplingOptions::from_args(Some(false), None);
        assert!(options.system);
        assert!(options.cpu);
        assert!(options.memory);
        assert!(!options.network);
        assert!(!options.disk);
        assert!(!options.gpu);
        assert!(!options.processes);
    }

    #[test]
    // 验证首次立即采样、刚刷新时复用缓存、超过昂贵刷新间隔后允许采样。
    fn should_refresh_respects_expensive_interval() {
        let now = Instant::now();
        assert!(should_refresh(None, now));
        assert!(!should_refresh(Some(now), now));
        assert!(should_refresh(
            Some(now - EXPENSIVE_REFRESH_INTERVAL - Duration::from_secs(1)),
            now
        ));
    }
}
