//! ADR-0216 — a person issues, lists and revokes their own **developer tokens**
//! (`/v1/workspaces/{ws}/dev-access…`), and a developer token ends only itself. The route
//! rows of the red-proof table, on a real PostgreSQL and the real Axum router (`momo_app`,
//! NOBYPASSRLS): R5 (b)(d), R6 (what the answers and the audit rows carry), R7, R8 (a)(b), R21.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `the_secret_is_in_the_201_alone_and_in_no_list_whoami_or_audit_row` | R6: the 201 is `no-store` and holds the secret; the list, the whoami and every audit row of the workspace hold no 8-character piece of it, no form of its hash, no channel id; the list item and the whoami body have a closed key set; the same checks do find the secret in the 201 (so they can fail) | `no_store` leaves the issuing answer; a hash, the secret or the channel ids enter a DTO or a `detail`; an audit row records the password or the token |
//! | `expires_in_days_is_a_whole_number_of_one_to_ninety_and_omitted_means_thirty` | R5(b): 0, 91, -1, null, "30", 30.5, a huge number, true → 400 and no `token` row, even with a wrong password (the 400 comes before the comparison); omitted → exactly 30 days, 1 and 90 → exactly 1 and 90 days | the `null` arm is dropped (null becomes the default), the bound moves, the body is judged after the password |
//! | `the_twenty_first_card_is_a_409_until_one_is_revoked` | R5(d): 20 cards by the real route, the 21st → 409 `dev_credential_limit` with no new row; another member still issues; one revoked → the 21st is a 201 and the next is a 409 again | the limit is dropped or counted per workspace, a revoked card still counts |
//! | `a_missing_or_wrong_current_password_issues_nothing_and_a_wrong_one_leaves_one_denial_row` | R7: no `currentPassword` / an empty one → 400; a wrong one → 403 `current_password_incorrect` with one `dev_token.issue_denied` row (`password_mismatch`) per attempt; an account with no password → 403 `current_password_unavailable`; every refusal leaves the `token` rows as they were; the right one → 201; no password is ever stored in an audit row | the password check is not run, the denial row is not written, a refusal still inserts |
//! | `five_wrong_passwords_in_a_window_lock_the_member_out_even_for_the_right_one` | R7: a right password → 201 first, five wrong ones → 403 each, the sixth try → 429 + `Retry-After` and then **the right password is a 429 too**, no row and no denial row from a 429; another member in the same workspace is unaffected | the failure budget is dropped, the right password is compared in a full window, a right password spends a slot, the key is the workspace or the address |
//! | `only_owners_and_admins_may_issue_under_the_default_policy` | R8(a): owner and admin → 201 and the card works; member and guest → 403 `dev_access_denied`, no row, a `policy_denied` denial row, and the same 403 for a wrong password (no password oracle for a refused role); the domain function refuses them too (`PolicyDenied`) when called directly; `GET dev-access` says who can create and who can manage all | the switch is not judged at issuance (route: the wrong-password case turns into `current_password_incorrect`; function: the direct call issues), member is admitted, the password is compared before the role |
//! | `an_admin_demoted_to_member_is_refused_on_the_next_request_without_any_sweep` | R8(b): the demotion goes through the real role route, the card's row is **not** revoked, and its next request is 403 `dev_access_denied`; another admin's card still opens | the door stops judging the role on use |
//! | `the_ladder_decides_who_may_revoke_whose_and_a_hidden_card_is_the_same_404_as_no_card` | R21(a): a member or guest asking about someone else's card (a card, a login lineage) gets the same status, body bytes and headers as for an id that does not exist, and the card stays live; admin → owner's card 403; admin → member's/guest's 200; owner → anyone's 200 and a repeat 200 with one audit row; another workspace's id 404 and untouched | the ladder check is dropped from `revoke`, "hidden" becomes a distinguishable answer, the owner/workspace predicate is lost |
//! | `only_owners_and_admins_may_list_everyones_credentials` | R21(b): `?scope=all` → 403 for member and guest, 200 with everyone's cards for owner and admin; the default list is the caller's own; a revoked card leaves the list | the role check of `list` is dropped, the default list widens |
//! | `a_developer_token_logs_out_only_itself` | R21(c): `DELETE …/dev-access/self` ends the calling card (or the calling access token's whole lineage) and nothing else of the member — not their other cards or lineages, not their app session, not another member's — even when it is handed another id; a person's session gets 403 `dev_credential_required` | the logout takes an id, sweeps the member, or stops at one half of the lineage |
//! | `an_agent_member_never_holds_a_developer_token_the_function_and_the_trigger_each_refuse` | R21(d), R8(a): `issue_dev_card_in_tx` answers `NotHuman` for an agent member under both policies; a direct INSERT of a `dev` row for an agent is refused by the trigger (and the same INSERT for a human goes in); an agent's REST bearer cannot use the issuing route | the function accepts an agent member (alone: the function assertion is red), the trigger is dropped (alone: the INSERT assertion is red) |
//! | `a_developer_token_cannot_issue_list_or_revoke_developer_tokens` | R3(d)-adjacent: with a valid card the issuing, listing (own and all), policy and revoking routes → 403 `dev_route_not_allowed`, nothing issued or revoked, and the same calls with a person's session work | the table or the handlers' own refusal admits a developer token (both walls must fall for this to go red) |
//!
//! `#[ignore]` — needs a real PostgreSQL 18 + pgvector (superuser URL); run on an isolated database:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test dev_access_routes_conformance_pg -- --ignored --test-threads=1
//! ```

#[path = "common/apps_pg.rs"]
mod apps_pg;

use std::collections::BTreeSet;
use std::sync::OnceLock;

use apps_pg::*;
use momo_auth::{
    issue_dev_card_in_tx, issue_dev_login_in_tx, DevAccessPolicy, DevTool, IssuedDevCard,
    IssuedDevLogin, NewDevCard, NewDevLogin, DEV_READ_ONLY_SCOPES, DEV_TOKEN_PREFIX,
};
use momo_db::sqlx::{self, Row};
use momo_db::{with_tenant_tx, PgPool};
use reqwest::{Client, Method};
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

/// Fixture passwords: not secrets, made up for this file.
const PASSWORD: &str = "dalmuri-fixture-password-1";
const WRONG_PASSWORD: &str = "dalmuri-fixture-wrong-9";

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// The keys a list item may have (`DevCredentialDto`) and a whoami body may have
/// (`DevAccessSelfResponse`). Closed on purpose: a field nobody decided on — a hash, a secret,
/// the channel ids — is a red test, not a silent addition.
const LIST_ITEM_KEYS: &[&str] = &[
    "id",
    "memberId",
    "kind",
    "name",
    "tool",
    "scopes",
    "channelRestricted",
    "deviceName",
    "createdAtMs",
    "lastUsedAtMs",
    "expiresAtMs",
    "lineageExpiresAtMs",
];
const SELF_KEYS: &[&str] = &[
    "id",
    "kind",
    "name",
    "tool",
    "workspaceId",
    "memberId",
    "scopes",
    "channelRestricted",
    "deviceName",
    "createdAtMs",
    "expiresAtMs",
    "lastUsedAtMs",
    "lineageExpiresAtMs",
];

// ---------------------------------------------------------------------------
// the world: a workspace, a server, people
// ---------------------------------------------------------------------------

struct World {
    /// Superuser: seeds, and reads rows RLS would hide. Asserts nothing by itself.
    su: PgPool,
    /// `momo_app` (NOBYPASSRLS): what the server under test runs on, and what the domain
    /// functions are called with.
    app: PgPool,
    base: String,
    http: Client,
    workspace: Uuid,
}

#[derive(Clone)]
struct Person {
    id: Uuid,
    jwt: String,
}

/// A developer token the test holds: its row id and its envelope.
#[derive(Clone)]
struct Card {
    id: Uuid,
    secret: String,
}

impl Card {
    fn from_issue(reply: &Reply) -> Card {
        let body = reply.json();
        Card {
            id: body["id"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok())
                .expect("the 201 names the card by id"),
            secret: body["token"]
                .as_str()
                .expect("the 201 carries the secret")
                .to_string(),
        }
    }

