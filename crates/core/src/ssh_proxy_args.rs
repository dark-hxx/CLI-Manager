/// SSH 代理 helper 的借用参数；沿用首个同名选项的取值规则。
#[derive(Debug, PartialEq, Eq)]
pub struct ProxyArgs<'a> {
    pub proxy_type: &'a str,
    pub proxy_host: &'a str,
    pub proxy_port: u16,
    pub target_host: &'a str,
    pub target_port: u16,
}

impl<'a> ProxyArgs<'a> {
    /// 仅解析选项和非零 u16 端口，代理类型与握手校验由后续执行阶段负责。
    pub fn parse(args: &'a [String]) -> Result<Self, String> {
        Ok(Self {
            proxy_type: arg_value(args, "--type").ok_or("ssh_proxy_type_invalid")?,
            proxy_host: arg_value(args, "--proxy-host").ok_or("ssh_proxy_address_invalid")?,
            proxy_port: parse_port(args, "--proxy-port")?,
            target_host: arg_value(args, "--target-host").ok_or("ssh_proxy_target_invalid")?,
            target_port: parse_port(args, "--target-port")?,
        })
    }
}

fn arg_value<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == key)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

fn parse_port(args: &[String], key: &str) -> Result<u16, String> {
    arg_value(args, key)
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .ok_or_else(|| "ssh_proxy_address_invalid".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> Vec<String> {
        [
            "cli",
            "__ssh_proxy",
            "--type",
            "http",
            "--proxy-host",
            "::1",
            "--proxy-port",
            "8080",
            "--target-host",
            "example.com",
            "--target-port",
            "22",
        ]
        .into_iter()
        .map(String::from)
        .collect()
    }

    #[test]
    fn parses_addresses_and_preserves_first_option_precedence() {
        let mut args = args();
        args.extend(["--proxy-port".into(), "9090".into()]);
        let parsed = ProxyArgs::parse(&args).unwrap();
        assert_eq!(
            parsed,
            ProxyArgs {
                proxy_type: "http",
                proxy_host: "::1",
                proxy_port: 8080,
                target_host: "example.com",
                target_port: 22,
            }
        );
    }

    #[test]
    fn rejects_missing_and_invalid_ports() {
        for index in [7, 11] {
            for value in ["0", "65536", "-1", "invalid", ""] {
                let mut args = args();
                args[index] = value.into();
                assert_eq!(
                    ProxyArgs::parse(&args).unwrap_err(),
                    "ssh_proxy_address_invalid"
                );
            }
        }
        let args = args();
        assert_eq!(
            ProxyArgs::parse(&args[..11]).unwrap_err(),
            "ssh_proxy_address_invalid"
        );
        assert_eq!(ProxyArgs::parse(&[]).unwrap_err(), "ssh_proxy_type_invalid");
    }
}
