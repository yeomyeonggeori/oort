//! The **human developer token** (ADR-0216) — a person's own, named, narrow
//! credential for the terminal and AI tools (`oort` CLI, Claude Code, Codex).
//!
//! It is a `token` row with `kind = 'dev'` (migration 152), so it lives here for
//! the reason [`crate::agent_bearer`] does: this crate is the only owner of
//! `token` SQL. Like that module it holds no `momo-db` dependency — callers open
//! the tenant transaction (`momo_db::with_tenant_tx`) and write the audit rows
//! in it, so every function here takes a `&mut PgConnection`.
//!
//! ## Forms and envelopes (D2)
//!
//! One kind, three forms (`token.dev_form`):
//!
//! | form | envelope | lifetime |
//! |---|---|---|
//! | `card` | `momo_dev_v1.<ws>.<secret>` | 1..=90 days (default 30), shown once |
//! | `access` | `momo_dev_v1.<ws>.<secret>` | 15 minutes, capped by the lineage |
//! | `refresh` | `momo_devr_v1.<ws>.<secret>` | 30 idle days, capped by the lineage (approval + 90 days) |
//!
//! Only `digest(<whole envelope>, 'sha256')` is stored, so the same secret bytes
//! relabelled with another prefix match no row. Every lookup ALSO filters on
//! `kind = 'dev'` and `dev_form` (the door takes `card`/`access`, rotation takes
//! `refresh`): the hash and the form filter are two separate walls (R2). The
//! lookups deliberately do not pre-check the envelope prefix in Rust — the
//! server's dispatch does that — so the SQL form filter stays an independently
//! testable wall.
//!
//! ## Policy (D3)
//!
//! Who may hold one is decided per **use**, not only at issuance: a demoted
//! member's live tokens stop at the next request. [`FIXED_POLICY`] is the
//! shipped value (`admins`); the switch's storage is out of this issue.
//!
//! ## Lock order (#3109)
//!
//! Every multi-row lineage or member-wide operation here takes
//! [`crate::lock_member_wide_sweep_in_tx`] first and then its `token` rows in one
//! `ORDER BY id FOR UPDATE` ([`LOCK_DEV_ROWS_SQL`] /
//! [`LOCK_MEMBER_LIVE_DEV_ROWS_SQL`], the `kind = 'dev'` siblings of the session
//! locks in [`crate::token_store`]). Single-row operations (finalizing one use,
//! revoking one card) cannot close a cycle and take no sweep lock. Issuance
//! inserts only and serializes per member on its own advisory key so the
//! live-count limits cannot be raced.
//!
//! ## Secrets
//!
//! A raw envelope exists only in the return value of an issuing function
//! ([`IssuedDevCard::secret`], [`IssuedDevLogin::access`]/[`IssuedDevLogin::refresh`]),
//! and both structs redact it from `Debug`. No lookup returns it.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::token_store::lock_member_wide_sweep_in_tx;
use crate::workspace_authorization::WorkspaceRole;

/// Envelope prefix of a card token and of a login session's access half.
pub const DEV_TOKEN_PREFIX: &str = "momo_dev_v1";
/// Envelope prefix of a login session's refresh half.
pub const DEV_REFRESH_PREFIX: &str = "momo_devr_v1";

/// Always granted: `whoami` (L1), self-revoke (L2), and the human MCP (L8).
pub const SCOPE_DEV_IDENTITY: &str = "dev:identity";
/// `GET …/channels` (L3).
pub const SCOPE_DEV_CHANNELS_READ: &str = "dev:channels:read";
/// `GET …/channels/{ch}/messages` and `…/{root}/replies` (L4, L5).
pub const SCOPE_DEV_MESSAGES_READ: &str = "dev:messages:read";
/// `POST …/channels/{ch}/messages` (L6).
pub const SCOPE_DEV_MESSAGES_WRITE: &str = "dev:messages:write";
/// `GET …/inbox` (L7).
pub const SCOPE_DEV_INBOX_READ: &str = "dev:inbox:read";

/// Every scope a developer token can carry — exactly the set migration 152's
/// `token_dev_scopes_ck` admits. The `dev:` namespace keeps every existing
/// scope check (`messages:*`, `realtime:*`, …) from waving a developer token
/// through by accident (D4).
pub const DEV_SCOPES: [&str; 5] = [
    SCOPE_DEV_IDENTITY,
    SCOPE_DEV_CHANNELS_READ,
    SCOPE_DEV_MESSAGES_READ,
    SCOPE_DEV_MESSAGES_WRITE,
    SCOPE_DEV_INBOX_READ,
];

/// The 「읽기만」 preset — the default selection (D4, D8).
pub const DEV_READ_ONLY_SCOPES: [&str; 4] = [
    SCOPE_DEV_IDENTITY,
    SCOPE_DEV_CHANNELS_READ,
    SCOPE_DEV_MESSAGES_READ,
    SCOPE_DEV_INBOX_READ,
];

/// Reserved name only. Never issued in v1: search reads many channels at once,
/// so it needs its own channel-restriction proof (D4).
pub const DEV_SCOPE_SEARCH_RESERVED: &str = "dev:search";

pub const DEFAULT_CARD_DAYS: i64 = 30;
pub const MAX_LIFETIME_DAYS: i64 = 90;
pub const ACCESS_TTL_SECONDS: i64 = 15 * 60;
pub const REFRESH_IDLE_DAYS: i64 = 30;
pub const MAX_LIVE_CARDS: i64 = 20;
pub const MAX_LIVE_LINEAGES: i64 = 10;
pub const MAX_CHANNEL_IDS: usize = 50;
/// Name and device-name limit, in characters (D6).
pub const MAX_LABEL_CHARS: usize = 80;
/// Client-name limit of a login lineage, in characters.
pub const MAX_CLIENT_CHARS: usize = 200;

/// `DEV_CREDENTIAL_KIND_*` — the two row kinds of [`DevCredentialRecord`].
pub const DEV_CREDENTIAL_KIND_CARD: &str = "card";
pub const DEV_CREDENTIAL_KIND_SESSION: &str = "session";

const SECONDS_PER_DAY: i64 = 24 * 60 * 60;
/// 32 bytes of OS entropy, unpadded base64url = 43 characters.
const SECRET_BYTES: usize = 32;
const MINIMUM_SECRET_CHARS: usize = 43;

// ---------------------------------------------------------------------------
// envelope
// ---------------------------------------------------------------------------

/// The workspace a presented card/access envelope claims, or `None` when the
/// string is not `momo_dev_v1.<lowercase uuid>.<≥43 base64url chars>`.
///
/// Like [`crate::agent_bearer_workspace_id`], nothing but the workspace is read
/// from the envelope: the identity always comes from the tenant-scoped row.
pub fn dev_token_workspace_id(raw: &str) -> Option<Uuid> {
    envelope_workspace_id(raw, DEV_TOKEN_PREFIX)
}

/// The workspace a presented refresh envelope (`momo_devr_v1.…`) claims.
pub fn dev_refresh_workspace_id(raw: &str) -> Option<Uuid> {
    envelope_workspace_id(raw, DEV_REFRESH_PREFIX)
}

/// Shared with [`crate::dev_login`], whose authorization-code envelope has the
/// same `<prefix>.<lowercase uuid>.<≥43 base64url>` shape under its own prefix.
pub(crate) fn envelope_workspace_id(raw: &str, prefix: &str) -> Option<Uuid> {
    let mut parts = raw.split('.');
    let presented_prefix = parts.next()?;
    let workspace = parts.next()?;
    let secret = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if presented_prefix != prefix {
        return None;
    }
    if !secret
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    if secret.len() < MINIMUM_SECRET_CHARS {
        return None;
    }
    let workspace_id = Uuid::parse_str(workspace).ok()?;
    // Only the form a mint writes: lowercase, hyphenated (no braces, no simple
    // or URN form). Anything else is not this envelope.
    if workspace_id.hyphenated().to_string() != workspace {
        return None;
    }
    Some(workspace_id)
}

/// Mint `<prefix>.<workspace>.<secret>` from 32 OS-CSPRNG bytes (the
/// `mint_agent_bearer` shape). `prefix` is [`DEV_TOKEN_PREFIX`] or
/// [`DEV_REFRESH_PREFIX`]. Entropy failure surfaces as an `sqlx::Error` the
/// way `hosted_oauth`'s envelope mint does, because every caller is a DB
/// function that already returns one.
pub fn mint_dev_envelope(prefix: &str, workspace_id: Uuid) -> Result<String, sqlx::Error> {
    let mut secret = [0_u8; SECRET_BYTES];
    getrandom::getrandom(&mut secret)
        .map_err(|_| sqlx::Error::Protocol("credential entropy unavailable".to_string()))?;
    Ok(format!(
        "{prefix}.{}.{}",
        workspace_id.hyphenated(),
        URL_SAFE_NO_PAD.encode(secret)
    ))
}

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

/// `token.dev_form`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevForm {
    Card,
    Access,
    Refresh,
}

impl DevForm {
    pub fn as_db_label(self) -> &'static str {
        match self {
            DevForm::Card => "card",
            DevForm::Access => "access",
            DevForm::Refresh => "refresh",
        }
    }

    pub fn from_db_label(label: &str) -> Option<Self> {
        Some(match label {
            "card" => DevForm::Card,
            "access" => DevForm::Access,
            "refresh" => DevForm::Refresh,
            _ => return None,
        })
    }
}

/// `token.dev_tool` — what the maker said the token is for. Never a verified
/// fact, so it is never shown as one (D6, D8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevTool {
    ClaudeCode,
    Codex,
    Cli,
    Other,
}

impl DevTool {
    pub fn as_db_label(self) -> &'static str {
        match self {
            DevTool::ClaudeCode => "claude_code",
            DevTool::Codex => "codex",
            DevTool::Cli => "cli",
            DevTool::Other => "other",
        }
    }

    /// Exact match on the four stored values.
    pub fn from_db_label(label: &str) -> Option<Self> {
        Some(match label {
            "claude_code" => DevTool::ClaudeCode,
            "codex" => DevTool::Codex,
            "cli" => DevTool::Cli,
            "other" => DevTool::Other,
            _ => return None,
        })
    }
}

/// The workspace switch 「명령줄·AI 도구 접근」 (D3). Guests are allowed under
/// no value, and an agent member never holds a developer token at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevAccessPolicy {
    Admins,
    Members,
    Off,
}

/// The value #4660 ships as a constant (D3 「출시 순서」). Storage and the
/// change API for the switch are a later checklist item.
pub const FIXED_POLICY: DevAccessPolicy = DevAccessPolicy::Admins;

