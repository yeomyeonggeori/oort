//! #3172 / ADR-0196 D4·D6·D10 — the consolidation job (duplicate merge, decision-interval closing, decay,
//! source-death retirement, retention, proposal purge, forget → stale digests) against a real Postgres.
//!
//! `#[ignore]`d like its siblings; run against an isolated `pgvector/pgvector:0.8.5-pg18-trixie`
//! (container name `3172-pg`, removed with `docker rm -f -v` afterwards):
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-agent-worker --test memory_consolidate_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! The model is a recording mock (no network). It answers a judging prompt with one of the three words
//! the job asks for; the SQL functions and the worker's parsing are what is under test, not language
//! quality. Every guard has a `red_*` twin that redefines the SQL function without the guard **inside a
//! transaction that is rolled back** and shows the test failing without it (the RED lines are printed with
//! `--nocapture` and quoted in the PR).
//!
//! | test | what it pins |
//! |---|---|
//! | `duplicate_merge_unions_evidence_and_is_reversible` | merge, evidence union, `mem_event`, revert, no re-judging |
//! | `a_newer_contradicting_decision_closes_the_old_one` | `valid_to` closing, no `supersedes_id`, forget reopens |
//! | `human_made_items_only_get_proposals` | curated/confirmed are never auto-changed; accept applies |
//! | `decay_skips_what_a_person_made_and_re_observation_extends_it` | decay, `forget_after` extension |
//! | `dead_evidence_retires_items` | `source_deleted` / `source_edited` |
//! | `retention_deletes_old_retired_items_and_covered_windows` | D10 retention |
//! | `forgetting_makes_digests_stale_and_they_regenerate_without_the_fact` | forget → stale → no fact (echoing mock) |
//! | `dead_expired_and_forgotten_pending_proposals_are_purged` | #3210 carry-over |
//! | `the_token_cap_stops_judging_but_not_the_housekeeping` | shared daily cap + 80 % share |
//! | `nothing_is_consolidated_across_channels` | D6-1 |
//! | `the_job_runs_as_momo_memory_and_is_closed_to_everyone_else` | roles |
//! | `a_channel_runs_once_per_slot_and_a_second_worker_yields` | cadence, lease |
//! | `red_*` | sabotage of each guard |

#![allow(dead_code)]

include!("common/memory_harness.rs");

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use momo_agent::memory_cons as cons;
use serde_json::json;

include!("common/consolidate_helpers.rs");

// --- tests ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn duplicate_merge_unions_evidence_and_is_reversible() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let m1 = w.say("배포는 금요일 오후로 하죠").await;
    let m2 = w.say("네 금요일 오후 좋아요").await;
    let m3 = w.say("확정: 금요일 오후 배포").await;
    let a = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "extracted",
            "배포는 금요일 오후에 한다",
            ago(3),
            &[m1, m2],
        ),
    )
    .await;
    let b = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "extracted",
            "배포는 금요일 오후에 진행한다",
            ago(2),
            &[m2, m3],
        ),
    )
    .await;
    *w.provider.reply_fn.lock().unwrap() = Some(judge(vec![(
        "금요일 오후에 한다",
        "금요일 오후에 진행한다",
        "duplicate",
    )]));

    let stats = w.consolidate().await;
    assert_eq!(
        (stats.llm_calls, stats.pairs_judged, stats.merged),
        (1, 1, 1),
        "{stats:?}"
    );
    assert!(
        tokens_used_today(su, ws).await > 0,
        "judging is charged to the daily cap"
    );

    // Equal rank and evidence: the earlier record wins. The loser is folded, not deleted.
    let (win, lose) = (item(su, a).await.unwrap(), item(su, b).await.unwrap());
    assert_eq!(lose.merged_into, Some(a));
    assert_eq!(lose.retired_reason.as_deref(), Some("merged"));
    assert!(!win.retired);
    assert_eq!(win.source_count, 3);
    assert_eq!(
        evidence_ids(su, a).await,
        sorted(vec![m1, m2, m3]),
        "union of the evidence"
    );
    assert_eq!(
        evidence_ids(su, b).await,
        sorted(vec![m2, m3]),
        "the loser keeps its own"
    );
    let merged = events(su, b, "merged").await;
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].1["into"], json!(a.to_string()));
    assert_eq!(merged[0].1["added"], json!([m3.to_string()]));
    assert_eq!(events(su, a, "merged").await.len(), 1);

    // Reversible: the event carries what is needed.
    let event = merged[0].0;
    let kind = w
        .mem_call(move |conn| Box::pin(async move { cons::revert(conn, event).await }))
        .await
        .expect("revert");
    assert_eq!(kind, "merged");
    let (win, lose) = (item(su, a).await.unwrap(), item(su, b).await.unwrap());
    assert!(!lose.retired && lose.merged_into.is_none() && lose.retired_reason.is_none());
    assert_eq!(win.source_count, 2);
    assert_eq!(evidence_ids(su, a).await, sorted(vec![m1, m2]));
    assert_eq!(events(su, b, "reverted").await.len(), 1);
    // ... only once.
    let again = w
        .mem_call(move |conn| Box::pin(async move { cons::revert(conn, event).await }))
        .await;
    assert_eq!(sqlstate_of(again).await, "55000");

    // A person's undo outranks the machine: the pair is remembered as distinct and never asked again.
    let calls = w.provider.count();
    let stats = w.consolidate().await;
    assert_eq!(
        (stats.llm_calls, w.provider.count()),
        (0, calls),
        "{stats:?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn a_newer_contradicting_decision_closes_the_old_one() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let app = momo_app_pool().await;
    let m1 = w.say("API 서버는 Rust로 가자").await;
    let m2 = w.say("다시 생각해보니 Go로 바꾸자").await;
    let mut s1 = spec(
        "decision",
        "extracted",
        "API 서버는 Rust로 간다",
        ago(5),
        &[m1],
    );
    s1.subject = Some("API 서버 언어");
    let mut s2 = spec(
        "decision",
        "extracted",
        "API 서버는 Go로 바꾼다",
        ago(1),
        &[m2],
    );
    s2.subject = Some("API 서버 언어");
    let (old, new) = (
        put_item(su, ws, ch, s1).await,
        put_item(su, ws, ch, s2).await,
    );
    *w.provider.reply_fn.lock().unwrap() = Some(judge(vec![("Rust로", "Go로", "supersedes")]));

    let stats = w.consolidate().await;
    assert_eq!((stats.closed, stats.pairs_judged), (1, 1), "{stats:?}");
    let (o, n) = (item(su, old).await.unwrap(), item(su, new).await.unwrap());
    // Graphiti: the old decision's validity ends where the new one begins; nothing is deleted or retired.
    let new_from: DateTime<Utc> =
        sqlx::query_scalar("SELECT valid_from FROM mem_item WHERE id = $1")
            .bind(new)
            .fetch_one(su)
            .await
            .unwrap();
    assert_eq!(o.valid_to, Some(new_from));
    assert_eq!(o.closed_by, Some(new));
    assert!(!o.retired && o.retired_reason.is_none());
    assert!(n.valid_to.is_none() && !n.retired);
    // The closing never touches `supersedes_id` (forget walks that chain and would delete the old decision).
    assert!(o.supersedes.is_none() && n.supersedes.is_none());
    let closing = events(su, old, "superseded").await;
    assert_eq!(closing.len(), 1);
    assert_eq!(closing[0].1["reason"], json!("contradiction"));
    assert_eq!(closing[0].1["superseded_by"], json!(new.to_string()));

    // Forgetting the *new* decision reopens the old one instead of leaving it closed by nothing ...
    assert_eq!(forget_as(&app, ws, w.fx.human_b, new).await, Ok(1));
    let o = item(su, old).await.expect("the old decision survives");
    assert!(o.valid_to.is_none() && o.closed_by.is_none(), "reopened");
    assert!(item(su, new).await.is_none());

    // ... and a closed decision can be forgotten on its own (it has no `supersedes` successor).
    let e1 = w.say("배포 도구는 A").await;
    let e2 = w.say("배포 도구는 B로 교체").await;
    let mut t1 = spec(
        "decision",
        "extracted",
        "배포 도구는 A를 쓴다",
        ago(4),
        &[e1],
    );
    t1.subject = Some("배포 도구");
    let mut t2 = spec(
        "decision",
        "extracted",
        "배포 도구는 B로 교체한다",
        ago(1),
        &[e2],
    );
    t2.subject = Some("배포 도구");
    let (old2, new2) = (
        put_item(su, ws, ch, t1).await,
        put_item(su, ws, ch, t2).await,
    );
    *w.provider.reply_fn.lock().unwrap() = Some(judge(vec![("A를", "B로", "supersedes")]));
    assert_eq!(w.consolidate().await.closed, 1);
    let closing = events(su, old2, "superseded").await;
    assert_eq!(
        forget_as(&app, ws, w.fx.human_b, old2).await,
        Ok(1),
        "the closed decision is forgettable"
    );
    assert!(item(su, old2).await.is_none() && item(su, new2).await.is_some());

    // Revert of a closing: re-open through the event.
    let (old3, _new3) = {
        let r1 = w.say("문서 도구는 X").await;
        let r2 = w.say("문서 도구는 Y로").await;
        let mut u1 = spec(
            "decision",
            "extracted",
            "문서 도구는 X를 쓴다",
            ago(4),
            &[r1],
        );
        u1.subject = Some("문서 도구");
        let mut u2 = spec(
            "decision",
            "extracted",
            "문서 도구는 Y로 바꾼다",
            ago(1),
            &[r2],
        );
        u2.subject = Some("문서 도구");
        (
            put_item(su, ws, ch, u1).await,
            put_item(su, ws, ch, u2).await,
        )
    };
    *w.provider.reply_fn.lock().unwrap() = Some(judge(vec![("X를", "Y로", "supersedes")]));
    assert_eq!(w.consolidate().await.closed, 1);
    let event = events(su, old3, "superseded").await[0].0;
    let kind = w
        .mem_call(move |conn| Box::pin(async move { cons::revert(conn, event).await }))
        .await
        .expect("revert closing");
    assert_eq!(kind, "superseded");
    let o = item(su, old3).await.unwrap();
    assert!(o.valid_to.is_none() && o.closed_by.is_none());
    let _ = closing;
}

