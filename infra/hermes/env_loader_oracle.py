"""A differential oracle for how lockgate.py reads the volume's `.env` (#4886 security review). Python 3, stdlib only.

The question is not "does the gate give the answer its author expected" but "does the gate refuse what Hermes' REAL loader applies".
For one `.env` (raw bytes), `run` does both and compares them on the judged names only:

    Hermes   `hermes_cli.env_loader.load_hermes_dotenv` on a copy of the file, in an environment shaped like the service slot Hermes
             runs in (it has variables the gate's own shell does not, which is what a `${...}` reference can resolve to). The names
             it ends with a forbidden value for are `violated`. It rewrites its copy in place; the result is kept for `after`.
    gate     `volume_env_problems` + `image_volume_env_problems` on ANOTHER copy of the original bytes, in the gate's own environment.
    missed   violated, but no gate problem names it. The unsafe direction: there must be none.
    needless a gate problem names it, but it is not violated. Allowed only for the documented reasons that make the gate refuse MORE
             than Hermes applies (`explain`). Anything else is `unexplained`: that is what keeps "the gate reads the file the way
             Hermes does" true, and what stops a gate that refuses everything from passing.
    after    the file as Hermes leaves it (it rewrites it, and each load drops a mark more, so it is not the same file) is loaded by Hermes
             AGAIN, and the gate must name what that second load applies: the file `report` reads after the start, and the next boot.

This module has no Hermes and no gate in it: `run` is given both. test_lockgate_env.py tests the plain functions offline, and the
in-image proof (scripts/tests/fixtures/hermes_image_guard_inimage.py, scenario `env-loader-oracle`) passes the image's own
`hermes_cli.env_loader`. The policy below spells the judged names out on purpose and does not read them from lockgate.py: a name
the gate stops judging has to show up here as a miss.
"""
import os
import random
import re
import tempfile

BOM = b"\xef\xbb\xbf"
FEFF = "\ufeff"

# --- what the policy forbids, in the environment Hermes ends up with -----------------------------------------------------------
FLAG_NAMES = ("HERMES_YOLO_MODE", "HERMES_DASHBOARD", "HERMES_ALLOW_PRIVATE_URLS", "HERMES_SAFE_MODE", "HERMES_ENABLE_PROJECT_PLUGINS")
TRUTHY = ("1", "true", "yes", "on")
PRESENT_NAMES = ("OORT_SELF_MEDIA_ORIGIN", "HERMES_MEDIA_DELIVERY_STRICT")  # the volume's .env may not set them at all
PROXY = "*_PROXY"  # the key `detected` uses for every proxy spelling
JUDGED_KEYS = frozenset(FLAG_NAMES + PRESENT_NAMES + ("API_SERVER_CORS_ORIGINS", "API_SERVER_KEY", "FAL_KEY", PROXY))


def violations(env):
    """The judged names `env` (the environment Hermes ended up with) holds a forbidden value for."""
    out = set()
    for name in FLAG_NAMES:
        if str(env.get(name, "")).strip().lower() in TRUTHY:
            out.add(name)
    if str(env.get("API_SERVER_CORS_ORIGINS", "")).strip():
        out.add("API_SERVER_CORS_ORIGINS")
    if "API_SERVER_KEY" in env and len(str(env["API_SERVER_KEY"]).strip()) < 32:
        out.add("API_SERVER_KEY")
    if str(env.get("FAL_KEY", "")).strip():
        out.add("FAL_KEY")
    for name, value in env.items():  # a name with a byte order mark in it is no proxy variable to any HTTP client
        upper = name.upper()
        if upper.endswith("_PROXY") and upper != "NO_PROXY" and FEFF not in name and str(value).strip():
            out.add(name)
    out.update(name for name in PRESENT_NAMES if name in env)
    return out


def key_of(name):
    return PROXY if name.upper().endswith("_PROXY") else name


# --- reading the gate's answer -------------------------------------------------------------------------------------------------
_PROBLEM_NAME_RE = re.compile(r"the volume's \.env (?:enables|sets(?: an)?) (\S+)")
_FILE_LEVEL = ("not valid UTF-8", "cannot parse", "cannot read")  # the gate refuses the whole file
_REFERENCE_RE = re.compile(r"\$(?:\{|[A-Za-z_])")


