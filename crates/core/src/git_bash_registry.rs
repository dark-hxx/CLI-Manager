use std::path::PathBuf;

/// 从 `reg query` 文本中提取首个 REG_ 类型后的非空值。
pub fn parse_reg_value(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        let value_start = trimmed.find("REG_")?;
        let value = trimmed[value_start..].split_once(char::is_whitespace)?.1;
        let cleaned = clean_registry_path(value.trim());
        (!cleaned.is_empty()).then_some(cleaned)
    })
}

/// 提取 InstallLocation 行并保持注册表输出顺序。
pub fn install_locations_from_reg_output(output: &str) -> Vec<PathBuf> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if !trimmed.starts_with("InstallLocation") {
                return None;
            }
            parse_reg_value(trimmed).map(PathBuf::from)
        })
        .collect()
}

/// 去除外层引号及约定的图标索引后缀，不执行变量展开或路径解析。
pub fn clean_registry_path(value: &str) -> String {
    let trimmed = value.trim().trim_matches('"');
    let without_icon_index = trimmed
        .strip_suffix(",0")
        .or_else(|| trimmed.strip_suffix(",-0"))
        .unwrap_or(trimmed);
    without_icon_index.trim_matches('"').to_string()
}

/// 从安装根目录生成 bin 与 usr/bin 两个 Bash 候选。
pub fn git_bash_candidates_from_install_dir(dir: PathBuf) -> Vec<PathBuf> {
    vec![
        dir.join("bin").join("bash.exe"),
        dir.join("usr").join("bin").join("bash.exe"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_cleans_reg_values() {
        assert_eq!(
            parse_reg_value("    (Default)    REG_SZ    \"C:\\\\Git\\bin\\bash.exe\",0"),
            Some("C:\\\\Git\\bin\\bash.exe".into())
        );
        assert_eq!(clean_registry_path("\"C:\\Git\\,-0\""), "C:\\Git\\");
    }

    #[test]
    fn extracts_install_locations_in_order() {
        let output = "InstallLocation    REG_SZ    C:\\Git\nOther REG_SZ ignored\nInstallLocation REG_SZ D:\\Git";
        assert_eq!(
            install_locations_from_reg_output(output),
            vec![PathBuf::from("C:\\Git"), PathBuf::from("D:\\Git")]
        );
        assert_eq!(
            git_bash_candidates_from_install_dir(PathBuf::from("C:\\Git")),
            vec![
                PathBuf::from("C:\\Git\\bin\\bash.exe"),
                PathBuf::from("C:\\Git\\usr\\bin\\bash.exe")
            ]
        );
    }
}
