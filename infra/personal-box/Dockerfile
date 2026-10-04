# oort personal-cloud box image (ADR-0197 D1, spike S3 #3410).
# - base pinned by digest (node:22-bookworm-slim, linux multi-arch index)
# - non-root uid 10001, no setuid/setgid binaries, no secrets baked
# - Codex CLI (Apache-2.0) installed unmodified from the npm lockfile (integrity-pinned)
# - Claude Code CLI is proprietary ("All rights reserved", Anthropic legal terms):
#   it is NOT redistributed in this image. momo-box-install-claude installs it
#   at first start from the lockfile-pinned npm package into a tmpfs tools dir.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

ARG BOX_UID=10001
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates less procps \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid ${BOX_UID} box \
 && useradd --uid ${BOX_UID} --gid ${BOX_UID} --home-dir /home/box --shell /bin/bash box \
 && mkdir -p /home/box /cred /work /opt/tools \
 && chown ${BOX_UID}:${BOX_UID} /home/box /cred /work /opt/tools \
 && chmod 0700 /cred \
 && find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} + \
 && npm config set update-notifier false --location=global

# Codex: unmodified npm package, resolved only through the committed lockfile.
COPY codex/package.json codex/package-lock.json /opt/momo-box/codex/
RUN cd /opt/momo-box/codex && npm ci --no-audit --no-fund --ignore-scripts \
 && ln -s /opt/momo-box/codex/node_modules/.bin/codex /usr/local/bin/codex \
 && mkdir -p /usr/share/licenses/momo-box \
 && cp node_modules/@openai/codex/LICENSE /usr/share/licenses/momo-box/codex-LICENSE 2>/dev/null || true \
 && cp node_modules/@openai/codex/NOTICE /usr/share/licenses/momo-box/codex-NOTICE 2>/dev/null || true \
 && rm -rf /root/.npm

# Claude: only the pin (package.json + lockfile) ships; the CLI itself is fetched at first start.
COPY claude/package.json claude/package-lock.json /opt/momo-box/claude-pin/
COPY momo-box-install-claude momo-box-entry momo-box-leakscan /usr/local/bin/
RUN chmod 0755 /usr/local/bin/momo-box-install-claude /usr/local/bin/momo-box-entry /usr/local/bin/momo-box-leakscan

# Credential homes are redirected into /cred (tmpfs or an opt-in volume) so nothing lands in HOME or the image.
ENV HOME=/home/box \
    CLAUDE_CONFIG_DIR=/cred/claude \
    CODEX_HOME=/cred/codex \
    DISABLE_AUTOUPDATER=1 \
    PATH=/opt/tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin

USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/momo-box-entry"]
CMD ["bash", "-l"]
