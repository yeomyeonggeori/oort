//! MEM-M0 evaluation set — DB-free half (#3160, plan §8).
//!
//! * green tests: the corpus is deterministic and matches the committed labels;
//!   the checkers pass a flawless reference model and FAIL every sabotaged one.
//! * `#[ignore]` red tests: the same criteria against the product seam
//!   ([`reference::product_backend`]). They fail today because no memory
//!   implementation exists; M1~M3 remove the ignore as each axis lands.
//!
//! ```text
//! cargo test -p momo-agent --test memory_eval                    # green half
//! cargo test -p momo-agent --test memory_eval -- --ignored       # RED half (must fail)
//! MEMORY_EVAL_BLESS=1 cargo test -p momo-agent --test memory_eval  # rewrite labels.json
//! MEMORY_EVAL_DUMP=/path cargo test ... corpus_dump                # write corpus.json (has secret-shaped text)
//! ```

mod eval_kit;

use eval_kit::corpus::*;
use eval_kit::harness::*;
use eval_kit::reference::*;
use std::path::PathBuf;

fn labels_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/memory_eval/labels.json")
}

fn reference(f: Flaws) -> impl Fn() -> Box<dyn MemoryBackend> {
    move || Box::new(Reference::new(f))
}

fn ingested(f: Flaws, c: &Corpus) -> Reference {
    let mut r = Reference::new(f);
    r.ingest(c).unwrap();
    r
}

#[test]
fn corpus_shape_matches_the_plan() {
    let c = generate(SEED);
    assert_eq!(c.messages.len(), TOTAL_MESSAGES);
    assert_eq!(c.decisions.len(), DECISION_COUNT);
    assert_eq!(
        c.decisions.iter().filter(|d| d.changed()).count(),
        CHANGED_DECISIONS
    );
    assert_eq!(c.queries.len(), 30);
    assert_eq!(c.commitments.len(), 20);
    assert_eq!(c.secrets.len(), 8);
    // ids are chronological and unique; replies never precede their root
    for w in c.messages.windows(2) {
        assert!(w[0].key < w[1].key && w[0].minute <= w[1].minute);
    }
    for m in &c.messages {
        if let Some(r) = &m.root {
            assert!(c.msg(r).unwrap().minute < m.minute);
            assert_eq!(c.msg(r).unwrap().channel, m.channel);
        }
    }
    // canaries are planted only in restricted channels, one inside a thread
    assert!(c.canaries.iter().all(|k| k.channel != Channel::General));
    assert!(c.canaries.iter().any(|k| k.in_thread));
    // every canary token is unique across the whole corpus except its own message
    for k in c.canaries.iter().chain(c.controls.iter()) {
        let n = c
            .messages
            .iter()
            .filter(|m| m.body.contains(&k.token))
            .count();
        assert_eq!(n, 1, "token {} must appear in exactly one message", k.token);
    }
}

#[test]
fn generation_is_deterministic_and_seed_sensitive() {
    let a = generate(SEED);
    let b = generate(SEED);
    assert_eq!(a.fingerprint(), b.fingerprint());
    assert_ne!(a.fingerprint(), generate(SEED ^ 1).fingerprint());
}

#[test]
fn committed_labels_match_the_generator() {
    let want = serde_json::to_string_pretty(&generate(SEED).labels_json()).unwrap() + "\n";
    if std::env::var("MEMORY_EVAL_BLESS").is_ok() {
        std::fs::write(labels_path(), &want).unwrap();
    }
    let have =
        std::fs::read_to_string(labels_path()).expect("labels.json (run with MEMORY_EVAL_BLESS=1)");
    assert_eq!(
        have, want,
        "labels.json drifted from the generator; re-bless deliberately"
    );
}

