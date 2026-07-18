#!/usr/bin/env python3
"""openapi_shape_check.py — MOMO-389 OpenAPI drift gate validator.

Validates sampled live HTTP response bodies against the response schemas in
docs/api/openapi.yaml (pre-converted to JSON). Stdlib only; the YAML->JSON
conversion happens in scripts/verify_openapi_contract.sh (ruby or python-yaml).

Drift policy (stricter than plain OpenAPI semantics, by design):
  * required keys must be present with matching types;
  * present optional keys must match their declared type;
  * JSON null is rejected unless the schema says `nullable: true`
    (the Swift server omits nil fields instead of emitting null);
  * an object schema that declares `properties` without `additionalProperties`
    is CLOSED — undeclared response keys are contract drift;
  * `additionalProperties: true` / `{}` (empty schema) opt out for
    arbitrary-shape fields (Message.props, ApprovalProjection.payload).

Usage:
  openapi_shape_check.py --spec <openapi.json> --manifest <manifest.json>

Manifest shape:
  {"samples": [{"name": "...", "method": "post", "path": "/v1/auth/login",
                "status": "200", "body_file": "/tmp/.../login.json"}, ...]}

Exit code 0 only when every sample validates.
"""

import argparse
import json
import re
import sys

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


class SpecError(Exception):
    """The spec itself (or the manifest) is malformed for this gate."""


def resolve_ref(spec, schema, seen=None):
    """Resolve local $ref chains. Returns a concrete schema dict."""
    if seen is None:
        seen = set()
    while isinstance(schema, dict) and "$ref" in schema:
        ref = schema["$ref"]
        if ref in seen:
            raise SpecError(f"circular $ref: {ref}")
        seen.add(ref)
        if not ref.startswith("#/"):
            raise SpecError(f"non-local $ref unsupported: {ref}")
        node = spec
        for part in ref[2:].split("/"):
            part = part.replace("~1", "/").replace("~0", "~")
            if not isinstance(node, dict) or part not in node:
                raise SpecError(f"unresolvable $ref: {ref}")
            node = node[part]
        schema = node
    return schema


def type_ok(schema_type, value):
    if schema_type == "string":
        return isinstance(value, str)
    if schema_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if schema_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if schema_type == "boolean":
        return isinstance(value, bool)
    if schema_type == "object":
        return isinstance(value, dict)
    if schema_type == "array":
        return isinstance(value, list)
    raise SpecError(f"unsupported schema type: {schema_type}")


def validate(spec, schema, value, path, errors):
    schema = resolve_ref(spec, schema)
    if not isinstance(schema, dict):
        raise SpecError(f"schema at {path} is not an object")

    for combinator in ("oneOf", "anyOf", "allOf", "not"):
        if combinator in schema:
            raise SpecError(
                f"schema at {path} uses `{combinator}`; the drift gate "
                "requires plain object/array/scalar schemas"
            )

    # Empty schema ({}) accepts anything (used for arbitrary payloads).
    meaningful = set(schema) - {"description", "example", "title", "default",
                                "deprecated", "readOnly", "writeOnly"}
    if not meaningful:
        return

    if value is None:
        if schema.get("nullable") is True:
            return
        errors.append(f"{path}: null is not allowed (server omits absent fields)")
        return

    schema_type = schema.get("type")
    if schema_type is None:
        # typeless but constrained (e.g. only enum) — check what exists.
        if "enum" in schema and value not in schema["enum"]:
            errors.append(f"{path}: {value!r} not in enum {schema['enum']}")
        if "properties" in schema or "required" in schema:
            schema_type = "object"
        else:
            return

    if not type_ok(schema_type, value):
        errors.append(
            f"{path}: expected {schema_type}, got "
            f"{type(value).__name__} ({json.dumps(value, ensure_ascii=False)[:120]})"
        )
        return

    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: {value!r} not in enum {schema['enum']}")
        return

    if schema_type == "string":
        if schema.get("format") == "uuid" and not UUID_RE.match(value):
            errors.append(f"{path}: {value!r} is not a UUID")
        return

    if schema_type == "array":
        items = schema.get("items")
        if items is not None:
            for i, element in enumerate(value):
                validate(spec, items, element, f"{path}[{i}]", errors)
        return

    if schema_type == "object":
        properties = schema.get("properties", {})
        required = schema.get("required", [])
        additional = schema.get("additionalProperties", None)

        for key in required:
            if key not in value:
                errors.append(f"{path}: required key `{key}` is missing")
        for key, item in value.items():
            key_path = f"{path}.{key}"
            if key in properties:
                validate(spec, properties[key], item, key_path, errors)
            elif isinstance(additional, dict):
                validate(spec, additional, item, key_path, errors)
            elif additional is True:
                continue
            elif additional is False or properties:
                # Closed-world drift policy: undeclared key on a schema that
                # declares properties = contract drift.
                errors.append(
                    f"{path}: undeclared key `{key}` in response "
                    "(spec drift — add it to docs/api/openapi.yaml or fix the spec)"
                )
            # bare `type: object` with no properties/additionalProperties: open.
        return


