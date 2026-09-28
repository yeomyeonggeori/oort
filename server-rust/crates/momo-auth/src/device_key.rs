//! A person's device signing keys — ADR-0146 개정 2026-09-28 (R2-E2, #3022).
//!
//! Store and rules for `member_device_key` (migration 094). The bytes a key
//! signs are E1's ([`momo_wire::human_control`]); this module decides which
//! rows those bytes are rebuilt from and what a verified letter changes.
//!
//! ## Rules the server holds (advisory — workd is the boundary, D-10)
//!
//! * **Own keys only.** Every write names the caller's member id, never one
//!   from the request. A key live under another member cannot be registered
//!   again (the live-key unique index), a letter cannot name another member's
//!   key, and neither can a root.
//! * **Lineage-bound.** A key is registered under the caller's session lineage
//!   and only while that lineage can still rotate
//!   ([`crate::lock_live_session_lineage`]); ending the lineage revokes it
//!   ([`revoke_session_device_keys_in_tx`], [`revoke_member_device_keys_in_tx`]).
//! * **Root candidate** = a live `macos` key with no endorsement (D-6 ①). The
//!   server cannot tell the host Mac's key from any other Mac's; workd pins the
//!   real root over its local socket. What the server refuses is every shape
//!   the chain can never have.
//! * **Endorsement** (D-6 ②): a `device_endorse.v1` letter from a live root
//!   candidate of the same member, over a live, unendorsed `ios` key of that
//!   member. The bytes are rebuilt from the **stored** rows (target key, alg,
//!   label; root key), never from the request, and the canonical low-s
//!   signature E1 returns is what is stored.
//! * **Revocation** (D-7): a `device_revoke.v1` letter from a live root
//!   candidate, or the end of the key's session lineage. Rows are never deleted.
//! * **host_register** (D-8): [`verify_host_register_in_tx`] — the root
//!   candidate's `momo.human.control.v1` statement over the host key, host id
//!   candidate and label.
//!
//! ## State
//!
//! [`DeviceKeyState`] is derived per read: `revoked`, `root` (candidate),
//! `endorsed` (letter verified and its root still live) or `unendorsed` —
//! 「지시 불가」. Only `root` and `endorsed` can instruct.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_wire::human_control::{
    check_control_window, parse_p256_public_key, ControlContent, DeviceEndorse, DeviceKeyAlg,
    DeviceRevoke, HumanControl, MAX_CLOCK_SKEW_MS, P256_PUBLIC_KEY_LEN,
};
use sqlx::{PgConnection, Row};

use crate::token_store::lock_live_session_lineage;
use uuid::Uuid;

pub const DEVICE_KEY_ALG_P256: &str = "p256";
pub const DEVICE_KEY_PLATFORM_MACOS: &str = "macos";
pub const DEVICE_KEY_PLATFORM_IOS: &str = "ios";
/// `member_device_key_label_ck`.
pub const DEVICE_KEY_LABEL_MAX_CHARS: usize = 80;

/// Named refusal codes (ADR-0146 D-10 names the first three).
pub const REFUSAL_DEVICE_SIGNATURE_REQUIRED: &str = "device_signature_required";
pub const REFUSAL_DEVICE_SIGNATURE_INVALID: &str = "device_signature_invalid";
pub const REFUSAL_DEVICE_KEY_REVOKED: &str = "device_key_revoked";
pub const REFUSAL_DEVICE_KEY_NOT_FOUND: &str = "device_key_not_found";
pub const REFUSAL_DEVICE_KEY_MEMBER_MISMATCH: &str = "device_key_member_mismatch";
pub const REFUSAL_DEVICE_ROOT_NOT_ELIGIBLE: &str = "device_root_not_eligible";
pub const REFUSAL_DEVICE_KEY_NOT_ENDORSABLE: &str = "device_key_not_endorsable";
pub const REFUSAL_DEVICE_KEY_ALREADY_REGISTERED: &str = "device_key_already_registered";
pub const REFUSAL_SESSION_LINEAGE_ENDED: &str = "session_lineage_ended";
/// A root (`macos`) key needs the caller's password re-entered (review H1).
pub const REFUSAL_DEVICE_ROOT_PASSWORD_REQUIRED: &str = "device_root_password_required";
/// A root key cannot come from a QR-linked (labelled) session: that is a phone.
pub const REFUSAL_DEVICE_ROOT_LINKED_SESSION: &str = "device_root_linked_session";