    fn from_issued(issued: &IssuedDevCard) -> Card {
        Card {
            id: issued.id,
            secret: issued.secret.clone(),
        }
    }
}

/// What a client could tell two answers apart by: the status, the body bytes and the headers
/// that describe it.
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

    fn error_code(&self) -> Option<String> {
        self.json()["error"]["code"].as_str().map(str::to_owned)
    }

    fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    }

    /// Everything a client could tell two refusals apart by (`date` and the like are left
    /// out — they differ between any two answers).
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
        ]
        .into_iter()
        .map(|name| (name, self.header(name)))
        .collect();
        (self.status, self.body.clone(), headers)
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

fn dev_path(workspace: Uuid, tail: &str) -> String {
    format!("/v1/workspaces/{workspace}/dev-access{tail}")
}

fn issue_body(name: &str, password: &str) -> Value {
    json!({"name": name, "tool": "claude_code", "currentPassword": password})
}

impl World {
    async fn boot() -> World {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let app = momo_app_pool().await;
        let workspace = seed_workspace(&su).await;
        let base = start_server(app.clone(), ServerOptions::default()).await;
        World {
            su,
            app,
            base,
            http: Client::new(),
            workspace,
        }
    }

    /// A person of `role` in `workspace`, signed in, with a known password (`None`: an account
    /// that signed in without one). `seed_human` records the session row as `label='apps-pg'`;
    /// the issuing route asks whether the calling session is a live person's *access* row
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

    // ---- HTTP ----

    async fn send(&self, method: Method, path: &str, bearer: &str, body: Option<Value>) -> Reply {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(bearer);
        if let Some(body) = body {
            request = request.json(&body);
        }
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

    async fn issue_with(&self, who: &Person, body: Value) -> Reply {
        self.send(
            Method::POST,
            &dev_path(self.workspace, "/credentials"),
            &who.jwt,
            Some(body),
        )
        .await
    }

    async fn issue_as(&self, who: &Person, name: &str, password: &str) -> Reply {
        self.issue_with(who, issue_body(name, password)).await
    }

    /// A card through the real route, with the right password. Asserts the 201.
    async fn issue_card(&self, who: &Person, name: &str) -> Card {
        let reply = self.issue_as(who, name, PASSWORD).await;
        expect_status(&reply, 201, "issuing a card");
        Card::from_issue(&reply)
    }

    async fn list(&self, bearer: &str, query: &str) -> Reply {
        self.send(
            Method::GET,
            &format!("{}{query}", dev_path(self.workspace, "/credentials")),
            bearer,
            None,
        )
        .await
    }

    async fn revoke(&self, bearer: &str, id: Uuid) -> Reply {
        self.send(
            Method::DELETE,
            &dev_path(self.workspace, &format!("/credentials/{id}")),
            bearer,
            None,
        )
        .await
    }

    async fn policy(&self, bearer: &str) -> Reply {
        self.send(Method::GET, &dev_path(self.workspace, ""), bearer, None)
            .await
    }

    async fn whoami_in(&self, workspace: Uuid, bearer: &str) -> Reply {
        self.send(Method::GET, &dev_path(workspace, "/self"), bearer, None)
            .await
    }

    async fn whoami(&self, bearer: &str) -> Reply {
        self.whoami_in(self.workspace, bearer).await
    }

    async fn logout(&self, bearer: &str) -> Reply {
        self.send(
            Method::DELETE,
            &dev_path(self.workspace, "/self"),
            bearer,
            None,
        )
        .await
    }

    // ---- the database, read back with the superuser ----

    /// Every `dev` row the member owns, revoked or not.
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

    /// The member's cards that can still authenticate (not revoked, not expired).
    async fn live_cards(&self, member: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM token \
              WHERE workspace_id = $1 AND actor_member_id = $2 AND kind::text = 'dev' \
                AND dev_form = 'card' AND revoked_at IS NULL AND expires_at > now()",
        )
        .bind(self.workspace)
        .bind(member)
        .fetch_one(&self.su)
        .await
        .expect("count live cards")
    }

    async fn is_revoked(&self, token: Uuid) -> bool {
        sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM token WHERE id = $1")
            .bind(token)
            .fetch_one(&self.su)
            .await
            .expect("read a token row")
    }

    /// Live rows of one login lineage (access and refresh halves).
    async fn live_lineage_rows(&self, workspace: Uuid, session: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM token \
              WHERE workspace_id = $1 AND session_id = $2 AND kind::text = 'dev' \
                AND revoked_at IS NULL",
        )
        .bind(workspace)
        .bind(session)
        .fetch_one(&self.su)
        .await
        .expect("count live lineage rows")
    }

    async fn audit(&self, action: &str) -> Vec<AuditRow> {
        sqlx::query(
            "SELECT actor_member_id, subject_member_id, target_type, target_id, via_token_id, \
                    detail::text AS detail \
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
            via_token: row.get("via_token_id"),
            detail: serde_json::from_str(&row.get::<String, _>("detail")).expect("detail is JSON"),
        })
        .collect()
    }

    /// Every audit row of the workspace, whole, as one string: the haystack for "no piece of
    /// the secret is in any row".
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

    /// How a stored hash could be written down: hex, base64 with and without padding.
    async fn hash_forms(&self, token: Uuid) -> Vec<String> {
        let row = sqlx::query(
            "SELECT encode(token_hash, 'hex') AS hex, encode(token_hash, 'base64') AS b64 \
               FROM token WHERE id = $1",
        )
        .bind(token)
        .fetch_one(&self.su)
        .await
        .expect("read a token hash");
        let hex: String = row.get("hex");
        let b64: String = row.get("b64");
        vec![
            hex.to_uppercase(),
            hex,
            b64.trim_end_matches('=').to_string(),
            b64,
        ]
    }

    /// Change a role the way a demotion leaves the rows: nothing is swept (the route that
    /// would sweep is not the subject here; the real role route is used where its behaviour
    /// is the point).
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

    /// A card for a member through the domain function — the fast way to a row the issuing
    /// route would also make. A member or guest cannot get one under the shipped switch
    /// (`admins`); the fixtures that need one issue it while the person is an admin and
    /// demote them afterwards, which is also how such a card exists in a real workspace.
    async fn card_by_function(&self, member: Uuid, name: &str) -> Card {
        let issued = issue_by_function(
            &self.app,
            self.workspace,
            member,
            DevAccessPolicy::Admins,
            name,
        )
        .await
        .expect("the domain issues a card for an owner or admin");
        Card::from_issued(&issued)
    }

    async fn login_by_function(&self, member: Uuid, name: &str) -> IssuedDevLogin {
        login_by_function_in(&self.app, self.workspace, member, name).await
    }
}

struct AuditRow {
    actor: Option<Uuid>,
    subject: Option<Uuid>,
    target_type: Option<String>,
    target_id: Option<Uuid>,
    via_token: Option<Uuid>,
    detail: Value,
}

/// `issue_dev_card_in_tx` as the issuing route calls it, in a tenant transaction on `momo_app`.
/// `Err` carries what refused it, as text.
async fn issue_by_function(
    app: &PgPool,
    workspace: Uuid,
    member: Uuid,
    policy: DevAccessPolicy,
    name: &str,
) -> Result<IssuedDevCard, String> {
    let card = NewDevCard {
        label: name.to_string(),
        tool: DevTool::ClaudeCode,
        scopes: DEV_READ_ONLY_SCOPES
            .iter()
            .map(|scope| scope.to_string())
            .collect(),
        channel_ids: None,
        expires_in_days: 30,
    };
    let outcome = with_tenant_tx(app, workspace, move |conn| {
        Box::pin(
            async move { Ok(issue_dev_card_in_tx(conn, workspace, member, &card, policy).await?) },
        )
    })
    .await;
    match outcome {
        Ok(Ok(issued)) => Ok(issued),
        Ok(Err(refusal)) => Err(format!("{refusal:?}")),
        Err(error) => Err(format!("database error: {error}")),
    }
}

