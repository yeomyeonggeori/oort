//! #4656 / ADR-0200 증보 7 (7-S1 + 7-S2) — the agent's activity report, end to end, on a real
//! PostgreSQL with the `momo_app` (NOBYPASSRLS) role and two tenants.
//!
//! Every test names the branch it proves in a "Tamper table": the line to remove and the
//! assertion that must turn red. A compile failure is not a red.
use super::*;

/// A marker that no honest label contains: it must never come back in an answer, an audit row
/// or any column outside the ledger.
const MARK: &str = "SECRETMARK4656";

/// `oort_run_event` with this lease, the way an adapter sends it.
async fn send(
    client: &reqwest::Client,
    base: &str,
    fixture: &Fixture,
    handle: &str,
    extra: Value,
) -> (u16, Value) {
    let mut arguments = json!({"leaseHandle": handle});
    arguments
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().expect("arguments object").clone());
    call(
        client,
        base,
        &fixture.hosted_bearer,
        "oort_run_event",
        arguments,
    )
    .await
}

/// `(id, kind, label, status, n)` of every `activity` ledger row of the run, oldest first.
type ActivityRow = (String, String, Option<String>, String, i32);

async fn activity_rows(su: &PgPool, run: Uuid) -> Vec<ActivityRow> {
    sqlx::query_as(
        "SELECT activity_id, activity_kind, label, activity_status, activity_n \
           FROM agent_run_event WHERE run_id=$1 AND kind='activity' ORDER BY seq",
    )
    .bind(run)
    .fetch_all(su)
    .await
    .expect("activity rows")
}

async fn plan_rows(su: &PgPool, run: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT plan FROM agent_run_event WHERE run_id=$1 AND kind='plan' ORDER BY seq",
    )
    .bind(run)
    .fetch_all(su)
    .await
    .expect("plan rows")
}

/// `(kind, completed_units, failed_units)` of the run's total table.
async fn tally(su: &PgPool, run: Uuid) -> Vec<(String, i64, i64)> {
    sqlx::query_as(
        "SELECT kind, completed_units, failed_units FROM agent_run_activity_tally \
          WHERE run_id=$1 ORDER BY kind",
    )
    .bind(run)
    .fetch_all(su)
    .await
    .expect("activity tally")
}

async fn stage_rows(su: &PgPool, run: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT stage FROM agent_run_event WHERE run_id=$1 AND kind='stage' ORDER BY seq",
    )
    .bind(run)
    .fetch_all(su)
    .await
    .expect("stage rows")
}

fn act(id: &str, kind: &str, status: &str, n: i64) -> Value {
    json!({"id": id, "kind": kind, "status": status, "n": n})
}

/// A new hosted run row (queued), the way a mention would leave it.
async fn new_run(su: &PgPool, fixture: &Fixture, channel: Uuid) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status) \
         VALUES ($1,$2,$3,'queued') RETURNING id",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .bind(channel)
    .fetch_one(su)
    .await
    .expect("run row")
}

/// The SQL writer called as the real runtime role under a tenant GUC — what the tool path
/// ends up doing, with the Rust layer's caps (8 per call, 12 steps) not in the way.
async fn record_as_app(
    app: &PgPool,
    workspace: Uuid,
    run: Uuid,
    actor: Uuid,
    activities: Option<Value>,
    plan: Option<Value>,
) -> i32 {
    let mut tx = app.begin().await.expect("tx");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(workspace.to_string())
        .execute(&mut *tx)
        .await
        .expect("guc");
    let written: i32 = sqlx::query_scalar("SELECT agent_run_activity_record($1,$2,$3,$4,$5)")
        .bind(workspace)
        .bind(run)
        .bind(actor)
        .bind(activities)
        .bind(plan)
        .fetch_one(&mut *tx)
        .await
        .expect("record");
    tx.commit().await.expect("commit");
    written
}

fn expected_data(field: &str, rule: &str, index: Option<u64>) -> Value {
    match index {
        Some(index) => json!({"field": field, "rule": rule, "index": index}),
        None => json!({"field": field, "rule": rule}),
    }
}

/// RED PROOF (ADR-0200 증보 7 7-A1·7-A2·7-A3·7-A4). A report with one bad item is refused
/// WHOLE: -32602, the fixed sentence, `error.data {field, rule, index?}` from the closed list,
/// nothing written (ledger, total, `output.stages`, `step_count`, the stage riding in the same
/// call), and the value the agent sent comes back nowhere — not in the answer, not in an audit
/// row. A refusal on a live lease leaves ONE audit row of closed words and a counter. Exactly
/// 40 / 60 characters pass; the `stage` ceiling stays at 80.
///
/// Tamper table (each applied and seen red):
///   * drop the `/` `\` check in `momo_wire::report_text::checked_report_text` -> the `/` label reaches the SQL backstop (a 500, not a 400)
///   * drop `is_unsafe_char` in `momo_wire::report_text::checked_text`         -> the control / bidi labels are accepted
///   * raise the label limit to 41 in `MAX_ACTIVITY_LABEL_CHARS`               -> the 41-character label is accepted
///   * drop the alphabet check in `validated_id`                               -> `a.b`, `a b` are accepted
///   * drop `"enum": RUN_ACTIVITY_KINDS` from the schema                       -> kind `think` reaches the handler
///   * drop `maxItems` from `run_activities_schema`                            -> the 9th activity is accepted
///   * judge the report AFTER `record_gateway_event_in_tx` instead of before   -> the stage in a refused call is written
///   * pass `violation` as `None` in `write_report_rejected_audit` for a report -> the audit row loses `field`/`rule`
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_refused_report_is_refused_whole_names_only_closed_words_and_writes_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (handle, run) = claimed_run_3516(&client, &base, &su, &fixture).await;

    let label = |text: String| json!({"activities": [{"id": "a1", "kind": "read", "status": "completed", "label": text}]});
    let plan = |text: String| json!({"plan": [{"text": "ok", "status": "pending"}, {"text": text, "status": "pending"}]});
    let id = |text: &str| json!({"activities": [act("ok1", "read", "completed", 1), {"id": text, "kind": "read", "status": "completed"}]});
    // (arguments, field, rule, index, is judged after the lease check — leaves an audit row)
    let character_layer: Vec<(Value, &str, &str, Option<u64>)> = vec![
        (
            label(format!("{MARK}/x")),
            "activities.label",
            "forbidden",
            Some(0),
        ),
        (
            label(format!("{MARK}\\x")),
            "activities.label",
            "forbidden",
            Some(0),
        ),
        (
            label(format!("{MARK}\u{7}")),
            "activities.label",
            "forbidden",
            Some(0),
        ),
        (
            label(format!("{MARK}\u{202E}")),
            "activities.label",
            "forbidden",
            Some(0),
        ),
        (
            label(format!("{MARK}\u{200B}")),
            "activities.label",
            "forbidden",
            Some(0),
        ),
        (label("가".repeat(41)), "activities.label", "range", Some(0)),
        (
            label("   ".to_string()),
            "activities.label",
            "range",
            Some(0),
        ),
        (plan(format!("{MARK}/x")), "plan.text", "forbidden", Some(1)),
        (
            plan(format!("{MARK}\\x")),
            "plan.text",
            "forbidden",
            Some(1),
        ),
        (
            plan(format!("{MARK}\u{202E}")),
            "plan.text",
            "forbidden",
            Some(1),
        ),
        (plan("나".repeat(61)), "plan.text", "range", Some(1)),
        (id("a.b"), "activities.id", "format", Some(1)),
        (id("a b"), "activities.id", "format", Some(1)),
        (
            id(&format!("{MARK}/x")),
            "activities.id",
            "forbidden",
            Some(1),
        ),
        (
            id(&format!("{MARK}\\x")),
            "activities.id",
            "forbidden",
            Some(1),
        ),
    ];
    // judged by the schema before the handler runs: refused the same way, no audit row (no
    // lease context yet), and the same `{field, rule, index}` shape
    let schema_layer: Vec<(Value, &str, &str, Option<u64>)> = vec![
        (
            json!({"activities": (0..9).map(|i| act(&format!("a{i}"), "read", "completed", 1)).collect::<Vec<_>>()}),
            "activities",
            "range",
            None,
        ),
        (
            json!({"plan": (0..13).map(|i| json!({"text": format!("s{i}"), "status": "pending"})).collect::<Vec<_>>()}),
            "plan",
            "range",
            None,
        ),
        (
            json!({"activities": [{"id": "a1", "kind": "think", "status": "completed"}]}),
            "activities.kind",
            "enum",
            Some(0),
        ),
        (
            json!({"activities": [{"id": "a1", "kind": "read", "status": "pending"}]}),
            "activities.status",
            "enum",
            Some(0),
        ),
        (
            json!({"activities": [{"id": "x".repeat(33), "kind": "read", "status": "completed"}]}),
            "activities.id",
            "range",
            Some(0),
        ),
        (
            json!({"activities": [{"id": "a1", "kind": "read", "status": "completed", "cmd": MARK}]}),
            "activities",
            "forbidden",
            Some(0),
        ),
        (
            json!({"activities": [{"id": "a1", "kind": "read", "status": "completed", "n": 0}]}),
            "activities.n",
            "range",
            Some(0),
        ),
        (
            json!({"activities": [{"id": "a1", "kind": "read", "status": "completed", "n": 100_001}]}),
            "activities.n",
            "range",
            Some(0),
        ),
        (
            json!({"plan": [{"text": "a", "status": "failed"}]}),
            "plan.status",
            "enum",
            Some(0),
        ),
    ];

    let before = (
        activity_rows(&su, run).await,
        plan_rows(&su, run).await,
        tally(&su, run).await,
        stage_rows(&su, run).await,
        run_record_3516(&su, run).await,
    );
    let mut attempts = 0u64;
    for (layer, cases) in [("character", &character_layer), ("schema", &schema_layer)] {
        for (extra, field, rule, index) in cases {
            // the same refused call also carries a stage: it must not be written either
            let mut arguments = extra.clone();
            arguments["stage"] = json!("원자성 단계");
            let (status, answer) = send(&client, &base, &fixture, &handle, arguments).await;
            assert_eq!(status, 400, "{layer} {field}: {answer}");
            assert_eq!(error_code(&answer), -32602, "{layer} {field}: {answer}");
            assert_eq!(answer["error"]["message"], json!("invalid tool arguments"));
            assert_eq!(
                answer["error"]["data"],
                expected_data(field, rule, *index),
                "{layer}: {extra}"
            );
            assert!(
                !answer.to_string().contains(MARK),
                "the sent value came back: {answer}"
            );
            if layer == "character" {
                attempts += 1;
            }
        }
    }
    let after = (
        activity_rows(&su, run).await,
        plan_rows(&su, run).await,
        tally(&su, run).await,
        stage_rows(&su, run).await,
        run_record_3516(&su, run).await,
    );
    assert_eq!(
        after, before,
        "a refused call writes nothing: no row, no total, no stage, no step"
    );
    assert!(
        !after.3.contains(&"원자성 단계".to_string()),
        "the stage of a refused call is not kept"
    );

    // one audit row per character-layer refusal, closed words and a counter only
    let audits = rejected_audits_3516(&su, run).await;
    assert_eq!(audits.len() as u64, attempts, "{audits:?}");
    for (position, audit) in audits.iter().enumerate() {
        let mut keys: Vec<&str> = audit
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["attempt", "field", "reason", "rule", "run_id", "schema", "tool"],
            "{audit}"
        );
        assert_eq!(audit["tool"], json!("oort_run_event"));
        assert_eq!(
            audit["attempt"],
            json!(position as u64 + 1),
            "the counter is per run and tool"
        );
        let (_, field, rule, _) = &character_layer[position];
        assert_eq!(audit["field"], json!(field));
        assert_eq!(audit["rule"], json!(rule));
        assert_eq!(
            audit["reason"],
            json!(if field.starts_with("plan") {
                "plan_invalid"
            } else {
                "activities_invalid"
            })
        );
    }
    let marked: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE detail::text LIKE $1")
            .bind(format!("%{MARK}%"))
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(marked, 0, "no audit row holds what the agent sent");
    // the refused call is still one ordinary `tool_call` row with a closed code (migration 133)
    let refused_codes: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run_event WHERE run_id=$1 AND kind='tool_call' AND code='invalid_arguments'",
    )
    .bind(run)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(refused_codes >= attempts as i64, "{refused_codes}");

    // the bounds are inclusive: 40 / 60 characters, 32-character id, 80-character stage
    let (status, ok) = send(
        &client,
        &base,
        &fixture,
        &handle,
        json!({
            "stage": "단".repeat(80),
            "activities": [{"id": "x".repeat(32), "kind": "read", "status": "completed", "label": "가".repeat(40), "n": 100_000}],
            "plan": [{"text": "나".repeat(60), "status": "in_progress"}]
        }),
    )
    .await;
    assert_eq!(status, 200, "{ok}");
    assert_eq!(activity_rows(&su, run).await.len(), 1);
    assert_eq!(plan_rows(&su, run).await.len(), 1);
    assert_eq!(stage_rows(&su, run).await, vec!["단".repeat(80)]);
    // a 41-character stage is still accepted (the server ceiling stays at 80), 81 is not
    let (status, ok) = send(
        &client,
        &base,
        &fixture,
        &handle,
        json!({"stage": "단".repeat(41)}),
    )
    .await;
    assert_eq!(status, 200, "{ok}");
    let (status, refused) = send(
        &client,
        &base,
        &fixture,
        &handle,
        json!({"stage": "단".repeat(81)}),
    )
    .await;
    assert_eq!(status, 400, "{refused}");
    assert_eq!(error_code(&refused), -32602);
    assert_eq!(
        refused["error"].get("data"),
        None,
        "a stage fault stays the plain refusal"
    );
}

