"""Offline tests for how lockgate.py reads the volume's `.env` (#4886, ADR-0203 D6 / I2):

    python3 -m unittest infra/hermes/test_lockgate_env.py -v

Hermes loads `<HERMES_HOME>/.env` after the gate ran: python-dotenv's parser with interpolation off, then its own `${VAR}`
resolution (hermes_cli/env_loader.py, v0.22.2). The gate reads the file the same way: the image's python-dotenv when it can be
imported, otherwise a fallback with the same grammar. This file holds the two to ONE table of inputs (`PARSE_TABLE`, measured on
python-dotenv==1.2.2, the version Hermes v0.22.2's uv.lock pins): the fallback has to reproduce every row everywhere, and the real
parser every row wherever it is installed. `OORT_REQUIRE_DOTENV=1` turns "python-dotenv is not installed" from a skip into a
failure; the in-image proof sets it (scripts/tests/test_hermes_image_guard_docker.sh), so there the comparison cannot be skipped.

Then the rules, through `volume_env_problems` / `image_volume_env_problems`, for each parser: every spelling the loader APPLIES is
refused once, by name, never with its value; every spelling it ignores is not; the last assignment of a name decides; a judged name
whose value holds a reference (`${...}`, `$NAME`) is refused for that, because Hermes resolves it in an environment the gate does
not have. The byte order marks at the front are read exactly as the loader strips them (its sanitizer's decode, and one more after
it rewrote the file). Each rule has a case that fails when the rule is removed.

The last part tests the comparison in infra/hermes/env_loader_oracle.py, which the in-image proof runs against Hermes' REAL loader
(scenario `env-loader-oracle`): the policy, the reading of the gate's answer, the verdict and its plumbing, offline, with a
stand-in loader that only exists to show the plumbing works.
"""
import importlib.util
import logging
import os
import random
import re
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
logging.getLogger("dotenv.main").setLevel(logging.CRITICAL)  # python-dotenv warns about every statement it drops


def load(path, name):
    previous, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


lockgate = load(os.path.join(HERE, "lockgate.py"), "lockgate_for_env_test")
oracle = load(os.path.join(HERE, "env_loader_oracle.py"), "env_loader_oracle_for_env_test")
FEFF = oracle.FEFF
REAL = lockgate._DotEnv
HAVE_DOTENV = REAL is not None
PARSERS = [("fallback", None)] + ([("python-dotenv", REAL)] if HAVE_DOTENV else [])
BOM = b"\xef\xbb\xbf"


def setUpModule():
    if os.environ.get("OORT_REQUIRE_DOTENV") == "1" and not HAVE_DOTENV:
        raise RuntimeError("OORT_REQUIRE_DOTENV=1 but python-dotenv cannot be imported: the comparison would be skipped")


def write_env(directory, raw):
    path = os.path.join(directory, ".env")
    with open(path, "wb") as handle:
        handle.write(raw)
    return path


def judge(raw, impl, lookup=None):
    """(volume_env_problems, image_volume_env_problems) of a `.env` holding `raw`, read by `impl` (None = the fallback)."""
    with tempfile.TemporaryDirectory() as tmp:
        path = write_env(tmp, raw)
        with mock.patch.object(lockgate, "_DotEnv", impl):
            return (lockgate.volume_env_problems(path, {} if lookup is None else lookup),
                    lockgate.image_volume_env_problems(path, {} if lookup is None else lookup))


def read_final(raw, impl, lookup=None):
    """What the loader ends up setting for `raw`: the last assignment of every name, names without a value left out."""
    with tempfile.TemporaryDirectory() as tmp:
        path = write_env(tmp, raw)
        with mock.patch.object(lockgate, "_DotEnv", impl):
            pairs, problems = lockgate._read_env_pairs(path, {} if lookup is None else lookup)
    return {name: value for name, value in dict(pairs).items() if value is not None}, problems



