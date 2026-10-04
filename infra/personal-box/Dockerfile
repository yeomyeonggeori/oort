# oort personal-cloud box image (ADR-0197 D1, spike S3 #3410).
# - base pinned by digest (node:22-bookworm-slim, linux multi-arch index)
# - non-root uid 10001, no setuid/setgid binaries, no secrets baked
# - Codex CLI (Apache-2.0) installed unmodified from the npm lockfile (integrity-pinned)
# - M3 (#3501, ADR-0197 D1): a second, unprivileged account `box-agent` (uid 10002) for
#   momo-box-agent, whose host key must stay unreadable to the person's uid 10001. The agent
#   binary itself is added by M2's image build; infra/personal-box/m3/ tests it on top of this one.
# - Claude Code CLI is proprietary ("All rights reserved", Anthropic legal terms):
#   it is NOT redistributed in this image. momo-box-install-claude installs it
#   at first start from the lockfile-pinned npm package into a tmpfs tools dir.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

ARG BOX_UID=10001
ARG BOX_AGENT_UID=10002
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates less procps \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid ${BOX_UID} box \
 && useradd --uid ${BOX_UID} --gid ${BOX_UID} --home-dir /home/box --shell /bin/bash box \
 && groupadd --gid ${BOX_AGENT_UID} box-agent \
 && useradd --uid ${BOX_AGENT_UID} --gid ${BOX_AGENT_UID} --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin box-agent \
 && mkdir -p /home/box /cred /work /opt/tools /var/lib/oort-box/key /var/lib/oort-box/state /run/oort-box-seal \
 && chown ${BOX_UID}:${BOX_UID} /home/box /cred /work /opt/tools \
 && chown ${BOX_AGENT_UID}:${BOX_AGENT_UID} /var/lib/oort-box/key /var/lib/oort-box/state /run/oort-box-seal \
 && chmod 0700 /cred /var/lib/oort-box/key /var/lib/oort-box/state /run/oort-box-seal \
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

# Interactive shells (docker exec bash -l / bashrc) get umask 077 so credential files are never group/world readable.
RUN printf 'umask 077\n' > /etc/profile.d/momo-umask.sh && printf '\numask 077\n' >> /etc/bash.bashrc

# #3496: Debian's /etc/profile resets PATH for a login shell, which dropped /opt/tools/node_modules/.bin
# (where the first-start Claude install lands) from `bash -l`, i.e. from every PTY the person opens. A
# profile.d snippet appends it at the END (zz- sorts after the distro's own scripts), only when absent.
RUN printf '%s\n' \
  '# oort box: the first-start tools dir joins PATH last, after the distro login PATH (#3496).' \
  'case ":${PATH}:" in' \
  '  *:/opt/tools/node_modules/.bin:*) ;;' \
  '  *) PATH="${PATH}:/opt/tools/node_modules/.bin" ;;' \
  'esac' \
  'export PATH' > /etc/profile.d/zz-momo-path.sh \
 && chmod 0644 /etc/profile.d/zz-momo-path.sh

# Credential homes are redirected into /cred (tmpfs or an opt-in volume) so nothing lands in HOME or the image.
ENV OORT_BOX=1 \
    HOME=/home/box \
    CLAUDE_CONFIG_DIR=/cred/claude \
    CODEX_HOME=/cred/codex \
    DISABLE_AUTOUPDATER=1 \
    PATH=/usr/local/bin:/usr/bin:/bin:/opt/tools/node_modules/.bin

# Source hash of the build context, so the verifier can refuse a stale image (see momo-s3-box.sh src_hash).
ARG SRC_HASH=unset
LABEL io.momo.s3.src-hash=$SRC_HASH

USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/momo-box-entry"]
CMD ["bash", "-l"]
