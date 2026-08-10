#!/usr/bin/env bash
# oort 1단계 게이트 — 사용자에게 보이는 자리에 momo 가 남아 있으면 빨강.
#
# ADR-0152 D2-1(사용자 노출 잔여 전환)이 되돌아가지 않게 지키는 게이트다. 재는 것은
# 딱 하나: **사람이 읽는 문자열**에 제품 옛 이름이 남았는가. 화면 카피·OS 권한 프롬프트·
# 알림 제목·앱 표시명·사용자가 받는 산출물 이름이 그 범위다.
#
# 이 게이트가 재지 않는 것(= ADR-0152 D1 동결층과 2·4·5단계 몫):
#   - 번들 ID·App Group·keychain·APNs 토픽·플러그인 ID (app.momo.*, com.dawnkim.momo, com.momo.plugins.*)
#   - MOMO-NNN 티켓 참조 · DB role/함수(momo_*) · MOMO_* env · wire schema id(momo.*.vN) · X-Momo-* 헤더
#   - 패키지·타깃·crate 이름(@momo/core, MomoMac, momo-desktop …) · 리포/URL · 파일 경로
#   - 저장 키·이벤트명·accessibilityIdentifier·로그 태그·Bonjour 서비스 타입(_momo._tcp)
#   - 주석 · 테스트 · 픽스처 · 예시 도메인(momo.local, momo.test)
#
# `server-rust/` 는 #1118 에서 합류했다(3절). 클라가 "oort Cloud"를 말하는데 서버가
# 돌려주는 오류 문장이 "momo Cloud"면 사람 눈에는 두 제품이다 — 그 갈라짐을 여기서 잰다.
# Swift `server/` 는 #1118 배치 4 에서 합류했다(4절). prod 이미지가 아직 이쪽을 빌드하므로
# (`infra/prod/docker/momo.Dockerfile`) 사용자가 실제로 받는 문장은 여전히 여기서 나온다.
# 위 형태들은 IDENTIFIER_PATTERNS 로 문자열 리터럴 단위에서 걸러지고, 패턴으로 못 가르는
# 몇 건은 ALLOW 에 이유와 함께 하나씩 적혀 있다. 규칙을 넓혀야 하면 근거는 ADR 이어야
# 한다 — 여기서 조용히 넓히면 게이트가 아무것도 재지 않게 된다.
#
# 사용:  bash scripts/gate_oort_user_facing.sh
# red proof: 전환 지점 하나를 momo 로 되돌리면 이 게이트가 빨강이 된다.
set -euo pipefail

cd "$(dirname "$0")/.."

python3 - "$@" <<'PY'
import os, re, sys, json, plistlib

ROOT = os.getcwd()
failures = []
checked = 0


def rel(p):
    return os.path.relpath(p, ROOT)


# ── 1. 문자열 리터럴 스캐너 ────────────────────────────────────────────────
# 사람이 읽는 카피가 사는 소스만 본다.
SOURCE_DIRS = [
    ("clients/macOS/Sources", (".swift",)),
    ("clients/macOS/XcodeHost", (".swift",)),
    ("clients/iOS/MomoiOSKit/Sources", (".swift",)),
    ("clients/iOS/XcodeHost", (".swift",)),
    ("clients/mobile/ios/MomoPushKit", (".swift",)),
    ("clients/mobile/ios/MomoMobile", (".swift",)),
    ("clients/mobile/ios/NotificationService", (".swift",)),
    ("relay/PushRelay/Sources", (".swift",)),
    ("clients/web/src", (".ts", ".tsx")),
    ("clients/mobile/src", (".ts", ".tsx")),
    ("packages/momo-core/src", (".ts",)),
]

SKIP_PATH = re.compile(r"(^|/)(Tests?|__tests__|Fixtures|fixtures|node_modules|dist|build)(/|$)")
SKIP_FILE = re.compile(r"\.(test|spec)\.[jt]sx?$|Fixtures?\.(swift|ts)$")

