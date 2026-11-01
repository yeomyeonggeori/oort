"""A differential oracle for how lockgate.py reads the volume's `.env` (#4886 security review, #4950). Python 3, stdlib only.

The question is not "does the gate give the answer its author expected" but "does the gate refuse what Hermes' REAL readers see".
The policy is an allow-list (#4950): the volume's `.env` may set the names of `SECRETS` (any value) and the lines of `SEEDED` (exactly
those values), and no other name. Hermes reads the file with two tokenizers, and a name either one yields counts. For one `.env`
(raw bytes), `run` asks the real readers what they see and the gate what it refuses, and compares them:

    Hermes   `hermes_cli.env_loader.load_hermes_dotenv` on a copy of the file, in an environment shaped like the service slot Hermes
             runs in. Hermes loads the file again and again and every load rewrites it, so the copy is loaded until a load leaves it as
             it was (at most `LOAD_CAP` loads, each in a fresh process): the names it adds or changes in ANY of those loads that the
             policy does not allow are `violated`. Each file the chain went through is also loaded once more as it stands, the clean-up
             switched off (it leaves some files alone and cannot always write its result): what that applies counts too.
    line     Hermes' second reader, the line-by-line tokenizer behind `agent.secret_scope.load_env_file` (the credential pool, the config
             readers and the profile scope read the file through it; python-dotenv is not involved). It is given every file the chain went
             through, as it stands: the names it yields that the policy does not allow are `violated` too. `line_reader` is optional
             (offline plumbing tests have none); the in-image proof always passes the image's own.
    gate     `volume_env_problems` on ANOTHER copy of the original bytes. There is ONE judgement: boot and `report` call it.
    missed   violated, but no gate problem names it. The unsafe direction: there must be none. `missed` is what the first load, the
             original file as it stands or the line reader on the original file applies; `missed_after` is the rest: what only a later
             load applies, and the file Hermes leaves behind after j loads (`report` and the next boot read that one), which the gate
             must name for the loads still to come.
    needless a gate problem names it, but it is not violated. Allowed only for the documented reason that makes the gate refuse MORE
             than Hermes applies (`explain`). Anything else is `unexplained`: that is what keeps "the gate reads the file the way
             Hermes does" true, and what stops a gate that refuses everything from passing.
    states   the files the chain went through are what the gate's own model of the clean-up (`env_states`) says they are, byte for byte:
             a model that differs from the loader is `chain_mismatch`, not a quiet pass.
    port     the gate's own copy of the line-by-line tokenizer (`line_assignments`) gives, for each of those files, exactly what the real
             one gives: a copy that differs is `line_reader_mismatch`, not a quiet pass.

This module has no Hermes and no gate in it: `run` is given both. test_lockgate_env.py tests the plain functions offline, and the
in-image proof (scripts/tests/fixtures/hermes_image_guard_inimage.py, scenario `env-loader-oracle`) passes the image's own
`hermes_cli.env_loader` and `agent.secret_scope`. The policy below spells the allowed names out on purpose and does not read them from
lockgate.py: a name the gate starts to allow has to show up here as a difference (test_lockgate_env.py holds the two lists to each other).
"""
import contextlib
import os
import pathlib
import random
import re
import tempfile
from unittest import mock

BOM = b"\xef\xbb\xbf"
FEFF = "\ufeff"

# --- what the policy allows, in the environment Hermes ends up with --------------------------------------------------------------
SECRETS = ("OPENAI_API_KEY", "ANTHROPIC_API_KEY")  # any value
SEEDED = {  # Hermes v0.22.2's own `.env.example`, which its first boot copies into a fresh volume: exactly these values
    "TERMINAL_MODAL_IMAGE": "nikolaik/python-nodejs:python3.11-nodejs20", "TERMINAL_TIMEOUT": "60", "TERMINAL_LIFETIME_SECONDS": "300",
    "BROWSERBASE_PROXIES": "true", "BROWSERBASE_ADVANCED_STEALTH": "false", "BROWSER_SESSION_TIMEOUT": "300",
    "BROWSER_INACTIVITY_TIMEOUT": "120", "WEB_TOOLS_DEBUG": "false", "VISION_TOOLS_DEBUG": "false", "MOA_TOOLS_DEBUG": "false",
    "IMAGE_TOOLS_DEBUG": "false",
}
# Allowed names the shapes below use for their helper statements (a note, a statement that makes the clean-up rewrite the file, a line
# that never closes its quote): a helper must not be a violation of its own, or no shape around it could ever be clean. A helper is
# always a secret (any value), never a seeded name; the two secrets serve the four roles (X and LATER share one, NOTE and Q the other).
HELPER_X, HELPER_NOTE = SECRETS
HELPER_LATER, HELPER_Q = SECRETS


def violations(applied, ignore=()):
    """The names in `applied` (what a load added to the environment or changed in it: `hermes_load`) that the volume's `.env` may not
    set: any name that is not a secret and not a seeded line with its own value. `ignore`: names the loader adds without any file."""
    out = set()
    for name, value in applied.items():
        if name in ignore or name in SECRETS or (name in SEEDED and SEEDED[name] == value):
            continue
        out.add(name)
    return out


def loader_own_names(env_loader, slot_env=None):
    """The names the loader adds to the environment for an EMPTY `.env`: its own bookkeeping, never the file's doing."""
    return set(hermes_load(env_loader, b"", slot_env)[0])


def loader_violations(env_loader, raw, slot_env=None):
    """`(the names the first load of `raw` violates, the name of the error the loader raised or None)`: for one file, the verdict the
    in-image scenarios record next to the gate's."""
    applied, _left, error = hermes_load(env_loader, raw, slot_env)
    return violations(applied, loader_own_names(env_loader, slot_env)), error


# --- reading the gate's answer -------------------------------------------------------------------------------------------------
# A name in a problem runs up to the next " (" (the reason) or the end: a name may hold blanks and line ends (a quoted name), so `\S+`
# would stop inside it and the gate would be said to have missed a name it did name.
_PROBLEM_NAME_RE = re.compile(r"the volume's \.env sets (.+?)(?: \(|\Z)", re.S)
_FILE_LEVEL = ("not valid UTF-8", "cannot parse", "cannot read")  # the gate refuses the whole file


