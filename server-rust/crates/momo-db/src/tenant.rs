//! Tenant-scoped transaction guards — the single wiring point for the RLS GUC.
//!
//! Invariant #6 (RLS FORCE) is enforced structurally: every tenant transaction
//! begins by running `SELECT set_config('app.workspace_id', $1, true)`. Because
//! `set_config(..., is_local => true)` is `SET LOCAL`, the binding is released
//! on commit/rollback — correct even under a transaction-mode pooler. Ports
//! Swift `DB/Database.swift`:
//!   * `withTenantTransaction`     :85-105  (base tenant guard, `set_config` :92)
//!   * `withProviderLinkTransaction`      :171-191 (`app.provider_link_admin`)
//!   * `withProviderQuotaIngestTransaction`:223-243 (`app.provider_quota_admin`)
//!
//! The closure receives the transaction's connection so a domain write and its
//! `momo_outbox::emit_outbox` call run in the *same* transaction (invariant #3).

use futures::future::BoxFuture;
use sqlx::{PgConnection, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::error::DbError;

tokio::task_local! {
    /// ADR-0217: server-authenticated agent, never a request argument.
    pub static REQUEST_AGENT_MEMBER: Uuid;
}

/// Set the tenant RLS GUC on an open transaction. `SET LOCAL` semantics via
/// `set_config(_, _, is_local => true)`, byte-for-byte the Swift statement so
/// the RLS policies behave identically.
async fn bind_workspace_guc(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(workspace_id.to_string())
        .execute(&mut **tx)
        .await?;
    let agent = REQUEST_AGENT_MEMBER
        .try_with(|id| id.to_string())
        .unwrap_or_default();
    sqlx::query("SELECT set_config('app.agent_member_id', $1, true)")
        .bind(agent)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Re-point an already-open tenant transaction at a **different** workspace.
///
/// This exists for exactly one caller — tenant provisioning (`POST /v1/workspaces`,
/// ADR-0117 §D1-A) — and the reason it lives here rather than in that caller is
/// invariant #6: `app.workspace_id` is set in this module and nowhere else, so a
/// grep for `set_config('app.workspace_id'` still returns this file alone.
///
/// The provisioning transaction genuinely needs two scopes in order: it
/// authorizes the operator under **their own** workspace (that read must pass
/// RLS), then seeds the new tenant's rows under the **new** workspace (those
/// writes must pass the same policies, because the seed is not exempt from
/// them). `SET LOCAL` semantics still apply, so the rebind unwinds with the
/// transaction.
///
/// It is deliberately not a general-purpose helper: any *other* use would be a
/// route reading one tenant and writing another inside one transaction, which is
/// the shape RLS exists to make impossible.
pub async fn rebind_tenant_guc(conn: &mut PgConnection, workspace_id: Uuid) -> Result<(), DbError> {
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(workspace_id.to_string())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Set an additional boolean GUC (`'on'`) on an open transaction. Used by the
/// operator-scoped variants below; callers MUST have verified the operator
/// scope BEFORE opening the transaction — the GUC is the last gate, not the
/// first (ADR-0004 증보 1 / ADR-0135 D2).
async fn bind_admin_guc(tx: &mut Transaction<'_, Postgres>, guc: &str) -> Result<(), DbError> {
    // `guc` is a compile-time constant supplied by this crate only (never user
    // input), so the literal interpolation cannot inject.
    let stmt = format!("SELECT set_config('{guc}', 'on', true)");
    sqlx::query(&stmt).execute(&mut **tx).await?;
    Ok(())
}

/// Run `body` inside a transaction with the tenant's RLS scope set.
///
/// This is the ONLY sanctioned way for a domain crate to open a tenant write:
/// it cannot obtain the GUC any other way, so a query that skips this guard is
/// filtered to zero rows by the DB policies (invariant #6 backstop).
pub async fn with_tenant_tx<T, F>(pool: &PgPool, workspace_id: Uuid, body: F) -> Result<T, DbError>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<T, DbError>> + Send,
{
    let mut tx = pool.begin().await?;
    bind_workspace_guc(&mut tx, workspace_id).await?;
    match body(&mut tx).await {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(err) => {
            // Best-effort rollback; surface the original closure error.
            let _ = tx.rollback().await;
            Err(err)
        }
    }
}

/// Run `body` inside a tenant transaction, with two caller-supplied preludes
/// sandwiching the RLS GUC.
///
/// Added for ADR-0140 D2 (B2.1). The T3 lifecycle ladder needs statements on
/// **both** sides of `set_config('app.workspace_id', …)`:
///
/// * `before_guc` — `pg_advisory_xact_lock` must be the transaction's *first*
///   statement, ahead of every row lock. It touches no RLS table, so it does
///   not need the tenant scope, and the Swift prelude
///   (`Cloud/T3LifecycleLock.swift:17-27`) puts it first for exactly that
///   reason. This guard ports that order faithfully.
/// * `after_guc` — the coarse-to-fine row locks (`work_pool`,
///   `workspace_credit`, `work_cloud_host`). Every one of those tables is
///   `FORCE ROW LEVEL SECURITY`, so they must come after the GUC — and before
///   `body`, so that a domain closure can never take them out of order.
///
/// Routing this through `momo-db` rather than opening a second transaction
/// helper elsewhere is what preserves invariant #6: `bind_workspace_guc` stays
/// the one and only wiring point for `app.workspace_id` in the workspace.
///
/// Generic over the error type so a domain crate can classify PostgreSQL
/// failures (trigger rejections, constraint violations) into its own domain
/// errors instead of flattening them to [`DbError`]; `E: From<DbError>` keeps
/// the transaction plumbing's own failures representable.
pub async fn with_tenant_tx_prelude<T, E, P, Q, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    before_guc: P,
    after_guc: Q,
    body: F,
) -> Result<T, E>
where
    T: Send,
    E: From<DbError> + Send,
    P: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<(), E>> + Send,
    Q: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<(), E>> + Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<T, E>> + Send,
{
    let mut tx = pool.begin().await.map_err(DbError::from)?;
    if let Err(err) = before_guc(&mut tx).await {
        let _ = tx.rollback().await;
        return Err(err);
    }
    if let Err(err) = bind_workspace_guc(&mut tx, workspace_id).await {
        let _ = tx.rollback().await;
        return Err(E::from(err));
    }
    if let Err(err) = after_guc(&mut tx).await {
        let _ = tx.rollback().await;
        return Err(err);
    }
    match body(&mut tx).await {
        Ok(value) => {
            tx.commit().await.map_err(DbError::from)?;
            Ok(value)
        }
        Err(err) => {
            let _ = tx.rollback().await;
            Err(err)
        }
    }
}

/// Operator provider-link transaction (MOMO-572 / ADR-0004 증보 1). Binds both
/// `app.workspace_id` (for the operator's workspace-scoped audit write) and
/// `app.provider_link_admin` to unlock the GUC-gated `provider_link` policy.
pub async fn with_provider_link_admin_tx<T, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    body: F,
) -> Result<T, DbError>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<T, DbError>> + Send,
{
    let mut tx = pool.begin().await?;
    bind_workspace_guc(&mut tx, workspace_id).await?;
    bind_admin_guc(&mut tx, "app.provider_link_admin").await?;
    match body(&mut tx).await {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(err) => {
            let _ = tx.rollback().await;
            Err(err)
        }
    }
}

/// Operator GitHub App transaction (#3947 / ADR-0205 D1). Binds `app.workspace_id` (for the
/// operator's workspace-scoped audit write) and `app.github_app_admin` to unlock the GUC-gated
/// `github_app` singleton and the operator branch of `github_app_installation`.
///
/// Like `app.provider_link_admin`, the GUC is bound **only after** the route's instance-operator
/// gate (`PLATFORM_ADMIN_EMAILS`); an ordinary tenant transaction never carries it.
pub async fn with_github_app_admin_tx<T, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    body: F,
) -> Result<T, DbError>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<T, DbError>> + Send,
{
    let mut tx = pool.begin().await?;
    bind_workspace_guc(&mut tx, workspace_id).await?;
    bind_admin_guc(&mut tx, "app.github_app_admin").await?;
    match body(&mut tx).await {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(err) => {
            let _ = tx.rollback().await;
            Err(err)
        }
    }
}

