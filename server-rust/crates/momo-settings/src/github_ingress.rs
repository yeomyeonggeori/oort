//! GitHub App receive, link and subscribe — every statement (#3954 E-GH2 / ADR-0205 D3·D4·D5).
//!
//! Every function takes a caller-supplied `&mut PgConnection`. Which GUCs that connection carries
//! is decided by `momo_db::with_github_tx` (and the operator / tenant helpers), never here:
//!
//! | function                                  | needs on the transaction                          |
//! |-------------------------------------------|---------------------------------------------------|
//! | [`read_webhook_secrets`]                  | `app.github_ingress`                              |
//! | installation / repository writes          | `app.github_ingress`                              |
//! | [`try_link_installation`]                 | `app.github_link` (+ `app.github_ingress` to also |
//! |                                           | have just created the row)                        |
//! | claims, subscriptions, receipts, author   | `app.workspace_id`                                |
//!
//! ## Linking: two signals, exactly one link (ADR-0205 D3)
//!
//! A pending claim (the setup URL, with an `installation_id` that **may be forged**) and a signed
//! `installation.created` row meet in [`try_link_installation`]. The link is one guarded
//! `UPDATE … WHERE workspace_id IS NULL`, so whichever path arrives second performs it and a
//! simultaneous pair performs it once. If more than one pending claim names the same
//! installation, nothing is linked automatically (it is the shape a forged setup URL takes), and
//! the instance operator decides.
//!
//! Residual risk, stated plainly: an installation that has been signed-in but is not yet linked
//! can be claimed by any workspace owner/admin who guesses its numeric id within ten minutes of
//! minting a state. ADR-0205 D3 accepts this in exchange for never holding a person's GitHub
//! token; the audit rows (`github.installation_linked`) name who linked what.

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// What `installation` / `installation_repositories` payloads say about an installation.
/// Plain data so this crate does not depend on `momo-webhook`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallationFacts {
    pub id: i64,
    pub account_login: String,
    pub account_type: String,
    pub repository_selection: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryFacts {
    pub id: i64,
    pub full_name: String,
    pub private: bool,
}

/// The lifetime of an install claim (ADR-0205 D3: 10 분).
pub const INSTALL_STATE_TTL_SECONDS: i64 = 600;

// ---------------------------------------------------------------------------
// webhook secrets (ingress GUC)
// ---------------------------------------------------------------------------

/// The sealed webhook secrets, newest first. `previous` is `Some` only while the rotation overlap
/// window is open **at the database clock** (ADR-0205 D7), so a closed window is invisible to the
/// caller and cannot be forgotten.
#[derive(Debug, Clone)]
pub struct SealedWebhookSecrets {
    pub current: Vec<u8>,
    pub previous: Option<Vec<u8>>,
}

pub async fn read_webhook_secrets(
    conn: &mut PgConnection,
) -> Result<Option<SealedWebhookSecrets>, DbError> {
    let row: Option<(Vec<u8>, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT webhook_secret_ciphertext, \
                CASE WHEN previous_valid_until IS NOT NULL AND previous_valid_until > now() \
                     THEN webhook_secret_previous_ciphertext END \
           FROM github_app WHERE id = true",
    )
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|(current, previous)| SealedWebhookSecrets { current, previous }))
}

/// The App's non-secret slug (any tenant session may read it; migration 142).
pub async fn read_app_slug(conn: &mut PgConnection) -> Result<Option<String>, DbError> {
    Ok(
        sqlx::query_scalar("SELECT slug FROM github_app_public WHERE id = true")
            .fetch_optional(&mut *conn)
            .await?,
    )
}

// ---------------------------------------------------------------------------
// installations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallationRecord {
    pub installation_id: i64,
    pub account_login: String,
    pub account_type: String,
    pub repository_selection: String,
    pub workspace_id: Option<Uuid>,
    pub suspended: bool,
    pub removed: bool,
}

const INSTALLATION_PROJECTION: &str = "installation_id, account_login, account_type, \
     repository_selection, workspace_id, suspended_at IS NOT NULL AS suspended, \
     removed_at IS NOT NULL AS removed";

