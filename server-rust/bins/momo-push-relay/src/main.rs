//! `momo-push-relay` entry point: environment → config → serve.
//!
//! A configuration refusal is exit 78 (EX_CONFIG) with one operator-readable
//! line. Compose restart-loops, so that line has to survive `docker logs`.

use momo_push_relay::{build_router, ApnsSender, AppState, RelayConfig, SenderMode, EX_CONFIG};

#[tokio::main]
async fn main() {
    let filter = std::env::var("RUST_LOG")
        .or_else(|_| std::env::var("LOG_LEVEL"))
        .unwrap_or_else(|_| "info".into());
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_new(&filter)
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = match RelayConfig::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("PushRelay refused to start — {error}");
            std::process::exit(EX_CONFIG);
        }
    };

    let sender = match config.sender_mode {
        SenderMode::Stub => ApnsSender::Stub(momo_push_relay::sender::StubApnsSender::new(
            config.stub_status,
            config.stub_reason.clone(),
            config.stub_capture_path.clone(),
        )),
        SenderMode::Live => {
            let environment = config
                .apns_environment
                .expect("live mode always sets apns_environment");
            match momo_push_relay::sender::LiveApnsSender::new(
                environment,
                config
                    .apns_key_path
                    .as_deref()
                    .expect("live mode always sets apns_key_path"),
                config
                    .apns_key_id
                    .clone()
                    .expect("live mode always sets apns_key_id"),
                config
                    .apns_team_id
                    .clone()
                    .expect("live mode always sets apns_team_id"),
            ) {
                Ok(sender) => ApnsSender::Live(sender),
                Err(error) => {
                    eprintln!("PushRelay refused to start — {error}");
                    std::process::exit(EX_CONFIG);
                }
            }
        }
    };

    tracing::info!(
        host = %config.host,
        port = config.port,
        registered_servers = config.servers.len(),
        rate_limit_per_minute = config.rate_limit_per_minute,
        sender_mode = config.sender_mode.as_str(),
        "starting PushRelay"
    );

    let state = AppState::from_config(&config, sender);
    let listener = match tokio::net::TcpListener::bind(config.listen_addr()).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!(
                "PushRelay refused to start — cannot bind {}: {error}",
                config.listen_addr()
            );
            std::process::exit(EX_CONFIG);
        }
    };
    if let Err(error) = axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        tracing::error!(error = %error, "PushRelay server exited");
        std::process::exit(1);
    }
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
