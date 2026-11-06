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
/// operator opted in? IPv4 is judged against the IPv4 special-purpose ranges;
/// IPv6 against the IANA IPv6 Special-Purpose Address Registry (`V6_RANGES`).
/// Every IPv6 form that carries an IPv4 address (mapped, translated,
/// compatible, NAT64, 6to4) is judged as the IPv4 address it carries.
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

/// What the gate does with one block of the IPv6 special-purpose registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V6Rule {
    /// Registry `Globally Reachable` is False, or N/A with a tail this gate
    /// cannot vet (Teredo): a provider call must not land here.
    Refuse,
    /// A more specific allocation the registry marks globally reachable, cut
    /// out of the refused block around it (`2001:3::/32` inside `2001::/23`).
    Reachable,
    /// The block carries an IPv4 address at this byte offset, and that is where
    /// the packet really goes (a dual-stack socket, a NAT64 gateway, a 6to4
    /// relay). It is judged as that IPv4 address and the registry's column is
    /// not asked: `::ffff:10.0.0.1` and `64:ff9b::a00:1` are private addresses
    /// wearing an IPv6 prefix.
    CarriesV4(usize),
}

use V6Rule::{CarriesV4, Reachable, Refuse};

/// One block: the address as 128 bits (written in full, eight groups of four
/// hex digits, so it lines up with the registry's text), its prefix length, and
/// what the gate does with it.
struct V6Range {
    network: u128,
    prefix_len: u8,
    rule: V6Rule,
}

const fn block(network: u128, prefix_len: u8, rule: V6Rule) -> V6Range {
    V6Range {
        network,
        prefix_len,
        rule,
    }
}

impl V6Range {
    /// `prefix_len` is 1..=128 (a test holds the table to it), so the shift is
    /// 0..=127.
    fn contains(&self, bits: u128) -> bool {
        (bits ^ self.network) >> (128 - u32::from(self.prefix_len)) == 0
    }
}