// --- the human-made side ---------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn human_made_items_only_get_proposals() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let app = momo_app_pool().await;
    let m: Vec<Uuid> = {
        let mut v = Vec::new();
        for body in [
            "금요일 배포로 확정",
            "네 동의합니다",
            "다시 정리: 금요일",
            "DB는 Postgres",
            "DB를 MySQL로 바꿉니다",
            "장애 대응은 김철수",
        ] {
            v.push(w.say(body).await);
        }
        v
    };
    // Two human-made duplicates: the curated one wins, the confirmed one becomes a *proposal*.
    let confirmed = put_item(
        su,
        ws,
        ch,
        spec("fact", "confirmed", "배포는 금요일에 한다", ago(4), &[m[0]]),
    )
    .await;
    let curated = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "curated",
            "배포는 금요일에 진행한다",
            ago(3),
            &[m[1]],
        ),
    )
    .await;
    // A confirmed decision and a newer machine-made contradiction: a *proposal* to close, nothing closed.
    let mut d1 = spec(
        "decision",
        "confirmed",
        "DB는 Postgres를 쓴다",
        ago(6),
        &[m[3]],
    );
    d1.subject = Some("DB 종류");
    let mut d2 = spec(
        "decision",
        "extracted",
        "DB는 MySQL로 바꾼다",
        ago(1),
        &[m[4]],
    );
    d2.subject = Some("DB 종류");
    let (old_decision, new_decision) = (
        put_item(su, ws, ch, d1).await,
        put_item(su, ws, ch, d2).await,
    );
    // A machine-made duplicate of a confirmed item is folded into it, and the confirmed one is not touched.
    let dup = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "extracted",
            "장애 대응은 김철수가 맡는다",
            ago(2),
            &[m[5]],
        ),
    )
    .await;
    let owner = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "confirmed",
            "장애 대응은 김철수가 한다",
            ago(5),
            &[m[2]],
        ),
    )
    .await;
    *w.provider.reply_fn.lock().unwrap() = Some(judge(vec![
        ("금요일에 한다", "금요일에 진행한다", "duplicate"),
        ("Postgres", "MySQL", "supersedes"),
        ("김철수가 한다", "김철수가 맡는다", "duplicate"),
    ]));

    let stats = w.consolidate().await;
    assert_eq!(
        (stats.proposed, stats.merged, stats.closed),
        (2, 1, 0),
        "{stats:?}"
    );
    // Nothing a person made was changed.
    for id in [confirmed, curated, old_decision, owner] {
        let row = item(su, id).await.unwrap();
        assert!(
            !row.retired && row.valid_to.is_none() && row.merged_into.is_none(),
            "{id}"
        );
    }
    // The machine-made duplicate went into the confirmed item, whose evidence stayed as it was.
    let folded = item(su, dup).await.unwrap();
    assert_eq!(
        (folded.merged_into, folded.retired_reason.as_deref()),
        (Some(owner), Some("merged"))
    );
    assert_eq!(item(su, owner).await.unwrap().source_count, 1);
    assert_eq!(evidence_ids(su, owner).await, vec![m[2]]);

    let proposals: Vec<(Uuid, String, Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT id, op, target_item_id, other_item_id, status FROM mem_proposal WHERE channel_id = $1 ORDER BY op",
    )
    .bind(ch)
    .fetch_all(su)
    .await
    .unwrap();
    assert_eq!(proposals.len(), 2);
    let close = proposals
        .iter()
        .find(|p| p.1 == "close")
        .expect("close proposal");
    let merge = proposals
        .iter()
        .find(|p| p.1 == "merge")
        .expect("merge proposal");
    assert_eq!((close.2, close.3), (old_decision, new_decision));
    assert_eq!(
        (merge.2, merge.3),
        (confirmed, curated),
        "target = the one that would go, other = the one that stays"
    );
    assert!(proposals.iter().all(|p| p.4 == "pending"));

    // A second pass does not pile up more of them.
    assert_eq!(w.consolidate().await.proposed, 0);

    // M-7: through the API nobody can decide these yet (no card until #3174) — not even a channel member who
    // knows the id. The apply function behind it exists and carries its own checks; it is exercised below as its owner.
    assert_eq!(
        accept_as(&app, ws, w.fx.human_b, merge.0).await,
        Err("55000".to_string())
    );
    assert_eq!(
        accept_as(&app, ws, w.fx.human_b, close.0).await,
        Err("55000".to_string())
    );
    let accept_direct = |proposal: Uuid, viewer: Uuid| {
        let su = su.clone();
        async move {
            let mut tx = su.begin().await.unwrap();
            sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
                .bind(ws.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query("SET LOCAL ROLE mem_definer")
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query("SELECT mem_op('accept_proposal')")
                .execute(&mut *tx)
                .await
                .unwrap();
            let out = sqlx::query_scalar::<_, Uuid>("SELECT mem_cons_accept($1, $2)")
                .bind(proposal)
                .bind(viewer)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| mem::sqlstate(&momo_db::DbError::from(e)).unwrap_or_default());
            (tx, out)
        }
    };
    // A guest cannot decide; neither can someone outside the channel; a switched-off channel refuses.
    let guest = new_member(su, ws, "human", "게스트").await;
    sqlx::query("UPDATE workspace_membership SET role = 'guest' WHERE member_id = $1")
        .bind(guest)
        .execute(su)
        .await
        .unwrap();
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(ws)
        .bind(ch)
        .bind(guest)
        .execute(su)
        .await
        .unwrap();
    let outsider = new_member(su, ws, "human", "외부인").await;
    for (who, label) in [
        (guest, "guest"),
        (outsider, "outsider"),
        (w.fx.agent, "agent"),
    ] {
        let (tx, out) = accept_direct(merge.0, who).await;
        tx.rollback().await.unwrap();
        assert_eq!(out, Err("42501".to_string()), "{label}");
    }
    sqlx::query(
        "INSERT INTO mem_settings (workspace_id, scope, paused) VALUES ($1, 'workspace', true)",
    )
    .bind(ws)
    .execute(su)
    .await
    .unwrap();
    let (tx, out) = accept_direct(merge.0, w.fx.human_b).await;
    tx.rollback().await.unwrap();
    assert_eq!(
        out,
        Err("55000".to_string()),
        "a paused workspace decides nothing"
    );
    sqlx::query("DELETE FROM mem_settings WHERE workspace_id = $1")
        .bind(ws)
        .execute(su)
        .await
        .unwrap();

    // A member of the channel decides: the merge is applied and the proposal keeps no text.
    let (mut tx, out) = accept_direct(merge.0, w.fx.human_b).await;
    assert_eq!(out, Ok(curated));
    sqlx::query("RESET ROLE").execute(&mut *tx).await.unwrap();
    let gone: (Option<Uuid>, Option<String>) =
        sqlx::query_as("SELECT merged_into_id, retired_reason FROM mem_item WHERE id = $1")
            .bind(confirmed)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(gone, (Some(curated), Some("merged".to_string())));
    let body_left: Option<String> =
        sqlx::query_scalar("SELECT body FROM mem_proposal WHERE id = $1")
            .bind(merge.0)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert!(body_left.is_none(), "decided proposals keep no text");
    tx.commit().await.unwrap();
    let (mut tx, out) = accept_direct(close.0, w.fx.human_b).await;
    assert_eq!(out, Ok(new_decision));
    sqlx::query("RESET ROLE").execute(&mut *tx).await.unwrap();
    let closed: (Option<Uuid>, bool) =
        sqlx::query_as("SELECT closed_by_id, valid_to IS NOT NULL FROM mem_item WHERE id = $1")
            .bind(old_decision)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(closed, (Some(new_decision), true));
    tx.commit().await.unwrap();
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn red_a_confirmed_item_is_changed_without_the_two_walls() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let m1 = w.say("금요일 배포로 확정").await;
    let m2 = w.say("동의합니다").await;
    let a = put_item(
        su,
        ws,
        ch,
        spec("fact", "confirmed", "배포는 금요일에 한다", ago(4), &[m1]),
    )
    .await;
    let b = put_item(
        su,
        ws,
        ch,
        spec("fact", "curated", "배포는 금요일에 진행한다", ago(3), &[m2]),
    )
    .await;
    let sql = format!("SELECT mem_cons_apply('{a}', '{b}', 'duplicate')");

    // Shipped: a proposal, and the confirmed item is untouched.
    let mut tx = red_tx(su, ws, &[]).await;
    let outcome: String = sqlx::query_scalar(&sql).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(outcome, "proposed_merge");
    tx.rollback().await.unwrap();

    // Wall 1 (`mem_cons_apply` routes a protected loser to a proposal) removed: wall 2 in `mem_cons_merge_items` holds alone.
    let route = (
        "IF l.origin IN ('curated', 'confirmed') OR v_guest THEN",
        "IF false THEN",
    );
    let mut tx = red_tx(su, ws, &[(APPLY, &[route])]).await;
    let held = sqlx::query_scalar::<_, String>(&sql)
        .fetch_one(&mut *tx)
        .await;
    let held = held.map_err(|e| mem::sqlstate(&momo_db::DbError::from(e)));
    assert_eq!(held, Err(Some("23514".to_string())), "wall 2 alone refuses");
    tx.rollback().await.unwrap();

    // Both walls removed: the confirmed item is folded away automatically. This is what the walls prevent.
    let inner = (
        "IF l.origin IN ('curated', 'confirmed') AND p_proposal_id IS NULL THEN",
        "IF false THEN",
    );
    let mut tx = red_tx(su, ws, &[(APPLY, &[route]), (MERGE, &[inner])]).await;
    let outcome: String = sqlx::query_scalar(&sql).fetch_one(&mut *tx).await.unwrap();
    sqlx::query("RESET ROLE").execute(&mut *tx).await.unwrap();
    let retired: bool =
        sqlx::query_scalar("SELECT retired_at IS NOT NULL FROM mem_item WHERE id = $1")
            .bind(a)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    eprintln!("RED both walls removed: outcome={outcome} confirmed item retired={retired}");
    assert_eq!((outcome.as_str(), retired), ("merged", true));
    tx.rollback().await.unwrap();

    // The same for closing a confirmed decision.
    let d1 = put_item(
        su,
        ws,
        ch,
        spec(
            "decision",
            "confirmed",
            "DB는 Postgres를 쓴다",
            ago(6),
            &[m1],
        ),
    )
    .await;
    let d2 = put_item(
        su,
        ws,
        ch,
        spec(
            "decision",
            "extracted",
            "DB는 MySQL로 바꾼다",
            ago(1),
            &[m2],
        ),
    )
    .await;
    let sql = format!("SELECT mem_cons_apply('{d1}', '{d2}', 'supersedes')");
    let route = (
        "IF older.origin IN ('curated', 'confirmed') OR v_guest THEN",
        "IF false THEN",
    );
    let inner = (
        "IF o.origin IN ('curated', 'confirmed') AND p_proposal_id IS NULL THEN",
        "IF false THEN",
    );
    let mut tx = red_tx(su, ws, &[(APPLY, &[route])]).await;
    let held = sqlx::query_scalar::<_, String>(&sql)
        .fetch_one(&mut *tx)
        .await;
    assert_eq!(
        held.map_err(|e| mem::sqlstate(&momo_db::DbError::from(e))),
        Err(Some("23514".to_string()))
    );
    tx.rollback().await.unwrap();
    let mut tx = red_tx(su, ws, &[(APPLY, &[route]), (CLOSE, &[inner])]).await;
    let outcome: String = sqlx::query_scalar(&sql).fetch_one(&mut *tx).await.unwrap();
    sqlx::query("RESET ROLE").execute(&mut *tx).await.unwrap();
    let closed: bool =
        sqlx::query_scalar("SELECT valid_to IS NOT NULL FROM mem_item WHERE id = $1")
            .bind(d1)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    eprintln!("RED both walls removed: outcome={outcome} confirmed decision closed={closed}");
    assert_eq!((outcome.as_str(), closed), ("closed", true));
    tx.rollback().await.unwrap();
}

// --- decay ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn decay_skips_what_a_person_made_and_re_observation_extends_it() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let m = w.say("오늘은 임시 서버로 배포").await;
    let mut due = spec(
        "fact",
        "extracted",
        "오늘은 임시 서버로 배포한다",
        ago(20),
        &[m],
    );
    due.forget_after = Some(ago(1));
    let mut synth = spec(
        "fact",
        "synthesized",
        "이번 주는 야간 배포 금지",
        ago(20),
        &[m],
    );
    synth.forget_after = Some(ago(2));
    let mut later = spec("fact", "extracted", "이번 주 회의는 화요일", ago(2), &[m]);
    later.forget_after = Some(in_days(5));
    let mut confirmed = spec("fact", "confirmed", "확정된 사실 하나", ago(20), &[m]);
    confirmed.forget_after = Some(ago(1));
    let mut curated = spec("fact", "curated", "손으로 고친 사실 하나", ago(20), &[m]);
    curated.forget_after = Some(ago(1));
    let ids = [
        put_item(su, ws, ch, due).await,
        put_item(su, ws, ch, synth).await,
        put_item(su, ws, ch, later).await,
        put_item(su, ws, ch, confirmed).await,
        put_item(su, ws, ch, curated).await,
    ];
    let stats = w.consolidate().await;
    assert_eq!(stats.decayed, 2, "{stats:?}");
    let reasons: Vec<Option<String>> = {
        let mut out = Vec::new();
        for id in ids {
            out.push(item(su, id).await.unwrap().retired_reason);
        }
        out
    };
    assert_eq!(
        reasons,
        vec![
            Some("decayed".into()),
            Some("decayed".into()),
            None,
            None,
            None
        ],
        "only the machine-made, elapsed ones decay; a person's are never touched"
    );
    let ev = events(su, ids[0], "retired").await;
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].1["reason"], json!("decayed"));
    assert!(
        ev[0].1.get("body").is_none(),
        "the ledger holds ids and reasons, never text"
    );

    // Decay is reversible through its event; a revived item gets a fresh 14 days.
    let event = ev[0].0;
    w.mem_call(move |conn| Box::pin(async move { cons::revert(conn, event).await }))
        .await
        .expect("revert");
    let back = item(su, ids[0]).await.unwrap();
    assert!(!back.retired && back.forget_after.unwrap() > in_days(13));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn re_observation_extends_forget_after_and_a_regeneration_does_not() {
    let w = world().await;
    let (su, ws) = (&w.su, w.fx.ws);
    let text = "이번 주 배포는 임시 서버로 한다";
    // The mock answers every window with the same ephemeral item, citing the first human message it was shown.
    *w.provider.reply_fn.lock().unwrap() = Some(Arc::new(move |_n, prompt| {
        let first_seq: i64 = between(prompt, "<대화>\n[", "]")
            .trim()
            .parse()
            .unwrap_or(0);
        extraction_answer(
            "- 임시 서버 배포",
            vec![
                json!({"kind": "fact", "text": text, "evidence": [first_seq], "ephemeral": true, "confidence": 0.9}),
            ],
        )
    }));
    for body in ["임시 서버로 배포해요", "확인했습니다", "롤백 계획은 별도"] {
        w.say(body).await;
    }
    w.worker.summary_sweep().await;
    let id: Uuid = sqlx::query_scalar("SELECT id FROM mem_item WHERE workspace_id = $1")
        .bind(ws)
        .fetch_one(su)
        .await
        .expect("one item");
    let first = item(su, id).await.unwrap();
    assert_eq!(first.reinforce_count, 0);
    // Pretend a week went by.
    sqlx::query("UPDATE mem_item SET forget_after = now() + interval '1 hour' WHERE id = $1")
        .bind(id)
        .execute(su)
        .await
        .unwrap();

    // A regeneration of the same window (same evidence) is not a new observation.
    sqlx::query("UPDATE mem_digest SET stale = true WHERE channel_id = $1")
        .bind(w.fx.channel)
        .execute(su)
        .await
        .unwrap();
    w.worker.summary_state().forget_channels();
    w.worker.summary_sweep().await;
    let same = item(su, id).await.unwrap();
    assert_eq!(same.reinforce_count, 0, "same evidence: not re-observed");
    assert!(same.forget_after.unwrap() < in_days(1));

    // New messages say it again: reinforce_count + 1 and 14 more days.
    for body in [
        "오늘도 임시 서버를 쓴다",
        "네 그대로 갑니다",
        "내일까지 유지",
    ] {
        w.say(body).await;
    }
    w.worker.summary_state().forget_channels();
    w.worker.summary_sweep().await;
    let again = item(su, id).await.unwrap();
    assert_eq!(
        again.reinforce_count,
        1,
        "{again_count}",
        again_count = again.reinforce_count
    );
    assert!(
        again.forget_after.unwrap() > in_days(13),
        "extended to 14 days"
    );
    assert_eq!(events(su, id, "reinforced").await.len(), 1);
    let stats = w.consolidate().await;
    assert_eq!(stats.decayed, 0, "a re-observed item does not decay");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn red_decay_touches_a_confirmed_item_without_the_origin_guard() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let m = w.say("확정").await;
    let mut confirmed = spec("fact", "confirmed", "확정된 사실", ago(20), &[m]);
    confirmed.forget_after = Some(ago(1));
    let id = put_item(su, ws, ch, confirmed).await;
    let run = |edits: Vec<(&'static str, &'static str)>| {
        let su = su.clone();
        async move {
            let e: Vec<(&str, &[(&str, &str)])> = if edits.is_empty() {
                vec![]
            } else {
                vec![(DECAY, &edits[..])]
            };
            let mut tx = red_tx(&su, ws, &e).await;
            let n: i32 = sqlx::query_scalar("SELECT mem_cons_decay($1, 10)")
                .bind(ch)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            tx.rollback().await.unwrap();
            n
        }
    };
    assert_eq!(run(vec![]).await, 0, "shipped: nothing decays");
    let n = run(vec![(
        "AND i.origin IN ('extracted', 'synthesized')",
        "AND true",
    )])
    .await;
    eprintln!("RED origin guard removed: {n} item(s) decayed (a confirmed one)");
    assert_eq!(n, 1);
    let _ = id;
}