/// Which GitHub GUC(s) a [`with_github_tx`] transaction turns on (#3954 / ADR-0205 D3·D4).
///
/// * [`GithubGuc::Ingress`] (`app.github_ingress`) — read the sealed webhook secret, read and
///   write the instance-global installation routing table. Held ONLY by the receiver, and only
///   so it can verify the `X-Hub-Signature-256`: the receiver writes nothing until the signature
///   has passed.
/// * [`GithubGuc::Link`] (`app.github_link`) — the narrow "two signals meet" privilege: read and
///   update the pending `install` claims and the installation's link columns. It unlocks neither
///   `github_app` nor any other tenant table. The unauthenticated setup-URL route binds this one
///   alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GithubGuc {
    Ingress,
    Link,
}

impl GithubGuc {
    fn name(self) -> &'static str {
        match self {
            GithubGuc::Ingress => "app.github_ingress",
            GithubGuc::Link => "app.github_link",
        }
    }
}

/// What the resolve step of [`with_github_tx`] decided.
pub enum GithubScope<T> {
    /// The request is finished (a refusal, a `ping`): commit nothing more and return `T`.
    Done(T),
    /// Run the body with only the GitHub GUC(s): the installation is not linked to a workspace.
    Global,
    /// Run the body with the GitHub GUC(s) **and** this workspace's RLS scope.
    Tenant(Uuid),
}