#[test]
fn secret_shapes_are_runtime_only() {
    let c = generate(SEED);
    let labels = serde_json::to_string(&c.labels_json()).unwrap();
    for (key, secret) in &c.secrets {
        assert!(
            secret.len() >= 20,
            "secret-shaped string too short to be realistic"
        );
        assert!(
            !labels.contains(secret.as_str()),
            "labels.json must not embed {key}'s value"
        );
    }
    let src = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/eval_kit/corpus.rs"),
    )
    .unwrap();
    for whole in ["sk-", "ghp_", "AKIA", "Bearer "] {
        assert!(
            !src.contains(&format!("\"{whole}")),
            "whole prefix literal {whole} in source"
        );
    }
}

#[test]
fn optional_corpus_dump() {
    if let Ok(dir) = std::env::var("MEMORY_EVAL_DUMP") {
        let c = generate(SEED);
        let rows: Vec<_> = c
            .messages
            .iter()
            .map(|m| {
                serde_json::json!({
                    "id": m.key, "channel": m.channel.label(), "author": m.author.handle(),
                    "minute": m.minute, "body": m.body, "root": m.root, "class": m.class.label(),
                })
            })
            .collect();
        std::fs::write(
            PathBuf::from(dir).join("corpus.json"),
            serde_json::to_string_pretty(&rows).unwrap(),
        )
        .unwrap();
    }
}

// --- the checkers can pass ---------------------------------------------------

#[test]
fn a_flawless_reference_passes_every_checker() {
    let c = generate(SEED);
    let f = reference(Flaws::default());
    assert_eq!(leak_violations(&f, &c), Ok(vec![]));
    let r = ingested(Flaws::default(), &c);
    let s = decision_score(&r, &c).unwrap();
    assert!(s.passes(), "{s:?}");
    assert_eq!(commitment_recall(&r, &c), Ok(1.0));
    assert_eq!(policy_and_provenance_violations(&r, &c), Ok(vec![]));
}

// --- the checkers can FAIL (sabotage of the harness itself) ---------------------

fn leak_fails(f: Flaws, needle: &str) {
    let c = generate(SEED);
    let v = leak_violations(&reference(f), &c).unwrap();
    assert!(
        v.iter().any(|x| x.starts_with(needle)),
        "expected {needle} violation, got {v:?}"
    );
}

#[test]
fn sabotage_dropped_membership_check_leaks_to_z() {
    leak_fails(
        Flaws {
            ignore_membership: true,
            ..Default::default()
        },
        "z_sees_no_hr",
    );
}
#[test]
fn sabotage_dropped_left_at_check_is_caught() {
    leak_fails(
        Flaws {
            ignore_left_at: true,
            ..Default::default()
        },
        "left_member_sees_none",
    );
}
#[test]
fn sabotage_dropped_deleted_check_is_caught() {
    leak_fails(
        Flaws {
            ignore_deleted: true,
            ..Default::default()
        },
        "deleted_source_hidden",
    );
}
#[test]
fn sabotage_dropped_audience_predicate_is_caught() {
    leak_fails(
        Flaws {
            ignore_audience: true,
            ..Default::default()
        },
        "general_call_excludes_hr",
    );
    leak_fails(
        Flaws {
            ignore_audience: true,
            ..Default::default()
        },
        "no_cross_channel_text",
    );
}

#[test]
fn sabotage_stale_and_open_ended_decisions_are_caught() {
    let c = generate(SEED);
    let stale = decision_score(
        &ingested(
            Flaws {
                stale_current: true,
                ..Default::default()
            },
            &c,
        ),
        &c,
    )
    .unwrap();
    assert!(!stale.passes());
    assert!(stale.current_correct < stale.current_total);
    let open = decision_score(
        &ingested(
            Flaws {
                open_ended_timeline: true,
                ..Default::default()
            },
            &c,
        ),
        &c,
    )
    .unwrap();
    assert!(!open.passes());
    assert_eq!(open.closed_ok, 0);
}

