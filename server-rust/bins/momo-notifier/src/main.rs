//! `momo-notifier` entry point: environment → config → pool → the two loops.
//!
//! The process connects as the BYPASSRLS `momo_notifier` role and runs until
//! SIGTERM/SIGINT. Compose/entrypoint wiring is deliberately not part of this
//! batch — the binary exists and boots; which image runs it is the next step.

use momo_notifier::{Notifier, NotifierConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let filter = momo_notifier::config::log_filter();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_new(&filter)
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = NotifierConfig::from_env()?;
    // Log the loop shape, never the connection string.
    tracing::info!(
        reconcile_interval_ms = config.reconcile_interval.as_millis() as u64,
        sweep_interval_ms = config.sweep_interval.as_millis() as u64,
        claim_batch = config.claim_batch_size,
        t3_enabled = config.t3_enabled,
        "starting momo-notifier"
    );

    let notifier = Notifier::connect(config).await?;
    notifier.run(shutdown_signal()).await;
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
