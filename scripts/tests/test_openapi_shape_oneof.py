#!/usr/bin/env python3
"""RED/GREEN proof for the strict OpenAPI oneOf response validator."""

import importlib.util
import pathlib
import sys


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "openapi_shape_check.py"
SPEC = importlib.util.spec_from_file_location("openapi_shape_check", SCRIPT)
assert SPEC and SPEC.loader
shape = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(shape)


def errors_for(schema, value):
    errors = []
    shape.validate({}, schema, value, "$", errors)
    return errors


def main():
    closed_a = {
        "type": "object",
        "additionalProperties": False,
        "required": ["kind", "a"],
        "properties": {
            "kind": {"type": "string", "enum": ["a"]},
            "a": {"type": "integer"},
        },
    }
    closed_b = {
        "type": "object",
        "additionalProperties": False,
        "required": ["kind", "b"],
        "properties": {
            "kind": {"type": "string", "enum": ["b"]},
            "b": {"type": "string"},
        },
    }
    union = {"oneOf": [closed_a, closed_b]}
    assert not errors_for(union, {"kind": "a", "a": 1})
    assert errors_for(union, {"kind": "a"}), "no-branch value must fail"

    ambiguous = {"oneOf": [{"type": "number"}, {"type": "integer"}]}
    assert errors_for(ambiguous, 1), "multi-branch value must fail"

    nullable = {
        "nullable": True,
        "oneOf": [{"type": "string"}, {"type": "number"}],
    }
    assert not errors_for(nullable, None)
    print("[openapi-shape-oneof] PASS strict single-branch and nullable union contract")
    return 0


if __name__ == "__main__":
    sys.exit(main())
