//! CLI-Manager 内置 Claude Code 状态栏。
//!
//! 配置格式基于 ccstatusline-zh v2.2.23（MIT），保留 v3 字段语义。

mod themes;
use themes::powerline_theme;

use crate::app_paths;
use crate::shell_resolver::{output_with_timeout, output_with_timeout_bounded, silent_command};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Graphics::Gdi::AddFontResourceExW,
    UI::WindowsAndMessaging::{SendMessageW, HWND_BROADCAST, WM_FONTCHANGE},
};

const SETTINGS_VERSION: u32 = 3;
const STATUSLINE_DIR: &str = "statusline";
const SETTINGS_FILE: &str = "settings.json";
const BUNDLED_POWERLINE_FONT_NAME: &str = "SymbolsNerdFontMono-Regular.ttf";
const BUNDLED_POWERLINE_FONT: &[u8] =
    include_bytes!("../../../resources/fonts/SymbolsNerdFontMono-Regular.ttf");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetItem {
    pub id: String,
    #[serde(rename = "type")]
    pub widget_type: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub background_color: Option<String>,
    #[serde(default)]
    pub bold: Option<bool>,
    #[serde(default)]
    pub dim: Option<Value>,
    #[serde(default)]
    pub character: Option<String>,
    #[serde(default)]
    pub raw_value: Option<bool>,
    #[serde(default)]
    pub custom_text: Option<String>,
    #[serde(default)]
    pub custom_symbol: Option<String>,
    #[serde(default)]
    pub command_path: Option<String>,
    #[serde(default)]
    pub max_width: Option<u32>,
    #[serde(default)]
    pub preserve_colors: Option<bool>,
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default)]
    pub merge: Option<Value>,
    #[serde(default)]
    pub hide: Option<bool>,
    #[serde(default)]
    pub metadata: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerlineConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_powerline_separators")]
    pub separators: Vec<String>,
    #[serde(default)]
    pub separator_invert_background: Vec<bool>,
    #[serde(default)]
    pub start_caps: Vec<String>,
    #[serde(default)]
    pub end_caps: Vec<String>,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub auto_align: bool,
    #[serde(default)]
    pub continue_theme_across_lines: bool,
}

impl Default for PowerlineConfig {
    // 构造默认关闭、使用箭头分隔符的 Powerline 配置。
    fn default() -> Self {
        Self {
            enabled: false,
            separators: default_powerline_separators(),
            separator_invert_background: vec![false],
            start_caps: Vec::new(),
            end_caps: Vec::new(),
            theme: None,
            auto_align: false,
            continue_theme_across_lines: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatuslineSettings {
    #[serde(default = "settings_version")]
    pub version: u32,
    #[serde(default = "default_lines")]
    pub lines: Vec<Vec<WidgetItem>>,
    #[serde(default = "default_flex_mode")]
    pub flex_mode: String,
    #[serde(default = "default_compact_threshold")]
    pub compact_threshold: u8,
    #[serde(default = "default_color_level")]
    pub color_level: u8,
    #[serde(default)]
    pub default_separator: Option<String>,
    #[serde(default)]
    pub default_padding: Option<String>,
    #[serde(default)]
    pub inherit_separator_colors: bool,
    #[serde(default)]
    pub override_background_color: Option<String>,
    #[serde(default)]
    pub override_foreground_color: Option<String>,
    #[serde(default)]
    pub global_bold: bool,
    #[serde(default = "default_git_cache_ttl")]
    pub git_cache_ttl_seconds: u8,
    #[serde(default)]
    pub minimalist_mode: bool,
    #[serde(default)]
    pub powerline: PowerlineConfig,
    #[serde(default)]
    pub imported_from: Option<String>,
}

impl Default for StatuslineSettings {
    // 构造内置三行状态栏及默认布局、颜色和缓存设置。
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            lines: default_lines(),
            flex_mode: default_flex_mode(),
            compact_threshold: default_compact_threshold(),
            color_level: default_color_level(),
            default_separator: None,
            default_padding: None,
            inherit_separator_colors: false,
            override_background_color: None,
            override_foreground_color: None,
            global_bold: false,
            git_cache_ttl_seconds: default_git_cache_ttl(),
            minimalist_mode: false,
            powerline: PowerlineConfig::default(),
            imported_from: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatuslineStatus {
    pub settings_path: String,
    pub claude_settings_path: String,
    pub installed: bool,
    pub current_command: Option<String>,
    pub legacy_settings_path: String,
    pub legacy_settings_available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetCatalogEntry {
    pub widget_type: &'static str,
    pub category: &'static str,
    pub zh_name: &'static str,
    pub en_name: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerlineFontStatus {
    pub installed: bool,
    pub checked_symbol: &'static str,
    pub matched_font: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerlineFontInstallResult {
    pub success: bool,
    pub message: String,
    pub installed_count: usize,
}

// 返回当前状态栏设置模式版本。
fn settings_version() -> u32 {
    SETTINGS_VERSION
}
// 返回默认弹性布局模式。
fn default_flex_mode() -> String {
    "full-minus-40".to_string()
}
// 返回默认紧凑显示阈值。
fn default_compact_threshold() -> u8 {
    60
}
// 返回默认 ANSI256 色彩级别。
fn default_color_level() -> u8 {
    2
}
// 返回默认 Git 缓存秒数配置。
fn default_git_cache_ttl() -> u8 {
    5
}
// 返回默认 Powerline 箭头分隔符列表。
fn default_powerline_separators() -> Vec<String> {
    vec!["\u{e0b0}".to_string()]
}

// 构造指定身份、类型和前景色的基础组件配置。
fn widget(id: &str, widget_type: &str, color: Option<&str>) -> WidgetItem {
    WidgetItem {
        id: id.to_string(),
        widget_type: widget_type.to_string(),
        color: color.map(str::to_string),
        background_color: None,
        bold: None,
        dim: None,
        character: None,
        raw_value: None,
        custom_text: None,
        custom_symbol: None,
        command_path: None,
        max_width: None,
        preserve_colors: None,
        timeout: None,
        merge: None,
        hide: None,
        metadata: None,
    }
}

// 构造模型、上下文及 Git 信息的默认行，另外两行留空。
fn default_lines() -> Vec<Vec<WidgetItem>> {
    vec![
        vec![
            widget("1", "model", Some("cyan")),
            widget("2", "separator", None),
            widget("3", "context-length", Some("brightBlack")),
            widget("4", "separator", None),
            widget("5", "git-branch", Some("magenta")),
            widget("6", "separator", None),
            widget("7", "git-changes", Some("yellow")),
        ],
        Vec::new(),
        Vec::new(),
    ]
}

// 返回当前应用数据根内的状态栏设置路径。
pub fn settings_path() -> Result<PathBuf, String> {
    Ok(app_paths::cli_manager_data_dir()?
        .join(STATUSLINE_DIR)
        .join(SETTINGS_FILE))
}

// 从 USERPROFILE 或 HOME 读取用户主目录。
fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "home_dir_unavailable".to_string())
}

// 按操作系统返回用户优先的字体安装目录列表。
fn powerline_font_dirs() -> Result<Vec<PathBuf>, String> {
    let home = home_dir()?;
    #[cfg(target_os = "windows")]
    return Ok(vec![
        home.join("AppData/Local/Microsoft/Windows/Fonts"),
        PathBuf::from(r"C:\Windows\Fonts"),
    ]);
    #[cfg(target_os = "macos")]
    return Ok(vec![
        home.join("Library/Fonts"),
        PathBuf::from("/Library/Fonts"),
        PathBuf::from("/System/Library/Fonts"),
    ]);
    #[cfg(target_os = "linux")]
    return Ok(vec![
        home.join(".local/share/fonts"),
        home.join(".fonts"),
        PathBuf::from("/usr/share/fonts"),
        PathBuf::from("/usr/local/share/fonts"),
    ]);
    #[allow(unreachable_code)]
    Ok(Vec::new())
}

// 根据名称中的常见 Powerline 或 Nerd Font 标记识别候选字体。
fn looks_like_powerline_font(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("powerline")
        || name.contains("nerdfont")
        || name.contains("nerd font")
        || name.contains("meslo")
        || name.contains("cascadiacodepl")
        || name.contains("fira code nerd")
}

// 将可选匹配字体名称转换为字体可用状态。
fn powerline_font_status(matched_font: Option<String>) -> PowerlineFontStatus {
    PowerlineFontStatus {
        installed: matched_font.is_some(),
        checked_symbol: "\u{e0b0}",
        matched_font,
    }
}

#[cfg(target_os = "windows")]
// 在 Windows 用户和系统字体注册表项中查找匹配字体。
fn detect_powerline_font() -> Result<PowerlineFontStatus, String> {
    for key in [
        r"HKCU\Software\Microsoft\Windows NT\CurrentVersion\Fonts",
        r"HKLM\Software\Microsoft\Windows NT\CurrentVersion\Fonts",
    ] {
        let mut command = silent_command("reg.exe");
        command.args(["query", key]);
        let Ok(output) = output_with_timeout(command, Duration::from_secs(10)) else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let value_name = line.split("REG_").next().unwrap_or(line).trim();
            if looks_like_powerline_font(value_name) {
                let family = value_name
                    .strip_prefix("CLI-Manager ")
                    .unwrap_or(value_name)
                    .trim_end_matches(" (TrueType)")
                    .trim_end_matches(" (OpenType)")
                    .to_string();
                return Ok(powerline_font_status(Some(family)));
            }
        }
    }
    Ok(powerline_font_status(None))
}

#[cfg(target_os = "linux")]
// 通过 Linux fc-list 字体家族输出查找匹配字体。
fn detect_powerline_font() -> Result<PowerlineFontStatus, String> {
    let mut command = silent_command("fc-list");
    command.args([":", "family"]);
    let Ok(output) = output_with_timeout(command, Duration::from_secs(10)) else {
        return Ok(powerline_font_status(None));
    };
    if output.status.success() {
        for family in String::from_utf8_lossy(&output.stdout)
            .lines()
            .flat_map(|line| line.split(','))
        {
            let family = family.trim();
            if looks_like_powerline_font(family) {
                return Ok(powerline_font_status(Some(family.to_string())));
            }
        }
    }
    Ok(powerline_font_status(None))
}

#[cfg(target_os = "macos")]
// 从 macOS 系统字体数据库中查找匹配家族。
fn detect_powerline_font() -> Result<PowerlineFontStatus, String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    for face in db.faces() {
        for (family, _) in &face.families {
            if looks_like_powerline_font(family) {
                return Ok(powerline_font_status(Some(family.clone())));
            }
        }
    }
    Ok(powerline_font_status(None))
}

// 优先选择内置符号字体，否则选择非粗体、非斜体候选。
fn preferred_powerline_font(fonts: &[PathBuf]) -> Option<&Path> {
    fonts
        .iter()
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case(BUNDLED_POWERLINE_FONT_NAME))
        })
        .or_else(|| {
            fonts.iter().find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        let name = name.to_ascii_lowercase();
                        !name.contains("bold")
                            && !name.contains("italic")
                            && !name.contains("oblique")
                    })
            })
        })
        .map(PathBuf::as_path)
}

