#[cfg(target_os = "windows")]
fn main() {
    for (binary, display_name) in [
        ("cli-manager-daemon", "cli-manager-daemon"),
        ("cli-manager-web-daemon", "cli-manager-web-daemon"),
        ("cli-manager-codex-proxy", "cli-manager-codex-proxy"),
    ] {
        let resource_path = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap())
            .join(format!("{binary}.rc"));
        let resource = format!(
            r#"1 VERSIONINFO
FILEVERSION 1,4,4,0
PRODUCTVERSION 1,4,4,0
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "CLI-Manager"
      VALUE "FileDescription", "{display_name}"
      VALUE "FileVersion", "1.4.4"
      VALUE "InternalName", "{binary}.exe"
      VALUE "OriginalFilename", "{binary}.exe"
      VALUE "ProductName", "{display_name}"
      VALUE "ProductVersion", "1.4.4"
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
            .unwrap_or_else(|error| panic!("failed to compile Windows resource for {binary}: {error}"));
    }
}

#[cfg(not(target_os = "windows"))]
fn main() {}