def named(problems):
    """(names the gate's problems refuse, whether it refused the file as a whole)."""
    names, file_level = set(), False
    for problem in problems:
        match = _PROBLEM_NAME_RE.match(problem)
        if match:
            names.add(match.group(1))
        elif any(marker in problem for marker in _FILE_LEVEL):
            file_level = True
    return names, file_level


def _text(raw):
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")) and not raw.startswith((b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff")):
        text = raw.decode("utf-16", "replace")
    else:
        text = raw.decode("utf-8", "replace")
        text = text[1:] if text.startswith(FEFF) else text  # one mark in front is the encoding's own: every reader strips it
    return text.replace("\x00", "")


def explain(raw, name):
    """Why the gate may refuse `name` although Hermes ends without a forbidden value for it, or None. Three reasons, all designed:
    a reference on a line that holds the name (the gate refuses the reference itself); a proxy name with a byte order mark inside
    it (the gate judges a `*_PROXY` by its ending, no HTTP client reads a variable with a mark in its name); and the two names the
    volume may not set at all, refused wherever an assignment stands, even one that a later bare `NAME` cancels. Nothing else:
    in particular no byte order mark anywhere else is an excuse, the gate reads those exactly as many as the loader does."""
    text = _text(raw)
    if any(name in line and _REFERENCE_RE.search(line) for line in re.split(r"[\r\n]", text)):
        return "reference"
    if FEFF in name and name.upper().endswith("_PROXY"):
        return "mark in a proxy name"
    if name in PRESENT_NAMES and re.search(re.escape(name) + r"'?\s*=", text):
        return "name-only rule"
    return None


def compare(raw, violated, problems):
    """{"file_refused", "missed", "needless": [(name, reason)]}: see the module docstring. A gate that refuses the file as a whole (not
    UTF-8, unreadable, unparsable) has nothing left to miss."""
    names, file_level = named(problems)
    if file_level:
        return {"file_refused": True, "missed": [], "needless": []}
    return {"file_refused": False, "missed": sorted(violated - names),
            "needless": [(name, explain(raw, name) or "unexplained") for name in sorted(names - violated)]}


# --- the two environments ------------------------------------------------------------------------------------------------------
# What the Hermes gateway process has: the service slot's run script exports these before it execs Hermes (hermes_cli/service_manager.py),
# on top of the container's environment. No judged name in it (the loader's change is then the whole picture) except a good key.
SLOT_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/opt/data", "HERMES_HOME": "/opt/data", "SOME_SET_VAR": "set",
            "HERMES_SUPERVISED_CHILD": "1", "HERMES_S6_SUPERVISED_CHILD": "1", "API_SERVER_KEY": "k" * 40}
# What the gate's own shell has: the same container without the slot's additions, and the HOME of whoever started the gate.
GATE_ENV = {name: value for name, value in SLOT_ENV.items() if name not in ("HERMES_SUPERVISED_CHILD", "HERMES_S6_SUPERVISED_CHILD")}
GATE_ENV["HOME"] = "/root"


def hermes_load(env_loader, raw, slot_env=None):
    """(the environment Hermes ends up with, the bytes it leaves in the file, the name of the error it raised or None), loading a COPY
    of `raw` with `env_loader.load_hermes_dotenv` as `<home>/.env`. `os.environ` is replaced for the call and put back after it, and the
    loader's own record of earlier passes is cleared, so one case never sees another's output. External secret sources are off and its
    managed-scope folder is an empty one: the file under test is the only `.env` there is."""
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
                env_loader.load_hermes_dotenv(hermes_home=home, load_external_secrets=False)
            except BaseException as exc:  # a file Hermes cannot load: whatever it applied before is still what it applied
                error = type(exc).__name__
            applied = dict(os.environ)
        finally:
            os.environ.clear()
            os.environ.update(saved)
        with open(path, "rb") as handle:
            left = handle.read()
    return applied, left, error


def gate_view(lockgate, raw, lookup_env=None):
    """The problems the gate gives a volume whose `.env` holds `raw`, exactly as `gate()` asks (`volume_env_problems` and, because
    the picture tool is exposed, `image_volume_env_problems`), in the gate's own environment."""
    lookup_env = GATE_ENV if lookup_env is None else lookup_env
    with tempfile.TemporaryDirectory(prefix="oort-env-oracle-gate-") as tmp:
        path = os.path.join(tmp, ".env")
        with open(path, "wb") as handle:
            handle.write(raw)
        return lockgate.volume_env_problems(path, dict(lookup_env)) + lockgate.image_volume_env_problems(path, dict(lookup_env))


