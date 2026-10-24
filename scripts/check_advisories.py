#!/usr/bin/env python3
"""Dependency advisory gate (#4243, SEC-05).

One entry point for CI (`advisories` lane in .github/workflows/pr-ci.yml) and for a
developer machine. It fails closed: a missing tool, a tool error, or a scan that
silently covered fewer lockfiles than asked is a FAIL, never a green.

Steps (each prints PASS/FAIL, the exit code is 1 if any selected step failed):

  ledger  deny.toml [advisories].ignore and osv-scanner.toml [[IgnoredVulns]]: every
          exception needs a reason and an expiry (deny.toml: `expires=YYYY-MM-DD` inside
          the reason; osv-scanner.toml: `ignoreUntil`). The date is the FIRST RED DAY.
          Expired, undated, or more than 180 days out is a FAIL. This runs on the dates
          themselves, so a stale exception is red even when the advisory has since gone.
  cargo   `cargo deny check advisories` for server-rust, and for the desktop shell on
          the macOS targets it ships (tauri.conf.json bundle targets: app, dmg).
  npm     `npm audit --omit=dev --audit-level=high` for the workspace root (packages/
          momo-core) and clients/web. clients/mobile is judged by OSV only: Expo and RN
          file their build tools under `dependencies`, so `--omit=dev` cannot separate
          the app bundle from the build machine (see osv-scanner.toml).
  osv     osv-scanner over the five lockfiles. A crates.io finding that has a RUSTSEC id
          is judged by `cargo deny` (real graph, features and targets) and only counted
          here; everything else, including GHSA-only Rust advisories, is judged here.

Usage: scripts/check_advisories.py [--only ledger,cargo,npm,osv] [--today YYYY-MM-DD]
       [--list] [--root DIR] [--deny-config F] [--osv-config F]
       [--cargo-workspace DIR[=TRIPLE,TRIPLE]]... [--npm-tree DIR]... [--osv-lockfile F]...
The repeatable options replace the defaults (the fixtures in scripts/tests use them).
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import subprocess
import sys
import tempfile
import time
import tomllib
from pathlib import Path

MAX_HORIZON_DAYS = 180
WARN_DAYS = 14
EXPIRES_RE = re.compile(r"\bexpires=(\d{4}-\d{2}-\d{2})\b")
TRANSIENT_RE = re.compile(
    r"failed to (fetch|clone)|error sending request|timed out|timeout|Could not resolve|"
    r"Connection (reset|refused)|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|temporary failure",
    re.I,
)

DEFAULT_CARGO = [
    ("server-rust", []),
    ("clients/desktop/src-tauri", ["aarch64-apple-darwin", "x86_64-apple-darwin"]),
]
DEFAULT_NPM = [".", "clients/web"]
DEFAULT_OSV = [
    "server-rust/Cargo.lock",
    "clients/desktop/src-tauri/Cargo.lock",
    "package-lock.json",
    "clients/web/package-lock.json",
    "clients/mobile/package-lock.json",
]


def today_utc() -> dt.date:
    return dt.datetime.now(dt.timezone.utc).date()


def as_date(value) -> dt.date | None:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str):
        try:
            return dt.date.fromisoformat(value)
        except ValueError:
            return None
    return None


def judge_date(label: str, day: dt.date | None, today: dt.date, problems: list[str]) -> None:
    if day is None:
        problems.append(f"{label}: expiry missing or not a YYYY-MM-DD date")
    elif day <= today:
        problems.append(f"{label}: EXPIRED {day} (today {today}); fix it, remove it, or renew it by a reviewed policy change")
    elif (day - today).days > MAX_HORIZON_DAYS:
        problems.append(f"{label}: expires {day}, more than {MAX_HORIZON_DAYS} days out")


def ledger(deny_path: Path, osv_path: Path, today: dt.date) -> tuple[list[tuple], list[str]]:
    """Return (rows, problems). A row is (file, id, expiry-or-None, reason)."""
    rows: list[tuple] = []
    problems: list[str] = []
    seen: set[tuple[str, str]] = set()

    def add(src: str, ident: str, day, reason) -> None:
        label = f"{src} {ident}"
        if (src, ident) in seen:
            problems.append(f"{label}: listed twice")
        seen.add((src, ident))
        if not isinstance(reason, str) or len(EXPIRES_RE.sub("", reason).strip()) < 20:
            problems.append(f"{label}: needs a real reason (at least 20 characters besides the date)")
        judge_date(label, day, today, problems)
        rows.append((src, ident, day, reason if isinstance(reason, str) else ""))

    deny = tomllib.loads(deny_path.read_text(encoding="utf-8")) if deny_path.is_file() else {}
    if not deny_path.is_file():
        problems.append(f"missing {deny_path}")
    for item in deny.get("advisories", {}).get("ignore", []):
        if isinstance(item, str):
            problems.append(f"deny.toml {item}: bare string has no reason or expiry")
            continue
        ident = item.get("id") or item.get("crate") or "?"
        reason = item.get("reason")
        match = EXPIRES_RE.search(reason) if isinstance(reason, str) else None
        add("deny.toml", ident, as_date(match.group(1)) if match else None, reason)

    osv = tomllib.loads(osv_path.read_text(encoding="utf-8")) if osv_path.is_file() else {}
    if not osv_path.is_file():
        problems.append(f"missing {osv_path}")
    for item in osv.get("IgnoredVulns", []):
        add("osv-scanner.toml", item.get("id", "?"), as_date(item.get("ignoreUntil")), item.get("reason"))
    for item in osv.get("PackageOverrides", []):
        if item.get("ignore"):
            problems.append(
                f"osv-scanner.toml PackageOverrides {item.get('name') or item.get('group') or '?'}: "
                "a package-wide ignore also hides future advisories; use [[IgnoredVulns]] by id"
            )
    return rows, problems


def run(cmd, cwd, timeout, retries=1):
    """Run a command, retrying once on a network-looking failure. Returns (rc, output)."""
    out = ""
    for attempt in range(retries + 1):
        try:
            p = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, timeout=timeout)
            rc, out = p.returncode, (p.stdout or "") + (p.stderr or "")
        except subprocess.TimeoutExpired:
            rc, out = 124, f"timed out after {timeout}s: {' '.join(map(str, cmd))}"
        if rc == 0 or attempt == retries or not TRANSIENT_RE.search(out):
            return rc, out
        time.sleep(5)
    return rc, out


def have(*cmd) -> bool:
    try:
        return subprocess.run(list(cmd), capture_output=True, timeout=60).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def summarize_cargo(out: str) -> list[str]:
    lines = []
    title = ""
    for line in out.splitlines():
        m = re.match(r"^(error|warning)\[([a-z-]+)\]: (.*)", line)
        if m:
            title = f"{m.group(2)}: {m.group(3)}" if m.group(1) == "error" else ""
        m = re.search(r"ID: (\S+)", line)
        if m and title:
            lines.append(f"    {m.group(1)}  {title}")
            title = ""
        elif re.match(r"^error(\[|:)", line) and "advisor" not in line and not m:
            lines.append(f"    {line.strip()}")
    return lines[:40]


def step_cargo(root: Path, deny_config: Path, workspaces) -> bool:
    if not have("cargo", "deny", "--version"):
        print("  FAIL: cargo-deny is not installed (cargo install --locked cargo-deny@0.20.2). "
              "The gate is fail-closed: a missing scanner is not a pass.")
        return False
    print(f"  {subprocess.run(['cargo', 'deny', '--version'], capture_output=True, text=True).stdout.strip()}")
    ok = True
    for ws, targets in workspaces:
        manifest = root / ws / "Cargo.toml"
        if not manifest.is_file():
            print(f"  FAIL: missing {manifest}")
            ok = False
            continue
        for target in targets or [None]:
            cmd = ["cargo", "deny", "--locked", "--manifest-path", str(manifest), "--config", str(deny_config)]
            if target:
                cmd += ["--target", target]
            cmd += ["check", "advisories"]
            rc, out = run(cmd, root, timeout=1200)
            label = f"{ws}" + (f" [{target}]" if target else "")
            if rc == 0:
                print(f"  PASS {label}")
            else:
                ok = False
                print(f"  FAIL {label} (cargo deny exit {rc})")
                detail = summarize_cargo(out) or [f"    {l}" for l in out.strip().splitlines()[-6:]]
                print("\n".join(detail))
    return ok


def step_npm(root: Path, trees) -> bool:
    if not have("npm", "--version"):
        print("  FAIL: npm is not installed")
        return False
    ok = True
    for tree in trees:
        cwd = root / tree
        if not (cwd / "package-lock.json").is_file():
            print(f"  FAIL: missing {cwd / 'package-lock.json'}")
            ok = False
            continue
        rc, out = run(["npm", "audit", "--package-lock-only", "--omit=dev", "--audit-level=high"], cwd, timeout=300)
        if rc == 0:
            print(f"  PASS {tree} (npm audit --omit=dev --audit-level=high)")
        else:
            ok = False
            print(f"  FAIL {tree} (npm audit exit {rc})")
            print("\n".join(f"    {l}" for l in out.strip().splitlines()[:30]))
    return ok


def step_osv(root: Path, osv_config: Path, lockfiles) -> bool:
    import json

    if not have("osv-scanner", "--version"):
        print("  FAIL: osv-scanner is not installed (https://google.github.io/osv-scanner/installation/, pinned v2.7.0)")
        return False
    for lock in lockfiles:
        if not (root / lock).is_file():
            print(f"  FAIL: missing lockfile {root / lock}")
            return False
    with tempfile.TemporaryDirectory(prefix="oort-osv-") as tmp:
        result = Path(tmp) / "osv.json"
        cmd = ["osv-scanner", "scan", "source", "--config", str(osv_config), "--format", "json",
               "--output-file", str(result)]
        for lock in lockfiles:
            cmd += ["-L", lock]
        rc, out = run(cmd, root, timeout=600)
        if rc not in (0, 1) or not result.is_file():
            print(f"  FAIL: osv-scanner error (exit {rc})")
            print("\n".join(f"    {l}" for l in out.strip().splitlines()[-8:]))
            return False
        scanned = re.findall(r"^Scanned (.+?) file and found (\d+) packages?", out, re.M)
        if len(scanned) != len(lockfiles):
            print(f"  FAIL: scan covered {len(scanned)} lockfiles, expected {len(lockfiles)} (a blind scan is not a pass)")
            return False
        data = json.loads(result.read_text(encoding="utf-8") or "{}")
    findings, delegated = [], 0
    for res in data.get("results", []):
        src = Path(res["source"]["path"])
        try:
            src = src.relative_to(root.resolve())
        except ValueError:
            pass
        for pkg in res.get("packages", []):
            name = f"{pkg['package']['name']}@{pkg['package']['version']}"
            for group in pkg.get("groups", []):
                ids = set(group.get("ids", [])) | set(group.get("aliases", []))
                if pkg["package"]["ecosystem"] == "crates.io" and any(i.startswith("RUSTSEC-") for i in ids):
                    delegated += 1
                else:
                    findings.append(f"    {src}  {name}  {', '.join(sorted(group.get('ids', [])))}")
    print(f"  scanned {len(scanned)} lockfiles; {delegated} RUSTSEC findings judged by cargo deny")
    if findings:
        print(f"  FAIL: {len(findings)} advisories not covered by a dated exception")
        print("\n".join(sorted(set(findings))))
        return False
    print("  PASS")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--only", default="ledger,cargo,npm,osv")
    ap.add_argument("--today")
    ap.add_argument("--list", action="store_true", help="print the exception ledger as a markdown table")
    ap.add_argument("--root", default=None)
    ap.add_argument("--deny-config")
    ap.add_argument("--osv-config")
    ap.add_argument("--cargo-workspace", action="append")
    ap.add_argument("--npm-tree", action="append")
    ap.add_argument("--osv-lockfile", action="append")
    args = ap.parse_args()

    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parent.parent
    deny_config = Path(args.deny_config).resolve() if args.deny_config else root / "deny.toml"
    osv_config = Path(args.osv_config).resolve() if args.osv_config else root / "osv-scanner.toml"
    today = dt.date.fromisoformat(args.today) if args.today else today_utc()
    workspaces = DEFAULT_CARGO
    if args.cargo_workspace:
        workspaces = [(w.split("=")[0], [t for t in w.partition("=")[2].split(",") if t]) for w in args.cargo_workspace]
    trees = args.npm_tree or DEFAULT_NPM
    lockfiles = args.osv_lockfile or DEFAULT_OSV

    rows, problems = ledger(deny_config, osv_config, today)
    if args.list:
        print("| 파일 | id | 만료(첫 빨강 날) | 남은 일 | 이유 |\n|---|---|---|---|---|")
        for src, ident, day, reason in sorted(rows, key=lambda r: (str(r[2]), r[1])):
            left = (day - today).days if day else "?"
            print(f"| {src} | {ident} | {day} | {left} | {reason.strip()[:140].replace('|', '/')} |")
        return 0

    selected = [s.strip() for s in args.only.split(",") if s.strip()]
    unknown = set(selected) - {"ledger", "cargo", "npm", "osv"}
    if unknown:
        print(f"unknown step(s): {', '.join(sorted(unknown))}", file=sys.stderr)
        return 2

    results: dict[str, bool] = {}
    for name in selected:
        print(f"==> {name}")
        if name == "ledger":
            soon = [r for r in rows if r[2] and 0 < (r[2] - today).days <= WARN_DAYS]
            for src, ident, day, _ in soon:
                print(f"  NOTE: {src} {ident} reaches its first red day {day} within {WARN_DAYS} days")
            for p in problems:
                print(f"  FAIL: {p}")
            print(f"  {len(rows)} exceptions, {'PASS' if not problems else str(len(problems)) + ' problem(s)'}")
            results[name] = not problems
        elif name == "cargo":
            results[name] = step_cargo(root, deny_config, workspaces)
        elif name == "npm":
            results[name] = step_npm(root, trees)
        else:
            results[name] = step_osv(root, osv_config, lockfiles)
    print("==> summary: " + "  ".join(f"{k}={'PASS' if v else 'FAIL'}" for k, v in results.items()))
    if all(results.values()):
        print("ADVISORY GATE PASS")
        return 0
    print("ADVISORY GATE FAIL", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
