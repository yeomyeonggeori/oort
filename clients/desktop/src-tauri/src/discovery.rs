// LAN server discovery over mDNS (ADR-0133 P2, MOMO-603).
//
// The internal-alpha stack advertises the API over Bonjour as `_momo._tcp` with
// a TXT record whose `base` key holds the API base URL (see
// `scripts/internal_alpha_stack.sh`, MOMO-586). This is the desktop shell's
// browser for it, ported from the macOS client
// (`clients/macOS/Sources/MomoMac/MomoServerDiscovery.swift`, MOMO-587) so both
// shells offer the same addresses from the same advertisement.
//
// The rule carried over verbatim is that discovery is allowed to be USEFUL but
// never NOISY: nothing found, permission denied, no mDNS responder on the host —
// all three resolve to an empty server list, which the web side renders as
// silence rather than as an error. A person who already knows their server
// address must never be shown a failed search.
//
// `mdns-sd` is a pure-Rust responder (MIT/Apache-2.0) with no async runtime, so
// the browse runs on one plain thread with a deadline instead of dragging a
// second executor into the shell.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use url::Url;

/// Emitted whenever the known server set changes, plus once when a scan ends.
pub const DISCOVERY_EVENT: &str = "momo:discovery";

/// Service type advertised by the stack (MOMO-586).
const SERVICE_TYPE: &str = "_momo._tcp.local.";
/// TXT key: the API as a Bonjour NAME, e.g. `http://MacBook-Pro-2.local:28000`.
const TXT_BASE_KEY: &str = "base";
/// TXT key: the same API as a LAN ADDRESS, e.g. `http://192.168.35.57:28000`.
///
/// Added by MOMO-609 (parity gate G-1) on both sides at once — the advertiser is
/// `scripts/internal_alpha_stack.sh`. The webview this shell embeds was measured
/// resolving the advertised `.local` name to a link-local IPv6 address it then
/// could not dial, so a login against the NAME produced no request at all: 70 s
/// of "로그인 중…" with zero entries in the server's access log. Whether that
/// name resolves depends on the responder cache and the local-network grant,
/// which is not a thing a client can rely on; the address form always dials, and
/// the name form survives a DHCP lease change. Advertising both lets each
/// consumer take the one it can actually use, so this shell prefers `ipv4` and
/// falls back to `base`, and an advertiser that predates this key still works.
const TXT_IPV4_KEY: &str = "ipv4";

/// Matches the macOS chooser's browse window: long enough for a responder on the
/// same LAN to answer, short enough that a person is not left watching a spinner.
const DEFAULT_TIMEOUT_MS: u64 = 4_000;
const MAX_TIMEOUT_MS: u64 = 30_000;

/// A validated server the join surface is willing to offer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredServer {
    /// The address this client will DIAL, exactly as advertised — this is what
    /// gets prefilled, so it is never normalised on the way through. `ipv4` when
    /// the advertisement carried a usable one, `base` otherwise.
    pub base_url: String,
    /// Short human label naming the MACHINE, e.g. `MacBook-Pro-2.local:28000`.
    /// Taken from the advertised name even when the dialed address is the IPv4
    /// one, because the name is what its owner recognises; the address is shown
    /// beside it on the card, so neither is hidden.
    pub display_host: String,
    /// The Bonjour instance name, e.g. `momo`.
    pub instance_name: String,
}

/// The full current result set. Emitting the whole set rather than deltas keeps
/// the consumer a pure render of `servers` with no accumulation logic to get wrong.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryPayload {
    pub servers: Vec<DiscoveredServer>,
    /// False on the terminal emit of a scan (deadline reached or stopped).
    pub scanning: bool,
}

/// Owns at most one live browse.
///
/// `generation` is what makes stop/restart safe: a superseded thread may still be
/// inside a `recv_timeout` when the next scan starts, and its late emits would
/// otherwise resurrect servers the new scan has not seen. Every emit checks that
/// it still owns the current generation.
///
/// The daemon and the generation share ONE lock rather than sitting behind a
/// mutex and an atomic, because every interesting operation is "check whether I
/// still own this, and act on it" — split across two primitives, a scan ending at
/// the same moment as a restart could shut down its successor's daemon.
#[derive(Default)]
struct Browse {
    daemon: Option<ServiceDaemon>,
    generation: u64,
}

#[derive(Default)]
pub struct DiscoveryState {
    browse: Mutex<Browse>,
}

impl DiscoveryState {
    /// Installs a new daemon, retiring any previous one. Returns its generation.
    fn begin(&self, daemon: ServiceDaemon) -> u64 {
        let mut browse = self.lock();
        if let Some(previous) = browse.daemon.take() {
            let _ = previous.shutdown();
        }
        browse.generation += 1;
        browse.daemon = Some(daemon);
        browse.generation
    }

    /// Retires the current browse. Idempotent.
    fn stop(&self) {
        let mut browse = self.lock();
        if let Some(daemon) = browse.daemon.take() {
            let _ = daemon.shutdown();
        }
        browse.generation += 1;
    }

