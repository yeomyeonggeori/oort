//! Provider egress guard (#2852): the provider call may only connect to an
//! address [`momo_settings::EgressPolicy`] accepts.
//!
//! ## Where the check sits, and why there
//!
//! `provider_link.base_url` is typed by an instance operator through the GUI,
//! so it is input, not configuration. The write gate refuses private address
//! *literals*, but a name is only a promise: `llm.example.com` can resolve to
//! `169.254.169.254` today, or to a public address at save time and to
//! `127.0.0.1` a second later (DNS rebinding).
//!
//! So the authoritative check is [`GuardedResolver`], installed as the HTTP
//! client's DNS resolver. reqwest asks it for the addresses of the host it is
//! about to connect to; it resolves, refuses the whole name if **any** answer is
//! non-public, and otherwise returns exactly the addresses it checked. The
//! connector dials only those — there is no second lookup between check and
//! connect for a rebinding resolver to win.
//!
//! Two things a resolver cannot see are closed around it:
//!
//! * **Address literals** never reach a resolver (the connector parses them),
//!   so [`EgressGuard::precheck`] decides them before the request is built.
//! * **Redirects and proxies.** The guarded client follows no redirect (a
//!   `307` to `http://169.254.169.254/` would otherwise be dialled as a literal)
//!   and ignores `HTTP(S)_PROXY` (a proxy resolves the target itself, out of
//!   our sight).
//!
//! The precheck also resolves a name once, so a refused host fails the turn
//! with [`ProviderError::EgressDenied`] — non-retryable — instead of surfacing
//! as a transport error the cascade would retry.

use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;

use momo_settings::{EgressDenied, EgressPolicy};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};

