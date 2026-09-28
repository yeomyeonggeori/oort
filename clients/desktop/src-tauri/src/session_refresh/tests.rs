//! #3106 — the shell's rotation against a model of the #3079 server.
//!
//! `Server` below re-implements the server's decision table from ADR-0146
//! D-7 증보 #3079 (`auth_routes::answer_spent`): binding on the lineage's
//! first token within 10 minutes, verification against the bound key, ±5 min,
//! single-use nonces, the #3074 30-second reissue, recovery of a spent token
//! with the bound key's proof, and `require`. It builds the signed bytes
//! itself (not with `proof.rs`) and verifies with p256, so a client that
//! drifts from momo-wire's bytes fails here too — and the vector test pins
//! both to momo-wire's own output.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use p256::ecdsa::signature::{Signer as _, Verifier as _};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use serde_json::Value;

use super::proof::*;
use super::*;

const VECTOR: &str = include_str!("../../../../../docs/api/refresh-proof.vector.json");
const WS: Uuid = Uuid::from_u128(0x11);
const MEMBER: Uuid = Uuid::from_u128(0x22);
const BASE: &str = "https://oort.example";
const T0: i64 = 1_790_000_000_000;

fn block<F: Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
}

// ---- fakes --------------------------------------------------------------------

/// A software key standing in for the enclave — tests only.
struct SoftKey {
    key: SigningKey,
    signs: AtomicUsize,
    absent: bool,
}

impl SoftKey {
    fn new(seed: u8) -> Self {
        Self {
            key: SigningKey::from_slice(&[seed; 32]).unwrap(),
            signs: AtomicUsize::new(0),
            absent: false,
        }
    }

    fn none() -> Self {
        Self {
            absent: true,
            ..Self::new(1)
        }
    }

    fn public(&self) -> [u8; P256_PUBLIC_KEY_LEN] {
        let point = self.key.verifying_key().to_encoded_point(true);
        point.as_bytes().try_into().unwrap()
    }
}

impl RefreshSigner for SoftKey {
    fn prove(&self, fields: &ProofFields<'_>) -> Result<Option<DeviceProof>, String> {
        if self.absent {
            return Ok(None);
        }
        self.signs.fetch_add(1, Ordering::SeqCst);
        let public = self.public();
        let bytes = refresh_proof_bytes(fields, &public).map_err(|e| format!("{e:?}"))?;
        let signature: Signature = self.key.sign(&bytes);
        let signature = signature.normalize_s().unwrap_or(signature);
        Ok(Some(DeviceProof {
            public_key: BASE64.encode(public),
            nonce: fields.nonce,
            signed_at_ms: fields.signed_at_ms,
            signature: BASE64.encode(signature.to_bytes()),
        }))
    }
}

#[derive(Default)]
struct MemStore {
    token: Mutex<Option<String>>,
    origin: Mutex<Option<String>>,
    refuse_store: Mutex<bool>,
}

impl MemStore {
    fn with(token: &str) -> Arc<Self> {
        let store = Self::default();
        *store.token.lock().unwrap() = Some(token.into());
        *store.origin.lock().unwrap() = Some(BASE.into());
        Arc::new(store)
    }
    fn token(&self) -> Option<String> {
        self.token.lock().unwrap().clone()
    }
}

impl TokenStore for MemStore {
    fn load(&self) -> Result<Option<String>, String> {
        Ok(self.token())
    }
    fn store(&self, token: &str) -> Result<(), String> {
        if *self.refuse_store.lock().unwrap() {
            return Err("refused".into());
        }
        *self.token.lock().unwrap() = Some(token.into());
        Ok(())
    }
    fn clear(&self) -> Result<(), String> {
        *self.token.lock().unwrap() = None;
        Ok(())
    }
    fn origin(&self) -> Result<Option<String>, String> {
        Ok(self.origin.lock().unwrap().clone())
    }
    fn set_origin(&self, origin: Option<&str>) -> Result<(), String> {
        *self.origin.lock().unwrap() = origin.map(str::to_owned);
        Ok(())
    }
}

struct Tok {
    lineage: u32,
    issued_at: i64,
    first: bool,
    spent_at: Option<i64>,
    successor: Option<String>,
}

