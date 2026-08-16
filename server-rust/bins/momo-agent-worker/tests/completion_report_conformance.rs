//! 프로듀서↔소비자 conformance — 서버가 만든 봉투가 코어가 파싱하는 그 형상인가
//! (UXC-A / #1454).
//!
//! 완료 리포트 카드는 두 트리에 걸쳐 있다: 봉투를 **쓰는** 쪽이 여기(`server-rust`,
//! `crate::completion_report`)고, **읽는** 쪽이 `packages/momo-core/src/features/
//! timeline/completionReportCard.ts` 다. 둘은 서로를 컴파일하지 않으므로, 한쪽이
//! 키 이름을 바꾸거나 상한을 옮겨도 두 게이트 모두 초록으로 남는다 — 화면에서 카드가
//! 조용히 사라질 때까지. 이 파일이 그 사이에 놓인 유일한 것이다.
//!
//! ## 왜 코어 파일을 실제로 읽는가
//!
//! 기대값을 Rust 안에 베껴 적으면 그것은 「2026-08-17의 코어를 이렇게 기억한다」는
//! 주석일 뿐이고, 코어가 움직여도 빨개지지 않는다. 그래서 이 스위트는 계약 파일과
//! 픽스처 파일을 **디스크에서 읽어** 대조한다:
//!
//!   * `completionReportCard.ts` — `COMPLETION_REPORT_KIND`, 상한 셋, 결과 어휘.
//!   * `completionReportCard.test.ts:35` `REPORT_PROPS` — 실제 봉투의 키 집합.
//!
//! 두 파일은 **읽기 전용**이다(#1441 이 웹/코어를 만지는 중이고, 이 goal 은
//! server-rust 만 만진다). 대조는 한 방향이다: 코어가 정본이고, 어긋나면 프로듀서가
//! 틀린 것이다.
//!
//! ## 무엇이 이 파일을 빨갛게 만드는가
//!
//! | 되돌리면 빨개지는 것 | 어느 테스트 |
//! |---|---|
//! | 프로듀서가 `props.kind` 를 다른 낱말로 방출 | `the_kind_is_the_word_the_core_looks_for` |
//! | 코어가 상한을 옮겼는데 프로듀서의 클램프가 그대로 | `the_producer_clamps_at_the_limits_the_core_actually_parses` |
//! | 프로토콜 블록이 코어 어휘에 없는 결과 낱말을 모델에게 가르침 | `the_protocol_teaches_only_words_the_core_knows` |
//! | 프로듀서가 픽스처에 없는 키를 실거나 키 이름이 갈라짐 | `a_real_emission_matches_the_cores_pinned_envelope` |
//! | 서버가 게이트 결과를 정규화하기 시작 | `the_server_never_authors_an_outcome` |

use std::path::PathBuf;

use momo_agent_worker::completion_report::{
    extract, with_elapsed_ms, Extraction, COMPLETION_REPORT_KIND, MAX_COMPLETION_ACTIONS,
    MAX_COMPLETION_CHECKS_PER_ROW, MAX_COMPLETION_GATE_ROWS, REPORT_FENCE_TAG,
    REPORT_PROTOCOL_BLOCK,
};
use serde_json::{json, Map, Value};

// ---------------------------------------------------------------------------
// the core tree, read as the contract it is
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    // …/server-rust/bins/momo-agent-worker → …/
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("resolve repo root")
}

fn core_file(name: &str) -> String {
    let path = repo_root()
        .join("packages/momo-core/src/features/timeline")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "the core contract for this card must be readable at {} ({error}). \
             This suite is the only thing joining the producer to it.",
            path.display()
        )
    })
}

/// `const NAME = <digits>;` out of the contract file.
fn core_number(source: &str, name: &str) -> usize {
    let needle = format!("export const {name} = ");
    let at = source
        .find(&needle)
        .unwrap_or_else(|| panic!("`{name}` is gone from the core contract"));
    let rest = &source[at + needle.len()..];
    let digits: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '_')
        .filter(|c| *c != '_')
        .collect();
    digits
        .parse()
        .unwrap_or_else(|_| panic!("`{name}` is no longer a number literal"))
}

/// The `REPORT_PROPS` literal's source, from the fixture the core pinned.
fn report_props_literal() -> String {
    let source = core_file("completionReportCard.test.ts");
    let at = source
        .find("const REPORT_PROPS = {")
        .expect("REPORT_PROPS is the fixture this producer must match; it is gone");
    let body = &source[at..];
    // The literal ends at the first line that is exactly `};`.
    let end = body
        .find("\n};")
        .expect("REPORT_PROPS literal is not closed the way this reader expects");
    body[..end].to_string()
}

