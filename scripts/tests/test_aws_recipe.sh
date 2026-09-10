#!/usr/bin/env bash
# SH-11c / #2377 — AWS Lightsail/EC2 T1 recipe: static contract.
# terraform fmt/validate run when terraform is installed; otherwise a visible
# optional-tool skip line (SH-11f) and the static assertions still run.
# Sabotage copies must each go RED.
set -euo pipefail

fail() {
  printf '[test-aws-recipe] FAIL %s\n' "$*" >&2
  exit 1
}

pass() {
  printf '[test-aws-recipe] PASS %s\n' "$*"
}

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"

AWS_DIR="$ROOT/infra/aws"
TF_DIR="$AWS_DIR/terraform"
CLOUDINIT="$AWS_DIR/cloud-init.yaml"
IAM="$AWS_DIR/iam-policy.json"
README="$AWS_DIR/README.md"

command -v python3 >/dev/null 2>&1 || fail "python3 없음"
[ -d "$TF_DIR" ] || fail "infra/aws/terraform missing"
[ -f "$TF_DIR/main.tf" ] || fail "main.tf missing"
[ -f "$TF_DIR/variables.tf" ] || fail "variables.tf missing"
[ -f "$TF_DIR/outputs.tf" ] || fail "outputs.tf missing"
[ -f "$CLOUDINIT" ] || fail "cloud-init.yaml missing"
[ -f "$IAM" ] || fail "iam-policy.json missing"
[ -f "$README" ] || fail "README.md missing"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oort-aws-recipe.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

# ---------------------------------------------------------------------------
# Static assertions against a recipe tree (ROOT-relative or a copy).
# Each helper prints to stderr and returns 1 on failure (no exit).
# ---------------------------------------------------------------------------

