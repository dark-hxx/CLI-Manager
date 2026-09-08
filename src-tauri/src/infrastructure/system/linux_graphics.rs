use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MODE_ENV: &str = "CLI_MANAGER_LINUX_GRAPHICS_MODE";
const EXPLICIT_SYNC_ENV: &str = "__NV_DISABLE_EXPLICIT_SYNC";
const DMABUF_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const COMPOSITING_ENV: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LinuxGraphicsMode {
    Auto,
    System,
    DisableDmabuf,
    DisableCompositing,
}

impl LinuxGraphicsMode {
    // 裁剪并忽略大小写解析四种持久化模式，缺失或未知值返回 None 交由策略回退。
    fn parse(value: Option<&str>) -> Option<Self> {
        match value?.trim().to_ascii_lowercase().as_str() {
            "auto" => Some(Self::Auto),
            "system" => Some(Self::System),
            "disable-dmabuf" => Some(Self::DisableDmabuf),
            "disable-compositing" => Some(Self::DisableCompositing),
            _ => None,
        }
    }

    // 返回配置与诊断接口使用的稳定模式字符串。
    fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::System => "system",
            Self::DisableDmabuf => "disable-dmabuf",
            Self::DisableCompositing => "disable-compositing",
        }
    }
}

#[derive(Clone, Debug)]
struct GraphicsPolicyInput {
    is_linux: bool,
    wayland: bool,
    nvidia_proprietary: bool,
    mode_override: Option<String>,
    stored_mode: Option<String>,
    explicit_sync_env: Option<String>,
    dmabuf_env: Option<String>,
    compositing_env: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct EnvAssignment {
    key: &'static str,
    value: &'static str,
}

#[derive(Clone, Debug)]
struct GraphicsPolicyResolution {
    requested_mode: LinuxGraphicsMode,
    effective_mode: String,
    source: &'static str,
    assignments: Vec<EnvAssignment>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxGraphicsDiagnostics {
    pub platform: String,
    pub session_type: Option<String>,
    pub current_desktop: Option<String>,
    pub wayland: bool,
    pub nvidia_proprietary: bool,
    pub requested_mode: String,
    pub effective_mode: String,
    pub source: String,
    pub explicit_sync_disabled: bool,
    pub dmabuf_disabled: bool,
    pub compositing_disabled: bool,
}

static DIAGNOSTICS: OnceLock<LinuxGraphicsDiagnostics> = OnceLock::new();

// 仅将 1/true/yes/on 视为启用，忽略首尾空白和 ASCII 大小写。
fn env_enabled(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

// 纯计算请求模式、有效模式和待写环境项；标准开关的启用值优先，不覆写已存在的变量。
// 应用模式依次取环境覆盖、持久化设置和 auto；非 Linux 不生成环境修改。
fn resolve_policy(input: &GraphicsPolicyInput) -> GraphicsPolicyResolution {
    let override_mode = LinuxGraphicsMode::parse(input.mode_override.as_deref());
    let stored_mode = LinuxGraphicsMode::parse(input.stored_mode.as_deref());
    let (requested_mode, source) = if let Some(mode) = override_mode {
        (mode, "environment")
    } else if let Some(mode) = stored_mode {
        (mode, "settings")
    } else {
        (LinuxGraphicsMode::Auto, "default")
    };

    if !input.is_linux {
        return GraphicsPolicyResolution {
            requested_mode,
            effective_mode: "system".to_string(),
            source,
            assignments: Vec::new(),
        };
    }

    if env_enabled(input.compositing_env.as_deref()) {
        return GraphicsPolicyResolution {
            requested_mode,
            effective_mode: "disable-compositing".to_string(),
            source: "standard-environment",
            assignments: Vec::new(),
        };
    }
    if env_enabled(input.dmabuf_env.as_deref()) {
        return GraphicsPolicyResolution {
            requested_mode,
            effective_mode: "disable-dmabuf".to_string(),
            source: "standard-environment",
            assignments: Vec::new(),
        };
    }
    if env_enabled(input.explicit_sync_env.as_deref()) {
        return GraphicsPolicyResolution {
            requested_mode,
            effective_mode: "explicit-sync-workaround".to_string(),
            source: "standard-environment",
            assignments: Vec::new(),
        };
    }

    let mut assignments = Vec::new();
    let effective_mode = match requested_mode {
        LinuxGraphicsMode::System => "system",
        LinuxGraphicsMode::Auto => {
            if input.wayland && input.nvidia_proprietary {
                if input.explicit_sync_env.is_none() {
                    assignments.push(EnvAssignment {
                        key: EXPLICIT_SYNC_ENV,
                        value: "1",
                    });
                    "explicit-sync-workaround"
                } else {
                    "system"
                }
            } else {
                "system"
            }
        }
        LinuxGraphicsMode::DisableDmabuf => {
            if input.dmabuf_env.is_none() {
                assignments.push(EnvAssignment {
                    key: DMABUF_ENV,
                    value: "1",
                });
            }
            "disable-dmabuf"
        }
        LinuxGraphicsMode::DisableCompositing => {
            if input.compositing_env.is_none() {
                assignments.push(EnvAssignment {
                    key: COMPOSITING_ENV,
                    value: "1",
                });
            }
            "disable-compositing"
        }
    };

    GraphicsPolicyResolution {
        requested_mode,
        effective_mode: effective_mode.to_string(),
        source,
        assignments,
    }
}

// 从指定设置文件读取字符串模式；路径缺失、读取/JSON 解析失败均返回 None，不写回文件。
fn read_stored_mode(settings_path: Option<&Path>) -> Option<String> {
    let text = std::fs::read_to_string(settings_path?).ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()?
        .get("linuxGraphicsMode")?
        .as_str()
        .map(str::to_string)
}

// 根据编译目标而非运行环境字符串判断是否为 Linux 构建。
fn is_linux() -> bool {
    cfg!(target_os = "linux")
}

// XDG 会话类型为 wayland 或显示变量非空即视为 Wayland，不连接显示服务器验证。
fn detect_wayland(session_type: Option<&str>, wayland_display: Option<&str>) -> bool {
    session_type.is_some_and(|value| value.eq_ignore_ascii_case("wayland"))
        || wayland_display.is_some_and(|value| !value.trim().is_empty())
}

// 仅在 Linux 通过驱动版本文件或 GLX vendor 环境提示探测 NVIDIA 专有驱动，不启动外部命令。
fn detect_nvidia_proprietary() -> bool {
    if !is_linux() {
        return false;
    }
    Path::new("/proc/driver/nvidia/version").is_file()
        || std::env::var("__GLX_VENDOR_LIBRARY_NAME")
            .is_ok_and(|value| value.eq_ignore_ascii_case("nvidia"))
}

// 将编译目标转换为诊断接口的平台标签，未覆盖的平台返回 unknown。
fn current_platform() -> &'static str {
    if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "unknown"
    }
}

// 在 WebView/图形服务创建前读取设置与环境、应用兼容策略并缓存诊断；已有缓存则直接返回。
// 会修改进程环境，调用方应保持早期启动顺序，不将其用作运行时热切换入口。
pub fn initialize(settings_path: Option<PathBuf>) -> LinuxGraphicsDiagnostics {
    if let Some(existing) = DIAGNOSTICS.get() {
        return existing.clone();
    }

    let session_type = std::env::var("XDG_SESSION_TYPE").ok();
    let wayland_display = std::env::var("WAYLAND_DISPLAY").ok();
    let current_desktop = std::env::var("XDG_CURRENT_DESKTOP").ok();
    let wayland = detect_wayland(session_type.as_deref(), wayland_display.as_deref());
    let nvidia_proprietary = detect_nvidia_proprietary();
    let input = GraphicsPolicyInput {
        is_linux: is_linux(),
        wayland,
        nvidia_proprietary,
        mode_override: std::env::var(MODE_ENV).ok(),
        stored_mode: read_stored_mode(settings_path.as_deref()),
        explicit_sync_env: std::env::var(EXPLICIT_SYNC_ENV).ok(),
        dmabuf_env: std::env::var(DMABUF_ENV).ok(),
        compositing_env: std::env::var(COMPOSITING_ENV).ok(),
    };
    let resolution = resolve_policy(&input);
    for assignment in &resolution.assignments {
        std::env::set_var(assignment.key, assignment.value);
    }

    let diagnostics = LinuxGraphicsDiagnostics {
        platform: current_platform().to_string(),
        session_type,
        current_desktop,
        wayland,
        nvidia_proprietary,
        requested_mode: resolution.requested_mode.as_str().to_string(),
        effective_mode: resolution.effective_mode,
        source: resolution.source.to_string(),
        explicit_sync_disabled: env_enabled(std::env::var(EXPLICIT_SYNC_ENV).ok().as_deref()),
        dmabuf_disabled: env_enabled(std::env::var(DMABUF_ENV).ok().as_deref()),
        compositing_disabled: env_enabled(std::env::var(COMPOSITING_ENV).ok().as_deref()),
    };
    let _ = DIAGNOSTICS.set(diagnostics.clone());
    diagnostics
}

#[tauri::command]
// 返回启动时缓存的诊断快照；未初始化时给出明确的默认状态，不触发环境修改或重新探测。
pub fn app_get_graphics_diagnostics() -> LinuxGraphicsDiagnostics {
    DIAGNOSTICS
        .get()
        .cloned()
        .unwrap_or_else(|| LinuxGraphicsDiagnostics {
            platform: current_platform().to_string(),
            session_type: None,
            current_desktop: None,
            wayland: false,
            nvidia_proprietary: false,
            requested_mode: "auto".to_string(),
            effective_mode: "system".to_string(),
            source: "uninitialized".to_string(),
            explicit_sync_disabled: false,
            dmabuf_disabled: false,
            compositing_disabled: false,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    // 构造没有驱动/会话特征和外部覆盖项的 Linux 策略测试基线。
    fn base_input() -> GraphicsPolicyInput {
        GraphicsPolicyInput {
            is_linux: true,
            wayland: false,
            nvidia_proprietary: false,
            mode_override: None,
            stored_mode: None,
            explicit_sync_env: None,
            dmabuf_env: None,
            compositing_env: None,
        }
    }

    #[test]
    // 验证 auto 在 Wayland 与 NVIDIA 条件同时满足时仅添加显式同步兼容开关。
    fn auto_applies_explicit_sync_workaround_only_for_wayland_nvidia() {
        let mut input = base_input();
        input.wayland = true;
        input.nvidia_proprietary = true;

        let resolution = resolve_policy(&input);

        assert_eq!(resolution.effective_mode, "explicit-sync-workaround");
        assert_eq!(
            resolution.assignments,
            vec![EnvAssignment {
                key: EXPLICIT_SYNC_ENV,
                value: "1",
            }]
        );
    }

    #[test]
    // 验证显式 system 模式不会因 Wayland/NVIDIA 组合而自动新增兼容变量。
    fn system_mode_does_not_modify_environment() {
        let mut input = base_input();
        input.wayland = true;
        input.nvidia_proprietary = true;
        input.mode_override = Some("system".to_string());

        let resolution = resolve_policy(&input);

        assert_eq!(resolution.effective_mode, "system");
        assert!(resolution.assignments.is_empty());
    }

    #[test]
    // 验证应用环境模式优先于设置文件中的模式选择。
    fn explicit_override_beats_stored_mode() {
        let mut input = base_input();
        input.mode_override = Some("disable-dmabuf".to_string());
        input.stored_mode = Some("disable-compositing".to_string());

        let resolution = resolve_policy(&input);

        assert_eq!(resolution.requested_mode, LinuxGraphicsMode::DisableDmabuf);
        assert_eq!(resolution.source, "environment");
        assert_eq!(resolution.effective_mode, "disable-dmabuf");
    }

    #[test]
    // 验证已启用的 WebKit 标准变量优先于应用模式，不生成覆盖赋值。
    fn standard_environment_is_never_overwritten() {
        let mut input = base_input();
        input.mode_override = Some("disable-compositing".to_string());
        input.dmabuf_env = Some("1".to_string());

        let resolution = resolve_policy(&input);

        assert_eq!(resolution.source, "standard-environment");
        assert_eq!(resolution.effective_mode, "disable-dmabuf");
        assert!(resolution.assignments.is_empty());
    }

    #[test]
    // 验证用户显式设为 0 的标准变量也阻止 auto 将其改成启用。
    fn disabled_standard_variable_blocks_auto_overwrite() {
        let mut input = base_input();
        input.wayland = true;
        input.nvidia_proprietary = true;
        input.explicit_sync_env = Some("0".to_string());

        let resolution = resolve_policy(&input);

        assert_eq!(resolution.effective_mode, "system");
        assert!(resolution.assignments.is_empty());
    }

    #[test]
    // 验证非 Linux 保留请求模式用于诊断，但有效策略为 system 且没有环境赋值。
    fn non_linux_platform_never_applies_webkit_environment() {
        let mut input = base_input();
        input.is_linux = false;
        input.mode_override = Some("disable-compositing".to_string());

        let resolution = resolve_policy(&input);

        assert_eq!(
            resolution.requested_mode,
            LinuxGraphicsMode::DisableCompositing
        );
        assert_eq!(resolution.effective_mode, "system");
        assert!(resolution.assignments.is_empty());
    }
}