// --- dead evidence --------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn dead_evidence_retires_items() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let app = momo_app_pool().await;
    let (p1, p2, q1, r1, r2, s1, c1) = (
        w.say("삭제될 근거 하나").await,
        w.say("삭제될 근거 둘").await,
        w.say("나중에 고칠 문장").await,
        w.say("부분 삭제 하나").await,
        w.say("부분 삭제 둘").await,
        w.say("멀쩡한 근거").await,
        w.say("확정 항목의 근거").await,
    );
    let all_dead = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "extracted",
            "근거가 모두 지워진 사실",
            ago(3),
            &[p1, p2],
        ),
    )
    .await;
    let edited = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "근거가 고쳐진 사실", ago(3), &[q1]),
    )
    .await;
    let partial = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "extracted",
            "근거가 반만 남은 사실",
            ago(3),
            &[r1, r2],
        ),
    )
    .await;
    let healthy = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "멀쩡한 사실", ago(3), &[s1]),
    )
    .await;
    let confirmed = put_item(
        su,
        ws,
        ch,
        spec("decision", "confirmed", "확정한 결정", ago(3), &[c1]),
    )
    .await;
    let stale = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "다시 추출되며 죽은 행", ago(3), &[s1]),
    )
    .await;
    sqlx::query("UPDATE mem_item SET stale = true WHERE id = $1")
        .bind(stale)
        .execute(su)
        .await
        .unwrap();
    for gone in [p1, p2, r1, c1] {
        delete_msg(&app, ws, w.fx.human, gone).await;
    }
    edit_msg(&app, ws, w.fx.human, q1, "고친 문장입니다").await;

    let stats = w.consolidate().await;
    assert_eq!(stats.dead_retired, 5, "{stats:?}");
    let reason = |id| {
        let su = su.clone();
        async move { item(&su, id).await.unwrap().retired_reason }
    };
    assert_eq!(reason(all_dead).await.as_deref(), Some("source_deleted"));
    assert_eq!(reason(edited).await.as_deref(), Some("source_edited"));
    assert_eq!(
        reason(partial).await.as_deref(),
        Some("source_deleted"),
        "a claim that lost one of its sources is dead too"
    );
    assert_eq!(
        reason(confirmed).await.as_deref(),
        Some("source_deleted"),
        "hygiene applies to a person's items as well"
    );
    assert_eq!(reason(stale).await.as_deref(), Some("source_deleted"));
    assert_eq!(reason(healthy).await, None);
    let ev = events(su, all_dead, "retired").await;
    assert_eq!(ev[0].1["reason"], json!("source_deleted"));

    // RED: without the liveness test nothing retires.
    let m = w.say("또 다른 근거").await;
    let dead2 = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "또 죽을 사실", ago(3), &[m]),
    )
    .await;
    delete_msg(&app, ws, w.fx.human, m).await;
    let mut tx = red_tx(
        su,
        ws,
        &[(
            RETIRE,
            &[(
                "AND (i.stale OR NOT public.mem_item_live(i.id))",
                "AND i.stale",
            )],
        )],
    )
    .await;
    let n: i32 = sqlx::query_scalar("SELECT mem_cons_retire_dead($1, 10)")
        .bind(ch)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    eprintln!("RED liveness test removed: {n} dead item(s) retired");
    assert_eq!(n, 0);
    tx.rollback().await.unwrap();
    let mut tx = red_tx(su, ws, &[]).await;
    let n: i32 = sqlx::query_scalar("SELECT mem_cons_retire_dead($1, 10)")
        .bind(ch)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(n, 1);
    tx.rollback().await.unwrap();
    let _ = dead2;
}

// --- retention -----------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn put_digest(
    su: &PgPool,
    ws: Uuid,
    channel: Uuid,
    level: &str,
    from: i64,
    to: i64,
    thread: Option<Uuid>,
    stale: bool,
    age_days: i32,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO mem_digest (workspace_id, channel_id, thread_root_id, level, from_seq, to_seq, body, \
                                 source_count, prompt_version, stale, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, '요약 본문', 0, 'test', $7, now() - make_interval(days => $8)) RETURNING id",
    )
    .bind(ws)
    .bind(channel)
    .bind(thread)
    .bind(level)
    .bind(from)
    .bind(to)
    .bind(stale)
    .bind(age_days)
    .fetch_one(su)
    .await
    .expect("digest")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn retention_deletes_old_retired_items_and_covered_windows() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let m = w.say("보존 시험용 근거").await;
    let old = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "오래전에 내려간 사실", ago(200), &[m]),
    )
    .await;
    let recent = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "최근에 내려간 사실", ago(20), &[m]),
    )
    .await;
    let live = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "살아 있는 사실", ago(20), &[m]),
    )
    .await;
    sqlx::query("UPDATE mem_item SET retired_at = now() - interval '91 days', retired_reason = 'decayed' WHERE id = $1")
        .bind(old)
        .execute(su)
        .await
        .unwrap();
    sqlx::query("UPDATE mem_item SET retired_at = now() - interval '10 days', retired_reason = 'decayed' WHERE id = $1")
        .bind(recent)
        .execute(su)
        .await
        .unwrap();
    // Windows: old + covered (pruned) · old + not covered · recent + covered · old + covered only by a stale
    // rollup · an old thread digest (threads never roll up).
    let covered = put_digest(su, ws, ch, "window", 1, 10, None, false, 100).await;
    let uncovered = put_digest(su, ws, ch, "window", 21, 30, None, false, 100).await;
    let recent_w = put_digest(su, ws, ch, "window", 11, 20, None, false, 5).await;
    let stale_cover = put_digest(su, ws, ch, "window", 41, 50, None, false, 100).await;
    let day = put_digest(su, ws, ch, "day", 1, 20, None, false, 1).await;
    let _stale_day = put_digest(su, ws, ch, "day", 41, 60, None, true, 1).await;
    let root = w.say("스레드 뿌리").await;
    let thread = put_digest(su, ws, ch, "window", 61, 70, Some(root), false, 100).await;
    let _thread_day = put_digest(su, ws, ch, "day", 61, 80, None, false, 1).await;

    let stats = w.consolidate().await;
    assert_eq!(
        (stats.items_purged, stats.windows_pruned),
        (1, 1),
        "{stats:?}"
    );
    assert!(
        !exists(su, "mem_item", old).await,
        "retired for 91 days: permanently deleted"
    );
    assert_eq!(
        scalar_i64(
            su,
            "SELECT count(*) FROM mem_evidence WHERE item_id = $1",
            old
        )
        .await,
        0,
        "with its evidence links"
    );
    assert!(exists(su, "mem_item", recent).await && exists(su, "mem_item", live).await);
    assert!(
        !exists(su, "mem_digest", covered).await,
        "an old window that a rollup covers is pruned"
    );
    for kept in [uncovered, recent_w, stale_cover, day, thread] {
        assert!(exists(su, "mem_digest", kept).await, "{kept} stays");
    }
    // The ledger keeps ids and reasons only.
    let purged = events(su, old, "purged").await;
    assert_eq!(purged.len(), 1);
    assert_eq!(purged[0].1["reason"], json!("retention"));
    assert!(
        purged[0].1.to_string().find("사실").is_none(),
        "no text in the ledger"
    );
    assert_eq!(events(su, covered, "purged").await.len(), 1);

    // A retention of less than a day is a mistake, not a setting.
    let bad = w
        .mem_call(move |conn| Box::pin(async move { cons::retention(conn, ch, 0, 90, 10).await }))
        .await;
    assert_eq!(sqlstate_of(bad).await, "22023");

    // A paused workspace keeps its data (no decay, no retention) but still drops what lost its source.
    sqlx::query(
        "INSERT INTO mem_settings (workspace_id, scope, paused) VALUES ($1, 'workspace', true)",
    )
    .bind(ws)
    .execute(su)
    .await
    .unwrap();
    let old2 = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "extracted",
            "일시정지 중에도 남는 사실",
            ago(300),
            &[m],
        ),
    )
    .await;
    sqlx::query("UPDATE mem_item SET retired_at = now() - interval '200 days', retired_reason = 'decayed' WHERE id = $1")
        .bind(old2)
        .execute(su)
        .await
        .unwrap();
    let stats = w.consolidate().await;
    assert_eq!((stats.items_purged, stats.decayed), (0, 0), "{stats:?}");
    assert!(exists(su, "mem_item", old2).await);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn red_retention_without_its_guards() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let m = w.say("보존 시험용 근거").await;
    let recent = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "최근에 내려간 사실", ago(20), &[m]),
    )
    .await;
    sqlx::query("UPDATE mem_item SET retired_at = now() - interval '10 days', retired_reason = 'decayed' WHERE id = $1")
        .bind(recent)
        .execute(su)
        .await
        .unwrap();
    put_digest(su, ws, ch, "window", 21, 30, None, false, 100).await;
    let count = |edits: Vec<(&'static str, &'static str)>| {
        let su = su.clone();
        async move {
            let e: Vec<(&str, &[(&str, &str)])> = if edits.is_empty() {
                vec![]
            } else {
                vec![(RETENTION, &edits[..])]
            };
            let mut tx = red_tx(&su, ws, &e).await;
            let row = sqlx::query(
                "SELECT items_deleted, windows_pruned FROM mem_cons_retention($1, 90, 90, 100)",
            )
            .bind(ch)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            tx.rollback().await.unwrap();
            (
                row.get::<i32, _>("items_deleted"),
                row.get::<i32, _>("windows_pruned"),
            )
        }
    };
    assert_eq!(
        count(vec![]).await,
        (0, 0),
        "shipped: a 10-day-old retired item and an uncovered window stay"
    );
    let age = count(vec![(
        "AND i.retired_at < pg_catalog.now() - pg_catalog.make_interval(\n             days => p_retired_days * CASE WHEN i.origin IN ('curated', 'confirmed') THEN 4 ELSE 1 END)",
        "",
    )])
    .await;
    eprintln!("RED retirement age removed: {age:?} (items, windows) — a 10-day-old retired item is deleted");
    assert_eq!(age.0, 1);
    let cover = count(vec![(
        "AND EXISTS (SELECT 1 FROM public.mem_digest u",
        "AND NOT EXISTS (SELECT 1 FROM public.mem_digest u",
    )])
    .await;
    eprintln!("RED rollup cover inverted: {cover:?} — an uncovered window is deleted");
    assert_eq!(cover.1, 1);
}

// --- forgetting an item makes its digests stale ----------------------------------------

struct ForgetFlow {
    forgotten: usize,
    stale_after_forget: bool,
    suppressed_messages: i64,
    regen_prompt_has_fact: bool,
    regen_body_has_fact: bool,
    still_stale_after_regen: bool,
    items_after: i64,
    reextracted_from_the_regeneration: bool,
}

const FACT_MARKER: &str = "회식비는 오만원";