#[cfg(target_os = "windows")]
// 在 Windows 激活首选字体、写入用户注册表并广播字体变更。
fn activate_powerline_fonts(target: &Path, fonts: &[PathBuf]) -> Result<(), String> {
    let font =
        preferred_powerline_font(fonts).ok_or_else(|| "powerline_fonts_not_found".to_string())?;
    let installed_font = target.join(
        font.file_name()
            .ok_or_else(|| "powerline_font_invalid_name".to_string())?,
    );
    let mut wide_path = installed_font.as_os_str().encode_wide().collect::<Vec<_>>();
    wide_path.push(0);
    if unsafe { AddFontResourceExW(wide_path.as_ptr(), 0, std::ptr::null()) } == 0 {
        return Err("powerline_font_activation_failed".to_string());
    }

    let value_name = format!(
        "CLI-Manager {} (TrueType)",
        installed_font
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("Powerline")
    );
    let mut command = silent_command("reg.exe");
    command
        .args([
            "add",
            r"HKCU\Software\Microsoft\Windows NT\CurrentVersion\Fonts",
            "/v",
            &value_name,
            "/t",
            "REG_SZ",
            "/d",
        ])
        .arg(&installed_font)
        .arg("/f");
    let output = output_with_timeout(command, Duration::from_secs(10))
        .map_err(|error| format!("powerline_font_registry_failed: {error}"))?;
    if !output.status.success() {
        return Err("powerline_font_registry_failed".to_string());
    }

    unsafe { SendMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0) };
    Ok(())
}

#[cfg(target_os = "linux")]
// 调用 Linux fc-cache 刷新目标字体目录。
fn activate_powerline_fonts(target: &Path, _fonts: &[PathBuf]) -> Result<(), String> {
    let mut command = silent_command("fc-cache");
    command.args(["-f"]).arg(target);
    let output = output_with_timeout(command, Duration::from_secs(30))
        .map_err(|error| format!("powerline_font_cache_failed: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err("powerline_font_cache_failed".to_string())
    }
}

#[cfg(target_os = "macos")]
// macOS 字体复制完成后无需额外激活步骤。
fn activate_powerline_fonts(_target: &Path, _fonts: &[PathBuf]) -> Result<(), String> {
    Ok(())
}

// 将内置符号字体写入用户字体目录并执行平台激活。
fn install_powerline_fonts() -> Result<PowerlineFontInstallResult, String> {
    let target = powerline_font_dirs()?
        .into_iter()
        .next()
        .ok_or_else(|| "powerline_font_platform_unsupported".to_string())?;
    fs::create_dir_all(&target)
        .map_err(|err| format!("powerline_font_create_dir_failed: {err}"))?;
    let installed_font = target.join(BUNDLED_POWERLINE_FONT_NAME);
    fs::write(&installed_font, BUNDLED_POWERLINE_FONT)
        .map_err(|err| format!("powerline_font_write_failed: {err}"))?;
    let fonts = vec![PathBuf::from(BUNDLED_POWERLINE_FONT_NAME)];
    activate_powerline_fonts(&target, &fonts)?;
    Ok(PowerlineFontInstallResult {
        success: true,
        message: "powerline_fonts_installed".to_string(),
        installed_count: 1,
    })
}

// 返回用户原 ccstatusline 的只读导入来源路径。
fn legacy_settings_path() -> Result<PathBuf, String> {
    Ok(home_dir()?
        .join(".config")
        .join("ccstatusline")
        .join(SETTINGS_FILE))
}

// 优先使用 CLAUDE_CONFIG_DIR，否则解析 Claude 默认设置文件。
fn claude_settings_path() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(dir).join(SETTINGS_FILE));
    }
    crate::provider::home::default_config_root("claude")
        .or_else(|| home_dir().ok().map(|home| home.join(".claude")))
        .ok_or_else(|| "home_dir_unavailable".to_string())
        .map(|dir| dir.join(SETTINGS_FILE))
}

