//! #3172 B / ADR-0196 D3·D6·D10 — the topic layer of the consolidation job (assign, split at the cap, summarise)
//! against a real Postgres. Same setup as `memory_consolidate_conformance_pg` (isolated `3172-pg`, mock model,
//! `red_*` twins that redefine a SQL function without its guard inside a rolled-back transaction).
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-agent-worker --test memory_topics_conformance_pg -- --ignored --test-threads=1 --nocapture
//! ```

#![allow(dead_code, unused_imports)]

include!("common/memory_harness.rs");

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use momo_agent::memory_cons as cons;
use serde_json::json;

include!("common/consolidate_helpers.rs");

const ASSIGN: &str = "public.mem_topic_assign(uuid, uuid, text, integer)";
const SPLIT: &str = "public.mem_topic_split_apply(uuid, text[], uuid[], integer[], integer)";
const SET_SUMMARY: &str = "public.mem_topic_set_summary(uuid, text, uuid[], text, text)";
const LABEL_CLEAN: &str = "public.mem_topic_label_clean(text)";
const SUMMARY_OK: &str = "public.mem_topic_summary_ok(uuid)";

/// The mock model of the topic layer: one label for everything unassigned, three sub-topics for a split, a
/// summary that echoes the items it was shown (so what a summary says is what the model saw).
fn topic_model() -> ReplyFn {
    Arc::new(|_n, prompt| {
        if prompt.contains("<기억 A>") {
            "distinct".to_string()
        } else if prompt.contains("<주제들>") {
            let topics = between(prompt, "<주제들>\n", "\n</주제들>");
            let items = between(prompt, "<항목들>\n", "\n</항목들>");
            let n = items.lines().count();
            let entries: Vec<String> = (1..=n)
                .map(|i| {
                    if topics.contains("(없음)") {
                        format!(r#"{{"item": {i}, "new": "운영 규칙"}}"#)
                    } else {
                        format!(r#"{{"item": {i}, "topic": 1}}"#)
                    }
                })
                .collect();
            format!("[{}]", entries.join(", "))
        } else if prompt.contains("<주제>\n") {
            let n = between(prompt, "<항목들>\n", "\n</항목들>").lines().count();
            let assign: Vec<String> = (0..n).map(|i| (i % 3 + 1).to_string()).collect();
            format!(
                r#"{{"topics": ["배포", "장애", "문서"], "assign": [{}]}}"#,
                assign.join(", ")
            )
        } else {
            let items = between(prompt, "<항목들>\n", "\n</항목들>");
            format!(
                "이 주제의 요약: {}",
                items.lines().collect::<Vec<_>>().join(" ")
            )
        }
    })
}

async fn many_items(w: &World, channel: Uuid, n: usize, tag: &str) -> Vec<Uuid> {
    let m = w.say_in(channel, &format!("{tag} 근거 메시지")).await;
    let mut ids = Vec::new();
    for i in 0..n {
        ids.push(
            put_item(
                &w.su,
                w.fx.ws,
                channel,
                spec(
                    "fact",
                    "extracted",
                    &format!(
                        "{tag} 사실 번호 {i} 는 다르게 적혀 있다 {}",
                        i * 7919 % 1000
                    ),
                    ago(30 - (i % 25) as i64),
                    &[m],
                ),
            )
            .await,
        );
    }
    ids
}

async fn topic_of(su: &PgPool, item: Uuid) -> Option<Uuid> {
    sqlx::query_scalar("SELECT topic_id FROM mem_item WHERE id = $1")
        .bind(item)
        .fetch_one(su)
        .await
        .unwrap()
}

fn topic_config() -> WorkerConfig {
    let mut c = cons_config();
    c.memory.topics_enabled = true;
    c.memory.consolidate_max_calls = 100;
    c
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn items_are_assigned_and_a_full_topic_is_split_in_three() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    *w.provider.reply_fn.lock().unwrap() = Some(topic_model());
    let worker = worker_with(&w.provider, topic_config()).await;
    let ids = many_items(&w, ch, 130, "배포").await;

    let stats = worker.consolidate_channel_now(ws, ch).await;
    assert_eq!(
        (
            stats.topic_assigned,
            stats.topic_created,
            stats.topic_splits
        ),
        (130, 1, 1),
        "{stats:?}"
    );
    assert_eq!(stats.failures, 0, "{stats:?}");
    // Every item is in exactly one topic, and it is a leaf of its own channel.
    let root: Uuid =
        sqlx::query_scalar("SELECT id FROM mem_topic WHERE channel_id = $1 AND parent_id IS NULL")
            .bind(ch)
            .fetch_one(su)
            .await
            .unwrap();
    let children: Vec<(Uuid, String, i64)> = sqlx::query_as(
        "SELECT t.id, t.label, (SELECT count(*) FROM mem_item i WHERE i.topic_id = t.id) FROM mem_topic t WHERE t.parent_id = $1 ORDER BY t.label",
    ).bind(root).fetch_all(su).await.unwrap();
    assert_eq!(children.len(), 3);
    assert_eq!(
        children.iter().map(|c| c.2).sum::<i64>(),
        130,
        "{children:?}"
    );
    assert!(
        children.iter().all(|c| c.2 > 0 && c.2 < 125),
        "every sub-topic is under the cap: {children:?}"
    );
    let direct: i64 = sqlx::query_scalar("SELECT count(*) FROM mem_item WHERE topic_id = $1")
        .bind(root)
        .fetch_one(su)
        .await
        .unwrap();
    assert_eq!(direct, 0, "the split parent holds no items itself");
    for id in &ids {
        let t = topic_of(su, *id).await;
        assert!(
            children.iter().any(|c| Some(c.0) == t),
            "{id} sits in a sub-topic"
        );
    }
    let cross: i64 = sqlx::query_scalar("SELECT count(*) FROM mem_item i JOIN mem_topic t ON t.id = i.topic_id WHERE i.channel_id <> t.channel_id")
        .fetch_one(su).await.unwrap();
    assert_eq!(cross, 0);
    assert_eq!(events(su, root, "split").await.len(), 1);
    let assigned: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM mem_event WHERE action = 'assigned' AND channel_id = $1",
    )
    .bind(ch)
    .fetch_one(su)
    .await
    .unwrap();
    assert_eq!(
        assigned, 260,
        "130 first assignments + 130 moves by the split"
    );
    assert_eq!(
        stats.topic_summaries, 3,
        "each sub-topic got a summary: {stats:?}"
    );
    assert!(
        tokens_used_today(su, ws).await > 0,
        "topic calls are charged to the daily cap"
    );

    // Under the cap nothing splits; and a split that was reverted stays reverted (locked).
    let event = events(su, root, "split").await[0].0;
    let kind = w
        .mem_call(move |conn| Box::pin(async move { cons::topic_revert(conn, event).await }))
        .await
        .expect("revert");
    assert_eq!(kind, "split");
    let direct: i64 = sqlx::query_scalar("SELECT count(*) FROM mem_item WHERE topic_id = $1")
        .bind(root)
        .fetch_one(su)
        .await
        .unwrap();
    assert_eq!(direct, 130);
    assert_eq!(
        scalar_i64(
            su,
            "SELECT count(*) FROM mem_topic WHERE parent_id = $1",
            root
        )
        .await,
        0
    );
    let again = worker.consolidate_channel_now(ws, ch).await;
    assert_eq!(
        again.topic_splits, 0,
        "the revert locks the topic for a day: {again:?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn red_a_topic_below_the_cap_is_split_without_the_cap_check() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    *w.provider.reply_fn.lock().unwrap() = Some(topic_model());
    let worker = worker_with(&w.provider, topic_config()).await;
    let ids = many_items(&w, ch, 40, "장애").await;
    let stats = worker.consolidate_channel_now(ws, ch).await;
    assert_eq!(
        (stats.topic_assigned, stats.topic_splits),
        (40, 0),
        "{stats:?}"
    );
    let root: Uuid = sqlx::query_scalar("SELECT id FROM mem_topic WHERE channel_id = $1")
        .bind(ch)
        .fetch_one(su)
        .await
        .unwrap();
    let call = |edits: Vec<(&'static str, &'static str)>| {
        let su = su.clone();
        let ids = ids.clone();
        async move {
            let e: Vec<(&str, &[(&str, &str)])> = if edits.is_empty() {
                vec![]
            } else {
                vec![(SPLIT, &edits[..])]
            };
            let mut tx = red_tx(&su, ws, &e).await;
            let n: i32 = sqlx::query_scalar(
                "SELECT mem_topic_split_apply($1, ARRAY['가나','다라'], $2, $3, 125)",
            )
            .bind(root)
            .bind(&ids[..2])
            .bind(vec![1i32, 2])
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            tx.rollback().await.unwrap();
            n
        }
    };
    assert_eq!(
        call(vec![]).await,
        0,
        "shipped: 40 items are under the cap of 125"
    );
    let n = call(vec![(
        "        < GREATEST(COALESCE(p_cap, 125), 2) THEN",
        "        < 0 THEN",
    )])
    .await;
    eprintln!("RED cap check removed: a 40-item topic is split, {n} item(s) moved");
    assert_eq!(n, 40);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn no_topic_crosses_a_channel() {
    let w = world().await;
    let (su, ws) = (&w.su, w.fx.ws);
    let other = new_channel(su, ws, "public", &[w.fx.human, w.fx.human_b, w.fx.agent]).await;
    *w.provider.reply_fn.lock().unwrap() = Some(topic_model());
    let worker = worker_with(&w.provider, topic_config()).await;
    let a = many_items(&w, w.fx.channel, 4, "채널A").await;
    let b = many_items(&w, other, 4, "채널B").await;
    worker.consolidate_channel_now(ws, w.fx.channel).await;
    worker.consolidate_channel_now(ws, other).await;
    let (ta, tb) = (
        topic_of(su, a[0]).await.unwrap(),
        topic_of(su, b[0]).await.unwrap(),
    );
    assert_ne!(ta, tb, "same label, two channels, two topics");
    // The prompt of one channel never carries the other's items.
    for i in 0..w.provider.count() {
        let p = w.provider.prompt(i);
        assert!(
            !(p.contains("채널A") && p.contains("채널B")),
            "a prompt mixed channels: {p}"
        );
    }
    // A new unassigned item of the other channel cannot be put into this channel's topic by anyone.
    let stray = many_items(&w, other, 1, "채널B-신규").await[0];
    let sql = format!("SELECT mem_topic_assign('{stray}', '{ta}', NULL, 60)");
    let mut tx = red_tx(su, ws, &[]).await;
    let refused = sqlx::query_scalar::<_, Option<Uuid>>(&sql)
        .fetch_one(&mut *tx)
        .await;
    assert_eq!(
        refused.map_err(|e| mem::sqlstate(&momo_db::DbError::from(e))),
        Err(Some("23514".to_string()))
    );
    tx.rollback().await.unwrap();
    // RED: without the channel/space check the item lands in the other channel's topic.
    let wall = (
        "IF t.channel_id <> i.channel_id OR",
        "IF false AND t.channel_id <> i.channel_id OR",
    );
    let mut tx = red_tx(su, ws, &[(ASSIGN, &[wall])]).await;
    let landed: Option<Uuid> = sqlx::query_scalar(&sql).fetch_one(&mut *tx).await.unwrap();
    eprintln!("RED channel check removed: an item of one channel was put into the other channel's topic = {}", landed == Some(ta));
    assert_eq!(landed, Some(ta));
    tx.rollback().await.unwrap();
    // Summaries are the same: a source from another channel is refused.
    let mut tx = red_tx(su, ws, &[]).await;
    let refused = sqlx::query_scalar::<_, bool>(
        "SELECT mem_topic_set_summary($1, '요약', ARRAY[$2]::uuid[], 'm', 'v')",
    )
    .bind(ta)
    .bind(b[0])
    .fetch_one(&mut *tx)
    .await;
    assert_eq!(
        refused.map_err(|e| mem::sqlstate(&momo_db::DbError::from(e))),
        Err(Some("23514".to_string()))
    );
    tx.rollback().await.unwrap();
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn labels_and_summaries_are_checked_again_in_sql() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let ids = many_items(&w, ch, 3, "검사").await;
    let key = format!("{}{}", "ghp_", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc");
    // A label is at most 30 characters, so its credential-shaped string is a short one.
    let label_secret = format!("{}{}", "sk-", "Zx9Yw8Vu7Ts6Rq5Po4Nm3");
    // The worker drops a secret-shaped label before it asks the database ...
    *w.provider.reply_fn.lock().unwrap() = Some({
        let key = label_secret.clone();
        Arc::new(move |_n, prompt| {
            if prompt.contains("<기억 A>") {
                "distinct".to_string()
            } else if prompt.contains("<주제들>") {
                format!(r#"[{{"item": 1, "new": "{key}"}}, {{"item": 2, "new": "[7] 지시"}}]"#)
            } else {
                "요약".to_string()
            }
        })
    });
    let worker = worker_with(&w.provider, topic_config()).await;
    let stats = worker.consolidate_channel_now(ws, ch).await;
    assert_eq!(
        (stats.topic_assigned, stats.topic_created),
        (0, 0),
        "{stats:?}"
    );
    assert_eq!(
        scalar_i64(
            su,
            "SELECT count(*) FROM mem_topic WHERE channel_id = $1",
            ch
        )
        .await,
        0
    );
    // ... and the database refuses it too when asked directly (the last line of defence).
    let sql = format!(
        "SELECT mem_topic_assign('{}', NULL, '{label_secret}', 60)",
        ids[0]
    );
    let mut tx = red_tx(su, ws, &[]).await;
    let refused = sqlx::query_scalar::<_, Option<Uuid>>(&sql)
        .fetch_one(&mut *tx)
        .await;
    assert_eq!(
        refused.map_err(|e| mem::sqlstate(&momo_db::DbError::from(e))),
        Err(Some("23514".to_string()))
    );
    tx.rollback().await.unwrap();
    let bracket = format!(
        "SELECT mem_topic_assign('{}', NULL, '[7] 지시', 60)",
        ids[0]
    );
    let mut tx = red_tx(su, ws, &[]).await;
    assert_eq!(
        sqlx::query_scalar::<_, Option<Uuid>>(&bracket)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| mem::sqlstate(&momo_db::DbError::from(e))),
        Err(Some("23514".to_string()))
    );
    tx.rollback().await.unwrap();
    // RED: without the SQL secret test in the label cleaner the label is stored.
    let mut tx = red_tx(
        su,
        ws,
        &[(
            LABEL_CLEAN,
            &[("AND NOT public.mem_looks_like_secret(c)", "")],
        )],
    )
    .await;
    let stored: Option<Uuid> = sqlx::query_scalar(&sql).fetch_one(&mut *tx).await.unwrap();
    eprintln!(
        "RED SQL label secret check removed: a credential-shaped label is stored = {}",
        stored.is_some()
    );
    assert!(stored.is_some());
    tx.rollback().await.unwrap();

    // Summaries: a secret is refused, brackets become full-width, and RED shows the secret check is load-bearing.
    *w.provider.reply_fn.lock().unwrap() = Some(topic_model());
    let worker = worker_with(&w.provider, topic_config()).await;
    worker.consolidate_channel_now(ws, ch).await;
    let topic = topic_of(su, ids[0])
        .await
        .expect("assigned by the normal model");
    let items = format!("ARRAY['{}','{}','{}']::uuid[]", ids[0], ids[1], ids[2]);
    let set = |body: String| {
        format!("SELECT mem_topic_set_summary('{topic}', '{body}', {items}, 'm', 'v')")
    };
    let mut tx = red_tx(su, ws, &[]).await;
    let refused = sqlx::query_scalar::<_, bool>(&set(format!("키는 {key} 입니다")))
        .fetch_one(&mut *tx)
        .await;
    assert_eq!(
        refused.map_err(|e| mem::sqlstate(&momo_db::DbError::from(e))),
        Err(Some("23514".to_string()))
    );
    tx.rollback().await.unwrap();
    let mut tx = red_tx(su, ws, &[]).await;
    sqlx::query_scalar::<_, bool>(&set("결정 [3] 확정".to_string()))
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    sqlx::query("RESET ROLE").execute(&mut *tx).await.unwrap();
    let stored: String =
        sqlx::query_scalar("SELECT body FROM mem_topic_summary WHERE topic_id = $1")
            .bind(topic)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert!(!stored.contains('[') && stored.contains('［'), "{stored}");
    tx.rollback().await.unwrap();
    let mut tx = red_tx(
        su,
        ws,
        &[(
            SET_SUMMARY,
            &[("OR public.mem_looks_like_secret(v_body)", "")],
        )],
    )
    .await;
    let ok = sqlx::query_scalar::<_, bool>(&set(format!("키는 {key} 입니다")))
        .fetch_one(&mut *tx)
        .await;
    eprintln!(
        "RED SQL summary secret check removed: a credential-shaped summary is stored = {}",
        ok.is_ok()
    );
    assert!(ok.is_ok());
    tx.rollback().await.unwrap();
}

/// Would this reader be shown the topic's summary? (B-4: the API role has no table read on the topic tables yet, so
/// the rule the policy will use is asked through its PUBLIC helper.)
async fn reader_ok(app: &PgPool, ws: Uuid, member: Uuid, topic: Uuid) -> bool {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            momo_messaging::memory::bind_mem_reader_guc(conn, member).await?;
            Ok(
                sqlx::query_scalar::<_, bool>("SELECT mem_topic_summary_ok($1)")
                    .bind(topic)
                    .fetch_one(&mut *conn)
                    .await?,
            )
        })
    })
    .await
    .expect("reader")
}

