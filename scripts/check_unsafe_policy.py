#!/usr/bin/env python3
"""SEC-08 (#4246) unsafe_code policy gate.

The compiler is the real enforcement: `[workspace.lints.rust] unsafe_code =
"forbid"` makes any `unsafe` in a member that inherits it a hard error, and
`forbid` (unlike `deny`) cannot be re-allowed with `#![allow(unsafe_code)]`.
What the compiler cannot see is a member that never opted in: a new crate whose
Cargo.toml has no `[lints] workspace = true` is silently unprotected. This gate
closes that hole by requiring every server-rust workspace member to be exactly
one of:

  * inherits the workspace lint (`[lints] workspace = true`), not allowlisted;
  * sets its own `[lints.rust] unsafe_code = "forbid"`, not allowlisted;
  * is listed in server-rust/unsafe-allowlist.tsv with a reason AND sets
    `unsafe_code = "allow"` itself.

Also red: workspace forbid missing, an allowlist row for a path that is not a
crate or has no reason, an allowlisted crate that does not actually allow
(stale row), an allowlisted-but-forbidding mismatch, and a non-allowlisted
crate that weakens the lint. The gate reads Cargo.toml only; it does not look
for the `unsafe` keyword (comments and strings would make that noisy).

Usage: scripts/check_unsafe_policy.py [--root DIR]
"""
import argparse
import glob
import os
import sys
import tomllib


def load(path):
    with open(path, "rb") as fh:
        return tomllib.load(fh)


def own_level(doc):
    """unsafe_code level a crate sets for itself, or None."""
    lint = doc.get("lints", {})
    rust = lint.get("rust", {}) if isinstance(lint.get("rust"), dict) else {}
    value = rust.get("unsafe_code")
    if isinstance(value, dict):
        value = value.get("level")
    return value


def inherits(doc):
    return doc.get("lints", {}).get("workspace") is True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.join(os.path.dirname(__file__), ".."))
    root = os.path.abspath(ap.parse_args().root)
    errors = []

    ws_path = os.path.join(root, "server-rust", "Cargo.toml")
    ws = load(ws_path)
    level = ws.get("workspace", {}).get("lints", {}).get("rust", {}).get("unsafe_code")
    if isinstance(level, dict):
        level = level.get("level")
    if level != "forbid":
        errors.append(f"server-rust/Cargo.toml: [workspace.lints.rust] unsafe_code must be \"forbid\" (found {level!r})")

    allow = {}
    tsv = os.path.join(root, "server-rust", "unsafe-allowlist.tsv")
    if not os.path.isfile(tsv):
        errors.append("server-rust/unsafe-allowlist.tsv is missing")
    else:
        with open(tsv, encoding="utf-8") as fh:
            for n, line in enumerate(fh, 1):
                line = line.rstrip("\n")
                if not line.strip() or line.lstrip().startswith("#"):
                    continue
                path, _, reason = line.partition("\t")
                if path in allow:
                    errors.append(f"unsafe-allowlist.tsv:{n}: duplicate row for {path}")
                if len(reason.strip()) < 20:
                    errors.append(f"unsafe-allowlist.tsv:{n}: {path} needs a real reason (why unsafe, why no safe replacement)")
                allow[path] = reason

    members = sorted(
        os.path.relpath(p, root)[: -len("/Cargo.toml")]
        for pat in ("crates", "bins")
        for p in glob.glob(os.path.join(root, "server-rust", pat, "*", "Cargo.toml"))
    )
    for path in allow:
        if not os.path.isfile(os.path.join(root, path, "Cargo.toml")):
            errors.append(f"unsafe-allowlist.tsv: {path} has no Cargo.toml (stale row)")

    for m in members:
        doc = load(os.path.join(root, m, "Cargo.toml"))
        own = own_level(doc)
        if m in allow:
            if own != "allow":
                errors.append(f"{m}: allowlisted but its Cargo.toml does not set [lints.rust] unsafe_code = \"allow\" (stale row, or lint still inherited)")
            if inherits(doc):
                errors.append(f"{m}: allowlisted crate must not also inherit [lints] workspace = true")
        else:
            if own is not None and own != "forbid":
                errors.append(f"{m}: sets unsafe_code = {own!r} but is not in unsafe-allowlist.tsv")
            elif own is None and not inherits(doc):
                errors.append(f"{m}: no [lints] workspace = true (new crates must inherit the unsafe_code forbid, or be allowlisted with a reason)")

    for path in allow:
        if path.startswith("server-rust/") and path not in members and os.path.isfile(os.path.join(root, path, "Cargo.toml")):
            errors.append(f"unsafe-allowlist.tsv: {path} is not a workspace member directory (crates/* or bins/*)")

    if errors:
        print("unsafe_code policy gate: RED")
        for e in errors:
            print("  - " + e)
        return 1
    print(f"unsafe_code policy gate: green ({len(members)} members, {len([m for m in members if m in allow])} allowlisted)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
