//! ADR-0218 증보 6 §12 L6 (#5461 S2, A3): the decision rule of a set card against the **shared
//! vectors**. `docs/api/expression-set.vectors.json` is a byte-equal copy of the core's
//! `set.vectors.json` — the table the core's `decideExpressionSet` is tested against in
//! `set.test.ts` — so the TypeScript rule and this Rust rule cannot drift apart. The core cannot read
//! outside its own package, and a Rust test may only read files the PR CI rust filter covers
//! (`docs/api/*.vectors.json` is one of them, #4055), which is why the server reads the copy under
//! `docs/api/`; `verify-contract.mjs` (core side) holds the two copies byte-equal.
//!
//! No database: the rule is pure ([`momo_expressions::set_decision::decide_set`] and
//! [`momo_expressions::set_decision::parse_choices`]). The transaction that feeds it facts is tested
//! against a real PG in `momo-server`'s `expression_set_decision_pg.rs`.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `every_case_of_the_shared_vectors_gives_the_core_s_answer` | all 15 cases: request order, name and quota skips, the all-skipped refusals, the gray / stale / expired whole-decision refusals, the duplicate and the empty list | any line of `decide_set` or `parse_choices` changes the answer of one case |
//! | `the_vectors_pin_every_branch_of_the_rule` | the table itself has a case for each way the rule can flip (a mutation could not pass on a nearly empty table) | the table loses a case |
//! | `the_shared_constants_are_the_servers` | the vectors' quota is the server's `QUOTA` | one of the two moves alone |

use std::collections::BTreeSet;

use momo_expressions::set_decision::{
    decide_set, parse_choices, Pick, ReadySlot, Refusal, SkipReason, Verdict,
};
use momo_expressions::{Kind, QUOTA};
use serde_json::{json, Value};
use uuid::Uuid;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/api/expression-set.vectors.json"
    );
    serde_json::from_str(
        &std::fs::read_to_string(path).expect("the shared set vectors (a copy under docs/api)"),
    )
    .expect("the vectors are JSON")
}

/// The draft id a slot index stands for in a case.
fn draft(index: u64) -> Uuid {
    Uuid::from_u128(0x5e70_0000_0000_4000_8000_0000_0000_0000 + u128::from(index))
}

/// An id no slot has: what a request names when it names a gray slot (a gray slot has no draft).
fn made_up(index: u64) -> Uuid {
    Uuid::from_u128(0x0bad_0000_0000_4000_8000_0000_0000_0000 + u128::from(index))
}

fn text(value: &Value, key: &str) -> String {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} in {value}"))
        .to_string()
}

fn number(value: &Value, key: &str) -> u32 {
    u32::try_from(
        value[key]
            .as_u64()
            .unwrap_or_else(|| panic!("{key} in {value}")),
    )
    .expect("a small number")
}

/// What the case says the answer is, in the vectors' own words.
fn answer(case: &Value) -> Value {
    let slots = case["slots"].as_array().expect("slots");
    let by_index = |index: u64| {
        slots
            .iter()
            .find(|slot| slot["index"].as_u64() == Some(index))
            .unwrap_or_else(|| panic!("slot {index} of {}", case["name"]))
    };
    let choose: Vec<u64> = case["choose"]
        .as_array()
        .expect("choose")
        .iter()
        .map(|index| index.as_u64().expect("an index"))
        .collect();
    let kinds = &case["chooseKinds"];
    // the request, as a person's client would send it
    let request: Vec<Value> = choose
        .iter()
        .map(|&index| {
            let ready = by_index(index)["state"] == "ready";
            let mut item = json!({
                "draftId": if ready { draft(index) } else { made_up(index) }.to_string(),
                "revision": "1",
                "sha256": "a".repeat(64),
            });
            if let Some(kind) = kinds.get(index.to_string()).filter(|kind| !kind.is_null()) {
                item["kind"] = kind.clone();
            }
            item
        })
        .collect();
    // 400: the list is not the contract's shape (empty, a draft twice)
    let Some(choices) = parse_choices(&Value::Array(request)) else {
        return json!({"ok": false, "status": 400, "code": "expression_choice_invalid"});
    };
    let ready: Vec<ReadySlot> = slots
        .iter()
        .filter(|slot| slot["state"] == "ready")
        .map(|slot| ReadySlot {
            index: u8::try_from(slot["index"].as_u64().expect("index")).expect("a slot index"),
            draft_id: draft(slot["index"].as_u64().expect("index")),
            name: text(slot, "name"),
        })
        .collect();
    let stale: Vec<u64> = case["stale"]
        .as_array()
        .map(|list| list.iter().map(|index| index.as_u64().unwrap()).collect())
        .unwrap_or_default();
    let expired = case["expired"].as_bool().unwrap_or(false);
    let picks: Vec<Pick> = choices
        .iter()
        .zip(&choose)
        .map(|(choice, &index)| {
            let slot = by_index(index);
            let large = if slot["state"] == "ready" {
                (
                    number(slot, "width"),
                    number(slot, "height"),
                    number(slot, "frames"),
                )
            } else {
                (0, 0, 0)
            };
            Pick {
                draft_id: choice.draft_id,
                kind: choice.kind,
                // a revision the card did not show, or a card past its window, is a draft whose proofs
                // do not hold (the transaction finds that out by reading the row)
                holds: !stale.contains(&index) && !expired,
                large,
            }
        })
        .collect();
    let taken: BTreeSet<String> = case["taken"]
        .as_array()
        .expect("taken")
        .iter()
        .map(|name| name.as_str().expect("a name").to_string())
        .collect();
    let live = i64::try_from(case["live"].as_u64().expect("live")).expect("live");
    let quota = case["quota"].as_i64().unwrap_or(QUOTA);
    match decide_set(&ready, &picks, &taken, live, quota) {
        Verdict::Registered {
            registered,
            skipped,
        } => json!({
            "ok": true,
            "registered": registered.iter().map(|item| json!({"name": item.name, "kind": item.kind.as_str()})).collect::<Vec<_>>(),
            "skipped": skipped.iter().map(|skip| json!({"name": skip.name, "reason": skip.reason.as_str()})).collect::<Vec<_>>(),
        }),
        Verdict::Refused(refusal) => json!({
            "ok": false,
            "status": 409,
            "code": match refusal {
                Refusal::Stale => "expression_preview_stale",
                Refusal::NameReserved => "expression_name_reserved",
                Refusal::Quota => "expression_quota",
            },
        }),
    }
}