# What a table label promises about the loader. `run` checks the promise against the loader's own result, so a row cannot rot: an
# "applied" row the loader no longer applies, or an "inert" one it does, is `wrong_labels`, not a quiet pass.
CLAIMS = (("applied:", True), ("mark applied:", True), ("inert:", False), ("mark kept:", False), ("mark control:", False))


def claim_of(label):
    for prefix, applied in CLAIMS:
        if label.startswith(prefix):
            return applied
    return None


def run(env_loader, lockgate, cases, slot_env=None, gate_env=None, examples=6):
    """Compare the gate with the loader on every `(label, raw)` of `cases`. The summary is JSON-able. `ok` is the verdict: no miss, no
    miss on the file the loader left behind (`missed_after`), nothing unexplained, no table label the loader contradicts. The other counts are for the
    caller's positive controls (a comparison of nothing against nothing passes): `violating` cases (the loader applied something
    forbidden), `clean` ones (nothing forbidden and the gate said nothing), and `detected` (the judged keys that were violated and
    named at least once). Examples are capped."""
    kinds = ("missed", "missed_after", "unexplained", "wrong_labels")
    summary = {"cases": 0, "hermes_errors": 0, "violating": 0, "clean": 0, "file_refused": 0, "needless": {}, "detected": set(),
               "examples": {kind: [] for kind in kinds}}
    summary.update({kind: 0 for kind in kinds})

    def keep(kind, label, raw, *extra):
        if len(summary["examples"][kind]) < examples:
            summary["examples"][kind].append([label, repr(raw)[:160]] + list(extra))

    for label, raw in cases:
        summary["cases"] += 1
        applied, left, error = hermes_load(env_loader, raw, slot_env)
        if error:
            summary["hermes_errors"] += 1
            continue
        violated = violations(applied)
        claim = claim_of(label)
        if claim is not None and claim != bool(violated):
            summary["wrong_labels"] += 1
            keep("wrong_labels", label, raw, sorted(violated))
        problems = gate_view(lockgate, raw, gate_env)
        verdict = compare(raw, violated, problems)
        summary["file_refused"] += verdict["file_refused"]
        if violated:
            summary["violating"] += 1
        elif not problems:
            summary["clean"] += 1
        if verdict["missed"]:
            summary["missed"] += 1
            keep("missed", label, raw, verdict["missed"])
        for name, why in verdict["needless"]:
            summary["needless"][why] = summary["needless"].get(why, 0) + 1
            if why == "unexplained":
                summary["unexplained"] += 1
                keep("unexplained", label, raw, name)
        if not verdict["file_refused"]:
            summary["detected"].update(key_of(name) for name in violated & named(problems)[0])
        again, _left_again, again_error = hermes_load(env_loader, left, slot_env)
        if not again_error:
            after = compare(left, violations(again), gate_view(lockgate, left, gate_env))
            if after["missed"] and not after["file_refused"]:
                summary["missed_after"] += 1
                keep("missed_after", label, raw, after["missed"], repr(left)[:160])
    summary["detected"] = sorted(summary["detected"])
    summary["ok"] = not any(summary[kind] for kind in kinds)
    return summary


# --- the inputs -----------------------------------------------------------------------------------------------------------------
# (name, a value Hermes applies that the policy forbids, a harmless value, or None when the name may not be set at all)
JUDGED = (
    ("HERMES_YOLO_MODE", "1", "0"),
    ("HERMES_DASHBOARD", "true", "false"),
    ("HERMES_ALLOW_PRIVATE_URLS", "yes", "no"),
    ("HERMES_SAFE_MODE", "on", "off"),
    ("HERMES_ENABLE_PROJECT_PLUGINS", "1", "0"),
    ("API_SERVER_CORS_ORIGINS", "https://evil.example", ""),
    ("API_SERVER_KEY", "t" * 12, "k" * 40),  # built, not spelled out: no scanner takes a fixture for a credential
    ("FAL_KEY", "f" * 12, ""),
    ("HTTPS_PROXY", "http://proxy.example:3128", ""),
    ("all_proxy", "socks5://proxy.example:1080", ""),
    ("OORT_SELF_MEDIA_ORIGIN", "https://oort.example.com", None),
    ("HERMES_MEDIA_DELIVERY_STRICT", "0", None),
)