async fn summary_bodies(su: &PgPool, ch: Uuid) -> Vec<String> {
    sqlx::query_scalar("SELECT body FROM mem_topic_summary WHERE channel_id = $1")
        .bind(ch)
        .fetch_all(su)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn a_forgotten_item_hides_the_summary_and_it_is_written_again_without_it() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let app = momo_app_pool().await;
    let outsider = new_member(su, ws, "human", "외부인").await;
    *w.provider.reply_fn.lock().unwrap() = Some(topic_model());
    let worker = worker_with(&w.provider, topic_config()).await;
    let m = w.say("주제 요약 근거").await;
    let mut ids = Vec::new();
    for body in [
        "배포는 금요일에 한다",
        "롤백은 김철수가 맡는다",
        "회식비는 오만원으로 정했다",
        "릴리스 노트는 위키에 쓴다",
        "장애 공지는 슬랙에 한다",
    ] {
        ids.push(put_item(su, ws, ch, spec("fact", "extracted", body, ago(3), &[m])).await);
    }
    let stats = worker.consolidate_channel_now(ws, ch).await;
    assert_eq!(
        (stats.topic_assigned, stats.topic_summaries),
        (5, 1),
        "{stats:?}"
    );
    let topic = topic_of(su, ids[0]).await.unwrap();
    let seen = summary_bodies(su, ch).await;
    assert_eq!(seen.len(), 1);
    assert!(
        seen[0].contains("회식비"),
        "the summary carries the fact: {}",
        seen[0]
    );
    assert!(reader_ok(&app, ws, w.fx.human_b, topic).await);
    assert!(
        !reader_ok(&app, ws, outsider, topic).await,
        "not to someone outside the channel"
    );

    // Forget the item the fact came from: the summary that rested on it is hidden at once ...
    assert_eq!(forget_as(&app, ws, w.fx.human_b, ids[2]).await, Ok(1));
    assert!(
        !reader_ok(&app, ws, w.fx.human_b, topic).await,
        "hidden the moment a source is gone"
    );
    // ... RED: without the readable-sources test the old text stays visible.
    let mut tx = su.begin().await.unwrap();
    redefine(
        &mut tx,
        SUMMARY_OK,
        &[("AND NOT EXISTS (", "AND true OR NOT EXISTS (")],
    )
    .await;
    sqlx::query(
        "SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)",
    )
    .bind(ws.to_string())
    .bind(w.fx.human_b.to_string())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("SET LOCAL ROLE momo_app")
        .execute(&mut *tx)
        .await
        .unwrap();
    let leaked: bool = sqlx::query_scalar("SELECT mem_topic_summary_ok($1)")
        .bind(topic)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    eprintln!(
        "RED source-readable test removed: the summary of a forgotten fact is still shown = {leaked}"
    );
    assert!(leaked);

    // ... and the next pass deletes it (B-2) and writes it again from what is left.
    let before = w.provider.count();
    let stats = worker.consolidate_channel_now(ws, ch).await;
    assert_eq!(stats.topic_summaries, 1, "{stats:?}");
    assert!(
        (before..w.provider.count()).all(|i| !w.provider.prompt(i).contains("회식비")),
        "the new prompt never saw the forgotten fact"
    );
    let seen = summary_bodies(su, ch).await;
    assert_eq!(seen.len(), 1);
    assert!(
        !seen[0].contains("회식비") && seen[0].contains("배포는 금요일"),
        "{}",
        seen[0]
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn topic_calls_stop_at_the_token_cap_and_the_call_budget() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    *w.provider.reply_fn.lock().unwrap() = Some(topic_model());
    many_items(&w, ch, 45, "예산").await;
    sqlx::query("INSERT INTO mem_settings (workspace_id, scope, daily_token_cap) VALUES ($1, 'workspace', 10)")
        .bind(ws).execute(su).await.unwrap();
    let worker = worker_with(&w.provider, topic_config()).await;
    let stats = worker.consolidate_channel_now(ws, ch).await;
    assert_eq!(
        (stats.llm_calls, stats.cap_reached, stats.topic_assigned),
        (0, 1, 0),
        "{stats:?}"
    );
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
    let mut config = topic_config();
    config.memory.consolidate_max_calls = 2;
    let limited = worker_with(&w.provider, config).await;
    let stats = limited.consolidate_channel_now(ws, ch).await;
    // Two calls for judging near-duplicate pairs and — a separate budget of the same size — two of 20 items each.
    assert_eq!((stats.llm_calls, stats.pairs_judged), (4, 2), "{stats:?}");
    assert_eq!(stats.topic_assigned, 40, "two calls of 20 items: {stats:?}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn an_assignment_can_be_reverted_and_empty_topics_are_removed() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    *w.provider.reply_fn.lock().unwrap() = Some(topic_model());
    let worker = worker_with(&w.provider, topic_config()).await;
    let ids = many_items(&w, ch, 3, "되돌림").await;
    worker.consolidate_channel_now(ws, ch).await;
    let topic = topic_of(su, ids[0]).await.unwrap();
    let event = events(su, ids[0], "assigned").await[0].0;
    let kind = w
        .mem_call(move |conn| Box::pin(async move { cons::topic_revert(conn, event).await }))
        .await
        .expect("revert");
    assert_eq!(kind, "assigned");
    assert_eq!(topic_of(su, ids[0]).await, None);
    assert_eq!(events(su, ids[0], "reverted").await.len(), 1);
    // Retire every member: the topic is empty and the job removes it.
    sqlx::query(
        "UPDATE mem_item SET retired_at = now(), retired_reason = 'decayed' WHERE channel_id = $1",
    )
    .bind(ch)
    .execute(su)
    .await
    .unwrap();
    let stats = worker.consolidate_channel_now(ws, ch).await;
    assert!(stats.topics_gc >= 1, "{stats:?}");
    assert_eq!(
        scalar_i64(su, "SELECT count(*) FROM mem_topic WHERE id = $1", topic).await,
        0
    );
}

async fn gc_in_tx(su: &PgPool, ws: Uuid, ch: Uuid, edits: &[(&str, &[(&str, &str)])]) -> i32 {
    let mut tx = red_tx(su, ws, edits).await;
    let n: i32 = sqlx::query_scalar("SELECT mem_topic_gc($1)")
        .bind(ch)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    n
}

const GC: &str = "public.mem_topic_gc(uuid)";
const SUMMARY_WORK: &str = "public.mem_topic_summary_work(uuid, integer, integer, integer)";

/// B-1 (#3172 re-review): the item that named a topic is forgotten -> the label is dissolved and the rest are relabelled.
#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn forgetting_the_item_that_named_a_topic_dissolves_the_label() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let app = momo_app_pool().await;
    *w.provider.reply_fn.lock().unwrap() = Some(topic_model());
    let worker = worker_with(&w.provider, topic_config()).await;
    let ids = many_items(&w, ch, 5, "라벨").await;
    worker.consolidate_channel_now(ws, ch).await;
    let topic = topic_of(su, ids[0]).await.expect("assigned");
    let creator: Uuid =
        sqlx::query_scalar("SELECT created_by_item_id FROM mem_topic WHERE id = $1")
            .bind(topic)
            .fetch_one(su)
            .await
            .unwrap();
    assert!(ids.contains(&creator));
    assert_eq!(forget_as(&app, ws, w.fx.human_b, creator).await, Ok(1));
    // RED: without the dissolve step the label (born from the forgotten fact) stays.
    let kept = gc_in_tx(
        su,
        ws,
        ch,
        &[(
            GC,
            &[(
                "AND t.depth = 0 AND t.created_by_item_id IS NOT NULL",
                "AND false AND t.created_by_item_id IS NOT NULL",
            )],
        )],
    )
    .await;
    eprintln!("RED dissolve removed: gc removed {kept} topic(s), the forgotten fact's label stays");
    assert_eq!(kept, 0);
    assert!(gc_in_tx(su, ws, ch, &[]).await >= 1);
    // The real pass: the topic is dissolved, its items come back unassigned and are named again from live items.
    worker.consolidate_channel_now(ws, ch).await;
    assert_eq!(
        scalar_i64(su, "SELECT count(*) FROM mem_topic WHERE id = $1", topic).await,
        0
    );
    let (again, live_creator): (i64, i64) = (
        scalar_i64(su, "SELECT count(*) FROM mem_topic WHERE channel_id = $1", ch).await,
        scalar_i64(
            su,
            "SELECT count(*) FROM mem_topic t JOIN mem_item i ON i.id = t.created_by_item_id WHERE t.channel_id = $1",
            ch,
        )
        .await,
    );
    let _ = again;
    assert!(
        live_creator == 0 || live_creator == again,
        "every topic left is named by an item that still exists"
    );
    for id in ids.iter().filter(|i| **i != creator) {
        if let Some(t) = topic_of(su, *id).await {
            assert_ne!(t, topic);
        }
    }
}

/// B-2: summaries that rest on a dead item, or that belong to a topic that has been split, are deleted by the job.
#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn summaries_of_dead_items_and_split_parents_are_deleted() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    *w.provider.reply_fn.lock().unwrap() = Some(topic_model());
    let worker = worker_with(&w.provider, topic_config()).await;
    let ids = many_items(&w, ch, 5, "요약정리").await;
    worker.consolidate_channel_now(ws, ch).await;
    assert_eq!(summary_bodies(su, ch).await.len(), 1);
    let topic = topic_of(su, ids[0]).await.unwrap();

    // (a) a member is retired -> the summary that rested on it goes.
    sqlx::query("UPDATE mem_item SET retired_at = now(), retired_reason = 'decayed' WHERE id = $1")
        .bind(ids[4])
        .execute(su)
        .await
        .unwrap();
    let sabotage: &[(&str, &[(&str, &str)])] = &[(
        GC,
        &[(
            "WHERE s.workspace_id = v_ws AND s.channel_id = p_channel_id\n     AND (",
            "WHERE false AND s.workspace_id = v_ws AND s.channel_id = p_channel_id\n     AND (",
        )],
    )];
    let mut tx = red_tx(su, ws, sabotage).await;
    sqlx::query_scalar::<_, i32>("SELECT mem_topic_gc($1)")
        .bind(ch)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    sqlx::query("RESET ROLE").execute(&mut *tx).await.unwrap();
    let left: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mem_topic_summary WHERE topic_id = $1")
            .bind(topic)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    tx.rollback().await.unwrap();
    eprintln!(
        "RED summary cleanup removed: summaries left for a topic with a dead source = {left}"
    );
    assert_eq!(left, 1);
    worker.consolidate_channel_now(ws, ch).await;
    let bodies = summary_bodies(su, ch).await;
    assert_eq!(
        bodies.len(),
        1,
        "deleted, then written again from the live items"
    );

    // (b) the topic gets children (a split): the parent's summary goes even though its items are alive.
    let child: Uuid = sqlx::query_scalar(
        "INSERT INTO mem_topic (workspace_id, channel_id, parent_id, depth, label, label_key) VALUES ($1, $2, $3, 1, '하위 주제', '하위 주제') RETURNING id",
    )
    .bind(ws)
    .bind(ch)
    .bind(topic)
    .fetch_one(su)
    .await
    .unwrap();
    sqlx::query("UPDATE mem_item SET topic_id = $1 WHERE topic_id = $2")
        .bind(child)
        .bind(topic)
        .execute(su)
        .await
        .unwrap();
    sqlx::query("DELETE FROM mem_topic_summary WHERE topic_id = $1")
        .bind(topic)
        .execute(su)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO mem_topic_summary (topic_id, workspace_id, channel_id, body, item_ids, item_hash, prompt_version) \
         SELECT $1, $2, $3, '옛 부모 요약', array_agg(id), 'x', 'topic-v1' FROM mem_item WHERE topic_id = $4 AND retired_at IS NULL",
    )
    .bind(topic)
    .bind(ws)
    .bind(ch)
    .bind(child)
    .execute(su)
    .await
    .unwrap();
    let sabotage: &[(&str, &[(&str, &str)])] = &[(
        GC,
        &[(
            "(EXISTS (SELECT 1 FROM public.mem_topic c WHERE c.parent_id = s.topic_id)",
            "(false",
        )],
    )];
    let mut tx = red_tx(su, ws, sabotage).await;
    sqlx::query_scalar::<_, i32>("SELECT mem_topic_gc($1)")
        .bind(ch)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    sqlx::query("RESET ROLE").execute(&mut *tx).await.unwrap();
    let left: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mem_topic_summary WHERE topic_id = $1")
            .bind(topic)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    tx.rollback().await.unwrap();
    eprintln!(
        "RED split-parent cleanup removed: the parent's summary is kept = {}",
        left == 1
    );
    assert_eq!(left, 1);
    gc_in_tx(su, ws, ch, &[]).await; // rolled back: only the count matters below
    worker.consolidate_channel_now(ws, ch).await;
    assert_eq!(
        scalar_i64(
            su,
            "SELECT count(*) FROM mem_topic_summary WHERE topic_id = $1",
            topic
        )
        .await,
        0,
        "the split parent has no summary"
    );
}