/// Why a key ended (`member_device_key_revoked_ck`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKeyRevocationReason {
    /// A `device_revoke.v1` letter from the root.
    Signed,
    /// The session logged out.
    Logout,
    /// The linked device was disconnected (ADR-0180 D5).
    DeviceUnlinked,
    /// A spent refresh token was presented again (ADR-0188 R1).
    RefreshReuse,
    /// Every session of the member ended (password change or reset,
    /// suspension, removal, leaving, owner takeover).
    MemberSessionsEnded,
}

impl DeviceKeyRevocationReason {
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceKeyRevocationReason::Signed => "signed",
            DeviceKeyRevocationReason::Logout => "logout",
            DeviceKeyRevocationReason::DeviceUnlinked => "device_unlinked",
            DeviceKeyRevocationReason::RefreshReuse => "refresh_reuse",
            DeviceKeyRevocationReason::MemberSessionsEnded => "member_sessions_ended",
        }
    }
}

/// The derived trust state of one key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKeyState {
    /// A live `macos` key with no endorsement — a root candidate.
    Root,
    /// A live key whose endorsement verified and whose root is still live.
    Endorsed,
    /// A live key with no (live) endorsement: 「지시 불가」.
    Unendorsed,
    Revoked,
}

impl DeviceKeyState {
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceKeyState::Root => "root",
            DeviceKeyState::Endorsed => "endorsed",
            DeviceKeyState::Unendorsed => "unendorsed",
            DeviceKeyState::Revoked => "revoked",
        }
    }

    /// Whether a statement signed by this key may authorize an instruction.
    pub fn can_instruct(self) -> bool {
        matches!(self, DeviceKeyState::Root | DeviceKeyState::Endorsed)
    }
}

/// One `member_device_key` row plus whether its endorser is still live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceKeyRecord {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    pub session_id: Uuid,
    pub alg: String,
    pub public_key: String,
    pub platform: String,
    pub label: String,
    pub endorsed_by_key_id: Option<Uuid>,
    pub endorsement_sig: Option<String>,
    pub endorsed_at_ms: Option<i64>,
    /// The endorser row is live (NULL endorsement → `false`).
    pub endorser_live: bool,
    pub created_at_ms: i64,
    pub revoked_at_ms: Option<i64>,
    pub revoked_reason: Option<String>,
    pub revoked_by_key_id: Option<Uuid>,
    pub revocation_sig: Option<String>,
    /// The time inside the signed revocation letter.
    pub revocation_signed_at_ms: Option<i64>,
}

impl DeviceKeyRecord {
    pub fn is_live(&self) -> bool {
        self.revoked_at_ms.is_none()
    }

    /// A live `macos` key nobody endorsed (D-6 ①).
    pub fn is_root_candidate(&self) -> bool {
        self.is_live()
            && self.platform == DEVICE_KEY_PLATFORM_MACOS
            && self.endorsed_by_key_id.is_none()
    }

    pub fn state(&self) -> DeviceKeyState {
        if !self.is_live() {
            DeviceKeyState::Revoked
        } else if self.is_root_candidate() {
            DeviceKeyState::Root
        } else if self.endorsed_by_key_id.is_some() && self.endorser_live {
            DeviceKeyState::Endorsed
        } else {
            DeviceKeyState::Unendorsed
        }
    }

    fn public_key_bytes(&self) -> Vec<u8> {
        BASE64.decode(&self.public_key).unwrap_or_default()
    }
}

