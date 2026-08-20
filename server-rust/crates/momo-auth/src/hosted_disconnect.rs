//! ADR-0162 HAP-E6 — the hosted-agent disconnect lifecycle.
//!
//! Three transitions live here and nothing else does:
//!
//! | transition | what it is |
//! |---|---|
//! | `active`/`detected` → `cleanup_pending` | [`start_hosted_disconnect_in_tx`] — the operator pulled the plug |
//! | `active` → `cleanup_pending` | [`reconcile_hosted_connection_in_tx`] — the first domain guard found the credential already dead |
//! | `cleanup_pending` → `disconnected` | [`complete_hosted_disconnect_in_tx`] — every required artifact is resolved |
//!
//! ## Why the start is one transaction and not a workflow
//!
//! Disconnect is the moment a human decides a runtime should stop being able to
//! act. Split across two commits it has an interval — however short — in which
//! the credential still opens tools while the connection says it does not, and
//! that interval is exactly what an operator revoking an agent in a hurry is
//! trying to avoid. So the bearer revoke, the `cleanup_pending` transition, the
//! dedicated agent's pause, the manifest seed and the audit either all land or
//! none of them do. Open job/lease suppression is the caller's second in-tx
//! call ([`momo_outbox`] owns `outbox` SQL) and rolls back with the rest.
//!
//! ## Lock order is HAP-E4's, and the revoke is connection-scoped
//!
//! `connection → token → member → membership → profile`, the same order
//! [`crate::hosted_connection::resolve_hosted_tool_identity_in_tx`] takes and
//! the same order `regenerate_pairing_in_tx` takes. Two things follow. First,
//! a disconnect and an in-flight tool call cannot deadlock: every tool call
//! holds `FOR SHARE` on the connection first, so the disconnect's `FOR UPDATE`
//! simply waits for it and the outcome is serial either way.
//!
//! Second — and this is the #1374 lesson made structural — the token revoke is
//! scoped by `hosted_connection_id`, never by `actor_member_id`. Revoking "every
//! hosted credential of this member" would reach a sibling connection's token
//! while holding this connection's locks, which was the AB-BA pair #1374 closed
//! on the prove path (`hosted_connection::invalidate_hosted_lifecycle_in_tx` is
//! connection-scoped for the same reason). This module never widened past the
//! connection it was handed, so it needed no repair of its own.
//!
//! ## What resolution means, and what it deliberately does not
//!
//! The manifest is rows (migration 072), one per artifact kind plus one per
//! named item. `connector` resolving cannot resolve `local_plugin_files`
//! because they are different rows and no code path writes one from the other
//! (#1344 measured a connector uninstall leaving the files behind). An
//! `inactive` routine is a `current_status`, not a `disposition`, so recording
//! it changes nothing about resolution. A `bot` is the one kind whose legal
//! terminal set contains `preserved`: oort never deletes provider chat history
//! on someone's behalf, so "keep it" is an answer rather than an omission.

use serde_json::Value;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::hosted_connection::HostedConnection;

/// Every artifact kind a disconnect must account for (issue #1367).
pub const HOSTED_ARTIFACT_KINDS: [&str; 6] = [
    "bot",
    "routine",
    "plugin",
    "connector",
    "local_plugin_files",
    "secret",
];

/// The states a disconnect may start from: the two in which a credential exists
/// and a provider may still be holding capability. `pairing_pending` and
/// `expired` never handed anything out (regeneration is their verb), and the
/// two terminal-ward states answer idempotently instead.
pub const HOSTED_DISCONNECTABLE_STATES: [&str; 2] = ["detected", "active"];

/// A bounded, non-secret provider-side item name a caller may add to the seeded
/// manifest.
pub const MAX_ARTIFACT_REF_BYTES: usize = 200;
pub const MAX_ARTIFACT_EVIDENCE_BYTES: usize = 2_000;
/// A manifest is an operator's checklist, not an inventory service.
pub const MAX_ARTIFACT_ITEMS: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HostedArtifactInputError {
    #[error(
        "artifact kind must be one of bot, routine, plugin, connector, local_plugin_files, secret"
    )]
    Kind,
    #[error("artifact reference must be 1..=200 non-secret bytes and unique per kind")]
    Reference,
    #[error("artifact items exceed the manifest bound")]
    TooMany,
    #[error("currentStatus must be one of unknown, present, inactive, absent")]
    Status,
    #[error("disposition is not legal for this artifact kind")]
    Disposition,
    #[error("a manual acknowledgement requires 1..=2000 bytes of evidence")]
    Evidence,
}

/// One acknowledgement, as the caller states it.
///
/// `source` is deliberately absent: this input can only ever produce a `manual`
/// provenance. `server_verified` is written by the disconnect transaction for
/// the credential it revoked itself and is unreachable from any request body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostedArtifactAcknowledgement<'a> {
    pub artifact_id: Uuid,
    pub actor_member_id: Uuid,
    /// `unknown` | `present` | `inactive` | `absent`.
    pub current_status: &'a str,
    /// `delete` | `preserve` | `revoke`. `None` records an observation only.
    pub disposition: Option<&'a str>,
    pub evidence: Option<&'a str>,
}

/// One extra named item a caller wants tracked beside the seeded per-kind row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedArtifactSeed {
    pub kind: String,
    pub external_ref: String,
}