impl DevAccessPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            DevAccessPolicy::Admins => "admins",
            DevAccessPolicy::Members => "members",
            DevAccessPolicy::Off => "off",
        }
    }

    /// The `workspace_membership.role` labels this value admits.
    pub fn allowed_roles(self) -> &'static [&'static str] {
        match self {
            DevAccessPolicy::Admins => &["owner", "admin"],
            DevAccessPolicy::Members => &["owner", "admin", "member"],
            DevAccessPolicy::Off => &[],
        }
    }

    pub fn allows_role(self, role_label: &str) -> bool {
        self.allowed_roles().contains(&role_label)
    }

    pub fn allows(self, role: WorkspaceRole) -> bool {
        self.allows_role(role.as_db_label())
    }

    fn allowed_role_vec(self) -> Vec<String> {
        self.allowed_roles()
            .iter()
            .map(|role| role.to_string())
            .collect()
    }
}

// ---------------------------------------------------------------------------
// the closed route table (D4)
// ---------------------------------------------------------------------------

/// One row of the closed developer-door table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DevRoute {
    pub method: &'static str,
    /// The router's matched template (`MatchedPath`), character for character.
    pub template: &'static str,
    pub scope: &'static str,
}

/// L1–L8 (ADR-0216 D4). The ONLY REST a developer token reaches; a pair not in
/// this table is refused before any DB work. Keys are the route template the
/// router resolved, never the raw request path.
pub const DEV_ROUTE_TABLE: [DevRoute; 8] = [
    // L1 whoami
    DevRoute {
        method: "GET",
        template: "/v1/workspaces/{ws}/dev-access/self",
        scope: SCOPE_DEV_IDENTITY,
    },
    // L2 logout (this token / lineage only)
    DevRoute {
        method: "DELETE",
        template: "/v1/workspaces/{ws}/dev-access/self",
        scope: SCOPE_DEV_IDENTITY,
    },
    // L3 channels
    DevRoute {
        method: "GET",
        template: "/v1/workspaces/{ws}/channels",
        scope: SCOPE_DEV_CHANNELS_READ,
    },
    // L4 read
    DevRoute {
        method: "GET",
        template: "/v1/workspaces/{ws}/channels/{ch}/messages",
        scope: SCOPE_DEV_MESSAGES_READ,
    },
    // L5 read --thread
    DevRoute {
        method: "GET",
        template: "/v1/workspaces/{ws}/channels/{ch}/messages/{root}/replies",
        scope: SCOPE_DEV_MESSAGES_READ,
    },
    // L6 post
    DevRoute {
        method: "POST",
        template: "/v1/workspaces/{ws}/channels/{ch}/messages",
        scope: SCOPE_DEV_MESSAGES_WRITE,
    },
    // L7 inbox (never marks read)
    DevRoute {
        method: "GET",
        template: "/v1/workspaces/{ws}/inbox",
        scope: SCOPE_DEV_INBOX_READ,
    },
    // L8 human MCP (#4661 mounts the route)
    DevRoute {
        method: "POST",
        template: "/v1/mcp/me",
        scope: SCOPE_DEV_IDENTITY,
    },
];

/// The scope a developer token must carry for `method route_template`, or
/// `None` — refuse — for every pair not in [`DEV_ROUTE_TABLE`]. Exact match on
/// both: the method is the uppercase HTTP token (`HEAD`, `OPTIONS`, `PUT`,
/// `PATCH` and lowercase spellings are not in the table), and the template is
/// what the router matched, so a trailing slash, a case variant or a static
/// sibling of `{ch}` never resolves to a row.
pub fn required_dev_scope(method: &str, route_template: &str) -> Option<&'static str> {
    DEV_ROUTE_TABLE
        .iter()
        .find(|route| route.method == method && route.template == route_template)
        .map(|route| route.scope)
}

// ---------------------------------------------------------------------------
// input validation (the route uses the same functions for its 400s)
// ---------------------------------------------------------------------------

/// Why an issuance refused. `InvalidInput` names the field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DevIssueError {
    /// The member is not a human (an agent member, D2 / R21 d).
    #[error("developer tokens are for human members only")]
    NotHuman,
    /// The member's role is not admitted by the policy (or the member is not an
    /// active member at all).
    #[error("developer access is not allowed for this member")]
    PolicyDenied,
    /// 20 live cards / 10 live login lineages already (409 `dev_credential_limit`).
    #[error("developer credential limit reached")]
    LimitReached,
    #[error("invalid {0}")]
    InvalidInput(&'static str),
}

fn has_control_character(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn contains_dev_envelope_material(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    lowered.contains(&format!("{DEV_TOKEN_PREFIX}."))
        || lowered.contains(&format!("{DEV_REFRESH_PREFIX}."))
}

fn bounded_text(raw: &str, max_chars: usize, field: &'static str) -> Result<String, DevIssueError> {
    let value = raw.trim();
    let length = value.chars().count();
    if length == 0 || length > max_chars {
        return Err(DevIssueError::InvalidInput(field));
    }
    if has_control_character(value) {
        return Err(DevIssueError::InvalidInput(field));
    }
    // A pasted secret must not become a second, listable copy of itself.
    if contains_dev_envelope_material(value) {
        return Err(DevIssueError::InvalidInput(field));
    }
    Ok(value.to_string())
}

/// The token name: trimmed, 1..=80 characters, no control characters, no
/// developer-envelope material.
pub fn normalized_dev_label(raw: &str) -> Result<String, DevIssueError> {
    bounded_text(raw, MAX_LABEL_CHARS, "name")
}

/// Characters that change how a line of text *looks* without being visible
/// themselves: the zero-width and direction marks (U+200B..U+200F), the embedding
/// and override controls (U+202A..U+202E), the word joiner and invisible operators
/// (U+2060..U+2064), the isolates (U+2066..U+2069) and the byte-order mark
/// (U+FEFF). They are category Cf, so [`char::is_control`] does not see them.
fn is_display_spoofing_character(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// A login lineage's device name (chosen by the connecting side): absent or
/// blank is `None`; otherwise as [`normalized_dev_label`], and additionally free of
/// [`is_display_spoofing_character`]s. This name is what the consent screen shows
/// next to the server host so a person can tell their own terminal from a relayed
/// one (ADR-0216 D6 나, RFC 8628 §5.4): a name that can reorder or hide the text
/// around it defeats that comparison.
pub fn normalized_dev_device_name(raw: Option<&str>) -> Result<Option<String>, DevIssueError> {
    match raw {
        None => Ok(None),
        Some(value) if value.trim().is_empty() => Ok(None),
        Some(value) => {
            if value.chars().any(is_display_spoofing_character) {
                return Err(DevIssueError::InvalidInput("device_name"));
            }
            bounded_text(value, MAX_LABEL_CHARS, "device_name").map(Some)
        }
    }
}

/// A login lineage's client name: trimmed, 1..=200 characters.
pub fn normalized_dev_client(raw: &str) -> Result<String, DevIssueError> {
    bounded_text(raw, MAX_CLIENT_CHARS, "client")
}

/// The scope set to store. `None` (omitted) is the 「읽기만」 preset. Otherwise
/// every entry must be one of [`DEV_SCOPES`] (trimmed, ASCII-lowercased);
/// [`DEV_SCOPE_SEARCH_RESERVED`] and unknown names are refused.
/// [`SCOPE_DEV_IDENTITY`] is always added. The result is de-duplicated and in
/// [`DEV_SCOPES`] order, so equal grants store equal arrays.
pub fn normalized_dev_scopes(raw: Option<&[String]>) -> Result<Vec<String>, DevIssueError> {
    let requested: Vec<String> = match raw {
        None => DEV_READ_ONLY_SCOPES.iter().map(|s| s.to_string()).collect(),
        Some(values) => values
            .iter()
            .map(|value| value.trim().to_ascii_lowercase())
            .collect(),
    };
    for scope in &requested {
        if !DEV_SCOPES.contains(&scope.as_str()) {
            return Err(DevIssueError::InvalidInput("scopes"));
        }
    }
    Ok(DEV_SCOPES
        .iter()
        .filter(|scope| **scope == SCOPE_DEV_IDENTITY || requested.iter().any(|r| r == *scope))
        .map(|scope| scope.to_string())
        .collect())
}

/// The channel restriction: `None` = unrestricted; otherwise 1..=50 distinct
/// ids (duplicates collapse, first occurrence kept). Membership is the route's
/// check, against the maker's current channels.
pub fn normalized_dev_channel_ids(
    raw: Option<&[Uuid]>,
) -> Result<Option<Vec<Uuid>>, DevIssueError> {
    let Some(values) = raw else {
        return Ok(None);
    };
    let mut ids: Vec<Uuid> = Vec::with_capacity(values.len());
    for id in values {
        if !ids.contains(id) {
            ids.push(*id);
        }
    }
    if ids.is_empty() || ids.len() > MAX_CHANNEL_IDS {
        return Err(DevIssueError::InvalidInput("channel_ids"));
    }
    Ok(Some(ids))
}

/// A card's lifetime in days: omitted is [`DEFAULT_CARD_DAYS`]; otherwise
/// 1..=[`MAX_LIFETIME_DAYS`].
pub fn validated_dev_card_days(raw: Option<i64>) -> Result<i64, DevIssueError> {
    let days = raw.unwrap_or(DEFAULT_CARD_DAYS);
    if !(1..=MAX_LIFETIME_DAYS).contains(&days) {
        return Err(DevIssueError::InvalidInput("expires_in_days"));
    }
    Ok(days)
}

// ---------------------------------------------------------------------------
// identity, resolution, use (the door)
// ---------------------------------------------------------------------------

/// A resolved developer token. Carries no secret and no hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevIdentity {
    pub token_id: Uuid,
    pub member_id: Uuid,
    pub workspace_id: Uuid,
    /// `Card` or `Access` — the door never resolves a refresh.
    pub form: DevForm,
    pub scopes: Vec<String>,
    /// The restriction as issued. The route re-intersects it with the member's
    /// CURRENT channels on every request (D4) — never trust it alone.
    pub channel_ids: Option<Vec<Uuid>>,
    /// `workspace_membership.role` as of resolution.
    pub role: String,
    /// The login lineage of an access token; `None` for a card.
    pub session_id: Option<Uuid>,
    pub label: String,
    pub tool: Option<String>,
    pub client: Option<String>,
    pub device_name: Option<String>,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub last_used_at_ms: Option<i64>,
    pub lineage_expires_at_ms: Option<i64>,
}

impl DevIdentity {
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|granted| granted == scope)
    }
}

/// Outcome of the door lookup. Every failure to identify — no row, wrong
/// workspace, wrong form, revoked, expired, suspended or removed member, not a
/// human — is the one `Unknown`, so the route answers all of them with the
/// same 401 bytes. Only a live credential whose role the policy refuses is told
/// apart (`PolicyDenied` → 403), because its holder already proved the secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevResolution {
    Active(DevIdentity),
    PolicyDenied(DevIdentity),
    Unknown,
}