/// A validated registration input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewDeviceKey {
    pub alg: String,
    pub public_key: String,
    pub platform: String,
    pub label: String,
}

/// A registration input that cannot become a row (400).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DeviceKeyInputError {
    #[error("alg must be p256")]
    Alg,
    #[error("publicKey must be the base64 of a 33-byte compressed P-256 point")]
    PublicKey,
    #[error("platform must be macos or ios")]
    Platform,
    #[error("label must be at most 80 characters without control characters")]
    Label,
}

/// Validate a registration. The public key must be the **canonical** base64
/// of a compressed point on the curve — the exact text E1 puts in signed bytes.
pub fn validated_new_device_key(
    alg: &str,
    public_key: &str,
    platform: &str,
    label: Option<&str>,
) -> Result<NewDeviceKey, DeviceKeyInputError> {
    if alg != DEVICE_KEY_ALG_P256 {
        return Err(DeviceKeyInputError::Alg);
    }
    let bytes = BASE64
        .decode(public_key)
        .map_err(|_| DeviceKeyInputError::PublicKey)?;
    if bytes.len() != P256_PUBLIC_KEY_LEN
        || BASE64.encode(&bytes) != public_key
        || parse_p256_public_key(&bytes).is_err()
    {
        return Err(DeviceKeyInputError::PublicKey);
    }
    if platform != DEVICE_KEY_PLATFORM_MACOS && platform != DEVICE_KEY_PLATFORM_IOS {
        return Err(DeviceKeyInputError::Platform);
    }
    let label = label.unwrap_or("").trim().to_string();
    if label.chars().count() > DEVICE_KEY_LABEL_MAX_CHARS || label.chars().any(char::is_control) {
        return Err(DeviceKeyInputError::Label);
    }
    Ok(NewDeviceKey {
        alg: alg.to_string(),
        public_key: public_key.to_string(),
        platform: platform.to_string(),
        label,
    })
}

/// A refusal a route maps to a named HTTP error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKeyRefusal {
    /// No such key in this workspace.
    NotFound,
    /// The key (target or root) belongs to another member.
    MemberMismatch,
    /// The named root is not a live root candidate of the caller.
    RootNotEligible,
    /// The target cannot be endorsed (revoked, a Mac, or already endorsed).
    NotEndorsable,
    /// The target key is already revoked and already carries a letter.
    Revoked,
    /// The signature does not verify, or the statement is stale or malformed.
    SignatureInvalid,
}

impl DeviceKeyRefusal {
    pub fn code(self) -> &'static str {
        match self {
            DeviceKeyRefusal::NotFound => REFUSAL_DEVICE_KEY_NOT_FOUND,
            DeviceKeyRefusal::MemberMismatch => REFUSAL_DEVICE_KEY_MEMBER_MISMATCH,
            DeviceKeyRefusal::RootNotEligible => REFUSAL_DEVICE_ROOT_NOT_ELIGIBLE,
            DeviceKeyRefusal::NotEndorsable => REFUSAL_DEVICE_KEY_NOT_ENDORSABLE,
            DeviceKeyRefusal::Revoked => REFUSAL_DEVICE_KEY_REVOKED,
            DeviceKeyRefusal::SignatureInvalid => REFUSAL_DEVICE_SIGNATURE_INVALID,
        }
    }
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const KEY_COLUMNS: &str = "k.id, k.workspace_id, k.member_id, k.session_id, k.alg, \
     k.public_key, k.platform, k.label, k.endorsed_by_key_id, k.endorsement_sig, \
     (extract(epoch FROM k.endorsed_at) * 1000)::bigint AS endorsed_at_ms, \
     COALESCE(e.revoked_at IS NULL, false) AS endorser_live, \
     (extract(epoch FROM k.created_at) * 1000)::bigint AS created_at_ms, \
     (extract(epoch FROM k.revoked_at) * 1000)::bigint AS revoked_at_ms, \
     k.revoked_reason, k.revoked_by_key_id, k.revocation_sig, k.revoked_at_ms AS revocation_signed_at_ms";

