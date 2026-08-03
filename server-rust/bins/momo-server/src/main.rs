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
        // B4.2: whether the two settings gates are open. A boolean and a count —
        // never the master key, never an operator's address.
        provider_link_configurable = config.settings.provider_link_master_key.is_some(),
        instance_operators = config.settings.platform_admin_emails.len(),
        // B4.3: what guards the one unauthenticated write (`POST /v1/join`).
        rate_limit_per_ip = config.rate_limit.per_ip_limit,
        rate_limit_window_seconds = config.rate_limit.window_seconds,
        // MOMO-605: how wide the cross-origin surface is. A count, not the list —
        // the origins themselves go in the warn below only when one was refused.
        cors_allowed_origins = config.cors.allowed_origins.len(),
        "momo-server starting"
    );
    // MOMO-605: a refused entry is silent otherwise, and silence here reads as
    // "the allowlist worked" while the desktop client still cannot log in.
    if !config.cors.rejected_entries.is_empty() {
        tracing::warn!(
            rejected = ?config.cors.rejected_entries,
            "MOMO_CORS_ALLOWED_ORIGINS had entries that are not exact origins \
             (wildcards, `null`, a trailing slash or a path are all refused); they \
             were DROPPED. A typo can only narrow this allowlist, never widen it — \
             so the surface is now narrower than the operator intended."
        );
    }
    if config.rate_limit.per_ip_limit == 0 {
        tracing::warn!(
            "RATE_LIMIT_PER_IP=0 disables the per-IP limiter; POST /v1/join is the \
             only unauthenticated write on this instance and it accepts an invite \
             code in the body"
        );
    }
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
    .with_realtime(config.realtime.clone())
    // B4.2: the AI-연결 family stays 503 unless the operator supplied
    // PROVIDER_LINK_MASTER_KEY, and the instance-global surfaces admit only a
    // `platform:read` token unless PLATFORM_ADMIN_EMAILS lists someone.
    .with_settings(config.settings.clone())
    // B4.3: the per-IP limiter in front of `POST /v1/join`. On by default —
    // `RATE_LIMIT_PER_IP=0` is the only way to turn it off, and the boot warns
    // when someone does.
    .with_rate_limit(config.rate_limit)
    // B5.2: mention→run routing is always on (routing an `@mention` to its agent
    // is the product); the only knob is how much history rides the job.
    .with_mentions(config.mentions.clone())
    // MOMO-605: no cross-origin surface at all unless the operator named an
    // origin in MOMO_CORS_ALLOWED_ORIGINS.
    .with_cors(config.cors.clone())
    // ADR-0149 (SRV-T2): 휘발 신호 stays 503 unless the operator handed this
    // process the Centrifugo publish credential (CENT_API_URL + CENT_API_KEY).
    // No deployment did before this batch, so an un-updated env block keeps the
    // surface closed rather than half-open.
    .with_ephemeral(config.ephemeral.clone());
    let app = build_app(state);

    let address: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "listening");

    // `into_make_service_with_connect_info` is what gives the rate limiter a
    // socket peer to fall back on when there is no `X-Forwarded-For` — i.e. a
    // directly exposed deployment. Without it every un-proxied request would be
    // unattributable and therefore unlimited.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
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