    fn is_current(&self, generation: u64) -> bool {
        self.lock().generation == generation
    }

    /// Releases the daemon of a scan that reached its own deadline. Reclaiming it
    /// matters: each `ServiceDaemon` owns a thread and sockets, so leaving them
    /// behind would make every scan cost a little more than the last.
    fn finish(&self, generation: u64) {
        let mut browse = self.lock();
        if browse.generation != generation {
            return; // already superseded; the daemon in the slot is not ours
        }
        if let Some(daemon) = browse.daemon.take() {
            let _ = daemon.shutdown();
        }
    }

    /// A poisoned lock here means a previous holder panicked mid-update. The
    /// state is a daemon slot and a counter, not an invariant that can be
    /// half-broken, so recovering beats poisoning discovery for the session.
    fn lock(&self) -> std::sync::MutexGuard<'_, Browse> {
        self.browse
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Starts (or restarts) a browse for `_momo._tcp`.
///
/// Returns as soon as the browse is running; results arrive as `momo:discovery`
/// events. An error means the mDNS responder could not be started at all. The
/// terminal empty payload goes out even then, so the UI stays silent either way
/// while the cause still reaches the console.
///
/// A failure also retires whatever browse was running: the caller asked for a
/// restart, and leaving the old scan emitting into a UI that has been told the
/// restart failed is worse than no results at all.
#[tauri::command]
pub fn discovery_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DiscoveryState>,
    timeout_ms: Option<u64>,
) -> Result<(), String> {
    let timeout =
        Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS));

    let daemon = match ServiceDaemon::new() {
        Ok(daemon) => daemon,
        Err(error) => {
            state.stop();
            emit(&app, Vec::new(), false);
            return Err(format!("mDNS responder unavailable: {error}"));
        }
    };
    let receiver = match daemon.browse(SERVICE_TYPE) {
        Ok(receiver) => receiver,
        Err(error) => {
            let _ = daemon.shutdown();
            state.stop();
            emit(&app, Vec::new(), false);
            return Err(format!("mDNS browse failed: {error}"));
        }
    };
    let generation = state.begin(daemon);

    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + timeout;
        let mut servers: Vec<DiscoveredServer> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match receiver.recv_timeout(remaining) {
                Ok(ServiceEvent::ServiceResolved(resolved)) => {
                    let Some(server) = to_server(&resolved) else {
                        continue;
                    };
                    if !seen.insert(server.base_url.clone()) {
                        continue;
                    }
                    servers.push(server);
                    if !emit_if_current(&app_for_thread, generation, servers.clone(), true) {
                        return;
                    }
                }
                // Every other event (search started/stopped, unresolved sighting,
                // removal) leaves the offered set alone: a server that stops
                // advertising mid-scan is still reachable, and dropping it would
                // make the list flicker for no gain.
                Ok(_) => continue,
                Err(_) => break, // daemon shut down by discovery_stop
            }
        }

        emit_if_current(&app_for_thread, generation, servers, false);
        if let Some(state) = app_for_thread.try_state::<DiscoveryState>() {
            state.finish(generation);
        }
    });

    Ok(())
}

/// Stops the current browse. Idempotent; safe to call when nothing is running.
#[tauri::command]
pub fn discovery_stop(state: State<'_, DiscoveryState>) {
    state.stop();
}

fn emit<R: Runtime>(app: &AppHandle<R>, servers: Vec<DiscoveredServer>, scanning: bool) {
    let _ = app.emit(DISCOVERY_EVENT, DiscoveryPayload { servers, scanning });
}

/// Emits only while this thread still owns the browse. Returns false once it does
/// not, which is the signal for a superseded thread to stop working.
fn emit_if_current<R: Runtime>(
    app: &AppHandle<R>,
    generation: u64,
    servers: Vec<DiscoveredServer>,
    scanning: bool,
) -> bool {
    let Some(state) = app.try_state::<DiscoveryState>() else {
        return false;
    };
    if !state.is_current(generation) {
        return false;
    }
    emit(app, servers, scanning);
    true
}

/// A TXT value, trimmed, with an empty one treated as absent.
fn txt<'a>(resolved: &'a mdns_sd::ResolvedService, key: &str) -> Option<&'a str> {
    let value = resolved.txt_properties.get_property_val_str(key)?.trim();
    (!value.is_empty()).then_some(value)
}

fn to_server(resolved: &mdns_sd::ResolvedService) -> Option<DiscoveredServer> {
    let (base_url, display_host) =
        offered(txt(resolved, TXT_BASE_KEY), txt(resolved, TXT_IPV4_KEY))?;
    Some(DiscoveredServer {
        base_url,
        display_host,
        instance_name: instance_name(&resolved.fullname, &resolved.ty_domain),
    })
}