# 리터럴이 "식별자"라서 사람이 읽는 카피가 아닌 경우. 위 주석의 제외 규칙과 1:1이다.
IDENTIFIER_PATTERNS = [
    r"://",                            # URL·딥링크
    r"\bmomo:",                        # Tauri 이벤트명 (momo:deep-link …)
    r"\[momo\]",                       # 콘솔 로그 태그
    r"app\.momo|com\.momo|com\.dawnkim\.momo",   # 번들 ID 계열 (동결층)
    r"MOMO-[A-Z0-9]",                  # 티켓 참조 (동결)
    r"MOMO_[A-Z]",                     # env
    r"momo_[a-z]",                     # DB role·SQL 함수·env 폴백
    r"X-Momo-",                        # 서명 헤더
    r"@momo/",                         # npm 패키지
    r"Momo[A-Z]",                      # Swift 타입·타깃·Info.plist 커스텀 키
    r"momo[A-Z]",                       # camelCase 식별자 (momoActions …)
    r"_momo\._tcp",                    # Bonjour 서비스 타입
    r"momo\.[A-Za-z0-9_.\-]+",         # 점 식별자: 저장 키·schema id·카테고리·subsystem
    r"momo\.(local|test|invalid)",     # dev/예시 도메인
    r"[/~]\.?momo\b|momo/",            # 파일 경로 (~/.momo, momo/avatars, scripts/momo)
    r"momo-[a-z0-9]",                  # 하이픈 식별자 (momo-core-team, momo-macos …)
    # 리포 참조. `yeomyeonggeori`가 현행 소유 org이고 `Dawn-kim-official`은 구 org명
    # (#1224에서 실소유로 재조준). 히스토리 문서·픽스처에 구명이 남아 있으므로 둘 다 식별자로 둔다.
    r"repo:|yeomyeonggeori|Dawn-kim-official",
]
IDENTIFIER_RE = re.compile("|".join(IDENTIFIER_PATTERNS))

# 패턴으로 못 가르는 잔존. 전부 "식별자인데 형태가 맨 momo" 인 경우다.
ALLOW = {
    ("clients/macOS/Sources/MomoMac/MomoDeepLink.swift", "momo"):
        "구 딥링크 스킴 수용 목록 — 발급은 oort://, 이미 보낸 링크는 계속 열려야 한다",
    ("clients/iOS/MomoiOSKit/Sources/MomoiOSKit/PushRegistration.swift", "momo"):
        "구 푸시 딥링크 스킴 수용 — 서버가 이미 보낸 알림 안에 살아 있다",
    ("clients/iOS/MomoiOSKit/Sources/MomoiOSPushKit/PushNotification.swift", "momo"):
        "구 딥링크 스킴 발급부(동결 킷, ADR-0137 D8) — 스킴 전환은 별도 ADR",
    ("clients/mobile/ios/MomoPushKit/PushNotification.swift", "momo"):
        "위 동결 킷의 바이트 단위 승계 복사본",
    ("packages/momo-core/src/features/auth/deepLink.ts", "momo"):
        "구 딥링크 스킴 수용 목록 (코어)",
    ("clients/macOS/Sources/MomoMac/MomoWorkHostIdentityStore.swift", "momo"):
        "Application Support 하위 디렉터리 경로 — 옮기면 기존 호스트 신원을 잃는다",
}

BRAND_RE = re.compile(r"momo|모모", re.IGNORECASE)

# 주석 제거 — 주석 산문은 2단계의 몫이다.
BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
LINE_COMMENT = re.compile(r"(^|[^:'\"])//[^\n]*")
LITERAL = re.compile(r'"((?:[^"\\\n]|\\.)*)"' r"|'((?:[^'\\\n]|\\.)*)'" r"|`((?:[^`\\]|\\.)*)`", re.S)
# 보간 안은 코드(변수명)다 — 카피가 아니다.
INTERPOLATION = re.compile(r"\\\([^)]*\)|\$\{[^}]*\}")


def strip_comments(text):
    text = BLOCK_COMMENT.sub(" ", text)
    return LINE_COMMENT.sub(lambda m: m.group(1), text)