/// One manifest row, projected for an API that must never leak provider secrets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedArtifact {
    pub id: Uuid,
    pub kind: String,
    pub external_ref: Option<String>,
    pub expected_action: String,
    pub current_status: String,
    pub disposition: String,
    pub resolved: bool,
    pub required: bool,
    pub source: Option<String>,
    pub acknowledged_by: Option<Uuid>,
    pub acknowledged_at_ms: Option<i64>,
    pub evidence: Option<String>,
    pub updated_at_ms: i64,
}

/// What a disconnect start did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedDisconnectStarted {
    pub connection: HostedConnection,
    pub artifacts: Vec<HostedArtifact>,
    pub revoked_credential_count: i64,
    /// False when the connection was already `cleanup_pending`: the transition,
    /// the revoke and the pause are not repeated, and the caller writes no
    /// second `disconnect_started` audit row.
    pub changed: bool,
    /// How many manifest rows this call **added** to a manifest that already
    /// existed (issue #1386 F4).
    ///
    /// Non-zero only on a retry, and only when the caller named an artifact the
    /// manifest did not already hold. It is reported separately from `changed`
    /// because a manifest extension is not a second disconnect: the transition
    /// happened once, and this is a later discovery being written into the
    /// checklist that transition opened.
    pub merged_artifact_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostedDisconnectStart {
    Applied(Box<HostedDisconnectStarted>),
    /// Already `disconnected`. Terminal is terminal; there is nothing to start.
    AlreadyTerminal(Box<HostedConnection>),
    NotFound,
    WrongState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedArtifactAcknowledged {
    pub artifact: HostedArtifact,
    pub remaining_required: i64,
    /// False for a byte-identical repeat — the caller writes no audit row.
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostedArtifactAck {
    Applied(Box<HostedArtifactAcknowledged>),
    NotFound,
    /// The connection is not in `cleanup_pending`.
    WrongState,
    /// A resolved artifact cannot be re-decided into a different disposition.
    AlreadyResolved,
    IllegalDisposition,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostedDisconnectCompletion {
    Applied(Box<HostedConnection>),
    /// Idempotent replay of a transition that already happened once.
    AlreadyTerminal(Box<HostedConnection>),
    Unresolved {
        remaining_required: i64,
    },
    /// The connection is `cleanup_pending` with **no** manifest rows at all, so
    /// there is nothing for the unresolved-artifact gate to judge. Only a
    /// caller that reached `cleanup_pending` without running the disconnect
    /// start can be in this state, and it is refused rather than waved through
    /// on a vacuously-satisfied check.
    ManifestMissing,
    /// The local half is not server-confirmed: a live credential or an unpaused
    /// agent. Refusing here is what keeps `disconnected` an honest claim.
    LocalRevokeIncomplete,
    NotFound,
    WrongState,
}

/// The action a kind's row asks for. `None` for an unknown kind, which is how
/// the input validator and the CHECK constraint stay one rule.
pub fn expected_action_for_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "bot" => Some("decide"),
        "secret" => Some("revoke"),
        "routine" | "plugin" | "connector" | "local_plugin_files" => Some("remove"),
        _ => None,
    }
}

/// The wire disposition vocabulary (`delete` / `preserve` / `revoke`) mapped to
/// the stored one, refusing any pairing the kind does not allow.
///
/// `preserve` is legal for `bot` and nothing else. That asymmetry is the whole
/// #1344 lesson: deleting a bot deletes its chat history, so preserving one is
/// a terminal answer — while "I left the connector installed" is not.
pub fn stored_disposition(kind: &str, wire: &str) -> Option<&'static str> {
    match (kind, wire) {
        ("bot", "delete") => Some("removed"),
        ("bot", "preserve") => Some("preserved"),
        ("secret", "revoke") => Some("revoked"),
        ("routine" | "plugin" | "connector" | "local_plugin_files", "delete") => Some("removed"),
        _ => None,
    }
}

pub fn validate_artifact_status(status: &str) -> Result<(), HostedArtifactInputError> {
    if matches!(status, "unknown" | "present" | "inactive" | "absent") {
        Ok(())
    } else {
        Err(HostedArtifactInputError::Status)
    }
}

/// Bound and de-duplicate caller-supplied manifest items.
///
/// Non-secret is enforced by shape, not by trust: an item name that opens with
/// one of this server's own credential envelopes is refused outright rather
/// than stored and later shown in an admin list.
pub fn validate_artifact_seeds(
    seeds: &[HostedArtifactSeed],
) -> Result<Vec<HostedArtifactSeed>, HostedArtifactInputError> {
    if seeds.len() > MAX_ARTIFACT_ITEMS {
        return Err(HostedArtifactInputError::TooMany);
    }
    let mut normalized: Vec<HostedArtifactSeed> = Vec::with_capacity(seeds.len());
    for seed in seeds {
        if expected_action_for_kind(&seed.kind).is_none() {
            return Err(HostedArtifactInputError::Kind);
        }
        let reference = seed.external_ref.trim();
        if reference.is_empty()
            || reference.len() > MAX_ARTIFACT_REF_BYTES
            || reference.starts_with(crate::hosted_connection::HOSTED_PAIRING_PREFIX)
            || reference.starts_with(crate::AGENT_BEARER_PREFIX)
            || reference.chars().any(|c| c.is_control())
        {
            return Err(HostedArtifactInputError::Reference);
        }
        if normalized
            .iter()
            .any(|item| item.kind == seed.kind && item.external_ref == reference)
        {
            return Err(HostedArtifactInputError::Reference);
        }
        normalized.push(HostedArtifactSeed {
            kind: seed.kind.clone(),
            external_ref: reference.to_string(),
        });
    }
    Ok(normalized)
}