# Spellings of one assignment: `{n}` the name, `{v}` a forbidden value, `{g}` a harmless one (templates that need it are skipped
# for the names without one).
APPLIED = (
    ("plain", "{n}={v}"),
    ("export", "export {n}={v}"),
    ("export, tab", "export\t{n}={v}"),
    ("inline comment", "{n}={v} # c"),
    ("double quotes", '{n}="{v}"'),
    ("single-quoted name", "'{n}'={v}"),
    ("blanks around the equals sign", "{n} = {v}"),
    ("harmless first, forbidden last", "{n}={g}\n{n}={v}"),
    ("after a multi-line quoted value", 'OORT_ORACLE_NOTE="one\ntwo"\n{n}={v}'),
    ("NUL after the value", "{n}={v}\x00"),
)
INERT = (
    ("comment line", "# {n}={v}"),
    ("unterminated double quote", '{n}="{v}'),
    ("bare name", "{n}"),
    ("bare name after the assignment", "{n}={v}\n{n}"),
    ("harmless value", "{n}={g}"),
    ("forbidden word only in a comment", "{n}={g} # {n}={v}"),
    ("forbidden first, harmless last", "{n}={v}\n{n}={g}"),
    ("inside a multi-line quoted value", 'OORT_ORACLE_NOTE="one\n{n}={v}"'),
)
# Values with a reference. The gate refuses these for the reference itself; what they resolve to is not its business (Hermes resolves
# them in the slot's environment, the gate would in its own, and `HERMES_SUPERVISED_CHILD` / HOME are the names that differ).
REFERENCES = (
    ("an unset name", "{n}=${{OORT_ORACLE_UNSET}}"),
    ("an unset name with a forbidden default", "{n}=${{OORT_ORACLE_UNSET:-{v}}}"),
    ("an unset name with a harmless default", "{n}=${{OORT_ORACLE_UNSET:-{g}}}"),
    ("a name only the service slot has, harmless default", "{n}=${{HERMES_SUPERVISED_CHILD:-{g}}}"),
    ("a name only the service slot has", "{n}=${{HERMES_SUPERVISED_CHILD}}"),
    ("a name only the service slot has, without braces", "{n}=$HERMES_SUPERVISED_CHILD"),
    ("HOME, which the slot sets to the volume", "{n}=${{HOME}}"),
    ("a set name inside double quotes", '{n}="${{SOME_SET_VAR}}"'),
    ("single quotes", "{n}='${{OORT_ORACLE_UNSET:-{v}}}'"),
    ("unclosed", "{n}=${{"),
    ("an earlier line of the file", "OORT_ORACLE_LATER={v}\n{n}=${{OORT_ORACLE_LATER}}"),
)


def shape_cases(templates, kind):
    out = []
    for name, value, good in JUDGED:
        for label, template in templates:
            if "{g}" in template and good is None:
                continue
            if label == "forbidden word only in a comment" and not good:
                continue  # `NAME= # ...` is the value `# ...` for python-dotenv: not empty, so it is no comment for a name that must be empty
            text = template.format(n=name, v=value, g=good)
            out.append(("%s: %s: %s" % (kind, name, label), (text + "\n").encode("utf-8")))
    return out


def byte_order_mark_shapes(line):
    """(applied, kept, control) lists of `(label, raw)` for one assignment `line` (text, no newline), measured against Hermes v0.22.2's
    real loader. `applied`: Hermes ends with the plain name (the marks in front are the ones its decoders strip: the sanitizer's, and
    the loader's second one after the clean-up rewrote the file). `kept`: a mark stays in the first name (nothing to rewrite, or one
    mark too many), so Hermes applies nothing under the plain name and the gate must not refuse it either: it reads the name with the
    mark in it. `control`: marks no reader strips (not at the front)."""
    body, trigger = (line + "\n").encode("utf-8"), b" OORT_ORACLE_X=1\n"  # a line with blanks around it: the clean-up changes it, so it rewrites
    plain = line.encode("utf-8")  # no final newline: the clean-up adds one, so it rewrites that way too
    applied = [
        ("one mark", BOM + body),
        ("two marks, a second line the clean-up rewrites", BOM + BOM + body + trigger),
        ("two marks, no final newline", BOM + BOM + plain),
        ("two marks, a blank, the name, rewritten", BOM + BOM + b" " + body + trigger),
        ("a mark, a blank, a mark", BOM + b" " + BOM + body),
        ("utf-16 with a mark, then a second mark", b"\xff\xfe" + (FEFF + line + "\n").encode("utf-16-le")),
        ("utf-16 big endian with a mark, then a second mark", b"\xfe\xff" + (FEFF + line + "\n").encode("utf-16-be")),
        # Marks that stay in front of the first name end that statement early for Hermes (it is dropped up to its line end), so the
        # next line is a statement of its own; a reader that dropped every mark would read an open quote there and swallow it.
        ("marks left in front move where the first statement ends", BOM + BOM + BOM + b" " + b'OORT_ORACLE_Q="x\n' + body + b'"\n'),
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
        ("a mark on the second line", b"OORT_ORACLE_X=1\n" + BOM + body),
        ("a blank line, then a mark", b"\n" + BOM + body),
    ]
    return applied, kept, control