/// B-3: a closed decision (an old value) and a retired item never feed a topic summary.
#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn closed_decisions_never_feed_a_topic_summary() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    *w.provider.reply_fn.lock().unwrap() = Some(topic_model());
    let worker = worker_with(&w.provider, topic_config()).await;
    let m = w.say("결정 근거").await;
    let mut ids = Vec::new();
    for (i, body) in [
        "배포는 금요일",
        "문서는 위키에",
        "리뷰는 이틀 안에",
        "회의는 월요일",
    ]
    .iter()
    .enumerate()
    {
        let mut sp = spec("decision", "extracted", body, ago(10 - i as i64), &[m]);
        sp.subject = Some(["배포", "문서", "리뷰", "회의"][i]);
        ids.push(put_item(su, ws, ch, sp).await);
    }
    worker.consolidate_channel_now(ws, ch).await;
    let old = ids[0];
    sqlx::query("UPDATE mem_item SET valid_to = now() - interval '1 day' WHERE id = $1")
        .bind(old)
        .execute(su)
        .await
        .unwrap();
    // The old summary (which still says the old value) is gone, so the topic is due for a new one.
    sqlx::query("DELETE FROM mem_topic_summary WHERE channel_id = $1")
        .bind(ch)
        .execute(su)
        .await
        .unwrap();
    let ask = |edits: Vec<(&'static str, Vec<(&'static str, &'static str)>)>| async move {
        let refs: Vec<(&str, &[(&str, &str)])> =
            edits.iter().map(|(f, e)| (*f, e.as_slice())).collect();
        let mut tx = red_tx(su, ws, &refs).await;
        let got: Vec<Uuid> =
            sqlx::query_scalar("SELECT item_id FROM mem_topic_summary_work($1, 5, 3, 30)")
                .bind(ch)
                .fetch_all(&mut *tx)
                .await
                .unwrap();
        tx.rollback().await.unwrap();
        got
    };
    let got = ask(vec![]).await;
    assert_eq!(
        got.len(),
        3,
        "three open decisions, the closed one is left out: {got:?}"
    );
    assert!(!got.contains(&old));
    let got = ask(vec![(
        SUMMARY_WORK,
        vec![("AND i.valid_to IS NULL  -- B-3", "AND true  -- B-3")],
    )])
    .await;
    eprintln!(
        "RED valid_to filter removed: the closed decision feeds the summary = {}",
        got.contains(&old)
    );
    assert!(got.contains(&old));
    // The summary written by the next pass says nothing about the old value.
    let before = w.provider.count();
    worker.consolidate_channel_now(ws, ch).await;
    assert!((before..w.provider.count()).all(|i| !w.provider.prompt(i).contains("배포는 금요일")));
}

