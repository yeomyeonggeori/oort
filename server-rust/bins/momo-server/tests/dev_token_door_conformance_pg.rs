//! ADR-0216 (#4660) — the developer-token **door**, proved over the real router.
//!
//! Rows covered: R1(a), R2(i)(ii)(iii), R3(a)(b)(c)(d), R4 and both approval-decision routes
//! (the first layer: the closed table; the second: `decide()` itself). Every claim about a
//! refusal is paired with a **positive control** in the same test — a request that must get
//! through, from the same token over the same wiring — so "refused" cannot be an artifact of a
//! dead token, a dead route or a mistyped path.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `the_closed_table_is_exactly_the_eight_pairs_the_adr_names` | R3(a): `DEV_ROUTE_TABLE` is ADR D4's L1–L8, each with its scope | a row is added, dropped or rescoped |
//! | `a_pair_off_the_table_has_no_scope_whatever_the_spelling` | R3(a): every other method of a table template (HEAD, OPTIONS, lower case), every near-miss spelling and the routes D4 puts out of reach (both decisions, credentials, edits) have no scope | the default branch allows, the key becomes a raw path shape, or an out-of-reach route enters the table |
//! | `the_doors_verdict_needs_a_matched_template_and_the_envelopes_own_workspace` | R3(a): `dev_route_scope` refuses a missing template and another workspace | the door guesses without a template or stops comparing `{ws}` |
//! | `the_router_debug_still_lists_every_route_the_sweep_depends_on` | the parse of `Router`'s Debug output behind the sweeps still sees the routes (and their methods) it must | axum reshapes that output (the sweeps would otherwise visit nothing) |
//! | `every_mounted_pair_off_the_table_is_refused_by_the_door_before_the_database` | R3(b): every non-public mounted template × seven methods, except the table's pairs, gets the door's own 403 (same bytes; HEAD the same length) before any handler or lookup; the table's pairs pass the door; the public list is exact | a route is open to a developer token, a table pair is refused, or a public route moves behind or out of the door |
//! | `the_sweep_flags_a_route_that_is_open_to_a_developer_token` | the sweep's detector: one extra route outside the door is reported, and only it | the sweep accepts every answer or visits nothing |
//! | `a_request_the_router_has_not_matched_is_refused_not_guessed_at` | R3(c): with the matched template stripped, an on-table path is refused (fail closed); the control passes with it | the door admits by the raw path when it has no template |
//! | `decide_refuses_a_developer_credential_on_the_approval_decision_route` / `…_run_decision_route` | decide(), layer two, each route alone: a person carrying the developer marker gets the 403 receipt `dev_cannot_decide`; the same person without it reaches the database (500 here); a non-person gets another 403 receipt | `decide()` stops reading the marker, or either route stops passing it |
//! | `the_table_closes_the_approval_decision_route_to_a_developer_token` / `…_run_decision_route_…` | decide(), layer one, each route alone, on the real router and before any lookup | a decision route enters the table |
//! | `every_scope_the_server_already_knows_stays_out_of_the_dev_namespace` | R4: `DEV_SCOPES` is the ADR's five names; no scope the server names in code (constants, tool catalog, agent route table) equals one or squats `dev:` | a dev scope is renamed to an existing one, or an existing scope takes `dev:` |
//! | `the_contract_files_and_the_mounted_router_differ_only_by_the_drift_listed_here` | R3(b): `openapi.yaml` ∪ `openapi.operator.yaml` ∪ the allow-list against the mounted routes, both directions, exact | a route is mounted without a contract entry, a contract entry loses its route, or a listed drift line goes stale |
//! | `a_token_is_stored_as_the_hash_of_its_whole_envelope` | R2(i): `token_hash` = SHA-256 of the whole envelope (computed with `sha2`), not of the secret alone; the same secret under another prefix matches no row and is refused | the hash input loses the prefix |
//! | `the_data_door_takes_card_and_access_only_and_the_refresh_door_takes_refresh_only` | R2(ii): at the server and, calling the domain functions directly, in the SQL | the `dev_form` filter of the lookup or of the rotation is dropped |
//! | `every_way_a_developer_token_can_fail_to_identify_is_the_same_401` | R2(iii): expired, revoked, unknown, another workspace's, malformed ×6 and a refresh envelope are byte-for-byte the unknown-string 401 | any one of them answers differently |
//! | `a_developer_token_is_not_an_agent_port_credential` | R1(a): a card, an access, a refresh and a relabelled secret get an unknown string's answer at the Agent Port; the control agent bearer is admitted | the Agent Port takes a developer envelope |
//! | `a_live_token_is_refused_on_every_pair_off_the_table_and_the_database_is_unchanged` | R3(b) with a live all-scope owner token: the sweep, the database unchanged, the token untouched; then L1–L7 with real data | a refusal reaches a handler, or a table pair stops working |
//! | `a_variant_of_a_table_path_never_reaches_a_handler_the_table_did_not_open` | R3(c): a static sibling of `{ch}` behind the real door, hit by every method and spelling, runs no handler; `%61rchived` and friends reach only the table row's | the key is the raw path's shape instead of the matched template |
//! | `a_developer_token_cannot_issue_list_or_revoke_developer_tokens` | R3(d): the credential routes and the policy route are refused, nothing changes, a session is admitted on them | a credential route enters the table |
//! | `a_live_developer_token_is_refused_on_the_approval_decision_route` / `…_run_decision_route` | decide(), layer one, with a live token: refused before the lookup, no decision recorded, a person is not refused | a decision route enters the table |
//! | `the_database_keeps_dev_scopes_on_dev_rows_and_dev_columns_off_every_other_row` | R4 in the database: the named CHECK (23514) refuses each violation; the CHECKs agree with `DEV_SCOPES` and with every existing scope | a CHECK is dropped or loosened |
//!
//! The tests that need no database run in a plain `cargo test` (they use a lazily-connected
//! pool that never dials, so anything that reaches the database answers 500 — which is how a
//! control proves a refusal was decided *before* it). The rest are `#[ignore]` and need a real
//! PostgreSQL 18 + pgvector (superuser URL), isolated, serial:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test dev_token_door_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! The sweeps take their universe from the mounted router itself (parsed out of `Router`'s Debug
//! output, which the first test above holds), not from the contract files: the ADR's union of
//! `openapi.yaml` and the allow-list does not cover every mounted route today, and the router is a
//! superset of its mounted part. The contract test pins that disagreement instead of hiding it.

#[path = "common/apps_pg.rs"]
mod apps_pg;

use std::collections::{BTreeMap, BTreeSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use apps_pg::*;
use axum::extract::Request;
use axum::middleware::Next;
use axum::routing::{get, post};
use axum::Router;
use momo_auth::dev_token::{
    issue_dev_card_in_tx, issue_dev_login_in_tx, required_dev_scope, resolve_dev_token_in_tx,
    rotate_dev_refresh_in_tx, DevForm, DevResolution, DevRotation, DevTool, IssuedDevCard,
    IssuedDevLogin, NewDevCard, NewDevLogin, DEV_READ_ONLY_SCOPES, DEV_REFRESH_PREFIX,
    DEV_ROUTE_TABLE, DEV_SCOPES, DEV_SCOPE_SEARCH_RESERVED, DEV_TOKEN_PREFIX, FIXED_POLICY,
};
use momo_auth::{Principal, PrincipalKind, AGENT_BEARER_PREFIX};
use momo_db::sqlx;
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_server::dev_access::{dev_route_scope, rotate_dev_refresh};
use momo_server::dev_credential::DevCredential;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// the oracles — written here, independently of the code under test
// ---------------------------------------------------------------------------

/// ADR-0216 D4's closed table, L1–L8, as the ADR states it. The tests compare the code's
/// `DEV_ROUTE_TABLE` to THIS list, and classify every pair of the sweeps by THIS list — never
/// by asking `required_dev_scope` — so a pair added to (or dropped from) the table is a red
/// test, not a moved expectation.
const TABLE: [(&str, &str, &str); 8] = [
    ("GET", "/v1/workspaces/{ws}/dev-access/self", "dev:identity"),
    (
        "DELETE",
        "/v1/workspaces/{ws}/dev-access/self",
        "dev:identity",
    ),
    ("GET", "/v1/workspaces/{ws}/channels", "dev:channels:read"),
    (
        "GET",
        "/v1/workspaces/{ws}/channels/{ch}/messages",
        "dev:messages:read",
    ),
    (
        "GET",
        "/v1/workspaces/{ws}/channels/{ch}/messages/{root}/replies",
        "dev:messages:read",
    ),
    (
        "POST",
        "/v1/workspaces/{ws}/channels/{ch}/messages",
        "dev:messages:write",
    ),
    ("GET", "/v1/workspaces/{ws}/inbox", "dev:inbox:read"),
    ("POST", "/v1/mcp/me", "dev:identity"),
];

/// L8 is on the table but its route belongs to #4661 (`/v1/mcp/me`): until that lands there is
/// no such route to sweep. The exception is conditional on the router, not a skip: the moment the
/// route is mounted it is swept like the others.
const L8_TEMPLATE: &str = "/v1/mcp/me";

/// The two approval-decision routes (ADR-0216 D4: 승인 카드의 결정 — a developer token never
/// decides). Spelled out by hand so a typo here is caught by the "is it mounted?" assertions.
const DECISION_BY_APPROVAL: &str = "/v1/workspaces/{ws}/approvals/{approval}/decision";
const DECISION_BY_RUN: &str = "/v1/agent-runs/{run}/approval-decisions";

/// Every route `build_app` mounts OUTSIDE `require_principal` (the "public" routers of
/// `lib.rs`). A developer token is never looked at there, so the sweep leaves these out — and
/// the list is held exact in both directions: a mounted route that is neither behind the door
/// nor on this list turns the sweep red, and a listed route that is in fact behind the door
/// turns the converse check red.
const PUBLIC_TEMPLATES: &[&str] = &[
    "/healthz",
    "/health",
    "/v1/auth/login",
    "/v1/auth/refresh",
    "/v1/auth/logout",
    "/v1/mcp/agent-port",
    "/.well-known/oauth-protected-resource/v1/mcp/agent-port",
    "/.well-known/oauth-authorization-server",
    "/v1/oauth/authorize",
    "/v1/oauth/token",
    "/v1/oauth/revoke",
    "/v1/workspaces/{ws}/work-hosts/{host}/heartbeat",
    "/v1/workspaces/{ws}/work-hosts/cloud/register",
    "/v1/workspaces/{ws}/work-hosts/{host}/terminal-attach/validate",
    "/v1/workspaces/{ws}/work-hosts/{host}/display-attach/validate",
    "/v1/centrifugo/subscribe",
    "/v1/join",
    "/v1/claim",
    "/v1/auth/device-link/redeem",
    "/v1/workspaces/{ws}/cloud-box-runner/claim",
    "/v1/workspaces/{ws}/cloud-box-runner/controls/{control}/complete",
    "/v1/workspaces/{ws}/cloud-box-runner/boxes",
    "/v1/integrations/github/app/callback",
    "/v1/integrations/github/setup",
    "/v1/integrations/github/webhook",
    "/v1/webhooks/{ws}/{installation}",
    "/hooks/{token}",
];

/// Public only when the Drive archive accepts stub uploads (an in-memory or local archive); the
/// states these tests build do not mount it, so it is allowed to be absent — and swept if it is
/// ever present without being listed above.
const CONDITIONAL_PUBLIC_TEMPLATES: &[&str] = &["/__momo_stub/drive/uploads/{token}"];

const SWEEP_METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

fn sha256(text: &str) -> Vec<u8> {
    Sha256::digest(text.as_bytes()).to_vec()
}

/// 43 base64url characters — the shape of a minted secret. Not a credential of anyone.
fn random_secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())[..43].to_string()
}

fn envelope(prefix: &str, workspace: Uuid, secret: &str) -> String {
    format!("{prefix}.{}.{secret}", workspace.hyphenated())
}

/// The secret part of an envelope (its third dot-separated field).
fn secret_part(envelope: &str) -> &str {
    envelope
        .rsplit('.')
        .next()
        .expect("an envelope has a secret")
}

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

/// Everything a caller can observe of one response except the clock: status, every other header
/// (names lower-cased, sorted) and the body bytes. Two refusals that must be indistinguishable
/// are compared as whole values.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|error| panic!("a JSON body ({error}): {:?}", self.text()))
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(candidate, _)| candidate == name)
            .map(|(_, value)| value.as_str())
    }

    /// `error.code` of the API's error envelope.
    fn error_code(&self) -> Option<String> {
        serde_json::from_slice::<Value>(&self.body)
            .ok()
            .and_then(|body| body["error"]["code"].as_str().map(str::to_string))
    }

    /// The door's refusal of a pair off the closed table: 403 with `dev_route_not_allowed`.
    fn is_route_refusal(&self) -> bool {
        self.status == 403 && self.error_code().as_deref() == Some("dev_route_not_allowed")
    }

    /// The same refusal as `other`: status, body bytes and content type. (Not the `allow` header:
    /// axum adds that to whatever answers a method the route does not register, so it differs by
    /// route and method — and is the same for every refusal a caller can provoke there.)
    fn same_refusal_as(&self, other: &Answer) -> bool {
        self.status == other.status
            && self.body == other.body
            && self.header("content-type") == other.header("content-type")
    }

    /// What a HEAD request to a refused pair must look like: no body of its own, and the status,
    /// `content-type` and `content-length` of the refusal (a GET-shaped answer to the same pair)
    /// whose body it stands for — so a 403 that some handler made up does not pass for the door's.
    fn is_head_of(&self, refusal: &Answer) -> bool {
        self.status == refusal.status
            && self.body.is_empty()
            && self.header("content-type") == refusal.header("content-type")
            && self.header("content-length") == Some(refusal.body.len().to_string().as_str())
    }
}

/// One client + base URL. Never follows a redirect: a public route may point somewhere else and
/// a conformance run must not go there.
#[derive(Clone)]
struct Http {
    client: reqwest::Client,
    base: String,
}

impl Http {
    fn new(base: String) -> Http {
        Http {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()
                .expect("an HTTP client"),
            base,
        }
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        bearer: Option<&str>,
        body: Option<&Value>,
    ) -> Answer {
        self.send_with(method, path, bearer, &[], body).await
    }