pub fn validate_artifact_evidence(
    evidence: Option<&str>,
) -> Result<String, HostedArtifactInputError> {
    let evidence = evidence.unwrap_or_default().trim();
    if evidence.is_empty() || evidence.len() > MAX_ARTIFACT_EVIDENCE_BYTES {
        return Err(HostedArtifactInputError::Evidence);
    }
    Ok(evidence.to_string())
}

const ARTIFACT_PROJECTION: &str = "id, kind, external_ref, expected_action, current_status, \
    disposition, resolved, required, source, acknowledged_by, \
    (EXTRACT(EPOCH FROM acknowledged_at) * 1000)::bigint AS acknowledged_at_ms, evidence, \
    (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_at_ms";

fn decode_artifact(row: &sqlx::postgres::PgRow) -> Result<HostedArtifact, sqlx::Error> {
    Ok(HostedArtifact {
        id: row.try_get("id")?,
        kind: row.try_get("kind")?,
        external_ref: row.try_get("external_ref")?,
        expected_action: row.try_get("expected_action")?,
        current_status: row.try_get("current_status")?,
        disposition: row.try_get("disposition")?,
        resolved: row.try_get("resolved")?,
        required: row.try_get("required")?,
        source: row.try_get("source")?,
        acknowledged_by: row.try_get("acknowledged_by")?,
        acknowledged_at_ms: row.try_get("acknowledged_at_ms")?,
        evidence: row.try_get("evidence")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

/// The connection's manifest, in a stable order so two reads of an unchanged
/// manifest are byte-identical.
pub async fn list_hosted_artifacts_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
) -> Result<Vec<HostedArtifact>, sqlx::Error> {
    let sql = format!(
        "SELECT {ARTIFACT_PROJECTION} FROM hosted_agent_connection_artifact \
          WHERE workspace_id = $1 AND connection_id = $2 \
          ORDER BY kind ASC, COALESCE(external_ref, '') ASC"
    );
    sqlx::query(&sql)
        .bind(workspace_id)
        .bind(connection_id)
        .fetch_all(&mut *conn)
        .await?
        .iter()
        .map(decode_artifact)
        .collect()
}

pub async fn count_unresolved_required_artifacts_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM hosted_agent_connection_artifact \
          WHERE workspace_id = $1 AND connection_id = $2 AND required AND NOT resolved",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_one(&mut *conn)
    .await
}

const CONNECTION_PROJECTION: &str = "id, workspace_id, agent_member_id, status, auth_mode, \
    audience, detected_client_name, detected_client_version, approved_channel_ids, \
    approved_scopes, active_token_id, \
    (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_at_ms, \
    (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_at_ms";

fn decode_connection(row: &sqlx::postgres::PgRow) -> Result<HostedConnection, sqlx::Error> {
    Ok(HostedConnection {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        agent_member_id: row.try_get("agent_member_id")?,
        status: row.try_get("status")?,
        auth_mode: row.try_get("auth_mode")?,
        audience: row.try_get("audience")?,
        detected_client_name: row.try_get("detected_client_name")?,
        detected_client_version: row.try_get("detected_client_version")?,
        approved_channel_ids: row.try_get("approved_channel_ids")?,
        approved_scopes: row.try_get("approved_scopes")?,
        active_token_id: row.try_get("active_token_id")?,
        created_at_ms: row.try_get("created_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

async fn load_connection(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
) -> Result<Option<HostedConnection>, sqlx::Error> {
    let sql = format!(
        "SELECT {CONNECTION_PROJECTION} FROM hosted_agent_connection \
          WHERE workspace_id = $1 AND id = $2"
    );
    sqlx::query(&sql)
        .bind(workspace_id)
        .bind(connection_id)
        .fetch_optional(&mut *conn)
        .await?
        .as_ref()
        .map(decode_connection)
        .transpose()
}

/// Seed the manifest: one required row per kind, plus one per caller-named item.
/// Returns how many rows this call actually inserted.
///
/// `ON CONFLICT DO NOTHING` is what makes a retried disconnect idempotent
/// without re-opening an artifact a human already resolved — and, since the
/// insert count is returned rather than discarded, it is also what lets the
/// retry path tell "you named something new" from "you said it twice".
///
/// `revoked_now` is `Some(n)` only when **this** call performed the revoke. The
/// seeded `secret` row is then the one artifact this server can close by itself
/// — the hosted bearer it just revoked in this same transaction — and its
/// evidence is a fact read back from that write rather than a claim.
///
/// `None` is the retry: the transition already happened, this call revoked
/// nothing, and so the `secret` row (if it is somehow missing) seeds `pending`
/// and manual like every other kind. Writing `server_verified` here would be
/// the exact provenance lie migration 072 reserves that value against — the
/// value means "this server observed it", not "this server assumes it".
///
/// A *named* secret item is a provider-side store entry oort cannot see, so it
/// is always `pending` and manual.
async fn seed_manifest_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    agent_member_id: Uuid,
    revoked_now: Option<i64>,
    seeds: &[HostedArtifactSeed],
) -> Result<i64, sqlx::Error> {
    let mut inserted = 0_i64;
    for kind in HOSTED_ARTIFACT_KINDS {
        let expected = expected_action_for_kind(kind).unwrap_or("remove");
        let server_verified = kind == "secret" && revoked_now.is_some();
        let result = sqlx::query(
            "INSERT INTO hosted_agent_connection_artifact \
               (workspace_id, connection_id, agent_member_id, kind, external_ref, \
                expected_action, current_status, disposition, source, acknowledged_at, evidence) \
             VALUES ($1, $2, $3, $4, NULL, $5, \
                     CASE WHEN $6 THEN 'absent' ELSE 'unknown' END, \
                     CASE WHEN $6 THEN 'revoked' ELSE 'pending' END, \
                     CASE WHEN $6 THEN 'server_verified' END, \
                     CASE WHEN $6 THEN now() END, \
                     CASE WHEN $6 THEN $7::text END) \
             ON CONFLICT DO NOTHING",
        )
        .bind(workspace_id)
        .bind(connection_id)
        .bind(agent_member_id)
        .bind(kind)
        .bind(expected)
        .bind(server_verified)
        .bind(format!(
            "oort revoked {} hosted credential(s) on this connection",
            revoked_now.unwrap_or_default()
        ))
        .execute(&mut *conn)
        .await?;
        inserted += result.rows_affected() as i64;
    }
    for seed in seeds {
        let expected = expected_action_for_kind(&seed.kind).unwrap_or("remove");
        let result = sqlx::query(
            "INSERT INTO hosted_agent_connection_artifact \
               (workspace_id, connection_id, agent_member_id, kind, external_ref, \
                expected_action, current_status) \
             VALUES ($1, $2, $3, $4, $5, $6, 'present') \
             ON CONFLICT DO NOTHING",
        )
        .bind(workspace_id)
        .bind(connection_id)
        .bind(agent_member_id)
        .bind(&seed.kind)
        .bind(&seed.external_ref)
        .bind(expected)
        .execute(&mut *conn)
        .await?;
        inserted += result.rows_affected() as i64;
    }
    Ok(inserted)
}

/// Revoke every live credential of **this connection** and lock the identity
/// rows behind it, in HAP-E4's order.
///
/// Returns how many credentials this call actually revoked. The
/// `COALESCE(revoked_at, now())` shape is `regenerate_pairing_in_tx`'s, so a
/// credential revoked a moment earlier keeps its original timestamp and the
/// count answers "how many were live", not "how many rows matched".
async fn revoke_and_pause_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    agent_member_id: Uuid,
    actor_member_id: Option<Uuid>,
) -> Result<i64, sqlx::Error> {
    let revoked: Vec<Uuid> = sqlx::query_scalar(
        "UPDATE token SET revoked_at = COALESCE(revoked_at, now()) \
          WHERE workspace_id = $1 AND hosted_connection_id = $2 AND revoked_at IS NULL \
        RETURNING id",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_all(&mut *conn)
    .await?;
    // member → membership, locked in HAP-E4's order so a concurrent tool call
    // (which takes them FOR SHARE in the same order) serializes rather than
    // interleaving with the pause below.
    let _member_lock: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM member WHERE workspace_id = $1 AND id = $2 FOR UPDATE")
            .bind(workspace_id)
            .bind(agent_member_id)
            .fetch_optional(&mut *conn)
            .await?;
    let _membership_lock: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM workspace_membership WHERE workspace_id = $1 AND member_id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    // The dedicated sentinel always has a profile row (HAP-E3 creates it paused
    // before the connection exists), so an UPDATE that changes nothing is a
    // broken invariant rather than a no-op — and the whole disconnect must roll
    // back rather than leave a revoked credential beside a runnable agent.
    let paused = sqlx::query(
        "UPDATE agent_profile \
            SET paused = true, \
                version = version + CASE WHEN paused THEN 0 ELSE 1 END, \
                updated_by = CASE WHEN paused THEN updated_by ELSE COALESCE($3, updated_by) END, \
                updated_at = now() \
          WHERE workspace_id = $1 AND agent_member_id = $2",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(actor_member_id)
    .execute(&mut *conn)
    .await?;
    if paused.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound);
    }
    Ok(revoked.len() as i64)
}

/// Begin a disconnect: revoke, pause, transition, seed — or nothing at all.
pub async fn start_hosted_disconnect_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    actor_member_id: Uuid,
    seeds: &[HostedArtifactSeed],
) -> Result<HostedDisconnectStart, sqlx::Error> {
    // 1 — connection. Every other lock in this function is taken after it.
    let locked: Option<(String, Uuid)> = sqlx::query_as(
        "SELECT status::text, agent_member_id FROM hosted_agent_connection \
          WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((status, agent_member_id)) = locked else {
        return Ok(HostedDisconnectStart::NotFound);
    };
    if status == "disconnected" {
        let Some(connection) = load_connection(conn, workspace_id, connection_id).await? else {
            return Ok(HostedDisconnectStart::NotFound);
        };
        return Ok(HostedDisconnectStart::AlreadyTerminal(Box::new(connection)));
    }
    if status == "cleanup_pending" {
        // The idempotent answer for the *transition*: it happened once, and
        // nothing about it is repeated — no second revoke, no second pause, no
        // second `disconnect_started` audit row. A retried disconnect must not
        // amplify.
        //
        // The manifest is the one part that is not finished being written. A
        // cleanup runs over hours; the artifact a person finds on the second
        // pass through a provider's settings screen is exactly the artifact
        // most likely to be missed, and before #1386 this branch dropped the
        // caller's `artifacts` on the floor and answered 200 — the worst of the
        // three possible answers, because the operator was told the item was
        // tracked when nothing had recorded it.
        //
        // So the retry MERGES rather than 409s. A 409 would be honest but
        // useless: there is no other route that adds a manifest row, so the
        // operator would be told "conflict" with nowhere to go. Merging is
        // idempotent by the same unique index the first seed relies on — naming
        // the same item twice inserts nothing the second time — and it cannot
        // undo a decision, because a row a human already resolved is not
        // re-opened by a conflicting insert that does nothing.
        //
        // The per-kind rows are reseeded too, and that is not redundancy: a
        // manifest that is empty here was never seeded by this lifecycle, and
        // merging one named row into it would leave a manifest that satisfies
        // migration 072's non-empty clause while confirming almost nothing.
        // Reseeding restores the full six-kind checklist so the terminal
        // transition still has the whole list to judge. `None` withholds the
        // `server_verified` provenance: this call revoked no credential.
        let merged_artifact_count = seed_manifest_in_tx(
            conn,
            workspace_id,
            connection_id,
            agent_member_id,
            None,
            seeds,
        )
        .await?;
        let Some(connection) = load_connection(conn, workspace_id, connection_id).await? else {
            return Ok(HostedDisconnectStart::NotFound);
        };
        let artifacts = list_hosted_artifacts_in_tx(conn, workspace_id, connection_id).await?;
        return Ok(HostedDisconnectStart::Applied(Box::new(
            HostedDisconnectStarted {
                connection,
                artifacts,
                revoked_credential_count: 0,
                changed: false,
                merged_artifact_count,
            },
        )));
    }
    if !HOSTED_DISCONNECTABLE_STATES.contains(&status.as_str()) {
        return Ok(HostedDisconnectStart::WrongState);
    }

    // 2..5 — token → member → membership → profile.
    let revoked_credential_count = revoke_and_pause_in_tx(
        conn,
        workspace_id,
        connection_id,
        agent_member_id,
        Some(actor_member_id),
    )
    .await?;

    // 6 — the transition itself. `active_token_id` is released because the
    // credential it named is revoked; leaving it would let a later reader
    // believe the connection still has one.
    let sql = format!(
        "UPDATE hosted_agent_connection \
            SET status = 'cleanup_pending', active_token_id = NULL, updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 AND status = $3 \
        RETURNING {CONNECTION_PROJECTION}"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(connection_id)
        .bind(&status)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        // The row was locked FOR UPDATE above, so this is unreachable; making
        // it an error rather than a silent `NotFound` keeps the revoke and the
        // pause from committing without their transition.
        return Err(sqlx::Error::RowNotFound);
    };
    let connection = decode_connection(&row)?;

    // 7 — the manifest.
    seed_manifest_in_tx(
        conn,
        workspace_id,
        connection_id,
        agent_member_id,
        Some(revoked_credential_count),
        seeds,
    )
    .await?;
    let artifacts = list_hosted_artifacts_in_tx(conn, workspace_id, connection_id).await?;
    Ok(HostedDisconnectStart::Applied(Box::new(
        HostedDisconnectStarted {
            connection,
            artifacts,
            revoked_credential_count,
            changed: true,
            // The whole manifest belongs to this transition, not to a merge.
            merged_artifact_count: 0,
        },
    )))
}

/// The forced half of the same transition: a first domain guard observed that
/// an `active` connection's own credential is no longer live.
///
/// Returns `true` when this call performed the reconciliation, so the caller
/// writes exactly one audit row and suppresses open work exactly once.
///
/// The caller must already have proved that the presented credential **is** the
/// connection's `active_token_id`. Reconciling on any other signal would let a
/// holder of a long-revoked credential force a live connection down.
pub async fn reconcile_hosted_connection_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let locked: Option<(String, Uuid)> = sqlx::query_as(
        "SELECT status::text, agent_member_id FROM hosted_agent_connection \
          WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((status, agent_member_id)) = locked else {
        return Ok(false);
    };
    if status != "active" {
        return Ok(false);
    }
    let revoked_credential_count =
        revoke_and_pause_in_tx(conn, workspace_id, connection_id, agent_member_id, None).await?;
    let transitioned = sqlx::query(
        "UPDATE hosted_agent_connection \
            SET status = 'cleanup_pending', active_token_id = NULL, updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 AND status = 'active'",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .execute(&mut *conn)
    .await?;
    if transitioned.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound);
    }
    seed_manifest_in_tx(
        conn,
        workspace_id,
        connection_id,
        agent_member_id,
        Some(revoked_credential_count),
        &[],
    )
    .await?;
    Ok(true)
}