/// Top-level keys of `REPORT_PROPS` — lines indented exactly two spaces.
fn report_props_keys() -> Vec<String> {
    let literal = report_props_literal();
    let mut keys = Vec::new();
    for line in literal.lines().skip(1) {
        let Some(rest) = line.strip_prefix("  ") else {
            continue;
        };
        if rest.starts_with(' ') || rest.starts_with("//") {
            continue;
        }
        let Some(colon) = rest.find(':') else {
            continue;
        };
        let key = rest[..colon].trim();
        if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            keys.push(key.to_string());
        }
    }
    assert!(
        keys.len() > 4,
        "the fixture reader found only {keys:?}; the literal's shape moved"
    );
    keys
}

// ---------------------------------------------------------------------------
// a real emission
// ---------------------------------------------------------------------------

/// What a model actually sends at the end of a long setup turn, written the way
/// [`REPORT_PROTOCOL_BLOCK`] asks for it. Modelled on the core fixture's own
/// report so the two sides are describing the same run.
const MODEL_TURN: &str = r#"환경 셋업을 마쳤습니다.

```oort:report
{
  "title": "yeomyeonggeori/oort 환경 셋업 완료",
  "summary": "oort 모노레포입니다. Rust 서버·TS 코어·웹/폰 클라이언트가 한 트리에 있고, 게이트를 전부 초록으로 맞췄습니다.",
  "elapsed_ms": 999,
  "actions": [
    {"text": "Rust 툴체인을 1.83에서 1.97로 올림", "note": "워크스페이스가 edition2024를 요구해 고정된 1.83으로는 빌드되지 않았습니다."},
    {"text": "compose 스택 기동 후 헬스체크 확인"}
  ],
  "gates": [
    {"surface": "웹", "checks": [
      {"label": "테스트", "outcome": "pass", "detail": "896 통과"},
      {"label": "린트", "outcome": "pass", "detail": "경고 0"}
    ]},
    {"surface": "엔진", "checks": [
      {"label": "빌드", "outcome": "pass"},
      {"label": "테스트", "outcome": "pass", "detail": "clippy 경고 0"}
    ]},
    {"surface": "compose", "checks": [
      {"label": "실행", "outcome": "pass", "detail": "healthy"}
    ]}
  ]
}
```
"#;