    async fn send_with(
        &self,
        method: &str,
        path: &str,
        bearer: Option<&str>,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Answer {
        let method = reqwest::Method::from_bytes(method.as_bytes()).expect("an HTTP method");
        let mut request = self.client.request(method, format!("{}{path}", self.base));
        if let Some(bearer) = bearer {
            request = request.bearer_auth(bearer);
        }
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .unwrap_or_else(|error| panic!("the server answers {path}: {error}"));
        let status = response.status().as_u16();
        let mut headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .filter(|(name, _)| name.as_str() != "date")
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect();
        headers.sort();
        let body = response.bytes().await.expect("a response body").to_vec();
        Answer {
            status,
            headers,
            body,
        }
    }

    async fn get(&self, path: &str, bearer: Option<&str>) -> Answer {
        self.send("GET", path, bearer, None).await
    }
}

fn ws_path(workspace: Uuid, rest: &str) -> String {
    format!("/v1/workspaces/{}{rest}", workspace.hyphenated())
}

/// A concrete request path for a route template: `{ws}` is the given workspace, every other
/// placeholder a fresh UUID (no static route anywhere is spelled like one, so the router's
/// match for the concrete path is the template it was built from).
fn concrete_path(template: &str, workspace: Uuid) -> String {
    template
        .split('/')
        .map(|segment| match segment {
            "{ws}" => workspace.hyphenated().to_string(),
            placeholder if placeholder.starts_with('{') && placeholder.ends_with('}') => {
                Uuid::new_v4().hyphenated().to_string()
            }
            literal => literal.to_string(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// `{anything}` → `{}`: the spelling the allow-list file and the comparison use.
fn normalize_template(template: &str) -> String {
    template
        .split('/')
        .map(|segment| {
            if segment.starts_with('{') && segment.ends_with('}') {
                "{}"
            } else {
                segment
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

// ---------------------------------------------------------------------------
// mining the mounted routes out of `Router`'s Debug output
// ---------------------------------------------------------------------------

/// One route `build_app` mounted: the template the router will report as `MatchedPath`, and the
/// methods registered on it (`HEAD` is never listed for a `GET`: axum answers it from the GET).
#[derive(Debug, Clone, PartialEq, Eq)]
struct MountedRoute {
    template: String,
    methods: BTreeSet<&'static str>,
}

/// `Router { path_router: PathRouter { routes: {RouteId(n): MethodRouter(MethodRouter { get: …,
/// …, post: …, … }), …}, node: Node { paths: {RouteId(n): "<template>", …} } }, fallback_router:
/// …`. Debug output is not an API, so the tests that depend on this parse assert that it still
/// sees the routes it must (`the_router_debug_still_lists_every_route_the_sweep_depends_on`)
/// rather than trusting a count of zero.
fn mounted_routes(router: &Router) -> Vec<MountedRoute> {
    const ROUTES: &str = "routes: {";
    const PATHS: &str = "node: Node { paths: {";
    let text = format!("{router:?}");
    let routes_start = text
        .find(ROUTES)
        .expect("the router Debug lists its routes")
        + ROUTES.len();
    let paths_start = text
        .find(PATHS)
        .expect("the router Debug lists its route templates");

    let mut templates: BTreeMap<u64, String> = BTreeMap::new();
    let mut rest = &text[paths_start + PATHS.len()..];
    while let Some(after) = rest.strip_prefix("RouteId(") {
        let close = after.find("): \"").expect("RouteId(n): \"template\"");
        let id: u64 = after[..close].parse().expect("a numeric route id");
        let body = &after[close + 4..];
        let end = body.find('"').expect("a closing quote");
        templates.insert(id, body[..end].to_string());
        rest = &body[end + 1..];
        rest = rest.strip_prefix(", ").unwrap_or(rest);
    }

    let mut methods_by_id: BTreeMap<u64, BTreeSet<&'static str>> = BTreeMap::new();
    for chunk in text[routes_start..paths_start].split("RouteId(").skip(1) {
        let close = chunk.find("): ").expect("RouteId(n): endpoint");
        let id: u64 = chunk[..close].parse().expect("a numeric route id");
        let endpoint = &chunk[close + 3..];
        assert!(
            endpoint.starts_with("MethodRouter(MethodRouter { "),
            "route {id} is not a plain method router: {endpoint}"
        );
        let fields = &endpoint[..endpoint
            .find("fallback:")
            .expect("a method router has a fallback field")];
        let mut methods = BTreeSet::new();
        for (field, method) in [
            ("get: ", "GET"),
            ("head: ", "HEAD"),
            ("delete: ", "DELETE"),
            ("options: ", "OPTIONS"),
            ("patch: ", "PATCH"),
            ("post: ", "POST"),
            ("put: ", "PUT"),
            ("trace: ", "TRACE"),
            ("connect: ", "CONNECT"),
        ] {
            let at = fields
                .find(field)
                .unwrap_or_else(|| panic!("the method router Debug has no `{field}`"));
            if !fields[at + field.len()..].starts_with("None") {
                methods.insert(method);
            }
        }
        methods_by_id.insert(id, methods);
    }

    templates
        .into_iter()
        .map(|(id, template)| MountedRoute {
            methods: methods_by_id
                .remove(&id)
                .unwrap_or_else(|| panic!("route {id} ({template}) has no method router")),
            template,
        })
        .collect()
}

/// A router over a pool that never dials (an unreachable port, a short acquire timeout), so a
/// request that gets past the door's pre-database refusals answers 500 instead of hanging.
fn lazy_state() -> AppState {
    let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(250))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool never dials");
    AppState::new(
        pool,
        "dev-door-conformance-secret".to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
}

async fn serve(router: Router) -> Http {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral port");
    let address: SocketAddr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    Http::new(format!("http://{address}"))
}

/// The real router over a pool that never dials; also returns the router for template mining.
async fn serve_real_router_without_database() -> (Http, Router) {
    let router = build_app(lazy_state());
    (serve(router.clone()).await, router)
}

// ---------------------------------------------------------------------------
// the sweep (R3 b): every mounted template × seven methods
// ---------------------------------------------------------------------------

struct Sweep {
    /// Pairs the door refused with its own `dev_route_not_allowed` envelope.
    refused: usize,
    /// Pairs of the literal TABLE that are mounted — NOT sent by the sweep (the caller sends
    /// them, in an order that suits its token).
    table_pairs: Vec<(&'static str, String)>,
    /// Everything that broke the rule, in one place.
    problems: Vec<String>,
}

fn is_public(template: &str) -> bool {
    PUBLIC_TEMPLATES.contains(&template) || CONDITIONAL_PUBLIC_TEMPLATES.contains(&template)
}

/// Send `bearer` to every non-public mounted template with every method of [`SWEEP_METHODS`]
/// except the literal TABLE's own pairs. Each must be answered by the door itself: 403, the
/// `dev_route_not_allowed` envelope — the same bytes every time, and for HEAD the same status, type
/// and length. Anything
/// else — a handler's answer, a 404, a 401 — is a problem: the route is either open to a
/// developer token, or public and missing from [`PUBLIC_TEMPLATES`].
async fn sweep_off_table_pairs(
    http: &Http,
    bearer: &str,
    workspace: Uuid,
    mounted: &[MountedRoute],
) -> Sweep {
    let mut sweep = Sweep {
        refused: 0,
        table_pairs: Vec::new(),
        problems: Vec::new(),
    };
    let mut reference: Option<Answer> = None;
    for route in mounted.iter().filter(|route| !is_public(&route.template)) {
        for method in SWEEP_METHODS {
            if TABLE.iter().any(|(table_method, template, _)| {
                *table_method == method && *template == route.template
            }) {
                sweep.table_pairs.push((method, route.template.clone()));
                continue;
            }
            let path = concrete_path(&route.template, workspace);
            let answer = http.send(method, &path, Some(bearer), None).await;
            let refused = if method == "HEAD" {
                reference
                    .as_ref()
                    .is_some_and(|reference| answer.is_head_of(reference))
            } else {
                answer.is_route_refusal()
            };
            if !refused {
                sweep.problems.push(format!(
                    "{method} {}: {} {}",
                    route.template,
                    answer.status,
                    answer.text()
                ));
                continue;
            }
            if method != "HEAD" {
                match &reference {
                    None => reference = Some(answer),
                    Some(reference) if reference.body != answer.body => {
                        sweep.problems.push(format!(
                            "{method} {}: the refusal differs from the first one: {}",
                            route.template,
                            answer.text()
                        ))
                    }
                    Some(_) => {}
                }
            }
            sweep.refused += 1;
        }
    }
    sweep
}

/// The converse: every listed public template is mounted, and a developer token sent to it is
/// never answered by the door (so the list names routes that really are outside it).
async fn public_templates_are_outside_the_door(
    http: &Http,
    bearer: &str,
    workspace: Uuid,
    mounted: &[MountedRoute],
) -> Vec<String> {
    let mut problems = Vec::new();
    let present: BTreeSet<&str> = mounted
        .iter()
        .map(|route| route.template.as_str())
        .collect();
    for template in PUBLIC_TEMPLATES {
        if !present.contains(template) {
            problems.push(format!(
                "{template} is listed as public but is not mounted (stale list)"
            ));
            continue;
        }
        let answer = http
            .get(&concrete_path(template, workspace), Some(bearer))
            .await;
        if answer.is_route_refusal() {
            problems.push(format!(
                "{template} is listed as public but the developer door answers it"
            ));
        }
    }
    problems
}

// ---------------------------------------------------------------------------
// R3 (a) — the table, no database
// ---------------------------------------------------------------------------

/// R3 (a): exactly the eight rows of D4, each with its scope, and nothing else.
#[test]
fn the_closed_table_is_exactly_the_eight_pairs_the_adr_names() {
    for (method, template, scope) in TABLE {
        assert_eq!(
            required_dev_scope(method, template),
            Some(scope),
            "{method} {template}"
        );
    }
    let in_code: BTreeSet<(String, String, String)> = DEV_ROUTE_TABLE
        .iter()
        .map(|row| {
            (
                row.method.to_string(),
                row.template.to_string(),
                row.scope.to_string(),
            )
        })
        .collect();
    let in_adr: BTreeSet<(String, String, String)> = TABLE
        .iter()
        .map(|(method, template, scope)| {
            (method.to_string(), template.to_string(), scope.to_string())
        })
        .collect();
    assert_eq!(
        in_code, in_adr,
        "DEV_ROUTE_TABLE must be exactly ADR-0216 D4's L1–L8"
    );
    assert_eq!(DEV_ROUTE_TABLE.len(), TABLE.len(), "no duplicated row");
}

/// R3 (a), the default branch: any (method, template) the ADR does not list has no scope — every
/// other method of a table template (HEAD, OPTIONS, lowercase included), every near-miss
/// spelling of a table template (so a raw path, a different placeholder name or a trailing slash
/// is never a key), and the routes the ADR names as out of reach.
#[test]
fn a_pair_off_the_table_has_no_scope_whatever_the_spelling() {
    let methods = [
        "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT", "get",
        "post", "delete", "head", "options", "Get", "",
    ];
    let on_table = |method: &str, template: &str| {
        TABLE
            .iter()
            .any(|(row_method, row_template, _)| *row_method == method && *row_template == template)
    };

    let mut probed = 0;
    for (_, template, _) in TABLE {
        for method in methods {
            if !on_table(method, template) {
                probed += 1;
                assert_eq!(
                    required_dev_scope(method, template),
                    None,
                    "{method} {template} is not a row of the table"
                );
            }
        }
        // near misses of the template itself, with every method (the table's own methods too)
        let near_misses = [
            format!("{template}/"),
            template.to_uppercase(),
            template.replace("{ch}", "{channel}"),
            template.replace("{ws}", "{workspace}"),
            template.replace("{ws}", "0190f2a4-6b1d-7c3e-8f00-00000000a1a1"),
            template.replace("/v1/", "v1/"),
            template.replace("/v1/", "//v1/"),
            format!("{template}?x=1"),
            format!("{template}#x"),
            template.replace('{', "%7B").replace('}', "%7D"),
            template.replace("channels", "Channels"),
            template.replace("channels", "channels%2F"),
        ];
        for near_miss in near_misses {
            if near_miss == template {
                continue;
            }
            for method in ["GET", "POST", "DELETE", "HEAD"] {
                probed += 1;
                assert_eq!(
                    required_dev_scope(method, &near_miss),
                    None,
                    "{method} {near_miss} is a spelling of a table template, not a key"
                );
            }
        }
    }
    assert!(probed > 250, "the probe really ran ({probed} pairs)");

    // The routes ADR-0216 D4 names as out of a developer token's reach, by their mounted
    // templates (the first two are the approval decisions).
    for (method, template) in [
        ("POST", DECISION_BY_APPROVAL),
        ("POST", DECISION_BY_RUN),
        ("POST", "/v1/workspaces/{ws}/dev-access/credentials"),
        ("GET", "/v1/workspaces/{ws}/dev-access/credentials"),
        ("DELETE", "/v1/workspaces/{ws}/dev-access/credentials/{id}"),
        ("GET", "/v1/workspaces/{ws}/dev-access"),
        ("PATCH", "/v1/workspaces/{ws}/messages/{id}"),
        ("DELETE", "/v1/workspaces/{ws}/messages/{id}"),
        ("PUT", "/v1/workspaces/{ws}/messages/{id}/pin"),
        ("PUT", "/v1/workspaces/{ws}/messages/{id}/reactions/{emoji}"),
        ("POST", "/v1/workspaces/{ws}/channels"),
        ("POST", "/v1/workspaces/{ws}/inbox/read-all"),
        ("PUT", "/v1/workspaces/{ws}/members/me/password"),
        ("POST", "/v1/mcp/agent-port"),
        ("GET", "/v1/mcp/me"),
        ("DELETE", "/v1/mcp/me"),
    ] {
        assert_eq!(
            required_dev_scope(method, template),
            None,
            "{method} {template} must stay off the table"
        );
    }
}

/// R3 (a) through the door's own verdict (`dev_route_scope`, the function the middleware calls):
/// a missing template (fail closed), another workspace, and the table's rows by their raw paths.
#[test]
fn the_doors_verdict_needs_a_matched_template_and_the_envelopes_own_workspace() {
    let workspace = Uuid::from_u128(0xa1b2_c3d4_e5f6_4a7b_8c9d_0e1f_2a3b_4c5d);
    let other = Uuid::from_u128(0xb2c3_d4e5_f6a7_4b8c_9d0e_1f2a_3b4c_5d6e);
    for (method, template, scope) in TABLE {
        let raw = concrete_path(template, workspace);
        assert_eq!(
            dev_route_scope(method, Some(template), &raw, workspace),
            Some(scope),
            "{method} {template}: the control — its own workspace, its own template"
        );
        assert_eq!(
            dev_route_scope(method, None, &raw, workspace),
            None,
            "{method} {template}: no matched template is a refusal, whatever the raw path says"
        );
        if template.contains("{ws}") {
            assert_eq!(
                dev_route_scope(
                    method,
                    Some(template),
                    &concrete_path(template, other),
                    workspace
                ),
                None,
                "{method} {template}: another workspace in the path"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// the parse the sweeps depend on
// ---------------------------------------------------------------------------

/// The sweeps and the contract comparison trust a parse of `Router`'s Debug output, so the parse
/// must itself be held: if a dependency upgrade reshapes the output, this fails with a message
/// instead of the sweeps silently visiting nothing.
#[tokio::test]
async fn the_router_debug_still_lists_every_route_the_sweep_depends_on() {
    let router = build_app(lazy_state());
    let mounted = mounted_routes(&router);
    let by_template: BTreeMap<&str, &MountedRoute> = mounted
        .iter()
        .map(|route| (route.template.as_str(), route))
        .collect();
    assert_eq!(
        by_template.len(),
        mounted.len(),
        "a template is listed once"
    );
    assert!(
        mounted.len() >= 240,
        "the router mounts well over 240 routes; saw {}",
        mounted.len()
    );
    // every listed public route and every mounted-and-tabled route, with the methods it must have
    for template in PUBLIC_TEMPLATES {
        assert!(
            by_template.contains_key(template),
            "{template} is not in the parsed route list"
        );
    }
    for (method, template, _) in TABLE {
        if template == L8_TEMPLATE {
            continue;
        }
        let route = by_template
            .get(template)
            .unwrap_or_else(|| panic!("table row {method} {template} names an unmounted template"));
        assert!(
            route.methods.contains(method),
            "{template} is mounted without {method}: {:?}",
            route.methods
        );
    }
    for template in [DECISION_BY_APPROVAL, DECISION_BY_RUN] {
        let route = by_template
            .get(template)
            .unwrap_or_else(|| panic!("the decision route {template} is not mounted"));
        assert!(
            route.methods.contains("POST"),
            "{template}: {:?}",
            route.methods
        );
    }
    // methods are read per route, not smeared: a single-method route and a multi-method one
    assert_eq!(
        by_template["/healthz"].methods,
        BTreeSet::from(["GET"]),
        "/healthz"
    );
    assert_eq!(
        by_template["/v1/workspaces/{ws}/messages/{id}"].methods,
        BTreeSet::from(["DELETE", "PATCH"]),
        "a route with two methods"
    );
    // the fallback router's catch-all is not a route of the app
    assert!(
        !by_template
            .keys()
            .any(|template| template.contains("__private__")),
        "the parse read the fallback router's templates as well"
    );
}

// ---------------------------------------------------------------------------
// R3 (b) — the sweep, no database
// ---------------------------------------------------------------------------

/// R3 (b): every mounted route that is not public, with every method that is not a table row, is
/// refused by the door with its own envelope — before any handler (and, here, before any
/// database: the pool never dials). The positive control: the table's own mounted pairs are not
/// refused by the door; they get as far as the database, which answers 500.
#[tokio::test]
async fn every_mounted_pair_off_the_table_is_refused_by_the_door_before_the_database() {
    let (http, router) = serve_real_router_without_database().await;
    let mounted = mounted_routes(&router);
    let workspace = Uuid::new_v4();
    // Well-formed and unknown to any database: the table is judged before the lookup, so the
    // refusal must not depend on the token being any good.
    let token = envelope(DEV_TOKEN_PREFIX, workspace, &random_secret());

    let sweep = sweep_off_table_pairs(&http, &token, workspace, &mounted).await;
    assert!(
        sweep.problems.is_empty(),
        "{} pair(s) were not refused by the door:\n{}",
        sweep.problems.len(),
        sweep.problems.join("\n")
    );
    let protected = mounted
        .iter()
        .filter(|route| !is_public(&route.template))
        .count();
    assert_eq!(
        sweep.refused + sweep.table_pairs.len(),
        protected * SWEEP_METHODS.len(),
        "every protected template was visited with every method"
    );
    assert!(
        protected >= 200,
        "the router mounts at least 200 protected routes; saw {protected}"
    );

    // The control: the table's pairs on the real router. L1–L7 are mounted (L8 only once #4661
    // lands); each passes the door and reaches the database, which this test does not have.
    let mut expected: Vec<(&str, String)> = TABLE
        .iter()
        .filter(|(_, template, _)| *template != L8_TEMPLATE)
        .map(|(method, template, _)| (*method, template.to_string()))
        .collect();
    if mounted.iter().any(|route| route.template == L8_TEMPLATE) {
        expected.push(("POST", L8_TEMPLATE.to_string()));
    }
    let mut found = sweep.table_pairs.clone();
    found.sort();
    expected.sort();
    assert_eq!(found, expected, "the table's pairs that the router mounts");
    for (method, template) in &found {
        let answer = http
            .send(
                method,
                &concrete_path(template, workspace),
                Some(&token),
                None,
            )
            .await;
        assert!(
            !answer.is_route_refusal(),
            "{method} {template}: the door refused a pair that is on its table"
        );
        assert_eq!(
            answer.status, 500,
            "{method} {template}: past the door, the database is unreachable here"
        );
    }

    // And the list of public routes is exact: each is mounted and answered by something other
    // than the door.
    let problems = public_templates_are_outside_the_door(&http, &token, workspace, &mounted).await;
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// The sweep's own detector, held: the same sweep over the real router plus ONE route that sits
/// outside the door (the mistake the sweep exists to catch — a new route mounted without
/// `require_principal`, or a handler a developer token can reach) must report that route and
/// nothing else. Without this, a sweep that visits nothing, or accepts every answer, would pass.
#[tokio::test]
async fn the_sweep_flags_a_route_that_is_open_to_a_developer_token() {
    let open_template = "/v1/workspaces/{ws}/zz-open-to-everyone";
    let router = build_app(lazy_state()).route(
        open_template,
        get(|| async { "open" }).delete(|| async { "open" }),
    );
    let http = serve(router.clone()).await;
    let mounted = mounted_routes(&router);
    assert!(
        mounted.iter().any(|route| route.template == open_template),
        "the extra route is mounted"
    );
    let workspace = Uuid::new_v4();
    let token = envelope(DEV_TOKEN_PREFIX, workspace, &random_secret());

    let sweep = sweep_off_table_pairs(&http, &token, workspace, &mounted).await;
    assert!(
        sweep
            .problems
            .iter()
            .any(|problem| problem.starts_with(&format!("GET {open_template}: 200 open"))),
        "the open GET is reported with the handler's own answer: {:?}",
        sweep.problems
    );
    assert!(
        sweep
            .problems
            .iter()
            .any(|problem| problem.starts_with(&format!("DELETE {open_template}: 200 open"))),
        "the open DELETE is reported: {:?}",
        sweep.problems
    );
    assert!(
        sweep
            .problems
            .iter()
            .all(|problem| problem.contains(open_template)),
        "only the open route is reported, every real route is still refused: {:?}",
        sweep.problems
    );
}

// ---------------------------------------------------------------------------
// R3 (c) — no matched template, no admission (no database)
// ---------------------------------------------------------------------------

/// The door keys on the template the router matched. Strip that template (a stand-in for the
/// door being mounted where the router has not routed yet) and a request to a perfectly
/// on-table PATH must be refused — not guessed at from the raw path's shape. The control: with
/// the template present the same request passes the table and reaches the database (500 here).
#[tokio::test]
async fn a_request_the_router_has_not_matched_is_refused_not_guessed_at() {
    let table_path = "/v1/workspaces/{ws}/channels";
    let hits = Arc::new(AtomicUsize::new(0));
    let build = |strip_the_template: bool| {
        let state = lazy_state();
        let counted = hits.clone();
        let router = Router::new()
            .route(
                table_path,
                get(move || {
                    let counted = counted.clone();
                    async move {
                        counted.fetch_add(1, Ordering::SeqCst);
                        "reached"
                    }
                }),
            )
            .route_layer(axum::middleware::from_fn_with_state(
                state.clone(),
                momo_server::auth::require_principal,
            ));
        // The later `route_layer` is the outer one: it runs first and takes the template away.
        let router = if strip_the_template {
            router.route_layer(axum::middleware::from_fn(
                |mut request: Request, next: Next| async move {
                    request
                        .extensions_mut()
                        .remove::<axum::extract::MatchedPath>();
                    next.run(request).await
                },
            ))
        } else {
            router
        };
        router.with_state(state)
    };
    let workspace = Uuid::new_v4();
    let token = envelope(DEV_TOKEN_PREFIX, workspace, &random_secret());
    let path = concrete_path(table_path, workspace);

    let stripped = serve(build(true)).await;
    let refused = stripped.get(&path, Some(&token)).await;
    assert!(
        refused.is_route_refusal(),
        "no template: {} {}",
        refused.status,
        refused.text()
    );

    let with_template = serve(build(false)).await;
    let passed = with_template.get(&path, Some(&token)).await;
    assert_eq!(
        passed.status, 500,
        "with its template the same request passes the table and reaches the database"
    );
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "no handler ran in either case"
    );
}

// ---------------------------------------------------------------------------
// the approval decisions — layer one (the table) and layer two (decide), no database
// ---------------------------------------------------------------------------

fn card_marker() -> DevCredential {
    DevCredential {
        token_id: Uuid::new_v4(),
        form: DevForm::Card,
        scopes: DEV_SCOPES.iter().map(|scope| scope.to_string()).collect(),
        channel_ids: None,
    }
}

fn decision_request(approval: Uuid) -> Value {
    json!({
        "approvalId": approval,
        "approve": true,
        "clientDecisionId": Uuid::new_v4(),
    })
}

/// The two decision routes on a router of their own, behind a stub that plants `principal` (and,
/// when given, the developer marker) exactly as the middleware would — but without the table, so
/// what answers is `decide()` alone. The pool never dials.
async fn serve_decision_routes(principal: Principal, marker: Option<DevCredential>) -> Http {
    let state = lazy_state();
    let router = Router::new()
        .route(
            DECISION_BY_APPROVAL,
            post(momo_server::routes::approvals::decide_by_approval),
        )
        .route(
            DECISION_BY_RUN,
            post(momo_server::routes::approvals::decide_by_run),
        )
        .route_layer(axum::middleware::from_fn(
            move |mut request: Request, next: Next| {
                let principal = principal.clone();
                let marker = marker.clone();
                async move {
                    request.extensions_mut().insert(principal);
                    if let Some(marker) = marker {
                        request.extensions_mut().insert(marker);
                    }
                    next.run(request).await
                }
            },
        ))
        .with_state(state);
    serve(router).await
}

fn person(workspace: Uuid, member: Uuid, kind: PrincipalKind) -> Principal {
    Principal {
        member_id: member,
        workspace_id: workspace,
        token_id: Some(Uuid::new_v4()),
        scopes: Vec::new(),
        kind,
    }
}

/// Layer two for ONE route: three stubbed callers, three different answers.
/// * a person carrying the developer marker → 403 receipt `dev_cannot_decide`;
/// * the same person without it → past the check, into the database (500 here): the refusal
///   above is the marker's doing and nothing else's;
/// * a non-person without the marker → 403 receipt `human_principal_required`, a DIFFERENT
///   status string: a 403 alone would not have satisfied the first assertion.
async fn assert_decide_refuses_a_developer_marker(path_for: impl Fn(Uuid, Uuid) -> String) {
    let workspace = Uuid::new_v4();
    let member = Uuid::new_v4();
    let approval = Uuid::new_v4();
    let path = path_for(workspace, approval);
    let body = decision_request(approval);

    let with_marker = serve_decision_routes(
        person(workspace, member, PrincipalKind::Human),
        Some(card_marker()),
    )
    .await;
    let refused = with_marker.send("POST", &path, None, Some(&body)).await;
    assert_eq!(refused.status, 403, "{}", refused.text());
    let receipt = refused.json();
    assert_eq!(receipt["status"], "dev_cannot_decide", "{receipt}");
    assert_eq!(receipt["decidedBy"], member.to_string(), "{receipt}");
    assert!(
        receipt["decisionReason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty()),
        "the receipt says why: {receipt}"
    );
    assert_eq!(
        refused.header("cache-control"),
        Some("no-store"),
        "a decision outcome is never cached"
    );

    let without_marker =
        serve_decision_routes(person(workspace, member, PrincipalKind::Human), None).await;
    let past = without_marker.send("POST", &path, None, Some(&body)).await;
    assert_eq!(
        past.status, 500,
        "no marker: the request is past `decide`'s checks and into the database, which is not there: {}",
        past.text()
    );
    assert!(
        !past.text().contains("dev_cannot_decide"),
        "{}",
        past.text()
    );

    let not_a_person =
        serve_decision_routes(person(workspace, member, PrincipalKind::Agent), None).await;
    let other_refusal = not_a_person.send("POST", &path, None, Some(&body)).await;
    assert_eq!(other_refusal.status, 403, "{}", other_refusal.text());
    assert_eq!(
        other_refusal.json()["status"],
        "human_principal_required",
        "a different 403 receipt, so `dev_cannot_decide` above is not just 'some 403'"
    );
}

/// `decide()` — the second layer — on `POST …/approvals/{approval}/decision`.
#[tokio::test]
async fn decide_refuses_a_developer_credential_on_the_approval_decision_route() {
    assert_decide_refuses_a_developer_marker(|workspace, approval| {
        ws_path(workspace, &format!("/approvals/{approval}/decision"))
    })
    .await;
}

/// `decide()` — the second layer — on `POST /v1/agent-runs/{run}/approval-decisions`: the other
/// route, the same function, checked on its own.
#[tokio::test]
async fn decide_refuses_a_developer_credential_on_the_run_decision_route() {
    assert_decide_refuses_a_developer_marker(|_, _| {
        format!("/v1/agent-runs/{}/approval-decisions", Uuid::new_v4())
    })
    .await;
}

/// The first layer for `POST …/approvals/{approval}/decision`: on the real router a developer
/// token is refused by the closed table, before the database, with the door's own envelope.
#[tokio::test]
async fn the_table_closes_the_approval_decision_route_to_a_developer_token() {
    let (http, router) = serve_real_router_without_database().await;
    assert!(
        mounted_routes(&router)
            .iter()
            .any(|route| route.template == DECISION_BY_APPROVAL && route.methods.contains("POST")),
        "the route under test is mounted"
    );
    let workspace = Uuid::new_v4();
    let token = envelope(DEV_TOKEN_PREFIX, workspace, &random_secret());
    let approval = Uuid::new_v4();
    let refused = http
        .send(
            "POST",
            &ws_path(workspace, &format!("/approvals/{approval}/decision")),
            Some(&token),
            Some(&decision_request(approval)),
        )
        .await;
    assert!(
        refused.is_route_refusal(),
        "{} {}",
        refused.status,
        refused.text()
    );
    // the control: a table route, same token, same server — past the door, into the database
    let passed = http
        .get(&ws_path(workspace, "/channels"), Some(&token))
        .await;
    assert_eq!(
        passed.status, 500,
        "the table lets L3 through to the database"
    );
}

/// The first layer for `POST /v1/agent-runs/{run}/approval-decisions`.
#[tokio::test]
async fn the_table_closes_the_run_decision_route_to_a_developer_token() {
    let (http, router) = serve_real_router_without_database().await;
    assert!(
        mounted_routes(&router)
            .iter()
            .any(|route| route.template == DECISION_BY_RUN && route.methods.contains("POST")),
        "the route under test is mounted"
    );
    let workspace = Uuid::new_v4();
    let token = envelope(DEV_TOKEN_PREFIX, workspace, &random_secret());
    let refused = http
        .send(
            "POST",
            &format!("/v1/agent-runs/{}/approval-decisions", Uuid::new_v4()),
            Some(&token),
            Some(&decision_request(Uuid::new_v4())),
        )
        .await;
    assert!(
        refused.is_route_refusal(),
        "{} {}",
        refused.status,
        refused.text()
    );
    let passed = http
        .get(&ws_path(workspace, "/channels"), Some(&token))
        .await;
    assert_eq!(
        passed.status, 500,
        "the table lets L3 through to the database"
    );
}

// ---------------------------------------------------------------------------
// R4 — the dev namespace is its own (no database)
// ---------------------------------------------------------------------------

/// Every scope the server already names in code: the public constants of momo-auth and
/// momo-mcp, and what every Agent Port tool requires. (The test below adds what the agent route
/// table asks of each mounted route.)
fn named_scopes() -> BTreeSet<String> {
    use momo_auth::agent_scope as agent;
    let mut scopes: BTreeSet<String> = BTreeSet::new();
    for scope in [
        agent::SCOPE_AGENT_JOBS_READ,
        agent::SCOPE_AGENT_RUNS_CALLBACK,
        agent::SCOPE_MESSAGES_WRITE,
        agent::SCOPE_WORK_CONTROL,
        agent::SCOPE_AGENT_PORT_CONNECT,
        agent::SCOPE_AGENT_INBOX_READ,
        agent::SCOPE_MESSAGES_READ,
        agent::SCOPE_WORKSPACE_PROPOSE,
        momo_auth::push_action_token::SCOPE_PUSH_ACTION,
        momo_auth::push_fetch_token::SCOPE_PUSH_FETCH,
        momo_auth::token_store::SCOPE_REALTIME_SUBSCRIBE,
        momo_mcp::tools::SCOPE_PORT_CONNECT,
        momo_mcp::tools::SCOPE_INBOX_READ,
        momo_mcp::tools::SCOPE_MESSAGES_READ,
        momo_mcp::tools::SCOPE_MESSAGES_WRITE,
        momo_mcp::tools::SCOPE_JOBS_READ,
        momo_mcp::tools::SCOPE_RUNS_CALLBACK,
        momo_mcp::tools::SCOPE_WORKSPACE_PROPOSE,
    ] {
        scopes.insert(scope.to_string());
    }
    for scope in momo_auth::token_store::PRIVILEGED_SCOPES
        .iter()
        .chain(momo_auth::hosted_connection::HOSTED_AGENT_SCOPES.iter())
        .chain(momo_auth::agent_credential::DEFAULT_AGENT_CREDENTIAL_SCOPES.iter())
    {
        scopes.insert(scope.to_string());
    }
    assert!(
        !momo_mcp::TOOL_CATALOG.is_empty(),
        "the Agent Port tool catalog is read"
    );
    for tool in momo_mcp::TOOL_CATALOG.iter() {
        scopes.insert(tool.required_scope.to_string());
    }
    scopes
}

/// R4: `DEV_SCOPES` is exactly the ADR's five names, and no scope the server already knows — a
/// named constant in momo-auth or momo-mcp, a scope an Agent Port tool requires, a scope the
/// agent route table demands of any mounted route — equals one of them or squats `dev:`.
#[tokio::test]
async fn every_scope_the_server_already_knows_stays_out_of_the_dev_namespace() {
    use momo_auth::agent_scope as agent;

    let adr_scopes: BTreeSet<&str> = BTreeSet::from([
        "dev:identity",
        "dev:channels:read",
        "dev:messages:read",
        "dev:messages:write",
        "dev:inbox:read",
    ]);
    assert_eq!(
        DEV_SCOPES.iter().copied().collect::<BTreeSet<_>>(),
        adr_scopes,
        "DEV_SCOPES is exactly the ADR's vocabulary"
    );
    assert_eq!(DEV_SCOPES.len(), adr_scopes.len(), "no duplicate");
    assert_eq!(DEV_SCOPE_SEARCH_RESERVED, "dev:search");
    assert!(
        !DEV_SCOPES.contains(&DEV_SCOPE_SEARCH_RESERVED),
        "`dev:search` is a reserved name, never issued"
    );
    // the 「읽기만」 preset reads and never writes
    assert!(DEV_READ_ONLY_SCOPES
        .iter()
        .all(|scope| DEV_SCOPES.contains(scope)));
    assert!(!DEV_READ_ONLY_SCOPES.contains(&"dev:messages:write"));
    assert!(DEV_READ_ONLY_SCOPES.contains(&"dev:identity"));

    let mut existing = named_scopes();

    // What the agent route table asks of every mounted route — derived from the code, so a scope
    // someone adds there without naming a constant is still met here.
    let router = build_app(lazy_state());
    let workspace = Uuid::new_v4();
    let mut asked_by_routes = BTreeSet::new();
    for route in mounted_routes(&router) {
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            if let Some(scope) =
                agent::required_agent_scope(method, &concrete_path(&route.template, workspace))
            {
                asked_by_routes.insert(scope.to_string());
            }
        }
    }
    assert!(
        asked_by_routes.contains("messages:write") && asked_by_routes.contains("agent:jobs:read"),
        "the route-derived set is not empty: {asked_by_routes:?}"
    );
    existing.extend(asked_by_routes);

    for dev in DEV_SCOPES.iter().chain([&DEV_SCOPE_SEARCH_RESERVED]) {
        assert!(
            !existing.contains(*dev),
            "{dev} collides with a scope the server already knows"
        );
    }
    for scope in &existing {
        assert!(
            !scope.starts_with("dev:"),
            "{scope} squats the dev: namespace"
        );
    }
    for dev in DEV_SCOPES {
        assert!(dev.starts_with("dev:"), "{dev}");
    }
}

// ===========================================================================
// PostgreSQL — the same door over real rows (`#[ignore]`)
// ===========================================================================

/// A workspace with a person who may hold a developer token (the owner, 이도현), a person who
/// may not under the shipped policy (a member, 박서연), one channel both are in, and the real
/// router on a `momo_app` (NOBYPASSRLS) pool.
struct World {
    su: PgPool,
    app: PgPool,
    /// A second `AppState` over the same pool, for the server-side wrapper `rotate_dev_refresh`.
    state: AppState,
    http: Http,
    ws: Uuid,
    owner: Uuid,
    owner_jwt: String,
    channel: Uuid,
}

impl World {
    async fn boot() -> World {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let app = momo_app_pool().await;
        let http = Http::new(start_server(app.clone(), ServerOptions::default()).await);
        let state = AppState::new(
            app.clone(),
            TEST_JWT_SECRET.to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        );
        let ws = seed_workspace(&su).await;
        let (owner, owner_jwt) = seed_human(&su, ws, "owner", "이도현").await;
        let (member, _) = seed_human(&su, ws, "member", "박서연").await;
        let channel = seed_channel(&su, ws, "public", &[owner, member]).await;
        World {
            su,
            app,
            state,
            http,
            ws,
            owner,
            owner_jwt,
            channel,
        }
    }

    /// Another workspace and its owner (정하윤).
    async fn foreign(&self) -> (Uuid, Uuid) {
        let ws = seed_workspace(&self.su).await;
        let (owner, _) = seed_human(&self.su, ws, "owner", "정하윤").await;
        (ws, owner)
    }

    async fn issue_card(&self, member: Uuid, scopes: &[&str]) -> IssuedDevCard {
        let card = NewDevCard {
            label: "달무리 노트북".to_string(),
            tool: DevTool::Cli,
            scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
            channel_ids: None,
            expires_in_days: 30,
        };
        let ws = self.ws;
        with_tenant_tx(&self.app, ws, move |conn| {
            Box::pin(async move {
                issue_dev_card_in_tx(conn, ws, member, &card, FIXED_POLICY)
                    .await
                    .map_err(DbError::from)
            })
        })
        .await
        .expect("the issuing transaction")
        .expect("a card is issuable to an owner")
    }

    async fn issue_login(&self, member: Uuid, scopes: &[&str]) -> IssuedDevLogin {
        let login = NewDevLogin {
            label: "oort CLI".to_string(),
            tool: DevTool::Cli,
            client: "oort-cli".to_string(),
            device_name: Some("달무리 맥북".to_string()),
            scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
            channel_ids: None,
        };
        let ws = self.ws;
        with_tenant_tx(&self.app, ws, move |conn| {
            Box::pin(async move {
                issue_dev_login_in_tx(conn, ws, member, &login, FIXED_POLICY)
                    .await
                    .map_err(DbError::from)
            })
        })
        .await
        .expect("the issuing transaction")
        .expect("a login is issuable to an owner")
    }

    /// `resolve_dev_token_in_tx` as the door calls it (a tenant transaction on `ws`).
    async fn resolve(&self, raw: &str) -> DevResolution {
        let (ws, raw) = (self.ws, raw.to_string());
        with_tenant_tx(&self.app, ws, move |conn| {
            Box::pin(async move {
                resolve_dev_token_in_tx(conn, ws, &raw, FIXED_POLICY)
                    .await
                    .map_err(DbError::from)
            })
        })
        .await
        .expect("the resolving transaction")
    }

    /// The DOMAIN rotation — no Rust prefix pre-check in front of the SQL.
    async fn rotate_in_sql(&self, raw: &str) -> DevRotation {
        let (ws, raw) = (self.ws, raw.to_string());
        with_tenant_tx(&self.app, ws, move |conn| {
            Box::pin(async move {
                rotate_dev_refresh_in_tx(conn, ws, &raw, FIXED_POLICY)
                    .await
                    .map_err(DbError::from)
            })
        })
        .await
        .expect("the rotating transaction")
    }

    /// A dev card row planted by the superuser: `row_workspace` owns the row, `raw` is whatever
    /// envelope its hash is made of. Lets a test put a row where the door must NOT find it.
    async fn plant_card_row(
        &self,
        row_workspace: Uuid,
        actor: Uuid,
        raw: &str,
        scopes: &[&str],
    ) -> Uuid {
        let scopes: Vec<String> = scopes.iter().map(|scope| scope.to_string()).collect();
        sqlx::query_scalar(
            "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                               expires_at, dev_form, dev_tool) \
             VALUES($1,'dev',$2,digest($3::text,'sha256'),$4,'door-fixture', \
                    now() + interval '30 days','card','cli') RETURNING id",
        )
        .bind(row_workspace)
        .bind(actor)
        .bind(raw)
        .bind(&scopes)
        .fetch_one(&self.su)
        .await
        .expect("plant a dev card row")
    }

    async fn stored_hash(&self, token: Uuid) -> Vec<u8> {
        sqlx::query_scalar("SELECT token_hash FROM token WHERE id = $1")
            .bind(token)
            .fetch_one(&self.su)
            .await
            .expect("the token row")
    }

    /// How many rows of any workspace carry `digest(raw, 'sha256')` as their hash.
    async fn rows_hashing(&self, raw: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM token WHERE token_hash = digest($1::text,'sha256')",
        )
        .bind(raw)
        .fetch_one(&self.su)
        .await
        .expect("count rows by hash")
    }

    async fn last_used(&self, token: Uuid) -> bool {
        sqlx::query_scalar("SELECT last_used_at IS NOT NULL FROM token WHERE id = $1")
            .bind(token)
            .fetch_one(&self.su)
            .await
            .expect("last_used_at")
    }

    async fn revoked(&self, token: Uuid) -> bool {
        sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM token WHERE id = $1")
            .bind(token)
            .fetch_one(&self.su)
            .await
            .expect("revoked_at")
    }

    async fn audit_rows_via(&self, token: Uuid) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE via_token_id = $1")
            .bind(token)
            .fetch_one(&self.su)
            .await
            .expect("audit rows")
    }

    /// Row counts of the tables a handler could change, in this workspace — equal before and
    /// after a run of requests that must have reached no handler.
    async fn fingerprint(&self) -> BTreeMap<String, i64> {
        let mut counts = BTreeMap::new();
        for table in [
            "message",
            "channel",
            "membership",
            "member",
            "workspace_membership",
            "human",
            "outbox",
            "audit_log",
            "token",
            "approval",
            "agent_run",
        ] {
            let count: i64 = sqlx::query_scalar(&format!(
                "SELECT count(*) FROM {table} WHERE workspace_id = $1"
            ))
            .bind(self.ws)
            .fetch_one(&self.su)
            .await
            .unwrap_or_else(|error| panic!("count {table}: {error}"));
            counts.insert(table.to_string(), count);
        }
        let revoked: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM token WHERE workspace_id = $1 AND revoked_at IS NOT NULL",
        )
        .bind(self.ws)
        .fetch_one(&self.su)
        .await
        .expect("count revoked tokens");
        counts.insert("revoked tokens".to_string(), revoked);
        counts
    }

    fn channels_path(&self) -> String {
        ws_path(self.ws, "/channels")
    }
}

/// What a developer token's failure to identify looks like to a caller: the JWT arm's answer to a
/// string it cannot verify, which is also what any unknown string gets.
async fn unknown_token_answer(w: &World, path: &str) -> Answer {
    let unknown = envelope(DEV_TOKEN_PREFIX, w.ws, &random_secret());
    let reference = w.http.get(path, Some(&unknown)).await;
    assert_eq!(reference.status, 401, "{}", reference.text());
    assert_eq!(
        reference.error_code(),
        None,
        "the unknown-token answer carries no code"
    );
    let garbage = w.http.get(path, Some("not-a-token")).await;
    assert_eq!(
        garbage, reference,
        "an unknown developer-shaped string and a plain garbage string are answered alike"
    );
    reference
}

// ---------------------------------------------------------------------------
// R2 (i) — what is stored
// ---------------------------------------------------------------------------

/// R2 (i): `token_hash` is the SHA-256 of the WHOLE envelope — computed here with `sha2`,
/// independently of the database's `digest()` — and is neither the hash of the secret alone nor
/// of `<workspace>.<secret>`. The same secret bytes under another prefix hash differently and
/// match no row; presented anyway they are refused.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R2)"]
async fn a_token_is_stored_as_the_hash_of_its_whole_envelope() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let card = w.issue_card(w.owner, &DEV_SCOPES).await;
    let login = w.issue_login(w.owner, &DEV_SCOPES).await;

    let secret = secret_part(&card.secret).to_string();
    assert_eq!(secret.len(), 43, "a minted secret is 43 characters");
    let stored = w.stored_hash(card.id).await;
    assert_eq!(
        stored,
        sha256(&card.secret),
        "the stored hash is the SHA-256 of the whole envelope, prefix included"
    );
    assert_ne!(
        stored,
        sha256(&secret),
        "not the hash of the secret part alone"
    );
    assert_ne!(
        stored,
        sha256(&format!("{}.{secret}", w.ws.hyphenated())),
        "not the hash of the workspace and the secret without the prefix"
    );

    // a login lineage: each half is the hash of its own whole envelope, and the halves differ
    assert_eq!(
        w.stored_hash(login.access_token_id).await,
        sha256(&login.access)
    );
    assert_eq!(
        w.stored_hash(login.refresh_token_id).await,
        sha256(&login.refresh)
    );
    assert_ne!(sha256(&login.access), sha256(&login.refresh));

    // the same secret bytes under the other prefixes
    let as_refresh = envelope(DEV_REFRESH_PREFIX, w.ws, &secret);
    let as_agent = envelope(AGENT_BEARER_PREFIX, w.ws, &secret);
    let hashes = BTreeSet::from([sha256(&card.secret), sha256(&as_refresh), sha256(&as_agent)]);
    assert_eq!(
        hashes.len(),
        3,
        "momo_dev_v1, momo_devr_v1 and momo_agent_v1 over one secret are three different hashes"
    );
    assert_eq!(
        w.rows_hashing(&card.secret).await,
        1,
        "the control: the real envelope matches its row"
    );
    assert_eq!(
        w.rows_hashing(&as_refresh).await,
        0,
        "relabelled as a refresh: no row"
    );
    assert_eq!(
        w.rows_hashing(&as_agent).await,
        0,
        "relabelled as an agent bearer: no row"
    );

    // and the user-visible half: the card works, its relabelled twin does not
    let channels = w.channels_path();
    assert_eq!(w.http.get(&channels, Some(&card.secret)).await.status, 200);
    let unknown = unknown_token_answer(&w, &channels).await;
    assert_eq!(
        w.http.get(&channels, Some(&as_refresh)).await,
        unknown,
        "the card's secret under the refresh prefix is an unknown string"
    );
}

// ---------------------------------------------------------------------------
// R2 (ii) — the form filter, proved at the SQL as well as at the dispatch
// ---------------------------------------------------------------------------

/// R2 (ii): a live refresh envelope at the data door and a live access envelope at the refresh
/// door are refused — at the server (prefix dispatch) AND in the SQL: the domain functions are
/// called directly, with no Rust pre-check in front, with envelopes whose hashes DO exist as
/// rows, so only the `dev_form` filter stands between them and an answer. Nothing is revoked or
/// touched by the refusals, and a card is no refresh either.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R2)"]
async fn the_data_door_takes_card_and_access_only_and_the_refresh_door_takes_refresh_only() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let login = w.issue_login(w.owner, &DEV_SCOPES).await;
    let spare = w.issue_login(w.owner, &DEV_SCOPES).await;
    let card = w.issue_card(w.owner, &DEV_SCOPES).await;
    let channels = w.channels_path();

    // -- the data door -------------------------------------------------------
    let unknown = unknown_token_answer(&w, &channels).await;
    assert_eq!(
        w.http.get(&channels, Some(&login.refresh)).await,
        unknown,
        "a live refresh at a data route is an unknown token"
    );
    assert_eq!(
        w.http.get(&channels, Some(&login.access)).await.status,
        200,
        "the control: the same lineage's access works"
    );
    assert_eq!(w.http.get(&channels, Some(&card.secret)).await.status, 200);
    // in the SQL, with the live refresh's own hash
    assert_eq!(
        w.rows_hashing(&login.refresh).await,
        1,
        "the refresh envelope IS a row"
    );
    assert_eq!(
        w.resolve(&login.refresh).await,
        DevResolution::Unknown,
        "the data lookup does not return a refresh row"
    );
    match w.resolve(&login.access).await {
        DevResolution::Active(identity) => {
            assert_eq!(identity.form, DevForm::Access);
            assert_eq!(identity.token_id, login.access_token_id);
        }
        other => panic!("the control: a live access resolves, got {other:?}"),
    }

    // -- the refresh door ----------------------------------------------------
    assert_eq!(
        rotate_dev_refresh(&w.state, w.ws, &login.access)
            .await
            .expect("the server wrapper answers"),
        DevRotation::Invalid,
        "a live access at the server's refresh door"
    );
    assert_eq!(
        w.rotate_in_sql(&login.access).await,
        DevRotation::Invalid,
        "a live access in the rotation SQL itself (its hash is a row; only the form filter refuses it)"
    );
    assert_eq!(
        w.rotate_in_sql(&card.secret).await,
        DevRotation::Invalid,
        "a card is not a refresh either"
    );
    assert_eq!(
        rotate_dev_refresh(&w.state, w.ws, &card.secret)
            .await
            .expect("the server wrapper answers"),
        DevRotation::Invalid
    );

    // The refusals changed nothing: both halves of the lineage and the card are still live and
    // the access still works.
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM token WHERE session_id = $1 AND revoked_at IS NULL",
    )
    .bind(login.session_id)
    .fetch_one(&w.su)
    .await
    .expect("count live halves");
    assert_eq!(live, 2, "the lineage is intact");
    assert!(!w.revoked(card.id).await);
    assert_eq!(w.http.get(&channels, Some(&login.access)).await.status, 200);

    // The refresh door's other ways of not knowing a string: never issued, claiming another
    // workspace, asked for in another workspace, malformed. All `Invalid`, none touches a lineage.
    let (other_ws, _) = w.foreign().await;
    for (name, asked_in, raw) in [
        (
            "never issued",
            w.ws,
            envelope(DEV_REFRESH_PREFIX, w.ws, &random_secret()),
        ),
        (
            "an envelope claiming another workspace",
            w.ws,
            envelope(DEV_REFRESH_PREFIX, other_ws, secret_part(&spare.refresh)),
        ),
        (
            "a live refresh asked for in another workspace",
            other_ws,
            spare.refresh.clone(),
        ),
        (
            "malformed",
            w.ws,
            format!("{DEV_REFRESH_PREFIX}.not-a-uuid.short"),
        ),
    ] {
        assert_eq!(
            rotate_dev_refresh(&w.state, asked_in, &raw)
                .await
                .expect("the server wrapper answers"),
            DevRotation::Invalid,
            "{name}"
        );
    }

    // The control: a refresh at the refresh door rotates (another lineage, so the one above
    // stays whole).
    match rotate_dev_refresh(&w.state, w.ws, &spare.refresh)
        .await
        .expect("the server wrapper answers")
    {
        DevRotation::Rotated(next) => {
            assert_eq!(next.session_id, spare.session_id, "the same lineage");
            assert_ne!(next.access, spare.access);
        }
        other => panic!("the control: a live refresh rotates, got {other:?}"),
    }

    // A row that is not a developer row, hashing a developer-shaped envelope, authenticates as
    // nothing: the lookup is for `kind = 'dev'`, not for a hash alone.
    let imposter = envelope(DEV_TOKEN_PREFIX, w.ws, &random_secret());
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'door-fixture')",
    )
    .bind(w.ws)
    .bind(w.owner)
    .bind(&imposter)
    .execute(&w.su)
    .await
    .expect("plant a session row with a developer-shaped hash");
    assert_eq!(w.rows_hashing(&imposter).await, 1);
    assert_eq!(w.resolve(&imposter).await, DevResolution::Unknown);
    assert_eq!(w.http.get(&channels, Some(&imposter)).await, unknown);
}

// ---------------------------------------------------------------------------
// R2 (iii) — one 401
// ---------------------------------------------------------------------------

/// R2 (iii): expired, revoked, never issued, another workspace's (twice over), malformed in six ways
/// and a live refresh envelope — the status, every header and the body are the same bytes, and the same
/// as the answer to an unknown string and to plain garbage. The control: the live card and a
/// planted-the-same-way card of this workspace both get 200, so the planting technique makes
/// real rows and the 401s are the door's, not the fixture's.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R2)"]
async fn every_way_a_developer_token_can_fail_to_identify_is_the_same_401() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let (other_ws, other_owner) = w.foreign().await;
    let channels = w.channels_path();
    let secret = random_secret();

    let live = w.issue_card(w.owner, &DEV_SCOPES).await;
    let expired = w.issue_card(w.owner, &DEV_SCOPES).await;
    sqlx::query("UPDATE token SET expires_at = now() - interval '1 minute' WHERE id = $1")
        .bind(expired.id)
        .execute(&w.su)
        .await
        .expect("expire a card");
    let revoked = w.issue_card(w.owner, &DEV_SCOPES).await;
    sqlx::query("UPDATE token SET revoked_at = now() WHERE id = $1")
        .bind(revoked.id)
        .execute(&w.su)
        .await
        .expect("revoke a card");
    let login = w.issue_login(w.owner, &DEV_SCOPES).await;

    // A row of ANOTHER workspace whose hash is that of an envelope claiming THIS one: the hash
    // exists, behind the other tenant's row-level security.
    let claims_this = envelope(DEV_TOKEN_PREFIX, w.ws, &random_secret());
    w.plant_card_row(other_ws, other_owner, &claims_this, &DEV_SCOPES)
        .await;
    assert_eq!(
        w.rows_hashing(&claims_this).await,
        1,
        "the foreign row exists"
    );
    // …and its control: planted the same way in THIS workspace, a row is found.
    let planted_here = envelope(DEV_TOKEN_PREFIX, w.ws, &random_secret());
    w.plant_card_row(w.ws, w.owner, &planted_here, &DEV_SCOPES)
        .await;

    assert_eq!(w.http.get(&channels, Some(&live.secret)).await.status, 200);
    assert_eq!(
        w.http.get(&channels, Some(&planted_here)).await.status,
        200,
        "the control: the planting technique makes a working row"
    );

    let reference = unknown_token_answer(&w, &channels).await;
    let uppercase_workspace = format!(
        "{DEV_TOKEN_PREFIX}.{}.{secret}",
        w.ws.hyphenated().to_string().to_uppercase()
    );
    assert_ne!(
        uppercase_workspace,
        envelope(DEV_TOKEN_PREFIX, w.ws, &secret),
        "the upper-case spelling differs from the canonical one (a workspace id with a hex letter)"
    );
    let cases: Vec<(&str, String)> = vec![
        ("expired", expired.secret.clone()),
        ("revoked", revoked.secret.clone()),
        ("never issued", envelope(DEV_TOKEN_PREFIX, w.ws, &secret)),
        ("another workspace's row", claims_this),
        (
            "another workspace's secret relabelled to this one",
            // the foreign owner's real card, with its workspace segment rewritten to this one
            envelope(
                DEV_TOKEN_PREFIX,
                w.ws,
                secret_part(&plant_foreign_card(&w, other_ws, other_owner).await),
            ),
        ),
        (
            "not a uuid",
            format!("{DEV_TOKEN_PREFIX}.not-a-uuid.{secret}"),
        ),
        ("upper-case workspace id", uppercase_workspace),
        ("short secret", envelope(DEV_TOKEN_PREFIX, w.ws, "tooshort")),
        (
            "extra segment",
            format!("{}.extra", envelope(DEV_TOKEN_PREFIX, w.ws, &secret)),
        ),
        (
            "characters outside base64url",
            envelope(DEV_TOKEN_PREFIX, w.ws, &format!("{}+/=", &secret[..40])),
        ),
        ("prefix only", DEV_TOKEN_PREFIX.to_string()),
        ("a live refresh envelope", login.refresh.clone()),
        (
            "an unknown refresh envelope",
            envelope(DEV_REFRESH_PREFIX, w.ws, &secret),
        ),
    ];
    for (name, bearer) in &cases {
        let answer = w.http.get(&channels, Some(bearer)).await;
        assert_eq!(
            answer, reference,
            "{name}: not byte-for-byte the unknown-token 401"
        );
    }
}

/// A real card of the foreign workspace, as the foreign owner would hold it; returns its envelope.
async fn plant_foreign_card(w: &World, other_ws: Uuid, other_owner: Uuid) -> String {
    let raw = envelope(DEV_TOKEN_PREFIX, other_ws, &random_secret());
    w.plant_card_row(other_ws, other_owner, &raw, &DEV_SCOPES)
        .await;
    raw
}

// ---------------------------------------------------------------------------
// R1 (a) — not the Agent Port's credential
// ---------------------------------------------------------------------------

/// R1 (a): a card, an access, a refresh, and a card's secret relabelled as an agent bearer all get,
/// at `POST /v1/mcp/agent-port`, exactly the answer an unknown string gets — 401, the
/// `invalid_token` challenge, no body — and the developer rows are never touched. The control: a
/// real agent bearer with the connect scope on the same request is admitted (200).
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R1)"]
async fn a_developer_token_is_not_an_agent_port_credential() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let card = w.issue_card(w.owner, &DEV_SCOPES).await;
    let login = w.issue_login(w.owner, &DEV_SCOPES).await;

    let agent = seed_managed_agent(&w.su, w.ws, w.owner, "portbot").await;
    let agent_secret = random_secret();
    let agent_bearer = envelope(AGENT_BEARER_PREFIX, w.ws, &agent_secret);
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, subject_member_id, token_hash, \
                           scopes, label) \
         VALUES($1,'agent_bearer',$2,NULL,digest($3::text,'sha256'), \
                ARRAY['agent:port:connect']::text[],'door-fixture')",
    )
    .bind(w.ws)
    .bind(agent.id)
    .bind(&agent_bearer)
    .execute(&w.su)
    .await
    .expect("seed an agent bearer with the connect scope");

    let discover = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "server/discover",
        "params": {"_meta": {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {"name": "oort-dev-door-conformance", "version": "1.0.0"}
        }}
    });
    let post = |bearer: String| {
        let http = w.http.clone();
        let discover = discover.clone();
        async move {
            http.send_with(
                "POST",
                "/v1/mcp/agent-port",
                Some(&bearer),
                &[
                    ("content-type", "application/json"),
                    ("accept", "application/json, text/event-stream"),
                    ("mcp-protocol-version", "2026-07-28"),
                    ("mcp-method", "server/discover"),
                ],
                Some(&discover),
            )
            .await
        }
    };

    let unknown_agent = post(envelope(AGENT_BEARER_PREFIX, w.ws, &random_secret())).await;
    assert_eq!(unknown_agent.status, 401);
    assert_eq!(
        unknown_agent.header("www-authenticate"),
        Some("Bearer error=\"invalid_token\", scope=\"agent:port:connect\"")
    );
    assert!(unknown_agent.body.is_empty(), "no body to learn from");
    assert_eq!(
        post("not-a-token".to_string()).await,
        unknown_agent,
        "garbage and an unknown agent envelope are answered alike"
    );

    for (name, bearer) in [
        ("a card", card.secret.clone()),
        ("an access", login.access.clone()),
        ("a refresh", login.refresh.clone()),
        (
            "a card's secret relabelled as an agent bearer",
            envelope(AGENT_BEARER_PREFIX, w.ws, secret_part(&card.secret)),
        ),
    ] {
        assert_eq!(
            post(bearer).await,
            unknown_agent,
            "{name} at the Agent Port is an unknown string"
        );
    }
    // the developer rows were never seen by that door
    for token in [card.id, login.access_token_id, login.refresh_token_id] {
        assert!(!w.last_used(token).await, "{token} was touched");
        assert_eq!(
            w.audit_rows_via(token).await,
            0,
            "{token} left an audit row"
        );
    }

    // the control
    let admitted = post(agent_bearer).await;
    assert_eq!(admitted.status, 200, "{}", admitted.text());
    assert_eq!(admitted.json()["jsonrpc"], "2.0");
    assert!(
        admitted.json().get("error").is_none(),
        "{}",
        admitted.text()
    );
}