/// One login lineage (access + refresh) for `member`, through the domain function.
async fn login_by_function_in(
    app: &PgPool,
    workspace: Uuid,
    member: Uuid,
    name: &str,
) -> IssuedDevLogin {
    let login = NewDevLogin {
        label: name.to_string(),
        tool: DevTool::Cli,
        client: "oort-cli".to_string(),
        device_name: Some("달무리 노트북".to_string()),
        scopes: DEV_READ_ONLY_SCOPES
            .iter()
            .map(|scope| scope.to_string())
            .collect(),
        channel_ids: None,
    };
    with_tenant_tx(app, workspace, move |conn| {
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

// ---------------------------------------------------------------------------
// the checks that must be able to fail
// ---------------------------------------------------------------------------

/// The secret field of an envelope `momo_dev_v1.<workspace>.<43 characters>`.
fn secret_part(envelope: &str) -> &str {
    envelope
        .rsplit('.')
        .next()
        .expect("an envelope has a secret field")
}

/// The envelope shape a client is handed: prefix, this workspace, 43 base64url characters.
fn is_envelope_of(envelope: &str, workspace: Uuid) -> bool {
    let fields: Vec<&str> = envelope.split('.').collect();
    fields.len() == 3
        && fields[0] == DEV_TOKEN_PREFIX
        && fields[1] == workspace.to_string()
        && fields[2].len() == 43
        && fields[2]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The first piece of the envelope found in `haystack`: the whole envelope, or any eight
/// consecutive characters of its secret (the front eight included). Eight random base64url
/// characters meet by chance with probability ~3e-15, so a hit is the secret.
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

fn collect_keys(value: &Value, keys: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                keys.insert(key.clone());
                collect_keys(inner, keys);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_keys(item, keys)),
        _ => {}
    }
}

/// Keys that would carry a secret, a hash, a password or the channel ids a card is limited
/// to — wherever they sit in a body.
fn secret_bearing_keys(value: &Value) -> Vec<String> {
    let mut keys = BTreeSet::new();
    collect_keys(value, &mut keys);
    keys.into_iter()
        .filter(|key| {
            let lowered = key.to_ascii_lowercase();
            lowered == "token"
                || lowered.contains("hash")
                || lowered.contains("secret")
                || lowered.contains("password")
                || lowered == "channelids"
                || lowered == "channel_ids"
        })
        .collect()
}

fn keys_of(value: &Value) -> BTreeSet<String> {
    value
        .as_object()
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

fn ids_in_list(reply: &Reply) -> BTreeSet<Uuid> {
    reply.json()["credentials"]
        .as_array()
        .expect("a list answer has `credentials`")
        .iter()
        .map(|item| {
            Uuid::parse_str(item["id"].as_str().expect("an item has an id"))
                .expect("the id is a uuid")
        })
        .collect()
}

fn set_of(ids: &[Uuid]) -> BTreeSet<Uuid> {
    ids.iter().copied().collect()
}

// ---------------------------------------------------------------------------
// R6 — what the answers and the audit rows carry
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4660)"]
async fn the_secret_is_in_the_201_alone_and_in_no_list_whoami_or_audit_row() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let channel = seed_channel(&w.su, w.workspace, "public", &[owner.id]).await;

    // The first card: restricted to one channel, with the write scope on top of the preset.
    let first_reply = w
        .issue_with(
            &owner,
            json!({
                "name": "이도현의 노트북", "tool": "claude_code",
                "scopes": ["dev:channels:read", "dev:messages:write"],
                "channelIds": [channel], "currentPassword": PASSWORD,
            }),
        )
        .await;
    expect_status(&first_reply, 201, "issuing the first card");
    let cache_control = first_reply.header("cache-control").unwrap_or_default();
    assert!(
        cache_control
            .split(',')
            .any(|directive| directive.trim().eq_ignore_ascii_case("no-store")),
        "the 201 that carries a secret is `no-store`, got `{cache_control}`"
    );
    let first = Card::from_issue(&first_reply);
    let issued = first_reply.json();
    assert!(
        is_envelope_of(&first.secret, w.workspace),
        "the secret is `momo_dev_v1.<this workspace>.<43 characters>`"
    );
    assert_eq!(issued["kind"], "card");
    assert_eq!(issued["name"], "이도현의 노트북");
    assert_eq!(issued["tool"], "claude_code");
    assert_eq!(
        issued["scopes"],
        json!(["dev:identity", "dev:channels:read", "dev:messages:write"]),
        "`dev:identity` is always on, in table order"
    );
    assert_eq!(
        issued["channelIds"],
        json!([channel.to_string()]),
        "the maker's own choice is echoed once, in the 201"
    );

    // A second card; each secret is in its own 201 and in no other answer.
    let second_reply = w.issue_as(&owner, "이도현의 Codex", PASSWORD).await;
    expect_status(&second_reply, 201, "issuing the second card");
    let second = Card::from_issue(&second_reply);
    assert_ne!(first.secret, second.secret, "every card has its own secret");
    assert_eq!(
        leaked_piece(&second_reply.text(), &first.secret),
        None,
        "the first card's secret is not in the second card's 201"
    );
    assert_eq!(
        leaked_piece(&first_reply.text(), &second.secret),
        None,
        "the second card's secret is not in the first card's 201"
    );

    // The checks below can fail: they find the secret, and the secret-bearing keys, in the 201.
    assert!(
        leaked_piece(&first_reply.text(), &first.secret).is_some(),
        "control: the piece finder sees the secret where it is"
    );
    let in_the_201 = secret_bearing_keys(&issued);
    assert!(
        in_the_201.contains(&"token".to_string()) && in_the_201.contains(&"channelIds".to_string()),
        "control: the key finder sees `token` and `channelIds` in the 201, got {in_the_201:?}"
    );

    // What must not be in any later answer or row.
    let mut never: Vec<String> = Vec::new(); // whole values: hashes, channel ids, passwords
    for card in [&first, &second] {
        never.extend(w.hash_forms(card.id).await);
    }
    never.push(channel.to_string());
    never.push(PASSWORD.to_string());
    let assert_clean = |what: &str, text: &str| {
        for card in [&first, &second] {
            assert_eq!(
                leaked_piece(text, &card.secret),
                None,
                "{what} holds a piece of a card's secret"
            );
        }
        for value in &never {
            assert!(
                !text.contains(value.as_str()),
                "{what} holds `{value}` (a hash form, the channel id or the password)"
            );
        }
    };

    // The list: both cards, no secret, no hash, no channel ids, only whether there is a limit.
    let listed = w.list(&owner.jwt, "").await;
    expect_status(&listed, 200, "listing my cards");
    assert!(
        listed
            .header("cache-control")
            .unwrap_or_default()
            .contains("no-store"),
        "the list is `no-store` too"
    );
    assert_clean("the list", &listed.text());
    let listed_json = listed.json();
    assert_eq!(
        secret_bearing_keys(&listed_json),
        Vec::<String>::new(),
        "no key of the list names a secret, a hash, a password or channel ids"
    );
    let items = listed_json["credentials"]
        .as_array()
        .expect("`credentials` is a list");
    assert_eq!(items.len(), 2, "both cards are listed (control)");
    for item in items {
        let extra: Vec<String> = keys_of(item)
            .into_iter()
            .filter(|key| !LIST_ITEM_KEYS.contains(&key.as_str()))
            .collect();
        assert!(
            extra.is_empty(),
            "a list item has keys nobody decided on: {extra:?}"
        );
    }
    let first_item = items
        .iter()
        .find(|item| item["id"] == first.id.to_string())
        .expect("the first card is in the list");
    assert_eq!(first_item["name"], "이도현의 노트북");
    assert_eq!(first_item["memberId"], owner.id.to_string());
    assert_eq!(
        first_item["channelRestricted"], true,
        "the list says there is a limit"
    );
    let second_item = items
        .iter()
        .find(|item| item["id"] == second.id.to_string())
        .expect("the second card is in the list");
    assert_eq!(second_item["name"], "이도현의 Codex");
    assert_eq!(second_item["channelRestricted"], false);

    // The whoami of the first card.
    let me = w.whoami(&first.secret).await;
    expect_status(&me, 200, "whoami with the first card");
    assert!(
        me.header("cache-control")
            .unwrap_or_default()
            .contains("no-store"),
        "whoami is `no-store` too"
    );
    assert_clean("the whoami", &me.text());
    let me_json = me.json();
    assert_eq!(secret_bearing_keys(&me_json), Vec::<String>::new());
    let extra: Vec<String> = keys_of(&me_json)
        .into_iter()
        .filter(|key| !SELF_KEYS.contains(&key.as_str()))
        .collect();
    assert!(
        extra.is_empty(),
        "the whoami has keys nobody decided on: {extra:?}"
    );
    assert_eq!(me_json["id"], first.id.to_string());
    assert_eq!(me_json["name"], "이도현의 노트북");
    assert_eq!(me_json["workspaceId"], w.workspace.to_string());
    assert_eq!(me_json["memberId"], owner.id.to_string());
    assert_eq!(me_json["channelRestricted"], true);

    // Every audit row of the workspace, the door's `used` row for that whoami included.
    let audit_text = w.audit_text().await;
    assert_clean("the audit log", &audit_text);
    let issued_rows = w.audit("dev_token.issued").await;
    assert_eq!(
        issued_rows
            .iter()
            .filter_map(|row| row.target_id)
            .collect::<BTreeSet<_>>(),
        set_of(&[first.id, second.id]),
        "control: one `dev_token.issued` row per card, naming it by id"
    );
    assert!(
        issued_rows
            .iter()
            .all(|row| row.detail["kind"] == "card"
                && row.detail.get("channel_restricted").is_some()),
        "the issuing row says whether the card is limited, not to which channels"
    );
    let used_rows = w.audit("auth.dev_token.used").await;
    assert_eq!(
        used_rows
            .iter()
            .filter_map(|row| row.via_token)
            .collect::<Vec<_>>(),
        vec![first.id],
        "control: the whoami left one `used` row, by the first card"
    );
}

// ---------------------------------------------------------------------------
// R5 (b) — the lifetime
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4660)"]
async fn expires_in_days_is_a_whole_number_of_one_to_ninety_and_omitted_means_thirty() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;

    let refused: Vec<(&str, Value)> = vec![
        ("0", json!(0)),
        ("91", json!(91)),
        ("-1", json!(-1)),
        ("null", Value::Null),
        ("a string", json!("30")),
        ("a fraction", json!(30.5)),
        ("far too many", json!(100_000_000_000_i64)),
        ("a boolean", json!(true)),
    ];
    for (what, days) in &refused {
        let mut body = issue_body("이도현의 노트북", PASSWORD);
        body["expiresInDays"] = days.clone();
        let reply = w.issue_with(&owner, body).await;
        expect_status(&reply, 400, &format!("expiresInDays {what}"));
    }
    // The body is judged before the password is compared: a wrong password does not turn the
    // 400 into a 403, and a 400 spends nothing and writes no denial row.
    let mut wrong_and_invalid = issue_body("이도현의 노트북", WRONG_PASSWORD);
    wrong_and_invalid["expiresInDays"] = json!(91);
    let reply = w.issue_with(&owner, wrong_and_invalid).await;
    expect_status(&reply, 400, "an invalid lifetime with a wrong password");
    assert_eq!(
        w.dev_rows(owner.id).await,
        0,
        "no refused lifetime inserted a row"
    );
    assert!(
        w.audit("dev_token.issue_denied").await.is_empty(),
        "a refused body is not a denied issuance: nothing was compared"
    );

    // What is accepted: omitted is 30 days; 1 and 90 are the two ends.
    let cases: [(Option<i64>, i64); 3] = [(None, 30), (Some(1), 1), (Some(90), 90)];
    for (requested, days) in cases {
        let mut body = issue_body("이도현의 노트북", PASSWORD);
        if let Some(requested) = requested {
            body["expiresInDays"] = json!(requested);
        }
        let reply = w.issue_with(&owner, body).await;
        expect_status(&reply, 201, &format!("expiresInDays {requested:?}"));
        let card = Card::from_issue(&reply);
        let created = reply.json()["createdAtMs"].as_i64().expect("createdAtMs");
        let expires = reply.json()["expiresAtMs"].as_i64().expect("expiresAtMs");
        assert_eq!(
            expires - created,
            days * DAY_MS,
            "{requested:?} → exactly {days} days in the 201"
        );
        let stored: i64 = sqlx::query_scalar(
            "SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::bigint FROM token WHERE id = $1",
        )
        .bind(card.id)
        .fetch_one(&w.su)
        .await
        .expect("read the stored lifetime");
        assert_eq!(
            stored,
            days * 24 * 60 * 60,
            "{requested:?} → exactly {days} days in the row"
        );
    }
    assert_eq!(
        w.dev_rows(owner.id).await,
        3,
        "only the three accepted ones"
    );
}