/// The other half of the same guard: the presented credential is the
/// connection's own `active_token_id`, and it is **already** revoked or expired.
///
/// The bearer resolution refuses a dead credential before
/// [`crate::hosted_connection::prove_hosted_binding_in_tx`] ever runs, so an
/// operator emergency revoke — the most likely way this split state appears —
/// would otherwise leave an `active` connection with a dead bearer and an
/// unpaused agent for as long as nobody looked. This is that look, on the
/// transport's rejection path, at the cost of one query that only a rejected
/// request pays.
///
/// Returns the reconciled `(connection_id, agent_member_id)` when this call
/// performed it, so the caller suppresses open work and audits exactly once.
///
/// A **superseded** credential cannot reach this: the join requires the
/// presented hash to be the connection's current `active_token_id`, so a holder
/// of an old credential cannot use it to force a live connection down.
pub async fn reconcile_dead_hosted_credential_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    raw_token: &str,
) -> Result<Option<(Uuid, Uuid)>, sqlx::Error> {
    let target: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT hc.id, hc.agent_member_id \
           FROM hosted_agent_connection hc \
           JOIN token t ON t.workspace_id = hc.workspace_id AND t.id = hc.active_token_id \
          WHERE hc.workspace_id = $1 \
            AND hc.status = 'active' \
            AND t.kind = 'agent_bearer' \
            AND t.credential_class IN ('hosted_active','hosted_oauth_access') \
            AND t.token_hash = digest($2::text, 'sha256') \
            AND ( \
              t.revoked_at IS NOT NULL \
              OR (t.expires_at IS NOT NULL AND t.expires_at <= now()) \
            ) \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(raw_token)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((connection_id, agent_member_id)) = target else {
        return Ok(None);
    };
    // The lock is taken inside, on the connection, in HAP-E4's order — and it
    // re-checks `active`, so two requests racing on the same dead credential
    // produce one reconciliation and one audit row.
    if !reconcile_hosted_connection_in_tx(conn, workspace_id, connection_id).await? {
        return Ok(None);
    }
    Ok(Some((connection_id, agent_member_id)))
}