const KEY_FROM: &str = "FROM member_device_key k \
     LEFT JOIN member_device_key e ON e.id = k.endorsed_by_key_id";

fn decode_key(row: &sqlx::postgres::PgRow) -> Result<DeviceKeyRecord, sqlx::Error> {
    Ok(DeviceKeyRecord {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        member_id: row.try_get("member_id")?,
        session_id: row.try_get("session_id")?,
        alg: row.try_get("alg")?,
        public_key: row.try_get("public_key")?,
        platform: row.try_get("platform")?,
        label: row.try_get("label")?,
        endorsed_by_key_id: row.try_get("endorsed_by_key_id")?,
        endorsement_sig: row.try_get("endorsement_sig")?,
        endorsed_at_ms: row.try_get("endorsed_at_ms")?,
        endorser_live: row.try_get("endorser_live")?,
        created_at_ms: row.try_get("created_at_ms")?,
        revoked_at_ms: row.try_get("revoked_at_ms")?,
        revoked_reason: row.try_get("revoked_reason")?,
        revoked_by_key_id: row.try_get("revoked_by_key_id")?,
        revocation_sig: row.try_get("revocation_sig")?,
        revocation_signed_at_ms: row.try_get("revocation_signed_at_ms")?,
    })
}

/// Insert a key under `session_id`. `None` when the same public key is already
/// live in this workspace (under this member or any other).
pub async fn insert_device_key_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    session_id: Uuid,
    new: &NewDeviceKey,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO member_device_key \
           (workspace_id, member_id, session_id, alg, public_key, platform, label) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         ON CONFLICT (workspace_id, public_key) WHERE revoked_at IS NULL DO NOTHING \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(session_id)
    .bind(&new.alg)
    .bind(&new.public_key)
    .bind(&new.platform)
    .bind(&new.label)
    .fetch_optional(&mut *conn)
    .await
}