// ---------------------------------------------------------------------------
// R5 (d) — twenty live cards a member
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4660)"]
async fn the_twenty_first_card_is_a_409_until_one_is_revoked() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;

    let mut cards = Vec::new();
    for number in 1..=20 {
        cards.push(w.issue_card(&owner, &format!("카드 {number}")).await);
    }
    assert_eq!(w.live_cards(owner.id).await, 20, "twenty cards, the limit");

    let refused = w.issue_as(&owner, "카드 21", PASSWORD).await;
    expect_code(&refused, 409, "dev_credential_limit", "the 21st card");
    assert_eq!(
        refused.json().get("token"),
        None,
        "a refused issuance hands out no secret"
    );
    assert_eq!(w.dev_rows(owner.id).await, 20, "the 409 inserted nothing");

    // The limit is the member's own.
    let others = w.issue_card(&admin, "박서연의 노트북").await;
    expect_status(
        &w.whoami(&others.secret).await,
        200,
        "another member's card works while the owner is at the limit",
    );

    // One revoked: the next one fits, and then the limit holds again.
    let revoked = w.revoke(&owner.jwt, cards[0].id).await;
    expect_status(&revoked, 200, "revoking one of the twenty");
    assert_eq!(revoked.json()["revokedNow"], true);
    assert_eq!(w.live_cards(owner.id).await, 19);
    let again = w.issue_card(&owner, "카드 21 다시").await;
    expect_status(
        &w.whoami(&again.secret).await,
        200,
        "the card that fit after a revoke works",
    );
    assert_eq!(w.live_cards(owner.id).await, 20);
    let refused_again = w.issue_as(&owner, "카드 22", PASSWORD).await;
    expect_code(
        &refused_again,
        409,
        "dev_credential_limit",
        "the card after that",
    );
    assert_eq!(
        w.dev_rows(owner.id).await,
        21,
        "twenty live and the one revoked; the two 409s inserted nothing"
    );
}

