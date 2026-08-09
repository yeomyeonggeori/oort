#!/usr/bin/env python3
"""Static MOMO-360 contract checks; does not invoke Docker or external APIs."""

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]

# 발행 이미지의 정본 GHCR 경로. 워크플로와 prod env 템플릿 3종이 이 한 문자열에 합의해야 한다.
# org명이 두 곳에 중복돼 있어 #1224 실소유 재조준 때 한쪽만 고칠 위험이 있었으므로 여기로 모은다.
CANONICAL_IMAGE = "ghcr.io/yeomyeonggeori/momo"


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
require(f"IMAGE: {CANONICAL_IMAGE}" in workflow, "workflow missing canonical momo image")
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
    require(f"MOMO_IMAGE={CANONICAL_IMAGE}:${{MOMO_IMAGE_TAG}}" in env, f"{relative} missing canonical image")
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