def table_cases():
    """The named inputs, for every judged name: the spellings Hermes applies and ignores, references, and byte order marks."""
    cases = shape_cases(APPLIED, "applied") + shape_cases(INERT, "inert") + shape_cases(REFERENCES, "reference")
    for name, value, _good in JUDGED:
        applied, kept, control = byte_order_mark_shapes("%s=%s" % (name, value))
        for kind, shapes in (("mark applied", applied), ("mark kept", kept), ("mark control", control)):
            cases.extend(("%s: %s: %s" % (kind, name, label), raw) for label, raw in shapes)
    return cases


_PREFIXES = ("", "", "", "export ", "export\t", " ", "\t", "#", "# ", "\x0c", "\x85", "\x1c", FEFF, " " + FEFF, "\t" + FEFF, FEFF + FEFF)
_SEPARATORS = ("=", "=", "=", " = ", "= ", " =", "==", "\t=\t", " ")
_ENDS = ("\n", "\n", "\n", "\r\n", "\r", "", " ", "\n\n", " \n", "\\\n", "\n#\n", "\x0b", "\x0c", "\x85")
_VALUES = ("1", "true", "yes", "on", "0", "false", "no", "off", "", " 1 ", "'1'", '"1"', "1 # c", "1#c", "'1' # c", '"1" x', "'1", '"1',
           "https://evil.example", "http://proxy.example:3128", "t" * 12, "k" * 40, "x" * 33, "f" * 12, "a\\nb", "\\", "1\\",
           "${OORT_ORACLE_UNSET:-1}", "${OORT_ORACLE_UNSET}", "${SOME_SET_VAR}", "${HERMES_SUPERVISED_CHILD}", "${HERMES_SUPERVISED_CHILD:-0}",
           "${HOME}", "$OORT_ORACLE_A", "$HERMES_SUPERVISED_CHILD", "x${OORT_ORACLE_UNSET:-1}y", "${", "${}", "}", "$", "$1")
_NOISE_NAMES = ("OORT_ORACLE_A", "OORT_ORACLE_B", "NO_PROXY", "OPENROUTER_API_KEY")


def random_cases(seed, count):
    """`count` seeded random `.env` inputs. The alphabet has what a review found missing from the earlier ones: U+FEFF in front of a
    name (alone, behind blanks, doubled), `${...}` / `$NAME` in values, a line the loader's clean-up rewrites, and the encodings
    (marks, UTF-16 with and without a mark, bytes that are not UTF-8). Names without a mark inside values, so Hermes' ASCII-only
    clean-up of credentials never makes the oracle's own answer uncertain."""
    rnd = random.Random(seed)
    names = [name for name, _v, _g in JUDGED] + list(_NOISE_NAMES)
    out = []
    for index in range(count):
        statements = []
        for _ in range(rnd.randint(1, 5)):
            name = rnd.choice(names)
            if rnd.random() < 0.08:
                name = "'%s'" % name if rnd.random() < 0.5 else name + " "
            statements.append(rnd.choice(_PREFIXES) + name + rnd.choice(_SEPARATORS) + rnd.choice(_VALUES) + rnd.choice(_ENDS))
        if rnd.random() < 0.25:
            statements.insert(rnd.randint(0, len(statements)), " OORT_ORACLE_X=1\n")
        if rnd.random() < 0.08:
            statements.insert(rnd.randint(0, len(statements)), rnd.choice(["\x00", "'", '"', "\\", "\n", "#", " "]))
        text = "".join(statements)
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