/// B-4: no runtime role reads the topic tables until a read route exists.
#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn the_api_role_cannot_read_the_topic_tables() {
    let w = world().await;
    let (su, ws) = (&w.su, w.fx.ws);
    let app = momo_app_pool().await;
    for table in ["mem_topic", "mem_topic_summary"] {
        let has: bool = sqlx::query_scalar("SELECT has_table_privilege('momo_app', $1, 'SELECT')")
            .bind(format!("public.{table}"))
            .fetch_one(su)
            .await
            .unwrap();
        assert!(!has, "{table}");
        let sql = format!("SELECT count(*) FROM {table}");
        let refused = with_tenant_tx(&app, ws, move |conn| {
            Box::pin(async move {
                sqlx::query_scalar::<_, i64>(&sql)
                    .fetch_one(&mut *conn)
                    .await?;
                Ok(())
            })
        })
        .await;
        assert_eq!(sqlstate_of(refused).await, "42501", "{table}");
    }
    // RED: the grant is what would open it.
    let mut tx = su.begin().await.unwrap();
    sqlx::query("GRANT SELECT ON mem_topic TO momo_app")
        .execute(&mut *tx)
        .await
        .unwrap();
    let has: bool =
        sqlx::query_scalar("SELECT has_table_privilege('momo_app', 'public.mem_topic', 'SELECT')")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    tx.rollback().await.unwrap();
    eprintln!("RED SELECT granted: the API role can read topics = {has}");
    assert!(has);
}

