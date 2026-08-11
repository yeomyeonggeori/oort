#!/usr/bin/env python3
"""Static contract for the Rust GHCR artifact and its self-host consumers.

This deliberately does not call GitHub or push an image. Runtime image building
is separate evidence; this test keeps the manual workflow, Dockerfile, Compose,
quickstart, and local gate pointing at one deployable artifact shape.
"""

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
CANONICAL_IMAGE = "ghcr.io/yeomyeonggeori/oort"
EXPECTED_ROLES = (
    "api",
    "relay",
    "agent-worker",
    "webhook-sender",
    "notifier",
    "migrate",
    "web-assets",
)


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


workflow = read(".github/workflows/publish-images.yml")
trigger_block = workflow.split("permissions:", 1)[0]
require(
    re.search(r"(?m)^\s{2}workflow_dispatch:\s*$", trigger_block) is not None,
    "workflow must be manually dispatched",
)
for forbidden in ("push", "pull_request", "schedule"):
    require(
        re.search(rf"(?m)^\s{{2}}{forbidden}:\s*$", trigger_block) is None,
        f"workflow must not declare {forbidden}",
    )
for permission in ("contents: read", "packages: write", "id-token: write", "attestations: write"):
    require(permission in workflow, f"workflow missing least-privilege permission: {permission}")

require(f"IMAGE: {CANONICAL_IMAGE}" in workflow, "workflow missing canonical oort image")
require("sha-${{ github.sha }}" in workflow, "image tag must bind to the dispatch commit")
require("file: server-rust/Dockerfile" in workflow, "workflow must use the Rust Dockerfile")
require("file: infra/prod/docker/momo.Dockerfile" not in workflow, "workflow still publishes the retired Swift image")
require("platforms: linux/amd64" in workflow, "workflow must publish for the live amd64 host")
require("linux/arm64" not in workflow, "first Rust publication must not claim an unbuilt arm64 artifact")
require("docker/setup-qemu-action" not in workflow, "native amd64 publication must not install QEMU")
require("MOMO_BUILD_SHA=${{ github.sha }}" in workflow, "workflow must stamp the source commit into the image")
require("push: true" in workflow, "build action must push the image")
require("provenance: mode=max" in workflow, "workflow must publish max provenance")
require("sbom: true" in workflow, "workflow must publish an SBOM attestation")
require("digest: ${{ steps.build.outputs.digest }}" in workflow, "workflow must expose the immutable digest")
require("org.opencontainers.image.source=" in workflow, "GHCR package must link to its source repository")
require("org.opencontainers.image.revision=${{ github.sha }}" in workflow, "OCI revision must match the dispatch SHA")
require("org.opencontainers.image.licenses=Apache-2.0" in workflow, "OCI license metadata must be explicit")
require("matrix:" not in workflow, "workflow must publish exactly one custom application image")
require("latest" not in workflow, "manual publication must not create a mutable latest tag")

dockerfile = read("server-rust/Dockerfile")
entrypoint = read("server-rust/docker-entrypoint.sh")
require("ARG MOMO_BUILD_SHA=unknown" in dockerfile, "Dockerfile needs an honest unstamped fallback")
require("org.opencontainers.image.revision=\"${MOMO_BUILD_SHA}\"" in dockerfile, "runtime image must carry the build SHA")
require("org.opencontainers.image.licenses=\"Apache-2.0\"" in dockerfile, "runtime image must carry license metadata")
require("COPY LICENSE NOTICE /usr/share/licenses/momo-rust/" in dockerfile, "redistributed image must contain LICENSE and NOTICE")
require("COPY --from=web-build" in dockerfile, "published Rust image must include the current web bundle")
require("grep -q \"content=\\\"${MOMO_BUILD_SHA}\\\"\" dist/index.html" in dockerfile, "web bundle must fail if the build stamp disappears")

for role in EXPECTED_ROLES:
    require(
        re.search(rf"(?m)^  {re.escape(role)}\)$", entrypoint) is not None,
        f"Rust image entrypoint missing role: {role}",
    )
for retired_role in ("worker", "linkshort"):
    require(
        re.search(rf"(?m)^  {retired_role}\)$", entrypoint) is None,
        f"Rust image entrypoint still exposes retired Swift role: {retired_role}",
    )

compose_contract = "\n".join(
    read(path)
    for path in (
        "infra/rust/docker-compose.rust.yml",
        "infra/rust/docker-compose.push.yml",
        "infra/rust/local.override.yml",
    )
)
require("${MOMO_RUST_IMAGE:?set MOMO_RUST_IMAGE}" in compose_contract, "Rust Compose path must require one image ref")
for role in EXPECTED_ROLES:
    require(f'command: ["{role}"]' in compose_contract, f"Rust Compose path has no consumer for role: {role}")

self_host = read("scripts/self_host_env.sh")
self_host_doc = read("docs/SELF_HOST.md")
require(f'CANONICAL_PUBLISHED_IMAGE="{CANONICAL_IMAGE}"' in self_host, "self-host generator must pin the canonical package")
require("--local-build" in self_host and "--published-image" in self_host, "self-host generator must expose both image modes")
require("MOMO_SELF_HOST_MODE=$MODE" in self_host, "generated env must record the selected image mode")
require("@sha256:[0-9a-f]{64}" in self_host, "published mode must require a full sha256 digest")
require("--pull missing --wait" in self_host, "published mode must pull an absent digest before starting")
require("--local-build" in self_host_doc and "--published-image" in self_host_doc, "SELF_HOST must document both image modes")
require("@sha256:" in self_host_doc, "SELF_HOST must show digest pinning instead of a mutable tag")

local_gate = read("scripts/local_gate.sh")
require(
    "python3 scripts/tests/test_publish_images_contract.py" in local_gate,
    "the Rust publish contract must run in the local gate",
)
require(
    "scripts/tests/test_self_host_env_modes.sh" in local_gate,
    "the self-host mode boundary must run in the local gate",
)

print("Rust publish + self-host static contract: PASS")
