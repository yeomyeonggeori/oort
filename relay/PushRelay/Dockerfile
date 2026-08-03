# syntax=docker/dockerfile:1
#
# PushRelay — the Dawn-operated APNs boundary (ADR-0120 P-3), as an image.
#
#   docker build -f relay/PushRelay/Dockerfile -t momo-push-relay:dev .
#
# ## Why this file is the thing that was missing
#
# APNs keys (`.p8`) belong to the App Store distributor. A self-hosted momo
# server has no Apple Developer account and therefore cannot talk to
# `api.push.apple.com` at all — it hands an id-only dispatch to this relay, which
# holds the key and does the HTTP/2 leg (ADR-0120 D1-A, "구조적 필연"). The Rust
# notifier can sign dispatches and the iOS NSE can render them, but with no way
# to *deploy* the middle hop, neither end could reach a device. The only
# containerized invocation that existed before this file copied the source into a
# `swift:6.2` container and ran `swift run` (infra/e2e/metrics.overlay.yml) —
# a verifier trick, not a deployment.
#
# ## Build context is the repo root, not `relay/PushRelay/`
#
# The package depends on `../../services/MomoMetrics` by path, so the context has
# to contain both trees. Same choice, for the same reason, as
# `server-rust/Dockerfile` and `infra/prod/docker/momo.Dockerfile`.
#
# ## No credential is baked in, here or anywhere
#
# The `.p8`, the key ID, the team ID and the server registry all arrive at run
# time from the environment and a read-only mount. This image is publishable;
# what makes a running container Dawn's is the key an operator mounts into it.
# See docs/cicd/12-push-relay-deploy-runbook.md.

ARG SWIFT_IMAGE=swift:6.2-noble
ARG RUNTIME_IMAGE=ubuntu:24.04

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
FROM ${SWIFT_IMAGE} AS build
WORKDIR /src

# Tests are copied even though they are not built: SwiftPM validates that every
# declared target has a source directory, so a package whose `Tests/` is absent
# fails to *configure*, let alone build (infra/prod/docker/swift-service.Dockerfile
# copies them for the same reason).
COPY relay/PushRelay/Package.swift relay/PushRelay/Package.swift
COPY relay/PushRelay/Sources relay/PushRelay/Sources
COPY relay/PushRelay/Tests relay/PushRelay/Tests
COPY services/MomoMetrics services/MomoMetrics

# `--static-swift-stdlib` is what lets the runtime stage be a plain ubuntu:24.04
# instead of the ~1.5GB Swift toolchain image; it is the same flag every other
# Swift product in this repo ships with.
RUN swift build --package-path relay/PushRelay -c release \
      --product PushRelay --static-swift-stdlib \
    && install -Dm755 \
      "$(swift build --package-path relay/PushRelay -c release --show-bin-path)/PushRelay" \
      /out/PushRelay

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE}
LABEL org.opencontainers.image.title="momo-push-relay" \
      org.opencontainers.image.description="momo PushRelay — Dawn-operated APNs boundary (ADR-0120)" \
      org.opencontainers.image.licenses="Apache-2.0"

# Measured runtime dependency set, mirroring the one the repo's other Swift
# services already run on (infra/prod/docker/swift-service.Dockerfile:34-42):
#   * ca-certificates — load bearing HERE in a way it is nowhere else in momo.
#     This is the only momo process that opens a TLS connection to a third party
#     (api.push.apple.com). Without the trust store every dispatch fails at the
#     handshake, and it fails as a *transport* error, i.e. a retry loop.
#   * libcurl4 / libxml2 / libz3-4 — swift-corelibs-foundation link dependencies;
#     the static stdlib covers the Swift runtime, not Foundation's C libraries.
#   * curl — the compose healthcheck binary (same convention as the api service).
#   * tzdata — Date/JWT `iat` handling.
# BoringSSL is vendored into swift-nio-ssl, so no libssl package is required.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      libcurl4 \
      libxml2 \
      libz3-4 \
      tzdata; \
    rm -rf /var/lib/apt/lists/*; \
    useradd --system --create-home --uid 10001 momo; \
    mkdir -p /usr/share/licenses/momo-push-relay

COPY --from=build /out/PushRelay /usr/local/bin/PushRelay
COPY LICENSE NOTICE /usr/share/licenses/momo-push-relay/

# Build-time assertion of the fail-closed contract. An image that boots without
# configuration would be a relay that accepts nothing while looking alive; this
# makes that a build failure rather than a production discovery. It needs no
# network and no credential — the refusal happens before any socket is opened.
RUN set -eux; \
    test -s /usr/share/licenses/momo-push-relay/LICENSE; \
    test -s /usr/share/licenses/momo-push-relay/NOTICE; \
    if PushRelay >/tmp/boot-check.log 2>&1; then \
      echo "PushRelay started with no configuration — fail-closed contract broken" >&2; \
      cat /tmp/boot-check.log >&2; \
      exit 1; \
    fi; \
    grep -q 'refused to start' /tmp/boot-check.log; \
    grep -q 'MOMO_RELAY_SERVERS' /tmp/boot-check.log; \
    rm -f /tmp/boot-check.log

# Unprivileged. The mounted `.p8` must be readable by uid 10001 — if it is not,
# the relay refuses to boot and says so by name (RelayConfig.unreadableAPNSKey)
# rather than starting and failing at the first push.
USER momo
WORKDIR /home/momo

# Documentation only (compose publishes nothing): 28195 is the relay's default
# listen port, 9093 its metrics port. Neither is ever exposed publicly without a
# TLS reverse proxy in front — see docs/PUSH_RELAY_RUNBOOK.md.
EXPOSE 28195 9093

ENTRYPOINT ["/usr/local/bin/PushRelay"]