# python-dotenv==1.2.2, DotEnv(..., interpolate=False).parse()
PARSE_TABLE = [
    ('plain', 'A=1\n',
     [('A', '1')]),
    ('no final newline', 'A=1',
     [('A', '1')]),
    ('empty file', '',
     []),
    ('only blank lines and blanks', '\n   \n\t\n',
     []),
    ('two statements', 'A=1\nB=2\n',
     [('A', '1'), ('B', '2')]),
    ('empty value', 'A=\n',
     [('A', '')]),
    ('blank-only value', 'A=   \n',
     [('A', '')]),
    ('bare name', 'A\n',
     [('A', None)]),
    ('bare name then assignment', 'A\nB=2\n',
     [('A', None), ('B', '2')]),
    ('value with equals signs', 'A=b=c\nD==1\n',
     [('A', 'b=c'), ('D', '=1')]),
    ('name characters', 'A.B-C=1\nD:E=2\n',
     [('A.B-C', '1'), ('D:E', '2')]),
    ('leading blanks', '   A=1\n\tB=2\n',
     [('A', '1'), ('B', '2')]),
    ('blanks around equals', 'A = 1\nB\t=\t2\nC =3\nD= 4\n',
     [('A', '1'), ('B', '2'), ('C', '3'), ('D', '4')]),
    ('value keeps inner blanks', 'A=a  b\n',
     [('A', 'a  b')]),
    ('comment line', '# A=1\n',
     []),
    ('indented comment line', '   # A=1\nB=2\n',
     [('B', '2')]),
    ('trailing comment after blank', 'A=1 # note\n',
     [('A', '1')]),
    ('trailing comment after tab', 'A=1\t# note\n',
     [('A', '1')]),
    ('trailing comment, no blank before the hash', 'A=1#note\n',
     [('A', '1#note')]),
    ('trailing comment, many blanks', 'A=1     #note\n',
     [('A', '1')]),
    ('hash right after equals sign', 'A=#1\n',
     [('A', '#1')]),
    ('blank then hash right after equals sign', 'A= # note\n',
     [('A', '# note')]),
    ('two hashes', 'A=1 # one # two\n',
     [('A', '1')]),
    ('comment holds an assignment', 'A=0 # B=1\n',
     [('A', '0')]),
    ('export', 'export A=1\n',
     [('A', '1')]),
    ('export, two blanks', 'export  A=1\n',
     [('A', '1')]),
    ('export, tab', 'export\tA=1\n',
     [('A', '1')]),
    ('export glued to the name', 'exportA=1\n',
     [('exportA', '1')]),
    ('export, bare name', 'export A\n',
     [('A', None)]),
    ('export, then a comment', 'export # c\nA=1\n',
     [('A', '1')]),
    ('export, quoted name', "export 'A'=1\n",
     [('A', '1')]),
    ('single quotes', "A='1'\n",
     [('A', '1')]),
    ('double quotes', 'A="1"\n',
     [('A', '1')]),
    ('quotes keep blanks', 'A=" a  b "\nB=\' c \'\n',
     [('A', ' a  b '), ('B', ' c ')]),
    ('empty quotes', 'A=\'\'\nB=""\n',
     [('A', ''), ('B', '')]),
    ('double quotes + comment', 'A="1" # note\n',
     [('A', '1')]),
    ('single quotes + comment', "A='1' # note\n",
     [('A', '1')]),
    ('double quotes + comment, no blank', 'A="1"#note\n',
     [('A', '1')]),
    ('hash inside quotes', 'A="a # b"\nB=\'c # d\'\n',
     [('A', 'a # b'), ('B', 'c # d')]),
    ('quote then junk', 'A="1" junk\nB=2\n',
     [('B', '2')]),
    ('single quote then junk', "A='1'junk\nB=2\n",
     [('B', '2')]),
    ('unterminated double quote', 'A="1\nB=2\n',
     [('B', '2')]),
    ('unterminated single quote', "A='1\nB=2\n",
     [('B', '2')]),
    ('unterminated quote at end of file', 'A="1',
     []),
    ('quote opened and closed lines later', 'A="1\nB="2"\n',
     []),
    ('quote in the middle of a bare value', 'A=b"c"d\n',
     [('A', 'b"c"d')]),
    ('double quotes decode escapes', 'A="a\\nb"\nB="a\\tb"\nC="a\\\\b"\nD="a\\"b"\n',
     [('A', 'a\nb'), ('B', 'a\tb'), ('C', 'a\\b'), ('D', 'a"b')]),
    ('single quotes decode only backslash and quote', "A='a\\nb'\nB='a\\\\b'\nC='a\\'b'\n",
     [('A', 'a\\nb'), ('B', 'a\\b'), ('C', "a'b")]),
    ('hex escape is not decoded', 'A="\\x31"\n',
     [('A', '\\x31')]),
    ('backslash before the closing quote', 'A="1\\"\nB=2\n',
     [('A', '1\\'), ('B', '2')]),
    ('bare values keep backslashes', 'A=a\\nb\n',
     [('A', 'a\\nb')]),
    ('multi-line double quotes', 'A="l1\nl2"\nB=1\n',
     [('A', 'l1\nl2'), ('B', '1')]),
    ('multi-line single quotes', "A='l1\nl2'\nB=1\n",
     [('A', 'l1\nl2'), ('B', '1')]),
    ('multi-line value swallows an assignment', 'A="x\nHERMES_SAFE_MODE=1"\nB=2\n',
     [('A', 'x\nHERMES_SAFE_MODE=1'), ('B', '2')]),
    ('multi-line value with indented continuation', 'A="x\n   y"\n',
     [('A', 'x\n   y')]),
    ('single-quoted name', "'A'=1\n",
     [('A', '1')]),
    ('single-quoted name with blanks', "'A B'=1\n",
     [('A B', '1')]),
    ('single-quoted name, blanks around equals', "'A'  =  1\n",
     [('A', '1')]),
    ('double-quoted name keeps its quotes', '"A"=1\n',
     [('"A"', '1')]),
    ('empty single-quoted name', "''=1\nB=2\n",
     [('B', '2')]),
    ('single-quoted name then junk', "'A'x=1\nB=2\n",
     [('B', '2')]),
    ('no name', '=1\nB=2\n',
     [('B', '2')]),
    ('two words', 'A B=1\nC=3\n',
     [('C', '3')]),
    ('value then more after a space, bare', 'A=1 B=2\nC=3\n',
     [('A', '1 B=2'), ('C', '3')]),
    ('duplicate, second wins in a dict', 'A=1\nA=0\n',
     [('A', '1'), ('A', '0')]),
    ('duplicate, bare name last', 'A=1\nA\n',
     [('A', '1'), ('A', None)]),
    ('duplicate, first bare', 'A\nA=1\n',
     [('A', None), ('A', '1')]),
    ('CRLF', 'A=1\r\nB=2\r\n',
     [('A', '1'), ('B', '2')]),
    ('CR only', 'A=1\rB=2\r',
     [('A', '1'), ('B', '2')]),
    ('mixed line ends', 'A=1\r\nB=2\rC=3\nD=4',
     [('A', '1'), ('B', '2'), ('C', '3'), ('D', '4')]),
    ('form feed is no line end', 'A=1\x0cB=2\n',
     [('A', '1\x0cB=2')]),
    ('U+2028 is no line end', 'A=1\u2028B=2\n',
     [('A', '1\u2028B=2')]),
    ('NEL is no line end', 'A=1\x85B=2\n',
     [('A', '1\x85B=2')]),
    ('no-break space before a comment', 'A=1\xa0# note\n',
     [('A', '1')]),
    ('vertical tab before a comment', 'A=1\x0b# note\n',
     [('A', '1')]),
    ('ideographic space before a comment', 'A=1\u3000# note\n',
     [('A', '1')]),
    ('no-break space after the name', 'A\xa0=1\n',
     [('A', '1')]),
    ('non-ASCII value', 'A=한글\n',
     [('A', '한글')]),
    ('reference', 'A=${B}\n',
     [('A', '${B}')]),
    ('reference with default', 'A=${B:-d}\n',
     [('A', '${B:-d}')]),
    ('reference inside double quotes', 'A="${B}"\n',
     [('A', '${B}')]),
    ('reference inside single quotes', "A='${B}'\n",
     [('A', '${B}')]),
    ('dollar without braces', 'A=$B\n',
     [('A', '$B')]),
    ('empty reference name', 'A=${}\n',
     [('A', '${}')]),
]


