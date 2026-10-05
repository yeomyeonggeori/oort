//! ADR-0197 D1/D2: the runner opens a box volume and mounts it; it never reads a box's
//! content, and it dials the server but listens on nothing. These tests read the runner's own
//! source (and say so): they are the 「시험이 소스로 잠근다」 the ADR asks for.
//!
//! What they cannot show — and the PR says so — is a syscall trace of a live run (the ADR
//! also mentions one). They bound what the *source* can do; the e2e run shows what one
//! real run did.

mod common;

fn code(file: &str) -> String {
    let (_, source) = common::source_files()
        .into_iter()
        .find(|(name, _)| name == file)
        .unwrap_or_else(|| panic!("{file}"));
    common::strip_line_comments(&source)
}

#[test]
fn only_the_config_and_the_ledger_touch_the_filesystem() {
    let fs_markers = [
        "std::fs",
        "tokio::fs",
        "File::open",
        "File::create",
        "OpenOptions",
        "read_dir",
        "read_to_string",
        "fs::read",
        "fs::write",
        "fs::copy",
        "fs::rename",
        "metadata(",
        "create_dir",
        "remove_file",
        "remove_dir",
        "set_permissions",
        "symlink_metadata",
    ];
    for (file, source) in common::source_files() {
        let code = common::strip_line_comments(&source);
        let touches = fs_markers.iter().any(|m| code.contains(m));
        // config.rs: its config and credential file. ledger.rs: its own ledger. identity.rs: its own signing seed
        // (ADR-0197 M4). provision.rs: the per-box files the RUNNER writes under its state directory and the box
        // directories it creates and removes under `hostKeyRoot` (see the next test for what it must not read).
        let allowed = ["config.rs", "ledger.rs", "identity.rs", "provision.rs"].contains(&file.as_str());
        assert!(
            !touches || allowed,
            "{file} touches the filesystem; only config.rs, ledger.rs, identity.rs and provision.rs may"
        );
    }
}

#[test]
fn no_source_names_docker_data_or_a_volume_path() {
    for (file, source) in common::source_files() {
        let code = common::strip_line_comments(&source);
        for path in [
            "/var/lib/docker",
            "/var/lib/oort",
            "/proc/",
            "/sys/",
            "_data",
            "/mnt/",
            "/Volumes/",
            "/home/box",
            "/cred",
        ] {
            // The template names the mount point INSIDE the box (/home/box, /cred, …); those are
            // arguments to docker, not paths this process opens.
            if file == "template.rs"
                && (path == "/home/box" || path == "/cred" || path == "/var/lib/oort")
            {
                continue;
            }
            assert!(!code.contains(path), "{file} names {path}");
        }
    }
}

#[test]
fn the_runner_listens_on_nothing() {
    for (file, source) in common::source_files() {
        let code = common::strip_line_comments(&source);
        for marker in [
            "TcpListener",
            "UdpSocket",
            "UnixListener",
            "UnixStream",
            "bind(",
            "listen(",
            "accept(",
            "axum",
            "hyper::server",
            "warp",
            "tiny_http",
            "SocketAddr::",
        ] {
            assert!(
                !code.contains(marker),
                "{file} contains `{marker}`: the runner is outbound only"
            );
        }
    }
}

#[test]
fn the_http_client_lives_in_one_file_and_speaks_https_only_by_configuration() {
    for (file, source) in common::source_files() {
        let code = common::strip_line_comments(&source);
        let uses = code.contains("reqwest::");
        assert_eq!(
            uses,
            file == "client.rs",
            "{file}: only client.rs may use the HTTP client"
        );
    }
    // The config refuses plain http except loopback with an explicit switch (tests/config.rs);
    // the client builds its URLs from that one validated base.
    assert!(code("client.rs").contains("bearer_auth"));
}

#[test]
fn no_log_line_or_error_carries_docker_output_or_the_credential() {
    // `DockerOutput` hides its text from Debug, `HttpServer` hides the credential, and the
    // engine's errors name the operation, never docker's words.
    let docker = code("docker.rs");
    assert!(
        docker.contains("finish_non_exhaustive"),
        "DockerOutput's Debug must hide its text"
    );
    assert!(code("client.rs").contains("\"<hidden>\""));
    for (file, source) in common::source_files() {
        let code = common::strip_line_comments(&source);
        for line in code
            .lines()
            .filter(|l| l.contains("tracing::") || l.contains("warn!(") || l.contains("info!("))
        {
            for secret in ["credential", "stdout", "stderr", "token"] {
                assert!(
                    !line.contains(&format!("{secret} =")) && !line.contains(&format!("{secret},")),
                    "{file}: a log call carries `{secret}`: {line}"
                );
            }
        }
    }
}

#[test]
fn the_runner_never_reads_inside_the_host_key_root() {
    // ADR-0197 D1/D2 (M4): the box's host key and agent state live under `hostKeyRoot/<box id>`. The runner creates
    // that directory and removes it on delete; it never opens, lists or reads anything in it — the registration
    // proof reaches the runner through the server's parked MAC, not through the box's files.
    let provision = code("provision.rs");
    for (n, line) in provision.lines().enumerate() {
        if !(line.contains("host_key_root") || line.contains("key_dir") || line.contains("root.path")) {
            continue;
        }
        for read in [
            "read_to_string",
            "File::open",
            "fs::read(",
            "read_dir",
            "OpenOptions",
            "fs::copy",
        ] {
            assert!(
                !line.contains(read),
                "provision.rs:{} reads inside the host key root: {line}",
                n + 1
            );
        }
    }
    // And no other file names the key root's content at all.
    for (file, source) in common::source_files() {
        if file == "provision.rs" || file == "config.rs" || file == "template.rs" {
            continue;
        }
        let code = common::strip_line_comments(&source);
        assert!(
            !code.contains("host_key_root") && !code.contains("host.key"),
            "{file} reaches for the host key root"
        );
    }
}
