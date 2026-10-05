//! Personal cloud box — the trust-chain pieces the server stores and forwards for the blind relay
//! (migration 120, ADR-0197 M4 증보 2).
//!
//! **The server can store these and cannot make them.** Every value is checked by an endpoint that is
//! not the server: the owner device (`HostPin`, `DeviceList` audit) and the box-agent (owner list,
//! device signature). The columns have no room for a pairing code, a session key or terminal content.
//!
//! * [`set_runner_signing_key_in_tx`] — the runner's Ed25519 public key, set once. No fingerprint is
//!   stored or served: a device computes it itself and compares it with what the operator told the member.
//! * [`put_owner_list_in_tx`] — the box's first owner `DeviceList` bytes (opaque), only while the box is
//!   `creating` and its `create` control has not been handed to the runner.
//! * [`register_agent_in_tx`] / [`activate_agent_in_tx`] — the box-agent's registration slot. The server
//!   cannot verify the MAC (it never sees the pairing code), so it parks a `pending` slot (last write wins)
//!   until the runner, which knows the code, attests the key. Once `active` the host key is never replaced.
//! * [`put_pin_in_tx`] — the owner's `HostPin` bytes (opaque), stored for devices to re-verify.

use momo_auth::{insert_work_host, NewWorkHost};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::DbError;
use serde_json::json;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::cloud_box::{find_box_in_tx, BoxInfo, BoxState, CLOUD_BOX_AUDIT_SCHEMA};

/// Largest first owner list / pin the server stores (`DeviceList::MAX_DEVICES = 16` is ~700 bytes).
pub const MAX_OPAQUE_BYTES: usize = 2048;

pub const KEY_LEN: usize = 32;
pub const MAC_LEN: usize = 32;
pub const ATTESTATION_LEN: usize = 64;

/// The display name every box host carries (the runner's name is not a person's label).
const HOST_DISPLAY_NAME: &str = "oort box";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigningKeyOutcome {
    Set,
    /// Same key again: idempotent.
    Same,
    /// A different key is already set: the runner's identity does not change.
    Conflict,
    NotFound,
}

/// Record the runner's Ed25519 public key. Set once; `Conflict` otherwise.
pub async fn set_runner_signing_key_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    runner_id: Uuid,
    key: &[u8; KEY_LEN],
) -> Result<SigningKeyOutcome, DbError> {
    let row = sqlx::query(
        "SELECT signing_public_key FROM cloud_box_runner \
          WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(runner_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(SigningKeyOutcome::NotFound);
    };
    let current: Option<Vec<u8>> = row.try_get(0)?;
    match current {
        Some(existing) if existing == key => Ok(SigningKeyOutcome::Same),
        Some(_) => Ok(SigningKeyOutcome::Conflict),
        None => {
            sqlx::query(
                "UPDATE cloud_box_runner SET signing_public_key = $3 \
                  WHERE workspace_id = $1 AND id = $2",
            )
            .bind(workspace_id)
            .bind(runner_id)
            .bind(&key[..])
            .execute(&mut *conn)
            .await?;
            Ok(SigningKeyOutcome::Set)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PutListOutcome {
    Stored,
    /// The box is past `creating` or its `create` control was already handed out / finished.
    Locked,
    NotFound,
}

/// Store the first owner device list for a box that is still waiting for its `create`.
pub async fn put_owner_list_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    box_id: Uuid,
    list: &[u8],
) -> Result<PutListOutcome, DbError> {
    debug_assert!(!list.is_empty() && list.len() <= MAX_OPAQUE_BYTES);
    let row = sqlx::query(
        "SELECT state FROM cloud_box WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(box_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(PutListOutcome::NotFound);
    };
    let state: String = row.try_get(0)?;
    if state != "creating" {
        return Ok(PutListOutcome::Locked);
    }
    // The `create` control must still be pending: a lease means the runner already built the box
    // with (or without) a list, and a late list could not reach it.
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM cloud_box_control \
          WHERE workspace_id = $1 AND box_id = $2 AND verb = 'create' AND status = 'pending'",
    )
    .bind(workspace_id)
    .bind(box_id)
    .fetch_one(&mut *conn)
    .await?;
    if pending == 0 {
        return Ok(PutListOutcome::Locked);
    }
    sqlx::query(
        "INSERT INTO cloud_box_trust (box_id, workspace_id, owner_list, owner_list_at) \
         VALUES ($1, $2, $3, now()) \
         ON CONFLICT (box_id) DO UPDATE SET owner_list = EXCLUDED.owner_list, owner_list_at = now()",
    )
    .bind(box_id)
    .bind(workspace_id)
    .bind(list)
    .execute(&mut *conn)
    .await?;
    Ok(PutListOutcome::Stored)
}

/// The first owner list, for the runner's `create` (never for another device, see the route).
pub async fn owner_list_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    box_id: Uuid,
) -> Result<Option<Vec<u8>>, DbError> {
    let list: Option<Option<Vec<u8>>> = sqlx::query_scalar(
        "SELECT owner_list FROM cloud_box_trust WHERE workspace_id = $1 AND box_id = $2",
    )
    .bind(workspace_id)
    .bind(box_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(list.flatten())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PutPinOutcome {
    Stored,
    /// No `active` box-agent yet: there is no host key to pin.
    NotActive,
    NotFound,
}

pub async fn put_pin_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    box_id: Uuid,
    pin: &[u8],
) -> Result<PutPinOutcome, DbError> {
    debug_assert!(!pin.is_empty() && pin.len() <= MAX_OPAQUE_BYTES);
    if find_box_in_tx(conn, workspace_id, box_id).await?.is_none() {
        return Ok(PutPinOutcome::NotFound);
    }
    let active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM cloud_box_agent \
          WHERE workspace_id = $1 AND box_id = $2 AND state = 'active'",
    )
    .bind(workspace_id)
    .bind(box_id)
    .fetch_one(&mut *conn)
    .await?;
    if active == 0 {
        return Ok(PutPinOutcome::NotActive);
    }
    sqlx::query(
        "INSERT INTO cloud_box_trust (box_id, workspace_id, pin, pin_at) \
         VALUES ($1, $2, $3, now()) \
         ON CONFLICT (box_id) DO UPDATE SET pin = EXCLUDED.pin, pin_at = now()",
    )
    .bind(box_id)
    .bind(workspace_id)
    .bind(pin)
    .execute(&mut *conn)
    .await?;
    Ok(PutPinOutcome::Stored)
}

