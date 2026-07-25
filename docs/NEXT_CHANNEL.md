# momo-next 발행 채널 (Tauri 자동 업데이트)

> 범위: `clients/desktop` (Tauri 2 + `clients/web`) 의 내부 배포 채널. ADR-0133 P2 / MOMO-606.
> macOS SwiftUI 클라이언트의 수동 채널은 [`MACOS_ALPHA_UPDATE_CHANNEL.md`](MACOS_ALPHA_UPDATE_CHANNEL.md) 이고 이 문서가 그것을 대체하지 않는다. 두 채널은 당분간 함께 산다.

## 0. 두 채널

| | alpha | next |
| --- | --- | --- |
| 무엇 | macOS SwiftUI 앱 (`MomoMac.app`) | Tauri 2 셸 + 웹 번들 (`momo.app`) |
| 설치 후 갱신 | 사람이 zip 받아 교체 | 앱이 스스로 교체 (버튼 1회 + 재시작 1회) |
| 발행 | `scripts/publish_alpha_build.sh` | `scripts/publish_next_build.sh` |
| 태그 | `v0.0.N` | `next-v0.1.0-next.N` |
| 매니페스트 | `update-manifest-alpha.json` (자체 스키마) | `update-next.json` (Tauri static JSON) |
| 번들 ID | `com.dawnkim.momo` | `app.momo.desktop` |

두 채널이 같은 배포 저장소(`Dawn-kim-official/momo-alpha`)를 쓰지만 태그·자산 이름·매니페스트 파일이 전부 다르므로 서로를 덮지 않는다. 두 앱을 한 맥에 같이 설치해도 파일 이름(`MomoMac.app` / `momo.app`)과 번들 ID가 달라 충돌하지 않는다. **단 하나 겹치는 것은 `momo://` 스킴**이고, macOS LaunchServices 는 핸들러를 하나만 고른다.

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
      "url": "https://github.com/Dawn-kim-official/momo-alpha/releases/download/next-v0.1.0-next.2/momo-next-0.1.0-next.2-darwin-aarch64.app.tar.gz"
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
curl -sS https://dawn-kim-official.github.io/momo-alpha/update-next.json | python3 -m json.tool

# 배포된 tar.gz 가 서명·공증을 유지하는지 (다운로드 후)
tar -xzf momo-next-*.app.tar.gz -C /tmp/check
codesign --verify --strict --deep /tmp/check/momo.app
xcrun stapler validate /tmp/check/momo.app
spctl -a -t exec -vv /tmp/check/momo.app
```

종단 증명은 하나뿐이다: **구버전 설치본에서 배지가 뜨고, 버튼 한 번으로 설치되고, 재시작하면 새 버전이 보이는 것.** 유닛 테스트로는 대신할 수 없다.

## 7. 실측 종단 증명 (2026-07-25, mac aarch64)

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
