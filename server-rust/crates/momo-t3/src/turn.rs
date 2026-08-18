//! Per-session **ephemeral TURN credentials** — LIVE-5a, ADR-0165 증보 1 D3-2.
//!
//! ## What this replaces, and why the replacement had to exist
//!
//! `docs/runbooks/turn-host-install.md` installed `momo-turn` with **one static
//! long-term credential** (`lt-cred-mech` + a `user=` line) and said so in
//! writing: 「이 정적 자격은 임시이며 LIVE-5에서 세션 capability 동반 단명 자격
//! 발급으로 교체한다」. A single shared password on a relay that every browser
//! and every microVM must be handed is three problems at once:
//!
//! 1. **It cannot be revoked for one session.** Rotating it cuts every live
//!    stream on the instance, so in practice it is never rotated.
//! 2. **It has no expiry.** A credential that reached a viewer's devtools once
//!    keeps allocating relays for as long as the config line stands.
//! 3. **It names nobody.** coturn's log says `oort-live` allocated a relay,
//!    which is true of every allocation and therefore evidence of nothing.
//!
//! ## The mechanism
//!
//! coturn's `use-auth-secret` (the "TURN REST API", draft-uberti-behave-turn-rest-00)
//! turns the long-term credential into a *derivation*: the server holds one
//! `static-auth-secret` and never stores a user row, while whoever is entitled
//! to hand out access computes
//!
//! ```text
//! username   = "<unix expiry seconds>:<subject>"
//! credential = base64( HMAC-SHA1( static-auth-secret, username ) )
//! ```
//!
//! coturn recomputes exactly that from the username it is presented with and
//! compares. So the credential is **bounded in time by its own username**, and
//! momo mints one per grant instead of shipping a shared password.
//!
//! **SHA-1 is not a choice here.** The password is verified through STUN
//! MESSAGE-INTEGRITY, which WebRTC fixes at HMAC-SHA1 (RFC 5389 §15.4), and
//! coturn derives the temporary password under the same `shatype`. A deployment
//! that "upgraded" to SHA-256 would authenticate no browser at all. The hash is
//! also not doing a hash's usual job: nothing here is stored, compared for
//! secrecy, or expected to resist collision — it is a keyed derivation whose
//! only reader is coturn.
//!
//! ## What this module deliberately does not do
//!
//! It does not dial anything, does not read coturn's log, and holds no state.
//! ADR-0165 D3 keeps momo out of the media path; issuing the relay's credential
//! is the *most* momo does with TURN, and the module boundary is where that is
//! visible. The one thing it does own is that the secret never leaves: the
//! policy's [`Debug`] is hand-written for the same reason
//! `momo_server::config::WebhookSettings`' is, and no error path formats it.
//!
//! ## The two lifetimes, and why they are not the same lifetime
//!
//! Two processes need a relay credential for one stream, and they need it for
//! different spans:
//!
//! | holder | how it gets one | how long the one it HOLDS lasts |
//! |---|---|---|
//! | the **viewer's browser** | once, on the `display-attach` grant | one TTL |
//! | the **producer** in the microVM | at each peer connection's pipeline construction, from that connection's `display-attach/validate` | one TTL |
//!
//! Both are **one TTL**, and the second row is the one to read carefully: the
//! producer is *served* a fresh credential on every 30-second re-validation, but
//! it only ever installs the first.
//!
//! The trap this design exists to avoid is the producer's. Its original
//! delivery was `envVars` (#1437), which arrives **once at create time**, so a
//! credential delivered that way is minted before the session even has viewers
//! and is already ageing when the first one arrives. Moving the producer's copy
//! onto the validate answer means each peer connection is built with a
//! credential minted **at the moment that viewer attached** — the full TTL is
//! ahead of it rather than partly spent.
//!
//! **What this does NOT do, stated plainly because an earlier draft of this
//! header claimed otherwise.** The producer re-validates every 30 seconds (to
//! hold its control-window lease open) and the server mints a fresh credential
//! on every one of those calls — but the producer **discards** the later ones.
//! It hands the credential to `webrtcbin` once, at pipeline construction, and
//! GStreamer offers no way to swap a TURN server underneath a running ICE agent
//! (reading `ice-agent` to reach one *destroys* it — measured in #1438 and
//! flagged in the producer's own source). So the re-validation is where a fresh
//! credential becomes **available**, not where a live pipeline is refreshed.
//!
//! The consequence is narrower than an earlier revision of this header
//! reasoned. That revision called the TTL a **ceiling on one continuous
//! stream** — past it, the argument went, the connection loses its relay and
//! the screen goes black. LIVE-5c measured it (PR #1570) and the measurement
//! said no: coturn checks the REST username's expiry **only when an
//! allocation is created**, never on an existing allocation's REFRESH, so a
//! 60-second credential carried a relay-only stream through a 200-second soak
//! with 10/10 typed beats delivered (the last at t+180s). The TTL bounds *when
//! a new allocation can be opened*, not how long a live stream may run — which
//! is why no remint machinery (ICE renegotiation) exists here: option (b) of
//! the LIVE-5c follow-up was adopted, and what was wrong was the narrative,
//! not the code.
//!
//! The case that remains, recorded so it is not rediscovered: a **mid-session
//! re-ALLOCATE** — which in practice means an **ICE restart** — authenticates
//! like any fresh ALLOCATE and therefore needs a credential valid *at that
//! moment*. Nothing in this codebase performs an ICE restart yet; the day
//! something does, that is the point where a remint hook must be added (mint
//! on restart, not on a timer — the fresh credential every 30-second
//! re-validation already serves is exactly what such a hook would install). A
//! *new* viewer needs no such hook (new connection, new pipeline, new
//! credential minted on attach).
//!
//! Both copies carry the **same subject**, so the two ends of one media path
//! appear in coturn's log under one username — which is the whole point of
//! having a per-session subject, given that relay↔relay is the only ICE path
//! that exists here (ADR-0165 증보 1 D3-1).
//!
//! ## Why the subject is the work session
//!
//! One credential per **session**, not per capability and not per member. Per
//! capability would mean the producer and the browser hold two different
//! usernames for one media path, which makes a coturn log line impossible to
//! join back to a session; per member would outlive the session it was issued
//! for. The session id is also the only identifier both sides of the stream
//! already agree on, and it is not a secret — a relay username is visible in
//! `chrome://webrtc-internals` by construction, so it must be something that
//! discloses nothing on its own. A work-session UUID discloses nothing.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use uuid::Uuid;

