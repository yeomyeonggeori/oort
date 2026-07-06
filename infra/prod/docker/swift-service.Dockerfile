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
WORKDIR /src/${PACKAGE_PATH}

# MOMO-317: 의존성 레이어 분리 — 매니페스트(Package.swift[+Package.resolved])만
# 먼저 복사해 `swift package resolve`를 자체 레이어로 고정한다. Sources/Tests만
# 바뀌면 이 COPY+resolve 레이어는 캐시 히트라 매번 재resolve하지 않는다.
# (Package.resolved는 리포에 커밋되지 않을 수 있어 glob `Package.*`로 optional 복사.)
COPY ${PACKAGE_PATH}/Package.* ./
# MOMO-317: BuildKit 빌드 캐시 mount — SwiftPM 산출물(.build)을 빌드 간 재사용.
# sharing=locked: 같은 패키지를 동시에 빌드하면 직렬화해 .build 오염을 막는다.
RUN --mount=type=cache,target=/src/${PACKAGE_PATH}/.build,sharing=locked \
  swift package resolve

COPY ${PACKAGE_PATH}/Sources ./Sources
COPY ${PACKAGE_PATH}/Tests ./Tests

# MOMO-317: build + 산출물 추출을 한 RUN에서 수행한다. .build가 cache mount이므로
# 빌드 바이너리는 mount 안에 생기고 이미지 레이어엔 남지 않는다 → 같은 RUN 안에서
# --show-bin-path 결과를 /artifact(일반 레이어 경로)로 cp해야 다음 스테이지가 본다.
RUN --mount=type=cache,target=/src/${PACKAGE_PATH}/.build,sharing=locked \
  swift build -c release --product "${PRODUCT}" --static-swift-stdlib \
  && mkdir -p /artifact \
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