const RESOLVE_DEV_TOKEN_SQL: &str = "SELECT t.id, t.actor_member_id, t.scopes, t.dev_form, \
            t.dev_channel_ids, t.session_id, t.label, t.dev_tool, t.dev_client, \
            t.dev_device_name, \
            (EXTRACT(EPOCH FROM t.created_at) * 1000)::bigint AS created_at_ms, \
            (EXTRACT(EPOCH FROM t.expires_at) * 1000)::bigint AS expires_at_ms, \
            (EXTRACT(EPOCH FROM t.last_used_at) * 1000)::bigint AS last_used_at_ms, \
            (EXTRACT(EPOCH FROM t.dev_lineage_expires_at) * 1000)::bigint \
              AS lineage_expires_at_ms, \
            wm.role::text AS role \
       FROM token t \
       JOIN member m \
         ON m.id = t.actor_member_id \
        AND m.workspace_id = t.workspace_id \
       JOIN workspace_membership wm \
         ON wm.workspace_id = m.workspace_id \
        AND wm.member_id = m.id \
      WHERE t.workspace_id = $1 \
        AND t.kind = 'dev' \
        AND t.dev_form IN ('card', 'access') \
        AND t.token_hash = digest($2::text, 'sha256') \
        AND t.revoked_at IS NULL \
        AND t.expires_at > now() \
        AND m.kind = 'human' \
        AND m.status = 'active' \
        AND m.deleted_at IS NULL \
      LIMIT 1";

/// The door's lookup. SELECT only — the caller rate-limits between this and
/// [`finalize_dev_use_in_tx`] so a 429 flood cannot amplify DB writes (the
/// Agent Port order).
///
/// `conn` must carry the GUC of the workspace the envelope claims
/// ([`dev_token_workspace_id`]); a token of workspace A is `Unknown` under B.
pub async fn resolve_dev_token_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    raw: &str,
    policy: DevAccessPolicy,
) -> Result<DevResolution, sqlx::Error> {
    let row = sqlx::query(RESOLVE_DEV_TOKEN_SQL)
        .bind(workspace_id)
        .bind(raw)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        return Ok(DevResolution::Unknown);
    };
    let form_label: String = row.try_get("dev_form")?;
    let Some(form) = DevForm::from_db_label(&form_label) else {
        return Ok(DevResolution::Unknown);
    };
    let identity = DevIdentity {
        token_id: row.try_get("id")?,
        member_id: row.try_get("actor_member_id")?,
        workspace_id,
        form,
        scopes: row.try_get("scopes")?,
        channel_ids: row.try_get("dev_channel_ids")?,
        role: row.try_get("role")?,
        session_id: row.try_get("session_id")?,
        label: row.try_get("label")?,
        tool: row.try_get("dev_tool")?,
        client: row.try_get("dev_client")?,
        device_name: row.try_get("dev_device_name")?,
        created_at_ms: row.try_get("created_at_ms")?,
        expires_at_ms: row.try_get("expires_at_ms")?,
        last_used_at_ms: row.try_get("last_used_at_ms")?,
        lineage_expires_at_ms: row.try_get("lineage_expires_at_ms")?,
    };
    // D3: judged on every use, not only at issuance.
    if !policy.allows_role(&identity.role) {
        return Ok(DevResolution::PolicyDenied(identity));
    }
    Ok(DevResolution::Active(identity))
}

/// `last_used_at` at most once a minute, re-checking every predicate of
/// [`RESOLVE_DEV_TOKEN_SQL`] plus the policy's role (READ COMMITTED gives this
/// statement a fresh snapshot, so a revoke/expiry/suspension/demotion that
/// committed after the SELECT fails it).
const FINALIZE_DEV_USE_SQL: &str = "UPDATE token t \
        SET last_used_at = now() \
       FROM member m, workspace_membership wm \
      WHERE t.id = $1 \
        AND t.workspace_id = $2 \
        AND t.actor_member_id = $3 \
        AND t.kind = 'dev' \
        AND t.dev_form IN ('card', 'access') \
        AND t.revoked_at IS NULL \
        AND t.expires_at > now() \
        AND (t.last_used_at IS NULL OR t.last_used_at <= now() - interval '60 seconds') \
        AND m.id = t.actor_member_id \
        AND m.workspace_id = t.workspace_id \
        AND m.kind = 'human' \
        AND m.status = 'active' \
        AND m.deleted_at IS NULL \
        AND wm.workspace_id = m.workspace_id \
        AND wm.member_id = m.id \
        AND wm.role::text = ANY($4::text[])";

/// The same predicates without the throttle, share-locking the row: tells "used
/// within the minute" (alive → `true`) from "ended since the SELECT" (`false`).
const CONFIRM_DEV_USE_SQL: &str = "SELECT t.id \
       FROM token t \
       JOIN member m \
         ON m.id = t.actor_member_id \
        AND m.workspace_id = t.workspace_id \
       JOIN workspace_membership wm \
         ON wm.workspace_id = m.workspace_id \
        AND wm.member_id = m.id \
      WHERE t.id = $1 \
        AND t.workspace_id = $2 \
        AND t.actor_member_id = $3 \
        AND t.kind = 'dev' \
        AND t.dev_form IN ('card', 'access') \
        AND t.revoked_at IS NULL \
        AND t.expires_at > now() \
        AND m.kind = 'human' \
        AND m.status = 'active' \
        AND m.deleted_at IS NULL \
        AND wm.role::text = ANY($4::text[]) \
        FOR SHARE OF t";

/// Commit one admitted use: the conditional `last_used_at` touch (≤ once a
/// minute) and a re-check of every door predicate. `false` when the token was
/// revoked or expired, or its member suspended, removed or demoted out of the
/// policy, after [`resolve_dev_token_in_tx`] — the caller then answers the same
/// 401 as an unknown token. One row: it takes no sweep lock (#3109).
pub async fn finalize_dev_use_in_tx(
    conn: &mut PgConnection,
    identity: &DevIdentity,
    policy: DevAccessPolicy,
) -> Result<bool, sqlx::Error> {
    let roles = policy.allowed_role_vec();
    let touched = sqlx::query(FINALIZE_DEV_USE_SQL)
        .bind(identity.token_id)
        .bind(identity.workspace_id)
        .bind(identity.member_id)
        .bind(&roles)
        .execute(&mut *conn)
        .await?;
    if touched.rows_affected() == 1 {
        return Ok(true);
    }
    let alive = sqlx::query(CONFIRM_DEV_USE_SQL)
        .bind(identity.token_id)
        .bind(identity.workspace_id)
        .bind(identity.member_id)
        .bind(&roles)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(alive.is_some())
}

// ---------------------------------------------------------------------------
// current-password re-check (D6 가-2)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordCheck {
    Ok,
    Mismatch,
    /// No `human` row, or no password set (SSO-only).
    NoPassword,
}

/// `FOR SHARE` is the point, not decoration: a password change takes `FOR
/// UPDATE` on this row before it rewrites the hash and sweeps every token
/// (`change_own_password_in_tx`). Sharing it here makes an issuance and a
/// change serialize — the issuance either commits its card before the change's
/// sweep (which then revokes it) or reads the new hash and is refused. Without
/// it, a card verified against the old password could commit after the sweep
/// and outlive the change (T14).
const VERIFY_CURRENT_PASSWORD_SQL: &str = "SELECT \
            (h.password_hash IS NOT NULL AND h.password_hash <> '') AS has_password, \
            momo_password_verify($3, h.password_hash) AS password_ok \
       FROM human h \
      WHERE h.member_id = $1 \
        AND h.workspace_id = $2 \
        FOR SHARE";

/// Re-check the caller's current password with the verifier the password
/// change uses (`momo_password_verify`).
pub async fn verify_current_password_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    current_password: &str,
) -> Result<PasswordCheck, sqlx::Error> {
    let row = sqlx::query(VERIFY_CURRENT_PASSWORD_SQL)
        .bind(member_id)
        .bind(workspace_id)
        .bind(current_password)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        return Ok(PasswordCheck::NoPassword);
    };
    if !row.try_get::<bool, _>("has_password")? {
        return Ok(PasswordCheck::NoPassword);
    }
    if row.try_get::<Option<bool>, _>("password_ok")? != Some(true) {
        return Ok(PasswordCheck::Mismatch);
    }
    Ok(PasswordCheck::Ok)
}

// ---------------------------------------------------------------------------
// issuance
// ---------------------------------------------------------------------------

/// A card to issue (D6 가). The route has already re-checked the password,
/// share-locked membership state and checked channel membership.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewDevCard {
    pub label: String,
    pub tool: DevTool,
    pub scopes: Vec<String>,
    pub channel_ids: Option<Vec<Uuid>>,
    /// 1..=90.
    pub expires_in_days: i64,
}

/// The one-time output of a card issuance. `secret` is the envelope — it goes
/// into the 201 response and nowhere else.
#[derive(Clone, PartialEq, Eq)]
pub struct IssuedDevCard {
    pub id: Uuid,
    pub secret: String,
    pub label: String,
    pub tool: DevTool,
    pub scopes: Vec<String>,
    pub channel_ids: Option<Vec<Uuid>>,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
}

impl std::fmt::Debug for IssuedDevCard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("IssuedDevCard")
            .field("id", &self.id)
            .field("secret", &"<redacted>")
            .field("label", &self.label)
            .field("tool", &self.tool)
            .field("scopes", &self.scopes)
            .field("channel_ids", &self.channel_ids)
            .field("created_at_ms", &self.created_at_ms)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

/// A login session to open (D6 나). HTTP exposure is #4700.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewDevLogin {
    pub label: String,
    pub tool: DevTool,
    pub client: String,
    pub device_name: Option<String>,
    pub scopes: Vec<String>,
    pub channel_ids: Option<Vec<Uuid>>,
}

/// A fresh access/refresh pair of one lineage. The two envelopes are redacted
/// from `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct IssuedDevLogin {
    pub session_id: Uuid,
    pub member_id: Uuid,
    pub access_token_id: Uuid,
    pub refresh_token_id: Uuid,
    pub access: String,
    pub refresh: String,
    pub scopes: Vec<String>,
    pub access_expires_at_ms: i64,
    pub refresh_expires_at_ms: i64,
    pub lineage_expires_at_ms: i64,
}

impl std::fmt::Debug for IssuedDevLogin {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("IssuedDevLogin")
            .field("session_id", &self.session_id)
            .field("member_id", &self.member_id)
            .field("access_token_id", &self.access_token_id)
            .field("refresh_token_id", &self.refresh_token_id)
            .field("access", &"<redacted>")
            .field("refresh", &"<redacted>")
            .field("scopes", &self.scopes)
            .field("access_expires_at_ms", &self.access_expires_at_ms)
            .field("refresh_expires_at_ms", &self.refresh_expires_at_ms)
            .field("lineage_expires_at_ms", &self.lineage_expires_at_ms)
            .finish()
    }
}

