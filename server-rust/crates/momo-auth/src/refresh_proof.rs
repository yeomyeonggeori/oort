//! Refresh-token sender constraint — #3079 (ADR-0146 D-7 증보 2026-09-29,
//! migration 096).
//!
//! A native client (phone, desktop) binds its sign-in lineage to a Secure
//! Enclave **refresh key** — a P-256 key with no biometry or presence check,
//! separate from the control key of `member_device_key` — and signs every
//! refresh with it (`momo.human.refresh_proof.v1`, momo-wire [`RefreshProof`]).
//! The server can then tell the device apart from someone who merely copied
//! the refresh token, which the single-use rotation of #3022 / #3074 cannot:
//!
//! * a **spent** token with a proof from the lineage's key is the device that
//!   lost a rotation response (sleep, Cmd+Q, a dead network) — the lineage is
//!   recovered, however long ago the token was spent;
//! * a spent token with **no** proof, or a proof from any other key, is a copy
//!   — the lineage ends (under `require`), even inside the 30-second window
//!   #3074 leaves open.
//!
//! This module decides the [`ProofVerdict`] for one presentation, inside the
//! refresh transaction; what the route then does with it is
//! `momo-server::routes::auth_routes`. It owns the SQL of the two 096 tables.
//!
//! Order of checks (and why): the signature first — a proof that does not
//! verify under the lineage's key must not spend a nonce the real device may
//! still send — then the time window, then the one-time nonce. A signature
//! that verifies under the lineage's key proves the presenter holds the key,
//! so a stale or replayed proof is only refused, never treated as a copy.
//!
//! [`RefreshProof`]: momo_wire::human_control::RefreshProof

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_wire::human_control::{
    refresh_token_sha256_hex, within_clock_skew, RefreshProof, MAX_CLOCK_SKEW_MS,
};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::human_control::db_now_ms;

/// `MOMO_REFRESH_PROOF_MODE`. See `momo-server` `config::DeviceKeySettings`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum RefreshProofMode {
    /// Proofs are ignored and nothing binds (the pre-#3079 server).
    Off,
    /// Proofs bind and are honored (a verified proof recovers a lineage);
    /// a missing or bad proof changes nothing.
    #[default]
    Observe,
    /// A key-bound lineage needs a verified proof on every refresh.
    Require,
}

impl RefreshProofMode {
    /// `off` | `observe` | `require`; anything else is `None` (a boot error,
    /// not a silent default).
    pub fn parse(raw: &str) -> Option<RefreshProofMode> {
        match raw.trim() {
            "off" => Some(RefreshProofMode::Off),
            "observe" => Some(RefreshProofMode::Observe),
            "require" => Some(RefreshProofMode::Require),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            RefreshProofMode::Off => "off",
            RefreshProofMode::Observe => "observe",
            RefreshProofMode::Require => "require",
        }
    }
}

/// The `deviceProof` a refresh request carries, as sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresentedRefreshProof {
    pub public_key_b64: String,
    pub nonce: Uuid,
    pub signed_at_ms: i64,
    pub signature_b64: String,
}

/// What one presentation's proof says about its presenter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofVerdict {
    /// The lineage has no refresh key (a browser, an older client, a pre-088
    /// row) or the mode is `off`. Every pre-#3079 rule applies unchanged.
    Unbound,
    /// Signed by the lineage's key, fresh, nonce spent now. `bound_now` when
    /// this very proof bound the key (first proof of the lineage).
    Verified { bound_now: bool },
    /// The lineage is bound and no proof came.
    Missing,
    /// The lineage is bound and the proof is not its key's: another key, a
    /// signature that does not verify, or a malformed proof.
    Forged,
    /// Signed by the lineage's key but outside the ±5 min window. The
    /// presenter holds the key; its clock is off.
    Stale,
    /// Signed by the lineage's key but the nonce was already spent — the same
    /// proof sent twice (a client resending an identical body, or a captured
    /// request replayed).
    Replayed,
}

impl ProofVerdict {
    /// The proof shows the presenter is *not* the lineage's device: a copy.
    /// A spent token presented this way ends the lineage under `require`.
    pub fn is_copy(self) -> bool {
        matches!(self, ProofVerdict::Missing | ProofVerdict::Forged)
    }

    /// The lineage is key-bound and this presentation did not prove it.
    pub fn is_unproven_bound(self) -> bool {
        matches!(
            self,
            ProofVerdict::Missing
                | ProofVerdict::Forged
                | ProofVerdict::Stale
                | ProofVerdict::Replayed
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ProofVerdict::Unbound => "unbound",
            ProofVerdict::Verified { bound_now: true } => "bound",
            ProofVerdict::Verified { bound_now: false } => "verified",
            ProofVerdict::Missing => "missing",
            ProofVerdict::Forged => "forged",
            ProofVerdict::Stale => "stale",
            ProofVerdict::Replayed => "replayed",
        }
    }
}