// ---------------------------------------------------------------------------
// R7 — the current password
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4660)"]
async fn a_missing_or_wrong_current_password_issues_nothing_and_a_wrong_one_leaves_one_denial_row()
{
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let sso = w
        .person_in(w.workspace, "admin", "박서연", None) // signed in without a password
        .await;
    let mut answers: Vec<String> = Vec::new();

    // (i) No password in the body: a closed body is a 400 before anything is compared.
    let mut absent = issue_body("이도현의 노트북", PASSWORD);
    absent
        .as_object_mut()
        .expect("an object")
        .remove("currentPassword");
    let reply = w.issue_with(&owner, absent).await;
    expect_status(&reply, 400, "no currentPassword");
    answers.push(reply.text());
    let reply = w.issue_as(&owner, "이도현의 노트북", "").await;
    expect_status(&reply, 400, "an empty currentPassword");
    answers.push(reply.text());
    assert_eq!(w.dev_rows(owner.id).await, 0, "no password, no card");

    // (ii) A wrong password: 403, no row, one denial row per attempt.
    for attempt in 1..=2 {
        let reply = w.issue_as(&owner, "이도현의 노트북", WRONG_PASSWORD).await;
        expect_code(
            &reply,
            403,
            "current_password_incorrect",
            "a wrong current password",
        );
        answers.push(reply.text());
        assert_eq!(
            w.dev_rows(owner.id).await,
            0,
            "a wrong password inserted a row (attempt {attempt})"
        );
        let denials = w.audit("dev_token.issue_denied").await;
        assert_eq!(
            denials.len(),
            attempt,
            "one `dev_token.issue_denied` row per wrong attempt"
        );
        let newest = denials.last().expect("a denial row");
        assert_eq!(newest.actor, Some(owner.id));
        assert_eq!(newest.detail["reason"], "password_mismatch");
        assert_eq!(newest.detail["schema"], "momo.dev_token.issue_denied.v1");
    }

    // (iii) An account with no password to confirm: 403 with its own code and reason.
    let reply = w.issue_as(&sso, "박서연의 노트북", PASSWORD).await;
    expect_code(
        &reply,
        403,
        "current_password_unavailable",
        "an account with no password",
    );
    answers.push(reply.text());
    assert_eq!(w.dev_rows(sso.id).await, 0);
    let denials = w.audit("dev_token.issue_denied").await;
    let sso_denial = denials
        .iter()
        .find(|row| row.actor == Some(sso.id))
        .expect("the passwordless account's refusal is recorded too");
    assert_eq!(sso_denial.detail["reason"], "password_unavailable");

    // The right password, on the same route, the same person: the card.
    let reply = w.issue_as(&owner, "이도현의 노트북", PASSWORD).await;
    expect_status(&reply, 201, "the right password");
    answers.push(
        reply
            .text()
            .replace(&Card::from_issue(&reply).secret, "<secret>"),
    );
    assert_eq!(
        w.dev_rows(owner.id).await,
        1,
        "exactly the one right attempt"
    );
    assert_eq!(
        w.audit("dev_token.issue_denied")
            .await
            .iter()
            .filter(|row| row.actor == Some(owner.id))
            .count(),
        2,
        "the right attempt wrote no denial row"
    );
    assert_eq!(w.audit("dev_token.issued").await.len(), 1);

    // No password — right or wrong — is echoed or recorded.
    let audit_text = w.audit_text().await;
    for password in [PASSWORD, WRONG_PASSWORD] {
        assert!(
            !audit_text.contains(password),
            "an audit row holds a password"
        );
        for answer in &answers {
            assert!(!answer.contains(password), "an answer echoes a password");
        }
    }
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4660)"]
async fn five_wrong_passwords_in_a_window_lock_the_member_out_even_for_the_right_one() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;

    // A right password first: a card, and it is not a failure, so it takes nothing off the five.
    let first = w.issue_as(&owner, "이도현의 노트북", PASSWORD).await;
    expect_status(&first, 201, "a right password before any failure");
    assert_eq!(w.dev_rows(owner.id).await, 1);

    // Five wrong ones: each is a 403 that is not rate limited.
    for attempt in 1..=5 {
        let reply = w.issue_as(&owner, "이도현의 노트북", WRONG_PASSWORD).await;
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
    let sixth = w.issue_as(&owner, "이도현의 노트북", WRONG_PASSWORD).await;
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
    // … and the RIGHT password is refused in that window too, without a card.
    let right = w.issue_as(&owner, "이도현의 노트북", PASSWORD).await;
    expect_status(&right, 429, "the right password in a full window");
    assert!(
        right.header("retry-after").is_some(),
        "the right password's 429 carries Retry-After too"
    );
    assert_eq!(right.json().get("token"), None, "a 429 hands out no secret");
    assert_eq!(
        w.dev_rows(owner.id).await,
        1,
        "the five wrong and the two 429s inserted nothing"
    );
    assert_eq!(
        w.audit("dev_token.issue_denied")
            .await
            .iter()
            .filter(|row| row.actor == Some(owner.id) && row.detail["reason"] == "password_mismatch")
            .count(),
        5,
        "one denial row per compared password; a 429 compared nothing and wrote nothing"
    );

    // The budget is the member's, not the workspace's or the address's: another member of the
    // same workspace, from the same address, issues; and the locked member can still read.
    let other = w.issue_as(&admin, "박서연의 노트북", PASSWORD).await;
    expect_status(&other, 201, "another member while the owner is locked out");
    expect_status(
        &w.list(&owner.jwt, "").await,
        200,
        "the lock-out is for issuing, not for reading my own list",
    );
}

// ---------------------------------------------------------------------------
// R8 (a) — who may issue
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4660)"]
async fn only_owners_and_admins_may_issue_under_the_default_policy() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;
    let member = w.person("member", "최민수").await;
    let guest = w.person("guest", "정하윤").await;

    // Owner and admin: a card, and it is a card that opens the door as them.
    for (who, name) in [(&owner, "이도현의 노트북"), (&admin, "박서연의 노트북")] {
        let card = w.issue_card(who, name).await;
        let me = w.whoami(&card.secret).await;
        expect_status(&me, 200, "the new card opens whoami");
        assert_eq!(me.json()["memberId"], who.id.to_string());
    }

    // Member and guest: 403 before the password is compared, so the answer is the same for a
    // wrong password (a role the switch refuses learns nothing about the password).
    for (who, role) in [(&member, "member"), (&guest, "guest")] {
        let right = w.issue_as(who, "x", PASSWORD).await;
        expect_code(
            &right,
            403,
            "dev_access_denied",
            &format!("{role}, right password"),
        );
        let wrong = w.issue_as(who, "x", WRONG_PASSWORD).await;
        expect_code(
            &wrong,
            403,
            "dev_access_denied",
            &format!("{role}, wrong password"),
        );
        assert_eq!(w.dev_rows(who.id).await, 0, "a {role} got a row");
    }
    let denials = w.audit("dev_token.issue_denied").await;
    for (who, role) in [(&member, "member"), (&guest, "guest")] {
        let rows: Vec<&AuditRow> = denials
            .iter()
            .filter(|row| row.actor == Some(who.id))
            .collect();
        assert_eq!(rows.len(), 2, "one denial row per refused {role} attempt");
        assert!(
            rows.iter()
                .all(|row| row.detail["reason"] == "policy_denied"),
            "the {role}'s refusals are `policy_denied`"
        );
    }
    assert!(
        denials
            .iter()
            .all(|row| row.detail["reason"] == "policy_denied"),
        "no password was compared for a refused role, so no `password_mismatch` row exists"
    );
    // The domain function judges the role again on its own (the route's check is not the only
    // one): called directly, it refuses a member and a guest under the shipped switch.
    for (who, role) in [(&member, "member"), (&guest, "guest")] {
        let outcome =
            issue_by_function(&w.app, w.workspace, who.id, DevAccessPolicy::Admins, "x").await;
        assert_eq!(
            outcome.err().as_deref(),
            Some("PolicyDenied"),
            "the domain function admitted a {role} under `admins`"
        );
        assert_eq!(w.dev_rows(who.id).await, 0);
    }

    // The switch's own view of the caller.
    for (who, role, can_create, can_manage_all) in [
        (&owner, "owner", true, true),
        (&admin, "admin", true, true),
        (&member, "member", false, false),
        (&guest, "guest", false, false),
    ] {
        let view = w.policy(&who.jwt).await;
        expect_status(&view, 200, &format!("GET dev-access as {role}"));
        assert_eq!(
            view.json(),
            json!({"policy": "admins", "canCreate": can_create, "canManageAll": can_manage_all}),
            "the switch as seen by a {role}"
        );
    }
}

// ---------------------------------------------------------------------------
// R8 (b) — the role is judged on every use
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4660)"]
async fn an_admin_demoted_to_member_is_refused_on_the_next_request_without_any_sweep() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;
    let other_admin = w.person("admin", "최민수").await;

    let card = w.issue_card(&admin, "박서연의 노트북").await;
    let other_card = w.issue_card(&other_admin, "최민수의 노트북").await;
    expect_status(&w.whoami(&card.secret).await, 200, "before the demotion");
    expect_status(
        &w.whoami(&other_card.secret).await,
        200,
        "before the demotion (the other admin)",
    );

    // The real role route: it writes the new role and an audit row, and sweeps nothing.
    let demoted = w
        .send(
            Method::PATCH,
            &format!("/v1/workspaces/{}/members/{}/role", w.workspace, admin.id),
            &owner.jwt,
            Some(json!({"role": "member"})),
        )
        .await;
    expect_status(&demoted, 200, "the owner demotes the admin");
    assert_eq!(demoted.json()["role"], "member");
    assert!(
        !w.is_revoked(card.id).await,
        "the demotion revoked nothing: what follows is the door's own judgement on use"
    );

    let after = w.whoami(&card.secret).await;
    expect_code(
        &after,
        403,
        "dev_access_denied",
        "the demoted admin's card, next request",
    );
    assert!(
        !w.is_revoked(card.id).await,
        "a refused request does not revoke either"
    );
    // The door is not simply closed: the other admin's card, same workspace, still opens.
    expect_status(
        &w.whoami(&other_card.secret).await,
        200,
        "an admin's card after another admin was demoted",
    );
}

