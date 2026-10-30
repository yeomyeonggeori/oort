"""Offline tests for the oort image-guard plugin (#4820, ADR-0203 I2): python3 -m unittest infra/hermes/test_image_guard.py -v

The plugin is pure stdlib, so it loads here without Hermes. What these tests pin:
  * the accept/refuse table (what may reach `image_generate`'s two address arguments),
  * the zero-access property: refusing or accepting never touches the network or a file (faked and counted),
  * the guard never raises and fails CLOSED,
  * the hook is registered once under the right name, and the plugin directory is exactly what lockgate.py pins.
Each refusal has its own subtest, so widening the accept rule breaks a named case. How the gate judges the plugin
(files, config, environment, canary) is tested in test_lockgate_image_guard.py.
"""
import ast
import builtins
import hashlib
import importlib.util
import io
import os
import pathlib
import re
import socket
import sys
import unittest
import urllib.request
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.join(HERE, "plugins", "oort-image-guard")


def load(path, name):
    # No bytecode next to the files the gate pins: a __pycache__ in the plugin directory would be a third file.
    previous, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


guard = load(os.path.join(PLUGIN_DIR, "__init__.py"), "oort_image_guard_under_test")
lockgate = load(os.path.join(HERE, "lockgate.py"), "lockgate_for_image_guard_plugin_test")

TINY_PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==")
PNG_URL = "data:image/png;base64," + TINY_PNG
HOOK_KWARGS = {"task_id": "", "session_id": "s", "tool_call_id": "c1", "turn_id": "t1", "api_request_id": "r1",
               "middleware_trace": [], "telemetry_schema_version": "1"}


def verdict(args, tool="image_generate"):
    return guard.pre_tool_call(tool_name=tool, args=args, **HOOK_KWARGS)


def edge_url(extra=0):
    """A png data URL whose payload is exactly the cap (plus `extra`) characters."""
    return "data:image/png;base64," + "A" * (guard.MAX_BASE64_CHARS + extra)


ACCEPTED = {
    "no sources at all": {"prompt": "a cat"},
    "explicit empty image_url": {"prompt": "a cat", "image_url": ""},
    "null image_url": {"prompt": "a cat", "image_url": None},
    "empty reference list": {"prompt": "a cat", "reference_image_urls": []},
    "null reference list": {"prompt": "a cat", "reference_image_urls": None},
    "empty reference string": {"prompt": "a cat", "reference_image_urls": ""},
    "empty item in the list": {"prompt": "a cat", "reference_image_urls": [""]},
    "tiny png as image_url": {"prompt": "a cat", "image_url": PNG_URL},
    "tiny png as one reference": {"prompt": "a cat", "reference_image_urls": [PNG_URL]},
    "tiny png as a bare reference string": {"prompt": "a cat", "reference_image_urls": PNG_URL},
    "all four mime types": {"prompt": "a cat", "reference_image_urls": [
        "data:image/%s;base64,%s" % (kind, TINY_PNG) for kind in ("png", "jpeg", "webp", "gif")]},
    "padding characters": {"prompt": "a cat", "image_url": "data:image/gif;base64,QQ=="},
    "exactly 4 MiB worth of base64": {"prompt": "a cat", "image_url": edge_url()},
    "extra unrelated arguments": {"prompt": "a cat", "aspect_ratio": "square", "upscale": False, "n": 1},
    "tuple of pictures": {"prompt": "a cat", "reference_image_urls": (PNG_URL, PNG_URL)},
}