assert_prevent_destroy() {
  local tree="$1"
  python3 - "$tree" <<'PY'
import pathlib, re, sys
tree = pathlib.Path(sys.argv[1])
text = (tree / "terraform/main.tf").read_text()

def resource_block(kind, name):
    m = re.search(
        r'resource\s+"%s"\s+"%s"\s*\{' % (re.escape(kind), re.escape(name)),
        text,
    )
    if not m:
        print("missing resource %s.%s" % (kind, name), file=sys.stderr)
        return None
    start = m.end() - 1
    depth = 0
    for i, ch in enumerate(text[start:], start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    print("unclosed resource %s.%s" % (kind, name), file=sys.stderr)
    return None

failed = 0
for kind, name in (("aws_lightsail_disk", "data"), ("aws_ebs_volume", "data")):
    block = resource_block(kind, name)
    if block is None:
        failed = 1
        continue
    if not re.search(r"lifecycle\s*\{[^}]*prevent_destroy\s*=\s*true", block, re.S):
        print("%s.%s missing prevent_destroy = true" % (kind, name), file=sys.stderr)
        failed = 1
sys.exit(failed)
PY
}

assert_ports() {
  local tree="$1"
  python3 - "$tree" <<'PY'
import pathlib, re, sys
tree = pathlib.Path(sys.argv[1])
text = (tree / "terraform/main.tf").read_text()
want = {22, 80, 443}

def block_after(pattern):
    m = re.search(pattern, text)
    if not m:
        return None
    start = m.end() - 1
    depth = 0
    for i, ch in enumerate(text[start:], start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None

failed = 0
ls = block_after(r'resource\s+"aws_lightsail_instance_public_ports"\s+"oort"\s*\{')
if ls is None:
    print("missing aws_lightsail_instance_public_ports.oort", file=sys.stderr)
    failed = 1
else:
    pairs = list(zip(
        map(int, re.findall(r"from_port\s*=\s*(\d+)", ls)),
        map(int, re.findall(r"to_port\s*=\s*(\d+)", ls)),
    ))
    if not pairs:
        print("lightsail public_ports has no from_port/to_port", file=sys.stderr)
        failed = 1
    opened = set()
    for a, b in pairs:
        if a != b:
            print("lightsail port range %s-%s is not a single port" % (a, b), file=sys.stderr)
            failed = 1
        opened.add(a)
        if 5432 >= a and 5432 <= b:
            print("lightsail firewall opens 5432", file=sys.stderr)
            failed = 1
    if opened != want:
        print("lightsail open ports %s != %s" % (sorted(opened), sorted(want)), file=sys.stderr)
        failed = 1

sg = block_after(r'resource\s+"aws_security_group"\s+"oort"\s*\{')
if sg is None:
    print("missing aws_security_group.oort", file=sys.stderr)
    failed = 1
else:
    ingress_blobs = []
    for m in re.finditer(r"ingress\s*\{", sg):
        start = m.end() - 1
        depth = 0
        for i, ch in enumerate(sg[start:], start):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    ingress_blobs.append(sg[start : i + 1])
                    break
    pairs = []
    for blob in ingress_blobs:
        pairs.extend(zip(
            map(int, re.findall(r"from_port\s*=\s*(\d+)", blob)),
            map(int, re.findall(r"to_port\s*=\s*(\d+)", blob)),
        ))
    opened = set()
    for a, b in pairs:
        if a != b:
            print("ec2 sg ingress range %s-%s is not a single port" % (a, b), file=sys.stderr)
            failed = 1
        opened.add(a)
        if 5432 >= a and 5432 <= b:
            print("ec2 security group opens 5432", file=sys.stderr)
            failed = 1
    if opened != want:
        print("ec2 sg ingress ports %s != %s" % (sorted(opened), sorted(want)), file=sys.stderr)
        failed = 1

sys.exit(failed)
PY
}

assert_budget() {
  local tree="$1"
  grep -Eq 'resource[[:space:]]+"aws_budgets_budget"[[:space:]]+"oort"' \
    "$tree/terraform/main.tf" || {
    echo "aws_budgets_budget.oort missing" >&2
    return 1
  }
  return 0
}

assert_no_literals() {
  local tree="$1"
  python3 - "$tree" <<'PY'
import pathlib, re, sys
tree = pathlib.Path(sys.argv[1])
files = list(tree.rglob("*.tf")) + list(tree.rglob("*.yaml")) + list(tree.rglob("*.yml")) + list(tree.rglob("*.json"))
akia = re.compile(r"AKIA[0-9A-Z]{16}")
acct = re.compile(r"(?<![0-9])[0-9]{12}(?![0-9])")
email = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
failed = 0
for path in files:
    text = path.read_text()
    rel = path
    if akia.search(text):
        print("%s: AKIA access-key literal" % rel, file=sys.stderr)
        failed = 1
    for m in acct.finditer(text):
        print("%s: 12-digit account-id literal %s" % (rel, m.group(0)), file=sys.stderr)
        failed = 1
    for m in email.finditer(text):
        print("%s: email literal %s" % (rel, m.group(0)), file=sys.stderr)
        failed = 1
sys.exit(failed)
PY
}

assert_allow_list() {
  local tree="$1"
  python3 - "$tree" <<'PY'
import pathlib, re, sys
text = (pathlib.Path(sys.argv[1]) / "terraform/variables.tf").read_text()
banned = (
    "nano_3_0", "nano_2_0", "micro_3_0", "micro_2_0",
    "t3.nano", "t3.micro", "t3a.nano", "t3a.micro",
    "t4g.nano", "t4g.micro",
)

def quoted_in_block(var_name):
    m = re.search(r'variable\s+"%s"\s*\{' % re.escape(var_name), text)
    if not m:
        print("missing variable %s" % var_name, file=sys.stderr)
        return None, None
    start = m.end() - 1
    depth = 0
    block = None
    for i, ch in enumerate(text[start:], start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                block = text[start : i + 1]
                break
    if block is None:
        return None, None
    default = re.search(r'default\s*=\s*"([^"]+)"', block)
    items = re.findall(r'"([^"]+)"', block)
    return (default.group(1) if default else None), items

failed = 0
b_default, b_items = quoted_in_block("lightsail_bundle_id")
t_default, t_items = quoted_in_block("ec2_instance_type")
if b_default is None or t_default is None:
    sys.exit(1)
if b_default != "small_3_0":
    print("default lightsail_bundle_id %s != small_3_0" % b_default, file=sys.stderr)
    failed = 1
if t_default != "t3.small":
    print("default ec2_instance_type %s != t3.small" % t_default, file=sys.stderr)
    failed = 1
for item in b_items + t_items:
    if item in banned or item.startswith("nano_") or item.startswith("micro_"):
        print("RAM < 2 GiB type in allow-list: %s" % item, file=sys.stderr)
        failed = 1
if "small_3_0" not in b_items:
    print("small_3_0 missing from lightsail allow-list", file=sys.stderr)
    failed = 1
if "t3.small" not in t_items:
    print("t3.small missing from ec2 allow-list", file=sys.stderr)
    failed = 1
sys.exit(failed)
PY
}

assert_data_root() {
  local tree="$1"
  local ci="$tree/cloud-init.yaml"
  grep -Fq '"data-root":"/data/docker"' "$ci" || {
    echo "cloud-init docker data-root is not /data/docker" >&2
    return 1
  }
  grep -Eq '[[:space:]]/data ext4' "$ci" || {
    echo "cloud-init does not mount the extra disk at /data" >&2
    return 1
  }
  if grep -Eq 'data-root["'\'']?\s*:\s*["'\'']/var/lib/docker' "$ci"; then
    echo "cloud-init data-root points at the root disk /var/lib/docker" >&2
    return 1
  fi
  return 0
}

assert_no_cloudinit_secrets_or_up() {
  local tree="$1"
  local ci="$tree/cloud-init.yaml"
  if grep -Eq '(^|[[:space:]])PASSWORD=' "$ci"; then
    echo "cloud-init contains PASSWORD= literal" >&2
    return 1
  fi
  if grep -Eq '(^|[[:space:]])SECRET=' "$ci"; then
    echo "cloud-init contains SECRET= literal" >&2
    return 1
  fi
  if grep -Eq 'self_host_env\.sh|oort[[:space:]]+up|compose[[:space:]]+up' "$ci"; then
    echo "cloud-init starts the stack or generates env (must be SSH)" >&2
    return 1
  fi
  return 0
}

assert_tags_and_iam() {
  local tree="$1"
  grep -Eq 'oort[[:space:]]*=[[:space:]]*"selfhost"' "$tree/terraform/main.tf" || {
    echo "tag oort=selfhost missing" >&2
    return 1
  }
  grep -Eq 'oort_issue' "$tree/terraform/main.tf" || {
    echo "tag oort_issue missing" >&2
    return 1
  }
  python3 - "$tree/iam-policy.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
actions = []
for stmt in data.get("Statement") or []:
    act = stmt.get("Action") or []
    if isinstance(act, str):
        act = [act]
    actions.extend(act)
need = (
    "lightsail:CreateInstances",
    "lightsail:CreateDisk",
    "lightsail:PutInstancePublicPorts",
    "lightsail:AllocateStaticIp",
    "budgets:ModifyBudget",
)
missing = [a for a in need if a not in actions]
if missing:
    print("iam-policy.json missing %s" % ",".join(missing), file=sys.stderr)
    sys.exit(1)
if any(a == "*" or a.startswith("iam:") or a == "ec2:*" for a in actions):
    print("iam-policy.json is not minimum (wildcard or iam/ec2 star)", file=sys.stderr)
    sys.exit(1)
PY
}

assert_recipe() {
  local tree="$1"
  assert_prevent_destroy "$tree" || return 1
  assert_ports "$tree" || return 1
  assert_budget "$tree" || return 1
  assert_no_literals "$tree" || return 1
  assert_allow_list "$tree" || return 1
  assert_data_root "$tree" || return 1
  assert_no_cloudinit_secrets_or_up "$tree" || return 1
  assert_tags_and_iam "$tree" || return 1
  return 0
}

copy_recipe() {
  local dest="$1"
  mkdir -p "$dest"
  cp -R "$AWS_DIR/." "$dest/"
}

# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------
assert_recipe "$AWS_DIR" || fail "canonical recipe static contract"
pass "static contract (prevent_destroy, ports {22,80,443}, budget, allow-list, data-root /data/docker, no literals)"

# ---------------------------------------------------------------------------
# Sabotage ① prevent_destroy removed → RED
# ---------------------------------------------------------------------------
s1="$TMP_ROOT/s1"
copy_recipe "$s1"
python3 - "$s1/terraform/main.tf" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text().replace("prevent_destroy = true", "prevent_destroy = false", 1)
p.write_text(text)
PY
if assert_prevent_destroy "$s1" >/dev/null 2>"$TMP_ROOT/s1.err"; then
  fail "sabotage prevent_destroy stayed green"
fi
pass "sabotage prevent_destroy removed → RED"

# ---------------------------------------------------------------------------
# Sabotage ② firewall opens 5432 → RED
# ---------------------------------------------------------------------------
s2="$TMP_ROOT/s2"
copy_recipe "$s2"
python3 - "$s2/terraform/main.tf" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
needle = """  port_info {
    protocol  = "tcp"
    from_port = 443
    to_port   = 443
  }
"""
extra = needle + """
  port_info {
    protocol  = "tcp"
    from_port = 5432
    to_port   = 5432
  }
"""
if needle not in text:
    raise SystemExit("could not find 443 port_info to extend")
p.write_text(text.replace(needle, extra, 1))
PY
if assert_ports "$s2" >/dev/null 2>"$TMP_ROOT/s2.err"; then
  fail "sabotage 5432 stayed green"
fi
pass "sabotage firewall 5432 → RED"

# ---------------------------------------------------------------------------
# Sabotage ③ docker data-root on the root disk → RED
# (live reboot would drop message count; this run is the static half)
# ---------------------------------------------------------------------------
s3="$TMP_ROOT/s3"
copy_recipe "$s3"
python3 - "$s3/cloud-init.yaml" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text().replace('{"data-root":"/data/docker"}', '{"data-root":"/var/lib/docker"}', 1)
p.write_text(text)
PY
if assert_data_root "$s3" >/dev/null 2>"$TMP_ROOT/s3.err"; then
  fail "sabotage data-root root-disk stayed green"
fi
pass "sabotage data-root /var/lib/docker → RED"

# ---------------------------------------------------------------------------
# terraform fmt / validate — optional tool (SH-11f)
# ---------------------------------------------------------------------------
if ! command -v terraform >/dev/null 2>&1; then
  printf '%s\n' \
    "[test-aws-recipe] optional-tool skip: terraform (fmt/validate) — not installed; static assertions still run (SH-11f)"
  pass "optional-tool skip printed; static path complete"
  exit 0
fi

fmt_out="$TMP_ROOT/fmt.out"
set +e
terraform fmt -check -diff "$TF_DIR" >"$fmt_out" 2>&1
fmt_rc=$?
set -e
if [ "$fmt_rc" -ne 0 ]; then
  cat "$fmt_out" >&2
  fail "terraform fmt -check (exit $fmt_rc)"
fi
pass "terraform fmt -check"

val_parent="$TMP_ROOT/valroot"
mkdir -p "$val_parent/terraform"
cp "$TF_DIR"/*.tf "$val_parent/terraform/"
cp "$CLOUDINIT" "$val_parent/cloud-init.yaml"
val_dir="$val_parent/terraform"

export AWS_ACCESS_KEY_ID=TESTKEYNOTREAL
export AWS_SECRET_ACCESS_KEY=testsecretnotreal
export AWS_DEFAULT_REGION=us-east-1
export AWS_EC2_METADATA_DISABLED=true
export TF_IN_AUTOMATION=1

init_out="$TMP_ROOT/init.out"
set +e
(CDPATH='' cd -- "$val_dir" && terraform init -backend=false -input=false -no-color) \
  >"$init_out" 2>&1
init_rc=$?
set -e
if [ "$init_rc" -ne 0 ]; then
  printf '%s\n' \
    "[test-aws-recipe] optional-tool skip: terraform validate — init failed (provider download/network); static assertions still run (SH-11f)"
  tail -n 20 "$init_out" >&2 || true
  pass "terraform init skipped validate; static path complete"
  exit 0
fi

val_out="$TMP_ROOT/validate.out"
set +e
(CDPATH='' cd -- "$val_dir" && terraform validate -no-color) >"$val_out" 2>&1
val_rc=$?
set -e
if [ "$val_rc" -ne 0 ]; then
  cat "$val_out" >&2
  fail "terraform validate (exit $val_rc)"
fi
pass "terraform validate -backend=false"
pass "all assertions + terraform fmt/validate"