/// The default lifetime of a minted credential.
///
/// Bounded from **below** by the thing that would break: coturn checks the
/// expiry **only when an allocation is created** — an existing allocation's
/// REFRESH does not re-check it (LIVE-5c, PR #1570) — so this number is the
/// window in which a handed-out credential can still open a *new* allocation:
/// the attach-to-connect gap, plus any future mid-session re-ALLOCATE (ICE
/// restart — module header). It is **not** how long a continuous viewing
/// session can last; a stream that allocated inside the window keeps running
/// past the expiry. One hour covers the slowest plausible attach-to-connect
/// gap with room to spare.
///
/// Bounded from **above** by what a leaked username+password is worth: an hour
/// of relay on one instance, scoped to a session id an operator can grep. The
/// static credential this replaces had no upper bound at all.
pub const DEFAULT_TURN_CREDENTIAL_TTL_SECONDS: i64 = 3600;

/// The longest lifetime an operator may configure, whatever they typed.
///
/// ## Why there is a ceiling at all
///
/// [`TurnCredentialPolicy::new`] used to refuse only `ttl_seconds <= 0`, which
/// left the interesting direction open: `MOMO_TURN_CREDENTIAL_TTL_SECONDS` is a
/// number in an operator's environment, and a fat-fingered one (milliseconds
/// pasted into a seconds field, a year written out) turns the whole point of
/// this module inside out. A credential that lives for a year **is** the static
/// shared password it was built to retire — same blast radius, same
/// unrevocability, now wearing the word "ephemeral". A bound that only exists
/// in a runbook is a bound that is not there.
///
/// ## Why 24 hours, and why it is a clamp rather than a refusal
///
/// The credential names one work session and exists so a person can watch that
/// session's screen. Past a day, two things are true at once: no one is still
/// watching the same continuous stream, and the value has stopped being scoped
/// by anything an operator can reason about. Twenty-four hours is also where the
/// industry's own REST-credential ceilings sit (Twilio caps its TURN tokens
/// there), so it is a number an operator has probably already met.
///
/// An operator who genuinely wants a longer-lived relay credential is asking for
/// a different thing — rotate `static-auth-secret` on a schedule instead, which
/// bounds *every* credential at once and is the control that actually matches
/// the intent.
///
/// It **clamps** rather than refuses because of which failure each produces.
/// Refusing turns the policy into `None`, which is the "no relay configured"
/// state — so a typo in one number would silently drop every instance back to
/// the static credential this goal exists to retire, and nothing in the response
/// would say why. Clamping keeps the relay working and shortens a credential,
/// which is the harmless direction; the operator is told in the boot log
/// (`momo_server::config::turn_policy_from_env`).
pub const MAX_TURN_CREDENTIAL_TTL_SECONDS: i64 = 86_400;

