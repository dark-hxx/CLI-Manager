// 对空串、空白或引号参数加双引号，按引号前及尾部位置倍增反斜杠；不是 CMD/PowerShell 脚本转义器。
pub(crate) fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.bytes().any(|byte| matches!(byte, b' ' | b'\t' | b'"')) {
        return arg.to_string();
    }
    let mut quoted = String::from("\"");
    let mut slashes = 0usize;
    for ch in arg.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            quoted.push_str(&"\\".repeat(slashes * 2 + 1));
            quoted.push('"');
            slashes = 0;
            continue;
        }
        quoted.push_str(&"\\".repeat(slashes));
        slashes = 0;
        quoted.push(ch);
    }
    quoted.push_str(&"\\".repeat(slashes * 2));
    quoted.push('"');
    quoted
}