# What the loader ends up setting for raw bytes (names without a value left out): measured with a stand-in of Hermes' own
# `_sanitize_env_file_if_needed` + `_load_dotenv_with_fallback` on python-dotenv==1.2.2. (label, bytes, environment, result)
READ_TABLE = [
    ("utf-8", b"A=1\n", {}, {"A": "1"}),
    ("utf-8 byte order mark", BOM + b"A=1\n", {}, {"A": "1"}),
    ("utf-16 little endian with a mark", b"\xff\xfe" + "A=1\r\nB=2\r\n".encode("utf-16-le"), {}, {"A": "1", "B": "2"}),
    ("utf-16 big endian with a mark", b"\xfe\xff" + "A=1\r\nB=2\r\n".encode("utf-16-be"), {}, {"A": "1", "B": "2"}),
    ("nul padded ascii (utf-16 without a mark)", "A=1\n".encode("utf-16-le"), {}, {"A": "1"}),
    ("nul inside a name and after a value", b"HERMES_SA\x00FE_MODE=1\x00\n", {}, {"HERMES_SAFE_MODE": "1"}),
    ("crlf", b"A=1\r\nB=2\r\n", {}, {"A": "1", "B": "2"}),
    ("cr only", b"A=1\rB=2\r", {}, {"A": "1", "B": "2"}),
    ("form feed is no line end", b"A=1\x0cB=2\n", {}, {"A": "1\x0cB=2"}),
    ("u+2028 is no line end", "A=1 B=2\n".encode("utf-8"), {}, {"A": "1 B=2"}),
    ("outer blanks of a line are stripped", b" \x0c A=1 \x0b \n", {}, {"A": "1"}),
    ("indentation inside a multi-line value is stripped", b'A="x\n    y"\n', {}, {"A": "x\ny"}),
    ("a comment line is ignored", b"   # A=1\nB=2\n", {}, {"B": "2"}),
    ("a reference reads the environment", b"A=${E}\n", {"E": "from-env"}, {"A": "from-env"}),
    ("a reference falls back to its default", b"A=${E:-d}\n", {}, {"A": "d"}),
    ("a reference to nothing is empty", b"A=x${E}y\n", {}, {"A": "xy"}),
    ("an empty default is empty", b"A=${E:-}\n", {}, {"A": ""}),
    ("the file's earlier value wins over the environment", b"E=file\nA=${E}\n", {"E": "env"}, {"E": "file", "A": "file"}),
    ("a later line is not visible to an earlier one", b"A=${E}\nE=file\n", {"E": "env"}, {"A": "env", "E": "file"}),
    ("a name without a value shadows the environment with empty", b"E\nA=${E:-d}\n", {"E": "env"}, {"A": ""}),
    ("a reference to itself", b"A=${A}x\n", {"A": "env"}, {"A": "envx"}),
    ("a reference inside double quotes", b'A="${E}"\n', {"E": "q"}, {"A": "q"}),
    ("a reference inside single quotes", b"A='${E}'\n", {"E": "q"}, {"A": "q"}),
    ("a dollar without braces is literal", b"A=$E\n", {"E": "q"}, {"A": "$E"}),
    ("the last assignment wins", b"A=1\nA=2\n", {}, {"A": "2"}),
    ("a name without a value after an assignment sets nothing", b"A=1\nA\n", {}, {}),
    ("a name without a value before an assignment", b"A\nA=1\n", {}, {"A": "1"}),
    # Byte order marks. These rows were measured with the REAL loader (hermes_cli/env_loader.py v0.22.2 run as it is, python-dotenv
    # 1.2.2), not with a stand-in: the number of marks that reach the first name depends on whether its sanitizer rewrote the file.
    ("two marks, and a second line the clean-up rewrites", BOM + BOM + b"A=1\n X=1\n", {}, {"A": "1", "X": "1"}),
    ("two marks, and no final newline (rewritten)", BOM + BOM + b"A=1", {}, {"A": "1"}),
    ("two marks, nothing to rewrite: one stays in the name", BOM + BOM + b"A=1\n", {}, {FEFF + "A": "1"}),
    ("three marks, rewritten: one stays in the name", BOM + BOM + BOM + b"A=1\n X=1\n", {}, {FEFF + "A": "1", "X": "1"}),
    ("a blank, then a mark, then the name", b" " + BOM + b"A=1\n", {}, {"A": "1"}),
    ("a tab, then a mark", b"\t" + BOM + b"A=1\n", {}, {"A": "1"}),
    ("a file separator, then a mark", b"\x1c" + BOM + b"A=1\n", {}, {"A": "1"}),
    ("a mark, a blank, a mark", BOM + b" " + BOM + b"A=1\n", {}, {"A": "1"}),
    ("utf-16 with a mark, then a second mark", b"\xff\xfe" + (FEFF + "A=1\n").encode("utf-16-le"), {}, {"A": "1"}),
    ("utf-16 with a mark, then two marks", b"\xff\xfe" + (FEFF + FEFF + "A=1\n").encode("utf-16-le"), {}, {FEFF + "A": "1"}),
    ("a mark on the second line stays in its name", b"B=2\n" + BOM + b"A=1\n", {}, {"B": "2", FEFF + "A": "1"}),
    ("marks left in front move where the first statement ends", BOM + BOM + BOM + b' Q="x\nA=1\n"\n', {}, {"A": "1"}),
]

# (name, a value the loader applies, a harmless value or None, the function that judges the name)
RULES = (
    ("HERMES_YOLO_MODE", "1", "0", "volume"),
    ("HERMES_DASHBOARD", "true", "false", "volume"),
    ("HERMES_ALLOW_PRIVATE_URLS", "yes", "no", "image"),
    ("HERMES_SAFE_MODE", "on", "off", "image"),
    ("HERMES_ENABLE_PROJECT_PLUGINS", "1", "0", "image"),
    ("API_SERVER_CORS_ORIGINS", "https://evil.example", "", "volume"),
    ("API_SERVER_KEY", "t" * 12, "k" * 40, "volume"),  # built, not spelled out: no scanner takes a fixture for a credential
    ("FAL_KEY", "f" * 12, "", "volume"),
    ("HTTPS_PROXY", "http://proxy.example:3128", "", "image"),
    ("all_proxy", "socks5://proxy.example:1080", "", "image"),
    (lockgate.SELF_ORIGIN_ENV, "https://oort.example.com", None, "image"),
    (lockgate.MEDIA_STRICT_ENV, "1", None, "image"),
)
FLAGS = {"HERMES_YOLO_MODE", "HERMES_DASHBOARD", "HERMES_ALLOW_PRIVATE_URLS", "HERMES_SAFE_MODE", "HERMES_ENABLE_PROJECT_PLUGINS"}

# Spellings Hermes' loader APPLIES. `{n}` name, `{v}` an applied value, `{good}` a harmless one (rules that have one).
APPLIES = (
    ("plain", "{n}={v}"),
    ("export", "export {n}={v}"),
    ("export, two blanks", "export  {n}={v}"),
    ("export, tab", "export\t{n}={v}"),
    ("trailing comment", "{n}={v} # why"),
    ("trailing comment after a tab, no space", "{n}={v}\t#why"),
    ("blanks around the equals sign", "{n} = {v}"),
    ("tabs around the equals sign", "{n}\t=\t{v}"),
    ("leading blanks", "   {n}={v}"),
    ("trailing blanks", "{n}={v}   "),
    ("single quotes", "{n}='{v}'"),
    ("double quotes", '{n}="{v}"'),
    ("single quotes + comment", "{n}='{v}' # why"),
    ("double quotes + comment", '{n}="{v}" # why'),
    ("double quotes + comment, no blank", '{n}="{v}"#why'),
    ("an escape inside double quotes", '{n}="{v}\\n"'),
    ("single-quoted name", "'{n}'={v}"),
    ("export + single-quoted name", "export '{n}'={v}"),
    ("everything at once", "export\t'{n}' = \"{v}\" # why"),
    ("reference with a default", "{n}=${{OORT_PROOF_UNSET:-{v}}}"),
    ("reference to an earlier line", "OORT_PROOF_LATER={v}\n{n}=${{OORT_PROOF_LATER}}"),
    ("harmless first, applied last", "{n}={good}\n{n}={v}"),
    ("after a multi-line quoted value", 'OORT_PROOF_NOTE="one\ntwo"\n{n}={v}'),
)
LINE_ENDS = (("LF", "\n"), ("CRLF", "\r\n"), ("CR", "\r"))

