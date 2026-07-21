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

components = re.findall(r"^\s+- component: (\S+)$", workflow, flags=re.MULTILINE)
require(components == ["api", "relay", "worker", "linkshort", "migrate", "web"], "matrix must contain six ordered runtime images")
for image in ("momo-server", "momo-outbox-relay", "momo-agent-worker", "momo-linkshort", "momo-migrate", "momo-web"):
    require(f"image: {image}" in workflow, f"workflow missing {image}")
require(workflow.count("dockerfile: infra/prod/docker/swift-service.Dockerfile") == 4, "four Swift services must share the production Dockerfile")
require("dockerfile: infra/prod/docker/internal-smoke-migrate.Dockerfile" in workflow, "migrate must use the source-checkout-free SQL image")
require("dockerfile: infra/prod/Dockerfile.web" in workflow, "web must use the dist-only production Dockerfile")

compose = read("infra/prod/docker-compose.prod.yml")
require("tag: ${MOMO_IMAGE_TAG:?set MOMO_IMAGE_TAG}" in compose, "compose must require shared release tag metadata")
for variable in ("MOMO_API_IMAGE", "MOMO_RELAY_IMAGE", "MOMO_WORKER_IMAGE", "MOMO_MIGRATE_IMAGE", "MOMO_WEB_IMAGE", "MOMO_LINKSHORT_IMAGE"):
    require(f"${{{variable}:?set {variable}}}" in compose, f"compose missing required {variable}")
require(re.search(r"^  migrate:\n", compose, flags=re.MULTILINE) is not None, "compose needs a one-shot migrate service")
require(compose.count("condition: service_completed_successfully") >= 3, "runtime services must wait for migration")
require("MOMO_AGENT_SEED_MODE: none" in compose, "production migration must not seed agents")

for relative in ("infra/prod/.env.example", "infra/prod/secrets.env.example", "infra/prod/aws-internal-alpha.env.example"):
    env = read(relative)
    require("MOMO_IMAGE_TAG=" in env, f"{relative} missing the shared image tag")
    require("MOMO_MIGRATE_IMAGE=" in env, f"{relative} missing the migrate image")
    require("MOMO_WEB_IMAGE=" in env, f"{relative} missing the web image")
    require("MOMO_LINKSHORT_IMAGE=" in env, f"{relative} missing the LinkShort image")

for relative in ("scripts/prod_env_preflight.sh", "scripts/aws_internal_alpha_preflight.sh"):
    preflight = read(relative)
    require("assert_release_tag MOMO_IMAGE_TAG" in preflight, f"{relative} must validate the immutable release tag")
    require("assert_image_matches_release MOMO_MIGRATE_IMAGE" in preflight, f"{relative} must bind migrate to the release")
    require("assert_image_matches_release MOMO_WEB_IMAGE" in preflight, f"{relative} must bind web to the release")
    require("assert_image_matches_release MOMO_LINKSHORT_IMAGE" in preflight, f"{relative} must bind LinkShort to the release")

print("publish images static contract: PASS")
