//! ADR-0216 D2·D7 — 개발자 토큰의 **수명주기**: 90일 상한(R5 a·c), 멤버가 끝나면 함께 끝남(R9), 로그인
//! 계보의 회전·재사용 감지·유휴 만료(R10). 카드·계보는 도메인 함수(`issue_dev_card_in_tx`·
//! `issue_dev_login_in_tx`)로 발급하고, 실제 앱 라우터를 `momo_app`(NOBYPASSRLS) 풀 위에 띄워 HTTP 문
//! (`GET …/channels`)과 서버 래퍼(`momo_server::dev_access::rotate_dev_refresh`)로만 확인한다. 멤버를 바꾸는
//! 일(비밀번호 변경·재설정·정지·제거·탈퇴)도 실제 라우트로 일으킨다. 시간은 슈퍼유저가 시각 열을 **함께**
//! 앞당겨 흉내 낸다(CHECK는 UPDATE마다 다시 평가되므로 한 열만 옮기면 막힌다).
//!
//! | 시험 | 증명 | 빨개지면 |
//! |---|---|---|
//! | `the_database_refuses_a_developer_row_that_outlives_ninety_days` | `dev` 행을 `expires_at` NULL·`created_at+91일`·`+2160시간 1초`로 직접 INSERT하면 `token_dev_lifetime_ck`가 거절하고, 정확히 2160시간은 통과(양성). 로그인 두 반쪽도 NULL이면 같은 제약 | 90일 CHECK가 지워지거나 느슨해짐 |
//! | `the_database_refuses_a_lineage_row_that_outlives_its_cap` | 계보 행의 `expires_at`이 상한을 넘거나 상한 자체가 승인+90일을 넘으면 `token_dev_lineage_cap_ck`가 거절하고, 상한과 같은 만료는 통과(양성) | 계보 상한 CHECK가 사라짐 |
//! | `a_ninety_day_row_stays_valid_when_a_session_in_another_time_zone_updates_it` | 서머타임을 건너는 90일 행을 다른 TimeZone 세션이 폐기해도 CHECK에 안 걸린다 | 상한을 `interval '90 days'`(달력 계산)로 바꿈 |
//! | `a_rotation_near_the_cap_never_mints_past_it` | 승인 80일 뒤·90일−5분 뒤 회전: 새 refresh(·access)의 만료는 계보 상한에서 잘리고, 상한 자체는 승계(갱신 안 됨) | 회전이 `now()+30일`을 그대로 쓰거나 상한을 새로 잡음 |
//! | `a_refresh_after_the_ninety_day_cap_is_refused` | 승인 90일+1분 뒤의 refresh는 `Invalid`(경보·폐기 없음), 90일−10분 뒤의 것은 회전(양성) | 상한 뒤의 회전이 통과함 |
//! | `changing_the_password_ends_every_developer_token_of_the_member` | 비밀번호 변경: 카드·access는 다음 요청에서 401, refresh는 회전 안 됨, 같은 `revoked_at`(같은 tx), 다른 멤버의 토큰은 그대로 | 폐기 연쇄가 `kind='session'`만 잡음(D7 함정) |
//! | `an_operator_reset_ends_every_developer_token_of_the_member` | 운영자 재설정(claim 소비): 위와 같음 | 같음 |
//! | `suspending_a_member_ends_every_developer_token_and_reinstating_does_not_revive_them` | 정지: 위와 같고, 복직해도 옛 토큰은 401이고 새 카드는 200 | `revoke_member_tokens_in_tx`가 `dev` 행을 건너뜀 |
//! | `removing_a_member_ends_every_developer_token` | 제거: 위와 같음 | 같음 |
//! | `leaving_the_workspace_ends_every_developer_token` | 탈퇴: 위와 같음 | 같음 |
//! | `an_app_logout_leaves_the_developer_tokens_of_the_member_alone` | 앱 로그아웃은 앱 세션만 끝내고(401) 카드·계보(access·refresh 회전)는 그대로(D7: 로그아웃은 개발자 토큰을 끝내지 않는다) | 로그아웃이 멤버의 개발자 토큰까지 끝냄 |
//! | `a_rotation_hands_over_a_new_pair_of_the_same_lineage_and_ends_the_old_one` | 회전: 같은 계보의 새 쌍, 옛 access 401·새 access 200, 상한 승계 | 옛 access가 살아 있거나 계보가 바뀜 |
//! | `an_old_refresh_presented_again_ends_the_whole_lineage_and_raises_one_alert` | 옛 refresh 재사용: `ReuseDetected`·계보 전체(access·refresh) 폐기·감사 정확히 한 줄, 한 번 더 내도 새 줄 없음 | 재사용 감지·감사·`revoked > 0` 조건 중 하나가 빠짐 |
//! | `two_concurrent_refreshes_of_one_refresh_let_exactly_one_through` | 같은 refresh의 동시 두 갱신(5회): 정확히 하나만 `Rotated`, 다른 하나는 `ReuseDetected` | 직렬화가 풀려 둘 다 통과하거나 오류 |
//! | `a_refresh_idle_for_thirty_days_is_refused_and_one_idle_for_twenty_nine_is_not` | 유휴 31일은 `Invalid`, 29일은 회전하고 유휴 시계가 30일로 다시 맞춰짐 | 유휴 만료가 없거나 기간이 달라짐 |
//!
//! 교착(R9 마지막 줄)은 같은 모양의 기존 시험 곁인 `member_sweep_lock_order_pg.rs`에 있다.
//!
//! 격리 DB에서만:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test dev_token_lifecycle_conformance_pg -- --ignored --test-threads=1
//! ```

