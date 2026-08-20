#!/usr/bin/env bash
# #1281 — next 채널 소스의 구 org URL 0, 채널 빌드 플래그, 매니페스트 엔드포인트.
#
# 라이브 배포 저장소(yeomyeonggeori/momo-alpha)는 이 테스트가 clone/push 하지 않는다.
# 재는 것은 이 레포 안의 발행 경로가 다시 Dawn-kim-official 을 가리키지 않는지다.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"

fail() { echo "[next-channel-hygiene] FAIL: $*" >&2; exit 1; }
pass() { echo "[next-channel-hygiene] ok: $*"; }

LIVE_FILES=(
  scripts/publish_next_build.sh
  clients/desktop/src-tauri/tauri.conf.json
  docs/NEXT_CHANNEL.md
  .github/workflows/release-desktop.yml
)

for f in "${LIVE_FILES[@]}"; do
  [ -f "$f" ] || fail "missing $f"
done

# URL 형태만. 산문의 "구 org" 호명은 이력 각주에 남을 수 있다.
if grep -nEi \
  'dawn-kim-official\.github\.io|github\.com/dawn-kim-official|ghcr\.io/dawn-kim-official' \
  "${LIVE_FILES[@]}"; then
  fail "live next-channel files still name a Dawn-kim-official URL"
fi
pass "live files have 0 Dawn-kim-official URLs"

python3 - "$ROOT/clients/desktop/src-tauri/tauri.conf.json" <<'PY' || fail "tauri updater endpoint"
import json, sys
conf = json.load(open(sys.argv[1], encoding="utf-8"))
want = "https://yeomyeonggeori.github.io/momo-alpha/update-next.json"
got = conf["plugins"]["updater"]["endpoints"]
if got != [want]:
    raise SystemExit("endpoints %r != [%r]" % (got, want))
version = conf.get("version", "")
if not version.startswith("0.1.0-next."):
    raise SystemExit("tauri.conf.json version %r is not a next-channel prerelease" % version)
PY
pass "tauri.conf.json updater endpoint + next.* version"

grep -Fq 'DIST_REPO="${MOMO_DIST_REPO:-yeomyeonggeori/momo-alpha}"' \
  scripts/publish_next_build.sh \
  || fail "publish_next_build.sh DIST_REPO default is not yeomyeonggeori/momo-alpha"
grep -Fq 'https://yeomyeonggeori.github.io/momo-alpha/${MANIFEST_NAME}' \
  scripts/publish_next_build.sh \
  || fail "publish_next_build.sh manifest URL is not yeomyeonggeori Pages"
pass "publish script DIST_REPO + Pages URL"

# 채널 플래그가 cargo tauri build 와 같은 서브셸에 있어야 한다.
# 파일 어딘가에 주석만 있으면 발행 산출물이 다시 가드에 걸린다.
python3 - scripts/publish_next_build.sh <<'PY' || fail "MOMO_CHANNEL_BUILD not on cargo tauri build"
import pathlib, sys, re
text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
# The assignment must appear in the build subshell, before cargo tauri build.
block = re.search(
    r"\(\s*cd clients/desktop.*?cargo tauri build --bundles app --ci",
    text,
    re.S,
)
if block is None:
    raise SystemExit("could not find the clients/desktop cargo tauri build subshell")
if "MOMO_CHANNEL_BUILD=1" not in block.group(0):
    raise SystemExit("MOMO_CHANNEL_BUILD=1 is missing from the build subshell")
PY
pass "MOMO_CHANNEL_BUILD=1 is on the publish build"

grep -Fq 'cfg!(momo_channel_build)' \
  clients/desktop/src-tauri/src/updater.rs \
  || fail "updater.rs does not read cfg!(momo_channel_build)"
grep -Fq 'cargo:rustc-cfg=momo_channel_build' \
  clients/desktop/src-tauri/build.rs \
  || fail "build.rs does not emit momo_channel_build"
pass "shell cfg wiring present"

# §8 체크리스트가 시크릿 값을 묻지 않고 이름/경로만 쓰는지 — 키 파일을 cat 하면 빨강.
if grep -nE 'cat (~/)?\.momo-secrets/momo-updater\.key|TAURI_SIGNING_PRIVATE_KEY_PASSWORD=' \
  docs/NEXT_CHANNEL.md; then
  fail "NEXT_CHANNEL.md checklist prints or assigns a secret value"
fi
grep -Fq '## 8. 성재 복붙' docs/NEXT_CHANNEL.md \
  || fail "docs/NEXT_CHANNEL.md is missing §8 paste-ready checklist"
pass "checklist is present and does not dump secrets"

echo "[next-channel-hygiene] PASS"
