#!/usr/bin/env python3
"""SEC-02 (#4224, ADR-0214) security-claims lint.

Every public security claim lives in docs/security/claims.yaml next to the tests
that prove it. A claim with no proof does not get published; this gate makes the
absence red. It reads files only (no compiler, no database) and checks, per claim:

  E1  the claim has no proof selector at all
  E2  a proof selector matches nothing: the file is missing, the symbol is not a
      real test (Rust: a `fn NAME(` line with a #[test]/#[tokio::test]/#[sqlx::test]
      attribute above it; TS: an exact it()/test() title that is not skipped), or
      a script that no workflow/gate invokes
  E3  `runs:` promises a lane the proof does not run in. Lanes, strongest first:
        pr-ci    non-#[ignore] Rust under server-rust/ (cargo test --workspace),
                 an #[ignore] Rust test whose (package, tests/<target>) is listed
                 in infra/security-pack/selection.txt (Security pack lane), a
                 vitest/jest file in packages/momo-core, clients/web, clients/mobile,
                 or a script named in a non-comment line of pr-ci.yml
        nightly  any other #[ignore] Rust test (security-nightly.yml runs them all)
        local    a script named in local_gate.sh only, or Rust outside server-rust/
  E4  a P0 claim has no sabotage evidence: `sabotage.how` (what was broken) and
      `sabotage.evidence`: a Rust/TS test selector, or a `scripts/tests/` script,
      that resolves like a proof, runs in a lane at least as strong as the claim's
      `runs:`, and (for a selector) is named like a negative control
      (control / red / sabotage / negative)
  E5  a `limits:` entry (an honest "oort does not do this") is missing its marker
      `<!-- limit:ID -->` in a document it names, the marker sits in a code block
      or has no sentence after it, or a required limit id (LIM-1..LIM-4 by default,
      --require-limits) is absent from the file
  E0  schema/format problem (duplicate id or yaml key, unknown top-level key or
      field value, unreadable file)

Selector matching ignores comments and string contents: a name that appears only in
a comment, a block comment, a raw string, or behind #[cfg(any())] / a never-enabled
feature, or an it() inside describe.skip, is not a test.

Selector forms (always quoted in the yaml):
  path/to/file.rs#test_fn_name        Rust test
  path/to/file.test.ts::exact title   vitest/jest test title
  script:path/to/script               a script/workflow, must be invoked somewhere

Usage: scripts/check_security_claims.py [--root DIR] [--claims FILE]
       [--selection FILE] [--pr-ci FILE] [--local-gate FILE] [--nightly FILE]
Exit 0 green, 1 on any finding. Selection entries no claim cites are a note, not
an error (deriving selection.txt from this file is a separate decision, ADR-0214).
"""
import argparse
import os
import posixpath
import re
import sys

LANE_RANK = {"pr-ci": 3, "nightly": 2, "local": 1, "release": 1}
PRIORITIES = ("P0", "P1")
RUST_TEST_ATTR = re.compile(r"#\[\s*(?:tokio::|sqlx::|async_std::)?test\b")
RUST_IGNORE_ATTR = re.compile(r"#\[\s*ignore\b")
TS_CALL = re.compile(
    r"\b(it|test)(\.(?:skip|todo|only|concurrent|fails))?\(\s*(['\"`])(.*?)\3", re.S
)
TS_TEST_FILE = re.compile(r"\.test\.(?:ts|tsx|mjs|js)$|/__tests__/.+\.(?:ts|tsx|js)$")
TS_ROOTS = ("packages/momo-core/", "clients/web/", "clients/mobile/")


# --------------------------------------------------------------------------- yaml
def _scalar(text):
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        body = text[1:-1]
        if text[0] == '"':
            body = body.replace('\\"', '"').replace("\\\\", "\\")
        else:
            body = body.replace("''", "'")
        return body
    if text in ("true", "false"):
        return text == "true"
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if text in ("", "~", "null"):
        return None
    return text


def _strip_comment(line):
    out, quote = [], None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            break
        out.append(ch)
    return "".join(out).rstrip()


