//! ADR-0197 D2: the runner's verbs are exactly five, fixed in source, and there is no
//! docker subcommand for anything else. Each test names the change that turns it red.

mod common;

use std::collections::BTreeSet;

use momo_box_runner::docker::DockerOp;
use momo_box_runner::verbs::Verb;

#[test]
fn the_verbs_are_exactly_create_start_stop_delete_status() {
    let words: BTreeSet<&str> = Verb::ALL.iter().map(|v| v.as_str()).collect();
    assert_eq!(
        words,
        BTreeSet::from(["create", "start", "stop", "delete", "status"]),
        "the allowed verb set changed; ADR-0197 D2 fixes it at five"
    );
    assert_eq!(Verb::ALL.len(), 5);
    // The enum has no sixth variant: an exhaustive match over exactly these five. Adding a
    // variant breaks this at compile time, which is the point.
    for verb in Verb::ALL {
        match verb {
            Verb::Create | Verb::Start | Verb::Stop | Verb::Delete | Verb::Status => {}
        }
    }
}

#[test]
fn the_enum_source_declares_five_variants_and_nothing_else() {
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/verbs.rs"),
    )
    .expect("verbs.rs");
    let body = source
        .split("pub enum Verb {")
        .nth(1)
        .and_then(|rest| rest.split('}').next())
        .expect("enum body");
    let variants: Vec<&str> = body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("//"))
        .collect();
    assert_eq!(
        variants,
        ["Create,", "Start,", "Stop,", "Delete,", "Status,"],
        "a verb was added to (or removed from) the closed enum"
    );
}

#[test]
fn every_other_word_is_not_a_verb() {
    for word in [
        "exec", "cp", "commit", "export", "snapshot", "clone", "copy", "logs", "attach", "kill",
        "restart", "pause", "run", "pull", "inspect", "build", "save", "load", "import", "",
        "Create", "CREATE", " create", "create ", "create\0",
    ] {
        assert_eq!(Verb::parse(word), None, "{word:?} must not parse as a verb");
    }
    for verb in Verb::ALL {
        assert_eq!(Verb::parse(verb.as_str()), Some(verb));
    }
}

#[test]
fn the_docker_operations_are_a_closed_list_of_nine() {
    let subcommands: BTreeSet<Vec<&str>> = DockerOp::ALL
        .iter()
        .map(|op| op.subcommand().to_vec())
        .collect();
    let expected: BTreeSet<Vec<&str>> = [
        vec!["volume", "create"],
        vec!["volume", "rm"],
        vec!["volume", "ls"],
        vec!["create"],
        vec!["start"],
        vec!["stop"],
        vec!["rm"],
        vec!["ps"],
        vec!["run"],
    ]
    .into_iter()
    .collect();
    assert_eq!(subcommands, expected, "the docker subcommand list changed");
    assert_eq!(DockerOp::ALL.len(), 9);
    for op in DockerOp::ALL {
        match op {
            DockerOp::VolumeCreate
            | DockerOp::VolumeRemove
            | DockerOp::VolumeList
            | DockerOp::ContainerCreate
            | DockerOp::ContainerStart
            | DockerOp::ContainerStop
            | DockerOp::ContainerRemove
            | DockerOp::ContainerList
            | DockerOp::OneShotRun => {}
        }
    }
}

/// A second line of defence behind the closed enums: no string literal anywhere in the
/// crate's source names a docker subcommand (or verb) the runner must never have. Comments
/// are ignored; the words are matched as whole string literals.
#[test]
fn no_source_names_a_forbidden_docker_subcommand_or_verb() {
    let forbidden = [
        "exec",
        "cp",
        "commit",
        "export",
        "snapshot",
        "inspect",
        "attach",
        "logs",
        "save",
        "load",
        "import",
        "build",
        "pull",
        "push",
        "tag",
        "diff",
        "top",
        "stats",
        "events",
        "kill",
        "pause",
        "unpause",
        "rename",
        "update",
        "wait",
        "checkpoint",
        "clone",
        "copy",
        "archive",
        "restore",
        "backup",
        "mount",
        "prune",
        "network",
        "context",
        "swarm",
        "service",
    ];
    for (file, source) in common::source_files() {
        let code = common::strip_line_comments(&source);
        for word in forbidden {
            assert!(
                !code.contains(&format!("\"{word}\"")),
                "{file} names the forbidden word \"{word}\" as a string literal"
            );
        }
        // And not as the first word of a formatted docker command either.
        for word in ["inspect", "exec", "commit", "snapshot", "export"] {
            assert!(
                !code.contains(&format!("\"{word} ")),
                "{file} builds a `{word} …` command"
            );
        }
    }
}

#[test]
fn docker_is_spawned_in_exactly_one_file_and_never_through_a_shell() {
    for (file, source) in common::source_files() {
        let code = common::strip_line_comments(&source);
        let spawns = code.contains("Command::new") || code.contains("process::Command");
        assert_eq!(
            spawns,
            file == "docker.rs",
            "{file}: only docker.rs may spawn a process"
        );
        for shell in ["\"sh\"", "\"bash\"", "\"-c\"", "/bin/sh"] {
            assert!(
                !code.contains(shell),
                "{file} reaches for a shell ({shell})"
            );
        }
    }
}
