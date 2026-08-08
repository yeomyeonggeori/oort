//! `momo-relay` entry point: environment → config → pool → drain loop.
//!
//! The process connects as the BYPASSRLS `momo_relay` role and runs until
//! SIGTERM/SIGINT.

use momo_relay::{Relay, RelayConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // `RUST_LOG` first, then the prod compose's `LOG_LEVEL`, then `info`
    // (`momo_relay::config::log_filter`).
    let filter = momo_relay::config::log_filter();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_new(&filter)
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = RelayConfig::from_env()?;
    // Log the target shape, never the connection string or the API key.
    tracing::info!(
        cent_api_url = %config.cent_api_url,
        claim_batch = config.claim_batch_size,
        max_attempts = config.max_attempts,
        "starting momo-relay"
    );

    let relay = Relay::connect(config).await?;
    relay.run(shutdown_signal()).await;
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
