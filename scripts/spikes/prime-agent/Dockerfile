# Spike #1120 — prime agent in a container.
#
# prime-agent is NOT a sandbox (research/2026-08-06-prime-agent-ade-herdr.md §①):
# it runs shell commands and a persistent IPython kernel with the privileges of
# whoever launched it. Host install is therefore banned for this spike; the
# container IS the isolation boundary. Nothing here is wired to production.
#
# Version pin: release v0.7.0 (2026-08-05), SHA-256 verified at build time.
# Day-1 project — an unpinned `latest` would silently move under us.
FROM node:22-bookworm-slim

ARG PRIME_AGENT_VERSION=0.7.0
ARG PRIME_AGENT_SHA256=88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b

# python3 + venv: the RLM runtime's only model-facing tool is a persistent
# IPython kernel (docs/rlm-runtime.md). curl: tarball fetch. git: agent workspace.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/prime-agent
# Kernel bootstrap is done at BUILD time on purpose. Measured: without it the
# first `ipython` tool call fails with "uv is required to set up the Python
# kernel … First-time setup needs internet", so a run-time-offline container
# would have a dead tool. PRIME_AGENT_INSTALL_UV=1 makes the postinstall pull
# uv from astral.sh plus a CPython toolchain, ipykernel and prime-agent-runtime
# (that last one is NOT on PyPI — it ships inside the npm tarball). That is a
# real supply-chain fact about this harness, recorded in the spike doc; it
# happens here, once, in a build we can pin and inspect.
RUN curl -fsSL -o prime-agent.tgz \
      "https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v${PRIME_AGENT_VERSION}/prime-agent-${PRIME_AGENT_VERSION}.tgz" \
 && echo "${PRIME_AGENT_SHA256}  prime-agent.tgz" | sha256sum -c - \
 && PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL=1 \
    PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=1 \
    PRIME_AGENT_INSTALL_UV=1 \
    npm install -g --no-fund --no-audit ./prime-agent.tgz \
 && rm prime-agent.tgz

# No credentials are baked in and none are expected at runtime. The spike's
# provider is a loopback OpenAI-compatible mock (mock_provider.py); ADR-0004
# says provider credentials never enter our images or our servers.
ENV PRIME_AGENT_SPIKE=1

# The image's own agent dir doubles as a read-only template: the kernel venv and
# the vendored rg/fd are package installs, not tenant state, so a per-workspace
# HOME (#1130 ③) borrows them from here instead of rebuilding them offline.
ENV SPIKE_SHARED_AGENT_DIR=/root/.prime/agent

COPY mock_provider.py rpc_adapter.py container_entry.sh harness_probe.py tenancy_probe.sh /spike/

# Pre-warm the kernel venv. The npm postinstall bootstrap creates the venv but
# does NOT install the eight bundled Python skills — those are `uv pip install`d
# on the first kernel start. Measured, first cell in a `--network none`
# container: 80.3s and all eight skills (agent_message, agent_observe,
# attach_image, compact, edit, goal, rlm_heartbeat, websearch) fail. With
# network: 3.5s and all install. Running one throwaway cell here — while the
# build still has network — lets the runtime container be both offline AND
# undegraded. Uses the same loopback mock, so still no credential.
#
# The `rm -rf /tmp/prime-agent-*` is load bearing, not tidiness. RPC mode is
# daemon-backed, and the supervisor claims ownership with a renameSync inside
# /tmp/prime-agent-0/supervisor-owners/. If that directory is baked into an
# image layer, the first runtime rename crosses the overlayfs boundary and dies
# with `EXDEV: cross-device link not permitted` → "Prime Agent daemon exited
# during startup (code 1)", with the RPC client seeing nothing but EOF. That is
# a genuine prime-agent bug in containers (v0.7.0); this line is the workaround.
RUN SPIKE_OUT=/tmp/prewarm MOCK_SCENARIO=tool MOCK_TOOL_SLEEP=0 \
      bash /spike/container_entry.sh text --timeout 240 --prompt "kernel prewarm" \
 && rm -rf /tmp/prewarm /tmp/prime-agent-* /root/.prime/agent/logs \
 && rm -f /root/.prime/agent/models.json

WORKDIR /work
CMD ["prime-agent", "--version"]
