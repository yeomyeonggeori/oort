# oort-next 발행 채널 (Tauri 자동 업데이트)

> 범위: `clients/desktop` (Tauri 2 + `clients/web`) 의 **유일한 현행** 내부 배포 채널. ADR-0133 P2 / MOMO-606.
> macOS SwiftUI 수동 채널 런북 [`MACOS_ALPHA_UPDATE_CHANNEL.md`](MACOS_ALPHA_UPDATE_CHANNEL.md) 는 ITO-0 T-C / #1609 에서 **사문서**다. `clients/macOS` 는 삭제됐다(W-S1 / #1215). 따라 가면 없는 트리를 찾는다. 이 문서가 그것을 대체한다.
> 은퇴한 Sparkle/DMG PLAYBOOK: [`RELEASE_PLAYBOOK.md`](RELEASE_PLAYBOOK.md) 상단 배너(ITO-0 T-E / #1610) — 실행하지 말 것.

## 0. 채널 하나 (next). alpha 는 은퇴

| | next (현행) | alpha (은퇴) |
| --- | --- | --- |
| 무엇 | Tauri 2 셸 + 웹 번들 (`oort.app`) | macOS SwiftUI (`MomoMac.app`) — 클라 트리 삭제됨 |
| 설치 후 갱신 | 앱이 스스로 교체 (버튼 1회 + 재시작 1회) | 사람이 zip 받아 교체 — **더 이상 발행하지 않는다** |
| 발행 | `scripts/publish_next_build.sh` | 발행 스크립트 삭제됨 (W-S1 / #1215) |
| 태그 | `next-v0.1.0-next.N` | `v0.0.N` (배포 저장소에 잔존, 덮지 말 것) |
| 매니페스트 | `update-next.json` (Tauri static JSON) | `update-manifest-alpha.json` (잔존, 손대지 말 것) |
| 번들 ID | `app.momo.desktop` | `com.dawnkim.momo` (동결층 — ADR-0152) |

> **배포 저장소 이름 각주(2026-08-10)**: 본 레포는 `yeomyeonggeori/momo` → `yeomyeonggeori/oort` 로 개명됐지만 **배포 저장소 `momo-alpha` 는 개명 대상이 아니다** — 별개의 공개 저장소로 이름 그대로 존재한다(`gh api repos/yeomyeonggeori/momo-alpha` 200, `has_pages: true`). Pages 경로는 발행 저장소명 기준이므로 `https://yeomyeonggeori.github.io/momo-alpha/…` 도 그대로다(실측: 루트·`update-next.json`·`update-manifest-alpha.json` 전부 200). 구 GitHub org 호스트는 소스에서 현행 소유자로 재조준했다. 라이브 매니페스트 안의 옛 자산 URL 은 다음 재발행(§8)이 덮는다 — 이 레포의 워커는 `yeomyeonggeori/momo-alpha` 원격을 만지지 않는다.

next 와 은퇴한 alpha 가 같은 배포 저장소(`yeomyeonggeori/momo-alpha`)를 쓰지만 태그·자산 이름·매니페스트 파일이 전부 다르므로 서로를 덮지 않는다. 옛 `MomoMac.app` 이 아직 설치된 맥에서만 딥링크 스킴(`oort://`, 하위호환 `momo://`)이 겹친다 — macOS LaunchServices 는 핸들러를 하나만 고른다. 현행 체크아웃에는 Swift 셸이 없다.

## 1. 버전 체계

```
0.1.0-next.N   next 채널 프리릴리스 (N 만 증가)
0.1.0          오픈 베타 전환 시 1회
```

- alpha 채널의 `0.0.x` 와 번호가 겹치지 않는다.
- semver 프리릴리스라 `0.1.0-next.9 < 0.1.0` 이 항상 성립한다. 업데이터의 비교는 semver 이므로, 베타 전환일에 `0.1.0` 을 올리면 next 채널의 모든 설치본이 그것을 새 버전으로 본다.
- "minor 상승은 오픈 베타 전환 때 1회" 라는 2026-07-23 규칙과 어긋나지 않는다: next 채널은 그 `0.1.0` 으로 가는 열차이고, 열차 자체는 minor 를 올리지 않는다.
- `publish_next_build.sh` 는 `*-next.N` 형태가 아닌 버전을 거부한다. 실수로 `0.1.0` 을 next 채널에 밀면 오픈 베타 번호를 태워버리고, 업데이터는 내려가지 않으므로 되돌릴 수 없다.

## 2. 신뢰 사슬

두 서명이 서로 다른 일을 하고, 둘 다 필요하다.

| 서명 | 막는 것 | 키 위치 |
| --- | --- | --- |
| minisign (Tauri 업데이터) | 매니페스트/자산이 바꿔치기된 업데이트 | `~/.momo-secrets/momo-updater.key` (0600, 레포 밖). 공개키는 `clients/desktop/src-tauri/tauri.conf.json` |
| Developer ID + 공증 + 스테이플 | Gatekeeper 거부, 최초 설치 마찰 | Apple 키체인 (`Developer ID Application: Kwak Seongjae (YWQQFQM38J)`), 공증은 notarytool 프로파일 `momo-notary` |

minisign 공개키는 빌드에 컴파일되므로, GitHub Pages 가 털려도 서명 없는 페이로드는 설치되지 않는다. 반대로 minisign 만 있고 공증이 없으면 자동 업데이트한 사람만 Gatekeeper 경고를 보게 되므로, 업데이터가 받는 tar.gz 안의 `.app` 은 **스테이플까지 끝난** 번들이어야 한다.

키를 잃어버리면 그 채널의 모든 설치본이 업데이트를 못 받는다(공개키가 앱 안에 박혀 있으므로 새 키로 서명한 매니페스트는 거부된다). 복구 경로는 새 키로 빌드한 앱을 수동 재설치하는 것뿐이다.

## 3. 발행

```sh
scripts/publish_next_build.sh --version 0.1.0-next.2 --notes "인박스 필터가 새로고침 뒤에도 유지됩니다."
```

단계: 빌드(서명 포함) → `codesign --verify` → notarytool 제출 + `stapler staple` → 스테이플된 `.app` 으로 `.app.tar.gz` 재생성 → tar 왕복 검증(`codesign --verify` + `stapler validate`) → minisign 서명 → 릴리스 업로드 → `update-next.json` 커밋.

`--dry-run` 은 공증 직전에서 멈춘다(빌드와 서명만 확인).

환경 변수로 덮어쓸 수 있는 것: `MOMO_SIGN_IDENTITY`, `MOMO_NOTARY_PROFILE`, `MOMO_UPDATER_KEY`, `MOMO_DIST_REPO`.

### 서명·공증에 관한 실측 (2026-07-25)

- **번들러 서명은 동작한다.** `APPLE_SIGNING_IDENTITY` 환경변수만 있으면 Tauri 번들러가 hardened runtime 으로 서명한다. `tauri.conf.json > bundle.macOS.signingIdentity` 에 넣지 않은 이유는, 인증서가 없는 개발 머신의 `cargo tauri build` 를 깨뜨리기 때문이다.
- **번들러 공증은 쓸 수 없다.** 번들러는 `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` 또는 App Store Connect API 키를 요구한다. 우리가 가진 것은 notarytool 의 keychain 프로파일(`momo-notary`)뿐이고, 거기서 app-specific password 를 다시 꺼낼 방법은 없다. 그래서 공증·스테이플은 alpha 스크립트와 같은 `xcrun notarytool --keychain-profile` 경로를 재사용한다.
- **그래서 tar.gz 를 스크립트가 만든다.** 번들러의 `createUpdaterArtifacts` 로 나오는 `.app.tar.gz` 는 공증 이전 상태다. 그것을 그대로 배포하면 자동 업데이트한 사람만 티켓 없는 앱을 받는다. 게다가 그 옵션을 켜 두면 빌드 시점에 minisign 개인키를 요구해서, 키가 없는 개발 머신의 `cargo tauri build` 가 `exit 1` 로 죽는다(실측). 그래서 `tauri.conf.json` 에서 꺼 두고, 스크립트가 스테이플이 끝난 뒤 `COPYFILE_DISABLE=1 tar -czf` 로 묶고, 풀어서 `stapler validate` 까지 통과하는지 확인한 뒤에만 서명한다.
- **프리릴리스 버전 문자열은 통과한다.** `CFBundleShortVersionString`/`CFBundleVersion` 이 `0.1.0-next.1` 이어도 서명·공증·Gatekeeper 가 문제 삼지 않는다(실측).

## 4. 매니페스트

`update-next.json` 은 Tauri 의 static JSON 포맷이다. 자체 스키마가 아니므로 필드를 늘리지 않는다.

```json
{
  "version": "0.1.0-next.2",
  "notes": "인박스 필터가 새로고침 뒤에도 유지됩니다.",
  "pub_date": "2026-07-25T09:12:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "dW50cnVzdGVk…",
      "url": "https://github.com/yeomyeonggeori/momo-alpha/releases/download/next-v0.1.0-next.2/momo-next-0.1.0-next.2-darwin-aarch64.app.tar.gz"
    }
  }
}
```

- `notes` 는 그대로 앱의 업데이트 패널에 보인다. 릴리스 노트가 아니라 **한 문장**으로 쓴다.
- `platforms` 는 병합된다. 한 머신에서 발행한다고 다른 아키텍처 항목을 지우면 그쪽 테스터의 채널이 조용히 멈춘다.
- **GitHub Pages 캐시는 `max-age=600`.** 발행 직후 최대 10분은 옛 매니페스트가 응답될 수 있다. 테스터에게 "바로 안 뜨면 10분 뒤에 다시" 라고 말할 것.

## 5. 앱에서 보이는 것

- 새 버전이 있으면 사이드바 왼쪽 아래에 한 줄이 나타난다. 없으면 아무것도 없다(항상 떠 있는 "최신입니다" 칩은 그 자리를 안 읽게 만든다).
- **로그인 전에도 뜬다.** 연결 화면 카드 안에 같은 한 줄과 같은 버튼이 있다. 운영자가 자리에 없어 서버에 못 닿는 것이 이 채널의 평상시 상태이므로, 그 상태를 고친 빌드를 로그인한 사람에게만 알리면 채널이 가장 필요한 순간에 쓸모가 없다.
- 전체 상태는 **설정 > 업데이트**. `/settings?section=updates` 로 바로 열 수 있다.
- 버튼은 둘이다: `지금 업데이트`(내려받기 + 교체) 와 `지금 재시작`. macOS 는 실행 중인 프로세스 밑에서 번들이 바뀌어도 종료 전까지 옛 이미지를 계속 쓰므로, 재시작 시점은 사람이 고른다.
- 브라우저 탭에서는 이 섹션이 아예 없다. 새로고침이 이미 최신 번들을 가져온다.
- 연결 화면의 런타임 배지는 `desktop 0.1.0-next.2` 처럼 버전을 표시한다. 로그인 전에 버그를 신고할 때 버전을 물어보지 않아도 되게.

## 6. 확인 절차

```sh
# 발행 없이 빌드/서명만
scripts/publish_next_build.sh --version 0.1.0-next.9 --dry-run

# 매니페스트가 실제로 서비스되는지
curl -sS https://yeomyeonggeori.github.io/momo-alpha/update-next.json | python3 -m json.tool

# 배포된 tar.gz 가 서명·공증을 유지하는지 (다운로드 후)
# 번들 이름은 tauri productName — 지금은 oort.app (2026-07-25 실측은 momo.app).
tar -xzf momo-next-*.app.tar.gz -C /tmp/check
codesign --verify --strict --deep /tmp/check/oort.app
xcrun stapler validate /tmp/check/oort.app
spctl -a -t exec -vv /tmp/check/oort.app
```

종단 증명은 하나뿐이다: **구버전 설치본에서 배지가 뜨고, 버튼 한 번으로 설치되고, 재시작하면 새 버전이 보이는 것.** 유닛 테스트로는 대신할 수 없다.

## 7. 실측 종단 증명 (2026-07-25, mac aarch64)

아래 경로는 그날의 번들 이름(`momo.app`)을 그대로 둔다. 지금 산출물은 `oort.app`.

발행 4회(`next.1`~`next.4`), 자동 업데이트 2홉. 로컬 빌드가 아니라 **릴리스 페이지에서 받은 zip** 을 `/Applications` 에 설치한 뒤 시작했다.

1. 설치: `momo-next-0.1.0-next.2-darwin-aarch64.zip` (sha256 `fdd09ff0…`, 페이지 공표값과 일치) → `/Applications/momo.app`. `spctl -a -t exec` = `accepted, source=Notarized Developer ID`.
2. 실행 → 연결 화면에 `새 버전 0.1.0-next.3` 한 줄. 배지는 `desktop 0.1.0-next.2`. mDNS 도 같이 살아 있었다(`MacBook-Pro-2.local:28000` 발견 카드).
3. **키보드만으로** 도달 가능: 창 진입 후 Tab 한 번에 `지금 업데이트` 로 포커스가 가고 액센트 포커스 링이 보인다. Space 로 실행.
4. 약 4초 뒤 행이 `재시작하면 적용` 로 바뀌고, 그 시점에 이미 디스크의 `CFBundleShortVersionString` 은 `0.1.0-next.3`. 실행 중인 창의 배지는 여전히 `next.2` — macOS 가 종료 전까지 옛 이미지를 쓰는 그 동작이 화면에 그대로 보인다.
5. `지금 재시작` → 재실행. 배지 `desktop 0.1.0-next.3`, 그리고 곧바로 `새 버전 0.1.0-next.4`.
6. 같은 방식으로 2홉째 → 배지 `desktop 0.1.0-next.4`, 업데이트 행은 **사라진다**(최신일 때 침묵).
7. 자기 갱신으로 교체된 `/Applications/momo.app` 검증:
   - `spctl -a -t exec -vv` → `accepted, source=Notarized Developer ID`
   - `xcrun stapler validate` → `The validate action worked!`
   즉 **자동 업데이트로 받은 앱과 수동 설치한 앱의 Gatekeeper 판정이 같다.** 스테이플 이후에 tar 를 다시 만드는 단계가 있는 이유가 이것이다.

부수 실측: 발행 직후 매니페스트가 옛 버전을 응답하는 구간이 실제로 있었다(Pages `max-age=600`). §4 의 10분 안내는 추정이 아니다.

패키징된 앱은 `tauri://localhost` 에서 REST 를 교차 오리진으로 부른다. 서버 CORS 레이어(MOMO-605 / #768)는 엔진 베이스에 있고, 셀프호스트 env 생성기는 Tauri origin 2종을 기본 기입한다(ITO-0 T-A / #1607). **라이브 momowebqa 로그인 + 릴리스 번들 왕복은 그 goal 에서 `runtime-unverified`** — 업데이터 종단 증명과 별개다. 좌표: `clients/desktop/README.md` Known gaps.

로컬 `cargo tauri build`(릴리스)는 채널을 따라가지 않는다(#1281). `tauri.conf.json` 의 커밋된 버전은 `0.1.0-next.1` 이고, 발행 스크립트만 `--config` 로 실제 `0.1.0-next.N` 을 주입한다. W-B2-5 가드는 `tauri dev`/`--debug` 만 막았고, 로컬 릴리스는 매니페스트(`next.10`)보다 낮아 기동 즉시 롤백을 제안했다. 지금은 `MOMO_CHANNEL_BUILD=1` 이 있는 산출물만 매니페스트를 본다 — 그 플래그는 이 스크립트만 켠다.

## 8. 성재 복붙 — next.11 재발행 (ITO-3 I5 직전)

이 절만 따라가면 된다. 시크릿 3종(minisign 개인키·Developer ID 개인키·notarytool 프로파일 비밀번호)은 **값으로 출력하거나 채팅/이슈/커밋에 붙이지 말 것.** 존재와 이름만 확인한다. 워커는 이 절을 실행하지 않는다.

자격 위치(2026-08-07 성재 맥 실측, `docs/cicd/13-selfhosted-runner-macos.md` §4):

| 자격 | 이름 / 경로 |
| --- | --- |
| minisign 개인키 | `~/.momo-secrets/momo-updater.key` (0600, 레포 밖) |
| Developer ID | `Developer ID Application: Kwak Seongjae (YWQQFQM38J)` |
| 공증 | notarytool 키체인 프로파일 `momo-notary` |
| 배포 저장소 | `yeomyeonggeori/momo-alpha` (이 레포가 아님 — `MOMO_DIST_REPO` 기본값) |

버전: 마지막 실발행은 `0.1.0-next.10`(2026-07-27, build 1320). 이번은 **`0.1.0-next.11`**. 노트는 업데이트 패널에 그대로 보이므로 한 문장.

### 8.1 전제 (값 출력 금지)

로그인 셸에서. 실패하면 여기서 멈춘다.

```sh
test -f ~/.momo-secrets/momo-updater.key && echo "minisign key: present"
security find-identity -v -p codesigning | grep -F "Developer ID Application: Kwak Seongjae (YWQQFQM38J)"
xcrun notarytool history --keychain-profile momo-notary >/dev/null && echo "notary profile: ok"
command -v cargo >/dev/null && cargo tauri --version
gh auth status
git -C "$(git rev-parse --show-toplevel)" rev-parse --short HEAD
```

체크아웃은 이 goal(#1281)이 랜딩된 `track/engine` HEAD 여야 한다. `MOMO_CHANNEL_BUILD=1` 없는 바이너리는 테스터에게 업데이트를 안 보여 준다.

### 8.2 dry-run (공증 직전에서 정지)

서명까지. 공증·업로드·매니페스트 커밋 없음.

```sh
cd "$(git rev-parse --show-toplevel)"
scripts/publish_next_build.sh --version 0.1.0-next.11 --dry-run --notes "내부 테스트용 next.11 (HEAD 채널 위생)."
```

기대: `codesign --verify` 통과, 로그에 `Authority=Developer ID Application: Kwak Seongjae (YWQQFQM38J)`, `dry run: stopping before notarization`. `spctl` 은 공증 전이므로 `Unnotarized Developer ID` 가 정상.

### 8.3 실발행

맥 앞에서. 첫 실행이면 키체인 "항상 허용"이 뜬다. 공증은 신규 팀 기준 1시간을 넘긴 전례가 있다(`--timeout 120m`).

```sh
cd "$(git rev-parse --show-toplevel)"
scripts/publish_next_build.sh --version 0.1.0-next.11 --notes "내부 테스트용 next.11 (HEAD 채널 위생)."
```

스크립트가 하는 일: 빌드(버전 주입 + `MOMO_CHANNEL_BUILD=1`) → 서명 검증 → notarytool + stapler → 스테이플된 `.app` 으로 tar.gz 재생성 → 왕복 검증 → minisign → `gh release` 업로드 → `update-next.json` 만 커밋·push. `index.html` 은 손대지 않는다.

대안(같은 스크립트, 러너 대행): `docs/cicd/13-selfhosted-runner-macos.md` §3 — 로그인 셸에서 `cd ~/actions-runner && ./run.sh` 를 올린 뒤 `gh workflow run release-desktop.yml --ref track/engine -f mode=release -f version=0.1.0-next.11 -f notes="내부 테스트용 next.11 (HEAD 채널 위생)."`

### 8.4 발행 후 확인 (최대 10분 Pages 캐시)

```sh
curl -sS https://yeomyeonggeori.github.io/momo-alpha/update-next.json | python3 -m json.tool
```

볼 것:

- `version` 이 `0.1.0-next.11`
- `platforms.darwin-aarch64.url` 이 `https://github.com/yeomyeonggeori/momo-alpha/releases/download/next-v0.1.0-next.11/` 로 시작한다 (구 org 호스트 0)
- `signature` 가 비어 있지 않다
- 다른 아키텍처 항목이 있었으면 그대로다 (한 머신 발행이 다른 키를 지우면 그쪽 채널이 멈춘다)

종단: **이전에 설치한 next.10 zip** 을 `/Applications` 에 두고 실행 → 연결 화면에 `새 버전 0.1.0-next.11` → `지금 업데이트` → `지금 재시작` → 배지 `desktop 0.1.0-next.11`. 로컬 `cargo tauri build` 산출물로 이 왕복을 재지 말 것 — 그 빌드는 채널을 보지 않는다(§7). 그게 ITO-3 I5 다.