#[derive(Default)]
struct ServerState {
    now: i64,
    require: bool,
    next: u32,
    tokens: HashMap<String, Tok>,
    ended: HashSet<u32>,
    bound: HashMap<u32, String>,
    nonces: HashSet<Uuid>,
    /// The next 200 is committed on the server and never reaches the client.
    lose_next_answer: bool,
    /// Requests that reached the server: (path, had proof).
    seen: Vec<(String, bool)>,
    revoked: HashSet<String>,
}

/// The #3079 server, in memory.
#[derive(Default)]
struct Server(Mutex<ServerState>);

#[derive(Debug, PartialEq)]
enum Verdict {
    Missing,
    Foreign,
    Stale,
    Replayed,
    Ok,
}

impl Server {
    fn sign_in(&self) -> String {
        let mut s = self.0.lock().unwrap();
        s.next += 1;
        let lineage = s.next;
        let token = format!("rt-{lineage}-0");
        let now = s.now;
        s.tokens.insert(
            token.clone(),
            Tok {
                lineage,
                issued_at: now,
                first: true,
                spent_at: None,
                successor: None,
            },
        );
        token
    }

    fn advance(&self, ms: i64) {
        self.0.lock().unwrap().now += ms;
    }

    fn state(&self) -> std::sync::MutexGuard<'_, ServerState> {
        self.0.lock().unwrap()
    }

    fn mint(s: &mut ServerState, lineage: u32) -> String {
        s.next += 1;
        let token = format!("rt-{lineage}-{}", s.next);
        let now = s.now;
        s.tokens.insert(
            token.clone(),
            Tok {
                lineage,
                issued_at: now,
                first: false,
                spent_at: None,
                successor: None,
            },
        );
        token
    }

    fn answer(status: u16, body: Value) -> HttpAnswer {
        HttpAnswer {
            status,
            date: Some("Mon, 28 Sep 2026 00:00:00 GMT".into()),
            body: body.to_string(),
        }
    }

    fn refused(code: Option<&str>) -> HttpAnswer {
        let mut error = serde_json::json!({ "message": "no" });
        if let Some(code) = code {
            error["code"] = code.into();
        }
        Self::answer(401, serde_json::json!({ "error": error }))
    }

    /// A proof → (the key it names, whether its signature verifies). The
    /// bytes are built HERE, independently of `proof.rs`.
    fn check_proof(proof: &Value, token: &str, now: i64) -> (String, bool, bool, Uuid) {
        let key = proof["publicKey"].as_str().unwrap().to_owned();
        let nonce: Uuid = proof["nonce"].as_str().unwrap().parse().unwrap();
        let signed_at = proof["signedAtMs"].as_i64().unwrap();
        let bytes = format!(
            "momo.human.refresh_proof.v1\n{WS}\n{MEMBER}\n{key}\n{}\n{nonce}\n{signed_at}",
            hex::encode(Sha256::digest(token.as_bytes()))
        );
        let verifies = (|| {
            let public = VerifyingKey::from_sec1_bytes(&BASE64.decode(&key).ok()?).ok()?;
            let signature =
                Signature::from_slice(&BASE64.decode(proof["signature"].as_str()?).ok()?).ok()?;
            public.verify(bytes.as_bytes(), &signature).ok()
        })()
        .is_some();
        let fresh = (now - signed_at).abs() <= 5 * 60 * 1000;
        (key, verifies, fresh, nonce)
    }

    fn refresh(&self, body: &Value) -> Option<HttpAnswer> {
        let mut s = self.0.lock().unwrap();
        let token = body["refreshToken"].as_str().unwrap().to_owned();
        let proof = body.get("deviceProof");
        s.seen.push(("/v1/auth/refresh".into(), proof.is_some()));
        let now = s.now;
        let Some(tok) = s.tokens.get(&token) else {
            return Some(Self::refused(None));
        };
        let lineage = tok.lineage;
        let spent = tok.spent_at;
        if s.ended.contains(&lineage) {
            return Some(Self::refused(None));
        }
        // Signature → bind (first token, 10 min) → time → nonce.
        let mut verdict = Verdict::Missing;
        if let Some(proof) = proof {
            let (key, verifies, fresh, nonce) = Self::check_proof(proof, &token, now);
            if verifies
                && !s.bound.contains_key(&lineage)
                && spent.is_none()
                && tok.first
                && now - tok.issued_at <= 10 * 60 * 1000
            {
                s.bound.insert(lineage, key.clone());
            }
            verdict = match s.bound.get(&lineage) {
                Some(bound) if *bound == key && verifies => {
                    if !fresh {
                        Verdict::Stale
                    } else if !s.nonces.insert(nonce) {
                        Verdict::Replayed
                    } else {
                        Verdict::Ok
                    }
                }
                _ => Verdict::Foreign,
            };
        }
        let bound = s.bound.contains_key(&lineage);
        let code = |v: &Verdict| match v {
            Verdict::Missing => "refresh_proof_required",
            Verdict::Stale => "refresh_proof_stale",
            Verdict::Replayed => "refresh_proof_replayed",
            _ => "refresh_proof_invalid",
        };
        let pair = |s: &mut ServerState| {
            let refresh = Self::mint(s, lineage);
            let lose = std::mem::take(&mut s.lose_next_answer);
            let answer = Self::answer(
                200,
                serde_json::json!({ "accessToken": format!("at-for-{refresh}"), "refreshToken": refresh }),
            );
            (!lose).then_some(answer)
        };
        match spent {
            None => {
                if bound && s.require && verdict != Verdict::Ok {
                    return Some(Self::refused(Some(code(&verdict))));
                }
                let answer = pair(&mut s);
                let successor = format!("rt-{lineage}-{}", s.next);
                let tok = s.tokens.get_mut(&token).unwrap();
                tok.spent_at = Some(now);
                tok.successor = Some(successor);
                answer
            }
            Some(spent_at) => match verdict {
                Verdict::Ok if bound => {
                    // Recovery: every live token of the lineage dies, a fresh
                    // pair in the same lineage.
                    for tok in s.tokens.values_mut() {
                        if tok.lineage == lineage && tok.spent_at.is_none() {
                            tok.spent_at = Some(now);
                        }
                    }
                    pair(&mut s)
                }
                Verdict::Stale | Verdict::Replayed if bound => {
                    Some(Self::refused(Some(code(&verdict))))
                }
                _ if bound && s.require => {
                    s.ended.insert(lineage);
                    Some(Self::refused(None))
                }
                _ if now - spent_at <= 30_000 => {
                    // #3074: the unused successor, again.
                    let successor = s.tokens[&token].successor.clone().unwrap();
                    Some(Self::answer(
                        200,
                        serde_json::json!({ "accessToken": "at-reissued", "refreshToken": successor }),
                    ))
                }
                _ => {
                    s.ended.insert(lineage);
                    Some(Self::refused(None))
                }
            },
        }
    }

    fn logout(&self, body: &Value, bearer: Option<&str>) -> HttpAnswer {
        let mut s = self.0.lock().unwrap();
        s.seen.push(("/v1/auth/logout".into(), false));
        if bearer.is_none_or(|b| b == "at-expired") {
            return Self::refused(None);
        }
        if let Some(refresh) = body.get("refreshToken").and_then(Value::as_str) {
            s.revoked.insert(refresh.to_owned());
        }
        Self::answer(200, serde_json::json!({ "status": "ok" }))
    }
}

