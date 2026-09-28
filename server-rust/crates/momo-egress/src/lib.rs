//! Provider egress guard plumbing (#2852, unified by #2976): a reqwest client
//! may only connect to an address [`momo_settings::EgressPolicy`] accepts.
//!
//! ## Where the check sits, and why there
//!
//! A provider `base_url` (and an OAuth token endpoint) is typed by an instance
//! operator through the GUI, so it is input, not configuration. The write gate
//! refuses private address *literals*, but a name is only a promise:
//! `llm.example.com` can resolve to `169.254.169.254` today, or to a public
//! address at save time and to `127.0.0.1` a second later (DNS rebinding).
//!
//! So the authoritative check is [`GuardedResolver`], installed as the HTTP
//! client's DNS resolver by [`EgressGuard::client`]. reqwest asks it for the
//! addresses of the host it is about to connect to; it resolves, refuses the
//! whole name if **any** answer is non-public, and otherwise returns exactly the
//! addresses it checked. The connector dials only those — there is no second
//! lookup between check and connect for a rebinding resolver to win.
//!
//! Two things a resolver cannot see are closed around it:
//!
//! * **Address literals** never reach a resolver (the connector parses them),
//!   so [`EgressGuard::precheck_host`] decides them before the request is built.
//! * **Redirects and proxies.** The guarded client follows no redirect (a
//!   `307` to `http://169.254.169.254/` would otherwise be dialled as a literal)
//!   and ignores `HTTP(S)_PROXY` (a proxy resolves the target itself, out of
//!   our sight).
//!
//! ## Time
//!
//! `getaddrinfo` has no deadline of its own (review-2972 M1). Every lookup this
//! guard makes — the precheck's and the connect-time resolver's — runs under
//! the deadline the caller constructs the guard with, and a lookup that
//! outlives it is [`EgressDenied::NoAddress`]: an availability failure, never a
//! pass. Callers pass the same per-call budget their reqwest client's total
//! `timeout` uses, so the connect-time bound is unchanged and the precheck gains
//! the bound it lacked. A timed-out `spawn_blocking(getaddrinfo)` thread is not
//! reclaimed; the deadline bounds the caller, not the blocking pool.
//!
//! ## Callers
//!
//! `momo-agent-worker` (provider call + OAuth token refresh) and
//! `momo-provider-probe` (「연결 확인」). Each maps [`EgressDenied`] to its own
//! error vocabulary; neither owns any resolver, precheck, or client-builder code.

use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

pub use momo_settings::{EgressDenied, EgressPolicy};
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

/// The policy, the lookup it judges, and the lookup's deadline.
#[derive(Clone)]
pub struct EgressGuard {
    policy: Arc<EgressPolicy>,
    lookup: Arc<dyn HostLookup>,
    lookup_deadline: Duration,
}

impl EgressGuard {
    pub fn new(
        policy: EgressPolicy,
        lookup: Arc<dyn HostLookup>,
        lookup_deadline: Duration,
    ) -> EgressGuard {
        EgressGuard {
            policy: Arc::new(policy),
            lookup,
            lookup_deadline,
        }
    }

    /// The system resolver.
    pub fn system(policy: EgressPolicy, lookup_deadline: Duration) -> EgressGuard {
        EgressGuard::new(policy, Arc::new(SystemLookup), lookup_deadline)
    }

    /// Resolve `host` within the deadline and return the vetted addresses, or
    /// the refusal. A lookup error or an expired deadline is `NoAddress`.
    async fn resolve_vetted(&self, host: &str) -> Result<Vec<IpAddr>, EgressDenied> {
        self.policy.check_host(host)?;
        let addresses =
            match tokio::time::timeout(self.lookup_deadline, self.lookup.lookup(host.to_string()))
                .await
            {
                Ok(Ok(addresses)) => addresses,
                Ok(Err(_)) | Err(_) => return Err(EgressDenied::NoAddress),
            };
        self.policy.check_resolved(host, &addresses)?;
        Ok(addresses)
    }

    /// The pre-request half: a literal (which no resolver sees) is decided
    /// here, and a name is resolved once so a refused host fails cleanly. The
    /// connect-time resolver re-checks regardless, so passing here grants
    /// nothing.
    ///
    /// `host` is `Url::host_str()` of the URL the client will be given; IPv6
    /// brackets are accepted.
    pub async fn precheck_host(&self, host: &str) -> Result<(), EgressDenied> {
        let bare = host.trim_matches(|c| c == '[' || c == ']');
        if bare.parse::<IpAddr>().is_ok() {
            return self.policy.check_host(bare);
        }
        self.resolve_vetted(bare).await.map(|_| ())
    }

    /// The only way either caller builds a client: guarded resolver, no
    /// redirects, no proxy. Everything else (timeouts) comes from `builder`.
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

/// The connect-time gate (see the module docs).
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
pub fn denied_in_chain(error: &(dyn std::error::Error + 'static)) -> Option<EgressDenied> {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(error) = current {
        if let Some(denied) = error.downcast_ref::<EgressDenied>() {
            return Some(*denied);
        }
        current = error.source();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    struct SlowLookup(Duration);

    impl HostLookup for SlowLookup {
        fn lookup(
            &self,
            _host: String,
        ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>> {
            let delay = self.0;
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                Ok(vec!["93.184.216.34".parse().unwrap()])
            })
        }
    }

    /// A lookup past the deadline is `NoAddress` — never a pass — and returns
    /// at the deadline, not when the resolver finally answers.
    #[tokio::test]
    async fn a_lookup_past_the_deadline_is_no_address_at_the_deadline() {
        let guard = EgressGuard::new(
            EgressPolicy::default(),
            Arc::new(SlowLookup(Duration::from_secs(5))),
            Duration::from_millis(200),
        );
        let started = Instant::now();
        let verdict = guard.precheck_host("slow.example").await;
        assert_eq!(verdict, Err(EgressDenied::NoAddress));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    /// Inside the deadline a public answer still passes (the bound does not
    /// turn every lookup into a refusal).
    #[tokio::test]
    async fn a_lookup_inside_the_deadline_passes() {
        let guard = EgressGuard::new(
            EgressPolicy::default(),
            Arc::new(SlowLookup(Duration::from_millis(10))),
            Duration::from_secs(2),
        );
        assert_eq!(guard.precheck_host("fast.example").await, Ok(()));
    }
}