def scan_sources():
    global checked
    for base, exts in SOURCE_DIRS:
        base_abs = os.path.join(ROOT, base)
        if not os.path.isdir(base_abs):
            continue
        for dirpath, dirnames, filenames in os.walk(base_abs):
            if SKIP_PATH.search(rel(dirpath)):
                dirnames[:] = []
                continue
            for name in sorted(filenames):
                if not name.endswith(exts) or SKIP_FILE.search(name):
                    continue
                path = os.path.join(dirpath, name)
                checked += 1
                body = strip_comments(open(path, encoding="utf-8").read())
                for m in LITERAL.finditer(body):
                    literal = next(g for g in m.groups() if g is not None)
                    prose = INTERPOLATION.sub(" ", literal)
                    if not BRAND_RE.search(prose):
                        continue
                    if IDENTIFIER_RE.search(prose):
                        continue
                    if (rel(path), prose) in ALLOW:
                        continue
                    line = body.count("\n", 0, m.start()) + 1
                    failures.append(
                        "%s:%d 사용자 문자열에 옛 이름이 남았다: %r" % (rel(path), line, literal[:90])
                    )


# ── 2. 표시명·타이틀·산출물 이름 (구조를 직접 읽는다) ──────────────────────
def expect(label, actual, wanted):
    global checked
    checked += 1
    if actual != wanted:
        failures.append("%s: %r 이어야 하는데 %r" % (label, wanted, actual))


def check_structured():
    global checked
    conf = json.load(open("clients/desktop/src-tauri/tauri.conf.json"))
    expect("tauri.conf.json productName", conf["productName"], "oort")
    expect("tauri.conf.json window title", conf["app"]["windows"][0]["title"], "oort")

    # 화면·OS에 노출되는 plist 값만 본다. 나머지 키(번들 ID·App Group·APNs)는 동결층이다.
    for path in [
        "clients/macOS/XcodeHost/Info.plist",
        "clients/iOS/XcodeHost/Info.plist",
        "clients/iOS/NotificationService/Info.plist",
        "clients/mobile/ios/MomoMobile/Info.plist",
        "clients/mobile/ios/NotificationService/Info.plist",
        "clients/desktop/src-tauri/Info.plist",
    ]:
        checked += 1
        with open(path, "rb") as fh:
            data = plistlib.load(fh)
        for key, value in data.items():
            if not isinstance(value, str):
                continue
            visible = key in ("CFBundleName", "CFBundleDisplayName") or (
                key.startswith("NS") and key.endswith("UsageDescription")
            )
            if visible and BRAND_RE.search(value):
                failures.append("%s: %s 값에 옛 이름이 남았다: %r" % (path, key, value))

    html = open("clients/web-legacy/index.html", encoding="utf-8").read()
    title = re.search(r"<title>(.*?)</title>", html, re.S)
    expect("clients/web-legacy/index.html <title>", title and title.group(1).strip(), "oort")

    # 사용자가 받는 산출물 이름: DMG 볼륨명과 .dmg 파일명만 본다.
    # build/MomoMac.app 은 Xcode 타깃 산출물(축2 식별자)이라 여기서 재지 않는다.
    checked += 1
    wf = open(".github/workflows/release-macos.yml", encoding="utf-8").read()
    artifacts = re.findall(r"-{1,2}volname\s+\"([^\"]+)\"", wf)
    artifacts += re.findall(r"([A-Za-z0-9_./${}\- ]*\.dmg)", wf)
    for token in artifacts:
        if BRAND_RE.search(token):
            failures.append("release-macos.yml 산출물 이름에 옛 이름: %r" % token)

    # 데스크톱 산출물 경로는 productName 을 따라간다 — 갈라지면 발행이 깨진다.
    checked += 1
    pub = open("scripts/publish_next_build.sh", encoding="utf-8").read()
    if "bundle/macos/%s.app" % conf["productName"] not in pub:
        failures.append(
            "scripts/publish_next_build.sh APP_PATH 가 tauri productName(%s)과 어긋난다" % conf["productName"]
        )

    # 업데이터 매니페스트에 실려 사용자가 읽는 문구.
    for path in ("scripts/switch_default_download.sh", "scripts/publish_next_build.sh"):
        checked += 1
        for line in open(path, encoding="utf-8"):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if re.search(r'"(app|summary)":|--title|(?<![A-Z_])NOTES=|Move .*\.app into', stripped) and BRAND_RE.search(stripped):
                failures.append("%s 사용자 문구에 옛 이름: %s" % (path, stripped[:90]))


