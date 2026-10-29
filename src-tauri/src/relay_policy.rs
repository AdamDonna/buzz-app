//! Build-owned relay trust. User preferences and process runtime cannot override it.
use crate::enterprise_relay_url::canonical_enterprise_relay_url;

#[derive(Debug)]
pub(crate) struct RelayPolicy {
    pinned: String,
    allowlist: Vec<String>,
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
            let pinned = canonical_enterprise_relay_url(object.get("pinned")?.as_str()?).ok()?;
            let allowlist = object
                .get("allowlist")?
                .as_array()?
                .iter()
                .map(|entry| canonical_enterprise_relay_url(entry.as_str()?).ok())
                .collect::<Option<Vec<_>>>()?;
            Some(Self { pinned, allowlist })
        };
        parse().map(Some).ok_or_else(|| "BUZZ_BUILD_RELAY_POLICY must be a JSON object with a secure pinned relay URL and an allowlist array of secure relay URLs.".into())
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
    const POLICY: &str = r#"{"pinned":"wss://relay.example","allowlist":["wss://other.example:8443","https://bücher.example","https://[2001:db8::1]"]}"#;

    #[test]
    fn only_absent_policy_is_unrestricted() {
        assert!(RelayPolicy::parse(None).unwrap().is_none());
        for raw in [
            "",
            " ",
            "null",
            "{}",
            "[]",
            "not-json",
            r#"{"pinned":"wss://relay.example"}"#,
            r#"{"pinned":"wss://relay.example","allowlist":null}"#,
            r#"{"pinned":"wss://relay.example","allowlist":[42]}"#,
            r#"{"pinned":"wss://relay.example","allowlist":[],"enabled":false}"#,
        ] {
            let error = RelayPolicy::parse(Some(raw)).unwrap_err();
            assert!(error.starts_with("BUZZ_BUILD_RELAY_POLICY must"));
        }
    }

    #[test]
    fn matches_the_shared_origin_corpus() {
        let policy = RelayPolicy::parse(Some(POLICY)).unwrap().unwrap();
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/relay-policy-cases.json")).unwrap();
        for value in cases["allowed"].as_array().unwrap() {
            assert!(policy.check(value.as_str().unwrap()).is_ok(), "{value}");
        }
        for value in cases["blocked"]
            .as_array()
            .unwrap()
            .iter()
            .chain(cases["invalid"].as_array().unwrap())
        {
            assert!(policy.check(value.as_str().unwrap()).is_err(), "{value}");
        }
        for value in cases["invalid"].as_array().unwrap() {
            for config in [
                serde_json::json!({"pinned": value, "allowlist": []}),
                serde_json::json!({"pinned": "wss://relay.example", "allowlist": [value]}),
            ] {
                assert!(
                    RelayPolicy::parse(Some(&config.to_string())).is_err(),
                    "{config}"
                );
            }
        }
    }

    #[test]
    fn an_empty_allowlist_keeps_only_the_pin_and_never_allows_its_removal() {
        let policy = RelayPolicy::parse(Some(
            r#"{"pinned":"https://RELAY.example.:443/","allowlist":[]}"#,
        ))
        .unwrap()
        .unwrap();
        assert!(policy.check("wss://relay.example").is_ok());
        assert!(policy
            .removable("wss://relay.example")
            .unwrap_err()
            .contains("pinned relay"));
        assert!(policy.check("wss://other.example").is_err());
        let policy = RelayPolicy::parse(Some(POLICY)).unwrap().unwrap();
        assert!(policy.removable("wss://other.example:8443").is_ok());
    }
}