/// One presentation to judge.
pub struct ProofInput<'a> {
    pub mode: RefreshProofMode,
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    /// The presented row's lineage (`token.session_id`); `None` for a pre-088
    /// row, which is [`ProofVerdict::Unbound`].
    pub session_id: Option<Uuid>,
    /// The raw refresh token as presented — the proof signs its hash.
    pub presented: &'a str,
    pub proof: Option<&'a PresentedRefreshProof>,
    /// Whether a proof on an unbound lineage may bind its key: only for a live
    /// token (a spent one proves nothing about who holds the lineage now).
    pub may_bind: bool,
}

/// Judge one presentation. `conn` must carry the tenant GUC; nonce and
/// binding writes land in the caller's transaction.
pub async fn judge_refresh_proof(
    conn: &mut PgConnection,
    input: ProofInput<'_>,
) -> Result<ProofVerdict, sqlx::Error> {
    if input.mode == RefreshProofMode::Off {
        return Ok(ProofVerdict::Unbound);
    }
    let Some(session_id) = input.session_id else {
        return Ok(ProofVerdict::Unbound);
    };
    let bound = lineage_refresh_key(conn, input.workspace_id, session_id).await?;
    let Some(proof) = input.proof else {
        return Ok(match bound {
            Some(_) => ProofVerdict::Missing,
            None => ProofVerdict::Unbound,
        });
    };

    // (1) The signature, against the key the proof names.
    let token_hash = refresh_token_sha256_hex(input.presented);
    let statement = RefreshProof {
        workspace_id: input.workspace_id,
        member_id: input.member_id,
        public_key_b64: &proof.public_key_b64,
        refresh_token_sha256: &token_hash,
        nonce: proof.nonce,
        signed_at_ms: proof.signed_at_ms,
    };
    let signature_ok = BASE64
        .decode(&proof.signature_b64)
        .ok()
        .is_some_and(|signature| statement.verify(&signature).is_ok());

    let bound_now = match bound {
        // ... which must be the lineage's key.
        Some(key) => {
            if key != proof.public_key_b64 || !signature_ok {
                return Ok(ProofVerdict::Forged);
            }
            false
        }
        None => {
            // First proof of the lineage: it binds its own key, if it proves
            // possession of it, the token is live, and the lineage is still
            // the sign-in's own first refresh token (review M1).
            if !signature_ok || !input.may_bind {
                return Ok(ProofVerdict::Unbound);
            }
            if !lineage_is_bindable(conn, input.workspace_id, session_id).await? {
                return Ok(ProofVerdict::Unbound);
            }
            if !within_clock_skew(proof.signed_at_ms, db_now_ms(conn).await?) {
                return Ok(ProofVerdict::Unbound);
            }
            let key = bind_lineage_refresh_key(
                conn,
                input.workspace_id,
                input.member_id,
                session_id,
                &proof.public_key_b64,
            )
            .await?;
            if key != proof.public_key_b64 {
                // A concurrent first proof bound another key.
                return Ok(ProofVerdict::Forged);
            }
            true
        }
    };

    // (2) The time window, on the database clock.
    if !within_clock_skew(proof.signed_at_ms, db_now_ms(conn).await?) {
        return Ok(ProofVerdict::Stale);
    }

    // (3) The nonce, once.
    if !consume_refresh_proof_nonce(
        conn,
        input.workspace_id,
        session_id,
        proof.nonce,
        proof.signed_at_ms,
    )
    .await?
    {
        return Ok(ProofVerdict::Replayed);
    }
    Ok(ProofVerdict::Verified { bound_now })
}

/// How long after sign-in a lineage may still bind its refresh key.
pub const BIND_WINDOW_SECONDS: f64 = 600.0;

/// A lineage binds only while it has never rotated (its one refresh row is
/// the one sign-in or QR redeem issued) and that row is younger than
/// [`BIND_WINDOW_SECONDS`] (#3079 review M1). First-come binding is a
/// trust-on-first-use; without this, whoever once copied a live token of any
/// unbound lineage — every browser tab, every older client — could bind their
/// own key and from then on recover (take over) the lineage at will. A native
/// client binds with the refresh right after it signs in; a session signed
/// in before its client learned to bind stays unbound until the next sign-in.
const BINDABLE_LINEAGE_SQL: &str = "SELECT count(*) = 1 \
            AND bool_and(created_at > now() - make_interval(secs => $3)) \
       FROM token \
      WHERE workspace_id = $1 \
        AND session_id = $2 \
        AND kind = 'session' \
        AND label = 'refresh'";