# Spellings it IGNORES (or sets nothing for): (label, template, applicable to a rule). `{nl}` is the lower-case name.
def is_proxy_rule(rule):
    return rule[0].upper().endswith("_PROXY")


INERT = (
    ("comment line", "# {n}={v}", lambda r: True),
    ("indented comment line", "   # {n}={v}", lambda r: True),
    ("unterminated double quote", '{n}="{v}', lambda r: True),
    ("unterminated single quote", "{n}='{v}", lambda r: True),
    ("junk after the closing quote", '{n}="{v}" junk', lambda r: True),
    ("bare name", "{n}", lambda r: True),
    ("double-quoted name keeps its quotes", '"{n}"={v}', lambda r: True),
    ("glued to export", "export{n}={v}", lambda r: not is_proxy_rule(r)),
    ("lower-case name (a POSIX name is case-sensitive)", "{nl}={v}", lambda r: not is_proxy_rule(r)),
    ("inside a multi-line quoted value", 'OORT_PROOF_NOTE="one\n{n}={v}"', lambda r: True),
    ("after a form feed on the same line", "OORT_PROOF_A=1\x0c{n}={v}", lambda r: True),
    ("after U+2028 on the same line", "OORT_PROOF_A=1 {n}={v}", lambda r: True),
    ("the applied word only in a comment", "{n}={good} # {n}={v}", lambda r: r[2] not in (None, "")),
)


class ParserParity(unittest.TestCase):
    def test_the_fallback_reads_every_row_as_the_table_says(self):
        for label, text, want in PARSE_TABLE:
            with self.subTest(row=label):
                self.assertEqual(lockgate._fallback_assignments(text), want)

    @unittest.skipUnless(HAVE_DOTENV, "python-dotenv is not installed (the in-image proof runs this with OORT_REQUIRE_DOTENV=1)")
    def test_the_installed_parser_reads_every_row_as_the_table_says(self):
        for label, text, want in PARSE_TABLE:
            with self.subTest(row=label):
                self.assertEqual(lockgate._real_assignments(text), want)

    @unittest.skipUnless(HAVE_DOTENV, "python-dotenv is not installed (the in-image proof runs this with OORT_REQUIRE_DOTENV=1)")
    def test_the_two_parsers_agree_on_random_statements(self):
        pieces = ["A", "B", "HERMES_SAFE_MODE", "=", "=", " ", "\t", "\n", "\n", "\r\n", "\r", "#", "'", '"', "\\", "\\n", "\\'",
                  '\\"', "export ", "export\t", "${A}", "${B:-d}", "${}", "$", "{", "}", ":-", "1", "0", "x", "\x0c", "\xa0",
                  " ", "\x85", "é",
                  # what a review found no earlier input could make: a byte order mark inside a statement, and more shapes of reference
                  FEFF, FEFF + FEFF, " " + FEFF, "$A", "${A:-${B}}", "${A:-", "$HERMES_SUPERVISED_CHILD", "x${A}y"]
        rnd = random.Random(4886)
        for _ in range(5000):
            text = "".join(rnd.choice(pieces) for _ in range(rnd.randint(1, 16)))
            self.assertEqual(lockgate._fallback_assignments(text), lockgate._real_assignments(text), repr(text))

    def test_the_gate_names_the_parser_it_used(self):
        with mock.patch.object(lockgate, "_DotEnv", None):
            self.assertEqual(lockgate.env_parser(), {"impl": "fallback"})
        if HAVE_DOTENV:
            parser = lockgate.env_parser()
            self.assertEqual(parser["impl"], "python-dotenv")
            self.assertTrue(parser["version"])


class ReadingLikeHermes(unittest.TestCase):
    def test_every_row_ends_up_as_the_loader_sets_it(self):
        for label, raw, lookup, want in READ_TABLE:
            for parser, impl in PARSERS:
                with self.subTest(row=label, parser=parser):
                    self.assertEqual(read_final(raw, impl, lookup), (want, []))

    def test_bytes_that_are_not_utf8_are_refused_not_guessed(self):
        # Hermes' sanitizer may rewrite such a file in place (bad bytes become U+FFFD) or leave it for the loader to read as
        # Latin-1; the two texts differ, so there is no safe reading of either.
        for label, raw in (("a Latin-1 byte", b"# caf\xe9\nA=1\n"), ("a cut multi-byte sequence", b"A=1\n\xe2\x80"),
                           ("utf-32", "A=1\n".encode("utf-32")), ("utf-16 cut in half", "A=1\n".encode("utf-16")[:-1])):
            for parser, impl in PARSERS:
                with self.subTest(file=label, parser=parser):
                    pairs, problems = read_final(raw, impl)
                    self.assertEqual(pairs, {})
                    self.assertEqual(len(problems), 1)
                    self.assertIn("not valid UTF-8", problems[0])
                    volume, image = judge(raw, impl)
                    self.assertEqual((len(volume), len(image)), (1, 1))

    def test_a_parser_that_fails_is_a_problem_not_an_empty_file(self):
        def broken(text):
            raise ValueError("fixture")
        for parser, impl in PARSERS:
            with self.subTest(parser=parser), tempfile.TemporaryDirectory() as tmp:
                path = write_env(tmp, b"HERMES_SAFE_MODE=1\n")
                with mock.patch.object(lockgate, "_DotEnv", impl), mock.patch.object(lockgate, "_real_assignments", broken), \
                        mock.patch.object(lockgate, "_fallback_assignments", broken):
                    pairs, problems = lockgate._read_env_pairs(path, {})
                self.assertEqual(pairs, [])
                self.assertEqual(len(problems), 1)
                self.assertIn("cannot parse", problems[0])
                self.assertNotIn("fixture", problems[0])

    def test_a_missing_file_is_fine_and_an_unreadable_one_is_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(lockgate._read_env_pairs(os.path.join(tmp, ".env")), ([], []))
            pairs, problems = lockgate._read_env_pairs(tmp)  # a directory cannot be read as a file
            self.assertEqual((pairs, len(problems)), ([], 1))