fn decode_installation(row: &sqlx::postgres::PgRow) -> Result<InstallationRecord, sqlx::Error> {
    Ok(InstallationRecord {
        installation_id: row.try_get("installation_id")?,
        account_login: row.try_get("account_login")?,
        account_type: row.try_get("account_type")?,
        repository_selection: row.try_get("repository_selection")?,
        workspace_id: row.try_get("workspace_id")?,
        suspended: row.try_get("suspended")?,
        removed: row.try_get("removed")?,
    })
}

pub async fn find_installation(
    conn: &mut PgConnection,
    installation_id: i64,
) -> Result<Option<InstallationRecord>, DbError> {
    let row = sqlx::query(&format!(
        "SELECT {INSTALLATION_PROJECTION} FROM github_app_installation WHERE installation_id = $1"
    ))
    .bind(installation_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.as_ref().map(decode_installation).transpose()?)
}

/// Create or refresh the routing row from a signed payload. The link (`workspace_id`) is never
/// touched here. `reset_state` (an `installation.created`) also clears a stale suspend/remove mark.
pub async fn upsert_installation(
    conn: &mut PgConnection,
    facts: &InstallationFacts,
    reset_state: bool,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO github_app_installation \
           (installation_id, account_login, account_type, repository_selection) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (installation_id) DO UPDATE SET \
           account_login = EXCLUDED.account_login, \
           account_type = EXCLUDED.account_type, \
           repository_selection = EXCLUDED.repository_selection, \
           suspended_at = CASE WHEN $5 THEN NULL ELSE github_app_installation.suspended_at END, \
           removed_at = CASE WHEN $5 THEN NULL ELSE github_app_installation.removed_at END, \
           updated_at = now()",
    )
    .bind(facts.id)
    .bind(&facts.account_login)
    .bind(&facts.account_type)
    .bind(&facts.repository_selection)
    .bind(reset_state)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallationMark {
    Suspended,
    Unsuspended,
    Removed,
}