/// Read one key (RLS confines it to the transaction's workspace).
pub async fn load_device_key_in_tx(
    conn: &mut PgConnection,
    key_id: Uuid,
) -> Result<Option<DeviceKeyRecord>, sqlx::Error> {
    let sql = format!("SELECT {KEY_COLUMNS} {KEY_FROM} WHERE k.id = $1");
    let row = sqlx::query(&sql)
        .bind(key_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref().map(decode_key).transpose()
}

/// Lock rows in id order (`FOR UPDATE`) so two letters over the same pair of
/// keys cannot deadlock, then read them.
async fn lock_keys_in_tx(conn: &mut PgConnection, ids: &[Uuid]) -> Result<(), sqlx::Error> {
    sqlx::query(
        "SELECT id FROM member_device_key WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    )
    .bind(ids)
    .fetch_all(&mut *conn)
    .await?;
    Ok(())
}

/// Every key of one member, newest first.
pub async fn list_member_device_keys_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Vec<DeviceKeyRecord>, sqlx::Error> {
    let sql = format!(
        "SELECT {KEY_COLUMNS} {KEY_FROM} \
          WHERE k.workspace_id = $1 AND k.member_id = $2 \
          ORDER BY k.created_at DESC, k.id DESC"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(member_id)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter().map(decode_key).collect()
}

/// Whether the named root key's session lineage can still rotate, with that
/// lineage's refresh rows share-locked for the rest of the transaction
/// (review M4). A key whose sign-in expired on its own is never swept by a
/// session end, so `revoked_at` alone would let it sign forever.
///
/// Called **before** any `member_device_key` row lock: every session end
/// locks `token` rows first and `member_device_key` rows second, and so must
/// this path, or the two can deadlock. `session_id` never changes, so reading
/// it unlocked is sound. `false` when the key is not the caller's (the caller
/// then refuses on the locked read).
async fn lock_root_lineage(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    root_key_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let session: Option<Uuid> = sqlx::query_scalar(
        "SELECT session_id FROM member_device_key \
          WHERE id = $1 AND workspace_id = $2 AND member_id = $3",
    )
    .bind(root_key_id)
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    match session {
        Some(session_id) => {
            lock_live_session_lineage(conn, workspace_id, member_id, session_id).await
        }
        None => Ok(false),
    }
}

/// A root key the caller named, checked against the caller.
fn eligible_root(
    root: Option<DeviceKeyRecord>,
    member_id: Uuid,
    lineage_live: bool,
) -> Result<DeviceKeyRecord, DeviceKeyRefusal> {
    let root = root.ok_or(DeviceKeyRefusal::RootNotEligible)?;
    if root.member_id != member_id {
        return Err(DeviceKeyRefusal::MemberMismatch);
    }
    if !root.is_live() || !lineage_live {
        return Err(DeviceKeyRefusal::Revoked);
    }
    if !root.is_root_candidate() || root.alg != DEVICE_KEY_ALG_P256 {
        return Err(DeviceKeyRefusal::RootNotEligible);
    }
    Ok(root)
}

/// Record a `device_endorse.v1` letter (D-6 ②). The letter is rebuilt from the
/// stored target and root rows; `signature_b64` is the raw `r‖s` in base64.
pub async fn endorse_device_key_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    target_id: Uuid,
    root_key_id: Uuid,
    signature_b64: &str,
) -> Result<Result<DeviceKeyRecord, DeviceKeyRefusal>, sqlx::Error> {
    let lineage_live = lock_root_lineage(conn, workspace_id, member_id, root_key_id).await?;
    lock_keys_in_tx(conn, &[target_id, root_key_id]).await?;
    let Some(target) = load_device_key_in_tx(conn, target_id).await? else {
        return Ok(Err(DeviceKeyRefusal::NotFound));
    };
    if target.member_id != member_id {
        return Ok(Err(DeviceKeyRefusal::MemberMismatch));
    }
    let root = match eligible_root(
        load_device_key_in_tx(conn, root_key_id).await?,
        member_id,
        lineage_live,
    ) {
        Ok(root) => root,
        Err(refusal) => return Ok(Err(refusal)),
    };
    if !target.is_live()
        || target.platform != DEVICE_KEY_PLATFORM_IOS
        // An endorsement whose root is gone may be replaced (D-6: 「맥에서 다시
        // 승인」); a live one may not.
        || (target.endorsed_by_key_id.is_some() && target.endorser_live)
        || target.alg != DEVICE_KEY_ALG_P256
    {
        return Ok(Err(DeviceKeyRefusal::NotEndorsable));
    }

    let letter = DeviceEndorse {
        workspace_id,
        member_id,
        root_key_id: root.id,
        target_alg: DeviceKeyAlg::P256,
        target_public_key_b64: &target.public_key,
        label: &target.label,
    };
    let Ok(signature) = BASE64.decode(signature_b64) else {
        return Ok(Err(DeviceKeyRefusal::SignatureInvalid));
    };
    let canonical = match letter.verify(&root.public_key_bytes(), &signature) {
        Ok(canonical) => canonical,
        Err(_) => return Ok(Err(DeviceKeyRefusal::SignatureInvalid)),
    };
    // A letter is used once (review M3). The endorse bytes name no target row
    // and no time, so a letter for a key that was later revoked would
    // otherwise endorse the same public key again once it is re-registered.
    // The stored form is canonical low-s, so both encodings of one signature
    // compare equal here.
    let canonical_b64 = BASE64.encode(canonical);
    let spent: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM member_device_key \
                         WHERE workspace_id = $1 AND endorsement_sig = $2)",
    )
    .bind(workspace_id)
    .bind(&canonical_b64)
    .fetch_one(&mut *conn)
    .await?;
    if spent {
        return Ok(Err(DeviceKeyRefusal::NotEndorsable));
    }

    sqlx::query(
        "UPDATE member_device_key k \
            SET endorsed_by_key_id = $2, endorsement_sig = $3, endorsed_at = now() \
          WHERE k.id = $1 AND k.revoked_at IS NULL \
            AND (k.endorsed_by_key_id IS NULL \
                 OR EXISTS (SELECT 1 FROM member_device_key e \
                             WHERE e.id = k.endorsed_by_key_id AND e.revoked_at IS NOT NULL))",
    )
    .bind(target.id)
    .bind(root.id)
    .bind(&canonical_b64)
    .execute(&mut *conn)
    .await?;
    let record = load_device_key_in_tx(conn, target.id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
    Ok(Ok(record))
}

/// Record a `device_revoke.v1` letter (D-7). A key the session end already
/// revoked still takes the letter once, so workd can be handed it.
#[allow(clippy::too_many_arguments)]
pub async fn revoke_device_key_signed_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    target_id: Uuid,
    root_key_id: Uuid,
    revoked_at_ms: i64,
    signature_b64: &str,
    now_ms: i64,
) -> Result<Result<DeviceKeyRecord, DeviceKeyRefusal>, sqlx::Error> {
    let lineage_live = lock_root_lineage(conn, workspace_id, member_id, root_key_id).await?;
    lock_keys_in_tx(conn, &[target_id, root_key_id]).await?;
    let Some(target) = load_device_key_in_tx(conn, target_id).await? else {
        return Ok(Err(DeviceKeyRefusal::NotFound));
    };
    if target.member_id != member_id {
        return Ok(Err(DeviceKeyRefusal::MemberMismatch));
    }
    let root = match eligible_root(
        load_device_key_in_tx(conn, root_key_id).await?,
        member_id,
        lineage_live,
    ) {
        Ok(root) => root,
        Err(refusal) => return Ok(Err(refusal)),
    };
    if target.revocation_sig.is_some() {
        return Ok(Err(DeviceKeyRefusal::Revoked));
    }
    // A letter dated in the future would be a revocation the host is told to
    // apply before it happened; one from before the key existed names a key
    // that was not there. The skew allowance is D-9's.
    if revoked_at_ms <= 0
        || revoked_at_ms > now_ms.saturating_add(MAX_CLOCK_SKEW_MS)
        || revoked_at_ms < target.created_at_ms.saturating_sub(MAX_CLOCK_SKEW_MS)
    {
        return Ok(Err(DeviceKeyRefusal::SignatureInvalid));
    }

    let letter = DeviceRevoke {
        workspace_id,
        member_id,
        root_key_id: root.id,
        target_key_id: target.id,
        revoked_at_ms,
    };
    let Ok(signature) = BASE64.decode(signature_b64) else {
        return Ok(Err(DeviceKeyRefusal::SignatureInvalid));
    };
    let canonical = match letter.verify(&root.public_key_bytes(), &signature) {
        Ok(canonical) => canonical,
        Err(_) => return Ok(Err(DeviceKeyRefusal::SignatureInvalid)),
    };

    sqlx::query(
        "UPDATE member_device_key \
            SET revoked_at = COALESCE(revoked_at, now()), \
                revoked_reason = COALESCE(revoked_reason, 'signed'), \
                revoked_by_key_id = $2, revocation_sig = $3, revoked_at_ms = $4 \
          WHERE id = $1 AND revocation_sig IS NULL",
    )
    .bind(target.id)
    .bind(root.id)
    .bind(BASE64.encode(canonical))
    .bind(revoked_at_ms)
    .execute(&mut *conn)
    .await?;
    let record = load_device_key_in_tx(conn, target.id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
    Ok(Ok(record))
}

/// One lineage ended: its live keys end with it (D-7). Runs in the caller's
/// tenant transaction next to the token revocation and the push invalidation,
/// so the session, its registrations and its keys end in one commit. Never
/// `DELETE`. Returns how many rows this call flipped.
pub async fn revoke_session_device_keys_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    session_id: Uuid,
    reason: DeviceKeyRevocationReason,
) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(
        "UPDATE member_device_key \
            SET revoked_at = now(), revoked_reason = $4 \
          WHERE workspace_id = $1 AND member_id = $2 AND session_id = $3 \
            AND revoked_at IS NULL",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(session_id)
    .bind(reason.as_str())
    .execute(&mut *conn)
    .await?
    .rows_affected())
}