REFUSED = {
    # the planner's table: http, https, any case, surrounding whitespace, file:, absolute path, relative path,
    # another data type, oversized data
    "http": ("image_url", "http://leak.example/?q=secret"),
    "https": ("image_url", "https://leak.example/x.png"),
    "HTTP upper case": ("image_url", "HTTP://LEAK.EXAMPLE/X"),
    "Https mixed case": ("image_url", "HtTpS://leak.example/x"),
    "leading space": ("image_url", " https://leak.example/x"),
    "trailing space": ("image_url", "https://leak.example/x "),
    "leading newline": ("image_url", "\nhttps://leak.example/x"),
    "file scheme": ("image_url", "file:///etc/passwd"),
    "absolute path": ("image_url", "/etc/passwd"),
    "relative path": ("image_url", "./secret.png"),
    "parent path": ("image_url", "../../etc/passwd"),
    "home path": ("image_url", "~/.hermes/.env"),
    "windows path": ("image_url", "C:\\secret.png"),
    "unc path": ("image_url", "\\\\host\\share\\x.png"),
    "scheme-relative": ("image_url", "//leak.example/x.png"),
    "ftp": ("image_url", "ftp://leak.example/x"),
    "javascript": ("image_url", "javascript:alert(1)"),
    "data html": ("image_url", "data:text/html;base64,PGh0bWw+"),
    "data svg": ("image_url", "data:image/svg+xml;base64," + TINY_PNG),
    "data tiff": ("image_url", "data:image/tiff;base64," + TINY_PNG),
    "data without base64": ("image_url", "data:image/png,%89PNG"),
    "data with a parameter": ("image_url", "data:image/png;charset=utf-8;base64," + TINY_PNG),
    "data upper case scheme": ("image_url", "DATA:image/png;base64," + TINY_PNG),
    "data upper case mime": ("image_url", "data:IMAGE/PNG;base64," + TINY_PNG),
    "data upper case base64 word": ("image_url", "data:image/png;BASE64," + TINY_PNG),
    "data with leading space": ("image_url", " " + PNG_URL),
    "data with trailing space": ("image_url", PNG_URL + " "),
    "data with trailing newline": ("image_url", PNG_URL + "\n"),
    "data with a space in the payload": ("image_url", "data:image/png;base64,AAAA AAAA"),
    "data with a newline in the payload": ("image_url", "data:image/png;base64,AAAA\nAAAA"),
    "data with url-safe base64 characters": ("image_url", "data:image/png;base64,AA-_"),
    "data with three padding characters": ("image_url", "data:image/png;base64,AA==="),
    "data with an address in the payload": ("image_url", "data:image/png;base64,AAAA,https://leak.example/x"),
    "data with an empty payload": ("image_url", "data:image/png;base64,"),
    "data over the 4 MiB cap by one character": ("image_url", edge_url(1)),
    "data far over the cap": ("image_url", edge_url(2_000_000)),
    "bare word": ("image_url", "cat.png"),
    "number": ("image_url", 7),
    "true": ("image_url", True),
    "false": ("image_url", False),
    "zero": ("image_url", 0),
    "list as image_url": ("image_url", [PNG_URL]),
    "empty list as image_url": ("image_url", []),
    "dict as image_url": ("image_url", {"url": PNG_URL}),
    "http in references": ("reference_image_urls", ["https://leak.example/x.png"]),
    "http after a good one": ("reference_image_urls", [PNG_URL, "https://leak.example/x.png"]),
    "http beyond the 16th": ("reference_image_urls", [PNG_URL] * 16 + ["https://leak.example/x.png"]),
    "http as a bare reference string": ("reference_image_urls", "https://leak.example/x.png"),
    "path in references": ("reference_image_urls", ["/etc/passwd"]),
    "file in references": ("reference_image_urls", ["file:///etc/passwd"]),
    "upper case http in references": ("reference_image_urls", ["HTTP://LEAK.EXAMPLE"]),
    "padded http in references": ("reference_image_urls", ["  https://leak.example/x  "]),
    "padded picture in references": ("reference_image_urls", [" " + PNG_URL]),
    "oversized picture in references": ("reference_image_urls", [PNG_URL, edge_url(1)]),
    "json encoded list of http": ("reference_image_urls", '["https://leak.example/x.png"]'),
    "json encoded list of pictures": ("reference_image_urls", '["%s"]' % PNG_URL),
    "whitespace-only reference": ("reference_image_urls", ["   "]),
    "whitespace-only bare string": ("reference_image_urls", "   "),
    "null item": ("reference_image_urls", [None]),
    "number item": ("reference_image_urls", [3]),
    "nested list item": ("reference_image_urls", [[PNG_URL]]),
    "dict item": ("reference_image_urls", [{"image_url": PNG_URL}]),
    "dict as references": ("reference_image_urls", {"0": PNG_URL}),
    "number as references": ("reference_image_urls", 5),
    "true as references": ("reference_image_urls", True),
    "false as references": ("reference_image_urls", False),
}