/// coturn's `rest_api_separator`, whose default this deployment keeps.
const REST_API_SEPARATOR: char = ':';

/// One entry of the browser's `RTCConfiguration.iceServers`.
///
/// Field names are the W3C ones because the client hands this array to
/// `new RTCPeerConnection({ iceServers })` unchanged. A momo-flavoured spelling
/// here would be a mapping step in every client for no gain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
}

/// What an operator configured, reduced to what minting needs.
///
/// `Clone` because the server holds one in `AppState` and hands copies to the
/// two routes that mint. It is small (two strings and a number) and cloning it
/// is cheaper than the `Arc` indirection would be to read.
#[derive(Clone, PartialEq, Eq)]
pub struct TurnCredentialPolicy {
    /// The relay's `turn:` URLs, in the order the client should try them.
    /// ADR-0165 D3: oort-operated only — a third-party URL here would put media
    /// through somebody else's egress.
    urls: Vec<String>,
    /// coturn's `static-auth-secret`. Held in memory only; never logged, never
    /// echoed in a response, never in `Debug`.
    static_auth_secret: String,
    ttl_seconds: i64,
}

impl std::fmt::Debug for TurnCredentialPolicy {
    /// Hand-written, and the field it omits is the whole point: `static-auth-secret`
    /// is the one value that turns "a username anyone can read" into "a relay
    /// anyone can use". `tracing` renders `Debug`, so a derived impl would put
    /// it in the first log line that mentions the policy.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TurnCredentialPolicy")
            .field("urls", &self.urls)
            .field("ttl_seconds", &self.ttl_seconds)
            .field("secret_configured", &!self.static_auth_secret.is_empty())
            .finish_non_exhaustive()
    }
}