class RulesOnEverySpelling(unittest.TestCase):
    def found(self, rule, raw, impl, lookup=None):
        volume, image = judge(raw, impl, lookup)
        return [p for p in (volume if rule[3] == "volume" else image) if rule[0] in p]

    def test_every_spelling_the_loader_applies_is_refused_once_by_name_and_without_its_value(self):
        for rule in RULES:
            name, value, good, _ = rule
            for label, template in APPLIES:
                if "{good}" in template and good is None:
                    continue
                for eol_label, eol in LINE_ENDS:
                    text = template.format(n=name, v=value, good=good).replace("\n", eol) + eol
                    for parser, impl in PARSERS:
                        with self.subTest(rule=name, spelling=label, line_end=eol_label, parser=parser):
                            found = self.found(rule, text.encode("utf-8"), impl)
                            self.assertEqual(len(found), 1, found)
                            self.assertIn("the volume's .env", found[0])
                            if len(value) > 4:
                                self.assertNotIn(value, found[0])

    def test_spellings_the_loader_ignores_are_not_refused(self):
        for rule in RULES:
            name, value, good, _ = rule
            for label, template, applies_to in INERT:
                if not applies_to(rule):
                    continue
                text = template.format(n=name, nl=name.lower(), v=value, good=good) + "\n"
                for parser, impl in PARSERS:
                    with self.subTest(rule=name, spelling=label, parser=parser):
                        self.assertEqual(self.found(rule, text.encode("utf-8"), impl), [])

    def test_a_blank_then_a_comment_after_the_equals_sign_is_a_value(self):
        # python-dotenv reads `NAME= # note` as the value `# note` (the blank before the hash was eaten with the equals sign):
        # not a flag Hermes reads as true, but a value that is not empty.
        for rule in RULES:
            for parser, impl in PARSERS:
                with self.subTest(rule=rule[0], parser=parser):
                    found = self.found(rule, (rule[0] + "= # note\n").encode(), impl)
                    self.assertEqual(len(found), 0 if rule[0] in FLAGS else 1, found)

    def test_the_last_assignment_of_a_name_decides(self):
        for rule in RULES:
            name, value, good, _ = rule
            if good is None:  # the two name-only rules refuse the name wherever it stands
                continue
            for parser, impl in PARSERS:
                with self.subTest(rule=name, parser=parser):
                    self.assertEqual(len(self.found(rule, f"{name}={good}\n{name}={value}\n".encode(), impl)), 1)
                    self.assertEqual(self.found(rule, f"{name}={value}\n{name}={good}\n".encode(), impl), [])
                    # a bare name after an assignment: the loader sets nothing for it, and the earlier line is gone too
                    self.assertEqual(self.found(rule, f"{name}={value}\n{name}\n".encode(), impl), [])

    def test_the_two_name_only_rules_refuse_the_name_wherever_it_stands(self):
        for name in (lockgate.SELF_ORIGIN_ENV, lockgate.MEDIA_STRICT_ENV):
            rule = next(r for r in RULES if r[0] == name)
            for parser, impl in PARSERS:
                with self.subTest(rule=name, parser=parser):
                    for text in (f"{name}=x\n{name}=y\n", f"{name}=\n", f"{name}=x\n{name}\n", f"{name}=x\n{name}=\n"):
                        self.assertEqual(len(self.found(rule, text.encode(), impl)), 1, text)

    # Spellings of a reference. `{n}` name, `{v}` an applied value, `{g}` a harmless one.
    REFERENCES = (
        "{n}=${{OORT_PROOF_FLAG}}",
        "{n}=${{OORT_PROOF_FLAG:-{g}}}",
        "{n}=${{OORT_PROOF_FLAG:-{v}}}",
        "{n}=$OORT_PROOF_FLAG",
        '{n}="${{OORT_PROOF_FLAG}}"',
        "{n}='${{OORT_PROOF_FLAG}}'",
        "{n}=x${{OORT_PROOF_FLAG}}y",
        "{n}=${{",
        "{n}=${{}}",
        "export {n}=${{OORT_PROOF_FLAG}} # c",
        "OORT_PROOF_FLAG={g}\n{n}=${{OORT_PROOF_FLAG}}",
    )

    def test_a_judged_name_holding_a_reference_is_refused_whatever_it_resolves_to(self):
        # Hermes resolves `${...}` in ITS environment (the service slot adds variables the gate's shell has not), so what the gate would
        # compute is not what Hermes ends with: the reference itself is refused, once, by name, and the answer does not depend on
        # what the gate's own environment holds.
        for rule in RULES:
            name, value, good, _ = rule
            if good is None:  # the two name-only rules refuse the name whatever it holds
                continue
            for template in self.REFERENCES:
                text = (template.format(n=name, v=value, g=good) + "\n").encode()
                for lookup in ({}, {"OORT_PROOF_FLAG": good}, {"OORT_PROOF_FLAG": value}):
                    for parser, impl in PARSERS:
                        with self.subTest(rule=name, spelling=template, environment=lookup, parser=parser):
                            found = self.found(rule, text, impl, lookup)
                            self.assertEqual(len(found), 1, found)
                            self.assertIn("reference", found[0])
                            if len(value) > 4:
                                self.assertNotIn(value, found[0])

    def test_a_name_the_gate_does_not_judge_may_hold_references(self):
        for text in ("OPENROUTER_API_KEY=${OORT_PROOF_FLAG}\n", "OORT_PROOF_A=$OORT_PROOF_B\n", 'NOTE="${OORT_PROOF_FLAG:-x}"\n',
                     "NO_PROXY=${OORT_PROOF_FLAG}\n", "HERMES_SAFE_MODE_NOTE=${OORT_PROOF_FLAG}\n"):
            for parser, impl in PARSERS:
                with self.subTest(text=text, parser=parser):
                    self.assertEqual(judge(text.encode(), impl, {"OORT_PROOF_FLAG": "1"}), ([], []))

    def test_a_dollar_sign_that_starts_no_reference_is_not_one(self):
        key = next(r for r in RULES if r[0] == "API_SERVER_KEY")
        for parser, impl in PARSERS:
            for tail, refused in (("$1", 0), ("$", 0), ("$-", 0), ("$$", 0), ("$ {x}", 0), ("$x", 1), ("$_x", 1), ("${x}", 1), ("${", 1)):
                with self.subTest(tail=tail, parser=parser):
                    found = self.found(key, ("API_SERVER_KEY=" + "k" * 40 + tail + "\n").encode(), impl)
                    self.assertEqual(len(found), refused, found)

    def test_the_last_assignment_decides_whether_a_reference_counts(self):
        for rule in RULES:
            name, value, good, _ = rule
            if good is None:
                continue
            for parser, impl in PARSERS:
                with self.subTest(rule=name, parser=parser):
                    self.assertEqual(self.found(rule, f"{name}=${{OORT_PROOF_FLAG}}\n{name}={good}\n".encode(), impl), [])
                    self.assertEqual(len(self.found(rule, f"{name}={good}\n{name}=${{OORT_PROOF_FLAG}}\n".encode(), impl)), 1)
                    # a bare name after it: the loader sets nothing, and the reference before it is gone too
                    self.assertEqual(self.found(rule, f"{name}=${{OORT_PROOF_FLAG}}\n{name}\n".encode(), impl), [])

    def test_every_byte_order_mark_shape_hermes_applies_is_refused_once_by_name(self):
        for rule in RULES:
            name, value, _good, _ = rule
            applied, _kept, _control = oracle.byte_order_mark_shapes("%s=%s" % (name, value))
            for label, raw in applied:
                for parser, impl in PARSERS:
                    with self.subTest(rule=name, shape=label, parser=parser):
                        found = self.found(rule, raw, impl)
                        self.assertEqual(len(found), 1, found)
                        self.assertIn("the volume's .env", found[0])
                        if len(value) > 4:
                            self.assertNotIn(value, found[0])

    def test_a_mark_that_stays_in_a_name_is_read_in_the_name(self):
        # Hermes ends with the name `<mark>NAME`: it applies nothing under NAME, and neither may the gate. The one place a mark in a name
        # still counts is a `*_PROXY`, which the gate judges by its ending whatever stands in front (no client reads such a variable).
        for rule in RULES:
            name, value, _good, _ = rule
            _applied, kept, control = oracle.byte_order_mark_shapes("%s=%s" % (name, value))
            for label, raw in kept + control:
                for parser, impl in PARSERS:
                    with self.subTest(rule=name, shape=label, parser=parser):
                        self.assertEqual(len(self.found(rule, raw, impl)), 1 if is_proxy_rule(rule) else 0)

    def test_the_same_marks_around_a_harmless_value_refuse_nothing(self):
        for rule in RULES:
            name, _value, good, _ = rule
            if good is None:
                continue
            applied, kept, control = oracle.byte_order_mark_shapes("%s=%s" % (name, good))
            for label, raw in applied + kept + control:
                for parser, impl in PARSERS:
                    with self.subTest(rule=name, shape=label, parser=parser):
                        self.assertEqual(self.found(rule, raw, impl), [])

    def test_env_text_drops_exactly_the_marks_the_loader_drops(self):
        # No parser in it: the text the gate hands to python-dotenv. The expected texts are what the REAL loader parses (READ_TABLE rows).
        for label, raw, want in (
            ("one mark", BOM + b"A=1\n", "A=1\n"),
            ("two marks, nothing to rewrite: one stays", BOM + BOM + b"A=1\n", FEFF + "A=1\n"),
            ("two marks, a line the clean-up changes", BOM + BOM + b"A=1\n X=1\n", "A=1\nX=1\n"),
            ("two marks, no final newline", BOM + BOM + b"A=1", "A=1\n"),
            ("two marks and a NUL", BOM + BOM + b"A=1\x00\n", "A=1\n"),
            ("three marks, no final newline: one stays", BOM + BOM + BOM + b"A=1", FEFF + "A=1\n"),
            ("a blank, then a mark", b" " + BOM + b"A=1\n", "A=1\n"),
            ("a blank line, then a mark: nothing is stripped", b"\n" + BOM + b"A=1\n", "\n" + FEFF + "A=1\n"),
            ("a mark on the second line", b"B=2\n" + BOM + b"A=1\n", "B=2\n" + FEFF + "A=1\n"),
            ("utf-16, a mark in the text", b"\xff\xfe" + (FEFF + "A=1\n").encode("utf-16-le"), "A=1\n"),
            ("utf-16, two marks in the text: one stays", b"\xff\xfe" + (FEFF + FEFF + "A=1\n").encode("utf-16-le"), FEFF + "A=1\n"),
            ("empty", b"", ""),
        ):
            with self.subTest(file=label):
                self.assertEqual(lockgate.env_text(raw), want)

    def test_an_api_key_counts_only_what_survives_the_load(self):
        # Hermes drops every non-ASCII character from variables named *_KEY after loading them.
        key = next(r for r in RULES if r[0] == "API_SERVER_KEY")
        for parser, impl in PARSERS:
            def refused(value):
                return len(self.found(key, f"API_SERVER_KEY={value}\n".encode("utf-8"), impl))
            with self.subTest(parser=parser):
                self.assertEqual(refused("k" * 32), 0)
                self.assertEqual(refused("k" * 31), 1)
                self.assertEqual(refused("k" * 31 + "é"), 1, "one of 32 characters is dropped by Hermes")
                self.assertEqual(refused("k" * 32 + "é"), 0)
                self.assertEqual(refused('"  ' + "k" * 31 + '  "'), 1, "blanks around a key are not part of it")
                self.assertEqual(refused(""), 1)
                self.assertEqual(self.found(key, b"API_SERVER_KEY\n", impl), [], "a bare name sets nothing")

    def test_what_hermes_cleans_up_before_loading_hides_nothing(self):
        line = "HERMES_SAFE_MODE=1\n"
        flag = next(r for r in RULES if r[0] == "HERMES_SAFE_MODE")
        for label, raw in (
            ("utf-8 byte order mark", BOM + line.encode()),
            ("utf-16 little endian with a mark", b"\xff\xfe" + line.encode("utf-16-le")),
            ("utf-16 big endian with a mark", b"\xfe\xff" + line.encode("utf-16-be")),
            ("nul padded ascii", line.encode("utf-16-le")),
            ("nul in the middle of the name", b"HERMES_SAFE\x00_MODE=1\n"),
            ("nul after the value", b"HERMES_SAFE_MODE=1\x00\n"),
            ("form feed and vertical tab around the line", b"\x0c HERMES_SAFE_MODE=1 \x0b\n"),
            ("no-break spaces around the line", " HERMES_SAFE_MODE=1 \n".encode("utf-8")),
        ):
            for parser, impl in PARSERS:
                with self.subTest(file=label, parser=parser):
                    self.assertEqual(len(self.found(flag, raw, impl)), 1)