// 检查行数、紧凑阈值、色彩级别和组件身份字段。
pub(crate) fn validate_settings(settings: &StatuslineSettings) -> Result<(), String> {
    if settings.lines.is_empty() || settings.lines.len() > 3 {
        return Err("statusline_invalid_line_count".to_string());
    }
    if !(1..=99).contains(&settings.compact_threshold) {
        return Err("statusline_invalid_compact_threshold".to_string());
    }
    if settings.color_level > 3 {
        return Err("statusline_invalid_color_level".to_string());
    }
    for line in &settings.lines {
        for item in line {
            if item.id.trim().is_empty() || item.widget_type.trim().is_empty() {
                return Err("statusline_invalid_widget".to_string());
            }
        }
    }
    Ok(())
}

// 解析设置、迁移旧组件别名并补足三行后验证。
fn parse_settings(text: &str) -> Result<StatuslineSettings, String> {
    let mut value: Value =
        serde_json::from_str(text).map_err(|_| "statusline_invalid_json".to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "statusline_invalid_root".to_string())?;
    object.entry("version").or_insert(json!(SETTINGS_VERSION));
    if let Some(lines) = object.get_mut("lines").and_then(Value::as_array_mut) {
        for line in lines.iter_mut().filter_map(Value::as_array_mut) {
            for item in line.iter_mut().filter_map(Value::as_object_mut) {
                if item.get("type").and_then(Value::as_str) == Some("git-pr") {
                    item.insert("type".to_string(), json!("git-review"));
                }
            }
        }
    }
    let mut settings: StatuslineSettings =
        serde_json::from_value(value).map_err(|_| "statusline_invalid_schema".to_string())?;
    settings.version = SETTINGS_VERSION;
    while settings.lines.len() < 3 {
        settings.lines.push(Vec::new());
    }
    validate_settings(&settings)?;
    Ok(settings)
}

// 读取内部状态栏设置，缺失时只返回内置默认值。
pub fn load_settings() -> Result<StatuslineSettings, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(StatuslineSettings::default());
    }
    parse_settings(
        &fs::read_to_string(path).map_err(|err| format!("statusline_read_failed: {err}"))?,
    )
}

// 读取可选旧版设置并解析，来源不存在时返回无配置。
pub(crate) fn load_legacy_settings() -> Result<Option<StatuslineSettings>, String> {
    let path = legacy_settings_path()?;
    if !path.exists() {
        return Ok(None);
    }
    parse_settings(
        &fs::read_to_string(path).map_err(|err| format!("statusline_legacy_read_failed: {err}"))?,
    )
    .map(Some)
}

// 同目录暂存设置后替换目标，失败时尝试清理暂存文件。
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "statusline_invalid_path".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("statusline_create_dir_failed: {err}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temp = parent.join(format!(
        ".{SETTINGS_FILE}.{}.{}.tmp",
        std::process::id(),
        stamp
    ));
    fs::write(&temp, bytes).map_err(|err| format!("statusline_write_failed: {err}"))?;
    if let Err(error) = fs::rename(&temp, path) {
        #[cfg(target_os = "windows")]
        if path.exists() {
            fs::remove_file(path).map_err(|err| format!("statusline_replace_failed: {err}"))?;
            fs::rename(&temp, path).map_err(|err| format!("statusline_replace_failed: {err}"))?;
            return Ok(());
        }
        let _ = fs::remove_file(&temp);
        return Err(format!("statusline_replace_failed: {error}"));
    }
    Ok(())
}

// 验证设置并以当前模式版本序列化保存。
pub fn save_settings(settings: &StatuslineSettings) -> Result<(), String> {
    validate_settings(settings)?;
    let mut next = settings.clone();
    next.version = SETTINGS_VERSION;
    let bytes = serde_json::to_vec_pretty(&next)
        .map_err(|err| format!("statusline_serialize_failed: {err}"))?;
    atomic_write(&settings_path()?, &bytes)
}

// 导入并记录旧配置来源，仅写 CLI-Manager 内部设置。
pub fn import_legacy() -> Result<StatuslineSettings, String> {
    let path = legacy_settings_path()?;
    if !path.exists() {
        return Err("statusline_legacy_not_found".to_string());
    }
    let mut settings = parse_settings(
        &fs::read_to_string(&path)
            .map_err(|err| format!("statusline_legacy_read_failed: {err}"))?,
    )?;
    settings.imported_from = Some(path.to_string_lossy().to_string());
    save_settings(&settings)?;
    Ok(settings)
}

// 读取 Claude JSON 对象，缺失时返回空对象且拒绝无效根。
fn read_json_object(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let value: Value = serde_json::from_str(
        &fs::read_to_string(path).map_err(|err| format!("claude_settings_read_failed: {err}"))?,
    )
    .map_err(|_| "claude_settings_invalid_json".to_string())?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "claude_settings_invalid_root".to_string())
}

// 为已存在设置文件创建固定后缀备份。
fn backup_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let backup = path.with_file_name(format!(
        "{}.cli-manager-statusline.bak",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    fs::copy(path, backup).map_err(|err| format!("claude_settings_backup_failed: {err}"))?;
    Ok(())
}

// 按平台 shell 规则转义程序路径并追加状态栏子命令。
fn quote_command_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if cfg!(target_os = "windows") {
        format!(
            "powershell -NoProfile -Command \"& '{}' __statusline\"",
            raw.replace('\'', "''")
        )
    } else {
        format!("'{}' __statusline", raw.replace('\'', "'\\''"))
    }
}

// 为当前可执行文件生成受管状态栏命令。
pub fn managed_command() -> Result<String, String> {
    Ok(quote_command_path(
        &std::env::current_exe().map_err(|err| format!("executable_path_failed: {err}"))?,
    ))
}

// 构造受管 command 配置，设置零 padding 并限制刷新间隔。
fn managed_status_line(refresh_interval: Option<u8>) -> Result<Value, String> {
    let mut status_line = Map::new();
    status_line.insert("type".to_string(), json!("command"));
    status_line.insert("command".to_string(), json!(managed_command()?));
    status_line.insert("padding".to_string(), json!(0));
    if let Some(interval) = refresh_interval {
        status_line.insert("refreshInterval".to_string(), json!(interval.clamp(1, 60)));
    }
    Ok(Value::Object(status_line))
}

// 备份 Claude 配置并写入受管 statusLine，保留其余字段。
pub fn install(refresh_interval: Option<u8>) -> Result<StatuslineStatus, String> {
    let path = claude_settings_path()?;
    let mut root = read_json_object(&path)?;
    backup_file(&path)?;
    root.insert(
        "statusLine".to_string(),
        managed_status_line(refresh_interval)?,
    );
    let bytes = serde_json::to_vec_pretty(&Value::Object(root)).map_err(|err| err.to_string())?;
    atomic_write(&path, &bytes)?;
    get_status()
}

// 仅当命令包含受管标记时备份并移除 Claude 状态栏配置。
pub fn uninstall() -> Result<StatuslineStatus, String> {
    let path = claude_settings_path()?;
    let mut root = read_json_object(&path)?;
    let owned = root
        .get("statusLine")
        .and_then(Value::as_object)
        .and_then(|value| value.get("command"))
        .and_then(Value::as_str)
        .map(|command| command.contains("__statusline"))
        .unwrap_or(false);
    if owned {
        backup_file(&path)?;
        root.remove("statusLine");
        atomic_write(
            &path,
            &serde_json::to_vec_pretty(&Value::Object(root)).map_err(|err| err.to_string())?,
        )?;
    }
    get_status()
}