impl TurnCredentialPolicy {
    /// Build a policy, or `None` when the operator configured a half of one.
    ///
    /// Fail-closed the same way every other subsystem in this repository is: an
    /// instance with URLs and no secret, or a secret and no URLs, hands out **no**
    /// ICE servers rather than a credential nothing can verify. A client that
    /// receives an empty array falls back to whatever it was configured with
    /// before, which during the retirement window is the static credential the
    /// template already carries — that overlap is the retirement order the
    /// runbook demands (prove the new one, *then* remove the old one).
    ///
    /// `ttl_seconds` is **clamped** to [`MAX_TURN_CREDENTIAL_TTL_SECONDS`], and
    /// the clamp lives here rather than at the one caller for the reason the
    /// half-configuration rule does: this is the single door, so a second caller
    /// cannot arrive at a different ceiling. [`Self::ttl_seconds`] reports the
    /// clamped value, which is how the caller learns it happened.
    pub fn new(urls: Vec<String>, static_auth_secret: String, ttl_seconds: i64) -> Option<Self> {
        let urls: Vec<String> = urls
            .into_iter()
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty())
            .collect();
        let secret = static_auth_secret.trim().to_string();
        if urls.is_empty() || secret.is_empty() || ttl_seconds <= 0 {
            return None;
        }
        Some(TurnCredentialPolicy {
            urls,
            static_auth_secret: secret,
            ttl_seconds: ttl_seconds.min(MAX_TURN_CREDENTIAL_TTL_SECONDS),
        })
    }

    pub fn ttl_seconds(&self) -> i64 {
        self.ttl_seconds
    }

    pub fn urls(&self) -> &[String] {
        &self.urls
    }

    /// Mint the ICE server list for one work session, expiring `ttl` from now.
    ///
    /// One entry carrying every URL rather than one entry per URL: the W3C shape
    /// says a single `RTCIceServer` may list several `urls` that share one
    /// credential, and that is exactly our case (udp and tcp on the same relay).
    /// Splitting them would make a client believe it had two relays to fail over
    /// between when it has one.
    pub fn ice_servers_for_session(&self, session_id: Uuid) -> Vec<IceServer> {
        self.ice_servers_at(session_id, unix_now_seconds())
    }

    /// [`Self::ice_servers_for_session`] with the clock injected, so the tests
    /// below can assert a byte-exact credential instead of asserting that
    /// something base64-shaped came out.
    pub fn ice_servers_at(&self, session_id: Uuid, now_unix_seconds: i64) -> Vec<IceServer> {
        let username = format!(
            "{}{REST_API_SEPARATOR}{}",
            now_unix_seconds.saturating_add(self.ttl_seconds),
            session_id
        );
        let credential = self.credential_for(&username);
        vec![IceServer {
            urls: self.urls.clone(),
            username,
            credential,
        }]
    }

    /// `base64(HMAC-SHA1(secret, username))` — coturn's own derivation.
    fn credential_for(&self, username: &str) -> String {
        // `new_from_slice` on HMAC accepts any key length, so the only error
        // variant is unreachable; `expect` here would still be a panic in a
        // request path, and an empty credential would look like a bug in the
        // client. The constructor already refused an empty secret, so this
        // cannot be reached with one.
        let mut mac = Hmac::<Sha1>::new_from_slice(self.static_auth_secret.as_bytes())
            .expect("HMAC accepts a key of any length");
        mac.update(username.as_bytes());
        base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
    }
}

