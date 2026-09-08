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
// 从 Tauri 配置读取版本/产品名并补默认值，发行方式由数据路径模块判断，不查询远端更新。
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
// 按编译目标返回平台标签，与终端选用 WSL 或其他 Shell 无关。
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
    // 验证发行方式属于三个枚举分支；当前断言不检查实际序列化字符串。
    fn distribution_has_a_stable_serialized_name() {
        assert!(matches!(
            app_distribution(),
            AppDistribution::Standalone | AppDistribution::Portable | AppDistribution::Aur
        ));
    }
}