#[test]
fn sabotage_storing_secrets_or_bot_output_is_caught() {
    let c = generate(SEED);
    let s = policy_and_provenance_violations(
        &ingested(
            Flaws {
                store_secrets: true,
                ..Default::default()
            },
            &c,
        ),
        &c,
    )
    .unwrap();
    assert!(!s.is_empty());
    let b = policy_and_provenance_violations(
        &ingested(
            Flaws {
                bot_as_evidence: true,
                ..Default::default()
            },
            &c,
        ),
        &c,
    )
    .unwrap();
    assert!(!b.is_empty());
}

#[test]
fn an_empty_backend_cannot_pass_the_leak_gate() {
    // Returns nothing to everyone: zero leaks, but the positive controls fail.
    struct Silent;
    impl MemoryBackend for Silent {
        fn ingest(&mut self, _: &Corpus) -> R<()> {
            Ok(())
        }
        fn apply(&mut self, _: &Mutation) -> R<()> {
            Ok(())
        }
        fn recall(&self, _: Who, _: &Surface) -> R<Vec<Recalled>> {
            Ok(vec![])
        }
        fn agent_context(&self, _: Who, _: Channel) -> R<String> {
            Ok(String::new())
        }
        fn stored(&self) -> R<Vec<Recalled>> {
            Ok(vec![])
        }
        fn current_value(&self, _: Who, _: &str) -> R<Option<Answer>> {
            Ok(None)
        }
        fn timeline(&self, _: Who, _: &str) -> R<Vec<Period>> {
            Ok(vec![])
        }
        fn commitments(&self, _: Who) -> R<Vec<Commitment>> {
            Ok(vec![])
        }
    }
    let c = generate(SEED);
    let v = leak_violations(&|| Box::new(Silent), &c).unwrap();
    assert!(v.iter().any(|x| x.starts_with("public_control_visible")));
    assert!(v.iter().any(|x| x.starts_with("x_sees_hr")));
}

#[test]
fn the_unimplemented_product_seam_errors_instead_of_passing() {
    let c = generate(SEED);
    let f = || product_backend();
    assert!(matches!(
        leak_violations(&f, &c),
        Err(EvalError::NotImplemented(_))
    ));
    assert!(decision_score(&*product_backend(), &c).is_err());
}

// --- RED: the product against the criteria (fail until M1~M3) --------------------

const RED: &str =
    "RED until MEM-M1..M3: product_backend() is Unimplemented; un-ignore per axis as it lands";

fn product_ingested() -> Box<dyn MemoryBackend> {
    let mut b = product_backend();
    b.ingest(&generate(SEED))
        .expect("product ingests the corpus");
    b
}

#[test]
#[ignore = "RED until MEM-M1..M3: product_backend() is Unimplemented"]
fn red_permission_leaks_are_zero() {
    let _ = RED;
    let c = generate(SEED);
    let v = leak_violations(&|| product_backend(), &c).expect("product answers leak cases");
    assert!(v.is_empty(), "leaks: {v:?}");
}

#[test]
#[ignore = "RED until MEM-M2/M3: product_backend() is Unimplemented"]
fn red_decision_tracking_meets_threshold() {
    let c = generate(SEED);
    let s = decision_score(&*product_ingested(), &c).expect("product answers decisions");
    assert!(s.passes(), "{s:?}");
}

#[test]
#[ignore = "RED until MEM-M2: product_backend() is Unimplemented"]
fn red_commitments_are_recalled_with_owner_and_evidence() {
    let c = generate(SEED);
    let r = commitment_recall(&*product_ingested(), &c).expect("product answers commitments");
    assert!(r >= 0.9, "recall {r}");
}

#[test]
#[ignore = "RED until MEM-M2: product_backend() is Unimplemented"]
fn red_collection_policy_and_provenance_hold() {
    let c = generate(SEED);
    let v = policy_and_provenance_violations(&*product_ingested(), &c)
        .expect("product lists stored items");
    assert!(v.is_empty(), "{v:?}");
}