impl Transport for Arc<Server> {
    fn post_json(
        &self,
        url: String,
        body: String,
        bearer: Option<String>,
    ) -> impl Future<Output = Result<HttpAnswer, String>> + Send {
        let server = self.clone();
        async move {
            let body: Value = serde_json::from_str(&body).unwrap();
            if url == format!("{BASE}/v1/auth/refresh") {
                server
                    .refresh(&body)
                    .ok_or_else(|| "session_unreachable: timeout".to_string())
            } else if url == format!("{BASE}/v1/auth/logout") {
                Ok(server.logout(&body, bearer.as_deref()))
            } else {
                Err(format!("session_unreachable: unexpected {url}"))
            }
        }
    }
}

fn server() -> Arc<Server> {
    let server = Arc::new(Server::default());
    server.state().now = T0;
    server
}

fn request(skew_ms: i64) -> AttemptRequest {
    AttemptRequest {
        api_base: BASE.into(),
        workspace_id: WS,
        member_id: MEMBER,
        skew_ms,
    }
}

fn run(
    server: &Arc<Server>,
    store: &Arc<MemStore>,
    key: &Arc<SoftKey>,
) -> Result<AttemptAnswer, String> {
    let now = server.state().now;
    block(attempt(
        server,
        store.clone(),
        key.clone(),
        &request(0),
        now,
    ))
}

// ---- the bytes ------------------------------------------------------------------