/// The IPv6 side of the gate, from the IANA IPv6 Special-Purpose Address
/// Registry (<https://www.iana.org/assignments/iana-ipv6-special-registry/>,
/// last updated 2025-10-09; #4874). Each comment reads `block, registry name
/// (RFC): Globally Reachable`.
///
/// **The longest matching prefix decides**, so a sub-allocation the registry
/// marks reachable is cut out of the block around it (the registry's own
/// footnote: `2001::/23` is not globally reachable "unless allowed by a more
/// specific allocation"). An address in no block here, which is RIR-allocated
/// global unicast and space nobody has allocated yet, is not refused: the
/// registry lists special-purpose blocks, it is not an allow-list of global
/// unicast.
///
/// Registry rows with no line below: `2001:10::/28` (deprecated ORCHID,
/// terminated 2014-03, so the `/23` decides again) and `2620:4f:8000::/48`
/// (Direct Delegation AS112, reachable, with nothing refused around it).
const V6_RANGES: &[V6Range] = &[
    // ::/128, Unspecified Address (RFC 4291): False
    block(0x0000_0000_0000_0000_0000_0000_0000_0000, 128, Refuse),
    // ::1/128, Loopback Address (RFC 4291): False
    block(0x0000_0000_0000_0000_0000_0000_0000_0001, 128, Refuse),
    // ::ffff:0:0/96, IPv4-mapped Address (RFC 4291): False
    block(0x0000_0000_0000_0000_0000_ffff_0000_0000, 96, CarriesV4(12)),
    // ::ffff:0:0:0/96, IPv4-translated (SIIT, RFC 2765/6145): not a registry row,
    // but it carries an IPv4 address.
    block(0x0000_0000_0000_0000_ffff_0000_0000_0000, 96, CarriesV4(12)),
    // ::/96, IPv4-compatible (deprecated, RFC 4291 2.5.5.1): not a registry row
    // either, and it carries an IPv4 address too.
    block(0x0000_0000_0000_0000_0000_0000_0000_0000, 96, CarriesV4(12)),
    // 64:ff9b::/96, IPv4-IPv6 Translat. (RFC 6052): True, as a prefix. What it
    // reaches is the IPv4 address it carries, which a NAT64 gateway dials.
    block(0x0064_ff9b_0000_0000_0000_0000_0000_0000, 96, CarriesV4(12)),
    // 64:ff9b:1::/48, IPv4-IPv6 Translat. local-use (RFC 8215): False
    block(0x0064_ff9b_0001_0000_0000_0000_0000_0000, 48, Refuse),
    // 100::/64, Discard-Only Address Block (RFC 6666): False
    block(0x0100_0000_0000_0000_0000_0000_0000_0000, 64, Refuse),
    // 100:0:0:1::/64, Dummy IPv6 Prefix (RFC 9780): False
    block(0x0100_0000_0000_0001_0000_0000_0000_0000, 64, Refuse),
    // 2001::/23, IETF Protocol Assignments (RFC 2928): False, unless allowed by
    // a more specific allocation, which are the rows down to 2001:30::/28.
    block(0x2001_0000_0000_0000_0000_0000_0000_0000, 23, Refuse),
    // 2001::/32, TEREDO (RFC 4380): N/A. It tunnels to an IPv4 server and
    // client that this gate cannot vet.
    block(0x2001_0000_0000_0000_0000_0000_0000_0000, 32, Refuse),
    // 2001:1::1/128, Port Control Protocol Anycast (RFC 7723): True
    block(0x2001_0001_0000_0000_0000_0000_0000_0001, 128, Reachable),
    // 2001:1::2/128, Traversal Using Relays around NAT Anycast (RFC 8155): True
    block(0x2001_0001_0000_0000_0000_0000_0000_0002, 128, Reachable),
    // 2001:1::3/128, DNS-SD Service Registration Protocol Anycast (RFC 9665): True
    block(0x2001_0001_0000_0000_0000_0000_0000_0003, 128, Reachable),
    // 2001:2::/48, Benchmarking (RFC 5180): False
    block(0x2001_0002_0000_0000_0000_0000_0000_0000, 48, Refuse),
    // 2001:3::/32, AMT (RFC 7450): True
    block(0x2001_0003_0000_0000_0000_0000_0000_0000, 32, Reachable),
    // 2001:4:112::/48, AS112-v6 (RFC 7535): True
    block(0x2001_0004_0112_0000_0000_0000_0000_0000, 48, Reachable),
    // 2001:20::/28, ORCHIDv2 (RFC 7343): True
    block(0x2001_0020_0000_0000_0000_0000_0000_0000, 28, Reachable),
    // 2001:30::/28, Drone Remote ID Protocol Entity Tags (RFC 9374): True
    block(0x2001_0030_0000_0000_0000_0000_0000_0000, 28, Reachable),
    // 2001:db8::/32, Documentation (RFC 3849): False
    block(0x2001_0db8_0000_0000_0000_0000_0000_0000, 32, Refuse),
    // 2002::/16, 6to4 (RFC 3056): N/A. The IPv4 address sits in bits 16..48.
    block(0x2002_0000_0000_0000_0000_0000_0000_0000, 16, CarriesV4(2)),
    // 3fff::/20, Documentation (RFC 9637): False
    block(0x3fff_0000_0000_0000_0000_0000_0000_0000, 20, Refuse),
    // 5f00::/16, Segment Routing (SRv6) SIDs (RFC 9602): False
    block(0x5f00_0000_0000_0000_0000_0000_0000_0000, 16, Refuse),
    // fc00::/7, Unique-Local (RFC 4193): False. Includes fd00:ec2::254, the AWS
    // metadata address.
    block(0xfc00_0000_0000_0000_0000_0000_0000_0000, 7, Refuse),
    // fe80::/10, Link-Local Unicast (RFC 4291): False
    block(0xfe80_0000_0000_0000_0000_0000_0000_0000, 10, Refuse),
    // fec0::/10, site-local (deprecated, RFC 3879): not a registry row, never a
    // public host.
    block(0xfec0_0000_0000_0000_0000_0000_0000_0000, 10, Refuse),
    // ff00::/8, multicast (RFC 4291): not a registry row, and TCP cannot dial it.
    block(0xff00_0000_0000_0000_0000_0000_0000_0000, 8, Refuse),
];

