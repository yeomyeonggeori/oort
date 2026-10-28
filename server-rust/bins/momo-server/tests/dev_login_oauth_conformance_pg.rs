//! ADR-0216 D6 (나) — `oort login`: the **human-subject arm** of the OAuth 2.1 authorization server, end to
//! end on a real PostgreSQL 18 and the real Axum router (`momo_app`, NOBYPASSRLS). The expectations come
//! from the wire contract and the ADR, never from the handlers: the PKCE challenge is derived here with
//! `sha2`, every digest is recomputed here and compared with what the database holds, every scope list is
//! spelled out in the contract's order, and every "nothing happened" is a row count read back as the
//! superuser.
//!
//! | group | proves | goes red if |
//! |---|---|---|
//! | authorize | the request becomes one signed envelope and **no** write; only the five loopback redirects are redirects (every other spelling is a 400 with no `Location`, even when PKCE/scope are also wrong); every later error goes back to the registered redirect with `error`, `state`, `iss`; the device name is bounded | an unknown redirect is redirected to, `plain` or a missing method is accepted, a row is written for an anonymous request, scope/resource/state/device name checks are dropped |
//! | consent screen | `preview` tells the signed-in person who/where/what/how long (closed key set, `serverHost` from the configured issuer, not from `Host`); a role outside the switch, a bad envelope, a developer token, an agent, a signed-out session are each refused | the preview widens, the host is taken from a header, a refused caller learns more than a 403/404/401 |
//! | decision | approve answers a loopback redirect with `code`, `state`, `iss` and **only the SHA-256 of the code** is stored; deny answers `access_denied`; one terminal decision per nonce (also under a race); the issued scopes are request ∩ choice; a wrong/absent/unavailable password issues nothing; five wrong passwords lock approving out even for the right one, and the budget is the **same** one as the card's; a role outside the switch is refused before the password is compared; ten live lineages refuse | the password is not compared, the nonce is not unique, the scope subset is not checked, the budget key is separate, the policy comes after the password, the code is stored whole |
//! | request envelope | forged, expired, other-secret, hosted-typed and other-client envelopes are one and the same 404 sentence and write nothing; a hosted envelope is not a dev one and the other way round | the hosted key/typ is shared, the client id is not checked, an enumerating answer |
//! | exchange | the lineage the code opens has exactly the approved scopes and only digests at rest; every wrong exchange is the same `invalid_grant` bytes and **burns nothing**; an expired code is refused (the clock decides, both sides); a replay ends the lineage the first use opened and leaves one audit line; the member is judged again at exchange (demotion, suspension, removal, the lineage limit) and the code is burned; a password change/reset burns a waiting code and ends a lineage, and an exchange that meets such a sweep in flight queues behind it and finds the code burned | PKCE/redirect/resource are not compared, a wrong verifier burns the code, a replay opens nothing/ends nothing, the exchange does not re-judge the member, the sweep skips waiting codes, the exchange does not take the member's sweep lock (it then runs past a sweep in flight and opens a lineage the sweep never saw) |
//! | refresh | rotation hands over a fresh pair of the same lineage; a spent refresh ends the whole lineage with one alert; unknown/garbled/spent answers are the same bytes; two simultaneous refreshes let exactly one through; 30-day idle and 90-day cap refuse; access and refresh are not interchangeable | reuse is not detected, the answers differ by reason, the serialisation is lost, idle/cap are not enforced |
//! | revoke | an access or a refresh ends the whole lineage; a card, an unknown string and an already revoked token are the same 200 as a real one (no oracle); another client id ends nothing | the card is revocable here, a wrong answer is an oracle, the client id is not part of the match |
//! | metadata, closed arm, hosted | the metadata follows the open arms; with the dev arm closed `oort-cli` is an unknown client byte for byte and a real dev token redeems nothing; opening the dev arm leaves the hosted flow's answers as they were | the flag does not gate the branch, `is_enabled` widens, the hosted PRM leaks out of a dev-only server |
//! | tenancy | `dev_login_authorization` is `FORCE ROW LEVEL SECURITY` and invisible from another workspace for the application role | RLS is dropped from the table |
//!
//! `#[ignore]` — needs a real PostgreSQL 18 + pgvector (superuser URL); run on an isolated database:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test dev_login_oauth_conformance_pg -- --ignored --test-threads=1
//! ```

#[path = "common/apps_pg.rs"]
mod apps_pg;

use std::collections::BTreeSet;
use std::sync::{Arc, OnceLock};

use apps_pg::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use momo_auth::{
    dev_login_request_key, hosted_oauth_request_key, issue_dev_card_in_tx, issue_dev_login_in_tx,
    lock_member_wide_sweep_in_tx, revoke_member_dev_tokens_in_tx, sign_authorization_request,
    sign_dev_login_request, verify_authorization_request, verify_dev_login_request,
    AuthorizationRequestSeed, DevAccessPolicy, DevLoginRequestSeed, DevTool, IssuedDevCard,
    IssuedDevLogin, NewDevCard, NewDevLogin, DEV_READ_ONLY_SCOPES,
};
use momo_db::sqlx::{self, Row};
use momo_db::{with_tenant_tx, PgPool};
use momo_server::config::{AgentPortOauthConfig, RegisteredOauthClient};
use reqwest::{Client, Method};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

// ---------------------------------------------------------------------------
// the contract's constants, spelled out (not imported from the code under test)
// ---------------------------------------------------------------------------

const ISSUER: &str = "https://oort.conformance.test";
const DEV_CONSENT_URL: &str = "https://app.oort.conformance.test/oauth/cli";
const HOSTED_CONSENT_URL: &str = "https://app.oort.conformance.test/oauth/consent";
const HOSTED_CLIENT_ID: &str = "oort-conformance-client";
const HOSTED_REDIRECT_URI: &str = "https://client.conformance.test/callback";
/// The dev resource is the issuer plus `/v1/mcp/me`; the hosted one is the issuer plus the Agent Port path.
const DEV_RESOURCE: &str = "https://oort.conformance.test/v1/mcp/me";
const HOSTED_RESOURCE: &str = "https://oort.conformance.test/v1/mcp/agent-port";

const CLIENT_ID: &str = "oort-cli";
/// The five loopback candidates: `http://127.0.0.1:{24681..24685}/callback`, exact match only.
const REDIRECTS: [&str; 5] = [
    "http://127.0.0.1:24681/callback",
    "http://127.0.0.1:24682/callback",
    "http://127.0.0.1:24683/callback",
    "http://127.0.0.1:24684/callback",
    "http://127.0.0.1:24685/callback",
];
const REDIRECT: &str = REDIRECTS[0];

/// `DEV_SCOPES` in the order of the contract: the order every list in an answer or a row is in.
const SCOPE_ORDER: [&str; 5] = [
    "dev:identity",
    "dev:channels:read",
    "dev:messages:read",
    "dev:messages:write",
    "dev:inbox:read",
];
const ALL_SCOPES: &str =
    "dev:identity dev:channels:read dev:messages:read dev:messages:write dev:inbox:read";
/// 「읽기만」: the four read scopes (identity included).
const READ_ONLY: [&str; 4] = [
    "dev:identity",
    "dev:channels:read",
    "dev:messages:read",
    "dev:inbox:read",
];

/// Fixture passwords: not secrets, made up for this file.
const PASSWORD: &str = "dalmuri-fixture-password-1";
const WRONG_PASSWORD: &str = "dalmuri-fixture-wrong-9";
const CHANGED_PASSWORD: &str = "dalmuri-changed-password";
const RESET_PASSWORD: &str = "dalmuri-reset-password";
const DEVICE: &str = "이도현의 노트북";

const DAY_SECONDS: i64 = 24 * 60 * 60;

/// `auth.dev_token.refresh_reuse_detected` — restated on purpose: the audit vocabulary is a contract.
const ACTION_REUSE: &str = "auth.dev_token.refresh_reuse_detected";

// ---------------------------------------------------------------------------
// independent derivations
// ---------------------------------------------------------------------------

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// RFC 7636 §4.2: `BASE64URL(SHA256(ASCII(verifier)))`, derived here.
fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

struct Pkce {
    verifier: String,
    challenge: String,
}

impl Pkce {
    /// A verifier of its own (64 unreserved characters) and the challenge this file derives from it.
    fn fresh() -> Pkce {
        let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let challenge = challenge_for(&verifier);
        Pkce {
            verifier,
            challenge,
        }
    }

    /// The vector of RFC 7636 appendix B. The literal challenge is checked against the derivation, so a
    /// typo in either fails here and not in the server.
    fn rfc7636() -> Pkce {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".to_string();
        let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".to_string();
        assert_eq!(challenge_for(&verifier), challenge, "the RFC vector");
        Pkce {
            verifier,
            challenge,
        }
    }
}

/// 43 base64url characters of no meaning: the secret part of an envelope that no row carries.
fn secret43() -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `<prefix>.<workspace>.<43 characters>` that no row carries.
fn unknown_envelope(prefix: &str, workspace: Uuid) -> String {
    format!("{prefix}.{workspace}.{}", secret43())
}

/// The secret field of an envelope `prefix.<workspace>.<43 characters>`.
fn secret_part(envelope: &str) -> &str {
    envelope
        .rsplit('.')
        .next()
        .expect("an envelope has a secret field")
}

fn is_envelope_of(envelope: &str, prefix: &str, workspace: Uuid) -> bool {
    let fields: Vec<&str> = envelope.split('.').collect();
    fields.len() == 3
        && fields[0] == prefix
        && fields[1] == workspace.to_string()
        && fields[2].len() == 43
        && fields[2]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The first piece of `envelope` found in `haystack`: the whole envelope, or any eight consecutive
/// characters of its secret. Eight random base64url characters meet by chance with probability ~3e-15, so
/// a hit is the secret.
fn leaked_piece(haystack: &str, envelope: &str) -> Option<String> {
    if haystack.contains(envelope) {
        return Some(envelope.to_string());
    }
    secret_part(envelope)
        .as_bytes()
        .windows(8)
        .map(|window| String::from_utf8_lossy(window).into_owned())
        .find(|piece| haystack.contains(piece.as_str()))
}

/// Percent-encode as RFC 3986 unreserved-only, byte by byte (the Korean test strings included).
fn pct(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// `application/x-www-form-urlencoded` decoding of one query component (`+` is a space, `%XX` a byte):
/// how any OAuth client reads a redirect's query, whichever encoder the server used.
fn form_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).expect("ascii hex");
                out.push(u8::from_str_radix(hex, 16).expect("a valid percent escape"));
                index += 3;
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            other => {
                out.push(other);
                index += 1;
            }
        }
    }
    String::from_utf8(out).expect("a decoded query value is utf-8")
}

fn query_pairs(url: &str) -> Vec<(String, String)> {
    let Some((_, query)) = url.split_once('?') else {
        return Vec::new();
    };
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (form_decode(name), form_decode(value))
        })
        .collect()
}

fn query_param(url: &str, key: &str) -> Option<String> {
    query_pairs(url)
        .into_iter()
        .find_map(|(name, value)| (name == key).then_some(value))
}

fn param_names(url: &str) -> BTreeSet<String> {
    query_pairs(url).into_iter().map(|(name, _)| name).collect()
}

fn request_envelope(location: &str) -> String {
    query_param(location, "request").expect("a consent redirect carries `request`")
}

fn names(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|name| (*name).to_string()).collect()
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|item| (*item).to_string()).collect()
}

/// `want` in the contract's order, `dev:identity` first: what a list of issued scopes must look like.
fn canonical(want: &[&str]) -> Vec<String> {
    SCOPE_ORDER
        .iter()
        .filter(|scope| want.contains(scope))
        .map(|scope| (*scope).to_string())
        .collect()
}

