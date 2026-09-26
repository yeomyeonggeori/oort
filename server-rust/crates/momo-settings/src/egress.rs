//! The provider egress policy (#2852): which addresses a provider base URL may
//! reach, decided on **IP addresses**, not on the text the operator typed.
//!
//! Two gates share this module:
//!
//! 1. **Write time** ([`crate::validated_base_url`]) refuses an authority that is
//!    itself a non-public address literal. A name cannot be decided there — what
//!    it resolves to on Tuesday says nothing about Wednesday.
//! 2. **Connect time** (the agent-worker's DNS resolver) resolves the name, runs
//!    [`EgressPolicy::check_resolved`] on **every** answer, and hands the HTTP
//!    client only the vetted addresses. The socket is opened to exactly the set
//!    that was checked, so a rebinding resolver has no second lookup to win.
//!
//! The one way past both gates is the operator's own opt-in that ADR-0004 증보
//! (2026-09-08) already defines: `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1` **and**
//! the host being physical loopback or an exact entry of
//! `AGENT_PROVIDER_LOCAL_HOSTS`. A self-hoster pointing at an in-house LLM lists
//! that host; nothing else opens.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Why a provider address was refused. The Display text carries no address and
/// no credential, so it is safe in a worker log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum EgressDenied {
    #[error("provider host resolves to a private, loopback, link-local, or metadata address")]
    NonPublicAddress,
    #[error("provider host did not resolve to any address")]
    NoAddress,
}

/// Is this address somewhere a provider call must never land unless the
/// operator opted in? Covers IPv4 special-purpose ranges, IPv6 local ranges,
/// and every IPv6 form that embeds an IPv4 address (mapped, compatible, NAT64,
/// 6to4), which is judged as the IPv4 address it carries.
pub fn is_non_public_ip(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => is_non_public_v4(v4),
        IpAddr::V6(v6) => is_non_public_v6(v6),
    }
}

fn is_non_public_v4(address: &Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    a == 0                                        // 0.0.0.0/8 "this network"
        || a == 10                                // 10/8 private
        || a == 127                               // 127/8 loopback
        || (a == 100 && (64..=127).contains(&b))  // 100.64/10 CGNAT
        || (a == 169 && b == 254)                 // 169.254/16 link-local + cloud metadata
        || (a == 172 && (16..=31).contains(&b))   // 172.16/12 private
        || (a == 192 && b == 0 && c == 0)         // 192.0.0/24 IETF protocol (incl. 192.0.0.192 OCI metadata)
        || (a == 192 && b == 0 && c == 2)         // TEST-NET-1
        || (a == 192 && b == 88 && c == 99)       // 6to4 relay anycast
        || (a == 192 && b == 168)                 // 192.168/16 private
        || (a == 198 && (b == 18 || b == 19))     // 198.18/15 benchmarking
        || (a == 198 && b == 51 && c == 100)      // TEST-NET-2
        || (a == 203 && b == 0 && c == 113)       // TEST-NET-3
        || a >= 224 // multicast, 240/4 reserved, broadcast
}