/// Record one artifact observation and, when a disposition is supplied, one
/// resolution.
///
/// `disposition = None` is an **observation**: it moves `current_status` and
/// nothing else. That is the shape the #1344 inactive-routine finding demands —
/// "it is switched off" is a fact worth recording and is not a cleanup.
pub async fn acknowledge_hosted_artifact_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    input: HostedArtifactAcknowledgement<'_>,
) -> Result<HostedArtifactAck, sqlx::Error> {
    let HostedArtifactAcknowledgement {
        artifact_id,
        actor_member_id,
        current_status,
        disposition,
        evidence,
    } = input;
    let locked_status: Option<String> = sqlx::query_scalar(
        "SELECT status::text FROM hosted_agent_connection \
          WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    match locked_status.as_deref() {
        None => return Ok(HostedArtifactAck::NotFound),
        Some("cleanup_pending") => {}
        Some(_) => return Ok(HostedArtifactAck::WrongState),
    }

    let existing: Option<(String, String, String, bool)> = sqlx::query_as(
        "SELECT kind, current_status, disposition, resolved \
           FROM hosted_agent_connection_artifact \
          WHERE workspace_id = $1 AND connection_id = $2 AND id = $3 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(artifact_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((kind, stored_status, stored_disposition_value, resolved)) = existing else {
        return Ok(HostedArtifactAck::NotFound);
    };

    let requested = match disposition {
        None => None,
        Some(wire) => match stored_disposition(&kind, wire) {
            Some(value) => Some(value),
            None => return Ok(HostedArtifactAck::IllegalDisposition),
        },
    };
    if resolved {
        // A decision is not re-decidable. A byte-identical repeat answers the
        // same thing it answered the first time, and writes nothing.
        if requested.is_some_and(|value| value != stored_disposition_value) {
            return Ok(HostedArtifactAck::AlreadyResolved);
        }
        if current_status != stored_status {
            return Ok(HostedArtifactAck::AlreadyResolved);
        }
        let artifact = load_artifact(conn, workspace_id, connection_id, artifact_id).await?;
        let Some(artifact) = artifact else {
            return Ok(HostedArtifactAck::NotFound);
        };
        let remaining_required =
            count_unresolved_required_artifacts_in_tx(conn, workspace_id, connection_id).await?;
        return Ok(HostedArtifactAck::Applied(Box::new(
            HostedArtifactAcknowledged {
                artifact,
                remaining_required,
                changed: false,
            },
        )));
    }

    let changed = requested.is_some() || current_status != stored_status;
    if !changed {
        let artifact = load_artifact(conn, workspace_id, connection_id, artifact_id).await?;
        let Some(artifact) = artifact else {
            return Ok(HostedArtifactAck::NotFound);
        };
        let remaining_required =
            count_unresolved_required_artifacts_in_tx(conn, workspace_id, connection_id).await?;
        return Ok(HostedArtifactAck::Applied(Box::new(
            HostedArtifactAcknowledged {
                artifact,
                remaining_required,
                changed: false,
            },
        )));
    }

    let sql = format!(
        "UPDATE hosted_agent_connection_artifact \
            SET current_status = $4, \
                disposition = COALESCE($5::text, disposition), \
                source = CASE WHEN $5::text IS NULL THEN source ELSE 'manual' END, \
                acknowledged_by = CASE WHEN $5::text IS NULL THEN acknowledged_by ELSE $6 END, \
                acknowledged_at = CASE WHEN $5::text IS NULL THEN acknowledged_at ELSE now() END, \
                evidence = CASE WHEN $5::text IS NULL THEN evidence ELSE $7::text END, \
                updated_at = now() \
          WHERE workspace_id = $1 AND connection_id = $2 AND id = $3 \
        RETURNING {ARTIFACT_PROJECTION}"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(connection_id)
        .bind(artifact_id)
        .bind(current_status)
        .bind(requested)
        .bind(actor_member_id)
        .bind(evidence)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        return Ok(HostedArtifactAck::NotFound);
    };
    let artifact = decode_artifact(&row)?;
    let remaining_required =
        count_unresolved_required_artifacts_in_tx(conn, workspace_id, connection_id).await?;
    Ok(HostedArtifactAck::Applied(Box::new(
        HostedArtifactAcknowledged {
            artifact,
            remaining_required,
            changed: true,
        },
    )))
}

