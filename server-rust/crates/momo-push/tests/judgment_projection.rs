//! The approval's payload enters the judgment through a **projection**, never whole
//! (ADR-0204 D7, #3928; independent review M1).
//!
//! `judge_targets` joins the approval onto one row per (recipient × device). Selecting
//! `approval.payload` itself would copy the card's arguments — a model's tool input,
//! up to a mebibyte, twice over — once per row into the notifier's memory, and would
//! put the card's text into a process that is designed never to hold any (the judgment
//! module's contract: a target carries ids and enum labels). So the statement selects
//! only the paths the shared functions read: the audience's (`decider_gate`,
//! `pinned_target_agent`, `reference_execution_host`) and the open-in-app list's
//! (`opens_in_app`: the tool's name, and whether the profile update carries an avatar
//! at all — never the avatar).
//!
//! This is a source-level pin: a statement text cannot be asked what it selects at
//! runtime without running a database, and the failure it guards (somebody "simplifies"
//! the projection back to the raw column, or adds a path to it) changes no result a
//! conformance test could see. It is an **allow-list over every read of the column**,
//! so a path nobody listed here cannot be added quietly. It lives in its own file so
//! that no string in it is found in the file it reads.

const JUDGMENT: &str = include_str!("../src/judgment.rs");

/// Every path of `approval.payload` the judgment statement may read, as the text that
/// follows the column reference `a.payload`.
const ALLOWED_READS: [&str; 6] = [
    "#>'{action,id}'",
    "#>'{action,pins}'",
    // Presence of one key, never its value: only valid as `jsonb_exists(<this>, 'avatar')`.
    "#>'{action,args}', 'avatar')",
    "#>'{tool_call,name}'",
    "->'execution'",
    "->'origin'",
];

/// The column references in the source: byte offsets of `a.payload` that are not the
/// tail of a longer identifier.
fn column_reads() -> Vec<usize> {
    const COLUMN: &str = "a.payload";
    JUDGMENT
        .match_indices(COLUMN)
        .map(|(at, _)| at)
        .filter(|&at| {
            JUDGMENT[..at]
                .chars()
                .next_back()
                .is_none_or(|before| !(before.is_alphanumeric() || before == '_' || before == '.'))
        })
        .collect()
}

#[test]
fn every_read_of_the_approval_payload_is_a_listed_path() {
    let reads = column_reads();
    assert!(
        !reads.is_empty(),
        "the judgment no longer reads the approval payload through `a.payload` — update this pin"
    );
    for at in reads {
        let rest = &JUDGMENT[at + "a.payload".len()..];
        assert!(
            ALLOWED_READS.iter().any(|ok| rest.starts_with(ok)),
            "the judgment statement reads `a.payload` at a path that is not listed in \
             ALLOWED_READS (the card's text would be copied into the notifier once per \
             recipient and device): `{}`",
            rest.chars().take(48).collect::<String>()
        );
    }
}

#[test]
fn every_listed_path_is_read() {
    // The other direction: a path the statement stopped reading is a path the shared
    // functions no longer get, and a stale entry here would hide the next addition.
    let reads = column_reads();
    for ok in ALLOWED_READS {
        assert!(
            reads
                .iter()
                .any(|&at| JUDGMENT[at + "a.payload".len()..].starts_with(ok)),
            "ALLOWED_READS lists {ok:?} but the judgment statement does not read it"
        );
    }
}

#[test]
fn the_avatar_is_asked_about_never_selected() {
    // `action.args` holds the card's arguments. The one place the statement may touch
    // it is the presence test for the avatar key, and the test's result is a boolean
    // marker — the avatar object itself is not in the projection.
    let args = "a.payload#>'{action,args}'";
    let reads: Vec<usize> = JUDGMENT.match_indices(args).map(|(at, _)| at).collect();
    assert_eq!(reads.len(), 1, "exactly one read of the card's arguments");
    let at = reads[0];
    assert!(
        JUDGMENT[..at].ends_with("jsonb_exists("),
        "the card's arguments are read only inside `jsonb_exists(…, 'avatar')`"
    );
    assert!(
        JUDGMENT[at..].contains("jsonb_build_object('avatar', true)"),
        "the avatar presence is carried as a bare marker, not as the avatar"
    );
}