_PROBLEM_PREFIX = "the volume's .env sets "


def named(problems, known=()):
    """(names the gate's problems refuse, whether it refused the file as a whole). `known`: names the readers yielded for the file. The line-by-line
    reader takes anything in front of an `=` for a name, so a name may hold " (" itself and the pattern above would cut it short: a problem
    that opens with `sets <a known name> (` is read as that name first (the longest one), the pattern is for the rest."""
    names, file_level = set(), False
    by_length = sorted(known, key=len, reverse=True)
    for problem in problems:
        if problem.startswith(_PROBLEM_PREFIX):
            rest = problem[len(_PROBLEM_PREFIX):]
            hit = next((name for name in by_length if rest.startswith(name + " (")), None)
            if hit is not None:
                names.add(hit)
                continue
        match = _PROBLEM_NAME_RE.match(problem)
        if match:
            names.add(match.group(1))
        elif any(marker in problem for marker in _FILE_LEVEL):
            file_level = True
    return names, file_level


def _text_with_nuls(raw):
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")) and not raw.startswith((b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff")):
        text = raw.decode("utf-16", "replace")
    else:
        text = raw.decode("utf-8", "replace")
        text = text[1:] if text.startswith(FEFF) else text  # one mark in front is the encoding's own: every reader strips it
    return text


def _readings_with_nuls(raw):
    """The texts the file may be read as, NULs kept: the decoded text, and (bytes that are not UTF-8) the Latin-1 text the loader falls back to."""
    return [_text_with_nuls(raw), raw.removeprefix(b"\xef\xbb\xbf").decode("latin-1")]


def explain(raw, name, raised=False, boundary=()):
    """Why the gate may refuse `name` although Hermes ends without a violation for it, or None. Three reasons, all designed. A NUL: the
    loader cannot export a variable with a NUL in its name or value, it raises on that statement and applies nothing after it, while the
    gate names the statements around it. That holds when the NUL is in the name or on the line of the name, in either reading of the file,
    and, when the loader really raised on some state of this file as it stands (`raised`), for any name of a file that holds a NUL: the NUL
    may sit on another line of the same quoted statement, or in a statement before it. A loader error alone excuses nothing. And a name the
    service slot already has: a line that sets it to the value it already holds changes nothing the loader can show, while the gate
    refuses the name (a DIFFERENT value is a violation, and a miss if the gate is silent). And a line break: an allowed name whose value
    holds one (`boundary`, from `boundary_names`) is refused whatever follows the break, because Hermes' line-by-line reader starts a new
    statement there while python-dotenv does not. Nothing else: a name that is not allowed is a violation wherever one of the readers
    sees it, and the gate reads the same names as they do, marks and all."""
    if "\x00" in name:
        return "NUL in the statement"
    texts = _readings_with_nuls(raw)
    for text in texts:
        if any(name in line and "\x00" in line for line in re.split(r"[\r\n]", text)):
            return "NUL in the statement"
    if raised and any("\x00" in text for text in texts):
        return "NUL in the statement"
    if name in SLOT_ENV:
        return "name the slot already has"
    if name in boundary:
        return "line break in an allowed value"
    return None


def boundary_names(lockgate, raw):
    """The allowed names that have a value with a line boundary in it, as python-dotenv reads `raw` in any text the loader may parse for it
    (`lockgate.env_texts`). `str.splitlines` is Python's own definition of a boundary, not the string the gate holds for it."""
    names = set()
    env_texts, assignments = getattr(lockgate, "env_texts", None), getattr(lockgate, "dotenv_assignments", None)
    if env_texts is None or assignments is None:  # a gate with no readings of its own (the offline plumbing tests') has no such reason
        return names
    for text in env_texts(raw) or []:
        for name, value in assignments(text):
            if value and value.splitlines() != [value] and (name in SECRETS or name in SEEDED):
                names.add(name)
    return names


def compare(raw, violated, problems, raised=False, boundary=()):
    """{"file_refused", "missed", "needless": [(name, reason)]}: see the module docstring. A gate that refuses the file as a whole (not
    UTF-8, unreadable, unparsable, never settling) has nothing left to miss. `raised`, `boundary`: see `explain`."""
    names, file_level = named(problems, violated)
    if file_level:
        return {"file_refused": True, "missed": [], "needless": []}
    return {"file_refused": False, "missed": sorted(violated - names),
            "needless": [(name, explain(raw, name, raised, boundary) or "unexplained") for name in sorted(names - violated)]}


# --- the environment of the loader ---------------------------------------------------------------------------------------------
# What the Hermes gateway process has: the service slot's run script exports these before it execs Hermes (hermes_cli/service_manager.py),
# on top of the container's environment. A value a `.env` line could write by accident is avoided on purpose: a line that sets a name to
# the value it already has changes nothing the loader can show.
SLOT_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/opt/data", "HERMES_HOME": "/opt/data", "SOME_SET_VAR": "set",
            "HERMES_SUPERVISED_CHILD": "1", "HERMES_S6_SUPERVISED_CHILD": "1", "API_SERVER_KEY": "z" * 40}

LOAD_CAP = 64  # loads of one file the oracle follows beyond the first: the gate follows `lockgate.ENV_LOAD_CAP` rewrites, so this reaches what it accepts
CLEANUP_STEP = "_sanitize_env_file_if_needed"  # the loader's clean-up of the file before it parses it: the one step switched off to load a file as it stands


@contextlib.contextmanager
def cleanup_switched(env_loader, on):
    """With `on` False the loader's clean-up does nothing and the loader parses the file exactly as it stands: what it does with a
    file the clean-up leaves alone, or cannot write back (read-only folder, no space). A loader without that step has nothing to switch off."""
    if on or not hasattr(env_loader, CLEANUP_STEP):
        yield
        return
    with mock.patch.object(env_loader, CLEANUP_STEP, new=lambda *args, **kwargs: None):
        yield