fn is_non_public_v6(address: &Ipv6Addr) -> bool {
    let bytes = address.octets();
    let segments = address.segments();
    let embedded_v4 =
        |at: usize| Ipv4Addr::new(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

    if address.is_unspecified() || address.is_loopback() {
        return true;
    }
    // ::ffff:a.b.c.d (mapped) — decide as the IPv4 address it is.
    if segments[..5] == [0, 0, 0, 0, 0] && segments[5] == 0xffff {
        return is_non_public_v4(&embedded_v4(12));
    }
    // ::ffff:0:a.b.c.d (IPv4-translated, RFC 2765/SIIT) — same.
    if segments[..4] == [0, 0, 0, 0] && segments[4] == 0xffff && segments[5] == 0 {
        return is_non_public_v4(&embedded_v4(12));
    }
    // ::a.b.c.d (deprecated IPv4-compatible) — same.
    if segments[..6] == [0, 0, 0, 0, 0, 0] {
        return is_non_public_v4(&embedded_v4(12));
    }
    // 64:ff9b::/96 NAT64 well-known prefix — the gateway forwards to the v4.
    if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return is_non_public_v4(&embedded_v4(12));
    }
    // 64:ff9b:1::/48 local-use NAT64.
    if segments[0] == 0x64 && segments[1] == 0xff9b && segments[2] == 1 {
        return true;
    }
    // 2002::/16 6to4 — the v4 sits in bits 16..48.
    if segments[0] == 0x2002 {
        return is_non_public_v4(&embedded_v4(2));
    }
    // 2001::/32 Teredo — tunnels to an address we cannot vet here.
    if segments[0] == 0x2001 && segments[1] == 0 {
        return true;
    }
    // 2001:20::/28 ORCHIDv2 — not routable.
    if segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0020 {
        return true;
    }
    // 2001:db8::/32 documentation.
    if segments[0] == 0x2001 && segments[1] == 0x0db8 {
        return true;
    }
    // 100::/64 discard-only.
    if segments[..4] == [0x0100, 0, 0, 0] {
        return true;
    }
    (segments[0] & 0xfe00) == 0xfc00      // fc00::/7 unique-local (incl. fd00:ec2::254 AWS metadata)
        || (segments[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
        || (segments[0] & 0xffc0) == 0xfec0 // fec0::/10 site-local (deprecated)
        || (segments[0] & 0xff00) == 0xff00 // ff00::/8 multicast
}

/// The WHATWG / `inet_aton` IPv4 spellings a URL parser normalises but
/// `Ipv4Addr::from_str` refuses: `2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1`.
/// Review N3 — without this the write gate stored them and only the worker's
/// precheck (after URL normalisation) refused them.
fn parse_loose_ipv4(host: &str) -> Option<Ipv4Addr> {
    let host = host.trim_end_matches('.');
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '.' || c == 'x' || c == 'X')
    {
        return None;
    }
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 4 {
        return None;
    }
    let mut numbers = Vec::with_capacity(parts.len());
    for part in &parts {
        let value = if let Some(hex) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
            if hex.is_empty() {
                0
            } else {
                u64::from_str_radix(hex, 16).ok()?
            }
        } else if part.len() > 1 && part.starts_with('0') {
            u64::from_str_radix(&part[1..], 8).ok()?
        } else {
            part.parse::<u64>().ok()?
        };
        numbers.push(value);
    }
    let (last, head) = numbers.split_last()?;
    if head.iter().any(|value| *value > 255) {
        return None;
    }
    let tail_bits = 8 * (4 - head.len() as u32);
    if *last >= 1u64 << tail_bits {
        return None;
    }
    let mut value: u64 = 0;
    for (index, part) in head.iter().enumerate() {
        value |= part << (24 - 8 * index as u32);
    }
    Some(Ipv4Addr::from((value | last) as u32))
}

/// A host *name* that is loopback by definition (RFC 6761), refused before DNS.
pub fn is_localhost_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost" || host.ends_with(".localhost")
}

/// The operator's opt-in, as the two gates read it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EgressPolicy {
    /// `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK`.
    pub allow_local: bool,
    /// `AGENT_PROVIDER_LOCAL_HOSTS`, already lower-cased and exact-host only.
    pub local_hosts: Vec<String>,
    /// Hosts the operator wrote into the process environment themselves
    /// (`HERMES_BASE_URL`'s host). The env transport is operator config, not
    /// user input — the same trust as the flag — so its host is never refused.
    pub operator_hosts: Vec<String>,
}

impl EgressPolicy {
    /// Read the two keys from the process environment.
    pub fn from_env(allow_local: bool) -> EgressPolicy {
        EgressPolicy {
            allow_local,
            local_hosts: crate::provider::local_hosts_from_env(),
            operator_hosts: Vec::new(),
        }
    }

    /// Trust `base_url`'s host as operator-written (the env transport).
    pub fn with_operator_base_url(mut self, base_url: &str) -> EgressPolicy {
        if let Some(host) = crate::provider::url_host(base_url) {
            self.operator_hosts.push(host);
        }
        self
    }

    /// Is `host` (name or literal, brackets optional) exempt from the address
    /// check? Flag ∧ (physical loopback ∨ exact listed), or an operator host.
    pub fn host_exempt(&self, host: &str) -> bool {
        let host = host
            .trim_matches(|c| c == '[' || c == ']')
            .trim_end_matches('.')
            .to_ascii_lowercase();
        if self.operator_hosts.iter().any(|allowed| allowed == &host) {
            return true;
        }
        self.allow_local
            && (crate::provider::is_allowed_loopback_host(&host)
                || self.local_hosts.iter().any(|allowed| allowed == &host))
    }

    /// Decide a host and the addresses it resolved to. **One** non-public
    /// answer refuses the whole name: an attacker who controls the zone would
    /// otherwise answer `[public, 169.254.169.254]` and let the connector pick.
    pub fn check_resolved(&self, host: &str, addresses: &[IpAddr]) -> Result<(), EgressDenied> {
        if addresses.is_empty() {
            return Err(EgressDenied::NoAddress);
        }
        if self.host_exempt(host) {
            return Ok(());
        }
        if is_localhost_name(host) || addresses.iter().any(is_non_public_ip) {
            return Err(EgressDenied::NonPublicAddress);
        }
        Ok(())
    }