async fn forget_flow(w: &World) -> ForgetFlow {
    let (su, ws) = (&w.su, w.fx.ws);
    let app = momo_app_pool().await;
    *w.provider.reply_fn.lock().unwrap() =
        Some(echo_reply(FACT_MARKER, "회식비는 오만원으로 정했다"));
    w.say("이번 배포는 금요일 오후입니다").await;
    w.say(&format!("{FACT_MARKER}으로 정했습니다 참고하세요"))
        .await;
    w.say("그럼 그렇게 진행하겠습니다").await;
    w.worker.summary_sweep().await;
    let item_id: Uuid = sqlx::query_scalar("SELECT id FROM mem_item WHERE workspace_id = $1")
        .bind(ws)
        .fetch_one(su)
        .await
        .expect("the fact was extracted");
    let digest_body: String = sqlx::query_scalar(
        "SELECT body FROM mem_digest WHERE workspace_id = $1 AND level = 'window'",
    )
    .bind(ws)
    .fetch_one(su)
    .await
    .expect("digest");
    assert!(
        digest_body.contains(FACT_MARKER),
        "the first digest carries the fact"
    );

    let forgotten = forget_as(&app, ws, w.fx.human_b, item_id)
        .await
        .expect("forget") as usize;
    let stale_after_forget: bool =
        sqlx::query_scalar("SELECT bool_and(stale) FROM mem_digest WHERE workspace_id = $1")
            .bind(ws)
            .fetch_one(su)
            .await
            .unwrap();
    let suppressed_messages: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mem_suppress_msg WHERE workspace_id = $1")
            .bind(ws)
            .fetch_one(su)
            .await
            .unwrap();

    let before = w.provider.count();
    w.worker.summary_state().forget_channels();
    w.worker.summary_sweep().await;
    let regen_prompt_has_fact =
        (before..w.provider.count()).any(|i| w.provider.prompt(i).contains(FACT_MARKER));
    let bodies: Vec<String> =
        sqlx::query_scalar("SELECT body FROM mem_digest WHERE workspace_id = $1")
            .bind(ws)
            .fetch_all(su)
            .await
            .unwrap();
    let still_stale_after_regen: bool = sqlx::query_scalar(
        "SELECT COALESCE(bool_or(stale), false) FROM mem_digest WHERE workspace_id = $1",
    )
    .bind(ws)
    .fetch_one(su)
    .await
    .unwrap();
    let items_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mem_item WHERE workspace_id = $1")
            .bind(ws)
            .fetch_one(su)
            .await
            .unwrap();
    ForgetFlow {
        forgotten,
        stale_after_forget,
        suppressed_messages,
        regen_prompt_has_fact,
        regen_body_has_fact: bodies.iter().any(|b| b.contains(FACT_MARKER)),
        still_stale_after_regen,
        items_after,
        reextracted_from_the_regeneration: items_after > 0,
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn forgetting_makes_digests_stale_and_they_regenerate_without_the_fact() {
    let w = world().await;
    let flow = forget_flow(&w).await;
    assert_eq!(flow.forgotten, 1);
    assert!(
        flow.stale_after_forget,
        "the digests that cite the forgotten item's evidence are stale at once"
    );
    assert_eq!(
        flow.suppressed_messages, 1,
        "its evidence message is remembered (id only)"
    );
    assert!(
        !flow.regen_prompt_has_fact,
        "the regeneration is not shown the forgotten message"
    );
    assert!(
        !flow.regen_body_has_fact,
        "the regenerated digest no longer carries the fact"
    );
    assert!(!flow.still_stale_after_regen);
    assert_eq!(flow.items_after, 0, "and the fact is not extracted again");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn red_forgetting_without_the_suppression_or_the_stale_mark() {
    // 1. Without the input exclusion the regeneration echoes the fact straight back: the guard is load-bearing.
    let w = world().await;
    let original = sabotage_committed(
        &w.su,
        SUPPRESSED,
        &[("AND s.message_id = ANY (p_ids)", "AND false")],
    )
    .await;
    let flow = forget_flow(&w).await;
    restore(&w.su, original).await;
    eprintln!(
        "RED suppression removed: regeneration prompt has the fact = {}, regenerated body has the fact = {}, fact extracted again = {}",
        flow.regen_prompt_has_fact, flow.regen_body_has_fact, flow.reextracted_from_the_regeneration
    );
    assert!(flow.regen_prompt_has_fact && flow.regen_body_has_fact);

    // 2. Without the stale mark in `mem_forget_item` the digest keeps serving the fact — until the job's own
    //    reconcile step (the second net) marks it.
    let w = world().await;
    let original = sabotage_committed(
        &w.su,
        FORGET,
        &[(
            "UPDATE public.mem_digest d SET stale = true",
            "UPDATE public.mem_digest d SET stale = d.stale",
        )],
    )
    .await;
    let app = momo_app_pool().await;
    *w.provider.reply_fn.lock().unwrap() =
        Some(echo_reply(FACT_MARKER, "회식비는 오만원으로 정했다"));
    w.say("이번 배포는 금요일 오후입니다").await;
    w.say(&format!("{FACT_MARKER}으로 정했습니다")).await;
    w.say("그럼 그렇게 진행하겠습니다").await;
    w.worker.summary_sweep().await;
    let item_id: Uuid = sqlx::query_scalar("SELECT id FROM mem_item WHERE workspace_id = $1")
        .bind(w.fx.ws)
        .fetch_one(&w.su)
        .await
        .unwrap();
    forget_as(&app, w.fx.ws, w.fx.human_b, item_id)
        .await
        .expect("forget");
    let stale_now: bool =
        sqlx::query_scalar("SELECT bool_and(stale) FROM mem_digest WHERE workspace_id = $1")
            .bind(w.fx.ws)
            .fetch_one(&w.su)
            .await
            .unwrap();
    restore(&w.su, original).await;
    eprintln!("RED stale mark removed from mem_forget_item: digests stale right after the forget = {stale_now}");
    assert!(!stale_now);
    let stats = w.consolidate().await;
    assert_eq!(
        stats.digests_marked_stale, 1,
        "the job's reconcile catches it: {stats:?}"
    );
    let stale_later: bool =
        sqlx::query_scalar("SELECT bool_and(stale) FROM mem_digest WHERE workspace_id = $1")
            .bind(w.fx.ws)
            .fetch_one(&w.su)
            .await
            .unwrap();
    assert!(stale_later);
}

// --- pending proposals -----------------------------------------------------------------

async fn put_proposal(
    su: &PgPool,
    fx: &Fx,
    body: &str,
    evidence: &[Uuid],
    hash: &str,
    expires_at: DateTime<Utc>,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO mem_proposal (workspace_id, channel_id, agent_member_id, requester_member_id, kind, body, \
                                   evidence_message_ids, content_hash, expires_at) \
         VALUES ($1, $2, $3, $4, 'fact', $5, $6, $7, $8) RETURNING id",
    )
    .bind(fx.ws)
    .bind(fx.channel)
    .bind(fx.agent)
    .bind(fx.human)
    .bind(body)
    .bind(evidence)
    .bind(hash)
    .bind(expires_at)
    .fetch_one(su)
    .await
    .expect("proposal")
}

struct Proposals {
    expired: Uuid,
    evidence_gone: Uuid,
    suppressed: Uuid,
    healthy: Uuid,
}

async fn seed_proposals(w: &World) -> Proposals {
    let (su, fx) = (&w.su, &w.fx);
    let app = momo_app_pool().await;
    let (m1, m2, m3, m4) = (
        w.say("만료될 제안의 근거").await,
        w.say("지워질 제안의 근거").await,
        w.say("잊은 내용의 제안 근거").await,
        w.say("멀쩡한 제안의 근거").await,
    );
    let forgotten_hash = "aa".repeat(32);
    sqlx::query(
        "INSERT INTO mem_suppress (workspace_id, channel_id, content_hash) VALUES ($1, $2, $3)",
    )
    .bind(fx.ws)
    .bind(fx.channel)
    .bind(&forgotten_hash)
    .execute(su)
    .await
    .unwrap();
    let expired = put_proposal(
        su,
        fx,
        "만료된 제안의 본문",
        &[m1],
        &"01".repeat(32),
        ago(1),
    )
    .await;
    let evidence_gone = put_proposal(
        su,
        fx,
        "근거가 지워진 제안의 본문",
        &[m2],
        &"02".repeat(32),
        in_days(10),
    )
    .await;
    let suppressed = put_proposal(
        su,
        fx,
        "잊은 내용의 제안 본문",
        &[m3],
        &forgotten_hash,
        in_days(10),
    )
    .await;
    let healthy = put_proposal(
        su,
        fx,
        "멀쩡한 제안의 본문",
        &[m4],
        &"04".repeat(32),
        in_days(10),
    )
    .await;
    delete_msg(&app, fx.ws, fx.human, m2).await;
    Proposals {
        expired,
        evidence_gone,
        suppressed,
        healthy,
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn dead_expired_and_forgotten_pending_proposals_are_purged() {
    let w = world().await;
    let p = seed_proposals(&w).await;
    let stats = w.consolidate().await;
    assert_eq!(stats.proposals_purged, 3, "{stats:?}");
    for gone in [p.expired, p.evidence_gone, p.suppressed] {
        assert!(
            !exists(&w.su, "mem_proposal", gone).await,
            "{gone}: the row and its body are deleted"
        );
    }
    assert!(exists(&w.su, "mem_proposal", p.healthy).await);
    let reason = |id| {
        let su = w.su.clone();
        async move {
            let ev: (String, serde_json::Value) = sqlx::query_as(
                "SELECT action, detail FROM mem_event WHERE target_id = $1 AND target_kind = 'proposal'",
            )
            .bind(id)
            .fetch_one(&su)
            .await
            .expect("event");
            ev
        }
    };
    let e = reason(p.expired).await;
    assert_eq!(
        (e.0.as_str(), e.1["reason"].as_str()),
        ("expired", Some("expired"))
    );
    let e = reason(p.suppressed).await;
    assert_eq!(
        (e.0.as_str(), e.1["reason"].as_str()),
        ("purged", Some("suppressed"))
    );
    let e = reason(p.evidence_gone).await;
    assert_eq!(
        (e.0.as_str(), e.1["reason"].as_str()),
        ("purged", Some("evidence_gone"))
    );
    let text_left: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mem_event WHERE detail::text LIKE '%본문%'")
            .fetch_one(&w.su)
            .await
            .unwrap();
    assert_eq!(text_left, 0, "the ledger never holds the proposal text");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn red_each_purge_condition_is_load_bearing() {
    let w = world().await;
    let p = seed_proposals(&w).await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let remaining = |edits: Vec<(&'static str, &'static str)>| {
        let su = su.clone();
        async move {
            let e: Vec<(&str, &[(&str, &str)])> = if edits.is_empty() {
                vec![]
            } else {
                vec![(PURGE, &edits[..])]
            };
            let mut tx = red_tx(&su, ws, &e).await;
            sqlx::query("SELECT mem_cons_purge_proposals($1)")
                .bind(ch)
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query("RESET ROLE").execute(&mut *tx).await.unwrap();
            let ids: Vec<Uuid> =
                sqlx::query_scalar("SELECT id FROM mem_proposal WHERE channel_id = $1")
                    .bind(ch)
                    .fetch_all(&mut *tx)
                    .await
                    .unwrap();
            tx.rollback().await.unwrap();
            ids
        }
    };
    assert_eq!(remaining(vec![]).await, vec![p.healthy]);
    let no_expiry = remaining(vec![("WHERE p.workspace_id = v_ws AND p.channel_id = p_channel_id AND p.status = 'pending'\n       AND (p.expires_at <= pg_catalog.now()\n            OR EXISTS", "WHERE p.workspace_id = v_ws AND p.channel_id = p_channel_id AND p.status = 'pending'\n       AND (false\n            OR EXISTS")]).await;
    eprintln!(
        "RED expiry condition removed: the expired proposal survives = {}",
        no_expiry.contains(&p.expired)
    );
    assert!(no_expiry.contains(&p.expired));
    let no_evidence = remaining(vec![(
        "OR NOT public.mem_proposal_evidence_ok(p.id))",
        "OR false)",
    )])
    .await;
    eprintln!(
        "RED evidence condition removed: the proposal whose message was deleted survives = {}",
        no_evidence.contains(&p.evidence_gone)
    );
    assert!(no_evidence.contains(&p.evidence_gone));
    let no_suppress = remaining(vec![(
        "            OR EXISTS (SELECT 1 FROM public.mem_suppress s\n                        WHERE s.workspace_id = p.workspace_id AND s.channel_id = p.channel_id\n                          AND s.content_hash = p.content_hash)\n            OR NOT",
        "            OR NOT",
    )]).await;
    eprintln!(
        "RED forgotten-hash condition removed: the proposal of a forgotten fact survives = {}",
        no_suppress.contains(&p.suppressed)
    );
    assert!(no_suppress.contains(&p.suppressed));
}

// --- budget --------------------------------------------------------------------------

async fn pair_of_duplicates(w: &World, tag: &str, bodies: (&str, &str)) {
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let m1 = w.say(&format!("{tag} 근거 하나")).await;
    let m2 = w.say(&format!("{tag} 근거 둘")).await;
    put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", bodies.0, ago(3), &[m1]),
    )
    .await;
    put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", bodies.1, ago(2), &[m2]),
    )
    .await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn the_token_cap_stops_judging_but_not_the_housekeeping() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    *w.provider.reply_fn.lock().unwrap() = Some(judge(vec![("", "", "duplicate")]));
    pair_of_duplicates(
        &w,
        "하나",
        (
            "빌드 서버는 리눅스 러너를 쓴다",
            "빌드 서버는 리눅스 러너를 사용한다",
        ),
    )
    .await;
    // Housekeeping work that needs no tokens: a decayed item.
    let m = w.say("감쇠될 근거").await;
    let mut due = spec("fact", "extracted", "감쇠될 사실", ago(20), &[m]);
    due.forget_after = Some(ago(1));
    let due_id = put_item(su, ws, ch, due).await;

    // The workspace's own cap is 10 tokens: a judging call cannot be reserved.
    sqlx::query("INSERT INTO mem_settings (workspace_id, scope, daily_token_cap) VALUES ($1, 'workspace', 10)")
        .bind(ws)
        .execute(su)
        .await
        .unwrap();
    let stats = w.consolidate().await;
    assert_eq!(
        (stats.llm_calls, stats.cap_reached, w.provider.count()),
        (0, 1, 0),
        "{stats:?}"
    );
    assert_eq!(stats.decayed, 1, "the housekeeping ran anyway");
    assert_eq!(
        item(su, due_id).await.unwrap().retired_reason.as_deref(),
        Some("decayed")
    );
    assert_eq!(tokens_used_today(su, ws).await, 0, "nothing was reserved");
    assert_eq!(
        audit_count(su, ws, "mem.consolidate.token_cap_reached").await,
        1
    );
    // The run is not "done": it retries after the back-off, not at the next slot.
    let (last_run, retry): (Option<DateTime<Utc>>, Option<DateTime<Utc>>) =
        sqlx::query_as("SELECT last_run_at, retry_after FROM mem_cons_state WHERE channel_id = $1")
            .bind(ch)
            .fetch_one(su)
            .await
            .unwrap();
    assert!(last_run.is_none() && retry.unwrap() > Utc::now());
    assert_eq!(
        w.consolidate().await.not_due,
        1,
        "inside the back-off the channel is not due"
    );

    // A cap of 100k with 85k already used: consolidation's 80 % share is spent, the summaries' 100 % is not.
    sqlx::query("DELETE FROM mem_settings WHERE workspace_id = $1")
        .bind(ws)
        .execute(su)
        .await
        .unwrap();
    sqlx::query("UPDATE mem_cons_state SET retry_after = NULL WHERE channel_id = $1")
        .bind(ch)
        .execute(su)
        .await
        .unwrap();
    sqlx::query("INSERT INTO mem_settings (workspace_id, scope, daily_token_cap) VALUES ($1, 'workspace', 100000)")
        .bind(ws)
        .execute(su)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO mem_usage (workspace_id, day, tokens) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 85000) \
         ON CONFLICT (workspace_id, day) DO UPDATE SET tokens = 85000",
    )
    .bind(ws)
    .execute(su)
    .await
    .unwrap();
    let stats = w.consolidate().await;
    assert_eq!(
        (stats.llm_calls, stats.cap_reached),
        (0, 1),
        "share spent: {stats:?}"
    );
    // The summaries' own reservation still succeeds at 85 %.
    let reserved = w
        .mem_call(|conn| Box::pin(async move { mem::reserve_tokens(conn, 1_000, 300_000).await }))
        .await
        .unwrap();
    assert!(
        reserved,
        "the summaries keep their headroom above consolidation's share"
    );
    sqlx::query("UPDATE mem_cons_state SET retry_after = NULL WHERE channel_id = $1")
        .bind(ch)
        .execute(su)
        .await
        .unwrap();

    // Control: with the share at 100 % the same numbers let the call through (the share check is what stopped it),
    // and the call is charged to the same counter.
    let mut config = cons_config();
    config.memory.consolidate_token_share_percent = 100;
    let free = worker_with(&w.provider, config).await;
    let before = tokens_used_today(su, ws).await;
    let stats = free.consolidate_channel_now(ws, ch).await;
    assert_eq!((stats.llm_calls, stats.merged), (1, 1), "{stats:?}");
    assert!(
        tokens_used_today(su, ws).await > before,
        "judging is charged to the summaries' counter"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn a_channel_spends_at_most_its_call_budget() {
    let w = world().await;
    *w.provider.reply_fn.lock().unwrap() = Some(judge(vec![]));
    for (i, (a, b)) in [
        ("배포 창구는 슬랙이다", "배포 창구는 슬랙 채널이다"),
        ("회의록은 노션에 쓴다", "회의록은 노션에 적는다"),
        ("코드 리뷰는 두 명이 한다", "코드 리뷰는 두 사람이 한다"),
        (
            "장애 공지는 상태 페이지에",
            "장애 공지는 상태 페이지에 올린다",
        ),
    ]
    .iter()
    .enumerate()
    {
        pair_of_duplicates(&w, &format!("쌍{i}"), (a, b)).await;
    }
    let mut config = cons_config();
    config.memory.consolidate_max_calls = 2;
    let capped = worker_with(&w.provider, config).await;
    let stats = capped.consolidate_channel_now(w.fx.ws, w.fx.channel).await;
    assert_eq!((stats.llm_calls, w.provider.count()), (2, 2), "{stats:?}");
    assert_eq!(stats.distinct, 2);
}

// --- channels ------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn nothing_is_consolidated_across_channels() {
    let w = world().await;
    let (su, ws) = (&w.su, w.fx.ws);
    let other = new_channel(su, ws, "public", &[w.fx.human, w.fx.human_b, w.fx.agent]).await;
    let m1 = w.say("배포는 금요일 오후").await;
    let m2 = w.say_in(other, "배포는 금요일 오후").await;
    let a = put_item(
        su,
        ws,
        w.fx.channel,
        spec(
            "fact",
            "extracted",
            "배포는 금요일 오후에 한다",
            ago(3),
            &[m1],
        ),
    )
    .await;
    let b = put_item(
        su,
        ws,
        other,
        spec(
            "fact",
            "extracted",
            "배포는 금요일 오후에 한다",
            ago(2),
            &[m2],
        ),
    )
    .await;
    *w.provider.reply_fn.lock().unwrap() = Some(judge(vec![("", "", "duplicate")]));

    let one = w.worker.consolidate_channel_now(ws, w.fx.channel).await;
    let two = w.worker.consolidate_channel_now(ws, other).await;
    assert_eq!(
        (one.llm_calls, two.llm_calls, w.provider.count()),
        (0, 0, 0),
        "no pair exists inside a channel"
    );
    for id in [a, b] {
        assert!(!item(su, id).await.unwrap().retired);
    }
    // Asked directly, the database refuses the pair (and only the shipped guards do).
    let sql = format!("SELECT mem_cons_apply('{a}', '{b}', 'duplicate')");
    let mut tx = red_tx(su, ws, &[]).await;
    let refused = sqlx::query_scalar::<_, String>(&sql)
        .fetch_one(&mut *tx)
        .await;
    assert_eq!(
        refused.map_err(|e| mem::sqlstate(&momo_db::DbError::from(e))),
        Err(Some("23514".to_string()))
    );
    tx.rollback().await.unwrap();
    // Wall 1 (in `mem_cons_apply`) removed: wall 2 (`mem_cons_merge_items`) refuses alone.
    let wall1 = (
        "IF x.channel_id <> y.channel_id OR",
        "IF false AND x.channel_id <> y.channel_id OR",
    );
    let mut tx = red_tx(su, ws, &[(APPLY, &[wall1])]).await;
    let refused = sqlx::query_scalar::<_, String>(&sql)
        .fetch_one(&mut *tx)
        .await;
    assert_eq!(
        refused.map_err(|e| mem::sqlstate(&momo_db::DbError::from(e))),
        Err(Some("23514".to_string()))
    );
    tx.rollback().await.unwrap();
    // Both removed: the two channels' items are merged into one. This is what the walls prevent.
    let wall2 = (
        "IF l.id = w.id OR l.channel_id <> w.channel_id OR",
        "IF l.id = w.id OR",
    );
    let mut tx = red_tx(su, ws, &[(APPLY, &[wall1]), (MERGE, &[wall2])]).await;
    let outcome: String = sqlx::query_scalar(&sql).fetch_one(&mut *tx).await.unwrap();
    sqlx::query("RESET ROLE").execute(&mut *tx).await.unwrap();
    let merged_across: bool = sqlx::query_scalar("SELECT i.channel_id <> w.channel_id FROM mem_item i JOIN mem_item w ON w.id = i.merged_into_id WHERE i.id = $1")
        .bind(b)
        .fetch_optional(&mut *tx)
        .await
        .unwrap()
        .unwrap_or(false);
    eprintln!("RED both cross-channel walls removed: outcome={outcome}, item merged into another channel's item = {merged_across}");
    assert!(merged_across);
    tx.rollback().await.unwrap();
}

// --- roles ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn the_job_runs_as_momo_memory_and_is_closed_to_everyone_else() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let app = momo_app_pool().await;
    let m1 = w.say("역할 시험 근거 하나").await;
    let m2 = w.say("역할 시험 근거 둘").await;
    let a = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "역할 시험 사실 하나", ago(3), &[m1]),
    )
    .await;
    let b = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "역할 시험 사실 둘", ago(2), &[m2]),
    )
    .await;

    let worker_only = vec![
        format!(
            "SELECT mem_cons_begin('{ch}', '{}', 60, now())",
            Uuid::new_v4()
        ),
        format!(
            "SELECT mem_cons_finish('{ch}', '{}', true, 60)",
            Uuid::new_v4()
        ),
        format!("SELECT mem_cons_retire_dead('{ch}', 10)"),
        format!("SELECT mem_cons_decay('{ch}', 10)"),
        format!("SELECT mem_cons_reconcile('{ch}')"),
        format!("SELECT mem_suppressed_messages('{ch}', '{{}}'::uuid[])"),
        format!("SELECT * FROM mem_cons_pairs('{ch}', 0.5, 0.2, 5)"),
        format!("SELECT mem_cons_apply('{a}', '{b}', 'distinct')"),
        format!("SELECT * FROM mem_cons_retention('{ch}', 90, 90, 10)"),
        format!("SELECT mem_cons_purge_proposals('{ch}')"),
        format!("SELECT mem_cons_revert('{}')", Uuid::new_v4()),
    ];
    let internal = vec![
        format!("SELECT mem_cons_merge_items('{a}', '{b}', NULL, NULL)"),
        format!("SELECT mem_cons_close_item('{a}', '{b}', NULL, NULL)"),
        format!("SELECT mem_cons_propose('merge', '{a}', '{b}')"),
        format!("SELECT mem_cons_note_pair('{a}', '{b}', 'distinct')"),
        format!(
            "SELECT mem_cons_accept('{}', '{}')",
            Uuid::new_v4(),
            w.fx.human
        ),
    ];
    let run = |pool: PgPool, sql: String| async move {
        with_tenant_tx(&pool, ws, move |conn| {
            Box::pin(async move { Ok(sqlx::query(&sql).fetch_all(&mut *conn).await.map(|_| ())?) })
        })
        .await
    };
    for sql in worker_only.iter().chain(internal.iter()) {
        // The API role and the plain worker connection (BYPASSRLS, but not momo_memory) cannot run any of them.
        assert_eq!(
            sqlstate_of(run(app.clone(), sql.clone()).await).await,
            "42501",
            "momo_app: {sql}"
        );
        assert_eq!(
            sqlstate_of(run(w.wp.clone(), sql.clone()).await).await,
            "42501",
            "momo_worker: {sql}"
        );
    }
    // momo_memory (the worker after SET LOCAL ROLE) runs the worker-only ones and not the internal ones.
    for sql in &worker_only {
        let outcome = w
            .mem_call({
                let sql = sql.clone();
                move |conn| {
                    Box::pin(async move {
                        Ok(sqlx::query(&sql).fetch_all(&mut *conn).await.map(|_| ())?)
                    })
                }
            })
            .await;
        assert_ne!(
            sqlstate_of(outcome).await,
            "42501",
            "momo_memory must run {sql}"
        );
    }
    for sql in &internal {
        let outcome = w
            .mem_call({
                let sql = sql.clone();
                move |conn| {
                    Box::pin(async move {
                        Ok(sqlx::query(&sql).fetch_all(&mut *conn).await.map(|_| ())?)
                    })
                }
            })
            .await;
        assert_eq!(
            sqlstate_of(outcome).await,
            "42501",
            "even momo_memory cannot run the internal {sql}"
        );
    }

    // Witness: the sweep's writes happen in a session of `momo_worker` that has done `SET ROLE momo_memory`.
    // (The probes above took a lease under a random token; start from a clean state row.)
    sqlx::query("DELETE FROM mem_cons_state WHERE channel_id = $1")
        .bind(ch)
        .execute(su)
        .await
        .unwrap();
    sqlx::query("DROP TABLE IF EXISTS cons_witness")
        .execute(su)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE cons_witness (session_name text, role_setting text)")
        .execute(su)
        .await
        .unwrap();
    sqlx::query("GRANT INSERT ON cons_witness TO PUBLIC")
        .execute(su)
        .await
        .unwrap();
    sqlx::query(
        "CREATE OR REPLACE FUNCTION cons_witness_fn() RETURNS trigger LANGUAGE plpgsql AS \
         $f$ BEGIN INSERT INTO cons_witness VALUES (session_user::text, current_setting('role')); RETURN NEW; END $f$",
    )
    .execute(su)
    .await
    .unwrap();
    sqlx::query("DROP TRIGGER IF EXISTS cons_witness_trg ON mem_cons_state")
        .execute(su)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER cons_witness_trg AFTER INSERT OR UPDATE ON mem_cons_state FOR EACH ROW EXECUTE FUNCTION cons_witness_fn()")
        .execute(su)
        .await
        .unwrap();
    let stats = w.consolidate().await;
    let seen: Vec<(String, String)> =
        sqlx::query_as("SELECT DISTINCT session_name, role_setting FROM cons_witness")
            .fetch_all(su)
            .await
            .unwrap();
    sqlx::query("DROP TRIGGER cons_witness_trg ON mem_cons_state")
        .execute(su)
        .await
        .unwrap();
    sqlx::query("DROP TABLE cons_witness")
        .execute(su)
        .await
        .unwrap();
    sqlx::query("DROP FUNCTION cons_witness_fn()")
        .execute(su)
        .await
        .unwrap();
    assert_eq!(stats.channels, 1, "{stats:?}");
    assert_eq!(
        seen,
        vec![("momo_worker".to_string(), "momo_memory".to_string())]
    );
}

