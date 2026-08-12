#!/usr/bin/env python3
"""Contract for the Rust/PostgreSQL GHCR artifacts and self-host consumers.

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
POSTGRES_IMAGE = "ghcr.io/yeomyeonggeori/oort-postgres"
SLSA_V1 = "https://slsa.dev/provenance/v1"
POSTGRES_BASE_DIGEST = "9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e"
DOCKERFILE_FRONTEND_DIGEST = "a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e"
PGBACKREST_VERSION = "2.59.0-1.pgdg13+1"
PGBACKREST_PACKAGE_SHA256 = {
    "amd64": "2ff822645a132ce71f215ae4355d050c6c542143ea6a267cb433acf6413b1a3e",
    "arm64": "bb42e82a8c02a556b98e2002f4ea2aa14675d34627ba4025351e56c9c520fc20",
}
LIBSSH2_PACKAGE_SHA256 = {
    "amd64": "915c4ec450a369d430e0151f9e10e25044ea2f0d6e41901e00a9317e232e5683",
    "arm64": "600c2a845d6d14d292c765382bc7e644898762e1634a4aecf5b85329622dbbfe",
}
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
EXPECTED_ACTION_COUNTS = {
    "actions/checkout": 1,
    "docker/setup-buildx-action": 1,
    "docker/login-action": 1,
    "docker/build-push-action": 2,
    "actions/attest": 2,
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
    require(model.get("env", {}).get("POSTGRES_IMAGE") == POSTGRES_IMAGE, "workflow missing canonical PostgreSQL image")
    require(
        model.get("env", {}).get("IMAGE_TAG") == "sha-${{ github.sha }}",
        "workflow tag must identify the dispatch commit",
    )

    jobs = model.get("jobs")
    require(isinstance(jobs, dict) and list(jobs) == ["publish"], "workflow must expose one publish job")
    job = jobs["publish"]
    require(job.get("environment") == "release", "publish job must cross the release Environment boundary")
    require(
        job.get("outputs")
        == {
            "application-image": "${{ env.IMAGE }}",
            "application-digest": "${{ steps.build_app.outputs.digest }}",
            "postgres-image": "${{ env.POSTGRES_IMAGE }}",
            "postgres-digest": "${{ steps.build_postgres.outputs.digest }}",
        },
        "job outputs must expose both returned image digests",
    )
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
    require(len(uses_steps) == sum(EXPECTED_ACTION_COUNTS.values()), "workflow action count drifted")
    seen_actions: dict[str, list[str]] = {}
    for step in uses_steps:
        uses = step["uses"]
        require(
            isinstance(uses, str) and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}", uses) is not None,
            f"action must use a full commit SHA: {uses!r}",
        )
        action, revision = uses.split("@", 1)
        seen_actions.setdefault(action, []).append(revision)
    require(set(seen_actions) == set(EXPECTED_ACTIONS), "workflow action set drifted")
    for action, revisions in seen_actions.items():
        require(len(revisions) == EXPECTED_ACTION_COUNTS[action], f"workflow action count drifted: {action}")
        require(set(revisions) == {EXPECTED_ACTIONS[action]}, f"immutable action pin drifted: {action}")

    subjects = (
        (
            "application",
            "build_app",
            "server-rust/Dockerfile",
            "${{ env.IMAGE }}:${{ env.IMAGE_TAG }}",
            "attest_app",
            "${{ env.IMAGE }}",
        ),
        (
            "PostgreSQL",
            "build_postgres",
            "infra/rust/postgres-pgbackrest/Dockerfile",
            "${{ env.POSTGRES_IMAGE }}:${{ env.IMAGE_TAG }}",
            "attest_postgres",
            "${{ env.POSTGRES_IMAGE }}",
        ),
    )
    attestation_steps: list[dict[str, Any]] = []
    for name, build_id, dockerfile_path, tag, attest_id, subject_name in subjects:
        build = step_by_id(steps, build_id)
        build_inputs = build.get("with", {})
        require(
            build.get("uses") == f"docker/build-push-action@{EXPECTED_ACTIONS['docker/build-push-action']}",
            f"{name} build action pin drifted",
        )
        require(build_inputs.get("context") == ".", f"{name} build context must be repository root")
        require(build_inputs.get("file") == dockerfile_path, f"{name} Dockerfile path drifted")
        require(build_inputs.get("platforms") == "linux/amd64", f"{name} publication must match the live amd64 host")
        require(build_inputs.get("push") is True, f"{name} digest attestation requires a registry push")
        require(build_inputs.get("tags") == tag, f"{name} tag must bind package and commit locator")
        require("MOMO_BUILD_SHA=${{ github.sha }}" in build_inputs.get("build-args", ""), f"{name} image must stamp source SHA")
        require(build_inputs.get("provenance") == "mode=max", f"{name} build must emit maximum provenance")
        require(build_inputs.get("sbom") is True, f"{name} build must emit an SBOM")
        labels = build_inputs.get("labels", "")
        require("org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}" in labels, f"{name} package must link source")
        require("org.opencontainers.image.revision=${{ github.sha }}" in labels, f"{name} revision label must bind source SHA")
        if name == "application":
            require("org.opencontainers.image.licenses=Apache-2.0" in labels, "application license label drifted")
        else:
            require(
                "org.opencontainers.image.licenses=" not in labels,
                "PostgreSQL image must not misrepresent a partial dependency delta as a complete OS license inventory",
            )

        attest = step_by_id(steps, attest_id)
        attestation_steps.append(attest)
        attest_inputs = attest.get("with", {})
        require(steps.index(attest) > steps.index(build), f"{name} attestation must follow its pushed build")
        require(
            attest.get("uses") == f"actions/attest@{EXPECTED_ACTIONS['actions/attest']}",
            f"{name} attestation action pin drifted",
        )
        require(attest_inputs.get("subject-name") == subject_name, f"{name} attestation subject package drifted")
        require(
            attest_inputs.get("subject-digest") == f"${{{{ steps.{build_id}.outputs.digest }}}}",
            f"{name} attestation must bind its returned build digest",
        )
        require(attest_inputs.get("push-to-registry") is True, f"{name} attestation must be an OCI referrer")
        require(attest_inputs.get("create-storage-record") is False, "optional storage records would widen permissions")

    manifest = step_by_id(steps, "release_manifest")
    require(all(steps.index(manifest) > steps.index(step) for step in attestation_steps), "release manifest must follow both attestations")
    require(
        manifest.get("env")
        == {
            "APPLICATION_DIGEST": "${{ steps.build_app.outputs.digest }}",
            "POSTGRES_DIGEST": "${{ steps.build_postgres.outputs.digest }}",
        },
        "release manifest must consume both returned digests",
    )
    manifest_script = manifest.get("run", "")
    require("$IMAGE@$APPLICATION_DIGEST" in manifest_script, "release manifest missing application digest ref")
    require("$POSTGRES_IMAGE@$POSTGRES_DIGEST" in manifest_script, "release manifest missing PostgreSQL digest ref")
    require("^sha256:[0-9a-f]{64}$" in manifest_script, "release manifest must reject malformed digests")
    require(
        sum("GITHUB_STEP_SUMMARY" in str(step.get("run", "")) for step in steps) == 1,
        "release manifest must be the only publication summary",
    )


def expect_workflow_rejected(model: dict[str, Any], message: str) -> None:
    try:
        validate_workflow(model)
    except AssertionError:
        return
    raise AssertionError(f"negative workflow mutation was accepted: {message}")


def validate_workflow_mutations(model: dict[str, Any]) -> None:
    steps = model["jobs"]["publish"]["steps"]

    mutation = deepcopy(model)
    step_by_id(mutation["jobs"]["publish"]["steps"], "attest_postgres")["uses"] = "actions/attest@v4"
    expect_workflow_rejected(mutation, "mutable action ref")

    mutation = deepcopy(model)
    mutation["jobs"]["publish"]["steps"] = mutation["jobs"]["publish"]["steps"][1:]
    expect_workflow_rejected(mutation, "main-ref guard removal")

    mutation = deepcopy(model)
    mutation["jobs"]["publish"]["steps"][0]["run"] = "test -n refs/heads/main\n"
    expect_workflow_rejected(mutation, "non-main ref allowed")

    for build_id in ("build_app", "build_postgres"):
        mutation = deepcopy(model)
        step_by_id(mutation["jobs"]["publish"]["steps"], build_id)["with"]["push"] = False
        expect_workflow_rejected(mutation, f"{build_id} registry push disabled")

    for attest_id in ("attest_app", "attest_postgres"):
        for key, replacement, description in (
            ("subject-name", "${{ env.IMAGE }}:${{ env.IMAGE_TAG }}", "tagged attestation subject"),
            ("subject-digest", "sha256:deadbeef", "attestation detached from build digest"),
            ("push-to-registry", False, "OCI attestation publication disabled"),
        ):
            mutation = deepcopy(model)
            step_by_id(mutation["jobs"]["publish"]["steps"], attest_id)["with"][key] = replacement
            expect_workflow_rejected(mutation, f"{attest_id}: {description}")

    mutation = deepcopy(model)
    mutated_steps = mutation["jobs"]["publish"]["steps"]
    attest_index = next(index for index, step in enumerate(mutated_steps) if step.get("id") == "attest_postgres")
    attest_step = mutated_steps.pop(attest_index)
    build_index = next(index for index, step in enumerate(mutated_steps) if step.get("id") == "build_postgres")
    mutated_steps.insert(build_index, attest_step)
    expect_workflow_rejected(mutation, "PostgreSQL attestation before push")

    mutation = deepcopy(model)
    mutated_steps = mutation["jobs"]["publish"]["steps"]
    manifest_index = next(index for index, step in enumerate(mutated_steps) if step.get("id") == "release_manifest")
    manifest_step = mutated_steps.pop(manifest_index)
    first_attest_index = next(index for index, step in enumerate(mutated_steps) if step.get("id") == "attest_app")
    mutated_steps.insert(first_attest_index, manifest_step)
    expect_workflow_rejected(mutation, "release manifest before both attestations")

    mutation = deepcopy(model)
    step_by_id(mutation["jobs"]["publish"]["steps"], "attest_postgres")["with"]["subject-digest"] = (
        "${{ steps.build_app.outputs.digest }}"
    )
    expect_workflow_rejected(mutation, "both attestations bound to application digest")

    mutation = deepcopy(model)
    mutation["permissions"]["artifact-metadata"] = "write"
    expect_workflow_rejected(mutation, "permission expansion")

    # Avoid an unused local that could hide accidental changes to this fixture.
    require(step_by_id(steps, "build_app") is not None, "base mutation fixture must contain application build")
    require(step_by_id(steps, "build_postgres") is not None, "base mutation fixture must contain PostgreSQL build")


def validate_postgres_dockerfile(text: str) -> None:
    require(
        text.startswith(f"# syntax=docker/dockerfile:1.7@sha256:{DOCKERFILE_FRONTEND_DIGEST}\n"),
        "remote Dockerfile frontend must be digest pinned",
    )
    expected_base = (
        "pgvector/pgvector:0.8.5-pg18-trixie@sha256:"
        f"{POSTGRES_BASE_DIGEST}"
    )
    from_images = re.findall(r"(?m)^FROM\s+(\S+)", text)
    require(from_images == [expected_base] * 3, "every PostgreSQL build stage must use the pinned PG18 base")
    require("ARG TARGETARCH" in text, "package selection must use BuildKit TARGETARCH")
    require("amd64|arm64)" in text, "only the pinned amd64/arm64 package set may build")
    require("unsupported TARGETARCH" in text, "unsupported architectures must fail closed")
    require("apt-get" not in text, "moving apt indexes must not select pgBackRest dependencies")
    require("curl " not in text and "wget " not in text, "package downloads must use checksum-enforcing ADD")

    for architecture, checksum in PGBACKREST_PACKAGE_SHA256.items():
        require(f"ADD --checksum=sha256:{checksum}" in text, f"pgBackRest {architecture} package checksum drifted")
        require(
            f"pgbackrest_2.59.0-1.pgdg13%2B1_{architecture}.deb" in text,
            f"pgBackRest {architecture} package URL/version drifted",
        )
    for architecture, checksum in LIBSSH2_PACKAGE_SHA256.items():
        require(f"ADD --checksum=sha256:{checksum}" in text, f"libssh2 {architecture} package checksum drifted")
        require(
            f"libssh2-1t64_1.11.1-1%2Bdeb13u1_{architecture}.deb" in text,
            f"libssh2 {architecture} package URL/version drifted",
        )

    require(f'com.oor7.oort.pgbackrest.version="{PGBACKREST_VERSION}"' in text, "pgBackRest version label drifted")
    require(
        'com.oor7.oort.additive-licenses="MIT AND BSD-3-Clause AND ISC"' in text,
        "additive pgBackRest/libssh2 license delta label drifted",
    )
    require('test "$(pgbackrest version)" = "pgBackRest 2.59.0"' in text, "installed pgBackRest binary is not verified")
    require("grep -Fxq 'License: MIT'" in text, "pgBackRest MIT license delta must be verified")
    require("grep -Fxq 'License: BSD3'" in text, "libssh2 BSD3 license delta must be verified")
    require("grep -Fxq 'License: ISC'" in text, "libssh2 ISC files must be acknowledged")
    require("not the complete Debian OS inventory" in text, "image must not overclaim a complete Debian NOTICE inventory")
    require("/usr/share/licenses/oort-postgres/pgbackrest-MIT" in text, "pgBackRest notice must remain in the image")
    require("/usr/share/licenses/oort-postgres/libssh2-BSD3-ISC" in text, "libssh2 notice must remain in the image")
    require("ENV PGBACKREST_REPO1_CIPHER_PASS" not in text, "cipher secret must never enter image ENV")
    require("COPY infra/rust/postgres-pgbackrest/oort-pgbackrest" in text, "secret wrapper must be installed")


def validate_pgbackrest_wrapper(text: str) -> None:
    require(text.startswith("#!/bin/sh\nset -eu\n"), "pgBackRest wrapper must be fail-fast POSIX shell")
    require(
        text.count("cipher_secret_file=/run/secrets/pgbackrest_repo1_cipher_pass") == 1,
        "wrapper must use the exact, non-configurable cipher path",
    )
    require(
        text.count("s3_key_file=/run/secrets/pgbackrest_repo1_s3_key") == 1
        and text.count("s3_key_secret_file=/run/secrets/pgbackrest_repo1_s3_key_secret") == 1,
        "wrapper must use exact, non-configurable S3 credential paths",
    )
    require(
        "ambient_pgbackrest=$(env | LC_ALL=C sed -n" in text,
        "wrapper must reject every ambient PGBACKREST option before exporting reviewed values",
    )
    for forbidden in (
        "MOMO_PGBACKREST_CIPHER_PASS",
        "MOMO_PGBACKREST_S3_KEY",
        "MOMO_PGBACKREST_S3_KEY_SECRET",
    ):
        require(f'${{{forbidden}+x}}' in text, f"wrapper must reject raw {forbidden}")
    require("eval " not in text, "wrapper must not dynamically evaluate names or secret-bearing values")
    require('[ ! -L "$secret_path" ]' in text, "wrapper must reject symbolic-link secrets")
    require('[ -f "$secret_path" ]' in text, "wrapper must require a regular secret file")
    require("secret_owner=$(stat -c '%u' -- \"$secret_path\")" in text, "wrapper must inspect secret ownership")
    require(
        '[ "$secret_owner" = "$(id -u)" ]' in text,
        "wrapper must bind every secret to the exact pgBackRest process uid",
    )
    require("400|500|600|700)" in text, "wrapper must require owner-read and zero group/world mode bits")
    require('-perm /022' in text, "wrapper must reject group/world-writable secret files")
    require('wc -c < "$secret_path"' in text, "wrapper must enforce a byte bound without reading into argv")
    require('"$byte_count" -le 4097' in text, "wrapper secret file size must remain bounded")
    require("tr -cd '\\n'" in text, "wrapper must count newlines")
    require("tr -cd '\\r'" in text, "wrapper must reject carriage returns")
    require("tr -cd '\\000'" in text, "wrapper must reject NUL bytes")
    require('read_secret cipher "$cipher_secret_file" 32' in text, "cipher passphrase minimum drifted")
    require('read_secret s3-key "$s3_key_file" 16' in text, "S3 access-key minimum drifted")
    require('read_secret s3-key-secret "$s3_key_secret_file" 32' in text, "S3 secret-key minimum drifted")
    require('export PGBACKREST_REPO1_CIPHER_PASS="$REPLY"' in text, "wrapper must export cipher only after validation")
    require('repository=${MOMO_PGBACKREST_REPOSITORY:-posix}' in text, "repository mode must default to posix")
    require('*) fail "MOMO_PGBACKREST_REPOSITORY must be exactly posix or s3"' in text, "unknown repository modes must fail")
    require('[ "${MOMO_PGBACKREST_S3_URI_STYLE:-}" = path ]' in text, "S3 URI style must be path")
    require('[ "${MOMO_PGBACKREST_S3_VERIFY_TLS:-}" = y ]' in text, "S3 TLS verification must be mandatory")
    require("valid_dns_name()" in text, "S3 bucket/endpoint must use the DNS validator")
    require('valid_dns_name "$bucket"' in text, "S3 bucket must be DNS validated")
    require('valid_dns_name "$endpoint"' in text, "S3 endpoint must be a hostname, not arbitrary scalar input")
    require('export PGBACKREST_REPO1_S3_KEY="$REPLY"' in text, "S3 key must come from its file")
    require('export PGBACKREST_REPO1_S3_KEY_SECRET="$REPLY"' in text, "S3 secret key must come from its file")
    require(
        "export PGBACKREST_REPO1_STORAGE_VERIFY_TLS=y" in text,
        "wrapper must use pgBackRest's repository-storage TLS verification option",
    )
    require(
        "PGBACKREST_REPO1_S3_VERIFY_TLS" not in text,
        "nonexistent pgBackRest S3 TLS option must not be used",
    )
    exec_lines = [line.strip() for line in text.splitlines() if line.strip().startswith("exec ")]
    require(exec_lines == ['exec /usr/bin/pgbackrest "$@"'], "wrapper must exec the pinned binary with only caller argv")
    require("cat " not in text, "wrapper must not print/read the secret through cat")
    require("set -x" not in text, "wrapper must never enable secret-bearing xtrace")


def expect_postgres_contract_rejected(dockerfile: str, wrapper: str, message: str) -> None:
    try:
        validate_postgres_dockerfile(dockerfile)
        validate_pgbackrest_wrapper(wrapper)
    except AssertionError:
        return
    raise AssertionError(f"negative PostgreSQL image mutation was accepted: {message}")


def validate_postgres_mutations(dockerfile: str, wrapper: str) -> None:
    expect_postgres_contract_rejected(
        dockerfile.replace(PGBACKREST_PACKAGE_SHA256["amd64"], "0" * 64),
        wrapper,
        "pgBackRest checksum drift",
    )
    expect_postgres_contract_rejected(
        dockerfile.replace("amd64|arm64)", "amd64|arm64|ppc64le)"),
        wrapper,
        "unverified architecture enabled",
    )
    expect_postgres_contract_rejected(
        dockerfile,
        wrapper.replace('[ ! -L "$secret_path" ]', ": # symlink check removed"),
        "symlink secret accepted",
    )
    expect_postgres_contract_rejected(
        dockerfile,
        wrapper.replace('"$byte_count" -le 4097', '"$byte_count" -le 999999'),
        "secret size bound widened",
    )
    expect_postgres_contract_rejected(
        dockerfile,
        wrapper.replace('[ "$secret_owner" = "$(id -u)" ]', ': # exact uid check removed'),
        "secret owned by a foreign uid accepted",
    )
    expect_postgres_contract_rejected(
        dockerfile,
        wrapper.replace("400|500|600|700)", "400|444|500|600|700)"),
        "world-readable 0444 secret accepted",
    )
    expect_postgres_contract_rejected(
        dockerfile,
        wrapper.replace('exec /usr/bin/pgbackrest "$@"', 'exec /usr/bin/pgbackrest "$@" "$PGBACKREST_REPO1_CIPHER_PASS"'),
        "secret appended to argv",
    )
    expect_postgres_contract_rejected(
        dockerfile,
        wrapper.replace("ambient_pgbackrest=$(env | LC_ALL=C sed -n", "ambient_pgbackrest=$(printf '' | LC_ALL=C sed -n"),
        "ambient pgBackRest override accepted",
    )
    expect_postgres_contract_rejected(
        dockerfile,
        wrapper.replace('[ "${MOMO_PGBACKREST_S3_VERIFY_TLS:-}" = y ]', ': # TLS verification removed'),
        "S3 TLS verification disabled",
    )
    expect_postgres_contract_rejected(
        dockerfile,
        wrapper.replace('read_secret s3-key-secret "$s3_key_secret_file" 32', ': # S3 secret file removed'),
        "S3 secret accepted without an owner-only file",
    )
    expect_postgres_contract_rejected(
        dockerfile,
        wrapper.replace('valid_dns_name "$endpoint"', ": # endpoint validation removed"),
        "unsafe S3 endpoint accepted",
    )


def validate_backup_compose(overlay: str, s3_overlay: str, s3_config: str) -> None:
    require(
        "${MOMO_POSTGRES_PGBACKREST_IMAGE:?" in overlay,
        "backup overlay must require the digest-only pgBackRest image variable",
    )
    require("archive_mode=on" in overlay, "continuous WAL archive mode must be enabled")
    require("archive_timeout=60s" in overlay, "archive timeout must remain bounded at 60 seconds")
    require(
        "archive_command=/usr/local/bin/oort-pgbackrest --stanza=momo archive-push %p" in overlay,
        "archive command must use the secret-file wrapper and exact stanza",
    )
    require("pgbackrest_repo:/var/lib/pgbackrest" in overlay, "repository must be a separate volume")
    require(
        "${COMPOSE_PROJECT_NAME:-momo-rust}-pgbackrest-repo" in overlay,
        "repository default must remain project scoped",
    )
    require("PGBACKREST_REPO1_CIPHER_PASS:" not in overlay, "raw cipher passphrase must not enter Compose env")
    require("MOMO_ENV: ${MOMO_MIGRATE_ENV:-production}" in overlay, "migrate policy environment must be explicit")
    require("MOMO_PITR_EVIDENCE_REQUIRED: ${MOMO_PITR_EVIDENCE_REQUIRED:-1}" in overlay, "backup migrate must default evidence-required")
    require("MOMO_PITR_BOOTSTRAP_EMPTY: ${MOMO_PITR_BOOTSTRAP_EMPTY:-0}" in overlay, "backup migrate must not default bootstrap")
    for expected in (
        "RUN_ID", "GIT_COMMIT", "COMPOSE_PROJECT", "SOURCE_VOLUME", "RESTORE_VOLUME",
        "REPO_VOLUME", "POSTGRES_IMAGE_DIGEST", "MIGRATE_IMAGE_DIGEST", "STANZA",
        "CIPHER_TYPE", "CIPHER_FINGERPRINT", "SYSTEM_IDENTIFIER",
    ):
        require(f"MOMO_PITR_EXPECT_{expected}:" in overlay, f"missing migrate binding {expected}")
    require("target: /run/momo-pitr/evidence.json" in overlay, "signed evidence mount drifted")
    require("target: /run/secrets/momo_pitr_hmac_key" in overlay, "HMAC key mount drifted")
    require(
        "${MOMO_PITR_MIGRATE_CIPHER_FILE:?" in overlay
        and "target: /run/secrets/pgbackrest_repo1_cipher_pass" in overlay,
        "migrate must receive its uid-10001 owner-only copy of the current repository cipher",
    )
    require(overlay.count("read_only: true") >= 3, "evidence, HMAC key and cipher must be read-only binds")

    require("MOMO_PGBACKREST_REPOSITORY: s3" in s3_overlay, "S3 mode must be explicit")
    require('MOMO_PGBACKREST_S3_VERIFY_TLS: "y"' in s3_overlay, "S3 TLS verification must be fixed on")
    require("MOMO_PGBACKREST_S3_URI_STYLE: path" in s3_overlay, "S3-compatible endpoint must use path style")
    require("/run/secrets/pgbackrest_repo1_s3_key" in s3_overlay, "S3 access key file mount missing")
    require("/run/secrets/pgbackrest_repo1_s3_key_secret" in s3_overlay, "S3 secret key file mount missing")
    require("PGBACKREST_REPO1_S3_KEY:" not in s3_overlay, "raw S3 access key must not enter Compose env")
    require("PGBACKREST_REPO1_S3_KEY_SECRET:" not in s3_overlay, "raw S3 secret key must not enter Compose env")
    require("repo1-type=s3" in s3_config, "S3 config must not fall back to POSIX")
    require("repo1-path=" not in s3_config, "S3 prefix comes from the fixed wrapper, not mutable config")


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
require("matrix:" not in workflow_text, "workflow must publish exactly the two contracted image subjects")
require(re.search(r"(?m)^\s+latest(?:\s|:)", workflow_text) is None, "workflow must not publish a latest tag")

dockerfile = read("server-rust/Dockerfile")
entrypoint = read("server-rust/docker-entrypoint.sh")
require("ARG MOMO_BUILD_SHA=unknown" in dockerfile, "Dockerfile needs an honest unstamped fallback")
require('org.opencontainers.image.revision="${MOMO_BUILD_SHA}"' in dockerfile, "runtime image must carry build SHA")
require('org.opencontainers.image.licenses="Apache-2.0"' in dockerfile, "runtime image must carry license metadata")
require("COPY LICENSE NOTICE /usr/share/licenses/momo-rust/" in dockerfile, "redistributed image must contain LICENSE and NOTICE")
require("COPY --from=web-build" in dockerfile, "published Rust image must include current web bundle")
require('grep -q "content=\\"${MOMO_BUILD_SHA}\\"" dist/index.html' in dockerfile, "web bundle must retain build stamp")
require(dockerfile.count("ENV MOMO_IN_CONTAINER=1") == 1, "runtime image must enable immutable SQL path policy")
for forbidden_path_env in (
    "MOMO_MIGRATIONS_DIR=", "MOMO_BOOTSTRAP_ROLES_SQL=",
    "MOMO_RUNTIME_ROLES_SQL=", "MOMO_SET_OWNER_SQL=",
    "MOMO_BOOTSTRAP_OWNER_SQL=",
):
    require(forbidden_path_env not in dockerfile, f"runtime image still exports mutable path {forbidden_path_env}")

postgres_dockerfile = read("infra/rust/postgres-pgbackrest/Dockerfile")
pgbackrest_wrapper = read("infra/rust/postgres-pgbackrest/oort-pgbackrest")
validate_postgres_dockerfile(postgres_dockerfile)
validate_pgbackrest_wrapper(pgbackrest_wrapper)
validate_postgres_mutations(postgres_dockerfile, pgbackrest_wrapper)
validate_backup_compose(
    read("infra/rust/docker-compose.backup.yml"),
    read("infra/rust/pgbackrest.s3.override.yml"),
    read("infra/rust/pgbackrest.s3.conf"),
)
wrapper_path = ROOT / "infra/rust/postgres-pgbackrest/oort-pgbackrest"
require(wrapper_path.stat().st_mode & 0o111 == 0o111, "pgBackRest wrapper must remain executable")
subprocess.run(["sh", "-n", str(wrapper_path)], check=True)

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
