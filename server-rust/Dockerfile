# syntax=docker/dockerfile:1
#
# One immutable momo **Rust** application image, seven runtime commands:
# api (momo-server), relay (momo-relay), agent-worker (momo-agent-worker),
# webhook-sender (momo-webhook-sender), notifier (momo-notifier),
# migrate (momo-migrate), web-assets (SPA staging).
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
# B5.1 adds `agent-worker`: the agent turn loop is what makes a mention produce
# an answer, so an image that cannot run it cannot dogfood the product. It ships
# beside api/relay rather than in an image of its own because all four are one
# `cargo build` of one workspace.
#
# #1222 adds `webhook-sender`: the outbound event-subscription drain. It is a
# separate command rather than a branch inside `relay` because the relay's single
# HTTP destination (Centrifugo) is what makes invariant #2 checkable from its
# dependency graph — a relay able to POST an operator-supplied URL would make the
# invariant unprovable even while it stayed true. Shipping the binary changes no
# running deployment; it only makes the drain reachable once compose names it.
#
# P2 adds `notifier`. It was previously excluded because "its compose wiring is
# still open" — but it now carries the ADR-0120 push-candidate drain, and an
# image that cannot run it is an image where a message can never wake a device.
# Both of its opt-in loops (T3 reconciler, push drain) are default-off, so
# shipping the binary changes no running deployment; it only makes the drain
# reachable once compose points at it.
#
# #1228 adds the **web SPA**. It was the last thing a deploy had to carry by
# hand: `npm run build` on a laptop, `tar | ssh`, bind-mount into Caddy. That
# made web and API two independently versioned deployments of one product, and
# it left no way to ask which commit the live bundle came from (audit B §4-1,
# B-6/B-10). It also was not new ground — the Swift image already bundled its
# dist and staged it with a `web-assets` command, and the Rust path had simply
# lost that. So: one image, and pinning it pins the browser too.
#
# Not in this image (deliberate): the Swift workers / T3 / workd / LinkShort.
# `infra/prod/docker/momo.Dockerfile` remains the Swift image and is untouched.
#
# No APNs credential is baked in, here or anywhere: this image cannot talk to
# Apple. The notifier posts id-only dispatches to the push relay, which is the
# only component that holds a `.p8` (ADR-0120 D1-A).

ARG RUST_IMAGE=rust:1-slim-bookworm
ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUNTIME_IMAGE=debian:bookworm-slim

# The commit this image was built from. Stamped into the OCI labels AND into
# the SPA's `<meta name="momo-build">`, because a deployed artifact that cannot
# name its own source is a deployment you can only audit by guessing (B-10).
# `unknown` is honest: an unstamped build says so instead of claiming a commit.
ARG MOMO_BUILD_SHA=unknown

# ---------------------------------------------------------------------------
# build — one workspace build for every binary
# ---------------------------------------------------------------------------
FROM ${RUST_IMAGE} AS build
WORKDIR /src/server-rust
ENV CARGO_TERM_COLOR=never \
    CARGO_INCREMENTAL=0

