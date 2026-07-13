# syntax=docker/dockerfile:1
#
# Source-checkout-free migration image for internal smoke and pinned host deploys.

FROM postgres:18
WORKDIR /workspace

COPY scripts/migrate.sh scripts/migrate.sh
COPY server/Migrations server/Migrations
COPY infra/e2e/bootstrap_roles.sql infra/e2e/bootstrap_roles.sql
COPY infra/prod/docker/internal-smoke-migrate.sh /usr/local/bin/internal-smoke-migrate
RUN chmod +x /usr/local/bin/internal-smoke-migrate

ENTRYPOINT ["internal-smoke-migrate"]