# ── 3. server-rust 가 사람에게 돌려주는 문장 (#1118) ───────────────────────
# API 오류 본문·승인 카드 카피·에이전트가 매 턴 읽는 preamble 이 범위다. 테스트
# 모듈은 재지 않는다: Rust 관례상 `#[cfg(test)]` 는 파일 맨 뒤이므로 거기서 자르고,
# `tests/` 통합 테스트 디렉터리는 통째로 건너뛴다.
RUST_ROOT = "server-rust"
RUST_IDENTIFIER_RE = re.compile(
    r"://|momo_[a-z]|momo-[a-z]|MOMO_[A-Z]|MOMO-[A-Z0-9]|app\.momo|com\.momo"
    r"|X-Momo-|@momo/|Momo[A-Z]|momo[A-Z]|momo\.[A-Za-z0-9_.{]|/momo|momo/|momohost"
)
CFG_TEST_RE = re.compile(r"^#\[cfg\(test\)\]", re.M)

# 패턴으로 못 가르는 잔존. 전부 "형태가 맨 momo 인 계약값/로그"다.
RUST_ALLOW = {
    ("server-rust/bins/momo-notifier/src/lib.rs", "momo notifier starting"):
        "운영 로그 라인 — 사람이 제품 안에서 읽는 카피가 아니다",
    ("server-rust/bins/momo-notifier/src/lib.rs", "momo notifier stopped"):
        "운영 로그 라인",
    ("server-rust/bins/momo-server/src/config.rs", "momo"):
        "예약 핸들 목록 + POSTGRES_DB 기본값 — 와이어/인프라 계약값(D1)",
    ("server-rust/crates/momo-settings/src/provider.rs", "momo"):
        "예약 핸들 목록 — 같은 계약값의 도메인 쪽 복사본",
    ("server-rust/crates/momo-t3/src/provider/cubesandbox.rs", "momo_"):
        "CubeSandbox 인스턴스 메타데이터 키의 접두사 상수 METADATA_KEY_PREFIX(#1197 H3). "
        "같은 파일의 momo_provision_id·momo_workspace_id 가 공유하는 앞부분이고, "
        "프로바이더 API 에 실려 나가는 계약값이지 사람이 제품 안에서 읽는 카피가 아니다 "
        "— ADR-0152 D1 동결층의 momo_* 네임스페이스와 같은 부류다. 접두사 단독이라 "
        "뒤에 글자가 오는 형태만 가르는 momo_[a-z] 패턴이 못 가른다. 패턴을 맨 momo_ 로 "
        "넓히면 그 글자열을 품은 진짜 카피까지 통과하므로, 넓히지 않고 여기 한 줄로 적는다(#1236).",
}


def scan_server_rust():
    global checked
    root = os.path.join(ROOT, RUST_ROOT)
    if not os.path.isdir(root):
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ("target", "tests")]
        for name in sorted(filenames):
            if not name.endswith(".rs"):
                continue
            path = os.path.join(dirpath, name)
            checked += 1
            raw = open(path, encoding="utf-8").read()
            cut = CFG_TEST_RE.search(raw)
            if cut:
                raw = raw[: cut.start()]
            body = strip_comments(raw)
            for m in re.finditer(r'"((?:[^"\\\n]|\\.)*)"', body):
                literal = m.group(1)
                if not BRAND_RE.search(literal):
                    continue
                if RUST_IDENTIFIER_RE.search(literal):
                    continue
                if (rel(path), literal) in RUST_ALLOW:
                    continue
                line = body.count("\n", 0, m.start()) + 1
                failures.append(
                    "%s:%d 서버가 돌려주는 문장에 옛 이름이 남았다: %r"
                    % (rel(path), line, literal[:90])
                )


# ── 4. Swift server/ 가 사람에게 돌려주는 문장 (#1118 배치 4) ──────────────
# server-rust 로 포팅 중이지만 prod 이미지는 아직 이쪽을 빌드한다. 3절과 같은 것을
# 재되, Swift 이므로 `"""` 여러 줄 리터럴(에이전트가 매 턴 읽는 preamble 이 여기 산다)도
# 본다. `server/Tests`·`server/Fixtures` 는 walk 대상이 아니다.
SWIFT_SERVER_ROOT = "server/Sources"
SWIFT_MULTILINE = re.compile(r'"""(.*?)"""', re.S)

