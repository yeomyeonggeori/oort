//! The runner's verbs (ADR-0197 D2). Exactly five, fixed in source.
//!
//! This list is the whole of what the server can ask this daemon to do. There is no
//! `exec`, `cp`, `commit`, `export` or `snapshot` verb and no volume-clone verb;
//! `tests/verbs_are_closed.rs` goes RED if one is added here, if a variant is added
//! without updating the expected set, or if a docker subcommand for one appears anywhere
//! in the crate.

/// A lifecycle verb the runner executes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Verb {
    Create,
    Start,
    Stop,
    Delete,
    Status,
}

impl Verb {
    /// Every verb. Five.
    pub const ALL: [Verb; 5] = [
        Verb::Create,
        Verb::Start,
        Verb::Stop,
        Verb::Delete,
        Verb::Status,
    ];

    /// The wire word.
    pub fn as_str(self) -> &'static str {
        match self {
            Verb::Create => "create",
            Verb::Start => "start",
            Verb::Stop => "stop",
            Verb::Delete => "delete",
            Verb::Status => "status",
        }
    }

    /// The verb for a wire word; anything else is not a verb.
    pub fn parse(word: &str) -> Option<Verb> {
        Verb::ALL.into_iter().find(|verb| verb.as_str() == word)
    }
}