def hermes_load(env_loader, raw, slot_env=None, cleanup=True):
    """(what the load changed in the environment, the bytes it leaves in the file, the name of the error it raised or None), loading a COPY
    of `raw` with `env_loader.load_hermes_dotenv` as `<home>/.env`. `os.environ` is replaced for the call and put back after it, and the
    loader's own record of earlier passes is cleared, so one case never sees another's output. External secret sources are off and its
    managed-scope folder is an empty one: the file under test is the only `.env` there is. What comes back is the names the load added or
    changed (a name set to the value it already had is not visible: the shapes avoid that). `cleanup=False`: see `cleanup_switched`."""
    slot_env = SLOT_ENV if slot_env is None else slot_env
    with tempfile.TemporaryDirectory(prefix="oort-env-oracle-home-") as home, tempfile.TemporaryDirectory(prefix="oort-env-oracle-managed-") as managed:
        path = os.path.join(home, ".env")
        with open(path, "wb") as handle:
            handle.write(raw)
        saved = dict(os.environ)
        error = None
        try:
            os.environ.clear()
            os.environ.update(slot_env)
            os.environ["HERMES_MANAGED_DIR"] = managed
            for record in ("_DOTENV_PUBLISHED", "_LOADED_DOTENV_KEYS", "_MANAGED_DOTENV_KEYS"):
                getattr(env_loader, record, {}).clear()
            try:
                with cleanup_switched(env_loader, cleanup):
                    env_loader.load_hermes_dotenv(hermes_home=home, load_external_secrets=False)
            except BaseException as exc:  # a file Hermes cannot load: whatever it applied before is still what it applied
                error = type(exc).__name__
            baseline = {**slot_env, "HERMES_MANAGED_DIR": managed}
            applied = {name: value for name, value in os.environ.items() if baseline.get(name) != value}
        finally:
            os.environ.clear()
            os.environ.update(saved)
        with open(path, "rb") as handle:
            left = handle.read()
    return applied, left, error


def hermes_chain(env_loader, raw, slot_env=None, cap=LOAD_CAP):
    """The loads Hermes makes of one file, each in a fresh process (`hermes_load`), following the file until a load leaves it as it was:
    {"states": [the file before load 1, before load 2, ...], "loads": [the environment each load ended with], "error": the name of the
    error a load raised, or None, "settled": whether a load left the file as it was within `cap` + 1 loads}. `states[i]` is the file load
    `i` + 1 was given."""
    states, loads, current = [raw], [], raw
    for _ in range(cap + 1):
        applied, left, error = hermes_load(env_loader, current, slot_env)
        if error:
            return {"states": states, "loads": loads, "error": error, "settled": False}
        loads.append(applied)
        if left == current:
            return {"states": states, "loads": loads, "error": None, "settled": True}
        states.append(left)
        current = left
    return {"states": states, "loads": loads, "error": None, "settled": False}


def line_reader_of(load_env_file):
    """A `line_reader` for `run` from the image's own `agent.secret_scope.load_env_file`: `raw` bytes -> the `{name: value}` it reads from
    a file holding them (a file of its own each time, so the reader's per-path memo never answers for another input)."""
    def read(raw):
        with tempfile.TemporaryDirectory(prefix="oort-env-oracle-line-") as tmp:
            path = os.path.join(tmp, ".env")
            with open(path, "wb") as handle:
                handle.write(raw)
            return dict(load_env_file(pathlib.Path(path)))
    return read


def line_violations(line_reader, raw):
    """The names the line-by-line reader yields for a file holding `raw` that the volume's `.env` may not set (the in-image scenarios record
    this next to the loader's verdict)."""
    return violations(line_reader(raw))


def gate_view(lockgate, raw):
    """The problems the gate gives a volume whose `.env` holds `raw`, exactly as `gate()` and `report()` ask: `volume_env_problems`."""
    with tempfile.TemporaryDirectory(prefix="oort-env-oracle-gate-") as tmp:
        path = os.path.join(tmp, ".env")
        with open(path, "wb") as handle:
            handle.write(raw)
        return lockgate.volume_env_problems(path)


# What a table label promises about the loader. `run` checks the promise against the loader's own result, so a row cannot rot: an
# "applied" row the loader no longer applies, or an "inert" one it does, is `wrong_labels`, not a quiet pass. "first": the first load
# applies it. "later": the first load does not, a later one does. "as it stands": no load does, the file read as it stands does.
# "line only": no load and no file as it stands applies it, the line-by-line reader of the file does (a promise only a run with a
# `line_reader` can check). "never": nothing does (the name is not applied, or the policy allows it).
CLAIMS = (("applied:", "first"), ("mark applied:", "first"), ("later applied:", "later"), ("as-is applied:", "as it stands"),
          ("line-read:", "line only"), ("inert:", "never"), ("clean:", "never"))


def claim_of(label):
    for prefix, claim in CLAIMS:
        if label.startswith(prefix):
            return claim
    return None


def claim_holds(claim, first, loaded, as_stands, line=()):
    """Whether `claim` is true of what the first load (`first`), all loads (`loaded`), the files read as they stand (`as_stands`) and the
    line-by-line reader of those files (`line`) applied."""
    return {"first": bool(first), "later": not first and bool(loaded), "as it stands": not loaded and bool(as_stands),
            "line only": not loaded and not as_stands and bool(line), "never": not loaded and not as_stands and not line}[claim]