class Table(unittest.TestCase):
    def test_every_accepted_shape_passes_with_no_directive(self):
        for name, args in ACCEPTED.items():
            with self.subTest(name):
                self.assertIsNone(verdict(args))

    def test_every_refused_shape_gets_a_block_directive_naming_the_field(self):
        for name, (field, value) in REFUSED.items():
            with self.subTest(name):
                args = {"prompt": "a cat", field: value}
                result = verdict(args)
                self.assertIsInstance(result, dict)
                self.assertEqual(result["action"], "block")
                self.assertTrue(isinstance(result["message"], str) and result["message"])
                self.assertIn(guard.MARKER, result["message"])
                self.assertIn(field, result["message"])

    def test_one_bad_argument_refuses_even_when_the_other_is_fine(self):
        for args in ({"image_url": PNG_URL, "reference_image_urls": ["https://leak.example/x"]},
                     {"image_url": "https://leak.example/x", "reference_image_urls": [PNG_URL]},
                     {"image_url": "", "reference_image_urls": ["/etc/passwd"]}):
            with self.subTest(args=sorted(args)):
                self.assertEqual(verdict(args)["action"], "block")

    def test_the_first_refused_field_is_the_one_named(self):
        result = verdict({"image_url": "https://leak.example/x", "reference_image_urls": ["/etc/passwd"]})
        self.assertIn("image_url", result["message"])
        result = verdict({"image_url": PNG_URL, "reference_image_urls": ["/etc/passwd"]})
        self.assertIn("reference_image_urls", result["message"])

    def test_the_refusal_never_echoes_what_was_refused(self):
        token = "secret-conversation-text-91f3"
        for value in ("https://%s.example/x?q=%s" % (token, token), "/home/%s/file" % token,
                      "data:text/html;base64,%s" % token, " " + token):
            with self.subTest(value=value[:24]):
                for field in ("image_url", "reference_image_urls"):
                    arg = value if field == "image_url" else [value]
                    message = verdict({field: arg})["message"]
                    self.assertNotIn(token, message)

    def test_the_cap_is_four_mebibytes_of_decoded_bytes(self):
        self.assertEqual(guard.MAX_DECODED_BYTES, 4 * 1024 * 1024)
        decoded_at_cap = guard.MAX_BASE64_CHARS // 4 * 3
        self.assertGreaterEqual(decoded_at_cap, guard.MAX_DECODED_BYTES)
        self.assertLess(decoded_at_cap - 3, guard.MAX_DECODED_BYTES)
        self.assertEqual(guard.MAX_BASE64_CHARS, 5_592_408)


class OnlyTheGuardedToolIsJudged(unittest.TestCase):
    def test_other_tools_pass_whatever_their_arguments_look_like(self):
        for tool in ("web_search", "memory", "todo_list", "session_search", "image_generator", "video_generate", "", None, 5):
            with self.subTest(tool=tool):
                self.assertIsNone(verdict({"url": "https://leak.example/x", "image_url": "/etc/passwd"}, tool=tool))

    def test_name_variants_of_the_guarded_tool_are_judged_too(self):
        for tool in ("image_generate", "Image_Generate", " image_generate ", "image-generate", "image generate", "IMAGE-GENERATE"):
            with self.subTest(tool=tool):
                self.assertEqual(verdict({"image_url": "https://leak.example/x"}, tool=tool)["action"], "block")


