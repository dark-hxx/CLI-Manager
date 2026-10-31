pub const FALLBACK_PORT_START: u16 = 15_721;
pub const FALLBACK_PORT_END: u16 = 15_799;
pub const MIN_PORT: u16 = 1_024;

pub fn candidate_ports(
    preferred_port: u16,
    last_actual_port: Option<u16>,
) -> Result<Vec<u16>, String> {
    if preferred_port < MIN_PORT || last_actual_port.is_some_and(|port| port < MIN_PORT) {
        return Err("routing_port_invalid".to_string());
    }

    let mut candidates =
        Vec::with_capacity(2 + usize::from(FALLBACK_PORT_END - FALLBACK_PORT_START));
    let mut add = |port: u16| {
        if !candidates.contains(&port) {
            candidates.push(port);
        }
    };
    if let Some(port) = last_actual_port {
        add(port);
    }
    add(preferred_port);
    for port in FALLBACK_PORT_START..=FALLBACK_PORT_END {
        add(port);
    }
    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_order_is_stable_and_deduplicated() {
        assert_eq!(
            &candidate_ports(15_721, Some(15_722)).unwrap()[..4],
            [15_722, 15_721, 15_723, 15_724]
        );
        assert_eq!(
            &candidate_ports(15_721, Some(15_721)).unwrap()[..3],
            [15_721, 15_722, 15_723]
        );
    }

    #[test]
    fn rejects_privileged_ports() {
        assert_eq!(
            candidate_ports(0, None).unwrap_err(),
            "routing_port_invalid"
        );
        assert_eq!(
            candidate_ports(15_721, Some(1)).unwrap_err(),
            "routing_port_invalid"
        );
    }
}
