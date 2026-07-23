# syntax=docker/dockerfile:1
#
# WH-1 (MOMO-579 / ADR-0114 증보1 C) — opt-in work host sidecar image.
#
# Bundles two permissively-licensed code-execution engines as SEPARATE image
# layers so each is auditable and independently cacheable:
#   * opencode (MIT, single binary)      — default engine, HTTP+SSE
#   * goose    (Apache-2.0, single binary) — ACP engine
# plus momo-workd (the Swift WorkEngineAdapter host). Codex is NOT bundled — the
# `codex-local` engine connects to the user host's own `codex` install, keeping
# the ChatGPT/OAuth credential boundary outside momo (ADR-0004).
#
# The engine versions/asset URLs below are orchestrator-confirmed at build time
# (this worker cannot run docker). Pin OPENCODE_VERSION / GOOSE_VERSION and, for
# supply-chain hardening, add per-arch checksums before production publish.

ARG SWIFT_IMAGE=swift:6.2-noble
ARG RUNTIME_IMAGE=ubuntu:24.04
# opencode 1.18.4 is the version exercised in the WH-0 spike.
ARG OPENCODE_VERSION=1.18.4
# goose ships a maintained `stable` release channel; override to pin a number.
ARG GOOSE_VERSION=stable

# -----------------------------------------------------------------------------
# Stage: build momo-workd (mirrors swift-service.Dockerfile static-stdlib build).
# -----------------------------------------------------------------------------
FROM ${SWIFT_IMAGE} AS swift-build
WORKDIR /src
COPY workers/WorkHostDaemon/Package.swift workers/WorkHostDaemon/Package.swift
COPY workers/WorkHostDaemon/Sources workers/WorkHostDaemon/Sources
COPY workers/WorkHostDaemon/Tests workers/WorkHostDaemon/Tests
WORKDIR /src/workers/WorkHostDaemon
RUN swift build -c release --product momo-workd --static-swift-stdlib \
  && install -Dm755 "$(swift build -c release --show-bin-path)/momo-workd" /artifact/momo-workd

# -----------------------------------------------------------------------------
# Stage: fetch opencode (MIT) — isolated so it forms its own final-image layer.
# -----------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS opencode-fetch
ARG OPENCODE_VERSION
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "${TARGETARCH:-amd64}" in \
    amd64) OC_ARCH=x64 ;; \
    arm64) OC_ARCH=arm64 ;; \
    *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  mkdir -p /opt/opencode /usr/share/licenses/opencode; \
  curl -fsSL -o /tmp/opencode.zip \
    "https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${OC_ARCH}.zip"; \
  unzip -o /tmp/opencode.zip -d /opt/opencode; \
  # The archive contains the single `opencode` binary; normalize its location.
  find /opt/opencode -type f -name opencode -exec install -Dm755 {} /opt/opencode/opencode \; ; \
  test -x /opt/opencode/opencode; \
  rm -f /tmp/opencode.zip; \
  curl -fsSL -o /usr/share/licenses/opencode/LICENSE \
    "https://raw.githubusercontent.com/sst/opencode/v${OPENCODE_VERSION}/LICENSE" \
  || curl -fsSL -o /usr/share/licenses/opencode/LICENSE \
    "https://raw.githubusercontent.com/sst/opencode/main/LICENSE"; \
  test -s /usr/share/licenses/opencode/LICENSE

# -----------------------------------------------------------------------------
# Stage: fetch goose (Apache-2.0) — isolated so it forms its own final layer.
# -----------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS goose-fetch
ARG GOOSE_VERSION
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl bzip2 \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "${TARGETARCH:-amd64}" in \
    amd64) GOOSE_TRIPLE=x86_64-unknown-linux-gnu ;; \
    arm64) GOOSE_TRIPLE=aarch64-unknown-linux-gnu ;; \
    *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  mkdir -p /opt/goose /usr/share/licenses/goose; \
  curl -fsSL -o /tmp/goose.tar.bz2 \
    "https://github.com/block/goose/releases/download/${GOOSE_VERSION}/goose-${GOOSE_TRIPLE}.tar.bz2"; \
  tar -xjf /tmp/goose.tar.bz2 -C /opt/goose; \
  find /opt/goose -type f -name goose -exec install -Dm755 {} /opt/goose/goose \; ; \
  test -x /opt/goose/goose; \
  rm -f /tmp/goose.tar.bz2; \
  curl -fsSL -o /usr/share/licenses/goose/LICENSE \
    "https://raw.githubusercontent.com/block/goose/main/LICENSE"; \
  test -s /usr/share/licenses/goose/LICENSE

# -----------------------------------------------------------------------------
# Final runtime: momo-workd + opencode(layer) + goose(layer). Codex absent.
# -----------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE}
LABEL org.opencontainers.image.title="momo-workhost" \
      org.opencontainers.image.description="momo work host sidecar (opencode MIT + goose Apache-2.0 + momo-workd)" \
      org.opencontainers.image.licenses="Apache-2.0"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libcurl4 \
    libxml2 \
    libz3-4 \
    python3 \
    tzdata \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /workspace /usr/share/licenses/momo-workhost

# momo-workd (Swift host).
COPY --from=swift-build /artifact/momo-workd /usr/local/bin/momo-workd

# opencode (MIT) — its own layer + license.
COPY --from=opencode-fetch /opt/opencode/opencode /usr/local/bin/opencode
COPY --from=opencode-fetch /usr/share/licenses/opencode/ /usr/share/licenses/opencode/

# goose (Apache-2.0) — its own layer + license.
COPY --from=goose-fetch /opt/goose/goose /usr/local/bin/goose
COPY --from=goose-fetch /usr/share/licenses/goose/ /usr/share/licenses/goose/

COPY infra/prod/docker/workhost-entrypoint.sh /usr/local/bin/workhost-entrypoint
COPY LICENSE NOTICE /usr/share/licenses/momo-workhost/

RUN chmod +x /usr/local/bin/workhost-entrypoint \
  && test -x /usr/local/bin/momo-workd \
  && test -x /usr/local/bin/opencode \
  && test -x /usr/local/bin/goose \
  && test -s /usr/share/licenses/opencode/LICENSE \
  && test -s /usr/share/licenses/goose/LICENSE \
  && test -s /usr/share/licenses/momo-workhost/LICENSE

WORKDIR /workspace
ENTRYPOINT ["workhost-entrypoint"]
