# oort — 셀프호스티드 macOS 러너 (데스크톱 릴리스용)

> 근거: **ADR-0153 D2** — 산출물 빌드는 GH Actions 워크플로를 그대로 두고 러너만 자체 호스팅한다(과금 0).
> 첫 소비자: [`.github/workflows/release-desktop.yml`](../../.github/workflows/release-desktop.yml) (#1116).
> 채널 계약은 [`docs/NEXT_CHANNEL.md`](../NEXT_CHANNEL.md) 가 정본이고, 이 문서는 그것을 **CI에서 대행 실행하기 위한 러너 운영 절차**만 다룬다.

## 1. 원칙 — 상시 데몬이 아니다

ADR-0153 D2 는 macOS 러너를 "릴리스 때만 온라인"으로 못박았다. 그래서 이 문서는 `svc.sh install`(launchd 데몬)을 **쓰지 않는다**. 릴리스할 때 사람이 터미널에서 `./run.sh` 를 올리고, 끝나면 Ctrl-C 로 내린다.

이유는 셋이다.

- **유휴 데몬을 안 만든다.** ADR-0153 D2 의 "설치 시점 = 첫 자동화 수요 시, 유휴 데몬 선설치 금지"가 그대로 적용된다.
- **로그인 세션이 필요하다.** 서명은 로그인 키체인의 개인키를, 공증은 키체인 프로파일(`momo-notary`)을 읽는다. launchd 데몬은 로그인 키체인에 닿지 못하거나 잠긴 키체인을 만나 조용히 멈춘다. `./run.sh` 를 사람의 터미널에서 띄우면 그 세션의 키체인·PATH(`~/.cargo/bin`, fnm node)를 그대로 물려받는다.
- **보안 경계가 사람이다.** 셀프호스티드 러너는 워크플로 코드를 성재 맥에서 실행한다. 러너가 꺼져 있는 동안에는 어떤 워크플로도 그 맥을 건드릴 수 없다.

러너가 꺼져 있으면 dispatch 한 잡은 실패하지 않고 **큐에서 기다린다**. 러너를 올리면 그때 잡힌다(의도된 동작).

## 2. 등록 (한 번만)

### 2.1 등록 토큰

오케스트레이터의 `gh` 권한이 ADMIN 이므로 API로 바로 발급한다(웹 UI 불필요). 토큰은 **1시간 만료**이며 러너 하나를 등록할 수 있는 자격이다 — 로그·PR·이슈에 붙이지 말 것.

```sh
gh api -X POST repos/yeomyeonggeori/oort/actions/runners/registration-token --jq .token
```

권한만 확인하고 토큰 값은 남기고 싶지 않을 때:

```sh
gh api -X POST repos/yeomyeonggeori/oort/actions/runners/registration-token --jq '"ok, expires_at=" + .expires_at'
```

### 2.2 설치·구성

```sh
mkdir -p ~/actions-runner && cd ~/actions-runner
RUNNER_VERSION=2.336.0     # gh api repos/actions/runner/releases/latest --jq .tag_name
curl -fsSLO "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"
tar xzf "actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"

./config.sh \
  --url https://github.com/yeomyeonggeori/oort \
  --token "$(gh api -X POST repos/yeomyeonggeori/oort/actions/runners/registration-token --jq .token)" \
  --name seongjae-mac \
  --labels release-desktop \
  --work _work \
  --unattended --replace
```

- `self-hosted` · `macOS` · `ARM64` 라벨은 GitHub가 자동으로 붙인다. 워크플로의 `runs-on: [self-hosted, macOS]`(ADR-0153 명시)가 이것으로 매칭된다. `--labels release-desktop` 은 나중에 러너가 늘었을 때 구분하려고 붙이는 여분이다.
- `--replace` 는 같은 이름의 죽은 등록이 남아 있을 때 덮어쓴다.
- 등록 확인: `gh api repos/yeomyeonggeori/oort/actions/runners --jq '[.runners[] | {name, status, labels: [.labels[].name]}]'`

## 3. 릴리스마다 하는 것

```sh
# 1) 러너를 올린다 — 반드시 사람의 로그인 셸(터미널)에서. 포그라운드로 뜬다.
cd ~/actions-runner && ./run.sh

# 2) 다른 창에서 워크플로를 던진다.
gh workflow run release-desktop.yml --ref track/engine -f mode=build-only
gh workflow run release-desktop.yml --ref track/engine -f mode=dry-run -f version=0.1.0-next.5
gh workflow run release-desktop.yml --ref track/engine -f mode=release \
  -f version=0.1.0-next.5 -f notes="인박스 필터가 새로고침 뒤에도 유지됩니다."

# 3) 지켜본다.
gh run watch "$(gh run list --workflow=release-desktop.yml -L1 --json databaseId --jq '.[0].databaseId')"

# 4) 끝나면 러너를 내린다.
#    ./run.sh 창에서 Ctrl-C
```

`notes` 는 릴리스 노트가 아니라 앱의 업데이트 패널에 그대로 보이는 **한 문장**이다(NEXT_CHANNEL.md §4).

## 4. 러너 머신이 갖고 있어야 하는 것

이 워크플로는 **레포에 자격증명을 두지 않는다.** 이름만 참조하고 값은 전부 러너 머신에 있다. 2026-08-07 성재 맥에서 실측한 상태:

| 자격 | 형태 | 위치 | 실측 |
|---|---|---|---|
| Developer ID Application | 인증서 + 개인키 | 로그인 키체인 `Developer ID Application: Kwak Seongjae (YWQQFQM38J)` | ✅ `security find-identity -v -p codesigning` 에 valid |
| 공증 | notarytool 키체인 프로파일 `momo-notary` | 로그인 키체인 | ✅ `xcrun notarytool history --keychain-profile momo-notary` 성공 (Accepted 이력 있음) |
| 업데이터 서명 | minisign 개인키 | `~/.momo-secrets/momo-updater.key` (0600, 레포 밖) | ✅ 존재. 공개키는 `tauri.conf.json` 에 컴파일됨 |
| 툴체인 | rust 1.95 / tauri-cli 2.11 / node 24 / npm 11 / Xcode 26.5 | 로그인 셸 PATH | ✅ 워크플로 preflight 가 매번 재확인 |

즉 **Developer ID 서명·공증·업데이터 서명 전부 자격이 충족되어 있고, 자리표시자(placeholder)로 남긴 항목은 없다.**

레포 쪽에 둘 수 있는 것은 이름/선택값뿐이다(전부 없어도 동작한다):

| 종류 | 키 | 없을 때 |
|---|---|---|
| Variable | `MOMO_SIGN_IDENTITY` | 위 Developer ID 문자열이 기본값 |
| Variable | `MOMO_NOTARY_PROFILE` | `momo-notary` |
| Variable | `MOMO_UPDATER_KEY` | `~/.momo-secrets/momo-updater.key` |
| Variable | `MOMO_DIST_REPO` | `yeomyeonggeori/momo-alpha` |
| Secret | `MOMO_DIST_TOKEN` | 러너 사용자의 `gh`/git 자격을 그대로 쓴다(기본 경로) |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 빈 문자열 |

`momo-alpha` 는 본 레포(`yeomyeonggeori/oort`)의 개명과 **무관하다** — 별개의 공개 배포 저장소로 이름 그대로 존재한다(2026-08-10 실측). 구 org 이름만 현행 소유자로 바꿨다.

`MOMO_DIST_TOKEN` 이 별도 항목인 이유: 발행 대상은 **다른 저장소**(`yeomyeonggeori/momo-alpha` — 릴리스 자산 + Pages 매니페스트)라 `secrets.GITHUB_TOKEN` 으로는 닿지 않는다. 러너가 성재 맥이라면 그 계정의 자격이 이미 있으므로 비워 두는 편이 맞다.

## 5. 세 모드

| mode | 하는 일 | 쓰는 자격 | 산출물 |
|---|---|---|---|
| `build-only` | npm ci + `cargo tauri build --bundles app --ci` | 없음 | 워크플로 아티팩트(ad-hoc 서명 zip, **설치용 아님**) |
| `dry-run` | `publish_next_build.sh --dry-run` — 빌드 + Developer ID 서명 + `codesign --verify` | 키체인 인증서 | 없음(러너 로컬 `.app`) |
| `release` | 전체 — 공증·스테이플·릴리스 업로드·`update-next.json` 커밋 | 인증서 + 공증 프로파일 + minisign + 배포 저장소 쓰기 | 배포 저장소 릴리스 `next-v<version>` + Pages 매니페스트 |

발행 논리를 워크플로에 복사하지 않고 `scripts/publish_next_build.sh` 를 그대로 호출한다. 스크립트는 이미 tar 왕복 검증(`codesign --verify` + `stapler validate`)까지 하는 검증된 경로이고(NEXT_CHANNEL.md §7 종단 증명), 두 벌로 나뉘면 로컬 발행과 CI 발행이 갈라진다.

## 6. 키체인 접근 프롬프트

러너가 처음으로 서명·공증을 시도할 때 macOS가 "키체인 항목 접근을 허용하시겠습니까" 대화상자를 띄울 수 있다. `./run.sh` 를 로그인 세션에서 띄웠으므로 화면에 뜬다 — **첫 릴리스는 맥 앞에서 실행하고 "항상 허용"을 고를 것.** 그 뒤로는 묻지 않는다.

워크플로는 이 순간을 앞당기려고 `release` 모드에서 빌드보다 **먼저** `notarytool history` 를 한 번 호출한다. 20분짜리 빌드 뒤에 대화상자를 만나는 것보다 낫다.

데몬으로 돌리면 이 대화상자가 뜰 화면이 없어 잡이 그대로 멈춘다 — §1 이 `svc.sh` 를 배제한 실질적 이유다.

## 7. 디스크 위생

- `~/actions-runner/_work/momo/momo/clients/desktop/src-tauri/target` = **약 1.1GB**(release 프로필, 295 crate). 워크플로는 `actions/checkout` 을 `clean: false` 로 돌려 이 캐시를 **일부러 보존한다** — 안 그러면 릴리스마다 콜드 빌드다.
- 대신 매 실행 첫 단계에서 `git status --porcelain --untracked-files=no` 로 추적 파일이 더러운지 본다. 더러우면 잡이 즉시 실패한다.
- 콜드 빌드를 강제하고 싶으면 `rm -rf ~/actions-runner/_work` 후 재실행.
- 러너를 오래 안 쓸 거면 `_work` 를 지우는 편이 낫다(Docker 자원 누적과 같은 종류의 문제).

## 8. 제거

```sh
cd ~/actions-runner
./config.sh remove --token "$(gh api -X POST repos/yeomyeonggeori/oort/actions/runners/remove-token --jq .token)"
```

## 9. 보안 경계

- 레포가 **private** 이라 fork PR 코드 실행 위험이 원리적으로 없다(ADR-0153 Context).
- 그래도 트리거는 `workflow_dispatch` **전용**이다. push/PR 트리거를 달면 브랜치에 코드를 넣을 수 있는 누구나 성재 맥의 키체인 옆에서 임의 코드를 돌리게 된다. 이 제약을 풀려면 ADR이 필요하다.
- `permissions: contents: read` — 발행 대상이 이 레포가 아니므로 쓰기 권한이 필요 없다.
- 등록/제거 토큰은 1시간 만료지만 그 사이에는 러너를 붙일 수 있는 자격이다. 로그에 남기지 말 것.

## 10. 트러블슈팅

| 증상 | 원인 | 조치 |
|---|---|---|
| 잡이 `Waiting for a runner…` 에서 멈춤 | 러너가 꺼져 있음 | `cd ~/actions-runner && ./run.sh` |
| `cargo/node 을 찾을 수 없습니다` | 러너를 로그인 셸이 아닌 곳에서 띄움 | 터미널에서 `./run.sh` 재기동. 워크플로가 `~/.cargo/bin` 은 보정하지만 fnm node 는 세션 PATH에 의존한다 |
| `tauri-cli 없음` | 툴체인 미설치 | `cargo install tauri-cli --version '^2'` |
| `추적 파일이 수정된 상태입니다` | 이전 실행 잔재 | `rm -rf ~/actions-runner/_work` |
| 공증이 몇십 분째 대기 | Apple 쪽 큐 | 정상. 신규 팀 첫 공증은 1시간 초과 전례(2026-07-24 실측). `timeout-minutes: 180` |
| `notarytool 프로파일을 쓸 수 없습니다` | 키체인 잠김/프로파일 없음 | 맥 로그인 상태 확인 → `xcrun notarytool store-credentials momo-notary` 재등록 |
| 배포 저장소 push 실패 | `gh`/git 자격 없음 | 러너 사용자로 `gh auth status` 확인, 또는 `MOMO_DIST_TOKEN` 시크릿 설정 |

## 11. `tauri.conf.json` 에 서명/공증 블록이 없는 이유 (의도)

#1116 발제와 research(2026-08-06) §판정 3 은 "tauri.conf.json 에 서명/공증 블록 부재"를 결함으로 적었지만, **이 부재는 2026-07-25 실측에 따른 의도된 선택**이다(NEXT_CHANNEL.md §3). 이 티켓에서 `tauri.conf.json` 을 건드리지 않은 이유가 그것이다.

- `bundle.macOS.signingIdentity` 를 넣으면 인증서 없는 개발 머신의 `cargo tauri build` 가 깨진다. 서명은 `APPLE_SIGNING_IDENTITY` 환경변수로 붙인다(번들러가 hardened runtime 으로 서명하는 것까지 실측 확인).
- 번들러 공증은 `APPLE_ID`/`APPLE_PASSWORD` 또는 ASC API 키를 요구하는데 우리가 가진 것은 notarytool 키체인 프로파일뿐이다. 그래서 공증·스테이플은 `xcrun notarytool --keychain-profile` 경로를 쓴다.
- `createUpdaterArtifacts` 를 켜면 (a) 공증 **이전** tar.gz 가 나와 자동 업데이트한 사람만 티켓 없는 앱을 받고 (b) 빌드 시점에 minisign 개인키를 요구해 키 없는 개발 머신의 빌드가 exit 1 로 죽는다.

즉 서명/공증은 "설정 파일"이 아니라 "환경변수 + 스크립트"에 사는 것이 이 프로젝트의 확정된 형태이고, CI는 그 환경을 러너에서 재현하는 역할만 한다.

## 12. 로컬 실측 (2026-08-07, #1116)

러너 없이 확인 가능한 것을 전부 확인했다.

| 항목 | 결과 |
|---|---|
| `actionlint`(+shellcheck) — 레포 전체 워크플로 | PASS (`rc=0`, 신규 파일 포함) |
| 각 `run` 블록을 `bash -e` 로 국소 재현 | PASS — 전제 확인 · 버전 형식(빈 값/`0.1.0` 거부) · 인자 조립 3조합 · 요약 전부 의도대로 |
| **`build-only`** — 서명 환경변수 없이 `cargo tauri build --bundles app --ci` (콜드 워크트리) | **PASS** — npm ci 2s + vite 1.6s + rust 295 crate **1m09s**, 총 **77초** |
| ↳ 산출물 | `bundle/macos/oort.app` 5.1MB · `CFBundleShortVersionString=0.1.0-next.1` · `CFBundleIdentifier=app.momo.desktop` |
| ↳ 서명 상태 | `Signature=adhoc`(linker-signed) — **인증서 없이도 빌드가 성립한다**. Gatekeeper 는 통과 못 하므로 `build-only` 산출물은 배포용이 아니다 |
| **`dry-run`** — `publish_next_build.sh --version 0.1.0-next.9 --dry-run` | **PASS (`rc=0`)** — 워크플로가 호출하는 그 명령 그대로 |
| ↳ 서명 결과 | `Authority=Developer ID Application: Kwak Seongjae (YWQQFQM38J)` → `Developer ID Certification Authority` → `Apple Root CA` · `TeamIdentifier=YWQQFQM38J` · `flags=0x10000(runtime)`(hardened runtime) · `Runtime Version=26.5.0` |
| ↳ `spctl -a -t exec` | `rejected, source=Unnotarized Developer ID` — 공증만 남았다는 정확한 상태(공증은 `release` 모드 몫) |
| ↳ 키체인 프롬프트 | 터미널 세션에서는 뜨지 않음. 러너 세션에서의 동작은 §6 |
| Developer ID / `momo-notary` / minisign 키 | 전부 존재 (§4) |
| 러너 등록 토큰 발급 | PASS (`gh api … registration-token` → `expires_at` 응답, ADMIN 권한 확인) |
| 등록된 러너 | 0개 — 첫 등록은 §2 절차로 성재가 실행 |

즉 **`release` 모드에서 새로 밟는 미검증 구간은 "공증 제출 → 스테이플 → 배포 저장소 업로드 → 매니페스트 커밋"뿐이고, 그 구간은 2026-07-25 에 로컬에서 4회 발행·2홉 자동 업데이트로 종단 증명된 경로다**(NEXT_CHANNEL.md §7). CI는 그 스크립트를 러너에서 대행 실행할 뿐이다.

러너에서만 확인 가능한 것(미검증, 첫 실행 때 확인): `runs-on: [self-hosted, macOS]` 라벨 매칭 · 러너 세션에서의 키체인 접근 프롬프트 · 배포 저장소 push 자격 · `clean: false` 캐시 보존.
