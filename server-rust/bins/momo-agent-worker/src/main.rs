//! `momo-agent-worker` entry point: environment → config → pool → the turn loop.
//!
//! The process connects as the BYPASSRLS `momo_worker` role and runs until
//! SIGTERM/SIGINT.
//!
//! The provider is always the real HTTP pair — both wires, routed on the sealed
//! envelope kind (B5.4b, `provider::WireRoutedProvider`). `MockChatProvider`
//! exists in the library for conformance tests and is deliberately unreachable
//! from here: a binary that could answer with canned text because an env var was
//! mistyped would be a far worse failure than refusing to boot.

use momo_agent_worker::{AgentWorker, WorkerConfig};

/// `momo-agent-worker --embed-check` — load the memory embedding model from
/// `MEMORY_EMBED_MODEL_DIR` (default: where the image puts it), embed one Korean sentence and
/// check the shape. The image build runs it, so a model file that is missing, corrupt or not
/// loadable by the bundled ONNX Runtime fails the build instead of degrading a running worker
/// to keyword-only search without anyone noticing. Prints no text, only the verdict.
fn current_rss_kb() -> Option<u64> {
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        return status
            .lines()
            .find_map(|l| l.strip_prefix("VmRSS:"))
            .and_then(|v| v.split_whitespace().next()?.parse().ok());
    }
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

fn embed_check() -> Result<(), Box<dyn std::error::Error>> {
    use momo_embed::TextEmbedder;
    let cfg = momo_agent_worker::config::MemoryConfig::from_env()?;
    let started = std::time::Instant::now();
    let model = momo_embed::OnnxEmbedder::load(
        std::path::Path::new(&cfg.embed_model_dir),
        Some(cfg.embed_threads),
    )?;
    let loaded_ms = started.elapsed().as_millis();
    let query = model.embed_query("배포 일정을 미루기로 했나요")?;
    let passage = model
        .embed_passages(&[
            "4월 릴리스는 QA 일정 때문에 다음 달로 연기하기로 결정했어요".to_string(),
        ])?
        .remove(0);
    let unrelated = model
        .embed_passages(&["점심은 김밥으로 하기로 했어요".to_string()])?
        .remove(0);
    let cos = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
    let (near, far) = (cos(&query, &passage), cos(&query, &unrelated));
    let norm = cos(&query, &query);
    if query.len() != momo_embed::DIMS || (norm - 1.0).abs() > 1e-3 || near <= far {
        return Err(format!(
            "embed-check failed: dims={} norm={norm:.4} related={near:.3} unrelated={far:.3}",
            query.len()
        )
        .into());
    }
    // Steady-state footprint after load + a few batches (Linux: /proc; elsewhere: ps). Measurement
    // aid for the runbook's memory floor; the number is informational.
    let passages: Vec<String> = (0..64)
        .map(|n| format!("4월 릴리스는 QA 일정 때문에 다음 달로 연기하기로 결정했어요 {n}"))
        .collect();
    for chunk in passages.chunks(16) {
        model.embed_passages(chunk)?;
    }
    let rss_mb = current_rss_kb().map(|kb| kb / 1024);
    println!(
        "embed-check ok model={} dims={} load_ms={loaded_ms} rss_mb={} related={near:.3} unrelated={far:.3}",
        model.model_id(),
        query.len(),
        rss_mb.map_or("?".to_string(), |v| v.to_string())
    );
    Ok(())
}