// ---------------------------------------------------------------------------
// R3 (b) — the contract files against the mounted router (no database)
// ---------------------------------------------------------------------------

/// `repo root / relative` — the contract files are data the ADR makes this test read (R3 (b)):
/// `docs/api/openapi.yaml` and `docs/api/openapi.undocumented-allowlist.json`; the operator spec
/// `docs/api/openapi.operator.yaml` is read as well, because its operations are real contract
/// the ADR's two-file union leaves out.
fn repo_file(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(relative)
}

/// `(METHOD, path)` of every operation under an OpenAPI file's `paths:`, with every `{name}`
/// normalised to `{}`. A line scan, because the files are generator-formatted (a path key at two
/// spaces, a method key at four, one `operationId` per operation at six) and no YAML parser is a
/// dependency of this crate. The scan is cross-checked against the `operationId` count, so a
/// reformatted file fails loudly instead of parsing to fewer operations than it declares.
fn spec_operations(relative: &str) -> BTreeSet<(String, String)> {
    const METHOD_KEYS: [&str; 8] = [
        "get", "put", "post", "delete", "options", "head", "patch", "trace",
    ];
    let text = std::fs::read_to_string(repo_file(relative))
        .unwrap_or_else(|error| panic!("read {relative}: {error}"));
    let mut in_paths = false;
    let mut path: Option<String> = None;
    let mut operations = BTreeSet::new();
    let (mut method_keys, mut operation_ids) = (0_usize, 0_usize);
    for line in text.lines() {
        if !in_paths {
            in_paths = line == "paths:";
            continue;
        }
        if !line.is_empty() && !line.starts_with(' ') && !line.starts_with('#') {
            break; // the next top-level key (`components:`)
        }
        if let Some(key) = line
            .strip_prefix("  /")
            .and_then(|rest| rest.strip_suffix(':'))
        {
            if !key.contains(' ') {
                path = Some(normalize_template(&format!("/{key}")));
                continue;
            }
        }
        if let Some(key) = line
            .strip_prefix("    ")
            .and_then(|rest| rest.strip_suffix(':'))
        {
            if METHOD_KEYS.contains(&key) {
                method_keys += 1;
                let path = path
                    .clone()
                    .unwrap_or_else(|| panic!("{relative}: a method key before any path"));
                operations.insert((key.to_uppercase(), path));
                continue;
            }
        }
        if line.starts_with("      operationId:") {
            operation_ids += 1;
        }
    }
    assert!(in_paths, "{relative}: no `paths:` block");
    assert_eq!(
        method_keys, operation_ids,
        "{relative}: the line scan found {method_keys} operations but the file declares {operation_ids} operationIds"
    );
    assert_eq!(
        operations.len(),
        method_keys,
        "{relative}: a (method, path) pair is declared twice"
    );
    operations
}