// --- cadence -------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn a_channel_runs_once_per_slot_and_a_second_worker_yields() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let m = w.say("주기 시험 근거").await;
    let decayable = |body: &'static str| {
        let mut s = spec("fact", "extracted", body, ago(20), &[m]);
        s.forget_after = Some(ago(1));
        s
    };
    let first = put_item(su, ws, ch, decayable("첫째 감쇠 대상")).await;
    w.worker.consolidate_sweep().await;
    assert!(
        item(su, first).await.unwrap().retired,
        "the first sweep of the slot runs the channel"
    );

    // Same slot: nothing more happens, from memory or (after a restart) from the database.
    let second = put_item(su, ws, ch, decayable("둘째 감쇠 대상")).await;
    w.worker.consolidate_sweep().await;
    assert!(
        !item(su, second).await.unwrap().retired,
        "not again in the same slot"
    );
    w.worker.consolidate_state().forget_channels();
    w.worker.consolidate_sweep().await;
    assert!(
        !item(su, second).await.unwrap().retired,
        "a restarted worker asks the database, which says done"
    );

    // The next slot.
    sqlx::query(
        "UPDATE mem_cons_state SET last_run_at = now() - interval '2 days' WHERE channel_id = $1",
    )
    .bind(ch)
    .execute(su)
    .await
    .unwrap();
    w.worker.consolidate_state().forget_channels();
    w.worker.consolidate_sweep().await;
    assert!(
        item(su, second).await.unwrap().retired,
        "a new day, a new run"
    );

    // Another worker holds the lease: this one does not touch the channel.
    let third = put_item(su, ws, ch, decayable("셋째 감쇠 대상")).await;
    sqlx::query(
        "UPDATE mem_cons_state SET last_run_at = NULL, lease_token = gen_random_uuid(), \
                leased_until = now() + interval '5 minutes' WHERE channel_id = $1",
    )
    .bind(ch)
    .execute(su)
    .await
    .unwrap();
    let stats = w.consolidate().await;
    assert_eq!((stats.channels, stats.not_due), (0, 1), "{stats:?}");
    assert!(!item(su, third).await.unwrap().retired);

    // RED: without the lease test in `mem_cons_begin` both workers run the channel.
    let original = sabotage_committed(
        su,
        BEGIN_FN,
        &[(
            "AND (s.leased_until IS NULL OR s.leased_until <= pg_catalog.now() OR s.lease_token = p_lease_token)",
            "AND true",
        )],
    )
    .await;
    let stats = w.consolidate().await;
    restore(su, original).await;
    eprintln!("RED lease test removed: the channel ran although another worker held the lease: channels={} retired={}", stats.channels, item(su, third).await.unwrap().retired);
    assert_eq!(stats.channels, 1);
    assert!(item(su, third).await.unwrap().retired);
}