#[path = "common/apps_pg.rs"]
mod apps_pg;

use apps_pg::*;
use momo_auth::dev_token::{
    issue_dev_card_in_tx, issue_dev_login_in_tx, DevRotation, DevTool, IssuedDevCard,
    IssuedDevLogin, NewDevCard, NewDevLogin, DEV_READ_ONLY_SCOPES, FIXED_POLICY,
};
use momo_db::sqlx;
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_server::dev_access::rotate_dev_refresh;
use momo_server::AppState;
use serde_json::{json, Value};
use uuid::Uuid;

/// `auth.dev_token.refresh_reuse_detected` — restated on purpose: the audit vocabulary is a contract
/// (ADR-0216 D9), so a rename in the server is a red test here.
const ACTION_REUSE: &str = "auth.dev_token.refresh_reuse_detected";

const DAY_SECONDS: i64 = 24 * 60 * 60;

const HOLDER_PASSWORD: &str = "dalmuri-holder-password";
const CHANGED_PASSWORD: &str = "dalmuri-changed-password";
const RESET_PASSWORD: &str = "dalmuri-reset-password";

// ---------------------------------------------------------------------------
// the world: 달무리 스튜디오 — a workspace with an owner, the token holder and a bystander
// ---------------------------------------------------------------------------

struct World {
    su: PgPool,
    app: PgPool,
    state: AppState,
    http: reqwest::Client,
    base: String,
    workspace: Uuid,
    owner_jwt: String,
    holder: Uuid,
    holder_jwt: String,
    bystander: Uuid,
}