fn keys_of(value: &Value) -> BTreeSet<String> {
    value
        .as_object()
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

fn as_count(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

// ---------------------------------------------------------------------------
// answers
// ---------------------------------------------------------------------------

/// What a client could tell two answers apart by: the status, the body bytes and the headers that
/// describe it.
type Fingerprint = (u16, Vec<u8>, Vec<(&'static str, Option<String>)>);

/// One answer, kept whole.
struct Reply {
    status: u16,
    headers: reqwest::header::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// The app error envelope's code (`{"error":{"message":…,"code":…}}`).
    fn error_code(&self) -> Option<String> {
        self.json()["error"]["code"].as_str().map(str::to_owned)
    }

    fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    }

    fn location(&self) -> Option<String> {
        self.header("location")
    }

    fn no_store(&self) -> bool {
        self.header("cache-control")
            .unwrap_or_default()
            .split(',')
            .any(|directive| directive.trim().eq_ignore_ascii_case("no-store"))
    }

    /// Everything a client could tell two refusals apart by (`date` and the like are left out — they
    /// differ between any two answers).
    fn fingerprint(&self) -> Fingerprint {
        let headers = [
            "content-type",
            "content-length",
            "cache-control",
            "pragma",
            "www-authenticate",
            "retry-after",
            "vary",
            "set-cookie",
            "location",
        ]
        .into_iter()
        .map(|name| (name, self.header(name)))
        .collect();
        (self.status, self.body.clone(), headers)
    }
}

async fn to_reply(request: reqwest::RequestBuilder) -> Reply {
    let response = request.send().await.expect("the server answers");
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response.bytes().await.expect("the body is read").to_vec();
    Reply {
        status,
        headers,
        body,
    }
}

fn expect_status(reply: &Reply, status: u16, what: &str) {
    assert_eq!(
        reply.status,
        status,
        "{what}: expected {status}, got {} {}",
        reply.status,
        reply.text()
    );
}

fn expect_code(reply: &Reply, status: u16, code: &str, what: &str) {
    expect_status(reply, status, what);
    assert_eq!(
        reply.error_code().as_deref(),
        Some(code),
        "{what}: expected error code {code}, got {}",
        reply.text()
    );
}

/// An OAuth refusal: the status and a body that is `{"error":"<code>"}` and nothing else.
fn expect_oauth_error(reply: &Reply, status: u16, error: &str, what: &str) {
    expect_status(reply, status, what);
    let body = reply.json();
    assert_eq!(
        body["error"],
        json!(error),
        "{what}: expected OAuth error {error}, got {}",
        reply.text()
    );
    assert_eq!(
        keys_of(&body),
        names(&["error"]),
        "{what}: an OAuth error body carries the code and nothing else, got {}",
        reply.text()
    );
}

// ---------------------------------------------------------------------------
// the authorize request
// ---------------------------------------------------------------------------

/// The query of `GET /v1/oauth/authorize`, one parameter at a time.
#[derive(Clone)]
struct Authz(Vec<(String, String)>);

impl Authz {
    /// A perfect request of the built-in client for `pkce`, asking for every dev scope.
    fn standard(pkce: &Pkce) -> Authz {
        Authz(vec![
            ("response_type".into(), "code".into()),
            ("client_id".into(), CLIENT_ID.into()),
            ("redirect_uri".into(), REDIRECT.into()),
            ("scope".into(), ALL_SCOPES.into()),
            ("resource".into(), DEV_RESOURCE.into()),
            ("state".into(), "opaque-state".into()),
            ("code_challenge".into(), pkce.challenge.clone()),
            ("code_challenge_method".into(), "S256".into()),
        ])
    }

    fn set(mut self, key: &str, value: &str) -> Authz {
        self.0.retain(|(existing, _)| existing != key);
        self.0.push((key.to_string(), value.to_string()));
        self
    }

    fn omit(mut self, key: &str) -> Authz {
        self.0.retain(|(existing, _)| existing != key);
        self
    }

    fn query(&self) -> String {
        self.0
            .iter()
            .map(|(key, value)| format!("{}={}", pct(key), pct(value)))
            .collect::<Vec<_>>()
            .join("&")
    }
}

// ---------------------------------------------------------------------------
// the world: a workspace, a server on the arms under test, people
// ---------------------------------------------------------------------------

fn dev_only() -> AgentPortOauthConfig {
    AgentPortOauthConfig::for_tests_dev_login(ISSUER, DEV_CONSENT_URL)
}

fn hosted_only() -> AgentPortOauthConfig {
    AgentPortOauthConfig::for_tests(
        ISSUER,
        HOSTED_CONSENT_URL,
        vec![RegisteredOauthClient {
            client_id: HOSTED_CLIENT_ID.to_string(),
            redirect_uris: vec![HOSTED_REDIRECT_URI.to_string()],
        }],
    )
}

fn both_arms() -> AgentPortOauthConfig {
    hosted_only().with_dev_login_for_tests(DEV_CONSENT_URL)
}

/// A client that never follows a redirect: every `Location` this suite asserts on is part of the
/// contract, so following one would hide it.
fn client() -> Client {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("build a non-following HTTP client")
}

struct World {
    /// Superuser: seeds, and reads rows RLS would hide. Asserts nothing by itself.
    su: PgPool,
    /// `momo_app` (NOBYPASSRLS): what the servers under test run on, and what the domain functions are
    /// called with.
    app: PgPool,
    /// The server under test (the arms `boot_with` was given).
    base: String,
    http: Client,
    workspace: Uuid,
}

#[derive(Clone)]
struct Person {
    id: Uuid,
    jwt: String,
}

/// One row of `dev_login_authorization`, as the superuser sees it.
#[allow(dead_code)]
#[derive(Debug)]
struct LedgerRow {
    member_id: Uuid,
    nonce: Uuid,
    status: String,
    requested: Vec<String>,
    approved: Vec<String>,
    client_id: String,
    redirect_uri: String,
    resource: String,
    challenge: String,
    method: String,
    device_name: Option<String>,
    code_hash_hex: Option<String>,
    ttl_seconds: Option<f64>,
    consumed: bool,
    session_id: Option<Uuid>,
}

#[allow(dead_code)]
struct AuditRow {
    actor: Option<Uuid>,
    subject: Option<Uuid>,
    target_type: Option<String>,
    target_id: Option<Uuid>,
    detail: Value,
}

/// What the person holds after `oort login`.
#[derive(Clone, Debug)]
struct Tokens {
    access: String,
    refresh: String,
    scope: String,
}

impl Tokens {
    fn from_reply(reply: &Reply) -> Tokens {
        expect_status(reply, 200, "a token answer");
        let body = reply.json();
        Tokens {
            access: body["access_token"]
                .as_str()
                .expect("an access token")
                .to_string(),
            refresh: body["refresh_token"]
                .as_str()
                .expect("a refresh token")
                .to_string(),
            scope: body["scope"].as_str().expect("a scope").to_string(),
        }
    }
}

/// An approved request on its way to the exchange.
struct Granted {
    request: String,
    code: String,
    pkce: Pkce,
}

fn dev_path(workspace: Uuid, tail: &str) -> String {
    format!("/v1/workspaces/{workspace}/dev-access{tail}")
}

fn consent_path(workspace: Uuid, verb: &str) -> String {
    dev_path(workspace, &format!("/authorization-requests/{verb}"))
}

fn approve_body(request: &str, password: &str, approved: Option<&[&str]>) -> Value {
    let mut body = json!({"request": request, "currentPassword": password});
    if let Some(approved) = approved {
        body["approvedScopes"] = json!(approved);
    }
    body
}

impl World {
    async fn boot() -> World {
        World::boot_with(dev_only()).await
    }

    async fn boot_with(oauth: AgentPortOauthConfig) -> World {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let app = momo_app_pool().await;
        let workspace = seed_workspace(&su).await;
        let base = start_server(app.clone(), ServerOptions::default().with_oauth(oauth)).await;
        World {
            su,
            app,
            base,
            http: client(),
            workspace,
        }
    }

    /// Another server on the same database and the same workspace, with other arms open.
    async fn another_server(&self, oauth: AgentPortOauthConfig) -> String {
        start_server(self.app.clone(), ServerOptions::default().with_oauth(oauth)).await
    }

    /// A person of `role` in `workspace`, signed in, with a known password (`None`: an account that
    /// signed in without one). `seed_human` records the session row as `label='apps-pg'`; the consent
    /// routes ask, like the card route, whether the calling session is a live person's *access* row
    /// (`label='access'`, what a real sign-in records), so the label is set to that.
    async fn person_in(
        &self,
        workspace: Uuid,
        role: &str,
        handle: &str,
        password: Option<&str>,
    ) -> Person {
        let (id, jwt) = seed_human(&self.su, workspace, role, handle).await;
        sqlx::query(
            "UPDATE token SET label = 'access' \
              WHERE workspace_id = $1 AND actor_member_id = $2 AND kind = 'session'",
        )
        .bind(workspace)
        .bind(id)
        .execute(&self.su)
        .await
        .expect("record the session as an access row");
        if let Some(password) = password {
            sqlx::query(
                "UPDATE human SET password_hash = momo_password_hash($1) \
                  WHERE workspace_id = $2 AND member_id = $3",
            )
            .bind(password)
            .bind(workspace)
            .bind(id)
            .execute(&self.su)
            .await
            .expect("set the person's password");
        }
        Person { id, jwt }
    }

    async fn person(&self, role: &str, handle: &str) -> Person {
        self.person_in(self.workspace, role, handle, Some(PASSWORD))
            .await
    }

    /// A second signed-in session of the same person (the first one may have been ended by a password
    /// change). `sign_access` carries a random `jti`, so every call is a new session.
    async fn new_session(&self, who: &Person) -> Person {
        let jwt = momo_auth::sign_access(who.id, self.workspace, &[], TEST_JWT_SECRET)
            .expect("sign a human App JWT")
            .token;
        sqlx::query(
            "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
             VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'access')",
        )
        .bind(self.workspace)
        .bind(who.id)
        .bind(&jwt)
        .execute(&self.su)
        .await
        .expect("record the second session");
        Person { id: who.id, jwt }
    }

    // ---- HTTP ----

    async fn call(
        &self,
        base: &str,
        method: Method,
        path: &str,
        bearer: Option<&str>,
        body: Option<Value>,
    ) -> Reply {
        let mut request = self.http.request(method, format!("{base}{path}"));
        if let Some(token) = bearer {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        to_reply(request).await
    }

    async fn send(&self, method: Method, path: &str, bearer: &str, body: Option<Value>) -> Reply {
        self.call(&self.base, method, path, Some(bearer), body)
            .await
    }

    async fn form(&self, base: &str, path: &str, fields: &[(&str, &str)]) -> Reply {
        to_reply(self.http.post(format!("{base}{path}")).form(fields)).await
    }

    async fn authorize_at(&self, base: &str, params: &Authz) -> Reply {
        to_reply(
            self.http
                .get(format!("{base}/v1/oauth/authorize?{}", params.query())),
        )
        .await
    }

    async fn authorize(&self, params: &Authz) -> Reply {
        self.authorize_at(&self.base, params).await
    }

    /// `authorize` that must succeed: the signed request envelope the consent screen is handed.
    async fn start(&self, params: &Authz) -> String {
        let reply = self.authorize(params).await;
        expect_status(&reply, 302, "authorize");
        let location = reply.location().expect("a consent redirect");
        assert!(
            location.starts_with(&format!("{DEV_CONSENT_URL}?request=")),
            "the browser goes to the dev consent screen: {location}"
        );
        request_envelope(&location)
    }

    async fn preview(&self, bearer: &str, request: &str) -> Reply {
        self.send(
            Method::GET,
            &format!(
                "{}?request={}",
                consent_path(self.workspace, "preview"),
                pct(request)
            ),
            bearer,
            None,
        )
        .await
    }

    async fn approve_as(
        &self,
        who: &Person,
        request: &str,
        password: &str,
        approved: Option<&[&str]>,
    ) -> Reply {
        self.send(
            Method::POST,
            &consent_path(self.workspace, "approve"),
            &who.jwt,
            Some(approve_body(request, password, approved)),
        )
        .await
    }

    /// The right password, no choice of scopes (「읽기만」 ∩ the request).
    async fn approve(&self, who: &Person, request: &str) -> Reply {
        self.approve_as(who, request, PASSWORD, None).await
    }

    async fn deny(&self, who: &Person, request: &str) -> Reply {
        self.send(
            Method::POST,
            &consent_path(self.workspace, "deny"),
            &who.jwt,
            Some(json!({"request": request})),
        )
        .await
    }

    async fn token_form(&self, fields: &[(&str, &str)]) -> Reply {
        self.form(&self.base, "/v1/oauth/token", fields).await
    }

    async fn exchange_with(
        &self,
        code: &str,
        verifier: &str,
        redirect: &str,
        resource: Option<&str>,
    ) -> Reply {
        let mut fields = vec![
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect),
        ];
        if let Some(resource) = resource {
            fields.push(("resource", resource));
        }
        self.token_form(&fields).await
    }

    /// The honest exchange of an approved request.
    async fn exchange(&self, granted: &Granted) -> Reply {
        self.exchange_with(
            &granted.code,
            &granted.pkce.verifier,
            REDIRECT,
            Some(DEV_RESOURCE),
        )
        .await
    }

    async fn refresh_as(&self, client_id: &str, refresh: &str) -> Reply {
        self.token_form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", refresh),
        ])
        .await
    }

    async fn refresh(&self, refresh: &str) -> Reply {
        self.refresh_as(CLIENT_ID, refresh).await
    }

    async fn revoke_as(&self, client_id: &str, token: &str, hint: Option<&str>) -> Reply {
        let mut fields = vec![("token", token), ("client_id", client_id)];
        if let Some(hint) = hint {
            fields.push(("token_type_hint", hint));
        }
        self.form(&self.base, "/v1/oauth/revoke", &fields).await
    }

    async fn revoke(&self, token: &str) -> Reply {
        self.revoke_as(CLIENT_ID, token, None).await
    }

    /// authorize (with `params`, built from `pkce`) → approve with the person's own consent → the
    /// approved request, holding the verifier that redeems it.
    async fn grant_with(
        &self,
        who: &Person,
        pkce: Pkce,
        params: &Authz,
        approved: Option<&[&str]>,
    ) -> Granted {
        let request = self.start(params).await;
        let reply = self.approve_as(who, &request, PASSWORD, approved).await;
        expect_status(&reply, 200, "approving");
        let redirect_to = reply.json()["redirectTo"]
            .as_str()
            .expect("an approval answers `redirectTo`")
            .to_string();
        let code = query_param(&redirect_to, "code").expect("an approval hands out a code");
        Granted {
            request,
            code,
            pkce,
        }
    }

    /// An approved request for `scope` (everything the person ticked: `approved`, or 「읽기만」).
    async fn grant(&self, who: &Person, scope: &str, approved: Option<&[&str]>) -> Granted {
        let pkce = Pkce::fresh();
        let params = Authz::standard(&pkce).set("scope", scope);
        self.grant_with(who, pkce, &params, approved).await
    }

    /// An approved request for every dev scope with the default choice (「읽기만」).
    async fn grant_all(&self, who: &Person) -> Granted {
        self.grant(who, ALL_SCOPES, None).await
    }

    /// A whole `oort login` of `who`: authorize, approve, exchange. The pair of tokens.
    async fn login(&self, who: &Person) -> Tokens {
        self.login_with(who, ALL_SCOPES, None, None).await
    }

    async fn login_with(
        &self,
        who: &Person,
        scope: &str,
        approved: Option<&[&str]>,
        device: Option<&str>,
    ) -> Tokens {
        let pkce = Pkce::fresh();
        let mut params = Authz::standard(&pkce).set("scope", scope);
        if let Some(device) = device {
            params = params.set("device_name", device);
        }
        let granted = self.grant_with(who, pkce, &params, approved).await;
        Tokens::from_reply(&self.exchange(&granted).await)
    }

    // ---- the developer door ----

    /// The data door: `GET …/channels` (needs `dev:channels:read`).
    async fn door(&self, token: &str) -> u16 {
        self.call(
            &self.base,
            Method::GET,
            &format!("/v1/workspaces/{}/channels", self.workspace),
            Some(token),
            None,
        )
        .await
        .status
    }

    async fn whoami(&self, token: &str) -> Reply {
        self.call(
            &self.base,
            Method::GET,
            &dev_path(self.workspace, "/self"),
            Some(token),
            None,
        )
        .await
    }

    // ---- the database, read back with the superuser ----

    async fn ledger(&self) -> Vec<LedgerRow> {
        sqlx::query(
            "SELECT member_id, request_nonce, status, requested_scopes, approved_scopes, client_id, \
                    redirect_uri, resource, code_challenge, code_challenge_method, device_name, \
                    encode(code_hash, 'hex') AS code_hash_hex, \
                    EXTRACT(EPOCH FROM (code_expires_at - decided_at))::float8 AS ttl_seconds, \
                    code_consumed_at IS NOT NULL AS consumed, session_id \
               FROM dev_login_authorization WHERE workspace_id = $1 ORDER BY created_at, id",
        )
        .bind(self.workspace)
        .fetch_all(&self.su)
        .await
        .expect("read the ledger")
        .iter()
        .map(|row| LedgerRow {
            member_id: row.get("member_id"),
            nonce: row.get("request_nonce"),
            status: row.get("status"),
            requested: row.get("requested_scopes"),
            approved: row.get("approved_scopes"),
            client_id: row.get("client_id"),
            redirect_uri: row.get("redirect_uri"),
            resource: row.get("resource"),
            challenge: row.get("code_challenge"),
            method: row.get("code_challenge_method"),
            device_name: row.get("device_name"),
            code_hash_hex: row.get("code_hash_hex"),
            ttl_seconds: row.get("ttl_seconds"),
            consumed: row.get("consumed"),
            session_id: row.get("session_id"),
        })
        .collect()
    }

    async fn ledger_count(&self) -> usize {
        self.ledger().await.len()
    }

    /// The only ledger row of a test that made exactly one decision.
    async fn only_ledger_row(&self) -> LedgerRow {
        let mut rows = self.ledger().await;
        assert_eq!(rows.len(), 1, "exactly one decision was recorded: {rows:?}");
        rows.remove(0)
    }

    /// Every `dev` row of the member (cards, access and refresh halves), revoked or not.
    async fn dev_rows(&self, member: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM token \
              WHERE workspace_id = $1 AND actor_member_id = $2 AND kind::text = 'dev'",
        )
        .bind(self.workspace)
        .bind(member)
        .fetch_one(&self.su)
        .await
        .expect("count dev rows")
    }

    async fn live_dev_rows(&self, member: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM token \
              WHERE workspace_id = $1 AND actor_member_id = $2 AND kind::text = 'dev' \
                AND revoked_at IS NULL",
        )
        .bind(self.workspace)
        .bind(member)
        .fetch_one(&self.su)
        .await
        .expect("count live dev rows")
    }

    /// `(live, total)` rows of one login lineage.
    async fn lineage_rows(&self, session: Uuid) -> (i64, i64) {
        sqlx::query_as(
            "SELECT count(*) FILTER (WHERE revoked_at IS NULL), count(*) FROM token \
              WHERE workspace_id = $1 AND session_id = $2 AND kind::text = 'dev'",
        )
        .bind(self.workspace)
        .bind(session)
        .fetch_one(&self.su)
        .await
        .expect("count lineage rows")
    }

    /// The lineage (`token.session_id`) a presented access or refresh envelope belongs to.
    async fn session_of(&self, envelope: &str) -> Uuid {
        sqlx::query_scalar(
            "SELECT session_id FROM token \
              WHERE workspace_id = $1 AND token_hash = digest($2::text, 'sha256')",
        )
        .bind(self.workspace)
        .bind(envelope)
        .fetch_one(&self.su)
        .await
        .expect("the envelope's digest names a lineage")
    }

    async fn audit(&self, action: &str) -> Vec<AuditRow> {
        sqlx::query(
            "SELECT actor_member_id, subject_member_id, target_type, target_id, detail::text AS detail \
               FROM audit_log WHERE workspace_id = $1 AND action = $2 ORDER BY id",
        )
        .bind(self.workspace)
        .bind(action)
        .fetch_all(&self.su)
        .await
        .expect("read audit rows")
        .iter()
        .map(|row| AuditRow {
            actor: row.get("actor_member_id"),
            subject: row.get("subject_member_id"),
            target_type: row.get("target_type"),
            target_id: row.get("target_id"),
            detail: serde_json::from_str(&row.get::<String, _>("detail")).expect("detail is JSON"),
        })
        .collect()
    }

    async fn audit_count(&self, action: &str) -> usize {
        self.audit(action).await.len()
    }

    /// Every audit row of the workspace, whole, as one string: the haystack for "nothing secret is in any
    /// row".
    async fn audit_text(&self) -> String {
        sqlx::query_scalar(
            "SELECT COALESCE(string_agg(to_jsonb(a)::text, E'\\n' ORDER BY a.id), '') \
               FROM audit_log a WHERE a.workspace_id = $1",
        )
        .bind(self.workspace)
        .fetch_one(&self.su)
        .await
        .expect("read the audit log")
    }

    /// Every ledger row of the workspace, whole, as one string.
    async fn ledger_text(&self) -> String {
        sqlx::query_scalar(
            "SELECT COALESCE(string_agg(to_jsonb(d)::text, E'\\n' ORDER BY d.created_at, d.id), '') \
               FROM dev_login_authorization d WHERE d.workspace_id = $1",
        )
        .bind(self.workspace)
        .fetch_one(&self.su)
        .await
        .expect("read the ledger as text")
    }

    /// `(ledger rows, audit rows, token rows)` of the whole database: the superuser sees every tenant.
    async fn global_counts(&self) -> (i64, i64, i64) {
        sqlx::query_as(
            "SELECT (SELECT count(*) FROM dev_login_authorization), \
                    (SELECT count(*) FROM audit_log), \
                    (SELECT count(*) FROM token)",
        )
        .fetch_one(&self.su)
        .await
        .expect("count rows")
    }

    async fn db_now_ms(&self) -> i64 {
        sqlx::query_scalar("SELECT (EXTRACT(EPOCH FROM now()) * 1000)::bigint")
            .fetch_one(&self.su)
            .await
            .expect("database clock")
    }

    async fn set_role(&self, member: Uuid, role: &str) {
        sqlx::query(
            "UPDATE workspace_membership SET role = $3::membership_role \
              WHERE workspace_id = $1 AND member_id = $2",
        )
        .bind(self.workspace)
        .bind(member)
        .bind(role)
        .execute(&self.su)
        .await
        .expect("change a role");
    }

    /// Pretend a login lineage was approved `seconds` ago: every time column of every row of the lineage
    /// moves together, so `token_dev_lifetime_ck` and `token_dev_lineage_cap_ck` (re-checked on UPDATE)
    /// still hold. A fresh lineage is exactly two rows.
    async fn age_lineage(&self, session: Uuid, seconds: i64) {
        let moved = sqlx::query(
            "UPDATE token \
                SET created_at = created_at - make_interval(secs => $3), \
                    expires_at = expires_at - make_interval(secs => $3), \
                    last_used_at = last_used_at - make_interval(secs => $3), \
                    revoked_at = revoked_at - make_interval(secs => $3), \
                    dev_lineage_expires_at = dev_lineage_expires_at - make_interval(secs => $3) \
              WHERE workspace_id = $1 AND session_id = $2 AND kind::text = 'dev'",
        )
        .bind(self.workspace)
        .bind(session)
        .bind(seconds as f64)
        .execute(&self.su)
        .await
        .expect("move the lineage back in time")
        .rows_affected();
        assert_eq!(moved, 2, "a fresh lineage is exactly two rows");
    }

    /// The refresh was last used just now: its idle clock (30 days) restarts, bounded by the cap as a real
    /// rotation bounds it. Without this, an aged lineage would be refused for idleness and the cap would
    /// not be what a test of the cap is looking at.
    async fn rearm_idle_clock(&self, session: Uuid) {
        let moved = sqlx::query(
            "UPDATE token \
                SET expires_at = LEAST(now() + interval '30 days', dev_lineage_expires_at), \
                    last_used_at = now() \
              WHERE workspace_id = $1 AND session_id = $2 AND dev_form = 'refresh' \
                AND revoked_at IS NULL",
        )
        .bind(self.workspace)
        .bind(session)
        .execute(&self.su)
        .await
        .expect("re-arm the refresh")
        .rows_affected();
        assert_eq!(moved, 1, "one live refresh per lineage");
    }

    // ---- domain fixtures (the fast way to rows the routes would also make) ----

    async fn card_for(&self, member: Uuid, name: &str) -> IssuedDevCard {
        let workspace = self.workspace;
        let card = NewDevCard {
            label: name.to_string(),
            tool: DevTool::ClaudeCode,
            scopes: strings(&READ_ONLY),
            channel_ids: None,
            expires_in_days: 30,
        };
        with_tenant_tx(&self.app, workspace, move |conn| {
            Box::pin(async move {
                Ok(
                    issue_dev_card_in_tx(conn, workspace, member, &card, DevAccessPolicy::Admins)
                        .await?,
                )
            })
        })
        .await
        .expect("the card's transaction commits")
        .expect("the domain issues a card for an owner or admin")
    }

    async fn lineage_for(&self, member: Uuid, name: &str) -> IssuedDevLogin {
        self.lineage_with_client(member, name, CLIENT_ID).await
    }

    /// A login lineage of a client other than `oort-cli` (what a tool of another kind would hold).
    async fn lineage_with_client(&self, member: Uuid, name: &str, client: &str) -> IssuedDevLogin {
        let workspace = self.workspace;
        let login = NewDevLogin {
            label: name.to_string(),
            tool: DevTool::Cli,
            client: client.to_string(),
            device_name: Some(DEVICE.to_string()),
            scopes: DEV_READ_ONLY_SCOPES
                .iter()
                .map(|scope| scope.to_string())
                .collect(),
            channel_ids: None,
        };
        with_tenant_tx(&self.app, workspace, move |conn| {
            Box::pin(async move {
                Ok(
                    issue_dev_login_in_tx(conn, workspace, member, &login, DevAccessPolicy::Admins)
                        .await?,
                )
            })
        })
        .await
        .expect("the lineage's transaction commits")
        .expect("the domain opens a login lineage for an owner or admin")
    }

    /// A card through the real issuing route with the right password (the other half of the shared
    /// password budget).
    async fn issue_card_as(&self, who: &Person, password: &str) -> Reply {
        self.send(
            Method::POST,
            &dev_path(self.workspace, "/credentials"),
            &who.jwt,
            Some(json!({"name": "이도현의 터미널", "tool": "claude_code", "currentPassword": password})),
        )
        .await
    }
}

/// Everything that ends or changes a member, made to happen through the real routes.
#[derive(Clone, Copy, Debug)]
enum Event {
    Demote,
    PasswordChange,
    PasswordReset,
    Suspend,
    Remove,
}

impl World {
    /// Make `event` happen to `member` through the real route (for a reset, the operator's issue and then
    /// the member's claim, which is the request that applies it) and require the route's 200. `owner` is
    /// the workspace owner's session.
    async fn happen(&self, event: Event, member: &Person, owner: &Person) {
        let workspace = self.workspace;
        let base = &self.base;
        let id = member.id;
        let request = match event {
            Event::Demote => self
                .http
                .patch(format!(
                    "{base}/v1/workspaces/{workspace}/members/{id}/role"
                ))
                .bearer_auth(&owner.jwt)
                .json(&json!({"role": "member"})),
            Event::PasswordChange => self
                .http
                .patch(format!(
                    "{base}/v1/workspaces/{workspace}/members/me/password"
                ))
                .bearer_auth(&member.jwt)
                .json(&json!({"currentPassword": PASSWORD, "newPassword": CHANGED_PASSWORD})),
            Event::PasswordReset => {
                let issued = self
                    .http
                    .post(format!(
                        "{base}/v1/workspaces/{workspace}/members/{id}/password-reset"
                    ))
                    .bearer_auth(&owner.jwt)
                    .send()
                    .await
                    .expect("issue the reset token");
                assert_eq!(issued.status().as_u16(), 201, "the owner issues a reset");
                let body: Value = issued.json().await.expect("reset body");
                let token = body["token"].as_str().expect("reset token").to_string();
                self.http
                    .post(format!("{base}/v1/claim"))
                    .json(&json!({"token": token, "password": RESET_PASSWORD}))
            }
            Event::Suspend => self
                .http
                .post(format!(
                    "{base}/v1/workspaces/{workspace}/members/{id}/suspend"
                ))
                .bearer_auth(&owner.jwt),
            Event::Remove => self
                .http
                .delete(format!("{base}/v1/workspaces/{workspace}/members/{id}"))
                .bearer_auth(&owner.jwt),
        };
        let response = request.send().await.expect("the member event");
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        assert_eq!(status, 200, "{event:?} must be accepted: {body}");
    }
}

// ===========================================================================
// authorize — `GET /v1/oauth/authorize` (public, anonymous, writes nothing)
// ===========================================================================

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn authorize_hands_the_browser_a_signed_request_and_writes_nothing() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let pkce = Pkce::rfc7636();
    let key = dev_login_request_key(TEST_JWT_SECRET);
    let params = Authz::standard(&pkce)
        .set("scope", "dev:channels:read dev:messages:write")
        .set("state", "상태 값")
        .set("device_name", DEVICE);

    let before = w.global_counts().await;
    let reply = w.authorize(&params).await;
    expect_status(&reply, 302, "authorize");
    assert!(reply.no_store(), "the redirect is `no-store`");
    let location = reply.location().expect("a consent redirect");
    assert!(
        location.starts_with(&format!("{DEV_CONSENT_URL}?request=")),
        "the browser goes to the configured consent screen: {location}"
    );
    assert_eq!(
        param_names(&location),
        names(&["request"]),
        "the consent screen is handed the signed request and nothing else"
    );
    for secret in [
        pkce.verifier.as_str(),
        "code_verifier",
        "momo_dev",
        "access_token",
    ] {
        assert!(
            !location.contains(secret),
            "`{secret}` leaked into the consent URL"
        );
    }

    let envelope = request_envelope(&location);
    let claims = verify_dev_login_request(&key, &envelope)
        .expect("the envelope verifies under the dev login key");
    assert_eq!(claims.cid, CLIENT_ID);
    assert_eq!(claims.ru, REDIRECT);
    assert_eq!(claims.res, DEV_RESOURCE);
    assert_eq!(
        claims.scp,
        ["dev:identity", "dev:channels:read", "dev:messages:write"],
        "the request's scopes are normalised: `dev:identity` first and always present"
    );
    assert_eq!(claims.cc, pkce.challenge);
    assert_eq!(claims.ccm, "S256");
    assert_eq!(claims.st.as_deref(), Some("상태 값"));
    assert_eq!(claims.dn.as_deref(), Some(DEVICE));
    assert_eq!(
        claims.exp - claims.iat,
        600,
        "a request stays consentable for ten minutes"
    );
    assert!(
        verify_authorization_request(&hosted_oauth_request_key(TEST_JWT_SECRET), &envelope)
            .is_err(),
        "a dev request is not a hosted request envelope (other key, other `typ`)"
    );

    // Every request is its own nonce.
    let again = w.start(&params).await;
    let again_claims =
        verify_dev_login_request(&key, &again).expect("the second envelope verifies");
    assert_ne!(again_claims.jti, claims.jti, "a fresh nonce per request");

    // A request without state and device name carries neither.
    let bare = w
        .start(&Authz::standard(&pkce).omit("state").omit("device_name"))
        .await;
    let bare_claims = verify_dev_login_request(&key, &bare).expect("the bare envelope verifies");
    assert_eq!(bare_claims.st, None);
    assert_eq!(bare_claims.dn, None);

    // An unauthenticated GET must not be able to grow any table.
    assert_eq!(
        w.global_counts().await,
        before,
        "authorize wrote a ledger, audit or token row"
    );
}

