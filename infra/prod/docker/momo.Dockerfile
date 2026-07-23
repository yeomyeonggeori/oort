# syntax=docker/dockerfile:1
#
# One immutable momo application image, six runtime commands:
# api, relay, worker, migrate, linkshort, web-assets.

ARG SWIFT_IMAGE=swift:6.2-noble
ARG NODE_IMAGE=node:22-alpine
ARG RUNTIME_IMAGE=ubuntu:24.04

FROM ${SWIFT_IMAGE} AS swift-build
WORKDIR /src

# Copy the four Swift package roots and their repo-local dependencies. Every
# imported module is declared directly by its Package.swift; Linux builds must
# not depend on implicit transitive imports.
COPY server /src/server
COPY relay/OutboxRelay /src/relay/OutboxRelay
COPY workers/AgentWorker /src/workers/AgentWorker
COPY services/LinkShort /src/services/LinkShort
COPY services/OutboundHTTPPolicy /src/services/OutboundHTTPPolicy
COPY services/MomoMetrics /src/services/MomoMetrics

RUN --mount=type=cache,target=/root/.cache/org.swift.swiftpm \
    --mount=type=cache,target=/src/server/.build \
    swift build --package-path server -c release --product MomoServer --static-swift-stdlib \
    && install -Dm755 "$(swift build --package-path server -c release --show-bin-path)/MomoServer" /artifacts/MomoServer
RUN --mount=type=cache,target=/root/.cache/org.swift.swiftpm \
    --mount=type=cache,target=/src/relay/OutboxRelay/.build \
    swift build --package-path relay/OutboxRelay -c release --product OutboxRelay --static-swift-stdlib \
    && install -Dm755 "$(swift build --package-path relay/OutboxRelay -c release --show-bin-path)/OutboxRelay" /artifacts/OutboxRelay
RUN --mount=type=cache,target=/root/.cache/org.swift.swiftpm \
    --mount=type=cache,target=/src/workers/AgentWorker/.build \
    swift build --package-path workers/AgentWorker -c release --product AgentWorker --static-swift-stdlib \
    && install -Dm755 "$(swift build --package-path workers/AgentWorker -c release --show-bin-path)/AgentWorker" /artifacts/AgentWorker
RUN --mount=type=cache,target=/root/.cache/org.swift.swiftpm \
    --mount=type=cache,target=/src/services/LinkShort/.build \
    swift build --package-path services/LinkShort -c release --product LinkShort --static-swift-stdlib \
    && install -Dm755 "$(swift build --package-path services/LinkShort -c release --show-bin-path)/LinkShort" /artifacts/LinkShort

FROM ${NODE_IMAGE} AS web-build
WORKDIR /src/clients/web
COPY clients/web/package.json clients/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY clients/web/ ./
RUN npm run build

FROM ${RUNTIME_IMAGE}
ARG TARGETARCH
LABEL org.opencontainers.image.title="momo" \
      org.opencontainers.image.description="momo multi-command self-host runtime" \
      org.opencontainers.image.licenses="Apache-2.0"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      libcurl4 \
      libxml2 \
      libz3-4 \
      postgresql-client \
      tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /opt/momo-web /srv/momo-web /usr/share/licenses/momo

COPY --from=swift-build /artifacts/ /usr/local/bin/
COPY --from=web-build /src/clients/web/dist/ /opt/momo-web/

# Source-checkout-free migration and day-2 operator payload.
WORKDIR /workspace
COPY scripts/migrate.sh scripts/migrate.sh
COPY scripts/check_migration_numbers.sh scripts/check_migration_numbers.sh
COPY server/Migrations server/Migrations
COPY infra/e2e/bootstrap_roles.sql infra/e2e/bootstrap_roles.sql
COPY infra/prod/bootstrap_runtime_roles.sql infra/prod/bootstrap_runtime_roles.sql
COPY infra/prod/set_initial_owner.sql infra/prod/set_initial_owner.sql
COPY infra/prod/member_list.sql infra/prod/member_list.sql
COPY infra/prod/create_invite.sql infra/prod/create_invite.sql
COPY infra/prod/create_workspace.sql infra/prod/create_workspace.sql
COPY infra/prod/docker/internal-smoke-migrate.sh /usr/local/bin/internal-smoke-migrate
COPY infra/prod/docker/momo-entrypoint.sh /usr/local/bin/momo-entrypoint
COPY LICENSE NOTICE /usr/share/licenses/momo/

RUN chmod +x \
      /usr/local/bin/internal-smoke-migrate \
      /usr/local/bin/momo-entrypoint \
      /workspace/scripts/migrate.sh \
      /workspace/scripts/check_migration_numbers.sh \
    && test -s /usr/share/licenses/momo/LICENSE \
    && test -s /usr/share/licenses/momo/NOTICE \
    && test -s /opt/momo-web/index.html

ENTRYPOINT ["momo-entrypoint"]
CMD ["migrate"]
