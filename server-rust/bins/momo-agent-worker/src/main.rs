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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
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