def run(env_loader, lockgate, cases, slot_env=None, examples=6, line_reader=None):
    """Compare the gate with the loader on every `(label, raw)` of `cases`. The summary is JSON-able. `ok` is the verdict: no miss (`missed`
    on what the first load, the file as it stands or the line-by-line reader on the original file applies, `missed_after` on the rest),
    nothing unexplained, no table label the readers contradict, no file whose chain the gate's model gets wrong (`chain_mismatch`), none
    that the gate accepts and the loader never settles (`unsettled`), no file on which the gate's copy of the line-by-line reader differs
    from the real one (`line_reader_mismatch`). `line_reader`: `raw` bytes -> `{name: value}` of the real line-by-line tokenizer
    (`line_reader_of`); without one the run compares the loader only. The other counts are for the caller's positive controls (a
    comparison of nothing against nothing passes): `line_reader_only` (what only the line-by-line reader saw), `line_states_compared`
    (files on which the gate's copy of that reader was held to the real one),
    `violating` cases (some load, or the file as it stands, applied something forbidden), `clean` ones (nothing forbidden and the gate said
    nothing), `later_only` (what only a later load, or a later file as it stands, applied), `as_stands_only` (what only the files read as
    they stand applied), `states_compared` (chains the gate's model was held to), `loads` (how many loads the chains took) and `detected`
    (the names of `JUDGED_KEYS` that were violated and named at least once). Examples are capped."""
    kinds = ("missed", "missed_after", "unexplained", "wrong_labels", "chain_mismatch", "unsettled", "line_reader_mismatch")
    summary = {"cases": 0, "hermes_errors": 0, "as_stands_errors": 0, "violating": 0, "clean": 0, "file_refused": 0, "later_only": 0,
               "as_stands_only": 0, "line_reader_only": 0, "line_states_compared": 0, "line_reader": line_reader is not None,
               "states_compared": 0, "loads": {}, "needless": {}, "detected": set(), "load_cap": LOAD_CAP,
               "cleanup_step_found": hasattr(env_loader, CLEANUP_STEP), "examples": {kind: [] for kind in kinds}}
    summary.update({kind: 0 for kind in kinds})
    model = getattr(lockgate, "env_states", None)
    line_model, line_text = getattr(lockgate, "line_assignments", None), getattr(lockgate, "env_loaded_text", None)
    own = loader_own_names(env_loader, slot_env)
    summary["loader_own_names"] = len(own)

    def keep(kind, label, raw, *extra):
        if len(summary["examples"][kind]) < examples:
            summary["examples"][kind].append([label, repr(raw)[:160]] + list(extra))

    for label, raw in cases:
        summary["cases"] += 1
        chain = hermes_chain(env_loader, raw, slot_env)
        problems = gate_view(lockgate, raw)
        names, file_level = named(problems)
        if chain["error"]:
            summary["hermes_errors"] += 1
            if line_reader is not None and not file_level:  # the loader stopped; the line-by-line reader reads the file all the same
                seen = set().union(*(violations(line_reader(state)) for state in chain["states"]))
                if seen - named(problems, seen)[0]:
                    summary["missed"] += 1
                    keep("missed", label, raw, sorted(seen - named(problems, seen)[0]))
            continue
        if not chain["settled"]:  # Hermes keeps changing the file: the gate has to refuse it as a whole, it cannot be proven otherwise
            if file_level:
                summary["file_refused"] += 1
            else:
                summary["unsettled"] += 1
                keep("unsettled", label, raw, len(chain["loads"]))
            continue
        states = chain["states"]
        loaded = [violations(applied, own) for applied in chain["loads"]]
        as_stands, raised = [], False
        for state in states:
            applied, _left, error = hermes_load(env_loader, state, slot_env, cleanup=False)
            summary["as_stands_errors"] += bool(error)  # what it applied before it stopped still counts
            raised = raised or bool(error)
            as_stands.append(violations(applied, own))
        summary["loads"][str(len(loaded))] = summary["loads"].get(str(len(loaded)), 0) + 1
        line_reads, port_differs = [set() for _ in states], False
        if line_reader is not None:  # the second reader sees each file of the chain as it stands, the first one too
            reads = [line_reader(state) for state in states]
            line_reads = [violations(read) for read in reads]
            if line_model is not None and line_text is not None:  # the gate's copy of the reader has to read what the real one reads
                summary["line_states_compared"] += len(states)
                port_differs = any(line_model(line_text(state)) != read for state, read in zip(states, reads))
        if port_differs:
            summary["line_reader_mismatch"] += 1
            keep("line_reader_mismatch", label, raw)
        ever_loaded, ever_as_stands, ever_line = set().union(*loaded), set().union(*as_stands), set().union(*line_reads)
        violated, first = ever_loaded | ever_as_stands | ever_line, loaded[0] | as_stands[0] | line_reads[0]
        names = named(problems, violated)[0]
        claim = claim_of(label)
        if claim == "line only" and line_reader is None:
            claim = None  # a promise about the line-by-line reader needs the reader to be checked
        if claim is not None and not claim_holds(claim, loaded[0], ever_loaded, ever_as_stands, ever_line):
            summary["wrong_labels"] += 1
            keep("wrong_labels", label, raw, sorted(violated))
        verdict = compare(raw, violated, problems, raised, boundary_names(lockgate, raw) if names - violated else ())
        summary["file_refused"] += verdict["file_refused"]
        if violated:
            summary["violating"] += 1
        elif not problems:
            summary["clean"] += 1
        summary["later_only"] += bool(violated - first)
        summary["as_stands_only"] += bool(ever_as_stands - ever_loaded)
        summary["line_reader_only"] += bool(ever_line - ever_loaded - ever_as_stands)
        if model is not None:  # the gate's own model of the clean-up has to produce the files the loader produced
            modelled = model(raw)
            if modelled is not None:
                summary["states_compared"] += 1
                if modelled != states:
                    summary["chain_mismatch"] += 1
                    keep("chain_mismatch", label, raw, len(modelled), len(states))
        if verdict["file_refused"]:
            continue
        if first - names:
            summary["missed"] += 1
            keep("missed", label, raw, sorted(first - names))
        later_missed = sorted((violated - first) - names)
        for index in range(1, len(states)):  # the file Hermes leaves behind after `index` loads: what `report` and the next boot read
            names_here, file_level_here = named(gate_view(lockgate, states[index]), violated)
            ahead = set().union(*loaded[index:], *as_stands[index:], *line_reads[index:])
            if not file_level_here and ahead - names_here:
                later_missed.append("%s (file after %d loads)" % (",".join(sorted(ahead - names_here)), index))
        if later_missed:
            summary["missed_after"] += 1
            keep("missed_after", label, raw, later_missed)
        for name, why in verdict["needless"]:
            summary["needless"][why] = summary["needless"].get(why, 0) + 1
            if why == "unexplained":
                summary["unexplained"] += 1
                keep("unexplained", label, raw, name)
        summary["detected"].update(name for name in violated & names if name in JUDGED_KEYS)
    summary["detected"] = sorted(summary["detected"])
    summary["ok"] = not any(summary[kind] for kind in kinds)
    return summary