// ---------------------------------------------------------------------------
// R21 (a) — who may revoke whose
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4660)"]
async fn the_ladder_decides_who_may_revoke_whose_and_a_hidden_card_is_the_same_404_as_no_card() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;
    // A member's and a guest's cards: made while they were admins, which is how such a card
    // exists once the switch is `admins` (R8 b), and kept through the demotion.
    let member = w.person("admin", "최민수").await;
    let guest = w.person("admin", "정하윤").await;
    let c_owner = w.card_by_function(owner.id, "이도현의 카드").await;
    let c_admin = w.card_by_function(admin.id, "박서연의 카드").await;
    let c_member_by_admin = w.card_by_function(member.id, "최민수 카드 1").await;
    let c_member_by_owner = w.card_by_function(member.id, "최민수 카드 2").await;
    let c_member_own = w.card_by_function(member.id, "최민수 카드 3").await;
    let c_guest = w.card_by_function(guest.id, "정하윤의 카드").await;
    let lineage = w.login_by_function(admin.id, "박서연의 oort CLI").await;
    // A second owner-role member: an owner reaches past the ladder to another owner (ADR-0215
    // F5), an admin does not.
    let co_owner = w.person("owner", "공동소유자").await;
    let c_co_owner = w.card_by_function(co_owner.id, "공동소유자의 카드").await;
    w.set_role(member.id, "member").await;
    w.set_role(guest.id, "guest").await;

    // The answer for an id that does not exist, as a member sees it.
    let nothing = w.revoke(&member.jwt, Uuid::new_v4()).await;
    expect_status(&nothing, 404, "an id that does not exist");
    assert!(
        nothing.json()["error"]["message"].is_string()
            && nothing
                .header("content-type")
                .is_some_and(|kind| kind.starts_with("application/json")),
        "the 404 is the handler's own JSON error, not the router's empty one (or every \
         fingerprint below would be equal for the wrong reason), got `{}`",
        nothing.text()
    );
    let no_card = nothing.fingerprint();

    // A member or guest asking about someone else's card, a login lineage included: the very same
    // answer — status, bytes, headers — and the card is untouched.
    for target in [c_admin.id, c_owner.id, c_guest.id, lineage.session_id] {
        let reply = w.revoke(&member.jwt, target).await;
        assert_eq!(
            reply.fingerprint(),
            no_card,
            "member → {target}: a hidden credential must answer like no credential"
        );
    }
    for target in [c_member_by_admin.id, c_admin.id, lineage.session_id] {
        let reply = w.revoke(&guest.jwt, target).await;
        assert_eq!(
            reply.fingerprint(),
            no_card,
            "guest → {target}: a hidden credential must answer like no credential"
        );
    }
    for (card, who) in [
        (&c_owner, "the owner's card"),
        (&c_admin, "the admin's card"),
        (&c_guest, "the guest's card"),
        (&c_member_by_admin, "a member's card"),
    ] {
        assert!(
            !w.is_revoked(card.id).await,
            "{who} was revoked by a refused request"
        );
    }
    assert_eq!(
        w.live_lineage_rows(w.workspace, lineage.session_id).await,
        2
    );
    expect_status(
        &w.whoami(&c_owner.secret).await,
        200,
        "the owner's card still opens",
    );
    expect_status(
        &w.whoami(&c_admin.secret).await,
        200,
        "the admin's card still opens",
    );

    // An admin does not reach up: an owner-role member's card is a 403 (found, not allowed).
    for target in [c_owner.id, c_co_owner.id] {
        let up = w.revoke(&admin.jwt, target).await;
        expect_status(&up, 403, "admin → an owner's card");
        assert_ne!(
            up.fingerprint(),
            no_card,
            "a manager is told the card exists"
        );
        assert!(
            !w.is_revoked(target).await,
            "an owner's card was revoked by an admin"
        );
    }

    // … but reaches down: member's and guest's cards.
    let down = w.revoke(&admin.jwt, c_member_by_admin.id).await;
    expect_status(&down, 200, "admin → a member's card");
    assert_eq!(
        down.json(),
        json!({"id": c_member_by_admin.id.to_string(), "kind": "card", "revokedNow": true})
    );
    assert!(w.is_revoked(c_member_by_admin.id).await);
    expect_status(
        &w.revoke(&admin.jwt, c_guest.id).await,
        200,
        "admin → a guest's card",
    );
    assert!(w.is_revoked(c_guest.id).await);

    // The owner reaches anyone's, and a repeat is a 200 that revokes nothing and records nothing.
    let by_owner = w.revoke(&owner.jwt, c_member_by_owner.id).await;
    expect_status(&by_owner, 200, "owner → a member's card");
    assert_eq!(by_owner.json()["revokedNow"], true);
    let repeat = w.revoke(&owner.jwt, c_member_by_owner.id).await;
    expect_status(&repeat, 200, "the same revoke again");
    assert_eq!(
        repeat.json()["revokedNow"],
        false,
        "a repeat revokes nothing"
    );
    let of_member_card: Vec<AuditRow> = w
        .audit("dev_token.revoked")
        .await
        .into_iter()
        .filter(|row| row.target_id == Some(c_member_by_owner.id))
        .collect();
    assert_eq!(of_member_card.len(), 1, "one audit row, not one per call");
    assert_eq!(of_member_card[0].actor, Some(owner.id));
    assert_eq!(of_member_card[0].subject, Some(member.id));
    assert_eq!(
        of_member_card[0].target_type.as_deref(),
        Some("dev_credential")
    );
    assert_eq!(
        of_member_card[0].detail["via"], "admin",
        "a manager down the ladder"
    );
    assert_eq!(of_member_card[0].detail["kind"], "card");

    // Another owner's card, by an owner: allowed — the owner arm is not the strict ladder.
    let among_owners = w.revoke(&owner.jwt, c_co_owner.id).await;
    expect_status(&among_owners, 200, "owner → another owner's card");
    assert_eq!(among_owners.json()["revokedNow"], true);
    assert!(w.is_revoked(c_co_owner.id).await);

    // An admin's card, by the owner: allowed, and the card stops opening the door.
    expect_status(
        &w.revoke(&owner.jwt, c_admin.id).await,
        200,
        "owner → an admin's card",
    );
    expect_status(
        &w.whoami(&c_admin.secret).await,
        401,
        "the admin's card once the owner revoked it",
    );

    // A person's own card, whatever their role is today, and the owner's own.
    let own = w.revoke(&member.jwt, c_member_own.id).await;
    expect_status(&own, 200, "a member revoking their own card");
    assert_eq!(own.json()["revokedNow"], true);
    let own_row: Vec<AuditRow> = w
        .audit("dev_token.revoked")
        .await
        .into_iter()
        .filter(|row| row.target_id == Some(c_member_own.id))
        .collect();
    assert_eq!(own_row.len(), 1);
    assert_eq!(
        own_row[0].detail["via"], "owner",
        "the credential's own owner"
    );
    expect_status(
        &w.revoke(&owner.jwt, c_owner.id).await,
        200,
        "the owner's own card",
    );

    // A login lineage is revoked by its id, both halves together.
    let ended = w.revoke(&owner.jwt, lineage.session_id).await;
    expect_status(&ended, 200, "owner → an admin's login lineage");
    assert_eq!(
        ended.json(),
        json!({"id": lineage.session_id.to_string(), "kind": "session", "revokedNow": true})
    );
    assert_eq!(
        w.live_lineage_rows(w.workspace, lineage.session_id).await,
        0,
        "access and refresh are both ended"
    );

    // Another workspace's id: the same 404 as no card, whoever asks, and that card is untouched.
    let other_workspace = seed_workspace(&w.su).await;
    let other_owner = w
        .person_in(other_workspace, "owner", "이도현", Some(PASSWORD))
        .await;
    let other_card = Card::from_issued(
        &issue_by_function(
            &w.app,
            other_workspace,
            other_owner.id,
            DevAccessPolicy::Admins,
            "다른 워크스페이스의 카드",
        )
        .await
        .expect("the other workspace's owner gets a card"),
    );
    let foreign = w.revoke(&owner.jwt, other_card.id).await;
    assert_eq!(
        foreign.fingerprint(),
        no_card,
        "another workspace's credential answers like no credential, even to an owner"
    );
    assert!(
        !w.is_revoked(other_card.id).await,
        "it was revoked across workspaces"
    );
    expect_status(
        &w.whoami_in(other_workspace, &other_card.secret).await,
        200,
        "the other workspace's card still opens its own door",
    );
    // Control: the id was real — its own workspace's owner revokes it.
    let real = w
        .send(
            Method::DELETE,
            &dev_path(other_workspace, &format!("/credentials/{}", other_card.id)),
            &other_owner.jwt,
            None,
        )
        .await;
    expect_status(&real, 200, "the other workspace's owner revokes it");
    assert_eq!(real.json()["revokedNow"], true);
}

