#!/usr/bin/env python3
"""Contract for the Rust GHCR artifact and its self-host consumers.

This deliberately never calls GitHub or pushes an image. It parses the manual
workflow, exercises its main-ref guard, mutates security-critical bindings to
prove the validator fails closed, and checks the deploy verifier's exact SLSA
v1 invocation with a fake ``gh`` executable.
"""

from copy import deepcopy
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
CANONICAL_IMAGE = "ghcr.io/yeomyeonggeori/oort"
SLSA_V1 = "https://slsa.dev/provenance/v1"
EXPECTED_PERMISSIONS = {
    "contents": "read",
    "packages": "write",
    "id-token": "write",
    "attestations": "write",
}
EXPECTED_ACTIONS = {
    "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
    "docker/setup-buildx-action": "8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
    "docker/login-action": "c94ce9fb468520275223c153574b00df6fe4bcc9",
    "docker/build-push-action": "10e90e3645eae34f1e60eeb005ba3a3d33f178e8",
    "actions/attest": "1e69f48acb82d1966a394da916b4c1698aa569d6",
}
EXPECTED_ROLES = (
    "api",
    "relay",
    "agent-worker",
    "webhook-sender",
    "notifier",
    "migrate",
    "web-assets",
)

RUBY_SAFE_YAML = r"""
text = File.read(ARGV.fetch(0))
begin
  value = YAML.safe_load(text, permitted_classes: [], permitted_symbols: [], aliases: true)
rescue ArgumentError
  value = YAML.safe_load(text, [], [], true)
end
puts JSON.generate(value)
"""


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def parse_workflow() -> dict[str, Any]:
    """Use Ruby's standard-library YAML parser; no repo dependency is needed."""
    parsed = subprocess.run(
        [
            "ruby",
            "-rjson",
            "-ryaml",
            "-e",
            RUBY_SAFE_YAML,
            str(ROOT / ".github/workflows/publish-images.yml"),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    value = json.loads(parsed.stdout)
    require(isinstance(value, dict), "workflow must parse to a mapping")
    return value


def run_ref_guard(script: str, ref: str) -> int:
    environment = {"PATH": os.environ.get("PATH", ""), "DISPATCH_REF": ref}
    return subprocess.run(
        ["bash", "-euo", "pipefail", "-c", script],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    ).returncode


def step_by_id(steps: list[dict[str, Any]], step_id: str) -> dict[str, Any]:
    matches = [step for step in steps if step.get("id") == step_id]
    require(len(matches) == 1, f"workflow must have exactly one {step_id!r} step")
    return matches[0]


def validate_workflow(model: dict[str, Any]) -> None:
    # Ruby's YAML 1.1 parser treats the unquoted key `on` as boolean true.
    trigger = model.get("on", model.get("true"))
    require(trigger == {"workflow_dispatch": None}, "workflow must be manual-only")
    require(model.get("permissions") == EXPECTED_PERMISSIONS, "workflow permissions must remain exact and minimal")
    require(model.get("env", {}).get("IMAGE") == CANONICAL_IMAGE, "workflow missing canonical oort image")
    require(
        model.get("env", {}).get("IMAGE_TAG") == "sha-${{ github.sha }}",
        "workflow tag must identify the dispatch commit",
    )

    jobs = model.get("jobs")
    require(isinstance(jobs, dict) and list(jobs) == ["publish"], "workflow must expose one publish job")
    job = jobs["publish"]
    require(job.get("environment") == "release", "publish job must cross the release Environment boundary")
    require(job.get("outputs", {}).get("digest") == "${{ steps.build.outputs.digest }}", "job output must expose build digest")
    steps = job.get("steps")
    require(isinstance(steps, list) and steps, "publish job must contain steps")

    guard_steps = [step for step in steps if step.get("name") == "Require a main-branch dispatch"]
    require(len(guard_steps) == 1, "workflow must have one explicit main-ref guard")
    guard = guard_steps[0]
    require(steps.index(guard) == 0, "main-ref guard must run before checkout, login, or push")
    require(guard.get("env", {}).get("DISPATCH_REF") == "${{ github.ref }}", "main-ref guard must read github.ref")
    guard_script = guard.get("run")
    require(isinstance(guard_script, str), "main-ref guard must be a shell step")
    require("refs/heads/main" in guard_script, "main-ref guard must require refs/heads/main")
    require(run_ref_guard(guard_script, "refs/heads/main") == 0, "main-ref guard must allow main")
    require(run_ref_guard(guard_script, "refs/heads/review-fixture") != 0, "main-ref guard must reject non-main")

    uses_steps = [step for step in steps if "uses" in step]
    require(len(uses_steps) == len(EXPECTED_ACTIONS), "workflow must not add or duplicate action steps")
    seen_actions: dict[str, str] = {}
    for step in uses_steps:
        uses = step["uses"]
        require(
            isinstance(uses, str) and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}", uses) is not None,
            f"action must use a full commit SHA: {uses!r}",
        )
        action, revision = uses.split("@", 1)
        seen_actions[action] = revision
    require(seen_actions == EXPECTED_ACTIONS, "workflow action set or immutable pins drifted")

    build = step_by_id(steps, "build")
    build_inputs = build.get("with", {})
    require(build.get("uses") == f"docker/build-push-action@{EXPECTED_ACTIONS['docker/build-push-action']}", "build action pin drifted")
    require(build_inputs.get("context") == ".", "build context must be repository root")
    require(build_inputs.get("file") == "server-rust/Dockerfile", "workflow must use the Rust Dockerfile")
    require(build_inputs.get("platforms") == "linux/amd64", "workflow must publish only the live amd64 platform")
    require(build_inputs.get("push") is True, "digest attestation is valid only for a pushed registry image")
    require(build_inputs.get("tags") == "${{ env.IMAGE }}:${{ env.IMAGE_TAG }}", "build tag must bind package and commit locator")
    require("MOMO_BUILD_SHA=${{ github.sha }}" in build_inputs.get("build-args", ""), "workflow must stamp exact source SHA")
    require(build_inputs.get("provenance") == "mode=max", "build must emit maximum provenance")
    require(build_inputs.get("sbom") is True, "build must emit an SBOM")

    attest = step_by_id(steps, "attest")
    attest_inputs = attest.get("with", {})
    require(steps.index(attest) > steps.index(build), "attestation must follow the pushed build")
    require(attest.get("uses") == f"actions/attest@{EXPECTED_ACTIONS['actions/attest']}", "attestation action pin drifted")
    require(attest_inputs.get("subject-name") == "${{ env.IMAGE }}", "attestation subject must be the untagged canonical package")
    require(attest_inputs.get("subject-digest") == "${{ steps.build.outputs.digest }}", "attestation must bind the pushed build digest")
    require(attest_inputs.get("push-to-registry") is True, "attestation must publish as an OCI registry referrer")
    require(attest_inputs.get("create-storage-record") is False, "optional storage records would widen permissions")


def expect_workflow_rejected(model: dict[str, Any], message: str) -> None:
    try:
        validate_workflow(model)
    except AssertionError:
        return
    raise AssertionError(f"negative workflow mutation was accepted: {message}")


def validate_workflow_mutations(model: dict[str, Any]) -> None:
    steps = model["jobs"]["publish"]["steps"]

    mutation = deepcopy(model)
    step_by_id(mutation["jobs"]["publish"]["steps"], "attest")["uses"] = "actions/attest@v4"
    expect_workflow_rejected(mutation, "mutable action ref")

    mutation = deepcopy(model)
    mutation["jobs"]["publish"]["steps"] = mutation["jobs"]["publish"]["steps"][1:]
    expect_workflow_rejected(mutation, "main-ref guard removal")

    mutation = deepcopy(model)
    mutation["jobs"]["publish"]["steps"][0]["run"] = "test -n refs/heads/main\n"
    expect_workflow_rejected(mutation, "non-main ref allowed")

    mutation = deepcopy(model)
    step_by_id(mutation["jobs"]["publish"]["steps"], "build")["with"]["push"] = False
    expect_workflow_rejected(mutation, "registry push disabled")

    for key, replacement, description in (
        ("subject-name", "${{ env.IMAGE }}:${{ env.IMAGE_TAG }}", "tagged attestation subject"),
        ("subject-digest", "sha256:deadbeef", "attestation detached from build digest"),
        ("push-to-registry", False, "OCI attestation publication disabled"),
    ):
        mutation = deepcopy(model)
        step_by_id(mutation["jobs"]["publish"]["steps"], "attest")["with"][key] = replacement
        expect_workflow_rejected(mutation, description)

    mutation = deepcopy(model)
    mutated_steps = mutation["jobs"]["publish"]["steps"]
    attest_index = next(index for index, step in enumerate(mutated_steps) if step.get("id") == "attest")
    attest_step = mutated_steps.pop(attest_index)
    build_index = next(index for index, step in enumerate(mutated_steps) if step.get("id") == "build")
    mutated_steps.insert(build_index, attest_step)
    expect_workflow_rejected(mutation, "attestation before push")

    mutation = deepcopy(model)
    mutation["permissions"]["artifact-metadata"] = "write"
    expect_workflow_rejected(mutation, "permission expansion")

    # Avoid an unused local that could hide accidental changes to this fixture.
    require(step_by_id(steps, "build") is not None, "base mutation fixture must contain build")


def validate_deploy_contract(text: str) -> None:
    require('gh attestation verify "oci://$image_ref"' in text, "deploy must verify the selected OCI digest")
    require("--repo yeomyeonggeori/oort" in text, "deploy attestation must bind repository identity")
    require(f"--predicate-type {SLSA_V1}" in text, "deploy attestation must require SLSA provenance v1")


def validate_deploy_behavior() -> None:
    digest_ref = f"{CANONICAL_IMAGE}@sha256:{'a' * 64}"
    with tempfile.TemporaryDirectory(prefix="oort-attestation-contract-") as directory:
        fixture = Path(directory)
        trace = fixture / "gh.args"
        fake_gh = fixture / "gh"
        fake_gh.write_text('#!/bin/sh\nprintf \'%s\\n\' "$@" >"$TRACE_FILE"\n', encoding="utf-8")
        fake_gh.chmod(0o755)
        environment = os.environ.copy()
        environment.update(
            {
                "PATH": f"{fixture}:{environment.get('PATH', '')}",
                "TRACE_FILE": str(trace),
                "MOMO_IMAGE": digest_ref,
                "MOMO_ATTESTATION_POLICY": "required",
            }
        )
        result = subprocess.run(
            [
                "bash",
                "-c",
                'source "$1"; verify_momo_image_attestations',
                "deploy-attestation-contract",
                str(ROOT / "infra/prod/deploy-lib.sh"),
            ],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        require(result.returncode == 0, "deploy SLSA verifier must accept a successful gh verification")
        require(
            trace.read_text(encoding="utf-8").splitlines()
            == [
                "attestation",
                "verify",
                f"oci://{digest_ref}",
                "--repo",
                "yeomyeonggeori/oort",
                "--predicate-type",
                SLSA_V1,
            ],
            "deploy verifier arguments must bind OCI digest, repository, and SLSA v1",
        )


workflow_text = read(".github/workflows/publish-images.yml")
workflow_model = parse_workflow()
validate_workflow(workflow_model)
validate_workflow_mutations(workflow_model)
require("file: infra/prod/docker/momo.Dockerfile" not in workflow_text, "workflow still publishes retired Swift image")
require("linux/arm64" not in workflow_text, "first Rust publication must not claim an unbuilt arm64 artifact")
require("docker/setup-qemu-action" not in workflow_text, "native amd64 publication must not install QEMU")
require("org.opencontainers.image.source=" in workflow_text, "GHCR package must link to source repository")
require("org.opencontainers.image.revision=${{ github.sha }}" in workflow_text, "OCI revision must match source SHA")
require("org.opencontainers.image.licenses=Apache-2.0" in workflow_text, "OCI license metadata must be explicit")
require("matrix:" not in workflow_text, "workflow must publish exactly one application image")
require(re.search(r"(?m)^\s+latest(?:\s|:)", workflow_text) is None, "workflow must not publish a latest tag")

dockerfile = read("server-rust/Dockerfile")
entrypoint = read("server-rust/docker-entrypoint.sh")
require("ARG MOMO_BUILD_SHA=unknown" in dockerfile, "Dockerfile needs an honest unstamped fallback")
require('org.opencontainers.image.revision="${MOMO_BUILD_SHA}"' in dockerfile, "runtime image must carry build SHA")
require('org.opencontainers.image.licenses="Apache-2.0"' in dockerfile, "runtime image must carry license metadata")
require("COPY LICENSE NOTICE /usr/share/licenses/momo-rust/" in dockerfile, "redistributed image must contain LICENSE and NOTICE")
require("COPY --from=web-build" in dockerfile, "published Rust image must include current web bundle")
require('grep -q "content=\\"${MOMO_BUILD_SHA}\\"" dist/index.html' in dockerfile, "web bundle must retain build stamp")

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
require(f'CANONICAL_PUBLISHED_IMAGE="{CANONICAL_IMAGE}"' in self_host, "self-host generator must pin canonical package")
require("--local-build" in self_host and "--published-image" in self_host, "self-host generator must expose both modes")
require("MOMO_SELF_HOST_MODE=$MODE" in self_host, "generated env must record selected image mode")
require("@sha256:[0-9a-f]{64}" in self_host, "published mode must require full sha256 digest")
require("--pull missing --wait" in self_host, "published mode must pull absent digest before starting")
require("validate_env_scalar" in self_host, "all env-file inputs need one shared scalar validator")
require("validate_owner_email" in self_host, "owner email must be dotenv-safe before persistence")
require("validate_owner_password" in self_host, "owner password must be dotenv-safe before persistence")
require("reject_duplicate_env_keys" in self_host, "existing env files must reject duplicate assignments")
require("normalize_port" in self_host, "ports must be normalized before arithmetic")
require("compose_ambient_keys" in self_host, "render/start commands must derive the complete ambient-key boundary")
require("COMPOSE_CONTROL_KEYS" in self_host, "Compose control env must have an explicit denylist")
require("run_self_host_compose" in self_host, "all rendered and printed Compose commands need one sanitized launcher")
require("scripts/self_host_env.sh --compose" in self_host, "printed launch must use the sanitized Compose launcher")
require("validate_compose_command_args" in self_host, "caller Compose argv must not replace canonical config sources")
require("PUBLISHED_IMAGE_CONSUMERS=7" in self_host, "render verification must cover all seven image consumers")
require("head -1" not in self_host, "security-critical env keys must not use first-value parsing")
require("--local-build" in self_host_doc and "--published-image" in self_host_doc, "SELF_HOST must document both modes")
require("@sha256:" in self_host_doc, "SELF_HOST must show immutable digest pinning")

deploy_lib = read("infra/prod/deploy-lib.sh")
validate_deploy_contract(deploy_lib)
try:
    validate_deploy_contract(deploy_lib.replace(SLSA_V1, "https://slsa.dev/provenance/v0.2"))
except AssertionError:
    pass
else:
    raise AssertionError("negative deploy mutation was accepted: SLSA v1 binding removed")
validate_deploy_behavior()

local_gate = read("scripts/local_gate.sh")
require(
    "python3 scripts/tests/test_publish_images_contract.py" in local_gate,
    "the Rust publish contract must run in the local gate",
)
require(
    "scripts/tests/test_self_host_env_modes.sh" in local_gate,
    "the self-host mode boundary must run in the local gate",
)

print("Rust publish + self-host security contract: PASS")