# --- the inputs -----------------------------------------------------------------------------------------------------------------
# Names the volume's `.env` may NOT set, each with a value and another one. The first twelve were judged by their value before #4950 and
# get every spelling below; the rest are names that were never judged (siblings of the first twelve, names that look like an allowed one,
# names the loader reads from its own environment) and get the plain spellings. The list has no end: that is why the policy is an allow-list.
FORBIDDEN_FULL = (
    ("HERMES_YOLO_MODE", "1", "0"), ("HERMES_DASHBOARD", "true", "false"), ("HERMES_ALLOW_PRIVATE_URLS", "yes", "no"),
    ("HERMES_SAFE_MODE", "on", "off"), ("HERMES_ENABLE_PROJECT_PLUGINS", "1", "0"), ("API_SERVER_CORS_ORIGINS", "https://evil.example", ""),
    ("API_SERVER_KEY", "t" * 12, "k" * 40),  # built, not spelled out: no scanner takes a fixture for a credential
    ("FAL_KEY", "f" * 12, ""), ("HTTPS_PROXY", "http://proxy.example:3128", ""), ("all_proxy", "socks5://proxy.example:1080", ""),
    ("OORT_SELF_MEDIA_ORIGIN", "https://oort.example.com", "x"), ("HERMES_MEDIA_DELIVERY_STRICT", "0", "1"),
)
FORBIDDEN_PLAIN = (
    ("HERMES_MEDIA_ALLOW_DIRS", "/oort-oracle/none", ""), ("HERMES_MEDIA_TRUST_RECENT_SECONDS", "999999", "0"),
    ("HERMES_MANAGED_DIR", "/oort-oracle/none", ""), ("HERMES_HOME", "/oort-oracle/none", ""),
    ("GATEWAY_PROXY_URL", "https://relay.example", ""), ("GATEWAY_PROXY_KEY", "g" * 12, ""),
    ("OPENROUTER_API_KEY", "o" * 12, ""), ("ANTHROPIC_TOKEN", "a" * 12, ""), ("CLAUDE_CODE_OAUTH_TOKEN", "c" * 12, ""),
    ("OPENAI_BASE_URL", "https://llm.example/v1", ""), ("OPENAI_API_KEY_2", "o" * 12, ""), ("openai_api_key", "o" * 12, ""),
    ("PYTHONPATH", "/oort-oracle/none", ""), ("OORT_ORACLE_UNKNOWN", "1", "0"),
    ("GOOGLE_OAUTH_CLIENT_ID", "oort-oracle-id", ""), ("GOOGLE_OAUTH_CLIENT_SECRET", "s" * 12, ""),  # service variables: the volume may not set them
)
JUDGED_KEYS = frozenset(name for name, _value, _other in FORBIDDEN_FULL + FORBIDDEN_PLAIN)

# Spellings of one assignment: `{n}` the name, `{v}` its value, `{g}` another value. What the loader applies is a violation unless the
# policy allows the name (with that value).
APPLIED = (
    ("plain", "{n}={v}"),
    ("export", "export {n}={v}"),
    ("export, tab", "export\t{n}={v}"),
    ("inline comment", "{n}={v} # c"),
    ("double quotes", '{n}="{v}"'),
    ("single-quoted name", "'{n}'={v}"),
    ("blanks around the equals sign", "{n} = {v}"),
    ("another value first, this one last", "{n}={g}\n{n}={v}"),
    ("this value first, another one last", "{n}={v}\n{n}={g}"),
    ("after a multi-line quoted value", HELPER_NOTE + '="one\ntwo"\n{n}={v}'),
    ("NUL after the value", "{n}={v}\x00"),
    ("an empty value", "{n}="),
)
FINAL_IS_VALUE = {"plain", "export", "export, tab", "inline comment", "double quotes", "single-quoted name", "blanks around the equals sign",
                  "another value first, this one last", "after a multi-line quoted value", "NUL after the value"}
PLAIN_APPLIED = {"plain", "export", "double quotes", "single-quoted name", "this value first, another one last", "an empty value"}
# Spellings no reader sets anything for.
INERT = (
    ("comment line", "# {n}={v}"),
    ("bare name", "{n}"),
)
# Spellings python-dotenv (the loader) sets nothing for, but that Hermes' line-by-line reader reads as the assignment of `{n}`: a statement
# the loader cannot finish, a bare name that undoes an earlier line only for the loader, a statement inside a quoted value, a statement
# after a boundary that only the line-by-line reader cuts at (python-dotenv ends a line at CR and LF alone), the tail of a comment.
LINE_ONLY = (
    ("unterminated double quote", '{n}="{v}'),
    ("junk after the closing quote", '{n}="{v}" junk'),
    ("bare name after the assignment", "{n}={v}\n{n}"),
    ("inside a multi-line quoted value", HELPER_NOTE + '="one\n{n}={v}"'),
    ("after a form feed on the same line", HELPER_X + "=1\x0c{n}={v}"),
    ("after U+2028 on the same line", HELPER_X + "=1\u2028{n}={v}"),
    ("after NEL on the same line", HELPER_X + "=1\x85{n}={v}"),
    ("in the tail of a comment, after U+2029", HELPER_X + "=1 # c\u2029{n}={v}"),
)
# Spellings of `APPLIED` that python-dotenv reads as the name and the line-by-line reader reads as another key (it takes off `export ` with
# one blank only, and it keeps quotes around a name): for an allowed name the loader's side is clean and the other reader's is not.
LINE_KEY_DIFFERS = {"export, tab", "single-quoted name"}
# Values with a reference: the loader resolves them in the service slot's environment. The gate reads no value, so what they resolve to is
# not its business: the name is refused all the same.
REFERENCES = (
    ("an unset name", "{n}=${{OORT_ORACLE_UNSET}}"),
    ("an unset name with a default", "{n}=${{OORT_ORACLE_UNSET:-{v}}}"),
    ("a name only the service slot has", "{n}=${{HERMES_SUPERVISED_CHILD}}"),
    ("a name only the service slot has, without braces", "{n}=$HERMES_SUPERVISED_CHILD"),
    ("HOME, which the slot sets to the volume", "{n}=${{HOME}}"),
    ("a set name inside double quotes", '{n}="${{SOME_SET_VAR}}"'),
    ("single quotes", "{n}='${{OORT_ORACLE_UNSET:-{v}}}'"),
    ("unclosed", "{n}=${{"),
    ("an earlier line of the file", HELPER_LATER + "={v}\n{n}=${{" + HELPER_LATER + "}}"),
)
OTHER_VALUE = "q" * 7  # a value the policy allows for no seeded name; for a secret any value will do


