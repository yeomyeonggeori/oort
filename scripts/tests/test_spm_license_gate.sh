#!/usr/bin/env bash
# Isolated positive/negative fixtures for scripts/check_spm_licenses.sh.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/momo-spm-license-test.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT HUP INT TERM

mkdir -p "$FIXTURE/pkg/.build/checkouts/fixture-dependency" "$FIXTURE/legal" "$FIXTURE/scripts"
printf '%s\n' '// swift-tools-version: 6.0' 'import PackageDescription' \
  'let package = Package(name: "Fixture", dependencies: [.package(url: "https://example.invalid/fixture-dependency.git", exact: "1.0.0")])' \
  > "$FIXTURE/pkg/Package.swift"
cat > "$FIXTURE/pkg/Package.resolved" <<'EOF'
{
  "pins": [
    {
      "identity": "fixture-dependency",
      "location": "https://example.invalid/fixture-dependency.git",
      "state": { "revision": "fixture", "version": "1.0.0" }
    }
  ],
  "version": 2
}
EOF
cat > "$FIXTURE/scripts/spm_license_exceptions.tsv" <<'EOF'
# package_identity	spdx_expression	review_reason
EOF
cat > "$FIXTURE/legal/THIRD_PARTY_NOTICES.md" <<'EOF'
# Third-party notices

## npm (web runtime dependencies)

Preserved manual section.
EOF

run_gate() {
  SPM_LICENSE_REPO_ROOT="$FIXTURE" \
  SPM_LICENSE_EXPECTED_ROOTS=1 \
  SPM_LICENSE_SKIP_RESOLVE=1 \
  "$REPO_ROOT/scripts/check_spm_licenses.sh" "$@"
}

cat > "$FIXTURE/pkg/.build/checkouts/fixture-dependency/LICENSE" <<'EOF'
MIT License
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.
EOF
run_gate --write
run_gate --check
grep -Fq '| fixture-dependency | 1.0.0 | MIT |' "$FIXTURE/legal/THIRD_PARTY_NOTICES.md"
grep -Fq 'Preserved manual section.' "$FIXTURE/legal/THIRD_PARTY_NOTICES.md"

cat > "$FIXTURE/pkg/.build/checkouts/fixture-dependency/LICENSE" <<'EOF'
Reviewed fictional permissive license text that intentionally needs an exception.
EOF
cat > "$FIXTURE/scripts/spm_license_exceptions.tsv" <<'EOF'
# package_identity	spdx_expression	review_reason
fixture-dependency	(AFL-2.1 OR BSD-3-Clause)	OR semantics fixture; BSD branch is allowed
EOF
run_gate --write
run_gate --check

cat > "$FIXTURE/scripts/spm_license_exceptions.tsv" <<'EOF'
# package_identity	spdx_expression	review_reason
fixture-dependency	(MIT AND BSD-3-Clause)	AND semantics fixture; both branches are allowed
EOF
run_gate --write
run_gate --check

cat > "$FIXTURE/pkg/.build/checkouts/fixture-dependency/LICENSE" <<'EOF'
GNU AFFERO GENERAL PUBLIC LICENSE
Version 3, 19 November 2007
EOF
cat > "$FIXTURE/scripts/spm_license_exceptions.tsv" <<'EOF'
# package_identity	spdx_expression	review_reason
fixture-dependency	MIT	A copyleft body must never be overridable
EOF
if run_gate --write >"$FIXTURE/agpl.out" 2>&1; then
  echo "expected AGPL fixture to fail closed" >&2
  exit 1
fi
grep -Fq 'copyleft license detected' "$FIXTURE/agpl.out"

echo "SPM license gate fixture PASS: permissive write/check + SPDX OR/AND + AGPL fail-closed"