// ---------------------------------------------------------------------------
// R21 (b) — the list
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4660)"]
async fn only_owners_and_admins_may_list_everyones_credentials() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;
    let member = w.person("admin", "최민수").await; // demoted below, after their card exists
    let guest = w.person("admin", "정하윤").await; // ditto
    let c_owner = w.card_by_function(owner.id, "이도현의 카드").await;
    let c_admin = w.card_by_function(admin.id, "박서연의 카드").await;
    let c_member = w.card_by_function(member.id, "최민수의 카드").await;
    let c_guest = w.card_by_function(guest.id, "정하윤의 카드").await;
    w.set_role(member.id, "member").await;
    w.set_role(guest.id, "guest").await;
    let everyone = set_of(&[c_owner.id, c_admin.id, c_member.id, c_guest.id]);

    // `?scope=all`: refused for a member and a guest, whatever they own.
    for (who, role) in [(&member, "member"), (&guest, "guest")] {
        expect_status(
            &w.list(&who.jwt, "?scope=all").await,
            403,
            &format!("{role} asking for everyone's credentials"),
        );
    }
    // … and complete for an owner and an admin, each row naming whose it is.
    for (who, role) in [(&owner, "owner"), (&admin, "admin")] {
        let all = w.list(&who.jwt, "?scope=all").await;
        expect_status(
            &all,
            200,
            &format!("{role} asking for everyone's credentials"),
        );
        assert_eq!(
            ids_in_list(&all),
            everyone,
            "the {role} sees every member's cards"
        );
        let owners_of: BTreeSet<(String, String)> = all.json()["credentials"]
            .as_array()
            .expect("a list")
            .iter()
            .map(|item| {
                (
                    item["id"].as_str().expect("id").to_string(),
                    item["memberId"].as_str().expect("memberId").to_string(),
                )
            })
            .collect();
        for (card, holder) in [
            (&c_owner, &owner),
            (&c_admin, &admin),
            (&c_member, &member),
            (&c_guest, &guest),
        ] {
            assert!(
                owners_of.contains(&(card.id.to_string(), holder.id.to_string())),
                "a card is listed under its holder"
            );
        }
    }

    // The default list is the caller's own, for every role.
    for (who, card, role) in [
        (&owner, &c_owner, "owner"),
        (&admin, &c_admin, "admin"),
        (&member, &c_member, "member"),
        (&guest, &c_guest, "guest"),
    ] {
        let mine = w.list(&who.jwt, "").await;
        expect_status(&mine, 200, &format!("{role}'s own list"));
        assert_eq!(
            ids_in_list(&mine),
            set_of(&[card.id]),
            "the {role}'s default list is their own card and nothing else"
        );
    }
    expect_status(
        &w.list(&owner.jwt, "?scope=everyone").await,
        400,
        "a scope that is neither omitted nor `all`",
    );

    // A revoked card leaves the list.
    expect_status(
        &w.revoke(&owner.jwt, c_admin.id).await,
        200,
        "revoking the admin's card",
    );
    assert_eq!(
        ids_in_list(&w.list(&owner.jwt, "?scope=all").await),
        set_of(&[c_owner.id, c_member.id, c_guest.id]),
        "the revoked card is no longer listed"
    );
}

// ---------------------------------------------------------------------------
// R21 (c) — L2 logout
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4660)"]
async fn a_developer_token_logs_out_only_itself() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let admin = w.person("admin", "박서연").await;
    let c1 = w.card_by_function(owner.id, "이도현의 카드 1").await;
    let c2 = w.card_by_function(owner.id, "이도현의 카드 2").await;
    let c3 = w.card_by_function(owner.id, "이도현의 카드 3").await;
    let theirs = w.card_by_function(admin.id, "박서연의 카드").await;
    let l1 = w.login_by_function(owner.id, "이도현의 oort CLI 1").await;
    let l2 = w.login_by_function(owner.id, "이도현의 oort CLI 2").await;

    // A card ends itself.
    let ended = w.logout(&c1.secret).await;
    expect_status(&ended, 200, "a card's logout");
    assert_eq!(
        ended.json(),
        json!({"id": c1.id.to_string(), "kind": "card", "revokedNow": true})
    );
    assert!(w.is_revoked(c1.id).await);
    expect_status(&w.whoami(&c1.secret).await, 401, "the card that logged out");
    expect_status(
        &w.logout(&c1.secret).await,
        401,
        "a card that is gone cannot log out again",
    );
    // Nothing else of the member, nor anyone else's, was touched.
    for (card, what) in [
        (&c2, "the second card"),
        (&c3, "the third card"),
        (&theirs, "another member's card"),
    ] {
        assert!(
            !w.is_revoked(card.id).await,
            "{what} was revoked by someone else's logout"
        );
        expect_status(
            &w.whoami(&card.secret).await,
            200,
            &format!("{what} still opens"),
        );
    }
    for (lineage, what) in [(&l1, "the first lineage"), (&l2, "the second lineage")] {
        assert_eq!(
            w.live_lineage_rows(w.workspace, lineage.session_id).await,
            2,
            "{what} lost a half to a card's logout"
        );
        expect_status(
            &w.whoami(&lineage.access).await,
            200,
            &format!("{what}'s access still opens"),
        );
    }
    let app_session = w.list(&owner.jwt, "").await;
    expect_status(
        &app_session,
        200,
        "the member's app session survives a developer logout",
    );
    assert_eq!(
        ids_in_list(&app_session),
        set_of(&[c2.id, c3.id, l1.session_id, l2.session_id]),
        "the list shows what is left: two cards and two lineages (control for the checks above)"
    );
    let logout_rows = w.audit("dev_token.revoked").await;
    assert_eq!(logout_rows.len(), 1);
    assert_eq!(logout_rows[0].detail["via"], "self");
    assert_eq!(logout_rows[0].actor, Some(owner.id));
    assert_eq!(logout_rows[0].target_id, Some(c1.id));
    assert_eq!(
        logout_rows[0].via_token,
        Some(c1.id),
        "the row names the token that asked"
    );

    // L2 has no id to name another credential with: whatever is added to the call, it ends the
    // caller and only the caller.
    let named = w
        .send(
            Method::DELETE,
            &format!("{}?id={}", dev_path(w.workspace, "/self"), c3.id),
            &c2.secret,
            Some(json!({"id": c3.id.to_string(), "credentialId": c3.id.to_string()})),
        )
        .await;
    expect_status(&named, 200, "a logout that names another card");
    assert_eq!(named.json()["id"], c2.id.to_string(), "it ended the caller");
    assert!(w.is_revoked(c2.id).await);
    assert!(
        !w.is_revoked(c3.id).await,
        "a card named in the call's query or body was revoked"
    );
    expect_status(
        &w.whoami(&c3.secret).await,
        200,
        "the named card still opens",
    );

    // A login lineage's logout ends the whole lineage — access and refresh — and no other.
    let session_end = w.logout(&l1.access).await;
    expect_status(&session_end, 200, "a login session's logout");
    assert_eq!(
        session_end.json(),
        json!({"id": l1.session_id.to_string(), "kind": "session", "revokedNow": true})
    );
    assert_eq!(
        w.live_lineage_rows(w.workspace, l1.session_id).await,
        0,
        "both halves of the logged-out lineage are ended"
    );
    expect_status(
        &w.whoami(&l1.access).await,
        401,
        "the lineage's access after logout",
    );
    assert_eq!(
        w.live_lineage_rows(w.workspace, l2.session_id).await,
        2,
        "the member's other lineage is untouched"
    );
    expect_status(
        &w.whoami(&l2.access).await,
        200,
        "the other lineage still opens",
    );
    expect_status(
        &w.whoami(&c3.secret).await,
        200,
        "the third card still opens",
    );
    expect_status(
        &w.whoami(&theirs.secret).await,
        200,
        "another member's card still opens",
    );

    // A person's session is not a developer token: both `self` routes answer it 403 and end nothing.
    for (reply, what) in [
        (w.whoami(&owner.jwt).await, "whoami with a session"),
        (w.logout(&owner.jwt).await, "logout with a session"),
    ] {
        expect_code(&reply, 403, "dev_credential_required", what);
    }
    assert!(!w.is_revoked(c3.id).await);
    assert_eq!(w.live_lineage_rows(w.workspace, l2.session_id).await, 2);
}