// --- carried-over follow-ups (#3200 L-7/L-8, #3209 L-2/L-3) -----------------------------------

/// Run `sql` as the API role with `member` as the reader; returns the first column of every row as a string.
async fn as_reader(app: &PgPool, ws: Uuid, member: Uuid, sql: &str) -> Vec<String> {
    let sql = sql.to_string();
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            momo_messaging::memory::bind_mem_reader_guc(conn, member).await?;
            let rows = sqlx::query(&sql).fetch_all(&mut *conn).await?;
            Ok(rows
                .iter()
                .map(|r| r.try_get::<String, _>(0).unwrap_or_default())
                .collect::<Vec<_>>())
        })
    })
    .await
    .expect("reader query")
}

const OLD_EVIDENCE_POLICY: &str = "DROP POLICY mem_evidence_sel ON mem_evidence; \
    CREATE POLICY mem_evidence_sel ON mem_evidence FOR SELECT \
    USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid AND mem_can_read_channel(channel_id))";

const OLD_EVENT_POLICY: &str = "DROP POLICY mem_event_sel ON mem_event; \
    CREATE POLICY mem_event_sel ON mem_event FOR SELECT \
    USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid AND target_kind = 'item' \
           AND CASE WHEN current_user = 'mem_definer' THEN false ELSE mem_item_evidence_ok(target_id) END)";

async fn as_reader_with(
    su: &PgPool,
    ws: Uuid,
    member: Uuid,
    ddl: Option<&str>,
    sql: &str,
) -> Vec<String> {
    let mut tx = su.begin().await.expect("begin");
    if let Some(ddl) = ddl {
        sqlx::raw_sql(ddl).execute(&mut *tx).await.expect("ddl");
    }
    sqlx::query(
        "SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)",
    )
    .bind(ws.to_string())
    .bind(member.to_string())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("SET LOCAL ROLE momo_app")
        .execute(&mut *tx)
        .await
        .unwrap();
    let rows = sqlx::query(sql)
        .fetch_all(&mut *tx)
        .await
        .expect("reader query");
    let out = rows
        .iter()
        .map(|r| r.try_get::<String, _>(0).unwrap_or_default())
        .collect();
    tx.rollback().await.unwrap();
    out
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn item_evidence_rows_follow_the_items_readability() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let app = momo_app_pool().await;
    let (m1, m2) = (
        w.say("보이는 항목의 근거").await,
        w.say("가려질 항목의 근거").await,
    );
    let shown = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "보이는 사실", ago(3), &[m1]),
    )
    .await;
    let hidden = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "가려질 사실", ago(3), &[m2]),
    )
    .await;
    delete_msg(&app, ws, w.fx.human, m2).await;
    let sql = format!("SELECT item_id::text FROM mem_evidence WHERE item_id IN ('{shown}', '{hidden}') ORDER BY 1");
    // A channel member reads the evidence link of the item they can read, and not that of the item hidden
    // by a deleted source (its message id would otherwise outlive the message it points at).
    let seen = as_reader(&app, ws, w.fx.human_b, &sql).await;
    assert_eq!(seen, vec![shown.to_string()]);
    // RED: the old policy showed every evidence row of a channel the reader belongs to.
    let old = as_reader_with(su, ws, w.fx.human_b, Some(OLD_EVIDENCE_POLICY), &sql).await;
    eprintln!(
        "RED old evidence policy: a reader sees {} evidence link(s), including the hidden item's",
        old.len()
    );
    assert_eq!(old.len(), 2);
    // A non-member sees neither (unchanged).
    let outsider = new_member(su, ws, "human", "외부인").await;
    assert!(as_reader(&app, ws, outsider, &sql).await.is_empty());
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn forgotten_items_leave_an_id_only_trace_channel_readers_can_see() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let app = momo_app_pool().await;
    let outsider = new_member(su, ws, "human", "외부인").await;
    let m = w.say("잊을 사실의 근거").await;
    let item_id = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "extracted",
            "잊을 사실은 비밀 문구를 담고 있다",
            ago(3),
            &[m],
        ),
    )
    .await;
    assert_eq!(forget_as(&app, ws, w.fx.human_b, item_id).await, Ok(1));
    assert!(item(su, item_id).await.is_none());

    let sql = format!(
        "SELECT detail::text FROM mem_event WHERE target_id = '{item_id}' AND action = 'forgotten'"
    );
    let seen = as_reader(&app, ws, w.fx.human, &sql).await;
    assert_eq!(
        seen.len(),
        1,
        "a channel reader still sees that something was forgotten"
    );
    let detail: serde_json::Value = serde_json::from_str(&seen[0]).unwrap();
    assert_eq!(
        detail["channel_id"],
        json!(ch.to_string()),
        "#3209 L-2: the channel id is in the detail"
    );
    assert!(!seen[0].contains("비밀 문구"), "ids only, never text");
    assert!(
        as_reader(&app, ws, outsider, &sql).await.is_empty(),
        "not to someone outside the channel"
    );
    // RED: the old rule needed the (now deleted) item to be readable.
    let old = as_reader_with(su, ws, w.fx.human, Some(OLD_EVENT_POLICY), &sql).await;
    eprintln!(
        "RED old event policy: the forgotten item's trace is visible to a channel member = {}",
        !old.is_empty()
    );
    assert!(old.is_empty());

    // A personal space's trace belongs to its owner alone.
    let dm = new_channel(su, ws, "dm", &[w.fx.human, w.fx.agent]).await;
    let dm_msg = w.say_in(dm, "개인 공간 사실의 근거").await;
    let personal = put_item(
        su,
        ws,
        dm,
        spec("fact", "extracted", "개인 공간의 사실", ago(3), &[dm_msg]),
    )
    .await;
    sqlx::query("UPDATE mem_item SET space_kind = 'personal', owner_member_id = $2 WHERE id = $1")
        .bind(personal)
        .bind(w.fx.human)
        .execute(su)
        .await
        .unwrap();
    assert_eq!(forget_as(&app, ws, w.fx.human, personal).await, Ok(1));
    let sql = format!(
        "SELECT action FROM mem_event WHERE target_id = '{personal}' AND action = 'forgotten'"
    );
    assert_eq!(
        as_reader(&app, ws, w.fx.human, &sql).await,
        vec!["forgotten".to_string()]
    );
    assert!(
        as_reader(&app, ws, w.fx.agent, &sql).await.is_empty(),
        "the DM's other member is not the owner"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn a_search_filter_narrows_before_the_top_n_cut() {
    let w = world().await;
    let (su, ws) = (&w.su, w.fx.ws);
    let other = new_channel(su, ws, "public", &[w.fx.human, w.fx.human_b, w.fx.agent]).await;
    let app = momo_app_pool().await;
    // Twelve items in #general match the query well; two in the other channel match a little less.
    for i in 0..12 {
        let m = w.say(&format!("배포창구 근거 {i}")).await;
        put_item(
            su,
            ws,
            w.fx.channel,
            spec(
                "fact",
                "extracted",
                &format!("배포창구는 슬랙 채널이다 {i}"),
                ago(3),
                &[m],
            ),
        )
        .await;
    }
    for i in 0..2 {
        let m = w.say_in(other, &format!("배포창구 다른 근거 {i}")).await;
        put_item(
            su,
            ws,
            other,
            spec(
                "decision",
                "extracted",
                &format!("다른 곳의 배포창구 정리 {i}"),
                ago(3),
                &[m],
            ),
        )
        .await;
    }
    let human = w.fx.human;
    let search = |channel: Option<Uuid>, kind: Option<&'static str>| {
        let app = app.clone();
        async move {
            with_tenant_tx(&app, ws, move |conn| {
                Box::pin(async move {
                    momo_messaging::memory::bind_mem_reader_guc(conn, human).await?;
                    momo_messaging::memory::search_item_rows_in_tx(
                        conn,
                        "배포창구",
                        channel,
                        kind,
                        Some(5),
                    )
                    .await
                })
            })
            .await
            .expect("search")
        }
    };
    assert_eq!(search(None, None).await.len(), 5);
    let narrowed = search(Some(other), None).await;
    assert_eq!(
        narrowed.len(),
        2,
        "both hits of the other channel, not the empty remainder of a general top-5"
    );
    assert!(narrowed.iter().all(|(item, _)| item.channel_id == other));
    let by_kind = search(None, Some("decision")).await;
    assert_eq!(by_kind.len(), 2);
    assert!(by_kind.iter().all(|(item, _)| item.kind == "decision"));

    // RED: without the in-scan predicate the filter cannot narrow.
    let mut tx = su.begin().await.unwrap();
    redefine(
        &mut tx,
        "public.mem_search_items_core(uuid, text, integer, uuid, boolean, uuid, text)",
        &[(
            "AND (p_channel_id IS NULL OR i.channel_id = p_channel_id)",
            "AND true",
        )],
    )
    .await;
    sqlx::query(
        "SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)",
    )
    .bind(ws.to_string())
    .bind(w.fx.human.to_string())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("SET LOCAL ROLE momo_app")
        .execute(&mut *tx)
        .await
        .unwrap();
    let wrong: Vec<Uuid> =
        sqlx::query_scalar("SELECT channel_id FROM mem_search_items('배포창구', 5, $1, NULL)")
            .bind(other)
            .fetch_all(&mut *tx)
            .await
            .unwrap();
    tx.rollback().await.unwrap();
    eprintln!("RED in-scan channel predicate removed: a search for the other channel returns {} hit(s) of #general", wrong.iter().filter(|c| **c != other).count());
    assert!(wrong.iter().any(|c| *c != other));
}

// --- review round (PR #3222) -----------------------------------------------------------------

/// H-1: D1 "Friday" is closed by D2 "Thursday"; D3 "Friday" arrives. The current decision is D2/D3, and D1 (closed)
/// must never be folded into D3 (open), whatever the model says — folding would make the closed one win and the
/// current decision disappear.
#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn an_open_decision_is_never_merged_into_a_closed_one() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let (m1, m2, m3) = (
        w.say("배포는 금요일").await,
        w.say("아니 목요일로").await,
        w.say("다시 금요일로 돌아가요").await,
    );
    let mut s1 = spec(
        "decision",
        "extracted",
        "배포는 금요일에 한다",
        ago(9),
        &[m1],
    );
    s1.subject = Some("배포 요일");
    let mut s2 = spec(
        "decision",
        "extracted",
        "배포는 목요일로 옮긴다",
        ago(5),
        &[m2],
    );
    s2.subject = Some("배포 요일");
    let mut s3 = spec(
        "decision",
        "extracted",
        "배포는 금요일에 한다 다시",
        ago(1),
        &[m3],
    );
    s3.subject = Some("배포 요일");
    let (d1, d2) = (
        put_item(su, ws, ch, s1).await,
        put_item(su, ws, ch, s2).await,
    );
    // D2 closes D1 (as the job would have).
    *w.provider.reply_fn.lock().unwrap() =
        Some(judge(vec![("금요일에 한다", "목요일로", "supersedes")]));
    assert_eq!(w.consolidate().await.closed, 1);
    let d3 = put_item(su, ws, ch, s3).await;
    assert!(item(su, d1).await.unwrap().valid_to.is_some());

    // The pair (closed D1, open D3) is not even a candidate ...
    let pairs = w
        .mem_call(move |conn| {
            Box::pin(async move { cons::candidate_pairs(conn, ch, 0.3, 0.5, 50).await })
        })
        .await
        .unwrap();
    assert!(
        !pairs.iter().any(|p| (p.a_id, p.b_id) == (d1, d3)),
        "{pairs:?}"
    );
    // ... and if the model (or a bug) asks for the merge anyway, the database says distinct and remembers it.
    let sql = format!("SELECT mem_cons_apply('{d1}', '{d3}', 'duplicate')");
    let mut tx = red_tx(su, ws, &[]).await;
    let out: String = sqlx::query_scalar(&sql).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(out, "distinct");
    tx.rollback().await.unwrap();
    // RED: without the guard in `mem_cons_apply` the inner wall in `mem_cons_merge_items` still refuses ...
    let apply_guard = (
        "IF x.valid_to IS DISTINCT FROM y.valid_to THEN",
        "IF false THEN",
    );
    let mut tx = red_tx(su, ws, &[(APPLY, &[apply_guard])]).await;
    let held = sqlx::query_scalar::<_, String>(&sql)
        .fetch_one(&mut *tx)
        .await;
    assert_eq!(
        held.map_err(|e| mem::sqlstate(&momo_db::DbError::from(e))),
        Err(Some("23514".to_string()))
    );
    tx.rollback().await.unwrap();
    // ... and with both removed the closed decision swallows the current one.
    let merge_guard = (
        "IF l.valid_to IS DISTINCT FROM w.valid_to THEN",
        "IF false THEN",
    );
    let mut tx = red_tx(su, ws, &[(APPLY, &[apply_guard]), (MERGE, &[merge_guard])]).await;
    let out: String = sqlx::query_scalar(&sql).fetch_one(&mut *tx).await.unwrap();
    sqlx::query("RESET ROLE").execute(&mut *tx).await.unwrap();
    let current_retired: bool =
        sqlx::query_scalar("SELECT retired_at IS NOT NULL FROM mem_item WHERE id = $1")
            .bind(d3)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    eprintln!("RED validity guards removed: outcome={out}, the open (current) decision was retired = {current_retired}");
    assert_eq!((out.as_str(), current_retired), ("merged", true));
    tx.rollback().await.unwrap();
    let _ = d2;
}