/// A GitHub transaction whose workspace is only known after a global lookup.
///
/// The receiver cannot open a tenant transaction first: which workspace an event belongs to is
/// what the installation routing table says. So the transaction opens with the GitHub GUC(s)
/// only, `resolve` reads the routing table (and verifies the signature) and names the
/// workspace, and `body` then runs with that workspace's `app.workspace_id` also set — the
/// receipt, the subscription fan-out and the messages all pass the same tenant policies as any
/// other write. `set_config(.., true)` is `SET LOCAL`, so both bindings unwind with the
/// transaction.
///
/// `app.workspace_id` is still set only in this module (invariant #6).
pub async fn with_github_tx<T, E, R, F>(
    pool: &PgPool,
    gucs: &[GithubGuc],
    resolve: R,
    body: F,
) -> Result<T, E>
where
    T: Send,
    E: From<DbError> + Send,
    R: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<GithubScope<T>, E>> + Send,
    F: for<'c> FnOnce(&'c mut PgConnection, Option<Uuid>) -> BoxFuture<'c, Result<T, E>> + Send,
{
    let mut tx = pool.begin().await.map_err(DbError::from)?;
    for guc in gucs {
        if let Err(err) = bind_admin_guc(&mut tx, guc.name()).await {
            let _ = tx.rollback().await;
            return Err(E::from(err));
        }
    }
    let scope = match resolve(&mut tx).await {
        Ok(scope) => scope,
        Err(err) => {
            let _ = tx.rollback().await;
            return Err(err);
        }
    };
    let workspace = match scope {
        GithubScope::Done(value) => {
            tx.commit().await.map_err(DbError::from)?;
            return Ok(value);
        }
        GithubScope::Global => None,
        GithubScope::Tenant(workspace_id) => {
            if let Err(err) = bind_workspace_guc(&mut tx, workspace_id).await {
                let _ = tx.rollback().await;
                return Err(E::from(err));
            }
            Some(workspace_id)
        }
    };
    match body(&mut tx, workspace).await {
        Ok(value) => {
            tx.commit().await.map_err(DbError::from)?;
            Ok(value)
        }
        Err(err) => {
            let _ = tx.rollback().await;
            Err(err)
        }
    }
}

/// Provider quota-snapshot ingest transaction (MOMO-623 / ADR-0135 D2). Binds
/// `app.workspace_id` (ingesting agent's workspace) and `app.provider_quota_admin`
/// to unlock the write policy on the instance-global `quota_snapshot` table.
pub async fn with_provider_quota_ingest_tx<T, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    body: F,
) -> Result<T, DbError>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<T, DbError>> + Send,
{
    let mut tx = pool.begin().await?;
    bind_workspace_guc(&mut tx, workspace_id).await?;
    bind_admin_guc(&mut tx, "app.provider_quota_admin").await?;
    match body(&mut tx).await {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(err) => {
            let _ = tx.rollback().await;
            Err(err)
        }
    }
}