// ---------------------------------------------------------------------------
// R21 (d), R8 (a) — an agent member holds no developer token
// ---------------------------------------------------------------------------

/// A `dev` card row exactly as `issue_dev_card_in_tx` writes one — every column a CHECK looks
/// at is valid, so the only thing that can refuse it is the trigger on who the actor is.
async fn insert_card_row(su: &PgPool, workspace: Uuid, actor: Uuid) -> Result<Uuid, sqlx::Error> {
    let secret =
        momo_auth::mint_dev_envelope(DEV_TOKEN_PREFIX, workspace).expect("an envelope is minted");
    sqlx::query_scalar(
        "INSERT INTO token \
           (workspace_id, kind, actor_member_id, token_hash, scopes, label, expires_at, \
            created_by, dev_form, dev_tool, dev_channel_ids) \
         VALUES ($1, 'dev', $2, digest($3::text, 'sha256'), ARRAY['dev:identity']::text[], \
                 $4, now() + interval '30 days', $2, 'card', 'cli', NULL) \
         RETURNING id",
    )
    .bind(workspace)
    .bind(actor)
    .bind(&secret)
    .bind("직접 넣은 행")
    .fetch_one(su)
    .await
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4660)"]
async fn an_agent_member_never_holds_a_developer_token_the_function_and_the_trigger_each_refuse() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let agent = seed_managed_agent(&w.su, w.workspace, owner.id, "assistant").await;

    // First wall: the domain function names what the member is. Under the shipped policy and
    // under the widest one — it is not a role question.
    for policy in [DevAccessPolicy::Admins, DevAccessPolicy::Members] {
        let outcome =
            issue_by_function(&w.app, w.workspace, agent.id, policy, "에이전트의 카드").await;
        assert_eq!(
            outcome.err().as_deref(),
            Some("NotHuman"),
            "the function must refuse an agent member as `NotHuman` under {policy:?}"
        );
    }
    assert_eq!(w.dev_rows(agent.id).await, 0, "no row for the agent");
    // Control: the same call, same inputs, for a human owner issues.
    let issued = issue_by_function(
        &w.app,
        w.workspace,
        owner.id,
        DevAccessPolicy::Admins,
        "에이전트의 카드",
    )
    .await;
    assert!(
        issued.is_ok(),
        "control: the function issues for a human owner, got {:?}",
        issued.err()
    );
    assert_eq!(w.dev_rows(owner.id).await, 1);

    // Second wall: a row put in directly, past the function. The superuser cannot be stopped
    // by row-level security, so only the trigger on `token` can answer.
    match insert_card_row(&w.su, w.workspace, agent.id).await {
        Err(sqlx::Error::Database(refusal)) => {
            assert_eq!(
                refusal.code().as_deref(),
                Some("23514"),
                "a check violation, got {refusal}"
            );
            assert!(
                refusal
                    .message()
                    .contains("dev token actor must be a human member"),
                "the trigger is what refused it, got {refusal}"
            );
        }
        other => panic!("a direct INSERT of an agent's dev row must be refused, got {other:?}"),
    }
    assert_eq!(
        w.dev_rows(agent.id).await,
        0,
        "the refused INSERT left no row"
    );
    // Control: the same INSERT for a human goes in, so the refusal above was about the actor.
    insert_card_row(&w.su, w.workspace, owner.id)
        .await
        .expect("control: the same INSERT for a human owner is accepted");
    assert_eq!(w.dev_rows(owner.id).await, 2);

    // The agent's own REST bearer cannot use the route that issues, and nothing is written.
    let bearer = seed_generic_agent_bearer(&w.su, w.workspace, agent.id).await;
    let by_agent = w
        .send(
            Method::POST,
            &dev_path(w.workspace, "/credentials"),
            &bearer,
            Some(issue_body("에이전트의 카드", PASSWORD)),
        )
        .await;
    expect_status(&by_agent, 403, "an agent's bearer on the issuing route");
    assert_eq!(
        w.dev_rows(agent.id).await,
        0,
        "the agent's bearer issued something"
    );
    assert_eq!(
        by_agent.json().get("token"),
        None,
        "a refusal hands out no secret"
    );
}

// ---------------------------------------------------------------------------
// the second wall of the closed table: these routes are for a person's session
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4660)"]
async fn a_developer_token_cannot_issue_list_or_revoke_developer_tokens() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let owner = w.person("owner", "이도현").await;
    let caller = w.card_by_function(owner.id, "이도현의 카드").await;
    let target = w.card_by_function(owner.id, "이도현의 다른 카드").await;
    expect_status(
        &w.whoami(&caller.secret).await,
        200,
        "control: the card is valid and opens its own door",
    );

    let credentials = dev_path(w.workspace, "/credentials");
    let calls = vec![
        (
            "issue",
            Method::POST,
            credentials.clone(),
            Some(issue_body("뒷문", PASSWORD)),
        ),
        ("list", Method::GET, credentials.clone(), None),
        (
            "list everyone's",
            Method::GET,
            format!("{credentials}?scope=all"),
            None,
        ),
        (
            "revoke another card",
            Method::DELETE,
            format!("{credentials}/{}", target.id),
            None,
        ),
        ("policy", Method::GET, dev_path(w.workspace, ""), None),
    ];
    for (what, method, path, body) in calls {
        let reply = w.send(method, &path, &caller.secret, body).await;
        expect_code(
            &reply,
            403,
            "dev_route_not_allowed",
            &format!("a developer token to {what}"),
        );
    }
    assert_eq!(
        w.dev_rows(owner.id).await,
        2,
        "a developer token issued a card"
    );
    assert!(
        !w.is_revoked(target.id).await,
        "a developer token revoked another card"
    );
    assert_eq!(
        w.audit("dev_token.issued").await.len() + w.audit("dev_token.revoked").await.len(),
        0,
        "none of the refused calls reached a handler's audit"
    );

    // Control: the same five calls with the person's own session are not refused.
    let listed = w.list(&owner.jwt, "").await;
    expect_status(&listed, 200, "the person's own list");
    assert_eq!(ids_in_list(&listed), set_of(&[caller.id, target.id]));
    expect_status(
        &w.list(&owner.jwt, "?scope=all").await,
        200,
        "the person's list of everyone's",
    );
    expect_status(&w.policy(&owner.jwt).await, 200, "the person's policy view");
    let issued = w.issue_as(&owner, "새 카드", PASSWORD).await;
    expect_status(&issued, 201, "the person's issuing");
    expect_status(
        &w.revoke(&owner.jwt, target.id).await,
        200,
        "the person's revoke",
    );
}
