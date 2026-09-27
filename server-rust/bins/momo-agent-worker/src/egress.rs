//! Provider egress guard (#2852): the provider call — and the OAuth token
//! refresh (#2894) — may only connect to an address
//! [`momo_settings::EgressPolicy`] accepts.
//!
//! The plumbing (guarded DNS resolver, literal precheck, lookup deadline, no
//! redirect, no proxy) lives in [`momo_egress`] and is shared with
//! `momo-provider-probe` (#2976); see that crate's docs for why the check sits
//! in the resolver. This module only adapts it to the worker's vocabulary:
//! a URL instead of a host, and [`ProviderError`] instead of
//! [`momo_settings::EgressDenied`].
//!
//! The precheck resolves a name once, so a refused host fails the turn with
//! [`ProviderError::EgressDenied`] — non-retryable — instead of surfacing as a
//! transport error the cascade would retry. An unresolvable name, or one whose
//! lookup outlives the guard's deadline (the call's `request_timeout`), is
//! [`ProviderError::Unreachable`]: availability, retryable, as it always was.

pub use momo_egress::{EgressGuard, HostLookup, SystemLookup};
use momo_settings::EgressDenied;

use crate::provider::ProviderError;

/// The pre-request half of the guard for a full URL. The connect-time
/// resolver re-checks regardless, so passing here grants nothing.
pub async fn precheck_url(guard: &EgressGuard, url: &str) -> Result<(), ProviderError> {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .ok_or_else(|| ProviderError::EgressDenied("provider URL has no host".into()))?;
    guard
        .precheck_host(&host)
        .await
        .map_err(|denied| match denied {
            // An unresolvable name is an availability problem, not a
            // policy verdict: keep it retryable, as it always was.
            EgressDenied::NoAddress => ProviderError::Unreachable(denied.to_string()),
            EgressDenied::NonPublicAddress => ProviderError::EgressDenied(denied.to_string()),
        })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::provider::{
        ChatMessage, ChatProvider, ChatRequest, ProviderEndpoint, ProviderWire, WireRoutedProvider,
    };
    use momo_settings::EgressPolicy;
    use std::future::Future;
    use std::net::IpAddr;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
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
        let timeout = Duration::from_secs(5);
        WireRoutedProvider::http_guarded(timeout, EgressGuard::new(policy, lookup, timeout))
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

    /// A resolver that takes `delay` to answer, with a public address.
    pub(crate) struct SlowLookup {
        pub(crate) delay: Duration,
    }

    impl HostLookup for SlowLookup {
        fn lookup(
            &self,
            _host: String,
        ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>> {
            let delay = self.delay;
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                Ok(vec!["93.184.216.34".parse().expect("ip")])
            })
        }
    }

    /// #2976 (review-2972 M1, worker side): the precheck lookup is inside the
    /// call's budget. Before the shared guard this waited the full 6 s.
    #[tokio::test]
    async fn a_slow_dns_lookup_is_bounded_by_the_request_timeout() {
        let timeout = Duration::from_millis(300);
        let provider = WireRoutedProvider::http_guarded(
            timeout,
            EgressGuard::new(
                EgressPolicy::default(),
                Arc::new(SlowLookup {
                    delay: Duration::from_secs(6),
                }),
                timeout,
            ),
        )
        .expect("client");
        let started = std::time::Instant::now();
        let result = provider
            .complete(&endpoint("https://slow-dns.example/v1".into()), &request())
            .await;
        let elapsed = started.elapsed();
        assert!(elapsed < Duration::from_secs(2), "took {elapsed:?}");
        assert!(
            matches!(&result, Err(ProviderError::Unreachable(_))),
            "{result:?}"
        );
        assert!(
            result.as_ref().unwrap_err().is_retryable(),
            "a slow resolver is availability, not policy"
        );
    }

    /// The review-2972 PoC's address-notation variants, pointed at a live
    /// loopback service. The lookup answers a PUBLIC address, so a variant the
    /// precheck mistook for a name (while the connector parsed it as a literal)
    /// would pass the precheck and be dialled — a hit is the regression.
    fn notation_variants(port: u16) -> Vec<String> {
        vec![
            format!("http://front.test@127.0.0.1:{port}/v1"),
            format!("http://front.test:x@0x7f000001:{port}/v1"),
            format!("http://2130706433:{port}/v1"),
            format!("HTTP://0177.0.0.1:{port}/v1"),
            format!("http://%31%32%37.0.0.1:{port}/v1"),
            format!("http://127.0.0.1.:{port}/v1"),
            format!("http:\\\\127.0.0.1:{port}/v1"),
            format!("http://\u{2460}\u{2461}\u{2466}.0.0.1:{port}/v1"),
            format!("http://[::ffff:0:7f00:1]:{port}/v1"),
            format!("http://[::ffff:7f00:1]:{port}/v1"),
            format!("http://0.0.0.0:{port}/v1"),
            format!("http://[::]:{port}/v1"),
        ]
    }

    #[tokio::test]
    async fn address_notation_variants_are_refused_and_never_dialled() {
        let (port, hits) = internal_service().await;
        for base in notation_variants(port) {
            let result = provider(
                EgressPolicy::default(),
                ScriptedLookup::new(&[&["93.184.216.34"]]),
            )
            .complete(&endpoint(base.clone()), &request())
            .await;
            assert!(
                matches!(result, Err(ProviderError::EgressDenied(_))),
                "{base}: {result:?}"
            );
        }
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "a notation variant was dialled"
        );
    }
}
