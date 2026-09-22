#!/usr/bin/env python3
"""Host-local orchestration board shared by every worktree of this clone.

The live board lives under this script's checkout
``git rev-parse --git-common-dir``/oort-coordination.
All worktrees of the same clone see it; a separate clone or unrelated repo
does not. The board never implies that no other process exists: a missing
or malformed board only means this clone has no readable local registrations.

Identity is ``--session`` (unique per run/harness). ``--owner`` is a display
label only and cannot take over another session's scope. There is no stale
auto-steal. Scope ``integration`` is the sequential integration lock; every
scope is exclusive while claimed.

The helper always binds the board to its own script checkout. When cwd is
another worktree of the same git common dir, that worktree is recorded as
the source. An unrelated git repo is never used as board or source.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


SCOPE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
NOTE_KEYS = ("issue", "pr", "run", "result", "next", "text")
VALID_STATES = {"claimed", "released"}
INTEGRATION_SCOPE = "integration"
# Fallback if `git rev-parse --local-env-vars` is unavailable. Names match
# current Git's repository-local list (not GIT_EDITOR / GIT_PAGER).
_FALLBACK_LOCAL_GIT_ENV = (
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
)


class UserError(Exception):
    def __init__(self, message: str, code: int = 1) -> None:
        super().__init__(message)
        self.code = code


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _local_git_env_names() -> frozenset[str]:
    """Repository-location variables. Queried from Git; fallback is documented."""
    env = os.environ.copy()
    for key in _FALLBACK_LOCAL_GIT_ENV:
        env.pop(key, None)
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--local-env-vars"],
            env=env,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return frozenset(_FALLBACK_LOCAL_GIT_ENV)
    if proc.returncode != 0:
        return frozenset(_FALLBACK_LOCAL_GIT_ENV)
    names = {line.strip() for line in proc.stdout.splitlines() if line.strip()}
    return frozenset(names) if names else frozenset(_FALLBACK_LOCAL_GIT_ENV)


_LOCAL_GIT_ENV_NAMES = _local_git_env_names()


def git_child_env() -> dict[str, str]:
    """Copy the process env without Git repository-location overrides.

    Does not mutate the parent. Child discovery then follows cwd / script
    checkout, including when a hook set GIT_DIR or passed --git-dir via env.
    """
    return {key: value for key, value in os.environ.items() if key not in _LOCAL_GIT_ENV_NAMES}


def git(args: list[str], cwd: str | None) -> str | None:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=cwd,
            env=git_child_env(),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


def script_checkout() -> str:
    return str(Path(__file__).resolve().parent.parent)


def same_path(left: str | None, right: str | None) -> bool:
    if not left or not right:
        return False
    try:
        return Path(left).resolve() == Path(right).resolve()
    except OSError:
        return os.path.normpath(left) == os.path.normpath(right)


def resolve_common_dir(start: str | None) -> str | None:
    if not start:
        return None
    common = git(["rev-parse", "--git-common-dir"], start)
    if not common:
        return None
    path = Path(common)
    if not path.is_absolute():
        path = Path(start) / path
    try:
        return str(path.resolve())
    except OSError:
        return str(path)


def bind_paths() -> tuple[str | None, str | None]:
    """Return (source_worktree, board_common_dir).

    Board is always this script's checkout. cwd may supply the source
    worktree only when it shares that git common dir.
    """
    script_root = script_checkout()
    script_top = git(["rev-parse", "--show-toplevel"], script_root)
    script_common = resolve_common_dir(script_top or script_root)

    cwd = os.getcwd()
    cwd_top = git(["rev-parse", "--show-toplevel"], cwd)
    cwd_common = resolve_common_dir(cwd_top) if cwd_top else None

    if script_common and same_path(cwd_common, script_common) and cwd_top:
        source_top = cwd_top
    else:
        source_top = script_top

    return source_top, script_common


def validate_scope(scope: str) -> str:
    if not scope or not SCOPE_RE.fullmatch(scope):
        raise UserError(
            "invalid scope: use a single name matching "
            "[A-Za-z0-9][A-Za-z0-9._-]{0,63} (no slashes or '..')",
            code=5,
        )
    if scope in {".", ".."} or "/" in scope or "\\" in scope:
        raise UserError("invalid scope: path traversal rejected", code=5)
    return scope


def require_token(value: str, flag: str) -> str:
    text = (value or "").strip()
    if not text:
        raise UserError(f"{flag} must be a non-empty session identity", code=2)
    return text


def board_dir(common_dir: str) -> Path:
    return Path(common_dir) / "oort-coordination"


def scope_path(board: Path, scope: str) -> Path:
    return board / "scopes" / f"{scope}.json"


def malformed_message(name: str, detail: str) -> str:
    return (
        f"malformed scope file {name}: {detail} "
        "(malformed is not an empty board; do not assume no other processes)"
    )


def validate_record(data: dict[str, Any], name: str) -> None:
    errors: list[str] = []
    version = data.get("version")
    if version != 1:
        errors.append(f"version must be 1, got {version!r}")
    state = data.get("state")
    if not isinstance(state, str) or state not in VALID_STATES:
        errors.append("state must be 'claimed' or 'released'")
    session = data.get("session")
    if not isinstance(session, str) or not session.strip():
        errors.append("session must be a non-empty string")
    stem = Path(name).stem
    scope = data.get("scope")
    if not isinstance(scope, str) or not scope.strip():
        errors.append("scope must be a non-empty string")
    else:
        try:
            validate_scope(scope)
        except UserError:
            errors.append(
                "scope must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}"
            )
        if scope != stem:
            errors.append(
                f"scope {scope!r} must equal filename stem {stem!r}"
            )
    owner = data.get("owner")
    if not isinstance(owner, str) or not owner.strip():
        errors.append("owner must be a non-empty string")
    source = data.get("source")
    if not isinstance(source, dict):
        errors.append("source must be an object")
    else:
        for key in ("worktree", "head"):
            value = source.get(key)
            if value is not None and not isinstance(value, str):
                errors.append(f"source.{key} must be a string")
    note = data.get("note")
    if not isinstance(note, dict):
        errors.append("note must be an object")
    elif "source" in note:
        note_source = note.get("source")
        if not isinstance(note_source, dict):
            errors.append("note.source must be an object")
        else:
            for key in ("worktree", "head"):
                value = note_source.get(key)
                if value is not None and not isinstance(value, str):
                    errors.append(f"note.source.{key} must be a string")
    if errors:
        raise UserError(malformed_message(name, "; ".join(errors)), code=1)


def load_existing_for_mutation(path: Path) -> dict[str, Any]:
    record = load_record(path)
    if record is None:
        raise UserError(f"scope file {path.name} disappeared under lock", code=1)
    validate_record(record, path.name)
    return record


def board_layout_problems(board: Path) -> list[str]:
    """Ordinary misconfiguration: board/scopes exist but are not directories."""
    problems: list[str] = []
    if board.exists() and not board.is_dir():
        problems.append(
            f"malformed board path {board}: expected a directory, found a file "
            "(malformed is not an empty board; do not assume no other processes)"
        )
        return problems
    scopes = board / "scopes"
    if scopes.exists() and not scopes.is_dir():
        problems.append(
            f"malformed scopes path {scopes}: expected a directory, found a file "
            "(malformed is not an empty board; do not assume no other processes)"
        )
    locks = board / "locks"
    if locks.exists() and not locks.is_dir():
        problems.append(
            f"malformed locks path {locks}: expected a directory, found a file "
            "(malformed is not an empty board; do not assume no other processes)"
        )
    return problems


def require_board_dirs(board: Path) -> None:
    problems = board_layout_problems(board)
    if problems:
        raise UserError(problems[0], code=1)
    try:
        (board / "locks").mkdir(parents=True, exist_ok=True)
        (board / "scopes").mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise UserError(f"cannot use board {board}: {exc}", code=1) from exc


@contextmanager
def exclusive_scope(board: Path, scope: str) -> Iterator[None]:
    require_board_dirs(board)
    lock_path = board / "locks" / f"{scope}.lock"
    with open(lock_path, "a+b") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield


def atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    data = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_record(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise UserError(malformed_message(path.name, str(exc)), code=1) from exc
    if not isinstance(data, dict):
        raise UserError(
            malformed_message(path.name, "expected object"),
            code=1,
        )
    return data


def current_source(toplevel: str | None) -> dict[str, str]:
    worktree = toplevel or script_checkout()
    head = git(["rev-parse", "HEAD"], worktree) or "unknown"
    return {"worktree": worktree, "head": head}


def parse_note_file(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    note_path = Path(path)
    if not note_path.is_file():
        raise UserError(f"note file not found: {path}", code=2)
    raw = note_path.read_text(encoding="utf-8")
    stripped = raw.strip()
    if not stripped:
        return {}
    try:
        loaded = json.loads(stripped)
    except json.JSONDecodeError:
        return {"text": raw.rstrip("\n")}
    if isinstance(loaded, dict):
        return {key: loaded[key] for key in NOTE_KEYS if key in loaded}
    return {"text": stripped}


def snapshot_note(
    incoming: dict[str, Any], checkpoint_source: dict[str, str]
) -> dict[str, Any]:
    """Replace the previous note. Partial files do not keep old result/text."""
    note: dict[str, Any] = {
        key: incoming[key] for key in NOTE_KEYS if key in incoming
    }
    note["updated_at"] = utc_now()
    note["source"] = {
        "worktree": checkpoint_source.get("worktree", ""),
        "head": checkpoint_source.get("head", ""),
    }
    return note


def iter_scope_files(
    board: Path,
) -> tuple[list[dict[str, Any]], list[str], list[dict[str, Any]]]:
    scopes_dir = board / "scopes"
    if not scopes_dir.exists():
        return [], [], []
    records: list[dict[str, Any]] = []
    malformed: list[str] = []
    malformed_records: list[dict[str, Any]] = []
    if not scopes_dir.is_dir():
        malformed.append(
            f"malformed scopes path {scopes_dir}: expected a directory, found a file "
            "(malformed is not an empty board; do not assume no other processes)"
        )
        return [], malformed, []
    for path in sorted(scopes_dir.glob("*.json")):
        try:
            record = load_record(path)
        except UserError as exc:
            malformed.append(str(exc))
            continue
        if record is None:
            continue
        try:
            validate_record(record, path.name)
        except UserError as exc:
            malformed.append(str(exc))
            malformed_records.append(record)
            continue
        records.append(record)
    return records, malformed, malformed_records


def _stringify(value: Any) -> str:
    if isinstance(value, str):
        text = value
    else:
        text = json.dumps(value, ensure_ascii=False, default=str)
    return text.replace("\t", " ").replace("\r", " ").replace("\n", " / ")


def format_record(record: dict[str, Any]) -> str:
    scope = record.get("scope", "?")
    state = record.get("state", "unknown")
    if not isinstance(state, str):
        state = _stringify(state)
    session = record.get("session")
    owner = record.get("owner")
    session_s = session if isinstance(session, str) and session else "-"
    owner_s = owner if isinstance(owner, str) and owner else "-"
    note = record.get("note") if isinstance(record.get("note"), dict) else {}
    source = record.get("source") if isinstance(record.get("source"), dict) else {}
    head_raw = source.get("head")
    worktree_raw = source.get("worktree")
    head = _stringify(head_raw)[:12] if head_raw not in (None, "") else "-"
    worktree = _stringify(worktree_raw) if worktree_raw not in (None, "") else "-"
    parts = [
        f"- {_stringify(scope)}\t{state}\tsession={session_s}\towner={owner_s}"
    ]
    for key in NOTE_KEYS:
        if key not in note:
            continue
        value = note[key]
        if value in (None, ""):
            continue
        parts.append(f"{key}={_stringify(value)}")
    note_source = note.get("source") if isinstance(note.get("source"), dict) else {}
    note_head_raw = note_source.get("head")
    note_worktree_raw = note_source.get("worktree")
    if note_head_raw not in (None, ""):
        parts.append(f"note.head={_stringify(note_head_raw)[:12]}")
    if note_worktree_raw not in (None, ""):
        parts.append(f"note.worktree={_stringify(note_worktree_raw)}")
    parts.append(f"head={head}")
    parts.append(f"worktree={worktree}")
    return "\t".join(parts)


def cmd_path(common_dir: str | None) -> int:
    if not common_dir:
        print(
            "cannot resolve git-common-dir; live board unknown "
            "(not proof that no other processes exist)",
            file=sys.stderr,
        )
        return 1
    print(str(board_dir(common_dir)))
    return 0


def cmd_status(common_dir: str | None) -> int:
    print("# oort coordination")
    if not common_dir:
        print("board: unresolved (not proof that no other processes exist)")
        print(
            "no local registrations; a missing board is not proof that "
            "no other processes exist"
        )
        return 0
    board = board_dir(common_dir)
    print(f"board: {board}")
    layout = board_layout_problems(board)
    if layout:
        for problem in layout:
            print(f"warning: {problem}", file=sys.stderr)
        print(f"scopes: 0 claimed, 0 released, {len(layout)} malformed")
        print(
            "malformed files present; do not assume the board is empty or "
            "that no other processes exist"
        )
        return 0
    if not board.exists():
        print(
            "no local registrations; a missing board is not proof that "
            "no other processes exist"
        )
        return 0
    records, malformed, _malformed_records = iter_scope_files(board)
    for warning in malformed:
        print(f"warning: {warning}", file=sys.stderr)
    claimed = [
        r for r in records if isinstance(r.get("state"), str) and r.get("state") == "claimed"
    ]
    released = [
        r for r in records if isinstance(r.get("state"), str) and r.get("state") == "released"
    ]
    other = [r for r in records if r not in claimed and r not in released]
    extra = f", {len(malformed)} malformed" if malformed else ""
    print(f"scopes: {len(claimed)} claimed, {len(released)} released{extra}")
    if not records and not malformed:
        print(
            "no local registrations; this is not proof that no other "
            "processes exist"
        )
        return 0
    if malformed and not records:
        print(
            "malformed files present; do not assume the board is empty or "
            "that no other processes exist"
        )
    elif malformed:
        print(
            "warning: malformed registrations present; do not assume the "
            "board is complete"
        )
    for record in claimed + other + released:
        try:
            print(format_record(record))
        except Exception as exc:  # pragma: no cover - defensive
            print(f"warning: failed to display a scope: {exc}", file=sys.stderr)
    return 0


def cmd_claim(
    common_dir: str | None,
    scope: str,
    session: str,
    owner: str,
    toplevel: str | None,
) -> int:
    if not common_dir:
        raise UserError(
            "cannot resolve git-common-dir; refusing to claim "
            "(unresolved is not proof that no other processes exist)",
            code=1,
        )
    scope = validate_scope(scope)
    session = require_token(session, "--session")
    owner = require_token(owner, "--owner")
    board = board_dir(common_dir)
    path = scope_path(board, scope)
    with exclusive_scope(board, scope):
        current = None
        if path.exists():
            current = load_existing_for_mutation(path)
            if current.get("state") == "claimed" and current.get("session") != session:
                raise UserError(
                    f"scope {scope!r} already claimed by session "
                    f"{current.get('session')!r} (owner {current.get('owner')!r})",
                    code=3,
                )
        note = current.get("note") if current else {}
        if not isinstance(note, dict):
            note = {}
        same_claimed_session = (
            current is not None
            and current.get("state") == "claimed"
            and current.get("session") == session
            and isinstance(current.get("claimed_at"), str)
            and bool(current.get("claimed_at"))
        )
        record = {
            "version": 1,
            "scope": scope,
            "state": "claimed",
            "session": session,
            "owner": owner,
            "claimed_at": current["claimed_at"] if same_claimed_session else utc_now(),
            "released_at": None,
            "source": current_source(toplevel),
            "note": note,
        }
        if scope == INTEGRATION_SCOPE:
            record["exclusive"] = True
        atomic_write(path, record)
    print(f"claimed {scope} session={session} owner={owner}")
    return 0


def cmd_checkpoint(
    common_dir: str | None,
    scope: str,
    session: str,
    note_file: str | None,
    toplevel: str | None,
) -> int:
    if not common_dir:
        raise UserError("cannot resolve git-common-dir; refusing checkpoint", code=1)
    scope = validate_scope(scope)
    session = require_token(session, "--session")
    board = board_dir(common_dir)
    path = scope_path(board, scope)
    incoming = parse_note_file(note_file)
    with exclusive_scope(board, scope):
        if not path.exists():
            raise UserError(f"scope {scope!r} is not claimed", code=4)
        current = load_existing_for_mutation(path)
        if current.get("state") != "claimed":
            raise UserError(f"scope {scope!r} is not claimed", code=4)
        if current.get("session") != session:
            raise UserError(
                f"scope {scope!r} belongs to session {current.get('session')!r}",
                code=4,
            )
        live = current_source(toplevel)
        current["source"] = live
        if incoming:
            current["note"] = snapshot_note(incoming, live)
        atomic_write(path, current)
    print(f"checkpoint {scope} session={session}")
    return 0


def cmd_release(
    common_dir: str | None, scope: str, session: str, toplevel: str | None
) -> int:
    if not common_dir:
        raise UserError("cannot resolve git-common-dir; refusing release", code=1)
    scope = validate_scope(scope)
    session = require_token(session, "--session")
    board = board_dir(common_dir)
    path = scope_path(board, scope)
    with exclusive_scope(board, scope):
        if not path.exists():
            raise UserError(f"scope {scope!r} is not claimed", code=4)
        current = load_existing_for_mutation(path)
        if current.get("state") != "claimed":
            raise UserError(f"scope {scope!r} is not claimed", code=4)
        if current.get("session") != session:
            raise UserError(
                f"scope {scope!r} belongs to session {current.get('session')!r}",
                code=4,
            )
        current["state"] = "released"
        current["released_at"] = utc_now()
        current["source"] = current_source(toplevel)
        atomic_write(path, current)
    print(f"released {scope} session={session} (notes retained)")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scripts/planning_session.py",
        description=(
            "Tiny stdlib helper for the host-local oort coordination board. "
            "The board is under this script checkout's git --git-common-dir/"
            "oort-coordination and is shared by every worktree of this clone. "
            "--session is the unique owner identity; --owner is only a label. "
            "No time-based steal, no network, no daemon."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  scripts/planning_session.py path\n"
            "  scripts/planning_session.py status\n"
            "  scripts/planning_session.py claim integration --session astra-1 --owner Astra/Codex\n"
            "  scripts/planning_session.py checkpoint integration --session astra-1 --note-file /tmp/note.json\n"
            "  scripts/planning_session.py release integration --session astra-1\n"
            "\n"
            "exit codes: 0 ok, 2 usage, 3 claim conflict, 4 wrong session, "
            "5 invalid scope path, 1 other. A missing/malformed board never "
            "means no other processes exist. Malformed records cannot be "
            "claimed, checkpointed, or released until replaced by a valid "
            "v1 record written out-of-band."
        ),
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("path", help="Print the shared coordination directory")
    sub.add_parser(
        "status",
        help="Show local registrations (missing/malformed ≠ no other processes)",
    )
    claim = sub.add_parser("claim", help="Atomically claim a scope for this session")
    claim.add_argument("scope", help="Scope name; 'integration' is the sequential lock")
    claim.add_argument("--session", required=True, help="Unique session identity")
    claim.add_argument("--owner", required=True, help="Display label (not identity)")
    checkpoint = sub.add_parser(
        "checkpoint",
        help="Replace the note snapshot; only the claiming session may write",
    )
    checkpoint.add_argument("scope")
    checkpoint.add_argument("--session", required=True)
    checkpoint.add_argument(
        "--note-file",
        help=(
            "Complete note snapshot: JSON object with issue/pr/run/result/"
            "next/text, or plain text. Replaces the previous note (no field "
            "merge). Provenance is stored on the snapshot and kept across "
            "release/reclaim."
        ),
    )
    release = sub.add_parser(
        "release", help="Release a scope; last checkpoint notes are retained"
    )
    release.add_argument("scope")
    release.add_argument("--session", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    toplevel, common_dir = bind_paths()
    try:
        if args.cmd == "path":
            return cmd_path(common_dir)
        if args.cmd == "status":
            return cmd_status(common_dir)
        if args.cmd == "claim":
            return cmd_claim(common_dir, args.scope, args.session, args.owner, toplevel)
        if args.cmd == "checkpoint":
            return cmd_checkpoint(
                common_dir, args.scope, args.session, args.note_file, toplevel
            )
        if args.cmd == "release":
            return cmd_release(common_dir, args.scope, args.session, toplevel)
        parser.print_help()
        return 2
    except UserError as exc:
        print(str(exc), file=sys.stderr)
        return exc.code


if __name__ == "__main__":
    sys.exit(main())
