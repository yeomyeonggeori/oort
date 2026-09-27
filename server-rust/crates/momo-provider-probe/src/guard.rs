//! The #2852 egress guard, adapted to this crate's reqwest client.
//!
//! The **decision** is `momo_settings::EgressPolicy` — the same `check_host` /
//! `check_resolved` the agent-worker's provider client uses (ADR-0004 증보 5
//! D2). This module is only the plumbing that makes the socket open to exactly
//! the addresses that decision accepted:
//!
//! * [`GuardedResolver`] is the client's DNS resolver. It resolves, refuses the
//!   whole name if **any** answer is non-public, and hands the connector only
//!   the addresses it checked — no second lookup for a rebinding resolver to win.
//! * Address literals never reach a resolver, so [`EgressGuard::precheck`]
//!   decides them before the request is built.
//! * The client follows no redirect and ignores `HTTP(S)_PROXY` (D3).
//!
//! The agent-worker carries the same adapter in `bins/momo-agent-worker/src/egress.rs`.
//! Two copies of ~60 lines of plumbing over one policy is the price of the
//! worker being a binary; unifying them is a follow-up, not a policy fork.

use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;

use momo_settings::{EgressDenied, EgressPolicy};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};

/// A DNS lookup, as a seam: production uses the system resolver, tests use a
/// table that can answer differently on each call (the rebinding scenario).
pub trait HostLookup: Send + Sync {
    fn lookup(
        &self,
        host: String,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>>;
}

/// `getaddrinfo` via tokio.
pub struct SystemLookup;

impl HostLookup for SystemLookup {
    fn lookup(
        &self,
        host: String,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>> {
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((host.as_str(), 0)).await?;
            Ok(addresses.map(|address| address.ip()).collect())
        })
    }
}

/// The policy plus the lookup it judges.
#[derive(Clone)]
pub struct EgressGuard {
    policy: Arc<EgressPolicy>,
    lookup: Arc<dyn HostLookup>,
}

impl EgressGuard {
    pub fn new(policy: EgressPolicy, lookup: Arc<dyn HostLookup>) -> EgressGuard {
        EgressGuard {
            policy: Arc::new(policy),
            lookup,
        }
    }

    async fn resolve_vetted(&self, host: &str) -> Result<Vec<IpAddr>, EgressDenied> {
        self.policy.check_host(host)?;
        let addresses = self
            .lookup
            .lookup(host.to_string())
            .await
            .map_err(|_| EgressDenied::NoAddress)?;
        self.policy.check_resolved(host, &addresses)?;
        Ok(addresses)
    }

    /// The pre-request half: a literal (which no resolver sees) is decided
    /// here, and a name is resolved once so a refused host fails cleanly. The
    /// connect-time resolver re-checks regardless, so passing here grants
    /// nothing.
    pub async fn precheck(&self, host: &str) -> Result<(), EgressDenied> {
        let bare = host.trim_matches(|c| c == '[' || c == ']');
        if bare.parse::<IpAddr>().is_ok() {
            return self.policy.check_host(bare);
        }
        self.resolve_vetted(bare).await.map(|_| ())
    }

    /// The only client this crate builds: guarded resolver, no redirects, no
    /// proxy.
    pub fn client(
        &self,
        builder: reqwest::ClientBuilder,
    ) -> Result<reqwest::Client, reqwest::Error> {
        builder
            .dns_resolver(Arc::new(GuardedResolver {
                guard: self.clone(),
            }))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
    }
}

struct GuardedResolver {
    guard: EgressGuard,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let guard = self.guard.clone();
        Box::pin(async move {
            let addresses = guard
                .resolve_vetted(name.as_str())
                .await
                .map_err(|denied| Box::new(denied) as Box<dyn std::error::Error + Send + Sync>)?;
            let addrs: Addrs = Box::new(
                addresses
                    .into_iter()
                    .map(|ip| SocketAddr::new(ip, 0))
                    .collect::<Vec<_>>()
                    .into_iter(),
            );
            Ok(addrs)
        })
    }
}

/// Was this transport error the connect-time resolver refusing the address?
/// Walks the `source()` chain, because reqwest wraps the resolver's error.
pub(crate) fn denied_in_chain(error: &(dyn std::error::Error + 'static)) -> Option<EgressDenied> {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(error) = current {
        if let Some(denied) = error.downcast_ref::<EgressDenied>() {
            return Some(*denied);
        }
        current = error.source();
    }
    None
}