/// The shared vector (docs/api/refresh-proof.vector.json) was printed by
/// momo-wire itself; this builder must produce its bytes, and the same key
/// must produce its signature (RFC 6979, low-s).
#[test]
fn proof_bytes_match_momo_wire_and_its_signature() {
    let vector: Value = serde_json::from_str(VECTOR).unwrap();
    let inputs = &vector["inputs"];
    let key = SigningKey::from_slice(&[9u8; 32]).unwrap();
    let public: [u8; P256_PUBLIC_KEY_LEN] = key
        .verifying_key()
        .to_encoded_point(true)
        .as_bytes()
        .try_into()
        .unwrap();
    assert_eq!(BASE64.encode(public), inputs["publicKey"].as_str().unwrap());
    let token = inputs["refreshToken"].as_str().unwrap();
    assert_eq!(
        refresh_token_sha256_hex(token),
        vector["refreshTokenSha256"].as_str().unwrap()
    );
    let fields = ProofFields {
        workspace_id: inputs["workspaceId"].as_str().unwrap().parse().unwrap(),
        member_id: inputs["memberId"].as_str().unwrap().parse().unwrap(),
        refresh_token: token,
        nonce: inputs["nonce"].as_str().unwrap().parse().unwrap(),
        signed_at_ms: inputs["signedAtMs"].as_i64().unwrap(),
    };
    let bytes = refresh_proof_bytes(&fields, &public).unwrap();
    assert_eq!(
        std::str::from_utf8(&bytes).unwrap(),
        vector["payload"].as_str().unwrap()
    );
    let signature: Signature = key.sign(&bytes);
    let signature = signature.normalize_s().unwrap_or(signature);
    assert_eq!(
        BASE64.encode(signature.to_bytes()),
        vector["signature"].as_str().unwrap()
    );
}

#[test]
fn a_malformed_proof_is_refused_before_it_is_signed() {
    let public = SoftKey::new(3).public();
    let fields = |token: &'static str, at: i64| ProofFields {
        workspace_id: WS,
        member_id: MEMBER,
        refresh_token: token,
        nonce: Uuid::from_u128(1),
        signed_at_ms: at,
    };
    assert_eq!(
        refresh_proof_bytes(&fields("", T0), &public),
        Err(ProofError::Token)
    );
    assert_eq!(
        refresh_proof_bytes(&fields("t", 0), &public),
        Err(ProofError::SignedAt)
    );
    assert_eq!(
        refresh_proof_bytes(&fields("t", 1 << 53), &public),
        Err(ProofError::SignedAt)
    );
    let mut uncompressed = public;
    uncompressed[0] = 0x04;
    assert_eq!(
        refresh_proof_bytes(&fields("t", T0), &uncompressed),
        Err(ProofError::PublicKey)
    );
}

/// Cross-sabotage, the desktop half: the instruction key's last gate refuses
/// a refresh proof, and nothing the refresh builder makes starts with an
/// instruction schema. Sabotage: add `(REFRESH_PROOF_SCHEMA_V1, 7)` to
/// `device_key::payload::SIGNING_SCHEMAS` — RED.
#[cfg(target_os = "macos")]
#[test]
fn the_instruction_key_never_signs_a_refresh_proof_and_the_refresh_key_nothing_else() {
    use crate::device_key::payload;
    let vector: Value = serde_json::from_str(VECTOR).unwrap();
    let refresh_bytes = vector["payload"].as_str().unwrap().as_bytes();
    assert!(payload::check_signing_payload(refresh_bytes).is_err());
    assert!(payload::SIGNING_SCHEMAS
        .iter()
        .all(|(schema, _)| *schema != REFRESH_PROOF_SCHEMA_V1));
    let bytes = refresh_proof_bytes(
        &ProofFields {
            workspace_id: WS,
            member_id: MEMBER,
            refresh_token: "t",
            nonce: Uuid::from_u128(1),
            signed_at_ms: T0,
        },
        &SoftKey::new(3).public(),
    )
    .unwrap();
    let first = std::str::from_utf8(&bytes).unwrap().lines().next().unwrap();
    assert_eq!(first, REFRESH_PROOF_SCHEMA_V1);
    assert_eq!(std::str::from_utf8(&bytes).unwrap().split('\n').count(), 7);
}

#[test]
fn the_handle_names_a_token_without_being_one() {
    let handle = handle_of("header.payload.signature");
    assert_eq!(handle, "shell:256d04db4e5e4ac308751ed0885b722b");
    assert!(!handle.contains("payload"));
    assert_ne!(handle_of("a"), handle_of("b"));
}