    /// The pre-DNS half: a literal authority is its own answer, and a
    /// `*.localhost` name needs no lookup to refuse. Other names pass here and
    /// are decided by [`check_resolved`](Self::check_resolved).
    pub fn check_host(&self, host: &str) -> Result<(), EgressDenied> {
        let bare = host.trim_matches(|c| c == '[' || c == ']');
        if self.host_exempt(bare) {
            return Ok(());
        }
        if is_localhost_name(bare) {
            return Err(EgressDenied::NonPublicAddress);
        }
        let address = bare
            .parse::<IpAddr>()
            .ok()
            .or_else(|| parse_loose_ipv4(bare).map(IpAddr::V4));
        match address {
            Some(address) if is_non_public_ip(&address) => Err(EgressDenied::NonPublicAddress),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(raw: &str) -> IpAddr {
        raw.parse().expect(raw)
    }

    #[test]
    fn every_special_purpose_range_is_non_public() {
        for raw in [
            "0.0.0.0",
            "10.1.2.3",
            "127.0.0.1",
            "127.255.255.254",
            "100.64.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.192",
            "192.168.0.1",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "::ffff:10.0.0.1",
            "::127.0.0.1",
            "64:ff9b::a9fe:a9fe",
            "64:ff9b:1::1",
            "2002:a9fe:a9fe::1",
            "2001:0:4136:e378::1",
            "2001:db8::1",
            "::ffff:0:7f00:1",
            "::ffff:0:a9fe:a9fe",
            "2001:20::1",
            "192.88.99.1",
            "fc00::1",
            "fd00:ec2::254",
            "fe80::1",
            "fec0::1",
            "ff02::1",
        ] {
            assert!(is_non_public_ip(&ip(raw)), "{raw} must be non-public");
        }
        for raw in [
            "93.184.216.34",
            "8.8.8.8",
            "172.32.0.1",
            "100.128.0.1",
            "2606:4700::1111",
            "::ffff:93.184.216.34",
            "64:ff9b::808:808",
            "2002:5db8:d822::1",
        ] {
            assert!(!is_non_public_ip(&ip(raw)), "{raw} must be public");
        }
    }

    #[test]
    fn one_private_answer_poisons_the_whole_name() {
        let policy = EgressPolicy::default();
        assert_eq!(
            policy.check_resolved(
                "evil.example",
                &[ip("93.184.216.34"), ip("169.254.169.254")]
            ),
            Err(EgressDenied::NonPublicAddress)
        );
        assert_eq!(
            policy.check_resolved("api.example.com", &[ip("93.184.216.34")]),
            Ok(())
        );
        assert_eq!(
            policy.check_resolved("api.example.com", &[]),
            Err(EgressDenied::NoAddress)
        );
    }

    #[test]
    fn the_opt_in_is_flag_and_exact_host_or_operator_env() {
        let listed = EgressPolicy {
            allow_local: true,
            local_hosts: vec!["llm.internal".into()],
            operator_hosts: Vec::new(),
        };
        assert_eq!(
            listed.check_resolved("llm.internal", &[ip("10.0.0.5")]),
            Ok(())
        );
        assert_eq!(
            listed.check_resolved("evil.llm.internal", &[ip("10.0.0.5")]),
            Err(EgressDenied::NonPublicAddress),
            "exact match only"
        );
        let flag_off = EgressPolicy {
            allow_local: false,
            ..listed.clone()
        };
        assert_eq!(
            flag_off.check_resolved("llm.internal", &[ip("10.0.0.5")]),
            Err(EgressDenied::NonPublicAddress),
            "the list means nothing without the flag"
        );
        let env = EgressPolicy::default().with_operator_base_url("http://mock-hermes:8088/v1");
        assert_eq!(
            env.check_resolved("mock-hermes", &[ip("172.18.0.4")]),
            Ok(())
        );
        assert_eq!(
            env.check_resolved("other", &[ip("172.18.0.4")]),
            Err(EgressDenied::NonPublicAddress)
        );
    }

    #[test]
    fn literals_and_localhost_names_are_decided_before_dns() {
        let policy = EgressPolicy::default();
        assert!(policy.check_host("169.254.169.254").is_err());
        assert!(policy.check_host("[::ffff:127.0.0.1]").is_err());
        assert!(policy.check_host("foo.localhost").is_err());
        assert!(policy.check_host("localhost.").is_err());
        assert!(policy.check_host("api.example.com").is_ok());
        // Review N3: the non-canonical IPv4 spellings a URL parser normalises.
        for loose in [
            "2130706433",
            "0x7f.1",
            "0177.0.0.1",
            "127.1",
            "0xa9.0xfe.0xa9.0xfe",
            "0xa9fea9fe",
        ] {
            assert!(policy.check_host(loose).is_err(), "{loose}");
        }
        for name in ["cafe.be", "deadbeef.example", "1password.com", "8.8.8.8"] {
            assert!(policy.check_host(name).is_ok(), "{name}");
        }
        assert!(policy.check_host("93.184.216.34").is_ok());
    }
}
