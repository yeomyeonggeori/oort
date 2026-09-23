# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# PostgreSQL 18.4 + pgvector 0.8.5 is the production database base. Keep the
# multi-platform manifest digest immutable; tags are only human-readable hints.
FROM pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e AS packages-amd64

# Package bytes are pinned independently of repository metadata so a republish
# or moving package index fails at the Docker layer. The URLs are permanent
# archives (#2572): the live deb.debian.org and apt.postgresql.org pools delete
# superseded versions (libssh2 1.11.1-1+deb13u1 went 404 at Debian 13.7 and
# failed the v0.1.6 publish), while snapshot.debian.org and
# apt-archive.postgresql.org keep every published file at a fixed path.
ADD --checksum=sha256:2ff822645a132ce71f215ae4355d050c6c542143ea6a267cb433acf6413b1a3e \
    https://apt-archive.postgresql.org/pub/repos/apt/pool/main/p/pgbackrest/pgbackrest_2.59.0-1.pgdg13%2B1_amd64.deb \
    /packages/pgbackrest.deb
ADD --checksum=sha256:dbb1024c192d4d292b7cfa902b96076cfe81b56a5eed4fb28da36e8bf543e49a \
    https://snapshot.debian.org/archive/debian/20260905T205002Z/pool/main/libs/libssh2/libssh2-1t64_1.11.1-1%2Bdeb13u2_amd64.deb \
    /packages/libssh2.deb

FROM pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e AS packages-arm64

ADD --checksum=sha256:bb42e82a8c02a556b98e2002f4ea2aa14675d34627ba4025351e56c9c520fc20 \
    https://apt-archive.postgresql.org/pub/repos/apt/pool/main/p/pgbackrest/pgbackrest_2.59.0-1.pgdg13%2B1_arm64.deb \
    /packages/pgbackrest.deb
ADD --checksum=sha256:245565f4ce5493d67a3c54e26bc3d9cf28b1b70eeb912de7cda61af52268017d \
    https://snapshot.debian.org/archive/debian/20260905T205002Z/pool/main/libs/libssh2/libssh2-1t64_1.11.1-1%2Bdeb13u2_arm64.deb \
    /packages/libssh2.deb

FROM pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e AS runtime

ARG TARGETARCH
ARG MOMO_BUILD_SHA=unknown

LABEL org.opencontainers.image.title="oort PostgreSQL 18 + pgBackRest" \
      org.opencontainers.image.description="Pinned pgvector PostgreSQL 18 base with pgBackRest; image copies LICENSE/NOTICE/index/generated bundle and verifies every dpkg copyright file exists. That inventory is evidence, not a legal-sufficiency claim." \
      org.opencontainers.image.revision="${MOMO_BUILD_SHA}" \
      com.oor7.oort.postgres-base.digest="sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e" \
      com.oor7.oort.pgbackrest.version="2.59.0-1.pgdg13+1" \
      com.oor7.oort.libssh2.version="1.11.1-1+deb13u2" \
      com.oor7.oort.additive-licenses="MIT AND BSD-3-Clause AND ISC"

COPY --from=packages-amd64 /packages/ /tmp/packages/amd64/
COPY --from=packages-arm64 /packages/ /tmp/packages/arm64/
COPY infra/rust/postgres-pgbackrest/oort-pgbackrest /usr/local/bin/oort-pgbackrest
COPY LICENSE NOTICE legal/THIRD_PARTY_NOTICES.md legal/generated/GHCR_THIRD_PARTY_NOTICES.txt /usr/share/licenses/oort-postgres/
COPY legal/generated/GHCR_NOTICE_BUNDLE.sha256 /usr/share/licenses/oort-postgres/
COPY scripts/check_debian_copyrights.sh /usr/local/bin/check_debian_copyrights.sh

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
    test "$(dpkg-deb -f "$package_dir/libssh2.deb" Version)" = "1.11.1-1+deb13u2"; \
    test "$(dpkg-deb -f "$package_dir/libssh2.deb" Architecture)" = "$TARGETARCH"; \
    dpkg -i "$package_dir/libssh2.deb" "$package_dir/pgbackrest.deb"; \
    test "$(dpkg-query -W -f='${Version}' pgbackrest)" = "2.59.0-1.pgdg13+1"; \
    test "$(dpkg-query -W -f='${Version}' libssh2-1t64)" = "1.11.1-1+deb13u2"; \
    test "$(pgbackrest version)" = "pgBackRest 2.59.0"; \
    grep -Fxq 'License: MIT' /usr/share/doc/pgbackrest/copyright; \
    grep -Fxq 'License: BSD3' /usr/share/doc/libssh2-1t64/copyright; \
    grep -Fxq 'License: ISC' /usr/share/doc/libssh2-1t64/copyright; \
    install -d -m 0755 /usr/share/licenses/oort-postgres; \
    install -m 0644 /usr/share/doc/pgbackrest/copyright /usr/share/licenses/oort-postgres/pgbackrest-MIT; \
    install -m 0644 /usr/share/doc/libssh2-1t64/copyright /usr/share/licenses/oort-postgres/libssh2-BSD3-ISC; \
    chmod 0755 /usr/local/bin/oort-pgbackrest /usr/local/bin/check_debian_copyrights.sh; \
    rm -rf /tmp/packages; \
    test -s /usr/share/licenses/oort-postgres/LICENSE; \
    test -s /usr/share/licenses/oort-postgres/NOTICE; \
    test -s /usr/share/licenses/oort-postgres/THIRD_PARTY_NOTICES.md; \
    test -s /usr/share/licenses/oort-postgres/GHCR_THIRD_PARTY_NOTICES.txt; \
    test -s /usr/share/licenses/oort-postgres/pgbackrest-MIT; \
    test -s /usr/share/licenses/oort-postgres/libssh2-BSD3-ISC; \
    ( cd /usr/share/licenses/oort-postgres && sha256sum -c GHCR_NOTICE_BUNDLE.sha256 ); \
    /usr/local/bin/check_debian_copyrights.sh --output /usr/share/licenses/oort-postgres/DEBIAN_COPYRIGHT_INVENTORY.txt

# Keep the upstream postgres entrypoint, PGDATA, and default command. Secrets
# are loaded only by /usr/local/bin/oort-pgbackrest at command execution time.