fn allowlist_operations() -> BTreeSet<(String, String)> {
    let relative = "docs/api/openapi.undocumented-allowlist.json";
    let text = std::fs::read_to_string(repo_file(relative))
        .unwrap_or_else(|error| panic!("read {relative}: {error}"));
    let file: Value = serde_json::from_str(&text).expect("the allow-list is JSON");
    file["operations"]
        .as_array()
        .expect("`operations` is a list")
        .iter()
        .map(|operation| {
            (
                operation["method"]
                    .as_str()
                    .expect("a method")
                    .to_uppercase(),
                normalize_template(operation["path"].as_str().expect("a path")),
            )
        })
        .collect()
}

/// A drift list: a reason, and the `(METHOD, normalised path)` pairs it explains.
type Drift = &'static [(&'static str, &'static [(&'static str, &'static str)])];

fn flatten(drift: Drift) -> BTreeSet<(String, String)> {
    let mut pairs = BTreeSet::new();
    for (reason, operations) in drift {
        assert!(!reason.is_empty(), "every drift group says why");
        for (method, path) in *operations {
            assert!(
                pairs.insert((method.to_string(), path.to_string())),
                "{method} {path} is listed twice"
            );
        }
    }
    pairs
}

fn show(pairs: &[&(String, String)]) -> String {
    pairs
        .iter()
        .map(|(method, path)| format!("    (\"{method}\", \"{path}\"),"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// **Drift that predates #4660**, found by this test on 2026-10-28 and written down rather than
/// fixed here: routes the router mounts that no contract file lists. The list is held EXACT — a
/// new mounted route without a contract entry is a red test, and so is an entry here that has
/// since been documented or unmounted (the list can only shrink). Not drift: the six
/// `dev-access` operations #4660 adds, which `docs/api/openapi.yaml` documents.
const MOUNTED_WITHOUT_CONTRACT: Drift = &[
    (
        "GitHub App integration (ADR-0205, #3947/#3954): mounted by build_app, listed in none of the three contract files",
        &[
            ("GET", "/v1/integrations/github/app"),
            ("PUT", "/v1/integrations/github/app"),
            ("GET", "/v1/integrations/github/app/callback"),
            ("POST", "/v1/integrations/github/app/manifest"),
            ("GET", "/v1/integrations/github/installations"),
            ("POST", "/v1/integrations/github/installations/{}/link"),
            ("GET", "/v1/integrations/github/setup"),
            ("POST", "/v1/integrations/github/webhook"),
            ("GET", "/v1/workspaces/{}/github"),
            ("POST", "/v1/workspaces/{}/github/link"),
            ("POST", "/v1/workspaces/{}/github/subscriptions"),
            ("DELETE", "/v1/workspaces/{}/github/subscriptions/{}"),
        ],
    ),
    (
        "Agent Port OAuth authorization server (ADR-0162 증보 1, HAP-E7): mounted unconditionally (it answers 404 while its flag is off), listed in none of the three contract files",
        &[
            ("GET", "/.well-known/oauth-authorization-server"),
            ("GET", "/.well-known/oauth-protected-resource/v1/mcp/agent-port"),
            ("GET", "/v1/oauth/authorize"),
            ("POST", "/v1/oauth/revoke"),
            ("POST", "/v1/oauth/token"),
            ("POST", "/v1/workspaces/{}/oauth/authorization-requests/approve"),
            ("POST", "/v1/workspaces/{}/oauth/authorization-requests/deny"),
            ("GET", "/v1/workspaces/{}/oauth/authorization-requests/preview"),
        ],
    ),
    (
        "liveness and the Centrifugo broker's proxy: the header of openapi.yaml says these remain intentionally undocumented there",
        &[
            ("GET", "/health"),
            ("GET", "/healthz"),
            ("POST", "/v1/centrifugo/subscribe"),
        ],
    ),
    (
        "other mounted surfaces listed in none of the three contract files (inbox — L7 of the developer table among them —, typing and availability, avatar, connector trial and owner, co-hosted agent connect and probe, work-session reattach)",
        &[
            ("PUT", "/v1/workspaces/{}/agents/{}/connector-owner"),
            ("GET", "/v1/workspaces/{}/agents/{}/connector-trial"),
            ("PUT", "/v1/workspaces/{}/agents/{}/connector-trial"),
            ("GET", "/v1/workspaces/{}/avatar/content"),
            ("POST", "/v1/workspaces/{}/avatar/uploads"),
            ("POST", "/v1/workspaces/{}/avatar/{}/complete"),
            ("POST", "/v1/workspaces/{}/channels/{}/availability"),
            ("POST", "/v1/workspaces/{}/channels/{}/typing"),
            ("POST", "/v1/workspaces/{}/channels/{}/typing/grant"),
            ("POST", "/v1/workspaces/{}/cohosted-agent/connect"),
            ("POST", "/v1/workspaces/{}/cohosted-agent/probe"),
            ("GET", "/v1/workspaces/{}/inbox"),
            ("POST", "/v1/workspaces/{}/inbox/read-all"),
            ("PUT", "/v1/workspaces/{}/inbox/{}/read"),
            ("GET", "/v1/workspaces/{}/work-sessions/{}/reattach"),
        ],
    ),
];

/// **Drift that predates #4660**, the other direction: operations a contract file declares that the
/// router mounts no such method for. Held exact in the same way.
const CONTRACT_WITHOUT_MOUNT: Drift = &[
    (
        "team-memory v1 operations in openapi.yaml (`…/memories…`, `memory-policy`, `memory-external-provider-consent`): the router mounts the redesigned `…/memory/*` surface instead",
        &[
            ("DELETE", "/v1/workspaces/{}/memories"),
            ("GET", "/v1/workspaces/{}/memories"),
            ("POST", "/v1/workspaces/{}/memories"),
            ("GET", "/v1/workspaces/{}/memories/search"),
            ("PATCH", "/v1/workspaces/{}/memories/{}"),
            ("DELETE", "/v1/workspaces/{}/memories/{}/grants"),
            ("GET", "/v1/workspaces/{}/memories/{}/grants"),
            ("POST", "/v1/workspaces/{}/memories/{}/grants"),
            ("POST", "/v1/workspaces/{}/memories/{}/invalidate"),
            ("GET", "/v1/workspaces/{}/memory-external-provider-consent"),
            ("PUT", "/v1/workspaces/{}/memory-external-provider-consent"),
            ("GET", "/v1/workspaces/{}/memory-policy"),
            ("PUT", "/v1/workspaces/{}/memory-policy"),
        ],
    ),
    (
        "notification v1 operations in openapi.yaml (`notification-prefs`, `notification-keywords`, `notification-diagnostics`): the router mounts `…/notification-rules` and `…/channels/{ch}/notification-pref` instead",
        &[
            ("GET", "/v1/workspaces/{}/notification-diagnostics"),
            ("POST", "/v1/workspaces/{}/notification-diagnostics/test"),
            ("GET", "/v1/workspaces/{}/notification-keywords"),
            ("PUT", "/v1/workspaces/{}/notification-keywords"),
            ("GET", "/v1/workspaces/{}/notification-prefs"),
            ("PATCH", "/v1/workspaces/{}/notification-prefs"),
        ],
    ),
    (
        "operations of openapi.undocumented-allowlist.json (frozen at MOMO-633 according to its own `_comment`) that the router no longer mounts",
        &[
            ("GET", "/v1/mcp"),
            ("GET", "/v1/mcp/tools"),
            ("POST", "/v1/mcp/tools/call"),
            ("GET", "/v1/platform/invites"),
            ("GET", "/v1/platform/members"),
            ("GET", "/v1/platform/workspaces"),
            ("POST", "/v1/provider/quota-snapshots"),
            ("GET", "/v1/workspaces/{}/channels/{}/cost-snapshots"),
        ],
    ),
    (
        "work, huddle, agent-card, presence and drive operations in openapi.yaml that build_app mounts no such method for (e.g. `work-tool-profiles` is mounted GET-only: 'Swift CRUD stays unported')",
        &[
            ("POST", "/v1/mcp/drive"),
            ("POST", "/v1/workspaces/{}/agents/from-card"),
            ("POST", "/v1/workspaces/{}/agents/from-card/{}/confirm"),
            ("GET", "/v1/workspaces/{}/audit"),
            ("GET", "/v1/workspaces/{}/context-packets/{}"),
            ("POST", "/v1/workspaces/{}/huddles/{}/recording-consent"),
            ("POST", "/v1/workspaces/{}/huddles/{}/recordings"),
            ("PUT", "/v1/workspaces/{}/presence/activity"),
            ("DELETE", "/v1/workspaces/{}/work-hosts/{}/cloud"),
            ("POST", "/v1/workspaces/{}/work-hosts/{}/cloud/pause"),
            ("POST", "/v1/workspaces/{}/work-hosts/{}/cloud/resume"),
            ("GET", "/v1/workspaces/{}/work-hosts/{}/live-sessions"),
            ("POST", "/v1/workspaces/{}/work-hosts/{}/reconcile"),
            ("GET", "/v1/workspaces/{}/work-pool"),
            ("PUT", "/v1/workspaces/{}/work-pool"),
            ("POST", "/v1/workspaces/{}/work-tool-profiles"),
            ("DELETE", "/v1/workspaces/{}/work-tool-profiles/{}"),
            ("PUT", "/v1/workspaces/{}/work-tool-profiles/{}"),
            ("GET", "/v1/workspaces/{}/workstreams"),
            ("GET", "/v1/workspaces/{}/workstreams/{}"),
            ("GET", "/v1/workspaces/{}/workstreams/{}/runs"),
        ],
    ),
];

/// R3 (b), the contract half. The ADR defines the sweep's universe as `openapi.yaml`'s operations
/// plus the allow-list's 28 and asks that the union cover every mounted route. It does not today —
/// so the sweeps above take their universe from the router itself (a strict superset of the union's
/// mounted part), and this test pins the disagreement instead of hiding it: the drift is exactly
/// what the two lists above say, in both directions.
#[tokio::test]
async fn the_contract_files_and_the_mounted_router_differ_only_by_the_drift_listed_here() {
    let router = build_app(lazy_state());
    let mounted: BTreeSet<(String, String)> = mounted_routes(&router)
        .iter()
        .flat_map(|route| {
            route
                .methods
                .iter()
                .map(|method| (method.to_string(), normalize_template(&route.template)))
        })
        .collect();
    let documented = spec_operations("docs/api/openapi.yaml");
    let operator = spec_operations("docs/api/openapi.operator.yaml");
    let allowlisted = allowlist_operations();
    assert!(
        documented.len() > 250,
        "{} operations in openapi.yaml",
        documented.len()
    );
    assert!(
        operator.len() >= 15,
        "{} operations in openapi.operator.yaml",
        operator.len()
    );
    assert_eq!(allowlisted.len(), 28, "the allow-list's 28 operations");
    assert!(
        allowlisted.contains(&(
            "POST".to_string(),
            "/v1/agent-runs/{}/approval-decisions".to_string()
        )),
        "ADR-0216 F18's example: the run decision route is one of the allow-list's operations"
    );

    let contract: BTreeSet<(String, String)> = documented
        .iter()
        .chain(&operator)
        .chain(&allowlisted)
        .cloned()
        .collect();
    let listed_undocumented = flatten(MOUNTED_WITHOUT_CONTRACT);
    let listed_unmounted = flatten(CONTRACT_WITHOUT_MOUNT);

    let mounted_without_contract: BTreeSet<(String, String)> =
        mounted.difference(&contract).cloned().collect();
    let contract_without_mount: BTreeSet<(String, String)> =
        contract.difference(&mounted).cloned().collect();

    let mut problems = Vec::new();
    for (label, actual, listed) in [
        (
            "mounted but in no contract file",
            &mounted_without_contract,
            &listed_undocumented,
        ),
        (
            "in a contract file but not mounted",
            &contract_without_mount,
            &listed_unmounted,
        ),
    ] {
        let new: Vec<_> = actual.difference(listed).collect();
        let stale: Vec<_> = listed.difference(actual).collect();
        if !new.is_empty() {
            problems.push(format!(
                "{label} — NOT in the drift list (document it, or list it with a reason):\n{}",
                show(&new)
            ));
        }
        if !stale.is_empty() {
            problems.push(format!(
                "{label} — listed, but no longer true (delete it from the list):\n{}",
                show(&stale)
            ));
        }
    }
    assert!(problems.is_empty(), "\n{}", problems.join("\n"));
}

// ---------------------------------------------------------------------------
// R3 (b) — the sweep with a live token, and nothing changes
// ---------------------------------------------------------------------------

/// R3 (b) on real rows: the most privileged developer token there can be — every dev scope, held by
/// the workspace owner — is sent to every mounted route that is not public with every method that is
/// not a table row. All refused by the door; the database is exactly what it was (no handler ran:
/// not a row, not an audit line), and the token was not even touched. The controls then walk the
/// table's own seven mounted pairs with the same token and real data: each is admitted and answers
/// as its handler does, `DELETE …/dev-access/self` last because it ends the token.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R3)"]
async fn a_live_token_is_refused_on_every_pair_off_the_table_and_the_database_is_unchanged() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let card = w.issue_card(w.owner, &DEV_SCOPES).await;
    let mounted = mounted_routes(&build_app(w.state.clone()));

    let before = w.fingerprint().await;
    let sweep = sweep_off_table_pairs(&w.http, &card.secret, w.ws, &mounted).await;
    assert!(
        sweep.problems.is_empty(),
        "{} pair(s) were not refused by the door:\n{}",
        sweep.problems.len(),
        sweep.problems.join("\n")
    );
    let protected = mounted
        .iter()
        .filter(|route| !is_public(&route.template))
        .count();
    assert_eq!(
        sweep.refused + sweep.table_pairs.len(),
        protected * SWEEP_METHODS.len(),
        "every protected template was visited with every method"
    );
    assert!(
        protected >= 200,
        "the router mounts at least 200 protected routes; saw {protected}"
    );
    assert_eq!(
        w.fingerprint().await,
        before,
        "no refused request changed a row the workspace owns"
    );
    assert!(
        !w.last_used(card.id).await,
        "a refusal does not touch the token"
    );
    assert_eq!(
        w.audit_rows_via(card.id).await,
        0,
        "a refusal writes nothing under the token"
    );
    // L1–L7 are mounted; L8 joins them when #4661 mounts `/v1/mcp/me` (and brings its own tests).
    let l8_mounted = mounted.iter().any(|route| route.template == L8_TEMPLATE);
    assert_eq!(
        sweep.table_pairs.len(),
        7 + usize::from(l8_mounted),
        "the table's pairs that the router mounts"
    );

    // The controls, with real data.
    let ws = w.ws;
    let bearer = Some(card.secret.as_str());
    let channel = w.channel;
    assert_eq!(
        w.http
            .get(&ws_path(ws, "/dev-access/self"), bearer)
            .await
            .status,
        200,
        "L1"
    );
    let channels = w.http.get(&w.channels_path(), bearer).await;
    assert_eq!(channels.status, 200, "L3: {}", channels.text());
    assert_eq!(
        w.http
            .get(
                &ws_path(ws, &format!("/channels/{channel}/messages")),
                bearer
            )
            .await
            .status,
        200,
        "L4"
    );
    let sent = w
        .http
        .send(
            "POST",
            &ws_path(ws, &format!("/channels/{channel}/messages")),
            bearer,
            Some(
                &json!({"clientMsgId": Uuid::new_v4(), "body": "안녕하세요, 달무리 스튜디오예요"}),
            ),
        )
        .await;
    assert_eq!(sent.status, 201, "L6: {}", sent.text());
    let root = sent.json()["id"]
        .as_str()
        .expect("the sent message's id")
        .to_string();
    let replies = w
        .http
        .get(
            &ws_path(ws, &format!("/channels/{channel}/messages/{root}/replies")),
            bearer,
        )
        .await;
    assert_eq!(replies.status, 200, "L5: {}", replies.text());
    assert_eq!(
        w.http.get(&ws_path(ws, "/inbox"), bearer).await.status,
        200,
        "L7"
    );
    assert!(
        w.last_used(card.id).await,
        "an admitted request does touch it"
    );

    // L2 last: it ends the token, and from then on the token is an unknown string.
    let logout = w
        .http
        .send("DELETE", &ws_path(ws, "/dev-access/self"), bearer, None)
        .await;
    assert_eq!(logout.status, 200, "L2: {}", logout.text());
    assert!(w.revoked(card.id).await);
    let unknown = unknown_token_answer(&w, &w.channels_path()).await;
    assert_eq!(
        w.http.get(&w.channels_path(), bearer).await,
        unknown,
        "a logged-out token is an unknown string"
    );
}

// ---------------------------------------------------------------------------
// R3 (c) — a variant of a path never reaches a handler the table did not open
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Hits {
    /// The handler of `…/channels/{ch}/messages` — L4, a row of the table.
    table: AtomicUsize,
    /// The handler of the static sibling `…/channels/archived/messages` — not on the table.
    sibling: AtomicUsize,
}

/// The two overlapping routes, behind the REAL door (`require_principal`, as a `route_layer`) on a
/// live pool, each counting the times its handler runs.
async fn serve_overlap_fixture(state: AppState, hits: Arc<Hits>) -> Http {
    let table_hits = hits.clone();
    let sibling_hits = hits;
    let router = Router::new()
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/messages",
            get(move || {
                let hits = table_hits.clone();
                async move {
                    hits.table.fetch_add(1, Ordering::SeqCst);
                    "table"
                }
            }),
        )
        .route(
            "/v1/workspaces/{ws}/channels/archived/messages",
            get(move || {
                let hits = sibling_hits.clone();
                async move {
                    hits.sibling.fetch_add(1, Ordering::SeqCst);
                    "sibling"
                }
            }),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            momo_server::auth::require_principal,
        ))
        .with_state(state);
    serve(router).await
}