def shape_cases(templates, kind, name, value, other, only=None):
    out = []
    for label, template in templates:
        if only is not None and label not in only:
            continue
        text = template.format(n=name, v=value, g=other)
        out.append(("%s: %s: %s" % (kind, name, label), (text + "\n").encode("utf-8")))
    return out


def byte_order_mark_shapes(line):
    """(applied, kept, control) lists of `(label, raw)` for one assignment `line` (text, no newline), measured against Hermes v0.22.2's
    real loader. `applied`: Hermes ends with the plain name (the marks in front are the ones its decoders strip: the sanitizer's, and
    the loader's second one after the clean-up rewrote the file). `kept`: a mark stays in the first name (nothing to rewrite, or one
    mark too many), so Hermes applies nothing under the plain name and the gate must not refuse it either: it reads the name with the
    mark in it. `control`: marks no reader strips (not at the front)."""
    body, trigger = (line + "\n").encode("utf-8"), b" OPENAI_API_KEY=1\n"  # a line with blanks around it: the clean-up changes it, so it rewrites
    plain = line.encode("utf-8")  # no final newline: the clean-up adds one, so it rewrites that way too
    applied = [
        ("one mark", BOM + body),
        ("two marks, a second line the clean-up rewrites", BOM + BOM + body + trigger),
        ("two marks, no final newline", BOM + BOM + plain),
        ("two marks, a blank, the name, rewritten", BOM + BOM + b" " + body + trigger),
        ("a mark, a blank, a mark", BOM + b" " + BOM + body),
        ("utf-16 with a mark, then a second mark", b"\xff\xfe" + (FEFF + line + "\n").encode("utf-16-le")),
        ("utf-16 big endian with a mark, then a second mark", b"\xfe\xff" + (FEFF + line + "\n").encode("utf-16-be")),
        # Marks left in front of the first name, then a statement the loader does not finish: measured on the real loader.
        ("marks left in front of an unfinished statement", BOM + BOM + BOM + b" " + HELPER_Q.encode() + b'="x\n' + body + b'"\n'),
    ]
    for label, blank in (("blank", b" "), ("tab", b"\t"), ("file separator", b"\x1c"), ("form feed", b"\x0c"),
                         ("NEL", "\x85".encode("utf-8")), ("U+2028", "\u2028".encode("utf-8")), ("no-break space", "\xa0".encode("utf-8"))):
        applied.append(("%s, then a mark" % label, blank + BOM + body))
    kept = [
        ("two marks, nothing to rewrite", BOM + BOM + body),
        ("three marks, a second line the clean-up rewrites", BOM + BOM + BOM + body + trigger),
        ("utf-16 with a mark, then two marks", b"\xff\xfe" + (FEFF + FEFF + line + "\n").encode("utf-16-le")),
    ]
    control = [
        ("a mark on the second line", b"OPENAI_API_KEY=1\n" + BOM + body),
        ("a blank line, then a mark", b"\n" + BOM + body),
    ]
    return applied, kept, control


FFFD = "\ufffd".encode("utf-8")  # a real U+FFFD as the first character: the loader's clean-up leaves such a file alone
QUOTE_LINE = b"\x00 " + HELPER_Q.encode() + b'="x\n'  # a line with a NUL and a quote that is never closed on it


def pair_run(blank, count):
    """`count` times (a blank, a byte order mark), as bytes."""
    return (blank + BOM) * count


def chain_shapes(line):
    """(later, skipped, as_stands) lists of `(label, raw)` for one assignment `line` (text, no newline), measured against Hermes
    v0.22.2's real loader, which loads the file more than once in its life. `later`: the first load applies nothing under the name, a
    later one does. `skipped`: the first character is U+FFFD, the clean-up leaves the file alone, and the first load applies the name.
    `as_stands`: only a load of the file as it stands applies the name (a clean-up that could not write its result back)."""
    body = (line + "\n").encode("utf-8")
    later = [("%d blank-and-mark pairs" % count, pair_run(b" ", count) + body) for count in (2, 3, 4, 8, 16)]
    later += [
        ("3 tab-and-mark pairs", pair_run(b"\t", 3) + body),
        ("3 file-separator-and-mark pairs", pair_run(b"\x1c", 3) + body),
        ("a mark, then 3 blank-and-mark pairs", BOM + pair_run(b" ", 3) + body),
        ("3 blank-and-mark pairs, a second line the clean-up rewrites", pair_run(b" ", 3) + body + b" OPENAI_API_KEY=1\n"),
        ("utf-16 with 3 blank-and-mark pairs", b"\xff\xfe" + ((" " + FEFF) * 3 + line + "\n").encode("utf-16-le")),
        ("utf-16 big endian with 4 blank-and-mark pairs", b"\xfe\xff" + ((" " + FEFF) * 4 + line + "\n").encode("utf-16-be")),
    ]
    skipped = [
        ("first character U+FFFD, a NUL line, an open quote", FFFD + b"\n" + QUOTE_LINE + body + b'"\n'),
        ("a mark, U+FFFD, a NUL line, an open quote", BOM + FFFD + b"\n" + QUOTE_LINE + body + b'"\n'),
        ("first character U+FFFD, a blank, a NUL line, an open quote", FFFD + b" \n" + QUOTE_LINE + body + b'"\n'),
        ("first character U+FFFD, the assignment on the next line", FFFD + b"\n" + body),
    ]
    as_stands = [
        ("a NUL line and an open quote", b"OPENAI_API_KEY=1\n" + QUOTE_LINE + body + b'"\n'),
        ("a NUL line and an open quote, a blank before the name", b"OPENAI_API_KEY=1\n" + QUOTE_LINE + b" " + body + b'"\n'),
    ]
    return later, skipped, as_stands