def response_schema(spec, method, path, status, media_type="application/json"):
    paths = spec.get("paths", {})
    if path not in paths:
        raise SpecError(f"path not in spec: {path}")
    operation = paths[path].get(method.lower())
    if operation is None:
        raise SpecError(f"operation not in spec: {method.upper()} {path}")
    responses = operation.get("responses", {})
    response = responses.get(str(status)) or responses.get("default")
    if response is None:
        raise SpecError(
            f"response {status} not documented for {method.upper()} {path}"
        )
    response = resolve_ref(spec, response)
    content = response.get("content")
    if not content:
        return None  # documented as body-less
    media = content.get(media_type)
    if media is None or "schema" not in media:
        raise SpecError(
            f"{method.upper()} {path} {status} has no {media_type} schema"
        )
    return media["schema"]


HTTP_METHODS = ("get", "put", "post", "delete", "patch", "head", "options", "trace")


def spec_operations(spec):
    operations = set()
    for path, item in spec.get("paths", {}).items():
        if not isinstance(item, dict):
            continue
        for method in HTTP_METHODS:
            if method in item:
                operations.add((method, path))
    return operations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", required=True, help="OpenAPI spec as JSON")
    parser.add_argument("--manifest", required=True, help="samples manifest JSON")
    parser.add_argument(
        "--require-operation-coverage",
        action="store_true",
        help="fail when a spec operation (method+path) has no sample — every "
        "documented route must be exercised against the live server",
    )
    args = parser.parse_args()

    with open(args.spec, encoding="utf-8") as handle:
        spec = json.load(handle)
    with open(args.manifest, encoding="utf-8") as handle:
        manifest = json.load(handle)

    samples = manifest.get("samples", [])
    if not samples:
        print("[openapi-shape] FAIL: manifest contains no samples", file=sys.stderr)
        return 1

    failures = 0
    for sample in samples:
        name = sample.get("name", "<unnamed>")
        method = sample["method"]
        path = sample["path"]
        status = sample["status"]
        label = f"{name} [{method.upper()} {path} -> {status}]"
        try:
            media_type = sample.get("media_type", "application/json")
            schema = response_schema(spec, method, path, status, media_type)
            with open(sample["body_file"], "rb") as handle:
                raw = handle.read()
            if schema is None:
                if raw.strip():
                    raise SpecError("spec documents no body but response has one")
                print(f"[openapi-shape] PASS {label} (no body)")
                continue
            if media_type == "application/json":
                body = json.loads(raw.decode("utf-8"))
            else:
                body = raw.decode("latin-1")
            errors = []
            validate(spec, schema, body, "$", errors)
            if errors:
                failures += 1
                print(f"[openapi-shape] FAIL {label}", file=sys.stderr)
                for err in errors:
                    print(f"    - {err}", file=sys.stderr)
            else:
                print(f"[openapi-shape] PASS {label}")
        except (SpecError, KeyError, json.JSONDecodeError, OSError) as exc:
            failures += 1
            print(f"[openapi-shape] FAIL {label}: {exc}", file=sys.stderr)

    if args.require_operation_coverage:
        sampled = {(s["method"].lower(), s["path"]) for s in samples}
        uncovered = sorted(spec_operations(spec) - sampled)
        if uncovered:
            failures += 1
            print(
                "[openapi-shape] FAIL operation coverage — spec operations "
                "without a live sample:",
                file=sys.stderr,
            )
            for method, path in uncovered:
                print(f"    - {method.upper()} {path}", file=sys.stderr)
        else:
            print(
                f"[openapi-shape] PASS operation coverage "
                f"({len(spec_operations(spec))} operations sampled)"
            )

    total = len(samples)
    if failures:
        print(
            f"[openapi-shape] RESULT FAIL — {failures} failure(s) across "
            f"{total} samples",
            file=sys.stderr,
        )
        return 1
    print(f"[openapi-shape] RESULT PASS — {total}/{total} samples match the spec")
    return 0


if __name__ == "__main__":
    sys.exit(main())