/// R3 (c), on a fixture router: the table row `…/channels/{ch}/messages` has a static sibling
/// `…/channels/archived/messages` that is NOT a row. A developer token sent to the sibling — by
/// every method, with a query, naming another workspace, in a case variant, behind a trailing or a
/// doubled slash — never runs the sibling's handler; the door answers by the route the router
/// matched, not by the path's shape. The percent-encoded `%61rchived` is, to the router, an `{ch}`
/// value: it reaches the TABLE row's handler (which is its right), never the sibling's. The
/// controls: the same token on a plain `{ch}` path runs the table handler, and a session JWT on the
/// sibling runs the sibling handler — so both counters count, and 0 means 0.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R3)"]
async fn a_variant_of_a_table_path_never_reaches_a_handler_the_table_did_not_open() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let card = w.issue_card(w.owner, &DEV_SCOPES).await;
    let hits = Arc::new(Hits::default());
    let fixture = serve_overlap_fixture(w.state.clone(), hits.clone()).await;
    let bearer = Some(card.secret.as_str());
    let (ws, channel) = (w.ws, w.channel);
    let table_path = ws_path(ws, &format!("/channels/{channel}/messages"));
    let sibling_path = ws_path(ws, "/channels/archived/messages");

    // The control: a plain `{ch}` path is admitted and runs the table row's handler.
    let admitted = fixture.get(&table_path, bearer).await;
    assert_eq!(admitted.status, 200, "{}", admitted.text());
    assert_eq!(admitted.text(), "table");
    assert_eq!(hits.table.load(Ordering::SeqCst), 1);

    // The sibling, by every method the sweep uses: the door's own refusal, and no handler. (The
    // GET answer is the reference the HEAD answer is held to.)
    let refusal = fixture.get(&sibling_path, bearer).await;
    assert!(
        refusal.is_route_refusal(),
        "GET {sibling_path}: {} {}",
        refusal.status,
        refusal.text()
    );
    for method in SWEEP_METHODS {
        let answer = fixture.send(method, &sibling_path, bearer, None).await;
        let refused = if method == "HEAD" {
            answer.is_head_of(&refusal)
        } else {
            answer.same_refusal_as(&refusal)
        };
        assert!(
            refused,
            "{method} {sibling_path}: {} {}",
            answer.status,
            answer.text()
        );
    }
    // …with a query, and naming another workspace
    let with_query = fixture.get(&format!("{sibling_path}?x=1"), bearer).await;
    assert!(
        with_query.is_route_refusal(),
        "{} {}",
        with_query.status,
        with_query.text()
    );
    let other = Uuid::new_v4();
    let elsewhere = fixture
        .get(&ws_path(other, "/channels/archived/messages"), bearer)
        .await;
    assert!(
        elsewhere.is_route_refusal(),
        "{} {}",
        elsewhere.status,
        elsewhere.text()
    );
    // …and a TABLE path naming another workspace, or none: the table row alone is not enough, the
    // path's `{ws}` must be the token's own (D4). The control above (`table_path`) is admitted.
    for (name, path) in [
        (
            "a table path naming another workspace",
            ws_path(other, &format!("/channels/{channel}/messages")),
        ),
        (
            "a table path with an empty workspace segment",
            format!("/v1/workspaces//channels/{channel}/messages"),
        ),
    ] {
        let answer = fixture.get(&path, bearer).await;
        assert!(
            answer.is_route_refusal(),
            "{name}: {} {}",
            answer.status,
            answer.text()
        );
    }
    // …and with the workspace segment empty (matchit gives it to `{ws}`; the door refuses it)
    let no_workspace = fixture
        .get("/v1/workspaces//channels/archived/messages", bearer)
        .await;
    assert!(
        no_workspace.is_route_refusal(),
        "{} {}",
        no_workspace.status,
        no_workspace.text()
    );
    // HEAD and the rest on a row's own path: not the row's methods
    for method in ["HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"] {
        let answer = fixture.send(method, &table_path, bearer, None).await;
        let refused = if method == "HEAD" {
            answer.is_head_of(&refusal)
        } else {
            answer.same_refusal_as(&refusal)
        };
        assert!(
            refused,
            "{method} {table_path}: {} {}",
            answer.status,
            answer.text()
        );
    }
    assert_eq!(
        hits.table.load(Ordering::SeqCst),
        1,
        "only the control reached the table handler"
    );
    assert_eq!(
        hits.sibling.load(Ordering::SeqCst),
        0,
        "no handler of the sibling ran"
    );

    // Spellings the router does not match at all: no middleware, no handler — a plain 404 that is
    // the same bytes a request without any token gets (nothing the door could leak).
    for (name, path) in [
        ("trailing slash on the sibling", format!("{sibling_path}/")),
        ("trailing slash on a row", format!("{table_path}/")),
        (
            "upper-case route words",
            ws_path(ws, "/Channels/archived/messages"),
        ),
        ("leading double slash", format!("/{sibling_path}")),
        (
            "double slash inside the prefix",
            format!(
                "/v1//workspaces/{}/channels/archived/messages",
                ws.hyphenated()
            ),
        ),
        (
            "double slash after the workspace",
            format!(
                "/v1/workspaces/{}//channels/archived/messages",
                ws.hyphenated()
            ),
        ),
        (
            "double slash before the last segment",
            ws_path(ws, "/channels/archived//messages"),
        ),
        (
            "an encoded slash inside the sibling's segment",
            ws_path(ws, "/channels/archived%2Fmessages"),
        ),
    ] {
        let with_token = fixture.get(&path, bearer).await;
        let without = fixture.get(&path, None).await;
        assert_eq!(with_token.status, 404, "{name}: {}", with_token.text());
        assert_eq!(
            with_token, without,
            "{name}: the 404 does not depend on the credential"
        );
    }
    assert_eq!(hits.sibling.load(Ordering::SeqCst), 0);

    // Spellings the router reads as an `{ch}` value: the TABLE row's handler, never the sibling's.
    let before = hits.table.load(Ordering::SeqCst);
    for (name, path) in [
        ("%61rchived", ws_path(ws, "/channels/%61rchived/messages")),
        ("ARCHIVED", ws_path(ws, "/channels/ARCHIVED/messages")),
        (
            "archived%2Fx",
            ws_path(ws, "/channels/archived%2Fx/messages"),
        ),
        // matchit gives an empty segment to `{ch}` as well; the route handler judges the value
        (
            "an empty channel segment",
            ws_path(ws, "/channels//messages"),
        ),
    ] {
        let answer = fixture.get(&path, bearer).await;
        assert_eq!(answer.status, 200, "{name}: {}", answer.text());
        assert_eq!(answer.text(), "table", "{name} reached the row's handler");
    }
    assert_eq!(hits.table.load(Ordering::SeqCst), before + 4);
    assert_eq!(
        hits.sibling.load(Ordering::SeqCst),
        0,
        "an encoded or re-cased spelling never reaches the sibling"
    );

    // The other counter counts: a session JWT passes the door untouched and runs the sibling.
    let session = fixture.get(&sibling_path, Some(&w.owner_jwt)).await;
    assert_eq!(session.status, 200, "{}", session.text());
    assert_eq!(session.text(), "sibling");
    assert_eq!(hits.sibling.load(Ordering::SeqCst), 1);

    // The same spellings on the REAL router, by status: nothing 2xx that the table did not open.
    let real = |suffix: &str| ws_path(ws, &format!("/channels/{channel}/messages{suffix}"));
    assert_eq!(
        w.http.get(&real(""), bearer).await.status,
        200,
        "the control"
    );
    assert_eq!(
        w.http.get(&real("/"), bearer).await.status,
        404,
        "trailing slash"
    );
    // matchit hands an empty segment to `{ch}`: the table row's handler gets the request, and
    // refuses the value itself — the door admitted a row of the table, nothing more.
    let empty_segment = w
        .http
        .get(&ws_path(ws, "/channels//messages"), bearer)
        .await;
    assert_eq!(
        empty_segment.status,
        400,
        "an empty channel segment: {}",
        empty_segment.text()
    );
    assert_eq!(
        empty_segment.error_code(),
        None,
        "a handler's refusal, not the door's"
    );
    let put_refusal = w.http.send("PUT", &real(""), bearer, None).await;
    assert!(
        put_refusal.is_route_refusal(),
        "PUT on the real read route: {} {}",
        put_refusal.status,
        put_refusal.text()
    );
    assert!(
        w.http
            .send("HEAD", &real(""), bearer, None)
            .await
            .is_head_of(&put_refusal),
        "HEAD on the real read route"
    );
    for method in ["PATCH", "DELETE", "OPTIONS"] {
        assert!(
            w.http
                .send(method, &real(""), bearer, None)
                .await
                .same_refusal_as(&put_refusal),
            "{method} on the real read route"
        );
    }
}

