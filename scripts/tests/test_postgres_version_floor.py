#!/usr/bin/env python3
"""SEC-06 (#4244) - PostgreSQL minor-version floor for the pgvector image pin.

RLS FORCE is the tenant boundary, so the database minor must not fall behind
the security-patch line. Floor: PostgreSQL 18.6 (server_version_num 180006).

Modes (each prints PASS/FAIL lines and exits non-zero on any FAIL):
  (default)    static: every `pgvector/pgvector:<tag>[@sha256:<digest>]`
               reference in tracked live files is one single tag and one single
               digest, and the tag is a `-pg18-trixie` tag. No network.
  --registry   additionally read the pinned digest's image config from the
               registry (`docker buildx imagetools inspect`, no container) and
               require PG_VERSION >= floor for every platform.
  --runtime    additionally start a throwaway container from the pin and
               require `SHOW server_version_num` >= floor (needs a Docker
               daemon; runs in the PR gate, not in the fast local check).
  --image-ref REF  override the ref used by --registry/--runtime (sabotage aid).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

FLOOR_NUM = 180006
REF_RE = re.compile(r"pgvector/pgvector:([A-Za-z0-9._-]+)(?:@sha256:([0-9a-f]{64}))?")
# Historical records, research logs and ADR prose describe past pins on purpose.
EXCLUDE_PREFIXES = ("claudedocs/", "docs/planning/", "docs/adr/", "research/", "docs/research/")
# Bench results are dated measurements, not pins.
EXCLUDE_PARTS = ("/bench/", "CHANGELOG.md", "STATUS.md")
SELF = "scripts/tests/test_postgres_version_floor.py"

failures: list[str] = []


def check(ok: bool, msg: str) -> None:
    print(("PASS: " if ok else "FAIL: ") + msg)
    if not ok:
        failures.append(msg)


def version_num(pg_version: str) -> int:
    """'18.6-1.pgdg13+2' -> 180006 (PG >= 10 has a two-part version)."""
    m = re.match(r"^(\d+)\.(\d+)", pg_version)
    if not m:
        raise ValueError(f"unparseable PostgreSQL version: {pg_version!r}")
    return int(m.group(1)) * 10000 + int(m.group(2))


def tracked_refs(root: Path) -> list[tuple[str, str, str | None]]:
    out = subprocess.run(
        ["git", "grep", "-nIE", r"pgvector/pgvector:[A-Za-z0-9._-]+", "--", "."],
        cwd=root, capture_output=True, text=True,
    ).stdout
    refs = []
    for line in out.splitlines():
        path = line.split(":", 1)[0]
        if path == SELF or path.startswith(EXCLUDE_PREFIXES) or any(p in "/" + path for p in EXCLUDE_PARTS):
            continue
        for m in REF_RE.finditer(line):
            refs.append((path, m.group(1), m.group(2)))
    return refs


def static_mode(root: Path) -> tuple[str, str] | None:
    refs = tracked_refs(root)
    check(len(refs) >= 15, f"found {len(refs)} live pgvector refs (expected the compose/Dockerfile/railway/verify pins)")
    pinned = {(t, d) for _, t, d in refs if d}
    check(len(pinned) == 1, f"exactly one digest-pinned (tag, digest) across live files: {sorted(pinned)}")
    # Bare `pg18` is the upstream moving tag (always the latest 18.x, so it can
    # only be at or above the floor); it appears in test comments and doc prose.
    # Every *versioned* tag must still be the one pinned tag.
    versioned = {t for _, t, _ in refs if re.match(r"^\d+\.\d+\.\d+-", t)}
    check(versioned == {t for t, _ in pinned}, f"every versioned pgvector tag equals the pinned tag (no stale 0.8.5 left): {sorted(versioned)}")
    check(all(t.endswith("-pg18-trixie") for t in versioned), "versioned tags are -pg18-trixie")
    return next(iter(pinned)) if len(pinned) == 1 else None


def registry_mode(ref: str) -> None:
    res = subprocess.run(
        ["docker", "buildx", "imagetools", "inspect", ref, "--format", "{{json .Image}}"],
        capture_output=True, text=True,
    )
    check(res.returncode == 0, f"registry inspect of {ref.split('@')[0]} succeeded")
    if res.returncode != 0:
        print(res.stderr.strip()[-300:])
        return
    images = json.loads(res.stdout)
    check(len(images) >= 2, f"image index carries >=2 platforms: {sorted(images)}")
    for plat, img in sorted(images.items()):
        envs = dict(e.split("=", 1) for e in img.get("config", {}).get("Env", []) if "=" in e)
        pgv = envs.get("PG_VERSION", "")
        num = version_num(pgv) if pgv else 0
        check(num >= FLOOR_NUM, f"{plat} PG_VERSION={pgv or '<missing>'} -> {num} >= {FLOOR_NUM}")


def runtime_mode(ref: str) -> None:
    name = f"pgfloor-4244-{int(time.time())}"
    run = subprocess.run(
        ["docker", "run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=floor", ref],
        capture_output=True, text=True,
    )
    check(run.returncode == 0, "throwaway container started")
    if run.returncode != 0:
        print(run.stderr.strip()[-300:])
        return
    try:
        num = ""
        for _ in range(60):
            q = subprocess.run(
                ["docker", "exec", name, "psql", "-U", "postgres", "-qAtc", "SHOW server_version_num"],
                capture_output=True, text=True,
            )
            if q.returncode == 0 and q.stdout.strip().isdigit():
                num = q.stdout.strip()
                break
            time.sleep(1)
        check(num.isdigit() and int(num) >= FLOOR_NUM, f"SHOW server_version_num={num or '<none>'} >= {FLOOR_NUM}")
    finally:
        subprocess.run(["docker", "stop", "-t", "2", name], capture_output=True)


def selftest() -> None:
    check(version_num("18.6-1.pgdg13+2") == 180006, "version_num('18.6-1.pgdg13+2') == 180006")
    check(version_num("18.4-1.pgdg13+1") < FLOOR_NUM, "18.4 is below the floor")
    check(version_num("18.10") > FLOOR_NUM, "18.10 compares numerically, not lexically")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry", action="store_true")
    ap.add_argument("--runtime", action="store_true")
    ap.add_argument("--image-ref")
    args = ap.parse_args()
    root = Path(__file__).resolve().parents[2]
    selftest()
    pin = static_mode(root)
    ref = args.image_ref or (f"pgvector/pgvector:{pin[0]}@sha256:{pin[1]}" if pin else None)
    if (args.registry or args.runtime) and ref is None:
        check(False, "no single pin to inspect")
    elif ref:
        if args.registry:
            registry_mode(ref)
        if args.runtime:
            runtime_mode(ref)
    print("RESULT:", "FAIL" if failures else "PASS")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