// 只读查询内部路径、Claude 当前命令和旧配置可用状态。
pub fn get_status() -> Result<StatuslineStatus, String> {
    let claude_path = claude_settings_path()?;
    let root = read_json_object(&claude_path)?;
    let command = root
        .get("statusLine")
        .and_then(Value::as_object)
        .and_then(|value| value.get("command"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let legacy = legacy_settings_path()?;
    Ok(StatuslineStatus {
        settings_path: settings_path()?.to_string_lossy().to_string(),
        claude_settings_path: claude_path.to_string_lossy().to_string(),
        installed: command
            .as_deref()
            .map(|value| value.contains("__statusline"))
            .unwrap_or(false),
        current_command: command,
        legacy_settings_path: legacy.to_string_lossy().to_string(),
        legacy_settings_available: legacy.exists(),
    })
}

// 沿 JSON 字段路径查找嵌套值。
fn value_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
}

// 读取数字或数字字符串，字段不可用时回退零。
fn number_at(value: &Value, path: &[&str]) -> f64 {
    value_at(value, path)
        .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(0.0)
}

// 沿字段路径读取可选字符串。
fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    value_at(value, path)
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

// 将数值格式化为整数或带一位小数的 k/m 缩写。
fn format_number(value: f64) -> String {
    if value >= 1_000_000.0 {
        format!("{:.1}m", value / 1_000_000.0)
    } else if value >= 1_000.0 {
        format!("{:.1}k", value / 1_000.0)
    } else {
        format!("{}", value.round() as i64)
    }
}

// 格式化上下文数值并移除 k/m 前多余的 .0。
fn format_context_number(value: f64) -> String {
    let formatted = format_number(value);
    if let Some(value) = formatted.strip_suffix(".0k") {
        format!("{value}k")
    } else if let Some(value) = formatted.strip_suffix(".0m") {
        format!("{value}m")
    } else {
        formatted
    }
}

// 从当前上下文用量对象中读取指定数值字段。
fn current_usage(payload: &Value, key: &str) -> f64 {
    value_at(payload, &["context_window", "current_usage"])
        .and_then(Value::as_object)
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(0.0)
}

// 从载荷工作目录发现 Git 仓库。
fn git_repo(payload: &Value) -> Option<git2::Repository> {
    let cwd = string_at(payload, &["workspace", "current_dir"])
        .or_else(|| string_at(payload, &["cwd"]))?;
    git2::Repository::discover(cwd).ok()
}

// 优先使用预览分支，否则读取仓库 HEAD 简称。
fn git_branch(payload: &Value) -> Option<String> {
    if let Some(branch) = string_at(payload, &["preview_git", "branch"]) {
        return Some(branch);
    }
    let repo = git_repo(payload)?;
    let branch = repo.head().ok()?.shorthand().map(str::to_string);
    branch
}

// 使用预览计数或扫描 Git 状态，返回暂存、未暂存、未跟踪和冲突数。
fn git_status_counts(payload: &Value) -> (usize, usize, usize, usize) {
    if let Some(preview) = payload.get("preview_git") {
        let count = |key: &str| preview.get(key).and_then(Value::as_u64).unwrap_or(0) as usize;
        return (
            count("staged"),
            count("unstaged"),
            count("untracked"),
            count("conflicts"),
        );
    }
    let Some(repo) = git_repo(payload) else {
        return (0, 0, 0, 0);
    };
    let Ok(statuses) = repo.statuses(None) else {
        return (0, 0, 0, 0);
    };
    let mut staged = 0;
    let mut unstaged = 0;
    let mut untracked = 0;
    let mut conflicts = 0;
    for entry in statuses.iter() {
        let status = entry.status();
        if status.is_conflicted() {
            conflicts += 1;
        }
        if status.is_wt_new() {
            untracked += 1;
        }
        if status.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        ) {
            staged += 1;
        }
        if status.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE,
        ) {
            unstaged += 1;
        }
    }
    (staged, unstaged, untracked, conflicts)
}

