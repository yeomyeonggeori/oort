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
//! or displayName at all — never their values).
//!
//! This is a source-level pin: a statement text cannot be asked what it selects at
//! runtime without running a database, and the failure it guards (somebody "simplifies"
//! the projection back to the raw column, or adds a path to it) changes no result a
//! conformance test could see. It is an **allow-list over every way the statement can
//! reach the approval row**: each read of the column must be a listed path, the row
//! cannot be taken whole (`to_jsonb(a)`, `a.*`, a second alias), and the word `payload`
//! may appear in the statement only as that column or as the output alias. What it
//! cannot see — a *new* spelling nobody thought of — the review of a change to this
//! statement still has to. It lives in its own file so that no string in it is found in
//! the file it reads.

const JUDGMENT: &str = include_str!("../src/judgment.rs");

/// Every path of `approval.payload` the judgment statement may read, as the text that
/// follows the column reference `a.payload`.
const ALLOWED_READS: [&str; 8] = [
    "#>'{action,id}'",
    "#>'{action,pins}'",
    // Presence of one key, never its value — and only on an object, so that the answer
    // is the one `opens_in_app` gives the whole payload: `jsonb_typeof(<this>) = 'object'`
    // and `jsonb_exists(<this>, 'avatar')`.
    "#>'{action,args}') = 'object'",
    "#>'{action,args}', 'avatar')",
    "#>'{action,args}', 'displayName')",
    "#>'{tool_call,name}'",
    "->'execution'",
    "->'origin'",
];

/// The judgment statement itself: from its first CTE to its `ORDER BY` — not the module
/// documentation above it, which names the column in prose.
fn statement() -> &'static str {
    let start = JUDGMENT
        .find("WITH msg AS (")
        .expect("the judgment statement starts with `WITH msg AS (`");
    let end = start
        + JUDGMENT[start..]
            .find("ORDER BY r.member_id, t.id")
            .expect("the judgment statement ends with its ORDER BY");
    &JUDGMENT[start..end]
}

/// The column references in the statement: byte offsets of `a.payload` that are not the
/// tail of a longer identifier.
fn column_reads() -> Vec<usize> {
    const COLUMN: &str = "a.payload";
    let sql = statement();
    sql.match_indices(COLUMN)
        .map(|(at, _)| at)
        .filter(|&at| {
            sql[..at]
                .chars()
                .next_back()
                .is_none_or(|before| !(before.is_alphanumeric() || before == '_' || before == '.'))
        })
        .collect()
}

#[test]
fn every_read_of_the_approval_payload_is_a_listed_path() {
    let sql = statement();
    let reads = column_reads();
    assert!(
        !reads.is_empty(),
        "the judgment no longer reads the approval payload through `a.payload` — update this pin"
    );
    for at in reads {
        let rest = &sql[at + "a.payload".len()..];
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
    let sql = statement();
    let reads = column_reads();
    for ok in ALLOWED_READS {
        assert!(
            reads
                .iter()
                .any(|&at| sql[at + "a.payload".len()..].starts_with(ok)),
            "ALLOWED_READS lists {ok:?} but the judgment statement does not read it"
        );
    }
}

#[test]
fn the_word_payload_means_the_column_or_the_output_alias_and_nothing_else() {
    // A second alias for the approval (`ap.payload`), an unqualified `payload`, a quoted
    // or spaced spelling (`a."payload"`, `a . payload`), a capitalised one — none of them
    // contain the text `a.payload`, so the allow-list above cannot see them. They all
    // contain the word, though, so the word is what is counted: every occurrence is
    // either `a.payload` (checked above) or the `approval_payload` output column.
    let sql = statement().to_lowercase();
    for (at, _) in sql.match_indices("payload") {
        let before = &sql[..at];
        let is_column = before.ends_with("a.")
            && !before[..before.len() - 2]
                .ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '.');
        let is_output_alias = before.ends_with("approval_");
        assert!(
            is_column || is_output_alias,
            "the word `payload` appears in the judgment statement outside `a.payload` and the \
             `approval_payload` alias: …{}…",
            &sql[at.saturating_sub(24)..(at + 24).min(sql.len())]
        );
    }
}

#[test]
fn the_approval_row_cannot_be_taken_whole() {
    let sql = statement().to_lowercase();
    // The approval is joined once, under the alias the pin above reads.
    assert_eq!(
        sql.matches("join approval ").count(),
        1,
        "the statement must join the approval table exactly once"
    );
    assert!(
        sql.contains("join approval a "),
        "the approval is aliased `a`; the allow-list reads `a.payload`"
    );
    assert!(
        !sql.contains("from approval"),
        "the approval table is reached only through the one join"
    );
    // Whole-row spellings: the card's arguments, rationale and everything else with it.
    for whole_row in [
        "to_jsonb(a",
        "to_json(a",
        "row_to_json(a",
        "jsonb_build_object(a",
        "a.*",
        "a .",
        "a.\"",
        "(a)",
    ] {
        assert!(
            !sql.contains(whole_row),
            "the judgment statement takes the approval row whole (`{whole_row}`): its payload would be \
             copied into the notifier once per recipient and device"
        );
    }
}

#[test]
fn the_avatar_and_name_are_asked_about_never_selected() {
    // `action.args` holds the card's arguments. The one place the statement may touch it
    // is the presence test for the avatar/name keys — on an object — and the result is
    // a boolean marker: neither value is in the projection.
    let sql = statement();
    let args = "a.payload#>'{action,args}'";
    let reads: Vec<usize> = sql.match_indices(args).map(|(at, _)| at).collect();
    assert_eq!(
        reads.len(),
        3,
        "exactly three reads of the card's arguments: the object test and two key tests"
    );
    assert!(
        sql[..reads[0]].ends_with("jsonb_typeof("),
        "the first read of the card's arguments is `jsonb_typeof(…) = 'object'`"
    );
    for (read, key) in reads[1..].iter().zip(["avatar", "displayName"]) {
        assert!(sql[..*read].ends_with("jsonb_exists("));
        assert!(
            sql[*read..].starts_with(&format!("{args}, '{key}') THEN true END")),
            "{key} presence is carried as a bare marker, never its value"
        );
    }
}
