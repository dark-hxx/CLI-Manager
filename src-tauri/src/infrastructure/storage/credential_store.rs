use std::sync::OnceLock;

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
// 惰性安装当前平台的默认密钥库，成功或失败结果都会缓存，后续调用不重新尝试初始化。
fn initialize_store() -> Result<(), String> {
    static STORE_INIT: OnceLock<Result<(), String>> = OnceLock::new();
    STORE_INIT
        .get_or_init(|| {
            #[cfg(target_os = "windows")]
            let store = windows_native_keyring_store::Store::new()
                .map_err(|err| format!("initialize Windows credential store failed: {err}"))?;
            #[cfg(target_os = "macos")]
            let store = apple_native_keyring_store::keychain::Store::new()
                .map_err(|err| format!("initialize macOS Keychain failed: {err}"))?;
            #[cfg(target_os = "linux")]
            let store = zbus_secret_service_keyring_store::Store::new()
                .map_err(|err| format!("initialize Linux Secret Service failed: {err}"))?;
            keyring_core::set_default_store(store);
            Ok(())
        })
        .clone()
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
// 在 CLI-Manager 服务名下创建账户条目句柄，Linux 额外指定 target；本身不读取密码。
pub(crate) fn entry(account: &str) -> Result<keyring_core::Entry, String> {
    initialize_store()?;
    #[cfg(target_os = "linux")]
    let entry = {
        let modifiers = std::collections::HashMap::from([("target", "CLI-Manager")]);
        keyring_core::Entry::new_with_modifiers("CLI-Manager", account, &modifiers)
    };
    #[cfg(not(target_os = "linux"))]
    let entry = keyring_core::Entry::new("CLI-Manager", account);
    entry.map_err(|err| format!("create credential entry failed: {err}"))
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
// 将值保存到系统密钥库对应账户，初始化或写入失败均向调用方返回上下文错误。
pub(crate) fn set(account: &str, value: &str) -> Result<(), String> {
    entry(account)?
        .set_password(value)
        .map_err(|err| format!("save credential failed: {err}"))
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
// 读取账户密码，仅条目不存在映射为 None；权限、服务及其他读取错误不伪装成缺失。
pub(crate) fn get(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("read credential failed: {err}")),
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
// 删除指定账户凭据，已不存在视为成功，其余失败保留为错误。
pub(crate) fn delete(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("delete credential failed: {err}")),
    }
}
