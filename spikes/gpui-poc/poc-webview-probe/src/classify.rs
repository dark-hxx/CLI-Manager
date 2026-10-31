use serde_json::{json, Value};

pub fn classify(hresult: i32, version: Option<&str>, minimum_major: u32) -> Value {
    let (availability, reason) = if hresult < 0 {
        if hresult as u32 == 0x80070002 {
            ("Missing", "runtime_not_found")
        } else {
            ("Failed", "version_api_failed")
        }
    } else {
        match version {
            None => ("Missing", "null_version"),
            Some(value) => match parse_version(value) {
                None => ("Failed", "invalid_version"),
                Some(parts) if parts == [0; 4] => ("Missing", "zero_version"),
                Some(parts) if parts[0] < minimum_major => {
                    ("OutdatedCandidate", "below_explicit_minimum")
                }
                Some(_) => ("AvailableCandidate", "environment_creation_not_tested"),
            },
        }
    };
    json!({"availability": availability, "reason": reason,
        "hresult": format!("0x{:08X}", hresult as u32), "version": version,
        "minimumMajor": minimum_major, "environmentCreationTested": false,
        "policyVerified": false})
}

fn parse_version(value: &str) -> Option<[u32; 4]> {
    let mut words = value.split_whitespace();
    let raw = words.next()?;
    if let Some(channel) = words.next() {
        if !["beta", "dev", "canary"].contains(&channel.to_ascii_lowercase().as_str())
            || words.next().is_some()
        {
            return None;
        }
    }
    let parts: Vec<_> = raw.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut result = [0; 4];
    for (target, part) in result.iter_mut().zip(parts) {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *target = part.parse().ok()?;
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn successful_api_is_only_a_candidate_even_above_threshold() {
        let result = classify(0, Some("156.0.4314.50"), 100);
        assert_eq!(result["availability"], "AvailableCandidate");
        assert_eq!(result["environmentCreationTested"], false);
        assert_eq!(result["policyVerified"], false);
    }

    #[test]
    fn runtime_missing_and_access_denied_are_distinct() {
        assert_eq!(
            classify(0x80070002u32 as i32, None, 1)["availability"],
            "Missing"
        );
        // Even a returned/stale version cannot override an API failure.
        assert_eq!(
            classify(0x80070005u32 as i32, Some("156.0.1.2"), 1)["availability"],
            "Failed"
        );
    }

    #[test]
    fn threshold_is_explicit_and_does_not_simulate_an_old_runtime() {
        assert_eq!(
            classify(0, Some("156.0.1.2"), 157)["availability"],
            "OutdatedCandidate"
        );
        assert_eq!(
            classify(0, Some("156.0.1.2"), 156)["availability"],
            "AvailableCandidate"
        );
    }

    #[test]
    fn absent_zero_malformed_and_preview_versions() {
        for version in [None, Some("0.0.0.0")] {
            assert_eq!(classify(0, version, 1)["availability"], "Missing");
        }
        for version in ["", "156", "156.0.1.x", "+156.0.1.2", "156.0.1.2 unknown"] {
            assert_eq!(classify(0, Some(version), 1)["availability"], "Failed");
        }
        for channel in ["beta", "Dev", "Canary"] {
            assert_eq!(
                classify(0, Some(&format!("156.0.1.2 {channel}")), 1)["availability"],
                "AvailableCandidate"
            );
        }
    }
}