/// Every session of the member ended: every live key of the member ends.
pub async fn revoke_member_device_keys_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(
        "UPDATE member_device_key \
            SET revoked_at = now(), revoked_reason = 'member_sessions_ended' \
          WHERE workspace_id = $1 AND member_id = $2 AND revoked_at IS NULL",
    )
    .bind(workspace_id)
    .bind(member_id)
    .execute(&mut *conn)
    .await?
    .rows_affected())
}

/// Re-check the caller's password without changing anything — the step-up a
/// root registration needs (review H1: a stolen refresh token alone must not
/// mint a root). `false` for a wrong password or a member with none.
pub async fn verify_own_password_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    password: &str,
) -> Result<bool, sqlx::Error> {
    let ok: Option<Option<bool>> = sqlx::query_scalar(
        "SELECT CASE WHEN h.password_hash IS NULL OR h.password_hash = '' THEN false \
                     ELSE momo_password_verify($3, h.password_hash) END \
           FROM human h \
          WHERE h.member_id = $1 AND h.workspace_id = $2",
    )
    .bind(member_id)
    .bind(workspace_id)
    .bind(password)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(ok.flatten() == Some(true))
}

// ---------------------------------------------------------------------------
// host_register (D-8)
// ---------------------------------------------------------------------------

/// The signature half of a member-scoped host registration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostRegisterProof {
    pub device_key_id: Uuid,
    /// The host id candidate; the host row is inserted under this id, so a
    /// replayed statement collides with the row it created.
    pub host_id: Uuid,
    pub nonce: Uuid,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
    /// base64 raw `r‖s`.
    pub signature_b64: String,
}

