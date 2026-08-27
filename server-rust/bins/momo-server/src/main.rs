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
        agent_port_rate_limit_per_token = config.agent_port.per_token_limit,
        agent_port_rate_limit_per_agent = config.agent_port.per_agent_limit,
        agent_port_rate_limit_per_ip = config.agent_port.per_ip_limit,
        agent_port_external_origin_configured = config.agent_port.external_origin.is_some(),
        // MOMO-605: how wide the cross-origin surface is. A count, not the list —
        // the origins themselves go in the warn below only when one was refused.
        cors_allowed_origins = config.cors.allowed_origins.len(),
        // ADR-0110 / ADR-0167: Fixed prints the URL; SameOrigin prints the mode
        // name. Never a secret.
        realtime_ws_url = %config.realtime_ws_url,
        // ADR-0151: which archive backs attachments. The backend name and
        // whether a shared drive was named — never the key path's contents and
        // never a token.
        drive_backend = %config.drive.backend,
        drive_local_base = %config.drive.local_base(
            config.port,
            &format!("http://127.0.0.1:{}", config.port)
        ),
        drive_configured = config.drive.shared_drive_id.is_some()
            || config.drive.backend == momo_drive::LOCAL_BACKEND,
        livekit_configured = config.livekit.is_some(),
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
            "RATE_LIMIT_PER_IP=0 disables the per-IP limiter on POST /v1/join; \
             that route accepts an invite code in the body"
        );
    }
    if config.rate_limit.claim_per_ip_limit == 0 {
        tracing::warn!(
            "RATE_LIMIT_CLAIM_PER_IP=0 disables the per-IP limiter on POST /v1/claim; \
             that route accepts a claim token in the body"
        );
    }
    if config.realtime.cent_token_hmac.is_none() || config.realtime.cent_proxy_secret.is_none() {
        tracing::warn!(
            "CENT_TOKEN_HMAC / CENT_PROXY_SECRET not both set; the realtime rail is \
             fail-closed (no connection tokens, every subscribe callback 401). \
             REST still serves."
        );
    }
    // LIVE-5a: silence here would read as "the TTL you asked for is what you
    // got". It is not, and the direction matters — a credential configured to
    // outlive a day is the static shared password this goal exists to retire,
    // wearing the word "ephemeral".
    if let Some(requested) = config.turn_ttl_clamped_from {
        tracing::warn!(
            requested_seconds = requested,
            applied_seconds = momo_t3::MAX_TURN_CREDENTIAL_TTL_SECONDS,
            "MOMO_TURN_CREDENTIAL_TTL_SECONDS exceeds the ceiling and was CLAMPED. \
             A relay credential that lives longer than a day is not scoped by \
             anything an operator can reason about; if you need one, rotate \
             MOMO_TURN_STATIC_AUTH_SECRET on a schedule instead — that bounds every \
             credential at once."
        );
    }
    if config.agent_gateway.legacy_secret_enabled() {
        tracing::warn!(
            "MOMO_ALLOW_LEGACY_GATEWAY_SECRET is on; rotate gateway callers to \
             per-agent bearers — the shared secret names no member, so its actions \
             are unattributable"
        );
    }

    // ADR-0151: build the archive before the pool, because `build_archive`
    // reads the service-account key off disk and a misconfiguration should be in
    // the log before anything else is opened. It never fails — an unreadable key
    // degrades to the unavailable archive and the three attachment routes answer
    // 503 (see `momo_drive::build_archive`).
    let drive = momo_drive::build_archive(&config.drive.backend_config(config.port)).await;
    if config.drive.backend == momo_drive::STUB_BACKEND {
        tracing::warn!(
            "MOMO_DRIVE_ARCHIVE_BACKEND=stub — attachments are held in memory and are \
             LOST on restart. Refused outright in a deployed environment; this instance \
             is not one."
        );
    }
    if config.drive.backend == momo_drive::LOCAL_BACKEND {
        tracing::info!(
            "MOMO_DRIVE_ARCHIVE_BACKEND=local — attachments are stored under \
             MOMO_DRIVE_LOCAL_DIR and survive a restart"
        );
    }

    // ADR-0156 D4-④: the managed provisioner, built once from the process
    // environment. Absent whenever T3 is off, the default provider is the
    // degenerate one, or the operator supplied no endpoint for it — and in all
    // three cases the acquisition route answers 503 rather than writing a
    // billable row against a substrate nobody can reach (ADR-0142 D4).
    //
    // Deliberately gated on `t3.enabled` as well as on configuration: a disabled
    // instance must not even hold the object that can create paid instances.
    let t3_provisioner = config
        .t3
        .enabled
        .then(|| momo_t3::provisioner_from_process_env(&config.t3.default_provider_id))
        .flatten()
        .map(std::sync::Arc::new);
    tracing::info!(
        t3_provisioner_ready = t3_provisioner.is_some(),
        "oort Cloud managed provisioner resolved"
    );

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
    // ADR-0162: the Agent Port has its own token/agent/IP bounds and an optional
    // trusted Origin comparison. It never borrows the public join knobs.
    .with_agent_port(config.agent_port)
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
    .with_ephemeral(config.ephemeral.clone())
    // #1222: the webhook families. Unlike the builders above this one closes
    // nothing when unset — `OUTBOUND_WEBHOOK_MASTER_KEY` falls back to JWT_HMAC
    // exactly as Swift's `Config` does, because the outbound signing secret is
    // *derived*: a different key would silently stop every already-installed
    // subscriber's signature from verifying, with no row anywhere recording it.
    .with_webhook(config.webhook.clone())
    // ADR-0151: the attachment surface answers 503 unless the operator named a
    // service-account key and a shared drive. The routes are mounted either way,
    // so "no archive here" is distinguishable from "no such route".
    // ADR-0169 증보 1: local capability URLs follow the 0167 Host/XFP pair
    // when the operator named `same-origin`; google/stub stay Fixed-empty.
    .with_drive(drive)
    .with_drive_local_base(
        config
            .drive
            .local_base(config.port, &format!("http://127.0.0.1:{}", config.port)),
    );
    let state = match config.livekit.clone() {
        Some(livekit) => state.with_livekit(livekit),
        None => state,
    };
    // ADR-0156 D4-④: attached only when one was actually built, so "no managed
    // substrate here" stays distinguishable from "one that cannot be reached".
    let state = match t3_provisioner {
        Some(provisioner) => state.with_t3_provisioner(provisioner),
        None => state,
    };
    // LIVE-5a / ADR-0165 증보 1 D3-2: per-session ephemeral TURN credentials,
    // attached only when the operator gave this process a relay AND its
    // `static-auth-secret`. Without both, the display routes hand back an empty
    // `ice_servers` and the producer keeps the static credential the install
    // runbook shipped — the overlap that makes 「신규 실증 → 정적 제거」 possible
    // on a relay that is already carrying production traffic.
    let state = match config.turn.clone() {
        Some(policy) => state.with_turn(policy),
        None => state,
    };
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
