# 서버/이미지 릴리스 (RELEASING.md)

> **이 문서 하나로 서버 이미지 릴리스를 완주한다.** 범위는 `v0.x` 태그 +
> GitHub Release + GHCR 불변 digest 표 + `releases/latest.json` +
> `docs/SELF_HOST.md` 문면이다.
> 데스크탑 Tauri next 채널은 **다른 절차**다 — [§데스크탑 next 채널과의 경계](#데스크탑-next-채널과의-경계).
> 공개 데스크탑 설치 파일(dmg)은 서버 `v0.x` Release 의 **자산**으로 붙인다 —
> [§데스크탑 dmg 공개 릴리스](#데스크탑-dmg-공개-릴리스). 실공증·실업로드는
> 오케스트레이터다.
>
> 태그 push와 GitHub Release 생성은 오케스트레이터가 집행한다. 이 문서는 그
> 절차의 정본이지, 워커에게 원격 쓰기를 허가하지 않는다.

근거 원장: 핸드오프 패킷
[`docs/planning/handoffs/2026-08-21-launch-hygiene-wave-packet.md`](planning/handoffs/2026-08-21-launch-hygiene-wave-packet.md)
§G1 · GitHub 이슈 #1628. 발행 digest 실값·빌드 커밋·실측은 그 패킷만 인용한다.

---

## 한 줄 순서

**승격 → 프리퍼블리시(`gate:csp-deploy`) → 발행(dispatch · owner 승인) →
digest 수거 → 태그(빌드 커밋에) → Release(digest 표) → 매니페스트 생성·커밋 →
SELF_HOST 문면 확인.**

릴리스는 **main 기준**이다. 태그는 승격 커밋에 앉힌다 — track 브랜치 HEAD가
아니다.

팀 서버의 공동 Hermes(`infra/hermes/lockgate.py`·`config.yaml`·`infra/railway/railway.json`의
hermes `startCommand`)가 이 릴리스에서 바뀌었다면 이미지 발행과 **별개로** [§Hermes 단계](#hermes-단계-팀-서버-공동-hermes)를
같은 배포 안에서 한다. 이미지 digest를 올려도 Hermes 서비스의 설정·게이트는 저절로 바뀌지 않는다.

---

## 1. 승격

발행 workflow는 `refs/heads/main` 만 받는다
(`.github/workflows/publish-images.yml`). 이미지가 가리킬 커밋이 아직
`track/engine` 에만 있으면, 성재 승인 범위의 묶음 승격([`docs/TRACKS.md`](TRACKS.md) §3)으로
`track/engine` → `main` 승격부터 한다. 워커가 main에 직접 push하지
않는다.

첫 공개 발행의 빌드 커밋은 `main=45a154d2` 다 (패킷 §G1).

---

## 1.5 프리퍼블리시 체크리스트 (dispatch 전)

발행을 dispatch 하기 **전에** 배포 CSP 게이트를 통과시킨다. 이 단계는
필수다 — 도구가 없다고 건너뛰고 dispatch 하지 않는다. `gate:csp-deploy` 는
엣지 파일을 `caddy adapt` 로 렌더하므로 **docker 또는 PATH 의 caddy** 가
필요하다 (`MOMO_CADDY_IMAGE`, 기본 `caddy:2-alpine`).

```sh
npm --prefix clients/web run gate:csp-deploy
```

로컬 PR 게이트 `--profile web` 은 같은 명령을 **선택 도구** 로 돌린다:
docker/caddy 가 PATH 에 없으면 눈에 보이는 skip 줄(silent skip 금지,
RED 아님), 있으면 실행하고 실패는 RED. 릴리스 체크리스트는 skip 이 없다.

새 크레이트·빈이 들어간 릴리스면 `scripts/check_dockerfile_crates.sh` 도 통과시킨다 — `server-rust/Dockerfile` 의존성 캐시 COPY 목록이 워크스페이스 멤버와 어긋나면 이미지 빌드만 깨진다(v0.1.27 publish 실패, #3876). PR CI `alignment` 잡이 `scripts/check_ghcr_notice_bundle.sh` 경유로 같은 검사를 매 PR 돈다.

---

## 2. 발행 (dispatch · owner 승인)

수동 `publish-images.yml` 만 쓴다. 자동 `push`/`pull_request`/tag 트리거는
없다.

1. Actions에서 workflow `publish-images` 를 **main** ref로 dispatch 한다.
   또는:

   ```sh
   gh workflow run publish-images.yml --ref main
   ```

2. GitHub `release` Environment 의 owner 승인을 기다린다. 2026-08-12
   attended 설정/readback: required reviewer `kwakseongjae`(user id
   `87296259`), `prevent_self_review=false`, deployment branch policy 는
   custom `main` 하나.

3. 워크플로가 native `linux/amd64`(`ubuntu-24.04`)와 native
   `linux/arm64`(`ubuntu-24.04-arm`) 두 잡에서 앱
   (`ghcr.io/yeomyeonggeori/oort`)과 PostgreSQL 18+pgBackRest
   (`ghcr.io/yeomyeonggeori/oort-postgres`) 을 **아키별 digest** 로
   push·attestation 한 뒤, `buildx imagetools create` 가 두 digest 를
   manifest list 로 묶고 그 list digest 에도 SLSA v1 provenance 를 OCI
   referrer 로 붙인 뒤에만 summary 표를 낸다. 각 잡이 GitHub `release`
   Environment 를 거친다. `sha-<commit>` 태그는 list 에만 붙는 커밋
   locator 이지 불변 신원이 아니다. QEMU 는 쓰지 않는다.

   **첫 multi-arch 발행 실측은 아직 없다.** 아래 §3 표의 v0.1.0 digest 는
   amd64 단일 이다. 운영자 pin 은 다음 발행부터 list digest 다.

---

## 3. digest 수거

run summary 의 「Published release manifest」 표에서 exact digest 를 가져온다.
v0.1.0 은 앱·postgres **두** digest (amd64 단일). 다음 발행부터 운영자 pin 은
manifest list digest 두 행이고, 같은 표에 아키별 digest 가 따라온다.
`sha-*` 태그나 로컬 retag 는 배포 권위가 아니다.

첫 공개 발행 실값 (원장 #1332 코멘트 2026-08-21, 빌드 커밋
`main=45a154d2`):

| 대상 | 불변 이미지 |
|---|---|
| 앱 | `ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36947b4dfd18d6fc91e9229fc5e6f52ebb896b9bf632a2ec127620b8eb` |
| PostgreSQL 18 + pgBackRest | `ghcr.io/yeomyeonggeori/oort-postgres@sha256:c68063695bde97bb2911d5eca4ebce6a94858dc9af9f60ad294657ef7cea0757` |

attestation 검증 PASS (같은 원장). 이후 릴리스는 **그 발행의** summary 표로
이 표를 갈아끼운다. 이 문서의 표는 첫 발행 예시이지 영원히 최신이 아니다.
최신 값은 GitHub Releases 가 정본이다.

검증 (`gh` 가 있는 운영자):

```sh
APP_REF='ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36947b4dfd18d6fc91e9229fc5e6f52ebb896b9bf632a2ec127620b8eb'
POSTGRES_REF='ghcr.io/yeomyeonggeori/oort-postgres@sha256:c68063695bde97bb2911d5eca4ebce6a94858dc9af9f60ad294657ef7cea0757'
gh attestation verify "oci://$APP_REF" \
  --repo yeomyeonggeori/oort \
  --predicate-type https://slsa.dev/provenance/v1
gh attestation verify "oci://$POSTGRES_REF" \
  --repo yeomyeonggeori/oort \
  --predicate-type https://slsa.dev/provenance/v1
```

플랫폼: **다음 발행부터** 워크플로는 `linux/amd64`+`linux/arm64`
manifest list 를 만든다. **현행 v0.1.0 digest(`main=45a154d2`)는 amd64
단일** — Apple Silicon 에서 그 digest 의 native pull 은 불가했다(실측
2026-08-21). 첫 multi-arch digest 실값은 아직 없다. 에뮬레이션 성공을
가정하지 않는다. 다음 발행의 운영자 pin 은 summary 표의 manifest list
digest 행이다.

---

## 4. 태그 (빌드 커밋에)

태그는 **이미지가 구워진 main 커밋**에 앉힌다. 첫 릴리스:

```sh
git tag v0.1.0 45a154d2
git push origin v0.1.0
```

버전 `v0.1.0` 은 데스크탑 `0.1.0-next.N` 과 같은 0.1.0 계열이다
([§경계](#데스크탑-next-채널과의-경계)). 태그 이름에 `next-` 접두를 붙이지
않는다.

[`SECURITY.md`](../SECURITY.md) 의 「최신 발행 `v0.x` 태그 지원」 약속은 이
태그가 원격에 있는 뒤에야 실물을 얻는다.

---

## 5. GitHub Release (digest 표)

```sh
gh release create v0.1.0 \
  --notes-file docs/planning/research/2026-08-21-v0-1-0-release-notes.md
```

Release 본문에는 반드시 **digest 표**(§3과 동형)가 들어간다. v0.1.0 초안이
그 표와 검증 커맨드·amd64 고지를 싣는다. 이후 **첫 multi-arch 릴리스**는
list digest 를 pin 칸에 두고 아키별 digest 를 같은 표에 남긴다. 사람용 변경 이력은
[`CHANGELOG.md`](../CHANGELOG.md) — 다음 태그를 자를 때 `[Unreleased]` 를
새 버전 칸으로 옮긴다.

---

## 6. 릴리스 매니페스트 (`releases/latest.json`)

Release 표의 list digest를 기계가독 JSON으로 옮긴다. 셀프호스트 문면은 이
파일을 읽고, 산문에 digest hex를 다시 적지 않는다.

태그는 이미 원격에 있어야 한다. 생성기는 GitHub Release 본문의 앱·postgres
list pin을 읽고, GHCR에서 그 list의 linux/amd64·linux/arm64 이미지
매니페스트 digest를 조회한다. 추측 금지.

```sh
scripts/release_manifest.sh v0.1.4
git add releases/latest.json
# CHANGELOG 최신 칸이 같은 버전인지 확인한 뒤
scripts/check_release_manifest.sh
git commit -m "chore(release): refresh releases/latest.json for v0.1.4"
```

재실행은 바이트 동일해야 한다. `docs/SELF_HOST*.md`와 `README.md`에
digest 리터럴을 되넣으면 `scripts/check_release_manifest.sh`가 거절한다.

---

## 7. SELF_HOST 문면 확인

[`docs/SELF_HOST.md`](SELF_HOST.md) §2-B 는 매니페스트를 읽는 명령을 유지한다.
digest hex를 산문에 되넣지 않는다. `latest` / `sha-<commit>` 를 넣지 않는다.
`--published-image` 는 앱 이미지만 받는다 — postgres digest 는 Release 표와
운영/PITR 경로용이다.

셀프호스트 생성 명령은 바뀌지 않는다:

```sh
IMAGE_REF="$(jq -r '"\(.images.app.ref)@\(.images.app.digest_list)"' releases/latest.json)"
scripts/self_host_env.sh --published-image "$IMAGE_REF"
```

---

## 데스크탑 next 채널과의 경계

이 문서는 **서버/이미지** 릴리스다. 산출물은 GHCR digest 2본과 `v0.x` 태그,
GitHub Release 다.

데스크탑 Tauri 자동 업데이트는 **다른 채널**이다. 정본
[`docs/NEXT_CHANNEL.md`](NEXT_CHANNEL.md) §8:

| | 이 문서 (서버/이미지) | next 채널 (데스크탑) |
|---|---|---|
| 버전 | `v0.1.0` (`v0.x`) | `0.1.0-next.N` |
| 태그 | `v0.1.0` — **main 의 빌드 커밋** | `next-v0.1.0-next.N` |
| 저장소 | `yeomyeonggeori/oort` | `yeomyeonggeori/momo-alpha` (이 레포가 아님) |
| 발행 | `publish-images.yml` (dispatch · `release` Environment) | `scripts/publish_next_build.sh` |
| 불변 신원 | 이미지 `@sha256:` digest | minisign 서명 매니페스트 + 공증된 `.app.tar.gz` |

`0.1.0-next.N < 0.1.0` 이 semver 로 항상 성립한다. next 채널에 `0.1.0` 을
밀면 오픈 베타 번호를 태워 되돌릴 수 없다(`NEXT_CHANNEL.md` §1). 이 문서의
`v0.1.0` 은 next 매니페스트를 올리지 않고, next 발행은 GHCR digest 를
올리지 않는다. 한 커밋·한 릴리스에 두 절차를 섞지 마라.

공개 dmg 의 번들 버전은 `0.1.0`(태그 `v0.1.0` 과 동일)이고, 파일명은 버전을
넣지 않는다([§데스크탑 dmg 공개 릴리스](#데스크탑-dmg-공개-릴리스)). next
채널 스크립트는 `--public` 없이 `0.1.0` 을 거절한다.

---

## 데스크탑 dmg 공개 릴리스

T-2 플레이북이 사람·그록봇에게 줄 **안정 다운로드 URL** 의 정본. 워커는
`--dry-run` 까지. 실공증·`gh release upload` 는 오케스트레이터/성재.

### 택일 (이 절의 권고)

| 갈래 | 무엇 | 판정 |
|---|---|---|
| **(a) 기존 `v0.1.1` Release 에 dmg 자산 첨부** | 서버 digest 표와 같은 GitHub Release | **채택** |
| (b) 별도 `desktop-v0.1.1` 태그 | 데스크탑만의 Release | 기각 |

**(a) 논거.** GitHub `…/releases/latest/download/<filename>` 은 가장 최근
**비-prerelease** 를 가리킨다. 지금 `latest` = `v0.1.1`(서버 릴리스, dmg
자산 없음). 그 Release 에 고정 파일명으로 붙이면 T-2 링크가 즉시 성립하고,
서버 digest 표가 `/releases/latest` 에서 밀리지 않는다. (b) 를 풀 릴리스로
만들면 그 태그가 latest 가 되어 이미지 digest 안내가 가려진다. prerelease 로
만들면 `/releases/latest` 가 dmg 를 안 준다. next 채널(`0.1.0-next.N` →
`momo-alpha`) 과 저장소가 갈라져 계열도 안 섞인다.

파일명에 버전을 넣지 않는다. latest 패턴이 가리키는 이름은 릴리스마다
같아야 한다.

**안정 URL (T-2 가 이 문자열을 쓴다):**

```
https://github.com/yeomyeonggeori/oort/releases/latest/download/oort-macos-aarch64.dmg
```

태그 고정이 필요하면 같은 자산의
`https://github.com/yeomyeonggeori/oort/releases/download/v0.1.1/oort-macos-aarch64.dmg`.
darwin-x86_64 / Windows 는 이 절의 범위가 아니다.

### 절차 (오케스트레이터)

시크릿 3종(minisign 개인키·Developer ID 개인키·notarytool 프로파일)은 **값으로
출력하거나 채팅/이슈/커밋에 붙이지 말 것.** 존재와 이름만
[`docs/NEXT_CHANNEL.md`](NEXT_CHANNEL.md) §8.1.

`tauri.conf.json` 의 커밋된 버전은 `0.1.0-next.1` 로 둔다. 공개 번호는
`--config` 로만 주입한다. `--public` 은 next 매니페스트/`momo-alpha` 를
건드리지 않는다.

```sh
# 전제: §8.1. 서명 자산은 로컬 키체인. 워커 증명 = 이 한 줄.
scripts/publish_next_build.sh --public --version 0.1.0 --dry-run
```

기대: `bundle/dmg/` 아래에 버전 넣은 tauri dmg + `codesign --verify --strict`
통과, 로그에 `dry run: stopping before notarization`. `spctl` 은 공증 전이므로
`Unnotarized Developer ID` 가 정상. 이 호출은 `0.1.0` 을 next 채널에 올리지
않는다.

**실공증 전제:** `--public`(업로드 없음) 실공증은 [M7-I](cicd/03-store-readiness-gate.md) 증거 빌드(빌드마다 owner 승인, owner 기기 한정)와 M7-I 팀 직접 전달(유효한 M7-I PASS 기록 + 배포 건마다 owner 승인 인용)에 쓴다. 공증 DMG를 공개 게시(`gh release upload`)하는 것은 현재 후보의 M7-S PASS 기록과 owner 승인 뒤에만 한다. 서버 이미지 발행 승인은 공증 권한을 포함하지 않는다. 승인 전에는 위 dry-run/로컬 준비까지만 진행한다.

```sh
# 실공증·스테이플 (맥 앞에서). 업로드는 하지 않는다.
scripts/publish_next_build.sh --public --version 0.1.0
```

산출 안정 파일: `clients/desktop/src-tauri/target/release/bundle/dmg/oort-macos-aarch64.dmg`.
스크립트가 찍는 `gh` 한 줄을 사람이 실행한다:

```sh
gh release upload v0.1.1 \
  clients/desktop/src-tauri/target/release/bundle/dmg/oort-macos-aarch64.dmg \
  --repo yeomyeonggeori/oort
```

`--clobber` 는 같은 이름을 교체할 때만. 태그/Release 자체를 새로 만들지 않는다
(`v0.1.1` Release 는 이미 있다).

확인:

```sh
curl -sI https://github.com/yeomyeonggeori/oort/releases/latest/download/oort-macos-aarch64.dmg \
  | grep -Ei '^(HTTP|content-type|location):'
```

302 가 `releases/download/v0.1.1/oort-macos-aarch64.dmg` 로 끝나면 T-2 링크가
산다.

---

## iOS 새 버전 피드 (폰 앱의 새 버전 배너)

폰 앱의 「새 버전 x.y.z [업데이트]」 배너(홈 맨 위, 프로필 시트의 「내 상태」 위, #3905)는
정적 JSON 한 장을 읽어 **자기 빌드 번호와 견준다.** 서버 필드도 네이티브 코드도 없다.

| | |
|---|---|
| 주소 | `https://yeomyeonggeori.github.io/momo-alpha/ios-latest.json` (데스크탑 `update-next.json` 과 같은 Pages 저장소 `momo-alpha`) |
| 읽는 곳 | `clients/mobile/src/features/appUpdate/feed.ts`(주소·검증·캐시 6시간, 실패 5분, 시간 제한 5초) |
| 모양 | `{"ios": {"latest_build": 3036, "version": "0.1.29", "testflight": true}}` |
| `latest_build` | 올린 빌드의 `CFBundleVersion`(정수). 앱의 `nativeBuildVersion` 과 숫자로 견주고, **더 클 때만** 배너가 선다 |
| `version` | 사람이 읽는 `x.y.z`(영숫자와 `.` `+` `-`, 32자 이하) |
| `testflight` | `true` 면 시트가 「TestFlight 앱에서 업데이트를 눌러 주세요」와 [TestFlight 열기](`itms-beta://`), `false` 면 App Store 링크(`feed.ts` 의 `APP_STORE_URL`, **스토어 등록 전 자리표시**) |

**이 JSON은 증거 빌드 미션이 갱신한다.** TestFlight 업로드가 처리 완료(「Ready to Test」)로 바뀐
**뒤에**, 그리고 그 빌드의 owner 승인(M7-I)이 기록된 **뒤에만** 올린 빌드 번호와 버전을 적어
`momo-alpha` 에 커밋한다. 먼저 올리면 TestFlight 에 아직 없는 판을 배너가 약속한다.
`latest_build` 는 **올라간 빌드의 번호**(App Store Connect·TestFlight 에 보이는 빌드 번호)다.
저장소의 `project.pbxproj` 값(`1`)은 소스 기본값이라 쓰지 않는다. 번호를 부여·덮어쓰는 방식은
이 문서를 쓴 PR 이 확인하지 못했다(runtime-unverified). 미션은 올린 뒤 기기에 깔린 앱의
설정 시트 버전 줄 `oort x.y.z (빌드)` 의 숫자와 같은 값인지 한 번 대조한다.

- 올리지 않으면 아무 일도 없다: 앱은 JSON 을 못 읽거나 같은 빌드면 배너를 그리지 않는다.
- 되돌릴 때는 `latest_build` 를 앱들이 이미 가진 값 이하로 내리거나 파일을 지운다. 배너가 사라진다.
- 시크릿·개인 정보는 이 파일에 쓰지 않는다. 앱은 쿠키·토큰 없이 `GET` 한 번만 한다.
- 외부 TestFlight·App Store 로 넘어갈 때(M7-S)는 `testflight: false` 로 바꾸고 `APP_STORE_URL`
  을 실제 앱 주소로 고쳐 같은 PR 에 싣는다. 그 PR 은 owner 승인 범위다.

---

## Hermes 단계 (팀 서버 공동 Hermes)

팀 서버의 공동 Hermes(서비스 하나, api·agent-worker가 가리킨다)를 새 게이트로 올리는 절차다. 집행은 오케스트레이터이고
owner에게 사전 고지한다(운영 변수는 워커가 건드리지 않는다). **이 절의 어떤 단계도 값을 적지 않는다**: 변수·`.env`·설정의
값은 터미널 공유·이슈·PR·로그에 내지 않고, 이름·길이·sha256으로만 말한다. 근거는 [ADR-0203 증보 2026-11-01](adr/0203-cohosted-agent-detection.md)
(#4950 허용 목록, #4935 설정 해시 목록·엄격 모드)다.

**함께 바뀌는 것.** 게이트(`HERMES_LOCKGATE_B64`), 설정(`HERMES_CONFIG_B64`), 시작 명령의 체크섬, `HERMES_MEDIA_DELIVERY_STRICT=1`은
**한 번에** 바꾼다. 새 게이트는 엄격 값이 없으면, 새 시작 명령은 자기 목록에 없는 설정이면 Hermes를 띄우지 않으므로 하나만 바꾸면 서비스가 멈춘다.

1. **바꾸기 전 값 저장.** 서비스의 변수 전체와 시작 명령을 **값 그대로** 비공개 기록(planner 비공개 기록·시크릿 금고)에 저장한다. 저장소·이슈·PR에는
   두지 않는다. 저장이 됐는지는 변수 **이름 목록과 각 값의 길이·sha256**으로만 확인한다. 이 저장본이 6단계의 되돌리기 재료다.
2. **설정을 해시로 대조한다(값 미출력).** 운영 `HERMES_CONFIG_B64`를 디코드한 바이트의 sha256만 계산하고(`base64 -d | shasum -a 256`, 내용은 화면에 내지 않는다)
   저장소가 같은 입력으로 다시 만드는 해시와 비교한다. 연결 모드 서비스는 운영이 쓰는 모델 선택으로
   `python3 infra/hermes/render_model_config.py --auth <방식> [--fallback <방식>] --connector-base infra/hermes/google-connectors.config.yaml --sha256`
   (전체 목록은 `--catalog`의 `connector/…` 줄)을 돌린다. 같으면 설정 변수는 그대로 둔다. 다르면 같은 명령의 **출력**으로 `HERMES_CONFIG_B64`를 만든다
   (`… --connector-base … | base64 | tr -d '\n'`). 운영의 모델 선택이 카탈로그 네 가지 밖이면 멈춘다: 카탈로그에 더하는 결정(ADR 증보)이 먼저다.
3. **볼륨 `.env`의 이름만 읽는다.** 새 게이트는 볼륨 `.env`에 허용 목록 밖의 이름이 있거나 `.op.env`가 있으면 Hermes를 띄우지 않는다. 서비스에 들어가
   `/opt/data/.env`의 **이름만** 읽고(`sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/\2/p' /opt/data/.env | sort -u`,
   값은 나오지 않는다), `/opt/data/.op.env`가 있는지 본다. 허용 이름은 `lockgate.py`의 `VOLUME_ENV_SECRETS`·`VOLUME_ENV_SEEDED`다(씨앗 줄은 값이 Hermes가
   쓴 그대로여야 한다). 그 밖의 이름은 운영자가 지우고(지운 **이름**만 기록), 지우기 전에는 4단계로 가지 않는다.
4. **한 번에 바꾼다.** ① `HERMES_MEDIA_DELIVERY_STRICT=1`을 더한다(이미 있으면 정확히 `1`인지 본다). ② `HERMES_LOCKGATE_B64`를 `base64 < infra/hermes/lockgate.py | tr -d '\n'`로,
   시작 명령을 저장소 `infra/railway/railway.json`의 hermes `startCommand`와 같게 바꾸고(설정 해시 목록과 게이트 체크섬이 함께 들어 있다), 필요하면 2단계의
   `HERMES_CONFIG_B64`도 같은 배포에서 바꾼다. 연결 모드 서비스가 이미 가진 `OORT_COHOSTED_AGENT_CONNECTOR_APPS`·`GOOGLE_OAUTH_CLIENT_ID`·`GOOGLE_OAUTH_CLIENT_SECRET`은
   건드리지 않는다. 배포는 한 번이다.
5. **기동 로그를 확인한다.** 배포 로그의 `LOCKGATE` 줄이 `"ok": true`, `config_accepted_as`가 대상에 맞는 이름(`default` 또는 `connector/…`), `"media_strict": true`이고,
   연결 모드에서는 `selected_tools`에 `web_search`·`image_generate`가 없다. 이어서 `LOCKREPORT` 줄이 `"ok": true`이고 서비스가 healthy이고 oort의 AI 연결 카드가
   정상이다. `LOCKGATE`가 `"ok": false`이거나 서비스가 멈추면 `problems`(이름·해시만 나온다)를 이슈에 적고 6단계로 간다.
6. **되돌린다.** 1단계에서 저장한 값으로 변수와 시작 명령을 되돌려 다시 배포한다(옛 게이트가 옛 설정을 받아들인다). 볼륨의 데이터·로그인(`auth.json`)은 그대로다.
   되돌린 뒤 5단계의 `problems`에 맞춰 원인(보통 3단계에서 놓친 `.env` 이름)을 고치고 다시 4단계부터 간다.

이 단계에 들어 있지 않은 것: 그림 도구를 어느 Hermes가 갖는지의 결정과 `OORT_SELF_MEDIA_ORIGIN`·`OORT_HOSTED_MEDIA_STRICT`(ADR-0218 증보와
[리허설 런북](runbooks/hermes-photo-expression-rehearsal.md))는 이 단계의 다음 일이다. 연결 모드 Hermes에는 그림 도구가 없다(ADR-0203 I3).

---

## 이 문서가 하지 않는 것

- 태그/Release 의 원격 쓰기 — 오케스트레이터. 워커는 초안과 문면만.
- 팀 서버 Hermes 서비스의 실제 변수·시작 명령 변경 — 오케스트레이터가 owner 사전 고지 뒤에 집행한다([§Hermes 단계](#hermes-단계-팀-서버-공동-hermes)).
- 실발행 dispatch — owner 가 `release` Environment 에서 승인한다. 워크플로
  계약은 multi-arch 이지만 첫 arm64 digest 실측은 아직 없다.
  공개 dmg 업로드도 같다(`gh release upload` 는 사람이 실행).
- next 채널 실발행 — [`docs/NEXT_CHANNEL.md`](NEXT_CHANNEL.md) §8.
- `linux/arm64` 재발행.
- darwin-x86_64 / Windows 데스크탑 패키지.
- 장기 버전 정책(semver 이후 자리).
- 운영 호스트 배포 — [`docs/SELF_HOST.md`](SELF_HOST.md).
- 셀프호스트 첫 로그인 — [`docs/SELF_HOST.md`](SELF_HOST.md).
