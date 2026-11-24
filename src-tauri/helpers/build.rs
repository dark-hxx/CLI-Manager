#[cfg(target_os = "windows")]
fn main() {
    // build script 的 cfg 描述宿主机；链接参数须按 Cargo 的实际目标选择。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        configure_msvc_runtime();
    }

    for (binary, display_name) in [
        ("cli-manager-daemon", "cli-manager-daemon"),
        ("cli-manager-web-daemon", "cli-manager-web-daemon"),
        ("cli-manager-codex-proxy", "cli-manager-codex-proxy"),
    ] {
        let resource_path = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap())
            .join(format!("{binary}.rc"));
        let resource = format!(
            r#"1 VERSIONINFO
FILEVERSION 1,5,2,0
PRODUCTVERSION 1,5,2,0
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "CLI-Manager"
      VALUE "FileDescription", "{display_name}"
      VALUE "FileVersion", "1.5.2"
      VALUE "InternalName", "{binary}.exe"
      VALUE "OriginalFilename", "{binary}.exe"
      VALUE "ProductName", "{display_name}"
      VALUE "ProductVersion", "1.5.2"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#
        );
        std::fs::write(&resource_path, resource).expect("failed to write Windows version resource");
        embed_resource::compile_for(&resource_path, [binary], embed_resource::NONE)
            .manifest_optional()
            .unwrap_or_else(|error| {
                panic!("failed to compile Windows resource for {binary}: {error}")
            });
    }
}

#[cfg(target_os = "windows")]
fn configure_msvc_runtime() {
    // tauri-build 2.5.6 的 native 搜索路径会传到依赖方，包含占位 msvcrt.lib；
    // Cargo 不会把主库的 rustc-link-arg 传给独立 helper，须在最终二进制处
    // 选择同一套静态 VCRuntime + 动态 UCRT，避免占位库遮住正常 CRT。
    for argument in [
        "/NODEFAULTLIB:libvcruntimed.lib",
        "/NODEFAULTLIB:vcruntime.lib",
        "/NODEFAULTLIB:vcruntimed.lib",
        "/NODEFAULTLIB:libcmtd.lib",
        "/NODEFAULTLIB:msvcrt.lib",
        "/NODEFAULTLIB:msvcrtd.lib",
        "/NODEFAULTLIB:libucrt.lib",
        "/NODEFAULTLIB:libucrtd.lib",
        "/DEFAULTLIB:libcmt.lib",
        "/DEFAULTLIB:libvcruntime.lib",
        "/DEFAULTLIB:ucrt.lib",
    ] {
        println!("cargo:rustc-link-arg-bins={argument}");
    }
}

#[cfg(not(target_os = "windows"))]
fn main() {}