fn is_non_public_v6(address: &Ipv6Addr) -> bool {
    let bits = u128::from(*address);
    let rule = V6_RANGES
        .iter()
        .filter(|range| range.contains(bits))
        .max_by_key(|range| range.prefix_len)
        .map(|range| range.rule);
    match rule {
        Some(Refuse) => true,
        Some(Reachable) | None => false,
        Some(CarriesV4(at)) => {
            let bytes = address.octets();
            is_non_public_v4(&Ipv4Addr::new(
                bytes[at],
                bytes[at + 1],
                bytes[at + 2],
                bytes[at + 3],
            ))
        }
    }
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
            // ORCHIDv2: the registry marks 2001:20::/28 Globally Reachable (#4874).
            "2001:20::1",
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

    // ---- #4874: the IPv6 list against the IANA special-purpose registry ----

    /// The registry's `Globally Reachable` column.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Reach {
        Yes,
        No,
        /// `N/A`: the registry defers to the RFC (Teredo, 6to4).
        NotApplicable,
        /// A row with a termination date and no flags (deprecated ORCHID).
        Terminated,
    }

    /// IANA IPv6 Special-Purpose Address Registry, last updated 2025-10-09
    /// (<https://www.iana.org/assignments/iana-ipv6-special-registry/>, CC0):
    /// `(Address Block, Globally Reachable)` for every row of the CSV export, in
    /// registry order. Generated from the CSV, not typed, and written apart from
    /// `V6_RANGES` so the two can disagree.
    const REGISTRY: &[(&str, Reach)] = &[
        ("::1/128", Reach::No),
        ("::/128", Reach::No),
        ("::ffff:0:0/96", Reach::No),
        ("64:ff9b::/96", Reach::Yes),
        ("64:ff9b:1::/48", Reach::No),
        ("100::/64", Reach::No),
        ("100:0:0:1::/64", Reach::No),
        ("2001::/23", Reach::No),
        ("2001::/32", Reach::NotApplicable),
        ("2001:1::1/128", Reach::Yes),
        ("2001:1::2/128", Reach::Yes),
        ("2001:1::3/128", Reach::Yes),
        ("2001:2::/48", Reach::No),
        ("2001:3::/32", Reach::Yes),
        ("2001:4:112::/48", Reach::Yes),
        ("2001:10::/28", Reach::Terminated),
        ("2001:20::/28", Reach::Yes),
        ("2001:30::/28", Reach::Yes),
        ("2001:db8::/32", Reach::No),
        ("2002::/16", Reach::NotApplicable),
        ("2620:4f:8000::/48", Reach::Yes),
        ("3fff::/20", Reach::No),
        ("5f00::/16", Reach::No),
        ("fc00::/7", Reach::No),
        ("fe80::/10", Reach::No),
    ];

    /// Registry blocks the gate does not judge by the column: each carries an
    /// IPv4 address (at this byte offset) and is judged as that address.
    const CARRIERS: &[(&str, usize)] = &[
        ("::ffff:0:0/96", 12),
        ("64:ff9b::/96", 12),
        ("2002::/16", 2),
    ];

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Want {
        Refuse,
        Open,
        Carries(usize),
    }

    /// Blocks the gate handles although the registry has no row for them.
    const OUTSIDE_REGISTRY: &[(&str, Want)] = &[
        ("::ffff:0:0:0/96", Want::Carries(12)), // IPv4-translated (SIIT)
        ("::/96", Want::Carries(12)),           // IPv4-compatible (deprecated)
        ("fec0::/10", Want::Refuse),            // site-local (deprecated)
        ("ff00::/8", Want::Refuse),             // multicast
    ];

    fn v6(raw: &str) -> Ipv6Addr {
        raw.parse().expect(raw)
    }

    fn prefix_len(cidr: &str) -> u32 {
        cidr.split_once('/').expect(cidr).1.parse().expect(cidr)
    }

    /// First and last address of a CIDR block, as bits.
    fn span(cidr: &str) -> (u128, u128) {
        let len = prefix_len(cidr);
        let host_mask = if len == 128 { 0 } else { u128::MAX >> len };
        let first = u128::from(v6(cidr.split_once('/').expect(cidr).0)) & !host_mask;
        (first, first | host_mask)
    }

    fn ipv4_carried_at(address: Ipv6Addr, at: usize) -> Ipv4Addr {
        let bytes = address.octets();
        Ipv4Addr::new(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
    }

    /// What the registry says a gate must do with `address`: the verdict of the
    /// longest block that holds it (a terminated row holds nothing), where a
    /// block that carries an IPv4 address is judged as that address.
    fn registry_says_non_public(address: Ipv6Addr) -> bool {
        let bits = u128::from(address);
        let from_registry = REGISTRY
            .iter()
            .filter(|(_, reach)| *reach != Reach::Terminated)
            .map(|(cidr, reach)| {
                let want = match CARRIERS.iter().find(|(carrier, _)| carrier == cidr) {
                    Some((_, at)) => Want::Carries(*at),
                    None if *reach == Reach::Yes => Want::Open,
                    None => Want::Refuse,
                };
                (*cidr, want)
            });
        let want = from_registry
            .chain(OUTSIDE_REGISTRY.iter().copied())
            .filter(|(cidr, _)| {
                let (first, last) = span(cidr);
                (first..=last).contains(&bits)
            })
            .max_by_key(|(cidr, _)| prefix_len(cidr))
            .map(|(_, want)| want);
        match want {
            Some(Want::Refuse) => true,
            Some(Want::Open) | None => false,
            Some(Want::Carries(at)) => is_non_public_v4(&ipv4_carried_at(address, at)),
        }
    }

    /// Every registry block is enforced at both edges: the first and the last
    /// address inside it, and the address just below and just above. The
    /// expectation is the registry's verdict for that very address (the longest
    /// block holding it), so a neighbour that falls in another special-purpose
    /// block is asserted as refused for that reason, and one in public space as
    /// open. The 2001::/23 carve-outs are checked at their edges the same way.
    #[test]
    fn every_ipv6_registry_block_is_enforced_at_both_edges() {
        // The table is well formed: a typo that leaves host bits set or lists a
        // block twice would silently change which row wins.
        for (index, range) in V6_RANGES.iter().enumerate() {
            let len = u32::from(range.prefix_len);
            assert!((1..=128).contains(&len), "row {index}: prefix length {len}");
            let host_mask = if len == 128 { 0 } else { u128::MAX >> len };
            assert_eq!(
                range.network & host_mask,
                0,
                "row {index} has host bits set"
            );
            for other in &V6_RANGES[index + 1..] {
                assert!(
                    !(other.network == range.network && other.prefix_len == range.prefix_len),
                    "row {index} is listed twice"
                );
            }
        }

        let blocks = REGISTRY
            .iter()
            .map(|(cidr, _)| *cidr)
            .chain(OUTSIDE_REGISTRY.iter().map(|(cidr, _)| *cidr));
        let mut probes = 0;
        for cidr in blocks {
            let (first, last) = span(cidr);
            let edges = [
                ("just below", first.checked_sub(1)),
                ("first inside", Some(first)),
                ("last inside", Some(last)),
                ("just above", last.checked_add(1)),
            ];
            for (edge, bits) in edges {
                let Some(bits) = bits else { continue };
                let address = Ipv6Addr::from(bits);
                assert_eq!(
                    is_non_public_v6(&address),
                    registry_says_non_public(address),
                    "{cidr}, {edge}: {address}"
                );
                probes += 1;
            }
        }
        assert!(probes > 100, "only {probes} edge probes ran");
    }

    /// The same contract in plain sight: the addresses #4874 changes, their
    /// neighbours, and real public addresses that must stay reachable.
    #[test]
    fn ipv6_registry_realignment_in_plain_sight() {
        for (raw, why) in [
            // Newly refused, with the last address of each block.
            ("3fff::1", "documentation 3fff::/20 (RFC 9637)"),
            (
                "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
                "last of 3fff::/20",
            ),
            ("5f00::1", "SRv6 SIDs 5f00::/16"),
            (
                "5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
                "last of 5f00::/16",
            ),
            ("100:0:0:1::1", "dummy prefix 100:0:0:1::/64"),
            ("100:0:0:1:ffff:ffff:ffff:ffff", "last of the dummy prefix"),
            ("2001:2::1", "benchmarking 2001:2::/48"),
            ("2001:2:0:ffff:ffff:ffff:ffff:ffff", "last of 2001:2::/48"),
            // Inside 2001::/23 with no reachable allocation: the /23 refuses.
            ("2001:1::", "next to the reachable anycast addresses"),
            ("2001:1::4", "next to the reachable anycast addresses"),
            (
                "2001:10::1",
                "deprecated ORCHID, terminated: the /23 decides",
            ),
            ("2001:40::1", "unallocated inside the /23"),
            (
                "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff",
                "last of 2001::/23",
            ),
            // Refused before this change and still.
            ("2001:db8::1", "documentation 2001:db8::/32"),
            ("2001:0:4136:e378::1", "Teredo"),
            ("100::1", "discard-only"),
            ("64:ff9b:1::1", "local-use NAT64"),
            ("fd00:ec2::254", "AWS metadata"),
            ("fe80::1", "link-local"),
            ("fec0::1", "site-local"),
            ("ff02::1", "multicast"),
        ] {
            assert!(is_non_public_ip(&ip(raw)), "{raw} must be refused: {why}");
        }
        for (raw, why) in [
            // Just outside the newly refused blocks.
            (
                "3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
                "just below 3fff::/20",
            ),
            ("3fff:1000::", "just above 3fff::/20"),
            (
                "5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
                "just below 5f00::/16",
            ),
            ("5f01::", "just above 5f00::/16"),
            ("100:0:0:2::", "just above the dummy prefix"),
            (
                "2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
                "just below 2001::/23",
            ),
            ("2001:200::", "just above 2001::/23, the first RIR block"),
            // Globally reachable allocations cut out of 2001::/23.
            ("2001:1::1", "PCP anycast (RFC 7723)"),
            ("2001:1::2", "TURN anycast (RFC 8155)"),
            ("2001:1::3", "DNS-SD SRP anycast (RFC 9665)"),
            ("2001:3::1", "AMT (RFC 7450)"),
            ("2001:4:112::1", "AS112-v6 (RFC 7535)"),
            ("2001:20::1", "ORCHIDv2 (RFC 7343)"),
            ("2001:30::1", "drone remote ID (RFC 9374)"),
            ("2620:4f:8000::1", "direct delegation AS112 (RFC 7534)"),
            // Ordinary public addresses.
            ("2606:4700:4700::1111", "Cloudflare DNS"),
            ("2001:4860:4860::8888", "Google DNS"),
            ("2620:fe::fe", "Quad9"),
            ("2a00:1450:4001:81b::200e", "Google"),
        ] {
            assert!(
                !is_non_public_ip(&ip(raw)),
                "{raw} must stay reachable: {why}"
            );
        }
    }

    /// Mapped and translated addresses cannot reach the private network: every
    /// IPv6 form that carries an IPv4 address is judged as the IPv4 address it
    /// carries, whatever the prefix around it says.
    #[test]
    fn ipv4_carrying_forms_are_judged_as_the_ipv4_they_carry() {
        // The form as it is written in the wild, around the IPv4 address's two
        // 16-bit halves.
        let wrap = |form: &str, v4: Ipv4Addr| -> IpAddr {
            let [a, b, c, d] = v4.octets();
            let (hi, lo) = (u16::from_be_bytes([a, b]), u16::from_be_bytes([c, d]));
            let raw = match form {
                "mapped" => format!("::ffff:{hi:x}:{lo:x}"),
                "translated" => format!("::ffff:0:{hi:x}:{lo:x}"),
                "compatible" => format!("::{hi:x}:{lo:x}"),
                "nat64" => format!("64:ff9b::{hi:x}:{lo:x}"),
                "6to4" => format!("2002:{hi:x}:{lo:x}::1"),
                other => panic!("unknown form {other}"),
            };
            ip(&raw)
        };
        // (form, also assert that a public IPv4 stays reachable). The deprecated
        // forms only get the refusal half: nobody should rely on `::8.8.8.8`.
        let forms = [
            ("mapped", true),
            ("translated", false),
            ("compatible", false),
            ("nat64", true),
            ("6to4", true),
        ];
        let private = [
            "0.0.0.1",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.0.0.192",
            "192.168.1.1",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
        ];
        let public = ["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1"];
        for (form, public_stays_open) in forms {
            for raw in private {
                let wrapped = wrap(form, raw.parse().expect(raw));
                assert!(
                    is_non_public_ip(&wrapped),
                    "{form} carrying {raw} ({wrapped}) must be refused"
                );
            }
            if public_stays_open {
                for raw in public {
                    let wrapped = wrap(form, raw.parse().expect(raw));
                    assert!(
                        !is_non_public_ip(&wrapped),
                        "{form} carrying {raw} ({wrapped}) must stay reachable"
                    );
                }
            }
        }
        // Prefixes whose IPv4 side this gate cannot vet are refused whole, even
        // around a public IPv4 address.
        for (raw, why) in [
            (
                "64:ff9b:1::5db8:d822",
                "local-use NAT64: the operator picked the prefix",
            ),
            ("2001:0:5db8:d822::1", "Teredo: a tunnel, not a destination"),
        ] {
            assert!(is_non_public_ip(&ip(raw)), "{raw} must be refused: {why}");
        }
    }
}