// ---------------------------------------------------------------------------
// R3 (d) — a developer token cannot mint, list or revoke developer tokens
// ---------------------------------------------------------------------------

/// R3 (d): with every dev scope, a developer token is refused (403 `dev_route_not_allowed`) on the
/// four credential routes and on the policy route — and nothing happens: no `token` row appears, no
/// card is revoked. The controls: the same token's `…/dev-access/self` answers 200, and the
/// owner's SESSION JWT is admitted on the very same routes (200), so the routes exist and the 403
/// is the table's.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R3)"]
async fn a_developer_token_cannot_issue_list_or_revoke_developer_tokens() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let card = w.issue_card(w.owner, &DEV_SCOPES).await;
    let other = w.issue_card(w.owner, &DEV_SCOPES).await;
    let bearer = Some(card.secret.as_str());
    let ws = w.ws;
    let rows = |w: &World| {
        let (su, ws, owner) = (w.su.clone(), w.ws, w.owner);
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM token WHERE workspace_id = $1 AND actor_member_id = $2",
            )
            .bind(ws)
            .bind(owner)
            .fetch_one(&su)
            .await
            .expect("count the owner's tokens")
        }
    };
    let rows_before = rows(&w).await;

    let issue_body = json!({"name": "no", "tool": "cli", "currentPassword": "not-checked-here"});
    for (method, path, body) in [
        (
            "POST",
            ws_path(ws, "/dev-access/credentials"),
            Some(&issue_body),
        ),
        ("GET", ws_path(ws, "/dev-access/credentials"), None),
        (
            "GET",
            ws_path(ws, "/dev-access/credentials?scope=all"),
            None,
        ),
        (
            "DELETE",
            ws_path(ws, &format!("/dev-access/credentials/{}", other.id)),
            None,
        ),
        (
            "DELETE",
            ws_path(ws, &format!("/dev-access/credentials/{}", card.id)),
            None,
        ),
        ("GET", ws_path(ws, "/dev-access"), None),
    ] {
        let answer = w.http.send(method, &path, bearer, body).await;
        assert!(
            answer.is_route_refusal(),
            "{method} {path}: {} {}",
            answer.status,
            answer.text()
        );
    }
    assert_eq!(rows(&w).await, rows_before, "no token row was made");
    assert!(!w.revoked(other.id).await, "another card was not revoked");
    assert!(!w.revoked(card.id).await, "the card did not revoke itself");
    assert_eq!(
        w.http
            .get(&ws_path(ws, "/dev-access/self"), bearer)
            .await
            .status,
        200,
        "the control: the token is live and reads its own identity"
    );

    // The same routes are open to a person (the control that they exist and work).
    let session = Some(w.owner_jwt.as_str());
    for path in [
        ws_path(ws, "/dev-access"),
        ws_path(ws, "/dev-access/credentials"),
    ] {
        let answer = w.http.get(&path, session).await;
        assert_eq!(
            answer.status,
            200,
            "GET {path} with a session: {}",
            answer.text()
        );
    }
}