async fn load_artifact(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    artifact_id: Uuid,
) -> Result<Option<HostedArtifact>, sqlx::Error> {
    let sql = format!(
        "SELECT {ARTIFACT_PROJECTION} FROM hosted_agent_connection_artifact \
          WHERE workspace_id = $1 AND connection_id = $2 AND id = $3"
    );
    sqlx::query(&sql)
        .bind(workspace_id)
        .bind(connection_id)
        .bind(artifact_id)
        .fetch_optional(&mut *conn)
        .await?
        .as_ref()
        .map(decode_artifact)
        .transpose()
}

/// The terminal transition, which happens at most once per connection.
///
/// Four gates, in this order because each one is cheaper and more specific than
/// the next:
///
///   1. the connection is `cleanup_pending` — the terminal has one predecessor;
///   2. the manifest is **non-empty**. "No unresolved required rows" is
///      vacuously true when there are no rows at all, so a connection that
///      never ran a disconnect start would otherwise walk straight through the
///      gate that exists to stop it. The start seeds all six kinds, so this
///      refuses only a caller that skipped it;
///   3. no required artifact is unresolved;
///   4. the local half — zero live credentials on this connection, a paused
///      dedicated agent — is readable from this server's own tables.
///
/// Migration 072's trigger asserts the same four facts. That is deliberate
/// duplication, not belt-and-braces: this function is the contract a route
/// obeys, and the trigger is the contract a repair script cannot get around.
pub async fn complete_hosted_disconnect_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
) -> Result<HostedDisconnectCompletion, sqlx::Error> {
    let locked: Option<(String, Uuid)> = sqlx::query_as(
        "SELECT status::text, agent_member_id FROM hosted_agent_connection \
          WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((status, agent_member_id)) = locked else {
        return Ok(HostedDisconnectCompletion::NotFound);
    };
    if status == "disconnected" {
        let Some(connection) = load_connection(conn, workspace_id, connection_id).await? else {
            return Ok(HostedDisconnectCompletion::NotFound);
        };
        return Ok(HostedDisconnectCompletion::AlreadyTerminal(Box::new(
            connection,
        )));
    }
    if status != "cleanup_pending" {
        return Ok(HostedDisconnectCompletion::WrongState);
    }
    // Gate 2, and it has to come before gate 3 rather than be folded into it:
    // `remaining_required == 0` is TRUE on an empty manifest, so a connection
    // whose rows were never seeded (or were deleted out of band) would read as
    // fully resolved. The start seeds all six kinds in the same transaction as
    // the `cleanup_pending` transition, so an empty manifest here means the
    // lifecycle was not followed and there is nothing to confirm.
    let manifest_rows: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM hosted_agent_connection_artifact \
          WHERE workspace_id = $1 AND connection_id = $2",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_one(&mut *conn)
    .await?;
    if manifest_rows == 0 {
        return Ok(HostedDisconnectCompletion::ManifestMissing);
    }
    let remaining_required =
        count_unresolved_required_artifacts_in_tx(conn, workspace_id, connection_id).await?;
    if remaining_required > 0 {
        return Ok(HostedDisconnectCompletion::Unresolved { remaining_required });
    }
    let local_confirmed: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS ( \
             SELECT 1 FROM token \
              WHERE workspace_id = $1 AND hosted_connection_id = $2 AND revoked_at IS NULL \
           ) AND EXISTS ( \
             SELECT 1 FROM agent_profile \
              WHERE workspace_id = $1 AND agent_member_id = $3 AND paused \
           )",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(agent_member_id)
    .fetch_one(&mut *conn)
    .await?;
    if !local_confirmed {
        return Ok(HostedDisconnectCompletion::LocalRevokeIncomplete);
    }
    let sql = format!(
        "UPDATE hosted_agent_connection \
            SET status = 'disconnected', active_token_id = NULL, updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 AND status = 'cleanup_pending' \
        RETURNING {CONNECTION_PROJECTION}"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(connection_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        return Err(sqlx::Error::RowNotFound);
    };
    Ok(HostedDisconnectCompletion::Applied(Box::new(
        decode_connection(&row)?,
    )))
}

/// The audit detail for a manifest row — bounded, non-secret, and shaped so an
/// operator reading the log can tell a decision from an observation.
pub fn artifact_audit_detail(artifact: &HostedArtifact) -> Value {
    serde_json::json!({
        "kind": artifact.kind,
        "named_item": artifact.external_ref.is_some(),
        "expected_action": artifact.expected_action,
        "current_status": artifact.current_status,
        "disposition": artifact.disposition,
        "resolved": artifact.resolved,
        "source": artifact.source,
        "evidence_present": artifact.evidence.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_has_exactly_one_expected_action() {
        for kind in HOSTED_ARTIFACT_KINDS {
            assert!(expected_action_for_kind(kind).is_some(), "{kind}");
        }
        assert_eq!(expected_action_for_kind("bot"), Some("decide"));
        assert_eq!(expected_action_for_kind("secret"), Some("revoke"));
        assert_eq!(expected_action_for_kind("connector"), Some("remove"));
        assert_eq!(
            expected_action_for_kind("local_plugin_files"),
            Some("remove")
        );
        assert_eq!(expected_action_for_kind("chat_history"), None);
    }

    /// The #1344 rule set, as a table. `preserve` belongs to `bot` alone, and a
    /// connector can only ever be *removed* — which is why resolving one says
    /// nothing about the files it left on disk.
    #[test]
    fn preserve_is_a_bot_only_terminal_and_secrets_are_only_revoked() {
        assert_eq!(stored_disposition("bot", "preserve"), Some("preserved"));
        assert_eq!(stored_disposition("bot", "delete"), Some("removed"));
        assert_eq!(stored_disposition("bot", "revoke"), None);
        assert_eq!(stored_disposition("secret", "revoke"), Some("revoked"));
        assert_eq!(stored_disposition("secret", "delete"), None);
        for kind in ["routine", "plugin", "connector", "local_plugin_files"] {
            assert_eq!(
                stored_disposition(kind, "delete"),
                Some("removed"),
                "{kind}"
            );
            assert_eq!(stored_disposition(kind, "preserve"), None, "{kind}");
            assert_eq!(stored_disposition(kind, "revoke"), None, "{kind}");
        }
        assert_eq!(stored_disposition("chat_history", "delete"), None);
    }

    #[test]
    fn an_observation_vocabulary_that_cannot_smuggle_a_resolution() {
        for status in ["unknown", "present", "inactive", "absent"] {
            assert!(validate_artifact_status(status).is_ok(), "{status}");
        }
        for status in ["removed", "resolved", "off", ""] {
            assert_eq!(
                validate_artifact_status(status),
                Err(HostedArtifactInputError::Status),
                "{status}"
            );
        }
    }

    #[test]
    fn named_items_are_bounded_deduplicated_and_never_credential_shaped() {
        let ok = validate_artifact_seeds(&[
            HostedArtifactSeed {
                kind: "routine".into(),
                external_ref: "  Morning digest  ".into(),
            },
            HostedArtifactSeed {
                kind: "connector".into(),
                external_ref: "oort".into(),
            },
        ])
        .expect("two distinct items");
        assert_eq!(ok[0].external_ref, "Morning digest");

        assert_eq!(
            validate_artifact_seeds(&[HostedArtifactSeed {
                kind: "chat_history".into(),
                external_ref: "x".into()
            }]),
            Err(HostedArtifactInputError::Kind)
        );
        for bad in [
            String::new(),
            "   ".to_string(),
            "x".repeat(MAX_ARTIFACT_REF_BYTES + 1),
            format!("{}.leak", crate::hosted_connection::HOSTED_PAIRING_PREFIX),
            format!("{}.leak", crate::AGENT_BEARER_PREFIX),
            "line\nbreak".to_string(),
        ] {
            assert_eq!(
                validate_artifact_seeds(&[HostedArtifactSeed {
                    kind: "routine".into(),
                    external_ref: bad.clone()
                }]),
                Err(HostedArtifactInputError::Reference),
                "{bad:?}"
            );
        }
        assert_eq!(
            validate_artifact_seeds(&[
                HostedArtifactSeed {
                    kind: "routine".into(),
                    external_ref: "same".into()
                },
                HostedArtifactSeed {
                    kind: "routine".into(),
                    external_ref: " same ".into()
                },
            ]),
            Err(HostedArtifactInputError::Reference)
        );
        let too_many: Vec<HostedArtifactSeed> = (0..=MAX_ARTIFACT_ITEMS)
            .map(|index| HostedArtifactSeed {
                kind: "routine".into(),
                external_ref: format!("item-{index}"),
            })
            .collect();
        assert_eq!(
            validate_artifact_seeds(&too_many),
            Err(HostedArtifactInputError::TooMany)
        );
    }

    #[test]
    fn a_manual_acknowledgement_cannot_be_evidence_free() {
        assert_eq!(
            validate_artifact_evidence(Some("  removed in provider UI  ")).unwrap(),
            "removed in provider UI"
        );
        for bad in [None, Some(""), Some("   ")] {
            assert_eq!(
                validate_artifact_evidence(bad),
                Err(HostedArtifactInputError::Evidence),
                "{bad:?}"
            );
        }
        let long = "e".repeat(MAX_ARTIFACT_EVIDENCE_BYTES + 1);
        assert_eq!(
            validate_artifact_evidence(Some(&long)),
            Err(HostedArtifactInputError::Evidence)
        );
    }

    /// A disconnect starts from the two states that ever handed capability out.
    #[test]
    fn only_credentialed_states_can_start_a_disconnect() {
        assert_eq!(HOSTED_DISCONNECTABLE_STATES, ["detected", "active"]);
        for state in [
            "pairing_pending",
            "expired",
            "cleanup_pending",
            "disconnected",
        ] {
            assert!(!HOSTED_DISCONNECTABLE_STATES.contains(&state), "{state}");
        }
    }

    #[test]
    fn the_artifact_audit_detail_carries_no_evidence_text() {
        let detail = artifact_audit_detail(&HostedArtifact {
            id: Uuid::from_u128(1),
            kind: "connector".into(),
            external_ref: Some("oort".into()),
            expected_action: "remove".into(),
            current_status: "absent".into(),
            disposition: "removed".into(),
            resolved: true,
            required: true,
            source: Some("manual".into()),
            acknowledged_by: Some(Uuid::from_u128(2)),
            acknowledged_at_ms: Some(3),
            evidence: Some("uninstalled via momo_pair_v1.looking.text".into()),
            updated_at_ms: 4,
        });
        assert_eq!(detail["evidence_present"], serde_json::json!(true));
        assert!(detail.get("evidence").is_none());
        assert!(!detail.to_string().contains("momo_pair_v1"));
        assert_eq!(detail["named_item"], serde_json::json!(true));
    }
}
