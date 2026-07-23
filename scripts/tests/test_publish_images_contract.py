#!/usr/bin/env python3
"""Static MOMO-360 contract checks; does not invoke Docker or external APIs."""

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


workflow = read(".github/workflows/publish-images.yml")
trigger_block = workflow.split("permissions:", 1)[0]
require("workflow_dispatch:" in trigger_block, "workflow must be manually dispatched")
for forbidden in ("push:", "pull_request:", "schedule:"):
    require(forbidden not in trigger_block, f"workflow must not declare {forbidden}")
require("packages: write" in workflow, "workflow needs package publication permission")
require("platforms: linux/arm64" in workflow, "workflow must publish linux/arm64")
require("push: true" in workflow, "build action must push images")
require("sha-${{ github.sha }}" in workflow, "image tag must bind to the dispatch commit")

require("matrix:" not in workflow, "workflow must publish exactly one custom image")
require("IMAGE: ghcr.io/dawn-kim-official/momo" in workflow, "workflow missing canonical momo image")
require("file: infra/prod/docker/momo.Dockerfile" in workflow, "workflow must use the multi-command Dockerfile")
require("provenance: mode=max" in workflow, "workflow must publish max provenance")
require("sbom: true" in workflow, "workflow must publish an SBOM attestation")
require("digest: ${{ steps.build.outputs.digest }}" in workflow, "workflow must expose the immutable digest")

compose = read("infra/prod/docker-compose.prod.yml")
require("tag: ${MOMO_IMAGE_TAG:?set MOMO_IMAGE_TAG}" in compose, "compose must require shared release tag metadata")
commands = {
    "MOMO_API_IMAGE": 'command: ["api"]',
    "MOMO_RELAY_IMAGE": 'command: ["relay"]',
    "MOMO_WORKER_IMAGE": 'command: ["worker"]',
    "MOMO_MIGRATE_IMAGE": 'command: ["migrate"]',
    "MOMO_WEB_IMAGE": 'command: ["web-assets"]',
    "MOMO_LINKSHORT_IMAGE": 'command: ["linkshort"]',
}
for variable, command in commands.items():
    require(f"${{{variable}:?set {variable}}}" in compose, f"compose missing required {variable}")
    require(command in compose, f"compose missing multi-command argv {command}")
require(re.search(r"^  migrate:\n", compose, flags=re.MULTILINE) is not None, "compose needs a one-shot migrate service")
require(compose.count("condition: service_completed_successfully") >= 3, "runtime services must wait for migration")
require("MOMO_AGENT_SEED_MODE: none" in compose, "production migration must not seed agents")

for relative in ("infra/prod/.env.example", "infra/prod/secrets.env.example", "infra/prod/aws-internal-alpha.env.example"):
    env = read(relative)
    require("MOMO_IMAGE=ghcr.io/dawn-kim-official/momo:${MOMO_IMAGE_TAG}" in env, f"{relative} missing canonical image")
    require("MOMO_IMAGE_TAG=" in env, f"{relative} missing the shared image tag")
    for variable in commands:
        require(f"{variable}=${{MOMO_IMAGE}}" in env, f"{relative} must derive {variable} from MOMO_IMAGE")

for relative in ("scripts/prod_env_preflight.sh", "scripts/aws_internal_alpha_preflight.sh"):
    preflight = read(relative)
    require("assert_release_tag MOMO_IMAGE_TAG" in preflight, f"{relative} must validate the immutable release tag")
    require("assert_image_matches_release MOMO_IMAGE" in preflight, f"{relative} must bind canonical image to the release")
    require("assert_image_matches_release MOMO_MIGRATE_IMAGE" in preflight, f"{relative} must bind migrate to the release")
    require("assert_image_matches_release MOMO_WEB_IMAGE" in preflight, f"{relative} must bind web to the release")
    require("assert_image_matches_release MOMO_LINKSHORT_IMAGE" in preflight, f"{relative} must bind LinkShort to the release")

print("publish images static contract: PASS")
