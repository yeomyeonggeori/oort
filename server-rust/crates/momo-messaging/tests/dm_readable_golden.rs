//! #4227 / ADR-0177 증보 D9 — the shape and invariants of the readable-message drift golden.
//!
//! No database. The golden file (`docs/api/dm-readable-message.golden.json`) is the one place the two
//! implementations of "is this message worth reading" — the core's `isAmbientMessage` and the Postgres
//! trigger `message_last_readable_seq_trg` — agree on by value. Two suites read it for the values:
//!
//! * `clients/web/src/features/sidebar/ambientMessage.golden.test.ts` (a web test: the core's purity gate
//!   cannot read repo docs) runs every shape through `isAmbientMessage` and compares with `core`;
//! * `bins/momo-server/tests/dm_closure_conformance_pg.rs` (`#[ignore]`, real Postgres) inserts every
//!   shape through the production send path and compares the trigger's effect with `trigger`.
//!
//! This test is the part that runs in plain `cargo test --workspace`. It pins what a drifted *file*
//! looks like, so an edit that quietly weakens the golden — dropping the NULL-trap shape, or giving a
//! shape two different answers — cannot go unnoticed in a gate that skips the PG suite.

use momo_messaging::message::MessageType;
use serde_json::Value;

/// The same bytes the vitest and the PG suite read. `include_str!` makes the file's absence a build
/// error, so the golden cannot be deleted from under the Rust side.
const GOLDEN: &str = include_str!("../../../../docs/api/dm-readable-message.golden.json");

const NOT_APPLICABLE: &str = "n/a(insert-time)";

fn shapes() -> Vec<Value> {
    let golden: Value = serde_json::from_str(GOLDEN).expect("the golden file is JSON");
    golden["shapes"]
        .as_array()
        .expect("`shapes` is an array")
        .clone()
}

fn str_of<'a>(shape: &'a Value, key: &str) -> &'a str {
    shape[key]
        .as_str()
        .unwrap_or_else(|| panic!("{}: `{key}` must be a string", shape["name"]))
}

#[test]
fn every_shape_is_well_formed() {
    let shapes = shapes();
    assert!(
        shapes.len() >= 10,
        "the golden lost shapes: {}",
        shapes.len()
    );
    let mut names = std::collections::BTreeSet::new();
    for shape in &shapes {
        let name = str_of(shape, "name");
        assert!(
            names.insert(name.to_string()),
            "duplicate shape name {name}"
        );
        assert!(
            MessageType::from_db_label(str_of(shape, "type")).is_some(),
            "{name}: `type` is not a message_type label"
        );
        assert!(
            ["sent", "edited", "deleted", "failed"].contains(&str_of(shape, "state")),
            "{name}: `state` is not a message_state label"
        );
        assert!(
            shape["props"].is_object(),
            "{name}: `props` must be a JSON object (message.props is stored as one)"
        );
        assert!(
            ["readable", "ambient"].contains(&str_of(shape, "core")),
            "{name}: `core` must be readable|ambient"
        );
        assert!(
            ["readable", "ambient", NOT_APPLICABLE].contains(&str_of(shape, "trigger")),
            "{name}: `trigger` must be readable|ambient|{NOT_APPLICABLE}"
        );
        assert!(
            !str_of(shape, "why").trim().is_empty(),
            "{name}: every shape says why it is there"
        );
    }
}

/// A shape has one answer. The only place the two implementations may differ is a message that has
/// already been deleted — the trigger fires at INSERT and cannot see a delete — and that difference
/// is written down as `n/a(insert-time)`, not left as two disagreeing values.
#[test]
fn the_two_implementations_agree_except_where_the_golden_says_n_a() {
    for shape in shapes() {
        let name = str_of(&shape, "name");
        if str_of(&shape, "state") == "deleted" {
            assert_eq!(str_of(&shape, "trigger"), NOT_APPLICABLE, "{name}");
            assert_eq!(
                str_of(&shape, "core"),
                "ambient",
                "{name}: the core reads a deleted message as machine"
            );
        } else {
            assert_eq!(
                str_of(&shape, "trigger"),
                str_of(&shape, "core"),
                "{name}: core and trigger disagree on a shape that exists at INSERT time"
            );
        }
    }
}

/// The shapes this rule is easy to get wrong must stay in the file. Each one is a way a plausible
/// edit breaks the trigger or the core while the common shapes still pass.
#[test]
fn the_shapes_the_rule_is_easy_to_get_wrong_stay() {
    let shapes = shapes();
    let find = |name: &str| {
        shapes
            .iter()
            .find(|shape| shape["name"] == name)
            .unwrap_or_else(|| panic!("the golden must keep the `{name}` shape"))
            .clone()
    };

    // `props->>'kind'` is NULL here: `<>` makes the whole predicate NULL and nothing is ever raised.
    let plain = find("plain-text-without-kind");
    assert_eq!(plain["props"], serde_json::json!({}));
    assert_eq!(str_of(&plain, "trigger"), "readable");

    let null_kind = find("text-with-null-kind");
    assert_eq!(null_kind["props"], serde_json::json!({ "kind": null }));
    assert_eq!(str_of(&null_kind, "trigger"), "readable");

    let work_session = find("text-with-work-session-kind");
    assert_eq!(str_of(&work_session, "trigger"), "ambient");

    let deleted = find("deleted-text");
    assert_eq!(str_of(&deleted, "trigger"), NOT_APPLICABLE);

    // Every ambient `type` the trigger names is covered, and one readable `type` of each family.
    for ambient_type in ["system", "tool_call", "tool_result"] {
        assert!(
            shapes
                .iter()
                .any(|shape| str_of(shape, "type") == ambient_type
                    && str_of(shape, "state") == "sent"
                    && str_of(shape, "trigger") == "ambient"),
            "no ambient shape for type {ambient_type}"
        );
    }
    for readable_type in ["text", "diff", "artifact", "approval_request"] {
        assert!(
            shapes
                .iter()
                .any(|shape| str_of(shape, "type") == readable_type
                    && str_of(shape, "state") == "sent"
                    && str_of(shape, "trigger") == "readable"),
            "no readable shape for type {readable_type}"
        );
    }
}