/// See [`BINDABLE_LINEAGE_SQL`].
pub async fn lineage_is_bindable(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, Option<bool>>(BINDABLE_LINEAGE_SQL)
        .bind(workspace_id)
        .bind(session_id)
        .bind(BIND_WINDOW_SECONDS)
        .fetch_one(&mut *conn)
        .await
        .map(|value| value.unwrap_or(false))
}

/// The refresh key a lineage is bound to, if any.
pub async fn lineage_refresh_key(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT public_key FROM session_refresh_key \
          WHERE workspace_id = $1 AND session_id = $2",
    )
    .bind(workspace_id)
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await
}

/// Bind `public_key_b64` to the lineage unless a key is bound already, and
/// return the key that is bound now (first-come; never replaced).
pub async fn bind_lineage_refresh_key(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    session_id: Uuid,
    public_key_b64: &str,
) -> Result<String, sqlx::Error> {
    let inserted: Option<String> = sqlx::query_scalar(
        "INSERT INTO session_refresh_key (workspace_id, session_id, member_id, alg, public_key) \
         VALUES ($1, $2, $3, 'p256', $4) \
         ON CONFLICT (workspace_id, session_id) DO NOTHING \
         RETURNING public_key",
    )
    .bind(workspace_id)
    .bind(session_id)
    .bind(member_id)
    .bind(public_key_b64)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(key) = inserted {
        return Ok(key);
    }
    sqlx::query_scalar(
        "SELECT public_key FROM session_refresh_key \
          WHERE workspace_id = $1 AND session_id = $2",
    )
    .bind(workspace_id)
    .bind(session_id)
    .fetch_one(&mut *conn)
    .await
}

/// Spend a proof's nonce: `true` the first time, `false` on a replay. Rows
/// whose window has closed are pruned first (095's shape).
///
/// SABOTAGE(nonce-noop): return `Ok(true)` without the INSERT — the replay
/// test must go RED.
pub async fn consume_refresh_proof_nonce(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    nonce: Uuid,
    signed_at_ms: i64,
) -> Result<bool, sqlx::Error> {
    // A second of margin: the window is judged on whole milliseconds, and a
    // row must not be pruned by the very transaction that could still accept
    // its proof (review N1).
    sqlx::query(
        "DELETE FROM refresh_proof_nonce \
          WHERE workspace_id = $1 AND expires_at < now() - interval '1 second'",
    )
    .bind(workspace_id)
    .execute(&mut *conn)
    .await?;
    let keep_until_ms = signed_at_ms.saturating_add(MAX_CLOCK_SKEW_MS);
    let consumed: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO refresh_proof_nonce (workspace_id, nonce, session_id, expires_at) \
         VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000.0)) \
         ON CONFLICT (workspace_id, nonce) DO NOTHING \
         RETURNING nonce",
    )
    .bind(workspace_id)
    .bind(nonce)
    .bind(session_id)
    .bind(keep_until_ms as f64)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(consumed.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mode_parses_three_words_and_nothing_else() {
        assert_eq!(RefreshProofMode::parse("off"), Some(RefreshProofMode::Off));
        assert_eq!(
            RefreshProofMode::parse(" observe "),
            Some(RefreshProofMode::Observe)
        );
        assert_eq!(
            RefreshProofMode::parse("require"),
            Some(RefreshProofMode::Require)
        );
        assert_eq!(RefreshProofMode::parse("true"), None);
        assert_eq!(RefreshProofMode::parse(""), None);
        assert_eq!(RefreshProofMode::default(), RefreshProofMode::Observe);
    }

    /// Only a missing proof or another key's is a copy. A stale or replayed
    /// proof verified under the lineage's key: its presenter holds the key,
    /// and treating it as a copy would log the device out for a clock skew or
    /// a resent body (the case #3079 exists to fix).
    #[test]
    fn only_a_missing_or_foreign_proof_is_a_copy() {
        assert!(ProofVerdict::Missing.is_copy());
        assert!(ProofVerdict::Forged.is_copy());
        for honest in [
            ProofVerdict::Stale,
            ProofVerdict::Replayed,
            ProofVerdict::Unbound,
            ProofVerdict::Verified { bound_now: false },
            ProofVerdict::Verified { bound_now: true },
        ] {
            assert!(!honest.is_copy(), "{honest:?} is not a copy");
        }
        assert!(!ProofVerdict::Unbound.is_unproven_bound());
        assert!(!ProofVerdict::Verified { bound_now: false }.is_unproven_bound());
        assert!(ProofVerdict::Stale.is_unproven_bound());
    }
}
