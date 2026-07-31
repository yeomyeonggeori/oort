//! `momo-server` entry point: environment → config → pool → serve.
//!
//! Nothing but wiring lives here. The process exits non-zero on a
//! misconfiguration (missing DB target or JWT secret) rather than booting with a
//! baked-in development credential.

use std::net::SocketAddr;

use momo_server::config::Config;
use momo_server::{build_app, AppState};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // `RUST_LOG` first, then the prod compose's `LOG_LEVEL`, then `info`
    // (`config::log_filter`). An unparsable directive degrades to `info` rather
    // than killing the process over a logging knob.
    let filter = momo_server::config::log_filter();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_new(&filter)
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env()?;
    // Log the shape of the deployment, never a credential.
    tracing::info!(
        environment = %config.environment,
        host = %config.host,
        port = config.port,
        db_host = %config.db.host,
        db_port = config.db.port,
        db_name = %config.db.database,
        // Whether momo Cloud is on, and which adapter new hosts use. Never an
        // endpoint or a key — those stay in the process (invariant #7).
        t3_enabled = config.t3.enabled,
        t3_provider = %config.t3.default_provider_id,
        // Which agent runtime path is live, and whether the deprecated shared
        // secret is still accepted. The secret itself is never logged.
        agent_gateway_mode = config.agent_gateway.mode.as_str(),
        agent_gateway_legacy_secret = config.agent_gateway.legacy_secret_enabled(),
        // B4: whether the realtime rail can be served at all. Booleans only —
        // neither Centrifugo secret is ever logged.
        realtime_token_issuable = config.realtime.cent_token_hmac.is_some(),
        realtime_subscribe_proxy = config.realtime.cent_proxy_secret.is_some(),
        "momo-server starting"
    );
    if config.realtime.cent_token_hmac.is_none() || config.realtime.cent_proxy_secret.is_none() {
        tracing::warn!(
            "CENT_TOKEN_HMAC / CENT_PROXY_SECRET not both set; the realtime rail is \
             fail-closed (no connection tokens, every subscribe callback 401). \
             REST still serves."
        );
    }
    if config.agent_gateway.legacy_secret_enabled() {
        tracing::warn!(
            "MOMO_ALLOW_LEGACY_GATEWAY_SECRET is on; rotate gateway callers to \
             per-agent bearers — the shared secret names no member, so its actions \
             are unattributable"
        );
    }

    let pool = momo_db::connect(&config.db).await?;
    let state = AppState::new(
        pool,
        config.jwt_secret.clone(),
        config.realtime_ws_url.clone(),
    )
    // B2.2: T3 stays off unless the operator configured it (MOMO_T3_ENABLED=1).
    .with_t3(config.t3.clone())
    // B2.6: the gateway callback surface stays 403 unless the operator selected
    // AGENT_GATEWAY_MODE=gateway.
    .with_agent_gateway(config.agent_gateway.clone())
    // B4: connection-token issuance and the subscribe proxy stay shut unless the
    // operator supplied CENT_TOKEN_HMAC / CENT_PROXY_SECRET.
    .with_realtime(config.realtime.clone());
    let app = build_app(state);

    let address: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Drain in-flight requests on SIGTERM/SIGINT (compose stop, deploy rollover).
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
    tracing::info!("shutdown signal received; draining");
}