/// Every spelling of a redirect URI that is not one of the five candidates, byte for byte.
const REFUSED_REDIRECTS: &[&str] = &[
    "",
    "http://localhost:24681/callback",
    "http://127.0.0.1:24680/callback",
    "http://127.0.0.1:24686/callback",
    "http://127.0.0.1:80/callback",
    "http://127.0.0.1:65535/callback",
    "http://127.0.0.1:/callback",
    "http://127.0.0.1/callback",
    "http://127.0.0.1:24681",
    "http://127.0.0.1:24681/",
    "http://127.0.0.1:24681/callback/",
    "http://127.0.0.1:24681//callback",
    "http://127.0.0.1:24681/Callback",
    "http://127.0.0.1:24681/callbac",
    "http://127.0.0.1:24681/callback?x=1",
    "http://127.0.0.1:24681/callback?",
    "http://127.0.0.1:24681/callback#fragment",
    "http://127.0.0.1:24681/callback%2f",
    "http://127.0.0.1:24681/callback/../callback",
    "HTTP://127.0.0.1:24681/callback",
    "https://127.0.0.1:24681/callback",
    "http://[::1]:24681/callback",
    "http://[0:0:0:0:0:0:0:1]:24681/callback",
    "http://127.0.0.1:024681/callback",
    "http://127.0.0.1:+24681/callback",
    "http://127.0.0.1:24681@evil.example/callback",
    "http://evil.example@127.0.0.1:24681/callback",
    "http://127.0.0.1.evil.example:24681/callback",
    "http://127.1:24681/callback",
    "http://0.0.0.0:24681/callback",
    "http://127.0.0.2:24681/callback",
    "http://2130706433:24681/callback",
    " http://127.0.0.1:24681/callback",
    "http://127.0.0.1:24681/callback ",
    "http://127.0.0.1:24681/callback\n",
    "https://oort.conformance.test/callback",
    "https://client.conformance.test/callback",
    "oort://callback",
    "//127.0.0.1:24681/callback",
    "127.0.0.1:24681/callback",
];

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn only_the_five_loopback_candidates_are_redirect_targets_and_every_other_spelling_is_refused_in_place(
) {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let pkce = Pkce::fresh();
    let key = dev_login_request_key(TEST_JWT_SECRET);

    // The five are accepted, each one on its own, and the envelope names exactly that one.
    for uri in REDIRECTS {
        let envelope = w
            .start(&Authz::standard(&pkce).set("redirect_uri", uri))
            .await;
        let claims = verify_dev_login_request(&key, &envelope).expect("the envelope verifies");
        assert_eq!(
            claims.ru, uri,
            "the envelope names the redirect it was asked for"
        );
    }

    let before = w.global_counts().await;
    for bad in REFUSED_REDIRECTS {
        // A request that is perfect in every other way: still not a redirect, and not an error redirect
        // either (the browser is not sent to a URI nobody registered).
        let perfect = w
            .authorize(&Authz::standard(&pkce).set("redirect_uri", bad))
            .await;
        assert_eq!(
            perfect.status,
            400,
            "`{bad:?}` must be refused in place, got {} {}",
            perfect.status,
            perfect.text()
        );
        assert!(
            perfect.location().is_none(),
            "`{bad:?}` must not send the browser anywhere, got {:?}",
            perfect.location()
        );
        // The redirect is judged FIRST: when PKCE, scope, resource and response type are wrong too, the
        // answer is the same refusal in place — never an `error=` redirect to the unregistered URI.
        let worst = Authz::standard(&pkce)
            .set("redirect_uri", bad)
            .set("code_challenge_method", "plain")
            .set("scope", "admin")
            .set("resource", HOSTED_RESOURCE)
            .set("response_type", "token")
            .set("state", "x");
        let reply = w.authorize(&worst).await;
        assert_eq!(reply.status, 400, "`{bad:?}` with everything else wrong");
        assert!(
            reply.location().is_none(),
            "`{bad:?}` with everything else wrong must not redirect either"
        );
    }
    let absent = w
        .authorize(&Authz::standard(&pkce).omit("redirect_uri"))
        .await;
    assert_eq!(absent.status, 400, "no redirect_uri at all");
    assert!(absent.location().is_none());

    assert_eq!(
        w.global_counts().await,
        before,
        "a refused request wrote something"
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn every_other_authorize_error_goes_back_to_the_registered_redirect_with_error_state_and_iss()
{
    let _guard = test_lock().await;
    let w = World::boot().await;
    let pkce = Pkce::fresh();
    let base = || Authz::standard(&pkce).set("state", "keep-this-state");
    let too_long_state = "s".repeat(513);
    let long_challenge = "A".repeat(129);
    let challenge_with_plus = format!("{}+", "A".repeat(42));
    let long_device = "가".repeat(81);
    let cases: Vec<(&str, Authz, &str)> = vec![
        (
            "response_type=token",
            base().set("response_type", "token"),
            "unsupported_response_type",
        ),
        (
            "code_challenge_method=plain",
            base().set("code_challenge_method", "plain"),
            "invalid_request",
        ),
        (
            "no code_challenge_method",
            base().omit("code_challenge_method"),
            "invalid_request",
        ),
        (
            "an empty code_challenge_method",
            base().set("code_challenge_method", ""),
            "invalid_request",
        ),
        (
            "code_challenge_method=s256 (not the spelling S256)",
            base().set("code_challenge_method", "s256"),
            "invalid_request",
        ),
        (
            "no code_challenge",
            base().omit("code_challenge"),
            "invalid_request",
        ),
        (
            "a short code_challenge",
            base().set("code_challenge", "short"),
            "invalid_request",
        ),
        (
            "a 129 character code_challenge",
            base().set("code_challenge", &long_challenge),
            "invalid_request",
        ),
        (
            "a code_challenge with a character outside base64url",
            base().set("code_challenge", &challenge_with_plus),
            "invalid_request",
        ),
        ("no scope", base().omit("scope"), "invalid_scope"),
        ("an empty scope", base().set("scope", ""), "invalid_scope"),
        (
            "an unknown scope",
            base().set("scope", "admin"),
            "invalid_scope",
        ),
        (
            "a scope listed twice",
            base().set("scope", "dev:identity dev:identity"),
            "invalid_scope",
        ),
        (
            "a hosted scope",
            base().set("scope", "dev:identity agent:port:connect"),
            "invalid_scope",
        ),
        (
            "one unknown scope among known ones",
            base().set("scope", "dev:messages:write dev:nope"),
            "invalid_scope",
        ),
        ("no resource", base().omit("resource"), "invalid_target"),
        (
            "an empty resource",
            base().set("resource", ""),
            "invalid_target",
        ),
        (
            "the hosted resource",
            base().set("resource", HOSTED_RESOURCE),
            "invalid_target",
        ),
        (
            "the resource with a trailing slash",
            base().set("resource", &format!("{DEV_RESOURCE}/")),
            "invalid_target",
        ),
        (
            "another origin's resource",
            base().set("resource", "https://evil.example/v1/mcp/me"),
            "invalid_target",
        ),
        (
            "the resource over http",
            base().set("resource", "http://oort.conformance.test/v1/mcp/me"),
            "invalid_target",
        ),
        (
            "state of 513 bytes",
            base().set("state", &too_long_state),
            "invalid_request",
        ),
        (
            "a device name of 81 characters",
            base().set("device_name", &long_device),
            "invalid_request",
        ),
        (
            "a device name with a control character",
            base().set("device_name", "line\nbreak"),
            "invalid_request",
        ),
        (
            "a device name carrying an envelope",
            base().set("device_name", "my momo_dev_v1.abc"),
            "invalid_request",
        ),
    ];

    let before = w.global_counts().await;
    for (what, params, error) in &cases {
        let reply = w.authorize(params).await;
        expect_status(&reply, 302, what);
        let location = reply.location().unwrap_or_default();
        assert!(
            location.starts_with(&format!("{REDIRECT}?")),
            "{what}: an error goes only to the registered redirect, got `{location}`"
        );
        assert_eq!(
            query_param(&location, "error").as_deref(),
            Some(*error),
            "{what}: the error"
        );
        assert_eq!(
            query_param(&location, "iss").as_deref(),
            Some(ISSUER),
            "{what}: RFC 9207 `iss`"
        );
        assert!(
            query_param(&location, "code").is_none() && query_param(&location, "request").is_none(),
            "{what}: an error carries neither a code nor a consent request"
        );
        if !what.starts_with("state") {
            assert_eq!(
                query_param(&location, "state").as_deref(),
                Some("keep-this-state"),
                "{what}: the client's state comes back"
            );
        }
    }
    assert_eq!(
        w.global_counts().await,
        before,
        "an erroring request wrote something"
    );

    // Positive controls: the same checks admit the boundary values, so the matrix above is not
    // "everything is refused".
    let key = dev_login_request_key(TEST_JWT_SECRET);
    for (what, params) in [
        (
            "a device name of 80 characters",
            base().set("device_name", &"가".repeat(80)),
        ),
        (
            "a state of 512 bytes",
            base().set("state", &"s".repeat(512)),
        ),
        ("only dev:identity", base().set("scope", "dev:identity")),
        (
            "the scopes in another order",
            base().set("scope", "dev:inbox:read dev:identity"),
        ),
    ] {
        let envelope = w.start(&params).await;
        assert!(
            verify_dev_login_request(&key, &envelope).is_ok(),
            "{what} is admitted"
        );
    }
}

// ===========================================================================
// the consent screen — `GET …/dev-access/authorization-requests/preview`
// ===========================================================================

const PREVIEW_KEYS: [&str; 15] = [
    "clientName",
    "clientId",
    "issuer",
    "serverHost",
    "workspaceId",
    "workspaceName",
    "memberDisplayName",
    "role",
    "deviceName",
    "requestedScopes",
    "canSend",
    "expiresAtMs",
    "accessMinutes",
    "idleDays",
    "maxDays",
];

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn the_consent_screen_is_told_who_asks_for_what_on_which_server_and_for_how_long() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    sqlx::query("UPDATE workspace SET name = '달무리 스튜디오' WHERE id = $1")
        .bind(w.workspace)
        .execute(&w.su)
        .await
        .expect("name the workspace");
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;
    let pkce = Pkce::fresh();

    let request = w
        .start(
            &Authz::standard(&pkce)
                .set("scope", "dev:channels:read dev:messages:write")
                .set("device_name", DEVICE),
        )
        .await;
    let reply = w.preview(&owner.jwt, &request).await;
    expect_status(&reply, 200, "preview");
    assert!(reply.no_store(), "the preview is `no-store`");
    let body = reply.json();
    assert_eq!(
        keys_of(&body),
        names(&PREVIEW_KEYS),
        "the preview's keys are closed: {body}"
    );
    assert_eq!(body["clientName"], "oort CLI");
    assert_eq!(body["clientId"], CLIENT_ID);
    assert_eq!(body["issuer"], ISSUER);
    assert_eq!(body["serverHost"], "oort.conformance.test");
    assert_eq!(body["workspaceId"], w.workspace.to_string());
    assert_eq!(body["workspaceName"], "달무리 스튜디오");
    assert_eq!(body["memberDisplayName"], "이도현");
    assert_eq!(body["role"], "owner");
    assert_eq!(body["deviceName"], DEVICE);
    assert_eq!(
        body["requestedScopes"],
        json!(["dev:identity", "dev:channels:read", "dev:messages:write"])
    );
    assert_eq!(body["canSend"], true, "the request asks to send");
    assert_eq!(body["accessMinutes"], 15);
    assert_eq!(body["idleDays"], 30);
    assert_eq!(body["maxDays"], 90);
    let now = w.db_now_ms().await;
    let expires = body["expiresAtMs"].as_i64().expect("expiresAtMs");
    assert!(
        (expires - (now + 600_000)).abs() < 30_000,
        "the request is consentable for ten minutes: expires {expires}, now {now}"
    );

    // The server name the person compares comes from the operator's issuer, never from a header the
    // caller (or a proxy) controls.
    let spoofed = to_reply(
        w.http
            .get(format!(
                "{}{}?request={}",
                w.base,
                consent_path(w.workspace, "preview"),
                pct(&request)
            ))
            .bearer_auth(&owner.jwt)
            .header("host", "evil.example")
            .header("x-forwarded-host", "evil.example")
            .header("forwarded", "host=evil.example;proto=http"),
    )
    .await;
    expect_status(&spoofed, 200, "preview with spoofed host headers");
    assert_eq!(spoofed.json()["serverHost"], "oort.conformance.test");
    assert_eq!(spoofed.json()["issuer"], ISSUER);

    // An admin sees their own name and role; a request that does not ask to send says so, and a request
    // without a device name has a JSON `null`.
    let plain = w
        .start(&Authz::standard(&pkce).set("scope", "dev:channels:read"))
        .await;
    let reply = w.preview(&admin.jwt, &plain).await;
    expect_status(&reply, 200, "preview as an admin");
    let body = reply.json();
    assert_eq!(body["memberDisplayName"], "박서연");
    assert_eq!(body["role"], "admin");
    assert!(
        body["deviceName"].is_null(),
        "no device name is a JSON null, got {}",
        body["deviceName"]
    );
    assert_eq!(body["canSend"], false);
    assert_eq!(
        body["requestedScopes"],
        json!(["dev:identity", "dev:channels:read"])
    );

    // Looking is not deciding: no row, and the same request can still be approved afterwards.
    assert_eq!(w.ledger_count().await, 0, "a preview recorded a decision");
    expect_status(
        &w.approve(&owner, &request).await,
        200,
        "approving after previewing",
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn the_server_name_on_the_consent_screen_keeps_the_port_of_the_configured_issuer() {
    let _guard = test_lock().await;
    let issuer = "https://oort.conformance.test:8443";
    let w = World::boot_with(AgentPortOauthConfig::for_tests_dev_login(
        issuer,
        DEV_CONSENT_URL,
    ))
    .await;
    let owner = w.person("owner", "이도현").await;
    let pkce = Pkce::fresh();
    // The resource of this server is its own issuer's: the one the other suite uses is not it.
    let resource = format!("{issuer}/v1/mcp/me");
    let wrong = w.authorize(&Authz::standard(&pkce)).await;
    expect_status(&wrong, 302, "a request naming another issuer's resource");
    assert_eq!(
        query_param(&wrong.location().expect("an error redirect"), "error").as_deref(),
        Some("invalid_target"),
        "the resource is derived from the configured issuer, port included"
    );
    let request = w
        .start(&Authz::standard(&pkce).set("resource", &resource))
        .await;
    let preview = w.preview(&owner.jwt, &request).await;
    expect_status(&preview, 200, "preview");
    assert_eq!(preview.json()["issuer"], issuer);
    assert_eq!(
        preview.json()["serverHost"],
        "oort.conformance.test:8443",
        "the host a person compares keeps its port"
    );
    let approved = w.approve(&owner, &request).await;
    expect_status(&approved, 200, "approve");
    let redirect_to = approved.json()["redirectTo"]
        .as_str()
        .expect("redirectTo")
        .to_string();
    assert_eq!(query_param(&redirect_to, "iss").as_deref(), Some(issuer));
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn the_three_consent_routes_answer_a_signed_in_person_and_nobody_else() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;
    let signed_out = w.person("admin", "달무리-로그아웃").await;
    let agent = seed_managed_agent(&w.su, w.workspace, owner.id, "assistant").await;
    let agent_bearer = seed_generic_agent_bearer(&w.su, w.workspace, agent.id).await;
    let card = w.card_for(admin.id, "박서연의 카드").await;
    let lineage = w.lineage_for(admin.id, "박서연의 oort CLI").await;
    let out = w
        .call(
            &w.base,
            Method::POST,
            "/v1/auth/logout",
            Some(&signed_out.jwt),
            None,
        )
        .await;
    expect_status(&out, 200, "signing a session out through the real route");

    let pkce = Pkce::fresh();
    let request = w.start(&Authz::standard(&pkce)).await;
    let ws = w.workspace;
    let routes: Vec<(&str, Method, String, Option<Value>)> = vec![
        (
            "preview",
            Method::GET,
            format!("{}?request={}", consent_path(ws, "preview"), pct(&request)),
            None,
        ),
        (
            "approve",
            Method::POST,
            consent_path(ws, "approve"),
            Some(approve_body(&request, PASSWORD, None)),
        ),
        (
            "deny",
            Method::POST,
            consent_path(ws, "deny"),
            Some(json!({"request": request})),
        ),
    ];
    for (route, method, path, body) in &routes {
        // No credential, a made-up one, and a session that was signed out: 401.
        expect_status(
            &w.hit(method, path, body, None).await,
            401,
            &format!("{route}: no credential"),
        );
        expect_status(
            &w.hit(method, path, body, Some("not-a-credential")).await,
            401,
            &format!("{route}: a made-up bearer"),
        );
        expect_status(
            &w.hit(method, path, body, Some(&signed_out.jwt)).await,
            401,
            &format!("{route}: a session that was signed out"),
        );
        // An agent member is not a person.
        expect_status(
            &w.hit(method, path, body, Some(&agent_bearer)).await,
            403,
            &format!("{route}: an agent's bearer"),
        );
        // A developer token — a card, a login's access — is refused by the door, whatever it is scoped to.
        for (what, token) in [
            ("a card", card.secret.as_str()),
            ("a login's access", lineage.access.as_str()),
        ] {
            expect_code(
                &w.hit(method, path, body, Some(token)).await,
                403,
                "dev_route_not_allowed",
                &format!("{route}: {what}"),
            );
        }
        // A login's refresh is not even a bearer.
        let refresh = w.hit(method, path, body, Some(&lineage.refresh)).await;
        assert!(
            matches!(refresh.status, 401 | 403),
            "{route}: a refresh envelope as a bearer, got {}",
            refresh.status
        );
    }
    assert_eq!(
        w.ledger_count().await,
        0,
        "a refused caller recorded a decision"
    );

    // Controls: the same card opens its own door, and the person's session reaches the route — so every
    // refusal above was about the caller, not about a broken route; and none of them used up the request.
    expect_status(
        &w.whoami(&card.secret).await,
        200,
        "the card opens its own door",
    );
    expect_status(
        &w.preview(&owner.jwt, &request).await,
        200,
        "the person's session reaches preview",
    );
    expect_status(
        &w.approve(&admin, &request).await,
        200,
        "the request survived every refused attempt",
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn an_approval_needs_a_live_access_session_and_not_just_a_session_row() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    // `seed_human` records the session as `label='apps-pg'`: a live session row, but not what a real
    // sign-in records (a person's *access* row, `label='access'`).
    let (id, jwt) = seed_human(&w.su, w.workspace, "owner", "이도현").await;
    sqlx::query(
        "UPDATE human SET password_hash = momo_password_hash($1) \
          WHERE workspace_id = $2 AND member_id = $3",
    )
    .bind(PASSWORD)
    .bind(w.workspace)
    .bind(id)
    .execute(&w.su)
    .await
    .expect("set the person's password");
    let person = Person { id, jwt };
    let request = w.start(&Authz::standard(&Pkce::fresh())).await;

    let refused = w.approve(&person, &request).await;
    expect_status(
        &refused,
        401,
        "an approval from a session row that is not an access row",
    );
    assert_eq!(
        w.ledger_count().await,
        0,
        "the refused approval stored a decision"
    );
    // The premise, from the route this one follows: the card route gives that session the same answer.
    expect_status(
        &w.issue_card_as(&person, PASSWORD).await,
        401,
        "the card route's answer for the same session",
    );

    // Control: the very same person once the session is recorded as a real sign-in records it — the
    // same request is approved, so the label was the only thing the 401 was about.
    sqlx::query(
        "UPDATE token SET label = 'access' \
          WHERE workspace_id = $1 AND actor_member_id = $2 AND kind = 'session'",
    )
    .bind(w.workspace)
    .bind(id)
    .execute(&w.su)
    .await
    .expect("record the session as an access row");
    expect_status(
        &w.approve(&person, &request).await,
        200,
        "the same request with an access session",
    );
}

impl World {
    /// One call of a table row of routes (`method`, `path`, `body`), with or without a bearer.
    async fn hit(
        &self,
        method: &Method,
        path: &str,
        body: &Option<Value>,
        bearer: Option<&str>,
    ) -> Reply {
        self.call(&self.base, method.clone(), path, bearer, body.clone())
            .await
    }

    /// `POST …/channels/{ch}/messages` (the dev door's L6, which needs `dev:messages:write`).
    async fn post_message(&self, token: &str, channel: Uuid) -> Reply {
        self.call(
            &self.base,
            Method::POST,
            &format!(
                "/v1/workspaces/{}/channels/{channel}/messages",
                self.workspace
            ),
            Some(token),
            Some(json!({"clientMsgId": Uuid::new_v4(), "body": "안녕하세요, 달무리 스튜디오예요"})),
        )
        .await
    }

    /// Push a waiting code's deadline an hour out. A test that holds a code across many requests does
    /// this so that a slow machine cannot turn the sixty seconds into the thing under test; the deadline
    /// itself is tested with explicit clock moves in `an_expired_code_is_refused…`.
    async fn keep_code_alive(&self, code: &str) {
        let moved = sqlx::query(
            "UPDATE dev_login_authorization SET code_expires_at = now() + interval '1 hour' \
              WHERE workspace_id = $1 AND code_hash = digest($2::text, 'sha256') \
                AND status = 'approved'",
        )
        .bind(self.workspace)
        .bind(code)
        .execute(&self.su)
        .await
        .expect("move a waiting code's deadline")
        .rows_affected();
        assert_eq!(moved, 1, "the code is a waiting one");
    }

    /// The rows of one member in the ledger.
    async fn ledger_of(&self, member: Uuid) -> Vec<LedgerRow> {
        self.ledger()
            .await
            .into_iter()
            .filter(|row| row.member_id == member)
            .collect()
    }
}

// ===========================================================================
// the decision — `POST …/approve`, `POST …/deny`
// ===========================================================================

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn an_approval_answers_a_loopback_redirect_and_the_ledger_keeps_only_a_digest_of_the_code() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let pkce = Pkce::rfc7636();
    let key = dev_login_request_key(TEST_JWT_SECRET);
    let params = Authz::standard(&pkce)
        .set("redirect_uri", REDIRECTS[3])
        .set("state", "원본 상태/1")
        .set("device_name", DEVICE);
    let request = w.start(&params).await;
    let claims = verify_dev_login_request(&key, &request).expect("the envelope verifies");

    let reply = w.approve(&owner, &request).await;
    expect_status(&reply, 200, "approving");
    assert!(
        reply.no_store(),
        "an answer that carries a code is `no-store`"
    );
    assert_eq!(
        keys_of(&reply.json()),
        names(&["redirectTo"]),
        "the approval answers `redirectTo` and nothing else"
    );
    let redirect_to = reply.json()["redirectTo"]
        .as_str()
        .expect("redirectTo")
        .to_string();
    assert!(
        redirect_to.starts_with(&format!("{}?", REDIRECTS[3])),
        "the redirect is the one the request named, got {redirect_to}"
    );
    assert_eq!(
        param_names(&redirect_to),
        names(&["code", "state", "iss"]),
        "exactly code, state and iss: {redirect_to}"
    );
    assert_eq!(
        query_param(&redirect_to, "state").as_deref(),
        Some("원본 상태/1"),
        "the client's state comes back exactly"
    );
    assert_eq!(
        query_param(&redirect_to, "iss").as_deref(),
        Some(ISSUER),
        "RFC 9207: `iss` is the configured issuer"
    );
    let code = query_param(&redirect_to, "code").expect("a code");
    assert!(
        is_envelope_of(&code, "momo_devc_v1", w.workspace),
        "the code is `momo_devc_v1.<this workspace>.<43 characters>`, got {code}"
    );

    // The ledger: one approved row, exactly what was asked, chosen and decided.
    let row = w.only_ledger_row().await;
    assert_eq!(row.status, "approved");
    assert_eq!(
        row.member_id, owner.id,
        "the person who approved owns the code"
    );
    assert_eq!(
        row.nonce.to_string(),
        claims.jti,
        "keyed on the request's nonce"
    );
    assert_eq!(row.client_id, CLIENT_ID);
    assert_eq!(row.redirect_uri, REDIRECTS[3]);
    assert_eq!(row.resource, DEV_RESOURCE);
    assert_eq!(row.requested, canonical(&SCOPE_ORDER));
    assert_eq!(
        row.approved,
        canonical(&READ_ONLY),
        "no choice made: 「읽기만」 ∩ the request"
    );
    assert_eq!(row.challenge, pkce.challenge);
    assert_eq!(row.method, "S256");
    assert_eq!(row.device_name.as_deref(), Some(DEVICE));
    assert_eq!(
        row.code_hash_hex.as_deref(),
        Some(sha256_hex(&code).as_str()),
        "only the SHA-256 of the whole code is stored"
    );
    let ttl = row.ttl_seconds.expect("a code has a deadline");
    assert!(
        (58.0..=62.0).contains(&ttl),
        "a code lives sixty seconds, got {ttl}"
    );
    assert!(
        !row.consumed && row.session_id.is_none(),
        "nothing exchanged yet"
    );

    // The raw code (and the verifier) is in no row at all.
    for (what, haystack) in [
        ("the ledger", w.ledger_text().await),
        ("the audit log", w.audit_text().await),
    ] {
        assert_eq!(
            leaked_piece(&haystack, &code),
            None,
            "{what} holds a piece of the code"
        );
        assert!(
            !haystack.contains(&pkce.verifier),
            "{what} holds the verifier"
        );
    }
    assert_eq!(
        w.dev_rows(owner.id).await,
        0,
        "consent is not a login: nothing is opened until the code is exchanged"
    );

    // One audit line, naming the decision and the scopes — and no device name, challenge or password.
    let granted = w.audit("dev_token.consent_granted").await;
    assert_eq!(granted.len(), 1, "one `dev_token.consent_granted` line");
    assert_eq!(granted[0].detail["decision"], "approved");
    assert_eq!(granted[0].detail["scopes"], json!(READ_ONLY));
    let audit_text = w.audit_text().await;
    for private in [DEVICE, pkce.challenge.as_str(), PASSWORD] {
        assert!(
            !audit_text.contains(private),
            "the audit log holds `{private}`"
        );
    }

    // A request without a state gets a redirect without one.
    let stateless = w
        .start(&Authz::standard(&Pkce::fresh()).omit("state"))
        .await;
    let reply = w.approve(&owner, &stateless).await;
    expect_status(&reply, 200, "approving a request without state");
    let redirect_to = reply.json()["redirectTo"]
        .as_str()
        .expect("redirectTo")
        .to_string();
    assert_eq!(param_names(&redirect_to), names(&["code", "iss"]));
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn a_state_comes_back_exactly_and_adds_no_parameter_to_the_redirect() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let nasty = "a b&code=evil&iss=x#y?z+é/%41";
    let pkce = Pkce::fresh();

    // approve
    let request = w.start(&Authz::standard(&pkce).set("state", nasty)).await;
    let reply = w.approve(&owner, &request).await;
    expect_status(&reply, 200, "approving");
    let approved = reply.json()["redirectTo"]
        .as_str()
        .expect("redirectTo")
        .to_string();
    assert_eq!(
        param_names(&approved),
        names(&["code", "state", "iss"]),
        "the state did not forge a parameter: {approved}"
    );
    assert_eq!(query_param(&approved, "state").as_deref(), Some(nasty));
    assert_eq!(query_param(&approved, "iss").as_deref(), Some(ISSUER));
    assert_eq!(query_pairs(&approved).len(), 3, "no duplicated parameter");

    // deny
    let request = w.start(&Authz::standard(&pkce).set("state", nasty)).await;
    let reply = w.deny(&owner, &request).await;
    expect_status(&reply, 200, "denying");
    let denied = reply.json()["redirectTo"]
        .as_str()
        .expect("redirectTo")
        .to_string();
    assert_eq!(
        param_names(&denied),
        names(&["error", "state", "iss"]),
        "{denied}"
    );
    assert_eq!(query_param(&denied, "state").as_deref(), Some(nasty));
    assert_eq!(query_pairs(&denied).len(), 3);

    // an authorize error
    let reply = w
        .authorize(
            &Authz::standard(&pkce)
                .set("state", nasty)
                .set("scope", "admin"),
        )
        .await;
    expect_status(&reply, 302, "an erroring authorize");
    let location = reply.location().expect("an error redirect");
    assert_eq!(
        param_names(&location),
        names(&["error", "state", "iss"]),
        "{location}"
    );
    assert_eq!(query_param(&location, "state").as_deref(), Some(nasty));
    assert_eq!(query_pairs(&location).len(), 3);
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn a_denial_answers_access_denied_and_opens_nothing() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let pkce = Pkce::fresh();
    let request = w
        .start(
            &Authz::standard(&pkce)
                .set("redirect_uri", REDIRECTS[1])
                .set("state", "s-deny"),
        )
        .await;

    let reply = w.deny(&owner, &request).await;
    expect_status(&reply, 200, "denying");
    assert!(reply.no_store());
    assert_eq!(keys_of(&reply.json()), names(&["redirectTo"]));
    let redirect_to = reply.json()["redirectTo"]
        .as_str()
        .expect("redirectTo")
        .to_string();
    assert!(
        redirect_to.starts_with(&format!("{}?", REDIRECTS[1])),
        "{redirect_to}"
    );
    assert_eq!(param_names(&redirect_to), names(&["error", "state", "iss"]));
    assert_eq!(
        query_param(&redirect_to, "error").as_deref(),
        Some("access_denied")
    );
    assert_eq!(
        query_param(&redirect_to, "state").as_deref(),
        Some("s-deny")
    );
    assert_eq!(query_param(&redirect_to, "iss").as_deref(), Some(ISSUER));

    let row = w.only_ledger_row().await;
    assert_eq!(row.status, "denied", "the refusal is the terminal decision");
    assert!(row.code_hash_hex.is_none(), "a denial carries no code");
    assert!(row.approved.is_empty(), "a denial approves nothing");
    assert_eq!(w.dev_rows(owner.id).await, 0, "a denial opens nothing");
    assert_eq!(w.audit_count("dev_token.consent_denied").await, 1);
    assert_eq!(w.audit_count("dev_token.consent_granted").await, 0);
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn exactly_one_terminal_decision_survives_per_request() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;

    // approve → approve → deny
    let first = w.grant_all(&owner).await;
    w.keep_code_alive(&first.code).await;
    let again = w.approve(&owner, &first.request).await;
    expect_code(&again, 409, "dev_login_already_decided", "a second approve");
    let late_deny = w.deny(&owner, &first.request).await;
    expect_code(
        &late_deny,
        409,
        "dev_login_already_decided",
        "a deny after an approve",
    );
    assert_eq!(
        w.ledger_count().await,
        1,
        "one row per request, however many times it was decided"
    );
    // The first approval is untouched: its code is the only one, and it redeems.
    assert_eq!(
        w.ledger()
            .await
            .iter()
            .filter(|row| row.code_hash_hex.is_some())
            .count(),
        1,
        "the second approve did not mint a second code"
    );
    Tokens::from_reply(&w.exchange(&first).await);

    // deny → approve
    let pkce = Pkce::fresh();
    let request = w.start(&Authz::standard(&pkce)).await;
    expect_status(
        &w.deny(&owner, &request).await,
        200,
        "the first decision: a denial",
    );
    let late_approve = w.approve(&owner, &request).await;
    expect_code(
        &late_approve,
        409,
        "dev_login_already_decided",
        "an approve after a deny",
    );
    let rows = w.ledger().await;
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows.iter().filter(|row| row.status == "denied").count(),
        1,
        "the denial stands"
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row.code_hash_hex.is_some())
            .count(),
        1,
        "a denied request mints no code, however it is asked again"
    );
    assert_eq!(w.audit_count("dev_token.consent_granted").await, 1);
    assert_eq!(w.audit_count("dev_token.consent_denied").await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn two_simultaneous_decisions_of_one_request_let_exactly_one_through() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let key = dev_login_request_key(TEST_JWT_SECRET);

    for round in 0..3 {
        for (first_verb, second_verb) in [("approve", "approve"), ("approve", "deny")] {
            let pkce = Pkce::fresh();
            let request = w.start(&Authz::standard(&pkce)).await;
            let gate = Arc::new(tokio::sync::Barrier::new(2));
            let mut racers = Vec::new();
            for verb in [first_verb, second_verb] {
                let http = w.http.clone();
                let gate = gate.clone();
                let url = format!("{}{}", w.base, consent_path(w.workspace, verb));
                let jwt = owner.jwt.clone();
                let body = if verb == "approve" {
                    approve_body(&request, PASSWORD, None)
                } else {
                    json!({"request": request})
                };
                racers.push(tokio::spawn(async move {
                    gate.wait().await;
                    let response = http
                        .post(url)
                        .bearer_auth(jwt)
                        .json(&body)
                        .send()
                        .await
                        .expect("the server answers");
                    let status = response.status().as_u16();
                    let text = response.text().await.unwrap_or_default();
                    (status, text)
                }));
            }
            let mut answers = Vec::new();
            for racer in racers {
                answers.push(racer.await.expect("racer task"));
            }
            let mut statuses: Vec<u16> = answers.iter().map(|(status, _)| *status).collect();
            statuses.sort_unstable();
            assert_eq!(
                statuses,
                [200, 409],
                "round {round} {first_verb}‖{second_verb}: exactly one decision wins: {answers:?}"
            );
            let loser = answers
                .iter()
                .find(|(status, _)| *status == 409)
                .expect("a loser");
            assert!(
                loser.1.contains("dev_login_already_decided"),
                "round {round}: the loser is told the request was decided: {}",
                loser.1
            );
            let nonce = verify_dev_login_request(&key, &request)
                .expect("the envelope verifies")
                .jti;
            let rows: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM dev_login_authorization \
                  WHERE workspace_id = $1 AND request_nonce = $2::uuid",
            )
            .bind(w.workspace)
            .bind(&nonce)
            .fetch_one(&w.su)
            .await
            .expect("count the decisions of one nonce");
            assert_eq!(
                rows, 1,
                "round {round} {first_verb}‖{second_verb}: one row per nonce"
            );
        }
    }
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn the_issued_scopes_are_the_request_intersected_with_the_choice_and_the_token_does_exactly_that(
) {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let channel = seed_channel(&w.su, w.workspace, "public", &[owner.id]).await;

    // (a) No choice made, the request asks for read and send: 「읽기만」 — the send scope is not issued,
    // and the token cannot send.
    let granted = w
        .grant(
            &owner,
            "dev:channels:read dev:messages:read dev:messages:write",
            None,
        )
        .await;
    let row = w.ledger().await.pop().expect("the approval's row");
    assert_eq!(
        row.approved,
        canonical(&["dev:identity", "dev:channels:read", "dev:messages:read"]),
        "no choice: read-only ∩ the request"
    );
    let tokens = Tokens::from_reply(&w.exchange(&granted).await);
    assert_eq!(
        tokens.scope,
        "dev:identity dev:channels:read dev:messages:read"
    );
    assert_eq!(
        w.whoami(&tokens.access).await.json()["scopes"],
        json!(["dev:identity", "dev:channels:read", "dev:messages:read"])
    );
    assert_eq!(w.door(&tokens.access).await, 200, "it can read channels");
    expect_code(
        &w.post_message(&tokens.access, channel).await,
        403,
        "dev_scope_denied",
        "a read-only login sending a message",
    );

    // (b) The person ticks send (and not `messages:read`, though it was requested): the token carries
    // exactly that, `dev:identity` in front, and it can send.
    let granted = w
        .grant(
            &owner,
            "dev:channels:read dev:messages:read dev:messages:write",
            Some(&["dev:messages:write", "dev:channels:read"]),
        )
        .await;
    let row = w.ledger().await.pop().expect("the approval's row");
    assert_eq!(
        row.approved,
        canonical(&["dev:identity", "dev:channels:read", "dev:messages:write"]),
        "the choice, in the contract's order, with `dev:identity` added"
    );
    let tokens = Tokens::from_reply(&w.exchange(&granted).await);
    assert_eq!(
        tokens.scope,
        "dev:identity dev:channels:read dev:messages:write"
    );
    let sent = w.post_message(&tokens.access, channel).await;
    expect_status(&sent, 201, "a login that was allowed to send");

    // (c) A choice outside the request is a 400 and stores nothing — and the same request is still
    // there to be approved properly afterwards.
    let pkce = Pkce::fresh();
    let request = w
        .start(&Authz::standard(&pkce).set("scope", "dev:channels:read"))
        .await;
    let rows_before = w.ledger_count().await;
    for (what, approved) in [
        ("a scope that was not requested", vec!["dev:inbox:read"]),
        (
            "a requested scope plus one that was not",
            vec!["dev:channels:read", "dev:messages:write"],
        ),
        (
            "a scope outside the vocabulary",
            vec!["dev:channels:read", "admin"],
        ),
        ("a hosted scope", vec!["agent:port:connect"]),
    ] {
        let reply = w
            .approve_as(&owner, &request, PASSWORD, Some(approved.as_slice()))
            .await;
        expect_status(&reply, 400, what);
    }
    assert_eq!(
        w.ledger_count().await,
        rows_before,
        "a refused choice stored a row"
    );
    assert_eq!(
        w.ledger()
            .await
            .iter()
            .filter(|row| row.code_hash_hex.is_some())
            .count(),
        rows_before,
        "a refused choice minted a code"
    );
    let proper = w
        .approve_as(&owner, &request, PASSWORD, Some(&["dev:channels:read"]))
        .await;
    expect_status(&proper, 200, "the same request, approved within itself");
    assert_eq!(w.ledger_count().await, rows_before + 1);

    // (d) Only `dev:identity` was asked for and ticked: identity works, channels do not.
    let granted = w
        .grant(&owner, "dev:identity", Some(&["dev:identity"]))
        .await;
    let tokens = Tokens::from_reply(&w.exchange(&granted).await);
    assert_eq!(tokens.scope, "dev:identity");
    expect_status(&w.whoami(&tokens.access).await, 200, "identity-only whoami");
    expect_code(
        &w.call(
            &w.base,
            Method::GET,
            &format!("/v1/workspaces/{}/channels", w.workspace),
            Some(&tokens.access),
            None,
        )
        .await,
        403,
        "dev_scope_denied",
        "an identity-only login listing channels",
    );

    // (e) A choice that leaves out `dev:identity` still gets it.
    let granted = w
        .grant(&owner, ALL_SCOPES, Some(&["dev:channels:read"]))
        .await;
    let tokens = Tokens::from_reply(&w.exchange(&granted).await);
    assert_eq!(tokens.scope, "dev:identity dev:channels:read");
    assert_eq!(
        w.audit("dev_token.login_issued")
            .await
            .last()
            .expect("a login line")
            .detail["scopes"],
        json!(["dev:identity", "dev:channels:read"]),
        "the audit line carries the issued scopes"
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn a_missing_wrong_or_unavailable_password_issues_nothing_and_a_wrong_one_leaves_one_refusal_line(
) {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let sso = w
        .person_in(w.workspace, "admin", "박서연", None) // signed in without a password
        .await;
    let pkce = Pkce::fresh();
    let request = w.start(&Authz::standard(&pkce)).await;
    let mut answers: Vec<String> = Vec::new();
    let approve_path = consent_path(w.workspace, "approve");

    // (i) A body that cannot be read, or has no password: a 400 before anything is compared.
    let bodies: Vec<(&str, Value)> = vec![
        ("no currentPassword", json!({"request": request})),
        (
            "an empty currentPassword",
            json!({"request": request, "currentPassword": ""}),
        ),
        (
            "a non-string currentPassword",
            json!({"request": request, "currentPassword": 7}),
        ),
        ("no request", json!({"currentPassword": PASSWORD})),
        (
            "an approvedScopes that is not a list",
            json!({"request": request, "currentPassword": PASSWORD, "approvedScopes": "dev:identity"}),
        ),
    ];
    for (what, body) in bodies {
        let reply = w
            .send(Method::POST, &approve_path, &owner.jwt, Some(body))
            .await;
        expect_status(&reply, 400, what);
        answers.push(reply.text());
    }
    let unreadable = to_reply(
        w.http
            .post(format!("{}{approve_path}", w.base))
            .bearer_auth(&owner.jwt)
            .header("content-type", "application/json")
            .body("{not json"),
    )
    .await;
    expect_status(&unreadable, 400, "a body that is not JSON");
    answers.push(unreadable.text());
    assert_eq!(w.ledger_count().await, 0, "no password, no decision");
    assert_eq!(
        w.audit_count("dev_token.consent_refused").await,
        0,
        "a body that was never compared is not a refused consent"
    );

    // (ii) A wrong password: 403, no row, one refusal line per attempt.
    for attempt in 1..=2 {
        let reply = w.approve_as(&owner, &request, WRONG_PASSWORD, None).await;
        expect_code(
            &reply,
            403,
            "current_password_incorrect",
            "a wrong password",
        );
        answers.push(reply.text());
        assert_eq!(
            w.ledger_count().await,
            0,
            "a wrong password stored a decision (attempt {attempt})"
        );
        assert_eq!(w.dev_rows(owner.id).await, 0);
        let refused = w.audit("dev_token.consent_refused").await;
        assert_eq!(
            refused.len(),
            attempt,
            "one `dev_token.consent_refused` line per wrong attempt"
        );
        assert_eq!(
            refused.last().expect("a line").detail["reason"],
            "password_mismatch"
        );
    }

    // (iii) An account with no password to confirm: 403 with its own code and reason.
    let request_sso = w.start(&Authz::standard(&Pkce::fresh())).await;
    let reply = w.approve_as(&sso, &request_sso, PASSWORD, None).await;
    expect_code(
        &reply,
        403,
        "current_password_unavailable",
        "an account without a password",
    );
    answers.push(reply.text());
    assert_eq!(w.ledger_count().await, 0);
    let unavailable: Vec<AuditRow> = w
        .audit("dev_token.consent_refused")
        .await
        .into_iter()
        .filter(|row| row.detail["reason"] == "password_unavailable")
        .collect();
    assert_eq!(
        unavailable.len(),
        1,
        "the passwordless account's refusal is recorded too"
    );

    // (iv) None of that used the request up: the right password on the same request, now.
    let reply = w.approve(&owner, &request).await;
    expect_status(&reply, 200, "the right password");
    answers.push(reply.text());
    assert_eq!(w.ledger_count().await, 1, "exactly the one right attempt");
    assert_eq!(
        w.audit("dev_token.consent_refused").await.len(),
        3,
        "the right attempt wrote no refusal line"
    );

    // No password — right or wrong — is echoed or recorded.
    let audit_text = w.audit_text().await;
    for password in [PASSWORD, WRONG_PASSWORD] {
        assert!(
            !audit_text.contains(password),
            "an audit row holds a password"
        );
        for answer in &answers {
            assert!(
                !answer.contains(password),
                "an answer echoes a password: {answer}"
            );
        }
    }
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn five_wrong_passwords_in_a_window_lock_approving_out_even_for_the_right_one() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;
    let pkce = Pkce::fresh();

    // A right password first: an approval, and it is not a failure, so it takes nothing off the five.
    let first = w.start(&Authz::standard(&pkce)).await;
    expect_status(
        &w.approve(&owner, &first).await,
        200,
        "a right password before any failure",
    );

    // Five wrong ones on another request: each is a 403 that is not rate limited.
    let request = w.start(&Authz::standard(&pkce)).await;
    for attempt in 1..=5 {
        let reply = w.approve_as(&owner, &request, WRONG_PASSWORD, None).await;
        expect_code(
            &reply,
            403,
            "current_password_incorrect",
            &format!("wrong password {attempt} of 5"),
        );
        assert_eq!(
            reply.header("retry-after"),
            None,
            "a 403 carries no Retry-After"
        );
    }

    // The sixth try is a 429 with a Retry-After inside the window …
    let sixth = w.approve_as(&owner, &request, WRONG_PASSWORD, None).await;
    expect_status(&sixth, 429, "the sixth wrong password in the window");
    let retry_after: u64 = sixth
        .header("retry-after")
        .expect("a 429 carries Retry-After")
        .parse()
        .expect("Retry-After is whole seconds");
    assert!(
        (1..=60).contains(&retry_after),
        "Retry-After is inside the 60 s window, got {retry_after}"
    );
    // … and the RIGHT password is refused in that window too, without a decision.
    let right = w.approve(&owner, &request).await;
    expect_status(&right, 429, "the right password in a full window");
    assert!(
        right.header("retry-after").is_some(),
        "its 429 carries Retry-After too"
    );
    assert!(
        !right.text().contains("redirectTo"),
        "a 429 hands out no redirect"
    );
    assert_eq!(
        w.ledger_count().await,
        1,
        "only the very first approval left a row: the five wrong and the two 429s stored nothing"
    );
    assert_eq!(
        w.audit("dev_token.consent_refused")
            .await
            .iter()
            .filter(|row| row.detail["reason"] == "password_mismatch")
            .count(),
        5,
        "one refusal line per compared password; a 429 compared nothing and wrote nothing"
    );

    // The budget is the member's, not the workspace's or the address's: another member of the same
    // workspace, from the same address, approves; and the locked member can still look.
    let other_request = w.start(&Authz::standard(&pkce)).await;
    expect_status(
        &w.approve(&admin, &other_request).await,
        200,
        "another member while the owner is locked out",
    );
    expect_status(
        &w.preview(&owner.jwt, &request).await,
        200,
        "the lock-out is for approving, not for looking",
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn the_password_budget_of_approving_is_the_one_of_issuing_a_card_five_a_minute_together() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;
    let third = w.person("admin", "달무리-운영자").await;
    let pkce = Pkce::fresh();

    // The owner: three wrong passwords at the card route and two at approve — neither route alone has
    // reached five; together they have.
    let request = w.start(&Authz::standard(&pkce)).await;
    for _ in 0..3 {
        expect_code(
            &w.issue_card_as(&owner, WRONG_PASSWORD).await,
            403,
            "current_password_incorrect",
            "a wrong password at the card route",
        );
    }
    for _ in 0..2 {
        expect_code(
            &w.approve_as(&owner, &request, WRONG_PASSWORD, None).await,
            403,
            "current_password_incorrect",
            "a wrong password at approve",
        );
    }
    let approve = w.approve(&owner, &request).await;
    expect_status(
        &approve,
        429,
        "the right password at approve after 3 + 2 failures",
    );
    assert!(approve.header("retry-after").is_some());
    let card = w.issue_card_as(&owner, PASSWORD).await;
    expect_status(
        &card,
        429,
        "the right password at the card route after 3 + 2 failures",
    );
    assert!(card.header("retry-after").is_some());
    assert_eq!(w.ledger_count().await, 0);
    assert_eq!(
        w.dev_rows(owner.id).await,
        0,
        "no card was issued past the budget"
    );

    // The admin: the other way round (three at approve, two at the card route).
    let request = w.start(&Authz::standard(&pkce)).await;
    for _ in 0..3 {
        expect_code(
            &w.approve_as(&admin, &request, WRONG_PASSWORD, None).await,
            403,
            "current_password_incorrect",
            "a wrong password at approve",
        );
    }
    for _ in 0..2 {
        expect_code(
            &w.issue_card_as(&admin, WRONG_PASSWORD).await,
            403,
            "current_password_incorrect",
            "a wrong password at the card route",
        );
    }
    expect_status(
        &w.issue_card_as(&admin, PASSWORD).await,
        429,
        "the right password at the card route after 3 + 2 failures",
    );
    expect_status(
        &w.approve(&admin, &request).await,
        429,
        "the right password at approve after 3 + 2 failures",
    );
    assert_eq!(w.ledger_count().await, 0);

    // Control: four failures in total (2 + 2) leave one slot, and the right password still works at both
    // routes — the budget is five, not four, and a right password is refunded.
    let request = w.start(&Authz::standard(&pkce)).await;
    for _ in 0..2 {
        expect_code(
            &w.issue_card_as(&third, WRONG_PASSWORD).await,
            403,
            "current_password_incorrect",
            "a wrong password at the card route",
        );
        expect_code(
            &w.approve_as(&third, &request, WRONG_PASSWORD, None).await,
            403,
            "current_password_incorrect",
            "a wrong password at approve",
        );
    }
    expect_status(
        &w.approve(&third, &request).await,
        200,
        "the right password after four failures",
    );
    expect_status(
        &w.issue_card_as(&third, PASSWORD).await,
        201,
        "the card with the right password after four failures",
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn a_role_outside_the_switch_is_refused_before_the_password_is_compared() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;
    let member = w.person("member", "달무리-멤버").await;
    let guest = w.person("guest", "달무리-게스트").await;
    let pkce = Pkce::fresh();
    let request = w.start(&Authz::standard(&pkce)).await;

    // Approve: 403 whatever the password — seven wrong ones never become a 429 (no budget slot is taken
    // for a refused role) and never a password verdict (nothing was compared).
    for (who, role) in [(&member, "member"), (&guest, "guest")] {
        for attempt in 1..=7 {
            let reply = w.approve_as(who, &request, WRONG_PASSWORD, None).await;
            expect_code(
                &reply,
                403,
                "dev_access_denied",
                &format!("{role}, wrong password, attempt {attempt}"),
            );
        }
        expect_code(
            &w.approve(who, &request).await,
            403,
            "dev_access_denied",
            &format!("{role}, right password"),
        );
    }
    assert_eq!(
        w.ledger_count().await,
        0,
        "a refused role stored a decision"
    );
    let refusals = w.audit("dev_token.consent_refused").await;
    assert!(
        !refusals.is_empty() && refusals.iter().all(|row| row.detail["reason"] == "policy_denied"),
        "every refusal is `policy_denied`; no password was compared, so no `password_mismatch` exists"
    );

    // Preview and deny are refused the same way — and a refused deny does not use the request up, so the
    // person it was meant for can still decide (a member must not be able to veto an admin's login).
    for (who, role) in [(&member, "member"), (&guest, "guest")] {
        expect_code(
            &w.preview(&who.jwt, &request).await,
            403,
            "dev_access_denied",
            &format!("{role}: preview"),
        );
        expect_code(
            &w.deny(who, &request).await,
            403,
            "dev_access_denied",
            &format!("{role}: deny"),
        );
    }
    assert_eq!(w.ledger_count().await, 0);

    // Control: owner and admin are admitted, the same request included.
    expect_status(
        &w.approve(&admin, &request).await,
        200,
        "an admin approving",
    );
    let other = w.start(&Authz::standard(&pkce)).await;
    expect_status(&w.approve(&owner, &other).await, 200, "an owner approving");
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn ten_live_login_lineages_refuse_the_approval_until_one_ends() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;
    let mut lineages = Vec::new();
    for number in 1..=10 {
        lineages.push(
            w.lineage_for(owner.id, &format!("이도현의 oort CLI {number}"))
                .await,
        );
    }
    let rows_before = w.dev_rows(owner.id).await;
    assert_eq!(rows_before, 20, "ten lineages of two rows each");

    let pkce = Pkce::fresh();
    let request = w.start(&Authz::standard(&pkce)).await;
    let refused = w.approve(&owner, &request).await;
    expect_code(
        &refused,
        409,
        "dev_credential_limit",
        "the eleventh lineage's approval",
    );
    assert!(!refused.text().contains("redirectTo"));
    assert_eq!(
        w.ledger_count().await,
        0,
        "the limit stored no decision and minted no code"
    );
    assert_eq!(
        w.dev_rows(owner.id).await,
        rows_before,
        "the limit opened nothing"
    );
    let refusals: Vec<AuditRow> = w
        .audit("dev_token.consent_refused")
        .await
        .into_iter()
        .filter(|row| row.detail["reason"] == "limit")
        .collect();
    assert_eq!(
        refusals.len(),
        1,
        "the refusal is recorded with the reason `limit`"
    );

    // The limit is the member's own.
    let other = w.start(&Authz::standard(&pkce)).await;
    expect_status(
        &w.approve(&admin, &other).await,
        200,
        "another member at the same time",
    );

    // One lineage ended through the real revoke route: the same request now goes through.
    let ended = w
        .send(
            Method::DELETE,
            &dev_path(
                w.workspace,
                &format!("/credentials/{}", lineages[0].session_id),
            ),
            &owner.jwt,
            None,
        )
        .await;
    expect_status(&ended, 200, "ending one lineage");
    expect_status(
        &w.approve(&owner, &request).await,
        200,
        "the same request after one lineage ended",
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn a_bad_request_envelope_is_one_and_the_same_404_sentence_and_records_nothing() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let pkce = Pkce::fresh();
    let valid = w.start(&Authz::standard(&pkce)).await;
    let dev_key = dev_login_request_key(TEST_JWT_SECRET);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("the clock")
        .as_secs() as i64;
    let scopes = strings(&["dev:identity", "dev:channels:read"]);
    let seed = |client_id| DevLoginRequestSeed {
        nonce: Uuid::new_v4(),
        client_id,
        redirect_uri: REDIRECT,
        resource: DEV_RESOURCE,
        scopes: &scopes,
        code_challenge: &pkce.challenge,
        code_challenge_method: "S256",
        state: None,
        device_name: None,
    };

    // The first character of the signature segment is fully significant: flipping it breaks the HMAC.
    let tampered = {
        let mut parts: Vec<String> = valid.split('.').map(str::to_string).collect();
        let signature = parts.last_mut().expect("a signature segment");
        let first = signature.remove(0);
        signature.insert(0, if first == 'A' { 'B' } else { 'A' });
        parts.join(".")
    };
    let expired = sign_dev_login_request(&dev_key, seed(CLIENT_ID), now - 1200)
        .expect("sign an envelope that expired ten minutes ago");
    let other_secret = sign_dev_login_request(
        &dev_login_request_key("another-signing-secret"),
        seed(CLIENT_ID),
        now,
    )
    .expect("sign under another secret");
    let other_client = sign_dev_login_request(&dev_key, seed(HOSTED_CLIENT_ID), now)
        .expect("sign a request of another client");
    let hosted_scopes = strings(&["agent:port:connect"]);
    let hosted_typed = sign_authorization_request(
        &hosted_oauth_request_key(TEST_JWT_SECRET),
        AuthorizationRequestSeed {
            nonce: Uuid::new_v4(),
            client_id: HOSTED_CLIENT_ID,
            redirect_uri: HOSTED_REDIRECT_URI,
            resource: HOSTED_RESOURCE,
            scopes: &hosted_scopes,
            code_challenge: &pkce.challenge,
            code_challenge_method: "S256",
            state: None,
        },
        now,
    )
    .expect("sign a hosted request envelope");
    // The walls one at a time. A dev-typed request signed with the HOSTED key: only the key is wrong …
    let hosted_key = hosted_oauth_request_key(TEST_JWT_SECRET);
    let dev_typed_hosted_key = sign_dev_login_request(&hosted_key, seed(CLIENT_ID), now)
        .expect("sign a dev request under the hosted key");
    // … and a HOSTED-typed request signed with the dev key that names the built-in client and its exact
    // redirect, resource and scopes: only the `typ` is wrong.
    let hosted_typed_dev_key = sign_authorization_request(
        &dev_key,
        AuthorizationRequestSeed {
            nonce: Uuid::new_v4(),
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT,
            resource: DEV_RESOURCE,
            scopes: &scopes,
            code_challenge: &pkce.challenge,
            code_challenge_method: "S256",
            state: None,
        },
        now,
    )
    .expect("sign a hosted-typed request under the dev key");
    let variants: Vec<(&str, String)> = vec![
        ("a tampered signature", tampered),
        (
            "a dev request signed with the hosted key",
            dev_typed_hosted_key,
        ),
        (
            "a hosted-typed request signed with the dev key (otherwise a perfect dev request)",
            hosted_typed_dev_key,
        ),
        ("garbage", "not-an-envelope".to_string()),
        ("an expired envelope", expired),
        ("an envelope signed with another secret", other_secret),
        ("another client's request", other_client),
        ("a hosted request envelope", hosted_typed),
    ];

    let mut previews: Vec<Fingerprint> = Vec::new();
    let mut approvals: Vec<Fingerprint> = Vec::new();
    let mut denials: Vec<Fingerprint> = Vec::new();
    let mut sentences: BTreeSet<String> = BTreeSet::new();
    for (what, envelope) in &variants {
        let preview = w.preview(&owner.jwt, envelope).await;
        let approval = w.approve(&owner, envelope).await;
        let denial = w.deny(&owner, envelope).await;
        for (route, reply) in [
            ("preview", &preview),
            ("approve", &approval),
            ("deny", &denial),
        ] {
            expect_code(
                reply,
                404,
                "dev_login_request_not_found",
                &format!("{what}: {route}"),
            );
            sentences.insert(
                reply.json()["error"]["message"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            );
        }
        previews.push(preview.fingerprint());
        approvals.push(approval.fingerprint());
        denials.push(denial.fingerprint());
    }
    for (route, prints) in [
        ("preview", &previews),
        ("approve", &approvals),
        ("deny", &denials),
    ] {
        assert!(
            prints.iter().all(|print| print == &prints[0]),
            "{route}: the kinds of bad envelope are told apart by their answer"
        );
    }
    assert_eq!(
        sentences.len(),
        1,
        "one sentence for every kind of bad envelope and every route: {sentences:?}"
    );

    // Nothing was recorded, and the request that was genuine all along is still approvable.
    assert_eq!(w.ledger_count().await, 0);
    for action in [
        "dev_token.consent_granted",
        "dev_token.consent_denied",
        "dev_token.consent_refused",
    ] {
        assert_eq!(
            w.audit_count(action).await,
            0,
            "{action} was written for a bad envelope"
        );
    }
    assert_eq!(w.dev_rows(owner.id).await, 0);
    expect_status(&w.approve(&owner, &valid).await, 200, "the genuine request");
}

// ===========================================================================
// the exchange — `POST /v1/oauth/token`, `grant_type=authorization_code`
// ===========================================================================

/// The 200 body of the token endpoint: exactly these keys.
const TOKEN_KEYS: [&str; 6] = [
    "access_token",
    "token_type",
    "expires_in",
    "refresh_token",
    "scope",
    "workspace_id",
];

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn the_exchange_opens_a_login_lineage_of_exactly_the_approved_scopes_and_keeps_only_digests()
{
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let pkce = Pkce::fresh();
    let params = Authz::standard(&pkce).set("device_name", DEVICE);
    let granted = w.grant_with(&owner, pkce, &params, None).await;

    let reply = w.exchange(&granted).await;
    expect_status(&reply, 200, "the exchange");
    assert!(reply.no_store(), "the token answer is `no-store`");
    assert_eq!(
        reply.header("pragma").as_deref(),
        Some("no-cache"),
        "and `Pragma: no-cache`"
    );
    let body = reply.json();
    assert_eq!(
        keys_of(&body),
        names(&TOKEN_KEYS),
        "the 200 body's keys are closed: {body}"
    );
    assert_eq!(body["token_type"], "Bearer");
    assert_eq!(
        body["expires_in"], 900,
        "an access token lives fifteen minutes"
    );
    assert_eq!(
        body["scope"],
        "dev:identity dev:channels:read dev:messages:read dev:inbox:read"
    );
    assert_eq!(body["workspace_id"], w.workspace.to_string());
    let tokens = Tokens::from_reply(&reply);
    assert!(
        is_envelope_of(&tokens.access, "momo_dev_v1", w.workspace),
        "the access token is `momo_dev_v1.<this workspace>.<43 characters>`"
    );
    assert!(
        is_envelope_of(&tokens.refresh, "momo_devr_v1", w.workspace),
        "the refresh token is `momo_devr_v1.<this workspace>.<43 characters>`"
    );

    // Who the lineage is, as its holder sees it.
    let me = w.whoami(&tokens.access).await;
    expect_status(&me, 200, "whoami with the new access token");
    let me = me.json();
    assert_eq!(me["kind"], "session");
    assert_eq!(me["memberId"], owner.id.to_string());
    assert_eq!(me["workspaceId"], w.workspace.to_string());
    assert_eq!(me["scopes"], json!(READ_ONLY));
    assert_eq!(me["deviceName"], DEVICE);
    assert_eq!(
        w.door(&tokens.access).await,
        200,
        "the access token opens the data door"
    );

    // Who it is, as the person sees it in their own list.
    let session = w.session_of(&tokens.access).await;
    assert_eq!(
        w.session_of(&tokens.refresh).await,
        session,
        "access and refresh are the two halves of one lineage"
    );
    let listed = w
        .send(
            Method::GET,
            &dev_path(w.workspace, "/credentials"),
            &owner.jwt,
            None,
        )
        .await;
    expect_status(&listed, 200, "the person's list");
    let listed = listed.json();
    let item = listed["credentials"]
        .as_array()
        .expect("a list")
        .iter()
        .find(|item| item["id"] == session.to_string())
        .expect("the new lineage is listed under its session id");
    assert_eq!(item["kind"], "session");
    assert_eq!(item["deviceName"], DEVICE);
    assert_eq!(item["scopes"], json!(READ_ONLY));

    // The rows: two, one lineage, the client, the device name, the lifetimes — and only digests.
    let rows = sqlx::query(
        "SELECT dev_form::text AS form, encode(token_hash, 'hex') AS hash, session_id, \
                dev_client::text AS client, dev_device_name::text AS device, \
                EXTRACT(EPOCH FROM (expires_at - created_at))::float8 AS ttl, \
                EXTRACT(EPOCH FROM (dev_lineage_expires_at - created_at))::float8 AS cap \
           FROM token \
          WHERE workspace_id = $1 AND actor_member_id = $2 AND kind::text = 'dev' \
          ORDER BY dev_form::text",
    )
    .bind(w.workspace)
    .bind(owner.id)
    .fetch_all(&w.su)
    .await
    .expect("read the lineage rows");
    assert_eq!(rows.len(), 2, "an access row and a refresh row");
    let expected = [
        ("access", &tokens.access, 900.0),
        ("refresh", &tokens.refresh, 30.0 * 86400.0),
    ];
    for (row, (form, envelope, ttl)) in rows.iter().zip(expected) {
        assert_eq!(row.get::<String, _>("form"), form);
        assert_eq!(row.get::<Uuid, _>("session_id"), session);
        assert_eq!(
            row.get::<Option<String>, _>("client").as_deref(),
            Some(CLIENT_ID),
            "{form}: the lineage belongs to the `oort-cli` client"
        );
        assert_eq!(
            row.get::<Option<String>, _>("device").as_deref(),
            Some(DEVICE),
            "{form}: the device name the connecting side chose"
        );
        assert_eq!(
            row.get::<String, _>("hash"),
            sha256_hex(envelope),
            "{form}: only the SHA-256 of the whole envelope is stored"
        );
        let lifetime: f64 = row.get("ttl");
        assert!(
            (lifetime - ttl).abs() < 10.0,
            "{form}: lives {lifetime} s, expected about {ttl}"
        );
        let cap: f64 = row.get("cap");
        assert!(
            (cap - 90.0 * 86400.0).abs() < 10.0,
            "{form}: the lineage ends 90 days after approval, got {cap} s"
        );
    }
    let raw: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM token \
          WHERE workspace_id = $1 AND encode(token_hash, 'escape') LIKE '%momo_dev%'",
    )
    .bind(w.workspace)
    .fetch_one(&w.su)
    .await
    .expect("scan the token rows");
    assert_eq!(raw, 0, "a raw envelope is stored somewhere");

    // The ledger remembers the lineage its code opened; the audit says a login was issued — and holds
    // no secret.
    let row = w.only_ledger_row().await;
    assert_eq!(row.status, "consumed");
    assert!(row.consumed);
    assert_eq!(row.session_id, Some(session));
    let issued = w.audit("dev_token.login_issued").await;
    assert_eq!(issued.len(), 1, "one `dev_token.login_issued` line");
    assert_eq!(issued[0].detail["scopes"], json!(READ_ONLY));
    let audit_text = w.audit_text().await;
    for secret in [&tokens.access, &tokens.refresh, &granted.code] {
        assert_eq!(
            leaked_piece(&audit_text, secret),
            None,
            "the audit log holds a piece of a secret"
        );
    }
    assert!(
        !audit_text.contains(DEVICE),
        "the audit log holds the device name"
    );

    // `resource` is optional at the token endpoint.
    let pkce = Pkce::fresh();
    let params = Authz::standard(&pkce);
    let second = w.grant_with(&owner, pkce, &params, None).await;
    let reply = w
        .exchange_with(&second.code, &second.pkce.verifier, REDIRECT, None)
        .await;
    expect_status(&reply, 200, "an exchange without `resource`");
}

/// One attempt at the exchange: every field the honest one has, with one of them changed.
struct Attempt {
    what: &'static str,
    code: String,
    verifier: String,
    redirect: String,
    resource: String,
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn every_wrong_exchange_is_the_same_invalid_grant_and_burns_nothing() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let granted = w.grant_all(&owner).await;
    w.keep_code_alive(&granted.code).await;
    let verifier = granted.pkce.verifier.clone();
    let secret = secret_part(&granted.code).to_string();
    let honest = |what: &'static str| Attempt {
        what,
        code: granted.code.clone(),
        verifier: verifier.clone(),
        redirect: REDIRECT.to_string(),
        resource: DEV_RESOURCE.to_string(),
    };
    let attempts = vec![
        Attempt {
            verifier: Pkce::fresh().verifier,
            ..honest("a wrong verifier")
        },
        Attempt {
            verifier: granted.pkce.challenge.clone(),
            ..honest("the challenge presented as the verifier")
        },
        Attempt {
            verifier: "short".to_string(),
            ..honest("a verifier that is too short")
        },
        Attempt {
            verifier: format!("{}+", &verifier[..63]),
            ..honest("a verifier with a character PKCE does not allow")
        },
        Attempt {
            redirect: REDIRECTS[1].to_string(),
            ..honest("another registered loopback port")
        },
        Attempt {
            redirect: "http://127.0.0.1:24686/callback".to_string(),
            ..honest("an unregistered port")
        },
        Attempt {
            redirect: format!("{REDIRECT}/"),
            ..honest("the redirect with a trailing slash")
        },
        Attempt {
            redirect: format!("{REDIRECT}?x=1"),
            ..honest("the redirect with a query")
        },
        Attempt {
            resource: HOSTED_RESOURCE.to_string(),
            ..honest("the hosted resource")
        },
        Attempt {
            resource: format!("{DEV_RESOURCE}/"),
            ..honest("the resource with a trailing slash")
        },
        Attempt {
            code: format!("momo_devc_v1.{}.{secret}", Uuid::new_v4()),
            ..honest("the code under another workspace's name")
        },
        Attempt {
            code: unknown_envelope("momo_devc_v1", w.workspace),
            ..honest("an unknown secret in this workspace")
        },
        Attempt {
            code: format!("momo_oauth_code_v1.{}.{secret}", w.workspace),
            ..honest("the secret relabelled as a hosted code")
        },
        Attempt {
            code: format!("momo_dev_v1.{}.{secret}", w.workspace),
            ..honest("the secret relabelled as an access token")
        },
        Attempt {
            code: format!("momo_devr_v1.{}.{secret}", w.workspace),
            ..honest("the secret relabelled as a refresh token")
        },
        Attempt {
            code: granted.code[..granted.code.len() - 5].to_string(),
            ..honest("a truncated code")
        },
        Attempt {
            code: format!("{} ", granted.code),
            ..honest("the code with a trailing space")
        },
        Attempt {
            code: String::new(),
            ..honest("an empty code")
        },
    ];

    let mut baseline: Option<Fingerprint> = None;
    for attempt in &attempts {
        let reply = w
            .exchange_with(
                &attempt.code,
                &attempt.verifier,
                &attempt.redirect,
                Some(&attempt.resource),
            )
            .await;
        // An empty code is an absent one for a form parser: either refusal is fine for that one case, but
        // it must still burn nothing. Every other attempt is the same `invalid_grant`.
        if attempt.what == "an empty code" {
            assert_eq!(reply.status, 400, "{}: {}", attempt.what, reply.text());
            continue;
        }
        expect_oauth_error(&reply, 400, "invalid_grant", attempt.what);
        assert!(
            reply.no_store(),
            "{}: an error answer is `no-store` too",
            attempt.what
        );
        let print = reply.fingerprint();
        match &baseline {
            None => baseline = Some(print),
            Some(first) => assert_eq!(
                &print, first,
                "{}: told apart from the first refusal by its answer",
                attempt.what
            ),
        }
    }

    // A request that is not a request: the grant type, and the parameters every exchange must carry.
    expect_oauth_error(
        &w.token_form(&[
            ("grant_type", "password"),
            ("client_id", CLIENT_ID),
            ("code", &granted.code),
            ("code_verifier", &verifier),
            ("redirect_uri", REDIRECT),
        ])
        .await,
        400,
        "unsupported_grant_type",
        "grant_type=password",
    );
    for (what, fields) in [
        (
            "no code",
            vec![
                ("grant_type", "authorization_code"),
                ("client_id", CLIENT_ID),
                ("code_verifier", verifier.as_str()),
                ("redirect_uri", REDIRECT),
            ],
        ),
        (
            "no code_verifier",
            vec![
                ("grant_type", "authorization_code"),
                ("client_id", CLIENT_ID),
                ("code", granted.code.as_str()),
                ("redirect_uri", REDIRECT),
            ],
        ),
        (
            "no redirect_uri",
            vec![
                ("grant_type", "authorization_code"),
                ("client_id", CLIENT_ID),
                ("code", granted.code.as_str()),
                ("code_verifier", verifier.as_str()),
            ],
        ),
    ] {
        expect_oauth_error(&w.token_form(&fields).await, 400, "invalid_request", what);
    }
    expect_oauth_error(
        &w.token_form(&[("grant_type", "refresh_token"), ("client_id", CLIENT_ID)])
            .await,
        400,
        "invalid_request",
        "a refresh grant without a refresh token",
    );

    // Nothing above burned the code or opened anything: the row is still waiting, and the honest
    // exchange still works.
    let row = w.only_ledger_row().await;
    assert_eq!(
        row.status, "approved",
        "a refused exchange changed the code's state"
    );
    assert!(!row.consumed);
    assert_eq!(
        w.dev_rows(owner.id).await,
        0,
        "a refused exchange opened something"
    );
    expect_status(
        &w.exchange(&granted).await,
        200,
        "the honest exchange after every refusal",
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn an_expired_code_is_refused_the_clock_decides_and_a_fresh_one_still_works() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let unknown = w
        .exchange_with(
            &unknown_envelope("momo_devc_v1", w.workspace),
            &Pkce::fresh().verifier,
            REDIRECT,
            Some(DEV_RESOURCE),
        )
        .await;

    // Thirty seconds left: still a code. (The clock decides — it is not a blanket refusal.)
    let near = w.grant_all(&owner).await;
    sqlx::query(
        "UPDATE dev_login_authorization SET code_expires_at = now() + interval '30 seconds' \
          WHERE workspace_id = $1 AND code_hash = digest($2::text, 'sha256')",
    )
    .bind(w.workspace)
    .bind(&near.code)
    .execute(&w.su)
    .await
    .expect("move the deadline to thirty seconds from now");
    expect_status(
        &w.exchange(&near).await,
        200,
        "a code with thirty seconds left",
    );

    // One second past its deadline: refused, like any other bad code, and not turned into a login.
    let late = w.grant_all(&owner).await;
    let live_before = w.dev_rows(owner.id).await;
    sqlx::query(
        "UPDATE dev_login_authorization SET code_expires_at = now() - interval '1 second' \
          WHERE workspace_id = $1 AND code_hash = digest($2::text, 'sha256')",
    )
    .bind(w.workspace)
    .bind(&late.code)
    .execute(&w.su)
    .await
    .expect("age the code");
    let refused = w.exchange(&late).await;
    expect_oauth_error(&refused, 400, "invalid_grant", "an expired code");
    assert_eq!(
        refused.fingerprint(),
        unknown.fingerprint(),
        "an expired code answers like a code nobody issued"
    );
    assert_eq!(
        w.dev_rows(owner.id).await,
        live_before,
        "an expired code opened something"
    );
    let stale = w
        .ledger_of(owner.id)
        .await
        .into_iter()
        .filter(|row| !row.consumed)
        .count();
    assert_eq!(stale, 1, "the expired row is still waiting, not consumed");

    // A fresh approval is unaffected.
    let fresh = w.grant_all(&owner).await;
    expect_status(
        &w.exchange(&fresh).await,
        200,
        "a fresh code after an expired one",
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn a_code_works_once_and_presenting_it_again_ends_the_lineage_it_opened() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;
    let others = w.login(&admin).await; // another member's lineage: must not be touched
    let mine = w.login(&owner).await; // the same member's other lineage: must not be touched either
    let granted = w.grant_all(&owner).await;
    let first = Tokens::from_reply(&w.exchange(&granted).await);
    let session = w.session_of(&first.access).await;
    assert_eq!(
        w.door(&first.access).await,
        200,
        "the first exchange's access works"
    );
    let unknown = w
        .exchange_with(
            &unknown_envelope("momo_devc_v1", w.workspace),
            &granted.pkce.verifier,
            REDIRECT,
            Some(DEV_RESOURCE),
        )
        .await;

    // The same code, the same verifier, the same redirect — presented a second time.
    let replay = w.exchange(&granted).await;
    expect_oauth_error(&replay, 400, "invalid_grant", "the replay");
    assert_eq!(
        replay.fingerprint(),
        unknown.fingerprint(),
        "a replay answers like any other bad code"
    );
    assert_eq!(
        w.lineage_rows(session).await,
        (0, 2),
        "both halves of the lineage the first use opened are ended"
    );
    assert_eq!(w.door(&first.access).await, 401, "the access token is dead");
    expect_oauth_error(
        &w.refresh(&first.refresh).await,
        400,
        "invalid_grant",
        "the refresh token of the ended lineage",
    );
    assert_eq!(
        w.audit_count("dev_token.code_replayed").await,
        1,
        "one audit line for the replay"
    );
    assert_eq!(
        w.audit_count(ACTION_REUSE).await,
        0,
        "a code replay is not a refresh reuse"
    );
    let audit_text = w.audit_text().await;
    assert_eq!(
        leaked_piece(&audit_text, &granted.code),
        None,
        "the audit holds the code"
    );

    // The ledger still says what the code did.
    let row = w
        .ledger_of(owner.id)
        .await
        .into_iter()
        .find(|row| row.session_id == Some(session))
        .expect("the replayed code's row");
    assert_eq!(row.status, "consumed");

    // Controls: nothing else was touched — not the member's other lineage, not another member's.
    assert_eq!(
        w.door(&mine.access).await,
        200,
        "the member's other lineage"
    );
    assert_eq!(
        w.door(&others.access).await,
        200,
        "another member's lineage"
    );
    expect_status(
        &w.refresh(&mine.refresh).await,
        200,
        "the other lineage still rotates",
    );
}

/// One member event, one waiting code: the exchange judges the member again (D6: two evaluation points).
async fn the_exchange_judges_the_member_again(event: Event) {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let member = w.person("admin", "박서연").await;
    let granted = w.grant_all(&member).await;
    let control = w.grant_all(&owner).await; // an unrelated waiting code
    w.keep_code_alive(&granted.code).await;
    w.keep_code_alive(&control.code).await;
    w.happen(event, &member, &owner).await;

    let refused = w.exchange(&granted).await;
    expect_oauth_error(
        &refused,
        400,
        "invalid_grant",
        &format!("{event:?}: the exchange"),
    );
    assert_eq!(
        w.dev_rows(member.id).await,
        0,
        "{event:?}: the refused exchange opened a lineage"
    );

    // The code is burned, not merely refused once: put the member back (where that is possible) and
    // present it again.
    match event {
        Event::Demote => w.set_role(member.id, "admin").await,
        Event::Suspend => {
            let reinstated = w
                .send(
                    Method::POST,
                    &format!(
                        "/v1/workspaces/{}/members/{}/reinstate",
                        w.workspace, member.id
                    ),
                    &owner.jwt,
                    None,
                )
                .await;
            expect_status(&reinstated, 200, "reinstating");
        }
        _ => {}
    }
    let again = w.exchange(&granted).await;
    expect_oauth_error(&again, 400, "invalid_grant", &format!("{event:?}: again"));
    assert_eq!(
        w.dev_rows(member.id).await,
        0,
        "{event:?}: the second attempt opened a lineage"
    );

    // The ledger: burned and never consumed. (A removal may take the member's rows with it.)
    for row in w.ledger_of(member.id).await {
        assert!(!row.consumed, "{event:?}: the code was consumed");
        assert!(
            row.session_id.is_none(),
            "{event:?}: the code opened a lineage"
        );
        assert_ne!(
            row.status, "approved",
            "{event:?}: the code is still redeemable"
        );
        if matches!(event, Event::Demote) {
            assert_eq!(row.status, "revoked", "a refused exchange burns the code");
        }
    }

    // Control: nobody else's waiting code was affected.
    expect_status(&w.exchange(&control).await, 200, "the owner's own code");
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn a_demotion_between_consent_and_exchange_refuses_the_exchange_and_burns_the_code() {
    the_exchange_judges_the_member_again(Event::Demote).await;
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn a_suspension_between_consent_and_exchange_refuses_the_exchange_and_reinstating_does_not_revive_the_code(
) {
    the_exchange_judges_the_member_again(Event::Suspend).await;
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn a_removal_between_consent_and_exchange_refuses_the_exchange() {
    the_exchange_judges_the_member_again(Event::Remove).await;
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn the_lineage_limit_is_judged_again_at_the_exchange_and_the_code_is_burned() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    for number in 1..=9 {
        w.lineage_for(owner.id, &format!("이도현의 oort CLI {number}"))
            .await;
    }
    // Nine lineages: the approval goes through (the limit is ten) …
    let granted = w.grant_all(&owner).await;
    // … and by the time the code is exchanged the tenth lineage exists.
    let tenth = w.lineage_for(owner.id, "이도현의 oort CLI 10").await;
    let rows_before = w.dev_rows(owner.id).await;
    assert_eq!(rows_before, 20);

    let refused = w.exchange(&granted).await;
    expect_oauth_error(&refused, 400, "invalid_grant", "an exchange at the limit");
    assert_eq!(
        w.dev_rows(owner.id).await,
        rows_before,
        "an eleventh lineage was opened"
    );
    let row = w.ledger_of(owner.id).await.pop().expect("the code's row");
    assert_eq!(
        row.status, "revoked",
        "a refusal at the exchange burns the code"
    );
    assert!(!row.consumed);

    // Room made, same code: still refused (burned, not parked).
    let ended = w
        .send(
            Method::DELETE,
            &dev_path(w.workspace, &format!("/credentials/{}", tenth.session_id)),
            &owner.jwt,
            None,
        )
        .await;
    expect_status(&ended, 200, "ending one lineage");
    expect_oauth_error(
        &w.exchange(&granted).await,
        400,
        "invalid_grant",
        "the burned code once there is room",
    );
}

/// A password change or an operator reset: it ends what the member holds AND burns what they were about
/// to be handed.
async fn a_password_event_burns_a_waiting_code_and_ends_a_login(event: Event, new_password: &str) {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let holder = w.person("admin", "박서연").await;
    let bystander = w.person("admin", "달무리-운영자").await;
    let lineage = w.login(&holder).await; // a login the holder already has
    let waiting = w.grant_all(&holder).await; // a code waiting for its exchange
    let by_waiting = w.grant_all(&bystander).await;
    w.keep_code_alive(&waiting.code).await;
    w.keep_code_alive(&by_waiting.code).await;
    let by_lineage = w.login(&bystander).await;
    assert_eq!(
        w.door(&lineage.access).await,
        200,
        "control: the holder's login is live"
    );
    let rows_before = w.dev_rows(holder.id).await;
    assert_eq!(rows_before, 2);

    w.happen(event, &holder, &owner).await;

    // The waiting code is burned: refused, nothing opened, and the ledger says so.
    expect_oauth_error(
        &w.exchange(&waiting).await,
        400,
        "invalid_grant",
        &format!("{event:?}: the waiting code"),
    );
    assert_eq!(
        w.dev_rows(holder.id).await,
        rows_before,
        "{event:?}: a lineage was opened after the change"
    );
    let burned: Vec<LedgerRow> = w
        .ledger_of(holder.id)
        .await
        .into_iter()
        .filter(|row| !row.consumed)
        .collect();
    assert_eq!(burned.len(), 1, "{event:?}: the one waiting code");
    assert_eq!(
        burned[0].status, "revoked",
        "{event:?}: the sweep burned the waiting code"
    );

    // The lineage the holder had is over: the door and the refresh both refuse it.
    assert_eq!(
        w.door(&lineage.access).await,
        401,
        "{event:?}: the access token"
    );
    expect_oauth_error(
        &w.refresh(&lineage.refresh).await,
        400,
        "invalid_grant",
        &format!("{event:?}: the refresh token"),
    );
    assert_eq!(
        w.live_dev_rows(holder.id).await,
        0,
        "{event:?}: every developer row is revoked"
    );

    // Controls: it is the holder's sweep alone — the bystander's lineage and waiting code are untouched —
    // and the holder is not shut out: a login with the new password goes through.
    assert_eq!(
        w.door(&by_lineage.access).await,
        200,
        "{event:?}: another member's login"
    );
    expect_status(
        &w.exchange(&by_waiting).await,
        200,
        "another member's waiting code",
    );
    let session = w.new_session(&holder).await;
    let pkce = Pkce::fresh();
    let request = w.start(&Authz::standard(&pkce)).await;
    let approved = w.approve_as(&session, &request, new_password, None).await;
    expect_status(
        &approved,
        200,
        &format!("{event:?}: approving with the new password"),
    );
    let code = query_param(
        approved.json()["redirectTo"].as_str().expect("redirectTo"),
        "code",
    )
    .expect("a code");
    let fresh = w
        .exchange_with(&code, &pkce.verifier, REDIRECT, Some(DEV_RESOURCE))
        .await;
    expect_status(
        &fresh,
        200,
        &format!("{event:?}: a new login after the change"),
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn changing_the_password_burns_a_waiting_code_and_ends_a_login_lineage() {
    a_password_event_burns_a_waiting_code_and_ends_a_login(Event::PasswordChange, CHANGED_PASSWORD)
        .await;
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn an_operator_reset_burns_a_waiting_code_and_ends_a_login_lineage() {
    a_password_event_burns_a_waiting_code_and_ends_a_login(Event::PasswordReset, RESET_PASSWORD)
        .await;
}

/// Wait — on the database's own `pg_stat_activity`, with a deadline and no fixed wait — until some backend
/// is parked on a lock that the backend `holder` holds. A task that ends first never queued; that is the
/// failure this helper exists to show, so it is the first thing every round asks.
async fn wait_until_queued_behind<T>(
    su: &PgPool,
    holder: i32,
    task: &tokio::task::JoinHandle<T>,
    what: &str,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        assert!(
            !task.is_finished(),
            "{what} answered while the lock was held: it did not queue behind it"
        );
        let parked: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity \
              WHERE datname = current_database() AND wait_event_type = 'Lock' \
                AND $1 = ANY(pg_blocking_pids(pid))",
        )
        .bind(holder)
        .fetch_one(su)
        .await
        .expect("read pg_stat_activity");
        if parked > 0 {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "{what} never parked behind the held lock within 10 s"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

/// A password change/reset and a code exchange serialize on the member's sweep lock, which the exchange takes
/// (`lock_dev_login_code_in_tx`) before it locks the ledger row: either the sweep burns the waiting code
/// before the exchange reads it, or the exchange's lineage exists before the sweep looks and the sweep ends
/// it. A lineage cannot slip between the two.
///
/// Here the lock is held on a connection of the test's own — what a sweep in flight holds — while the honest
/// exchange of a waiting code is started. The exchange has to queue behind it: no answer while the lock is
/// held (waited for on `pg_stat_activity`, not on a timer). The sweep then burns the code and commits, and
/// the exchange answers `invalid_grant` having opened nothing. Without the queue the exchange runs straight
/// through the held lock, opens a lineage the sweep never saw, and answers 200 while the lock is still held.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn an_exchange_that_meets_a_sweep_in_flight_queues_behind_it_and_opens_nothing() {
    let _guard = test_lock().await;
    let w = Arc::new(World::boot().await);
    let holder = w.person("admin", "박서연").await;
    let earlier = w.login(&holder).await; // a login the holder already has: the sweep has something to end
    let waiting = w.grant_all(&holder).await; // a code waiting for its exchange
    w.keep_code_alive(&waiting.code).await;
    assert_eq!(
        w.door(&earlier.access).await,
        200,
        "control: the holder's earlier login is live"
    );
    let rows_before = w.dev_rows(holder.id).await;
    assert_eq!(
        rows_before, 2,
        "control: the earlier login is the holder's only developer rows"
    );

    // The sweep in flight: it holds the member's lock and has not committed.
    let (workspace, member) = (w.workspace, holder.id);
    let pool = w.app.clone();
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel::<i32>();
    let (go_tx, go_rx) = tokio::sync::oneshot::channel::<()>();
    let sweep = tokio::spawn(async move {
        with_tenant_tx(&pool, workspace, move |conn| {
            Box::pin(async move {
                lock_member_wide_sweep_in_tx(conn, workspace, member).await?;
                let backend: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                    .fetch_one(&mut *conn)
                    .await?;
                let _ = locked_tx.send(backend);
                let _ = go_rx.await;
                Ok(revoke_member_dev_tokens_in_tx(conn, workspace, member).await?)
            })
        })
        .await
    });
    let sweep_backend = locked_rx.await.expect("the sweep took the member's lock");

    // The exchange arrives meanwhile and has to wait for the lock.
    let exchange = tokio::spawn({
        let w = Arc::clone(&w);
        async move { w.exchange(&waiting).await }
    });
    wait_until_queued_behind(&w.su, sweep_backend, &exchange, "the exchange").await;
    assert!(
        !exchange.is_finished(),
        "the exchange is still waiting for the lock the sweep holds"
    );

    // The sweep finishes: it ends the earlier login, burns the waiting code and commits.
    let _ = go_tx.send(());
    let swept = sweep.await.expect("sweep task").expect("the sweep commits");
    assert_eq!(
        swept, 2,
        "the sweep ends the earlier login: its access and its refresh"
    );
    let reply = exchange.await.expect("exchange task");
    expect_oauth_error(
        &reply,
        400,
        "invalid_grant",
        "the exchange that queued behind the sweep",
    );
    assert_eq!(
        w.dev_rows(holder.id).await,
        rows_before,
        "the exchange opened no lineage"
    );
    assert_eq!(
        w.live_dev_rows(holder.id).await,
        0,
        "every developer row of the holder is ended"
    );
    let waiting_rows: Vec<LedgerRow> = w
        .ledger_of(holder.id)
        .await
        .into_iter()
        .filter(|row| !row.consumed)
        .collect();
    assert_eq!(waiting_rows.len(), 1, "the one code that was waiting");
    assert_eq!(
        waiting_rows[0].status, "revoked",
        "the sweep burned the waiting code and the exchange did not consume it"
    );
    assert_eq!(
        w.door(&earlier.access).await,
        401,
        "the earlier login is over"
    );

    // Control: the holder is not shut out — a login after the sweep goes through.
    let again = w.login(&holder).await;
    assert_eq!(
        w.door(&again.access).await,
        200,
        "a new login after the sweep opens the door"
    );
}

// ===========================================================================
// refresh — `POST /v1/oauth/token`, `grant_type=refresh_token`
// ===========================================================================

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D2 · R10)"]
async fn a_refresh_hands_over_a_fresh_pair_of_the_same_lineage_and_the_new_access_opens_the_door() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let login = w.login_with(&owner, ALL_SCOPES, None, Some(DEVICE)).await;
    let session = w.session_of(&login.access).await;
    let before = w.whoami(&login.access).await.json();

    let reply = w.refresh(&login.refresh).await;
    expect_status(&reply, 200, "a refresh");
    assert!(reply.no_store(), "the refresh answer is `no-store`");
    assert_eq!(reply.header("pragma").as_deref(), Some("no-cache"));
    let body = reply.json();
    assert_eq!(
        keys_of(&body),
        names(&TOKEN_KEYS),
        "the same closed body: {body}"
    );
    assert_eq!(body["token_type"], "Bearer");
    assert_eq!(body["expires_in"], 900);
    assert_eq!(
        body["scope"],
        login.scope.as_str(),
        "the grant is carried over exactly"
    );
    assert_eq!(body["workspace_id"], w.workspace.to_string());
    let next = Tokens::from_reply(&reply);
    assert_ne!(next.access, login.access, "a new access token");
    assert_ne!(next.refresh, login.refresh, "a new refresh token");
    assert!(is_envelope_of(&next.access, "momo_dev_v1", w.workspace));
    assert!(is_envelope_of(&next.refresh, "momo_devr_v1", w.workspace));
    assert_eq!(
        w.session_of(&next.access).await,
        session,
        "the same lineage"
    );

    // Positive control first: the new access token works. Then the old one does not.
    assert_eq!(
        w.door(&next.access).await,
        200,
        "the rotated access token opens the door"
    );
    assert_eq!(
        w.door(&login.access).await,
        401,
        "a rotation ends the old access token"
    );
    let after = w.whoami(&next.access).await.json();
    assert_eq!(after["scopes"], before["scopes"]);
    assert_eq!(
        after["deviceName"], DEVICE,
        "the device name is carried over"
    );
    assert_eq!(
        after["lineageExpiresAtMs"], before["lineageExpiresAtMs"],
        "the 90-day cap is the approval's, never renewed by a rotation"
    );
    assert_eq!(
        w.lineage_rows(session).await,
        (2, 4),
        "two rows ended, and exactly one new access and one new refresh live"
    );
    expect_status(
        &w.refresh(&next.refresh).await,
        200,
        "and the new refresh rotates again",
    );
    assert_eq!(
        w.audit_count(ACTION_REUSE).await,
        0,
        "a normal rotation alerts nothing"
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D2 · R10)"]
async fn an_old_refresh_presented_again_ends_the_whole_lineage_and_raises_one_alert() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;
    let login = w.login(&owner).await;
    let bystander = w.login(&admin).await;
    let session = w.session_of(&login.access).await;
    let next = Tokens::from_reply(&w.refresh(&login.refresh).await);
    assert_eq!(w.door(&next.access).await, 200, "the new pair is live");

    // Somebody presents the refresh that was already spent.
    let reuse = w.refresh(&login.refresh).await;
    expect_oauth_error(&reuse, 400, "invalid_grant", "a spent refresh");
    assert_eq!(
        w.door(&next.access).await,
        401,
        "the lineage's live access ended with the reuse"
    );
    expect_oauth_error(
        &w.refresh(&next.refresh).await,
        400,
        "invalid_grant",
        "the lineage's live refresh",
    );
    assert_eq!(
        w.lineage_rows(session).await,
        (0, 4),
        "every row of the lineage is revoked"
    );
    assert_eq!(
        w.door(&bystander.access).await,
        200,
        "another lineage is untouched"
    );

    // Exactly one alert, about the lineage and its owner, carrying counts and no secret.
    let alerts = w.audit(ACTION_REUSE).await;
    assert_eq!(alerts.len(), 1, "one line");
    let alert = &alerts[0];
    assert_eq!(
        alert.actor, None,
        "the presenter is unknown, so nobody is the actor"
    );
    assert_eq!(
        alert.subject,
        Some(owner.id),
        "the lineage's owner is who it is about"
    );
    assert_eq!(alert.target_type.as_deref(), Some("dev_lineage"));
    assert_eq!(alert.target_id, Some(session));
    assert_eq!(alert.detail["schema"], "momo.dev_token.refresh_reuse.v1");
    assert_eq!(as_count(&alert.detail["revoked_tokens"]), Some(2));
    assert_eq!(
        keys_of(&alert.detail),
        names(&["revoked_tokens", "schema"]),
        "the alert is a closed vocabulary: the lineage, its owner, a count"
    );
    let audit_text = w.audit_text().await;
    for envelope in [&login.access, &login.refresh, &next.access, &next.refresh] {
        assert_eq!(
            leaked_piece(&audit_text, envelope),
            None,
            "the alert row carries no part of an envelope"
        );
    }

    // Presenting spent refreshes again is no new news: nothing is left to revoke.
    for spent in [&login.refresh, &next.refresh] {
        expect_oauth_error(
            &w.refresh(spent).await,
            400,
            "invalid_grant",
            "an ended lineage's refresh",
        );
    }
    assert_eq!(
        w.audit(ACTION_REUSE).await.len(),
        1,
        "re-presenting an already ended lineage's refresh raises no new alert"
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D2 · R10)"]
async fn an_unknown_a_garbled_and_a_spent_refresh_answer_with_the_same_bytes() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let live = w.login(&owner).await;
    let spent = w.login(&owner).await;
    let card = w.card_for(owner.id, "이도현의 카드").await;
    Tokens::from_reply(&w.refresh(&spent.refresh).await); // `spent.refresh` is now a spent refresh
    let relabelled = format!("momo_dev_v1.{}.{}", w.workspace, secret_part(&live.refresh));
    let other_workspace = format!("momo_devr_v1.{}.{}", Uuid::new_v4(), secret43());
    let variants: Vec<(&str, String)> = vec![
        ("garbage", "not-a-token".to_string()),
        (
            "a well-formed refresh nobody holds",
            unknown_envelope("momo_devr_v1", w.workspace),
        ),
        (
            "a refresh of a workspace that is not this one",
            other_workspace,
        ),
        ("an access token in the refresh slot", live.access.clone()),
        ("a card's secret in the refresh slot", card.secret.clone()),
        (
            "the refresh's secret relabelled as an access token",
            relabelled,
        ),
        (
            "a hosted refresh prefix",
            unknown_envelope("momo_oauth_rt_v1", w.workspace),
        ),
        ("the spent refresh", spent.refresh.clone()),
    ];

    let mut baseline: Option<Fingerprint> = None;
    for (what, presented) in &variants {
        let reply = w.refresh(presented).await;
        expect_oauth_error(&reply, 400, "invalid_grant", what);
        assert!(reply.no_store(), "{what}: `no-store`");
        let print = reply.fingerprint();
        match &baseline {
            None => baseline = Some(print),
            Some(first) => assert_eq!(
                &print, first,
                "{what}: told apart from the first refusal by its answer (a reason is an oracle)"
            ),
        }
    }

    // Controls: none of the refusals touched the live lineage, and the spent refresh's alert is the one
    // line it should be.
    assert_eq!(
        w.door(&live.access).await,
        200,
        "a refused refresh ended a live lineage"
    );
    expect_status(
        &w.refresh(&live.refresh).await,
        200,
        "the live lineage still rotates",
    );
    assert_eq!(
        w.whoami(&card.secret).await.status,
        200,
        "the card is untouched"
    );
    assert_eq!(
        w.audit(ACTION_REUSE).await.len(),
        1,
        "only the spent refresh raised an alert"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D2 · R10)"]
async fn two_simultaneous_refreshes_of_one_refresh_let_exactly_one_through() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    for round in 0..5 {
        let login = w.login(&owner).await;
        let session = w.session_of(&login.access).await;
        let gate = Arc::new(tokio::sync::Barrier::new(2));
        let mut racers = Vec::new();
        for _ in 0..2 {
            let http = w.http.clone();
            let gate = gate.clone();
            let url = format!("{}/v1/oauth/token", w.base);
            let refresh = login.refresh.clone();
            racers.push(tokio::spawn(async move {
                gate.wait().await;
                let response = http
                    .post(url)
                    .form(&[
                        ("grant_type", "refresh_token"),
                        ("client_id", CLIENT_ID),
                        ("refresh_token", refresh.as_str()),
                    ])
                    .send()
                    .await
                    .expect("the server answers");
                let status = response.status().as_u16();
                let text = response.text().await.unwrap_or_default();
                (status, text)
            }));
        }
        let mut answers = Vec::new();
        for racer in racers {
            answers.push(racer.await.expect("racer task"));
        }
        let winners: Vec<&(u16, String)> = answers
            .iter()
            .filter(|(status, _)| *status == 200)
            .collect();
        let losers: Vec<&(u16, String)> = answers
            .iter()
            .filter(|(status, _)| *status != 200)
            .collect();
        assert_eq!(
            (winners.len(), losers.len()),
            (1, 1),
            "round {round}: of two refreshes of one refresh exactly one is let through: {answers:?}"
        );
        assert_eq!(
            losers[0].0, 400,
            "round {round}: the other is an invalid_grant"
        );
        assert!(
            losers[0].1.contains("invalid_grant"),
            "round {round}: {}",
            losers[0].1
        );
        // The loser is indistinguishable from a thief holding the spent refresh, so it ends the lineage
        // — the winner's fresh pair included (ADR-0216 D2; the CLI serialises its own refreshes).
        let won: Value = serde_json::from_str(&winners[0].1).expect("the winner's body is JSON");
        let winner_access = won["access_token"].as_str().expect("the winner's access");
        assert_eq!(
            w.door(winner_access).await,
            401,
            "round {round}: the winner's access ended with the lineage"
        );
        assert_eq!(w.lineage_rows(session).await, (0, 4), "round {round}");
    }
    assert_eq!(
        w.audit(ACTION_REUSE).await.len(),
        5,
        "one alert per round, none more"
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D2 · R10)"]
async fn a_refresh_idle_for_thirty_days_is_refused_and_one_idle_for_twenty_nine_is_not() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let recent = w.login(&owner).await;
    let stale = w.login(&owner).await;
    let recent_session = w.session_of(&recent.access).await;
    let stale_session = w.session_of(&stale.access).await;
    w.age_lineage(recent_session, 29 * DAY_SECONDS).await;
    w.age_lineage(stale_session, 31 * DAY_SECONDS).await;

    // Twenty-nine days unused: still a refresh, and the lineage cap is the approval's (61 days left).
    let next = Tokens::from_reply(&w.refresh(&recent.refresh).await);
    let now = w.db_now_ms().await;
    let cap = w.whoami(&next.access).await.json()["lineageExpiresAtMs"]
        .as_i64()
        .expect("lineageExpiresAtMs");
    assert!(
        (cap - (now + 61 * DAY_SECONDS * 1000)).abs() < 120_000,
        "the cap is the approval's — 29 of 90 days spent — not renewed: {cap} vs {}",
        now + 61 * DAY_SECONDS * 1000
    );

    // Thirty-one days unused: refused, plainly (not a reuse alarm), and nothing was ended by asking.
    expect_oauth_error(
        &w.refresh(&stale.refresh).await,
        400,
        "invalid_grant",
        "a refresh unused for 31 days",
    );
    assert_eq!(w.lineage_rows(stale_session).await, (2, 2));
    assert_eq!(w.audit_count(ACTION_REUSE).await, 0);
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D2 · R10)"]
async fn a_refresh_after_the_ninety_day_cap_is_refused_and_one_just_before_it_still_rotates() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;

    // Ten minutes before the cap the lineage still rotates (the idle clock re-armed so that the cap is
    // what is being looked at).
    let before = w.login(&owner).await;
    let before_session = w.session_of(&before.access).await;
    w.age_lineage(before_session, 90 * DAY_SECONDS - 10 * 60)
        .await;
    w.rearm_idle_clock(before_session).await;
    expect_status(
        &w.refresh(&before.refresh).await,
        200,
        "a refresh ten minutes before the cap",
    );

    // A minute after the cap: not idle (its clock was just re-armed), but the lineage is over.
    let after = w.login(&owner).await;
    let after_session = w.session_of(&after.access).await;
    w.age_lineage(after_session, 90 * DAY_SECONDS + 60).await;
    w.rearm_idle_clock(after_session).await;
    expect_oauth_error(
        &w.refresh(&after.refresh).await,
        400,
        "invalid_grant",
        "a refresh a minute after the cap",
    );
    assert_eq!(w.lineage_rows(after_session).await, (2, 2));
    assert_eq!(w.audit_count(ACTION_REUSE).await, 0);
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D2 · R10)"]
async fn an_access_token_cannot_be_refreshed_and_a_refresh_token_cannot_open_the_door() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let login = w.login(&owner).await;
    let granted = w.grant_all(&owner).await;

    // The access token in the refresh slot.
    expect_oauth_error(
        &w.refresh(&login.access).await,
        400,
        "invalid_grant",
        "an access token as a refresh token",
    );
    // The refresh token — and a code — as a bearer on the data door and on whoami.
    for (what, token) in [
        ("a refresh token", login.refresh.as_str()),
        ("an authorization code", granted.code.as_str()),
    ] {
        assert_eq!(w.door(token).await, 401, "{what} on the data door");
        assert_eq!(w.whoami(token).await.status, 401, "{what} on whoami");
    }

    // None of that was a signal or a side effect: the lineage is exactly as it was.
    assert_eq!(w.door(&login.access).await, 200);
    expect_status(
        &w.refresh(&login.refresh).await,
        200,
        "the refresh still rotates",
    );
    expect_status(
        &w.exchange(&granted).await,
        200,
        "the code was not used up by being shown to the door",
    );
    assert_eq!(w.audit_count(ACTION_REUSE).await, 0);
}

// ===========================================================================
// revoke — `POST /v1/oauth/revoke` (RFC 7009)
// ===========================================================================

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn revoking_a_login_token_ends_the_whole_lineage_and_answers_everyone_the_same() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let first = w.login(&owner).await;
    let second = w.login(&owner).await;
    let third = w.login(&owner).await;
    let spared = w.login(&owner).await;
    let card = w.card_for(owner.id, "이도현의 카드").await;
    let first_session = w.session_of(&first.access).await;
    let second_session = w.session_of(&second.access).await;
    let third_session = w.session_of(&third.access).await;

    // What "nothing to do" looks like: an unknown envelope, garbage, and a card's secret (a card is not a
    // login credential and is not this endpoint's to end).
    let nothing = w
        .revoke(&unknown_envelope("momo_dev_v1", w.workspace))
        .await;
    expect_status(&nothing, 200, "an unknown token");
    let baseline = nothing.fingerprint();
    assert_eq!(
        w.revoke("not-a-token").await.fingerprint(),
        baseline,
        "garbage"
    );
    assert_eq!(
        w.revoke(&card.secret).await.fingerprint(),
        baseline,
        "a card's secret"
    );
    assert_eq!(
        w.whoami(&card.secret).await.status,
        200,
        "the card was not revoked through the login endpoint"
    );
    assert_eq!(
        w.audit_count("dev_token.revoked").await,
        0,
        "nothing was ended, so no line was written"
    );

    // An access token ends the whole lineage — and the answer is the same bytes as for nothing at all.
    let by_access = w
        .revoke_as(CLIENT_ID, &first.access, Some("access_token"))
        .await;
    assert_eq!(
        by_access.fingerprint(),
        baseline,
        "a real revocation answers like no revocation (no oracle)"
    );
    assert_eq!(
        w.lineage_rows(first_session).await,
        (0, 2),
        "both halves ended"
    );
    assert_eq!(w.door(&first.access).await, 401);
    expect_oauth_error(
        &w.refresh(&first.refresh).await,
        400,
        "invalid_grant",
        "the refresh of a revoked lineage",
    );
    assert_eq!(
        w.audit_count("dev_token.revoked").await,
        1,
        "one line for the real revocation"
    );

    // Already revoked: the same 200, and no new line.
    assert_eq!(w.revoke(&first.access).await.fingerprint(), baseline);
    assert_eq!(w.revoke(&first.refresh).await.fingerprint(), baseline);
    assert_eq!(
        w.audit_count("dev_token.revoked").await,
        1,
        "an already ended lineage records nothing"
    );

    // A refresh token ends the whole lineage too (with its hint, and without one).
    let by_refresh = w
        .revoke_as(CLIENT_ID, &second.refresh, Some("refresh_token"))
        .await;
    assert_eq!(by_refresh.fingerprint(), baseline);
    assert_eq!(w.lineage_rows(second_session).await, (0, 2));
    assert_eq!(w.door(&second.access).await, 401);
    let no_hint = w.revoke(&third.refresh).await;
    assert_eq!(no_hint.fingerprint(), baseline);
    assert_eq!(w.lineage_rows(third_session).await, (0, 2));
    assert_eq!(w.door(&third.access).await, 401);
    assert_eq!(
        w.audit_count("dev_token.revoked").await,
        3,
        "one line per lineage actually ended"
    );

    // A lineage that belongs to another client is not this client's to end — by either half.
    let foreign = w
        .lineage_with_client(owner.id, "다른 도구의 로그인", "other-tool/1.0")
        .await;
    for half in [&foreign.access, &foreign.refresh] {
        assert_eq!(
            w.revoke(half).await.fingerprint(),
            baseline,
            "a lineage of another client answers like no revocation"
        );
    }
    assert_eq!(
        w.lineage_rows(foreign.session_id).await,
        (2, 2),
        "`oort-cli` ended a lineage that belongs to another client"
    );
    assert_eq!(w.door(&foreign.access).await, 200);
    assert_eq!(
        w.audit_count("dev_token.revoked").await,
        3,
        "and wrote no line for it"
    );

    // Nothing else of the member was touched.
    assert_eq!(
        w.door(&spared.access).await,
        200,
        "another lineage of the member"
    );
    assert_eq!(
        w.whoami(&card.secret).await.status,
        200,
        "the member's card"
    );
    expect_status(
        &w.refresh(&spared.refresh).await,
        200,
        "the spared lineage still rotates",
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn another_client_id_revokes_and_refreshes_nothing() {
    let _guard = test_lock().await;
    // Both arms are open: another client id is routed to the hosted arm, which does not know a dev token.
    let w = World::boot_with(both_arms()).await;
    let owner = w.person("owner", "이도현").await;
    let login = w.login(&owner).await;
    let session = w.session_of(&login.access).await;

    for client in [
        HOSTED_CLIENT_ID,
        "OORT-CLI",
        " oort-cli",
        "oort-cli ",
        "oort-cli/0.1.0",
        "oort",
    ] {
        let _ = w.revoke_as(client, &login.access, None).await;
        let _ = w.revoke_as(client, &login.refresh, None).await;
        let refreshed = w.refresh_as(client, &login.refresh).await;
        assert_ne!(
            refreshed.status, 200,
            "a refresh under client `{client}` rotated a dev lineage"
        );
        assert_eq!(
            w.door(&login.access).await,
            200,
            "a revoke or refresh under client `{client}` ended the access token"
        );
        assert_eq!(
            w.lineage_rows(session).await,
            (2, 2),
            "client `{client}` touched the lineage"
        );
    }
    // The registered hosted client's revoke is RFC 7009's 200 for a token it never issued.
    expect_status(
        &w.revoke_as(HOSTED_CLIENT_ID, &login.access, None).await,
        200,
        "a registered client revoking a token that is not its own",
    );
    // And the lineage is still good for its own client.
    expect_status(
        &w.refresh(&login.refresh).await,
        200,
        "the right client still rotates",
    );
    assert_eq!(w.audit_count("dev_token.revoked").await, 0);
}

// ===========================================================================
// metadata, the closed arm, the hosted flow, tenancy
// ===========================================================================

const ASM_PATH: &str = "/.well-known/oauth-authorization-server";
const HOSTED_PRM_PATH: &str = "/.well-known/oauth-protected-resource/v1/mcp/agent-port";

impl World {
    async fn get_public(&self, base: &str, path: &str) -> Reply {
        to_reply(self.http.get(format!("{base}{path}"))).await
    }

    /// A hosted-arm connection waiting for its OAuth exchange (`pairing_pending`, `auth_mode='oauth'`) on a
    /// paused dedicated agent: the starting point of the hosted flow.
    async fn seed_hosted_connection(&self, owner: Uuid, label: &str) -> Uuid {
        let agent = Uuid::new_v4();
        insert_member(
            &self.su,
            self.workspace,
            agent,
            "agent",
            &format!("{label}-{}", agent.simple()),
        )
        .await;
        sqlx::query(
            "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, config) \
             VALUES($1,$2,'hosted-agent','https://hosted-agent.invalid/disabled',$3, \
                    '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb)",
        )
        .bind(agent)
        .bind(self.workspace)
        .bind(owner)
        .execute(&self.su)
        .await
        .expect("seed the hosted agent row");
        sqlx::query(
            "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
        )
        .bind(self.workspace)
        .bind(agent)
        .execute(&self.su)
        .await
        .expect("seed the hosted agent's membership");
        sqlx::query(
            "INSERT INTO agent_profile(agent_member_id, workspace_id, updated_by, paused) \
             VALUES($1,$2,$3,true)",
        )
        .bind(agent)
        .bind(self.workspace)
        .bind(owner)
        .execute(&self.su)
        .await
        .expect("seed the hosted agent's profile");
        let connection = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO hosted_agent_connection(id,workspace_id,agent_member_id,status,auth_mode,created_by) \
             VALUES($1,$2,$3,'pairing_pending','oauth',$4)",
        )
        .bind(connection)
        .bind(self.workspace)
        .bind(agent)
        .bind(owner)
        .execute(&self.su)
        .await
        .expect("seed the hosted connection");
        connection
    }

    /// `GET /v1/oauth/authorize` of the hosted client (the operator-registered one), `overrides` applied.
    async fn hosted_authorize_at(
        &self,
        base: &str,
        pkce: &Pkce,
        overrides: &[(&str, &str)],
    ) -> Reply {
        let mut params: Vec<(String, String)> = vec![
            ("response_type".into(), "code".into()),
            ("client_id".into(), HOSTED_CLIENT_ID.into()),
            ("redirect_uri".into(), HOSTED_REDIRECT_URI.into()),
            ("scope".into(), "agent:port:connect".into()),
            ("state".into(), "hosted-state".into()),
            ("code_challenge".into(), pkce.challenge.clone()),
            ("code_challenge_method".into(), "S256".into()),
            ("resource".into(), HOSTED_RESOURCE.into()),
        ];
        for (key, value) in overrides {
            params.retain(|(existing, _)| existing != key);
            params.push(((*key).to_string(), (*value).to_string()));
        }
        let query = params
            .iter()
            .map(|(key, value)| format!("{}={}", pct(key), pct(value)))
            .collect::<Vec<_>>()
            .join("&");
        to_reply(self.http.get(format!("{base}/v1/oauth/authorize?{query}"))).await
    }

    async fn hosted_approve_at(
        &self,
        base: &str,
        owner: &Person,
        request: &str,
        connection: Uuid,
    ) -> Reply {
        self.call(
            base,
            Method::POST,
            &format!(
                "/v1/workspaces/{}/oauth/authorization-requests/approve",
                self.workspace
            ),
            Some(&owner.jwt),
            Some(json!({
                "request": request,
                "connectionId": connection,
                "approvedScopes": ["agent:port:connect"],
                "approvedChannelIds": [],
            })),
        )
        .await
    }

    /// The hosted client's whole flow against `base`: authorize → approve (the owner) → exchange. Returns
    /// the token body.
    async fn hosted_flow(&self, base: &str, owner: &Person, connection: Uuid) -> Value {
        let pkce = Pkce::fresh();
        let reply = self.hosted_authorize_at(base, &pkce, &[]).await;
        expect_status(&reply, 302, "hosted authorize");
        let location = reply.location().expect("a consent redirect");
        assert!(
            location.starts_with(&format!("{HOSTED_CONSENT_URL}?request=")),
            "the hosted client goes to the HOSTED consent screen: {location}"
        );
        let decided = self
            .hosted_approve_at(base, owner, &request_envelope(&location), connection)
            .await;
        expect_status(&decided, 200, "hosted approve");
        let code = query_param(
            decided.json()["redirectTo"].as_str().expect("redirectTo"),
            "code",
        )
        .expect("a hosted code");
        let issued = self
            .form(
                base,
                "/v1/oauth/token",
                &[
                    ("grant_type", "authorization_code"),
                    ("client_id", HOSTED_CLIENT_ID),
                    ("code", &code),
                    ("code_verifier", &pkce.verifier),
                    ("redirect_uri", HOSTED_REDIRECT_URI),
                    ("resource", HOSTED_RESOURCE),
                ],
            )
            .await;
        expect_status(&issued, 200, "hosted exchange");
        issued.json()
    }
}

fn scopes_supported(document: &Value) -> BTreeSet<String> {
    document["scopes_supported"]
        .as_array()
        .expect("`scopes_supported` is a list")
        .iter()
        .map(|scope| scope.as_str().expect("a scope").to_string())
        .collect()
}

/// The metadata document without the one field the arms legitimately change.
fn without_scopes(document: &Value) -> Value {
    let mut copy = document.clone();
    copy.as_object_mut()
        .expect("the document is an object")
        .remove("scopes_supported");
    copy
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn the_server_metadata_follows_the_arms_that_are_open() {
    let _guard = test_lock().await;
    let dev = World::boot().await; // the human-subject arm only
    let hosted = dev.another_server(hosted_only()).await;
    let both = dev.another_server(both_arms()).await;
    let closed = dev.another_server(AgentPortOauthConfig::default()).await;

    // Dev only: the document is served, names the configured issuer and exactly the dev vocabulary.
    let reply = dev.get_public(&dev.base, ASM_PATH).await;
    expect_status(&reply, 200, "metadata of a dev-only server");
    let document = reply.json();
    assert_eq!(document["issuer"], ISSUER);
    assert_eq!(
        document["authorization_endpoint"],
        format!("{ISSUER}/v1/oauth/authorize")
    );
    assert_eq!(
        document["token_endpoint"],
        format!("{ISSUER}/v1/oauth/token")
    );
    assert_eq!(
        document["revocation_endpoint"],
        format!("{ISSUER}/v1/oauth/revoke")
    );
    assert_eq!(
        scopes_supported(&document),
        names(&SCOPE_ORDER),
        "exactly the five dev scopes — a dev-only server advertises no hosted scope"
    );
    assert_eq!(
        document["code_challenge_methods_supported"],
        json!(["S256"])
    );
    assert_eq!(
        document["grant_types_supported"],
        json!(["authorization_code", "refresh_token"])
    );
    assert_eq!(
        document["token_endpoint_auth_methods_supported"],
        json!(["none"])
    );
    assert_eq!(
        document["authorization_response_iss_parameter_supported"],
        true
    );
    assert!(
        document.get("registration_endpoint").is_none(),
        "no dynamic client registration is advertised"
    );
    // Headers a caller or a proxy controls do not move the issuer.
    let spoofed = to_reply(
        dev.http
            .get(format!("{}{ASM_PATH}", dev.base))
            .header("host", "evil.example")
            .header("x-forwarded-host", "evil.example")
            .header("x-forwarded-proto", "http"),
    )
    .await;
    assert_eq!(spoofed.json()["issuer"], ISSUER);
    // A dev-only server must not advertise the hosted protected resource (the hosted arm is closed).
    let prm = dev.get_public(&dev.base, HOSTED_PRM_PATH).await;
    assert_eq!(
        prm.status, 404,
        "the hosted PRM leaked out of a dev-only server"
    );
    assert!(prm.body.is_empty(), "and it is not a document");

    // Hosted only: no dev scope is advertised.
    let reply = dev.get_public(&hosted, ASM_PATH).await;
    expect_status(&reply, 200, "metadata of a hosted-only server");
    let hosted_document = reply.json();
    assert!(
        scopes_supported(&hosted_document)
            .iter()
            .all(|scope| !scope.starts_with("dev:")),
        "a hosted-only server advertises a dev scope"
    );
    assert!(scopes_supported(&hosted_document).contains("agent:port:connect"));
    let hosted_prm = dev.get_public(&hosted, HOSTED_PRM_PATH).await;
    expect_status(&hosted_prm, 200, "the hosted PRM of a hosted-only server");

    // Both: the union of the two vocabularies; the rest of the document is the hosted one, and the hosted
    // PRM is byte for byte the hosted-only server's.
    let reply = dev.get_public(&both, ASM_PATH).await;
    expect_status(&reply, 200, "metadata of a both-arms server");
    let both_document = reply.json();
    let union = scopes_supported(&both_document);
    assert!(
        names(&SCOPE_ORDER).is_subset(&union),
        "the union holds every dev scope: {union:?}"
    );
    assert!(
        scopes_supported(&hosted_document).is_subset(&union),
        "the union holds every hosted scope: {union:?}"
    );
    assert_eq!(
        without_scopes(&both_document),
        without_scopes(&hosted_document),
        "opening the dev arm changed more of the metadata than the vocabulary"
    );
    let both_prm = dev.get_public(&both, HOSTED_PRM_PATH).await;
    assert_eq!(
        both_prm.fingerprint(),
        hosted_prm.fingerprint(),
        "the hosted PRM changed when the dev arm was opened"
    );

    // Neither arm: not served, and not a document.
    for path in [ASM_PATH, HOSTED_PRM_PATH] {
        let reply = dev.get_public(&closed, path).await;
        assert_eq!(
            reply.status, 404,
            "{path} on a server with both arms closed"
        );
        assert!(reply.body.is_empty(), "{path} is not a document");
    }
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn with_the_dev_arm_closed_oort_cli_is_an_unknown_client_byte_for_byte_and_a_real_dev_token_redeems_nothing(
) {
    let _guard = test_lock().await;
    let w = World::boot().await; // the open one: the dev arm only
    let owner = w.person("owner", "이도현").await;
    let closed = w.another_server(AgentPortOauthConfig::default()).await;
    let hosted = w.another_server(hosted_only()).await;
    let pkce = Pkce::fresh();

    // Control: the open server takes the very request the closed ones will be given.
    let open = w.authorize(&Authz::standard(&pkce)).await;
    expect_status(&open, 302, "the dev arm open");

    // A real lineage and a real waiting code, made on the open server.
    let login = w.login(&owner).await;
    let session = w.session_of(&login.access).await;
    let waiting = w.grant_all(&owner).await;

    w.keep_code_alive(&waiting.code).await;
    for (arm, base) in [("both arms closed", &closed), ("hosted arm only", &hosted)] {
        let cli = w.authorize_at(base, &Authz::standard(&pkce)).await;
        let unknown = w
            .authorize_at(
                base,
                &Authz::standard(&pkce).set("client_id", "not-registered"),
            )
            .await;
        assert_eq!(
            cli.fingerprint(),
            unknown.fingerprint(),
            "{arm}: authorize for `oort-cli` is told apart from an unknown client"
        );
        assert!(
            cli.location().is_none() && cli.status != 302,
            "{arm}: the dev arm answered while closed"
        );

        let code_form = |client: &'static str| {
            vec![
                ("grant_type", "authorization_code"),
                ("client_id", client),
                ("code", waiting.code.as_str()),
                ("code_verifier", waiting.pkce.verifier.as_str()),
                ("redirect_uri", REDIRECT),
                ("resource", DEV_RESOURCE),
            ]
        };
        let real_code = w.form(base, "/v1/oauth/token", &code_form(CLIENT_ID)).await;
        let unknown_code = w
            .form(base, "/v1/oauth/token", &code_form("not-registered"))
            .await;
        assert_eq!(
            real_code.fingerprint(),
            unknown_code.fingerprint(),
            "{arm}: a real waiting code under `oort-cli` is told apart from an unknown client"
        );
        assert_ne!(real_code.status, 200, "{arm}: a closed arm redeemed a code");

        let refresh_form = |client: &'static str| {
            vec![
                ("grant_type", "refresh_token"),
                ("client_id", client),
                ("refresh_token", login.refresh.as_str()),
            ]
        };
        let real_refresh = w
            .form(base, "/v1/oauth/token", &refresh_form(CLIENT_ID))
            .await;
        let unknown_refresh = w
            .form(base, "/v1/oauth/token", &refresh_form("not-registered"))
            .await;
        assert_eq!(
            real_refresh.fingerprint(),
            unknown_refresh.fingerprint(),
            "{arm}: a real refresh under `oort-cli` is told apart from an unknown client"
        );
        assert_ne!(
            real_refresh.status, 200,
            "{arm}: a closed arm rotated a refresh"
        );

        let revoke_form =
            |client: &'static str| vec![("token", login.access.as_str()), ("client_id", client)];
        let real_revoke = w
            .form(base, "/v1/oauth/revoke", &revoke_form(CLIENT_ID))
            .await;
        let unknown_revoke = w
            .form(base, "/v1/oauth/revoke", &revoke_form("not-registered"))
            .await;
        assert_eq!(
            real_revoke.fingerprint(),
            unknown_revoke.fingerprint(),
            "{arm}: a real revoke under `oort-cli` is told apart from an unknown client"
        );
    }

    // With both arms closed there is no authorization server at all: 404, and not a document.
    let absent = w.authorize_at(&closed, &Authz::standard(&pkce)).await;
    assert_eq!(absent.status, 404);
    assert!(absent.body.is_empty());

    // Nothing was consumed, ended or rotated by asking the closed servers: the open one still honours all
    // three — the flag, not the data, is what said no.
    assert_eq!(
        w.door(&login.access).await,
        200,
        "a closed arm's revoke ended the lineage"
    );
    assert_eq!(w.lineage_rows(session).await, (2, 2));
    expect_status(
        &w.exchange(&waiting).await,
        200,
        "the waiting code, on the open server",
    );
    expect_status(
        &w.refresh(&login.refresh).await,
        200,
        "the refresh, on the open server",
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn opening_the_dev_arm_leaves_the_hosted_flow_and_its_answers_as_they_were() {
    let _guard = test_lock().await;
    let w = World::boot_with(both_arms()).await; // both arms open
    let hosted = w.another_server(hosted_only()).await; // the reference: the hosted arm alone
    let owner = w.person("owner", "이도현").await;
    let on_hosted = w.seed_hosted_connection(owner.id, "hostedone").await;
    let on_both = w.seed_hosted_connection(owner.id, "hostedtwo").await;
    let spare = w.seed_hosted_connection(owner.id, "hostedthree").await;

    // The hosted client's whole flow on each server: the same shape of answer (the secrets differ).
    let from_hosted = w.hosted_flow(&hosted, &owner, on_hosted).await;
    let from_both = w.hosted_flow(&w.base, &owner, on_both).await;
    assert_eq!(
        keys_of(&from_both),
        keys_of(&from_hosted),
        "the hosted token body changed shape"
    );
    for (what, body) in [("hosted only", &from_hosted), ("both arms", &from_both)] {
        assert_eq!(body["token_type"], "Bearer", "{what}");
        assert_eq!(
            body["expires_in"], 1800,
            "{what}: the hosted access lives thirty minutes"
        );
        assert_eq!(body["scope"], "agent:port:connect", "{what}");
        assert!(
            body["access_token"]
                .as_str()
                .is_some_and(|token| token.starts_with("momo_oauth_at_v1.")),
            "{what}: a hosted access token"
        );
        assert!(
            body["refresh_token"]
                .as_str()
                .is_some_and(|token| token.starts_with("momo_oauth_rt_v1.")),
            "{what}: a hosted refresh token"
        );
    }

    // Deterministic hosted answers are byte for byte the same with and without the dev arm.
    let pkce = Pkce::fresh();
    let fixed_state = "state-that-comes-back";
    let probes: Vec<(&str, Vec<u16>, Reply, Reply)> = vec![
        (
            "the hosted PRM",
            vec![200],
            w.get_public(&hosted, HOSTED_PRM_PATH).await,
            w.get_public(&w.base, HOSTED_PRM_PATH).await,
        ),
        (
            "authorize with plain PKCE",
            vec![302],
            w.hosted_authorize_at(
                &hosted,
                &pkce,
                &[("code_challenge_method", "plain"), ("state", fixed_state)],
            )
            .await,
            w.hosted_authorize_at(
                &w.base,
                &pkce,
                &[("code_challenge_method", "plain"), ("state", fixed_state)],
            )
            .await,
        ),
        (
            "authorize with a scope the hosted arm does not know",
            vec![302],
            w.hosted_authorize_at(
                &hosted,
                &pkce,
                &[("scope", "dev:identity"), ("state", fixed_state)],
            )
            .await,
            w.hosted_authorize_at(
                &w.base,
                &pkce,
                &[("scope", "dev:identity"), ("state", fixed_state)],
            )
            .await,
        ),
        (
            "authorize with an unregistered redirect",
            vec![400],
            w.hosted_authorize_at(
                &hosted,
                &pkce,
                &[("redirect_uri", "https://evil.example/cb")],
            )
            .await,
            w.hosted_authorize_at(
                &w.base,
                &pkce,
                &[("redirect_uri", "https://evil.example/cb")],
            )
            .await,
        ),
        (
            "authorize for a client nobody registered",
            vec![400],
            w.hosted_authorize_at(&hosted, &pkce, &[("client_id", "not-registered")])
                .await,
            w.hosted_authorize_at(&w.base, &pkce, &[("client_id", "not-registered")])
                .await,
        ),
        (
            "a token request of an unregistered client",
            vec![400, 401],
            w.form(
                &hosted,
                "/v1/oauth/token",
                &[
                    ("grant_type", "authorization_code"),
                    ("client_id", "not-registered"),
                ],
            )
            .await,
            w.form(
                &w.base,
                "/v1/oauth/token",
                &[
                    ("grant_type", "authorization_code"),
                    ("client_id", "not-registered"),
                ],
            )
            .await,
        ),
        (
            "a hosted code nobody issued",
            vec![400, 401],
            w.form(
                &hosted,
                "/v1/oauth/token",
                &[
                    ("grant_type", "authorization_code"),
                    ("client_id", HOSTED_CLIENT_ID),
                    ("code", &unknown_envelope("momo_oauth_code_v1", w.workspace)),
                    ("code_verifier", &pkce.verifier),
                    ("redirect_uri", HOSTED_REDIRECT_URI),
                    ("resource", HOSTED_RESOURCE),
                ],
            )
            .await,
            w.form(
                &w.base,
                "/v1/oauth/token",
                &[
                    ("grant_type", "authorization_code"),
                    ("client_id", HOSTED_CLIENT_ID),
                    ("code", &unknown_envelope("momo_oauth_code_v1", w.workspace)),
                    ("code_verifier", &pkce.verifier),
                    ("redirect_uri", HOSTED_REDIRECT_URI),
                    ("resource", HOSTED_RESOURCE),
                ],
            )
            .await,
        ),
        (
            "a hosted revoke of a token nobody holds",
            vec![200],
            w.form(
                &hosted,
                "/v1/oauth/revoke",
                &[("token", "not-a-token"), ("client_id", HOSTED_CLIENT_ID)],
            )
            .await,
            w.form(
                &w.base,
                "/v1/oauth/revoke",
                &[("token", "not-a-token"), ("client_id", HOSTED_CLIENT_ID)],
            )
            .await,
        ),
    ];
    for (what, expected, reference, with_dev) in &probes {
        assert!(
            expected.contains(&reference.status),
            "{what}: the reference (hosted arm alone) answered {}, expected one of {expected:?}",
            reference.status
        );
        assert_eq!(
            with_dev.fingerprint(),
            reference.fingerprint(),
            "{what}: the answer changed when the dev arm was opened"
        );
    }

    // A hosted envelope is not a dev one and a dev envelope is not a hosted one — on a server that has
    // both, each one's own approval still works.
    let hosted_request = {
        let reply = w.hosted_authorize_at(&w.base, &pkce, &[]).await;
        expect_status(&reply, 302, "a hosted request on the both-arms server");
        request_envelope(&reply.location().expect("a consent redirect"))
    };
    let dev_request = w.start(&Authz::standard(&Pkce::fresh())).await;
    let hosted_rows_before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_oauth_authorization_request WHERE workspace_id = $1",
    )
    .bind(w.workspace)
    .fetch_one(&w.su)
    .await
    .expect("count hosted decisions");
    expect_code(
        &w.approve(&owner, &hosted_request).await,
        404,
        "dev_login_request_not_found",
        "a hosted request at the dev approve",
    );
    expect_code(
        &w.preview(&owner.jwt, &hosted_request).await,
        404,
        "dev_login_request_not_found",
        "a hosted request at the dev preview",
    );
    expect_status(
        &w.hosted_approve_at(&w.base, &owner, &dev_request, spare)
            .await,
        404,
        "a dev request at the hosted approve",
    );
    assert_eq!(
        w.ledger_count().await,
        0,
        "a hosted request reached the dev ledger"
    );
    let hosted_rows_after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_oauth_authorization_request WHERE workspace_id = $1",
    )
    .bind(w.workspace)
    .fetch_one(&w.su)
    .await
    .expect("count hosted decisions");
    assert_eq!(
        hosted_rows_after, hosted_rows_before,
        "a dev request reached the hosted ledger"
    );

    // And the two arms run side by side on one server: each flow still completes.
    let login = w.login(&owner).await;
    assert_eq!(
        w.door(&login.access).await,
        200,
        "the dev flow on the both-arms server"
    );
    let again = w.hosted_flow(&w.base, &owner, spare).await;
    assert_eq!(
        again["token_type"], "Bearer",
        "the hosted flow on the both-arms server"
    );
}

/// A connection of the application role with the tenant bound as the server binds it.
async fn set_tenant(pool: &PgPool, workspace: Uuid) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    let mut conn = pool.acquire().await.expect("acquire a momo_app connection");
    sqlx::query("SELECT set_config('app.workspace_id', $1::text, false)")
        .bind(workspace)
        .execute(&mut *conn)
        .await
        .expect("bind the tenant GUC");
    conn
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D6 나)"]
async fn the_ledger_is_row_level_secured_and_invisible_from_another_workspace() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    w.login(&owner).await; // one row in this workspace
    let other = seed_workspace(&w.su).await;

    let (enabled, forced): (bool, bool) = sqlx::query_as(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class \
          WHERE relname = 'dev_login_authorization'",
    )
    .fetch_one(&w.su)
    .await
    .expect("read the table's RLS flags");
    assert!(
        enabled && forced,
        "the table is ENABLE + FORCE ROW LEVEL SECURITY"
    );
    let bypass: bool =
        sqlx::query_scalar("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'momo_app'")
            .fetch_one(&w.su)
            .await
            .expect("read the application role");
    assert!(!bypass, "the application role must not bypass RLS");

    let app = momo_app_pool().await;
    let own: i64 = sqlx::query_scalar("SELECT count(*) FROM dev_login_authorization")
        .fetch_one(&mut *set_tenant(&app, w.workspace).await)
        .await
        .expect("read the own tenant's rows");
    assert_eq!(
        own, 1,
        "control: the application role sees its own tenant's row"
    );
    let foreign: i64 = sqlx::query_scalar("SELECT count(*) FROM dev_login_authorization")
        .fetch_one(&mut *set_tenant(&app, other).await)
        .await
        .expect("read as another tenant");
    assert_eq!(foreign, 0, "another workspace sees the row");
    let unbound = momo_app_pool().await; // a fresh pool: no tenant was ever bound on its connections
    let nobody: i64 = sqlx::query_scalar("SELECT count(*) FROM dev_login_authorization")
        .fetch_one(&unbound)
        .await
        .expect("read without a tenant");
    assert_eq!(nobody, 0, "a connection with no tenant sees the row");

    // A write for another workspace is refused by the policy itself; the same write for the bound one
    // goes in (so it is the policy that said no).
    let insert = "INSERT INTO dev_login_authorization \
                    (workspace_id, member_id, request_nonce, client_id, redirect_uri, resource, \
                     requested_scopes, approved_scopes, code_challenge, code_challenge_method, status) \
                  VALUES ($1, $2, $3, 'oort-cli', $4, $5, ARRAY['dev:identity']::text[], '{}', $6, \
                          'S256', 'denied')";
    let challenge = Pkce::fresh().challenge;
    let refused = sqlx::query(insert)
        .bind(w.workspace)
        .bind(owner.id)
        .bind(Uuid::new_v4())
        .bind(REDIRECT)
        .bind(DEV_RESOURCE)
        .bind(&challenge)
        .execute(&mut *set_tenant(&app, other).await)
        .await;
    match refused {
        Err(sqlx::Error::Database(error)) => assert_eq!(
            error.code().as_deref(),
            Some("42501"),
            "a row-level security violation, got {error}"
        ),
        other => panic!("a write across tenants must be refused by the policy, got {other:?}"),
    }
    sqlx::query(insert)
        .bind(w.workspace)
        .bind(owner.id)
        .bind(Uuid::new_v4())
        .bind(REDIRECT)
        .bind(DEV_RESOURCE)
        .bind(&challenge)
        .execute(&mut *set_tenant(&app, w.workspace).await)
        .await
        .expect("control: the same write inside the bound tenant");
    assert_eq!(w.ledger_count().await, 2);
}
