//! The runner's configuration is closed and validated: what a box runs lives here, pinned.

mod common;

use std::os::unix::fs::PermissionsExt as _;

use momo_box_runner::config::{load_credential, ConfigError, CredentialError, RunnerConfig};
use serde_json::{json, Value};

fn base() -> Value {
    json!({
        "serverUrl": "https://oort.example.test",
        "workspaceId": common::WORKSPACE,
        "credentialFile": "/etc/momo-box-runner/credential",
        "image": common::IMAGE,
        "network": "momo-box-net",
        "diskQuota": "local-driver-size",
        "stateDir": "/var/lib/momo-box-runner",
    })
}

fn parse(value: Value) -> Result<RunnerConfig, ConfigError> {
    RunnerConfig::parse(&value.to_string())
}

#[test]
fn a_minimal_config_is_valid_and_defaults_to_the_adr_limits() {
    let cfg = parse(base()).expect("valid");
    assert_eq!(cfg.name_prefix, "momo-box-");
    assert_eq!(cfg.caps.cpu_millis, 1000);
    assert_eq!(cfg.shred.grace_days, 14);
    assert_eq!(cfg.dns, ["1.1.1.1", "9.9.9.9"]);
}

#[test]
fn what_a_box_runs_is_not_configurable_through_free_fields() {
    for field in [
        "command",
        "entrypoint",
        "mounts",
        "volumes",
        "env",
        "privileged",
        "capAdd",
        "securityOpt",
        "extraArgs",
        "dockerArgs",
    ] {
        let mut value = base();
        value[field] = json!("x");
        assert!(
            matches!(parse(value), Err(ConfigError::Shape(_))),
            "`{field}` must not be accepted"
        );
    }
}

#[test]
fn the_image_must_be_pinned_by_digest() {
    for good in [
        common::IMAGE.to_string(),
        format!("ghcr.io/example/box@sha256:{}", "ab".repeat(32)),
    ] {
        let mut value = base();
        value["image"] = json!(good);
        parse(value).expect("pinned");
    }
    for bad in [
        "node:22",
        "ghcr.io/example/box:latest",
        "ghcr.io/example/box",
        "sha256:abc",
        "ghcr.io/example/box@sha256:xyz",
        "@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "",
    ] {
        let mut value = base();
        value["image"] = json!(bad);
        assert_eq!(
            parse(value).unwrap_err(),
            ConfigError::ImageNotPinned,
            "{bad:?}"
        );
    }
}

#[test]
fn names_urls_dns_and_caps_are_validated() {
    let case = |field: &str, value: Value| {
        let mut config = base();
        config[field] = value;
        parse(config)
    };
    for bad in [
        "",
        "Momo-",
        "9box-",
        "momo box",
        "a".repeat(25).as_str(),
        "momo_box",
    ] {
        assert_eq!(
            case("namePrefix", json!(bad)).unwrap_err(),
            ConfigError::BadPrefix,
            "{bad:?}"
        );
    }
    for bad in ["", "-net", "net work", "net;rm"] {
        assert_eq!(
            case("network", json!(bad)).unwrap_err(),
            ConfigError::BadNetwork,
            "{bad:?}"
        );
    }
    assert_eq!(
        case("serverUrl", json!("http://oort.example.test")).unwrap_err(),
        ConfigError::InsecureServer
    );
    assert_eq!(
        case("serverUrl", json!("http://127.0.0.1:8080")).unwrap_err(),
        ConfigError::InsecureServer,
        "loopback http needs the switch"
    );
    let mut loopback = base();
    loopback["serverUrl"] = json!("http://127.0.0.1:8080");
    loopback["allowInsecureLoopback"] = json!(true);
    parse(loopback).expect("loopback http with the switch");
    let mut remote = base();
    remote["serverUrl"] = json!("http://oort.example.test");
    remote["allowInsecureLoopback"] = json!(true);
    assert_eq!(
        parse(remote).unwrap_err(),
        ConfigError::InsecureServer,
        "the switch is for loopback only"
    );
    let mut lookalike = base();
    lookalike["serverUrl"] = json!("http://127.0.0.1.evil.test");
    lookalike["allowInsecureLoopback"] = json!(true);
    assert_eq!(parse(lookalike).unwrap_err(), ConfigError::InsecureServer);
    assert_eq!(
        case("dns", json!(["example.com"])).unwrap_err(),
        ConfigError::BadDns
    );
    assert_eq!(case("dns", json!([])).unwrap_err(), ConfigError::BadDns);
    // Caps cannot exceed the ADR D3 ceiling (and a lower cap is fine).
    assert_eq!(
        case(
            "caps",
            json!({"cpuMillis": 2000, "memoryMb": 2048, "diskGb": 10, "pids": 512})
        )
        .unwrap_err(),
        ConfigError::BadCaps
    );
    case(
        "caps",
        json!({"cpuMillis": 500, "memoryMb": 1024, "diskGb": 5, "pids": 256}),
    )
    .expect("lower caps");
    assert_eq!(
        case("pollIntervalSeconds", json!(0)).unwrap_err(),
        ConfigError::BadInterval
    );
    // The disk quota mode has no default: the operator must say it (or say "unenforced").
    let mut missing = base();
    missing.as_object_mut().expect("object").remove("diskQuota");
    assert!(matches!(parse(missing), Err(ConfigError::Shape(_))));
}

#[test]
fn the_credential_file_must_be_private_and_hold_a_runner_credential() {
    let dir = common::temp_dir("credential");
    let path = dir.join("credential");
    let token = format!(
        "oort_runner.11111111-2222-4333-8444-555555555555.{}",
        "A".repeat(43)
    );
    std::fs::write(&path, format!("{token}\n")).expect("write");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod");
    assert!(
        matches!(load_credential(&path), Err(CredentialError::Permissions)),
        "a world-readable credential file was accepted"
    );
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).expect("chmod");
    assert!(matches!(
        load_credential(&path),
        Err(CredentialError::Permissions)
    ));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("chmod");
    assert_eq!(load_credential(&path).expect("private"), token);
    // A symlink is not the file.
    let link = dir.join("link");
    std::os::unix::fs::symlink(&path, &link).expect("symlink");
    assert!(matches!(
        load_credential(&link),
        Err(CredentialError::Permissions)
    ));
    // Not a runner credential.
    std::fs::write(&path, "Bearer something-else\n").expect("write");
    assert!(matches!(
        load_credential(&path),
        Err(CredentialError::NotACredential)
    ));
    assert!(load_credential(&dir.join("missing")).is_err());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn only_exact_prefix_uuid_names_are_this_runners() {
    let dir = common::temp_dir("names");
    let cfg = common::config(&dir);
    let id = uuid::Uuid::new_v4();
    assert_eq!(cfg.box_id_of_name(&cfg.resource_name(id)), Some(id));
    for stranger in [
        format!("other-{id}"),
        format!("momo-m2-{id}-x"),
        format!("momo-m2-{}", id.simple()),
        format!("momo-m2-{}", id.to_string().to_uppercase()),
        "momo-m2-".to_string(),
        id.to_string(),
    ] {
        assert_eq!(cfg.box_id_of_name(&stranger), None, "{stranger}");
    }
    std::fs::remove_dir_all(&dir).ok();
}