def table_cases():
    """The named inputs: for the names the policy forbids, the spellings Hermes applies and ignores, references, byte order marks, the loads
    that come after the first, and the files its clean-up leaves alone or cannot write; for the names it allows, the same spellings, which
    must all stay silent; for the seeded names, their value and any other."""
    cases = []
    for name, value, other in FORBIDDEN_FULL:
        cases += shape_cases(APPLIED, "applied", name, value, other) + shape_cases(INERT, "inert", name, value, other)
        cases += shape_cases(LINE_ONLY, "line-read", name, value, other)
        cases += shape_cases(REFERENCES, "applied", name, value, other)
        marks, kept, control = byte_order_mark_shapes("%s=%s" % (name, value))
        later, skipped, as_stands = chain_shapes("%s=%s" % (name, value))
        # A mark that stays in a name makes it another name, which the policy does not allow either: a file whose first load leaves a mark
        # in the name violates at once, under that other name (the `kept` and `control` rows, and the two-pair row of `later`). The other
        # `later` rows lose their statement in the first load and apply the plain name only in a later one.
        first_marks = [row for row in later if row[0].startswith("2 ")]
        # a statement python-dotenv never finishes but the line-by-line reader reads: behind marks and blanks it shows the plain name in the files
        # of a LATER load only, to that reader alone
        cases.extend(("line-read: %s: %s" % (name, label), raw) for label, raw in chain_shapes('%s="%s' % (name, value))[0])
        for kind, shapes in (("mark applied", marks + kept + control + first_marks),
                             ("later applied", [row for row in later if not row[0].startswith("2 ")]), ("applied", skipped),
                             ("as-is applied", as_stands)):
            cases.extend(("%s: %s: %s" % (kind, name, label), raw) for label, raw in shapes)
    for name, value, other in FORBIDDEN_PLAIN:
        cases += shape_cases(APPLIED, "applied", name, value, other, only=PLAIN_APPLIED)
        cases += shape_cases(INERT, "inert", name, value, other)
        cases += shape_cases(LINE_ONLY, "line-read", name, value, other, only={"unterminated double quote", "bare name after the assignment",
                                                                              "inside a multi-line quoted value", "after a form feed on the same line"})
    for name in SECRETS:
        value = "s" * 12
        cases += shape_cases(APPLIED, "clean", name, value, OTHER_VALUE, only={label for label, _t in APPLIED} - LINE_KEY_DIFFERS)
        cases += shape_cases(APPLIED, "line-read", name, value, OTHER_VALUE, only=LINE_KEY_DIFFERS)
        cases += shape_cases(INERT, "clean", name, value, OTHER_VALUE) + shape_cases(LINE_ONLY, "clean", name, value, OTHER_VALUE)
    for name, value in SEEDED.items():
        # the seeded value is the one that stays; a NUL after it is part of the value for the line-by-line reader (the loader cannot export it)
        cases += shape_cases(APPLIED, "clean", name, value, OTHER_VALUE, only=FINAL_IS_VALUE - LINE_KEY_DIFFERS - {"NUL after the value"})
        cases += shape_cases(APPLIED, "line-read", name, value, OTHER_VALUE, only=LINE_KEY_DIFFERS | {"NUL after the value"})
        cases += shape_cases(INERT, "clean", name, value, OTHER_VALUE)
        cases += shape_cases(APPLIED, "applied", name, OTHER_VALUE, value, only=FINAL_IS_VALUE | {"an empty value"})  # any other value
    seeded_file = "# Hermes' own first-boot template\n\n" + "".join("%s=%s\n" % item for item in SEEDED.items())
    cases.append(("clean: the seeded template as Hermes' first boot writes it", seeded_file.encode("utf-8")))
    cases.append(("clean: the seeded template and the allowed secrets", (seeded_file + "".join("%s=%s\n" % (n, "s" * 12) for n in SECRETS)).encode("utf-8")))
    cases.append(("applied: the seeded template and one other name", (seeded_file + "OPENROUTER_API_KEY=%s\n" % ("o" * 12)).encode("utf-8")))
    cases.append(("clean: nothing in the file", b""))
    cases.append(("clean: only comments", b"# one\n  # two\n\n"))
    # at the edge of what the oracle follows: a file that settles in the last load it makes (the gate must name what it applies), and files
    # that are still changing after it (the gate must refuse the file as a whole, whatever it holds)
    for count, kind, tail in ((LOAD_CAP, "later applied", b"HERMES_SAFE_MODE=on\n"), (LOAD_CAP + 1, "unbounded", b"HERMES_SAFE_MODE=on\n"),
                              (LOAD_CAP + 6, "unbounded", b"%s=1\n" % HELPER_X.encode())):
        cases.append(("%s: %d blank-and-mark pairs, at the load cap" % (kind, count), pair_run(b" ", count) + tail))
    return cases


_PREFIXES = ("", "", "", "export ", "export\t", " ", "\t", "#", "# ", "\x0c", "\x85", "\x1c", "\u2028", "\u2029", "\x1d", FEFF, " " + FEFF, "\t" + FEFF, FEFF + FEFF,
             (" " + FEFF) * 3, ("\t" + FEFF) * 3, ("\x1c" + FEFF) * 4)  # runs of (blank, mark)
_SEPARATORS = ("=", "=", "=", " = ", "= ", " =", "==", "\t=\t", " ")
_ENDS = ("\n", "\n", "\n", "\r\n", "\r", "", " ", "\n\n", " \n", "\\\n", "\n#\n", "\x0b", "\x0c", "\x85", "\u2028", "\u2029", "\x1d", "\x1e",
         " # c\u2028", " # c\x0b")  # the last ones: a boundary only the line-by-line reader cuts at, in or after a comment
_VALUES = ("1", "true", "yes", "on", "0", "false", "no", "off", "", " 1 ", "'1'", '"1"', "1 # c", "1#c", "'1' # c", '"1" x', "'1", '"1',
           "https://evil.example", "http://proxy.example:3128", "t" * 12, "k" * 40, "x" * 33, "f" * 12, "a\\nb", "\\", "1\\",
           "${OORT_ORACLE_UNSET:-1}", "${OORT_ORACLE_UNSET}", "${SOME_SET_VAR}", "${HERMES_SUPERVISED_CHILD}", "${HERMES_SUPERVISED_CHILD:-0}",
           "${HOME}", "$OORT_ORACLE_A", "$HERMES_SUPERVISED_CHILD", "x${OORT_ORACLE_UNSET:-1}y", "${", "${}", "}", "$", "$1")