#[test]
fn every_case_of_the_shared_vectors_gives_the_core_s_answer() {
    let file = vectors();
    let cases = file["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 15, "the ADR counts 15 rows (A3)");
    for case in cases {
        assert_eq!(answer(case), case["expect"], "{}", case["name"]);
    }
}

#[test]
fn the_vectors_pin_every_branch_of_the_rule() {
    let file = vectors();
    let cases = file["cases"].as_array().expect("cases");
    let has = |what: &dyn Fn(&Value) -> bool| cases.iter().any(what);
    let code = |case: &Value| case["expect"]["code"].as_str().map(str::to_owned);
    // every refusal code
    for expected in [
        "expression_choice_invalid",
        "expression_preview_stale",
        "expression_name_reserved",
        "expression_quota",
    ] {
        assert!(
            has(&|case| code(case).as_deref() == Some(expected)),
            "{expected}"
        );
    }
    // a registration with both skip reasons, and the order of the request changing nothing
    for reason in [SkipReason::NameTaken, SkipReason::Quota] {
        assert!(
            has(&|case| case["expect"]["skipped"]
                .as_array()
                .is_some_and(|skips| skips.iter().any(|skip| skip["reason"] == reason.as_str()))),
            "{}",
            reason.as_str()
        );
    }
    assert!(
        has(&|case| {
            let choose: Vec<u64> = case["choose"]
                .as_array()
                .unwrap()
                .iter()
                .map(|index| index.as_u64().unwrap())
                .collect();
            choose.len() > 1 && choose.windows(2).any(|pair| pair[0] > pair[1])
        }),
        "a case whose request is not in slot order"
    );
    // both kinds of registration: the person's own and the recommendation, and a moving one
    assert!(
        has(&|case| !case["chooseKinds"].is_null()),
        "a kind the person chose"
    );
    for kind in [Kind::Emoji, Kind::Sticker] {
        assert!(
            has(&|case| case["expect"]["registered"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["kind"] == kind.as_str()))),
            "{}",
            kind.as_str()
        );
    }
    assert!(
        has(&|case| case["slots"]
            .as_array()
            .unwrap()
            .iter()
            .any(|slot| slot["state"] == "gray")),
        "a gray slot"
    );
    assert!(has(&|case| case["expired"] == true), "an expired card");
    assert!(has(&|case| !case["stale"].is_null()), "a stale pin");
}

#[test]
fn the_shared_constants_are_the_servers() {
    let file = vectors();
    assert_eq!(file["version"], 1);
    assert_eq!(file["quota"].as_i64(), Some(QUOTA));
    assert_eq!(QUOTA, 1000, "D2");
}

#[test]
fn a_list_of_more_than_forty_or_with_a_loose_shape_is_never_a_decision() {
    let item = |n: u128| json!({"draftId": Uuid::from_u128(n).to_string(), "revision": "1", "sha256": "b".repeat(64)});
    let list = |count: u128| Value::Array((1..=count).map(item).collect());
    assert_eq!(
        parse_choices(&list(40)).map(|choices| choices.len()),
        Some(40)
    );
    assert!(
        parse_choices(&list(41)).is_none(),
        "41 pictures: the schema's maxItems 40"
    );
    assert!(parse_choices(&json!({})).is_none(), "not an array");
    assert!(parse_choices(&Value::Null).is_none());
    let mut bad = vec![item(1)];
    for (why, change) in [
        ("an open key", json!({"extra": 1})),
        ("a revision with a leading zero", json!({"revision": "01"})),
        ("a revision that is a number", json!({"revision": 1})),
        ("a short hash", json!({"sha256": "abc"})),
        ("an upper-case hash", json!({"sha256": "B".repeat(64)})),
        ("a kind outside the closed two", json!({"kind": "gif"})),
        ("a kind that is null", json!({"kind": null})),
        ("a draft id that is not an id", json!({"draftId": "x"})),
    ] {
        let mut broken = item(2);
        for (key, value) in change.as_object().unwrap() {
            broken[key] = value.clone();
        }
        bad.push(broken);
        assert!(parse_choices(&Value::Array(bad.clone())).is_none(), "{why}");
        bad.pop();
    }
    // the closed two are fine, and a kind is optional
    for kind in [json!("emoji"), json!("sticker")] {
        let mut ok = item(3);
        ok["kind"] = kind;
        assert!(parse_choices(&Value::Array(vec![ok])).is_some());
    }
}