// ---------------------------------------------------------------------------
// the approval decisions, with a live token (layer one)
// ---------------------------------------------------------------------------

/// One decision route, a live all-scope token held by the owner: 403 `dev_route_not_allowed`, the
/// token untouched (the refusal is before the lookup), nothing recorded; and the same token is
/// admitted on a table route right after, so the refusal is the route's, not the token's. The
/// owner's SESSION on the same request is not refused by the door (the approval it names does not
/// exist, so the route answers 404): the route is alive, and the 403 is for developer tokens.
async fn assert_a_live_token_cannot_decide_at(path: impl Fn(&World, Uuid) -> String) {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let card = w.issue_card(w.owner, &DEV_SCOPES).await;
    let bearer = Some(card.secret.as_str());
    let approval = Uuid::new_v4();
    let path = path(&w, approval);
    let request = decision_request(approval);

    let refused = w.http.send("POST", &path, bearer, Some(&request)).await;
    assert!(
        refused.is_route_refusal(),
        "{} {}",
        refused.status,
        refused.text()
    );
    assert!(
        !w.last_used(card.id).await,
        "the refusal came before the lookup"
    );
    assert_eq!(w.audit_rows_via(card.id).await, 0);
    let decisions: i64 =
        sqlx::query_scalar("SELECT count(*) FROM approval_decision WHERE workspace_id = $1")
            .bind(w.ws)
            .fetch_one(&w.su)
            .await
            .expect("count decisions");
    assert_eq!(decisions, 0, "no decision was recorded");

    assert_eq!(
        w.http.get(&w.channels_path(), bearer).await.status,
        200,
        "the control: the same token is admitted on a table route"
    );
    assert!(w.last_used(card.id).await);

    let person = w
        .http
        .send("POST", &path, Some(&w.owner_jwt), Some(&request))
        .await;
    assert!(
        !person.is_route_refusal() && person.status == 404,
        "the owner's session reaches the route, which finds no such approval: {} {}",
        person.status,
        person.text()
    );
}