#[test]
fn origins_are_scheme_host_port_and_nothing_else() {
    assert_eq!(origin_of("https://oort.example/").as_deref(), Some(BASE));
    assert_eq!(origin_of("https://oort.example/api").as_deref(), Some(BASE));
    assert_eq!(
        origin_of("http://10.0.0.2:8080").as_deref(),
        Some("http://10.0.0.2:8080")
    );
    assert_eq!(origin_of("tauri://localhost"), None);
    assert_eq!(origin_of(""), None);
    assert_eq!(origin_of("https://user:pw@oort.example"), None);
    assert!(endpoint("https://oort.example?x=1", "/v1/auth/refresh").is_err());
}

// ---- the rotation ---------------------------------------------------------------

/// Sign-in → the bind refresh (the client MUST): the first proof binds the key.
#[test]
fn the_first_refresh_after_sign_in_binds_the_key_and_stores_the_successor() {
    let server = server();
    let token = server.sign_in();
    let store = MemStore::with(&token);
    let key = Arc::new(SoftKey::new(5));
    let answer = run(&server, &store, &key).unwrap();
    assert_eq!(answer.status, 200);
    assert!(answer.proved);
    let stored = store.token().unwrap();
    assert_ne!(stored, token);
    assert_eq!(
        answer.refresh_token.as_deref(),
        Some(handle_of(&stored).as_str())
    );
    assert!(
        !answer.refresh_token.unwrap().contains(&stored),
        "never the token"
    );
    assert_eq!(
        server.state().bound.get(&1),
        Some(&BASE64.encode(key.public()))
    );
}

/// The issue's case: the answer to a rotation is lost (Cmd+Q, a dropped
/// connection) and the app comes back after the 30-second reissue window. The
/// stored token is the spent one; presented with a proof it recovers.
/// Sabotage: send no proof (`SoftKey::none()` on the second run) — the server
/// ends the lineage and this goes RED.
#[test]
fn a_rotation_lost_for_longer_than_30_seconds_recovers_with_the_proof() {
    for gap in [31_000, 60 * 60 * 1000] {
        let server = server();
        let token = server.sign_in();
        let store = MemStore::with(&token);
        let key = Arc::new(SoftKey::new(5));
        assert_eq!(run(&server, &store, &key).unwrap().status, 200, "bound");
        let spent = store.token().unwrap();

        server.state().lose_next_answer = true;
        let lost = run(&server, &store, &key);
        assert!(lost.is_err(), "nothing answered: {lost:?}");
        assert_eq!(store.token().as_deref(), Some(spent.as_str()), "kept");
        assert!(
            server.state().tokens[&spent].spent_at.is_some(),
            "the server spent it"
        );

        server.advance(gap);
        // The next launch: a new shell, the same keychain and enclave key.
        let answer = run(&server, &store, &key).unwrap();
        assert_eq!(answer.status, 200, "recovered after {gap} ms: {answer:?}");
        let fresh = store.token().unwrap();
        assert_ne!(fresh, spent);
        assert!(server.state().tokens[&fresh].spent_at.is_none());
        assert!(!server.state().ended.contains(&1));
        // And rotates on normally from there.
        assert_eq!(run(&server, &store, &key).unwrap().status, 200);
    }
}

/// Same loss, under `require`, without the key: the lineage ends. Proves the
/// model enforces the proof, so the test above cannot pass on the model's
/// leniency.
#[test]
fn without_the_proof_the_same_loss_ends_the_lineage_under_require() {
    let server = server();
    server.state().require = true;
    let token = server.sign_in();
    let store = MemStore::with(&token);
    let key = Arc::new(SoftKey::new(5));
    assert_eq!(run(&server, &store, &key).unwrap().status, 200);
    server.state().lose_next_answer = true;
    assert!(run(&server, &store, &key).is_err());
    server.advance(31_000);
    let answer = run(&server, &store, &Arc::new(SoftKey::none())).unwrap();
    assert_eq!(answer.status, 401);
    assert!(!answer.proved);
    assert!(server.state().ended.contains(&1));
}