_NOISE_NAMES = ("OORT_ORACLE_A", "OORT_ORACLE_B", "NO_PROXY", "OPENROUTER_API_KEY")  # names the policy does not allow either


_BLANKS = (" ", "\t", "\x1c", "\x0c", "\x85", "\xa0", "\u2028")
_CLEAN_VALUES = ("1", "abc123", "", "'quoted'", '"quoted"', "a b c", "x" * 40, "${OORT_ORACLE_UNSET}", "$HOME", "\xe9")  # any value of an allowed secret


def clean_file(rnd):
    """A file of allowed names only, in the spellings an operator writes (blanks, `export `, comments, a mark in front, any line end): the
    gate has to accept it, so a gate that refuses everything fails on these."""
    lines = []
    for _ in range(rnd.randint(1, 6)):
        if rnd.random() < 0.15:
            lines.append(rnd.choice(["", "# a note", "  # indented", "# OORT_ORACLE_A=1"]))
            continue
        name = rnd.choice(list(SECRETS) + list(SEEDED))
        value = SEEDED[name] if name in SEEDED else rnd.choice(_CLEAN_VALUES)
        lines.append(rnd.choice(("", "", "export ", " ", "\t")) + name + rnd.choice(("=", "=", " = ", "= ", " =")) + value + rnd.choice(("", "", " ", " # c")))
    newline = rnd.choice(("\n", "\n", "\r\n", "\r"))
    return rnd.choice((b"", b"", BOM)) + (newline.join(lines) + rnd.choice(("", newline))).encode("utf-8")


def random_cases(seed, count):
    """`count` seeded random `.env` inputs. The alphabet has what the reviews found missing from the earlier ones: U+FEFF in front of a
    name (alone, behind blanks, doubled, in runs of (blank, mark) three to nine long), U+FFFD as the first character, a NUL line next to
    a quote that is never closed, `${...}` / `$NAME` in values, a line the loader's clean-up rewrites, and the encodings (marks, UTF-16
    with and without a mark, bytes that are not UTF-8), and the boundaries only the line-by-line reader cuts at (U+2028, U+2029, NEL, VT,
    FF, FS/GS/RS), also after a comment. Three kinds of case: about one in five is `clean_file` (allowed names in plain spellings, which the
    gate has to accept), of the rest about two in five are written from the names the policy allows in the full alphabet (so that some
    stay clean and the comparison is not one of refusals only), the others mix in the names it does not."""
    rnd = random.Random(seed)
    forbidden = [name for name, _v, _g in FORBIDDEN_FULL + FORBIDDEN_PLAIN] + list(_NOISE_NAMES)
    allowed = list(SECRETS) + list(SEEDED)
    out = []
    for index in range(count):
        if rnd.random() < 0.18:  # a file the gate has to accept
            out.append(("random %d/%d" % (seed, index), clean_file(rnd)))
            continue
        statements = []
        allowed_only = rnd.random() < 0.4
        for _ in range(rnd.randint(1, 5)):
            if allowed_only or rnd.random() < 0.25:
                name = rnd.choice(allowed)
                value = SEEDED[name] if name in SEEDED and rnd.random() < 0.85 else rnd.choice(_VALUES)
            else:
                name, value = rnd.choice(forbidden), rnd.choice(_VALUES)
            if rnd.random() < 0.08:
                name = "'%s'" % name if rnd.random() < 0.5 else name + " "
            statements.append(rnd.choice(_PREFIXES) + name + rnd.choice(_SEPARATORS) + value + rnd.choice(_ENDS))
        if rnd.random() < 0.25:
            statements.insert(rnd.randint(0, len(statements)), " %s=1\n" % HELPER_X)
        if rnd.random() < 0.08:
            statements.insert(rnd.randint(0, len(statements)), rnd.choice(["\x00", "'", '"', "\\", "\n", "#", " "]))
        if rnd.random() < 0.10:  # a NUL line and a quote that is never closed on it, the statements after it, maybe a quote that closes
            at = rnd.randint(0, len(statements))
            statements.insert(at, rnd.choice(["\x00 %s=\"x\n" % HELPER_Q, "\x00 %s='x\n" % HELPER_Q, "\x00 \"\n", "X=1\x00 Q=\"x\n"]))
            if rnd.random() < 0.6:
                statements.insert(rnd.randint(at + 1, len(statements)), rnd.choice(['"\n', "'\n", 'x"\n']))
        text = "".join(statements)
        if rnd.random() < 0.08:  # a run of (blank, mark) pairs in front of everything
            text = (rnd.choice(_BLANKS) + FEFF) * rnd.randint(3, 9) + text
        if rnd.random() < 0.10:  # U+FFFD as the first character: the clean-up leaves the file alone
            text = "\ufffd" + rnd.choice(["", "\n", " \n", " ", "=", "\x00\n"]) + text
        mode = rnd.random()
        if mode < 0.58:
            raw = text.encode("utf-8")
        elif mode < 0.66:
            raw = BOM + text.encode("utf-8")
        elif mode < 0.74:
            raw = BOM + BOM + text.encode("utf-8")
        elif mode < 0.77:
            raw = BOM + BOM + BOM + text.encode("utf-8")
        elif mode < 0.82:
            raw = b"\xff\xfe" + text.encode("utf-16-le")
        elif mode < 0.86:
            raw = b"\xff\xfe" + (FEFF + text).encode("utf-16-le")
        elif mode < 0.89:
            raw = b"\xfe\xff" + (FEFF + text).encode("utf-16-be")
        elif mode < 0.95:
            raw = text.encode("utf-16-le")  # no mark: NUL padded ASCII
        else:
            raw = text.encode("latin-1", "replace") + (b"\xe9" if rnd.random() < 0.5 else b"")
        out.append(("random %d/%d" % (seed, index), raw))
    return out
