"""Offline tests for how lockgate.py reads and judges the volume's `.env` (#4886, #4950, ADR-0203 D6 / I2):

    python3 -m unittest infra/hermes/test_lockgate_env.py -v

Hermes loads `<HERMES_HOME>/.env` after the gate ran: python-dotenv's parser with interpolation off (hermes_cli/env_loader.py, v0.22.2).
The gate reads the file the same way: the image's python-dotenv when it can be imported, otherwise a fallback with the same grammar. This
file holds the two to ONE table of inputs (`PARSE_TABLE`, measured on python-dotenv==1.2.2, the version Hermes v0.22.2's uv.lock pins): the
fallback has to reproduce every row everywhere, and the real parser every row wherever it is installed. `OORT_REQUIRE_DOTENV=1` turns
"python-dotenv is not installed" from a skip into a failure; the in-image proof sets it (scripts/tests/test_hermes_image_guard_docker.sh),
so there the comparison cannot be skipped.

Then the judgement, `volume_env_problems` (the one function the boot gate and `report` call, #4950), for each parser: the file may hold
the allowed names and nothing else. Every spelling the loader APPLIES of a name that is not allowed is refused once, by name, never with
its value, whatever the value is; every spelling it ignores is not; the last assignment of a name decides; the match is exact. The byte
order marks at the front are read exactly as the loader strips them (its sanitizer's decode, and one more after it rewrote the file). The
loader loads the file again and again and every load rewrites it: the gate follows the file through those loads (CHAIN_TABLE, measured with
the real loader) and judges every text a load may parse, also the file as it stands when the clean-up leaves it alone. Each rule has a
case that fails when the rule is removed.

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


def judge(raw, impl):
    """`volume_env_problems` of a `.env` holding `raw`, read by `impl` (None = the fallback)."""
    with tempfile.TemporaryDirectory() as tmp:
        path = write_env(tmp, raw)
        with mock.patch.object(lockgate, "_DotEnv", impl):
            return lockgate.volume_env_problems(path)


def read_final(raw, impl):
    """What the loader ends up setting for `raw`, as written: the last assignment of every name, names without a value left out."""
    with tempfile.TemporaryDirectory() as tmp:
        path = write_env(tmp, raw)
        with mock.patch.object(lockgate, "_DotEnv", impl):
            readings, problems = lockgate._read_env_readings(path)
    return ({name: value for name, value in dict(readings[0]).items() if value is not None} if readings else {}), problems


def sets(name):
    """The start of the problem that refuses `name`."""
    return "the volume's .env sets %s (" % name


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


# What the loader ends up setting for raw bytes (names without a value left out), values as written: the gate judges names, so it does not
# resolve a `${...}` (Hermes does, against its own environment). Measured with a stand-in of Hermes' own `_sanitize_env_file_if_needed` +
# `_load_dotenv_with_fallback` on python-dotenv==1.2.2. (label, bytes, result)
READ_TABLE = [
    ("utf-8", b"A=1\n", {"A": "1"}),
    ("utf-8 byte order mark", BOM + b"A=1\n", {"A": "1"}),
    ("utf-16 little endian with a mark", b"\xff\xfe" + "A=1\r\nB=2\r\n".encode("utf-16-le"), {"A": "1", "B": "2"}),
    ("utf-16 big endian with a mark", b"\xfe\xff" + "A=1\r\nB=2\r\n".encode("utf-16-be"), {"A": "1", "B": "2"}),
    ("nul padded ascii (utf-16 without a mark)", "A=1\n".encode("utf-16-le"), {"A": "1"}),
    ("nul inside a name and after a value", b"HERMES_SA\x00FE_MODE=1\x00\n", {"HERMES_SAFE_MODE": "1"}),
    ("crlf", b"A=1\r\nB=2\r\n", {"A": "1", "B": "2"}),
    ("cr only", b"A=1\rB=2\r", {"A": "1", "B": "2"}),
    ("form feed is no line end", b"A=1\x0cB=2\n", {"A": "1\x0cB=2"}),
    ("u+2028 is no line end", "A=1 B=2\n".encode("utf-8"), {"A": "1 B=2"}),
    ("outer blanks of a line are stripped", b" \x0c A=1 \x0b \n", {"A": "1"}),
    ("indentation inside a multi-line value is stripped", b'A="x\n    y"\n', {"A": "x\ny"}),
    ("a comment line is ignored", b"   # A=1\nB=2\n", {"B": "2"}),
    ("a reference is read as written", b"A=${E}\n", {"A": "${E}"}),
    ("a reference with a default is read as written", b"A=${E:-d}\n", {"A": "${E:-d}"}),
    ("a reference inside a value is read as written", b"A=x${E}y\n", {"A": "x${E}y"}),
    ("an empty default is read as written", b"A=${E:-}\n", {"A": "${E:-}"}),
    ("a reference to an earlier line is read as written", b"E=file\nA=${E}\n", {"E": "file", "A": "${E}"}),
    ("a name without a value sets nothing, and neither does the reference after it", b"E\nA=${E:-d}\n", {"A": "${E:-d}"}),
    ("a reference to itself is read as written", b"A=${A}x\n", {"A": "${A}x"}),
    ("a reference inside double quotes", b'A="${E}"\n', {"A": "${E}"}),
    ("a reference inside single quotes", b"A='${E}'\n", {"A": "${E}"}),
    ("a dollar without braces is literal", b"A=$E\n", {"A": "$E"}),
    ("the last assignment wins", b"A=1\nA=2\n", {"A": "2"}),
    ("a name without a value after an assignment sets nothing", b"A=1\nA\n", {}),
    ("a name without a value before an assignment", b"A\nA=1\n", {"A": "1"}),
    # Byte order marks. These rows were measured with the REAL loader (hermes_cli/env_loader.py v0.22.2 run as it is, python-dotenv
    # 1.2.2), not with a stand-in: the number of marks that reach the first name depends on whether its sanitizer rewrote the file.
    ("two marks, and a second line the clean-up rewrites", BOM + BOM + b"A=1\n X=1\n", {"A": "1", "X": "1"}),
    ("two marks, and no final newline (rewritten)", BOM + BOM + b"A=1", {"A": "1"}),
    ("two marks, nothing to rewrite: one stays in the name", BOM + BOM + b"A=1\n", {FEFF + "A": "1"}),
    ("three marks, rewritten: one stays in the name", BOM + BOM + BOM + b"A=1\n X=1\n", {FEFF + "A": "1", "X": "1"}),
    ("a blank, then a mark, then the name", b" " + BOM + b"A=1\n", {"A": "1"}),
    ("a tab, then a mark", b"\t" + BOM + b"A=1\n", {"A": "1"}),
    ("a file separator, then a mark", b"\x1c" + BOM + b"A=1\n", {"A": "1"}),
    ("a mark, a blank, a mark", BOM + b" " + BOM + b"A=1\n", {"A": "1"}),
    ("utf-16 with a mark, then a second mark", b"\xff\xfe" + (FEFF + "A=1\n").encode("utf-16-le"), {"A": "1"}),
    ("utf-16 with a mark, then two marks", b"\xff\xfe" + (FEFF + FEFF + "A=1\n").encode("utf-16-le"), {FEFF + "A": "1"}),
    ("a mark on the second line stays in its name", b"B=2\n" + BOM + b"A=1\n", {"B": "2", FEFF + "A": "1"}),
    ("marks left in front of an unfinished statement", BOM + BOM + BOM + b' Q="x\nA=1\n"\n', {"A": "1"}),
]

# The files a volume's `.env` goes through while the loader loads it again and again: the file before load 1, before load 2 ... up to the
# one a load leaves as it is. Measured with the REAL loader (hermes_cli/env_loader.py v0.22.2 run as it is, python-dotenv 1.2.2), each
# load in a fresh process on the file the load before left behind. (label, bytes, the files)
CHAIN_TABLE = [
    ('empty', b'', [b'']),
    ('nothing to clean up', b'A=1\n', [b'A=1\n']),
    ('a mark only: the file keeps it', b'\xef\xbb\xbfA=1\n', [b'\xef\xbb\xbfA=1\n']),
    ('a blank before the name', b' A=1\n', [b' A=1\n', b'A=1\n']),
    ('no final newline', b'A=1', [b'A=1', b'A=1\n']),
    ('a NUL', b'A=1\x00\n', [b'A=1\x00\n', b'A=1\n']),
    ('CRLF line ends are not a change', b'A=1\r\nB=2\r\n', [b'A=1\r\nB=2\r\n']),
    ('outer blanks and form feeds', b'\x0c A=1 \x0b\n', [b'\x0c A=1 \x0b\n', b'A=1\n']),
    ('a comment keeps its blanks', b'  # note \nA=1\n', [b'  # note \nA=1\n']),
    ('utf-16 with a mark', b'\xff\xfeA\x00=\x001\x00\r\x00\n\x00', [b'\xff\xfeA\x00=\x001\x00\r\x00\n\x00', b'A=1\n']),
    ('first character U+FFFD: left alone, NUL line and all', b'\xef\xbf\xbd\n\x00 Q="x\nA=1\n"\n',
     [b'\xef\xbf\xbd\n\x00 Q="x\nA=1\n"\n']),
    ('a mark, then U+FFFD: left alone', b'\xef\xbb\xbf\xef\xbf\xbd\n\x00 Q="x\nA=1\n"\n',
     [b'\xef\xbb\xbf\xef\xbf\xbd\n\x00 Q="x\nA=1\n"\n']),
    ('two blank-and-mark pairs', b' \xef\xbb\xbf \xef\xbb\xbfA=1\n',
     [b' \xef\xbb\xbf \xef\xbb\xbfA=1\n', b'\xef\xbb\xbf \xef\xbb\xbfA=1\n', b'\xef\xbb\xbfA=1\n']),
    ('three blank-and-mark pairs', b' \xef\xbb\xbf \xef\xbb\xbf \xef\xbb\xbfA=1\n',
     [b' \xef\xbb\xbf \xef\xbb\xbf \xef\xbb\xbfA=1\n', b'\xef\xbb\xbf \xef\xbb\xbf \xef\xbb\xbfA=1\n', b'\xef\xbb\xbf \xef\xbb\xbfA=1\n',
      b'\xef\xbb\xbfA=1\n']),
    ('two tab-and-mark pairs, then a second line', b'\t\xef\xbb\xbf\t\xef\xbb\xbfA=1\n X=1\n',
     [b'\t\xef\xbb\xbf\t\xef\xbb\xbfA=1\n X=1\n', b'\xef\xbb\xbf\t\xef\xbb\xbfA=1\nX=1\n', b'\xef\xbb\xbfA=1\nX=1\n']),
    ('a mark, then two blank-and-mark pairs', b'\xef\xbb\xbf \xef\xbb\xbf \xef\xbb\xbfA=1\n',
     [b'\xef\xbb\xbf \xef\xbb\xbf \xef\xbb\xbfA=1\n', b'\xef\xbb\xbf \xef\xbb\xbfA=1\n', b'\xef\xbb\xbfA=1\n']),
    ('utf-16 with three blank-and-mark pairs', b'\xff\xfe \x00\xff\xfe \x00\xff\xfe \x00\xff\xfeA\x00=\x001\x00\n\x00',
     [b'\xff\xfe \x00\xff\xfe \x00\xff\xfe \x00\xff\xfeA\x00=\x001\x00\n\x00', b'\xef\xbb\xbf \xef\xbb\xbf \xef\xbb\xbfA=1\n',
      b'\xef\xbb\xbf \xef\xbb\xbfA=1\n', b'\xef\xbb\xbfA=1\n']),
]

# Hermes v0.22.2 `agent.secret_scope._parse_env_text` (the line-by-line tokenizer behind `load_env_file`), measured on the real function:
# `(label, text, {name: value})`. `lockgate.line_assignments` is a copy of it and has to give every row.
LINE_TABLE = [
    ('a plain assignment', 'A=1\n', {'A': '1'}),
    ('no final newline', 'A=1', {'A': '1'}),
    ('blanks around the name and the equals sign', '  A = 1  \n', {'A': '1'}),
    ('export with one blank', 'export A=1\n', {'A': '1'}),
    ('export with two blanks', 'export  A=1\n', {'A': '1'}),
    ('export with a tab is part of the name', 'export\tA=1\n', {'export\tA': '1'}),
    ('export glued to the name', 'exportA=1\n', {'exportA': '1'}),
    ('export and nothing after it', 'export \n', {}),
    ('a double-quoted value', 'A="x y"\n', {'A': 'x y'}),
    ('a single-quoted value', "A='x y'\n", {'A': 'x y'}),
    ('an escaped quote inside double quotes', 'A="a\\"b"\n', {'A': 'a"b'}),
    ('an escaped backslash inside double quotes', 'A="a\\\\b"\n', {'A': 'a\\b'}),
    ('a backslash n stays as written', 'A="a\\nb"\n', {'A': 'a\\nb'}),
    ('single quotes keep a backslash', "A='a\\nb'\n", {'A': 'a\\nb'}),
    ('a comment after a blank', 'A=1 # c\n', {'A': '1'}),
    ('a hash with no blank before it stays', 'A=1#c\n', {'A': '1#c'}),
    ('a comment after a closing double quote', 'A="x" # c\n', {'A': 'x'}),
    ('a comment after a closing single quote', "A='x' # c\n", {'A': 'x'}),
    ('junk after a closing quote stays in the value', 'A="x" junk\n', {'A': '"x" junk'}),
    ('an unterminated double quote', 'A="x\n', {'A': '"x'}),
    ('an unterminated single quote', "A='x\n", {'A': "'x"}),
    ('an equals sign inside the value', 'A=b=c\n', {'A': 'b=c'}),
    ('an empty value', 'A=\n', {'A': ''}),
    ('a bare name', 'A\n', {}),
    ('a bare name after an assignment keeps the assignment', 'A=1\nA\n', {'A': '1'}),
    ('the later line of a name wins', 'A=1\nA=2\n', {'A': '2'}),
    ('a comment line', '# A=1\n', {}),
    ('an indented comment line', '   # A=1\n', {}),
    ('a hash glued to the name is a comment', '#A=1\n', {}),
    ('a hash and a tab before the name is a comment', '#\tA=1\n', {}),
    ('blank lines', '\n\n  \n', {}),
    ('no name', '=1\n', {}),
    ('a name with a blank in it', 'A B=1\n', {'A B': '1'}),
    ('a single-quoted name keeps its quotes', "'A'=1\n", {"'A'": '1'}),
    ('a lower case name is another name', 'a=1\n', {'a': '1'}),
    ('CRLF line ends', 'A=1\r\nB=2\r\n', {'A': '1', 'B': '2'}),
    ('CR line ends', 'A=1\rB=2\r', {'A': '1', 'B': '2'}),
    ('a form feed ends a line', 'A=1\x0cB=2\n', {'A': '1', 'B': '2'}),
    ('a vertical tab ends a line', 'A=1\x0bB=2\n', {'A': '1', 'B': '2'}),
    ('file, group and record separators end a line', 'A=1\x1cB=2\x1dC=3\x1eD=4\n', {'A': '1', 'B': '2', 'C': '3', 'D': '4'}),
    ('NEL ends a line', 'A=1\x85B=2\n', {'A': '1', 'B': '2'}),
    ('U+2028 ends a line', 'A=1\u2028B=2\n', {'A': '1', 'B': '2'}),
    ('U+2029 ends a line', 'A=1\u2029B=2\n', {'A': '1', 'B': '2'}),
    ('a boundary in the tail of a comment', 'A=1 # c\u2029B=2\n', {'A': '1', 'B': '2'}),
    ('a quoted value over two lines is two lines', 'A="one\nB=2"\n', {'A': '"one', 'B': '2"'}),
    ('a mark in front stays in the name', '\ufeffA=1\n', {'\ufeffA': '1'}),
    ('a blank, then a mark: the mark stays', ' \ufeffA=1\n', {'\ufeffA': '1'}),
    ('a no-break space around the line is stripped', '\xa0A=1\xa0\n', {'A': '1'}),
    ('a NUL stays in the name', 'A\x00=1\n', {'A\x00': '1'}),
    ('a NUL stays in the value', 'A=1\x00\n', {'A': '1\x00'}),
    ('a quoted value with a trailing comment and a boundary', "A='x' # c\u2028B=2\n", {'A': 'x', 'B': '2'}),
    ('a value that is a lone quote', 'A="\n', {'A': '"'}),
    ('two quotes make an empty value', 'A=""\n', {'A': ''}),
    ('mixed quotes are no quotes', 'A=\'x"\n', {'A': '\'x"'}),
    ('a trailing backslash in double quotes', 'A="x\\\\"\n', {'A': 'x\\'}),
]

# Names the volume's `.env` may not set: (name, a value, another value). The oracle's table is the one list; the first twelve were judged by
# their value before #4950, and a name nobody judged is refused exactly as they are.
FORBIDDEN = oracle.FORBIDDEN_FULL
UNHEARD_OF = ("OORT_PROOF_UNHEARD", "A", "a_b", "SOMETHING_API_KEY", "HERMES_" + "X" * 40, "HERMES_MEDIA_ALLOW_DIRS", "HERMES_MANAGED_DIR",
              "HERMES_HOME", "GATEWAY_PROXY_URL", "OPENROUTER_API_KEY", "ANTHROPIC_TOKEN")

# Spellings Hermes' loader APPLIES. `{n}` name, `{v}` an applied value, `{good}` another one.
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
# The spellings of those whose value, as written, is the value (the seeded lines are judged by that value; the other four make another one).
AS_WRITTEN = {"plain", "export", "export, two blanks", "export, tab", "trailing comment", "trailing comment after a tab, no space",
              "blanks around the equals sign", "tabs around the equals sign", "leading blanks", "trailing blanks", "single quotes",
              "double quotes", "single quotes + comment", "double quotes + comment", "double quotes + comment, no blank", "single-quoted name",
              "export + single-quoted name", "everything at once", "harmless first, applied last"}
LINE_ENDS = (("LF", "\n"), ("CRLF", "\r\n"), ("CR", "\r"))

# Spellings NO reader sets anything for. The helper statements are names the policy allows.
INERT = (
    ("comment line", "# {n}={v}"),
    ("indented comment line", "   # {n}={v}"),
    ("bare name", "{n}"),
)
# Spellings python-dotenv (the loader) sets nothing for, but that Hermes' line-by-line reader reads as the assignment of `{n}`: a statement the
# loader cannot finish, a bare name that undoes an earlier line only for the loader, a statement inside a quoted value, one after a boundary
# only the line-by-line reader cuts at, the tail of a comment. The helper statements are names the policy allows.
LINE_READ = (
    ("unterminated double quote", '{n}="{v}'),
    ("unterminated single quote", "{n}='{v}"),
    ("junk after the closing quote", '{n}="{v}" junk'),
    ("bare name after the assignment", "{n}={v}\n{n}"),
    ("inside a multi-line quoted value", 'OPENAI_API_KEY="one\n{n}={v}"'),
    ("after a form feed on the same line", "OPENAI_API_KEY=1\x0c{n}={v}"),
    ("after U+2028 on the same line", "OPENAI_API_KEY=1\u2028{n}={v}"),
    ("after NEL on the same line", "OPENAI_API_KEY=1\x85{n}={v}"),
    ("in the tail of a comment, after U+2029", "OPENAI_API_KEY=1 # c\u2029{n}={v}"),
)
# Spellings of `APPLIES` that python-dotenv reads as the name and the line-by-line reader reads as ANOTHER key (it takes off `export ` with
# ONE blank only and keeps the quotes around a name): for an allowed name the other key is what is refused.
LINE_KEY_DIFFERS = {"export, tab", "single-quoted name", "export + single-quoted name", "everything at once"}
# Spellings that are ANOTHER name to the loader: refused as that name, which is not on the list either.
OTHER_NAMES = (
    ("lower-case name (a POSIX name is case-sensitive)", "{nl}={v}"),
    ("glued to export", "export{n}={v}"),
    ("double-quoted name keeps its quotes", '"{n}"={v}'),
    ("a letter behind the name", "{n}X={v}"),
    ("a letter in front of the name", "X{n}={v}"),
)
SECRET_VALUE = "s" * 12  # built, not spelled out: no scanner takes a fixture for a credential


class ReadingLikeHermes(unittest.TestCase):
    def test_every_row_ends_up_as_the_loader_sets_it(self):
        for label, raw, want in READ_TABLE:
            for parser, impl in PARSERS:
                with self.subTest(row=label, parser=parser):
                    self.assertEqual(read_final(raw, impl), (want, []))

    def test_the_gate_follows_the_file_through_the_loads_the_loader_makes(self):
        # The model of the loader's clean-up, one load at a time, against the files the REAL loader left behind (CHAIN_TABLE).
        for label, raw, files in CHAIN_TABLE:
            with self.subTest(file=label):
                self.assertEqual(lockgate.env_states(raw), files)
                self.assertEqual(lockgate.env_cleanup(raw), files[1] if len(files) > 1 else raw, "one load of it")

    def test_every_text_a_load_may_parse_is_judged_the_one_of_the_first_load_first(self):
        for label, raw, files in CHAIN_TABLE:
            with self.subTest(file=label):
                texts = lockgate.env_texts(raw)
                self.assertEqual(texts[0], lockgate.env_text(raw))
                self.assertEqual(sorted(texts), sorted({lockgate.env_loaded_text(state) for state in files} | {lockgate.env_text(raw)}))
                self.assertEqual(len(texts), len(set(texts)), "each text once")

    def test_what_the_clean_up_cannot_be_modelled_for_has_no_files_to_follow(self):
        for label, raw in (("a Latin-1 byte", b"# caf\xe9\nA=1\n"), ("utf-32", "A=1\n".encode("utf-32")), ("utf-16 cut in half", "A=1\n".encode("utf-16")[:-1])):
            with self.subTest(file=label):
                self.assertIsNone(lockgate.env_states(raw))
                self.assertIsNone(lockgate.env_texts(raw))
                self.assertIsNone(lockgate.env_text(raw))

    def test_a_file_that_keeps_changing_is_followed_up_to_the_cap_and_refused_beyond_it(self):
        # n blank-and-mark pairs take n loads (CHAIN_TABLE). The cap is how many rewrites the gate follows.
        cap = lockgate.ENV_LOAD_CAP
        within, beyond = oracle.pair_run(b" ", cap) + b"OPENAI_API_KEY=1\n", oracle.pair_run(b" ", cap + 1) + b"OPENAI_API_KEY=1\n"
        self.assertEqual(len(lockgate.env_states(within)), cap + 1)
        self.assertIsNone(lockgate.env_states(beyond))
        for parser, impl in PARSERS:
            for label, raw in (("beyond the cap, allowed name", beyond), ("beyond the cap, forbidden name", beyond.replace(b"OPENAI_API_KEY=1", b"HERMES_SAFE_MODE=on"))):
                with self.subTest(parser=parser, file=label):
                    problems = judge(raw, impl)
                    self.assertEqual(len(problems), 1, "refused as a whole")
                    self.assertIn("cannot parse the volume's .env", problems[0])
                    self.assertNotIn("HERMES_SAFE_MODE", problems[0])
            with self.subTest(parser=parser, file="within the cap, forbidden name"):
                plain = [p for p in judge(within.replace(b"OPENAI_API_KEY=1", b"HERMES_SAFE_MODE=on"), impl) if FEFF not in p]
                self.assertEqual(len(plain), 1, plain)
                self.assertTrue(plain[0].startswith(sets("HERMES_SAFE_MODE")), plain)
            with self.subTest(parser=parser, file="within the cap, allowed name"):
                self.assertEqual([p for p in judge(within, impl) if FEFF not in p], [])

    def test_bytes_that_are_not_utf8_are_refused_not_guessed(self):
        # Hermes' sanitizer may rewrite such a file in place (bad bytes become U+FFFD) or leave it for the loader to read as
        # Latin-1; the two texts differ, so there is no safe reading of either.
        for label, raw in (("a Latin-1 byte", b"# caf\xe9\nA=1\n"), ("a cut multi-byte sequence", b"A=1\n\xe2\x80"),
                           ("utf-32", "A=1\n".encode("utf-32")), ("utf-16 cut in half", "A=1\n".encode("utf-16")[:-1])):
            for parser, impl in PARSERS:
                with self.subTest(file=label, parser=parser):
                    final, problems = read_final(raw, impl)
                    self.assertEqual(final, {})
                    self.assertEqual(len(problems), 1)
                    self.assertIn("not valid UTF-8", problems[0])
                    self.assertEqual(len(judge(raw, impl)), 1)

    def test_a_parser_that_fails_is_a_problem_not_an_empty_file(self):
        def broken(text):
            raise ValueError("fixture")
        for parser, impl in PARSERS:
            with self.subTest(parser=parser), tempfile.TemporaryDirectory() as tmp:
                path = write_env(tmp, b"HERMES_SAFE_MODE=1\n")
                with mock.patch.object(lockgate, "_DotEnv", impl), mock.patch.object(lockgate, "_real_assignments", broken), \
                        mock.patch.object(lockgate, "_fallback_assignments", broken):
                    readings, problems = lockgate._read_env_readings(path)
                    judged = lockgate.volume_env_problems(path)
                self.assertEqual(readings, [])
                self.assertEqual(len(problems), 1)
                self.assertIn("cannot parse", problems[0])
                self.assertNotIn("fixture", problems[0])
                self.assertEqual(judged, problems, "the judgement refuses what it cannot read")

    def test_a_missing_file_is_fine_and_an_unreadable_one_is_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(lockgate._read_env_readings(os.path.join(tmp, ".env")), ([], []))
            self.assertEqual(lockgate.volume_env_problems(os.path.join(tmp, ".env")), [])
            readings, problems = lockgate._read_env_readings(tmp)  # a directory cannot be read as a file
            self.assertEqual((readings, len(problems)), ([], 1))


class AllowListOnEverySpelling(unittest.TestCase):
    def found(self, name, raw, impl):
        return [p for p in judge(raw, impl) if p.startswith(sets(name))]

    def test_every_spelling_the_loader_applies_is_refused_once_by_name_and_without_its_value(self):
        for name, value, other in FORBIDDEN:
            for label, template in APPLIES:
                for eol_label, eol in LINE_ENDS:
                    text = template.format(n=name, v=value, good=other).replace("\n", eol) + eol
                    for parser, impl in PARSERS:
                        with self.subTest(name=name, spelling=label, line_end=eol_label, parser=parser):
                            found = self.found(name, text.encode("utf-8"), impl)
                            self.assertEqual(len(found), 1, found)
                            if len(value) > 4:
                                self.assertNotIn(value, found[0])

    def test_spellings_no_reader_sets_anything_for_are_not_refused(self):
        for name, value, _other in FORBIDDEN:
            for label, template in INERT:
                text = (template.format(n=name, v=value) + "\n").encode("utf-8")
                for parser, impl in PARSERS:
                    with self.subTest(name=name, spelling=label, parser=parser):
                        self.assertEqual(judge(text, impl), [], "the helper statements are names the policy allows")

    def test_what_only_the_line_by_line_reader_reads_is_refused_by_name_once(self):
        # python-dotenv sets nothing for these, so the loader is silent; Hermes' other reader of the file reads the name all the same
        for name, value, _other in FORBIDDEN:
            for label, template in LINE_READ:
                text = (template.format(n=name, v=value) + "\n").encode("utf-8")
                for parser, impl in PARSERS:
                    with self.subTest(name=name, spelling=label, parser=parser):
                        self.assertNotIn(name, read_final(text, impl)[0], "python-dotenv sets nothing for it")
                        found = self.found(name, text, impl)
                        self.assertEqual(len(found), 1, found)
                        self.assertIn("not an allowed name", found[0])
                        if len(value) > 4:
                            self.assertNotIn(value, found[0])

    def test_another_spelling_of_a_name_is_another_name_and_is_refused_as_that(self):
        for name, value, _other in FORBIDDEN:
            for label, template in OTHER_NAMES:
                text = (template.format(n=name, nl=name.lower(), v=value) + "\n").encode("utf-8")
                if text == ("%s=%s\n" % (name, value)).encode():
                    continue  # `all_proxy` is lower-case already
                for parser, impl in PARSERS:
                    with self.subTest(name=name, spelling=label, parser=parser):
                        self.assertEqual(self.found(name, text, impl), [])
                        problems = judge(text, impl)
                        self.assertEqual(len(problems), 1, problems)

    def test_the_last_assignment_of_a_name_decides(self):
        for name, value, other in FORBIDDEN:
            for parser, impl in PARSERS:
                with self.subTest(name=name, parser=parser):
                    self.assertEqual(len(self.found(name, f"{name}={other}\n{name}={value}\n".encode(), impl)), 1)
                    self.assertEqual(len(self.found(name, f"{name}={value}\n{name}={other}\n".encode(), impl)), 1, "applied whatever the value")
                    # a bare name after an assignment: the loader sets nothing for it, and the earlier line is gone too; Hermes' line-by-line
                    # reader still reads the earlier line (LINE_READ), so the name is refused all the same
                    self.assertNotIn(name, read_final(f"{name}={value}\n{name}\n".encode(), impl)[0])
                    self.assertEqual(len(self.found(name, f"{name}={value}\n{name}\n".encode(), impl)), 1)
                    self.assertEqual(len(self.found(name, f"{name}\n{name}={value}\n".encode(), impl)), 1)
        for parser, impl in PARSERS:
            self.assertEqual(judge(b"OPENAI_API_KEY=x\nOPENAI_API_KEY\n", impl), [])

    def test_a_name_that_is_not_allowed_is_refused_whatever_its_value(self):
        values = ("", "0", "false", "no", "off", " ", "${OORT_PROOF_FLAG}", "$OORT_PROOF_FLAG", "${OORT_PROOF_FLAG:-1}", "'x'", '"x"', "x" * 40)
        for name in [item[0] for item in FORBIDDEN] + list(UNHEARD_OF):
            for value in values:
                text = ("%s=%s\n" % (name, value)).encode()
                for parser, impl in PARSERS:
                    with self.subTest(name=name, value=value, parser=parser):
                        found = self.found(name, text, impl)
                        self.assertEqual(len(found), 1, found)
                        self.assertNotIn("x" * 40, found[0])
                        self.assertIn("not an allowed name", found[0])

    def test_the_allowed_secrets_pass_whatever_their_value(self):
        for name in lockgate.VOLUME_ENV_SECRETS:
            for parser, impl in PARSERS:
                for value in ("", SECRET_VALUE, "${OORT_PROOF_FLAG}", "$HOME", "'quoted'", '"quoted"', "a b c", "é", "x" * 400):
                    with self.subTest(name=name, value=value[:20], parser=parser):
                        self.assertEqual(judge(f"{name}={value}\n".encode(), impl), [])
                for label, template in APPLIES:
                    if "OORT_PROOF" in template:
                        continue  # helper names of those two spellings are not allowed
                    if label in LINE_KEY_DIFFERS or label == "an escape inside double quotes":
                        continue  # refused, each for its own reason: see the two tests below
                    with self.subTest(name=name, spelling=label, parser=parser):
                        self.assertEqual(judge((template.format(n=name, v=SECRET_VALUE, good="g") + "\n").encode(), impl), [])

    def test_the_seeded_lines_pass_with_their_own_value_and_only_that(self):
        for name, value in lockgate.VOLUME_ENV_SEEDED.items():
            for parser, impl in PARSERS:
                for label, template in APPLIES:
                    if label not in AS_WRITTEN or label in LINE_KEY_DIFFERS:
                        continue
                    with self.subTest(name=name, spelling=label, parser=parser):
                        self.assertEqual(judge((template.format(n=name, v=value, good="9") + "\n").encode(), impl), [])
                for other in (value + "0", "", "x", value.upper() + "!", "${OORT_PROOF_FLAG:-%s}" % value, "$" + value):
                    with self.subTest(name=name, other=other, parser=parser):
                        found = self.found(name, f"{name}={other}\n".encode(), impl)
                        self.assertEqual(len(found), 1, found)
                        self.assertIn("template value", found[0])
                with self.subTest(name=name, parser=parser, what="the last one decides"):
                    self.assertEqual(judge(f"{name}=x\n{name}={value}\n".encode(), impl), [])
                    self.assertEqual(len(self.found(name, f"{name}={value}\n{name}=x\n".encode(), impl)), 1)
                for label, template in (("an escape inside double quotes", APPLIES[15][1]), ("a reference with a default", APPLIES[19][1])):
                    with self.subTest(name=name, spelling=label, parser=parser):
                        self.assertTrue(any("template value" in problem for problem in self.found(name, (template.format(n=name, v=value) + "\n").encode(), impl)),
                                        "another value as written: a reference or an escape does not launder it")

    def test_the_file_hermes_seeds_into_a_fresh_volume_passes(self):
        seeded = "# Hermes' own first-boot template\n\n" + "".join("%s=%s\n" % item for item in lockgate.VOLUME_ENV_SEEDED.items())
        extra = "".join("%s=%s\n" % (name, SECRET_VALUE) for name in lockgate.VOLUME_ENV_SECRETS)
        for parser, impl in PARSERS:
            with self.subTest(parser=parser):
                self.assertEqual(judge(seeded.encode(), impl), [])
                self.assertEqual(judge((seeded + extra).encode(), impl), [])
                self.assertEqual(judge((seeded + extra).replace("\n", "\r\n").encode(), impl), [])
                problems = judge((seeded + "OPENROUTER_API_KEY=%s\n" % SECRET_VALUE).encode(), impl)
                self.assertEqual([p.split(" (")[0] for p in problems], [sets("OPENROUTER_API_KEY")[:-2]])

    def test_an_allowed_name_the_line_reader_reads_as_another_key_is_refused_as_that_key(self):
        # `export<TAB>NAME` and `'NAME'=...` are the name to python-dotenv; the line-by-line reader keeps the tab or the quotes in the key, so
        # for it the file holds another name, which is not on the list
        for name in list(lockgate.VOLUME_ENV_SECRETS) + list(lockgate.VOLUME_ENV_SEEDED):
            value = lockgate.VOLUME_ENV_SEEDED.get(name, SECRET_VALUE)
            for label, template in APPLIES:
                if label not in LINE_KEY_DIFFERS:
                    continue
                text = template.format(n=name, v=value, good="g") + "\n"
                for parser, impl in PARSERS:
                    with self.subTest(name=name, spelling=label, parser=parser):
                        problems = judge(text.encode(), impl)
                        self.assertTrue(problems)
                        self.assertEqual([p for p in problems if p.startswith(sets(name))], [], "the allowed name itself is not what is refused")
                        for key in lockgate.line_assignments(text):
                            if key != name:
                                self.assertTrue(any(p.startswith(sets(key)) for p in problems), (key, problems))
                        for problem in problems:
                            self.assertIn("not an allowed name", problem)

    def test_an_escape_that_makes_a_line_break_in_an_allowed_value_is_refused(self):
        template = dict(APPLIES)["an escape inside double quotes"]
        for name in lockgate.VOLUME_ENV_SECRETS:
            for parser, impl in PARSERS:
                with self.subTest(name=name, parser=parser):
                    problems = judge((template.format(n=name, v=SECRET_VALUE) + "\n").encode(), impl)
                    self.assertEqual(len(problems), 1, problems)
                    self.assertTrue(problems[0].startswith(sets(name)) and "a line break inside its value" in problems[0], problems)

    def test_a_line_break_in_the_value_of_an_allowed_name_is_refused_whatever_follows_it(self):
        forms = (("bare", "{n}=a{b}b"), ("single quotes", "{n}='a{b}b'"), ("double quotes", '{n}="a{b}b"'))
        for name in list(lockgate.VOLUME_ENV_SECRETS) + list(lockgate.VOLUME_ENV_SEEDED):
            for boundary in lockgate.LINE_BREAKS:
                for label, template in forms:
                    if label == "bare" and boundary in "\r\n":
                        continue  # a bare value ends at CR and LF: the rest is another statement
                    text = (template.format(n=name, b=boundary) + "\n").encode("utf-8")
                    for parser, impl in PARSERS:
                        with self.subTest(name=name, boundary=repr(boundary), form=label, parser=parser):
                            problems = judge(text, impl)
                            hits = [p for p in problems if p.startswith(sets(name)) and "a line break inside its value" in p]
                            self.assertEqual(len(hits), 1, problems)
                            self.assertNotIn("a" + boundary + "b", hits[0], "the value is never printed")
                            if name in lockgate.VOLUME_ENV_SECRETS:
                                self.assertEqual(problems, hits, "nothing else is wrong with the file")
        # a value that holds no break is fine, and so is one that ends with a blank python-dotenv strips off (nothing follows it)
        for parser, impl in PARSERS:
            self.assertEqual(judge("OPENAI_API_KEY=ab\u2028\n".encode("utf-8"), impl), [])
            self.assertEqual(judge(b"OPENAI_API_KEY='a b'\n", impl), [])

    def test_a_line_break_counts_in_every_assignment_not_only_in_the_last_of_a_name(self):
        # python-dotenv keeps the last assignment of a name; the line-by-line reader cuts the TEXT, whatever python-dotenv kept
        text = b"OPENAI_API_KEY='a\nb'\nOPENAI_API_KEY=ok\n"
        for parser, impl in PARSERS:
            with self.subTest(parser=parser):
                self.assertEqual(read_final(text, impl)[0], {"OPENAI_API_KEY": "ok"})
                problems = judge(text, impl)
                self.assertEqual(len(problems), 1, problems)
                self.assertIn("a line break inside its value", problems[0])

    def test_the_gate_judges_every_text_for_the_line_reader_too(self):
        # the file as it stands and the files the loader leaves behind are each read by the line-by-line reader: the name that only a later
        # file holds to it is refused as well. The statement is one python-dotenv never finishes, so no load applies it and the loader's
        # reading of any text is silent: only the line-by-line reading of a LATER text names it plainly (the first one holds marks in front).
        later, _skipped, _as_stands = oracle.chain_shapes('HERMES_SAFE_MODE="1')
        for label, raw in later:
            for parser, impl in PARSERS:
                with self.subTest(shape=label, parser=parser):
                    self.assertNotIn("HERMES_SAFE_MODE", read_final(raw, impl)[0])
                    self.assertEqual(len(self.found("HERMES_SAFE_MODE", raw, impl)), 1, judge(raw, impl))

    def test_the_connector_client_pair_is_a_service_variable_and_not_a_name_of_the_volume(self):
        # `.env` is loaded with override: a name allowed there would let the volume replace what the service holds
        for name in ("GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"):
            self.assertNotIn(name, lockgate.VOLUME_ENV_SECRETS)
            self.assertNotIn(name, lockgate.VOLUME_ENV_SEEDED)
            for parser, impl in PARSERS:
                with self.subTest(name=name, parser=parser):
                    found = self.found(name, f"{name}={SECRET_VALUE}\n".encode(), impl)
                    self.assertEqual(len(found), 1, found)
                    self.assertNotIn(SECRET_VALUE, found[0])
        with open(os.path.join(HERE, "google-connectors.config.yaml"), encoding="utf-8") as handle:
            config = handle.read()
        self.assertIn("${GOOGLE_OAUTH_CLIENT_ID}", config)  # the connector config reads the pair through a variable reference: the service is the source
        self.assertIn("${GOOGLE_OAUTH_CLIENT_SECRET}", config)

    def test_the_allow_list_is_a_list_of_exact_plain_names(self):
        for table in (lockgate.VOLUME_ENV_SECRETS, lockgate.VOLUME_ENV_SEEDED):
            for name in table:
                self.assertRegex(name, r"\A[A-Z][A-Z0-9_]*\Z")  # no pattern character, no lower case, no blank
        self.assertFalse(set(lockgate.VOLUME_ENV_SECRETS) & set(lockgate.VOLUME_ENV_SEEDED))
        allowed = list(lockgate.VOLUME_ENV_SECRETS) + list(lockgate.VOLUME_ENV_SEEDED)
        # a name that merely resembles an allowed one is refused: no prefix, no suffix, no case folding, no family
        for name in allowed:
            for near in (name + "_2", name + "2", "X" + name, name[:-1], name.lower(), name.title(), name.replace("_", "", 1), name + "_"):
                if near in allowed:
                    continue
                for parser, impl in PARSERS:
                    with self.subTest(allowed=name, near=near, parser=parser):
                        problems = judge(f"{near}=1\n".encode(), impl)
                        self.assertEqual(len(problems), 1, problems)
                        self.assertTrue(problems[0].startswith(sets(near)), problems)
        for parser, impl in PARSERS:
            # python-dotenv reads the name with its blank, the line-by-line reader keeps the quotes: two other names, each refused
            self.assertEqual(len(judge(b"'OPENAI_API_KEY '=1\n", impl)), 2, "a quoted name with a blank is another name")
        self.assertEqual(sorted(lockgate.VOLUME_ENV_SECRETS), ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"])

    def test_every_secret_cites_a_file_of_this_repo_that_uses_the_name(self):
        for name, cited in lockgate.VOLUME_ENV_SECRETS.items():
            files = re.findall(r"[A-Za-z0-9_./-]+\.(?:py|ya?ml)", cited)
            self.assertTrue(files, name)
            for ref in files:
                path = os.path.join(HERE, ref[len("infra/hermes/"):] if ref.startswith("infra/hermes/") else ref)
                with self.subTest(name=name, file=ref):
                    self.assertTrue(os.path.isfile(path), path)
                    with open(path, encoding="utf-8") as handle:
                        self.assertIn(name, handle.read())

    def test_the_gate_and_the_oracle_hold_one_policy(self):
        self.assertEqual(set(lockgate.VOLUME_ENV_SECRETS), set(oracle.SECRETS))
        self.assertEqual(lockgate.VOLUME_ENV_SEEDED, oracle.SEEDED)
        names = {name for name, _v, _g in oracle.FORBIDDEN_FULL + oracle.FORBIDDEN_PLAIN}
        self.assertFalse(names & (set(lockgate.VOLUME_ENV_SECRETS) | set(lockgate.VOLUME_ENV_SEEDED)))
        # the names the gate's other rules are about are not on the list: the file may not carry them whatever it holds
        for name in (lockgate.SELF_ORIGIN_ENV, lockgate.MEDIA_STRICT_ENV, *lockgate.IMAGE_ENV_FLAG_REASONS, *lockgate.IMAGE_KEY_ENV_NAMES,
                     "API_SERVER_KEY", "API_SERVER_CORS_ORIGINS", "HERMES_YOLO_MODE", "HERMES_DASHBOARD", "HERMES_HOME", "HERMES_MANAGED_DIR"):
            self.assertIn(name, names, name)

    def test_a_second_env_file_next_to_the_first_refuses_the_start(self):
        makers = (("a file", lambda path: open(path, "wb").close()), ("a directory", os.mkdir),
                  ("a dangling link", lambda path: os.symlink("/oort-proof/none", path)))
        for label, make in makers:
            for env in (None, b"OPENAI_API_KEY=x\n"):
                with self.subTest(op_env=label, env=env), tempfile.TemporaryDirectory() as tmp:
                    if env is not None:
                        write_env(tmp, env)
                    make(os.path.join(tmp, ".op.env"))
                    problems = lockgate.volume_env_problems(os.path.join(tmp, ".env"))
                    self.assertEqual(len(problems), 1, problems)
                    self.assertIn(".op.env", problems[0])
        with tempfile.TemporaryDirectory() as tmp:
            write_env(tmp, b"OPENAI_API_KEY=x\n")
            self.assertEqual(lockgate.volume_env_problems(os.path.join(tmp, ".env")), [], "no second file, nothing to refuse")
            with open(os.path.join(tmp, ".op.env"), "wb") as handle:
                handle.write(b"HERMES_SAFE_MODE=oort-proof-content\n")
            problems = lockgate.volume_env_problems(os.path.join(tmp, ".env"))
            self.assertEqual(len(problems), 1)
            self.assertNotIn("oort-proof-content", problems[0])
            self.assertNotIn("HERMES_SAFE_MODE", problems[0], "the second file is refused as a whole, never read")

    def test_a_reading_that_names_a_problem_adds_to_the_others_and_never_repeats_one(self):
        # two readings of one file give the same problem in the same words once, and different problems both
        raw = oracle.pair_run(b" ", 2) + b"HERMES_YOLO_MODE=1\nAPI_SERVER_CORS_ORIGINS=https://evil.example\n"
        for parser, impl in PARSERS:
            with self.subTest(parser=parser):
                problems = judge(raw, impl)
                self.assertEqual(sorted(p.split(" (")[0] for p in problems if FEFF not in p),
                                 ["the volume's .env sets API_SERVER_CORS_ORIGINS", "the volume's .env sets HERMES_YOLO_MODE"])
                self.assertEqual(len(problems), len(set(problems)), "each problem once")

    def test_every_byte_order_mark_shape_hermes_applies_is_refused_once_by_name(self):
        for name, value, _other in FORBIDDEN:
            applied, _kept, _control = oracle.byte_order_mark_shapes("%s=%s" % (name, value))
            for label, raw in applied:
                for parser, impl in PARSERS:
                    with self.subTest(name=name, shape=label, parser=parser):
                        problems = judge(raw, impl)
                        # The name Hermes applies is refused once. A reading of the file with a mark left in the name (the file as it stood
                        # before a load cleaned it) adds a line for that other name.
                        self.assertEqual(len([p for p in problems if p.startswith(sets(name))]), 1, problems)
                        if len(value) > 4:
                            for problem in problems:
                                self.assertNotIn(value, problem)

    def test_a_mark_that_stays_in_a_name_is_refused_as_that_other_name(self):
        # Hermes ends with the name `<mark>NAME`: not on the list either. The plain name is not applied, so it is not what is refused.
        for name, value, _other in FORBIDDEN:
            _applied, kept, control = oracle.byte_order_mark_shapes("%s=%s" % (name, value))
            for label, raw in kept + control:
                for parser, impl in PARSERS:
                    with self.subTest(name=name, shape=label, parser=parser):
                        problems = judge(raw, impl)
                        self.assertEqual([p for p in problems if p.startswith(sets(name))], [])
                        self.assertGreaterEqual(len([p for p in problems if p.startswith(sets(FEFF + name))]), 1, problems)

    def chain_shapes_for(self, name, value):
        later, skipped, as_stands = oracle.chain_shapes("%s=%s" % (name, value))
        return (("a later load", later), ("a file the clean-up leaves alone", skipped), ("a file the clean-up could not write", as_stands))

    def test_a_name_hermes_applies_at_any_load_or_reads_from_the_file_as_it_stands_is_refused_once_by_name(self):
        for name, value, _other in FORBIDDEN:
            for kind, shapes in self.chain_shapes_for(name, value):
                for label, raw in shapes:
                    for parser, impl in PARSERS:
                        with self.subTest(name=name, kind=kind, shape=label, parser=parser):
                            problems = judge(raw, impl)
                            self.assertEqual(len([p for p in problems if p.startswith(sets(name))]), 1, problems)
                            if len(value) > 4:
                                for problem in problems:
                                    self.assertNotIn(value, problem)

    def test_the_same_marks_and_loads_around_an_allowed_name_never_refuse_the_name_itself(self):
        for name in lockgate.VOLUME_ENV_SECRETS:
            line = "%s=%s" % (name, SECRET_VALUE)
            applied, kept, control = oracle.byte_order_mark_shapes(line)
            later, skipped, as_stands = oracle.chain_shapes(line)
            for label, raw in applied + later + skipped + as_stands:
                for parser, impl in PARSERS:
                    with self.subTest(name=name, shape=label, parser=parser):
                        # the name policy never refuses the allowed name itself; a helper statement that holds a quote open over a line end
                        # is refused for its own line break, which is another rule (the name it carries is the helper's)
                        self.assertEqual([p for p in judge(raw, impl) if p.startswith(sets(name)) and "a line break inside its value" not in p], [])
            for label, raw in kept + control:  # a mark that stays in the name makes it another name
                for parser, impl in PARSERS:
                    with self.subTest(name=name, shape=label, parser=parser):
                        self.assertGreaterEqual(len([p for p in judge(raw, impl) if p.startswith(sets(FEFF + name))]), 1)

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

    def test_what_hermes_cleans_up_before_loading_hides_nothing(self):
        line = "HERMES_SAFE_MODE=1\n"
        for label, raw in (
            ("utf-8 byte order mark", BOM + line.encode()),
            ("utf-16 little endian with a mark", b"\xff\xfe" + line.encode("utf-16-le")),
            ("utf-16 big endian with a mark", b"\xfe\xff" + line.encode("utf-16-be")),
            ("nul padded ascii", line.encode("utf-16-le")),
            ("nul in the middle of the name", b"HERMES_SAFE\x00_MODE=1\n"),
            ("nul after the value", b"HERMES_SAFE_MODE=1\x00\n"),
            ("form feed and vertical tab around the line", b"\x0c HERMES_SAFE_MODE=1 \x0b\n"),
            ("no-break spaces around the line", " HERMES_SAFE_MODE=1 \n".encode("utf-8")),
        ):
            for parser, impl in PARSERS:
                with self.subTest(file=label, parser=parser):
                    self.assertEqual(len(self.found("HERMES_SAFE_MODE", raw, impl)), 1)


class LineReaderPort(unittest.TestCase):
    """`lockgate.line_assignments` is a copy of Hermes' line-by-line tokenizer: held to the real one's measured answers, and to Python's own
    idea of where a line ends."""

    def test_every_row_reads_as_the_real_tokenizer_reads_it(self):
        for label, text, want in LINE_TABLE:
            with self.subTest(row=label):
                self.assertEqual(lockgate.line_assignments(text), want)

    def test_the_line_breaks_are_exactly_the_characters_splitlines_ends_a_line_at(self):
        ends_a_line = {char for char in map(chr, range(0x110000)) if ("a" + char + "b").splitlines() != ["a" + char + "b"]}
        self.assertEqual(set(lockgate.LINE_BREAKS), ends_a_line)
        self.assertEqual(len(lockgate.LINE_BREAKS), len(set(lockgate.LINE_BREAKS)))

    def test_a_name_only_an_earlier_text_of_the_chain_shows_to_the_line_reader_is_named(self):
        # #4950 review round 2, Low-1: a gate that judged the line reader's names of the LAST text only passed every test, because the one-sided
        # case of this table was a name only a LATER text shows. Here the line reader reads a name only in the file as it stands on disk (a
        # blank between two marks, which the first load's clean-up strips: `env_texts` lists it second, after the text of the first load) and in
        # no python-dotenv reading, and the settled file holds only an allowed name: a refusal that names it can come from the line reader's
        # reading of that earlier text and from nothing else.
        raw = b' \xef\xbb\xbf \xef\xbb\xbfOPENAI_API_KEY=1\n'
        only_earlier = '\ufeff \ufeffOPENAI_API_KEY'
        texts = lockgate.env_texts(raw)
        line_names = [set(lockgate.line_assignments(text)) for text in texts]
        loader_names = [{name for name, _value in lockgate.dotenv_assignments(text)} for text in texts]
        self.assertEqual([i for i, names in enumerate(line_names) if only_earlier in names], [1], "an earlier text, not the first, not the last")
        self.assertFalse(any(only_earlier in names for names in loader_names), "the loader never reads it: only the line reader can name it")
        self.assertEqual(line_names[-1], {"OPENAI_API_KEY"}, "the settled file is clean")
        with tempfile.TemporaryDirectory() as tmp:
            problems = lockgate.volume_env_problems(write_env(tmp, raw))
        self.assertTrue(any(only_earlier in problem for problem in problems), problems)

    def test_the_table_has_what_makes_the_two_readers_differ(self):
        # a table that left these out would not hold the copy to what the policy needs it for
        labels = " ".join(label for label, _text, _want in LINE_TABLE)
        for needle in ("export with a tab", "unterminated", "junk after", "bare name after", "ends a line", "two lines", "tail of a comment"):
            self.assertIn(needle, labels)


class ProfilesFolder(unittest.TestCase):
    """`<HERMES_HOME>/profiles`: absent on a fresh volume, harmless when empty; an entry under it is a profile Hermes serves with an `.env` of its own."""

    def problems(self, make=None, env=b"OPENAI_API_KEY=x\n"):
        with tempfile.TemporaryDirectory() as tmp:
            if env is not None:
                write_env(tmp, env)
            if make is not None:
                make(os.path.join(tmp, "profiles"))
            return lockgate.volume_env_problems(os.path.join(tmp, ".env"))

    def test_a_missing_or_empty_folder_is_fine(self):
        self.assertEqual(self.problems(), [])
        self.assertEqual(self.problems(os.mkdir), [])
        self.assertEqual(self.problems(os.mkdir, env=None), [])

    def test_any_entry_under_it_refuses_the_start_and_only_the_number_is_named(self):
        def folder(path):
            os.mkdir(path)
            os.mkdir(os.path.join(path, "oort-proof-profile"))

        def file(path):
            os.mkdir(path)
            open(os.path.join(path, "oort-proof-file"), "wb").close()

        def hidden(path):
            os.mkdir(path)
            open(os.path.join(path, ".oort-proof-hidden"), "wb").close()

        def dangling(path):
            os.mkdir(path)
            os.symlink("/oort-proof/none", os.path.join(path, "oort-proof-link"))

        def tombstone(path):
            # what Hermes itself leaves when a profile is deleted (hermes_constants.py `mark_named_profile_deleted`: `profiles/.deleted/<name>`,
            # removed only by creating or restoring a profile of that name): a volume that once had a profile is not empty (#4950 review round 2)
            os.makedirs(os.path.join(path, ".deleted"))
            with open(os.path.join(path, ".deleted", "oort-proof-gone"), "w") as handle:
                handle.write("deleted\n")

        for label, make in (("a folder", folder), ("a file", file), ("a hidden file", hidden), ("a dangling link", dangling),
                            ("Hermes' tombstone of a deleted profile", tombstone)):
            for env in (None, b"OPENAI_API_KEY=x\n"):
                with self.subTest(entry=label, env=env):
                    problems = self.problems(make, env=env)
                    self.assertEqual(len(problems), 1, problems)
                    self.assertIn("1 entry under profiles/", problems[0])
                    self.assertNotIn("oort-proof", problems[0], "the name of an entry is never printed")

        def two(path):
            folder(path)
            open(os.path.join(path, "oort-proof-second"), "wb").close()

        self.assertIn("2 entries under profiles/", self.problems(two)[0])

    def test_a_link_or_a_thing_that_is_not_a_folder_is_refused_for_what_it_may_lead_to(self):
        def not_a_folder(path):
            open(path, "wb").close()

        def empty_target_link(path):
            os.mkdir(path + "-target")
            os.symlink(path + "-target", path)

        def dangling_link(path):
            os.symlink("/oort-proof/none", path)

        for label, make, want in (("a file", not_a_folder, "is not a folder"), ("a link to an empty folder", empty_target_link, "is a link"),
                                  ("a dangling link", dangling_link, "is a link")):
            with self.subTest(thing=label):
                problems = self.problems(make)
                self.assertEqual(len(problems), 1, problems)
                self.assertIn(want, problems[0])

    def test_a_folder_that_cannot_be_listed_is_refused_and_one_that_vanished_is_not(self):
        with mock.patch.object(lockgate.os, "listdir", side_effect=PermissionError):
            problems = self.problems(os.mkdir)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("cannot read the volume's profiles", problems[0])
        with mock.patch.object(lockgate.os, "listdir", side_effect=FileNotFoundError):
            self.assertEqual(self.problems(os.mkdir), [])

    def test_the_folder_adds_to_the_problems_of_the_file_and_the_second_env_file(self):
        def make(path):
            os.mkdir(path)
            os.mkdir(os.path.join(path, "p"))
            open(os.path.join(os.path.dirname(path), ".op.env"), "wb").close()

        problems = self.problems(make, env=b"HERMES_SAFE_MODE=1\n")
        self.assertEqual(len(problems), 3, problems)
        self.assertTrue(problems[0].startswith(sets("HERMES_SAFE_MODE")))
        self.assertIn(".op.env", problems[1])
        self.assertIn("profiles/", problems[2])


class StandInLoader:
    """Applies the `NAME=value` lines of `<home>/.env` and nothing else, and rewrites the file when told to. It only exists to show that
    `run` isolates the loader from this process and compares what it should: it knows nothing of Hermes. Like the real loader it has its
    clean-up as a step of its own (`_sanitize_env_file_if_needed`, called before it reads the file) that `clean` can make do something,
    and it rewrites the file AFTER a load with `rewrite`. `own`: a name it adds with no file at all (the loader's own bookkeeping).
    The first call of `run` is the control: an empty file, to learn what the loader adds by itself."""

    def __init__(self, rewrite=None, fail=False, clean=None, own=None):
        self._DOTENV_PUBLISHED = {"stale": (None, "x", 0)}
        self.calls, self.rewrite, self.fail, self.clean, self.own, self._cleaned = [], rewrite, fail, clean, own, False

    def _sanitize_env_file_if_needed(self, path):
        self._cleaned = True
        if self.clean is not None:
            with open(path, "rb") as handle:
                data = handle.read()
            cleaned = self.clean(data)
            if cleaned != data:
                with open(path, "wb") as handle:
                    handle.write(cleaned)

    def load_hermes_dotenv(self, hermes_home=None, load_external_secrets=True):
        managed = os.environ.get("HERMES_MANAGED_DIR", "")
        path = os.path.join(hermes_home, ".env")
        self._cleaned = False
        self._sanitize_env_file_if_needed(path)  # `run` may have switched it off
        self.calls.append({"home": hermes_home, "external": load_external_secrets, "env": dict(os.environ),
                           "published": dict(self._DOTENV_PUBLISHED), "managed_is_an_empty_folder": os.path.isdir(managed) and not os.listdir(managed),
                           "home_holds_only_the_file": sorted(os.listdir(hermes_home)) == [".env"], "cleanup_ran": self._cleaned})
        if self.own:
            os.environ[self.own] = "1"
        with open(path, "rb") as handle:
            data = handle.read()
        for line in data.decode("utf-8", "replace").splitlines():
            name, equals, value = line.partition("=")
            if equals and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):  # a statement that does not start with a plain name is dropped, as the parser drops it
                os.environ[name] = value
        if self.rewrite is not None:
            with open(path, "wb") as handle:
                handle.write(self.rewrite)
        if self.fail:
            raise ValueError("stand-in failure")


def strip_one_pair(data):
    """A clean-up step for `StandInLoader` that changes the file until it starts with the assignment."""
    return data[len(b" " + BOM):] if data.startswith(b" " + BOM) else data


def starts_with_the_assignment(raw, name):
    return raw.startswith(name.encode() + b"=1")


class StandInGate:
    """Refuses a name that is assigned `1` in the bytes it is given, by the gate's own wording, and records what it was given."""

    def __init__(self, names=("HERMES_SAFE_MODE",), extra=()):
        self.names, self.extra, self.seen = names, extra, []

    def volume_env_problems(self, path):
        with open(path, "rb") as handle:
            raw = handle.read()
        self.seen.append(raw)
        return ["the volume's .env sets %s (why)" % name for name in self.names if (name + "=1").encode() in raw] + list(self.extra)


class FirstReadingGate(StandInGate):
    """Judges the file as it stands and nothing else: a name is refused when the bytes START with its assignment."""

    def volume_env_problems(self, path):
        with open(path, "rb") as handle:
            raw = handle.read()
        self.seen.append(raw)
        return ["the volume's .env sets %s (why)" % name for name in self.names if starts_with_the_assignment(raw, name)] + list(self.extra)


def pair_stripping_chain(raw):
    """The files `StandInLoader(clean=strip_one_pair)` goes through, as a model of them: `[raw, after one load, ...]`."""
    files = [raw]
    while strip_one_pair(files[-1]) != files[-1]:
        files.append(strip_one_pair(files[-1]))
    return files


class EveryLoadGate(StandInGate):
    """Follows the file through the loads of `StandInLoader(clean=strip_one_pair)` (the same model `run` holds to the loader's files) and
    refuses a name when any file of that chain starts with its assignment."""

    def volume_env_problems(self, path):
        with open(path, "rb") as handle:
            raw = handle.read()
        self.seen.append(raw)
        return ["the volume's .env sets %s (why)" % name for name in self.names
                if any(starts_with_the_assignment(state, name) for state in pair_stripping_chain(raw))] + list(self.extra)

    def env_states(self, raw):
        return pair_stripping_chain(raw)


class CleanedOnlyGate(StandInGate):
    """Judges only what `clean` leaves of the file."""

    def __init__(self, clean, **kwargs):
        super().__init__(**kwargs)
        self.clean = clean

    def volume_env_problems(self, path):
        with open(path, "rb") as handle:
            raw = self.clean(handle.read())
        self.seen.append(raw)
        return ["the volume's .env sets %s (why)" % name for name in self.names if (name + "=1").encode() in raw] + list(self.extra)


def stand_in_line_reader(raw):
    """A line-by-line reader that only exists to show the plumbing: every `NAME=value` line that is not a comment (cut at every `splitlines`
    boundary, blanks around the name stripped), the last one of a name winning. It knows nothing of Hermes."""
    out = {}
    for line in raw.decode("utf-8", "replace").splitlines():
        if line.strip().startswith("#"):
            continue
        name, equals, value = line.partition("=")
        if equals and name.strip():
            out[name.strip()] = value.strip()
    return out


class NoCleanupLoader:
    """A loader with no clean-up step to switch off."""

    def __init__(self):
        self._DOTENV_PUBLISHED = {}

    def load_hermes_dotenv(self, hermes_home=None, load_external_secrets=True):
        pass


def holds_allowed_names_only(raw):
    """Whether every statement of `raw` (read as UTF-8, one mark in front allowed, cut at every line end) is the assignment of an allowed name."""
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return False
    allowed = set(oracle.SECRETS) | set(oracle.SEEDED)
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if line.partition("=")[0].strip() not in allowed:
            return False
    return True


class OracleComparison(unittest.TestCase):
    """The comparison in infra/hermes/env_loader_oracle.py, offline. The in-image proof runs it against Hermes' REAL loader."""

    def test_the_policy_names_what_hermes_must_not_end_with(self):
        for applied, want in (
            ({}, set()),
            ({"OPENAI_API_KEY": "x", "ANTHROPIC_API_KEY": ""}, set()),
            ({"GOOGLE_OAUTH_CLIENT_ID": "x", "GOOGLE_OAUTH_CLIENT_SECRET": "y"}, {"GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"}),  # service variables
            ({"TERMINAL_TIMEOUT": "60", "WEB_TOOLS_DEBUG": "false"}, set()),
            ({"TERMINAL_TIMEOUT": "61"}, {"TERMINAL_TIMEOUT"}),
            ({"WEB_TOOLS_DEBUG": "true"}, {"WEB_TOOLS_DEBUG"}),
            ({"HERMES_SAFE_MODE": "0"}, {"HERMES_SAFE_MODE"}),
            ({"HERMES_YOLO_MODE": ""}, {"HERMES_YOLO_MODE"}),
            ({"HTTP_PROXY": ""}, {"HTTP_PROXY"}),
            ({"NO_PROXY": "localhost"}, {"NO_PROXY"}),
            ({"OPENAI_API_KEY_2": "x"}, {"OPENAI_API_KEY_2"}),
            ({"openai_api_key": "x"}, {"openai_api_key"}),
            ({FEFF + "OPENAI_API_KEY": "x"}, {FEFF + "OPENAI_API_KEY"}),
        ):
            with self.subTest(applied=applied):
                self.assertEqual(oracle.violations(applied), want)
        self.assertEqual(oracle.violations({"OORT_OWN": "1", "OPENAI_API_KEY": "x"}, ignore=("OORT_OWN",)), set())

    def test_the_gates_problems_are_read_back_by_name(self):
        # The problems come from the real function, so a change to their wording breaks here and not silently in the proof.
        text = ("HERMES_YOLO_MODE=1\nAPI_SERVER_CORS_ORIGINS=x\nAPI_SERVER_KEY=short\nFAL_KEY=ffff\nHERMES_SAFE_MODE=${X}\n"
                "HTTPS_PROXY=http://p.example\nall_proxy=socks5://p.example\nOORT_SELF_MEDIA_ORIGIN=https://o.example.com\n"
                "HERMES_MEDIA_DELIVERY_STRICT=0\nTERMINAL_TIMEOUT=999\nOPENAI_API_KEY=ok\n").encode()
        for parser, impl in PARSERS:
            with self.subTest(parser=parser), mock.patch.object(lockgate, "_DotEnv", impl):
                names, file_level = oracle.named(oracle.gate_view(lockgate, text))
                self.assertEqual(names, {"HERMES_YOLO_MODE", "API_SERVER_CORS_ORIGINS", "API_SERVER_KEY", "FAL_KEY", "HERMES_SAFE_MODE",
                                         "HTTPS_PROXY", "all_proxy", "OORT_SELF_MEDIA_ORIGIN", "HERMES_MEDIA_DELIVERY_STRICT", "TERMINAL_TIMEOUT"})
                self.assertFalse(file_level)
                names, file_level = oracle.named(oracle.gate_view(lockgate, b"A=1\n\xe9\n"))
                self.assertEqual((names, file_level), (set(), True))

    def test_compare_finds_a_miss_a_needless_refusal_and_the_reason_for_it(self):
        def sets_(name):
            return "the volume's .env sets %s (why)" % name

        self.assertEqual(oracle.compare(b"", {"HERMES_SAFE_MODE"}, [])["missed"], ["HERMES_SAFE_MODE"], "a name nothing refuses is a miss")
        self.assertEqual(oracle.compare(b"", {"HERMES_SAFE_MODE"}, [sets_("HERMES_SAFE_MODE")]),
                         {"file_refused": False, "missed": [], "needless": []})
        for label, raw, name, reason in (
            ("a NUL in the name", b"x\x00_PROXY=1\n", "x\x00_PROXY", "NUL in the statement"),
            ("a NUL on the line of the name", b"FAL_KEY=\x00\n", "FAL_KEY", "NUL in the statement"),
            ("a NUL on the line of the name, in a utf-16 file", b"\xff\xfe" + "FAL_KEY=\x00\n".encode("utf-16-le"), "FAL_KEY",
             "NUL in the statement"),
            ("a NUL on the line of a name read as Latin-1", b"\xff\xfe\xfd\xff=\x00\n", "\xff\xfe\xfd\xff", "NUL in the statement"),
            ("a NUL on another line is no excuse", b"X=\x00\nFAL_KEY=\n", "FAL_KEY", "unexplained"),
            ("a name the slot already has", b"HERMES_HOME=/opt/data\n", "HERMES_HOME", "name the slot already has"),
            ("a name the slot does not have", b"HERMES_SAFE_MODE=0\n", "HERMES_SAFE_MODE", "unexplained"),
            ("a mark elsewhere is no excuse", BOM + BOM + b"HERMES_SAFE_MODE=0\n", "HERMES_SAFE_MODE", "unexplained"),
            ("a reference is no excuse any more", b"HERMES_SAFE_MODE=${X}\n", "HERMES_SAFE_MODE", "unexplained"),
            ("a mark inside a proxy name is no excuse any more", (FEFF + "HTTP_PROXY=p\n").encode(), FEFF + "HTTP_PROXY", "unexplained"),
        ):
            with self.subTest(case=label):
                self.assertEqual(oracle.compare(raw, set(), [sets_(name)])["needless"], [(name, reason)])
        # when the loader really raised on a file with a NUL, any name of that file may be refused beyond what it applied (the NUL can sit on
        # another line of the same quoted statement, or in a statement before it); a loader error without a NUL, or a NUL without an error, excuses nothing
        nul_in_the_quote = b'HERMES_SAFE_MODE="1\nx=\x00"\n'
        self.assertEqual(oracle.compare(nul_in_the_quote, set(), [sets_("HERMES_SAFE_MODE")], raised=True)["needless"],
                         [("HERMES_SAFE_MODE", "NUL in the statement")])
        self.assertEqual(oracle.compare(nul_in_the_quote, set(), [sets_("HERMES_SAFE_MODE")])["needless"], [("HERMES_SAFE_MODE", "unexplained")])
        self.assertEqual(oracle.compare(b"HERMES_SAFE_MODE=0\n", set(), [sets_("HERMES_SAFE_MODE")], raised=True)["needless"],
                         [("HERMES_SAFE_MODE", "unexplained")])
        verdict = oracle.compare(b"\xe9", {"HERMES_SAFE_MODE"}, ["the volume's .env is not valid UTF-8 (why)"])
        self.assertEqual(verdict, {"file_refused": True, "missed": [], "needless": []}, "a refused file has nothing left to miss")

    def test_the_generators_make_the_shapes_the_review_found_missing(self):
        table = [label for label, _raw in oracle.table_cases()]
        for name, _value, _other in oracle.FORBIDDEN_FULL:
            for kind in ("applied", "inert", "mark applied", "later applied", "as-is applied"):
                self.assertTrue(any(label.startswith("%s: %s: " % (kind, name)) for label in table), (kind, name))
            for shape in ("first character U+FFFD, a NUL line, an open quote", "16 blank-and-mark pairs", "3 tab-and-mark pairs"):
                self.assertTrue(any(label.endswith(": %s: %s" % (name, shape)) for label in table), (shape, name))
        for name, _value, _other in oracle.FORBIDDEN_FULL:
            for shape in ("unterminated double quote", "bare name after the assignment", "inside a multi-line quoted value",
                          "after a form feed on the same line", "in the tail of a comment, after U+2029"):
                self.assertIn("line-read: %s: %s" % (name, shape), table)
        for name, _value, _other in oracle.FORBIDDEN_PLAIN:
            self.assertTrue(any(label.startswith("applied: %s: " % name) for label in table), name)
        for name in list(oracle.SECRETS) + list(oracle.SEEDED):
            self.assertTrue(any(label.startswith("clean: %s: " % name) for label in table), name)
        for count, kind in ((oracle.LOAD_CAP, "later applied"), (oracle.LOAD_CAP + 1, "unbounded"), (oracle.LOAD_CAP + 6, "unbounded")):
            self.assertIn("%s: %d blank-and-mark pairs, at the load cap" % (kind, count), table)
        self.assertEqual(oracle.LOAD_CAP, lockgate.ENV_LOAD_CAP, "the oracle follows exactly as many rewrites as the gate does")
        cases = oracle.random_cases(4886, 2000)
        self.assertEqual(cases[:40], oracle.random_cases(4886, 40), "the same seed gives the same inputs")
        counts = {"two marks in front": 0, "a mark behind blanks": 0, "three blank-and-mark pairs in a row": 0, "U+FFFD as the first character": 0,
                  "a NUL line and an open quote": 0, "a reference": 0, "a line the clean-up rewrites": 0, "utf-16": 0, "bytes that are not utf-8": 0,
                  "an allowed name": 0, "a name that is not allowed": 0, "a boundary only the line-by-line reader cuts at": 0, "a file of allowed names only": 0}
        for _label, raw in cases:
            counts["three blank-and-mark pairs in a row"] += re.search(rb"(?:(?:[ \t\x0c\x1c]|\xc2[\x85\xa0])\xef\xbb\xbf){3}", raw) is not None
            counts["U+FFFD as the first character"] += raw.startswith((b"\xef\xbf\xbd", BOM + b"\xef\xbf\xbd"))
            counts["a NUL line and an open quote"] += re.search(rb"\x00 (?:ANTHROPIC_API_KEY=|\"\n)|X=1\x00 Q=", raw) is not None
            counts["a boundary only the line-by-line reader cuts at"] += re.search("[\u2028\u2029\x1d\x1e]", raw.decode("utf-8", "replace")) is not None
            counts["a file of allowed names only"] += holds_allowed_names_only(raw)
            counts["two marks in front"] += raw.startswith(BOM + BOM)
            counts["a mark behind blanks"] += re.search(rb"[ \t\x0c\x1c]\xef\xbb\xbf", raw) is not None
            counts["a reference"] += re.search(rb"\$(?:\{|[A-Za-z_])", raw) is not None
            counts["a line the clean-up rewrites"] += b" OPENAI_API_KEY=1\n" in raw
            counts["utf-16"] += raw[:2] in (b"\xff\xfe", b"\xfe\xff")
            counts["an allowed name"] += re.search(rb"OPENAI_API_KEY|TERMINAL_TIMEOUT|ANTHROPIC_API_KEY", raw) is not None
            counts["a name that is not allowed"] += re.search(rb"HERMES_SAFE_MODE|HTTPS_PROXY|OORT_ORACLE_A", raw) is not None
            try:
                raw.decode("utf-8")
            except UnicodeDecodeError:
                counts["bytes that are not utf-8"] += 1
        for shape, count in counts.items():
            with self.subTest(shape=shape):
                self.assertGreaterEqual(count, 20, counts)

    def run_oracle(self, loader, gate, cases, line_reader=None):
        with mock.patch.dict(os.environ, {"OORT_TEST_SENTINEL": "1"}):
            before = dict(os.environ)
            summary = oracle.run(loader, gate, cases, line_reader=line_reader)
            self.assertEqual(dict(os.environ), before, "the loader's environment must not leak into this process")
        return summary

    def test_run_isolates_the_loader_and_gives_the_gate_the_original_bytes(self):
        loader, gate = StandInLoader(rewrite=b"HERMES_YOLO_MODE=1\n"), StandInGate()
        raw = b"HERMES_SAFE_MODE=1\n"
        summary = self.run_oracle(loader, gate, [("applied: x", raw)])
        control, call = loader.calls[0], loader.calls[1]
        self.assertEqual(summary["loader_own_names"], 0)
        self.assertEqual(control["home"] == call["home"], False, "the control is a load of its own, in a folder of its own")
        self.assertFalse(call["external"], "external secret sources are off")
        self.assertEqual(call["published"], {}, "the loader's record of earlier passes is cleared before each load")
        self.assertEqual(loader._DOTENV_PUBLISHED, {})
        self.assertNotIn("OORT_TEST_SENTINEL", call["env"], "the loader runs in the slot's environment, not this process's")
        self.assertEqual({name: call["env"].get(name) for name in ("HOME", "HERMES_SUPERVISED_CHILD")}, {"HOME": "/opt/data", "HERMES_SUPERVISED_CHILD": "1"})
        self.assertNotIn("HERMES_SAFE_MODE", call["env"])
        self.assertTrue(call["managed_is_an_empty_folder"], "the loader's managed-scope folder is an empty one: no second .env to read")
        self.assertTrue(call["home_holds_only_the_file"])
        self.assertNotEqual(call["home"], oracle.SLOT_ENV["HERMES_HOME"], "the file under test sits in a folder of its own")
        self.assertEqual(gate.seen[0], raw, "the gate reads the original bytes")
        # The loader rewrote ITS copy into a file whose second load applies something the gate does not refuse: the file Hermes leaves
        # behind is judged too, against what Hermes applies when it loads THAT file (not against what the first load applied).
        self.assertEqual(gate.seen[1], b"HERMES_YOLO_MODE=1\n")
        # two loads follow the file (the second leaves it as the first did), then each file of the chain is loaded once more as it stands
        self.assertEqual([call["cleanup_ran"] for call in loader.calls[1:]], [True, True, False, False])
        self.assertEqual(loader.calls[2]["env"].get("HERMES_SAFE_MODE"), None, "the second load starts from the slot's environment again")
        self.assertEqual((summary["cases"], summary["violating"], summary["missed"], summary["missed_after"], summary["detected"]),
                         (1, 1, 0, 1, ["HERMES_SAFE_MODE"]))
        self.assertFalse(summary["ok"], "a miss on the rewritten file fails the run")
        # a file whose second load applies what the gate refuses is fine, however the first load went
        loader, gate = StandInLoader(rewrite=b"HERMES_SAFE_MODE=1\n"), StandInGate()
        summary = self.run_oracle(loader, gate, [("applied: y", raw)])
        self.assertEqual((summary["missed"], summary["missed_after"], summary["ok"]), (0, 0, True))
        # and so is one whose second load applies nothing the policy forbids, though the first load applied what the gate refused on the
        # ORIGINAL bytes: the file left behind is judged against what Hermes applies when it loads that file
        loader, gate = StandInLoader(rewrite=b"OPENAI_API_KEY=1\n"), StandInGate()
        summary = self.run_oracle(loader, gate, [("applied: z", raw)])
        self.assertEqual((summary["violating"], summary["missed"], summary["missed_after"], summary["ok"]), (1, 0, 0, True))

    def test_the_names_the_loader_adds_by_itself_are_not_the_files_doing(self):
        loader = StandInLoader(own="OORT_LOADER_OWN")
        summary = self.run_oracle(loader, StandInGate(), [("clean: a", b"OPENAI_API_KEY=1\n")])
        self.assertEqual((summary["loader_own_names"], summary["violating"], summary["clean"], summary["ok"]), (1, 0, 1, True))
        # a name the file adds beyond them is still a violation
        summary = self.run_oracle(StandInLoader(own="OORT_LOADER_OWN"), StandInGate(names=()), [("applied: a", b"HERMES_SAFE_MODE=1\n")])
        self.assertEqual((summary["violating"], summary["missed"], summary["ok"]), (1, 1, False))

    def test_run_follows_the_loader_through_every_load_of_the_file(self):
        raw = oracle.pair_run(b" ", 3) + b"HERMES_SAFE_MODE=1\n"
        # a gate that judges the file as it stands does not name what the third load applies
        loader, gate = StandInLoader(clean=strip_one_pair), FirstReadingGate()
        summary = self.run_oracle(loader, gate, [("later applied: x", raw)])
        self.assertEqual([call["cleanup_ran"] for call in loader.calls[1:]], [True] * 4 + [False] * 4, "four loads, then four files as they stand")
        self.assertEqual((summary["loads"], summary["violating"], summary["later_only"], summary["missed"], summary["missed_after"], summary["wrong_labels"],
                          summary["ok"]), ({"4": 1}, 1, 1, 0, 1, 0, False))
        self.assertIn("HERMES_SAFE_MODE", summary["examples"]["missed_after"][0][2][0])
        # the files the gate is asked about are the ones the loader leaves: it is told when a later file would be missed too
        self.assertEqual(gate.seen, [raw] + pair_stripping_chain(raw)[1:])
        # a gate that follows the same loads names it, and its model of the files is held to the loader's
        loader, gate = StandInLoader(clean=strip_one_pair), EveryLoadGate()
        summary = self.run_oracle(loader, gate, [("later applied: x", raw)])
        self.assertEqual((summary["missed"], summary["missed_after"], summary["chain_mismatch"], summary["states_compared"], summary["detected"], summary["ok"]),
                         (0, 0, 0, 1, ["HERMES_SAFE_MODE"], True))

    def test_run_holds_the_gates_model_of_the_files_to_the_loaders(self):
        class WrongModel(EveryLoadGate):
            def env_states(self, raw):
                return [raw]  # says the loader never changes the file
        raw = oracle.pair_run(b" ", 2) + b"HERMES_SAFE_MODE=1\n"
        summary = self.run_oracle(StandInLoader(clean=strip_one_pair), WrongModel(), [("later applied: x", raw)])
        self.assertEqual((summary["chain_mismatch"], summary["missed"], summary["missed_after"], summary["ok"]), (1, 0, 0, False))
        # a gate with no model at all is not held to one; one that cannot say (None) is not either
        summary = self.run_oracle(StandInLoader(clean=strip_one_pair), StandInGate(), [("later applied: x", raw)])
        self.assertEqual((summary["states_compared"], summary["chain_mismatch"]), (0, 0))

    def test_run_loads_each_file_once_more_with_the_clean_up_switched_off(self):
        raw, clean = b"HERMES_SAFE_MODE=1\n", lambda data: data.replace(b"HERMES_SAFE_MODE", b"OPENAI_API_KEY")
        # what only the file as it stands applies: a gate that judges only what the clean-up leaves misses it, and the table label says so
        loader = StandInLoader(clean=clean)
        summary = self.run_oracle(loader, CleanedOnlyGate(clean), [("as-is applied: x", raw)])
        self.assertEqual([call["cleanup_ran"] for call in loader.calls[1:]], [True, True, False, False])
        self.assertEqual((summary["cleanup_step_found"], summary["violating"], summary["as_stands_only"], summary["later_only"], summary["missed"],
                          summary["wrong_labels"], summary["ok"]), (True, 1, 1, 0, 1, 0, False))
        summary = self.run_oracle(StandInLoader(clean=clean), StandInGate(), [("as-is applied: x", raw)])
        self.assertEqual((summary["missed"], summary["as_stands_only"], summary["ok"]), (0, 1, True))
        # a label that promises the file only applies as it stands, on a loader whose clean-up changes nothing, is a wrong label
        summary = self.run_oracle(StandInLoader(), StandInGate(), [("as-is applied: x", raw)])
        self.assertEqual((summary["as_stands_only"], summary["wrong_labels"], summary["ok"]), (0, 1, False))
        # a loader with no clean-up step has nothing to switch off, and the summary says so
        self.assertFalse(self.run_oracle(NoCleanupLoader(), StandInGate(), [("random", raw)])["cleanup_step_found"])

    def test_run_demands_a_refusal_of_the_whole_file_when_the_loader_never_stops_changing_it(self):
        raw = b"OPENAI_API_KEY=0\n"
        never_settles = lambda data: data + b"#\n"
        summary = self.run_oracle(StandInLoader(clean=never_settles), StandInGate(), [("random", raw)])
        self.assertEqual((summary["unsettled"], summary["file_refused"], summary["ok"]), (1, 0, False))
        self.assertEqual(summary["examples"]["unsettled"][0][2], oracle.LOAD_CAP + 1)
        refusing = StandInGate(extra=["cannot parse the volume's .env: still changing"])
        summary = self.run_oracle(StandInLoader(clean=never_settles), refusing, [("random", raw)])
        self.assertEqual((summary["unsettled"], summary["file_refused"], summary["ok"]), (0, 1, True))

    def test_run_counts_what_the_proof_has_to_be_able_to_tell(self):
        good = StandInGate()
        summary = self.run_oracle(StandInLoader(), good, [("applied: a", b"HERMES_SAFE_MODE=1\n"), ("clean: b", b"OPENAI_API_KEY=x\n"),
                                                          ("random", b"ANTHROPIC_API_KEY=1\n")])
        self.assertEqual((summary["cases"], summary["violating"], summary["clean"], summary["ok"]), (3, 1, 2, True))
        self.assertEqual(summary["detected"], ["HERMES_SAFE_MODE"])
        # a miss: the loader applies a name the gate does not refuse
        summary = self.run_oracle(StandInLoader(), StandInGate(names=()), [("applied: a", b"HERMES_SAFE_MODE=1\n")])
        self.assertEqual((summary["missed"], summary["ok"]), (1, False))
        self.assertEqual(summary["examples"]["missed"][0][2], ["HERMES_SAFE_MODE"])
        # the gate that allows one name too many is a miss too: the loader applies it, the oracle's own list does not allow it
        summary = self.run_oracle(StandInLoader(), StandInGate(names=()), [("applied: a", b"OPENROUTER_API_KEY=1\n")])
        self.assertEqual((summary["missed"], summary["ok"]), (1, False))
        # a refusal nobody can explain
        summary = self.run_oracle(StandInLoader(), StandInGate(extra=["the volume's .env sets HERMES_YOLO_MODE (why)"]),
                                  [("random", b"OPENAI_API_KEY=1\n")])
        self.assertEqual((summary["unexplained"], summary["ok"]), (1, False))
        # a table label the loader contradicts: an "inert" row it applies, an "applied" one it does not violate, a "clean" one it violates
        for label, raw in (("inert: a", b"HERMES_SAFE_MODE=1\n"), ("applied: a", b"OPENAI_API_KEY=1\n"), ("clean: a", b"HERMES_SAFE_MODE=1\n")):
            with self.subTest(label=label):
                summary = self.run_oracle(StandInLoader(), StandInGate(), [(label, raw)])
                self.assertEqual((summary["wrong_labels"], summary["ok"]), (1, False))
        # a loader that cannot load the file: counted, nothing compared, and this process's environment is still back
        loader = StandInLoader(fail=True)
        summary = self.run_oracle(loader, StandInGate(), [("random", b"HERMES_SAFE_MODE=1\n")])
        self.assertEqual((summary["hermes_errors"], summary["violating"], summary["ok"]), (1, 0, True))

    def test_named_reads_a_name_that_holds_a_parenthesis_when_the_readers_know_it(self):
        # the line-by-line reader takes anything in front of an `=` for a name, a blank and a parenthesis included
        problem = "the volume's .env sets a (b (not an allowed name: x)"
        self.assertEqual(oracle.named([problem], known={"a (b"}), ({"a (b"}, False))
        self.assertEqual(oracle.named([problem], known={"a (b", "a"}), ({"a (b"}, False), "the longest known name wins")
        self.assertEqual(oracle.named([problem]), ({"a"}, False), "without it the pattern stops at the first parenthesis")

    def test_the_line_break_reason_is_computed_from_the_readings_and_pythons_own_idea_of_a_line(self):
        sets_ = "the volume's .env sets %s (why)"
        verdict = oracle.compare(b"", set(), [sets_ % "OPENAI_API_KEY"], boundary={"OPENAI_API_KEY"})
        self.assertEqual(verdict["needless"], [("OPENAI_API_KEY", "line break in an allowed value")])
        self.assertEqual(oracle.compare(b"", set(), [sets_ % "OPENAI_API_KEY"])["needless"], [("OPENAI_API_KEY", "unexplained")])
        for parser, impl in PARSERS:
            with self.subTest(parser=parser), mock.patch.object(lockgate, "_DotEnv", impl):
                for boundary in lockgate.LINE_BREAKS:
                    raw = ("OPENAI_API_KEY='a%sb'\n" % boundary).encode("utf-8")
                    self.assertEqual(oracle.boundary_names(lockgate, raw), {"OPENAI_API_KEY"}, repr(boundary))
                self.assertEqual(oracle.boundary_names(lockgate, b"OPENAI_API_KEY='a b'\nHERMES_SAFE_MODE=1\n"), set())
                self.assertEqual(oracle.boundary_names(lockgate, b"HERMES_SAFE_MODE='a\nb'\n"), set(), "only an allowed name has this reason")
        self.assertEqual(oracle.boundary_names(StandInGate(), b"OPENAI_API_KEY='a\nb'\n"), set(), "a gate with no readings has none")

    def test_the_real_gate_and_a_stand_in_reader_agree_on_what_the_line_break_rule_refuses(self):
        # through `run`, with a stand-in loader that applies nothing for the allowed name: the refusal is `needless`, and designed
        raw = b"OPENAI_API_KEY='a\nb'\n"
        for parser, impl in PARSERS:
            with self.subTest(parser=parser), mock.patch.object(lockgate, "_DotEnv", impl):
                summary = self.run_oracle(StandInLoader(), lockgate, [("clean: x", raw)], line_reader=stand_in_line_reader)
                self.assertEqual((summary["needless"], summary["unexplained"], summary["missed"], summary["ok"]),
                                 ({"line break in an allowed value": 1}, 0, 0, True))

    def test_run_asks_the_line_by_line_reader_about_every_file_and_holds_the_gate_to_it(self):
        raw = b" HERMES_SAFE_MODE=1\n"  # the stand-in loader needs the name at the start of the line; the line-by-line reader does not
        summary = self.run_oracle(StandInLoader(), StandInGate(names=()), [("random", raw)])
        self.assertEqual((summary["line_reader"], summary["violating"], summary["missed"], summary["ok"]), (False, 0, 0, True), "no reader, no dimension")
        summary = self.run_oracle(StandInLoader(), StandInGate(names=()), [("random", raw)], line_reader=stand_in_line_reader)
        self.assertEqual((summary["line_reader"], summary["violating"], summary["line_reader_only"], summary["missed"], summary["ok"]), (True, 1, 1, 1, False))
        self.assertEqual(summary["examples"]["missed"][0][2], ["HERMES_SAFE_MODE"])
        summary = self.run_oracle(StandInLoader(), StandInGate(), [("random", raw)], line_reader=stand_in_line_reader)
        self.assertEqual((summary["violating"], summary["line_reader_only"], summary["missed"], summary["detected"], summary["ok"]),
                         (1, 1, 0, ["HERMES_SAFE_MODE"], True))
        # an allowed name the line reader reads is not a violation of its own
        summary = self.run_oracle(StandInLoader(), StandInGate(), [("clean: a", b" OPENAI_API_KEY=1\n")], line_reader=stand_in_line_reader)
        self.assertEqual((summary["violating"], summary["clean"], summary["line_reader_only"], summary["ok"]), (0, 1, 0, True))

    def test_run_reads_the_file_the_loader_leaves_behind_with_the_line_by_line_reader_too(self):
        # the loader rewrites its copy into a file only the line-by-line reader reads: the gate has to be asked about that file as well, and
        # to name on the ORIGINAL bytes what a later file holds (the boot gate sees nothing else)
        rewrite, raw = b" HERMES_YOLO_MODE=1\n", b"# HERMES_YOLO_MODE=1\nOPENAI_API_KEY=1\n"
        summary = self.run_oracle(StandInLoader(rewrite=rewrite), StandInGate(names=()), [("random", raw)], line_reader=stand_in_line_reader)
        self.assertEqual((summary["violating"], summary["later_only"], summary["missed"], summary["missed_after"], summary["ok"]), (1, 1, 0, 1, False))
        gate = StandInGate(names=("HERMES_YOLO_MODE",))
        summary = self.run_oracle(StandInLoader(rewrite=rewrite), gate, [("random", raw)], line_reader=stand_in_line_reader)
        self.assertEqual((summary["missed"], summary["missed_after"], summary["ok"]), (0, 0, True))
        self.assertEqual(gate.seen, [raw, rewrite], "the gate is given the original bytes and then the file the loader left")

    def test_run_holds_the_gates_copy_of_the_line_reader_to_the_real_one(self):
        class PortGate(StandInGate):
            def __init__(self, port, **kwargs):
                super().__init__(**kwargs)
                self.port = port

            def env_loaded_text(self, raw):
                return raw.decode("utf-8", "replace")

            def line_assignments(self, text):
                return self.port(text.encode("utf-8"))

        raw = b" HERMES_SAFE_MODE=1\n"
        summary = self.run_oracle(StandInLoader(), PortGate(stand_in_line_reader), [("random", raw)], line_reader=stand_in_line_reader)
        self.assertEqual((summary["line_reader_mismatch"], summary["line_states_compared"], summary["ok"]), (0, 1, True))
        summary = self.run_oracle(StandInLoader(), PortGate(lambda data: {}), [("random", raw)], line_reader=stand_in_line_reader)
        self.assertEqual((summary["line_reader_mismatch"], summary["ok"]), (1, False))
        self.assertEqual(summary["examples"]["line_reader_mismatch"][0][0], "random")
        # a gate with no copy of the reader is not held to one, and a run with no real reader has nothing to hold it to
        summary = self.run_oracle(StandInLoader(), StandInGate(), [("random", raw)], line_reader=stand_in_line_reader)
        self.assertEqual((summary["line_states_compared"], summary["line_reader_mismatch"]), (0, 0))
        summary = self.run_oracle(StandInLoader(), PortGate(lambda data: {}), [("random", raw)])
        self.assertEqual((summary["line_states_compared"], summary["line_reader_mismatch"]), (0, 0))

    def test_a_label_that_promises_only_the_line_by_line_reader_reads_it_is_checked_against_it(self):
        raw = b" HERMES_SAFE_MODE=1\n"
        summary = self.run_oracle(StandInLoader(), StandInGate(), [("line-read: a", raw)], line_reader=stand_in_line_reader)
        self.assertEqual((summary["wrong_labels"], summary["ok"]), (0, True))
        # the reader reads nothing: the promise is false
        summary = self.run_oracle(StandInLoader(), StandInGate(), [("line-read: a", raw)], line_reader=lambda data: {})
        self.assertEqual((summary["wrong_labels"], summary["ok"]), (1, False))
        # the loader applies it too: it is not "only"
        summary = self.run_oracle(StandInLoader(), StandInGate(), [("line-read: a", b"HERMES_SAFE_MODE=1\n")], line_reader=stand_in_line_reader)
        self.assertEqual((summary["wrong_labels"], summary["ok"]), (1, False))
        # without a reader there is nothing to check it against: the promise is not held to anything
        summary = self.run_oracle(StandInLoader(), StandInGate(names=()), [("line-read: a", raw)])
        self.assertEqual((summary["wrong_labels"], summary["ok"]), (0, True))
        # "never" now means no reader at all: an "inert" row that only the line-by-line reader reads is a wrong label
        summary = self.run_oracle(StandInLoader(), StandInGate(), [("inert: a", raw)], line_reader=stand_in_line_reader)
        self.assertEqual((summary["wrong_labels"], summary["ok"]), (1, False))

    def test_a_loader_that_raises_is_not_a_reason_to_skip_the_line_by_line_reader(self):
        raw = b" HERMES_SAFE_MODE=1\n"
        summary = self.run_oracle(StandInLoader(fail=True), StandInGate(names=()), [("random", raw)], line_reader=stand_in_line_reader)
        self.assertEqual((summary["hermes_errors"], summary["missed"], summary["ok"]), (1, 1, False))
        summary = self.run_oracle(StandInLoader(fail=True), StandInGate(), [("random", raw)], line_reader=stand_in_line_reader)
        self.assertEqual((summary["hermes_errors"], summary["missed"], summary["ok"]), (1, 0, True))
        refusing = StandInGate(names=(), extra=["cannot parse the volume's .env: stand-in"])
        summary = self.run_oracle(StandInLoader(fail=True), refusing, [("random", raw)], line_reader=stand_in_line_reader)
        self.assertEqual((summary["missed"], summary["ok"]), (0, True), "a refused file has nothing left to miss")

    def test_the_image_reader_is_wrapped_into_one_file_of_its_own_per_input(self):
        seen = []

        def load_env_file(path):  # the shape of `agent.secret_scope.load_env_file`: a path in, `{name: value}` out
            seen.append(path)
            with open(path, "rb") as handle:
                return {line.split(b"=")[0].decode(): "v" for line in handle.read().splitlines() if b"=" in line}

        read = oracle.line_reader_of(load_env_file)
        self.assertEqual(read(b"A=1\nB=2\n"), {"A": "v", "B": "v"})
        self.assertEqual(read(b"C=3\n"), {"C": "v"})
        self.assertEqual(len(set(map(str, seen))), 2, "a path of its own each time: the reader's per-path memo never answers for another input")
        self.assertTrue(all(path.name == ".env" for path in seen))
        self.assertEqual(oracle.line_violations(read, b"OPENAI_API_KEY=1\nHERMES_SAFE_MODE=1\n"), {"HERMES_SAFE_MODE"})


if __name__ == "__main__":
    unittest.main()
