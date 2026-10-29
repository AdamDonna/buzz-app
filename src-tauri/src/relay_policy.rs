//! Build-owned relay trust. User preferences and process runtime cannot override it.
use crate::enterprise_relay_url::canonical_enterprise_relay_url;

#[derive(Debug)]
pub(crate) struct RelayPolicy {
    pinned: String,
    allowlist: Vec<String>,
}

/// A policy entry is `host` or `host:port`; it matches both `wss://` and `https://`.
fn host_origin(entry: &serde_json::Value) -> Option<String> {
    let host = entry.as_str()?;
    if host.contains('/') {
        return None;
    }
    canonical_enterprise_relay_url(&format!("wss://{host}")).ok()
}

impl RelayPolicy {
    pub(crate) fn parse(raw: Option<&str>) -> Result<Option<Self>, String> {
        let Some(raw) = raw else { return Ok(None) };
        let parse = || -> Option<Self> {
            let value: serde_json::Value = serde_json::from_str(raw).ok()?;
            let object = value.as_object()?;
            if object.len() != 2 {
                return None;
            }
            let pinned = host_origin(object.get("pinned")?)?;
            let allowlist = object
                .get("allowlist")?
                .as_array()?
                .iter()
                .map(host_origin)
                .collect::<Option<Vec<_>>>()?;
            Some(Self { pinned, allowlist })
        };
        parse().map(Some).ok_or_else(|| "BUZZ_BUILD_RELAY_POLICY must be a JSON object with a pinned relay host and an allowlist array of relay hosts, each as host or host:port.".into())
    }

    pub(crate) fn check(&self, value: &str) -> Result<(), String> {
        let origin = canonical_enterprise_relay_url(value)?;
        if origin == self.pinned || self.allowlist.contains(&origin) {
            Ok(())
        } else {
            Err("This relay is not allowed by this build's relay policy.".into())
        }
    }

    pub(crate) fn removable(&self, value: &str) -> Result<(), String> {
        self.check(value)?;
        if canonical_enterprise_relay_url(value)? == self.pinned {
            Err("The pinned relay cannot be removed from this build.".into())
        } else {
            Ok(())
        }
    }
}

fn configured() -> &'static Option<RelayPolicy> {
    static POLICY: std::sync::OnceLock<Option<RelayPolicy>> = std::sync::OnceLock::new();
    POLICY.get_or_init(|| {
        RelayPolicy::parse(option_env!("BUZZ_BUILD_RELAY_POLICY"))
            .expect("Invalid compiled relay policy")
    })
}

pub(crate) fn allowed(value: &str) -> Result<(), String> {
    configured()
        .as_ref()
        .map_or(Ok(()), |policy| policy.check(value))
}

pub(crate) fn removable(value: &str) -> Result<(), String> {
    configured()
        .as_ref()
        .map_or(Ok(()), |policy| policy.removable(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_policy_is_unrestricted_and_malformed_policy_fails() {
        assert!(RelayPolicy::parse(None).unwrap().is_none());
        for raw in [
            "",
            "{}",
            r#"{"pinned":"relay.example"}"#,
            r#"{"pinned":"relay.example","allowlist":[42]}"#,
            r#"{"pinned":"wss://relay.example","allowlist":[]}"#,
            r#"{"pinned":"relay.example","allowlist":["other.example/path"]}"#,
        ] {
            assert!(RelayPolicy::parse(Some(raw)).is_err(), "{raw}");
        }
    }

    #[test]
    fn matches_hosts_on_either_scheme_and_exact_port() {
        let policy = RelayPolicy::parse(Some(
            r#"{"pinned":"relay.example","allowlist":["other.example:8443"]}"#,
        ))
        .unwrap()
        .unwrap();
        for allowed in [
            "wss://relay.example",
            "https://RELAY.example:443/",
            "wss://other.example:8443",
            "https://other.example:8443",
        ] {
            assert!(policy.check(allowed).is_ok(), "{allowed}");
        }
        for blocked in [
            "wss://other.example",
            "wss://relay.example:8443",
            "wss://sub.relay.example",
            "wss://relay.example.evil",
        ] {
            assert!(policy.check(blocked).is_err(), "{blocked}");
        }
        assert!(policy.removable("wss://other.example:8443").is_ok());
        assert!(policy
            .removable("https://relay.example")
            .unwrap_err()
            .contains("pinned relay"));
    }
}