class NeverTouchesTheNetworkOrAFile(unittest.TestCase):
    """The refusal comes before any download, DNS lookup or file read: count every such call while judging all inputs."""

    def test_zero_network_and_file_access_for_every_input(self):
        calls = []

        def trap(label):
            def _trap(*args, **kwargs):
                calls.append(label)
                raise AssertionError("forbidden call: " + label)
            return _trap

        patches = [
            mock.patch.object(socket, name, trap("socket." + name))
            for name in ("getaddrinfo", "gethostbyname", "gethostbyname_ex", "create_connection", "socketpair")
        ] + [
            mock.patch.object(socket.socket, "connect", trap("socket.connect")),
            mock.patch.object(socket.socket, "sendall", trap("socket.sendall")),
            mock.patch.object(urllib.request, "urlopen", trap("urlopen")),
            mock.patch.object(builtins, "open", trap("open")),
            mock.patch.object(io, "open", trap("io.open")),
            mock.patch.object(os, "stat", trap("os.stat")),
            mock.patch.object(os, "listdir", trap("os.listdir")),
            mock.patch.object(os, "scandir", trap("os.scandir")),
            mock.patch.object(os.path, "exists", trap("os.path.exists")),
            mock.patch.object(os.path, "isfile", trap("os.path.isfile")),
            mock.patch.object(os.path, "expanduser", trap("os.path.expanduser")),
            mock.patch.object(os.path, "realpath", trap("os.path.realpath")),
            mock.patch.object(pathlib.Path, "read_bytes", trap("Path.read_bytes")),
            mock.patch.object(pathlib.Path, "resolve", trap("Path.resolve")),
            mock.patch.object(pathlib.Path, "is_file", trap("Path.is_file")),
            mock.patch.object(pathlib.Path, "stat", trap("Path.stat")),
        ]
        inputs = [args for args in ACCEPTED.values()]
        inputs += [{"prompt": "x", field: value} for field, value in REFUSED.values()]
        results = []
        for patch in patches:
            patch.start()
        try:
            for args in inputs:
                results.append(verdict(args))
        finally:
            for patch in reversed(patches):
                patch.stop()
        self.assertEqual(calls, [], "the guard touched the network or a file: %s" % sorted(set(calls)))
        self.assertEqual(len(results), len(ACCEPTED) + len(REFUSED))
        self.assertEqual(sum(1 for r in results if r is None), len(ACCEPTED))
        self.assertEqual(sum(1 for r in results if r is not None), len(REFUSED))

    def test_the_source_imports_only_re_and_calls_no_io(self):
        with open(os.path.join(PLUGIN_DIR, "__init__.py"), encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported |= {alias.name for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                imported.add(node.module)
        self.assertEqual(imported, {"re"})
        called = {n.func.id for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
        self.assertFalse(called & {"open", "exec", "eval", "compile", "__import__", "getattr", "setattr"}, called)


class NeverRaisesAndFailsClosed(unittest.TestCase):
    def test_hostile_values_get_a_refusal_not_an_exception(self):
        class Boom(str):
            def startswith(self, *args, **kwargs):
                raise RuntimeError("boom")

        class BoomEq(str):
            def __eq__(self, other):
                raise RuntimeError("boom")

            __hash__ = str.__hash__

        deep = []
        for _ in range(50_000):
            deep = [deep]
        for name, args in (
            ("str subclass that raises", {"image_url": Boom(PNG_URL)}),
            ("str subclass whose == raises", {"image_url": BoomEq(PNG_URL)}),
            ("deeply nested list", {"reference_image_urls": deep}),
            ("object() as image_url", {"image_url": object()}),
            ("bytes as image_url", {"image_url": PNG_URL.encode()}),
            ("not a dict", ["image_url"]),
            ("None as the argument mapping", None),
            ("a string as the argument mapping", "image_url=https://leak.example/x"),
        ):
            with self.subTest(name):
                result = verdict(args)
                self.assertIsInstance(result, dict)
                self.assertEqual(result["action"], "block")

    def test_a_failure_inside_the_decision_is_a_refusal(self):
        with mock.patch.object(guard, "refusal_field", side_effect=MemoryError("fixture")):
            result = verdict({"prompt": "a cat"})
        self.assertEqual(result["action"], "block")
        self.assertIn(guard.MARKER, result["message"])

    def test_a_failure_inside_a_non_guarded_call_is_not_this_guards_business(self):
        with mock.patch.object(guard, "refusal_field", side_effect=RuntimeError("fixture")):
            self.assertIsNone(verdict({"q": "x"}, tool="memory"))

    def test_the_arguments_are_not_modified(self):
        args = {"prompt": "a cat", "reference_image_urls": [PNG_URL, "https://leak.example/x"]}
        before = repr(args)
        verdict(args)
        self.assertEqual(repr(args), before)


class Registration(unittest.TestCase):
    def test_register_adds_exactly_one_hook_and_nothing_else(self):
        class Ctx:
            def __init__(self):
                self.hooks = []

            def register_hook(self, name, callback):
                self.hooks.append((name, callback))

        ctx = Ctx()
        guard.register(ctx)
        self.assertEqual(ctx.hooks, [("pre_tool_call", guard.pre_tool_call)])

    def test_the_callback_takes_the_whole_hook_payload_by_keyword(self):
        # Hermes passes everything to a callback that has **kwargs and only declared names to a narrow one.
        import inspect
        parameters = inspect.signature(guard.pre_tool_call).parameters
        self.assertIn("tool_name", parameters)
        self.assertIn("args", parameters)
        self.assertTrue(any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values()))


class PluginDirectory(unittest.TestCase):
    def test_the_directory_is_exactly_the_two_files_the_gate_pins(self):
        self.assertEqual(sorted(os.listdir(PLUGIN_DIR)), ["__init__.py", "plugin.yaml"])
        for name, sha in lockgate.IMAGE_GUARD_FILES.items():
            with open(os.path.join(PLUGIN_DIR, name), "rb") as handle:
                self.assertEqual(hashlib.sha256(handle.read()).hexdigest(), sha, name)
        self.assertEqual(sorted(lockgate.IMAGE_GUARD_FILES), ["__init__.py", "plugin.yaml"])

    def test_the_gate_and_the_plugin_agree_on_name_and_marker(self):
        self.assertEqual(lockgate.IMAGE_GUARD_PLUGIN, guard.PLUGIN_NAME)
        self.assertEqual(lockgate.IMAGE_GUARD_MARKER, guard.MARKER)
        self.assertEqual(lockgate.IMAGE_GUARD_TOOL, guard.GUARDED_TOOL)

    def test_the_manifest_names_the_plugin_and_its_one_hook(self):
        with open(os.path.join(PLUGIN_DIR, "plugin.yaml"), encoding="utf-8") as handle:
            text = handle.read()
        self.assertRegex(text, r"(?m)^name: oort-image-guard$")
        self.assertRegex(text, r"(?m)^kind: standalone$")
        self.assertEqual(re.findall(r"(?m)^  - (\S+)$", text), ["pre_tool_call"])
        # A version bound that Hermes cannot parse would skip the plugin silently; the gate's canary is the version check.
        self.assertNotIn("requires_hermes", text)

    def test_both_files_are_plain_ascii_without_a_byte_order_mark(self):
        for name in ("__init__.py", "plugin.yaml"):
            with open(os.path.join(PLUGIN_DIR, name), "rb") as handle:
                raw = handle.read()
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), name)
            raw.decode("ascii")
            self.assertNotIn(b"\r", raw, name)


if __name__ == "__main__":
    unittest.main()