# Dependency layer: manifests + lockfile only, with stub sources, so the ~200
# third-party crates recompile only when Cargo.toml/Cargo.lock changes and not
# on every source edit. The stubs are deleted immediately afterwards — the real
# sources land in the next COPY and only the workspace crates rebuild.
#
# **This list must mirror `crates/*` and `bins/*` exactly.** The workspace at
# Cargo.toml:6 is `members = ["crates/*", "bins/*"]`, so a new crate that is not
# added here does not produce a cache miss — it produces a hard build failure
# (`failed to load manifest for dependency <crate>`) in the RUN below, and only
# for whoever builds the IMAGE. Measured: commit 9b437626 (PR #1119, goal #1111)
# added `crates/momo-drive` and left this list alone, which broke
# `server-rust/Dockerfile` on track/engine for every deploy path while
# `cargo build` on the host stayed green. The lane
# (`clients/mobile/scripts/lane-phone.sh`) now builds this image on every run,
# so the next omission surfaces in a gate instead of at deploy time.
COPY server-rust/Cargo.toml server-rust/Cargo.lock ./
COPY server-rust/crates/momo-agent/Cargo.toml crates/momo-agent/
COPY server-rust/crates/momo-auth/Cargo.toml crates/momo-auth/
COPY server-rust/crates/momo-db/Cargo.toml crates/momo-db/
COPY server-rust/crates/momo-drive/Cargo.toml crates/momo-drive/
COPY server-rust/crates/momo-ephemeral/Cargo.toml crates/momo-ephemeral/
COPY server-rust/crates/momo-messaging/Cargo.toml crates/momo-messaging/
COPY server-rust/crates/momo-outbox/Cargo.toml crates/momo-outbox/
COPY server-rust/crates/momo-provider/Cargo.toml crates/momo-provider/
COPY server-rust/crates/momo-push/Cargo.toml crates/momo-push/
COPY server-rust/crates/momo-settings/Cargo.toml crates/momo-settings/
COPY server-rust/crates/momo-t3/Cargo.toml crates/momo-t3/
COPY server-rust/crates/momo-webhook/Cargo.toml crates/momo-webhook/
COPY server-rust/crates/momo-wire/Cargo.toml crates/momo-wire/
COPY server-rust/bins/momo-agent-worker/Cargo.toml bins/momo-agent-worker/
COPY server-rust/bins/momo-migrate/Cargo.toml bins/momo-migrate/
COPY server-rust/bins/momo-notifier/Cargo.toml bins/momo-notifier/
COPY server-rust/bins/momo-relay/Cargo.toml bins/momo-relay/
COPY server-rust/bins/momo-server/Cargo.toml bins/momo-server/
COPY server-rust/bins/momo-webhook-sender/Cargo.toml bins/momo-webhook-sender/
RUN set -eux; \
    for manifest in crates/*/Cargo.toml bins/*/Cargo.toml; do \
      dir=$(dirname "$manifest"); \
      mkdir -p "$dir/src"; \
      : > "$dir/src/lib.rs"; \
      printf 'fn main() {}\n' > "$dir/src/main.rs"; \
    done; \
    cargo build --release --locked \
      --bin momo-server --bin momo-relay --bin momo-agent-worker \
      --bin momo-webhook-sender --bin momo-migrate --bin momo-notifier; \
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
      --bin momo-server --bin momo-relay --bin momo-agent-worker \
      --bin momo-webhook-sender --bin momo-migrate --bin momo-notifier; \
    install -Dm755 target/release/momo-server /out/momo-server; \
    install -Dm755 target/release/momo-relay /out/momo-relay; \
    install -Dm755 target/release/momo-agent-worker /out/momo-agent-worker; \
    install -Dm755 target/release/momo-webhook-sender /out/momo-webhook-sender; \
    install -Dm755 target/release/momo-migrate /out/momo-migrate; \
    install -Dm755 target/release/momo-notifier /out/momo-notifier

# ---------------------------------------------------------------------------
# web — the SPA Caddy serves (#1228)
# ---------------------------------------------------------------------------
# A stage of its own, sharing nothing with `build`: node and cargo never
# invalidate each other's layers, so touching a React component does not
# recompile ~200 crates and touching a crate does not reinstall npm. That
# independence is a requirement of this ticket, not a nicety — the deploy host
# builds this image and a cache miss there is measured in tens of minutes.
FROM ${NODE_IMAGE} AS web-build
WORKDIR /src/clients/web

# `clients/web` is NOT a member of the root npm workspace (root package.json:
# `"workspaces": ["packages/*"]`), so it installs from its own lockfile with no
# root install first. PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is not an optimisation:
# the `playwright` devDependency (the e2e gates') downloads three browser
# bundles in postinstall, none of which a production build can use.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_audit=false \
    npm_config_fund=false
COPY clients/web/package.json clients/web/package-lock.json ./
RUN npm ci

# `@momo/core` is resolved BY PATH, not through node_modules — vite.config.ts
# aliases it to `../../packages/momo-core/src` and tsconfig.app.json maps the
# same paths (ADR-0137 D3, deliberately so an alias cannot drift with a
# lockfile). The consequence for the image is that the shared package must be
# in the build context; `npm ci` alone does not bring it.
COPY packages/momo-core /src/packages/momo-core
# 16KB of plugin manifests that `src/**/*.test.ts` imports by repo-relative path
# (`../../../../../server/Fixtures/...`). `npm run build` runs `tsc -b` first
# and tsconfig.app.json includes all of `src`, so without these four JSON files
# the image's build and the developer's build are not the same command. Keeping
# them identical is the whole point of this ticket — an image that builds by a
# different recipe than the repo is how the two drift apart again.
COPY server/Fixtures /src/server/Fixtures
COPY clients/web/ ./

