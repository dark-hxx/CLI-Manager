/// Normalize listener addresses while delegating local-interface discovery to the host.
/// The predicate must only accept addresses that the host permits binding to.
pub fn normalize_listener_addresses(
    listen_addresses: &[String],
    mut is_local_unicast_address: impl FnMut(&str) -> bool,
) -> Result<Vec<String>, String> {
    if listen_addresses.is_empty() {
        return Err("routing_listen_address_invalid".to_string());
    }
    let mut normalized = Vec::with_capacity(listen_addresses.len());
    for address in listen_addresses {
        let address = address.trim();
        if !matches!(address, "127.0.0.1" | "::1" | "localhost")
            && !is_local_unicast_address(address)
        {
            return Err("routing_listen_address_invalid".to_string());
        }
        if !normalized.iter().any(|item| item == address) {
            normalized.push(address.to_string());
        }
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_trims_and_deduplicates_without_platform_lookup() {
        let addresses = [" localhost ", "::1", "localhost", "127.0.0.1"].map(String::from);
        assert_eq!(
            normalize_listener_addresses(&addresses, |_| panic!("unexpected lookup")).unwrap(),
            ["localhost", "::1", "127.0.0.1"]
        );
    }

    #[test]
    fn delegates_non_loopback_and_preserves_order() {
        let addresses = [" 192.0.2.1 ", "localhost", "192.0.2.1"].map(String::from);
        let mut queries = Vec::new();
        let result = normalize_listener_addresses(&addresses, |address| {
            queries.push(address.to_string());
            address == "192.0.2.1"
        })
        .unwrap();
        assert_eq!(result, ["192.0.2.1", "localhost"]);
        assert_eq!(queries, ["192.0.2.1", "192.0.2.1"]);
    }

    #[test]
    fn rejects_empty_list_and_host_rejected_addresses() {
        assert_eq!(
            normalize_listener_addresses(&[], |_| false).unwrap_err(),
            "routing_listen_address_invalid"
        );
        for value in ["", "0.0.0.0", "::", "example.com", "192.0.2.2"] {
            assert_eq!(
                normalize_listener_addresses(&[value.to_string()], |_| false).unwrap_err(),
                "routing_listen_address_invalid"
            );
        }
    }
}