/// The holder and the bystander are both **admins**: `FIXED_POLICY` is `admins`, so a member would be
/// refused at the door and the positive controls below would prove nothing.
async fn world() -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone(), ServerOptions::default()).await;
    let workspace = seed_workspace(&su).await;
    let (owner, owner_jwt) = seed_human(&su, workspace, "owner", "박서연").await;
    let (holder, holder_jwt) = seed_human(&su, workspace, "admin", "이도현").await;
    let (bystander, _) = seed_human(&su, workspace, "admin", "최민수").await;
    // `seed_human` writes no password; the change route proves the current one.
    sqlx::query(
        "UPDATE human SET password_hash = momo_password_hash($3) \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace)
    .bind(holder)
    .bind(HOLDER_PASSWORD)
    .execute(&su)
    .await
    .expect("give the holder a password");
    seed_channel(&su, workspace, "public", &[owner, holder, bystander]).await;
    // `rotate_dev_refresh` only reads `state.pool`; the HTTP server above has its own state.
    let state = AppState::new(
        app.clone(),
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
    World {
        su,
        app,
        state,
        http: reqwest::Client::new(),
        base,
        workspace,
        owner_jwt,
        holder,
        holder_jwt,
        bystander,
    }
}

fn read_only_scopes() -> Vec<String> {
    DEV_READ_ONLY_SCOPES
        .iter()
        .map(|scope| (*scope).to_string())
        .collect()
}

impl World {
    async fn issue_card(&self, member: Uuid, label: &str) -> IssuedDevCard {
        let workspace = self.workspace;
        let label = label.to_string();
        with_tenant_tx(&self.app, workspace, move |conn| {
            Box::pin(async move {
                issue_dev_card_in_tx(
                    conn,
                    workspace,
                    member,
                    &NewDevCard {
                        label,
                        tool: DevTool::Cli,
                        scopes: read_only_scopes(),
                        channel_ids: None,
                        expires_in_days: 30,
                    },
                    FIXED_POLICY,
                )
                .await
                .map_err(DbError::from)
            })
        })
        .await
        .expect("tenant transaction")
        .expect("the card is issued")
    }

    async fn issue_login(&self, member: Uuid) -> IssuedDevLogin {
        let workspace = self.workspace;
        with_tenant_tx(&self.app, workspace, move |conn| {
            Box::pin(async move {
                issue_dev_login_in_tx(
                    conn,
                    workspace,
                    member,
                    &NewDevLogin {
                        label: "oort CLI · 노트북".to_string(),
                        tool: DevTool::Cli,
                        client: "oort-cli/0.1.0".to_string(),
                        device_name: Some("노트북".to_string()),
                        scopes: read_only_scopes(),
                        channel_ids: None,
                    },
                    FIXED_POLICY,
                )
                .await
                .map_err(DbError::from)
            })
        })
        .await
        .expect("tenant transaction")
        .expect("the login lineage is opened")
    }

    /// The developer door, through the one route every read-only token reaches (L3).
    async fn door(&self, token: &str) -> u16 {
        self.http
            .get(format!(
                "{}/v1/workspaces/{}/channels",
                self.base, self.workspace
            ))
            .bearer_auth(token)
            .send()
            .await
            .expect("GET channels")
            .status()
            .as_u16()
    }

    /// A route only a person's app session reaches (the roster), for the session JWT's own status.
    async fn app_session(&self, jwt: &str) -> u16 {
        self.http
            .get(format!(
                "{}/v1/workspaces/{}/roster",
                self.base, self.workspace
            ))
            .bearer_auth(jwt)
            .send()
            .await
            .expect("GET roster")
            .status()
            .as_u16()
    }

    /// The server half of the refresh route (what #4700 will mount).
    async fn rotate(&self, raw_refresh: &str) -> DevRotation {
        rotate_dev_refresh(&self.state, self.workspace, raw_refresh)
            .await
            .expect("the rotation transaction")
    }

    async fn rotated(&self, raw_refresh: &str) -> IssuedDevLogin {
        match self.rotate(raw_refresh).await {
            DevRotation::Rotated(next) => next,
            other => panic!("a live refresh must rotate, got {other:?}"),
        }
    }

    /// Remove the workspace (and with it every row the test wrote) when the test went to its end, so a
    /// shared database does not pile up developer rows; a failed test leaves them for the post-mortem.
    async fn finish(self) {
        sqlx::query("DELETE FROM workspace WHERE id = $1")
            .bind(self.workspace)
            .execute(&self.su)
            .await
            .expect("clean up the workspace");
    }

    /// Live developer rows of one member (cards, access and refresh halves).
    async fn live_dev_rows(&self, member: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM token \
              WHERE workspace_id = $1 AND actor_member_id = $2 \
                AND kind = 'dev' AND revoked_at IS NULL",
        )
        .bind(self.workspace)
        .bind(member)
        .fetch_one(&self.su)
        .await
        .expect("count live developer rows")
    }

    /// `(live, total)` rows of one login lineage.
    async fn lineage_rows(&self, session: Uuid) -> (i64, i64) {
        sqlx::query_as(
            "SELECT count(*) FILTER (WHERE revoked_at IS NULL), count(*) FROM token \
              WHERE workspace_id = $1 AND session_id = $2 AND kind = 'dev'",
        )
        .bind(self.workspace)
        .bind(session)
        .fetch_one(&self.su)
        .await
        .expect("count lineage rows")
    }

    /// Every `refresh_reuse_detected` row of the workspace:
    /// `(actor, subject, target_type, target_id, schema, revoked_tokens)`.
    #[allow(clippy::type_complexity)]
    async fn reuse_alerts(
        &self,
    ) -> Vec<(
        Option<Uuid>,
        Option<Uuid>,
        Option<String>,
        Option<Uuid>,
        Option<String>,
        Option<String>,
    )> {
        sqlx::query_as(
            "SELECT actor_member_id, subject_member_id, target_type, target_id, \
                    detail->>'schema', detail->>'revoked_tokens' \
               FROM audit_log WHERE workspace_id = $1 AND action = $2 ORDER BY created_at, id",
        )
        .bind(self.workspace)
        .bind(ACTION_REUSE)
        .fetch_all(&self.su)
        .await
        .expect("read the reuse alerts")
    }

    /// The same rows, whole, as JSON (`to_jsonb(audit_log)`), for what the alert must not hold.
    async fn reuse_alert_rows(&self) -> Vec<Value> {
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT to_jsonb(a)::text FROM audit_log a \
              WHERE a.workspace_id = $1 AND a.action = $2 ORDER BY a.created_at, a.id",
        )
        .bind(self.workspace)
        .bind(ACTION_REUSE)
        .fetch_all(&self.su)
        .await
        .expect("read the reuse alert rows");
        rows.iter()
            .map(|text| serde_json::from_str(text).expect("an audit row is JSON"))
            .collect()
    }

    /// Pretend a login lineage was approved `seconds` ago: every time column of every row of the
    /// lineage moves together, so `token_dev_lifetime_ck` and `token_dev_lineage_cap_ck` (re-checked on
    /// UPDATE) still hold.
    async fn age_lineage(&self, session: Uuid, seconds: i64) {
        let moved = sqlx::query(
            "UPDATE token \
                SET created_at = created_at - make_interval(secs => $3), \
                    expires_at = expires_at - make_interval(secs => $3), \
                    last_used_at = last_used_at - make_interval(secs => $3), \
                    revoked_at = revoked_at - make_interval(secs => $3), \
                    dev_lineage_expires_at = dev_lineage_expires_at - make_interval(secs => $3) \
              WHERE workspace_id = $1 AND session_id = $2 AND kind = 'dev'",
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

    /// The refresh was last used just now: its idle clock (30 days) restarts, bounded by the cap as the
    /// real rotation bounds it. Without this, an aged lineage would be refused for idleness and the cap
    /// would not be what a test of the cap is looking at.
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

    /// `count(DISTINCT dev_lineage_expires_at)` over every row of a lineage — the cap is one value.
    async fn distinct_caps(&self, session: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT count(DISTINCT dev_lineage_expires_at) FROM token \
              WHERE workspace_id = $1 AND session_id = $2 AND kind = 'dev'",
        )
        .bind(self.workspace)
        .bind(session)
        .fetch_one(&self.su)
        .await
        .expect("count distinct caps")
    }
}

// ---------------------------------------------------------------------------
// R5 (a) — the database itself caps a developer row at 90 days
// ---------------------------------------------------------------------------

/// The constraint a failed statement named, or `None` when it failed for another reason.
fn violated_constraint(error: &sqlx::Error) -> Option<String> {
    match error {
        sqlx::Error::Database(database) => database.constraint().map(str::to_string),
        _ => None,
    }
}

