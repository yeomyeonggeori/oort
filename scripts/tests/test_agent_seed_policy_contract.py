#!/usr/bin/env python3
"""Static seed-policy contract checks. Never opens a DB or network connection."""

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

    seed_012 = read("server/Migrations/012_prod_seed_password_fail_closed.sql")
    require(
        seed_012,
        r"\if :MOMO_AGENT_SEED_ENABLED",
        "momo_password_hash('dev-password')",
        "SET password_hash = NULL",
        "momo_password_verify('dev-password', password_hash)",
        "00000000-0000-7000-8000-000000000101",
    )
    require(
        read("scripts/local_gate.sh"),
        "scripts/verify_rls.sh",
        "RLS runtime verification",
    )

    require(
        read("scripts/local_alpha_runner.sh"),
        'MOMO_AGENT_SEED_MODE=none sh "$REPO_ROOT/scripts/migrate.sh"',
    )
    rust_compose = read("infra/rust/docker-compose.rust.yml")
    require(rust_compose, "MOMO_AGENT_SEED_MODE")
    require(rust_compose, "${MOMO_AGENT_SEED_MODE:-none}")

    isolated_verifiers = [
        "scripts/verify_hermes_gateway_adapter.sh",
    ]
    for verifier in isolated_verifiers:
        require(read(verifier), 'MOMO_AGENT_SEED_MODE=none "$REPO_ROOT/scripts/migrate.sh"')

    fixed_seed_member_fixtures = {
        "scripts/verify_hermes_gateway_adapter.sh": (
            "('${HUMAN_MEMBER_ID}', '${WORKSPACE_ID}', 'human', 'active'",
            "('${AGENT_ID}', '${WORKSPACE_ID}', 'agent', 'active'",
        ),
    }
    for verifier, member_rows in fixed_seed_member_fixtures.items():
        require(read(verifier), "INSERT INTO member", *member_rows)

    digest_verifiers = [
        "scripts/verify_hermes_gateway_adapter.sh",
    ]
    for verifier in digest_verifiers:
        require(
            read(verifier),
            "VERIFIER_DB_CREATED_OID",
            "SOURCE_DIGEST_BEFORE",
            "source_digest()",
            "exit 96",
        )

    # LS-1 (#2165) retired the Swift-host isolated verifiers (agent_worker /
    # agent_context / agent_live_channel / external_agent_provider). Seed-none
    # + marker/OID + source-digest stays on the remaining Rust-host verifier.

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