/// Verify a `host_register` statement against the caller's live root
/// candidate. `host_public_key_b64` and `label` are the values the host row
/// will store (already normalized); `instance_id` is the server's own, never
/// the caller's. Returns the canonical low-s signature on success.
#[allow(clippy::too_many_arguments)]
pub async fn verify_host_register_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    instance_id: &str,
    proof: &HostRegisterProof,
    host_public_key_b64: &str,
    label: &str,
    now_ms: i64,
) -> Result<Result<[u8; 64], DeviceKeyRefusal>, sqlx::Error> {
    // Lineage first (token rows), then the root row — the order every session
    // end takes — and both share-locked, so a concurrent end cannot commit
    // between this check and the host insert.
    let lineage_live =
        lock_root_lineage(conn, workspace_id, member_id, proof.device_key_id).await?;
    sqlx::query("SELECT id FROM member_device_key WHERE id = $1 FOR SHARE")
        .bind(proof.device_key_id)
        .fetch_optional(&mut *conn)
        .await?;
    let root = load_device_key_in_tx(conn, proof.device_key_id).await?;
    let root = match root {
        None => return Ok(Err(DeviceKeyRefusal::NotFound)),
        Some(root) if root.member_id != member_id => {
            return Ok(Err(DeviceKeyRefusal::MemberMismatch))
        }
        Some(root) if !root.is_live() || !lineage_live => {
            return Ok(Err(DeviceKeyRefusal::Revoked))
        }
        Some(root) => root,
    };
    if !root.is_root_candidate() || root.alg != DEVICE_KEY_ALG_P256 {
        return Ok(Err(DeviceKeyRefusal::RootNotEligible));
    }
    if check_control_window(proof.issued_at_ms, proof.expires_at_ms, now_ms).is_err() {
        return Ok(Err(DeviceKeyRefusal::SignatureInvalid));
    }
    let statement = HumanControl {
        instance_id,
        workspace_id,
        member_id,
        device_key_id: root.id,
        host_id: proof.host_id,
        session_id: None,
        nonce: proof.nonce,
        issued_at_ms: proof.issued_at_ms,
        expires_at_ms: proof.expires_at_ms,
        content: ControlContent::HostRegister {
            host_public_key_b64,
            host_id: proof.host_id,
            label,
        },
    };
    let Ok(signature) = BASE64.decode(&proof.signature_b64) else {
        return Ok(Err(DeviceKeyRefusal::SignatureInvalid));
    };
    match statement.verify(&root.public_key_bytes(), &signature) {
        Ok(canonical) => Ok(Ok(canonical)),
        Err(_) => Ok(Err(DeviceKeyRefusal::SignatureInvalid)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The WebCrypto test key of `docs/api/human-control-signing.vectors.json`.
    const KEY: &str = "Al5MJdwsIiT7groXgUDS9kC6VMwSS1QutnuZEZlbxi5S";

    fn record(platform: &str) -> DeviceKeyRecord {
        DeviceKeyRecord {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            member_id: Uuid::from_u128(3),
            session_id: Uuid::from_u128(4),
            alg: "p256".into(),
            public_key: KEY.into(),
            platform: platform.into(),
            label: String::new(),
            endorsed_by_key_id: None,
            endorsement_sig: None,
            endorsed_at_ms: None,
            endorser_live: false,
            created_at_ms: 0,
            revoked_at_ms: None,
            revoked_reason: None,
            revoked_by_key_id: None,
            revocation_sig: None,
            revocation_signed_at_ms: None,
        }
    }

    #[test]
    fn state_is_root_endorsed_unendorsed_or_revoked() {
        assert_eq!(record("macos").state(), DeviceKeyState::Root);
        let phone = record("ios");
        assert_eq!(phone.state(), DeviceKeyState::Unendorsed);
        assert!(!phone.state().can_instruct());
        let mut endorsed = record("ios");
        endorsed.endorsed_by_key_id = Some(Uuid::from_u128(9));
        endorsed.endorser_live = true;
        assert_eq!(endorsed.state(), DeviceKeyState::Endorsed);
        assert!(endorsed.state().can_instruct());
        // The root that endorsed it is gone: the phone falls back to 지시 불가.
        endorsed.endorser_live = false;
        assert_eq!(endorsed.state(), DeviceKeyState::Unendorsed);
        let mut revoked = record("macos");
        revoked.revoked_at_ms = Some(1);
        assert_eq!(revoked.state(), DeviceKeyState::Revoked);
        assert!(!revoked.state().can_instruct());
    }

    #[test]
    fn registration_input_takes_only_a_canonical_compressed_point() {
        assert!(validated_new_device_key("p256", KEY, "ios", Some(" 폰 ")).is_ok());
        assert_eq!(
            validated_new_device_key("ed25519", KEY, "ios", None),
            Err(DeviceKeyInputError::Alg)
        );
        assert_eq!(
            validated_new_device_key("p256", KEY, "android", None),
            Err(DeviceKeyInputError::Platform)
        );
        // 33 bytes that name no point: x = 2^256 − 1 is not a field element.
        let mut off_curve = [0xFFu8; 33];
        off_curve[0] = 2;
        let off_curve = BASE64.encode(off_curve);
        assert_eq!(
            validated_new_device_key("p256", &off_curve, "ios", None),
            Err(DeviceKeyInputError::PublicKey)
        );
        // The uncompressed form of a key is refused: one stored form per key.
        assert_eq!(
            validated_new_device_key("p256", &BASE64.encode([4u8; 65]), "ios", None),
            Err(DeviceKeyInputError::PublicKey)
        );
        assert_eq!(
            validated_new_device_key("p256", "not base64", "ios", None),
            Err(DeviceKeyInputError::PublicKey)
        );
        assert_eq!(
            validated_new_device_key("p256", KEY, "ios", Some("a\nb")),
            Err(DeviceKeyInputError::Label)
        );
    }
}