/// What a device may learn about the box's trust chain. **No owner list and no fingerprint**: a new
/// device gets the list in person (S2 condition ①), and the fingerprint is computed on the device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustBundle {
    pub host_id: Option<Uuid>,
    pub host_public_key: Option<Vec<u8>>,
    pub attestation: Option<Vec<u8>>,
    pub runner_public_key: Option<Vec<u8>>,
    pub pin: Option<Vec<u8>>,
}

pub async fn trust_bundle_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    box_id: Uuid,
) -> Result<TrustBundle, DbError> {
    let agent = sqlx::query(
        "SELECT a.host_id, a.host_public_key, a.attestation, r.signing_public_key \
           FROM cloud_box_agent a \
           LEFT JOIN cloud_box_runner r ON r.id = a.runner_id AND r.workspace_id = a.workspace_id \
          WHERE a.workspace_id = $1 AND a.box_id = $2 AND a.state = 'active'",
    )
    .bind(workspace_id)
    .bind(box_id)
    .fetch_optional(&mut *conn)
    .await?;
    let pin: Option<Option<Vec<u8>>> = sqlx::query_scalar(
        "SELECT pin FROM cloud_box_trust WHERE workspace_id = $1 AND box_id = $2",
    )
    .bind(workspace_id)
    .bind(box_id)
    .fetch_optional(&mut *conn)
    .await?;
    let pin = pin.flatten();
    Ok(match agent {
        Some(row) => TrustBundle {
            host_id: row.try_get(0)?,
            host_public_key: Some(row.try_get(1)?),
            attestation: row.try_get(2)?,
            runner_public_key: row.try_get(3)?,
            pin,
        },
        None => TrustBundle {
            host_id: None,
            host_public_key: None,
            attestation: None,
            runner_public_key: None,
            pin,
        },
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterAgentOutcome {
    /// Parked; the runner has not attested yet.
    Pending,
    /// Already attested with this very key (idempotent answer for a restarting box-agent).
    Active { host_id: Uuid },
    /// An active host key exists and this is not it: nothing was overwritten.
    KeyConflict,
    /// No such box, or it can no longer host an agent (`deleting`, `delete_failed`, `deleted`).
    NotFound,
}

/// The box-agent's registration. The MAC cannot be verified here (the server never sees the pairing
/// code); the runner verifies it. A `pending` slot is last-writer-wins: whoever can reach this route
/// can occupy it until the runner rejects, which is a nuisance and not a compromise (the runner refuses
/// what it cannot verify, and the real box-agent re-registers).
pub async fn register_agent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    box_id: Uuid,
    host_public_key: &[u8; KEY_LEN],
    mac: &[u8; MAC_LEN],
) -> Result<RegisterAgentOutcome, DbError> {
    let row = sqlx::query(
        "SELECT state FROM cloud_box WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(box_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(RegisterAgentOutcome::NotFound);
    };
    let state: String = row.try_get(0)?;
    if !matches!(
        BoxState::parse(&state),
        Some(BoxState::Creating | BoxState::Running | BoxState::Idle | BoxState::Stopped)
    ) {
        return Ok(RegisterAgentOutcome::NotFound);
    }
    let existing = sqlx::query(
        "SELECT state, host_public_key, host_id FROM cloud_box_agent \
          WHERE workspace_id = $1 AND box_id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(box_id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(existing) = existing {
        let agent_state: String = existing.try_get(0)?;
        if agent_state == "active" {
            let stored: Vec<u8> = existing.try_get(1)?;
            let host_id: Option<Uuid> = existing.try_get(2)?;
            return Ok(match (stored == host_public_key, host_id) {
                (true, Some(host_id)) => RegisterAgentOutcome::Active { host_id },
                _ => RegisterAgentOutcome::KeyConflict,
            });
        }
        sqlx::query(
            "UPDATE cloud_box_agent SET host_public_key = $3, mac = $4, state = 'pending', registered_at = now() \
              WHERE workspace_id = $1 AND box_id = $2",
        )
        .bind(workspace_id)
        .bind(box_id)
        .bind(&host_public_key[..])
        .bind(&mac[..])
        .execute(&mut *conn)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO cloud_box_agent (box_id, workspace_id, host_public_key, mac) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(box_id)
        .bind(workspace_id)
        .bind(&host_public_key[..])
        .bind(&mac[..])
        .execute(&mut *conn)
        .await?;
    }
    Ok(RegisterAgentOutcome::Pending)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingRegistration {
    pub box_id: Uuid,
    pub host_public_key: Vec<u8>,
    pub mac: Vec<u8>,
}

/// The runner's work list: parked registrations for boxes that are still alive.
pub async fn list_pending_registrations_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Vec<PendingRegistration>, DbError> {
    let rows = sqlx::query(
        "SELECT a.box_id, a.host_public_key, a.mac FROM cloud_box_agent a \
           JOIN cloud_box b ON b.id = a.box_id AND b.workspace_id = a.workspace_id \
          WHERE a.workspace_id = $1 AND a.state = 'pending' \
            AND b.state IN ('creating', 'running', 'idle', 'stopped') \
          ORDER BY a.registered_at LIMIT 50",
    )
    .bind(workspace_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(PendingRegistration {
                box_id: row.try_get(0)?,
                host_public_key: row.try_get(1)?,
                mac: row.try_get(2)?,
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivateOutcome {
    Activated { host_id: Uuid },
    /// Already active with this key: idempotent.
    AlreadyActive { host_id: Uuid },
    /// The slot holds another key than the one the runner attested (the box-agent re-registered meanwhile),
    /// or nothing is parked: nothing was activated.
    NoMatchingRegistration,
    /// An active host with a different key exists: nothing was overwritten.
    KeyConflict,
    NotFound,
}

/// The runner attested the parked key: create the box's host (`scope='member'`, `type='cloud'`, owner =
/// the box owner) and mark the slot `active`. The attestation is stored opaque — the owner device
/// verifies it against the runner key it pinned out of band; the server's check is only that the
/// runner credential (which the route already verified) said so for this exact key.
pub async fn activate_agent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    runner_id: Uuid,
    box_id: Uuid,
    host_public_key: &[u8; KEY_LEN],
    attestation: &[u8; ATTESTATION_LEN],
) -> Result<ActivateOutcome, DbError> {
    use base64::Engine as _;
    let Some(info) = lock_box(conn, workspace_id, box_id).await? else {
        return Ok(ActivateOutcome::NotFound);
    };
    if !matches!(
        info.state,
        BoxState::Creating | BoxState::Running | BoxState::Idle | BoxState::Stopped
    ) {
        return Ok(ActivateOutcome::NotFound);
    }
    let slot = sqlx::query(
        "SELECT state, host_public_key, host_id FROM cloud_box_agent \
          WHERE workspace_id = $1 AND box_id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(box_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(slot) = slot else {
        return Ok(ActivateOutcome::NoMatchingRegistration);
    };
    let state: String = slot.try_get(0)?;
    let stored: Vec<u8> = slot.try_get(1)?;
    if state == "active" {
        let host_id: Option<Uuid> = slot.try_get(2)?;
        return Ok(match (stored == host_public_key, host_id) {
            (true, Some(host_id)) => ActivateOutcome::AlreadyActive { host_id },
            _ => ActivateOutcome::KeyConflict,
        });
    }
    // A `rejected` slot is empty; a `pending` one must hold exactly the key the runner attested.
    if state != "pending" || stored != host_public_key {
        return Ok(ActivateOutcome::NoMatchingRegistration);
    }
    let host_id = insert_work_host(
        conn,
        workspace_id,
        &NewWorkHost {
            scope: "member".to_string(),
            owner_member_id: info.member_id,
            host_type: "cloud".to_string(),
            display_name: HOST_DISPLAY_NAME.to_string(),
            public_key: base64::engine::general_purpose::STANDARD.encode(host_public_key),
            capabilities_json: json!({"acp": false, "terminal_attach": true}).to_string(),
            seen_now: false,
        },
    )
    .await?;
    sqlx::query(
        "UPDATE cloud_box_agent SET state = 'active', host_id = $3, attestation = $4, \
                runner_id = $5, activated_at = now() \
          WHERE workspace_id = $1 AND box_id = $2",
    )
    .bind(workspace_id)
    .bind(box_id)
    .bind(host_id)
    .bind(&attestation[..])
    .bind(runner_id)
    .execute(&mut *conn)
    .await?;
    audit(conn, &info, "cloud_box.agent_activated", Some(host_id)).await?;
    Ok(ActivateOutcome::Activated { host_id })
}

/// The runner could not verify the parked registration: free the slot (only a `pending` one holding exactly that
/// key becomes `rejected`; the API role may not delete these rows, and a `rejected` slot is simply empty).
pub async fn reject_registration_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    box_id: Uuid,
    host_public_key: &[u8; KEY_LEN],
) -> Result<bool, DbError> {
    let done = sqlx::query(
        "UPDATE cloud_box_agent SET state = 'rejected' \
          WHERE workspace_id = $1 AND box_id = $2 AND state = 'pending' AND host_public_key = $3",
    )
    .bind(workspace_id)
    .bind(box_id)
    .bind(&host_public_key[..])
    .execute(&mut *conn)
    .await?;
    Ok(done.rows_affected() == 1)
}

async fn lock_box(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    box_id: Uuid,
) -> Result<Option<BoxInfo>, DbError> {
    sqlx::query("SELECT 1 FROM cloud_box WHERE workspace_id = $1 AND id = $2 FOR UPDATE")
        .bind(workspace_id)
        .bind(box_id)
        .fetch_optional(&mut *conn)
        .await?;
    find_box_in_tx(conn, workspace_id, box_id).await
}

async fn audit(
    conn: &mut PgConnection,
    info: &BoxInfo,
    action: &str,
    host_id: Option<Uuid>,
) -> Result<(), DbError> {
    // Ids only. No key bytes, no mac, no attestation.
    let mut entry = AuditEntry::new(info.workspace_id, action)
        .about(info.member_id)
        .target("cloud_box", info.id)
        .with_schema(
            CLOUD_BOX_AUDIT_SCHEMA,
            json!({
                "box_id": info.id.to_string(),
                "host_id": host_id.map(|id| id.to_string()),
                "actor_role": "runner",
            }),
        );
    entry.actor_member_id = None;
    write_audit(conn, &entry).await?;
    Ok(())
}

/// What the relay needs to authorise one attach (and to re-check it while the socket lives).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachContext {
    pub box_info: BoxInfo,
    /// The box-agent host the **server** derived from the box row (never from the request).
    pub host_id: Uuid,
    pub host_revoked: bool,
    pub host_owner: Uuid,
}

pub async fn attach_context_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    box_id: Uuid,
) -> Result<Option<AttachContext>, DbError> {
    let Some(box_info) = find_box_in_tx(conn, workspace_id, box_id).await? else {
        return Ok(None);
    };
    let row = sqlx::query(
        "SELECT a.host_id, h.revoked_at IS NOT NULL, h.owner_member_id \
           FROM cloud_box_agent a JOIN work_host h ON h.id = a.host_id \
          WHERE a.workspace_id = $1 AND a.box_id = $2 AND a.state = 'active'",
    )
    .bind(workspace_id)
    .bind(box_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(AttachContext {
        box_info,
        host_id: row.try_get(0)?,
        host_revoked: row.try_get(1)?,
        host_owner: row.try_get(2)?,
    }))
}

/// The box this host serves (the box-agent's own sockets pin to it), if it is an `active` agent.
pub async fn box_of_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
) -> Result<Option<Uuid>, DbError> {
    let id: Option<Uuid> = sqlx::query_scalar(
        "SELECT box_id FROM cloud_box_agent \
          WHERE workspace_id = $1 AND host_id = $2 AND state = 'active'",
    )
    .bind(workspace_id)
    .bind(host_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(id)
}

/// Close the box's host when the box is gone (the runner reported `deleted`): its sockets stop at the next
/// request and the relay supervisor ends its sessions.
pub async fn revoke_box_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    box_id: Uuid,
) -> Result<Option<Uuid>, DbError> {
    let host: Option<Option<Uuid>> = sqlx::query_scalar(
        "SELECT host_id FROM cloud_box_agent WHERE workspace_id = $1 AND box_id = $2",
    )
    .bind(workspace_id)
    .bind(box_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(Some(host_id)) = host else {
        return Ok(None);
    };
    momo_auth::mark_work_host_revoked(conn, host_id).await?;
    Ok(Some(host_id))
}