def mini_yaml(text):
    """The YAML subset claims.yaml uses: block maps, block lists of scalars or maps,
    quoted or plain one-line scalars. Anything else raises ValueError (fail closed)."""
    rows = []
    for no, raw in enumerate(text.split("\n"), 1):
        line = _strip_comment(raw)
        if not line.strip():
            continue
        if "\t" in line[: len(line) - len(line.lstrip())]:
            raise ValueError(f"line {no}: tab indentation")
        rows.append((no, len(line) - len(line.lstrip(" ")), line.strip()))

    def block(i, indent):
        if rows[i][2].startswith("- "):
            return seq(i, indent)
        return mapping(i, indent)

    def mapping(i, indent):
        out = {}
        while i < len(rows) and rows[i][1] == indent and not rows[i][2].startswith("- "):
            no, _, s = rows[i]
            m = re.match(r"([A-Za-z_][\w-]*):(?:\s+(.*))?$", s)
            if not m:
                raise ValueError(f"line {no}: unsupported syntax: {s}")
            key, rest = m.group(1), m.group(2)
            if key in out:
                raise ValueError(f"line {no}: duplicate key {key}")
            i += 1
            if rest is None or rest == "":
                if i < len(rows) and rows[i][1] > indent:
                    out[key], i = block(i, rows[i][1])
                else:
                    out[key] = None
            else:
                out[key] = _scalar(rest)
        return out, i

    def seq(i, indent):
        out = []
        while i < len(rows) and rows[i][1] == indent and rows[i][2].startswith("- "):
            no, _, s = rows[i]
            body = s[2:].strip()
            m = re.match(r"([A-Za-z_][\w-]*):(?:\s+(.*))?$", body)
            if m:
                # a map item: rewrite "- k: v" as a map row at the item indent + 2
                rows[i] = (no, indent + 2, body)
                item, i = mapping(i, indent + 2)
                out.append(item)
            else:
                out.append(_scalar(body))
                i += 1
        return out, i

    if not rows:
        return {}
    value, end = block(0, rows[0][1])
    if end != len(rows):
        raise ValueError(f"line {rows[end][0]}: unexpected indentation")
    return value


def load_yaml(path):
    text = open(path, encoding="utf-8").read()
    try:
        import yaml  # noqa: PLC0415  (optional; the fallback is the same subset)
    except ImportError:
        return mini_yaml(text)

    class Strict(yaml.SafeLoader):
        pass

    def no_dup(loader, node, deep=False):
        seen = set()
        for k, _ in node.value:
            key = loader.construct_object(k, deep=deep)
            if key in seen:
                raise ValueError(f"duplicate key {key!r} (line {k.start_mark.line + 1})")
            seen.add(key)
        return yaml.SafeLoader.construct_mapping(loader, node, deep)

    Strict.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, no_dup)
    return yaml.load(text, Loader=Strict)  # noqa: S506  (SafeLoader subclass)


# ----------------------------------------------------------------------- resolvers
class Repo:
    def __init__(self, root, selection, pr_ci, local_gate, nightly):
        self.root = root
        self.selection_path = selection
        self.cache = {}
        self.pr_ci_text = self._workflow_text(pr_ci)
        self.local_gate_text = self._workflow_text(local_gate)
        self.nightly_exists = os.path.isfile(nightly)
        self.selection = self._selection(selection)

    def read(self, rel):
        if rel not in self.cache:
            full = os.path.join(self.root, rel)
            try:
                with open(full, encoding="utf-8", errors="replace") as fh:
                    self.cache[rel] = fh.read()
            except OSError:
                self.cache[rel] = None
        return self.cache[rel]

    @staticmethod
    def _workflow_text(path):
        try:
            lines = open(path, encoding="utf-8").read().split("\n")
        except OSError:
            return ""
        # A name in a comment is not an invocation.
        return "\n".join(l for l in lines if not l.lstrip().startswith("#"))

    def _selection(self, path):
        pairs = set()
        try:
            lines = open(path, encoding="utf-8").read().split("\n")
        except OSError:
            return pairs
        for line in lines:
            parts = line.split()
            if len(parts) == 3 and not line.lstrip().startswith("#"):
                pairs.add((parts[1], parts[2]))
        return pairs

    def package_of(self, rel):
        d = os.path.dirname(rel)
        while d:
            cargo = self.read(os.path.join(d, "Cargo.toml"))
            if cargo and re.search(r"^\[package\]", cargo, re.M):
                m = re.search(r'^name\s*=\s*"([^"]+)"', cargo, re.M)
                return d, (m.group(1) if m else None)
            d = os.path.dirname(d)
        return None, None