# 패턴으로 못 가르는 잔존. 전부 "형태가 맨 momo 인 계약값"이다.
SWIFT_SERVER_ALLOW = {
    ("server/Sources/MomoServer/Config.swift", "momo"):
        "POSTGRES_USER/PASSWORD/DB 기본값 + PG URL 파싱 폴백 + 취약 시크릿 거부 목록 — 인프라 계약값(D1)",
    ("server/Sources/MomoServer/DB/Database.swift", "momo"):
        "PG URL 파싱의 데이터베이스명 폴백 — 같은 계약값",
    ("server/Sources/MomoServer/Plugins/PluginManifestValidator.swift", "momo"):
        "플러그인 매니페스트 v0 의 최상위 키 이름 — 와이어 계약(momo.plugin.v1)",
    ("server/Sources/MomoServer/Plugins/PluginManifestValidator.swift", "unknown or missing field at momo"):
        "위 키 이름을 그대로 인용하는 검증 실패 경로 라벨",
    ("server/Sources/MomoServer/Drive/DriveBackend.swift", "momo Drive stub text"):
        "MOMO_DRIVE_BACKEND=stub 전용 결정론 픽스처 — staging/prod 부팅이 거부하는 모드",
    ("server/Sources/MomoServer/Drive/DriveBackend.swift", "momo Drive stub document"):
        "같은 스텁 픽스처",
    ("server/Sources/MomoServer/Auth/WorkHostAuthenticator.swift", "momohost"):
        "Authorization 스킴 토큰 — 와이어 계약",
    ("server/Sources/MomoServer/Routes/AttachmentRoutes.swift", "momo.\\(action).v1"):
        "audit_log detail 의 wire schema id — 보간이 점 뒤에 오는 탓에 점 식별자 패턴이 못 가른다",
}


def scan_swift_server():
    global checked
    root = os.path.join(ROOT, SWIFT_SERVER_ROOT)
    if not os.path.isdir(root):
        return
    for dirpath, dirnames, filenames in os.walk(root):
        if SKIP_PATH.search(rel(dirpath)):
            dirnames[:] = []
            continue
        for name in sorted(filenames):
            if not name.endswith(".swift") or SKIP_FILE.search(name):
                continue
            path = os.path.join(dirpath, name)
            checked += 1
            body = strip_comments(open(path, encoding="utf-8").read())
            spans = []
            for m in SWIFT_MULTILINE.finditer(body):
                spans.append((m.group(1), m.start()))
            # 여러 줄 리터럴은 따옴표 셋이라 한 줄 스캐너가 잘못 자른다 — 먼저 비운다.
            flat = SWIFT_MULTILINE.sub(lambda m: " " * (m.end() - m.start()), body)
            for m in re.finditer(r'"((?:[^"\\\n]|\\.)*)"', flat):
                spans.append((m.group(1), m.start()))
            for literal, start in spans:
                prose = INTERPOLATION.sub(" ", literal)
                if not BRAND_RE.search(prose):
                    continue
                if IDENTIFIER_RE.search(prose):
                    continue
                # 보간을 지운 형태와 원문 둘 다로 조회한다 — 보간이 낀 계약값은
                # 원문 그대로 적어야 ALLOW 가 읽힌다.
                if (rel(path), prose) in SWIFT_SERVER_ALLOW:
                    continue
                if (rel(path), literal) in SWIFT_SERVER_ALLOW:
                    continue
                line = body.count("\n", 0, start) + 1
                failures.append(
                    "%s:%d 서버가 돌려주는 문장에 옛 이름이 남았다: %r"
                    % (rel(path), line, literal.strip()[:90])
                )


scan_sources()
check_structured()
scan_server_rust()
scan_swift_server()

if failures:
    print("GATE FAIL: oort 사용자 노출 잔여 %d 건" % len(failures))
    for f in failures:
        print("  - " + f)
    sys.exit(1)

print("GATE PASS: oort 사용자 노출 표면 %d 곳 확인, momo 잔여 0" % checked)
PY
