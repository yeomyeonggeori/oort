# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# PostgreSQL 18.4 + pgvector 0.8.5 is the production database base. Keep the
# multi-platform manifest digest immutable; tags are only human-readable hints.
FROM pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e AS packages-amd64

# apt.postgresql.org package bytes are pinned independently of repository
# metadata so a republish or moving package index fails at the Docker layer.
ADD --checksum=sha256:2ff822645a132ce71f215ae4355d050c6c542143ea6a267cb433acf6413b1a3e \
    https://apt.postgresql.org/pub/repos/apt/pool/main/p/pgbackrest/pgbackrest_2.59.0-1.pgdg13%2B1_amd64.deb \
    /packages/pgbackrest.deb
ADD --checksum=sha256:915c4ec450a369d430e0151f9e10e25044ea2f0d6e41901e00a9317e232e5683 \
    https://deb.debian.org/debian/pool/main/libs/libssh2/libssh2-1t64_1.11.1-1%2Bdeb13u1_amd64.deb \
    /packages/libssh2.deb

FROM pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e AS packages-arm64

ADD --checksum=sha256:bb42e82a8c02a556b98e2002f4ea2aa14675d34627ba4025351e56c9c520fc20 \
    https://apt.postgresql.org/pub/repos/apt/pool/main/p/pgbackrest/pgbackrest_2.59.0-1.pgdg13%2B1_arm64.deb \
    /packages/pgbackrest.deb
ADD --checksum=sha256:600c2a845d6d14d292c765382bc7e644898762e1634a4aecf5b85329622dbbfe \
    https://deb.debian.org/debian/pool/main/libs/libssh2/libssh2-1t64_1.11.1-1%2Bdeb13u1_arm64.deb \
    /packages/libssh2.deb

FROM pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e AS runtime

ARG TARGETARCH
ARG MOMO_BUILD_SHA=unknown

LABEL org.opencontainers.image.title="oort PostgreSQL 18 + pgBackRest" \
      org.opencontainers.image.description="Pinned pgvector PostgreSQL 18 base with pgBackRest; bundled notices cover the additive pgBackRest/libssh2 delta, not the complete Debian OS inventory" \
      org.opencontainers.image.revision="${MOMO_BUILD_SHA}" \
      com.oor7.oort.postgres-base.digest="sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e" \
      com.oor7.oort.pgbackrest.version="2.59.0-1.pgdg13+1" \
      com.oor7.oort.libssh2.version="1.11.1-1+deb13u1" \
      com.oor7.oort.additive-licenses="MIT AND BSD-3-Clause AND ISC"

COPY --from=packages-amd64 /packages/ /tmp/packages/amd64/
COPY --from=packages-arm64 /packages/ /tmp/packages/arm64/
COPY infra/rust/postgres-pgbackrest/oort-pgbackrest /usr/local/bin/oort-pgbackrest

USER root

RUN set -eux; \
    case "$TARGETARCH" in \
      amd64|arm64) package_dir="/tmp/packages/$TARGETARCH" ;; \
      *) echo "unsupported TARGETARCH for pinned pgBackRest packages: $TARGETARCH" >&2; exit 64 ;; \
    esac; \
    test "$(dpkg-deb -f "$package_dir/pgbackrest.deb" Package)" = "pgbackrest"; \
    test "$(dpkg-deb -f "$package_dir/pgbackrest.deb" Version)" = "2.59.0-1.pgdg13+1"; \
    test "$(dpkg-deb -f "$package_dir/pgbackrest.deb" Architecture)" = "$TARGETARCH"; \
    test "$(dpkg-deb -f "$package_dir/libssh2.deb" Package)" = "libssh2-1t64"; \
    test "$(dpkg-deb -f "$package_dir/libssh2.deb" Version)" = "1.11.1-1+deb13u1"; \
    test "$(dpkg-deb -f "$package_dir/libssh2.deb" Architecture)" = "$TARGETARCH"; \
    dpkg -i "$package_dir/libssh2.deb" "$package_dir/pgbackrest.deb"; \
    test "$(dpkg-query -W -f='${Version}' pgbackrest)" = "2.59.0-1.pgdg13+1"; \
    test "$(dpkg-query -W -f='${Version}' libssh2-1t64)" = "1.11.1-1+deb13u1"; \
    test "$(pgbackrest version)" = "pgBackRest 2.59.0"; \
    grep -Fxq 'License: MIT' /usr/share/doc/pgbackrest/copyright; \
    grep -Fxq 'License: BSD3' /usr/share/doc/libssh2-1t64/copyright; \
    grep -Fxq 'License: ISC' /usr/share/doc/libssh2-1t64/copyright; \
    install -d -m 0755 /usr/share/licenses/oort-postgres; \
    install -m 0644 /usr/share/doc/pgbackrest/copyright /usr/share/licenses/oort-postgres/pgbackrest-MIT; \
    install -m 0644 /usr/share/doc/libssh2-1t64/copyright /usr/share/licenses/oort-postgres/libssh2-BSD3-ISC; \
    chmod 0755 /usr/local/bin/oort-pgbackrest; \
    rm -rf /tmp/packages; \
    test -s /usr/share/licenses/oort-postgres/pgbackrest-MIT; \
    test -s /usr/share/licenses/oort-postgres/libssh2-BSD3-ISC

# Keep the upstream postgres entrypoint, PGDATA, and default command. Secrets
# are loaded only by /usr/local/bin/oort-pgbackrest at command execution time.