pub async fn mark_installation(
    conn: &mut PgConnection,
    installation_id: i64,
    mark: InstallationMark,
) -> Result<(), DbError> {
    let statement = match mark {
        InstallationMark::Suspended => {
            "UPDATE github_app_installation SET suspended_at = COALESCE(suspended_at, now()), \
             updated_at = now() WHERE installation_id = $1"
        }
        InstallationMark::Unsuspended => {
            "UPDATE github_app_installation SET suspended_at = NULL, updated_at = now() \
             WHERE installation_id = $1"
        }
        InstallationMark::Removed => {
            "UPDATE github_app_installation SET removed_at = COALESCE(removed_at, now()), \
             updated_at = now() WHERE installation_id = $1"
        }
    };
    sqlx::query(statement)
        .bind(installation_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Replace the whole repository list (an `installation.created` carries the full set).
pub async fn replace_repositories(
    conn: &mut PgConnection,
    installation_id: i64,
    repositories: &[RepositoryFacts],
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM github_installation_repository WHERE installation_id = $1")
        .bind(installation_id)
        .execute(&mut *conn)
        .await?;
    add_repositories(conn, installation_id, repositories).await
}

pub async fn add_repositories(
    conn: &mut PgConnection,
    installation_id: i64,
    repositories: &[RepositoryFacts],
) -> Result<(), DbError> {
    if repositories.is_empty() {
        return Ok(());
    }
    let ids: Vec<i64> = repositories.iter().map(|repo| repo.id).collect();
    let names: Vec<String> = repositories
        .iter()
        .map(|repo| repo.full_name.clone())
        .collect();
    let privates: Vec<bool> = repositories.iter().map(|repo| repo.private).collect();
    sqlx::query(
        "INSERT INTO github_installation_repository \
           (installation_id, repo_id, full_name, private) \
         SELECT $1, r.id, r.name, r.private \
           FROM UNNEST($2::bigint[], $3::text[], $4::boolean[]) AS r(id, name, private) \
         ON CONFLICT (installation_id, repo_id) DO UPDATE SET \
           full_name = EXCLUDED.full_name, private = EXCLUDED.private, updated_at = now()",
    )
    .bind(installation_id)
    .bind(&ids)
    .bind(&names)
    .bind(&privates)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// ADR-0205 H-1 (#4084): a signed delivery carries the repository's **current** privacy and name.
/// The stored list is only written by installation events, so a repository that turned private (or
/// was renamed) after the install would keep the old facts and the reconfirm check would trust a
/// stale `private = false`. Refreshes a row that exists; a repository outside the list stays unknown
/// (and unknown counts as private).
pub async fn refresh_repository_facts(
    conn: &mut PgConnection,
    installation_id: i64,
    repo_id: i64,
    full_name: &str,
    private: bool,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE github_installation_repository \
            SET private = $3, full_name = $4, updated_at = now() \
          WHERE installation_id = $1 AND repo_id = $2 \
            AND (private IS DISTINCT FROM $3 OR full_name IS DISTINCT FROM $4)",
    )
    .bind(installation_id)
    .bind(repo_id)
    .bind(private)
    .bind(full_name)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn remove_repositories(
    conn: &mut PgConnection,
    installation_id: i64,
    repository_ids: &[i64],
) -> Result<(), DbError> {
    if repository_ids.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "DELETE FROM github_installation_repository \
          WHERE installation_id = $1 AND repo_id = ANY($2)",
    )
    .bind(installation_id)
    .bind(repository_ids)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryRecord {
    pub repo_id: i64,
    pub full_name: String,
    pub private: bool,
}

pub async fn list_repositories(
    conn: &mut PgConnection,
    installation_id: i64,
) -> Result<Vec<RepositoryRecord>, DbError> {
    let rows = sqlx::query(
        "SELECT repo_id, full_name, private FROM github_installation_repository \
          WHERE installation_id = $1 ORDER BY lower(full_name) LIMIT 2000",
    )
    .bind(installation_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(RepositoryRecord {
                repo_id: row.try_get("repo_id")?,
                full_name: row.try_get("full_name")?,
                private: row.try_get("private")?,
            })
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(DbError::from)
}

pub async fn find_repository(
    conn: &mut PgConnection,
    installation_id: i64,
    full_name: &str,
) -> Result<Option<RepositoryRecord>, DbError> {
    let row = sqlx::query(
        "SELECT repo_id, full_name, private FROM github_installation_repository \
          WHERE installation_id = $1 AND lower(full_name) = lower($2)",
    )
    .bind(installation_id)
    .bind(full_name)
    .fetch_optional(&mut *conn)
    .await?;
    row.map(|row| {
        Ok(RepositoryRecord {
            repo_id: row.try_get("repo_id")?,
            full_name: row.try_get("full_name")?,
            private: row.try_get("private")?,
        })
    })
    .transpose()
    .map_err(|error: sqlx::Error| DbError::from(error))
}

/// Installations nobody has linked yet (operator view; admin GUC).
pub async fn list_unlinked_installations(
    conn: &mut PgConnection,
) -> Result<Vec<(InstallationRecord, i64)>, DbError> {
    let rows = sqlx::query(&format!(
        "SELECT {INSTALLATION_PROJECTION}, \
                (SELECT count(*) FROM github_installation_repository r \
                  WHERE r.installation_id = github_app_installation.installation_id) AS repo_count \
           FROM github_app_installation \
          WHERE workspace_id IS NULL AND removed_at IS NULL \
          ORDER BY created_at DESC LIMIT 200"
    ))
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok((
                decode_installation(row)?,
                row.try_get::<i64, _>("repo_count")?,
            ))
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(DbError::from)
}

/// Installations linked to the session's own workspace (tenant SELECT policy does the scoping).
pub async fn list_workspace_installations(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Vec<InstallationRecord>, DbError> {
    let rows = sqlx::query(&format!(
        "SELECT {INSTALLATION_PROJECTION} FROM github_app_installation \
          WHERE workspace_id = $1 AND removed_at IS NULL ORDER BY linked_at LIMIT 50"
    ))
    .bind(workspace_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(decode_installation)
        .collect::<Result<_, sqlx::Error>>()
        .map_err(DbError::from)
}

// ---------------------------------------------------------------------------
// claims and the link
// ---------------------------------------------------------------------------

/// Mint an install claim for `(workspace, member)`: state hash only, ten minutes.
pub async fn insert_install_claim(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    hash: &[u8],
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO github_link_claim \
           (workspace_id, member_id, purpose, state_hash, expires_at) \
         VALUES ($1, $2, 'install', $3, now() + make_interval(secs => $4))",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(hash)
    .bind(INSTALL_STATE_TTL_SECONDS as f64)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Who minted a claim that is still pending and which it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PendingClaim {
    pub claim_id: Uuid,
    pub member_id: Uuid,
}

/// Record the setup URL's `installation_id` on a live, unspent install claim. The id is
/// **unverified** at this point (anyone can open the setup URL with any id); it is only a pending
/// half of the link. A claim that already names a different installation refuses a second one.
pub async fn record_claim_installation(
    conn: &mut PgConnection,
    hash: &[u8],
    installation_id: i64,
) -> Result<Option<PendingClaim>, DbError> {
    let row: Option<(Uuid, Uuid)> = sqlx::query_as(
        "UPDATE github_link_claim \
            SET installation_id = $2 \
          WHERE state_hash = $1 \
            AND purpose = 'install' \
            AND consumed_at IS NULL \
            AND expires_at > now() \
            AND (installation_id IS NULL OR installation_id = $2) \
          RETURNING id, member_id",
    )
    .bind(hash)
    .bind(installation_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|(claim_id, member_id)| PendingClaim {
        claim_id,
        member_id,
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkOutcome {
    /// This call linked the installation to `workspace_id`.
    Linked { workspace_id: Uuid, member_id: Uuid },
    /// Already linked to that workspace (a repeated signal): nothing changed.
    AlreadyLinked { workspace_id: Uuid },
    /// Linked to a different workspace: the claim cannot take it (409).
    LinkedElsewhere,
    /// The signed `installation.created` has not arrived (the row does not exist yet).
    NoInstallation,
    /// No live claim names this installation.
    NoClaim,
    /// More than one live claim names it: left for the instance operator.
    Ambiguous,
}

/// Meet the two signals. Needs `app.github_link` on the transaction.
///
/// `restrict_to_claim`: from the setup-URL path, the claim just recorded — the link may only use
/// **that** claim (the caller already proved it holds the state). From the signed-event path it is
/// `None`: any single live claim naming the installation qualifies.
pub async fn try_link_installation(
    conn: &mut PgConnection,
    installation_id: i64,
    restrict_to_claim: Option<Uuid>,
) -> Result<LinkOutcome, DbError> {
    // Two simultaneous signals serialise on `lock_installation_link`, taken by the caller; the
    // `WHERE workspace_id IS NULL` below is the atomic guard that makes the link happen once.
    let installation: Option<(Option<Uuid>, bool)> = sqlx::query_as(
        "SELECT workspace_id, removed_at IS NOT NULL FROM github_app_installation \
          WHERE installation_id = $1",
    )
    .bind(installation_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((linked_to, removed)) = installation else {
        return Ok(LinkOutcome::NoInstallation);
    };

    let claims: Vec<(Uuid, Uuid, Uuid)> = sqlx::query_as(
        "SELECT id, workspace_id, member_id FROM github_link_claim \
          WHERE installation_id = $1 AND purpose = 'install' \
            AND consumed_at IS NULL AND expires_at > now() \
          ORDER BY created_at LIMIT 3 FOR UPDATE",
    )
    .bind(installation_id)
    .fetch_all(&mut *conn)
    .await?;

    let chosen = match restrict_to_claim {
        Some(claim_id) => claims.iter().find(|claim| claim.0 == claim_id).copied(),
        None => match claims.as_slice() {
            [] => None,
            [only] => Some(*only),
            _ => return Ok(LinkOutcome::Ambiguous),
        },
    };
    let Some((claim_id, claim_workspace, member_id)) = chosen else {
        return Ok(match linked_to {
            Some(workspace_id) if restrict_to_claim.is_none() => {
                LinkOutcome::AlreadyLinked { workspace_id }
            }
            _ => LinkOutcome::NoClaim,
        });
    };
    // With a restricted claim, a second live claim for the same installation from another
    // workspace is the forged-id shape: refuse rather than guess.
    if claims.iter().any(|claim| claim.1 != claim_workspace) {
        return Ok(LinkOutcome::Ambiguous);
    }

    match linked_to {
        Some(workspace_id) if workspace_id == claim_workspace => {
            sqlx::query("UPDATE github_link_claim SET consumed_at = now() WHERE id = $1")
                .bind(claim_id)
                .execute(&mut *conn)
                .await?;
            return Ok(LinkOutcome::AlreadyLinked { workspace_id });
        }
        Some(_) => return Ok(LinkOutcome::LinkedElsewhere),
        None => {}
    }
    if removed {
        return Ok(LinkOutcome::NoInstallation);
    }

    let updated = sqlx::query(
        "UPDATE github_app_installation \
            SET workspace_id = $2, linked_at = now(), updated_at = now() \
          WHERE installation_id = $1 AND workspace_id IS NULL",
    )
    .bind(installation_id)
    .bind(claim_workspace)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if updated != 1 {
        return Ok(LinkOutcome::LinkedElsewhere);
    }
    sqlx::query("UPDATE github_link_claim SET consumed_at = now() WHERE id = $1")
        .bind(claim_id)
        .execute(&mut *conn)
        .await?;
    Ok(LinkOutcome::Linked {
        workspace_id: claim_workspace,
        member_id,
    })
}

/// Serialise the two signals of one installation's link. Both the setup-URL path and the signed
/// `installation.*` path take this first, so a simultaneous pair cannot each miss the other's
/// uncommitted half (T1 writes the claim while T2 writes the row, neither sees the other).
pub async fn lock_installation_link(
    conn: &mut PgConnection,
    installation_id: i64,
) -> Result<(), DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("github-install-link:{installation_id}"))
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Look a live install claim up by its state hash without changing it (needs `app.github_link`).
pub async fn peek_install_claim(
    conn: &mut PgConnection,
    hash: &[u8],
) -> Result<Option<PendingClaim>, DbError> {
    let row: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT id, member_id FROM github_link_claim \
          WHERE state_hash = $1 AND purpose = 'install' \
            AND consumed_at IS NULL AND expires_at > now()",
    )
    .bind(hash)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|(claim_id, member_id)| PendingClaim {
        claim_id,
        member_id,
    }))
}

/// What the signed-event path found, before anything is linked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkCandidate {
    NoInstallation,
    AlreadyLinked {
        workspace_id: Uuid,
    },
    /// Exactly one live claim names the installation. The caller must confirm, under that
    /// workspace's RLS scope, that the minter is **still** an owner/admin before completing.
    Candidate {
        claim_id: Uuid,
        workspace_id: Uuid,
        member_id: Uuid,
    },
    NoClaim,
    Ambiguous,
}

/// The read half of the signed-event link (needs `app.github_link`, and
/// [`lock_installation_link`] first).
pub async fn find_link_candidate(
    conn: &mut PgConnection,
    installation_id: i64,
) -> Result<LinkCandidate, DbError> {
    let installation: Option<(Option<Uuid>, bool)> = sqlx::query_as(
        "SELECT workspace_id, removed_at IS NOT NULL FROM github_app_installation \
          WHERE installation_id = $1",
    )
    .bind(installation_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((linked_to, removed)) = installation else {
        return Ok(LinkCandidate::NoInstallation);
    };
    if let Some(workspace_id) = linked_to {
        return Ok(LinkCandidate::AlreadyLinked { workspace_id });
    }
    if removed {
        return Ok(LinkCandidate::NoInstallation);
    }
    let claims: Vec<(Uuid, Uuid, Uuid)> = sqlx::query_as(
        "SELECT id, workspace_id, member_id FROM github_link_claim \
          WHERE installation_id = $1 AND purpose = 'install' \
            AND consumed_at IS NULL AND expires_at > now() \
          ORDER BY created_at LIMIT 3",
    )
    .bind(installation_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(match claims.as_slice() {
        [] => LinkCandidate::NoClaim,
        [(claim_id, workspace_id, member_id)] => LinkCandidate::Candidate {
            claim_id: *claim_id,
            workspace_id: *workspace_id,
            member_id: *member_id,
        },
        _ => LinkCandidate::Ambiguous,
    })
}

/// The write half: link the installation and spend the claim. `false` when the row was no longer
/// unlinked (someone else won).
pub async fn complete_link(
    conn: &mut PgConnection,
    installation_id: i64,
    claim_id: Uuid,
    workspace_id: Uuid,
) -> Result<bool, DbError> {
    let updated = sqlx::query(
        "UPDATE github_app_installation \
            SET workspace_id = $2, linked_at = now(), updated_at = now() \
          WHERE installation_id = $1 AND workspace_id IS NULL AND removed_at IS NULL",
    )
    .bind(installation_id)
    .bind(workspace_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    discard_claim(conn, claim_id).await?;
    Ok(updated == 1)
}

/// Spend a claim without linking (its minter is no longer an owner/admin).
pub async fn discard_claim(conn: &mut PgConnection, claim_id: Uuid) -> Result<(), DbError> {
    sqlx::query("UPDATE github_link_claim SET consumed_at = now() WHERE id = $1")
        .bind(claim_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The instance operator links an installation by hand (admin GUC). 409-shaped on a conflict.
pub async fn operator_link_installation(
    conn: &mut PgConnection,
    installation_id: i64,
    workspace_id: Uuid,
) -> Result<LinkOutcome, DbError> {
    let existing: Option<(Option<Uuid>, bool)> = sqlx::query_as(
        "SELECT workspace_id, removed_at IS NOT NULL FROM github_app_installation \
          WHERE installation_id = $1",
    )
    .bind(installation_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((linked_to, removed)) = existing else {
        return Ok(LinkOutcome::NoInstallation);
    };
    match linked_to {
        Some(current) if current == workspace_id => {
            return Ok(LinkOutcome::AlreadyLinked {
                workspace_id: current,
            })
        }
        Some(_) => return Ok(LinkOutcome::LinkedElsewhere),
        None => {}
    }
    if removed {
        return Ok(LinkOutcome::NoInstallation);
    }
    sqlx::query(
        "UPDATE github_app_installation \
            SET workspace_id = $2, linked_at = now(), updated_at = now() \
          WHERE installation_id = $1 AND workspace_id IS NULL",
    )
    .bind(installation_id)
    .bind(workspace_id)
    .execute(&mut *conn)
    .await?;
    // Any pending claim for it is spent: the operator has decided.
    sqlx::query(
        "UPDATE github_link_claim SET consumed_at = now() \
          WHERE installation_id = $1 AND purpose = 'install' AND consumed_at IS NULL",
    )
    .bind(installation_id)
    .execute(&mut *conn)
    .await?;
    Ok(LinkOutcome::Linked {
        workspace_id,
        member_id: Uuid::nil(),
    })
}

// ---------------------------------------------------------------------------
// the dedicated 「GitHub」 author
// ---------------------------------------------------------------------------

/// The workspace's non-login 「GitHub」 author, created on first use. `kind='agent'` because
/// `member_kind` has only two values and this is not a person; it gets no `agent` row, so nothing
/// in the run machinery can pick it up. Needs `app.workspace_id`.
pub async fn ensure_workspace_author(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Uuid, DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("github-author:{workspace_id}"))
        .execute(&mut *conn)
        .await?;
    if let Some(existing) = sqlx::query_scalar::<_, Uuid>(
        "SELECT author_member_id FROM github_workspace_author WHERE workspace_id = $1",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?
    {
        return Ok(existing);
    }
    let member_id = Uuid::new_v4();
    // `handle` is unique per workspace and a human may already hold `github`.
    let handle = {
        let taken: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM member WHERE workspace_id = $1 AND handle = 'github')",
        )
        .bind(workspace_id)
        .fetch_one(&mut *conn)
        .await?;
        if taken {
            format!("github-{}", member_id.simple())
        } else {
            "github".to_string()
        }
    };
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, 'agent', 'active', 'GitHub', $3)",
    )
    .bind(member_id)
    .bind(workspace_id)
    .bind(&handle)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO github_workspace_author (workspace_id, author_member_id) VALUES ($1, $2)",
    )
    .bind(workspace_id)
    .bind(member_id)
    .execute(&mut *conn)
    .await?;
    Ok(member_id)
}

pub async fn find_workspace_author(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Option<Uuid>, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT author_member_id FROM github_workspace_author WHERE workspace_id = $1",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Put the author in the channel so its messages are readable by the channel's members.
pub async fn ensure_author_in_channel(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    author_member_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member') \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(author_member_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// subscriptions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionRecord {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub installation_id: i64,
    pub repo_id: Option<i64>,
    pub repo_full_name: String,
    pub features: Vec<String>,
    pub active: bool,
    pub private_confirmed: bool,
    /// ADR-0205 H-1 (#4084): the channel is public now, the repository is (or may be) private and
    /// nobody confirmed that on a public channel. The receiver sends nothing until an owner/admin
    /// subscribes again with `confirmPrivate`.
    pub needs_reconfirm: bool,
}

/// Evaluated **now**, from the channel's current kind and the repository's current privacy, not
/// from what was true when the subscription was made: a subscription written on a private channel
/// carries no confirmation, and the channel can later become public. Unknown privacy counts as
/// private (the same stance as the subscribe route).
macro_rules! needs_reconfirm_sql {
    () => {
        "(github_channel_subscription.private_confirmed_at IS NULL \
          AND EXISTS (SELECT 1 FROM channel c \
                       WHERE c.id = github_channel_subscription.channel_id \
                         AND c.workspace_id = github_channel_subscription.workspace_id \
                         AND c.kind = 'public') \
          AND NOT EXISTS (SELECT 1 FROM github_installation_repository r \
                           WHERE r.installation_id = github_channel_subscription.installation_id \
                             AND NOT r.private \
                             AND (CASE WHEN github_channel_subscription.repo_id IS NOT NULL \
                                       THEN r.repo_id = github_channel_subscription.repo_id \
                                       ELSE lower(r.full_name) \
                                            = lower(github_channel_subscription.repo_full_name) \
                                  END)))"
    };
}

const SUBSCRIPTION_PROJECTION: &str = concat!(
    "github_channel_subscription.id, github_channel_subscription.channel_id, \
     github_channel_subscription.installation_id, github_channel_subscription.repo_id, \
     github_channel_subscription.repo_full_name, github_channel_subscription.features, \
     github_channel_subscription.active, \
     github_channel_subscription.private_confirmed_at IS NOT NULL AS private_confirmed, ",
    needs_reconfirm_sql!(),
    " AS needs_reconfirm"
);

const NEEDS_RECONFIRM_SQL: &str = needs_reconfirm_sql!();

fn decode_subscription(row: &sqlx::postgres::PgRow) -> Result<SubscriptionRecord, sqlx::Error> {
    Ok(SubscriptionRecord {
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        installation_id: row.try_get("installation_id")?,
        repo_id: row.try_get("repo_id")?,
        repo_full_name: row.try_get("repo_full_name")?,
        features: row.try_get("features")?,
        active: row.try_get("active")?,
        private_confirmed: row.try_get("private_confirmed")?,
        needs_reconfirm: row.try_get("needs_reconfirm")?,
    })
}

pub async fn list_subscriptions(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Option<Uuid>,
) -> Result<Vec<SubscriptionRecord>, DbError> {
    let rows = sqlx::query(&format!(
        "SELECT {SUBSCRIPTION_PROJECTION} FROM github_channel_subscription \
          WHERE workspace_id = $1 AND ($2::uuid IS NULL OR channel_id = $2) \
          ORDER BY created_at, id LIMIT 500"
    ))
    .bind(workspace_id)
    .bind(channel_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(decode_subscription)
        .collect::<Result<_, sqlx::Error>>()
        .map_err(DbError::from)
}

/// A channel's kind and archived state, for the subscribe checks.
pub async fn channel_kind(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
) -> Result<Option<String>, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT kind::text FROM channel \
          WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL",
    )
    .bind(channel_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?)
}

pub struct NewSubscription<'a> {
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub installation_id: i64,
    pub repo_id: Option<i64>,
    pub repo_full_name: &'a str,
    pub features: &'a [String],
    pub private_confirmed: bool,
    pub created_by: Uuid,
}

/// Insert, or re-open and re-feature the same `(channel, installation, repo)` subscription.
pub async fn upsert_subscription(
    conn: &mut PgConnection,
    new: &NewSubscription<'_>,
) -> Result<SubscriptionRecord, DbError> {
    let row = sqlx::query(&format!(
        "INSERT INTO github_channel_subscription \
           (workspace_id, channel_id, installation_id, repo_id, repo_full_name, features, \
            active, private_confirmed_at, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, true, \
                 CASE WHEN $7 THEN now() END, $8) \
         ON CONFLICT (channel_id, installation_id, repo_full_name) DO UPDATE SET \
           repo_id = COALESCE(EXCLUDED.repo_id, github_channel_subscription.repo_id), \
           features = EXCLUDED.features, \
           active = true, \
           private_confirmed_at = COALESCE(EXCLUDED.private_confirmed_at, \
                                           github_channel_subscription.private_confirmed_at), \
           updated_at = now() \
         RETURNING {SUBSCRIPTION_PROJECTION}"
    ))
    .bind(new.workspace_id)
    .bind(new.channel_id)
    .bind(new.installation_id)
    .bind(new.repo_id)
    .bind(new.repo_full_name)
    .bind(new.features)
    .bind(new.private_confirmed)
    .bind(new.created_by)
    .fetch_one(&mut *conn)
    .await?;
    Ok(decode_subscription(&row)?)
}

pub async fn delete_subscription(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    subscription_id: Uuid,
) -> Result<Option<SubscriptionRecord>, DbError> {
    let row = sqlx::query(&format!(
        "DELETE FROM github_channel_subscription \
          WHERE id = $1 AND workspace_id = $2 RETURNING {SUBSCRIPTION_PROJECTION}"
    ))
    .bind(subscription_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.as_ref().map(decode_subscription).transpose()?)
}

/// The active subscriptions an event may fan out to: same installation, same repository (by id
/// when the subscription has learned it, otherwise by case-insensitive name).
pub async fn matching_subscriptions(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    installation_id: i64,
    repo_id: Option<i64>,
    repo_full_name: &str,
) -> Result<Vec<SubscriptionRecord>, DbError> {
    let rows = sqlx::query(&format!(
        "SELECT {SUBSCRIPTION_PROJECTION} FROM github_channel_subscription \
          WHERE workspace_id = $1 AND installation_id = $2 AND active \
            AND ((repo_id IS NOT NULL AND repo_id = $3) \
                 OR (repo_id IS NULL AND lower(repo_full_name) = lower($4))) \
            AND EXISTS (SELECT 1 FROM channel c \
                         WHERE c.id = github_channel_subscription.channel_id \
                           AND c.workspace_id = $1 AND c.archived_at IS NULL) \
            AND NOT {NEEDS_RECONFIRM_SQL} \
          ORDER BY created_at, id"
    ))
    .bind(workspace_id)
    .bind(installation_id)
    .bind(repo_id)
    .bind(repo_full_name)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(decode_subscription)
        .collect::<Result<_, sqlx::Error>>()
        .map_err(DbError::from)
}

/// The first event of a repository tells a name-only subscription its `repo_id`.
pub async fn learn_subscription_repo_id(
    conn: &mut PgConnection,
    subscription_id: Uuid,
    repo_id: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE github_channel_subscription SET repo_id = $2, updated_at = now() \
          WHERE id = $1 AND repo_id IS NULL",
    )
    .bind(subscription_id)
    .bind(repo_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Flip subscriptions on or off by installation (`installation.deleted`), or by repository
/// (`installation_repositories` added / removed).
pub async fn set_installation_subscriptions_active(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    installation_id: i64,
    active: bool,
) -> Result<u64, DbError> {
    Ok(sqlx::query(
        "UPDATE github_channel_subscription SET active = $3, updated_at = now() \
          WHERE workspace_id = $1 AND installation_id = $2 AND active <> $3",
    )
    .bind(workspace_id)
    .bind(installation_id)
    .bind(active)
    .execute(&mut *conn)
    .await?
    .rows_affected())
}

pub async fn set_repository_subscriptions_active(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    installation_id: i64,
    repositories: &[RepositoryFacts],
    active: bool,
) -> Result<u64, DbError> {
    if repositories.is_empty() {
        return Ok(0);
    }
    let ids: Vec<i64> = repositories.iter().map(|repo| repo.id).collect();
    let names: Vec<String> = repositories
        .iter()
        .map(|repo| repo.full_name.to_lowercase())
        .collect();
    Ok(sqlx::query(
        "UPDATE github_channel_subscription SET active = $3, updated_at = now() \
          WHERE workspace_id = $1 AND installation_id = $2 AND active <> $3 \
            AND ((repo_id IS NOT NULL AND repo_id = ANY($4)) \
                 OR lower(repo_full_name) = ANY($5))",
    )
    .bind(workspace_id)
    .bind(installation_id)
    .bind(active)
    .bind(&ids)
    .bind(&names)
    .execute(&mut *conn)
    .await?
    .rows_affected())
}

// ---------------------------------------------------------------------------
// receipts
// ---------------------------------------------------------------------------

/// Record a delivery. `false` means this `(workspace, delivery)` was already recorded: the
/// receiver answers `duplicate: true` and writes nothing else (ADR-0205 D4).
pub async fn insert_receipt(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    delivery_id: &str,
    installation_id: i64,
    event: &str,
) -> Result<bool, DbError> {
    let inserted = sqlx::query(
        "INSERT INTO github_receipt (workspace_id, delivery_id, installation_id, event) \
         VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, delivery_id) DO NOTHING",
    )
    .bind(workspace_id)
    .bind(delivery_id)
    .bind(installation_id)
    .bind(event)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(inserted == 1)
}