/// What one advertisement is worth offering: the address to dial and the label
/// to show it under.
///
/// Dial priority is the LAN address first, the Bonjour name second. Each is
/// checked independently, so a malformed `ipv4` falls through to `base` rather
/// than taking the sighting down with it, and an advertiser carrying only `base`
/// behaves exactly as it did before this key existed.
fn offered(named: Option<&str>, addressed: Option<&str>) -> Option<(String, String)> {
    let (raw, url) = dialable(addressed).or_else(|| dialable(named))?;
    // The label names the machine whenever the advertisement said what it is
    // called, even when the dialed address is the numeric one.
    let label = named.and_then(|name| validated_base_url(name).map(|_| name));
    Some((raw.to_string(), display_host(label.unwrap_or(raw), &url)))
}

/// The raw string paired with its parsed URL, or None when it is not offerable.
fn dialable(raw: Option<&str>) -> Option<(&str, Url)> {
    let raw = raw?;
    validated_base_url(raw).map(|url| (raw, url))
}

/// An advertisement is only offered when it carries a base URL a client could
/// actually dial: http(s) with a host. Anything else is treated as absent.
fn validated_base_url(raw: &str) -> Option<Url> {
    if raw.is_empty() {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = url.host_str()?;
    if host.is_empty() {
        return None;
    }
    Some(url)
}

/// The advertised authority — host plus port, since the alpha stack listens on
/// `:28000` and the port is part of what identifies the machine.
///
/// Cut from the RAW advertised string rather than read off the parsed URL,
/// because `Url` lowercases hosts and the advertisement carries the machine's
/// own casing (`MacBook-Pro-2.local`) — which is the form its owner recognises.
/// The parsed URL is still what decides the string is offerable at all.
fn display_host(raw: &str, url: &Url) -> String {
    let authority = raw
        .split_once("://")
        .map_or(raw, |(_, rest)| rest)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, rest)| rest);
    if host_port.is_empty() {
        // Unreachable for a validated URL, but a blank label is never useful.
        return url.host_str().unwrap_or_default().to_string();
    }
    host_port.to_string()
}

/// `momo._momo._tcp.local.` + `_momo._tcp.local.` -> `momo`.
fn instance_name(fullname: &str, ty_domain: &str) -> String {
    fullname
        .strip_suffix(ty_domain)
        .map(|name| name.trim_end_matches('.').to_string())
        .unwrap_or_else(|| fullname.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_only_dialable_advertisements() {
        assert!(validated_base_url("http://macbook.local:28000").is_some());
        assert!(validated_base_url("https://api.example.com").is_some());
        assert!(validated_base_url("").is_none());
        assert!(validated_base_url("macbook.local:28000").is_none());
        assert!(validated_base_url("ws://macbook.local:28000").is_none());
        assert!(validated_base_url("file:///etc/hosts").is_none());
    }

    fn label(raw: &str) -> String {
        display_host(raw, &validated_base_url(raw).expect("offerable base URL"))
    }

    #[test]
    fn keeps_the_port_and_the_advertised_casing_in_the_display_label() {
        // The live stack advertises exactly this (dns-sd -B _momo._tcp).
        assert_eq!(
            label("http://MacBook-Pro-2.local:28000"),
            "MacBook-Pro-2.local:28000"
        );
        assert_eq!(label("https://api.example.com"), "api.example.com");
        assert_eq!(label("http://macbook.local:28000/"), "macbook.local:28000");
    }

    #[test]
    fn dials_the_lan_address_and_labels_it_with_the_machine_name() {
        // What the live stack advertises after MOMO-609. The name is what the
        // person recognises; the address is what a webview can actually reach.
        let (base, label) = offered(
            Some("http://MacBook-Pro-2.local:28000"),
            Some("http://192.168.35.57:28000"),
        )
        .expect("an offerable sighting");
        assert_eq!(base, "http://192.168.35.57:28000");
        assert_eq!(label, "MacBook-Pro-2.local:28000");
    }

    #[test]
    fn falls_back_to_the_name_when_there_is_no_address() {
        // An advertiser that predates the ipv4 key, and one whose ipv4 is junk:
        // both keep working exactly as before instead of disappearing.
        assert_eq!(
            offered(Some("http://macbook.local:28000"), None),
            Some((
                "http://macbook.local:28000".to_string(),
                "macbook.local:28000".to_string()
            ))
        );
        assert_eq!(
            offered(
                Some("http://macbook.local:28000"),
                Some("192.168.0.9:28000")
            ),
            Some((
                "http://macbook.local:28000".to_string(),
                "macbook.local:28000".to_string()
            ))
        );
    }

    #[test]
    fn offers_an_address_only_advertisement_under_its_address() {
        assert_eq!(
            offered(None, Some("http://192.168.35.57:28000")),
            Some((
                "http://192.168.35.57:28000".to_string(),
                "192.168.35.57:28000".to_string()
            ))
        );
    }

    #[test]
    fn stays_silent_when_neither_key_is_dialable() {
        assert_eq!(offered(None, None), None);
        assert_eq!(offered(Some("macbook.local:28000"), Some("nonsense")), None);
    }

    #[test]
    fn strips_the_service_type_from_the_instance_name() {
        assert_eq!(
            instance_name("momo._momo._tcp.local.", "_momo._tcp.local."),
            "momo"
        );
        assert_eq!(instance_name("odd-name", "_momo._tcp.local."), "odd-name");
    }
}