/// Per-member issuance queue: the live-count check and the INSERT of two
/// concurrent issuances cannot interleave. Its own key, so it never waits on
/// (or holds up) the #3109 sweep queue.
const DEV_ISSUE_LOCK_SQL: &str = "SELECT pg_advisory_xact_lock( \
       hashtextextended('dev-issue:' || $1::text || ':' || $2::text, 0))";

const ISSUER_SQL: &str = "SELECT m.kind::text AS kind, \
            (m.status = 'active' AND m.deleted_at IS NULL) AS active, \
            wm.role::text AS role \
       FROM member m \
       LEFT JOIN workspace_membership wm \
         ON wm.workspace_id = m.workspace_id \
        AND wm.member_id = m.id \
      WHERE m.workspace_id = $1 \
        AND m.id = $2";

const COUNT_LIVE_CARDS_SQL: &str = "SELECT COUNT(*)::bigint \
       FROM token \
      WHERE workspace_id = $1 \
        AND actor_member_id = $2 \
        AND kind = 'dev' \
        AND dev_form = 'card' \
        AND revoked_at IS NULL \
        AND expires_at > now()";

/// A lineage is live while its refresh half is (it can still rotate).
const COUNT_LIVE_LINEAGES_SQL: &str = "SELECT COUNT(DISTINCT session_id)::bigint \
       FROM token \
      WHERE workspace_id = $1 \
        AND actor_member_id = $2 \
        AND kind = 'dev' \
        AND dev_form = 'refresh' \
        AND revoked_at IS NULL \
        AND expires_at > now()";

/// How many login lineages the member holds right now (a lineage is live while
/// its refresh half is), by the same predicate [`issue_dev_login_in_tx`] enforces
/// [`MAX_LIVE_LINEAGES`] with.
///
/// This is a **courtesy look**, not the limit: it takes no lock, so the browser
/// approval (#4700) uses it only to refuse early — before it spends a current-password
/// attempt on a login that the exchange would be unable to open. The limit itself is
/// still judged again, under the per-member issuance lock, when the code is
/// redeemed.
pub async fn count_live_dev_lineages_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(COUNT_LIVE_LINEAGES_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .fetch_one(&mut *conn)
        .await
}

/// `expires_at` is `now()` plus whole seconds: the same transaction timestamp
/// `created_at` defaults to, and no calendar arithmetic (migration 152 measures
/// the 90-day cap in hours so a DST boundary cannot move it).
const INSERT_DEV_CARD_SQL: &str = "INSERT INTO token \
       (workspace_id, kind, actor_member_id, token_hash, scopes, label, expires_at, \
        created_by, dev_form, dev_tool, dev_channel_ids) \
     VALUES ($1, 'dev', $2, digest($3::text, 'sha256'), $4, $5, \
             now() + ($6::bigint * interval '1 second'), \
             $2, 'card', $7, $8) \
     RETURNING id, \
               (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_at_ms, \
               (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms";

/// One half of a NEW lineage. Both halves are inserted in the same transaction,
/// so `now()` — and therefore the lineage cap — is identical on both.
const INSERT_DEV_LOGIN_HALF_SQL: &str = "INSERT INTO token \
       (workspace_id, kind, actor_member_id, token_hash, scopes, label, expires_at, \
        created_by, session_id, dev_form, dev_tool, dev_channel_ids, dev_client, \
        dev_device_name, dev_lineage_expires_at) \
     VALUES ($1, 'dev', $2, digest($3::text, 'sha256'), $4, $5, \
             LEAST(now() + ($6::bigint * interval '1 second'), \
                   now() + ($7::bigint * interval '1 second')), \
             $2, $8, $9, $10, $11, $12, $13, \
             now() + ($7::bigint * interval '1 second')) \
     RETURNING id, \
               (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms, \
               (EXTRACT(EPOCH FROM dev_lineage_expires_at) * 1000)::bigint \
                 AS lineage_expires_at_ms";

/// Who is asking, judged inside the issuing transaction: a human (R21 d, first
/// wall — the 152 trigger is the second), active, with a role the policy admits.
async fn issuer_refusal(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    policy: DevAccessPolicy,
) -> Result<Option<DevIssueError>, sqlx::Error> {
    let row = sqlx::query(ISSUER_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        return Ok(Some(DevIssueError::PolicyDenied));
    };
    let kind: String = row.try_get("kind")?;
    if kind != "human" {
        return Ok(Some(DevIssueError::NotHuman));
    }
    if !row.try_get::<bool, _>("active")? {
        return Ok(Some(DevIssueError::PolicyDenied));
    }
    let Some(role) = row.try_get::<Option<String>, _>("role")? else {
        return Ok(Some(DevIssueError::PolicyDenied));
    };
    if !policy.allows_role(&role) {
        return Ok(Some(DevIssueError::PolicyDenied));
    }
    Ok(None)
}