// 在载荷工作目录执行自定义 shell 命令，轮询退出并在超时后终止。
fn run_custom_command(item: &WidgetItem, payload: &Value) -> Option<String> {
    let command = item.command_path.as_deref()?.trim();
    if command.is_empty() {
        return None;
    }
    let cwd =
        string_at(payload, &["workspace", "current_dir"]).or_else(|| string_at(payload, &["cwd"]));
    let mut child = if cfg!(target_os = "windows") {
        let mut process = Command::new("powershell");
        process.args(["-NoProfile", "-Command", command]);
        process
    } else {
        let mut process = Command::new("sh");
        process.args(["-lc", command]);
        process
    };
    if let Some(cwd) = cwd {
        child.current_dir(cwd);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        child.creation_flags(0x08000000);
    }
    let timeout = Duration::from_millis(item.timeout.unwrap_or(2_000).clamp(100, 30_000));
    let output = output_with_timeout_bounded(child, timeout, 64 * 1024).ok()?;
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// 按组件类型渲染原始值，隐藏项和普通空值不产生输出。
fn render_widget_raw(item: &WidgetItem, payload: &Value) -> Option<String> {
    if item.hide.unwrap_or(false) {
        return None;
    }
    let (staged, unstaged, untracked, conflicts) = git_status_counts(payload);
    let input = current_usage(payload, "input_tokens");
    let output = current_usage(payload, "output_tokens");
    let cache_read = current_usage(payload, "cache_read_input_tokens");
    let cache_write = current_usage(payload, "cache_creation_input_tokens");
    let context_size = number_at(payload, &["context_window", "context_window_size"]);
    let used = input + output + cache_read + cache_write;
    let raw = match item.widget_type.as_str() {
        "separator" => item.character.clone().unwrap_or_else(|| " | ".to_string()),
        "flex-separator" => " ".to_string(),
        "model" => value_at(payload, &["model"])
            .and_then(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| {
                        value
                            .get("display_name")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .or_else(|| value.get("id").and_then(Value::as_str).map(str::to_string))
            })
            .unwrap_or_else(|| "Claude".to_string()),
        "output-style" => string_at(payload, &["output_style", "name"]).unwrap_or_default(),
        "tokens-input" => format_number(input),
        "tokens-output" => format_number(output),
        "tokens-cached" | "cache-read" => format_number(cache_read),
        "cache-write" => format_number(cache_write),
        "tokens-total" => format_number(input + output + cache_read + cache_write),
        "cache-hit-rate" => {
            if input + cache_read > 0.0 {
                format!("{:.0}%", cache_read * 100.0 / (input + cache_read))
            } else {
                "0%".to_string()
            }
        }
        "context-length" => format_number(used),
        "context-window" => format_number(context_size),
        "context-percentage" => {
            if context_size > 0.0 {
                format!("{:.0}%", used * 100.0 / context_size)
            } else {
                "0%".to_string()
            }
        }
        "context-percentage-usable" => {
            if context_size > 0.0 {
                format!("{:.0}%", 100.0 - used * 100.0 / context_size)
            } else {
                "100%".to_string()
            }
        }
        "context-bar" => {
            let percentage = if context_size > 0.0 {
                (used * 100.0 / context_size).clamp(0.0, 100.0)
            } else {
                0.0
            };
            let filled = (percentage * 16.0 / 100.0).floor() as usize;
            format!(
                "[{}{}] {}/{} ({percentage:.0}%)",
                "█".repeat(filled),
                "░".repeat(16 - filled),
                format_context_number(used),
                format_context_number(context_size),
            )
        }
        "session-cost" => format!("${:.2}", number_at(payload, &["cost", "total_cost_usd"])),
        "session-clock" => {
            let seconds = number_at(payload, &["cost", "total_duration_ms"]) / 1000.0;
            format!("{:02}:{:02}", seconds as i64 / 60, seconds as i64 % 60)
        }
        "claude-session-id" => string_at(payload, &["session_id"]).unwrap_or_default(),
        "current-working-dir" => string_at(payload, &["workspace", "current_dir"])
            .or_else(|| string_at(payload, &["cwd"]))
            .and_then(|value| {
                Path::new(&value)
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
            })
            .unwrap_or_default(),
        "version" => env!("CARGO_PKG_VERSION").to_string(),
        "thinking-effort" => string_at(payload, &["effort", "level"]).unwrap_or_default(),
        "vim-mode" => string_at(payload, &["vim", "mode"]).unwrap_or_default(),
        "worktree-name" => string_at(payload, &["worktree", "name"]).unwrap_or_default(),
        "worktree-branch" => string_at(payload, &["worktree", "branch"]).unwrap_or_default(),
        "worktree-original-branch" => {
            string_at(payload, &["worktree", "original_branch"]).unwrap_or_default()
        }
        "worktree-mode" => {
            if value_at(payload, &["worktree"]).is_some() {
                "worktree".to_string()
            } else {
                String::new()
            }
        }
        "git-branch" => git_branch(payload)
            .map(|branch| format!("⎇ {branch}"))
            .unwrap_or_default(),
        "git-status" => format!("+{staged} *{unstaged} ?{untracked} !{conflicts}"),
        "git-changes" => format!("{}", staged + unstaged + untracked),
        "git-staged-files" => staged.to_string(),
        "git-unstaged-files" => unstaged.to_string(),
        "git-untracked-files" => untracked.to_string(),
        "git-conflicts" => conflicts.to_string(),
        "git-staged" => {
            if staged > 0 {
                "+".to_string()
            } else {
                String::new()
            }
        }
        "git-unstaged" => {
            if unstaged > 0 {
                "*".to_string()
            } else {
                String::new()
            }
        }
        "git-untracked" => {
            if untracked > 0 {
                "?".to_string()
            } else {
                String::new()
            }
        }
        "git-clean-status" => {
            if staged + unstaged + untracked + conflicts == 0 {
                "✓".to_string()
            } else {
                String::new()
            }
        }
        "git-root-dir" => string_at(payload, &["preview_git", "root_dir"])
            .or_else(|| {
                git_repo(payload).and_then(|repo| {
                    repo.workdir()
                        .and_then(Path::file_name)
                        .map(|name| name.to_string_lossy().to_string())
                })
            })
            .unwrap_or_default(),
        "git-sha" => string_at(payload, &["preview_git", "sha"])
            .or_else(|| {
                git_repo(payload).and_then(|repo| {
                    repo.head()
                        .ok()?
                        .target()
                        .map(|oid| oid.to_string()[..7].to_string())
                })
            })
            .unwrap_or_default(),
        "git-insertions" => format_number(number_at(payload, &["cost", "total_lines_added"])),
        "git-deletions" => format_number(number_at(payload, &["cost", "total_lines_removed"])),
        "custom-text" => item.custom_text.clone().unwrap_or_default(),
        "custom-symbol" => item.custom_symbol.clone().unwrap_or_default(),
        "custom-command" => run_custom_command(item, payload).unwrap_or_default(),
        "terminal-width" => {
            std::env::var("CCSTATUSLINE_WIDTH").unwrap_or_else(|_| "80".to_string())
        }
        "weekly-usage" => format!(
            "{:.0}%",
            number_at(payload, &["rate_limits", "seven_day", "used_percentage"])
        ),
        "weekly-sonnet-usage" => format!(
            "{:.0}%",
            number_at(
                payload,
                &["rate_limits", "seven_day_sonnet", "used_percentage"]
            )
        ),
        "weekly-opus-usage" => format!(
            "{:.0}%",
            number_at(
                payload,
                &["rate_limits", "seven_day_opus", "used_percentage"]
            )
        ),
        "session-usage" | "block-timer" => format!(
            "{:.0}%",
            number_at(payload, &["rate_limits", "five_hour", "used_percentage"])
        ),
        "link" => item
            .metadata
            .as_ref()
            .and_then(|value| value.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("link")
            .to_string(),
        "remote-control-status" => {
            if value_at(payload, &["remote_control", "enabled"])
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "remote".to_string()
            } else {
                String::new()
            }
        }
        "voice-status" => {
            if value_at(payload, &["voice", "enabled"])
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "voice".to_string()
            } else {
                String::new()
            }
        }
        _ => item
            .metadata
            .as_ref()
            .and_then(|value| value.get("fallback"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    };
    let trimmed = raw.trim_end().to_string();
    if trimmed.is_empty() && item.widget_type != "separator" && item.widget_type != "flex-separator"
    {
        None
    } else {
        Some(trimmed)
    }
}

// 渲染组件原始文本后应用组件 ANSI 样式。
fn render_widget(item: &WidgetItem, payload: &Value) -> Option<String> {
    render_widget_raw(item, payload).map(|value| apply_style(&value, item))
}

// 将命名色、ANSI256 或六位十六进制色转换为前景或背景代码。
fn ansi_color(name: &str, background: bool) -> Option<String> {
    let mut normalized = name.to_string();
    if normalized.to_ascii_lowercase().starts_with("bg") {
        normalized = normalized[2..].to_string();
    }
    if let Some(value) = normalized.strip_prefix("ansi256:") {
        let code = value.parse::<u8>().ok()?;
        return Some(format!("{};5;{code}", if background { 48 } else { 38 }));
    }
    let hex = normalized
        .strip_prefix("hex:")
        .or_else(|| normalized.strip_prefix('#'));
    if let Some(value) =
        hex.filter(|value| value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        let r = u8::from_str_radix(&value[0..2], 16).ok()?;
        let g = u8::from_str_radix(&value[2..4], 16).ok()?;
        let b = u8::from_str_radix(&value[4..6], 16).ok()?;
        return Some(format!(
            "{};2;{r};{g};{b}",
            if background { 48 } else { 38 }
        ));
    }
    let code = match normalized.to_ascii_lowercase().as_str() {
        "black" => 30,
        "red" => 31,
        "green" => 32,
        "yellow" => 33,
        "blue" => 34,
        "magenta" => 35,
        "cyan" => 36,
        "white" => 37,
        "brightblack" | "gray" | "grey" => 90,
        "brightred" => 91,
        "brightgreen" => 92,
        "brightyellow" => 93,
        "brightblue" => 94,
        "brightmagenta" => 95,
        "brightcyan" => 96,
        "brightwhite" => 97,
        _ => return None,
    };
    Some((if background { code + 10 } else { code }).to_string())
}

// 按前景、背景及粗体配置包装 ANSI 文本段。
fn styled_segment(
    text: &str,
    foreground: Option<&str>,
    background: Option<&str>,
    bold: bool,
) -> String {
    let mut codes = Vec::new();
    if bold {
        codes.push("1".to_string());
    }
    if let Some(code) = foreground.and_then(|value| ansi_color(value, false)) {
        codes.push(code);
    }
    if let Some(code) = background.and_then(|value| ansi_color(value, true)) {
        codes.push(code);
    }
    if codes.is_empty() {
        text.to_string()
    } else {
        format!("\x1b[{}m{text}\x1b[0m", codes.join(";"))
    }
}

// 为组件文本添加粗体、暗淡及前景背景 ANSI 样式。
fn apply_style(text: &str, item: &WidgetItem) -> String {
    let mut codes = Vec::new();
    if item.bold.unwrap_or(false) {
        codes.push("1".to_string());
    }
    if item.dim.as_ref().and_then(Value::as_bool).unwrap_or(false) {
        codes.push("2".to_string());
    }
    if let Some(color) = item
        .color
        .as_deref()
        .and_then(|value| ansi_color(value, false))
    {
        codes.push(color);
    }
    if let Some(color) = item
        .background_color
        .as_deref()
        .and_then(|value| ansi_color(value, true))
    {
        codes.push(color);
    }
    if codes.is_empty() {
        text.to_string()
    } else {
        format!("\x1b[{}m{text}\x1b[0m", codes.join(";"))
    }
}

// 按语言获取组件标签，自定义文本、分隔符和 Git 分支不加标签。
fn preview_label(widget_type: &str, language: &str) -> Option<&'static str> {
    if matches!(
        widget_type,
        "custom-text" | "custom-symbol" | "separator" | "flex-separator" | "git-branch"
    ) {
        return None;
    }
    if language == "zh-CN" {
        match widget_type {
            "output-style" => return Some("风格"),
            "thinking-effort" => return Some("思考"),
            "tokens-total" => return Some("合计"),
            "context-bar" => return Some("上下文"),
            "session-cost" => return Some("费用"),
            _ => {}
        }
    }
    catalog()
        .into_iter()
        .find(|entry| entry.widget_type == widget_type)
        .map(|entry| {
            if language == "zh-CN" {
                entry.zh_name
            } else {
                entry.en_name
            }
        })
}

// 通过统一管线渲染普通或 Powerline 多行布局及本地化标签。
fn render_internal(
    settings: &StatuslineSettings,
    payload: &Value,
    preview_language: Option<&str>,
) -> Result<String, String> {
    validate_settings(settings)?;
    if settings.powerline.enabled {
        let mut rows: Vec<Vec<(&WidgetItem, String)>> = settings
            .lines
            .iter()
            .take(3)
            .map(|line| {
                line.iter()
                    .filter(|item| {
                        !matches!(item.widget_type.as_str(), "separator" | "flex-separator")
                    })
                    .filter_map(|item| {
                        let mut value = render_widget_raw(item, payload)?;
                        if let Some(label) = preview_language
                            .and_then(|language| preview_label(&item.widget_type, language))
                        {
                            value = format!("{label}: {value}");
                        }
                        Some((item, value))
                    })
                    .collect()
            })
            .collect();
        if settings.powerline.auto_align {
            let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
            for column in 0..columns {
                let width = rows
                    .iter()
                    .filter_map(|row| row.get(column).map(|(_, value)| value.chars().count()))
                    .max()
                    .unwrap_or(0);
                for row in &mut rows {
                    if let Some((_, value)) = row.get_mut(column) {
                        value.push_str(&" ".repeat(width.saturating_sub(value.chars().count())));
                    }
                }
            }
        }
        let theme = settings.powerline.theme.as_deref().unwrap_or("nord-aurora");
        let palette = powerline_theme(theme, settings.color_level);
        let mut global_index = 0usize;
        let mut rendered = Vec::new();
        for row in rows {
            if row.is_empty() {
                continue;
            }
            let mut text = String::new();
            let mut previous_bg: Option<String> = None;
            for (index, (item, value)) in row.iter().enumerate() {
                let theme_index = if settings.powerline.continue_theme_across_lines {
                    global_index
                } else {
                    index
                };
                let (fg, bg) = if theme == "custom" {
                    (item.color.as_deref(), item.background_color.as_deref())
                } else if let Some((fg, bg)) = palette {
                    (
                        Some(fg[theme_index % fg.len()]),
                        Some(bg[theme_index % bg.len()]),
                    )
                } else {
                    (item.color.as_deref(), item.background_color.as_deref())
                };
                if index == 0 {
                    if let Some(cap) = settings.powerline.start_caps.first() {
                        text.push_str(&styled_segment(cap, bg, None, false));
                    }
                } else {
                    let separator = settings
                        .powerline
                        .separators
                        .get((index - 1) % settings.powerline.separators.len().max(1))
                        .map(String::as_str)
                        .unwrap_or("\u{e0b0}");
                    let invert = settings
                        .powerline
                        .separator_invert_background
                        .get(
                            (index - 1)
                                % settings.powerline.separator_invert_background.len().max(1),
                        )
                        .copied()
                        .unwrap_or(false);
                    let rendered_separator = if invert {
                        styled_segment(separator, bg, previous_bg.as_deref(), false)
                    } else {
                        styled_segment(separator, previous_bg.as_deref(), bg, false)
                    };
                    text.push_str(&rendered_separator);
                }
                let left_padding = if index == 0 { "   " } else { " " };
                text.push_str(&styled_segment(
                    &format!("{left_padding}{value} "),
                    fg,
                    bg,
                    item.bold.unwrap_or(false),
                ));
                previous_bg = bg.map(str::to_string);
                global_index += 1;
            }
            if let Some(cap) = settings.powerline.end_caps.first() {
                text.push_str(&styled_segment(cap, previous_bg.as_deref(), None, false));
            }
            rendered.push(text);
            if !settings.powerline.continue_theme_across_lines {
                global_index = 0;
            }
        }
        return Ok(rendered.join("\n"));
    }
    let mut rendered = Vec::new();
    for line in settings.lines.iter().take(3) {
        let mut text = String::new();
        let mut pending_separator = false;
        for item in line {
            if item.widget_type == "separator" {
                pending_separator = true;
                continue;
            }
            if let Some(value) = render_widget(item, payload) {
                if pending_separator && !text.is_empty() {
                    text.push_str(settings.default_separator.as_deref().unwrap_or(" | "));
                }
                pending_separator = false;
                if settings.powerline.enabled
                    && !text.is_empty()
                    && item.widget_type != "flex-separator"
                {
                    text.push_str(
                        settings
                            .powerline
                            .separators
                            .first()
                            .map(String::as_str)
                            .unwrap_or("\u{e0b0}"),
                    );
                }
                if let Some(label) =
                    preview_language.and_then(|language| preview_label(&item.widget_type, language))
                {
                    text.push_str(label);
                    text.push_str(": ");
                }
                text.push_str(&value);
            }
        }
        if !text.is_empty() {
            rendered.push(text);
        }
    }
    Ok(rendered.join("\n"))
}

// 使用中文短标签渲染实际状态栏。
pub fn render(settings: &StatuslineSettings, payload: &Value) -> Result<String, String> {
    render_internal(settings, payload, Some("zh-CN"))
}

// 使用指定语言的标签通过共享管线渲染预览。
pub fn render_preview(
    settings: &StatuslineSettings,
    payload: &Value,
    language: &str,
) -> Result<String, String> {
    render_internal(settings, payload, Some(language))
}

// 从标准输入读取 JSON、加载设置并输出状态栏后以对应状态码退出。
pub fn run_and_exit() -> ! {
    let mut input = String::new();
    let result = io::stdin()
        .read_to_string(&mut input)
        .map_err(|err| err.to_string())
        .and_then(|_| serde_json::from_str::<Value>(&input).map_err(|err| err.to_string()))
        .and_then(|payload| load_settings().and_then(|settings| render(&settings, &payload)));
    match result {
        Ok(output) => {
            println!("{output}");
            std::process::exit(0);
        }
        Err(error) => {
            eprintln!("CLI-Manager statusline: {error}");
            std::process::exit(1);
        }
    }
}

// 将静态组件目录转换为可序列化条目列表。
pub fn catalog() -> Vec<WidgetCatalogEntry> {
    WIDGET_CATALOG
        .iter()
        .map(
            |&(widget_type, category, zh_name, en_name)| WidgetCatalogEntry {
                widget_type,
                category,
                zh_name,
                en_name,
            },
        )
        .collect()
}

const WIDGET_CATALOG: &[(&str, &str, &str, &str)] = &[
    ("model", "core", "模型", "Model"),
    ("output-style", "core", "输出风格", "Output Style"),
    ("thinking-effort", "core", "思考力度", "Thinking Effort"),
    ("vim-mode", "core", "Vim 模式", "Vim Mode"),
    ("voice-status", "core", "语音状态", "Voice Status"),
    (
        "remote-control-status",
        "core",
        "远程控制",
        "Remote Control",
    ),
    ("git-branch", "git", "Git 分支", "Git Branch"),
    ("git-changes", "git", "Git 变更", "Git Changes"),
    ("git-insertions", "git", "Git 新增", "Git Insertions"),
    ("git-deletions", "git", "Git 删除", "Git Deletions"),
    ("git-staged-files", "git", "已暂存文件", "Staged Files"),
    ("git-unstaged-files", "git", "未暂存文件", "Unstaged Files"),
    (
        "git-untracked-files",
        "git",
        "未跟踪文件",
        "Untracked Files",
    ),
    ("git-clean-status", "git", "Git 干净状态", "Git Clean"),
    ("git-root-dir", "git", "Git 根目录", "Git Root"),
    ("git-review", "git", "Git PR", "Git Review"),
    ("git-worktree", "git", "Git Worktree", "Git Worktree"),
    ("git-status", "git", "Git 状态", "Git Status"),
    ("git-staged", "git", "已暂存标记", "Staged Marker"),
    ("git-unstaged", "git", "未暂存标记", "Unstaged Marker"),
    ("git-untracked", "git", "未跟踪标记", "Untracked Marker"),
    ("git-ahead-behind", "git", "超前/滞后", "Ahead/Behind"),
    ("git-conflicts", "git", "Git 冲突", "Git Conflicts"),
    ("git-sha", "git", "Git SHA", "Git SHA"),
    ("git-origin-owner", "git", "Origin 所有者", "Origin Owner"),
    ("git-origin-repo", "git", "Origin 仓库", "Origin Repo"),
    (
        "git-origin-owner-repo",
        "git",
        "Origin 所有者/仓库",
        "Origin Owner/Repo",
    ),
    (
        "git-upstream-owner",
        "git",
        "Upstream 所有者",
        "Upstream Owner",
    ),
    ("git-upstream-repo", "git", "Upstream 仓库", "Upstream Repo"),
    (
        "git-upstream-owner-repo",
        "git",
        "Upstream 所有者/仓库",
        "Upstream Owner/Repo",
    ),
    ("git-is-fork", "git", "是否 Fork", "Is Fork"),
    ("jj-bookmarks", "jj", "Jujutsu 书签", "JJ Bookmarks"),
    ("jj-workspace", "jj", "Jujutsu 工作区", "JJ Workspace"),
    ("jj-root-dir", "jj", "Jujutsu 根目录", "JJ Root"),
    ("jj-changes", "jj", "Jujutsu 变更", "JJ Changes"),
    ("jj-insertions", "jj", "Jujutsu 新增", "JJ Insertions"),
    ("jj-deletions", "jj", "Jujutsu 删除", "JJ Deletions"),
    ("jj-description", "jj", "Jujutsu 描述", "JJ Description"),
    ("jj-revision", "jj", "Jujutsu 修订", "JJ Revision"),
    ("tokens-input", "tokens", "输入 Token", "Input Tokens"),
    ("tokens-output", "tokens", "输出 Token", "Output Tokens"),
    ("tokens-cached", "tokens", "缓存 Token", "Cached Tokens"),
    ("tokens-total", "tokens", "总 Token", "Total Tokens"),
    ("cache-hit-rate", "tokens", "缓存命中率", "Cache Hit Rate"),
    ("cache-read", "tokens", "缓存读取", "Cache Read"),
    ("cache-write", "tokens", "缓存写入", "Cache Write"),
    ("input-speed", "tokens", "输入速度", "Input Speed"),
    ("output-speed", "tokens", "输出速度", "Output Speed"),
    ("total-speed", "tokens", "总速度", "Total Speed"),
    ("context-length", "context", "上下文长度", "Context Length"),
    ("context-window", "context", "上下文窗口", "Context Window"),
    (
        "context-percentage",
        "context",
        "上下文百分比",
        "Context Percentage",
    ),
    (
        "context-percentage-usable",
        "context",
        "可用上下文",
        "Usable Context",
    ),
    ("context-bar", "context", "上下文进度条", "Context Bar"),
    ("session-clock", "session", "会话时钟", "Session Clock"),
    ("session-cost", "session", "会话费用", "Session Cost"),
    ("block-timer", "session", "时段用量", "Block Usage"),
    ("reset-timer", "session", "时段重置", "Reset Timer"),
    ("weekly-reset-timer", "session", "周重置", "Weekly Reset"),
    ("session-name", "session", "会话名称", "Session Name"),
    ("session-usage", "session", "会话用量", "Session Usage"),
    ("weekly-usage", "session", "周用量", "Weekly Usage"),
    (
        "weekly-sonnet-usage",
        "session",
        "周 Sonnet 用量",
        "Weekly Sonnet",
    ),
    (
        "weekly-opus-usage",
        "session",
        "周 Opus 用量",
        "Weekly Opus",
    ),
    (
        "extra-usage-utilization",
        "session",
        "超额用量占比",
        "Extra Usage",
    ),
    (
        "extra-usage-remaining",
        "session",
        "超额用量剩余",
        "Extra Remaining",
    ),
    ("extra-usage-used", "session", "超额用量已用", "Extra Used"),
    (
        "claude-session-id",
        "session",
        "Claude 会话 ID",
        "Claude Session ID",
    ),
    (
        "claude-account-email",
        "session",
        "Claude 账户邮箱",
        "Claude Account",
    ),
    ("skills", "session", "技能", "Skills"),
    (
        "compaction-counter",
        "session",
        "压缩计数",
        "Compaction Counter",
    ),
    (
        "current-working-dir",
        "environment",
        "当前目录",
        "Current Directory",
    ),
    (
        "terminal-width",
        "environment",
        "终端宽度",
        "Terminal Width",
    ),
    ("free-memory", "environment", "可用内存", "Free Memory"),
    (
        "worktree-mode",
        "environment",
        "Worktree 模式",
        "Worktree Mode",
    ),
    (
        "worktree-name",
        "environment",
        "Worktree 名称",
        "Worktree Name",
    ),
    (
        "worktree-branch",
        "environment",
        "Worktree 分支",
        "Worktree Branch",
    ),
    (
        "worktree-original-branch",
        "environment",
        "原始分支",
        "Original Branch",
    ),
    ("version", "custom", "版本", "Version"),
    ("custom-text", "custom", "自定义文本", "Custom Text"),
    ("custom-symbol", "custom", "自定义符号", "Custom Symbol"),
    ("custom-command", "custom", "自定义命令", "Custom Command"),
    ("link", "custom", "链接", "Link"),
    ("separator", "layout", "分隔符", "Separator"),
    ("flex-separator", "layout", "弹性分隔符", "Flex Separator"),
];

#[tauri::command]
// 暴露状态栏安装状态查询命令。
pub fn statusline_get_status() -> Result<StatuslineStatus, String> {
    get_status()
}
#[tauri::command]
// 暴露内部状态栏设置读取命令。
pub fn statusline_load_settings() -> Result<StatuslineSettings, String> {
    load_settings()
}
#[tauri::command]
// 保存传入设置并返回调用方载荷。
pub fn statusline_save_settings(
    settings: StatuslineSettings,
) -> Result<StatuslineSettings, String> {
    save_settings(&settings)?;
    Ok(settings)
}
#[tauri::command]
// 暴露旧 ccstatusline 配置导入命令。
pub fn statusline_import_legacy() -> Result<StatuslineSettings, String> {
    import_legacy()
}
#[tauri::command]
// 按指定语言渲染预览，未指定时使用英文。
pub fn statusline_render_preview(
    settings: StatuslineSettings,
    payload: Value,
    language: Option<String>,
) -> Result<String, String> {
    render_preview(&settings, &payload, language.as_deref().unwrap_or("en-US"))
}
#[tauri::command]
// 暴露 Claude 受管状态栏安装命令。
pub fn statusline_install(refresh_interval: Option<u8>) -> Result<StatuslineStatus, String> {
    install(refresh_interval)
}
#[tauri::command]
// 暴露仅移除受管状态栏的卸载命令。
pub fn statusline_uninstall() -> Result<StatuslineStatus, String> {
    uninstall()
}
#[tauri::command]
// 返回内置状态栏组件目录。
pub fn statusline_get_catalog() -> Vec<WidgetCatalogEntry> {
    catalog()
}

#[tauri::command]
// 调用当前平台字体发现流程查询 Powerline 可用性。
pub fn statusline_powerline_font_status() -> Result<PowerlineFontStatus, String> {
    detect_powerline_font()
}

#[tauri::command]
// 响应显式安装请求写入并激活内置 Powerline 字体。
pub fn statusline_powerline_install_fonts() -> Result<PowerlineFontInstallResult, String> {
    install_powerline_fonts()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    // 验证内置默认状态栏设置通过校验。
    fn default_settings_are_valid() {
        validate_settings(&StatuslineSettings::default()).unwrap();
    }
    #[test]
    // 验证旧 git-pr 组件在解析时升级为 git-review。
    fn legacy_git_pr_is_upgraded() {
        let settings =
            parse_settings(r#"{"lines":[[{"id":"1","type":"git-pr"}]],"version":1}"#).unwrap();
        assert_eq!(settings.lines[0][0].widget_type, "git-review");
    }
    #[test]
    // 验证状态栏模型和输入 Token 来自传入载荷。
    fn render_uses_payload() {
        let settings = StatuslineSettings {
            lines: vec![vec![
                widget("1", "model", None),
                widget("2", "separator", None),
                widget("3", "tokens-input", None),
            ]],
            ..Default::default()
        };
        let output = render(&settings, &json!({"model":{"display_name":"Opus"},"context_window":{"current_usage":{"input_tokens":1200}}})).unwrap();
        assert!(output.contains("Opus"));
        assert!(output.contains("1.2k"));
    }
    #[test]
    // 验证预览 Git 信息保持在第二行并包含各类变更数。
    fn render_keeps_preview_git_on_second_line() {
        let settings = StatuslineSettings {
            lines: vec![
                vec![widget("1", "model", None)],
                vec![
                    widget("2", "git-branch", None),
                    widget("3", "git-status", None),
                ],
            ],
            ..Default::default()
        };
        let output = render(&settings, &json!({
            "model": {"display_name": "Opus"},
            "preview_git": {"branch": "feature/statusline", "staged": 2, "unstaged": 4, "untracked": 1, "conflicts": 0}
        })).unwrap();
        let lines = output.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        assert!(lines[1].contains("feature/statusline"));
        assert!(lines[1].contains("+2 *4 ?1 !0"));
    }
    #[test]
    // 验证实际输出使用中文标签而英文预览使用英文标签。
    fn live_and_preview_outputs_include_localized_labels() {
        let settings = StatuslineSettings {
            lines: vec![vec![widget("1", "model", None)]],
            ..Default::default()
        };
        let payload = json!({"model":{"display_name":"Opus"}});
        assert!(render(&settings, &payload).unwrap().contains("模型: Opus"));
        assert!(render_preview(&settings, &payload, "en-US")
            .unwrap()
            .contains("Model: Opus"));
    }
    #[test]
    // 验证上下文条同时包含使用量、容量和百分比。
    fn context_bar_includes_usage_limit_and_percentage() {
        let settings = StatuslineSettings {
            lines: vec![vec![widget("1", "context-bar", None)]],
            ..Default::default()
        };
        let payload = json!({
            "context_window": {
                "context_window_size": 200000,
                "current_usage": {
                    "input_tokens": 25000,
                    "output_tokens": 5000,
                    "cache_read_input_tokens": 10000,
                    "cache_creation_input_tokens": 0
                }
            }
        });
        assert_eq!(
            render(&settings, &payload).unwrap(),
            "上下文: [███░░░░░░░░░░░░░] 40k/200k (20%)"
        );
    }
    #[test]
    // 验证 Git 分支使用分支符号且不添加重复标签。
    fn git_branch_uses_branch_symbol_without_extra_label() {
        let settings = StatuslineSettings {
            lines: vec![vec![widget("1", "git-branch", None)]],
            ..Default::default()
        };
        let payload = json!({"preview_git":{"branch":"master"}});
        assert_eq!(render(&settings, &payload).unwrap(), "⎇ master");
    }
    #[test]
    // 验证 ANSI256、TrueColor 及亮背景命名色转换。
    fn ansi_color_supports_extended_formats() {
        assert_eq!(
            ansi_color("ansi256:123", false).as_deref(),
            Some("38;5;123")
        );
        assert_eq!(
            ansi_color("hex:112233", true).as_deref(),
            Some("48;2;17;34;51")
        );
        assert_eq!(ansi_color("bgBrightRed", true).as_deref(), Some("101"));
        assert_eq!(ansi_color("hex:aéabc", false), None);
    }
    #[test]
    // 验证 Powerline 首段缩进、端帽和主题组件内容。
    fn powerline_renders_caps_and_theme() {
        let mut settings = StatuslineSettings {
            lines: vec![vec![
                widget("1", "model", None),
                widget("2", "thinking-effort", None),
            ]],
            ..Default::default()
        };
        settings.powerline.enabled = true;
        settings.powerline.theme = Some("nord".to_string());
        settings.powerline.start_caps = vec!["[".to_string()];
        settings.powerline.end_caps = vec!["]".to_string()];
        let output = render(
            &settings,
            &json!({"model":{"display_name":"Opus"},"effort":{"level":"high"}}),
        )
        .unwrap();
        assert!(output.contains('['));
        assert!(output.contains(']'));
        assert!(output.contains("   模型: Opus "));
        assert!(output.contains("high"));
    }
    #[test]
    // 验证 Powerline 主题按色彩级别生成对应 ANSI 序列。
    fn powerline_theme_respects_color_level() {
        let mut settings = StatuslineSettings {
            lines: vec![vec![widget("1", "model", None)]],
            ..Default::default()
        };
        settings.powerline.enabled = true;
        settings.powerline.theme = Some("nord".to_string());
        let payload = json!({"model":{"display_name":"Opus"}});
        settings.color_level = 1;
        assert!(render(&settings, &payload)
            .unwrap()
            .contains("\x1b[30;106m"));
        settings.color_level = 2;
        assert!(render(&settings, &payload)
            .unwrap()
            .contains("\x1b[38;5;16;48;5;73m"));
        settings.color_level = 3;
        assert!(render(&settings, &payload)
            .unwrap()
            .contains("\x1b[38;2;46;52;64;48;2;136;192;208m"));
    }
    #[test]
    // 验证常见 Powerline 字体名称识别并排除普通字体。
    fn detects_common_powerline_font_names() {
        assert!(looks_like_powerline_font("CaskaydiaCove NerdFont.ttf"));
        assert!(looks_like_powerline_font("Meslo LG S for Powerline.ttf"));
        assert!(!looks_like_powerline_font("Arial.ttf"));
    }
    #[test]
    // 验证字体选择优先内置符号字体而非粗体候选。
    fn prefers_bundled_powerline_symbol_font() {
        let fonts = vec![
            PathBuf::from("Meslo LG S Bold for Powerline.ttf"),
            PathBuf::from(BUNDLED_POWERLINE_FONT_NAME),
        ];
        assert_eq!(
            preferred_powerline_font(&fonts).and_then(Path::file_name),
            Some(std::ffi::OsStr::new(BUNDLED_POWERLINE_FONT_NAME)),
        );
    }
    #[test]
    // 从内置字体字节验证实际字体家族名称。
    fn bundled_powerline_font_has_expected_family() {
        let mut db = fontdb::Database::new();
        db.load_font_data(BUNDLED_POWERLINE_FONT.to_vec());
        assert!(db
            .faces()
            .flat_map(|face| &face.families)
            .any(|(family, _)| family == "Symbols Nerd Font Mono"));
    }
}
