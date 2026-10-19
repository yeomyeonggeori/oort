#!/usr/bin/env python3
"""Print repo-relative files that Rust sources read from outside their cargo lane.

Companion to test_pr_ci_guardrails.sh (#4055). The pr-ci `changes` job decides
`rust=true` from changed paths, so every file a Rust test or build reads from
OUTSIDE `server-rust/` and `clients/desktop/src-tauri/` has to be in that
filter, otherwise a PR touching only that file skips cargo and goes red on base.

Two kinds of reference are extracted from every `.rs` file in the two roots:
  * `include_str!` / `include_bytes!` / `include!` with a string literal,
    resolved against the including file's directory (rustc semantics);
  * string literals in a statement that mentions `CARGO_MANIFEST_DIR`
    (`concat!`, `format!`, `.join(..)`), resolved against the crate root
    (the nearest ancestor with a Cargo.toml). This over-approximates; only
    candidates that exist in the repository and lie outside both roots count.
  * in a file that mentions `CARGO_MANIFEST_DIR`, any string literal that starts
    with a top-level repo directory (`repo_root().join("packages/...")`, a path
    passed to a `read(..)` helper, `root.pop(); root.join("infra")`, ...), resolved
    against the repo root. Without this the first two rules miss paths that are
    built over several statements.
A directory target (for example `server/Migrations/`) is printed with a
trailing `/` so the caller can decide how to probe it.

Output: one repo-relative path per line, sorted, unique.
"""
import os
import re
import sys

ROOTS = ("server-rust", "clients/desktop/src-tauri")
SKIP_DIRS = {"target", "node_modules", ".git"}
TOP_LEVEL = (
    "clients", "packages", "docs", "infra", "server", "scripts", "legal",
)
INCLUDE = re.compile(r'\binclude_(?:str|bytes)?!\s*\(\s*"([^"\\]+)"\s*\)')
LITERAL = re.compile(r'"((?:[^"\\]|\\.)*)"')


TOKEN = re.compile(
    r"//[^\n]*"  # line comment (also ///, //!)
    r"|/\*.*?\*/"  # block comment
    r'|\br(#*)".*?"\1'  # raw string
    r'|"(?:[^"\\]|\\.)*"'  # string
    r"|'(?:\\.|[^'\\])'",  # char literal such as '"'
    re.S,
)


def strip_comments(text):
    """Blank out comments so quotes inside them cannot unbalance literals."""

    def keep(match):
        token = match.group(0)
        return " " if token.startswith(("//", "/*")) else token

    return TOKEN.sub(keep, text)


def string_literals(text):
    """String literal bodies of cleaned source, skipping char literals like '"'."""
    for match in TOKEN.finditer(text):
        token = match.group(0)
        if token.startswith('"'):
            yield token[1:-1]


def crate_root(repo, file_dir):
    cur = file_dir
    while True:
        if os.path.isfile(os.path.join(cur, "Cargo.toml")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur or not cur.startswith(repo):
            return file_dir
        cur = parent


def inside_roots(rel):
    return any(rel == r or rel.startswith(r + "/") for r in ROOTS)


def main():
    repo = os.path.abspath(sys.argv[1])
    found = set()

    def consider(abs_path):
        abs_path = os.path.normpath(abs_path)
        if not abs_path.startswith(repo + os.sep):
            return
        rel = os.path.relpath(abs_path, repo)
        if inside_roots(rel) or not os.path.exists(abs_path):
            return
        found.add(rel + ("/" if os.path.isdir(abs_path) else ""))

    for root in ROOTS:
        for dirpath, dirnames, filenames in os.walk(os.path.join(repo, root)):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                if not name.endswith(".rs"):
                    continue
                path = os.path.join(dirpath, name)
                with open(path, encoding="utf-8", errors="replace") as handle:
                    text = strip_comments(handle.read())
                for match in INCLUDE.finditer(text):
                    consider(os.path.join(dirpath, match.group(1)))
                if "CARGO_MANIFEST_DIR" not in text:
                    continue
                manifest = crate_root(repo, dirpath)
                for lit in string_literals(text):
                    head = lit.split("/", 1)[0]
                    if "/" in lit and head in TOP_LEVEL:
                        consider(os.path.join(repo, lit))
                for match in re.finditer(r"CARGO_MANIFEST_DIR", text):
                    # +1 skips the closing quote of the "CARGO_MANIFEST_DIR" literal itself
                    statement = text[match.end() + 1:].split(";", 1)[0][:600]
                    for lit in LITERAL.findall(statement):
                        # strip format placeholders such as "{}/../x"
                        lit = re.sub(r"^\{[^}]*\}", "", lit).lstrip("/")
                        if lit and ("/" in lit or lit.startswith("..")):
                            consider(os.path.join(manifest, lit))
    for item in sorted(found):
        print(item)


if __name__ == "__main__":
    main()