ARG MOMO_BUILD_SHA
ENV MOMO_BUILD_SHA=${MOMO_BUILD_SHA}
RUN set -eux; \
    npm run build; \
    test -s dist/index.html; \
    # The stamp is the point of the ARG — if the vite plugin ever stops
    # injecting it, this build fails here rather than shipping a bundle that
    # cannot be traced back to a commit.
    grep -q "content=\"${MOMO_BUILD_SHA}\"" dist/index.html

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE}
ARG MOMO_BUILD_SHA
LABEL org.opencontainers.image.title="momo-rust" \
      org.opencontainers.image.description="momo Rust runtime — api | relay | agent-worker | webhook-sender | notifier | migrate | web-assets" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${MOMO_BUILD_SHA}"

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
    mkdir -p /opt/momo/sql /opt/momo/web /srv/web /usr/share/licenses/momo-rust; \
    # /srv/web is the mount point for the serving volume. Its ownership here is
    # what Docker copies onto a fresh named volume, and `web-assets` runs as
    # uid 10001 — a root-owned mount point is a one-shot that cannot write.
    chown momo:momo /srv/web

COPY --from=build /out/ /usr/local/bin/

# Source-checkout-free migration payload. The SQL is copied verbatim; the image
# owns no migration of its own and edits none of these files.
COPY server/Migrations /opt/momo/migrations
COPY infra/e2e/bootstrap_roles.sql /opt/momo/sql/bootstrap_roles.sql
COPY infra/prod/bootstrap_runtime_roles.sql /opt/momo/sql/bootstrap_runtime_roles.sql
COPY infra/prod/set_initial_owner.sql /opt/momo/sql/set_initial_owner.sql
# #1227: the only-if-absent twin the `migrate` command applies at first boot.
COPY infra/prod/bootstrap_owner_if_absent.sql /opt/momo/sql/bootstrap_owner_if_absent.sql
COPY LICENSE NOTICE /usr/share/licenses/momo-rust/
COPY server-rust/docker-entrypoint.sh /usr/local/bin/momo-rust-entrypoint

# The SPA payload, LAST of the COPYs on purpose: a web-only change then
# invalidates one thin layer at the end instead of every layer after it.
# Owned by `momo` so `web-assets` can `cp -a` (ownership preservation by a
# non-root process only succeeds when the source is already its own).
COPY --from=web-build --chown=momo:momo /src/clients/web/dist/ /opt/momo/web/

RUN set -eux; \
    chmod +x /usr/local/bin/momo-rust-entrypoint; \
    test -s /opt/momo/migrations/001_init.sql; \
    test -s /opt/momo/sql/bootstrap_roles.sql; \
    test -s /opt/momo/sql/bootstrap_runtime_roles.sql; \
    test -s /opt/momo/sql/set_initial_owner.sql; \
    test -s /opt/momo/sql/bootstrap_owner_if_absent.sql; \
    test -s /usr/share/licenses/momo-rust/LICENSE; \
    test -s /usr/share/licenses/momo-rust/NOTICE; \
    test -s /opt/momo/web/index.html; \
    momo-migrate --help >/dev/null

# The runner resolves every path from the environment (its compiled-in defaults
# are repo-relative and would not exist here). Nothing secret is baked in.
ENV MOMO_MIGRATIONS_DIR=/opt/momo/migrations \
    MOMO_BOOTSTRAP_ROLES_SQL=/opt/momo/sql/bootstrap_roles.sql \
    MOMO_RUNTIME_ROLES_SQL=/opt/momo/sql/bootstrap_runtime_roles.sql \
    MOMO_SET_OWNER_SQL=/opt/momo/sql/set_initial_owner.sql \
    MOMO_BOOTSTRAP_OWNER_SQL=/opt/momo/sql/bootstrap_owner_if_absent.sql

USER momo
WORKDIR /opt/momo

# Same contract as the Swift image: the role is the first argument
# (`command: ["api"]`), so compose files are interchangeable between them.
ENTRYPOINT ["momo-rust-entrypoint"]
CMD ["migrate"]