fn unix_now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        // Before 1970 the only sane answer is "already expired", which coturn
        // refuses. A clock that far wrong should not mint a working credential.
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> TurnCredentialPolicy {
        TurnCredentialPolicy::new(
            vec![
                "turn:223.130.142.109:3478?transport=udp".to_string(),
                "turn:223.130.142.109:3478?transport=tcp".to_string(),
            ],
            "s3cr3t".to_string(),
            DEFAULT_TURN_CREDENTIAL_TTL_SECONDS,
        )
        .expect("a complete configuration")
    }

    const SESSION: Uuid = Uuid::from_u128(0x0192_0000_0000_7000_8000_0000_0000_0001);

    /// The derivation, pinned to a value computed the way coturn computes it.
    ///
    /// This is the assertion that catches a "cleanup" swapping SHA-1 for the
    /// SHA-256 used everywhere else in this workspace: the code would still
    /// compile, still produce base64, and authenticate against nothing.
    #[test]
    fn the_credential_is_coturns_own_derivation() {
        let servers = policy().ice_servers_at(SESSION, 1_700_000_000);
        assert_eq!(servers.len(), 1, "one relay, several transports");
        let server = &servers[0];
        assert_eq!(
            server.username,
            format!("{}:{SESSION}", 1_700_000_000 + 3600),
            "coturn parses `<expiry>:<subject>` and nothing else"
        );

        let mut mac = Hmac::<Sha1>::new_from_slice(b"s3cr3t").unwrap();
        mac.update(server.username.as_bytes());
        let expected =
            base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        assert_eq!(server.credential, expected);

        // …and an INDEPENDENT vector, so the test fails when the *algorithm*
        // moves rather than merely agreeing with whatever the code now does.
        // The assertion above shares this crate's `Hmac<Sha1>`; this one does
        // not share anything, because the bytes were produced elsewhere:
        //
        //   python3 -c "import hmac,hashlib; print(hmac.new(
        //     b's3cr3t', b'1700003600:01920000-0000-7000-8000-000000000001',
        //     hashlib.sha1).digest().hex())"
        //
        // Written as BYTES rather than as the base64 string a client would see,
        // for a reason that is not stylistic: a 28-character base64 literal on a
        // line that mentions a credential is what a secret scanner is for, and a
        // test vector that has to be explained to `.gitleaksignore` every time
        // the line moves is a test vector that gets deleted.
        const EXPECTED_DIGEST: [u8; 20] = [
            0xbb, 0xa7, 0x31, 0xfe, 0x08, 0xb0, 0xac, 0x74, 0x2a, 0xd8, 0x44, 0xf6, 0x22, 0x47,
            0xc7, 0xa1, 0x81, 0x64, 0x29, 0xb8,
        ];
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&server.credential)
            .expect("the credential is base64, which is what coturn decodes");
        assert_eq!(
            decoded.len(),
            20,
            "SHA-1 is 20 bytes and SHA-256 is 32 — this length IS the guard \
             against 'tidying' the hash up to match the rest of the workspace, \
             which would compile, still produce base64, and authenticate no \
             browser at all"
        );
        assert_eq!(decoded, EXPECTED_DIGEST);
    }

    /// The expiry is in the username, which is what makes it ephemeral. A
    /// credential minted a second later is a different credential.
    #[test]
    fn every_mint_carries_its_own_expiry() {
        let policy = policy();
        let early = policy.ice_servers_at(SESSION, 1_700_000_000);
        let late = policy.ice_servers_at(SESSION, 1_700_000_060);
        assert_ne!(early[0].username, late[0].username);
        assert_ne!(
            early[0].credential, late[0].credential,
            "a static password is exactly what this replaces"
        );
    }

    /// Two sessions on one instance never share a credential — the property
    /// that makes a coturn log line answer 「어느 세션이 relay를 썼나」.
    #[test]
    fn the_subject_scopes_the_credential_to_one_session() {
        let policy = policy();
        let one = policy.ice_servers_at(Uuid::from_u128(1), 1_700_000_000);
        let two = policy.ice_servers_at(Uuid::from_u128(2), 1_700_000_000);
        assert_ne!(one[0].username, two[0].username);
        assert_ne!(one[0].credential, two[0].credential);
    }

    /// Half a configuration is no configuration. The client then receives an
    /// empty `iceServers` and keeps whatever it already had, which during the
    /// retirement window is the static credential — the overlap the runbook's
    /// 「신규 실증 → 정적 제거」 order requires.
    #[test]
    fn a_half_configured_relay_mints_nothing() {
        assert!(TurnCredentialPolicy::new(vec![], "s".into(), 3600).is_none());
        assert!(
            TurnCredentialPolicy::new(vec!["turn:host:3478".into()], "   ".into(), 3600).is_none()
        );
        assert!(TurnCredentialPolicy::new(vec!["turn:host:3478".into()], "s".into(), 0).is_none());
        assert!(TurnCredentialPolicy::new(vec!["  ".into()], "s".into(), 3600).is_none());
    }

    /// The direction the original `ttl_seconds <= 0` guard left open, and the
    /// one that actually matters: a credential configured to outlive a day is
    /// the static shared password this module exists to retire — same blast
    /// radius, same unrevocability, now called "ephemeral".
    #[test]
    fn an_operator_cannot_configure_a_credential_that_outlives_the_ceiling() {
        for asked in [
            MAX_TURN_CREDENTIAL_TTL_SECONDS + 1,
            // Milliseconds pasted into a seconds field — the shape of the typo
            // this guards, not a hypothetical.
            3_600_000,
            365 * 24 * 3600,
            i64::MAX,
        ] {
            let policy =
                TurnCredentialPolicy::new(vec!["turn:host:3478".into()], "s".into(), asked)
                    .expect("an over-long TTL must clamp, never close the relay");
            assert_eq!(
                policy.ttl_seconds(),
                MAX_TURN_CREDENTIAL_TTL_SECONDS,
                "asked for {asked}s"
            );
        }
    }

    /// …and the clamp does not quietly shorten a value that was already legal.
    /// A ceiling that also moved the ordinary case would make every deployment's
    /// credential a different length than its operator configured.
    #[test]
    fn a_ttl_inside_the_ceiling_is_used_verbatim() {
        for asked in [
            1,
            DEFAULT_TURN_CREDENTIAL_TTL_SECONDS,
            MAX_TURN_CREDENTIAL_TTL_SECONDS,
        ] {
            let policy =
                TurnCredentialPolicy::new(vec!["turn:host:3478".into()], "s".into(), asked)
                    .expect("a complete configuration");
            assert_eq!(policy.ttl_seconds(), asked);
        }
    }

    /// The clamp is not decorative: it has to reach the credential a client is
    /// actually handed, which is the username's expiry field.
    #[test]
    fn the_ceiling_reaches_the_minted_username() {
        let policy =
            TurnCredentialPolicy::new(vec!["turn:host:3478".into()], "s3cr3t".into(), i64::MAX / 2)
                .expect("clamped, not refused");
        let servers = policy.ice_servers_at(SESSION, 1_700_000_000);
        let (expiry, _) = servers[0]
            .username
            .split_once(':')
            .expect("coturn parses `<expiry>:<subject>`");
        assert_eq!(
            expiry.parse::<i64>().expect("unix seconds"),
            1_700_000_000 + MAX_TURN_CREDENTIAL_TTL_SECONDS,
            "an unclamped TTL would also have overflowed the `saturating_add` \
             into a nonsense expiry"
        );
    }

    /// The two constants must stay in the relation their prose claims, checked
    /// at COMPILE time — a default raised above the ceiling would be silently
    /// clamped on every boot, which is a default that does not mean what it says.
    #[test]
    fn the_default_lives_inside_the_ceiling() {
        const {
            assert!(DEFAULT_TURN_CREDENTIAL_TTL_SECONDS > 0);
            assert!(DEFAULT_TURN_CREDENTIAL_TTL_SECONDS <= MAX_TURN_CREDENTIAL_TTL_SECONDS);
        }
    }

    /// The secret is not in `Debug`, because `tracing` renders `Debug`.
    #[test]
    fn the_secret_never_reaches_a_log_line() {
        let rendered = format!("{:?}", policy());
        assert!(
            !rendered.contains("s3cr3t"),
            "the static-auth-secret must not be formattable: {rendered}"
        );
        assert!(rendered.contains("secret_configured: true"));
    }

    /// A relay somebody else operates is a media path momo cannot account for
    /// (ADR-0165 D3). This module cannot enforce that — the URL comes from the
    /// operator's environment — but the value it carries is exactly what the
    /// conformance assertion in `verify_display_attach.sh` reads, so the shape
    /// is pinned here.
    #[test]
    fn the_urls_are_carried_through_verbatim() {
        let policy = policy();
        let servers = policy.ice_servers_at(SESSION, 1_700_000_000);
        assert_eq!(servers[0].urls, policy.urls());
        assert_eq!(servers[0].urls.len(), 2, "udp and tcp on one relay");
    }
}
