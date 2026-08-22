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
targets = conf.get("bundle", {}).get("targets")
if targets != ["app", "dmg"]:
    raise SystemExit("bundle.targets %r must be ['app', 'dmg'] (app first — next-channel .app path)" % (targets,))
PY
pass "tauri.conf.json updater endpoint + next.* version + app,dmg targets"

grep -Fq 'DIST_REPO="${MOMO_DIST_REPO:-yeomyeonggeori/momo-alpha}"' \
  scripts/publish_next_build.sh \
  || fail "publish_next_build.sh DIST_REPO default is not yeomyeonggeori/momo-alpha"
grep -Fq 'https://yeomyeonggeori.github.io/momo-alpha/${MANIFEST_NAME}' \
  scripts/publish_next_build.sh \
  || fail "publish_next_build.sh manifest URL is not yeomyeonggeori Pages"
pass "publish script DIST_REPO + Pages URL"

# 채널 플래그가 next-channel cargo tauri build 와 같은 환경에 있어야 한다.
# 파일 어딘가에 주석만 있으면 발행 산출물이 다시 가드에 걸린다.
# --public 갈래는 고의로 플래그를 뺀다(공개 0.1.0 이 next.N 을 업데이트로 보면 안 된다).
python3 - scripts/publish_next_build.sh <<'PY' || fail "MOMO_CHANNEL_BUILD not on cargo tauri build"
import pathlib, sys, re
text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
if "cargo tauri build --bundles app,dmg --ci" not in text:
    raise SystemExit("publish build must request --bundles app,dmg (app path stays bundle/macos/oort.app)")
if not re.search(
    r"MOMO_CHANNEL_BUILD=1\s*\\\s*\n\s*cargo tauri build --bundles app,dmg --ci",
    text,
):
    raise SystemExit("MOMO_CHANNEL_BUILD=1 is missing from the next-channel cargo tauri build")
if "bundle/macos/oort.app" not in text:
    raise SystemExit("APP_PATH must stay bundle/macos/oort.app")
if "codesign --verify --strict" not in text or "DMG_PATH" not in text:
    raise SystemExit("dmg must be produced and codesign --verify --strict'd")
# next 채널 업로드는 tar.gz + zip. dmg 는 --public 의 gh 안내 한 줄만.
create = [ln for ln in text.splitlines() if "gh release create" in ln or "gh release upload" in ln]
next_uploads = [ln for ln in create if "--public" not in ln and "oort-macos-" not in ln]
for ln in next_uploads:
    if ".dmg" in ln:
        raise SystemExit("next-channel gh release must not upload a dmg: %s" % ln.strip())
PY
pass "MOMO_CHANNEL_BUILD=1 is on the next-channel publish build; dmg is extra, not an updater asset"

# 버전 갈래가 서로 섞이면 next 채널 번호를 태운다. cargo 전에 거절해야 한다.
reject_next="$(scripts/publish_next_build.sh --version 0.1.0 2>&1 || true)"
printf '%s\n' "$reject_next" | grep -q '0.1.0-next.N' \
  || fail "next channel must reject 0.1.0 before build (got: $reject_next)"
reject_public="$(scripts/publish_next_build.sh --public --version 0.1.0-next.1 2>&1 || true)"
printf '%s\n' "$reject_public" | grep -qi 'next-channel series' \
  || fail "public dmg must reject next.N before build (got: $reject_public)"
pass "version gates keep next.N and public 0.1.0 apart"

grep -Fq 'cfg!(momo_channel_build)' \
  clients/desktop/src-tauri/src/updater.rs \
  || fail "updater.rs does not read cfg!(momo_channel_build)"
grep -Fq 'cargo:rustc-cfg=momo_channel_build' \
  clients/desktop/src-tauri/build.rs \
  || fail "build.rs does not emit momo_channel_build"
pass "shell cfg wiring present"

# §8 체크리스트가 시크릿 값을 묻지 않고 이름/경로만 쓰는지 — 키 파일을 cat 하면 빨강.
if grep -nE 'cat (~/)?\.momo-secrets/momo-updater\.key|TAURI_SIGNING_PRIVATE_KEY_PASSWORD=' \
  docs/NEXT_CHANNEL.md docs/RELEASING.md; then
  fail "release docs print or assign a secret value"
fi
grep -Fq '## 8. 성재 복붙' docs/NEXT_CHANNEL.md \
  || fail "docs/NEXT_CHANNEL.md is missing §8 paste-ready checklist"
pass "checklist is present and does not dump secrets"

grep -Fq 'releases/latest/download/oort-macos-aarch64.dmg' docs/RELEASING.md \
  || fail "RELEASING.md must pin the T-2 stable dmg URL"
grep -Fq -- '--public' docs/RELEASING.md \
  || fail "RELEASING.md must document --public dmg (not next-channel upload)"
pass "RELEASING.md pins public dmg procedure + stable URL"

echo "[next-channel-hygiene] PASS"