/// B-6: bidi / zero-width characters are refused in labels and summaries; summaries get the label neutralisation.
#[tokio::test]
#[ignore = "needs DATABASE_URL to an isolated pgvector/pg18 DB"]
async fn invisible_format_characters_are_refused_and_summaries_are_neutralised() {
    let w = world().await;
    let (su, ws, ch) = (&w.su, w.fx.ws, w.fx.channel);
    let ids = many_items(&w, ch, 3, "문자").await;
    for label in ["운영\u{202E}규칙", "운영\u{200B}규칙", "\u{FEFF}운영규칙"] {
        let sql = format!("SELECT mem_topic_assign('{}', NULL, '{label}', 60)", ids[0]);
        let mut tx = red_tx(su, ws, &[]).await;
        let refused = sqlx::query_scalar::<_, Option<Uuid>>(&sql)
            .fetch_one(&mut *tx)
            .await;
        assert_eq!(
            refused.map_err(|e| mem::sqlstate(&momo_db::DbError::from(e))),
            Err(Some("23514".to_string())),
            "{label:?}"
        );
        tx.rollback().await.unwrap();
    }
    let sql = format!(
        "SELECT mem_topic_assign('{}', NULL, '운영\u{202E}규칙', 60)",
        ids[0]
    );
    let mut tx = red_tx(
        su,
        ws,
        &[(
            LABEL_CLEAN,
            &[(
                "AND c !~ '[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]'",
                "",
            )],
        )],
    )
    .await;
    let stored: Option<Uuid> = sqlx::query_scalar(&sql).fetch_one(&mut *tx).await.unwrap();
    tx.rollback().await.unwrap();
    eprintln!(
        "RED invisible-character check removed: a label with a bidi override is stored = {}",
        stored.is_some()
    );
    assert!(stored.is_some());

    // Summaries: the same neutralisation as labels, and no invisible format characters.
    *w.provider.reply_fn.lock().unwrap() = Some(topic_model());
    let worker = worker_with(&w.provider, topic_config()).await;
    worker.consolidate_channel_now(ws, ch).await;
    let topic = topic_of(su, ids[0]).await.expect("assigned");
    let items = format!("ARRAY['{}','{}','{}']::uuid[]", ids[0], ids[1], ids[2]);
    let set = |body: &str| {
        format!("SELECT mem_topic_set_summary('{topic}', '{body}', {items}, 'm', 'v')")
    };
    let mut tx = red_tx(su, ws, &[]).await;
    sqlx::query_scalar::<_, bool>(&set("a<b>{c}`d`"))
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    sqlx::query("RESET ROLE").execute(&mut *tx).await.unwrap();
    let stored: String =
        sqlx::query_scalar("SELECT body FROM mem_topic_summary WHERE topic_id = $1")
            .bind(topic)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(stored, "a＜b＞｛c｝｀d｀");
    tx.rollback().await.unwrap();
    for body in ["결정\u{202E}확정", "결\u{200B}정"] {
        let mut tx = red_tx(su, ws, &[]).await;
        let refused = sqlx::query_scalar::<_, bool>(&set(body))
            .fetch_one(&mut *tx)
            .await;
        assert_eq!(
            refused.map_err(|e| mem::sqlstate(&momo_db::DbError::from(e))),
            Err(Some("23514".to_string())),
            "{body:?}"
        );
        tx.rollback().await.unwrap();
    }
}
