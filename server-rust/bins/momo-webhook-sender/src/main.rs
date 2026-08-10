//! `momo-webhook-sender` entry point: environment → config → pool → drain loop.
//!
//! The process connects as a BYPASSRLS role (the drain crosses every tenant) and
//! runs until SIGTERM/SIGINT. It holds **one** credential the api does not: the
//! outbound signing master key. It holds no Centrifugo key and cannot publish to
//! the durable rail — the two workers' capabilities are disjoint by construction.

use momo_webhook_sender::{SenderConfig, WebhookSender};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let filter = momo_webhook_sender::config::log_filter();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_new(&filter)
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = SenderConfig::from_env()?;
    // The shape only. Never the connection string, never the master key —
    // `SenderConfig`'s hand-written `Debug` exists for the same reason.
    tracing::info!(
        claim_batch = config.claim_batch_size,
        max_attempts = config.max_attempts,
        disable_after_5xx = config.disable_after_server_failures,
        allow_development_http = config.allow_development_http,
        "starting momo-webhook-sender"
    );

    let sender = WebhookSender::connect(config).await?;
    sender.run(shutdown_signal()).await;
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
