# syntax=docker/dockerfile:1
#
# One immutable momo **Rust** application image, three runtime commands:
# api (momo-server), relay (momo-relay), migrate (momo-migrate).
# ADR-0145 B안 / batch B1.7 — the deploy path for the Rust stack.
#
#   docker build -f server-rust/Dockerfile -t momo-rust:dev .
#
# The build context is the **repo root**, not `server-rust/`: the image must be
# source-checkout-free at run time (prod contract), and the migration set plus
# the two role SQL files it applies live outside `server-rust/`
# (`server/Migrations`, `infra/e2e`, `infra/prod`). Those files are copied in,
# never modified.
#
# Not in this image (deliberate, B1.7 scope): worker / NotifierWorker / T3 /
# workd / LinkShort / the web SPA. `infra/prod/docker/momo.Dockerfile` remains
# the Swift image and is untouched.

ARG RUST_IMAGE=rust:1-slim-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim

# ---------------------------------------------------------------------------
# build — one workspace build for all three binaries
# ---------------------------------------------------------------------------
FROM ${RUST_IMAGE} AS build
WORKDIR /src/server-rust
ENV CARGO_TERM_COLOR=never \
    CARGO_INCREMENTAL=0

# Dependency layer: manifests + lockfile only, with stub sources, so the ~200
# third-party crates recompile only when Cargo.toml/Cargo.lock changes and not
# on every source edit. The stubs are deleted immediately afterwards — the real
# sources land in the next COPY and only the workspace crates rebuild.
COPY server-rust/Cargo.toml server-rust/Cargo.lock ./
COPY server-rust/crates/momo-agent/Cargo.toml crates/momo-agent/
COPY server-rust/crates/momo-auth/Cargo.toml crates/momo-auth/
COPY server-rust/crates/momo-db/Cargo.toml crates/momo-db/
COPY server-rust/crates/momo-messaging/Cargo.toml crates/momo-messaging/
COPY server-rust/crates/momo-outbox/Cargo.toml crates/momo-outbox/
COPY server-rust/crates/momo-provider/Cargo.toml crates/momo-provider/
COPY server-rust/crates/momo-settings/Cargo.toml crates/momo-settings/
COPY server-rust/crates/momo-t3/Cargo.toml crates/momo-t3/
COPY server-rust/crates/momo-wire/Cargo.toml crates/momo-wire/
COPY server-rust/bins/momo-migrate/Cargo.toml bins/momo-migrate/
COPY server-rust/bins/momo-notifier/Cargo.toml bins/momo-notifier/
COPY server-rust/bins/momo-relay/Cargo.toml bins/momo-relay/
COPY server-rust/bins/momo-server/Cargo.toml bins/momo-server/
RUN set -eux; \
    for manifest in crates/*/Cargo.toml bins/*/Cargo.toml; do \
      dir=$(dirname "$manifest"); \
      mkdir -p "$dir/src"; \
      : > "$dir/src/lib.rs"; \
      printf 'fn main() {}\n' > "$dir/src/main.rs"; \
    done; \
    cargo build --release --locked \
      --bin momo-server --bin momo-relay --bin momo-migrate; \
    find crates bins -name '*.rs' -delete

# Real sources. `--locked` keeps the dependency graph byte-identical to the
# committed Cargo.lock: a build can never silently resolve a different version.
COPY server-rust/crates crates
COPY server-rust/bins bins
RUN set -eux; \
    # cargo rebuild detection is mtime-based and COPY'd files can carry stale
    # timestamps, so the stub-compiled (empty) workspace rlibs would be reused
    # verbatim — momo-migrate then fails with E0432 on `momo_db::migrate`
    # (B1.7 docker-gate 실측). Touch every real source so the workspace crates
    # always rebuild; the ~200 third-party deps stay cached.
    find crates bins -name '*.rs' -exec touch {} +; \
    cargo build --release --locked \
      --bin momo-server --bin momo-relay --bin momo-migrate; \
    install -Dm755 target/release/momo-server /out/momo-server; \
    install -Dm755 target/release/momo-relay /out/momo-relay; \
    install -Dm755 target/release/momo-migrate /out/momo-migrate

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE}
LABEL org.opencontainers.image.title="momo-rust" \
      org.opencontainers.image.description="momo Rust runtime — api | relay | migrate" \
      org.opencontainers.image.licenses="Apache-2.0"

# postgresql-client is NOT optional: the migration runner shells out to psql
# because migrations 002/006/012 use psql *client* meta-commands (`\if`,
# `\getenv`) that the wire protocol cannot execute (B0 lesson, momo-db::migrate).
# curl exists so the api service has a container-local healthcheck.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      postgresql-client \
      tzdata; \
    rm -rf /var/lib/apt/lists/*; \
    useradd --system --create-home --uid 10001 momo; \
    mkdir -p /opt/momo/sql /usr/share/licenses/momo-rust

COPY --from=build /out/ /usr/local/bin/

# Source-checkout-free migration payload. The SQL is copied verbatim; the image
# owns no migration of its own and edits none of these files.
COPY server/Migrations /opt/momo/migrations
COPY infra/e2e/bootstrap_roles.sql /opt/momo/sql/bootstrap_roles.sql
COPY infra/prod/bootstrap_runtime_roles.sql /opt/momo/sql/bootstrap_runtime_roles.sql
COPY infra/prod/set_initial_owner.sql /opt/momo/sql/set_initial_owner.sql
COPY LICENSE NOTICE /usr/share/licenses/momo-rust/
COPY server-rust/docker-entrypoint.sh /usr/local/bin/momo-rust-entrypoint

RUN set -eux; \
    chmod +x /usr/local/bin/momo-rust-entrypoint; \
    test -s /opt/momo/migrations/001_init.sql; \
    test -s /opt/momo/sql/bootstrap_roles.sql; \
    test -s /opt/momo/sql/bootstrap_runtime_roles.sql; \
    test -s /opt/momo/sql/set_initial_owner.sql; \
    test -s /usr/share/licenses/momo-rust/LICENSE; \
    test -s /usr/share/licenses/momo-rust/NOTICE; \
    momo-migrate --help >/dev/null

# The runner resolves every path from the environment (its compiled-in defaults
# are repo-relative and would not exist here). Nothing secret is baked in.
ENV MOMO_MIGRATIONS_DIR=/opt/momo/migrations \
    MOMO_BOOTSTRAP_ROLES_SQL=/opt/momo/sql/bootstrap_roles.sql \
    MOMO_RUNTIME_ROLES_SQL=/opt/momo/sql/bootstrap_runtime_roles.sql \
    MOMO_SET_OWNER_SQL=/opt/momo/sql/set_initial_owner.sql

USER momo
WORKDIR /opt/momo

# Same contract as the Swift image: the role is the first argument
# (`command: ["api"]`), so compose files are interchangeable between them.
ENTRYPOINT ["momo-rust-entrypoint"]
CMD ["migrate"]