class StandInLoader:
    """Applies the `NAME=value` lines of `<home>/.env` and nothing else, and rewrites the file when told to. It only exists to show that
    `run` isolates the loader from this process and compares what it should: it knows nothing of Hermes."""

    def __init__(self, rewrite=None, fail=False):
        self._DOTENV_PUBLISHED = {"stale": (None, "x", 0)}
        self.calls, self.rewrite, self.fail = [], rewrite, fail

    def load_hermes_dotenv(self, hermes_home=None, load_external_secrets=True):
        managed = os.environ.get("HERMES_MANAGED_DIR", "")
        self.calls.append({"home": hermes_home, "external": load_external_secrets, "env": dict(os.environ),
                           "published": dict(self._DOTENV_PUBLISHED), "managed_is_an_empty_folder": os.path.isdir(managed) and not os.listdir(managed),
                           "home_holds_only_the_file": sorted(os.listdir(hermes_home)) == [".env"]})
        path = os.path.join(hermes_home, ".env")
        with open(path, "rb") as handle:
            data = handle.read()
        for line in data.decode("utf-8", "replace").splitlines():
            name, equals, value = line.partition("=")
            if equals and not name.startswith("#"):
                os.environ[name] = value
        if self.rewrite is not None:
            with open(path, "wb") as handle:
                handle.write(self.rewrite)
        if self.fail:
            raise ValueError("stand-in failure")