/// A keychain that refuses the successor: the token is spent and not stored.
/// The attempt fails as "nothing proven" and the next one recovers.
#[test]
fn a_failed_keychain_write_is_recovered_by_the_next_attempt() {
    let server = server();
    let token = server.sign_in();
    let store = MemStore::with(&token);
    let key = Arc::new(SoftKey::new(5));
    assert_eq!(run(&server, &store, &key).unwrap().status, 200);
    let kept = store.token().unwrap();
    *store.refuse_store.lock().unwrap() = true;
    assert_eq!(
        run(&server, &store, &key),
        Err("session_store_failed".into())
    );
    assert_eq!(store.token().as_deref(), Some(kept.as_str()));
    *store.refuse_store.lock().unwrap() = false;
    server.advance(45_000);
    assert_eq!(run(&server, &store, &key).unwrap().status, 200);
}

/// Refusals come back coded, with the `Date` the core corrects the clock by,
/// and leave the stored token alone.
#[test]
fn a_refusal_is_passed_back_coded_and_the_token_is_untouched() {
    let server = server();
    server.state().require = true;
    let token = server.sign_in();
    let store = MemStore::with(&token);
    let key = Arc::new(SoftKey::new(5));
    assert_eq!(run(&server, &store, &key).unwrap().status, 200);
    let live = store.token().unwrap();
    // Ten minutes of clock error: stale, not a sign-out.
    let now = server.state().now;
    let stale = block(attempt(
        &server,
        store.clone(),
        key.clone(),
        &request(0),
        now - 600_000,
    ))
    .unwrap();
    assert_eq!(stale.status, 401);
    assert_eq!(stale.code.as_deref(), Some("refresh_proof_stale"));
    assert!(stale.date.is_some());
    assert!(stale.proved);
    assert_eq!(store.token().as_deref(), Some(live.as_str()));
    // The core's retry: the same local clock plus the server's skew.
    let retried = block(attempt(
        &server,
        store.clone(),
        key.clone(),
        &request(600_000),
        now - 600_000,
    ))
    .unwrap();
    assert_eq!(retried.status, 200);
    // Another key: invalid, token untouched.
    let foreign = run(&server, &store, &Arc::new(SoftKey::new(6))).unwrap();
    assert_eq!(foreign.code.as_deref(), Some("refresh_proof_invalid"));
}

/// A script in the webview can ask for a rotation but not choose where the
/// token goes. Sabotage: skip `check_origin` in `attempt` — the token is
/// POSTed to the other host and this goes RED.
#[test]
fn the_token_is_presented_only_to_the_origin_it_was_stored_for() {
    let server = server();
    let token = server.sign_in();
    let store = MemStore::with(&token);
    let key = Arc::new(SoftKey::new(5));
    let mut evil = request(0);
    evil.api_base = "https://evil.example".into();
    let refused = block(attempt(&server, store.clone(), key.clone(), &evil, T0));
    assert_eq!(refused, Err("session_origin_mismatch".into()));
    assert!(server.state().seen.is_empty(), "nothing was sent");
    assert_eq!(key.signs.load(Ordering::SeqCst), 0, "nothing was signed");
    // A legacy record (no pin) takes the first origin it is used with.
    *store.origin.lock().unwrap() = None;
    assert_eq!(run(&server, &store, &key).unwrap().status, 200);
    assert_eq!(store.origin().unwrap().as_deref(), Some(BASE));
}

#[test]
fn no_stored_token_is_a_sign_out_not_a_network_error() {
    let server = server();
    let store = Arc::new(MemStore::default());
    let answer = run(&server, &store, &Arc::new(SoftKey::new(5))).unwrap();
    assert_eq!(
        (answer.status, answer.code.as_deref()),
        (401, Some("session_absent"))
    );
    assert!(server.state().seen.is_empty());
}

/// A build without a key still rotates (observe): no proof, no failure.
#[test]
fn a_build_without_a_refresh_key_rotates_without_a_proof() {
    let server = server();
    let token = server.sign_in();
    let store = MemStore::with(&token);
    let answer = run(&server, &store, &Arc::new(SoftKey::none())).unwrap();
    assert_eq!(answer.status, 200);
    assert!(!answer.proved);
    assert_eq!(
        server.state().seen,
        vec![("/v1/auth/refresh".to_string(), false)]
    );
}

// ---- logout ---------------------------------------------------------------------

