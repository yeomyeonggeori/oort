# oort prime adapter — the runtime image. Build context is `adapters/prime`.
#
#   docker build -t oort-prime-adapter:0.7.0 -f container/Dockerfile .
#
# ## Container, not host
#
# prime-agent is NOT a sandbox: it runs shell commands and a persistent IPython
# kernel with the caller's privileges. Host install is therefore not an option
# for this adapter, and `container/entrypoint.sh` draws the per-workspace
# boundary inside the container.
#
# ## The pin
#
# Release v0.7.0, SHA-256 verified at build time. This is a day-1 project whose
# RPC surface is already drifting from its own docs (`refine_complete` is
# emitted, documented nowhere, and absent from the shipped types), so an
# unpinned `latest` would move the contract under us silently. Bumping the pin
# means re-running `tests/` against the new tarball first.
FROM node:22-bookworm-slim

ARG PRIME_AGENT_VERSION=0.7.0
ARG PRIME_AGENT_SHA256=88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b

# python3: the RLM runtime's only model-facing tool is a persistent IPython
# kernel, and this adapter is Python. curl: tarball fetch and the mock's health
# poll. git: the agent's workspace.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/prime-agent
# The kernel bootstrap runs at BUILD time on purpose. Measured: without it the
# first `ipython` tool call in an offline container fails with "uv is required to
# set up the Python kernel … First-time setup needs internet", so a runtime
# offline container would ship a dead tool. `PRIME_AGENT_INSTALL_UV=1` makes the
# postinstall pull uv from astral.sh plus a CPython toolchain, ipykernel and
# prime-agent-runtime (that last one is not on PyPI — it ships inside the npm
# tarball). That is a real supply-chain fact about this harness; it happens here,
# once, in a build we pin and can inspect.
RUN curl -fsSL -o prime-agent.tgz \
      "https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v${PRIME_AGENT_VERSION}/prime-agent-${PRIME_AGENT_VERSION}.tgz" \
 && echo "${PRIME_AGENT_SHA256}  prime-agent.tgz" | sha256sum -c - \
 && PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL=1 \
    PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=1 \
    PRIME_AGENT_INSTALL_UV=1 \
    npm install -g --no-fund --no-audit ./prime-agent.tgz \
 && rm prime-agent.tgz

# No credential is baked in and none is expected at build time. The build's
# provider is the loopback mock; a deployment's real provider login is
# established inside the running container by its operator (ADR-0004).
# The image's own agent dir doubles as a read-only template: the kernel venv and
# the vendored rg/fd are package installs, not tenant state, so a per-workspace
# HOME borrows them from here instead of rebuilding them offline. It is left at
# `/root/.prime/agent` rather than copied somewhere tidier because a Python venv
# carries absolute paths in `pyvenv.cfg` and every console script shebang — a
# moved venv is a broken one.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/oort \
    OORT_PRIME_HOME=/opt/oort/prime \
    OORT_PRIME_SHARED_AGENT_DIR=/root/.prime/agent

COPY . /opt/oort/prime/
RUN chmod +x /opt/oort/prime/container/entrypoint.sh /opt/oort/prime/run.sh

# Pre-warm the kernel venv.
#
# The npm postinstall creates the venv but does NOT install the eight bundled
# Python skills — those are `uv pip install`ed on the first kernel start.
# Measured, first cell in a `--network none` container: 80.3s and all eight
# skills (agent_message, agent_observe, attach_image, compact, edit, goal,
# rlm_heartbeat, websearch) fail. With network: 3.5s and all install. One
# throwaway cell here — while the build still has network — lets the runtime
# container be both offline AND undegraded. It uses the same loopback mock, so
# still no credential.
#
# The `rm -rf /tmp/prime-agent-*` is load bearing, not tidiness. RPC mode is
# daemon-backed and the supervisor claims ownership with a `renameSync` inside
# `/tmp/prime-agent-0/supervisor-owners/`. Baked into an image layer, the first
# runtime rename crosses the overlayfs boundary and dies with `EXDEV: cross-device
# link not permitted` → "Prime Agent daemon exited during startup (code 1)", with
# the RPC client seeing nothing but EOF. That is a prime-agent bug in containers
# (v0.7.0); this line is the workaround.
RUN OORT_PRIME_WORKSPACE_ID=image-prewarm \
    OORT_PRIME_MOCK_PROVIDER=1 \
    OORT_PRIME_ISOLATION=off \
    OORT_PRIME_ALLOW_UNSAFE_ISOLATION=1 \
    MOCK_SCENARIO=tool MOCK_TOOL_SLEEP=0 \
      bash /opt/oort/prime/container/entrypoint.sh \
        python3 /opt/oort/prime/tests/rpc_probe.py \
          --model oort-mock/oort-mock-1 --timeout 300 --prompt "kernel prewarm" \
          --out /tmp/prewarm/probe.json \
 && rm -rf /tmp/prewarm /tmp/prime-agent-* /root/.prime/agent/logs \
 && rm -f /root/.prime/agent/models.json

WORKDIR /work
ENTRYPOINT ["bash", "/opt/oort/prime/container/entrypoint.sh"]
CMD ["python3", "-m", "prime.adapter"]
