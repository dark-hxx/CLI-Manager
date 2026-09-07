use crate::app_paths;
use serde::Serialize;

/// 应用版本信息
#[derive(Serialize)]
pub struct AppVersion {
    pub version: String,
    pub name: String,
    pub distribution: String,
}

/// 获取应用版本号
#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> AppVersion {
    let config = app.config();
    AppVersion {
        version: config
            .version
            .clone()
            .unwrap_or_else(|| "unknown".to_string()),
        name: config
            .product_name
            .clone()
            .unwrap_or_else(|| "CLI-Manager".to_string()),
        distribution: app_paths::app_distribution().as_str().to_string(),
    }
}

/// 获取当前操作系统平台（"windows" / "macos" / "linux" / "unknown"）
#[tauri::command]
pub fn get_os_platform() -> String {
    #[cfg(target_os = "windows")]
    {
        "windows".to_string()
    }
    #[cfg(target_os = "macos")]
    {
        "macos".to_string()
    }
    #[cfg(target_os = "linux")]
    {
        "linux".to_string()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unknown".to_string()
    }
}

#[cfg(test)]
mod tests {
    use crate::app_paths::{app_distribution, AppDistribution};

    #[test]
    fn distribution_has_a_stable_serialized_name() {
        assert!(matches!(
            app_distribution(),
            AppDistribution::Standalone | AppDistribution::Portable | AppDistribution::Aur
        ));
    }
}