/// H-2: a closing or a merge is undone when its cause dies.
#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn a_closing_and_a_merge_are_undone_when_their_cause_dies() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let app = momo_app_pool().await;
    // (a) A member posts a similar "new decision"; the job closes the real one; the member deletes their message.
    let real_msg = w.say("배포는 금요일 오후로 확정").await;
    let attacker_msg = w.say("배포는 월요일 새벽으로 바꿉니다").await;
    let mut real = spec(
        "decision",
        "extracted",
        "배포는 금요일 오후에 한다",
        ago(9),
        &[real_msg],
    );
    real.subject = Some("배포 시각");
    let mut fake = spec(
        "decision",
        "extracted",
        "배포는 월요일 새벽으로 바꾼다",
        ago(1),
        &[attacker_msg],
    );
    fake.subject = Some("배포 시각");
    let (real_id, fake_id) = (
        put_item(su, ws, ch, real).await,
        put_item(su, ws, ch, fake).await,
    );
    *w.provider.reply_fn.lock().unwrap() =
        Some(judge(vec![("금요일 오후", "월요일 새벽", "supersedes")]));
    assert_eq!(w.consolidate().await.closed, 1);
    assert!(
        item(su, real_id).await.unwrap().valid_to.is_some(),
        "closed by the impostor"
    );

    delete_msg(&app, ws, w.fx.human, attacker_msg).await;
    let stats = w.consolidate().await;
    assert_eq!(stats.dead_retired, 1, "{stats:?}");
    let back = item(su, real_id).await.unwrap();
    assert!(
        back.valid_to.is_none() && back.closed_by.is_none(),
        "the real decision is current again"
    );
    assert_eq!(
        item(su, fake_id).await.unwrap().retired_reason.as_deref(),
        Some("source_deleted")
    );
    let ev = events(su, real_id, "reverted").await;
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].1["reason"], json!("closer_source_gone"));

    // (b) A merge winner loses its source: the loser, whose own evidence is alive, comes back.
    let (wm, lm) = (
        w.say("릴리스 노트는 위키").await,
        w.say("노트는 위키에 쓴다고 했어요").await,
    );
    let winner = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "extracted",
            "릴리스 노트는 위키에 쓴다",
            ago(4),
            &[wm],
        ),
    )
    .await;
    let loser = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "extracted",
            "릴리스 노트는 위키에 적는다",
            ago(3),
            &[lm],
        ),
    )
    .await;
    *w.provider.reply_fn.lock().unwrap() =
        Some(judge(vec![("위키에 쓴다", "위키에 적는다", "duplicate")]));
    assert_eq!(w.consolidate().await.merged, 1);
    assert_eq!(item(su, loser).await.unwrap().merged_into, Some(winner));
    delete_msg(&app, ws, w.fx.human, wm).await;
    w.consolidate().await;
    assert_eq!(
        item(su, winner).await.unwrap().retired_reason.as_deref(),
        Some("source_deleted")
    );
    let revived = item(su, loser).await.unwrap();
    assert!(
        !revived.retired && revived.merged_into.is_none(),
        "the loser's own evidence is alive: it is back"
    );
    assert_eq!(events(su, loser, "reverted").await.len(), 1);

    // (c) Retention: a winner purged after 91 days must not take a loser with it whose evidence is alive.
    let (wm2, lm2) = (
        w.say("회식은 격주 금요일").await,
        w.say("회식은 이주에 한 번 금요일").await,
    );
    let winner2 = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "extracted",
            "회식은 격주 금요일에 한다",
            ago(120),
            &[wm2],
        ),
    )
    .await;
    let loser2 = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "extracted",
            "회식은 이주마다 금요일에 한다",
            ago(119),
            &[lm2],
        ),
    )
    .await;
    sqlx::query("UPDATE mem_item SET merged_into_id = $2, retired_at = now(), retired_reason = 'merged' WHERE id = $1")
        .bind(loser2).bind(winner2).execute(su).await.unwrap();
    sqlx::query("UPDATE mem_item SET retired_at = now() - interval '91 days', retired_reason = 'wrong' WHERE id = $1")
        .bind(winner2).execute(su).await.unwrap();
    let stats = w.consolidate().await;
    assert_eq!(stats.items_purged, 1, "{stats:?}");
    assert!(item(su, winner2).await.is_none());
    let kept = item(su, loser2)
        .await
        .expect("the loser is not purged with its winner");
    assert!(!kept.retired, "and it is live again");

    // (d) An edited closer hands its closing to the new version (no reopening for an edit).
    let (om, nm) = (
        w.say("서버는 A사").await,
        w.say("서버는 B사로 바꿉니다").await,
    );
    let mut older = spec("decision", "extracted", "서버는 A사를 쓴다", ago(9), &[om]);
    older.subject = Some("서버 업체");
    let mut newer = spec(
        "decision",
        "extracted",
        "서버는 B사로 바꾼다",
        ago(1),
        &[nm],
    );
    newer.subject = Some("서버 업체");
    let (o_id, n_id) = (
        put_item(su, ws, ch, older).await,
        put_item(su, ws, ch, newer).await,
    );
    *w.provider.reply_fn.lock().unwrap() = Some(judge(vec![("A사를", "B사로", "supersedes")]));
    assert_eq!(w.consolidate().await.closed, 1);
    let edited: Uuid = with_tenant_tx(&app, ws, {
        let member = w.fx.human_b;
        move |conn| {
            Box::pin(async move {
                sqlx::query("SELECT set_config('app.member_id', $1, true)")
                    .bind(member.to_string())
                    .execute(&mut *conn)
                    .await?;
                Ok(
                    sqlx::query_scalar("SELECT mem_edit_item($1, 'B사로 바꾸기로 했다 (수정)')")
                        .bind(n_id)
                        .fetch_one(&mut *conn)
                        .await?,
                )
            })
        }
    })
    .await
    .expect("edit");
    assert_eq!(item(su, o_id).await.unwrap().closed_by, Some(edited));
    assert!(item(su, o_id).await.unwrap().valid_to.is_some());
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn red_the_release_is_what_undoes_a_closing() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let app = momo_app_pool().await;
    let (a, b) = (
        w.say("배포는 금요일").await,
        w.say("배포는 월요일로 바꿔요").await,
    );
    let mut real = spec(
        "decision",
        "extracted",
        "배포는 금요일에 한다",
        ago(9),
        &[a],
    );
    real.subject = Some("배포 시각");
    let mut fake = spec(
        "decision",
        "extracted",
        "배포는 월요일로 바꾼다",
        ago(1),
        &[b],
    );
    fake.subject = Some("배포 시각");
    let (real_id, _fake) = (
        put_item(su, ws, ch, real).await,
        put_item(su, ws, ch, fake).await,
    );
    *w.provider.reply_fn.lock().unwrap() =
        Some(judge(vec![("금요일에", "월요일로", "supersedes")]));
    w.consolidate().await;
    delete_msg(&app, ws, w.fx.human, b).await;
    let original = sabotage_committed(
        su,
        "public.mem_cons_release(uuid[], text)",
        &[(
            "IF COALESCE(pg_catalog.cardinality(p_dying), 0) = 0 THEN",
            "IF true THEN",
        )],
    )
    .await;
    w.consolidate().await;
    restore(su, original).await;
    let stuck = item(su, real_id).await.unwrap();
    eprintln!(
        "RED release removed: the real decision stays closed by a dead impostor = {}",
        stuck.valid_to.is_some()
    );
    assert!(stuck.valid_to.is_some());
}

/// H-3: retention prunes covered windows; a later edit makes the rollup stale; the rollup is rebuilt from the
/// messages (never deleted for lack of inputs), and a forgotten message stays out of it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn a_stale_rollup_without_windows_is_rebuilt_from_the_messages() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let app = momo_app_pool().await;
    let mut seqs = Vec::new();
    let mut msgs = Vec::new();
    for body in [
        "아침 회의 결정: 배포는 금요일",
        "점심은 김밥",
        "회식비는 오만원으로 정했다 비밀",
    ] {
        let (id, seq) = post(&w.wp, &w.fx, w.fx.human, body).await;
        msgs.push(id);
        seqs.push(seq);
    }
    let (from, to) = (seqs[0], seqs[2]);
    let day = put_digest(su, ws, ch, "day", from, to, None, false, 1).await;
    let window = put_digest(su, ws, ch, "window", from, to, None, false, 100).await;
    for m in &msgs {
        for d in [day, window] {
            sqlx::query("INSERT INTO mem_evidence (workspace_id, digest_id, message_id, channel_id) VALUES ($1, $2, $3, $4)")
                .bind(ws).bind(d).bind(m).bind(ch).execute(su).await.unwrap();
        }
    }
    sqlx::query("UPDATE mem_digest SET source_count = 3 WHERE id IN ($1, $2)")
        .bind(day)
        .bind(window)
        .execute(su)
        .await
        .unwrap();
    // The channel is already summarised up to here (no new window is cut from these messages).
    sqlx::query("INSERT INTO mem_cursor (channel_id, workspace_id, last_seq) VALUES ($1, $2, $3)")
        .bind(ch)
        .bind(ws)
        .bind(to)
        .execute(su)
        .await
        .unwrap();
    // Retention removes the window the day rollup covers ...
    let stats = w.consolidate().await;
    assert_eq!(stats.windows_pruned, 1, "{stats:?}");
    assert!(!exists(su, "mem_digest", window).await);
    // ... then a member edits a message: the rollup goes stale and there is nothing left to roll up.
    edit_msg(&app, ws, w.fx.human, msgs[1], "점심은 샌드위치").await;
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT stale FROM mem_digest WHERE id = $1")
            .bind(day)
            .fetch_one(su)
            .await
            .unwrap()
    );
    // The forgotten fact's message is kept out of the rebuild.
    sqlx::query(
        "INSERT INTO mem_suppress_msg (workspace_id, channel_id, message_id) VALUES ($1, $2, $3)",
    )
    .bind(ws)
    .bind(ch)
    .bind(msgs[2])
    .execute(su)
    .await
    .unwrap();
    *w.provider.reply_fn.lock().unwrap() = Some(echo_reply("__none__", "x"));
    let before = w.provider.count();
    let sweep = w.worker.summary_sweep().await;
    assert_eq!((sweep.dropped, sweep.regenerated), (0, 1), "{sweep:?}");
    let body: String =
        sqlx::query_scalar("SELECT body FROM mem_digest WHERE id = $1 AND NOT stale")
            .bind(day)
            .fetch_one(su)
            .await
            .expect("the rollup is back, not deleted");
    assert!(
        body.contains("샌드위치") && body.contains("배포는 금요일"),
        "{body}"
    );
    assert!(
        !body.contains("회식비"),
        "the forgotten message stays out: {body}"
    );
    assert!((before..w.provider.count()).all(|i| !w.provider.prompt(i).contains("회식비")));
}

