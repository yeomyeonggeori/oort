#!/usr/bin/env python3
"""Static MOMO-355 contract checks. Never opens a DB or network connection."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def require(text: str, *fragments: str) -> None:
    for fragment in fragments:
        assert fragment in text, f"missing contract fragment: {fragment}"


def require_id_only_inside_agent_seed_guard(text: str, identifier: str) -> None:
    guarded = False
    for line_number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if stripped == r"\if :MOMO_AGENT_SEED_ENABLED":
            guarded = True
            continue
        if stripped == r"\endif":
            guarded = False
            continue
        if identifier in line and not stripped.startswith("--"):
            assert guarded, f"{identifier} escaped agent seed guard at line {line_number}"


def main() -> None:
    migrate = read("scripts/migrate.sh")
    require(
        migrate,
        '${MOMO_AGENT_SEED_MODE:-none}',
        "demo|e2e)",
        "MOMO_AGENT_SEED_ENABLED=1",
        "--set=MOMO_AGENT_SEED_ENABLED=${MOMO_AGENT_SEED_ENABLED}",
    )

    seed_002 = read("server/Migrations/002_seed.sql")
    seed_006 = read("server/Migrations/006_local_hermes_agent_seed.sql")
    require(seed_002, r"\if :MOMO_AGENT_SEED_ENABLED", "00000000-0000-7000-8000-000000000102")
    require(seed_006, r"\if :MOMO_AGENT_SEED_ENABLED", "00000000-0000-7000-8000-000000000103")
    assert seed_002.count(r"\if :MOMO_AGENT_SEED_ENABLED") == 4
    assert seed_006.count(r"\if :MOMO_AGENT_SEED_ENABLED") == 1
    require_id_only_inside_agent_seed_guard(seed_002, "00000000-0000-7000-8000-000000000102")
    require_id_only_inside_agent_seed_guard(seed_006, "00000000-0000-7000-8000-000000000103")

    require(
        read("scripts/local_alpha_runner.sh"),
        'MOMO_AGENT_SEED_MODE=none sh "$REPO_ROOT/scripts/migrate.sh"',
    )
    require(read("infra/docker-compose.e2e.yml"), "MOMO_AGENT_SEED_MODE: e2e")
    require(read("infra/prod/docker-compose.internal-smoke.yml"), "MOMO_AGENT_SEED_MODE: e2e")

    isolated_verifiers = [
        "scripts/verify_agent_worker.sh",
        "scripts/verify_agent_context.sh",
        "scripts/verify_agent_live_channel.sh",
        "scripts/verify_external_agent_provider.sh",
        "scripts/verify_hermes_gateway_adapter.sh",
        "scripts/verify_macos_real_backend_ui.sh",
    ]
    for verifier in isolated_verifiers:
        require(read(verifier), 'MOMO_AGENT_SEED_MODE=none "$REPO_ROOT/scripts/migrate.sh"')

    # Every isolated verifier that uses the historical 101/102/103 identities
    # as actual FK owners must create both member kinds itself under seed-none.
    fixed_seed_member_fixtures = {
        "scripts/verify_agent_context.sh": (
            "('$HUMAN_ID', '$WORKSPACE_ID', 'human', 'active'",
            "('$AGENT_ID', '$WORKSPACE_ID', 'agent', 'active'",
        ),
        "scripts/verify_agent_live_channel.sh": (
            "('$HUMAN_ID', '$WORKSPACE_ID', 'human', 'active'",
            "('$AGENT_ID', '$WORKSPACE_ID', 'agent', 'active'",
        ),
        "scripts/verify_external_agent_provider.sh": (
            "('$HUMAN_ID', '$WORKSPACE_ID', 'human', 'active'",
            "('$AGENT_ID', '$WORKSPACE_ID', 'agent', 'active'",
        ),
        "scripts/verify_hermes_gateway_adapter.sh": (
            "('${HUMAN_MEMBER_ID}', '${WORKSPACE_ID}', 'human', 'active'",
            "('${AGENT_ID}', '${WORKSPACE_ID}', 'agent', 'active'",
        ),
        "scripts/verify_macos_real_backend_ui.sh": (
            "('${HUMAN_ID}', '${WORKSPACE_ID}', 'human', 'active'",
            "('${AGENT_ID}', '${WORKSPACE_ID}', 'agent', 'active'",
        ),
    }
    for verifier, member_rows in fixed_seed_member_fixtures.items():
        require(read(verifier), "INSERT INTO member", *member_rows)

    digest_verifiers = [
        "scripts/verify_agent_context.sh",
        "scripts/verify_agent_live_channel.sh",
        "scripts/verify_external_agent_provider.sh",
        "scripts/verify_hermes_gateway_adapter.sh",
        "scripts/verify_macos_real_backend_ui.sh",
    ]
    for verifier in digest_verifiers:
        require(
            read(verifier),
            "VERIFIER_DB_CREATED_OID",
            "SOURCE_DIGEST_BEFORE",
            "source_digest()",
            "exit 96",
        )

    agent_context = read("scripts/verify_agent_context.sh")
    require(
        agent_context,
        "seeding isolated workspace/member/channel fixtures + context history",
        "INSERT INTO workspace",
        "'Agent Context Hermes', 'hermes'",
        "INSERT INTO human",
        "INSERT INTO agent",
        "INSERT INTO channel",
        "INSERT INTO channel_seq",
        "INSERT INTO membership",
        "'$TARGET_CHANNEL', '$AGENT_ID', 'member', NULL",
    )

    agent_worker = read("scripts/verify_agent_worker.sh")
    require(
        agent_worker,
        'MOMO_AGENT_SEED_MODE=none "$REPO_ROOT/scripts/migrate.sh"',
        "VERIFIER_DB_MARKER_PREFIX=",
        "VERIFIER_DB_CREATED_OID",
        "exit 96",
        "TRANSPORT_CHANNEL_ID=$(printf '%s' \"$CHANNEL_ID\" | tr '[:lower:]' '[:upper:]')",
        "user-owned Hermes seed",
        "PRESERVED_HERMES_STATE_BEFORE",
        "INSERT INTO agent",
        "INSERT INTO membership",
    )

    macos = read("scripts/verify_macos_real_backend_ui.sh")
    require(
        macos,
        'MOMO_AGENT_SEED_MODE=none "$REPO_ROOT/scripts/migrate.sh"',
        "VERIFIER_DB_MARKER_PREFIX=",
        "VERIFIER_DB_CREATED_OID",
        "SOURCE_DIGEST_BEFORE",
        "exit 96",
        'CHANNEL_ID="$(python3 -c',
        "tr '[:lower:]' '[:upper:]'",
        "seeding isolated demo/Hermes and approval/cost fixtures",
    )

    cleanup = read("scripts/cleanup_dogfood_seed_agents.sh")
    require(
        cleanup,
        "expected --yes; refusing to connect",
        "seed identity collision; refusing cleanup",
        "status = 'deleted'",
        "seeded-hermes-retired",
        "revoked_at = COALESCE(revoked_at, now())",
    )
    print("agent seed policy contract: PASS")


if __name__ == "__main__":
    main()