/// Layer one with a live token, `POST …/approvals/{approval}/decision`.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D4)"]
async fn a_live_developer_token_is_refused_on_the_approval_decision_route() {
    assert_a_live_token_cannot_decide_at(|w, approval| {
        ws_path(w.ws, &format!("/approvals/{approval}/decision"))
    })
    .await;
}

/// Layer one with a live token, `POST /v1/agent-runs/{run}/approval-decisions`.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D4)"]
async fn a_live_developer_token_is_refused_on_the_run_decision_route() {
    assert_a_live_token_cannot_decide_at(|_, _| {
        format!("/v1/agent-runs/{}/approval-decisions", Uuid::new_v4())
    })
    .await;
}

// ---------------------------------------------------------------------------
// R4 — the database's half
// ---------------------------------------------------------------------------

/// One `token` row to try to INSERT; every column the CHECKs of migration 152 read.
struct RowTry {
    kind: &'static str,
    scopes: Vec<String>,
    dev_form: Option<&'static str>,
    dev_tool: Option<&'static str>,
    with_channels: bool,
    dev_client: Option<&'static str>,
    dev_device_name: Option<&'static str>,
    with_lineage_cap: bool,
}

impl RowTry {
    /// A well-formed dev card row (the base every violation below departs from by ONE column).
    fn dev_card(scopes: &[&str]) -> RowTry {
        RowTry {
            kind: "dev",
            scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
            dev_form: Some("card"),
            dev_tool: Some("cli"),
            with_channels: false,
            dev_client: None,
            dev_device_name: None,
            with_lineage_cap: false,
        }
    }

    /// A well-formed row of another kind, with no developer column set.
    fn plain(kind: &'static str, scopes: &[&str]) -> RowTry {
        RowTry {
            kind,
            scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
            dev_form: None,
            dev_tool: None,
            with_channels: false,
            dev_client: None,
            dev_device_name: None,
            with_lineage_cap: false,
        }
    }
}

/// `Ok(())` when the row went in; otherwise the SQLSTATE and the constraint that refused it.
async fn insert_token_row(
    w: &World,
    actor: Uuid,
    row: &RowTry,
) -> Result<(), (String, Option<String>)> {
    let channels: Option<Vec<Uuid>> = row.with_channels.then(|| vec![w.channel]);
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           expires_at, dev_form, dev_tool, dev_channel_ids, dev_client, \
                           dev_device_name, dev_lineage_expires_at) \
         VALUES($1,$2::token_kind,$3,digest($4::text,'sha256'),$5,'door-check', \
                now() + interval '30 days',$6,$7,$8,$9,$10, \
                CASE WHEN $11 THEN now() + interval '1 day' END)",
    )
    .bind(w.ws)
    .bind(row.kind)
    .bind(actor)
    .bind(Uuid::new_v4().to_string())
    .bind(&row.scopes)
    .bind(row.dev_form)
    .bind(row.dev_tool)
    .bind(channels)
    .bind(row.dev_client)
    .bind(row.dev_device_name)
    .bind(row.with_lineage_cap)
    .execute(&w.su)
    .await
    .map(|_| ())
    .map_err(|error| {
        let database = error
            .as_database_error()
            .unwrap_or_else(|| panic!("a database error, got {error}"));
        (
            database
                .code()
                .map(|code| code.to_string())
                .unwrap_or_default(),
            database.constraint().map(str::to_string),
        )
    })
}

/// R4, in the database: a dev row can carry only the five dev scopes (and always `dev:identity`);
/// a row of any other kind carries no `dev:` scope and no developer column. Each violation departs
/// from a row that IS accepted by exactly one column, and must be refused by exactly the named
/// CHECK (SQLSTATE 23514) — so an unrelated mistake in the statement cannot pass for the rule.
/// And the database agrees with the code's constants: every `DEV_SCOPES` entry is accepted, every
/// scope the server already knows is refused on a dev row and accepted on any other.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R4)"]
async fn the_database_keeps_dev_scopes_on_dev_rows_and_dev_columns_off_every_other_row() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    const CHECK: &str = "23514";

    // The bases are accepted.
    insert_token_row(&w, w.owner, &RowTry::dev_card(&DEV_SCOPES))
        .await
        .expect("a dev card with all five scopes goes in");
    insert_token_row(&w, w.owner, &RowTry::dev_card(&DEV_READ_ONLY_SCOPES))
        .await
        .expect("a read-only dev card goes in");
    insert_token_row(
        &w,
        w.owner,
        &RowTry::plain("session", &["messages:read", "messages:write"]),
    )
    .await
    .expect("an ordinary session row goes in");
    insert_token_row(
        &w,
        w.owner,
        &RowTry::plain("agent_bearer", &["messages:write"]),
    )
    .await
    .expect("an ordinary agent bearer row goes in");

    // A dev row with a scope outside the dev namespace, or without `dev:identity`, or with the
    // reserved `dev:search`.
    for (name, scopes) in [
        ("an agent scope", vec!["messages:read"]),
        (
            "an agent scope beside dev:identity",
            vec!["dev:identity", "messages:write"],
        ),
        ("no dev:identity", vec!["dev:channels:read"]),
        (
            "the reserved dev:search",
            vec!["dev:identity", "dev:search"],
        ),
        ("a made-up dev scope", vec!["dev:identity", "dev:admin"]),
        ("an empty list", vec![]),
    ] {
        let row = RowTry::dev_card(&scopes);
        assert_eq!(
            insert_token_row(&w, w.owner, &row).await,
            Err((CHECK.to_string(), Some("token_dev_scopes_ck".to_string()))),
            "a dev row with {name}"
        );
    }

    // A row of any other kind with a `dev:` scope.
    for (kind, scopes) in [
        ("session", vec!["dev:identity"]),
        ("agent_bearer", vec!["dev:messages:write"]),
        ("session", vec!["messages:read", "dev:inbox:read"]),
    ] {
        assert_eq!(
            insert_token_row(&w, w.owner, &RowTry::plain(kind, &scopes)).await,
            Err((
                CHECK.to_string(),
                Some("token_non_dev_scopes_ck".to_string())
            )),
            "a {kind} row with {scopes:?}"
        );
    }

    // A row of any other kind with a developer column — each column alone.
    let mut form = RowTry::plain("session", &[]);
    form.dev_form = Some("card");
    assert_eq!(
        insert_token_row(&w, w.owner, &form).await,
        Err((CHECK.to_string(), Some("token_dev_form_ck".to_string()))),
        "a session row with dev_form"
    );
    for (name, edit) in [
        (
            "dev_tool",
            (|row: &mut RowTry| row.dev_tool = Some("cli")) as fn(&mut RowTry),
        ),
        ("dev_channel_ids", |row: &mut RowTry| {
            row.with_channels = true
        }),
        ("dev_client", |row: &mut RowTry| {
            row.dev_client = Some("oort-cli")
        }),
        ("dev_device_name", |row: &mut RowTry| {
            row.dev_device_name = Some("달무리 맥북")
        }),
        ("dev_lineage_expires_at", |row: &mut RowTry| {
            row.with_lineage_cap = true
        }),
    ] {
        let mut row = RowTry::plain("session", &[]);
        edit(&mut row);
        assert_eq!(
            insert_token_row(&w, w.owner, &row).await,
            Err((CHECK.to_string(), Some("token_dev_columns_ck".to_string()))),
            "a session row with {name}"
        );
    }

    // The database agrees with the code's constants.
    for scope in DEV_SCOPES {
        insert_token_row(&w, w.owner, &RowTry::dev_card(&["dev:identity", scope]))
            .await
            .unwrap_or_else(|error| {
                panic!("DEV_SCOPES lists {scope} but the CHECK refuses it: {error:?}")
            });
    }
    for scope in named_scopes() {
        assert_eq!(
            insert_token_row(
                &w,
                w.owner,
                &RowTry::dev_card(&["dev:identity", scope.as_str()])
            )
            .await,
            Err((CHECK.to_string(), Some("token_dev_scopes_ck".to_string()))),
            "a dev row may not carry the existing scope {scope}"
        );
        insert_token_row(&w, w.owner, &RowTry::plain("session", &[scope.as_str()]))
            .await
            .unwrap_or_else(|error| {
                panic!("a session row may carry the existing scope {scope}: {error:?}")
            });
    }
}