/// A `dev` row written straight into `token` as the superuser (the shape the issuance functions
/// write, so only the lifetime columns under test can be what a CHECK objects to).
///
/// `expires` and `cap` are intervals **after `now()`**, in Postgres' own spelling, so the boundary is
/// computed by the database from the same `created_at` (`now()` is the transaction time, written
/// explicitly below). `cap` is the lineage's absolute end; `None` for a card.
async fn insert_dev_row(
    su: &PgPool,
    workspace: Uuid,
    member: Uuid,
    form: &str,
    expires: Option<&str>,
    cap: Option<&str>,
) -> Result<(), sqlx::Error> {
    let lineage = form != "card";
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                            created_at, expires_at, created_by, session_id, dev_form, dev_tool, \
                            dev_client, dev_lineage_expires_at) \
         VALUES ($1, 'dev', $2, digest($3::text, 'sha256'), ARRAY['dev:identity']::text[], \
                 'lifetime probe', now(), \
                 CASE WHEN $4::text IS NULL THEN NULL ELSE now() + ($4::text)::interval END, \
                 $2, $5, $6, 'cli', $7, \
                 CASE WHEN $8::text IS NULL THEN NULL ELSE now() + ($8::text)::interval END)",
    )
    .bind(workspace)
    .bind(member)
    .bind(Uuid::new_v4().to_string())
    .bind(expires)
    .bind(lineage.then(Uuid::new_v4))
    .bind(form)
    .bind(lineage.then_some("oort-cli/0.1.0"))
    .bind(cap)
    .execute(su)
    .await
    .map(|_| ())
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_database_refuses_a_developer_row_that_outlives_ninety_days() {
    let w = world().await;
    let lifetime = Some("token_dev_lifetime_ck".to_string());

    // Positive control first: exactly 90 days (2160 hours — the migration measures hours, not a
    // calendar) is a valid card.
    insert_dev_row(
        &w.su,
        w.workspace,
        w.holder,
        "card",
        Some("2160 hours"),
        None,
    )
    .await
    .expect("a card of exactly 2160 hours is valid");

    for (what, expires) in [
        ("no expiry at all", None),
        ("91 days", Some("91 days")),
        ("2160 hours and one second", Some("2160 hours 1 second")),
    ] {
        let error = insert_dev_row(&w.su, w.workspace, w.holder, "card", expires, None)
            .await
            .expect_err(&format!("a card with {what} must be refused"));
        assert_eq!(
            violated_constraint(&error),
            lifetime,
            "a card with {what}: the 90-day CHECK is the wall, got {error}"
        );
    }

    // The two halves of a login lineage are developer rows too: no expiry is refused by the same wall.
    for form in ["access", "refresh"] {
        let error = insert_dev_row(&w.su, w.workspace, w.holder, form, None, Some("2160 hours"))
            .await
            .expect_err(&format!("a {form} row without an expiry must be refused"));
        assert_eq!(
            violated_constraint(&error),
            lifetime,
            "a {form} row without an expiry: got {error}"
        );
    }

    // Nothing was written by the refusals: the one valid card is the holder's only developer row.
    assert_eq!(w.live_dev_rows(w.holder).await, 1);
    w.finish().await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_database_refuses_a_lineage_row_that_outlives_its_cap() {
    let w = world().await;
    let cap = Some("token_dev_lineage_cap_ck".to_string());

    // Positive control: a refresh that ends exactly at the lineage cap, the cap itself exactly at
    // approval + 90 days.
    insert_dev_row(
        &w.su,
        w.workspace,
        w.holder,
        "refresh",
        Some("2160 hours"),
        Some("2160 hours"),
    )
    .await
    .expect("a refresh ending at its cap is valid");

    // Past the cap (but well inside 90 days, so the lifetime CHECK is not what objects).
    for form in ["access", "refresh"] {
        let error = insert_dev_row(
            &w.su,
            w.workspace,
            w.holder,
            form,
            Some("31 days"),
            Some("30 days"),
        )
        .await
        .expect_err(&format!(
            "a {form} row past its lineage cap must be refused"
        ));
        assert_eq!(
            violated_constraint(&error),
            cap,
            "a {form} row past the cap: got {error}"
        );
    }

    // A cap further than approval + 90 days.
    let error = insert_dev_row(
        &w.su,
        w.workspace,
        w.holder,
        "refresh",
        Some("10 days"),
        Some("2160 hours 1 second"),
    )
    .await
    .expect_err("a lineage cap beyond approval + 90 days must be refused");
    assert_eq!(
        violated_constraint(&error),
        cap,
        "a cap beyond 90 days: got {error}"
    );

    assert_eq!(w.live_dev_rows(w.holder).await, 1);
    w.finish().await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_ninety_day_row_stays_valid_when_a_session_in_another_time_zone_updates_it() {
    let w = world().await;
    // Written across both the US and the EU spring-forward dates: 2026-01-01 00:00Z + 2160 h =
    // 2026-04-01 00:00Z. In America/New_York a calendar `+ interval '90 days'` is one hour short of
    // that (2026-03-31 23:00Z), so a CHECK written in days would refuse the next UPDATE.
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO token (workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                            created_at, expires_at, created_by, dev_form, dev_tool) \
         VALUES ($1, 'dev', $2, digest($3::text, 'sha256'), ARRAY['dev:identity']::text[], \
                 'zone probe', '2026-01-01 00:00:00+00'::timestamptz, \
                 '2026-01-01 00:00:00+00'::timestamptz + interval '2160 hours', $2, 'card', 'cli') \
         RETURNING id",
    )
    .bind(w.workspace)
    .bind(w.holder)
    .bind(Uuid::new_v4().to_string())
    .fetch_one(&w.su)
    .await
    .expect("a 2160-hour card across the spring-forward dates is valid");

    // The revocation of a card is an UPDATE, which re-evaluates every CHECK of the row.
    let mut tx = w.su.begin().await.expect("begin");
    sqlx::query("SET LOCAL TimeZone = 'America/New_York'")
        .execute(&mut *tx)
        .await
        .expect("another time zone");
    sqlx::query("UPDATE token SET revoked_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .expect("a revocation from a session in another time zone must not trip the 90-day CHECK");
    tx.commit().await.expect("commit");

    let revoked: bool =
        sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM token WHERE id = $1")
            .bind(id)
            .fetch_one(&w.su)
            .await
            .expect("read back");
    assert!(revoked, "the revocation was applied");
    w.finish().await;
}

// ---------------------------------------------------------------------------
// R5 (c) — a login lineage ends 90 days after approval, whatever the rotations do
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_rotation_near_the_cap_never_mints_past_it() {
    let w = world().await;

    // Ten days of the 90 are left. Without the cap, a rotation would reach 30 days from now.
    let login = w.issue_login(w.holder).await;
    let approved_ago = 80 * DAY_SECONDS;
    w.age_lineage(login.session_id, approved_ago).await;
    w.rearm_idle_clock(login.session_id).await;
    let cap_ms = login.lineage_expires_at_ms - approved_ago * 1000;

    let next = w.rotated(&login.refresh).await;
    assert_eq!(
        next.lineage_expires_at_ms, cap_ms,
        "the cap is carried over from the approval, never renewed by a rotation"
    );
    assert_eq!(
        next.refresh_expires_at_ms, cap_ms,
        "30 days from now is past the cap, so the new refresh ends at the cap"
    );
    assert!(
        next.access_expires_at_ms < cap_ms,
        "15 minutes is far from a cap ten days away: the access is not cut short"
    );
    assert_eq!(
        w.distinct_caps(login.session_id).await,
        1,
        "every row of the lineage carries the one cap"
    );

    // Five minutes of the 90 are left: now even the access (15 minutes) would pass the cap.
    let last_minutes = w.issue_login(w.holder).await;
    let approved_ago = 90 * DAY_SECONDS - 5 * 60;
    w.age_lineage(last_minutes.session_id, approved_ago).await;
    w.rearm_idle_clock(last_minutes.session_id).await;
    let cap_ms = last_minutes.lineage_expires_at_ms - approved_ago * 1000;

    let next = w.rotated(&last_minutes.refresh).await;
    assert_eq!(next.lineage_expires_at_ms, cap_ms);
    assert_eq!(
        next.refresh_expires_at_ms, cap_ms,
        "the refresh ends at the cap"
    );
    assert_eq!(
        next.access_expires_at_ms, cap_ms,
        "the access would have lived 15 minutes, but only five are left"
    );
    assert_eq!(w.distinct_caps(last_minutes.session_id).await, 1);
    // …and the cut-short pair is still a working pair for the minutes it has left.
    assert_eq!(w.door(&next.access).await, 200);
    w.finish().await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_refresh_after_the_ninety_day_cap_is_refused() {
    let w = world().await;

    // Positive control: ten minutes before the cap the same lineage still rotates.
    let before = w.issue_login(w.holder).await;
    w.age_lineage(before.session_id, 90 * DAY_SECONDS - 10 * 60)
        .await;
    w.rearm_idle_clock(before.session_id).await;
    w.rotated(&before.refresh).await;

    // A minute after the cap: not idle (its clock was just re-armed), but the lineage is over.
    let after = w.issue_login(w.holder).await;
    w.age_lineage(after.session_id, 90 * DAY_SECONDS + 60).await;
    w.rearm_idle_clock(after.session_id).await;
    assert_eq!(
        w.rotate(&after.refresh).await,
        DevRotation::Invalid,
        "a refresh cannot outlive the 90 days from approval"
    );

    // Refused, not alarmed: nothing about the lineage changed and no alert was raised.
    let (live, total) = w.lineage_rows(after.session_id).await;
    assert_eq!((live, total), (2, 2));
    assert!(w.reuse_alerts().await.is_empty());
    w.finish().await;
}

// ---------------------------------------------------------------------------
// R9 — what ends a member ends every developer token of that member, in the same transaction
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum Event {
    PasswordChange,
    PasswordReset,
    Suspend,
    Remove,
    Leave,
}

impl World {
    /// Make `event` happen to the holder through the real route (for a reset, the operator's issue and
    /// then the holder's claim, which is the request that applies it) and require the route's 200.
    async fn happen(&self, event: Event) {
        let workspace = self.workspace;
        let base = &self.base;
        let holder = self.holder;
        let request = match event {
            Event::PasswordChange => self
                .http
                .patch(format!(
                    "{base}/v1/workspaces/{workspace}/members/me/password"
                ))
                .bearer_auth(&self.holder_jwt)
                .json(&json!({
                    "currentPassword": HOLDER_PASSWORD,
                    "newPassword": CHANGED_PASSWORD,
                })),
            Event::PasswordReset => {
                let issued = self
                    .http
                    .post(format!(
                        "{base}/v1/workspaces/{workspace}/members/{holder}/password-reset"
                    ))
                    .bearer_auth(&self.owner_jwt)
                    .send()
                    .await
                    .expect("issue the reset token");
                assert_eq!(issued.status().as_u16(), 201, "the owner issues a reset");
                let body: Value = issued.json().await.expect("reset body");
                let token = body["token"].as_str().expect("reset token").to_string();
                self.http
                    .post(format!("{base}/v1/claim"))
                    .json(&json!({ "token": token, "password": RESET_PASSWORD }))
            }
            Event::Suspend => self
                .http
                .post(format!(
                    "{base}/v1/workspaces/{workspace}/members/{holder}/suspend"
                ))
                .bearer_auth(&self.owner_jwt),
            Event::Remove => self
                .http
                .delete(format!("{base}/v1/workspaces/{workspace}/members/{holder}"))
                .bearer_auth(&self.owner_jwt),
            Event::Leave => self
                .http
                .delete(format!("{base}/v1/workspaces/{workspace}/members/me"))
                .bearer_auth(&self.holder_jwt),
        };
        let response = request.send().await.expect("the member event");
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        assert_eq!(status, 200, "{event:?} must be accepted: {body}");
    }

    /// Live developer and session rows of a member, by id.
    async fn live_credential_ids(&self, member: Uuid) -> Vec<Uuid> {
        sqlx::query_scalar(
            "SELECT id FROM token \
              WHERE workspace_id = $1 AND actor_member_id = $2 \
                AND kind IN ('dev', 'session') AND revoked_at IS NULL ORDER BY id",
        )
        .bind(self.workspace)
        .bind(member)
        .fetch_all(&self.su)
        .await
        .expect("list live credentials")
    }

    /// `(distinct revoked_at, rows still live)` over `ids`.
    async fn revocation_of(&self, ids: &[Uuid]) -> (i64, i64) {
        sqlx::query_as(
            "SELECT count(DISTINCT revoked_at), count(*) FILTER (WHERE revoked_at IS NULL) \
               FROM token WHERE id = ANY($1)",
        )
        .bind(ids)
        .fetch_one(&self.su)
        .await
        .expect("read the revocation")
    }
}

/// The shape of every R9 case. The holder has a card and a login lineage; so has the bystander, whose
/// tokens must be untouched (the sweep is one member's, and the controls prove the door itself works at
/// the moment the holder's are refused).
async fn ending_a_member_ends_every_developer_token(event: Event) {
    let w = world().await;
    let card = w.issue_card(w.holder, "이도현의 터미널").await;
    let first_pair = w.issue_login(w.holder).await;
    let other_card = w.issue_card(w.bystander, "최민수의 터미널").await;
    let other_pair = w.issue_login(w.bystander).await;

    // Positive controls: everything is live at the door, and the refresh proves itself by rotating. The
    // pair that comes out of the rotation is the one that must die.
    assert_eq!(w.door(&card.secret).await, 200, "the holder's card is live");
    assert_eq!(
        w.door(&first_pair.access).await,
        200,
        "the holder's access is live"
    );
    assert_eq!(w.door(&other_card.secret).await, 200);
    assert_eq!(w.door(&other_pair.access).await, 200);
    let pair = w.rotated(&first_pair.refresh).await;
    assert_eq!(w.door(&pair.access).await, 200);
    assert_eq!(
        w.live_dev_rows(w.holder).await,
        3,
        "a card, an access and a refresh"
    );
    assert_eq!(w.live_dev_rows(w.bystander).await, 3);

    let before = w.live_credential_ids(w.holder).await;
    assert_eq!(
        before.len(),
        4,
        "the three developer rows and the holder's own session: {before:?}"
    );

    w.happen(event).await;

    // The very next request is refused — there is no window between the change and the end.
    assert_eq!(w.door(&card.secret).await, 401, "{event:?}: the card");
    assert_eq!(w.door(&pair.access).await, 401, "{event:?}: the access");
    // The refresh is recognised as spent, not merely as belonging to someone who is gone: it was
    // revoked, so the answer is `ReuseDetected` with nothing left to revoke (and so no alert).
    match w.rotate(&pair.refresh).await {
        DevRotation::ReuseDetected {
            session_id,
            member_id,
            revoked,
        } => {
            assert_eq!(session_id, pair.session_id);
            assert_eq!(member_id, w.holder);
            assert_eq!(
                revoked, 0,
                "{event:?}: nothing of the lineage was still live"
            );
        }
        other => panic!("{event:?}: the refresh must be a spent one, got {other:?}"),
    }
    assert!(
        w.reuse_alerts().await.is_empty(),
        "an already-ended lineage raises no alert"
    );

    // The rows themselves, which the door's own member checks could mask for suspend, remove and leave.
    assert_eq!(
        w.live_dev_rows(w.holder).await,
        0,
        "{event:?}: every developer row of the holder is revoked"
    );
    // The same transaction: one `revoked_at` for everything the change ended, developer rows and the
    // holder's own session alike (a sweep in a second transaction would stamp a second instant).
    let (instants, still_live) = w.revocation_of(&before).await;
    assert_eq!(still_live, 0, "{event:?}");
    assert_eq!(
        instants, 1,
        "{event:?}: the developer tokens ended in the same transaction as the session"
    );

    // Other people's tokens are not the holder's to lose.
    assert_eq!(w.door(&other_card.secret).await, 200, "{event:?}");
    assert_eq!(w.door(&other_pair.access).await, 200, "{event:?}");
    assert_eq!(w.live_dev_rows(w.bystander).await, 3, "{event:?}");

    if matches!(event, Event::PasswordChange | Event::PasswordReset) {
        // The member is still here and still an admin. A card made AFTER the change works: the change
        // ended what existed, it did not close the door on the member, so the refusals above are the
        // sweep's doing and not the door's.
        let fresh = w.issue_card(w.holder, "변경 뒤 새 카드").await;
        assert_eq!(w.door(&fresh.secret).await, 200, "{event:?}: a new card");
    }

    if matches!(event, Event::Suspend) {
        // Reinstating gives the member back, not the tokens.
        let response = w
            .http
            .post(format!(
                "{}/v1/workspaces/{}/members/{}/reinstate",
                w.base, w.workspace, w.holder
            ))
            .bearer_auth(&w.owner_jwt)
            .send()
            .await
            .expect("reinstate");
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(
            w.door(&card.secret).await,
            401,
            "a reinstated card stays dead"
        );
        assert_eq!(w.door(&pair.access).await, 401);
        let fresh = w.issue_card(w.holder, "복직 뒤 새 카드").await;
        assert_eq!(
            w.door(&fresh.secret).await,
            200,
            "the member is back: a new card works, so the old ones are refused for being revoked"
        );
    }
    w.finish().await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn changing_the_password_ends_every_developer_token_of_the_member() {
    ending_a_member_ends_every_developer_token(Event::PasswordChange).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_operator_reset_ends_every_developer_token_of_the_member() {
    ending_a_member_ends_every_developer_token(Event::PasswordReset).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn suspending_a_member_ends_every_developer_token_and_reinstating_does_not_revive_them() {
    ending_a_member_ends_every_developer_token(Event::Suspend).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn removing_a_member_ends_every_developer_token() {
    ending_a_member_ends_every_developer_token(Event::Remove).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn leaving_the_workspace_ends_every_developer_token() {
    ending_a_member_ends_every_developer_token(Event::Leave).await;
}

/// The other half of D7: the cascade is for what ends the MEMBER (or their password). An app logout ends
/// one app session, and a developer token is a credential of its own — like a personal access token —
/// that the person revokes where it is listed. A logout that swept the member's developer tokens would
/// pass every test above; this is the one that notices.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_app_logout_leaves_the_developer_tokens_of_the_member_alone() {
    let w = world().await;
    let card = w.issue_card(w.holder, "이도현의 터미널").await;
    let pair = w.issue_login(w.holder).await;

    // Controls: the app session and both developer credentials are live.
    assert_eq!(w.app_session(&w.holder_jwt).await, 200, "the app session");
    assert_eq!(w.door(&card.secret).await, 200, "the card");
    assert_eq!(w.door(&pair.access).await, 200, "the lineage's access");

    let response = w
        .http
        .post(format!("{}/v1/auth/logout", w.base))
        .bearer_auth(&w.holder_jwt)
        .send()
        .await
        .expect("logout");
    assert_eq!(response.status().as_u16(), 200);
    let body: Value = response.json().await.expect("logout body");
    assert_eq!(
        body["revokedAccess"],
        json!(true),
        "the logout did end the app session: {body}"
    );
    assert_eq!(
        w.app_session(&w.holder_jwt).await,
        401,
        "the app session is over"
    );

    // …and the developer credentials are untouched.
    assert_eq!(
        w.door(&card.secret).await,
        200,
        "the card survives a logout"
    );
    assert_eq!(w.door(&pair.access).await, 200, "so does the access");
    assert_eq!(w.live_dev_rows(w.holder).await, 3);
    w.rotated(&pair.refresh).await;
    w.finish().await;
}

// ---------------------------------------------------------------------------
// R10 — rotation, reuse detection, concurrent refreshes, idleness
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_rotation_hands_over_a_new_pair_of_the_same_lineage_and_ends_the_old_one() {
    let w = world().await;
    let login = w.issue_login(w.holder).await;
    assert_eq!(w.door(&login.access).await, 200, "the first access is live");

    let next = w.rotated(&login.refresh).await;
    assert_eq!(next.session_id, login.session_id, "the same lineage");
    assert_eq!(next.member_id, w.holder);
    assert_ne!(next.access, login.access);
    assert_ne!(next.refresh, login.refresh);
    assert_eq!(
        next.scopes, login.scopes,
        "the grant is carried over exactly"
    );
    assert_eq!(
        next.lineage_expires_at_ms, login.lineage_expires_at_ms,
        "the 90-day cap is the approval's, carried over"
    );

    assert_eq!(
        w.door(&login.access).await,
        401,
        "a rotation ends the old access with the old refresh"
    );
    assert_eq!(w.door(&next.access).await, 200, "the new access works");
    let (live, total) = w.lineage_rows(login.session_id).await;
    assert_eq!(
        (live, total),
        (2, 4),
        "two rows ended, and exactly one new access and one new refresh live"
    );
    w.finish().await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_old_refresh_presented_again_ends_the_whole_lineage_and_raises_one_alert() {
    let w = world().await;
    let login = w.issue_login(w.holder).await;
    let bystander_pair = w.issue_login(w.bystander).await;
    let next = w.rotated(&login.refresh).await;
    assert_eq!(w.door(&next.access).await, 200, "the new pair is live");
    assert!(
        w.reuse_alerts().await.is_empty(),
        "a normal rotation alerts nothing"
    );

    // Somebody presents the refresh that was already spent.
    match w.rotate(&login.refresh).await {
        DevRotation::ReuseDetected {
            session_id,
            member_id,
            revoked,
        } => {
            assert_eq!(session_id, login.session_id);
            assert_eq!(member_id, w.holder);
            assert_eq!(revoked, 2, "the new access and the new refresh");
        }
        other => panic!("a spent refresh is reuse, got {other:?}"),
    }
    assert_eq!(
        w.door(&next.access).await,
        401,
        "the lineage's live access ended"
    );
    assert!(
        !matches!(w.rotate(&next.refresh).await, DevRotation::Rotated(_)),
        "the lineage's live refresh ended"
    );
    assert_eq!(
        w.lineage_rows(login.session_id).await,
        (0, 4),
        "every row of the lineage is revoked"
    );
    assert_eq!(
        w.door(&bystander_pair.access).await,
        200,
        "another lineage is untouched"
    );

    // Exactly one alert, about the lineage and its owner, carrying counts and no secret.
    let alerts = w.reuse_alerts().await;
    assert_eq!(alerts.len(), 1, "one line: {alerts:?}");
    let (actor, subject, target_type, target_id, schema, revoked) = &alerts[0];
    assert_eq!(
        *actor, None,
        "the presenter is unknown, so nobody is the actor"
    );
    assert_eq!(
        *subject,
        Some(w.holder),
        "the lineage's owner is who it is about"
    );
    assert_eq!(target_type.as_deref(), Some("dev_lineage"));
    assert_eq!(*target_id, Some(login.session_id));
    assert_eq!(schema.as_deref(), Some("momo.dev_token.refresh_reuse.v1"));
    assert_eq!(revoked.as_deref(), Some("2"));

    // The row is a closed vocabulary — the lineage, its owner, a count — and holds nothing the presenter
    // sent: a spent refresh is, by definition, a leaked secret, and the alert must not become another
    // copy of it (nor of the pair it ended).
    let rows = w.reuse_alert_rows().await;
    assert_eq!(rows.len(), 1);
    let detail = rows[0]["detail"].as_object().expect("detail is an object");
    let mut keys: Vec<&str> = detail.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["revoked_tokens", "schema"]);
    let whole = rows[0].to_string();
    assert!(
        whole.contains(&login.session_id.to_string()),
        "control: the row does name the lineage"
    );
    for envelope in [&login.access, &login.refresh, &next.access, &next.refresh] {
        let secret = envelope.rsplit('.').next().expect("the secret part");
        assert_eq!(secret.len(), 43, "a minted secret");
        assert!(
            !whole.contains(secret),
            "the alert row carries no part of an envelope"
        );
    }
    assert!(!whole.contains("momo_dev"), "nor an envelope's prefix");

    // Presenting spent refreshes again is no new news: nothing is left to revoke, so no new line.
    for spent in [&login.refresh, &next.refresh] {
        match w.rotate(spent).await {
            DevRotation::ReuseDetected { revoked, .. } => assert_eq!(revoked, 0),
            other => panic!("an ended lineage's refresh stays spent, got {other:?}"),
        }
    }
    assert_eq!(
        w.reuse_alerts().await.len(),
        1,
        "re-presenting an already-ended lineage's refresh raises no new alert"
    );
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn two_concurrent_refreshes_of_one_refresh_let_exactly_one_through() {
    let w = world().await;
    for round in 0..5 {
        let login = w.issue_login(w.holder).await;
        let gate = std::sync::Arc::new(tokio::sync::Barrier::new(2));
        let mut racers = Vec::new();
        for _ in 0..2 {
            let state = w.state.clone();
            let gate = gate.clone();
            let refresh = login.refresh.clone();
            let workspace = w.workspace;
            racers.push(tokio::spawn(async move {
                gate.wait().await;
                rotate_dev_refresh(&state, workspace, &refresh).await
            }));
        }
        let mut rotated = Vec::new();
        let mut reuse = Vec::new();
        for racer in racers {
            match racer.await.expect("racer task") {
                Ok(DevRotation::Rotated(next)) => rotated.push(next),
                Ok(DevRotation::ReuseDetected { revoked, .. }) => reuse.push(revoked),
                other => panic!("round {round}: neither a rotation nor a reuse: {other:?}"),
            }
        }
        assert_eq!(
            (rotated.len(), reuse.len()),
            (1, 1),
            "round {round}: of two refreshes of one refresh exactly one is let through"
        );
        // The second is indistinguishable from a thief holding the spent refresh, so it ends the
        // lineage — the winner's fresh pair included (ADR-0216 D2; the CLI serialises its own
        // refreshes with a file lock for exactly this reason, D10).
        assert_eq!(
            reuse[0], 2,
            "round {round}: the winner's new pair was revoked"
        );
        assert_eq!(
            w.lineage_rows(login.session_id).await,
            (0, 4),
            "round {round}"
        );
        assert_eq!(
            w.door(&rotated[0].access).await,
            401,
            "round {round}: the winner's access ended with the lineage"
        );
    }
    assert_eq!(
        w.reuse_alerts().await.len(),
        5,
        "one alert per round, none more"
    );
    w.finish().await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_refresh_idle_for_thirty_days_is_refused_and_one_idle_for_twenty_nine_is_not() {
    let w = world().await;
    let recent = w.issue_login(w.holder).await;
    let stale = w.issue_login(w.holder).await;
    w.age_lineage(recent.session_id, 29 * DAY_SECONDS).await;
    w.age_lineage(stale.session_id, 31 * DAY_SECONDS).await;

    // Twenty-nine days unused: still a refresh, and the rotation re-arms the 30-day idle clock.
    let next = w.rotated(&recent.refresh).await;
    let now_ms: i64 = sqlx::query_scalar("SELECT (EXTRACT(EPOCH FROM now()) * 1000)::bigint")
        .fetch_one(&w.su)
        .await
        .expect("database clock");
    let thirty_days_ms = 30 * DAY_SECONDS * 1000;
    assert!(
        (next.refresh_expires_at_ms - (now_ms + thirty_days_ms)).abs() < 120_000,
        "the new refresh is idle-valid for 30 days from now: {} vs {}",
        next.refresh_expires_at_ms,
        now_ms + thirty_days_ms
    );
    assert_eq!(
        next.lineage_expires_at_ms,
        recent.lineage_expires_at_ms - 29 * DAY_SECONDS * 1000,
        "the cap is the approval's — 29 days spent — not renewed"
    );

    // Thirty-one days unused: refused, plainly (not a reuse alarm), and nothing was ended by asking.
    assert_eq!(
        w.rotate(&stale.refresh).await,
        DevRotation::Invalid,
        "a refresh unused for more than 30 days is over"
    );
    assert_eq!(w.lineage_rows(stale.session_id).await, (2, 2));
    assert!(w.reuse_alerts().await.is_empty());
    w.finish().await;
}
