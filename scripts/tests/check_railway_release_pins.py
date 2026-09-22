#!/usr/bin/env python3
"""Field-level Railway app/Caddy pin checker (#2499).

Compares JSON fields and the Dockerfile ARG / actual web-asset source
against releases/latest.json. A file-wide grep of the current digest is
not a pass — appImage, each app service image, ARG OORT_IMAGE, the
stage named `web`, and the COPY that ships /srv/web are independent
sources. An unused FROM ${OORT_IMAGE} does not count.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

APP_SERVICES = ("api", "relay", "webhook-sender", "agent-worker")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
FROM_RE = re.compile(r"^FROM\s+(\S+)(?:\s+[Aa][Ss]\s+(\S+))?\s*$")
COPY_FROM_RE = re.compile(r"^COPY\s+--from=(\S+)\s+(\S+)\s+(\S+)\s*$")
PLAIN_COPY_RE = re.compile(r"^COPY\s+(\S+)\s+(\S+)\s*$")
ARG_OORT_RE = re.compile(r"^ARG\s+OORT_IMAGE=(.+)$")
WEB_STAGE_FROM = "${OORT_IMAGE}"
WEB_STAGE_NAME = "web"
WEB_SRC = "/opt/momo/web"
WEB_DEST = "/srv/web"
# Last published pin before v0.1.5. Mutations must use this exact previous
# digest so the proof is a real drift, not a no-op rewrite of the current pin.
PREVIOUS_APP_DIGEST = (
    "sha256:7426d282b67270ff3d52c4cbf1f5136ea038ae104a2c9dbb971ef71f8694d37f"
)


def fail(message: str) -> None:
    raise SystemExit(message)


def load_want(latest_path: Path) -> tuple[str, str, str]:
    latest = json.loads(latest_path.read_text())
    try:
        app = latest["images"]["app"]
        ref = app["ref"]
        digest = app["digest_list"]
    except (KeyError, TypeError) as exc:
        fail("latest.json images.app ref/digest_list missing: %s" % exc)
    if not isinstance(ref, str) or not ref:
        fail("latest.json images.app.ref missing")
    if not isinstance(digest, str) or not DIGEST_RE.fullmatch(digest):
        fail("latest.json images.app.digest_list is not a sha256 list digest")
    return ref, digest, "%s@%s" % (ref, digest)


def instruction_lines(dockerfile: Path) -> list[str]:
    lines: list[str] = []
    for raw in dockerfile.read_text().splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.endswith("\\"):
            fail("Dockerfile.caddy line continuation is unsupported")
        lines.append(stripped)
    return lines


def parse_oort_image_arg(dockerfile: Path) -> list[str]:
    values: list[str] = []
    for stripped in instruction_lines(dockerfile):
        match = ARG_OORT_RE.match(stripped)
        if match:
            values.append(match.group(1).strip())
    return values


def parse_stages(dockerfile: Path) -> list[dict[str, object]]:
    stages: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    for stripped in instruction_lines(dockerfile):
        from_match = FROM_RE.match(stripped)
        if from_match:
            current = {
                "image": from_match.group(1),
                "name": (from_match.group(2) or "").lower() or None,
                "copies": [],
            }
            stages.append(current)
            continue
        if current is None:
            continue
        copy_from = COPY_FROM_RE.match(stripped)
        if copy_from:
            current["copies"].append(
                {
                    "from": copy_from.group(1),
                    "src": copy_from.group(2),
                    "dest": copy_from.group(3),
                }
            )
            continue
        plain = PLAIN_COPY_RE.match(stripped)
        if plain:
            current["copies"].append(
                {
                    "from": None,
                    "src": plain.group(1),
                    "dest": plain.group(2),
                }
            )
    return stages


def caddy_web_source_errors(dockerfile: Path) -> list[str]:
    errors: list[str] = []
    stages = parse_stages(dockerfile)
    named: dict[str, str] = {}
    for stage in stages:
        name = stage["name"]
        if isinstance(name, str) and name:
            named[name] = str(stage["image"])
    web_image = named.get(WEB_STAGE_NAME)
    if web_image is None:
        errors.append("Dockerfile.caddy web stage missing")
    elif web_image != WEB_STAGE_FROM:
        errors.append(
            "Dockerfile.caddy web stage FROM %s != %s" % (web_image, WEB_STAGE_FROM)
        )

    if not stages:
        errors.append("Dockerfile.caddy FROM missing")
        return errors
    final_copies = list(stages[-1]["copies"])  # type: ignore[arg-type]
    web_copies = [item for item in final_copies if item["dest"] == WEB_DEST]
    if not web_copies:
        errors.append("Dockerfile.caddy /srv/web COPY missing")
        return errors
    if len(web_copies) != 1:
        errors.append("Dockerfile.caddy /srv/web COPY count %d" % len(web_copies))
    shipped = web_copies[-1]
    if shipped["from"] != WEB_STAGE_NAME:
        errors.append(
            "Dockerfile.caddy /srv/web COPY --from=%s != %s"
            % (shipped["from"], WEB_STAGE_NAME)
        )
    if shipped["src"] != WEB_SRC:
        errors.append(
            "Dockerfile.caddy /srv/web COPY src %s != %s" % (shipped["src"], WEB_SRC)
        )
    return errors


def collect_errors(
    railway_path: Path, dockerfile_path: Path, latest_path: Path
) -> list[str]:
    want_ref, want_digest, want_image = load_want(latest_path)
    errors: list[str] = []

    try:
        data = json.loads(railway_path.read_text())
    except json.JSONDecodeError as exc:
        return ["railway.json is not JSON: %s" % exc]

    app_image = data.get("appImage")
    if not isinstance(app_image, dict):
        errors.append("appImage missing")
    else:
        if app_image.get("ref") != want_ref:
            errors.append(
                "appImage.ref %r != %r" % (app_image.get("ref"), want_ref)
            )
        digest = app_image.get("digest")
        if digest is None:
            errors.append("appImage.digest missing")
        elif digest != want_digest:
            errors.append("appImage.digest %s != %s" % (digest, want_digest))

    services = data.get("services")
    if not isinstance(services, dict):
        errors.append("services missing")
        services = {}
    for name in APP_SERVICES:
        svc = services.get(name)
        if not isinstance(svc, dict):
            errors.append("service %s missing" % name)
            continue
        image = svc.get("image")
        if image is None:
            errors.append("service %s image missing" % name)
        elif image != want_image:
            errors.append(
                "service %s image %s != %s" % (name, image, want_image)
            )

    if not dockerfile_path.is_file():
        errors.append("Dockerfile.caddy missing")
        return errors

    arg_vals = parse_oort_image_arg(dockerfile_path)
    if len(arg_vals) != 1:
        errors.append("Dockerfile.caddy ARG OORT_IMAGE count %d" % len(arg_vals))
    elif arg_vals[0] != want_image:
        errors.append(
            "Dockerfile.caddy ARG OORT_IMAGE %s != %s" % (arg_vals[0], want_image)
        )
    errors.extend(caddy_web_source_errors(dockerfile_path))
    return errors


def check_or_exit(
    railway_path: Path, dockerfile_path: Path, latest_path: Path
) -> None:
    errors = collect_errors(railway_path, dockerfile_path, latest_path)
    if errors:
        fail("; ".join(errors))
    want_image = load_want(latest_path)[2]
    print("want_image", want_image)


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mutate(
    kind: str,
    railway_path: Path,
    dockerfile_path: Path,
    previous_digest: str,
    previous_image: str,
) -> None:
    data = json.loads(railway_path.read_text())
    if kind == "appImage":
        data["appImage"]["digest"] = previous_digest
        railway_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n"
        )
        return
    if kind in APP_SERVICES:
        data["services"][kind]["image"] = previous_image
        railway_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n"
        )
        return
    if kind == "missing-api":
        del data["services"]["api"]["image"]
        railway_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n"
        )
        return
    text = dockerfile_path.read_text()
    if kind == "caddy":
        replaced = 0
        lines: list[str] = []
        for line in text.splitlines(True):
            stripped = line.strip()
            if stripped.startswith("#"):
                lines.append(line)
                continue
            if stripped.startswith("ARG OORT_IMAGE="):
                indent = line[: len(line) - len(line.lstrip(" \t"))]
                ending = "\n" if line.endswith("\n") else ""
                lines.append(
                    "%sARG OORT_IMAGE=%s%s" % (indent, previous_image, ending)
                )
                replaced += 1
            else:
                lines.append(line)
        if replaced != 1:
            fail("could not mutate ARG OORT_IMAGE (count=%d)" % replaced)
        dockerfile_path.write_text("".join(lines))
        return
    if kind == "missing-caddy-arg":
        kept = []
        for line in text.splitlines(True):
            stripped = line.strip()
            if stripped.startswith("#"):
                kept.append(line)
                continue
            if stripped.startswith("ARG OORT_IMAGE="):
                continue
            kept.append(line)
        dockerfile_path.write_text("".join(kept))
        return
    if kind == "caddy-stale-web-stage":
        old = "FROM ${OORT_IMAGE} AS web\n"
        new = (
            "FROM ${OORT_IMAGE} AS unused\n"
            "FROM %s AS web\n" % previous_image
        )
        if old not in text:
            fail("could not locate FROM ${OORT_IMAGE} AS web to mutate")
        dockerfile_path.write_text(text.replace(old, new, 1))
        return
    if kind == "caddy-copy-from-stale":
        old_from = "FROM ${OORT_IMAGE} AS web\nFROM caddy:2-alpine\n"
        new_from = (
            "FROM ${OORT_IMAGE} AS web\n"
            "FROM %s AS stale\n"
            "FROM caddy:2-alpine\n" % previous_image
        )
        if old_from not in text:
            fail("could not locate web/caddy FROM pair to mutate COPY source")
        text = text.replace(old_from, new_from, 1)
        old_copy = "COPY --from=web /opt/momo/web /srv/web"
        if old_copy not in text:
            fail("could not locate COPY --from=web to redirect")
        dockerfile_path.write_text(
            text.replace(old_copy, "COPY --from=stale /opt/momo/web /srv/web", 1)
        )
        return
    fail("unknown mutation kind %s" % kind)


MUTATIONS: tuple[tuple[str, str], ...] = (
    ("appImage", "appImage.digest"),
    ("api", "service api image"),
    ("relay", "service relay image"),
    ("webhook-sender", "service webhook-sender image"),
    ("agent-worker", "service agent-worker image"),
    ("caddy", "Dockerfile.caddy ARG OORT_IMAGE"),
    ("missing-api", "service api image missing"),
    ("missing-caddy-arg", "Dockerfile.caddy ARG OORT_IMAGE count"),
    ("caddy-stale-web-stage", "web stage FROM"),
    ("caddy-copy-from-stale", "/srv/web COPY --from="),
)

DOCKERFILE_ONLY = {
    "caddy",
    "missing-caddy-arg",
    "caddy-stale-web-stage",
    "caddy-copy-from-stale",
}


def prove_mutations(
    railway_path: Path, dockerfile_path: Path, latest_path: Path
) -> None:
    want_ref, want_digest, want_image = load_want(latest_path)
    if want_digest == PREVIOUS_APP_DIGEST:
        fail(
            "mutation previous digest equals current latest.json digest — proof would be a no-op"
        )
    previous_image = "%s@%s" % (want_ref, PREVIOUS_APP_DIGEST)
    origin_rj = file_digest(railway_path)
    origin_df = file_digest(dockerfile_path)

    with tempfile.TemporaryDirectory(prefix="oort-railway-pins.") as tmp:
        scratch = Path(tmp)
        for kind, needle in MUTATIONS:
            dest = scratch / kind
            dest.mkdir()
            dest_rj = dest / "railway.json"
            dest_df = dest / "Dockerfile.caddy"
            shutil.copyfile(railway_path, dest_rj)
            shutil.copyfile(dockerfile_path, dest_df)
            mutate(kind, dest_rj, dest_df, PREVIOUS_APP_DIGEST, previous_image)
            errors = collect_errors(dest_rj, dest_df, latest_path)
            if not errors:
                fail(
                    "mutation %s still compared equal — pin check is not load-bearing"
                    % kind
                )
            joined = "; ".join(errors)
            if needle not in joined:
                fail(
                    "mutation %s failed without naming source (%s): %s"
                    % (kind, needle, joined)
                )
            # Other pins in the scratch JSON still carry the current digest.
            # A grep-anywhere check of latest.json would wrongly PASS.
            if kind not in DOCKERFILE_ONLY:
                if want_digest not in dest_rj.read_text():
                    fail(
                        "mutation %s scratch lost current digest; grep-anywhere proof is invalid"
                        % kind
                    )
            print("mutation %s RED (%s)" % (kind, needle))

    if file_digest(railway_path) != origin_rj or file_digest(dockerfile_path) != origin_df:
        fail("committed Railway pin files changed during scratch mutations")
    leftover = collect_errors(railway_path, dockerfile_path, latest_path)
    if leftover:
        fail("committed tree drifted after scratch mutations: %s" % "; ".join(leftover))
    print("scratch mutations restored; committed tree still pinned %s" % want_image)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("railway_json")
    parser.add_argument("dockerfile")
    parser.add_argument("latest_json")
    parser.add_argument(
        "--prove-mutations",
        action="store_true",
        help="copy sources to scratch, mutate each pin independently, expect RED",
    )
    args = parser.parse_args(argv)
    railway_path = Path(args.railway_json)
    dockerfile_path = Path(args.dockerfile)
    latest_path = Path(args.latest_json)
    check_or_exit(railway_path, dockerfile_path, latest_path)
    if args.prove_mutations:
        prove_mutations(railway_path, dockerfile_path, latest_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
