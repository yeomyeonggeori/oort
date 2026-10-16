//! The approval's payload enters the judgment through a **projection**, never whole
//! (ADR-0204 D7, #3928; independent review M1).
//!
//! `judge_targets` joins the approval onto one row per (recipient × device). Selecting
//! `approval.payload` itself would copy the card's arguments — a model's tool input,
//! up to a mebibyte, twice over — once per row into the notifier's memory, and would
//! put the card's text into a process that is designed never to hold any (the judgment
//! module's contract: a target carries ids and enum labels). So the statement selects
//! only the keys the shared audience functions read.
//!
//! This is a source-level pin: a statement text cannot be asked what it selects at
//! runtime without running a database, and the failure it guards (somebody "simplifies"
//! the projection back to the raw column) changes no result a conformance test could
//! see. It lives in its own file so that the strings it forbids are not found in the
//! file it reads.

const JUDGMENT: &str = include_str!("../src/judgment.rs");

#[test]
fn the_approval_payload_is_selected_through_the_routing_projection() {
    for projected in [
        "a.payload#>'{action,id}'",
        "a.payload#>'{action,pins}'",
        "a.payload->'execution'",
        "a.payload->'origin'",
    ] {
        assert!(
            JUDGMENT.contains(projected),
            "the judgment must select {projected} (a key the audience functions read)"
        );
    }
}

#[test]
fn the_approval_payload_is_never_selected_whole() {
    // Built at run time so this file does not contain the text it forbids.
    for raw in [
        ["a.payload", " AS approval_payload"].concat(),
        ["a.payload", "->'tool_call'"].concat(),
        ["a.payload", "->'arguments'"].concat(),
        ["a.payload", "#>'{action,args}'"].concat(),
        ["a.payload", "#>'{action,rationale}'"].concat(),
    ] {
        assert!(
            !JUDGMENT.contains(&raw),
            "the judgment statement selects `{raw}`: the card's text would be copied \
             into the notifier once per recipient and device"
        );
    }
}
