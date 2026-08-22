#!/usr/bin/env python3
"""#1525 — every command an operating document tells a reader to run must still
resolve against this tree.

The incident this generalizes is #1472. `AGENTS.md` §3 is labelled "copy-paste,
그대로 실행", and for weeks it carried `cargo fmt --check --manifest-path
server-rust/Cargo.toml`. Both cargo manifests here are virtual workspaces, so
that form prints "Failed to find targets" and checks nothing. Three workers
(#1454, #1442, #1467) ran it, believed the green, and each independently
rediscovered the same rustfmt drift underneath it. #1472 fixed that one command
and put the *executable* form in the gate; nothing yet checks that the
*documented* form stays true, which is the half that misled the workers.

So this is a drift gate on documents, not on code. It never runs a documented
command — the ones in these files create git worktrees, push branches, start
Docker stacks and mutate GitHub state, so "just run it" is not on offer. What it
does instead is resolve every command against the tree that has to answer it:

  * the executor exists, is executable, and parses (`bash -n` / `py_compile`)
  * `make <target>` names a target the Makefile actually defines
  * `--profile <p>` names a profile `local_gate.sh`'s own parser accepts
  * `npm [--prefix DIR] run <script>` names a script that package.json defines
  * every long flag handed to one of our scripts appears in that script
  * `-f` / `--env-file` paths handed to docker compose exist
  * a documented `cargo fmt` check carries `--all` (the #1472 rule itself)

Each of those is a fact a reader would only discover by running the command and
watching it fail — or worse, watching it succeed at nothing.

Two design notes worth keeping:

  * Unrecognized tokens are ignored, not guessed at. These documents mix real
    commands with diagrams, prose and placeholders, and a gate that flagged
    `<workspace-id>` would be turned off within a week. Every rule below fires
    only on a shape it can decide, and skips any token carrying a placeholder
    marker. The cost of that choice is silent under-coverage, which the
    coverage check at the bottom is there to bound.
  * The gated set is a table with reasons, plus globs. Adding a runbook gates
    it automatically; adding a top-level operating document is a deliberate row.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import py_compile
import re
import shlex
import subprocess
import sys
import tempfile

# -----------------------------------------------------------------------------
# The gated set. One row per document whose commands a reader is expected to
# execute verbatim. Documents that merely *mention* commands in passing are not
# here on purpose — see the module docstring on under-coverage.
# -----------------------------------------------------------------------------
GATED_DOCS = [
    (
        "AGENTS.md",
        "Codex 운영 계약. §3이 스스로 'copy-paste, 그대로 실행'이라고 선언한다 — "
        "#1472에서 워커 3기를 오도한 명령이 살던 자리다.",
    ),
    (
        "CODEX.md",
        "AGENTS.md 머리말이 '핵심 내용은 CODEX.md와 동일'이라고 선언한 쌍둥이. "
        "한쪽만 게이트하면 같은 드리프트가 게이트 없는 쪽으로 되돌아온다 "
        "(#1472의 깨진 fmt 명령도 두 파일에 같이 있었다).",
    ),
    (
        "docs/RUN.md",
        "로컬 기동 가이드. 은퇴 중인 Swift 장을 포함하지만 2~4장은 현행 유효라고 "
        "문서 스스로 못박고 있어, 여기 적힌 명령은 지금도 실행된다.",
    ),
    (
        "docs/RELEASING.md",
        "서버/이미지 릴리스 절차 정본. 스스로 '이 문서 하나로 서버 이미지 릴리스를 "
        "완주한다'고 선언한다 — workflow dispatch, attestation verify, "
        "self_host_env --published-image.",
    ),
    (
        "docs/NEXT_CHANNEL.md",
        "데스크탑 Tauri next 채널 발행 정본. publish_next_build.sh 를 그대로 "
        "실행하는 운영 문서다.",
    ),
    (
        "CONTRIBUTING.md",
        "기여자 운영 문서. local_gate --profile secrets/license, "
        "generate_ghcr_notice_bundle, verify_policy_integrity_from_base 를 "
        "실행 지시로 싣는다.",
    ),
    (
        "docs/SELF_HOST_AGENT.md",
        "그록봇 셀프호스트 플레이북(#1652). 스스로 '이 문서가 제품이다'고 "
        "선언하고 curl/docker 명령을 그대로 실행한다.",
    ),
]

# Every runbook is gated by construction: a runbook is by definition a document
# someone follows command by command, and a new one must not arrive ungated.
GATED_GLOBS = ["docs/runbooks/*.md"]

# Fence info strings that mean "this block is shell". A bare fence counts: RUN.md
# §1 uses one for its bring-up sequence, and those `make` targets are real.
SHELL_INFO = {"", "sh", "bash", "shell", "zsh", "console", "shell-session"}

# A token carrying any of these is a placeholder, an expansion or a glob — the
# document is not claiming it resolves, so neither do we.
PLACEHOLDER_MARKERS = ("<", ">", "${", "$(", "…", "*", "?", "[", "..", "|")

# Shell operators that end one command and begin another.
SEPARATORS = {"&&", "||", ";", "|", "&", "|&"}

# Command words that prefix another command rather than being one.
COMMAND_PREFIXES = {"sudo", "time", "exec", "nohup", "command", "env"}

# Extensionless executors count: `scripts/momo` is one, and it is the entry
# point RUN.md hands a first-time reader.
SCRIPT_RE = re.compile(r"^\.?/?(scripts/[A-Za-z0-9_./-]+)$")

# Data and prose living under scripts/. A span naming one of these is a pointer
# to something to read, never a program to run.
NON_EXECUTABLE_EXT = (
    ".md",
    ".json",
    ".yaml",
    ".yml",
    ".sql",
    ".toml",
    ".txt",
    ".example",
    ".lock",
    ".png",
    ".apns",
)
ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
IDENT_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_:.-]*$")

# An escape hatch with a mandatory reason, on the NON_COMPOSE_ENV_TEMPLATES
# precedent (#1250). A document sometimes has to *name* a command in order to
# say it is abolished, or to quote one that only resolves on a deploy host. The
# alternative to this marker is not a cleaner gate — it is someone deleting the
# gate, so the hatch exists, but it costs a written reason every time.
IGNORE_MARKER = "docs-cmd-ignore:"


# How many facts this run actually decided. Reported instead of "commands
# scanned", which would be a flattering number: most inline spans in these
# documents are identifiers and paths that no rule can or should judge, and a
# gate that reports its own coverage as 2600 when it decided 300 things is
# lying about how much it covers.
ASSERTIONS = [0]


def decided(n: int = 1) -> None:
    ASSERTIONS[0] += n


def is_ignored(line: str) -> bool:
    """True only for a marker that carries a reason. `<!-- docs-cmd-ignore: -->`
    is not a marker: the whole point of the hatch is that opting out costs a
    sentence somebody else can read and disagree with."""
    at = line.find(IGNORE_MARKER)
    if at < 0:
        return False
    reason = line[at + len(IGNORE_MARKER) :].strip()
    if reason.endswith("-->"):
        reason = reason[:-3].strip()
    return bool(reason)


class Finding:
    def __init__(self, doc: str, line: int, command: str, reason: str, fix: str = ""):
        self.doc = doc
        self.line = line
        self.command = command
        self.reason = reason
        self.fix = fix

    def render(self) -> str:
        out = [f"{self.doc}:{self.line}: {self.reason}", f"    command: {self.command}"]
        if self.fix:
            out.append(f"    fix: {self.fix}")
        return "\n".join(out)


# =============================================================================
# Extraction
# =============================================================================
def extract_commands(path: str, text: str):
    """Yield (lineno, command_string) for everything the document presents as a
    command: shell fenced blocks, and inline code spans in prose and tables.

    Line continuations are joined so a wrapped command is judged whole. The
    reported line number is always the line the command starts on, which is
    where a reader would go to fix it.
    """
    lines = text.splitlines()
    in_fence = False
    fence_marker = ""
    fence_is_shell = False
    skip_next = False
    pending: list[str] = []
    pending_line = 0

    def flush():
        nonlocal pending, pending_line
        if pending:
            yielded = (pending_line, " ".join(pending))
            pending = []
            return yielded
        return None

    for idx, raw in enumerate(lines, start=1):
        stripped = raw.strip()
        # Fences may be indented (list items) or quoted (`> ```sh`).
        fence_body = stripped[2:].strip() if stripped.startswith("> ") else stripped
        fence = re.match(r"^(```+|~~~+)(.*)$", fence_body)
        if fence:
            marker, info = fence.group(1), fence.group(2).strip()
            if not in_fence:
                in_fence = True
                fence_marker = marker[:3]
                fence_is_shell = info.split()[0].lower() if info else ""
                fence_is_shell = fence_is_shell in SHELL_INFO
            elif marker.startswith(fence_marker):
                done = flush()
                if done:
                    yield done
                in_fence = False
                fence_is_shell = False
            continue

        if in_fence:
            if not fence_is_shell:
                continue
            body = fence_body
            if not body or body.startswith("#"):
                if body.startswith("#") and is_ignored(body):
                    skip_next = True
                done = flush()
                if done:
                    yield done
                continue
            if skip_next:
                # Stays armed across a `\`-continued command so the marker
                # covers the whole thing, not just its first line.
                skip_next = body.endswith("\\")
                continue
            if body.startswith("$ "):
                body = body[2:]
            if body.endswith("\\"):
                if not pending:
                    pending_line = idx
                pending.append(body[:-1].strip())
                continue
            if pending:
                pending.append(body)
                done = flush()
                if done:
                    yield done
            else:
                yield (idx, body)
            continue

        # Outside fences: inline code spans, which is how the tables carry
        # commands ("| 확인 | `docker compose version` |").
        if is_ignored(raw):
            continue
        for span in re.findall(r"`([^`\n]+)`", raw):
            span = span.strip()
            if span.startswith("$ "):
                span = span[2:]
            if span:
                yield (idx, span)

    done = flush()
    if done:
        yield done


def split_pipeline(tokens):
    """Split a token list on shell operators into individual commands."""
    current: list[str] = []
    for tok in tokens:
        if tok in SEPARATORS:
            if current:
                yield current
            current = []
        else:
            current.append(tok)
    if current:
        yield current


def tokenize(command: str):
    try:
        return shlex.split(command, comments=True)
    except ValueError:
        # Unbalanced quotes — prose that merely looks like a command.
        return []


def has_placeholder(token: str) -> bool:
    return any(marker in token for marker in PLACEHOLDER_MARKERS)


# =============================================================================
# Tree facts the rules resolve against. Each is read from the artefact that
# owns it, never restated here — a hardcoded copy would be the same class of
# drift this script exists to catch.
# =============================================================================
class Tree:
    def __init__(self, root: str):
        self.root = root
        self._npm_scripts: dict[str, set] = {}

    def path(self, rel: str) -> str:
        return os.path.join(self.root, rel)

    def exists(self, rel: str) -> bool:
        return os.path.exists(self.path(rel))

    def read(self, rel: str) -> str:
        try:
            with open(self.path(rel), encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            return ""

    def make_targets(self) -> set:
        targets = set()
        for line in self.read("Makefile").splitlines():
            m = re.match(r"^([A-Za-z0-9_.-]+)[ \t]*:(?!=)", line)
            if m:
                targets.add(m.group(1))
        return targets

    def gate_profiles(self) -> set:
        """Read local_gate.sh's own accepted-profile alternation. Restating the
        list here would let the two drift, which is the whole disease."""
        source = self.read("scripts/local_gate.sh")
        best: set = set()
        for m in re.finditer(r"^[ \t]*([a-z0-9][a-z0-9|-]*\|all)\)", source, re.M):
            candidate = set(m.group(1).split("|"))
            if len(candidate) > len(best):
                best = candidate
        return best

    def npm_scripts(self, prefix: str) -> set:
        if prefix in self._npm_scripts:
            return self._npm_scripts[prefix]
        rel = os.path.join(prefix, "package.json") if prefix else "package.json"
        scripts: set = set()
        raw = self.read(rel)
        if raw:
            try:
                scripts = set(json.loads(raw).get("scripts", {}))
            except json.JSONDecodeError:
                scripts = set()
        self._npm_scripts[prefix] = scripts
        return scripts

    def has_package_json(self, prefix: str) -> bool:
        rel = os.path.join(prefix, "package.json") if prefix else "package.json"
        return self.exists(rel)


# =============================================================================
# Rules
# =============================================================================
def check_command(tree: Tree, doc: str, line: int, command: str, findings: list):
    tokens = tokenize(command)
    if not tokens:
        return

    for argv in split_pipeline(tokens):
        # Strip leading env assignments and command prefixes (`sudo`, `env`, …).
        while argv and (ENV_ASSIGN_RE.match(argv[0]) or argv[0] in COMMAND_PREFIXES):
            argv = argv[1:]
        if not argv:
            continue
        rule_scripts(tree, doc, line, command, argv, findings)
        rule_make(tree, doc, line, command, argv, findings)
        rule_gate_profile(tree, doc, line, command, argv, findings)
        rule_npm(tree, doc, line, command, argv, findings)
        rule_cargo_fmt(tree, doc, line, command, argv, findings)
        rule_file_flags(tree, doc, line, command, argv, findings)


def rule_scripts(tree, doc, line, command, argv, findings):
    """Every scripts/* executor a document names must exist, be executable, and
    parse. `bash -n` is the strongest thing available without running it: it is
    the difference between "the file is there" and "the file is a program"."""
    for pos, tok in enumerate(argv):
        m = SCRIPT_RE.match(tok)
        if not m or has_placeholder(tok) or tok.endswith("/"):
            continue
        rel = m.group(1)
        if rel.endswith(NON_EXECUTABLE_EXT):
            continue
        # An executor is either the command word, or something with an
        # executable extension handed to an interpreter (`bash scripts/x.sh`).
        # Anything else under scripts/ is a *reference* — RUN.md §3.2 points at
        # scripts/transcription/README.md as reading, not as a program.
        if pos != 0 and not rel.endswith((".sh", ".py", ".mjs", ".js")):
            continue
        if os.path.isdir(tree.path(rel)):
            continue
        decided()
        if not tree.exists(rel):
            findings.append(
                Finding(
                    doc,
                    line,
                    command,
                    f"{rel} 없음 — 문서가 존재하지 않는 실행체를 실행시킨다",
                    "스크립트를 되살리거나, 명령을 지우거나, 삭제 사실을 산문으로 적어라 "
                    "(코드블록 안에 남기면 다음 사람이 그대로 실행한다)",
                )
            )
            continue
        full = tree.path(rel)
        if not os.access(full, os.X_OK):
            findings.append(
                Finding(doc, line, command, f"{rel} 실행권한 없음", f"chmod +x {rel}")
            )
        err = syntax_error(full, rel)
        if err:
            findings.append(
                Finding(doc, line, command, f"{rel} 구문 오류: {err}", "")
            )
        rule_script_flags(tree, doc, line, command, argv[pos + 1 :], rel, findings)


_SYNTAX_CACHE: dict[str, str] = {}


def syntax_error(full: str, rel: str) -> str:
    if rel in _SYNTAX_CACHE:
        return _SYNTAX_CACHE[rel]
    err = ""
    if rel.endswith(".sh"):
        proc = subprocess.run(
            ["bash", "-n", full], capture_output=True, text=True, check=False
        )
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout).strip().splitlines()[-1:]
            err = err[0] if err else f"bash -n exit {proc.returncode}"
    elif rel.endswith(".py"):
        with tempfile.NamedTemporaryFile(suffix=".pyc", delete=True) as tmp:
            try:
                py_compile.compile(full, cfile=tmp.name, doraise=True)
            except py_compile.PyCompileError as exc:
                err = str(exc).strip().splitlines()[-1]
    _SYNTAX_CACHE[rel] = err
    return err


def rule_script_flags(tree, doc, line, command, rest, rel, findings):
    """A long flag the document hands to one of our scripts must appear in that
    script. This is the #1472 shape at its most literal: the fmt command failed
    not because the file was missing but because the flag combination it carried
    meant nothing to the tool. Flags are matched as literal strings against the
    script source, so a script that builds its parser dynamically will simply
    not be covered rather than produce a false red.

    Only flags that follow the script *immediately* are judged. Once a
    subcommand intervenes, the flags belong to whatever that subcommand
    dispatches to — `scripts/momo host add … --binary` forwards to
    infra/workd/bootstrap.sh, and `--binary` is that script's flag, not
    scripts/momo's. Under-covering the dispatchers is the honest trade."""
    if rest and not rest[0].startswith("-"):
        return
    source = tree.read(rel)
    if not source:
        return
    for tok in rest:
        if not tok.startswith("--") or len(tok) < 4:
            continue
        flag = tok.split("=", 1)[0]
        if has_placeholder(flag) or not re.match(r"^--[a-z][a-z0-9-]*$", flag):
            continue
        decided()
        if flag not in source:
            findings.append(
                Finding(
                    doc,
                    line,
                    command,
                    f"{rel}에 {flag} 옵션이 없다 — 스크립트가 모르는 플래그다",
                    f"grep -- '{flag}' {rel} 로 확인하고 문서나 스크립트 중 하나를 맞춰라",
                )
            )


def rule_make(tree, doc, line, command, argv, findings):
    if argv[0] != "make":
        return
    targets = tree.make_targets()
    if not targets:
        return
    for tok in argv[1:]:
        if tok.startswith("-") or "=" in tok or has_placeholder(tok):
            continue
        if not IDENT_RE.match(tok):
            continue
        decided()
        if tok not in targets:
            findings.append(
                Finding(
                    doc,
                    line,
                    command,
                    f"Makefile에 `{tok}` 타깃이 없다",
                    f"make -n {tok} 는 'No rule to make target'로 죽는다",
                )
            )


def rule_gate_profile(tree, doc, line, command, argv, findings):
    if not any("local_gate.sh" in tok for tok in argv):
        return
    profiles = tree.gate_profiles()
    if not profiles:
        return
    for i, tok in enumerate(argv):
        if tok != "--profile" or i + 1 >= len(argv):
            continue
        value = argv[i + 1]
        if has_placeholder(value):
            continue
        decided()
        if value not in profiles:
            findings.append(
                Finding(
                    doc,
                    line,
                    command,
                    f"local_gate.sh 프로파일 `{value}`는 존재하지 않는다",
                    "local_gate.sh는 모르는 프로파일에 exit 2로 답한다. "
                    f"현재 목록: {', '.join(sorted(profiles))}",
                )
            )


def rule_npm(tree, doc, line, command, argv, findings):
    if argv[0] != "npm":
        return
    prefix = ""
    rest = argv[1:]
    if rest[:1] == ["--prefix"] and len(rest) > 1:
        prefix = rest[1]
        rest = rest[2:]
    if has_placeholder(prefix):
        return
    decided()
    if prefix and not tree.has_package_json(prefix):
        findings.append(
            Finding(doc, line, command, f"{prefix}/package.json 없음", "")
        )
        return
    if not rest:
        return
    if rest[0] == "run" and len(rest) > 1 and not has_placeholder(rest[1]):
        script = rest[1]
        scripts = tree.npm_scripts(prefix)
        decided()
        if scripts and script not in scripts:
            where = f"{prefix}/package.json" if prefix else "package.json"
            findings.append(
                Finding(
                    doc,
                    line,
                    command,
                    f"{where}에 `{script}` 스크립트가 없다",
                    f"정의된 것: {', '.join(sorted(scripts))}",
                )
            )


def rule_cargo_fmt(tree, doc, line, command, argv, findings):
    """#1525's origin. `cargo fmt --check` without `--all` against a virtual
    workspace manifest prints "Failed to find targets" and checks nothing, so
    documenting that form hands the reader a green that means nothing. This is
    the one rule here that judges a command's *meaning* rather than whether its
    parts resolve, and it is here because that exact sentence cost #1472."""
    if argv[:2] != ["cargo", "fmt"]:
        return
    rest = argv[2:]
    if "--check" not in rest:
        return
    decided()
    if "--all" in rest or "-p" in rest or "--package" in rest:
        return
    findings.append(
        Finding(
            doc,
            line,
            command,
            "`cargo fmt --check`에 `--all`이 없다 — virtual workspace에서 "
            "'Failed to find targets'로 끝나고 아무것도 검사하지 않는다 (#1472)",
            "cargo fmt --all --check --manifest-path <manifest>",
        )
    )


def rule_file_flags(tree, doc, line, command, argv, findings):
    """Paths a flag points a tool at. Two shapes:

    * docker compose `-f` / `--env-file` — a missing overlay is the runbook
      failing at its first step, and these paths move (infra/prod → infra/rust).
    * `--package-path` / `--manifest-path` — the tree the build is aimed at.
      W-S1 (#1215) deleted clients/{Core,macOS,iOS} and left the commands that
      build them standing in RUN.md.
    """
    is_compose = "compose" in argv or "docker-compose" in argv[0]
    for i, tok in enumerate(argv):
        if i + 1 >= len(argv):
            continue
        if tok in ("-f", "--file", "--env-file"):
            if not is_compose:
                continue
        elif tok not in ("--package-path", "--manifest-path"):
            continue
        value = argv[i + 1]
        if has_placeholder(value) or value.startswith("-"):
            continue
        if not re.match(r"^(infra|clients|server|server-rust|packages|relay|workers|services|adapters|docs)/?", value):
            continue
        decided()
        if not tree.exists(value):
            findings.append(
                Finding(
                    doc,
                    line,
                    command,
                    f"{tok} 가 가리키는 {value} 가 이 트리에 없다",
                    "",
                )
            )


# =============================================================================
# Entry point
# =============================================================================
def gated_documents(tree: Tree):
    docs = []
    for rel, reason in GATED_DOCS:
        docs.append((rel, reason))
    for pattern in GATED_GLOBS:
        for full in sorted(glob.glob(os.path.join(tree.root, pattern))):
            rel = os.path.relpath(full, tree.root)
            docs.append((rel, f"{pattern} — 런북은 정의상 명령을 따라가는 문서다"))
    return docs


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Resolve every command in the operating documents against this tree (#1525)."
    )
    parser.add_argument(
        "--root",
        default=None,
        help="Tree to check. Default: the enclosing git worktree root.",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="Print the gated documents and the commands extracted from each, then exit.",
    )
    args = parser.parse_args()

    root = args.root
    if root is None:
        proc = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            print(
                "[docs-cmd] not inside a git worktree; pass --root DIR",
                file=sys.stderr,
            )
            return 1
        root = proc.stdout.strip()

    tree = Tree(root)
    findings: list = []
    checked_docs = 0
    checked_commands = 0

    for rel, _reason in gated_documents(tree):
        if not tree.exists(rel):
            print(
                f"[docs-cmd] FAIL: gated document {rel} does not exist — "
                "remove its row or restore the file",
                file=sys.stderr,
            )
            findings.append(Finding(rel, 0, "(document)", "gated document missing"))
            continue
        checked_docs += 1
        text = tree.read(rel)
        for line, command in extract_commands(rel, text):
            checked_commands += 1
            if args.list:
                print(f"{rel}:{line}: {command}")
                continue
            check_command(tree, rel, line, command, findings)

    if args.list:
        return 0

    if findings:
        print(
            f"[docs-cmd] {len(findings)} broken command(s) out of {ASSERTIONS[0]} "
            f"fact(s) decided in {checked_docs} document(s):",
            file=sys.stderr,
        )
        for f in findings:
            print(f.render(), file=sys.stderr)
        print(
            "\n[docs-cmd] 이 문서들은 사람이 그대로 실행하는 계약이다. "
            "위 명령은 오늘 이 트리에서 실패하거나, 더 나쁘게는 아무것도 하지 않고 성공한다.",
            file=sys.stderr,
        )
        return 1

    print(
        f"[docs-cmd] PASS: {ASSERTIONS[0]} fact(s) decided across {checked_commands} "
        f"candidate command(s) in {checked_docs} document(s); every one resolves "
        "against this tree"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