#[test]
fn revoke_uses_the_token_only_the_shell_holds_and_wipes_it() {
    let server = server();
    let token = server.sign_in();
    let store = MemStore::with(&token);
    let key = Arc::new(SoftKey::new(5));
    let revoke_request = RevokeRequest {
        api_base: BASE.into(),
        access_token: "at-live".into(),
        workspace_id: WS,
        member_id: MEMBER,
    };
    // The clear ran first and stashed it.
    store.clear().unwrap();
    let ok = block(revoke(
        &server,
        store.clone(),
        key.clone(),
        Some(token.clone()),
        &revoke_request,
        T0,
    ))
    .unwrap();
    assert!(ok);
    assert!(server.state().revoked.contains(&token));
    assert_eq!(store.token(), None);
    assert_eq!(store.origin().unwrap(), None, "the pin goes with the token");
}

/// The access token expired before logout: the refresh half is rotated once
/// with a proof and the minted pair revoked (else the lineage would stay
/// rotatable for 30 days).
#[test]
fn revoke_with_an_expired_access_token_rotates_with_a_proof_and_revokes_the_pair() {
    let server = server();
    server.state().require = true;
    let token = server.sign_in();
    let store = MemStore::with(&token);
    let key = Arc::new(SoftKey::new(5));
    assert_eq!(run(&server, &store, &key).unwrap().status, 200);
    let live = store.token().unwrap();
    let revoke_request = RevokeRequest {
        api_base: BASE.into(),
        access_token: "at-expired".into(),
        workspace_id: WS,
        member_id: MEMBER,
    };
    let now = server.state().now;
    let ok = block(revoke(
        &server,
        store.clone(),
        key.clone(),
        None,
        &revoke_request,
        now,
    ))
    .unwrap();
    assert!(ok);
    let seen = server.state().seen.clone();
    assert!(
        seen.contains(&("/v1/auth/refresh".to_string(), true)),
        "{seen:?}"
    );
    let revoked = server.state().revoked.clone();
    assert_eq!(revoked.len(), 1);
    assert_ne!(revoked.iter().next().unwrap(), &live, "the minted pair");
    assert_eq!(store.token(), None);
}

#[test]
fn revoke_to_another_origin_sends_nothing_and_still_wipes() {
    let server = server();
    let token = server.sign_in();
    let store = MemStore::with(&token);
    let revoke_request = RevokeRequest {
        api_base: "https://evil.example".into(),
        access_token: "at-live".into(),
        workspace_id: WS,
        member_id: MEMBER,
    };
    let result = block(revoke(
        &server,
        store.clone(),
        Arc::new(SoftKey::new(5)),
        None,
        &revoke_request,
        T0,
    ));
    assert_eq!(result, Err("session_origin_mismatch".into()));
    assert!(server.state().seen.is_empty());
    assert_eq!(store.token(), None);
}

// ---- the real transport ------------------------------------------------------------

/// `ReqwestTransport` against a socket: a connection closed without an answer
/// is `Err` (nothing proven), a real answer brings its status, `Date` and body;
/// a redirect is not followed.
#[test]
fn the_reqwest_transport_reports_a_lost_answer_and_follows_no_redirect() {
    use std::io::{Read as _, Write as _};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let answers = [
            None,
            Some("HTTP/1.1 401 Unauthorized\r\nDate: Mon, 28 Sep 2026 00:00:00 GMT\r\nContent-Type: application/json\r\nContent-Length: 45\r\nConnection: close\r\n\r\n{\"error\":{\"code\":\"refresh_proof_replayed\"}}  "),
            Some("HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:9/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
        ];
        for answer in answers {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer);
            if let Some(answer) = answer {
                stream.write_all(answer.as_bytes()).unwrap();
            }
            // `None`: drop the connection — the server may well have
            // committed; the client cannot know.
        }
    });
    let transport = ReqwestTransport::new().unwrap();
    let url = format!("http://127.0.0.1:{port}/v1/auth/refresh");
    let lost = block(transport.post_json(url.clone(), "{}".into(), None));
    assert!(lost.is_err(), "{lost:?}");
    let coded = block(transport.post_json(url.clone(), "{}".into(), None)).unwrap();
    assert_eq!(coded.status, 401);
    assert_eq!(coded.date.as_deref(), Some("Mon, 28 Sep 2026 00:00:00 GMT"));
    assert_eq!(
        error_code(&coded.body).as_deref(),
        Some("refresh_proof_replayed")
    );
    let redirect = block(transport.post_json(url, "{}".into(), None)).unwrap();
    assert_eq!(redirect.status, 307, "not followed");
    server.join().unwrap();
}