def _scan(text, line_comments=("//",), block=True, rust=False):
    """Blank comments (and, with rust=True, string/raw-string contents) while keeping
    every newline, and return (blanked_text, code_mask): code_mask[i] is False inside
    a comment or inside the content of a string literal."""
    n, out, mask, i = len(text), [], [], 0

    def emit(ch, code):
        out.append(ch)
        mask.append(code)

    def blank(chunk, code=False):
        for c in chunk:
            emit("\n" if c == "\n" else " ", code)

    while i < n:
        c = text[i]
        if text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            blank(text[i:j])
            i = j
        elif block and text.startswith("/*", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if text.startswith("/*", j):
                    depth, j = depth + 1, j + 2
                elif text.startswith("*/", j):
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            blank(text[i:j])
            i = j
        elif rust and c == "r" and re.match(r'r#*"', text[i:i + 8]) and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_")):
            hashes = len(re.match(r"r(#*)\"", text[i:]).group(1))
            end = text.find('"' + "#" * hashes, i + 2 + hashes)
            end = n if end < 0 else end + 1 + hashes
            emit("r", True)
            blank(text[i + 1:end])
            i = end
        elif c in "\"'`":
            if c == "'" and rust:
                m = re.match(r"'(?:\\.|[^\\'\n])'", text[i:])
                if not m:
                    emit(c, True)  # a lifetime
                    i += 1
                    continue
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            j = min(j, n - 1)
            emit(c, True)
            if rust:
                blank(text[i + 1:j])
            else:
                for ch in text[i + 1:j]:
                    emit(ch, False)
            emit(text[j], True)
            i = j + 1
        else:
            emit(c, True)
            i += 1
    return "".join(out), mask


# `#[cfg(...)]` shapes that compile a test out for good
RUST_CFG_OFF = re.compile(r"#\[\s*cfg\s*\(\s*(?:any\s*\(\s*\)|feature\b|not\s*\(\s*test\b|false\b)")


def rust_test(text, name):
    """(found, ignored) for a real test fn called `name`."""
    text, _ = _scan(text, rust=True)
    lines = text.split("\n")
    pat = re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+" + re.escape(name) + r"\s*[(<]")
    for i, line in enumerate(lines):
        if not pat.match(line):
            continue
        attrs, j = [], i - 1
        while j >= 0 and i - j <= 14:
            s = lines[j].strip()
            if s.startswith("#[") or s.startswith("//") or s == "":
                if s.startswith("#["):
                    attrs.append(s)
            elif s.endswith(")]") or s.endswith('"]') or s.startswith('"') or s.startswith(")"):
                attrs.append(s)  # tail of a multi-line attribute
            else:
                break
            j -= 1
        joined = " ".join(attrs)
        if RUST_CFG_OFF.search(joined):
            continue
        if RUST_TEST_ATTR.search(joined):
            return True, bool(RUST_IGNORE_ATTR.search(joined))
    return False, False


def ts_test(text, title):
    """(found, skipped) for an exact it()/test() title."""
    found, skipped = False, False
    stripped, mask = _scan(text)
    if re.search(r"\b(?:x?describe\.(?:skip|todo)|xdescribe|xit|xtest)\s*[(.]", stripped):
        return False, True  # a skipped suite: nothing inside it is a running test
    for m in TS_CALL.finditer(stripped):
        if not mask[m.start()]:
            continue  # inside a string literal
        if m.group(4) == title:
            found = True
            if m.group(2) in (".skip", ".todo"):
                skipped = True
            else:
                return True, False
    return found, skipped


def norm_selector(sel):
    for sep in ("::", "#"):
        if sep in sel:
            rel, rest = sel.split(sep, 1)
            break
    else:
        if not sel.startswith("script:"):
            return sel
        sep, rel, rest = "", sel[len("script:"):], ""
        rel = posixpath.normpath(rel)
        return None if rel.startswith("..") or rel.startswith("/") else "script:" + rel
    rel = posixpath.normpath(rel)
    if rel.startswith("..") or rel.startswith("/"):
        return None
    return rel + sep + rest


def invoked(rel, text):
    """The script's whole path appears in a non-comment line that is not a bare echo."""
    pat = re.compile(r"(?<![\w./-])" + re.escape(rel) + r"(?![\w./-])")
    return any(pat.search(l) and not l.lstrip().startswith("echo ") for l in text.split("\n"))


def resolve(repo, sel):
    """-> (error or None, lane or None, cited selection pair or None)."""
    sel = norm_selector(sel)
    if sel is None:
        return "selector path escapes the repository", None, None
    if sel.startswith("script:"):
        rel = sel[len("script:"):].strip()
        if repo.read(rel) is None:
            return f"script {rel} does not exist", None, None
        if invoked(rel, repo.pr_ci_text):
            return None, "pr-ci", None
        if invoked(rel, repo.local_gate_text):
            return None, "local", None
        if rel.startswith(".github/workflows/"):
            return None, "release", None
        return f"script {rel} is invoked by neither pr-ci.yml nor local_gate.sh", None, None
    if "::" in sel:
        rel, title = sel.split("::", 1)
        text = repo.read(rel)
        if text is None:
            return f"{rel} does not exist", None, None
        if not TS_TEST_FILE.search(rel):
            return f"{rel} is not a vitest/jest test file", None, None
        found, skipped = ts_test(text, title)
        if not found:
            return f"{rel} has no it()/test() titled exactly {title!r}", None, None
        if skipped:
            return f"{rel}: test {title!r} is skipped/todo", None, None
        lane = "pr-ci" if rel.startswith(TS_ROOTS) else "local"
        return None, lane, None
    if "#" in sel:
        rel, name = sel.split("#", 1)
        text = repo.read(rel)
        if text is None:
            return f"{rel} does not exist", None, None
        if not rel.endswith(".rs"):
            return f"{rel} is not a Rust file (use path.rs#fn or path.ts::title)", None, None
        found, ignored = rust_test(text, name)
        if not found:
            return f"{rel} has no #[test] fn {name}", None, None
        if not rel.startswith("server-rust/"):
            return None, "local", None
        if not ignored:
            return None, "pr-ci", None
        cdir, pkg = repo.package_of(rel)
        target = os.path.splitext(os.path.basename(rel))[0]
        if cdir and os.path.dirname(rel) == os.path.join(cdir, "tests") and (pkg, target) in repo.selection:
            return None, "pr-ci", (pkg, target)
        return None, ("nightly" if repo.nightly_exists else "local"), None
    return f"unrecognised selector form: {sel!r}", None, None


CONTROL_NAME = re.compile(r"control|red|sabotage|negative", re.I)


def resolve_evidence(repo, ev, runs):
    """Sabotage evidence is a test selector named like a negative control, or a
    scripts/tests/ regression script that something invokes; it must run in a lane at
    least as strong as the claim's `runs:`. -> error or None."""
    if "#" in ev or "::" in ev:
        err, lane, _ = resolve(repo, ev)
        if err:
            return err
        name = re.split(r"#|::", ev, 1)[1]
        if not CONTROL_NAME.search(name):
            return f"{ev} is not named like a negative control (control/red/sabotage/negative)"
    else:
        rel = posixpath.normpath(ev)
        if not rel.startswith("scripts/tests/"):
            return f"{ev} is neither a test selector nor a scripts/tests/ regression script"
        err, lane, _ = resolve(repo, "script:" + rel)
        if err:
            return err
    if runs in LANE_RANK and LANE_RANK[lane] < LANE_RANK[runs]:
        return f"{ev} only runs in the {lane} lane but the claim promises {runs}"
    return None


# ------------------------------------------------------------------------- checks
def lint(args):
    root = os.path.abspath(args.root)
    p = lambda rel, given: given if given else os.path.join(root, rel)  # noqa: E731
    claims_path = p("docs/security/claims.yaml", args.claims)
    repo = Repo(
        root,
        p("infra/security-pack/selection.txt", args.selection),
        p(".github/workflows/pr-ci.yml", args.pr_ci),
        p("scripts/local_gate.sh", args.local_gate),
        p(".github/workflows/security-nightly.yml", args.nightly),
    )
    errors, cited = [], set()
    try:
        doc = load_yaml(claims_path)
    except Exception as exc:  # noqa: BLE001
        return [f"E0 cannot read {claims_path}: {exc}"], 0, repo

    if not isinstance(doc, dict) or not isinstance(doc.get("claims"), list) or not doc["claims"]:
        return ["E0 claims.yaml needs a non-empty `claims:` list"], 0, repo

    for key in doc:
        if key not in ("version", "claims", "limits"):
            errors.append(f"E0 unknown top-level key {key!r} (a typo would silently drop the section)")
    ids = {l.get("id") for l in (doc.get("limits") or []) if isinstance(l, dict)}
    for need in args.require_limits:
        if need not in ids:
            errors.append(f"E5 required limit {need} is missing from `limits:`")

    seen = set()
    for idx, claim in enumerate(doc["claims"]):
        cid = claim.get("id") if isinstance(claim, dict) else None
        where = cid or f"claims[{idx}]"
        if not isinstance(claim, dict) or not cid or not isinstance(cid, str):
            errors.append(f"E0 {where}: every claim needs an id")
            continue
        if cid in seen:
            errors.append(f"E0 {cid}: duplicate id")
        seen.add(cid)
        for field in ("claim", "scope"):
            if not isinstance(claim.get(field), str) or len(claim[field].strip()) < 12:
                errors.append(f"E0 {cid}: `{field}` must be a real sentence")
        prio, runs = claim.get("priority"), claim.get("runs")
        if prio not in PRIORITIES:
            errors.append(f"E0 {cid}: priority must be one of {PRIORITIES}, got {prio!r}")
        if runs not in LANE_RANK:
            errors.append(f"E0 {cid}: runs must be one of {sorted(LANE_RANK)}, got {runs!r}")
        proofs = claim.get("proofs")
        if not isinstance(proofs, list) or not [x for x in proofs if isinstance(x, str) and x.strip()]:
            errors.append(f"E1 {cid}: no proof selector (a claim without a test is not published)")
            proofs = []
        for sel in proofs:
            if not isinstance(sel, str):
                errors.append(f"E0 {cid}: proof selectors must be strings")
                continue
            err, lane, pair = resolve(repo, sel.strip())
            if err:
                errors.append(f"E2 {cid}: {sel}: {err}")
                continue
            if pair:
                cited.add(pair)
            if runs in LANE_RANK and LANE_RANK[lane] < LANE_RANK[runs]:
                errors.append(f"E3 {cid}: runs: {runs} but {sel} only runs in the {lane} lane")
        if prio == "P0":
            sab = claim.get("sabotage")
            how = sab.get("how") if isinstance(sab, dict) else None
            ev = sab.get("evidence") if isinstance(sab, dict) else None
            if not isinstance(how, str) or len(how.strip()) < 12:
                errors.append(f"E4 {cid}: P0 claim has no sabotage.how")
            if not isinstance(ev, str) or not ev.strip():
                errors.append(f"E4 {cid}: P0 claim has no sabotage.evidence")
            else:
                err = resolve_evidence(repo, ev.strip(), runs)
                if err:
                    errors.append(f"E4 {cid}: sabotage evidence: {err}")

    for limit in doc.get("limits") or []:
        lid = limit.get("id") if isinstance(limit, dict) else None
        if not lid or not isinstance(limit.get("text"), str) or not isinstance(limit.get("docs"), list) or not limit["docs"]:
            errors.append(f"E0 limits: every entry needs id, text and docs ({limit!r})")
            continue
        if lid in seen:
            errors.append(f"E0 {lid}: duplicate id")
        seen.add(lid)
        for rel in limit["docs"]:
            text = repo.read(rel)
            if text is None:
                errors.append(f"E5 {lid}: document {rel} does not exist")
            else:
                err = limit_marker_problem(text, lid)
                if err:
                    errors.append(f"E5 {lid}: {rel} {err}")
    return errors, len(doc["claims"]), repo, cited


def limit_marker_problem(text, lid):
    """The marker must stand in prose (not a code fence) with a real sentence after it."""
    marker = f"<!-- limit:{lid} -->"
    fenced = False
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line.lstrip().startswith("```"):
            fenced = not fenced
        if marker in line:
            if fenced:
                return f"has the marker <!-- limit:{lid} --> only inside a code block"
            body = " ".join(lines[i:i + 4]).split(marker, 1)[1]
            body = re.sub(r"<[^>]*>|[*_`>#\-]", "", body.split("\n\n")[0]).strip()
            if len(body) < 30:
                return f"has the marker <!-- limit:{lid} --> without a sentence after it"
            return None
    return f"lacks the marker <!-- limit:{lid} -->"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    for opt in ("claims", "selection", "pr-ci", "local-gate", "nightly"):
        ap.add_argument(f"--{opt}", default=None)
    ap.add_argument("--require-limits", default="LIM-1,LIM-2,LIM-3,LIM-4",
                    help="comma-separated limit ids that must exist (default: the four published ones)")
    args = ap.parse_args()
    args.require_limits = [x for x in args.require_limits.split(",") if x]
    result = lint(args)
    errors, n = result[0], result[1]
    if errors:
        for e in errors:
            print(f"[security-claims] {e}", file=sys.stderr)
        print(f"[security-claims] RED: {len(errors)} finding(s) in {n} claim(s)", file=sys.stderr)
        return 1
    repo, cited = result[2], result[3]
    uncited = sorted(repo.selection - cited)
    for pkg, target in uncited:
        print(f"[security-claims] note: selection.txt entry {pkg}/{target} is cited by no claim")
    print(f"[security-claims] green: {n} claims, every one has a proof that resolves and runs where it says")
    return 0


if __name__ == "__main__":
    sys.exit(main())
