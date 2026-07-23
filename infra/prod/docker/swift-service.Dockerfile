# syntax=docker/dockerfile:1
#
# Internal smoke helper for building local, image-based service substitutes.
# Production compose still consumes images only; this Dockerfile is invoked by
# scripts/verify_internal_host_runtime.sh to produce deterministic local tags.

ARG SWIFT_IMAGE=swift:6.2-noble
ARG RUNTIME_IMAGE=ubuntu:24.04

FROM ${SWIFT_IMAGE} AS build
ARG PACKAGE_PATH
ARG PRODUCT
WORKDIR /src

COPY ${PACKAGE_PATH}/Package.swift ${PACKAGE_PATH}/Package.swift
COPY ${PACKAGE_PATH}/Sources ${PACKAGE_PATH}/Sources
COPY ${PACKAGE_PATH}/Tests ${PACKAGE_PATH}/Tests
# Server and OutboxRelay share the MOMO-536-derived SSRF policy. Copying this
# dependency for every product keeps the generic Dockerfile branch-free; SwiftPM
# only resolves it for packages that declare the local dependency.
COPY services/OutboundHTTPPolicy /src/services/OutboundHTTPPolicy
COPY services/MomoMetrics /src/services/MomoMetrics

WORKDIR /src/${PACKAGE_PATH}
RUN swift build -c release --product "${PRODUCT}" --static-swift-stdlib
RUN mkdir -p /artifact \
  && cp "$(swift build -c release --show-bin-path)/${PRODUCT}" "/artifact/${PRODUCT}"

FROM ${RUNTIME_IMAGE}
ARG PRODUCT
ENV MOMO_PRODUCT=${PRODUCT}
# curl(바이너리)은 compose healthcheck(`curl -fsS http://127.0.0.1:8080/health`)용
# (MOMO-316). libcurl4는 Swift 런타임 링크 의존성으로 별개다.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libcurl4 \
    libxml2 \
    libz3-4 \
    tzdata \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /artifact/${PRODUCT} /usr/local/bin/${PRODUCT}
ENTRYPOINT ["/bin/sh", "-lc", "exec /usr/local/bin/${MOMO_PRODUCT}"]