/// RED PROOF (ADR-0200 증보 7 7-A4·7-A5·7-A6). One call writes stage, activities and plan in
/// one transaction; a replay of the same `eventId` writes nothing; a repeat folds; a change is
/// a new row; the read shows the newest row per id; the total is "each id's LAST ended report",
/// so a resend or a correction is never counted twice; a repeated stage still folds when
/// activity rows sit between.
///
/// Tamper table:
///   * drop the fold `CONTINUE` in `agent_run_activity_record`        -> the repeated report adds rows
///   * drop the "take the previous ended value off" block             -> 5 then 7 reads 12; completed -> failed double counts
///   * drop `v_last.activity_status IN ('completed','failed')` guard  -> in_progress -> completed double counts
///   * copy `now()` instead of `v_last.activity_started_at`           -> `activity_started_at` drifts per row
///   * revert `kind NOT IN ('tool_call','activity','plan')` in `agent_run_event_append` -> the repeated stage adds a row
///   * drop `run_event_recorded` early return for the replay          -> the replayed call writes again
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn repeats_fold_changes_append_and_the_total_follows_each_ids_last_ended_report() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (handle, run) = claimed_run_3516(&client, &base, &su, &fixture).await;
    let report = |activities: Value| {
        let (client, base, fixture, handle) = (&client, &base, &fixture, &handle);
        async move {
            let (status, answer) = send(
                client,
                base,
                fixture,
                handle,
                json!({"activities": activities}),
            )
            .await;
            assert_eq!(status, 200, "{answer}");
        }
    };

    // 7-A4: one call, one transaction, one `eventId`
    let event_id = Uuid::new_v4();
    let whole = json!({
        "eventId": event_id,
        "stage": "단계 하나",
        "activities": [act("a1", "read", "in_progress", 1)],
        "plan": [{"text": "읽기", "status": "in_progress"}]
    });
    let (status, answer) = send(&client, &base, &fixture, &handle, whole.clone()).await;
    assert_eq!(status, 200, "{answer}");
    let counts = |su: PgPool| async move {
        let total: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_run_event WHERE run_id=$1 AND kind IN ('stage','activity','plan')")
            .bind(run)
            .fetch_one(&su)
            .await
            .unwrap();
        let audits: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_log WHERE run_id=$1 AND action='agent.gateway.status'",
        )
        .bind(run)
        .fetch_one(&su)
        .await
        .unwrap();
        (total, audits)
    };
    let first = counts(su.clone()).await;
    assert_eq!(first.0, 3, "stage + activity + plan");
    let (status, answer) = send(&client, &base, &fixture, &handle, whole).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(
        counts(su.clone()).await,
        first,
        "a replay adds no row and no audit row"
    );
    let status_audit: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE run_id=$1 AND action='agent.gateway.status' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(run)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(status_audit["activity_count"], json!(1));
    assert_eq!(status_audit["plan_steps"], json!(1));

    // 7-A5: the repeat folds, the change appends
    report(json!([act("a1", "read", "in_progress", 1)])).await;
    assert_eq!(
        activity_rows(&su, run).await.len(),
        1,
        "same content: folded"
    );
    report(json!([{"id": "a1", "kind": "read", "status": "in_progress", "label": "읽는 중"}]))
        .await;
    assert_eq!(
        activity_rows(&su, run).await.len(),
        2,
        "a label appearing is a change"
    );
    report(json!([{"id": "a1", "kind": "read", "status": "in_progress", "label": "읽는 중"}]))
        .await;
    assert_eq!(activity_rows(&su, run).await.len(), 2);

    // 7-A6: the total is each id's last ended value
    assert_eq!(tally(&su, run).await, vec![], "in_progress counts nothing");
    report(json!([act("a1", "read", "completed", 5)])).await;
    assert_eq!(tally(&su, run).await, vec![("read".to_string(), 5, 0)]);
    report(json!([act("a1", "read", "completed", 5)])).await;
    assert_eq!(
        tally(&su, run).await,
        vec![("read".to_string(), 5, 0)],
        "a resend is not counted twice"
    );
    report(json!([act("a1", "read", "completed", 7)])).await;
    assert_eq!(
        tally(&su, run).await,
        vec![("read".to_string(), 7, 0)],
        "a correction replaces, it does not add (12)"
    );
    report(json!([act("a1", "read", "failed", 7)])).await;
    assert_eq!(
        tally(&su, run).await,
        vec![("read".to_string(), 0, 7)],
        "completed -> failed moves the units"
    );
    report(json!([act("a1", "read", "in_progress", 7)])).await;
    assert_eq!(
        tally(&su, run).await,
        vec![("read".to_string(), 0, 0)],
        "going back to in_progress takes them off"
    );
    report(json!([act("a1", "read", "completed", 3)])).await;
    report(json!([act("a1", "edit", "completed", 3)])).await;
    assert_eq!(
        tally(&su, run).await,
        vec![("edit".to_string(), 3, 0), ("read".to_string(), 0, 0)],
        "a changed kind moves the units to the new kind"
    );
    // two ids, one call; the same id twice in one call: the later wins and writes one row
    let rows_before = activity_rows(&su, run).await.len();
    report(json!([
        act("b2", "run", "in_progress", 1),
        act("b2", "run", "completed", 2)
    ]))
    .await;
    assert_eq!(
        activity_rows(&su, run).await.len(),
        rows_before + 1,
        "the earlier entry of a repeated id is dropped"
    );
    assert_eq!(
        tally(&su, run).await,
        vec![
            ("edit".to_string(), 3, 0),
            ("read".to_string(), 0, 0),
            ("run".to_string(), 2, 0)
        ]
    );

    // the first report time rides on every row of an id
    let started: Vec<(String, i64)> = sqlx::query_as(
        "SELECT activity_id, count(DISTINCT activity_started_at) FROM agent_run_event \
          WHERE run_id=$1 AND kind='activity' GROUP BY activity_id ORDER BY 1",
    )
    .bind(run)
    .fetch_all(&su)
    .await
    .unwrap();
    assert!(
        started.iter().all(|(_, distinct)| *distinct == 1),
        "{started:?}"
    );

    // the read: one row per id, the newest state, and the total
    let (status, body) = events_with_3840(&client, &base, &fixture, run, "?include=activity").await;
    assert_eq!(status, 200, "{body}");
    let shown: Vec<(String, String, String, i64)> = body["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["kind"] == json!("activity"))
        .map(|event| {
            let a = &event["activity"];
            (
                a["id"].as_str().unwrap().to_string(),
                a["kind"].as_str().unwrap().to_string(),
                a["status"].as_str().unwrap().to_string(),
                a["n"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        shown,
        vec![
            (
                "a1".to_string(),
                "edit".to_string(),
                "completed".to_string(),
                3
            ),
            (
                "b2".to_string(),
                "run".to_string(),
                "completed".to_string(),
                2
            )
        ],
        "the newest row per id, in the order of their last update"
    );
    assert_eq!(
        body["activityTally"],
        json!([{"kind": "run", "completed": 2, "failed": 0}, {"kind": "edit", "completed": 3, "failed": 0}]),
        "the vocabulary's order, kinds with nothing ended left out"
    );
    assert_eq!(
        body["activityRowsTrimmed"],
        json!(false),
        "the total equals what is shown"
    );

    // 7-A5: a repeated stage folds although activity rows sit between the two
    let stages_before = stage_rows(&su, run).await.len();
    let (status, _) = send(
        &client,
        &base,
        &fixture,
        &handle,
        json!({"stage": "같은 단계", "activities": [act("c3", "web", "in_progress", 1)]}),
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = send(
        &client,
        &base,
        &fixture,
        &handle,
        json!({"stage": "같은 단계", "activities": [act("c3", "web", "completed", 1)]}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        stage_rows(&su, run).await.len(),
        stages_before + 1,
        "the same stage is one row"
    );
}

/// RED PROOF (ADR-0200 증보 7 7-A7). Past 100 `activity` rows the roll removes, in this order:
/// (a) superseded rows, oldest first — the read does not change; (b) only then the newest row
/// of ENDED activities, oldest first — the id leaves whole; (c) only then in-progress ones. An
/// in-progress id (even the oldest row of the run) survives while an ended one remains, an old
/// row of a removed id never comes back, and the total never shrinks.
///
/// Tamper table:
///   * drop the (a) block of `agent_run_activity_trim`      -> s0 loses its completed row and its in-progress row comes back
///   * drop or reorder the (b) block (delete the oldest row of any status) -> the oldest in-progress id `u0` is rolled while ended ids remain
///   * drop the (c) block                                   -> a run of 101 open activities keeps 101 rows
///   * `LIMIT v_extra` -> `LIMIT 1` in a block              -> a burst leaves the run above 100
///   * decrement the total when a row is rolled             -> the total shrinks (99 -> 98)
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_roll_removes_superseded_then_ended_then_open_rows_and_never_shrinks_the_total() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    let (ws, agent) = (fixture.workspace, fixture.hosted_agent);
    let run = new_run(&su, &fixture, fixture.channel).await;
    let rec = |activities: Value| {
        let app = app.clone();
        async move { record_as_app(&app, ws, run, agent, Some(activities), None).await }
    };
    let rows_of = |id: &'static str| {
        let su = su.clone();
        async move {
            sqlx::query_as::<_, (String,)>(
                "SELECT activity_status FROM agent_run_event WHERE run_id=$1 AND kind='activity' AND activity_id=$2 ORDER BY seq",
            )
            .bind(run)
            .bind(id)
            .fetch_all(&su)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.0)
            .collect::<Vec<String>>()
        }
    };
    let shape = |su: PgPool| async move {
        sqlx::query_as::<_, (i64, i64)>(
            "SELECT count(*), count(DISTINCT activity_id) FROM agent_run_event WHERE run_id=$1 AND kind='activity'",
        )
        .bind(run)
        .fetch_one(&su)
        .await
        .unwrap()
    };

    assert_eq!(shape(su.clone()).await, (0, 0));
    // the OLDEST row of the run is an in-progress id that stays open the whole time
    rec(json!([act("u0", "other", "in_progress", 1)])).await;
    // phase 1: 50 ids, each reported in_progress and then completed = 100 more rows
    for i in 0..50 {
        rec(json!([act(&format!("s{i}"), "read", "in_progress", 1)])).await;
        rec(json!([act(&format!("s{i}"), "read", "completed", 1)])).await;
    }
    // 101 rows at the last insert: (a) rolled ONE superseded row, the oldest — s0's in_progress
    assert_eq!(shape(su.clone()).await, (100, 51));
    assert_eq!(
        rows_of("s0").await,
        vec!["completed"],
        "the superseded row went, the newest stays"
    );
    assert_eq!(
        rows_of("s1").await,
        vec!["in_progress", "completed"],
        "only as many as needed"
    );

    // phase 2: 49 more ended ids; every insert rolls one superseded row until none is left
    for i in 0..49 {
        rec(json!([act(&format!("t{i}"), "read", "completed", 1)])).await;
    }
    assert_eq!(
        shape(su.clone()).await,
        (100, 100),
        "one row per id: nothing superseded is left"
    );
    assert_eq!(rows_of("s49").await, vec!["completed"]);

    // phase 3: one more id. No superseded row exists, so (b) removes the oldest ENDED id whole
    // (s0) — not u0, although u0's row is the oldest of the run.
    rec(json!([act("v0", "read", "in_progress", 1)])).await;
    assert_eq!(shape(su.clone()).await, (100, 100));
    assert!(
        rows_of("s0").await.is_empty(),
        "an ended id leaves whole; no old row is left to come back"
    );
    assert_eq!(
        rows_of("u0").await,
        vec!["in_progress"],
        "an open activity outlives ended ones"
    );
    assert_eq!(rows_of("v0").await, vec!["in_progress"]);
    assert_eq!(
        rows_of("s1").await,
        vec!["in_progress", "completed"]
            .into_iter()
            .skip(1)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        tally(&su, run).await,
        vec![("read".to_string(), 99, 0)],
        "the total keeps what was rolled away"
    );
    // the read: one row per id (no revived s0), and the total is larger than what is shown
    let (status, body) = events_with_3840(&client, &base, &fixture, run, "?include=activity").await;
    assert_eq!(status, 200, "{body}");
    let shown: Vec<&str> = body["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == json!("activity"))
        .map(|e| e["activity"]["id"].as_str().unwrap())
        .collect();
    assert_eq!(shown.len(), 100);
    assert!(
        !shown.contains(&"s0"),
        "a rolled id is not revived by the newest-per-id read"
    );
    assert_eq!(
        body["activityTally"],
        json!([{"kind": "read", "completed": 99, "failed": 0}])
    );
    assert_eq!(
        body["activityRowsTrimmed"],
        json!(true),
        "99 units counted, 98 shown"
    );

    // (c): a run whose 100 activities are all still open rolls the oldest open one
    let open_run = new_run(&su, &fixture, fixture.channel).await;
    let many: Vec<Value> = (0..100)
        .map(|i| act(&format!("p{i}"), "run", "in_progress", 1))
        .collect();
    record_as_app(&app, ws, open_run, agent, Some(Value::Array(many)), None).await;
    record_as_app(
        &app,
        ws,
        open_run,
        agent,
        Some(json!([act("p100", "run", "in_progress", 1)])),
        None,
    )
    .await;
    let ids: Vec<String> = activity_rows(&su, open_run)
        .await
        .into_iter()
        .map(|r| r.0)
        .collect();
    assert_eq!(ids.len(), 100);
    assert!(
        !ids.contains(&"p0".to_string()),
        "the oldest open activity is the fallback"
    );
    assert!(ids.contains(&"p100".to_string()));
    assert_eq!(
        tally(&su, open_run).await,
        vec![],
        "nothing ended, nothing counted"
    );
}

/// RED PROOF (ADR-0200 증보 7 7-A8). The agent's rows live outside the 200-row stage window in
/// both directions: 100 activity rows do not push `stage` rows out (the window counts only the
/// rest), and the 201st non-agent row rolls the oldest `stage` rows without touching a single
/// activity row.
///
/// Tamper table:
///   * revert `kind NOT IN ('tool_call','activity','plan')` to `kind <> 'tool_call'` in `agent_run_event_trim`
///       -> 100 activity rows + 191 others = 291 > 200 and the oldest stage rows are deleted at once
///   * let `agent_run_activity_trim` count or delete `stage` rows -> the stage count or the 100 activity rows change
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_agent_rows_and_the_stage_window_never_push_each_other_out() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let (ws, agent) = (fixture.workspace, fixture.hosted_agent);
    let run = new_run(&su, &fixture, fixture.channel).await;
    let many: Vec<Value> = (0..100)
        .map(|i| act(&format!("p{i}"), "run", "in_progress", 1))
        .collect();
    record_as_app(
        &app,
        ws,
        run,
        agent,
        Some(Value::Array(many)),
        Some(json!([{"text": "계획", "status": "pending"}])),
    )
    .await;
    let stage = |i: usize| {
        let app = app.clone();
        async move {
            momo_db::with_tenant_tx(&app, ws, move |conn| {
                Box::pin(async move {
                    momo_agent::append_run_event_in_tx(
                        conn,
                        ws,
                        run,
                        momo_agent::AppendedRunEvent::Stage(&format!("단계 {i}")),
                        agent,
                    )
                    .await
                    .map(|_| ())
                })
            })
            .await
            .expect("stage append")
        }
    };
    for i in 0..190 {
        stage(i).await;
    }
    // 1 lifecycle row (`queued`) + 190 stage rows = 191 rows the window counts: nothing rolls,
    // although the run holds 292 rows altogether
    assert_eq!(
        stage_rows(&su, run).await.len(),
        190,
        "the agent's rows are not in the window"
    );
    assert_eq!(activity_rows(&su, run).await.len(), 100);
    for i in 190..205 {
        stage(i).await;
    }
    // 1 + 205 = 206 counted rows, 6 over: the OLDEST stage rows go, the activity rows do not
    let stages = stage_rows(&su, run).await;
    assert_eq!(stages.len(), 199);
    assert_eq!(
        stages.first().map(String::as_str),
        Some("단계 6"),
        "oldest first"
    );
    assert_eq!(
        activity_rows(&su, run).await.len(),
        100,
        "stage pressure never rolls an activity"
    );
    assert_eq!(plan_rows(&su, run).await.len(), 1);
}

/// RED PROOF (ADR-0200 증보 7 7-A9). A plan is replaced whole: a new plan supersedes the old
/// one, the same plan folds, `[]` clears, a call without `plan` leaves it, the plan rows roll
/// at 10 and the read shows the newest only. A first `[]` on a run with no plan is a no-op.
///
/// Tamper table:
///   * drop the plan fold (`IS DISTINCT FROM`)                    -> the same plan adds a row
///   * treat "no plan yet" as not-empty (drop the COALESCE)       -> a first `[]` writes a row
///   * drop the plan roll `OFFSET 10` block in `agent_run_activity_trim` -> 12 plan rows stay
///   * select the oldest plan row in the read                      -> the read shows a superseded plan
///   * write the plan when `plan` is omitted                       -> the omitted call adds a row
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_plan_replaces_the_whole_folds_clears_rolls_and_is_read_newest_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    let (handle, run) = claimed_run_3516(&client, &base, &su, &fixture).await;
    let plan = |steps: Value| {
        let (client, base, fixture, handle) = (&client, &base, &fixture, &handle);
        async move {
            let (status, answer) =
                send(client, base, fixture, handle, json!({"plan": steps})).await;
            assert_eq!(status, 200, "{answer}");
        }
    };
    let p1 =
        json!([{"text": "읽기", "status": "in_progress"}, {"text": "고치기", "status": "pending"}]);
    plan(p1.clone()).await;
    assert_eq!(plan_rows(&su, run).await, vec![p1.clone()]);
    plan(p1.clone()).await;
    assert_eq!(plan_rows(&su, run).await.len(), 1, "the same plan folds");
    let p2 = json!([{"text": "읽기", "status": "completed"}, {"text": "고치기", "status": "in_progress"}]);
    plan(p2.clone()).await;
    assert_eq!(
        plan_rows(&su, run).await,
        vec![p1.clone(), p2.clone()],
        "a new plan is a new row, the old one is superseded"
    );
    plan(json!([])).await;
    plan(json!([])).await;
    assert_eq!(
        plan_rows(&su, run).await.len(),
        3,
        "`[]` clears once, and clearing twice folds"
    );
    // a call that carries no `plan` leaves the plan as it is
    let (status, _) = send(
        &client,
        &base,
        &fixture,
        &handle,
        json!({"activities": [act("a1", "read", "completed", 1)]}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(plan_rows(&su, run).await.len(), 3);
    let (status, body) = events_with_3840(&client, &base, &fixture, run, "?include=activity").await;
    assert_eq!(status, 200, "{body}");
    let plans: Vec<&Value> = body["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == json!("plan"))
        .collect();
    assert_eq!(plans.len(), 1, "the newest plan only");
    assert_eq!(
        plans[0]["plan"],
        json!([]),
        "the newest plan is the cleared one"
    );

    plan(p2.clone()).await;
    // the roll: 12 more distinct plans leave at most 10 rows, the newest last
    for i in 0..12 {
        plan(json!([{"text": format!("계획 {i}"), "status": "pending"}])).await;
    }
    let rows = plan_rows(&su, run).await;
    assert_eq!(rows.len(), 10, "{rows:?}");
    assert_eq!(
        rows.last().unwrap(),
        &json!([{"text": "계획 11", "status": "pending"}])
    );
    assert!(!rows.contains(&p1), "the oldest plans were rolled");
    let (_, body) = events_with_3840(&client, &base, &fixture, run, "?include=activity").await;
    let plans: Vec<&Value> = body["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == json!("plan"))
        .collect();
    assert_eq!(plans.len(), 1);
    assert_eq!(
        plans[0]["plan"],
        json!([{"text": "계획 11", "status": "pending"}])
    );

    // a first `[]` on a run that has no plan writes nothing
    let fresh = new_run(&su, &fixture, fixture.channel).await;
    let written = record_as_app(
        &app,
        fixture.workspace,
        fresh,
        fixture.hosted_agent,
        None,
        Some(json!([])),
    )
    .await;
    assert_eq!(written, 0);
    assert!(plan_rows(&su, fresh).await.is_empty());
}

fn event_kinds(body: &Value) -> Vec<String> {
    kinds_of_3840(body)
}

/// `GET …/agent-runs/{run}/events{query}` as the person this token belongs to.
async fn events_as(
    client: &reqwest::Client,
    base: &str,
    jwt: &str,
    workspace: Uuid,
    run: Uuid,
    query: &str,
) -> (u16, Value) {
    let response = client
        .get(format!(
            "{base}/v1/workspaces/{workspace}/agent-runs/{run}/events{query}"
        ))
        .bearer_auth(jwt)
        .send()
        .await
        .expect("events responds");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

fn has_report_rows(body: &Value) -> bool {
    event_kinds(body)
        .iter()
        .any(|kind| kind == "activity" || kind == "plan")
}

/// RED PROOF (ADR-0200 증보 7 7-A10 + 7-A11). The agent's rows are opt-in: no `include`, or any
/// other combination, returns not one `activity` or `plan` row and none of the new fields;
/// `include=activity` returns them folded (and the total); a mistyped value is a 400; and the
/// read the helper's `get_agent_run` tool makes (`RunEventInclude::default()`) never carries an
/// agent's label into a model's context. Only the channel's ACTIVE members read: an admin who is
/// not in the channel, a member who left, another tenant's member, a DM's third person, and a
/// member of ANOTHER channel of the same workspace (who reads the run of the room they are in and
/// not this one) — the same 404 as a run that does not exist.
///
/// Tamper table:
///   * drop `AND e.kind NOT IN ('activity','plan')` from the base read      -> the default read holds the rows
///   * make `RunEventInclude::default()` `activity: true`                     -> the helper-path assertion turns red
///   * drop `m.left_at IS NULL` from the visibility join                      -> the member who left reads the rows
///   * drop the membership JOIN (workspace membership only)                   -> the admin / the DM's third person reads them
///   * drop `AND m.channel_id = r.channel_id` from the visibility join        -> the member of the other channel reads them
///   * drop `"activity" =>` from `parse_run_event_include`                    -> `include=activity` is a 400
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_agents_rows_are_opt_in_and_read_only_by_the_channels_active_members() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let other = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    let (ws, human) = (fixture.workspace, fixture.human);
    let (handle, run) = claimed_run_3516(&client, &base, &su, &fixture).await;
    let (status, answer) = send(
        &client,
        &base,
        &fixture,
        &handle,
        json!({
            "stage": "읽기 시작",
            "activities": [
                {"id": "a1", "kind": "read", "status": "completed", "label": "문서 읽기", "n": 4},
                act("b2", "run", "in_progress", 1)
            ],
            "plan": [{"text": "읽기", "status": "completed"}, {"text": "쓰기", "status": "pending"}]
        }),
    )
    .await;
    assert_eq!(status, 200, "{answer}");

    // 7-A10: nothing without the opt-in, whatever else is asked for
    for query in [
        "",
        "?include=",
        "?include=doorbell",
        "?include=tools",
        "?include=doorbell,tools",
    ] {
        let (status, body) = events_with_3840(&client, &base, &fixture, run, query).await;
        assert_eq!(status, 200, "{query}: {body}");
        assert!(!has_report_rows(&body), "{query}: {body}");
        assert!(
            body.get("activityTally").is_none() && body.get("activityRowsTrimmed").is_none(),
            "{query}: {body}"
        );
    }
    let (status, body) = events_with_3840(&client, &base, &fixture, run, "?include=activity").await;
    assert_eq!(status, 200, "{body}");
    let kinds = event_kinds(&body);
    assert_eq!(kinds.iter().filter(|k| *k == "activity").count(), 2);
    assert_eq!(kinds.iter().filter(|k| *k == "plan").count(), 1);
    assert!(
        !kinds.iter().any(|k| k == "tool_call"),
        "tools were not asked for"
    );
    assert_eq!(
        body["activityTally"],
        json!([{"kind": "read", "completed": 4, "failed": 0}])
    );
    assert_eq!(body["activityRowsTrimmed"], json!(false));
    let a1 = body["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["activity"]["id"] == json!("a1"))
        .unwrap();
    assert_eq!(a1["activity"]["label"], json!("문서 읽기"));
    assert_eq!(a1["activity"]["n"], json!(4));
    assert!(a1["activity"]["startedAtMs"].as_i64().unwrap() <= a1["createdAtMs"].as_i64().unwrap());
    let (_, everything) = events_with_3840(
        &client,
        &base,
        &fixture,
        run,
        "?include=doorbell,tools,activity",
    )
    .await;
    let all_kinds = event_kinds(&everything);
    assert!(
        all_kinds.iter().any(|k| k == "tool_call")
            && all_kinds.iter().any(|k| k == "activity")
            && all_kinds.iter().any(|k| k == "plan")
    );
    assert!(everything.get("toolTally").is_some() && everything.get("activityTally").is_some());
    let ordinals: Vec<i64> = everything["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["ordinal"].as_i64().unwrap())
        .collect();
    assert_eq!(
        ordinals,
        (1..=ordinals.len() as i64).collect::<Vec<_>>(),
        "ordinals count the merged list"
    );
    assert!(ordinals.len() <= 200 + 100 + 101);
    for bad in [
        "?include=bogus",
        "?include=activity,bogus",
        "?include=activities",
        "?include=Activity",
    ] {
        let (status, body) = events_with_3840(&client, &base, &fixture, run, bad).await;
        assert_eq!(status, 400, "{bad}: {body}");
    }

    // the helper's read: `RunEventInclude::default()` holds not one agent-written row
    let read_as_helper = |include: momo_agent::RunEventInclude| {
        let app = app.clone();
        async move {
            momo_db::with_tenant_tx(&app, ws, move |conn| {
                Box::pin(async move {
                    momo_agent::list_run_ledger_in_tx(conn, ws, run, human, include).await
                })
            })
            .await
            .expect("read")
            .expect("the run is visible to its channel's member")
        }
    };
    let by_default = read_as_helper(momo_agent::RunEventInclude::default()).await;
    assert!(by_default.events.iter().all(|e| e.kind != "activity"
        && e.kind != "plan"
        && e.activity.is_none()
        && e.plan.is_none()));
    assert!(by_default.activity_tally.is_none() && by_default.activity_rows_trimmed.is_none());
    let opted = read_as_helper(momo_agent::RunEventInclude {
        activity: true,
        ..Default::default()
    })
    .await;
    assert_eq!(
        opted.events.iter().filter(|e| e.kind == "activity").count(),
        2,
        "the opt-in is what opens them"
    );
    assert!(opted
        .events
        .iter()
        .any(|e| e.plan.as_ref().is_some_and(|p| p.len() == 2)));

    // 7-A11: the audience is the channel's ACTIVE members, read at the time of reading
    let run_text = run.to_string();
    let (admin, admin_jwt) = seed_human_2915(&su, &fixture, "admin", "관리자").await;
    let (status, hidden) = events_3741(&client, &base, &admin_jwt, &fixture, &run_text).await;
    assert_eq!(
        status, 404,
        "a workspace admin outside the channel reads nothing: {hidden}"
    );
    let (status, missing) = events_3741(
        &client,
        &base,
        &admin_jwt,
        &fixture,
        &Uuid::new_v4().to_string(),
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(
        hidden, missing,
        "a hidden run and a missing one answer alike: no existence oracle"
    );
    // A person who is an active member of ANOTHER channel of this workspace. The admin and the
    // DM's third person here are in no channel at all, so they cannot tell "a member of this
    // run's room" from "a member of some room of the workspace"; this person can. The control
    // first: the same person with the same token reads the run of the room they ARE in (with
    // the report rows), so the 404 below is the room and not a broken credential.
    let (elsewhere, elsewhere_jwt) = seed_human_2915(&su, &fixture, "member", "다른 방").await;
    add_member_2915(&su, ws, fixture.private_channel, elsewhere).await;
    let own_room_run = new_run(&su, &fixture, fixture.private_channel).await;
    record_as_app(
        &app,
        ws,
        own_room_run,
        fixture.hosted_agent,
        Some(json!([act("p1", "read", "completed", 2)])),
        None,
    )
    .await;
    let (status, body) = events_as(
        &client,
        &base,
        &elsewhere_jwt,
        ws,
        own_room_run,
        "?include=activity",
    )
    .await;
    assert_eq!(
        status, 200,
        "a member reads the run of their own room: {body}"
    );
    assert!(
        has_report_rows(&body),
        "…and its report rows with the opt-in: {body}"
    );
    let (status, other_room) =
        events_as(&client, &base, &elsewhere_jwt, ws, run, "?include=activity").await;
    assert_eq!(
        status, 404,
        "a member of another room of the workspace reads nothing of this one: {other_room}"
    );
    let (_, nothing_there) = events_as(
        &client,
        &base,
        &elsewhere_jwt,
        ws,
        Uuid::new_v4(),
        "?include=activity",
    )
    .await;
    assert_eq!(
        other_room, nothing_there,
        "the other room's run answers like a run that does not exist"
    );
    let leaver = seed_outsider_3741(&su, &fixture).await; // joined the channel, then left it
    let (status, body) = events_3741(&client, &base, &leaver, &fixture, &run_text).await;
    assert_eq!(status, 404, "a member who left reads nothing: {body}");
    let (status, body) = events_3741(&client, &base, &other.human_jwt, &fixture, &run_text).await;
    assert!(
        status == 403 || status == 404,
        "another tenant's member: {status} {body}"
    );
    assert!(
        body.get("events").is_none(),
        "another tenant's member gets no ledger: {body}"
    );
    // a member who is IN the channel, added after the report, reads it (membership is read now)
    add_member_2915(&su, ws, fixture.channel, admin).await;
    let (status, body) = events_3741(&client, &base, &admin_jwt, &fixture, &run_text).await;
    assert_eq!(status, 200, "{body}");
    sqlx::query("UPDATE membership SET left_at = now() WHERE workspace_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(ws)
        .bind(fixture.channel)
        .bind(admin)
        .execute(&su)
        .await
        .unwrap();
    let (status, _) = events_3741(&client, &base, &admin_jwt, &fixture, &run_text).await;
    assert_eq!(status, 404, "leaving the channel closes the read at once");

    // a DM run: its two people read it, the workspace's third person does not
    let dm = seed_dm_2915(&su, ws, human, &[human, fixture.hosted_agent]).await;
    let dm_run = new_run(&su, &fixture, dm).await;
    record_as_app(
        &app,
        ws,
        dm_run,
        fixture.hosted_agent,
        Some(json!([act("d1", "read", "completed", 1)])),
        None,
    )
    .await;
    let dm_text = dm_run.to_string();
    let (status, body) =
        events_with_3840(&client, &base, &fixture, dm_run, "?include=activity").await;
    assert_eq!(status, 200, "{body}");
    assert!(has_report_rows(&body));
    let (_, third_jwt) = seed_human_2915(&su, &fixture, "member", "제삼자").await;
    let (status, body) = {
        let response = client
            .get(format!(
                "{base}/v1/workspaces/{ws}/agent-runs/{dm_text}/events?include=activity"
            ))
            .bearer_auth(&third_jwt)
            .send()
            .await
            .unwrap();
        (
            response.status().as_u16(),
            response.json::<Value>().await.unwrap_or(Value::Null),
        )
    };
    assert_eq!(status, 404, "a DM's third person: {body}");
}

/// RED PROOF (ADR-0200 증보 7 7-A12). Nothing the agent reports is copied anywhere else: with a
/// unique mark in the id, the label and the plan step, and the run then finished (so the message,
/// the audit log, the outbox, the push and inbox candidates and the memory inputs all had their
/// chance), the mark exists in EVERY text/jsonb column of EVERY table only where the contract
/// puts it — `agent_run_event.activity_id`, `.label`, `.plan` — and the audit row of the call
/// holds counts, not text. The scan reads the catalog, so a table added later is covered too.
///
/// Tamper table:
///   * put the label in the `agent.gateway.status` audit detail      -> `audit_log.detail` hits
///   * copy a label into `output.stages` / `output`                   -> `agent_run.output` hits
///   * emit the label in the thin `agent.run.event` frame             -> `outbox.payload` hits
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn nothing_the_agent_reports_is_copied_outside_its_ledger_rows() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (handle, run) = claimed_run_3516(&client, &base, &su, &fixture).await;
    let (status, answer) = send(
        &client,
        &base,
        &fixture,
        &handle,
        json!({
            "stage": "표지 단계",
            "activities": [{"id": "MARK4656I", "kind": "read", "status": "completed", "label": "MARK4656L", "n": 3}],
            "plan": [{"text": "MARK4656P", "status": "pending"}]
        }),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let (status, done) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_complete",
        json!({"leaseHandle": handle, "status": "succeeded", "body": "끝"}),
    )
    .await;
    assert_eq!(status, 200, "{done}");

    let columns: Vec<(String, String)> = sqlx::query_as(
        "SELECT c.table_name::text, c.column_name::text \
           FROM information_schema.columns c \
           JOIN information_schema.tables t \
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name \
          WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' \
            AND c.data_type IN ('text', 'character varying', 'character', 'jsonb', 'json', 'ARRAY') \
          ORDER BY 1, 2",
    )
    .fetch_all(&su)
    .await
    .unwrap();
    // the scan must reach the places a copy would most plausibly land, not just "many columns"
    for (table, column) in [
        ("message", "body"),
        ("audit_log", "detail"),
        ("outbox", "payload"),
        ("agent_run", "output"),
        ("agent_run", "input"),
        ("agent_run_event", "label"),
        ("agent_run_event", "plan"),
        ("agent_run_event", "stage"),
    ] {
        assert!(
            columns.contains(&(table.to_string(), column.to_string())),
            "the scan does not cover {table}.{column}"
        );
    }
    assert!(
        columns.len() > 200,
        "the scan must cover the whole schema, saw {}",
        columns.len()
    );
    let mut hits: Vec<(String, String)> = Vec::new();
    for (table, column) in &columns {
        let found: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM \"{table}\" WHERE \"{column}\"::text LIKE '%MARK4656%'"
        ))
        .fetch_one(&su)
        .await
        .unwrap_or_else(|error| panic!("scan {table}.{column}: {error}"));
        if found > 0 {
            hits.push((table.clone(), column.clone()));
        }
    }
    assert_eq!(
        hits,
        vec![
            ("agent_run_event".to_string(), "activity_id".to_string()),
            ("agent_run_event".to_string(), "label".to_string()),
            ("agent_run_event".to_string(), "plan".to_string()),
        ],
        "the mark appears only in the three ledger columns that are the contract"
    );
    let audit: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE run_id=$1 AND action='agent.gateway.status' \
          AND detail ? 'activity_count' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(run)
    .fetch_one(&su)
    .await
    .expect("the call's audit row");
    assert_eq!(audit["activity_count"], json!(1));
    assert_eq!(audit["plan_steps"], json!(1));
    // no push or inbox candidate came out of an activity (7-8)
    let inbox_like: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind <> 'broadcast' AND payload::text LIKE '%MARK4656%'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(inbox_like, 0);
}

/// RED PROOF (ADR-0200 증보 7 7-A13). One call with a stage, eight activities and a plan is ONE
/// frame: `stage`, `activity` and `plan` share one 2-second window. The frame carries the kind
/// and the ids of the run and channel — no label, no activity id, no plan text — and after the
/// window the next report frames again.
///
/// Tamper table:
///   * remove `'activity','plan'` from the window in `agent_run_event_set_framed`  -> one frame per row (10)
///   * widen the window to include `tool_call`                                      -> tool calls frame
///   * put `NEW.label` into the frame payload in `agent_run_event_emit_frame`       -> the text scan finds the mark
///   * put `NEW.stage` in place of `channel_id` in that payload                      -> the channel id equality turns red
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn one_call_is_one_frame_without_any_of_the_agents_text_and_the_next_window_frames_again() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (handle, run) = claimed_run_3516(&client, &base, &su, &fixture).await;
    let before = frames_3744(&su, &fixture, run).await.len();
    let eight: Vec<Value> = (0..8)
        .map(|i| json!({"id": format!("a{i}"), "kind": "read", "status": "completed", "label": format!("{MARK}{i}"), "n": 1}))
        .collect();
    let (status, answer) = send(
        &client,
        &base,
        &fixture,
        &handle,
        json!({"stage": "프레임 단계", "activities": eight, "plan": [{"text": format!("{MARK}P"), "status": "pending"}]}),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let written: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run_event WHERE run_id=$1 AND kind IN ('stage','activity','plan')",
    )
    .bind(run)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        written, 10,
        "a stage row, eight activity rows and a plan row"
    );
    let frames = frames_3744(&su, &fixture, run).await;
    let kind_of = |frame: &Value| frame["payload"]["kind"].as_str().unwrap().to_string();
    // the lifecycle row the first report causes (`queued` -> `started`) always frames, by its
    // own rule; the window under test is `stage` + `activity` + `plan`
    let new: Vec<&Value> = frames[before..]
        .iter()
        .filter(|frame| ["stage", "activity", "plan"].contains(&kind_of(frame).as_str()))
        .collect();
    assert_eq!(
        new.len(),
        1,
        "one call is one frame, not ten: {:?}",
        &frames[before..]
    );
    let frame = new[0];
    let mut data_keys: Vec<&str> = frame
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    data_keys.sort_unstable();
    assert_eq!(data_keys, ["payload", "ts", "type", "v"]);
    let mut payload_keys: Vec<&str> = frame["payload"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    payload_keys.sort_unstable();
    assert_eq!(
        payload_keys,
        ["channel_id", "kind", "run_id"],
        "kind and two ids, nothing the agent wrote"
    );
    assert!(["stage", "activity", "plan"].contains(&frame["payload"]["kind"].as_str().unwrap()));
    // Nothing is left that could carry the agent's words: the three keys hold the run's id (it
    // is what found this frame), this channel's id and a kind, and the labels' mark is nowhere
    // in the frame. (A substring scan for the activity id `a0` is not usable on this text: it
    // holds two random UUIDs, and `a0` turns up inside one of them about one run in five.)
    assert_eq!(
        frame["payload"]["channel_id"],
        json!(fixture.channel.to_string())
    );
    assert!(!frame.to_string().contains(MARK), "{frame}");

    // inside the same window another report writes its row and puts no second frame on the topic
    let started = std::time::Instant::now();
    let (status, _) = send(
        &client,
        &base,
        &fixture,
        &handle,
        json!({"activities": [act("z9", "run", "in_progress", 1)]}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(activity_rows(&su, run).await.len(), 9);
    let after_first = frames.len();
    if started.elapsed() < std::time::Duration::from_millis(1_200) {
        assert_eq!(
            frames_3744(&su, &fixture, run).await.len(),
            after_first,
            "the window is shared, not per row"
        );
    }
    // after the window the next report frames again
    tokio::time::sleep(std::time::Duration::from_millis(2_100)).await;
    let (status, _) = send(
        &client,
        &base,
        &fixture,
        &handle,
        json!({"activities": [act("z9", "run", "completed", 1)]}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        frames_3744(&su, &fixture, run).await.len(),
        after_first + 1,
        "a new window frames again"
    );
}

/// RED PROOF (ADR-0200 증보 7 7-A14). A report that only carries activities still keeps the run
/// alive (`updated_at` moves) but is never a step: 200 reports at the 60-second cadence leave
/// `step_count` at 0 and `output.stages` empty, and the roll holds the rows at 100. A run that
/// awaits an approval, a run that is over and a cancelled run's acknowledgement take no activity:
/// 409, 409, and a silently dropped report (not a refusal), with the ledger unchanged.
///
/// Tamper table:
///   * call `record_stage_in_tx` for a report                         -> `step_count` / `output.stages` move
///   * drop `!run.status.is_terminal()` before the report write        -> the cancelled run's acknowledgement writes rows
///   * drop `hosted_lease &&` before the report write                   -> (REST callback) a managed run writes rows
///   * skip `mark_run_started_in_tx` for an activities-only call        -> `updated_at` does not move
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_report_keeps_the_run_alive_spends_no_step_and_is_not_taken_after_the_run_is_over() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (handle, run) = claimed_run_3516(&client, &base, &su, &fixture).await;
    let updated_at = || {
        let su = su.clone();
        async move {
            sqlx::query_scalar::<_, chrono::DateTime<chrono::Utc>>(
                "SELECT updated_at FROM agent_run WHERE id=$1",
            )
            .bind(run)
            .fetch_one(&su)
            .await
            .unwrap()
        }
    };
    let steps_before = run_record_3516(&su, run).await;
    let t0 = updated_at().await;
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    let (status, answer) = send(
        &client,
        &base,
        &fixture,
        &handle,
        json!({"activities": [act("a1", "read", "in_progress", 1)]}),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert!(
        updated_at().await > t0,
        "an activities-only call is still a sign of life"
    );

    for i in 0..200 {
        let status_word = if i % 2 == 0 {
            "in_progress"
        } else {
            "completed"
        };
        let (status, answer) = send(
            &client,
            &base,
            &fixture,
            &handle,
            json!({"activities": [act(&format!("c{}", i % 20), "run", status_word, 1 + (i / 40) as i64)]}),
        )
        .await;
        assert_eq!(status, 200, "{i}: {answer}");
    }
    let after = run_record_3516(&su, run).await;
    assert_eq!(after.0, steps_before.0, "200 reports spent no step");
    assert_eq!(
        after.1.get("stages"),
        steps_before.1.get("stages"),
        "and wrote no `output.stages` entry"
    );
    assert!(
        activity_rows(&su, run).await.len() <= 100,
        "the roll holds the rows"
    );

    // an approval holds the run: 409 and nothing written
    let rows_before = activity_rows(&su, run).await;
    sqlx::query("UPDATE agent_run SET status='awaiting_approval' WHERE id=$1")
        .bind(run)
        .execute(&su)
        .await
        .unwrap();
    let (status, held) = send(
        &client,
        &base,
        &fixture,
        &handle,
        json!({"activities": [act("held", "run", "in_progress", 1)]}),
    )
    .await;
    assert_eq!(status, 409, "{held}");
    assert_eq!(activity_rows(&su, run).await, rows_before);
    sqlx::query("UPDATE agent_run SET status='running' WHERE id=$1")
        .bind(run)
        .execute(&su)
        .await
        .unwrap();

    // a finished run: the handle is dead, 409, nothing written
    let (status, done) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_complete",
        json!({"leaseHandle": handle, "status": "succeeded", "body": "끝"}),
    )
    .await;
    assert_eq!(status, 200, "{done}");
    let rows_before = activity_rows(&su, run).await;
    let (status, late) = send(&client, &base, &fixture, &handle, json!({"activities": [act("late", "run", "in_progress", 1)], "plan": [{"text": "늦은 계획", "status": "pending"}]})).await;
    assert_eq!(status, 409, "{late}");
    assert_eq!(activity_rows(&su, run).await, rows_before);
    assert!(plan_rows(&su, run)
        .await
        .iter()
        .all(|p| p != &json!([{"text": "늦은 계획", "status": "pending"}])));

    // a cancelled run's acknowledgement: accepted like the stage it may carry, and the report is
    // dropped — written nowhere and not a refusal
    let other = seed(&su).await;
    let (handle2, run2) = claimed_run_3516(&client, &base, &su, &other).await;
    let cancelled = client
        .post(format!(
            "{base}/v1/workspaces/{}/agent-runs/{run2}/cancel",
            other.workspace
        ))
        .bearer_auth(&other.human_jwt)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16();
    assert_eq!(cancelled, 200);
    let (status, ack) = send(
        &client,
        &base,
        &other,
        &handle2,
        json!({"status": "cancelled", "stage": "멈춤 확인", "activities": [act("x1", "run", "completed", 1)], "plan": [{"text": "버려질 계획", "status": "pending"}]}),
    )
    .await;
    assert_eq!(
        status, 200,
        "a cancellation acknowledgement is still accepted: {ack}"
    );
    assert!(
        activity_rows(&su, run2).await.is_empty(),
        "the settled run's record must not move"
    );
    assert!(plan_rows(&su, run2).await.is_empty());
    assert!(
        stage_rows(&su, run2).await.is_empty(),
        "the stage it carried is dropped the same way"
    );
}

fn raw_activity(value: &Value) -> momo_agent::RawActivity {
    momo_agent::RawActivity {
        id: value["id"].as_str().unwrap().to_string(),
        kind: value["kind"].as_str().unwrap().to_string(),
        label: value["label"].as_str().map(str::to_string),
        status: value["status"].as_str().unwrap().to_string(),
        n: value["n"].as_i64(),
    }
}

fn raw_plan(value: &Value) -> momo_agent::RawPlanItem {
    momo_agent::RawPlanItem {
        text: value["text"].as_str().unwrap().to_string(),
        status: value["status"].as_str().unwrap().to_string(),
    }
}

/// RED PROOF (ADR-0200 증보 7 7-A15). The tool path and an in-server recorder (the helper's
/// direct write, ADR-0201 B5-7) are ONE function: the same input leaves the same rows, the same
/// plan rows and the same total after every step, and a bad input is refused with the same
/// `{field, rule, index}` by both.
///
/// Tamper table:
///   * judge the report in the handler with its own copy of the rules  -> a refusal differs between the paths
///   * fold or tally in Rust for the tool path only                    -> the state diverges at the fold / correction step
///   * let `record_run_activity_in_tx` accept unvalidated text          -> (compile) it cannot: only `ActivityReport` is accepted
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_tool_path_and_an_in_server_recorder_are_one_function() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    let (ws, agent) = (fixture.workspace, fixture.hosted_agent);
    let (handle, via_tool) = claimed_run_3516(&client, &base, &su, &fixture).await;
    let direct = new_run(&su, &fixture, fixture.channel).await;
    let steps: Vec<(Option<Value>, Option<Value>)> = vec![
        (
            Some(
                json!([{"id": "a1", "kind": "read", "status": "in_progress", "label": "읽기", "n": 1}]),
            ),
            None,
        ),
        (
            Some(
                json!([{"id": "a1", "kind": "read", "status": "in_progress", "label": "읽기", "n": 1}]),
            ),
            None,
        ),
        (Some(json!([act("a1", "read", "completed", 5)])), None),
        (Some(json!([act("a1", "read", "completed", 7)])), None),
        (
            Some(json!([
                act("a1", "read", "failed", 7),
                act("b2", "edit", "in_progress", 1)
            ])),
            None,
        ),
        (
            Some(json!([act("b2", "edit", "completed", 2)])),
            Some(json!([{"text": "읽기", "status": "completed"}])),
        ),
        (
            Some(
                json!([{"id": "c3", "kind": "web", "status": "completed", "label": "웹", "n": 4}]),
            ),
            Some(json!([{"text": "읽기", "status": "completed"}])),
        ),
        (None, Some(json!([]))),
        (
            Some(json!([
                act("d4", "run", "in_progress", 1),
                act("d4", "run", "completed", 3)
            ])),
            None,
        ),
    ];
    let snapshot = |run: Uuid| {
        let su = su.clone();
        async move {
            (
                activity_rows(&su, run).await,
                plan_rows(&su, run).await,
                tally(&su, run).await,
            )
        }
    };
    for (number, (activities, plan)) in steps.iter().enumerate() {
        let mut extra = json!({});
        if let Some(activities) = activities {
            extra["activities"] = activities.clone();
        }
        if let Some(plan) = plan {
            extra["plan"] = plan.clone();
        }
        let (status, answer) = send(&client, &base, &fixture, &handle, extra).await;
        assert_eq!(status, 200, "step {number}: {answer}");
        let raw_activities: Option<Vec<momo_agent::RawActivity>> = activities
            .as_ref()
            .map(|items| items.as_array().unwrap().iter().map(raw_activity).collect());
        let raw_plan: Option<Vec<momo_agent::RawPlanItem>> = plan
            .as_ref()
            .map(|items| items.as_array().unwrap().iter().map(raw_plan).collect());
        let report =
            momo_agent::ActivityReport::validate(raw_activities.as_deref(), raw_plan.as_deref())
                .expect("the same input the tool accepted");
        momo_db::with_tenant_tx(&app, ws, move |conn| {
            Box::pin(async move {
                momo_agent::record_run_activity_in_tx(conn, ws, direct, agent, &report).await
            })
        })
        .await
        .expect("direct record");
        assert_eq!(
            snapshot(via_tool).await,
            snapshot(direct).await,
            "step {number}: the two paths diverged"
        );
    }

    // the same refusal from both
    let nine: Vec<Value> = (0..9)
        .map(|i| act(&format!("a{i}"), "read", "completed", 1))
        .collect();
    let thirteen: Vec<Value> = (0..13)
        .map(|i| json!({"text": format!("s{i}"), "status": "pending"}))
        .collect();
    let bad: Vec<(Value, Value)> = vec![
        (
            json!([{"id": "a1", "kind": "read", "status": "completed", "label": "a/b"}]),
            Value::Null,
        ),
        (
            json!([{"id": "a1", "kind": "read", "status": "completed", "label": "가".repeat(41)}]),
            Value::Null,
        ),
        (
            json!([{"id": "a.b", "kind": "read", "status": "completed"}]),
            Value::Null,
        ),
        (
            json!([act("ok", "read", "completed", 1), {"id": "a1", "kind": "think", "status": "completed"}]),
            Value::Null,
        ),
        (
            json!([{"id": "a1", "kind": "read", "status": "pending"}]),
            Value::Null,
        ),
        (json!([act("a1", "read", "completed", 0)]), Value::Null),
        (Value::Array(nine), Value::Null),
        (
            Value::Null,
            json!([{"text": "a", "status": "pending"}, {"text": "나".repeat(61), "status": "pending"}]),
        ),
        (Value::Null, json!([{"text": "a/b", "status": "pending"}])),
        (Value::Null, json!([{"text": "a", "status": "failed"}])),
        (Value::Null, Value::Array(thirteen)),
    ];
    for (activities, plan) in bad {
        let raw_activities: Option<Vec<momo_agent::RawActivity>> = activities
            .as_array()
            .map(|items| items.iter().map(raw_activity).collect());
        let raw_plan: Option<Vec<momo_agent::RawPlanItem>> = plan
            .as_array()
            .map(|items| items.iter().map(raw_plan).collect());
        let fault =
            momo_agent::ActivityReport::validate(raw_activities.as_deref(), raw_plan.as_deref())
                .expect_err("the recorder's judgement refuses it");
        let mut extra = json!({});
        if !activities.is_null() {
            extra["activities"] = activities.clone();
        }
        if !plan.is_null() {
            extra["plan"] = plan.clone();
        }
        let (status, answer) = send(&client, &base, &fixture, &handle, extra).await;
        assert_eq!(status, 400, "{answer}");
        assert_eq!(
            answer["error"]["data"],
            expected_data(
                fault.field.as_str(),
                fault.rule.as_str(),
                fault.index.map(|i| i as u64)
            ),
            "the tool and the recorder refuse alike: {activities} {plan}"
        );
    }
}

/// Take the run row `FOR <mode> NOWAIT` as `momo_app` on a connection of its own and let go
/// again: `Ok(())` = granted, `Err(sqlstate)` = refused (`55P03` = someone else holds the row in
/// a conflicting mode). `mode` is one of the three names below; the statement for each is a
/// fixed string, so no SQL is ever built from text.
async fn try_lock_run(app: &PgPool, workspace: Uuid, run: Uuid, mode: &str) -> Result<(), String> {
    let statement = match mode {
        "UPDATE" => "SELECT 1 FROM agent_run WHERE workspace_id = $1 AND id = $2 FOR UPDATE NOWAIT",
        "NO KEY UPDATE" => {
            "SELECT 1 FROM agent_run WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE NOWAIT"
        }
        "KEY SHARE" => {
            "SELECT 1 FROM agent_run WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE NOWAIT"
        }
        other => panic!("not a lock mode this probe knows: {other}"),
    };
    let mut tx = app.begin().await.expect("tx");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(workspace.to_string())
        .execute(&mut *tx)
        .await
        .expect("guc");
    let answer = sqlx::query(statement)
        .bind(workspace)
        .bind(run)
        .fetch_one(&mut *tx)
        .await;
    tx.rollback().await.expect("rollback");
    match answer {
        Ok(_) => Ok(()),
        Err(sqlx::Error::Database(error)) => {
            Err(error.code().map(|c| c.to_string()).unwrap_or_default())
        }
        Err(other) => panic!("the lock probe failed for another reason: {other}"),
    }
}

/// A `momo_app` transaction under this tenant's GUC, left open for the caller to use.
async fn open_tenant_tx(
    app: &PgPool,
    workspace: Uuid,
) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = app.begin().await.expect("tx");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(workspace.to_string())
        .execute(&mut *tx)
        .await
        .expect("guc");
    tx
}

/// `agent_run_activity_record` on this open transaction (the writer, called as the runtime role).
async fn record_in(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    workspace: Uuid,
    run: Uuid,
    actor: Uuid,
    activities: Value,
) -> Result<i32, sqlx::Error> {
    sqlx::query_scalar("SELECT agent_run_activity_record($1,$2,$3,$4,NULL)")
        .bind(workspace)
        .bind(run)
        .bind(actor)
        .bind(activities)
        .fetch_one(&mut **tx)
        .await
}

/// RED PROOF (ADR-0200 증보 7 7-6, the lock the #4656 security review asked the writer to take
/// itself). The SQL writer locks the run row it writes for, `FOR NO KEY UPDATE`, in the same
/// statement that checks the run is this agent's, so no caller has to lock the run first.
/// Measured with `NOWAIT` from a second connection while the writer's transaction is still open:
/// the row cannot be taken `FOR NO KEY UPDATE` (55P03) and cannot be taken `FOR UPDATE`, but it
/// CAN be taken `FOR KEY SHARE` (the foreign-key checks of other tables never wait on it, which
/// is what makes it NO KEY UPDATE and not UPDATE). A call that is refused (another agent as the
/// actor, another tenant's session) returns 0 and holds NO lock on a run that is not its own.
///
/// The report is one in-progress activity: it writes no total row, so the foreign key of the
/// total table takes no KEY SHARE and the writer's own lock is the only thing that can hold the
/// row.
///
/// Tamper table (each applied and seen red):
///   * check the run with a plain `EXISTS` (the first version)            -> the `NO KEY UPDATE NOWAIT` probe is granted while the writer is open
///   * `FOR UPDATE` instead of `FOR NO KEY UPDATE`                        -> the `KEY SHARE NOWAIT` probe is refused
///   * drop `AND agent_member_id = p_actor` from the locking select        -> another agent's call writes (1 ≠ 0) and holds the run row
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_recorder_locks_the_run_row_it_writes_for_and_only_that_row() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let other_tenant = seed(&su).await;
    let (ws, agent) = (fixture.workspace, fixture.hosted_agent);
    let run = new_run(&su, &fixture, fixture.channel).await;

    // control: with no writer open the row is free in every mode, so a refusal below is the writer's
    for mode in ["UPDATE", "NO KEY UPDATE", "KEY SHARE"] {
        assert_eq!(try_lock_run(&app, ws, run, mode).await, Ok(()), "{mode}");
    }

    // the agent's own call, transaction left open
    let mut writer = open_tenant_tx(&app, ws).await;
    let written = record_in(
        &mut writer,
        ws,
        run,
        agent,
        json!([act("a1", "read", "in_progress", 1)]),
    )
    .await
    .expect("record");
    assert_eq!(written, 1);
    assert_eq!(
        try_lock_run(&app, ws, run, "NO KEY UPDATE").await,
        Err("55P03".to_string()),
        "the writer holds the run row: another writer of it has to wait"
    );
    assert_eq!(
        try_lock_run(&app, ws, run, "UPDATE").await,
        Err("55P03".to_string())
    );
    assert_eq!(
        try_lock_run(&app, ws, run, "KEY SHARE").await,
        Ok(()),
        "…but not with the weak lock a foreign key takes: the lock is NO KEY UPDATE, not UPDATE"
    );
    writer.commit().await.expect("commit");
    assert_eq!(
        try_lock_run(&app, ws, run, "UPDATE").await,
        Ok(()),
        "the lock goes with the transaction"
    );

    // a refused call writes nothing and locks nothing: another agent as the actor, and a
    // session of another tenant naming this tenant's run
    let mut stranger = open_tenant_tx(&app, ws).await;
    let refused = record_in(
        &mut stranger,
        ws,
        run,
        fixture.managed_agent,
        json!([act("x1", "read", "in_progress", 1)]),
    )
    .await
    .expect("record");
    assert_eq!(refused, 0, "another agent's run: refused");
    assert_eq!(
        try_lock_run(&app, ws, run, "NO KEY UPDATE").await,
        Ok(()),
        "a refused caller holds nothing on the run"
    );
    stranger.commit().await.expect("commit");
    let mut foreign = open_tenant_tx(&app, other_tenant.workspace).await;
    let refused = record_in(
        &mut foreign,
        ws,
        run,
        agent,
        json!([act("y1", "read", "in_progress", 1)]),
    )
    .await
    .expect("record");
    assert_eq!(refused, 0, "another tenant's session: refused");
    assert_eq!(
        try_lock_run(&app, ws, run, "NO KEY UPDATE").await,
        Ok(()),
        "a session of another tenant holds nothing on this tenant's run"
    );
    foreign.commit().await.expect("commit");
    assert_eq!(
        activity_rows(&su, run).await.len(),
        1,
        "only the agent's own call wrote a row"
    );
}

/// RED PROOF (the deadlock the #4656 security review reproduced on a real PostgreSQL). A recorder
/// that did NOT lock the run row first (the in-server helper of ADR-0201 B5-7, called straight)
/// and the tool path (which holds the run row `FOR UPDATE` before it records) write to the same
/// run at the same time, and each one's first report for a new (run, kind) goes through the
/// total table's foreign key. The interleaving is made, not hoped for: the tool path's
/// transaction takes the run row; the recorder is started and polled until PostgreSQL says it is
/// waiting behind that transaction; only then does the tool path record. Both must commit with
/// no `deadlock detected` (40P01), and both reports must be in the ledger and in the total.
///
/// Tamper table (applied and seen red):
///   * check the run with a plain `EXISTS` (the first version) -> the recorder takes the advisory
///     lock and then waits on the row the tool path holds, the tool path waits on the advisory lock:
///     40P01 after one `deadlock_timeout`
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_recorder_that_did_not_lock_the_run_first_cannot_deadlock_the_tool_path() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let (ws, agent) = (fixture.workspace, fixture.hosted_agent);
    let run = new_run(&su, &fixture, fixture.channel).await;

    // the tool path: its transaction holds the run row FOR UPDATE before it records
    let mut tool = open_tenant_tx(&app, ws).await;
    let tool_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *tool)
        .await
        .expect("pid");
    sqlx::query("SELECT 1 FROM agent_run WHERE workspace_id = $1 AND id = $2 FOR UPDATE")
        .bind(ws)
        .bind(run)
        .fetch_one(&mut *tool)
        .await
        .expect("the tool path takes the run row");

    // the recorder that does not take the run row first
    let recorder = tokio::spawn({
        let app = app.clone();
        async move {
            let mut tx = open_tenant_tx(&app, ws).await;
            let written = record_in(
                &mut tx,
                ws,
                run,
                agent,
                json!([act("h1", "read", "completed", 3)]),
            )
            .await?;
            tx.commit().await?;
            Ok::<i32, sqlx::Error>(written)
        }
    });

    // wait until PostgreSQL says the recorder is parked behind the tool path's transaction
    let mut parked = false;
    for _ in 0..500 {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
        )
        .bind(tool_pid)
        .fetch_one(&su)
        .await
        .expect("who waits");
        if waiting > 0 {
            parked = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(parked, "the recorder never queued behind the tool path");

    // now the tool path records (a different kind, so its total row is new too)
    let from_tool = record_in(
        &mut tool,
        ws,
        run,
        agent,
        json!([act("t1", "edit", "completed", 5)]),
    )
    .await
    .expect("the tool path must not be the victim of a deadlock");
    tool.commit().await.expect("tool commit");
    let from_recorder = recorder
        .await
        .expect("recorder task")
        .expect("the recorder must not be the victim of a deadlock");
    assert_eq!((from_tool, from_recorder), (1, 1));
    assert_eq!(
        tally(&su, run).await,
        vec![("edit".to_string(), 5, 0), ("read".to_string(), 3, 0)],
        "both reports moved the total"
    );
    assert_eq!(
        activity_rows(&su, run).await.len(),
        2,
        "and both left their row"
    );
}

/// RED PROOF (ADR-0200 증보 7 7-A11 tenant half + the SQL backstop of 7-3). Another tenant reads
/// none of the agent's rows or totals and writes none (the policy and a foreign run both refuse),
/// and the database refuses by itself what the server would refuse: a row of either kind that
/// breaks its columns' rules is rejected by a CHECK, whatever wrote it.
///
/// Tamper table:
///   * drop the `ws_isolation` policy (or FORCE) on `agent_run_activity_tally`  -> the other tenant counts rows
///   * drop `agent_run.agent_member_id = p_actor` from the recorder's locking run check -> a foreign actor writes on the run
///   * drop `agent_report_text_ok(label, 40)` from the activity CHECK              -> the `/` label row is inserted
///   * drop `agent_run_plan_ok(plan)` from the plan CHECK                          -> the 13-step plan row is inserted
///   * drop the "columns the kinds never carry" arm                               -> an activity row with a `stage` is inserted
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn another_tenant_sees_and_writes_none_of_it_and_the_database_backstop_holds() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let other = seed(&su).await;
    let (ws, agent) = (fixture.workspace, fixture.hosted_agent);
    let run = new_run(&su, &fixture, fixture.channel).await;
    record_as_app(
        &app,
        ws,
        run,
        agent,
        Some(json!([act("a1", "read", "completed", 5)])),
        Some(json!([{"text": "계획", "status": "pending"}])),
    )
    .await;
    assert_eq!(activity_rows(&su, run).await.len(), 1);
    assert_eq!(tally(&su, run).await, vec![("read".to_string(), 5, 0)]);

    let as_tenant = |workspace: Uuid| {
        let app = app.clone();
        async move {
            let mut tx = app.begin().await.unwrap();
            sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
                .bind(workspace.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            tx
        }
    };
    // the owner tenant sees them
    let mut tx = as_tenant(ws).await;
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run_event WHERE kind IN ('activity','plan')",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let totals: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_run_activity_tally")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert!(rows >= 2 && totals >= 1, "{rows} {totals}");
    drop(tx);
    // another tenant sees none of the rows and none of the totals
    let mut tx = as_tenant(other.workspace).await;
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run_event WHERE kind IN ('activity','plan')",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let totals: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_run_activity_tally")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!((rows, totals), (0, 0), "RLS keeps the other tenant out");
    // the writer, called under the wrong tenant, neither writes nor tells why
    let written: i32 = sqlx::query_scalar("SELECT agent_run_activity_record($1,$2,$3,$4,NULL)")
        .bind(ws)
        .bind(run)
        .bind(agent)
        .bind(json!([act("evil", "run", "completed", 9)]))
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(written, 0);
    // and the table's own policy refuses a raw row for a workspace that is not the bound one
    sqlx::query("SAVEPOINT raw")
        .execute(&mut *tx)
        .await
        .unwrap();
    let raw_total = sqlx::query(
        "INSERT INTO agent_run_activity_tally (workspace_id, run_id, kind) VALUES ($1,$2,'run')",
    )
    .bind(ws)
    .bind(run)
    .execute(&mut *tx)
    .await;
    assert!(raw_total.is_err(), "WITH CHECK refuses a foreign total");
    sqlx::query("ROLLBACK TO SAVEPOINT raw")
        .execute(&mut *tx)
        .await
        .unwrap();
    let raw_row = sqlx::query(
        "INSERT INTO agent_run_event (workspace_id, run_id, kind, activity_id, activity_kind, activity_status, activity_n, activity_started_at) \
         VALUES ($1,$2,'activity','evil','run','completed',1,now())",
    )
    .bind(ws)
    .bind(run)
    .execute(&mut *tx)
    .await;
    assert!(raw_row.is_err(), "WITH CHECK refuses a foreign ledger row");
    drop(tx);
    assert_eq!(
        activity_rows(&su, run).await.len(),
        1,
        "the foreign attempts wrote nothing"
    );
    assert_eq!(tally(&su, run).await, vec![("read".to_string(), 5, 0)]);
    // a run that is not this agent's: nothing, from the owner's own tenant too
    let stranger = fixture.managed_agent;
    assert_eq!(
        record_as_app(
            &app,
            ws,
            run,
            stranger,
            Some(json!([act("x", "run", "completed", 1)])),
            None
        )
        .await,
        0
    );

    // the SQL backstop: each of these breaks one rule of the CHECKs and is refused by the
    // database itself (23514), whatever wrote it
    let activity_row = |extra_columns: &str, extra_values: &str| {
        format!(
            "INSERT INTO agent_run_event (workspace_id, run_id, kind, activity_id, activity_kind, activity_status, activity_n, activity_started_at{extra_columns}) \
             VALUES ($1,$2,'activity','ok1','run','completed',1,now(){extra_values})"
        )
    };
    let refuse = |sql: String, why: &'static str| {
        let su = su.clone();
        async move {
            let result = sqlx::query(&sql).bind(ws).bind(run).execute(&su).await;
            let error = result.expect_err(why);
            assert_eq!(
                error
                    .as_database_error()
                    .and_then(|e| e.code().map(|c| c.to_string()))
                    .as_deref(),
                Some("23514"),
                "{why}: {error}"
            );
        }
    };
    refuse(activity_row(", label", ", 'a/b'"), "a label with a slash").await;
    refuse(
        activity_row(", label", &format!(", '{}'", "가".repeat(41))),
        "a 41-character label",
    )
    .await;
    refuse(
        activity_row(", label", ", E'tab\\there'"),
        "a control character",
    )
    .await;
    refuse(
        activity_row(", stage", ", 'a stage'"),
        "a stage on an activity row",
    )
    .await;
    refuse(
        activity_row(", plan", ", '[]'::jsonb"),
        "a plan on an activity row",
    )
    .await;
    refuse(
        activity_row(", tool", ", 'oort_x'"),
        "a tool on an activity row",
    )
    .await;
    refuse(
        activity_row(", code", ", 'ok'"),
        "a code on an activity row",
    )
    .await;
    refuse(
        activity_row("", "").replace("'ok1'", "'a.b'"),
        "an id outside the alphabet",
    )
    .await;
    refuse(
        activity_row("", "").replace("'ok1'", &format!("'{}'", "x".repeat(33))),
        "a 33-character id",
    )
    .await;
    refuse(
        activity_row("", "").replace("'run','completed',1", "'think','completed',1"),
        "a kind outside the seven",
    )
    .await;
    refuse(
        activity_row("", "").replace("'run','completed',1", "'run','pending',1"),
        "a status outside the three",
    )
    .await;
    refuse(
        activity_row("", "").replace("'completed',1,now()", "'completed',0,now()"),
        "n = 0",
    )
    .await;
    refuse(
        activity_row("", "").replace("'completed',1,now()", "'completed',100001,now()"),
        "n = 100001",
    )
    .await;
    refuse(
        "INSERT INTO agent_run_event (workspace_id, run_id, kind, activity_id) VALUES ($1,$2,'stage','a1')".to_string(),
        "activity columns on a stage row",
    )
    .await;
    refuse(
        "INSERT INTO agent_run_event (workspace_id, run_id, kind, activity_id, activity_kind, activity_status, activity_n) VALUES ($1,$2,'activity','a1','run','completed',1)".to_string(),
        "no started-at",
    )
    .await;
    let plan_row = |plan: String| {
        format!("INSERT INTO agent_run_event (workspace_id, run_id, kind, plan) VALUES ($1,$2,'plan','{plan}'::jsonb)")
    };
    let thirteen = format!(
        "[{}]",
        vec![r#"{"text":"a","status":"pending"}"#; 13].join(",")
    );
    refuse(plan_row(thirteen), "a 13-step plan").await;
    refuse(
        plan_row(r#"[{"text":"a","status":"failed"}]"#.to_string()),
        "a plan status outside the three",
    )
    .await;
    refuse(
        plan_row(r#"[{"text":"a","status":"pending","id":"x"}]"#.to_string()),
        "an extra key in a plan step",
    )
    .await;
    refuse(
        plan_row(r#"[{"text":"a/b","status":"pending"}]"#.to_string()),
        "a path in a plan step",
    )
    .await;
    refuse(
        plan_row(format!(
            r#"[{{"text":"{}","status":"pending"}}]"#,
            "나".repeat(61)
        )),
        "a 61-character plan step",
    )
    .await;
    refuse(
        plan_row(r#"{"text":"a","status":"pending"}"#.to_string()),
        "a plan that is not an array",
    )
    .await;
    refuse(
        plan_row(r#"["a"]"#.to_string()),
        "a plan step that is not an object",
    )
    .await;
    refuse(
        "INSERT INTO agent_run_event (workspace_id, run_id, kind) VALUES ($1,$2,'plan')"
            .to_string(),
        "a plan row with no plan",
    )
    .await;
    refuse(
        "INSERT INTO agent_run_event (workspace_id, run_id, kind) VALUES ($1,$2,'bogus')"
            .to_string(),
        "an unknown kind",
    )
    .await;
    // a minimal valid row of each kind is accepted (the refusals above are not a broken table)
    sqlx::query(&activity_row("", "").replace("'ok1'", "'ok_valid'"))
        .bind(ws)
        .bind(run)
        .execute(&su)
        .await
        .expect("a valid activity row");
    sqlx::query(&plan_row(
        r#"[{"text":"가","status":"pending"}]"#.to_string(),
    ))
    .bind(ws)
    .bind(run)
    .execute(&su)
    .await
    .expect("a valid plan row");
    // the new CHECKs were added NOT VALID (migration convention: no scan of old rows)
    let unvalidated: Vec<String> = sqlx::query_scalar(
        "SELECT conname::text FROM pg_constraint WHERE conrelid = 'agent_run_event'::regclass \
          AND conname IN ('agent_run_event_kind_ck','agent_run_event_activity_ck') AND NOT convalidated ORDER BY 1",
    )
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(
        unvalidated,
        vec!["agent_run_event_activity_ck", "agent_run_event_kind_ck"]
    );
}

/// RED PROOF (ADR-0200 증보 7 7-6 "보존"). The agent's rows and its total have the ledger's
/// lifetime: the retention sweep removes both with a run finished 30+ days ago and leaves a
/// younger run's untouched — and its cross-tenant READ half finds a workspace by the total
/// alone, so a total can never outlive its run for lack of a ledger row to find it by.
///
/// Tamper table:
///   * drop the activity-total EXISTS from `workspaces_with_expired_run_events` -> a total with no ledger row is never found
///   * drop the `agent_run_activity_tally` DELETE from `delete_expired_run_events_in_tx` -> the expired run's total stays
///   * delete `activity`/`plan` rows of runs that are not past retention        -> the 29-day run loses its rows
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_retention_sweep_takes_the_agents_rows_and_total_with_their_run() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let notifier = momo_notifier_pool().await;
    let fixture = seed(&su).await;
    let (ws, agent) = (fixture.workspace, fixture.hosted_agent);
    let finished_run = |days: i32| {
        let su = su.clone();
        let channel = fixture.channel;
        async move {
            sqlx::query_scalar::<_, Uuid>(
                "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status, created_at, finished_at) \
                 VALUES ($1,$2,$3,'succeeded'::run_status, now() - make_interval(days => $4 + 1), now() - make_interval(days => $4)) \
                 RETURNING id",
            )
            .bind(ws)
            .bind(agent)
            .bind(channel)
            .bind(days)
            .fetch_one(&su)
            .await
            .unwrap()
        }
    };
    let (expired, young) = (finished_run(31).await, finished_run(29).await);
    for run in [expired, young] {
        let written = record_as_app(
            &app,
            ws,
            run,
            agent,
            Some(json!([
                act("a1", "read", "completed", 4),
                act("b2", "run", "in_progress", 1)
            ])),
            Some(json!([{"text": "계획", "status": "completed"}])),
        )
        .await;
        assert_eq!(written, 3);
        assert_eq!(tally(&su, run).await, vec![("read".to_string(), 4, 0)]);
    }
    let stats =
        momo_notifier::run_event_retention_sweep::sweep_expired_run_events(&notifier, &app, 50)
            .await
            .unwrap();
    assert!(stats.deleted >= 1, "{stats:?}");
    assert!(
        activity_rows(&su, expired).await.is_empty(),
        "the expired run's rows go with its ledger"
    );
    assert!(plan_rows(&su, expired).await.is_empty());
    assert!(
        tally(&su, expired).await.is_empty(),
        "and so does its total"
    );
    assert_eq!(activity_rows(&su, young).await.len(), 2, "29 days is kept");
    assert_eq!(plan_rows(&su, young).await.len(), 1);
    assert_eq!(tally(&su, young).await, vec![("read".to_string(), 4, 0)]);

    // the read half finds a workspace by the total alone: nothing else of this run is left
    let lone = seed(&su).await;
    let lone_run: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status, created_at, finished_at) \
         VALUES ($1,$2,$3,'succeeded'::run_status, now() - interval '33 days', now() - interval '32 days') RETURNING id",
    )
    .bind(lone.workspace)
    .bind(lone.hosted_agent)
    .bind(lone.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    record_as_app(
        &app,
        lone.workspace,
        lone_run,
        lone.hosted_agent,
        Some(json!([act("a1", "edit", "completed", 2)])),
        None,
    )
    .await;
    sqlx::query("DELETE FROM agent_run_event WHERE run_id=$1")
        .bind(lone_run)
        .execute(&su)
        .await
        .unwrap();
    assert_eq!(
        tally(&su, lone_run).await,
        vec![("edit".to_string(), 2, 0)],
        "only the total is left"
    );
    momo_notifier::run_event_retention_sweep::sweep_expired_run_events(&notifier, &app, 50)
        .await
        .unwrap();
    assert!(
        tally(&su, lone_run).await.is_empty(),
        "a total cannot outlive its run"
    );
    // idempotent
    let again =
        momo_notifier::run_event_retention_sweep::sweep_expired_run_events(&notifier, &app, 50)
            .await
            .unwrap();
    assert_eq!(again.deleted, 0);
}