/// A plain `main`, not `#[tokio::main]`: the child branch below has to run **before** a runtime exists.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    // #4970: the helper's PDF reader runs **this binary** as a supervised child with an empty
    // environment. It must be the first thing `main` does — before logging, before any configuration
    // is read — so the child never touches a secret it was not given. It is also before the async
    // runtime (#4970 review R2-1): the child limits its own address space as its first act, and that
    // ceiling counts every thread's stack and allocator arena. A multi-threaded runtime started first
    // puts one worker per visible core under the ceiling (glibc reserves a virtual arena per thread), so
    // on a host with many cores the child would be over it before it read a byte. This way the child is
    // one thread (plus its own watchdog) however many cores there are.
    if std::env::args().nth(1).as_deref() == Some(momo_agent_worker::attachment_text::CHILD_ARG) {
        std::process::exit(momo_agent_worker::attachment_text::child_main(
            momo_workspace_actions::team_ai_attachments::READ_MAX_BYTES as usize,
        ));
    }
    // What `#[tokio::main]` expands to, minus the `expect`: the worker itself is the multi-threaded runtime.
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|a| a == "--embed-check") {
        return embed_check();
    }
    // `RUST_LOG` first, then the prod compose's `LOG_LEVEL`, then `info`.
    let filter = momo_agent_worker::config::log_filter();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_new(&filter)
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = WorkerConfig::from_env()?;
    // Log the loop shape and the redacted provider endpoint — never the
    // connection string, the bearer, or the master key.
    tracing::info!(
        poll_interval_ms = config.poll_interval.as_millis() as u64,
        claim_batch = config.claim_batch_size,
        lease_seconds = config.lease_seconds,
        max_attempts = config.max_attempts,
        provider_mode = config.provider.mode.as_str(),
        provider_endpoint = %config.provider.endpoint_label(),
        provider_link_key_configured = config.provider_link_master_key.is_some(),
        "starting momo-agent-worker"
    );

    // #4820 C2a: a set-but-unusable origin is a silent "no photo address" otherwise. Name the variable,
    // never print its value.
    if std::env::var("OORT_SELF_MEDIA_ORIGIN").is_ok_and(|raw| !raw.trim().is_empty())
        && config.self_media_origin.is_none()
    {
        tracing::warn!(
            "OORT_SELF_MEDIA_ORIGIN is set but is not a canonical origin (https://<lowercase host>[:port], \
             no trailing slash); no picture address will be handed to the co-hosted Hermes"
        );
    }
    // #4934: the same for the api's private address — a typo here is a worker that silently cannot read the
    // picture a person sent. Name the variable, never print its value (a mistyped value may hold userinfo).
    if std::env::var("OORT_API_INTERNAL_ORIGIN").is_ok_and(|raw| !raw.trim().is_empty())
        && config.api_internal_origin.is_none()
    {
        tracing::warn!(
            "OORT_API_INTERNAL_ORIGIN is set but is not an origin (http(s)://<lowercase host>[:port], nothing after \
             it); attachments are read from this worker's own archive configuration instead"
        );
    }
    // #4974: a well-formed value that is not shaped like a private-network address is accepted (the grammar says
    // what an origin looks like, not where it may point), but the single-use token goes wherever it points — so one
    // boot line says so. The variable's name only; the function never prints the value.
    if let Some(origin) = config.api_internal_origin.as_deref() {
        momo_agent_worker::self_media::warn_if_internal_origin_is_not_private(origin);
    }
    tracing::info!(
        attachment_source = if config.api_internal_origin.is_some() {
            "api"
        } else {
            "archive"
        },
        "첨부 읽기 경로 (attachment read path): `api` = through the api's private address, `archive` = this worker's own MOMO_DRIVE_* configuration"
    );
    // #4820 C2b 3부: the hosted expression door opens only on an exact `OORT_HOSTED_MEDIA_STRICT=1`.
    // Without it the door is shut and a photo turn of the co-hosted Hermes is an ordinary turn — say so
    // once at boot (info, the name only, never the value), so an operator who expected the door can see why.
    if !config.hosted_media_strict {
        tracing::info!(
            "호스팅 문 꺼짐 (hosted expression door off): OORT_HOSTED_MEDIA_STRICT is not exactly `1`; \
             photo turns of the co-hosted Hermes are ordinary turns"
        );
    }
    let worker = AgentWorker::connect(config).await?;
    worker.run(shutdown_signal()).await;
    Ok(())
}

async fn shutdown_signal() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = interrupt => {}
        _ = terminate => {}
    }
    tracing::info!("shutdown signal received");
}