async fn lock_dev_issuance(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(DEV_ISSUE_LOCK_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Issue one card (D2, D6 가). Judges, in this transaction: the member is a
/// human, active, and admitted by `policy`; fewer than [`MAX_LIVE_CARDS`] live
/// cards (serialized per member). The inputs are re-validated here as well.
pub async fn issue_dev_card_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    card: &NewDevCard,
    policy: DevAccessPolicy,
) -> Result<Result<IssuedDevCard, DevIssueError>, sqlx::Error> {
    let label = match normalized_dev_label(&card.label) {
        Ok(label) => label,
        Err(error) => return Ok(Err(error)),
    };
    let scopes = match normalized_dev_scopes(Some(&card.scopes)) {
        Ok(scopes) => scopes,
        Err(error) => return Ok(Err(error)),
    };
    let channel_ids = match normalized_dev_channel_ids(card.channel_ids.as_deref()) {
        Ok(ids) => ids,
        Err(error) => return Ok(Err(error)),
    };
    if !(1..=MAX_LIFETIME_DAYS).contains(&card.expires_in_days) {
        return Ok(Err(DevIssueError::InvalidInput("expires_in_days")));
    }

    lock_dev_issuance(conn, workspace_id, member_id).await?;
    if let Some(refusal) = issuer_refusal(conn, workspace_id, member_id, policy).await? {
        return Ok(Err(refusal));
    }
    let live_cards: i64 = sqlx::query_scalar(COUNT_LIVE_CARDS_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .fetch_one(&mut *conn)
        .await?;
    if live_cards >= MAX_LIVE_CARDS {
        return Ok(Err(DevIssueError::LimitReached));
    }

    let secret = mint_dev_envelope(DEV_TOKEN_PREFIX, workspace_id)?;
    let row = sqlx::query(INSERT_DEV_CARD_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .bind(&secret)
        .bind(&scopes)
        .bind(&label)
        .bind(card.expires_in_days * SECONDS_PER_DAY)
        .bind(card.tool.as_db_label())
        .bind(channel_ids.as_deref())
        .fetch_one(&mut *conn)
        .await?;
    Ok(Ok(IssuedDevCard {
        id: row.try_get("id")?,
        secret,
        label,
        tool: card.tool,
        scopes,
        channel_ids,
        created_at_ms: row.try_get("created_at_ms")?,
        expires_at_ms: row.try_get("expires_at_ms")?,
    }))
}

/// Open one login lineage (D2 「로그인 세션」): access (15 min) + refresh (30
/// idle days) sharing a fresh `session_id`, both capped at approval + 90 days.
/// Same judgements as [`issue_dev_card_in_tx`], with [`MAX_LIVE_LINEAGES`].
pub async fn issue_dev_login_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    login: &NewDevLogin,
    policy: DevAccessPolicy,
) -> Result<Result<IssuedDevLogin, DevIssueError>, sqlx::Error> {
    let label = match normalized_dev_label(&login.label) {
        Ok(label) => label,
        Err(error) => return Ok(Err(error)),
    };
    let client = match normalized_dev_client(&login.client) {
        Ok(client) => client,
        Err(error) => return Ok(Err(error)),
    };
    let device_name = match normalized_dev_device_name(login.device_name.as_deref()) {
        Ok(name) => name,
        Err(error) => return Ok(Err(error)),
    };
    let scopes = match normalized_dev_scopes(Some(&login.scopes)) {
        Ok(scopes) => scopes,
        Err(error) => return Ok(Err(error)),
    };
    let channel_ids = match normalized_dev_channel_ids(login.channel_ids.as_deref()) {
        Ok(ids) => ids,
        Err(error) => return Ok(Err(error)),
    };

    lock_dev_issuance(conn, workspace_id, member_id).await?;
    if let Some(refusal) = issuer_refusal(conn, workspace_id, member_id, policy).await? {
        return Ok(Err(refusal));
    }
    let live_lineages: i64 = sqlx::query_scalar(COUNT_LIVE_LINEAGES_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .fetch_one(&mut *conn)
        .await?;
    if live_lineages >= MAX_LIVE_LINEAGES {
        return Ok(Err(DevIssueError::LimitReached));
    }

    let session_id = Uuid::new_v4();
    let lineage_seconds = MAX_LIFETIME_DAYS * SECONDS_PER_DAY;
    let access = mint_dev_envelope(DEV_TOKEN_PREFIX, workspace_id)?;
    let refresh = mint_dev_envelope(DEV_REFRESH_PREFIX, workspace_id)?;
    let mut inserted = Vec::with_capacity(2);
    for (raw, form, ttl_seconds) in [
        (&access, DevForm::Access, ACCESS_TTL_SECONDS),
        (
            &refresh,
            DevForm::Refresh,
            REFRESH_IDLE_DAYS * SECONDS_PER_DAY,
        ),
    ] {
        let row = sqlx::query(INSERT_DEV_LOGIN_HALF_SQL)
            .bind(workspace_id)
            .bind(member_id)
            .bind(raw.as_str())
            .bind(&scopes)
            .bind(&label)
            .bind(ttl_seconds)
            .bind(lineage_seconds)
            .bind(session_id)
            .bind(form.as_db_label())
            .bind(login.tool.as_db_label())
            .bind(channel_ids.as_deref())
            .bind(&client)
            .bind(device_name.as_deref())
            .fetch_one(&mut *conn)
            .await?;
        inserted.push((
            row.try_get::<Uuid, _>("id")?,
            row.try_get::<i64, _>("expires_at_ms")?,
            row.try_get::<i64, _>("lineage_expires_at_ms")?,
        ));
    }
    let (access_token_id, access_expires_at_ms, lineage_expires_at_ms) = inserted[0];
    let (refresh_token_id, refresh_expires_at_ms, _) = inserted[1];
    Ok(Ok(IssuedDevLogin {
        session_id,
        member_id,
        access_token_id,
        refresh_token_id,
        access,
        refresh,
        scopes,
        access_expires_at_ms,
        refresh_expires_at_ms,
        lineage_expires_at_ms,
    }))
}

// ---------------------------------------------------------------------------
// rotation (refresh) and reuse detection
// ---------------------------------------------------------------------------

/// What a presented refresh envelope resolved to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevRotation {
    /// The old pair is revoked and this is its successor (same lineage).
    Rotated(IssuedDevLogin),
    /// Unknown, not a refresh (an access or card envelope included), idle past
    /// 30 days, past the lineage cap, or the member is no longer an active
    /// human the policy admits. The route answers one 401.
    Invalid,
    /// The refresh was already revoked — rotated away (or ended): two parties
    /// hold the lineage. Every still-live row of it was revoked in this
    /// transaction (`revoked` rows; 0 when the lineage had already ended). The
    /// caller writes one audit row and **commits** — return this as `Ok` from
    /// the tenant closure and answer 401 afterwards; turning it into an error
    /// inside the closure rolls the revocation back (D2, R10).
    ReuseDetected {
        session_id: Uuid,
        member_id: Uuid,
        revoked: u64,
    },
}

/// Read-only first look: whose lineage is this? No lock yet — the sweep lock
/// must come before the first `token` row lock (#3109), and it is keyed by the
/// member this read finds. Everything is judged again under the locks.
const FIND_DEV_REFRESH_SQL: &str = "SELECT id, actor_member_id, session_id \
       FROM token \
      WHERE workspace_id = $1 \
        AND kind = 'dev' \
        AND dev_form = 'refresh' \
        AND token_hash = digest($2::text, 'sha256') \
      LIMIT 1";

/// THE developer-row lock: the named ids (revoked or not) plus every still-live
/// row of `lineage`, in ONE id-ordered acquisition — the `kind = 'dev'` sibling
/// of `token_store::LOCK_SESSION_ROWS_SQL`. Callers hold the member-wide sweep
/// lock first.
const LOCK_DEV_ROWS_SQL: &str = "SELECT id \
       FROM token \
      WHERE workspace_id = $1 \
        AND actor_member_id = $2 \
        AND kind = 'dev' \
        AND ( \
              id = ANY($3::uuid[]) \
           OR ($4::uuid IS NOT NULL AND session_id = $4 AND revoked_at IS NULL) \
            ) \
      ORDER BY id \
        FOR UPDATE";

/// The presented refresh, judged again under the locks.
const JUDGE_LOCKED_REFRESH_SQL: &str = "SELECT \
            revoked_at IS NOT NULL AS revoked, \
            expires_at <= now() AS expired, \
            dev_lineage_expires_at <= now() AS lineage_over \
       FROM token \
      WHERE workspace_id = $1 \
        AND id = $2 \
        AND actor_member_id = $3 \
        AND kind = 'dev' \
        AND dev_form = 'refresh'";

/// Is the lineage owner still an active human, and with which role?
const ACTIVE_HUMAN_ROLE_SQL: &str = "SELECT wm.role::text \
       FROM member m \
       JOIN workspace_membership wm \
         ON wm.workspace_id = m.workspace_id \
        AND wm.member_id = m.id \
      WHERE m.workspace_id = $1 \
        AND m.id = $2 \
        AND m.kind = 'human' \
        AND m.status = 'active' \
        AND m.deleted_at IS NULL";

/// Every still-live row of one lineage — access and refresh together.
const REVOKE_DEV_LINEAGE_SQL: &str = "UPDATE token \
        SET revoked_at = COALESCE(revoked_at, now()) \
      WHERE workspace_id = $1 \
        AND actor_member_id = $2 \
        AND kind = 'dev' \
        AND session_id = $3 \
        AND revoked_at IS NULL \
    RETURNING id";

/// One successor half, copied from the (locked) predecessor refresh in SQL so
/// the lineage cap, scopes, restriction, label, tool, client and device name
/// carry over exactly — no timestamp round-trips through Rust. The expiry is
/// `LEAST(now() + ttl, lineage cap)`: a rotation never mints past the cap (R5 c).
/// The new refresh records the rotation as the lineage's latest use.
const INSERT_DEV_SUCCESSOR_SQL: &str = "INSERT INTO token \
       (workspace_id, kind, actor_member_id, token_hash, scopes, label, expires_at, \
        created_by, session_id, last_used_at, dev_form, dev_tool, dev_channel_ids, \
        dev_client, dev_device_name, dev_lineage_expires_at) \
     SELECT p.workspace_id, 'dev', p.actor_member_id, digest($3::text, 'sha256'), \
            p.scopes, p.label, \
            LEAST(now() + ($4::bigint * interval '1 second'), p.dev_lineage_expires_at), \
            p.actor_member_id, p.session_id, \
            CASE WHEN $5 = 'refresh' THEN now() END, \
            $5, p.dev_tool, p.dev_channel_ids, p.dev_client, p.dev_device_name, \
            p.dev_lineage_expires_at \
       FROM token p \
      WHERE p.workspace_id = $1 \
        AND p.id = $2 \
        AND p.kind = 'dev' \
        AND p.dev_form = 'refresh' \
     RETURNING id, scopes, \
               (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms, \
               (EXTRACT(EPOCH FROM dev_lineage_expires_at) * 1000)::bigint \
                 AS lineage_expires_at_ms";

/// Take the member-wide sweep lock, then `ids` plus the live rows of `lineage`
/// in one id-ordered `FOR UPDATE`.
async fn lock_dev_rows_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    lineage: Option<Uuid>,
    ids: &[Uuid],
) -> Result<(), sqlx::Error> {
    lock_member_wide_sweep_in_tx(conn, workspace_id, member_id).await?;
    let mut ordered = ids.to_vec();
    ordered.sort_unstable();
    ordered.dedup();
    sqlx::query(LOCK_DEV_ROWS_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .bind(&ordered)
        .bind(lineage)
        .fetch_all(&mut *conn)
        .await?;
    Ok(())
}

async fn revoke_locked_dev_lineage(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    session_id: Uuid,
) -> Result<u64, sqlx::Error> {
    let rows = sqlx::query(REVOKE_DEV_LINEAGE_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .bind(session_id)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows.len() as u64)
}

/// Rotate one refresh envelope into a fresh pair of the same lineage.
///
/// Lock order: read the row (no lock) → member-wide sweep lock → the presented
/// row plus the lineage's live rows, id-ordered `FOR UPDATE` → judge again.
/// Two rotations of the same refresh therefore serialize: the second finds it
/// revoked, which is reuse — the whole lineage ends (the CLI serializes its own
/// refreshes for exactly this reason, D10). The partial unique indexes of 152
/// make "one live pair per lineage" a database fact as well.
pub async fn rotate_dev_refresh_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    raw_refresh: &str,
    policy: DevAccessPolicy,
) -> Result<DevRotation, sqlx::Error> {
    let found = sqlx::query(FIND_DEV_REFRESH_SQL)
        .bind(workspace_id)
        .bind(raw_refresh)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(found) = found else {
        return Ok(DevRotation::Invalid);
    };
    let refresh_id: Uuid = found.try_get("id")?;
    let member_id: Uuid = found.try_get("actor_member_id")?;
    let Some(session_id) = found.try_get::<Option<Uuid>, _>("session_id")? else {
        return Ok(DevRotation::Invalid);
    };

    lock_dev_rows_in_tx(
        conn,
        workspace_id,
        member_id,
        Some(session_id),
        &[refresh_id],
    )
    .await?;

    let judged = sqlx::query(JUDGE_LOCKED_REFRESH_SQL)
        .bind(workspace_id)
        .bind(refresh_id)
        .bind(member_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(judged) = judged else {
        return Ok(DevRotation::Invalid);
    };
    // Reuse first: a spent refresh is evidence of a second holder even when it
    // has since expired.
    if judged.try_get::<bool, _>("revoked")? {
        let revoked = revoke_locked_dev_lineage(conn, workspace_id, member_id, session_id).await?;
        return Ok(DevRotation::ReuseDetected {
            session_id,
            member_id,
            revoked,
        });
    }
    if judged.try_get::<bool, _>("expired")? {
        return Ok(DevRotation::Invalid);
    }
    if judged.try_get::<bool, _>("lineage_over")? {
        return Ok(DevRotation::Invalid);
    }
    let role: Option<String> = sqlx::query_scalar(ACTIVE_HUMAN_ROLE_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(role) = role else {
        return Ok(DevRotation::Invalid);
    };
    if !policy.allows_role(&role) {
        return Ok(DevRotation::Invalid);
    }

    // The old pair first: the unique indexes refuse a second live pair.
    revoke_locked_dev_lineage(conn, workspace_id, member_id, session_id).await?;

    let access = mint_dev_envelope(DEV_TOKEN_PREFIX, workspace_id)?;
    let refresh = mint_dev_envelope(DEV_REFRESH_PREFIX, workspace_id)?;
    let mut inserted = Vec::with_capacity(2);
    for (raw, form, ttl_seconds) in [
        (&access, DevForm::Access, ACCESS_TTL_SECONDS),
        (
            &refresh,
            DevForm::Refresh,
            REFRESH_IDLE_DAYS * SECONDS_PER_DAY,
        ),
    ] {
        let row = sqlx::query(INSERT_DEV_SUCCESSOR_SQL)
            .bind(workspace_id)
            .bind(refresh_id)
            .bind(raw.as_str())
            .bind(ttl_seconds)
            .bind(form.as_db_label())
            .fetch_one(&mut *conn)
            .await?;
        inserted.push((
            row.try_get::<Uuid, _>("id")?,
            row.try_get::<Vec<String>, _>("scopes")?,
            row.try_get::<i64, _>("expires_at_ms")?,
            row.try_get::<i64, _>("lineage_expires_at_ms")?,
        ));
    }
    let (refresh_token_id, _, refresh_expires_at_ms, _) = inserted.pop().expect("refresh row");
    let (access_token_id, scopes, access_expires_at_ms, lineage_expires_at_ms) =
        inserted.pop().expect("access row");
    Ok(DevRotation::Rotated(IssuedDevLogin {
        session_id,
        member_id,
        access_token_id,
        refresh_token_id,
        access,
        refresh,
        scopes,
        access_expires_at_ms,
        refresh_expires_at_ms,
        lineage_expires_at_ms,
    }))
}

// ---------------------------------------------------------------------------
// list (D6 가-4)
// ---------------------------------------------------------------------------

/// One row of the credential list: a card, or a login lineage (`id` is its
/// `session_id`). No secret, no hash, no channel ids — only whether a
/// restriction exists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevCredentialRecord {
    pub id: Uuid,
    pub member_id: Uuid,
    /// [`DEV_CREDENTIAL_KIND_CARD`] or [`DEV_CREDENTIAL_KIND_SESSION`].
    pub kind: &'static str,
    pub label: String,
    pub tool: Option<String>,
    pub scopes: Vec<String>,
    pub channel_restricted: bool,
    pub device_name: Option<String>,
    /// Card: issuance. Lineage: approval (its cap minus 90 days).
    pub created_at_ms: i64,
    /// Lineage: the later of its last rotation and its live access's last use.
    pub last_used_at_ms: Option<i64>,
    /// Card: its expiry. Lineage: its live refresh's (idle or cap).
    pub expires_at_ms: i64,
    pub lineage_expires_at_ms: Option<i64>,
}

/// Which credentials to list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevListScope {
    /// One member's (the route uses it for "mine").
    Member(Uuid),
    /// The whole workspace (`?scope=all`, owner/admin — the route's check).
    All,
}

/// Live cards ∪ live lineages (one row per lineage: its live refresh, with the
/// live access joined for the last use). `$2` NULL = the whole workspace.
const LIST_DEV_CREDENTIALS_SQL: &str = "SELECT t.id, t.actor_member_id, 'card' AS kind, \
            t.label, t.dev_tool, t.scopes, \
            (t.dev_channel_ids IS NOT NULL) AS channel_restricted, \
            t.dev_device_name, \
            (EXTRACT(EPOCH FROM t.created_at) * 1000)::bigint AS created_at_ms, \
            (EXTRACT(EPOCH FROM t.last_used_at) * 1000)::bigint AS last_used_at_ms, \
            (EXTRACT(EPOCH FROM t.expires_at) * 1000)::bigint AS expires_at_ms, \
            NULL::bigint AS lineage_expires_at_ms \
       FROM token t \
      WHERE t.workspace_id = $1 \
        AND ($2::uuid IS NULL OR t.actor_member_id = $2) \
        AND t.kind = 'dev' \
        AND t.dev_form = 'card' \
        AND t.revoked_at IS NULL \
        AND t.expires_at > now() \
     UNION ALL \
     SELECT r.session_id AS id, r.actor_member_id, 'session' AS kind, \
            r.label, r.dev_tool, r.scopes, \
            (r.dev_channel_ids IS NOT NULL) AS channel_restricted, \
            r.dev_device_name, \
            (EXTRACT(EPOCH FROM (r.dev_lineage_expires_at - interval '2160 hours')) * 1000)::bigint \
              AS created_at_ms, \
            (EXTRACT(EPOCH FROM GREATEST(r.last_used_at, a.last_used_at)) * 1000)::bigint \
              AS last_used_at_ms, \
            (EXTRACT(EPOCH FROM r.expires_at) * 1000)::bigint AS expires_at_ms, \
            (EXTRACT(EPOCH FROM r.dev_lineage_expires_at) * 1000)::bigint \
              AS lineage_expires_at_ms \
       FROM token r \
       LEFT JOIN token a \
         ON a.workspace_id = r.workspace_id \
        AND a.session_id = r.session_id \
        AND a.kind = 'dev' \
        AND a.dev_form = 'access' \
        AND a.revoked_at IS NULL \
      WHERE r.workspace_id = $1 \
        AND ($2::uuid IS NULL OR r.actor_member_id = $2) \
        AND r.kind = 'dev' \
        AND r.dev_form = 'refresh' \
        AND r.revoked_at IS NULL \
        AND r.expires_at > now() \
      ORDER BY created_at_ms DESC, id DESC";

pub async fn list_dev_credentials_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    scope: DevListScope,
) -> Result<Vec<DevCredentialRecord>, sqlx::Error> {
    let member = match scope {
        DevListScope::Member(member_id) => Some(member_id),
        DevListScope::All => None,
    };
    let rows = sqlx::query(LIST_DEV_CREDENTIALS_SQL)
        .bind(workspace_id)
        .bind(member)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter()
        .map(|row| {
            let kind: String = row.try_get("kind")?;
            Ok(DevCredentialRecord {
                id: row.try_get("id")?,
                member_id: row.try_get("actor_member_id")?,
                kind: if kind == DEV_CREDENTIAL_KIND_CARD {
                    DEV_CREDENTIAL_KIND_CARD
                } else {
                    DEV_CREDENTIAL_KIND_SESSION
                },
                label: row.try_get("label")?,
                tool: row.try_get("dev_tool")?,
                scopes: row.try_get("scopes")?,
                channel_restricted: row.try_get("channel_restricted")?,
                device_name: row.try_get("dev_device_name")?,
                created_at_ms: row.try_get("created_at_ms")?,
                last_used_at_ms: row.try_get("last_used_at_ms")?,
                expires_at_ms: row.try_get("expires_at_ms")?,
                lineage_expires_at_ms: row.try_get("lineage_expires_at_ms")?,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// revocation (D7)
// ---------------------------------------------------------------------------

const CARD_OWNER_SQL: &str = "SELECT actor_member_id \
       FROM token \
      WHERE workspace_id = $1 \
        AND id = $2 \
        AND kind = 'dev' \
        AND dev_form = 'card'";

const LINEAGE_OWNER_SQL: &str = "SELECT actor_member_id \
       FROM token \
      WHERE workspace_id = $1 \
        AND session_id = $2 \
        AND kind = 'dev' \
        AND dev_form IN ('access', 'refresh') \
      LIMIT 1";

/// Who owns the credential `id` names: a card's token id, or a lineage's
/// `session_id` (the list's ids). Revoked and expired ones are found too, so a
/// repeated DELETE stays 200. A lineage reports [`DevForm::Refresh`] (it is not
/// a card). `None` for anything else — including another workspace's id, which
/// RLS and the `workspace_id` predicate both hide.
pub async fn dev_credential_owner_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    id: Uuid,
) -> Result<Option<(Uuid, DevForm)>, sqlx::Error> {
    let card: Option<Uuid> = sqlx::query_scalar(CARD_OWNER_SQL)
        .bind(workspace_id)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    if let Some(owner) = card {
        return Ok(Some((owner, DevForm::Card)));
    }
    let lineage: Option<Uuid> = sqlx::query_scalar(LINEAGE_OWNER_SQL)
        .bind(workspace_id)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(lineage.map(|owner| (owner, DevForm::Refresh)))
}

/// One card. A single row, so no sweep lock (#3109).
const REVOKE_DEV_CARD_SQL: &str = "UPDATE token \
        SET revoked_at = COALESCE(revoked_at, now()) \
      WHERE workspace_id = $1 \
        AND id = $2 \
        AND actor_member_id = $3 \
        AND kind = 'dev' \
        AND dev_form = 'card' \
        AND revoked_at IS NULL \
    RETURNING id";

async fn revoke_dev_card(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    card_id: Uuid,
) -> Result<u64, sqlx::Error> {
    let rows = sqlx::query(REVOKE_DEV_CARD_SQL)
        .bind(workspace_id)
        .bind(card_id)
        .bind(member_id)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows.len() as u64)
}

pub(crate) async fn revoke_dev_lineage(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    session_id: Uuid,
) -> Result<u64, sqlx::Error> {
    lock_dev_rows_in_tx(conn, workspace_id, member_id, Some(session_id), &[]).await?;
    revoke_locked_dev_lineage(conn, workspace_id, member_id, session_id).await
}

/// Revoke what `id` names (a card, or a whole lineage). Idempotent: an
/// already-revoked or unknown id is `Ok(0)`. The ladder (who may revoke whose)
/// is the route's, on [`dev_credential_owner_in_tx`]'s answer.
pub async fn revoke_dev_credential_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    id: Uuid,
) -> Result<u64, sqlx::Error> {
    let Some((owner, form)) = dev_credential_owner_in_tx(conn, workspace_id, id).await? else {
        return Ok(0);
    };
    match form {
        DevForm::Card => revoke_dev_card(conn, workspace_id, owner, id).await,
        DevForm::Access | DevForm::Refresh => {
            revoke_dev_lineage(conn, workspace_id, owner, id).await
        }
    }
}

/// L2 `oort logout`: the calling card, or the calling access token's lineage —
/// nothing else of the member (R21 c). There is no id argument by design.
pub async fn revoke_dev_self_in_tx(
    conn: &mut PgConnection,
    identity: &DevIdentity,
) -> Result<u64, sqlx::Error> {
    match identity.form {
        DevForm::Card => {
            revoke_dev_card(
                conn,
                identity.workspace_id,
                identity.member_id,
                identity.token_id,
            )
            .await
        }
        DevForm::Access | DevForm::Refresh => {
            let Some(session_id) = identity.session_id else {
                return Ok(0);
            };
            revoke_dev_lineage(conn, identity.workspace_id, identity.member_id, session_id).await
        }
    }
}

/// The member-wide lock: every live developer row of the member in one
/// `ORDER BY id FOR UPDATE`, under the sweep lock.
const LOCK_MEMBER_LIVE_DEV_ROWS_SQL: &str = "SELECT id \
       FROM token \
      WHERE workspace_id = $1 \
        AND actor_member_id = $2 \
        AND kind = 'dev' \
        AND revoked_at IS NULL \
      ORDER BY id \
        FOR UPDATE";

const REVOKE_MEMBER_DEV_SQL: &str = "UPDATE token \
        SET revoked_at = COALESCE(revoked_at, now()) \
      WHERE workspace_id = $1 \
        AND actor_member_id = $2 \
        AND kind = 'dev' \
        AND revoked_at IS NULL \
    RETURNING id";

/// Every developer token of one member — cards and every lineage (access and
/// refresh) — plus the browser-login codes still waiting for their exchange.
/// Called from `token_store::revoke_member_session_tokens`, so a password change
/// or reset ends them in the same transaction (D7, R9).
pub async fn revoke_member_dev_tokens_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<u64, sqlx::Error> {
    lock_member_wide_sweep_in_tx(conn, workspace_id, member_id).await?;
    sqlx::query(LOCK_MEMBER_LIVE_DEV_ROWS_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .fetch_all(&mut *conn)
        .await?;
    let rows = sqlx::query(REVOKE_MEMBER_DEV_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .fetch_all(&mut *conn)
        .await?;
    // A browser approval that has not been exchanged yet would open a brand-new
    // lineage moments after this sweep (D7 / R9, #4700): burn it under the same
    // lock, in the same transaction. The returned count stays "tokens ended".
    crate::dev_login::invalidate_pending_dev_logins_in_tx(conn, workspace_id, member_id).await?;
    Ok(rows.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_credential::{
        DEFAULT_AGENT_CREDENTIAL_SCOPES, GRANTABLE_AGENT_CREDENTIAL_SCOPES,
    };
    use crate::agent_scope::{
        SCOPE_AGENT_INBOX_READ, SCOPE_AGENT_JOBS_READ, SCOPE_AGENT_PORT_CONNECT,
        SCOPE_AGENT_RUNS_CALLBACK, SCOPE_MESSAGES_READ, SCOPE_MESSAGES_WRITE,
        SCOPE_WORKSPACE_PROPOSE, SCOPE_WORK_CONTROL,
    };
    use crate::hosted_connection::HOSTED_AGENT_SCOPES;
    use crate::push_action_token::SCOPE_PUSH_ACTION;
    use crate::push_fetch_token::SCOPE_PUSH_FETCH;
    use crate::token_store::{PRIVILEGED_SCOPES, SCOPE_REALTIME_SUBSCRIBE};

    const WS: &str = "0190f2a4-6b1d-7c3e-8f00-00000000a1a1";

    fn workspace() -> Uuid {
        Uuid::parse_str(WS).unwrap()
    }

    fn envelope(prefix: &str, secret_chars: usize) -> String {
        format!("{prefix}.{WS}.{}", "A".repeat(secret_chars))
    }

    // -- envelope ------------------------------------------------------------

    #[test]
    fn a_card_or_access_envelope_names_its_workspace() {
        assert_eq!(
            dev_token_workspace_id(&envelope(DEV_TOKEN_PREFIX, 43)),
            Some(workspace())
        );
        // ≥ 43, like the agent bearer.
        assert_eq!(
            dev_token_workspace_id(&envelope(DEV_TOKEN_PREFIX, 44)),
            Some(workspace())
        );
        assert_eq!(
            dev_refresh_workspace_id(&envelope(DEV_REFRESH_PREFIX, 43)),
            Some(workspace())
        );
    }

    #[test]
    fn a_secret_one_short_of_32_bytes_is_not_an_envelope() {
        assert_eq!(
            dev_token_workspace_id(&envelope(DEV_TOKEN_PREFIX, 42)),
            None
        );
        assert_eq!(
            dev_refresh_workspace_id(&envelope(DEV_REFRESH_PREFIX, 42)),
            None
        );
        assert_eq!(
            dev_token_workspace_id(&format!("{DEV_TOKEN_PREFIX}.{WS}.")),
            None
        );
    }

    #[test]
    fn the_two_prefixes_never_cross() {
        let card = envelope(DEV_TOKEN_PREFIX, 43);
        let refresh = envelope(DEV_REFRESH_PREFIX, 43);
        assert_eq!(dev_refresh_workspace_id(&card), None);
        assert_eq!(dev_token_workspace_id(&refresh), None);
    }

    #[test]
    fn other_credential_shapes_are_not_developer_envelopes() {
        for raw in [
            envelope("momo_agent_v1", 43),
            envelope("momo_pair_v1", 43),
            envelope("momo_oauth_at_v1", 43),
            envelope("momo_oauth_rt_v1", 43),
            envelope("momo_dev_v2", 43),
            envelope("MOMO_DEV_V1", 43),
            envelope("momo_dev_v1 ", 43),
            // An App JWT is three dot-separated parts too; only the prefix
            // separates them.
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLWJ5dGVzLWFyZS1oZXJlLWFuZC1sb25n"
                .to_string(),
            String::new(),
            "momo_dev_v1".to_string(),
            format!("momo_dev_v1.{WS}"),
        ] {
            assert_eq!(dev_token_workspace_id(&raw), None, "{raw}");
            assert_eq!(dev_refresh_workspace_id(&raw), None, "{raw}");
        }
    }

    #[test]
    fn only_the_minted_workspace_spelling_and_secret_alphabet_parse() {
        let secret = "A".repeat(43);
        for raw in [
            // uppercase, simple, braced and URN uuid spellings
            format!("momo_dev_v1.{}.{secret}", WS.to_ascii_uppercase()),
            format!("momo_dev_v1.{}.{secret}", workspace().simple()),
            format!("momo_dev_v1.{{{WS}}}.{secret}"),
            format!("momo_dev_v1.not-a-uuid.{secret}"),
            // padded / standard-alphabet / whitespace secrets
            format!("momo_dev_v1.{WS}.{}=", "A".repeat(43)),
            format!("momo_dev_v1.{WS}.{}+/", "A".repeat(43)),
            format!("momo_dev_v1.{WS}.{} ", "A".repeat(43)),
            // a fourth segment
            format!("momo_dev_v1.{WS}.{secret}.x"),
        ] {
            assert_eq!(dev_token_workspace_id(&raw), None, "{raw}");
        }
        assert_eq!(
            dev_token_workspace_id(&format!("momo_dev_v1.{WS}.{}-_9z", "A".repeat(40))),
            Some(workspace()),
            "the base64url alphabet itself parses"
        );
    }

    #[test]
    fn minted_envelopes_round_trip_and_carry_32_fresh_bytes() {
        let card = mint_dev_envelope(DEV_TOKEN_PREFIX, workspace()).unwrap();
        let refresh = mint_dev_envelope(DEV_REFRESH_PREFIX, workspace()).unwrap();
        assert_eq!(dev_token_workspace_id(&card), Some(workspace()));
        assert_eq!(dev_refresh_workspace_id(&refresh), Some(workspace()));
        for raw in [&card, &refresh] {
            let secret = raw.rsplit('.').next().unwrap();
            assert_eq!(secret.len(), 43);
            assert_eq!(URL_SAFE_NO_PAD.decode(secret).unwrap().len(), SECRET_BYTES);
        }
        assert_ne!(
            mint_dev_envelope(DEV_TOKEN_PREFIX, workspace()).unwrap(),
            card,
            "every mint draws fresh entropy"
        );
    }

    // -- route table (R3 a) -----------------------------------------------------

    #[test]
    fn each_table_row_maps_its_exact_method_and_template() {
        let rows = [
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
        for (method, template, scope) in rows {
            assert_eq!(
                required_dev_scope(method, template),
                Some(scope),
                "{method} {template}"
            );
        }
        assert_eq!(
            DEV_ROUTE_TABLE.len(),
            rows.len(),
            "the table is L1-L8, no more"
        );
    }

    #[test]
    fn methods_outside_the_table_are_refused_on_every_template() {
        for route in DEV_ROUTE_TABLE {
            for method in ["HEAD", "OPTIONS", "PUT", "PATCH", "TRACE", "CONNECT"] {
                assert_eq!(
                    required_dev_scope(method, route.template),
                    None,
                    "{method} {}",
                    route.template
                );
            }
            assert_eq!(
                required_dev_scope(&route.method.to_ascii_lowercase(), route.template),
                None,
                "lowercase {}",
                route.method
            );
        }
        // The other verbs of the tabled templates.
        assert_eq!(
            required_dev_scope("POST", "/v1/workspaces/{ws}/channels"),
            None
        );
        assert_eq!(
            required_dev_scope("DELETE", "/v1/workspaces/{ws}/channels/{ch}/messages"),
            None
        );
        assert_eq!(required_dev_scope("GET", "/v1/mcp/me"), None);
        assert_eq!(required_dev_scope("DELETE", "/v1/mcp/me"), None);
    }

    #[test]
    fn template_variants_never_resolve() {
        for route in DEV_ROUTE_TABLE {
            let trailing = format!("{}/", route.template);
            let upper = route.template.to_ascii_uppercase();
            let doubled = route.template.replacen("/v1/", "//v1/", 1);
            for variant in [trailing, upper, doubled] {
                assert_eq!(
                    required_dev_scope(route.method, &variant),
                    None,
                    "{variant}"
                );
            }
        }
        // A static sibling of `{ch}` is its own template, not a tabled one.
        for raw in [
            "/v1/workspaces/{ws}/channels/archived/messages",
            "/v1/workspaces/{ws}/channels/{ch}/messages/archived/replies",
            "/v1/workspaces/0190f2a4-6b1d-7c3e-8f00-00000000a1a1/channels",
            "/v1/workspaces/{workspace_id}/channels",
            "",
        ] {
            assert_eq!(required_dev_scope("GET", raw), None, "{raw}");
            assert_eq!(required_dev_scope("POST", raw), None, "{raw}");
        }
    }

    #[test]
    fn surfaces_the_adr_closes_stay_closed() {
        for (method, template) in [
            // issuing / listing / revoking developer tokens (R3 d)
            ("GET", "/v1/workspaces/{ws}/dev-access"),
            ("POST", "/v1/workspaces/{ws}/dev-access/credentials"),
            ("GET", "/v1/workspaces/{ws}/dev-access/credentials"),
            ("DELETE", "/v1/workspaces/{ws}/dev-access/credentials/{id}"),
            // approvals, the Agent Port, edits, reactions, search, read state
            ("POST", "/v1/agent-runs/{run}/approval-decisions"),
            ("POST", "/v1/mcp/agent-port"),
            ("PATCH", "/v1/workspaces/{ws}/messages/{id}"),
            ("DELETE", "/v1/workspaces/{ws}/messages/{id}"),
            ("POST", "/v1/workspaces/{ws}/messages/{id}/reactions"),
            ("GET", "/v1/workspaces/{ws}/search"),
            ("POST", "/v1/workspaces/{ws}/inbox/read"),
            ("POST", "/v1/realtime/token"),
        ] {
            assert_eq!(
                required_dev_scope(method, template),
                None,
                "{method} {template}"
            );
        }
    }

    // -- scopes (R4) ----------------------------------------------------------

    fn every_existing_scope() -> Vec<&'static str> {
        let mut all = vec![
            SCOPE_AGENT_JOBS_READ,
            SCOPE_AGENT_RUNS_CALLBACK,
            SCOPE_MESSAGES_WRITE,
            SCOPE_WORK_CONTROL,
            SCOPE_AGENT_PORT_CONNECT,
            SCOPE_AGENT_INBOX_READ,
            SCOPE_MESSAGES_READ,
            SCOPE_WORKSPACE_PROPOSE,
            SCOPE_REALTIME_SUBSCRIBE,
            SCOPE_PUSH_ACTION,
            SCOPE_PUSH_FETCH,
        ];
        all.extend(PRIVILEGED_SCOPES);
        all.extend(HOSTED_AGENT_SCOPES);
        all.extend(DEFAULT_AGENT_CREDENTIAL_SCOPES);
        all.extend(GRANTABLE_AGENT_CREDENTIAL_SCOPES);
        all
    }

    #[test]
    fn dev_scopes_are_disjoint_from_every_existing_scope() {
        // SABOTAGE(rename): `SCOPE_DEV_MESSAGES_READ = "messages:read"` → red.
        let existing = every_existing_scope();
        for scope in DEV_SCOPES.iter().chain([&DEV_SCOPE_SEARCH_RESERVED]) {
            assert!(
                !existing.contains(scope),
                "{scope} collides with an existing scope"
            );
        }
    }

    #[test]
    fn the_dev_namespace_is_exclusive_both_ways() {
        for scope in DEV_SCOPES.iter().chain([&DEV_SCOPE_SEARCH_RESERVED]) {
            assert!(scope.starts_with("dev:"), "{scope}");
        }
        for scope in every_existing_scope() {
            assert!(
                !scope.starts_with("dev:"),
                "{scope} squats the dev: namespace"
            );
        }
        let mut sorted = DEV_SCOPES.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), DEV_SCOPES.len(), "no duplicate dev scope");
        assert!(!DEV_SCOPES.contains(&DEV_SCOPE_SEARCH_RESERVED));
    }

    #[test]
    fn agent_and_hosted_grants_refuse_dev_scopes() {
        for scope in DEV_SCOPES {
            assert!(
                crate::normalized_agent_credential_scopes(Some(&[scope.to_string()])).is_err(),
                "an agent credential must not be grantable {scope}"
            );
            assert!(
                crate::validate_hosted_scopes(&[
                    SCOPE_AGENT_PORT_CONNECT.to_string(),
                    scope.to_string()
                ])
                .is_err(),
                "a hosted credential must not be grantable {scope}"
            );
        }
    }

    #[test]
    fn omitted_scopes_are_the_read_only_preset() {
        assert_eq!(
            normalized_dev_scopes(None).unwrap(),
            vec![
                "dev:identity",
                "dev:channels:read",
                "dev:messages:read",
                "dev:inbox:read"
            ]
        );
        assert!(!normalized_dev_scopes(None)
            .unwrap()
            .iter()
            .any(|scope| scope == SCOPE_DEV_MESSAGES_WRITE));
    }

    #[test]
    fn requested_scopes_are_closed_canonical_and_always_carry_identity() {
        let requested = vec![
            " DEV:MESSAGES:WRITE ".to_string(),
            "dev:messages:write".to_string(),
            "dev:channels:read".to_string(),
        ];
        assert_eq!(
            normalized_dev_scopes(Some(&requested)).unwrap(),
            vec!["dev:identity", "dev:channels:read", "dev:messages:write"]
        );
        assert_eq!(
            normalized_dev_scopes(Some(&[])).unwrap(),
            vec!["dev:identity"]
        );
        for refused in [DEV_SCOPE_SEARCH_RESERVED, "messages:read", "dev:admin", ""] {
            assert_eq!(
                normalized_dev_scopes(Some(&[refused.to_string()])),
                Err(DevIssueError::InvalidInput("scopes")),
                "{refused}"
            );
        }
    }

    // -- policy (D3) ----------------------------------------------------------

    #[test]
    fn the_fixed_policy_is_admins_owner_and_admin_only() {
        assert_eq!(FIXED_POLICY, DevAccessPolicy::Admins);
        assert_eq!(FIXED_POLICY.as_str(), "admins");
        use WorkspaceRole::{Admin, Guest, Member, Owner};
        assert!(FIXED_POLICY.allows(Owner));
        assert!(FIXED_POLICY.allows(Admin));
        assert!(!FIXED_POLICY.allows(Member));
        assert!(!FIXED_POLICY.allows(Guest));
    }

    #[test]
    fn guests_are_never_admitted_and_off_admits_no_one() {
        use WorkspaceRole::{Admin, Guest, Member, Owner};
        for policy in [
            DevAccessPolicy::Admins,
            DevAccessPolicy::Members,
            DevAccessPolicy::Off,
        ] {
            assert!(!policy.allows(Guest), "{policy:?}");
            assert!(!policy.allows_role("guest"), "{policy:?}");
            assert!(!policy.allows_role("platform_admin"), "{policy:?}");
            assert!(
                !policy.allows_role("OWNER"),
                "{policy:?}: exact labels only"
            );
        }
        assert!(DevAccessPolicy::Members.allows(Member));
        assert!(DevAccessPolicy::Members.allows(Owner));
        assert!(DevAccessPolicy::Members.allows(Admin));
        assert!(DevAccessPolicy::Off.allowed_roles().is_empty());
        for role in [Owner, Admin, Member, Guest] {
            assert!(!DevAccessPolicy::Off.allows(role));
        }
    }

    // -- input ----------------------------------------------------------------

    #[test]
    fn names_are_trimmed_bounded_and_free_of_control_characters() {
        assert_eq!(
            normalized_dev_label("  노트북 CLI  ").unwrap(),
            "노트북 CLI"
        );
        assert_eq!(
            normalized_dev_label(&"가".repeat(80)).unwrap(),
            "가".repeat(80)
        );
        for refused in [
            String::new(),
            "   ".to_string(),
            "가".repeat(81),
            "a\nb".to_string(),
            "a\tb".to_string(),
            "a\u{7f}b".to_string(),
            "a\u{85}b".to_string(),
            "a\u{1b}[31mb".to_string(),
        ] {
            assert_eq!(
                normalized_dev_label(&refused),
                Err(DevIssueError::InvalidInput("name")),
                "{refused:?}"
            );
        }
    }

    #[test]
    fn a_pasted_secret_cannot_become_a_name() {
        let secret = mint_dev_envelope(DEV_TOKEN_PREFIX, workspace()).unwrap();
        let refresh = mint_dev_envelope(DEV_REFRESH_PREFIX, workspace()).unwrap();
        assert!(normalized_dev_label(&format!("mine {}", &secret[..60])).is_err());
        assert!(normalized_dev_label(&refresh[..60].to_ascii_uppercase()).is_err());
        assert!(normalized_dev_device_name(Some(&secret[..60])).is_err());
    }

    #[test]
    fn device_names_and_clients_follow_the_same_rules() {
        assert_eq!(normalized_dev_device_name(None).unwrap(), None);
        assert_eq!(normalized_dev_device_name(Some("  ")).unwrap(), None);
        assert_eq!(
            normalized_dev_device_name(Some(" oort CLI · macOS ")).unwrap(),
            Some("oort CLI · macOS".to_string())
        );
        assert!(normalized_dev_device_name(Some(&"x".repeat(81))).is_err());
        assert!(normalized_dev_device_name(Some("a\rb")).is_err());
        // Direction overrides, isolates, zero-width marks and the BOM can reorder or hide
        // the text next to the server host on the consent screen: refused (Cf, not Cc).
        for spoof in [
            "oort\u{202E}gnp.exe",
            "oort\u{2066}CLI",
            "oort\u{200B}CLI",
            "oort\u{200F}CLI",
            "oort\u{2060}CLI",
            "\u{FEFF}oort CLI",
        ] {
            assert!(
                normalized_dev_device_name(Some(spoof)).is_err(),
                "{spoof:?} must be refused"
            );
        }
        // Ordinary non-ASCII names are fine.
        assert_eq!(
            normalized_dev_device_name(Some("이도현의 맥북")).unwrap(),
            Some("이도현의 맥북".to_string())
        );
        assert_eq!(normalized_dev_client("oort-cli").unwrap(), "oort-cli");
        assert!(normalized_dev_client("").is_err());
        assert!(normalized_dev_client(&"c".repeat(201)).is_err());
    }

    #[test]
    fn channel_restrictions_hold_one_to_fifty_distinct_ids() {
        assert_eq!(normalized_dev_channel_ids(None).unwrap(), None);
        assert_eq!(
            normalized_dev_channel_ids(Some(&[])),
            Err(DevIssueError::InvalidInput("channel_ids"))
        );
        let fifty: Vec<Uuid> = (1..=50).map(Uuid::from_u128).collect();
        assert_eq!(
            normalized_dev_channel_ids(Some(&fifty)).unwrap(),
            Some(fifty.clone())
        );
        let fifty_one: Vec<Uuid> = (1..=51).map(Uuid::from_u128).collect();
        assert!(normalized_dev_channel_ids(Some(&fifty_one)).is_err());
        let repeated = [Uuid::from_u128(7), Uuid::from_u128(7), Uuid::from_u128(3)];
        assert_eq!(
            normalized_dev_channel_ids(Some(&repeated)).unwrap(),
            Some(vec![Uuid::from_u128(7), Uuid::from_u128(3)])
        );
    }

    #[test]
    fn card_lifetimes_default_to_thirty_and_stop_at_ninety_days() {
        assert_eq!(validated_dev_card_days(None), Ok(30));
        assert_eq!(validated_dev_card_days(Some(1)), Ok(1));
        assert_eq!(validated_dev_card_days(Some(90)), Ok(90));
        for refused in [0, -1, 91, i64::MAX, i64::MIN] {
            assert_eq!(
                validated_dev_card_days(Some(refused)),
                Err(DevIssueError::InvalidInput("expires_in_days")),
                "{refused}"
            );
        }
    }

    #[test]
    fn the_sealed_lifetimes_and_limits() {
        assert_eq!(DEFAULT_CARD_DAYS, 30);
        assert_eq!(MAX_LIFETIME_DAYS, 90);
        assert_eq!(ACCESS_TTL_SECONDS, 900);
        assert_eq!(REFRESH_IDLE_DAYS, 30);
        assert_eq!(MAX_LIVE_CARDS, 20);
        assert_eq!(MAX_LIVE_LINEAGES, 10);
        assert_eq!(MAX_CHANNEL_IDS, 50);
    }

    // -- vocabulary -----------------------------------------------------------

    #[test]
    fn forms_and_tools_round_trip_their_stored_labels() {
        for form in [DevForm::Card, DevForm::Access, DevForm::Refresh] {
            assert_eq!(DevForm::from_db_label(form.as_db_label()), Some(form));
        }
        assert_eq!(DevForm::from_db_label("session"), None);
        for tool in [
            DevTool::ClaudeCode,
            DevTool::Codex,
            DevTool::Cli,
            DevTool::Other,
        ] {
            assert_eq!(DevTool::from_db_label(tool.as_db_label()), Some(tool));
        }
        assert_eq!(DevTool::from_db_label("Claude Code"), None);
        assert_eq!(DevTool::from_db_label("CLI"), None);
    }

    // -- secrets stay out of Debug ---------------------------------------------

    #[test]
    fn issued_secrets_never_reach_debug_output() {
        let secret = mint_dev_envelope(DEV_TOKEN_PREFIX, workspace()).unwrap();
        let access = mint_dev_envelope(DEV_TOKEN_PREFIX, workspace()).unwrap();
        let refresh = mint_dev_envelope(DEV_REFRESH_PREFIX, workspace()).unwrap();
        let card = IssuedDevCard {
            id: Uuid::from_u128(1),
            secret: secret.clone(),
            label: "노트북".to_string(),
            tool: DevTool::Cli,
            scopes: normalized_dev_scopes(None).unwrap(),
            channel_ids: None,
            created_at_ms: 1,
            expires_at_ms: 2,
        };
        let login = IssuedDevLogin {
            session_id: Uuid::from_u128(2),
            member_id: Uuid::from_u128(3),
            access_token_id: Uuid::from_u128(4),
            refresh_token_id: Uuid::from_u128(5),
            access: access.clone(),
            refresh: refresh.clone(),
            scopes: vec![SCOPE_DEV_IDENTITY.to_string()],
            access_expires_at_ms: 1,
            refresh_expires_at_ms: 2,
            lineage_expires_at_ms: 3,
        };
        let printed = [
            format!("{card:?}"),
            format!("{card:#?}"),
            format!("{login:?}"),
            format!("{:?}", DevRotation::Rotated(login.clone())),
        ];
        for text in printed {
            for raw in [&secret, &access, &refresh] {
                let tail = raw.rsplit('.').next().unwrap();
                assert!(!text.contains(tail), "a secret leaked into {text}");
            }
            assert!(text.contains("<redacted>"));
        }
    }
}