/// M-1: only a strong signal closes on its own, and nothing that rests on a guest's message is closed or merged
/// automatically.
#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn a_weak_signal_or_a_guests_words_never_change_memory_on_their_own() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let guest = new_member(su, ws, "human", "게스트").await;
    sqlx::query("UPDATE workspace_membership SET role = 'guest' WHERE member_id = $1")
        .bind(guest)
        .execute(su)
        .await
        .unwrap();
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id, role) VALUES ($1, $2, $3, 'guest')")
        .bind(ws).bind(ch).bind(guest).execute(su).await.unwrap();
    let gm = post_in(&w.wp, ws, ch, guest, "게스트가 쓴 결정입니다 배포는 화요일")
        .await
        .0;
    let (m1, m2, m3, m4) = (
        w.say("배포는 금요일").await,
        w.say("서버는 A사를 쓴다").await,
        w.say("서버는 A사를 쓰기로 했다").await,
        w.say("배포는 수요일로").await,
    );
    // (a) two decisions without a shared subject and a low text similarity are not a closing candidate.
    put_item(
        su,
        ws,
        ch,
        spec(
            "decision",
            "extracted",
            "배포는 금요일에 한다",
            ago(9),
            &[m1],
        ),
    )
    .await;
    put_item(
        su,
        ws,
        ch,
        spec(
            "decision",
            "extracted",
            "서버 업체는 새로 고른다",
            ago(1),
            &[m4],
        ),
    )
    .await;
    let pairs = w
        .mem_call(move |conn| {
            Box::pin(async move { cons::candidate_pairs(conn, ch, 0.55, 0.5, 50).await })
        })
        .await
        .unwrap();
    assert!(pairs.is_empty(), "weak similarity, no subject: {pairs:?}");
    // (b) a duplicate that rests on the guest's message becomes a proposal.
    let a = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "서버는 A사를 쓴다", ago(4), &[m2]),
    )
    .await;
    let b = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "서버는 A사를 쓴다 확정", ago(3), &[gm]),
    )
    .await;
    *w.provider.reply_fn.lock().unwrap() = Some(judge(vec![("A사를 쓴다", "확정", "duplicate")]));
    let mut config = cons_config();
    config.memory.consolidate_merge_similarity = 0.3;
    let eager = worker_with(&w.provider, config).await;
    let stats = eager.consolidate_channel_now(ws, ch).await;
    assert_eq!((stats.merged, stats.proposed), (0, 1), "{stats:?}");
    assert!(!item(su, a).await.unwrap().retired && !item(su, b).await.unwrap().retired);
    // the database says so on its own, whoever asks: the inner function refuses an automatic merge / closing
    let _ = m3;
    let sql = format!("SELECT mem_cons_merge_items('{b}', '{a}', NULL, NULL)");
    let mut tx = su.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(ws.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SET LOCAL ROLE mem_definer")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SELECT mem_op('cons_apply')")
        .execute(&mut *tx)
        .await
        .unwrap();
    let refused = sqlx::query_scalar::<_, bool>(&sql)
        .fetch_one(&mut *tx)
        .await;
    assert_eq!(
        refused.map_err(|e| mem::sqlstate(&momo_db::DbError::from(e))),
        Err(Some("23514".to_string()))
    );
    tx.rollback().await.unwrap();
    // RED: without the guest test both walls let the automatic merge through.
    let route = (
        "IF l.origin IN ('curated', 'confirmed') OR v_guest THEN",
        "IF l.origin IN ('curated', 'confirmed') THEN",
    );
    let inner = ("IF p_proposal_id IS NULL AND (public.mem_item_guest_authored(l.id) OR public.mem_item_guest_authored(w.id)) THEN", "IF false THEN");
    let apply_sql = format!("SELECT mem_cons_apply('{a}', '{b}', 'duplicate')");
    sqlx::query("DELETE FROM mem_proposal WHERE channel_id = $1")
        .bind(ch)
        .execute(su)
        .await
        .unwrap();
    sqlx::query("DELETE FROM mem_cons_pair WHERE workspace_id = $1")
        .bind(ws)
        .execute(su)
        .await
        .unwrap();
    let mut tx = red_tx(su, ws, &[(APPLY, &[route]), (MERGE, &[inner])]).await;
    let out: String = sqlx::query_scalar(&apply_sql)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    eprintln!("RED guest guards removed: a merge resting on a guest's message runs on its own: outcome={out}");
    assert_eq!(out, "merged");
    tx.rollback().await.unwrap();
}

/// M-2: a person can undo a consolidation event they can read; guests, outsiders and forgotten content cannot.
#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn a_member_can_undo_a_consolidation_but_not_bring_back_what_was_forgotten() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let app = momo_app_pool().await;
    let (m1, m2) = (
        w.say("배포는 금요일 오후").await,
        w.say("금요일 오후 배포").await,
    );
    let a = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "extracted",
            "배포는 금요일 오후에 한다",
            ago(3),
            &[m1],
        ),
    )
    .await;
    let b = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "extracted",
            "배포는 금요일 오후에 진행한다",
            ago(2),
            &[m2],
        ),
    )
    .await;
    *w.provider.reply_fn.lock().unwrap() = Some(judge(vec![(
        "금요일 오후에 한다",
        "금요일 오후에 진행한다",
        "duplicate",
    )]));
    assert_eq!(w.consolidate().await.merged, 1);
    let event = events(su, b, "merged").await[0].0;
    let guest = new_member(su, ws, "human", "게스트").await;
    sqlx::query("UPDATE workspace_membership SET role = 'guest' WHERE member_id = $1")
        .bind(guest)
        .execute(su)
        .await
        .unwrap();
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id, role) VALUES ($1, $2, $3, 'guest')")
        .bind(ws).bind(ch).bind(guest).execute(su).await.unwrap();
    let outsider = new_member(su, ws, "human", "외부인").await;
    let revert_as = |member: Uuid| {
        let app = app.clone();
        async move {
            with_tenant_tx(&app, ws, move |conn| {
                Box::pin(async move {
                    sqlx::query("SELECT set_config('app.member_id', $1, true)")
                        .bind(member.to_string())
                        .execute(&mut *conn)
                        .await?;
                    Ok(
                        sqlx::query_scalar::<_, String>("SELECT mem_revert_consolidation($1)")
                            .bind(event)
                            .fetch_one(&mut *conn)
                            .await?,
                    )
                })
            })
            .await
            .map_err(|e| mem::sqlstate(&e).unwrap_or_default())
        }
    };
    assert_eq!(
        revert_as(guest).await,
        Err("42501".to_string()),
        "guests read but do not change"
    );
    assert_eq!(
        revert_as(outsider).await,
        Err("P0002".to_string()),
        "an unreadable item is a missing one"
    );
    assert_eq!(
        revert_as(w.fx.agent).await,
        Err("42501".to_string()),
        "agents never"
    );
    // the plain worker session (BYPASSRLS) cannot use the API entry point either
    let worker_call = with_tenant_tx(&w.wp, ws, move |conn| {
        Box::pin(async move {
            Ok(
                sqlx::query_scalar::<_, String>("SELECT mem_revert_consolidation($1)")
                    .bind(event)
                    .fetch_one(&mut *conn)
                    .await?,
            )
        })
    })
    .await;
    assert_eq!(sqlstate_of(worker_call).await, "42501");
    // a paused workspace: 409
    sqlx::query(
        "INSERT INTO mem_settings (workspace_id, scope, paused) VALUES ($1, 'workspace', true)",
    )
    .bind(ws)
    .execute(su)
    .await
    .unwrap();
    assert_eq!(revert_as(w.fx.human_b).await, Err("55000".to_string()));
    sqlx::query("DELETE FROM mem_settings WHERE workspace_id = $1")
        .bind(ws)
        .execute(su)
        .await
        .unwrap();
    // a forgotten hash is never brought back
    sqlx::query("INSERT INTO mem_suppress (workspace_id, channel_id, content_hash) SELECT workspace_id, channel_id, content_hash FROM mem_item WHERE id = $1")
        .bind(b).execute(su).await.unwrap();
    assert_eq!(
        revert_as(w.fx.human_b).await,
        Err("55000".to_string()),
        "forgotten content stays forgotten"
    );
    sqlx::query("DELETE FROM mem_suppress WHERE channel_id = $1")
        .bind(ch)
        .execute(su)
        .await
        .unwrap();
    // ... and content whose source is gone is not either
    delete_msg(&app, ws, w.fx.human, m2).await;
    let after = revert_as(w.fx.human_b).await;
    assert!(
        matches!(&after, Err(e) if e == "P0002" || e == "55000"),
        "{after:?}"
    );
    // The member who can read it, with everything in order, does undo it (a fresh merge, nothing forgotten).
    let (m3, m4) = (
        w.say("점심은 김밥 한 줄").await,
        w.say("점심은 김밥 한 줄로 한다").await,
    );
    let c = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "점심은 김밥 한 줄이다", ago(3), &[m3]),
    )
    .await;
    let d = put_item(
        su,
        ws,
        ch,
        spec(
            "fact",
            "extracted",
            "점심은 김밥 한 줄이다 확정",
            ago(2),
            &[m4],
        ),
    )
    .await;
    *w.provider.reply_fn.lock().unwrap() =
        Some(judge(vec![("김밥 한 줄이다", "확정", "duplicate")]));
    assert_eq!(w.consolidate().await.merged, 1);
    let ev2 = events(su, d, "merged").await[0].0;
    let human_b = w.fx.human_b;
    let ok = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            sqlx::query("SELECT set_config('app.member_id', $1, true)")
                .bind(human_b.to_string())
                .execute(&mut *conn)
                .await?;
            Ok(
                sqlx::query_scalar::<_, String>("SELECT mem_revert_consolidation($1)")
                    .bind(ev2)
                    .fetch_one(&mut *conn)
                    .await?,
            )
        })
    })
    .await
    .expect("a member undoes a merge");
    assert_eq!(ok, "merged");
    assert!(!item(su, d).await.unwrap().retired);
    let actor: Option<Uuid> = sqlx::query_scalar(
        "SELECT actor_member_id FROM mem_event WHERE target_id = $1 AND action = 'reverted'",
    )
    .bind(d)
    .fetch_one(su)
    .await
    .unwrap();
    assert_eq!(actor, Some(w.fx.human_b), "the ledger names who undid it");
    let _ = (a, b, c);
}

/// M-4: what a person made or confirmed is kept four times as long as what a machine retired.
#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn retired_human_made_items_outlive_the_machine_retention() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let m = w.say("보존 시험 근거").await;
    let machine = put_item(
        su,
        ws,
        ch,
        spec("fact", "extracted", "기계가 만든 사실", ago(400), &[m]),
    )
    .await;
    let human = put_item(
        su,
        ws,
        ch,
        spec("fact", "confirmed", "사람이 확정한 사실", ago(400), &[m]),
    )
    .await;
    let old_human = put_item(
        su,
        ws,
        ch,
        spec("fact", "curated", "아주 오래된 고친 사실", ago(900), &[m]),
    )
    .await;
    for (id, days) in [(machine, 100), (human, 100), (old_human, 400)] {
        sqlx::query("UPDATE mem_item SET retired_at = now() - make_interval(days => $2), retired_reason = 'edited' WHERE id = $1")
            .bind(id)
            .bind(days)
            .execute(su)
            .await
            .unwrap();
    }
    let stats = w.consolidate().await;
    assert_eq!(stats.items_purged, 2, "{stats:?}");
    assert!(
        item(su, machine).await.is_none(),
        "machine-retired, 100 days: gone"
    );
    assert!(
        item(su, human).await.is_some(),
        "confirmed, 100 days: kept (4 x 90 days)"
    );
    assert!(
        item(su, old_human).await.is_none(),
        "curated, 400 days: past 4 x 90"
    );
}

/// M-6: the consolidation lease is its own (longer) one, renewed after each model call, and lost leases are logged.
#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn the_lease_is_long_and_renewed_after_every_model_call() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    pair_of_duplicates(
        &w,
        "임대",
        (
            "임대 시험 사실 하나 입니다",
            "임대 시험 사실 하나 입니다 확정",
        ),
    )
    .await;
    let seen: Arc<Mutex<Vec<f64>>> = Arc::new(Mutex::new(Vec::new()));
    // The hook runs inside every model call: read how long the lease still has.
    let hook_seen = seen.clone();
    let hook_su = su.clone();
    *w.provider.hook.lock().unwrap() = Some(Arc::new(move |_n| {
        let (seen, su) = (hook_seen.clone(), hook_su.clone());
        Box::pin(async move {
            let left: Option<f64> = sqlx::query_scalar(
                "SELECT extract(epoch FROM (leased_until - now()))::float8 FROM mem_cons_state WHERE leased_until IS NOT NULL",
            )
            .fetch_optional(&su)
            .await
            .unwrap();
            seen.lock().unwrap().push(left.unwrap_or(-1.0));
        })
    }));
    *w.provider.reply_fn.lock().unwrap() = Some(judge(vec![]));
    let mut config = cons_config();
    config.memory.consolidate_merge_similarity = 0.3;
    config.memory.consolidate_lease_seconds = 900.0;
    let worker = worker_with(&w.provider, config).await;
    let stats = worker.consolidate_channel_now(ws, ch).await;
    assert!(stats.llm_calls >= 1, "{stats:?}");
    let left = seen.lock().unwrap().clone();
    assert!(
        left.iter().all(|s| *s > 600.0),
        "the summary lease (300 s) is not what guards consolidation: {left:?}"
    );
    // The lease is released at the end.
    let held: bool = sqlx::query_scalar(
        "SELECT leased_until IS NOT NULL FROM mem_cons_state WHERE channel_id = $1",
    )
    .bind(ch)
    .fetch_one(su)
    .await
    .unwrap();
    assert!(!held);
}

/// L-2: a pair the model could not answer is not asked again the next day; an unanswered pair costs one call.
#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn an_unanswerable_pair_is_not_asked_again_tomorrow() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    pair_of_duplicates(
        &w,
        "무응답",
        (
            "무응답 시험 사실 입니다 하나",
            "무응답 시험 사실 입니다 하나 더",
        ),
    )
    .await;
    *w.provider.reply_fn.lock().unwrap() =
        Some(Arc::new(|_n, _p| "글쎄요 잘 모르겠어요".to_string()));
    let mut config = cons_config();
    config.memory.consolidate_merge_similarity = 0.3;
    let worker = worker_with(&w.provider, config).await;
    let first = worker.consolidate_channel_now(ws, ch).await;
    assert_eq!((first.llm_calls, first.unparsed), (1, 1), "{first:?}");
    let second = worker.consolidate_channel_now(ws, ch).await;
    assert_eq!(second.llm_calls, 0, "deferred for a day: {second:?}");
    let (verdict, retry): (String, Option<DateTime<Utc>>) = sqlx::query_as(
        "SELECT verdict, retry_after FROM mem_cons_pair WHERE workspace_id = $1 LIMIT 1",
    )
    .bind(ws)
    .fetch_one(su)
    .await
    .unwrap();
    assert_eq!(verdict, "unparsed");
    assert!(retry.unwrap() > Utc::now() + ChronoDuration::hours(20));
    // A day later it is asked again.
    sqlx::query("UPDATE mem_cons_pair SET retry_after = now() - interval '1 minute' WHERE workspace_id = $1 AND verdict = 'unparsed'")
        .bind(ws)
        .execute(su)
        .await
        .unwrap();
    let third = worker.consolidate_channel_now(ws, ch).await;
    assert_eq!(third.llm_calls, 1, "{third:?}");
}