class StandInGate:
    """Refuses a name that is assigned `1` in the bytes it is given, by the gate's own wording, and records what it was given."""

    def __init__(self, names=("HERMES_SAFE_MODE",), extra=()):
        self.names, self.extra, self.seen = names, extra, []

    def volume_env_problems(self, path, lookup_env=None):
        with open(path, "rb") as handle:
            raw = handle.read()
        self.seen.append((raw, dict(lookup_env)))
        return ["the volume's .env enables %s" % name for name in self.names if (name + "=1").encode() in raw] + list(self.extra)

    def image_volume_env_problems(self, path, lookup_env=None):
        return []


class OracleComparison(unittest.TestCase):
    """The comparison in infra/hermes/env_loader_oracle.py, offline. The in-image proof runs it against Hermes' REAL loader."""

    def test_the_policy_names_what_hermes_must_not_end_with(self):
        for env, want in (
            ({}, set()),
            ({"HERMES_SAFE_MODE": " Yes "}, {"HERMES_SAFE_MODE"}),
            ({"HERMES_SAFE_MODE": "0", "HERMES_YOLO_MODE": ""}, set()),
            ({"API_SERVER_CORS_ORIGINS": "  "}, set()),
            ({"API_SERVER_CORS_ORIGINS": "https://evil.example"}, {"API_SERVER_CORS_ORIGINS"}),
            ({"API_SERVER_KEY": "k" * 32}, set()),
            ({"API_SERVER_KEY": "k" * 31}, {"API_SERVER_KEY"}),
            ({"API_SERVER_KEY": " " + "k" * 31 + " "}, {"API_SERVER_KEY"}),
            ({"FAL_KEY": "f"}, {"FAL_KEY"}),
            ({"FAL_KEY": ""}, set()),
            ({"http_proxy": "http://p.example"}, {"http_proxy"}),
            ({"HTTP_PROXY": ""}, set()),
            ({"NO_PROXY": "localhost"}, set()),
            ({"PROXY_HOST": "p.example"}, set()),
            ({FEFF + "HTTP_PROXY": "http://p.example"}, set()),
            ({"OORT_SELF_MEDIA_ORIGIN": ""}, {"OORT_SELF_MEDIA_ORIGIN"}),
            ({"HERMES_MEDIA_DELIVERY_STRICT": "1"}, {"HERMES_MEDIA_DELIVERY_STRICT"}),
        ):
            with self.subTest(env=env):
                self.assertEqual(oracle.violations(env), want)

    def test_the_gates_problems_are_read_back_by_name(self):
        # The problems come from the real functions, so a change to their wording breaks here and not silently in the proof.
        text = ("HERMES_YOLO_MODE=1\nAPI_SERVER_CORS_ORIGINS=x\nAPI_SERVER_KEY=short\nFAL_KEY=ffff\nHERMES_SAFE_MODE=${X}\n"
                "HTTPS_PROXY=http://p.example\nall_proxy=socks5://p.example\nOORT_SELF_MEDIA_ORIGIN=https://o.example.com\n"
                "HERMES_MEDIA_DELIVERY_STRICT=0\n").encode()
        for parser, impl in PARSERS:
            with self.subTest(parser=parser), mock.patch.object(lockgate, "_DotEnv", impl):
                names, file_level = oracle.named(oracle.gate_view(lockgate, text, {}))
                self.assertEqual(names, {"HERMES_YOLO_MODE", "API_SERVER_CORS_ORIGINS", "API_SERVER_KEY", "FAL_KEY", "HERMES_SAFE_MODE",
                                         "HTTPS_PROXY", "all_proxy", "OORT_SELF_MEDIA_ORIGIN", "HERMES_MEDIA_DELIVERY_STRICT"})
                self.assertFalse(file_level)
                names, file_level = oracle.named(oracle.gate_view(lockgate, b"A=1\n\xe9\n", {}))
                self.assertEqual((names, file_level), (set(), True))

    def test_compare_finds_a_miss_a_needless_refusal_and_the_reason_for_it(self):
        def enables(name):
            return "the volume's .env enables %s (why)" % name

        def sets(name):
            return "the volume's .env sets %s (why)" % name

        self.assertEqual(oracle.compare(b"", {"HERMES_SAFE_MODE"}, [])["missed"], ["HERMES_SAFE_MODE"], "a name nothing refuses is a miss")
        self.assertEqual(oracle.compare(b"", {"HERMES_SAFE_MODE"}, [enables("HERMES_SAFE_MODE")]),
                         {"file_refused": False, "missed": [], "needless": []})
        for label, raw, name, problem, reason in (
            ("a reference on the line", b"HERMES_SAFE_MODE=${X}\n", "HERMES_SAFE_MODE", enables("HERMES_SAFE_MODE"), "reference"),
            ("a reference without braces", b"HERMES_SAFE_MODE=$X\n", "HERMES_SAFE_MODE", enables("HERMES_SAFE_MODE"), "reference"),
            ("a mark inside a proxy name", BOM + b"x\n" + b"\n" + (FEFF + "HTTP_PROXY=p\n").encode(), FEFF + "HTTP_PROXY",
             sets(FEFF + "HTTP_PROXY"), "mark in a proxy name"),
            ("a name the volume may not set at all", b"OORT_SELF_MEDIA_ORIGIN=x\nOORT_SELF_MEDIA_ORIGIN\n", "OORT_SELF_MEDIA_ORIGIN",
             sets("OORT_SELF_MEDIA_ORIGIN"), "name-only rule"),
            ("a refusal with no reason in the file", b"HERMES_SAFE_MODE=0\n", "HERMES_SAFE_MODE", enables("HERMES_SAFE_MODE"), "unexplained"),
            ("a mark elsewhere is no excuse", BOM + BOM + b"HERMES_SAFE_MODE=0\n", "HERMES_SAFE_MODE", enables("HERMES_SAFE_MODE"), "unexplained"),
            ("a reference on ANOTHER name's line is no excuse", b"OPENROUTER_API_KEY=${X}\nHERMES_SAFE_MODE=0\n", "HERMES_SAFE_MODE",
             enables("HERMES_SAFE_MODE"), "unexplained"),
        ):
            with self.subTest(case=label):
                self.assertEqual(oracle.compare(raw, set(), [problem])["needless"], [(name, reason)])
        verdict = oracle.compare(b"\xe9", {"HERMES_SAFE_MODE"}, ["the volume's .env is not valid UTF-8 (why)"])
        self.assertEqual(verdict, {"file_refused": True, "missed": [], "needless": []}, "a refused file has nothing left to miss")

    def test_the_generators_make_the_shapes_the_review_found_missing(self):
        table = [label for label, _raw in oracle.table_cases()]
        for name, _value, _good in oracle.JUDGED:
            for kind in ("applied", "inert", "reference", "mark applied", "mark kept", "mark control"):
                self.assertTrue(any(label.startswith("%s: %s: " % (kind, name)) for label in table), (kind, name))
        cases = oracle.random_cases(4886, 2000)
        self.assertEqual(cases[:40], oracle.random_cases(4886, 40), "the same seed gives the same inputs")
        counts = {"two marks in front": 0, "a mark behind blanks": 0, "a reference": 0, "a line the clean-up rewrites": 0,
                  "utf-16": 0, "bytes that are not utf-8": 0}
        for _label, raw in cases:
            counts["two marks in front"] += raw.startswith(BOM + BOM)
            counts["a mark behind blanks"] += re.search(rb"[ \t\x0c\x1c]\xef\xbb\xbf", raw) is not None
            counts["a reference"] += re.search(rb"\$(?:\{|[A-Za-z_])", raw) is not None
            counts["a line the clean-up rewrites"] += b" OORT_ORACLE_X=1\n" in raw
            counts["utf-16"] += raw[:2] in (b"\xff\xfe", b"\xfe\xff")
            try:
                raw.decode("utf-8")
            except UnicodeDecodeError:
                counts["bytes that are not utf-8"] += 1
        for shape, count in counts.items():
            with self.subTest(shape=shape):
                self.assertGreaterEqual(count, 20, counts)

    def run_oracle(self, loader, gate, cases):
        with mock.patch.dict(os.environ, {"OORT_TEST_SENTINEL": "1"}):
            before = dict(os.environ)
            summary = oracle.run(loader, gate, cases)
            self.assertEqual(dict(os.environ), before, "the loader's environment must not leak into this process")
        return summary

    def test_run_isolates_the_loader_and_gives_the_gate_the_original_bytes(self):
        loader, gate = StandInLoader(rewrite=b"HERMES_YOLO_MODE=1\n"), StandInGate()
        raw = b"HERMES_SAFE_MODE=1\n"
        summary = self.run_oracle(loader, gate, [("applied: x", raw)])
        call = loader.calls[0]
        self.assertFalse(call["external"], "external secret sources are off")
        self.assertEqual(call["published"], {}, "the loader's record of earlier passes is cleared before each load")
        self.assertEqual(loader._DOTENV_PUBLISHED, {})
        self.assertNotIn("OORT_TEST_SENTINEL", call["env"], "the loader runs in the slot's environment, not this process's")
        self.assertEqual({name: call["env"].get(name) for name in ("HOME", "HERMES_SUPERVISED_CHILD")}, {"HOME": "/opt/data", "HERMES_SUPERVISED_CHILD": "1"})
        self.assertNotIn("HERMES_SAFE_MODE", call["env"])
        self.assertTrue(call["managed_is_an_empty_folder"], "the loader's managed-scope folder is an empty one: no second .env to read")
        self.assertTrue(call["home_holds_only_the_file"])
        self.assertNotEqual(call["home"], oracle.SLOT_ENV["HERMES_HOME"], "the file under test sits in a folder of its own")
        self.assertEqual(gate.seen[0], (raw, oracle.GATE_ENV), "the gate reads the original bytes in its own environment")
        self.assertNotIn("HERMES_SUPERVISED_CHILD", gate.seen[0][1])
        # The loader rewrote ITS copy into a file whose second load applies something the gate does not refuse: the file Hermes leaves
        # behind is judged too, against what Hermes applies when it loads THAT file (not against what the first load applied).
        self.assertEqual(gate.seen[1][0], b"HERMES_YOLO_MODE=1\n")
        self.assertEqual(len(loader.calls), 2)
        self.assertEqual(loader.calls[1]["env"].get("HERMES_SAFE_MODE"), None, "the second load starts from the slot's environment again")
        self.assertEqual((summary["cases"], summary["violating"], summary["missed"], summary["missed_after"], summary["detected"]),
                         (1, 1, 0, 1, ["HERMES_SAFE_MODE"]))
        self.assertFalse(summary["ok"], "a miss on the rewritten file fails the run")
        # a file whose second load applies what the gate refuses is fine, however the first load went
        loader, gate = StandInLoader(rewrite=b"HERMES_SAFE_MODE=1\n"), StandInGate()
        summary = self.run_oracle(loader, gate, [("applied: y", raw)])
        self.assertEqual((summary["missed"], summary["missed_after"], summary["ok"]), (0, 0, True))
        # and so is one whose second load applies nothing, though the first load applied what the gate refused on the ORIGINAL bytes: the
        # file left behind is judged against what Hermes applies when it loads that file, not against what the first load applied
        loader, gate = StandInLoader(rewrite=b"OORT_PROOF_A=1\n"), StandInGate()
        summary = self.run_oracle(loader, gate, [("applied: z", raw)])
        self.assertEqual((summary["violating"], summary["missed"], summary["missed_after"], summary["ok"]), (1, 0, 0, True))

    def test_run_counts_what_the_proof_has_to_be_able_to_tell(self):
        good = StandInGate()
        summary = self.run_oracle(StandInLoader(), good, [("applied: a", b"HERMES_SAFE_MODE=1\n"), ("inert: b", b"HERMES_SAFE_MODE=0\n"),
                                                          ("random", b"OORT_PROOF_A=1\n")])
        self.assertEqual((summary["cases"], summary["violating"], summary["clean"], summary["ok"]), (3, 1, 2, True))
        self.assertEqual(summary["detected"], ["HERMES_SAFE_MODE"])
        # a miss: the loader applies a name the gate does not refuse
        summary = self.run_oracle(StandInLoader(), StandInGate(names=()), [("applied: a", b"HERMES_SAFE_MODE=1\n")])
        self.assertEqual((summary["missed"], summary["ok"]), (1, False))
        self.assertEqual(summary["examples"]["missed"][0][2], ["HERMES_SAFE_MODE"])
        # a refusal nobody can explain
        summary = self.run_oracle(StandInLoader(), StandInGate(extra=["the volume's .env enables HERMES_YOLO_MODE (why)"]),
                                  [("random", b"OORT_PROOF_A=1\n")])
        self.assertEqual((summary["unexplained"], summary["ok"]), (1, False))
        # a table label the loader contradicts: an "inert" row it applies, an "applied" one it does not
        for label, raw in (("inert: a", b"HERMES_SAFE_MODE=1\n"), ("applied: a", b"HERMES_SAFE_MODE=0\n"), ("mark kept: a", b"HERMES_SAFE_MODE=1\n")):
            with self.subTest(label=label):
                summary = self.run_oracle(StandInLoader(), StandInGate(), [(label, raw)])
                self.assertEqual((summary["wrong_labels"], summary["ok"]), (1, False))
        # a loader that cannot load the file: counted, nothing compared, and this process's environment is still back
        loader = StandInLoader(fail=True)
        summary = self.run_oracle(loader, StandInGate(), [("random", b"HERMES_SAFE_MODE=1\n")])
        self.assertEqual((summary["hermes_errors"], summary["violating"], summary["ok"]), (1, 0, True))


if __name__ == "__main__":
    unittest.main()