fn emitted() -> (String, Map<String, Value>) {
    let (extraction, dropped) = extract(MODEL_TURN);
    assert_eq!(dropped, 0, "this report is well inside every limit");
    let Extraction::Report(report) = extraction else {
        panic!("the protocol's own example must produce a report: {extraction:?}");
    };
    let mut props = report.props;
    // The server's half — measured, never the model's word for it.
    with_elapsed_ms(&mut props, 1_000, 1_469_000);
    (report.body, props)
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// The one word that decides whether the card is drawn at all.
#[test]
fn the_kind_is_the_word_the_core_looks_for() {
    let contract = core_file("completionReportCard.ts");
    let expected = format!("export const COMPLETION_REPORT_KIND = \"{COMPLETION_REPORT_KIND}\";");
    assert!(
        contract.contains(&expected),
        "the producer emits props.kind = {COMPLETION_REPORT_KIND:?}, which the core no longer \
         calls COMPLETION_REPORT_KIND. A card nothing draws is the failure this pins."
    );
}

/// The producer's clamps are the core's limits, read from the core.
///
/// Drift here is silent in the worst direction: raise the core's ceiling and the
/// producer keeps cutting at the old one, so reports get shorter and nothing
/// says why.
#[test]
fn the_producer_clamps_at_the_limits_the_core_actually_parses() {
    let contract = core_file("completionReportCard.ts");
    assert_eq!(
        core_number(&contract, "MAX_COMPLETION_ACTIONS"),
        MAX_COMPLETION_ACTIONS
    );
    assert_eq!(
        core_number(&contract, "MAX_COMPLETION_GATE_ROWS"),
        MAX_COMPLETION_GATE_ROWS
    );
    assert_eq!(
        core_number(&contract, "MAX_COMPLETION_CHECKS_PER_ROW"),
        MAX_COMPLETION_CHECKS_PER_ROW
    );
}

/// The system block teaches four result words. Every one of them has to be a
/// word the core can fold, or the producer is training models to emit `unknown`
/// cells — warn-coloured "미상 결과" where a green 통과 belonged.
#[test]
fn the_protocol_teaches_only_words_the_core_knows() {
    let contract = core_file("completionReportCard.ts");
    for word in ["pass", "fail", "skip", "pending"] {
        assert!(
            REPORT_PROTOCOL_BLOCK.contains(word),
            "the protocol stopped offering {word:?}"
        );
        assert!(
            contract.contains(&format!("[\"{word}\", \"")),
            "the core's synonym table no longer knows {word:?}, which the protocol still teaches"
        );
    }
    assert!(
        REPORT_PROTOCOL_BLOCK.contains(REPORT_FENCE_TAG),
        "the protocol must name the fence `extract` actually reads"
    );
}

/// **The round trip.** A real emission's envelope, key for key, against the
/// envelope the core pinned as the one it parses.
#[test]
fn a_real_emission_matches_the_cores_pinned_envelope() {
    let (body, props) = emitted();
    assert_eq!(
        body, "환경 셋업을 마쳤습니다.",
        "the fence is cut out of the answer; the prose is what the channel shows"
    );

    // 1. Every key the producer ships is a key the fixture ships. A producer key
    //    the core never saw would render as nothing and be counted as an unread
    //    key by `payloadDetail`.
    let fixture_keys = report_props_keys();
    for key in props.keys() {
        assert!(
            fixture_keys.contains(key),
            "producer emits `{key}`, which is not in the core's REPORT_PROPS fixture ({fixture_keys:?})"
        );
    }
    // 2. …and every report key the fixture pins is one the producer can ship.
    for key in ["kind", "title", "summary", "elapsed_ms", "actions", "gates"] {
        assert!(
            fixture_keys.contains(&key.to_string()),
            "the core fixture stopped pinning `{key}`"
        );
        assert!(
            props.contains_key(key),
            "the producer stopped emitting `{key}`"
        );
    }

    // 3. The shapes, not just the names — this is what a client would have to
    //    re-derive if the producer got them wrong.
    assert_eq!(props["kind"], json!(COMPLETION_REPORT_KIND));
    assert_eq!(props["title"], json!("yeomyeonggeori/oort 환경 셋업 완료"));
    assert_eq!(
        props["actions"],
        json!([
            {
                "text": "Rust 툴체인을 1.83에서 1.97로 올림",
                "note": "워크스페이스가 edition2024를 요구해 고정된 1.83으로는 빌드되지 않았습니다."
            },
            {"text": "compose 스택 기동 후 헬스체크 확인"}
        ])
    );
    assert_eq!(
        props["gates"],
        json!([
            {"surface": "웹", "checks": [
                {"label": "테스트", "outcome": "pass", "detail": "896 통과"},
                {"label": "린트", "outcome": "pass", "detail": "경고 0"}
            ]},
            {"surface": "엔진", "checks": [
                {"label": "빌드", "outcome": "pass"},
                {"label": "테스트", "outcome": "pass", "detail": "clippy 경고 0"}
            ]},
            {"surface": "compose", "checks": [
                {"label": "실행", "outcome": "pass", "detail": "healthy"}
            ]}
        ])
    );

    // 4. The nested key names the fixture uses, read from the fixture rather
    //    than remembered.
    let literal = report_props_literal();
    for nested in [
        "text", "note", "surface", "checks", "label", "outcome", "detail",
    ] {
        assert!(
            literal.contains(&format!("{nested}:")) || literal.contains(&format!("\"{nested}\":")),
            "the fixture no longer names `{nested}`; the producer still emits it"
        );
    }
}

/// **`elapsed_ms` is the server's, and only the server's.**
///
/// The model wrote `999` in [`MODEL_TURN`] and the card must not show it. A
/// self-reported duration is the one number on this card an agent could inflate
/// without anyone being able to check it (ADR-0132), so the producer drops it on
/// the floor and measures instead.
#[test]
fn the_elapsed_time_is_measured_and_never_the_models_word() {
    let (_, props) = emitted();
    assert_eq!(
        props["elapsed_ms"],
        json!(1_468_000),
        "the server's measurement, not the 999 the model claimed"
    );

    // …and without a measurement there is no key at all, rather than a zero.
    let Extraction::Report(report) = extract(MODEL_TURN).0 else {
        unreachable!()
    };
    assert!(!report.props.contains_key("elapsed_ms"));
}

/// **The server never authors an outcome.** Folding `"failed"` into `"fail"`, or
/// guessing at a word it does not know, is the core's job — and doing it here
/// would make "the server wrote pass" a reachable state.
#[test]
fn the_server_never_authors_an_outcome() {
    let text = "끝.\n```oort:report\n\
        {\"gates\":[{\"surface\":\"엔진\",\"checks\":[\
          {\"label\":\"테스트\",\"outcome\":\"FAILED\"},\
          {\"label\":\"소크\",\"outcome\":\"미상\"}]}]}\n```";
    let Extraction::Report(report) = extract(text).0 else {
        panic!("a gates-only report is still a report")
    };
    let checks = &report.props["gates"][0]["checks"];
    assert_eq!(checks[0]["outcome"], json!("FAILED"));
    assert_eq!(checks[1]["outcome"], json!("미상"));
}

/// The trigger, stated as an invariant: an ordinary turn is byte-identical to
/// what it was before this producer existed.
#[test]
fn an_ordinary_turn_is_untouched_by_the_producer() {
    let text = "네, 내일 10시에 회의 잡아뒀습니다.";
    let (extraction, dropped) = extract(text);
    assert_eq!(extraction, Extraction::None);
    assert_eq!(dropped, 0);
}
