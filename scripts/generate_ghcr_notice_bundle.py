#!/usr/bin/env python3
"""Deterministic GHCR third-party notice bundle (#1332).

Reads ``server-rust/Cargo.lock`` (via ``cargo metadata --locked --offline``)
and ``clients/web/package-lock.json``, collects LICENSE/COPYING plus any
upstream NOTICE, and writes:

  legal/generated/GHCR_THIRD_PARTY_NOTICES.txt
  legal/generated/GHCR_NOTICE_MANIFEST.json
  legal/generated/GHCR_NOTICE_BUNDLE.sha256

Missing SPDX, missing license files (without a reviewed clarify row), and
unidentifiable licenses fail closed. This is not a license-policy allowlist
and not a legal-sufficiency declaration.

Same inputs always produce byte-identical outputs: UTF-8, LF, sorted keys,
no timestamps, ``LC_ALL=C`` for subprocesses.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

FORMAT = "ghcr-notice-bundle/v1"
GENERATOR = "scripts/generate_ghcr_notice_bundle.py"
CARGO_LOCK = "server-rust/Cargo.lock"
WEB_LOCK = "clients/web/package-lock.json"
BUNDLE_NAME = "GHCR_THIRD_PARTY_NOTICES.txt"
MANIFEST_NAME = "GHCR_NOTICE_MANIFEST.json"
SHA256_NAME = "GHCR_NOTICE_BUNDLE.sha256"
CLARIFY_NAME = "license-file-clarify.json"
SPDX_DIR_NAME = "spdx-texts"

IMAGE_FILES = (
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
    BUNDLE_NAME,
)

LICENSE_FILE_RE = re.compile(
    r"^(LICENSE|LICENCE|COPYING|UNLICENSE|COPYRIGHT)([._-].*)?$",
    re.IGNORECASE,
)
NOTICE_FILE_RE = re.compile(r"^NOTICE([._-].*)?$", re.IGNORECASE)
LICENSE_DIR_NAMES = {"LICENSES", "LICENSE", "LICENCE"}
COPYRIGHT_LINE_RE = re.compile(
    r"(?im)^\s*(?:copyright(?:\s*\([cC]\))?|\(c\)|©)\s+.+$"
)
SPDX_SPLIT_RE = re.compile(r"\s+(?:OR|AND)\s+")
COPYLEFT_FIELD_RE = re.compile(
    r"(?:^|[^A-Za-z])(AGPL|LGPL|GPL)(?:$|[^A-Za-z])",
    re.IGNORECASE,
)
PERMISSIVE_FIELD_RE = re.compile(
    r"\b(?:MIT|BSD|Apache|ISC|Zlib|PostgreSQL|Artistic|MPL|Unlicense|Boost|BSL|0BSD)\b",
    re.IGNORECASE,
)

APP_DOCKERFILE_REQUIRED = (
    "COPY LICENSE NOTICE legal/THIRD_PARTY_NOTICES.md legal/generated/GHCR_THIRD_PARTY_NOTICES.txt /usr/share/licenses/momo-rust/",
    "COPY LICENSE NOTICE legal/THIRD_PARTY_NOTICES.md legal/generated/GHCR_THIRD_PARTY_NOTICES.txt /opt/momo/web/legal/",
    "sha256sum -c /usr/share/licenses/momo-rust/GHCR_NOTICE_BUNDLE.sha256",
    "scripts/check_debian_copyrights.sh",
    "test -s /usr/share/licenses/momo-rust/LICENSE",
    "test -s /usr/share/licenses/momo-rust/NOTICE",
    "test -s /usr/share/licenses/momo-rust/THIRD_PARTY_NOTICES.md",
    "test -s /usr/share/licenses/momo-rust/GHCR_THIRD_PARTY_NOTICES.txt",
    "test -s /opt/momo/web/legal/GHCR_THIRD_PARTY_NOTICES.txt",
)
POSTGRES_DOCKERFILE_REQUIRED = (
    "COPY LICENSE NOTICE legal/THIRD_PARTY_NOTICES.md legal/generated/GHCR_THIRD_PARTY_NOTICES.txt /usr/share/licenses/oort-postgres/",
    "sha256sum -c /usr/share/licenses/oort-postgres/GHCR_NOTICE_BUNDLE.sha256",
    "scripts/check_debian_copyrights.sh",
    "test -s /usr/share/licenses/oort-postgres/LICENSE",
    "test -s /usr/share/licenses/oort-postgres/NOTICE",
    "test -s /usr/share/licenses/oort-postgres/THIRD_PARTY_NOTICES.md",
    "test -s /usr/share/licenses/oort-postgres/GHCR_THIRD_PARTY_NOTICES.txt",
)


class BundleError(Exception):
    """Fail-closed generation/check error."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def read_text(path: Path) -> str:
    raw = path.read_bytes()
    if b"\0" in raw:
        raise BundleError(f"binary license file refused: {path}")
    for encoding in ("utf-8", "utf-8-sig", "latin-1"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise BundleError(f"undecodable license file: {path}")
    return text.replace("\r\n", "\n").replace("\r", "\n")


def normalize_newline(text: str) -> str:
    if text and not text.endswith("\n"):
        text += "\n"
    return text.replace("\r\n", "\n").replace("\r", "\n")


def dump_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def extract_copyright(texts: list[str], authors: list[str]) -> str:
    hits: list[str] = []
    seen: set[str] = set()
    for text in texts:
        for match in COPYRIGHT_LINE_RE.finditer(text):
            line = " ".join(match.group(0).split())
            key = line.lower()
            if key in seen:
                continue
            seen.add(key)
            hits.append(line)
            if len(hits) >= 4:
                break
        if len(hits) >= 4:
            break
    if hits:
        return "; ".join(hits)
    cleaned = [item.strip() for item in authors if item and item.strip()]
    if cleaned:
        return "Authors: " + ", ".join(cleaned)
    return "copyright not stated in license file"


def spdx_atoms(expression: str) -> list[str]:
    if not expression or not expression.strip():
        return []
    stripped = expression.strip()
    if stripped.startswith("(") and stripped.endswith(")"):
        stripped = stripped[1:-1].strip()
    parts = SPDX_SPLIT_RE.split(stripped)
    atoms: list[str] = []
    seen: set[str] = set()
    for part in parts:
        atom = part.strip().strip("()")
        if not atom or atom in seen:
            continue
        seen.add(atom)
        atoms.append(atom)
    return atoms


def classify_debian_license_fields(fields: str) -> str:
    """Classify Debian ``License:`` fields. Copyleft is never 'permissive'."""
    text = fields.strip()
    if not text:
        return "unknown"
    if COPYLEFT_FIELD_RE.search(text):
        return "copyleft"
    if PERMISSIVE_FIELD_RE.search(text):
        return "permissive"
    return "other"


def iter_license_files(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    found: list[Path] = []
    try:
        children = list(root.iterdir())
    except OSError as exc:
        raise BundleError(f"cannot read {root}: {exc}") from exc
    for child in children:
        name = child.name
        if child.is_file() and (
            LICENSE_FILE_RE.match(name) or NOTICE_FILE_RE.match(name)
        ):
            found.append(child)
        elif child.is_dir() and name.upper() in LICENSE_DIR_NAMES:
            try:
                nested = list(child.iterdir())
            except OSError as exc:
                raise BundleError(f"cannot read {child}: {exc}") from exc
            for inner in nested:
                if inner.is_file():
                    found.append(inner)
    found.sort(key=lambda path: path.as_posix().lower())
    return found


def load_spdx_text(repo_root: Path, spdx_id: str) -> str:
    path = repo_root / "legal" / "generated" / SPDX_DIR_NAME / f"{spdx_id}.txt"
    if not path.is_file():
        raise BundleError(
            f"no vendored SPDX text for {spdx_id} (expected {path})"
        )
    return read_text(path)


def clarify_row(clarify: dict[str, Any], ecosystem: str, key: str) -> dict[str, Any] | None:
    table = clarify.get(ecosystem) or {}
    row = table.get(key)
    return row if isinstance(row, dict) else None


def files_from_spdx_ids(
    repo_root: Path, spdx_ids: list[str], source: str
) -> list[dict[str, str]]:
    files: list[dict[str, str]] = []
    for spdx_id in spdx_ids:
        text = normalize_newline(load_spdx_text(repo_root, spdx_id))
        files.append(
            {
                "name": f"SPDX-{spdx_id}.txt",
                "text": text,
                "sha256": sha256_bytes(text.encode("utf-8")),
                "source": source,
            }
        )
    return files


def files_from_disk(paths: list[Path], root: Path) -> list[dict[str, str]]:
    files: list[dict[str, str]] = []
    seen_names: set[str] = set()
    for path in paths:
        rel = path.relative_to(root).as_posix() if path.is_relative_to(root) else path.name
        name = rel.replace("\\", "/")
        if name in seen_names:
            continue
        seen_names.add(name)
        text = normalize_newline(read_text(path))
        files.append(
            {
                "name": name,
                "text": text,
                "sha256": sha256_bytes(text.encode("utf-8")),
                "source": "package-tree",
            }
        )
    return files


def resolve_package_files(
    *,
    repo_root: Path,
    clarify: dict[str, Any],
    ecosystem: str,
    name: str,
    version: str,
    spdx: str,
    search_root: Path | None,
    authors: list[str],
    license_file: str | None,
    optional_absent: bool,
) -> tuple[list[dict[str, str]], str, str]:
    key = f"{name}@{version}"
    files: list[dict[str, str]] = []
    if search_root is not None and search_root.is_dir():
        candidates = iter_license_files(search_root)
        if license_file:
            extra = (search_root / license_file).resolve()
            if extra.is_file() and extra not in candidates:
                candidates.append(extra)
                candidates.sort(key=lambda path: path.as_posix().lower())
        files = files_from_disk(candidates, search_root)

    if files:
        copyright = extract_copyright([item["text"] for item in files], authors)
        return files, copyright, "package-tree"

    row = clarify_row(clarify, ecosystem, key)
    if row:
        ids = list(row.get("spdx_texts") or [])
        if not ids:
            raise BundleError(f"clarify row {ecosystem}:{key} has empty spdx_texts")
        files = files_from_spdx_ids(repo_root, ids, "clarify")
        copyright = extract_copyright([item["text"] for item in files], authors)
        return files, copyright, "clarify"

    if optional_absent:
        atoms = spdx_atoms(spdx)
        if not atoms:
            raise BundleError(
                f"{ecosystem} {key}: optional package missing from node_modules "
                "and lockfile SPDX is empty"
            )
        files = files_from_spdx_ids(repo_root, atoms, "optional-not-installed")
        copyright = extract_copyright([item["text"] for item in files], authors)
        return files, copyright, "optional-not-installed"

    raise BundleError(
        f"{ecosystem} {key}: no LICENSE/COPYING/NOTICE file under {search_root} "
        "and no legal/generated/license-file-clarify.json row"
    )


def load_clarify(repo_root: Path) -> dict[str, Any]:
    path = repo_root / "legal" / "generated" / CLARIFY_NAME
    if not path.is_file():
        raise BundleError(f"missing {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise BundleError(f"{path} must be a JSON object")
    return data


def cargo_packages(
    repo_root: Path,
    clarify: dict[str, Any],
    metadata: dict[str, Any],
) -> list[dict[str, Any]]:
    workspace_ids = set(metadata.get("workspace_members") or [])
    packages: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for pkg in metadata.get("packages") or []:
        pkg_id = pkg.get("id")
        name = pkg.get("name")
        version = pkg.get("version")
        manifest = pkg.get("manifest_path")
        if not name or not version or not manifest:
            raise BundleError(f"cargo metadata package missing name/version/manifest: {pkg_id}")
        if pkg_id in workspace_ids:
            continue
        # Path/workspace crates have source=None. Registry and git deps are
        # third-party even if cargo unpacked them under this machine's CARGO_HOME.
        if not pkg.get("source"):
            continue
        manifest_path = Path(manifest).resolve()
        key = (name, version)
        if key in seen:
            continue
        seen.add(key)
        spdx = (pkg.get("license") or "").strip()
        if not spdx:
            raise BundleError(f"cargo {name}@{version}: empty SPDX license")
        search_root = manifest_path.parent
        files, copyright, source = resolve_package_files(
            repo_root=repo_root,
            clarify=clarify,
            ecosystem="cargo",
            name=name,
            version=version,
            spdx=spdx,
            search_root=search_root,
            authors=list(pkg.get("authors") or []),
            license_file=pkg.get("license_file"),
            optional_absent=False,
        )
        packages.append(
            {
                "ecosystem": "cargo",
                "name": name,
                "version": version,
                "spdx": spdx,
                "copyright": copyright,
                "source": source,
                "repository": pkg.get("repository") or "",
                "files": files,
            }
        )
    packages.sort(key=lambda row: (row["name"].lower(), row["version"], row["ecosystem"]))
    return packages


def npm_packages(
    repo_root: Path,
    clarify: dict[str, Any],
    lock: dict[str, Any],
    web_root: Path,
) -> list[dict[str, Any]]:
    packages_out: list[dict[str, Any]] = []
    seen: dict[tuple[str, str], dict[str, Any]] = {}
    entries = lock.get("packages")
    if not isinstance(entries, dict):
        raise BundleError(f"{WEB_LOCK} missing packages object")
    for lock_path in sorted(entries.keys()):
        info = entries[lock_path]
        if lock_path == "":
            continue
        if not isinstance(info, dict):
            raise BundleError(f"{WEB_LOCK} packages[{lock_path!r}] is not an object")
        if info.get("link"):
            continue
        name = info.get("name") or lock_path.rsplit("node_modules/", 1)[-1]
        version = info.get("version") or ""
        if not name or not version:
            raise BundleError(f"{WEB_LOCK} {lock_path}: missing name/version")
        spdx = (info.get("license") or "").strip()
        if not spdx:
            raise BundleError(f"npm {name}@{version}: empty SPDX license in lockfile")
        pkg_dir = web_root / lock_path
        optional_absent = bool(info.get("optional")) and not pkg_dir.is_dir()
        if not pkg_dir.is_dir() and not optional_absent:
            raise BundleError(
                f"npm {name}@{version}: {pkg_dir} missing (run npm ci --prefix clients/web)"
            )
        files, copyright, source = resolve_package_files(
            repo_root=repo_root,
            clarify=clarify,
            ecosystem="npm",
            name=name,
            version=version,
            spdx=spdx,
            search_root=pkg_dir if pkg_dir.is_dir() else None,
            authors=[],
            license_file=None,
            optional_absent=optional_absent,
        )
        key = (name, version)
        existing = seen.get(key)
        if existing:
            existing_hashes = [item["sha256"] for item in existing["files"]]
            new_hashes = [item["sha256"] for item in files]
            if existing_hashes != new_hashes and existing["spdx"] != spdx:
                raise BundleError(
                    f"npm {name}@{version} appears twice with different SPDX/files"
                )
            continue
        row = {
            "ecosystem": "npm",
            "name": name,
            "version": version,
            "spdx": spdx,
            "copyright": copyright,
            "source": source,
            "repository": "",
            "files": files,
        }
        seen[key] = row
        packages_out.append(row)
    packages_out.sort(key=lambda row: (row["name"].lower(), row["version"], row["ecosystem"]))
    return packages_out


def run_cargo_metadata(repo_root: Path, metadata_path: str | None) -> dict[str, Any]:
    if metadata_path:
        return json.loads(Path(metadata_path).read_text(encoding="utf-8"))
    env = os.environ.copy()
    env["LC_ALL"] = "C"
    env["LANG"] = "C"
    env["CARGO_TERM_COLOR"] = "never"
    cmd = [
        "cargo",
        "metadata",
        "--manifest-path",
        str(repo_root / "server-rust" / "Cargo.toml"),
        "--format-version",
        "1",
        "--locked",
        "--offline",
    ]
    try:
        proc = subprocess.run(
            cmd,
            check=True,
            capture_output=True,
            text=True,
            env=env,
            cwd=str(repo_root),
        )
    except FileNotFoundError as exc:
        raise BundleError("cargo is not installed") from exc
    except subprocess.CalledProcessError as exc:
        raise BundleError(
            "cargo metadata --offline failed "
            f"(need the server-rust registry cache):\n{exc.stderr}"
        ) from exc
    return json.loads(proc.stdout)


def render_bundle(
    *,
    cargo_lock_sha: str,
    web_lock_sha: str,
    clarify_sha: str,
    packages: list[dict[str, Any]],
) -> str:
    blobs: dict[str, dict[str, str]] = {}
    for pkg in packages:
        for item in pkg["files"]:
            blobs.setdefault(
                item["sha256"],
                {"sha256": item["sha256"], "name": item["name"], "text": item["text"]},
            )
    cargo_n = sum(1 for pkg in packages if pkg["ecosystem"] == "cargo")
    npm_n = sum(1 for pkg in packages if pkg["ecosystem"] == "npm")
    lines: list[str] = [
        "# GHCR third-party notices",
        f"# format: {FORMAT}",
        f"# generator: {GENERATOR}",
        "#",
        "# This file is a machine-generated inventory of redistributed Cargo and",
        "# npm license files for the GHCR app image (and the same bundle copied",
        "# into oort-postgres). It is not legal advice and does not declare",
        "# legal sufficiency. Debian OS-layer licenses are inventoried separately",
        "# inside each image; GPL/LGPL there are copyleft, not permissive.",
        "#",
        f"# cargo.lock.sha256: {cargo_lock_sha}",
        f"# web.package-lock.sha256: {web_lock_sha}",
        f"# clarify.sha256: {clarify_sha}",
        f"# cargo.packages: {cargo_n}",
        f"# npm.packages: {npm_n}",
        f"# unique.license.blobs: {len(blobs)}",
        "#",
        "## Package index",
        "# ecosystem <TAB> name <TAB> version <TAB> spdx <TAB> copyright <TAB> source <TAB> file_sha256[,file_sha256]",
    ]
    for pkg in packages:
        hashes = ",".join(item["sha256"] for item in pkg["files"])
        copyright = pkg["copyright"].replace("\t", " ").replace("\n", " ")
        spdx = pkg["spdx"].replace("\t", " ")
        lines.append(
            "\t".join(
                [
                    pkg["ecosystem"],
                    pkg["name"],
                    pkg["version"],
                    spdx,
                    copyright,
                    pkg["source"],
                    hashes,
                ]
            )
        )
    lines.append("")
    lines.append("## License file blobs")
    for digest in sorted(blobs):
        blob = blobs[digest]
        lines.append(f"### sha256:{digest}")
        lines.append(f"# as-filed: {blob['name']}")
        lines.append("-----")
        body = blob["text"]
        if body.endswith("\n"):
            body = body[:-1]
        lines.append(body)
        lines.append("-----")
        lines.append("")
    text = "\n".join(lines)
    if not text.endswith("\n"):
        text += "\n"
    return text


def package_manifest_rows(packages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for pkg in packages:
        rows.append(
            {
                "copyright": pkg["copyright"],
                "ecosystem": pkg["ecosystem"],
                "files": [
                    {
                        "name": item["name"],
                        "sha256": item["sha256"],
                        "source": item["source"],
                    }
                    for item in pkg["files"]
                ],
                "name": pkg["name"],
                "repository": pkg["repository"],
                "source": pkg["source"],
                "spdx": pkg["spdx"],
                "version": pkg["version"],
            }
        )
    return rows


def image_file_map(repo_root: Path, bundle_text: str) -> dict[str, str]:
    mapping = {
        "LICENSE": sha256_file(repo_root / "LICENSE"),
        "NOTICE": sha256_file(repo_root / "NOTICE"),
        "THIRD_PARTY_NOTICES.md": sha256_file(repo_root / "legal" / "THIRD_PARTY_NOTICES.md"),
        BUNDLE_NAME: sha256_bytes(bundle_text.encode("utf-8")),
    }
    return mapping


def render_sha256sum(image_files: dict[str, str]) -> str:
    lines = []
    for name in IMAGE_FILES:
        lines.append(f"{image_files[name]}  {name}")
    return "\n".join(lines) + "\n"


def build_bundle(repo_root: Path, args: argparse.Namespace) -> dict[str, str]:
    cargo_lock = repo_root / CARGO_LOCK
    web_lock_path = repo_root / WEB_LOCK
    clarify_path = repo_root / "legal" / "generated" / CLARIFY_NAME
    for path in (cargo_lock, web_lock_path, clarify_path, repo_root / "LICENSE"):
        if not path.is_file():
            raise BundleError(f"missing required input: {path}")
    cargo_lock_sha = sha256_file(cargo_lock)
    web_lock_sha = sha256_file(web_lock_path)
    clarify_sha = sha256_file(clarify_path)
    clarify = load_clarify(repo_root)
    metadata = run_cargo_metadata(repo_root, args.cargo_metadata)
    web_root = Path(args.web_root) if args.web_root else repo_root / "clients" / "web"
    lock = json.loads(web_lock_path.read_text(encoding="utf-8"))
    packages = cargo_packages(repo_root, clarify, metadata) + npm_packages(
        repo_root, clarify, lock, web_root
    )
    bundle = render_bundle(
        cargo_lock_sha=cargo_lock_sha,
        web_lock_sha=web_lock_sha,
        clarify_sha=clarify_sha,
        packages=packages,
    )
    image_files = image_file_map(repo_root, bundle)
    spdx_dir = repo_root / "legal" / "generated" / SPDX_DIR_NAME
    spdx_hashes = {
        path.name: sha256_file(path)
        for path in sorted(spdx_dir.glob("*.txt"))
    }
    manifest = {
        "format": FORMAT,
        "generator": GENERATOR,
        "image_files": image_files,
        "inputs": {
            "clarify_sha256": clarify_sha,
            "server_rust_cargo_lock_sha256": cargo_lock_sha,
            "spdx_texts_sha256": spdx_hashes,
            "clients_web_package_lock_sha256": web_lock_sha,
        },
        "outputs": {
            "bundle_sha256": image_files[BUNDLE_NAME],
            "sha256_manifest_sha256": sha256_bytes(
                render_sha256sum(image_files).encode("utf-8")
            ),
        },
        "packages": package_manifest_rows(packages),
        "counts": {
            "cargo": sum(1 for pkg in packages if pkg["ecosystem"] == "cargo"),
            "npm": sum(1 for pkg in packages if pkg["ecosystem"] == "npm"),
            "unique_blobs": len({item["sha256"] for pkg in packages for item in pkg["files"]}),
        },
    }
    return {
        "bundle": bundle,
        "manifest": dump_json(manifest),
        "sha256sum": render_sha256sum(image_files),
    }


def write_outputs(repo_root: Path, built: dict[str, str]) -> None:
    out_dir = repo_root / "legal" / "generated"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / BUNDLE_NAME).write_text(built["bundle"], encoding="utf-8", newline="\n")
    (out_dir / MANIFEST_NAME).write_text(built["manifest"], encoding="utf-8", newline="\n")
    (out_dir / SHA256_NAME).write_text(built["sha256sum"], encoding="utf-8", newline="\n")


def require_contains(path: Path, needle: str) -> None:
    text = path.read_text(encoding="utf-8")
    if needle not in text:
        raise BundleError(f"{path}: missing required fragment:\n  {needle}")


def check_dockerfiles(repo_root: Path, app_df: Path, postgres_df: Path) -> None:
    for needle in APP_DOCKERFILE_REQUIRED:
        require_contains(app_df, needle)
    for needle in POSTGRES_DOCKERFILE_REQUIRED:
        require_contains(postgres_df, needle)
    # COPY of the hash file next to the four notices.
    require_contains(
        app_df,
        "COPY legal/generated/GHCR_NOTICE_BUNDLE.sha256 /usr/share/licenses/momo-rust/",
    )
    require_contains(
        postgres_df,
        "COPY legal/generated/GHCR_NOTICE_BUNDLE.sha256 /usr/share/licenses/oort-postgres/",
    )


def load_committed(repo_root: Path) -> dict[str, str]:
    out_dir = repo_root / "legal" / "generated"
    required = [out_dir / BUNDLE_NAME, out_dir / MANIFEST_NAME, out_dir / SHA256_NAME]
    for path in required:
        if not path.is_file():
            raise BundleError(f"missing committed generated file: {path}")
    return {
        "bundle": path_read(out_dir / BUNDLE_NAME),
        "manifest": path_read(out_dir / MANIFEST_NAME),
        "sha256sum": path_read(out_dir / SHA256_NAME),
    }


def path_read(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")


def check_stale(repo_root: Path, committed: dict[str, str]) -> None:
    manifest = json.loads(committed["manifest"])
    inputs = manifest.get("inputs") or {}
    cargo_sha = sha256_file(repo_root / CARGO_LOCK)
    web_sha = sha256_file(repo_root / WEB_LOCK)
    clarify_sha = sha256_file(repo_root / "legal" / "generated" / CLARIFY_NAME)
    expected_cargo = inputs.get("server_rust_cargo_lock_sha256")
    expected_web = inputs.get("clients_web_package_lock_sha256")
    expected_clarify = inputs.get("clarify_sha256")
    if cargo_sha != expected_cargo:
        raise BundleError(
            "stale GHCR notice bundle: server-rust/Cargo.lock hash "
            f"{cargo_sha} != manifest {expected_cargo}. "
            "Run: python3 scripts/generate_ghcr_notice_bundle.py generate"
        )
    if web_sha != expected_web:
        raise BundleError(
            "stale GHCR notice bundle: clients/web/package-lock.json hash "
            f"{web_sha} != manifest {expected_web}. "
            "Run: python3 scripts/generate_ghcr_notice_bundle.py generate"
        )
    if clarify_sha != expected_clarify:
        raise BundleError(
            "stale GHCR notice bundle: license-file-clarify.json changed. "
            "Run: python3 scripts/generate_ghcr_notice_bundle.py generate"
        )
    bundle_sha = sha256_bytes(committed["bundle"].encode("utf-8"))
    expected_bundle = (manifest.get("outputs") or {}).get("bundle_sha256")
    if bundle_sha != expected_bundle:
        raise BundleError(
            "GHCR_THIRD_PARTY_NOTICES.txt does not match manifest.outputs.bundle_sha256"
        )
    image_files = manifest.get("image_files") or {}
    live = {
        "LICENSE": sha256_file(repo_root / "LICENSE"),
        "NOTICE": sha256_file(repo_root / "NOTICE"),
        "THIRD_PARTY_NOTICES.md": sha256_file(
            repo_root / "legal" / "THIRD_PARTY_NOTICES.md"
        ),
        BUNDLE_NAME: bundle_sha,
    }
    for name in IMAGE_FILES:
        if image_files.get(name) != live[name]:
            raise BundleError(
                f"image file hash drift for {name}: manifest {image_files.get(name)} "
                f"!= current {live[name]}. "
                "Run: python3 scripts/generate_ghcr_notice_bundle.py generate"
            )
    expected_sum = render_sha256sum(live)
    if committed["sha256sum"] != expected_sum:
        raise BundleError(
            "GHCR_NOTICE_BUNDLE.sha256 is stale relative to the four image files"
        )


def sources_available(repo_root: Path, args: argparse.Namespace) -> bool:
    if args.cargo_metadata:
        cargo_ok = Path(args.cargo_metadata).is_file()
    else:
        cargo_ok = (repo_root / "server-rust" / "Cargo.toml").is_file()
    web_root = Path(args.web_root) if args.web_root else repo_root / "clients" / "web"
    return cargo_ok and (web_root / "node_modules").is_dir()


def cmd_generate(repo_root: Path, args: argparse.Namespace) -> int:
    built = build_bundle(repo_root, args)
    write_outputs(repo_root, built)
    out = repo_root / "legal" / "generated"
    print(f"wrote {out / BUNDLE_NAME}")
    print(f"wrote {out / MANIFEST_NAME}")
    print(f"wrote {out / SHA256_NAME}")
    return 0


def cmd_check(repo_root: Path, args: argparse.Namespace) -> int:
    committed = load_committed(repo_root)
    check_stale(repo_root, committed)
    app_df = Path(args.app_dockerfile) if args.app_dockerfile else repo_root / "server-rust" / "Dockerfile"
    pg_df = (
        Path(args.postgres_dockerfile)
        if args.postgres_dockerfile
        else repo_root / "infra" / "rust" / "postgres-pgbackrest" / "Dockerfile"
    )
    check_dockerfiles(repo_root, app_df, pg_df)
    regenerate = args.require_regenerate or (
        not args.stale_only and sources_available(repo_root, args)
    )
    if regenerate:
        built = build_bundle(repo_root, args)
        if built["bundle"] != committed["bundle"]:
            raise BundleError(
                "regenerated GHCR_THIRD_PARTY_NOTICES.txt is not byte-identical "
                "to the committed file"
            )
        if built["manifest"] != committed["manifest"]:
            raise BundleError(
                "regenerated GHCR_NOTICE_MANIFEST.json is not byte-identical "
                "to the committed file"
            )
        if built["sha256sum"] != committed["sha256sum"]:
            raise BundleError(
                "regenerated GHCR_NOTICE_BUNDLE.sha256 is not byte-identical "
                "to the committed file"
            )
        print("GHCR notice bundle check PASS (stale hashes + regenerate identical)")
    else:
        print("GHCR notice bundle check PASS (stale hashes + Dockerfile COPY; regen skipped)")
    return 0


def cmd_classify_debian(_repo_root: Path, args: argparse.Namespace) -> int:
    print(classify_debian_license_fields(args.fields))
    return 0


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--repo-root", default=None, help="repository root")

    gen = sub.add_parser(
        "generate",
        parents=[shared],
        help="write legal/generated/* from lockfiles",
    )
    gen.add_argument("--cargo-metadata", default=None, help="precomputed cargo metadata JSON")
    gen.add_argument("--web-root", default=None, help="clients/web directory")

    chk = sub.add_parser(
        "check",
        parents=[shared],
        help="fail-closed stale/Dockerfile/regenerate check",
    )
    chk.add_argument("--cargo-metadata", default=None)
    chk.add_argument("--web-root", default=None)
    chk.add_argument("--app-dockerfile", default=None)
    chk.add_argument("--postgres-dockerfile", default=None)
    chk.add_argument(
        "--require-regenerate",
        action="store_true",
        help="fail if cargo metadata / web node_modules cannot regenerate",
    )
    chk.add_argument(
        "--stale-only",
        action="store_true",
        help="do not regenerate even if sources are present",
    )

    cls = sub.add_parser(
        "classify-debian",
        parents=[shared],
        help="classify a Debian License: field (copyleft is never permissive)",
    )
    cls.add_argument("fields")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = make_parser()
    args = parser.parse_args(argv)
    if args.repo_root:
        repo_root = Path(args.repo_root).resolve()
    else:
        repo_root = Path(__file__).resolve().parents[1]
    try:
        if args.command == "generate":
            return cmd_generate(repo_root, args)
        if args.command == "check":
            return cmd_check(repo_root, args)
        if args.command == "classify-debian":
            return cmd_classify_debian(repo_root, args)
        parser.error("unknown command")
    except BundleError as exc:
        print(f"GHCR NOTICE FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
