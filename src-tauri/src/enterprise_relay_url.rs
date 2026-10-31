use url::Url;

// The app uses only canonicalization; build.rs and tests parse the allowlist.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn parse_enterprise_relay_allowlist(raw: &str) -> Result<Vec<String>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("BUZZ_BUILD_ENTERPRISE_AUTH_RELAYS must not be empty when set".into());
    }
    raw.split(',')
        .enumerate()
        .map(|(index, value)| {
            let value = value.trim();
            if value.is_empty() {
                return Err(format!(
                    "BUZZ_BUILD_ENTERPRISE_AUTH_RELAYS entry {} must not be empty",
                    index + 1
                ));
            }
            canonical_enterprise_relay_url(value)
        })
        .collect()
}

pub(crate) fn canonical_enterprise_relay_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let Some((raw_scheme, authority_and_path)) = raw.split_once("://") else {
        return Err("Enterprise relay URL must be a secure root origin".into());
    };
    if !matches!(raw_scheme.to_ascii_lowercase().as_str(), "https" | "wss") {
        return Err("Enterprise relay URL must use https or wss".into());
    }
    if raw.encode_utf16().count() > 2048
        || raw
            .chars()
            .any(|character| character.is_whitespace() || character == '\\')
    {
        return Err("Enterprise relay URL must be a secure root origin".into());
    }
    let authority_end = authority_and_path
        .find(['/', '?', '#'])
        .unwrap_or(authority_and_path.len());
    let authority = &authority_and_path[..authority_end];
    let suffix = &authority_and_path[authority_end..];
    if authority.is_empty() || authority.contains('@') || (!suffix.is_empty() && suffix != "/") {
        return Err("Enterprise relay URL must be a secure root origin".into());
    }

    let mut url = Url::parse(raw).map_err(|_| "Invalid enterprise relay URL")?;
    let scheme = "wss";
    url.set_scheme(scheme)
        .map_err(|_| "Could not normalize enterprise relay URL")?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Enterprise relay URL must not contain credentials or query data".into());
    }
    let dotted_host = match url.host() {
        Some(url::Host::Domain(host)) => host.strip_suffix('.').map(str::to_owned),
        _ => None,
    };
    if let Some(host) = dotted_host {
        if host.is_empty() || host.ends_with('.') {
            return Err("Enterprise relay URL has an invalid host".into());
        }
        url.set_host(Some(&host))
            .map_err(|_| "Could not normalize enterprise relay URL")?;
    }
    if url.port() == Some(443) {
        url.set_port(None)
            .map_err(|_| "Could not normalize enterprise relay URL")?;
    }
    url.set_path("/");
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_secure_relay_origin() {
        assert_eq!(
            canonical_enterprise_relay_url(" https://relay.example:443/ ").unwrap(),
            "wss://relay.example/"
        );
        assert_eq!(
            canonical_enterprise_relay_url("WSS://EXAMPLE.com.").unwrap(),
            "wss://example.com/"
        );
        assert_eq!(
            canonical_enterprise_relay_url("https://[2001:DB8::1]:443/").unwrap(),
            "wss://[2001:db8::1]/"
        );
        assert_eq!(
            canonical_enterprise_relay_url("https://bücher.example/").unwrap(),
            "wss://xn--bcher-kva.example/"
        );
    }

    #[test]
    fn rejects_non_origin_relay_values() {
        for value in [
            "ws://relay.example",
            "http://relay.example",
            "wss://user@relay.example",
            "wss://relay.example?tenant=one",
            "wss://relay.example#tenant",
            "wss://relay.example/path",
            "wss://relay.example/../",
            "wss://relay.example/%2e/",
            "wss://relay.example//",
            "wss://relay.example\\@evil.example",
            "wss://relay.example\n.evil.example",
            "file://relay.example",
        ] {
            assert!(canonical_enterprise_relay_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn rejects_empty_allowlist_entries() {
        assert!(parse_enterprise_relay_allowlist("wss://relay.example,").is_err());
    }
}