use crate::provider::ProviderError;

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

    pub fn system(policy: EgressPolicy) -> EgressGuard {
        EgressGuard::new(policy, Arc::new(SystemLookup))
    }

    /// Resolve `host` and return the vetted addresses, or the refusal.
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

    /// The pre-request half: literals (which no resolver sees) and one early
    /// resolution for a clean, non-retryable failure. The connect-time
    /// resolver re-checks regardless, so passing here grants nothing.
    pub async fn precheck(&self, url: &str) -> Result<(), ProviderError> {
        let host = reqwest::Url::parse(url)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_string))
            .ok_or_else(|| ProviderError::EgressDenied("provider URL has no host".into()))?;
        let bare = host.trim_matches(|c| c == '[' || c == ']');
        if bare.parse::<IpAddr>().is_ok() {
            return self
                .policy
                .check_host(bare)
                .map_err(|denied| ProviderError::EgressDenied(denied.to_string()));
        }
        self.resolve_vetted(bare)
            .await
            .map(|_| ())
            .map_err(|denied| match denied {
                // An unresolvable name is an availability problem, not a
                // policy verdict: keep it retryable, as it always was.
                EgressDenied::NoAddress => ProviderError::Unreachable(denied.to_string()),
                EgressDenied::NonPublicAddress => ProviderError::EgressDenied(denied.to_string()),
            })
    }

    /// The HTTP client every provider call uses: guarded resolver, no
    /// redirects, no proxy.
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::provider::{
        ChatMessage, ChatProvider, ChatRequest, ProviderEndpoint, ProviderWire, WireRoutedProvider,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// Answers each lookup from a script; the last entry repeats.
    pub(crate) struct ScriptedLookup {
        answers: Vec<Vec<IpAddr>>,
        calls: AtomicUsize,
    }

    impl ScriptedLookup {
        pub(crate) fn new(answers: &[&[&str]]) -> Arc<ScriptedLookup> {
            Arc::new(ScriptedLookup {
                answers: answers
                    .iter()
                    .map(|set| set.iter().map(|raw| raw.parse().expect(raw)).collect())
                    .collect(),
                calls: AtomicUsize::new(0),
            })
        }

        pub(crate) fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl HostLookup for ScriptedLookup {
        fn lookup(
            &self,
            _host: String,
        ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let answer = self.answers[call.min(self.answers.len() - 1)].clone();
            Box::pin(async move { Ok(answer) })
        }
    }

    /// A loopback "internal service" that counts every connection it accepts
    /// and answers each with one OpenAI completion. A hit is the SSRF.
    pub(crate) async fn internal_service() -> (u16, Arc<AtomicUsize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut seen = Vec::new();
                    let mut buffer = [0u8; 4096];
                    loop {
                        if let Some(end) = seen.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&seen[..end]).to_lowercase();
                            let length = head
                                .lines()
                                .find_map(|line| line.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            if seen.len() >= end + 4 + length {
                                break;
                            }
                        }
                        match socket.read(&mut buffer).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => seen.extend_from_slice(&buffer[..n]),
                        }
                    }
                    let body = r#"{"choices":[{"message":{"content":"internal secret"}}]}"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (port, hits)
    }

    fn endpoint(base_url: String) -> ProviderEndpoint {
        ProviderEndpoint {
            base_url,
            bearer: "sk-live-egress".into(),
            source: "database",
            wire: ProviderWire::ChatCompletions,
            account_id: None,
        }
    }

    fn request() -> ChatRequest {
        ChatRequest {
            model: "m".into(),
            messages: vec![ChatMessage::user("hi")],
            max_tokens: None,
            tools: Vec::new(),
            momo_tools: Vec::new(),
        }
    }

    fn provider(policy: EgressPolicy, lookup: Arc<dyn HostLookup>) -> WireRoutedProvider {
        WireRoutedProvider::http_guarded(Duration::from_secs(5), EgressGuard::new(policy, lookup))
            .expect("client")
    }

    /// RED proof for #2852: a public-looking name that resolves to a private
    /// address never reaches the private service.
    #[tokio::test]
    async fn a_name_resolving_to_a_private_address_is_refused_before_connect() {
        let (port, hits) = internal_service().await;
        let lookup = ScriptedLookup::new(&[&["127.0.0.1"]]);
        let result = provider(EgressPolicy::default(), lookup)
            .complete(
                &endpoint(format!("http://llm.attacker.example:{port}/v1")),
                &request(),
            )
            .await;
        assert!(
            matches!(result, Err(ProviderError::EgressDenied(_))),
            "{result:?}"
        );
        assert!(!result.as_ref().unwrap_err().is_retryable());
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "the internal service was dialled"
        );
    }

    /// Rebinding: public on the first lookup, private on the next. The
    /// precheck passes; the connect-time resolver must still refuse.
    #[tokio::test]
    async fn dns_rebinding_between_check_and_connect_is_refused_at_connect() {
        let (port, hits) = internal_service().await;
        let lookup = ScriptedLookup::new(&[&["93.184.216.34"], &["127.0.0.1"]]);
        let result = provider(EgressPolicy::default(), lookup.clone())
            .complete(
                &endpoint(format!("http://rebind.attacker.example:{port}/v1")),
                &request(),
            )
            .await;
        assert_eq!(
            lookup.calls(),
            2,
            "the scenario needs the precheck to see the public answer and the connector the private one"
        );
        assert!(
            matches!(&result, Err(ProviderError::Unreachable(_))),
            "{result:?}"
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "rebinding reached the service"
        );
    }

    #[tokio::test]
    async fn private_literals_v4_v6_and_mapped_are_refused() {
        let (port, hits) = internal_service().await;
        for base in [
            format!("http://127.0.0.1:{port}/v1"),
            format!("http://[::ffff:127.0.0.1]:{port}/v1"),
            format!("http://[::1]:{port}/v1"),
            format!("http://169.254.169.254:{port}/v1"),
        ] {
            let result = provider(EgressPolicy::default(), ScriptedLookup::new(&[&[]]))
                .complete(&endpoint(base.clone()), &request())
                .await;
            assert!(
                matches!(result, Err(ProviderError::EgressDenied(_))),
                "{base}: {result:?}"
            );
        }
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    /// The operator's opt-in (ADR-0004 증보 D2/D3) still reaches an in-house
    /// LLM: flag on and the host listed exactly.
    #[tokio::test]
    async fn the_listed_host_under_the_flag_is_allowed() {
        let (port, hits) = internal_service().await;
        let policy = EgressPolicy {
            allow_local: true,
            local_hosts: vec!["llm.internal".into()],
            operator_hosts: Vec::new(),
        };
        let completion = provider(policy, ScriptedLookup::new(&[&["127.0.0.1"]]))
            .complete(
                &endpoint(format!("http://llm.internal:{port}/v1")),
                &request(),
            )
            .await
            .expect("listed host is allowed");
        assert_eq!(completion.text, "internal secret");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    /// A redirect to a private literal is not followed.
    #[tokio::test]
    async fn a_redirect_is_not_followed() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (internal_port, hits) = internal_service().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = [0u8; 4096];
                let _ = socket.read(&mut buffer).await;
                let response = format!(
                    "HTTP/1.1 307 Temporary Redirect\r\nlocation: http://127.0.0.1:{internal_port}/v1/chat/completions\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        let policy = EgressPolicy {
            allow_local: true,
            local_hosts: vec!["front.internal".into()],
            operator_hosts: Vec::new(),
        };
        let result = provider(policy, ScriptedLookup::new(&[&["127.0.0.1"]]))
            .complete(
                &endpoint(format!("http://front.internal:{port}/v1")),
                &request(),
            )
            .await;
        assert!(
            matches!(result, Err(ProviderError::HttpStatus(307, _))),
            "{result:?}"
        );
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }
}
