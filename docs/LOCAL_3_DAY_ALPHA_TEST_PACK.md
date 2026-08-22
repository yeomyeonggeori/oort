# ITO 내부 테스트 팩 (3-Day / LAUNCH_READY)

> 목적: 웹+데스크탑 셀프호스트 기준으로 내부 테스트 운영(ITO-1~4)을
> 이 문서만으로 실행하고, 증거로 `LAUNCH_READY` / `BLOCKED` /
> `NEEDS_MORE_INTERNAL`을 판정한다.
>
> 정본 시나리오: [`docs/planning/research/2026-08-20-oss-launch-readiness-and-internal-test-plan.md`](planning/research/2026-08-20-oss-launch-readiness-and-internal-test-plan.md) §4–§5.
> 호스팅 절차: [`docs/SELF_HOST.md`](SELF_HOST.md) (clone→브라우저 로그인). 데스크탑 셸: [`clients/desktop/README.md`](../clients/desktop/README.md).
> 스모크 A–F: [`docs/INTERNAL_ALPHA.md`](INTERNAL_ALPHA.md). 인테이크: [`docs/INTERNAL_ALPHA_FEEDBACK.md`](INTERNAL_ALPHA_FEEDBACK.md).
>
> 범위: 내부 리허설만. 이 팩은 GHCR 첫 발행·공개 DNS/TLS/SOPS/PITR·앱스토어/M7을
> 증명하지 않는다. AWS 호스트 토폴로지는 [`docs/AWS_INTERNAL_ALPHA.md`](AWS_INTERNAL_ALPHA.md)이며
> **ITO 판정값이 아니다.**

런칭 정의(이 팩이 리허설하는 것):

> **외부 셀프호스터 3명 이상 + 에이전트 멘션·런 실사용**이 런칭. 레포 공개는 시작이지 런칭이 아님.
> — `docs/planning/2026-08-10-public-release-directive.md:11`

---

## 0. 판정 계약

| 판정 | 의미 | 다음 행동 |
|---|---|---|
| `LAUNCH_READY` | 이 팩의 필수 행이 PASS이고 열린 P0/P1이 없다. 내부 리허설이 외부 셀프호스터 모집을 막을 결함을 남기지 않았다. | L 시리즈 잔여(태그·GHCR 발행·커뮤니티 문서)를 마감한 뒤 외부 셀프호스터를 모집한다. ITO 정본 §4 ITO-4. |
| `BLOCKED` | 이름 붙은 외부 의존이 유효한 실행을 막는다. 예: Docker Desktop, provider 실키(O3 ANSWERED를 이 회전의 필수로 둔 경우), T-A 미결로 I1을 판정할 수 없음, 로컬 게이트 파손. | 블로커 이슈를 남기고 런칭 모집을 열지 않는다. |
| `NEEDS_MORE_INTERNAL` | 실행은 배웠으나 제품/UX/신뢰 증거가 런칭 리허설로 부족하다. | 발견을 P0/P1/P2 골로 바꿔 고친 뒤, 빠진 날 또는 시나리오만 반복한다. |

«괜찮았다»는 판정이 아니다. 모든 판정은 커밋, 로컬 게이트 증거, diagnostics bundle, 열린 이슈 목록, `bench_onboarding.sh` M1–M5 상태(§0.2)를 이름 붙여야 한다.

구 계약 `AWS_READY` / `NEEDS_MORE_LOCAL`은 **쓰지 않는다.** 역사 기록은 git에 있다.

### 0.1 ITO-1~4를 이 팩에 묶는 법

| 페이즈 | 시나리오 | 이 팩의 자리 | 성공 판정 (ITO 정본 §4) |
|---|---|---|---|
| ITO-1 | H1 깨끗한 환경 첫 설치(로컬 빌드) | Day 0 | M1–M3 측정 · 문서 밖 임기응변 0 · 브라우저 로그인 도달 |
| ITO-1 | H2 digest pull | Day 0 (조건부) | 첫 발행·익명 pull·attestation PASS(원장 #1332 코멘트 2026-08-21). amd64 부팅 실측은 잔여(Apple Silicon native pull 불가만 실측). 구 `SKIP(L2 unpublished)`는 해당 없음 |
| ITO-1 | H3 도메인+TLS 1회 | Day 0 (조건부) | 외부 브라우저 HTTPS 로그인. 이 회전이 루프백만이면 `SKIP(public host)` |
| ITO-2 | O1 오퍼레이터 부트스트랩 | Day 1 | `PLATFORM_ADMIN_EMAILS` + `PROVIDER_LINK_MASTER_KEY` 배선 → 설정 표면 도달 |
| ITO-2 | O2 워크스페이스·초대·둘째 사용자 | Day 1 | 웹 GUI 초대 + 조인 링크(웹) + `oort://join`(데스크탑) |
| ITO-2 | O3 AI 연결 → 멘션 | Day 2 | M5=`ANSWERED`가 목표. 키 없으면 `NOTICE`가 정직한 값이다(`scripts/bench_onboarding.sh:31-41`) |
| ITO-2 | O4 외부 에이전트 1종 | Day 2 | #1361 Grok E2E. 성재 1단계 대가면 `SKIP(#1361)` |
| ITO-3 | I1–I8 웹↔데스크탑 3일 도그푸드 | Day 1–3 | §4–§6 표 |
| ITO-4 | 판정·환류 | Day 3 | 이 절의 `LAUNCH_READY` / `BLOCKED` / `NEEDS_MORE_INTERNAL` |

스모크 절차(한 사람, 한 세션)는 [`INTERNAL_ALPHA.md`](INTERNAL_ALPHA.md) A–F. 3일 증거의 레이아웃·심각도·최종 보고서는 이 팩이 정본이다.

### 0.2 측정 기준선 (실측만)

시간을 새로 만들지 않는다. 인용하는 숫자만 쓴다.

| 값 | 좌표 | 무엇을 말하나 |
|---|---|---|
| M1 첫 화면 **1:20.2**(첫 실행, docker 빈 상태) · **1:02.2**(콜드 빌드, 캐시 0) | `docs/planning/research/2026-08-18-onboarding-first-success-benchmark.md` §2 표, 머신 Apple Silicon 18코어 · Compose v5.3.1 · `feat/1526-dsh-b-onboarding-n@5e598773` | `scripts/self_host_env.sh` 시작 → 엣지가 index.html을 줌. 캐시 열이 서로 다른 질문이다. |
| M2 첫 로그인 1:20.2 / M3 첫 메시지 1:20.5 (같은 첫 실행 열) | 같은 표 | 로그인·메시지 구간 자체는 1초 미만(P3 0.036s · P5 0.181s). 벽시계의 대부분은 이미지 준비. |
| M5 `NOTICE` **3:58** (재시도 소진 포함) | 파도 7 `#1534` · `docs/planning/DEVIATION_LOG.md` 2026-08-18 행 · ITO 정본 §3·§6 | 키 없는 기본 측정. `ANSWERED`가 아니다. |
| M5 `ANSWERED` | 없음 | ITO-2 O3의 **신규 데이터**. 자격증명 없이 ANSWERED를 만드는 방법은 없다(`scripts/bench_onboarding.sh:37-40`: `MOMO_ENV=staging`에서 provider baseUrl은 외부 https만). |
| 데스크탑 릴리스 콜드스타트 **537 ms** · 유휴 ~196 MB | `clients/desktop/README.md` Measured 2026-07-25 (MOMO-595) | 셸 기동. 셀프호스트 로그인 왕복이 아니다. |
| 데스크탑 릴리스 → 셀프호스트 **로그인** | `clients/desktop/README.md` Known gaps: 릴리스 앱 origin은 `tauri://localhost`. CORS allowlist는 main에 랜딩(#768)했으나 이 README가 가리키는 발행분 `0.1.0-next.*`는 로그인 불가였고, **이후 실기동 재확인은 T-A(#1607) 몫** | I1을 T-A 증거 없이 PASS로 쓰지 마라. |

매 회전 `scripts/bench_onboarding.sh run`으로 M1–M5를 수거한다. 증거는 레포 밖(`scripts/bench_onboarding.sh` 헤더: `${TMPDIR:-/tmp}/oort-onboarding-bench/<UTC>/`).

---

## 1. 시작 전 입력

Day 0을 열기 전에:

- 깨끗한 클론 또는 dedicated worktree. 루트 dirty checkout에서 돌리지 않는다.
- Docker Engine + Compose v2 (`docs/SELF_HOST.md` 전제).
- 증거 디렉터리(레포 밖). ITO 정본 §6:

```bash
export MOMO_ITO_EVIDENCE_DIR="${HOME}/claudedocs/ito-$(date +%Y%m%d)"
mkdir -p "$MOMO_ITO_EVIDENCE_DIR"
```

`claudedocs/`는 로컬만. 레포에 커밋하지 않는다. 보고서 요약만 이슈/PR에 붙인다.

- `scripts/local_gate.sh --profile docs` PASS(이 팩·런북을 고친 커밋).
- 웹 표면 증거가 필요하면 `scripts/local_gate.sh --profile web`.
- 은퇴 프로파일 `macos-ui`·삭제된 `scripts/macos_dev_run.sh`·`clients/macOS` 트리를 **실행하지 않는다.** 분류는 §12. <!-- docs-cmd-ignore: 은퇴 스택 이름 호명 (#1609) -->
- 셀프호스트 시크릿은 `scripts/self_host_env.sh`가 만든다. `demo@momo.local` / `dev-password`는 이 경로의 계정이 아니다 — 같은 실측 A7이 셀프호스트에서 그 쌍을 **401**로 기록했다(온보딩 벤치마크 §3 A7).
- 로그인 좌표(`docs/SELF_HOST.md:115-120,157-164`): 기본 `http://localhost:8088`, 이메일 `owner@oort.local`, 비밀번호 `infra/rust/local.secrets.env`의 `MOMO_INITIAL_OWNER_PASSWORD`.

---

## 2. 표면과 런타임

| 표면 | 무엇이 증명되나 | 무엇이 증명되지 않나 |
|---|---|---|
| 웹 (셀프호스트 엣지) | same-origin. 브라우저 `http://localhost:<MOMO_WEB_PORT>` — SPA·`/v1`·Centrifugo가 한 오리진(`docs/SELF_HOST.md:241-257`). CORS가 성립할 여지가 없다. | 데스크탑 릴리스 origin(`tauri://localhost`) |
| 데스크탑 (Tauri 2) | `clients/web` 번들을 감싼 셸. 딥링크 `oort://join`, mDNS, 키체인, 알림, next 채널 업데이터(`clients/desktop/README.md`). 개발은 `cargo tauri dev`, 증거의 본체는 **릴리스 번들** `cargo tauri build --bundles app`(`:353-370`). | `cargo tauri dev` 성공은 릴리스 로그인 증거가 아니다(dev proxy가 있다). |
| iOS | I8: `npm --prefix clients/mobile run lane:phone` + 시뮬레이터 수동 로그인 1회 | 실기기·APNs·external TestFlight(`docs/IOS_TESTFLIGHT_RUNBOOK.md` — M7 PASS 전 금지) |

에이전트는 `member.kind='agent'`. 쓰기는 REST → Postgres 트랜잭션 → outbox → relay. 클라가 Centrifugo에 직접 publish하지 않는다. oort는 provider OAuth 토큰·원문 API 키를 DB·diagnostics·게이트 증거·앱 로그에 담지 않는다.

Mock provider는 메신저 도그푸드용. `LAUNCH_READY`에서 «에이전트 실사용»을 주장하려면 O3가 `ANSWERED`이거나, `NOTICE`만으로 끝낸 이유를 명시하고 `NEEDS_MORE_INTERNAL`을 검토한다.

---

## 3. Day 0 — ITO-1 호스팅

72시간 시계를 열지 마라. 필수 행이 PASS이거나 이름 붙은 SKIP/블로커로 기록될 때까지.

| 검사 | 명령 또는 증거 | PASS |
|---|---|---|
| Worktree | `git status --short --branch` | 깨끗한 알파 워크트리, 커밋 기록 |
| H1 로컬 빌드 | `docs/SELF_HOST.md` 1–4장을 **그대로**. `scripts/self_host_env.sh --local-build` 그리고 스크립트가 인쇄한 `scripts/self_host_env.sh --compose up -d --build --wait` | 브라우저 로그인 + 채널 목록(`agent-lab` · `general`, 목록에는 `#` 없음 — `SELF_HOST.md:173-175`) + 메시지 1건. 문서 밖 임기응변 0 |
| H1 측정 | `scripts/bench_onboarding.sh run` (또는 `plan` 후 `run`) | M1–M3 기록. 기준선은 §0.2. 새 시간을 지어내지 말 것 |
| H2 digest pull | `SELF_HOST.md` §2 B. `IMAGE_REF='ghcr.io/yeomyeonggeori/oort@sha256:…'` | 첫 발행·익명 pull·attestation PASS(원장 #1332 코멘트 2026-08-21, 패키지 public, amd64 단일). **amd64 부팅 실측은 잔여** — Apple Silicon native pull 불가만 실측(2026-08-21). 구 `SELF_HOST.md:88` `runtime-unverified`·`SKIP(L2 unpublished)` 문면은 해당 없음. 이 잔여만으로 팩 전체를 `BLOCKED`로 만들지 않는다 |
| H3 도메인+TLS | `SELF_HOST.md` §운영 + `docs/runbooks/ncp-rust-deploy.md` | 이 회전이 루프백이면 **`SKIP(public host)`**. `caddy.override.yml`을 노트북에서 이름 부르지 마라(`SELF_HOST.md:332-337`) |
| Docs gate | `scripts/local_gate.sh --profile docs` | PASS 증거 경로 |
| 이슈판 | `scripts/goal_status.sh --repo yeomyeonggeori/oort` | 이 실행을 막는 열린 P0/P1 없음 |
| 증거 루트 | `$MOMO_ITO_EVIDENCE_DIR` | Day 0 노트 존재 |

Day 0 출력:

```md
## Day 0 / ITO-1 Hosting
- Commit:
- Worktree:
- H1 (SELF_HOST 1–4, 임기응변 횟수):
- bench_onboarding M1/M2/M3 (값 + 증거 경로):
- H2: PASS / 잔여(amd64 부팅 미실측) / FAIL
- H3: PASS / SKIP(public host) / FAIL
- Docs gate:
- Open P0/P1:
- Decision to start ITO-2: START / BLOCKED / NEEDS_FIX
- Notes:
```

---

## 4. Day 1 — ITO-2 온보딩(O1–O2) + I1 시작

한 사람 메신저 + 둘째 사용자 합류. 데스크탑 동시 로그인은 T-A 증거에 묶인다.

| 시나리오 | PASS | 증거 |
|---|---|---|
| O1 부트스트랩 | 설정 › AI 연결이 403이 아니다. `PLATFORM_ADMIN_EMAILS`·`PROVIDER_LINK_MASTER_KEY`는 생성 env에 있다(`docs/SELF_HOST.md` §5). 403이면 같은 절의 복구(그 줄만 덧붙인 뒤 `oort up -d`). 503이면 master key 누락 | 화면 또는 `GET /v1/provider/link` (키 원문 없이) |
| 웹 로그인 | `owner@oort.local` + `MOMO_INITIAL_OWNER_PASSWORD`. 서버 주소 칸은 **비운다**(`SELF_HOST.md:162`) | 스크린샷 또는 앱/네트워크 로그 |
| 채널 로드 | `general` · `agent-lab` 히스토리 로드 | 스크린샷 또는 API JSON |
| 메시지 | 두 채널에 사람 메시지, `message.seq` 증가. 실시간은 outbox가 `broadcast\|done`인지로 서버측을 본다(`SELF_HOST.md:299-307`) | 트랜스크립트 / 스크린샷 / REST |
| O2 웹 GUI 초대 | 설정 › **멤버와 초대** → **초대 링크 만들기** (`clients/web/src/features/settings/InviteSection.tsx`, `SettingsRoute.tsx` `id: "members"`). 원문 코드는 발급 화면에 한 번만 보인다. T-B(#1608)가 첫 하루 런북을 따로 쓴다 — 이 팩은 그 표면이 **실재한다**는 것까지 책임진다 | 코드 마스킹한 응답 + 둘째 로그인 |
| O2 둘째 사용자 (웹) | 조인 링크로 합류, 공개 채널이 보인다, 공개 초대로 owner/platform admin이 되지 않는다 | 둘째 세션 증거 |
| O2 셋째 또는 같은 둘째 (데스크탑 딥링크) | `oort://join?server=<percent-encoded base>&code=<code>` (`docs/onboarding-deeplink.md`). **릴리스 번들**에 `open -a <app> "oort://join?…"` (`clients/desktop/README.md:361-370`). `cargo tauri dev`는 스킴을 못 받는다 | 착지한 방/서버 프리필 |
| I1 동일 계정 웹+데스크탑 | 메시지 실시간 양방향 · `message.seq` · unread 배지 수렴 · 프레즌스 | **T-A(#1607) 실기동 증거가 있을 때만 PASS.** 없으면 `BLOCKED` 또는 이 행 `FAIL(T-A)` — Known gaps를 낙관으로 덮지 말 것 |
| 재시작 | 웹 새로고침, 데스크탑 재실행, `oort up -d --wait` 한 번. 메시지 유실 없음 | 노트 + 로그 |
| 피드백 | 막힌 것이 없어도 1건 | GitHub 이슈/코멘트 또는 로컬 md (`INTERNAL_ALPHA_FEEDBACK.md`) |

Day 1 출력:

```md
## Day 1 / ITO-2 O1–O2 + I1
- Active time:
- O1 settings surface:
- Messages sent (web / desktop):
- Invites created / joined (web join link / oort://join):
- I1 web+desktop: PASS / FAIL(T-A) / SKIP
- Restarts:
- Bugs/feedback:
- P0/P1/P2/P3 summary:
- Notes:
```

---

## 5. Day 2 — ITO-2 에이전트(O3–O4) + ITO-3 I2–I4

| 시나리오 | PASS | 증거 |
|---|---|---|
| 에이전트 존재 | 기대한 채널에 `member.kind='agent'` | 화면 또는 members JSON |
| O3 키 주입 | 설정 › AI 연결에 **외부 https** 엔드포인트+키(`SELF_HOST.md` §5). 루프백 로컬 모델은 오늘 400 (`bench_onboarding.sh:38-41`) | 끝 네 자리만. 원문 키 금지 |
| O3 멘션 | `@핸들` → 채널에 에이전트가 쓴 메시지. 판정은 `ANSWERED` / `NOTICE` / `BLOCKED`를 **한 칸에 섞지 않는다** | `bench_onboarding.sh` M5 또는 타임라인 스크린샷 |
| O4 외부 에이전트 1종 | #1361 Grok E2E 절차 | 성재 1단계 대가면 `SKIP(#1361)` |
| I2 교차 패리티 | 스레드 · 멘션 자동완성 · 승인 카드 · 완료 리포트 카드 · 인용 — 웹과 데스크탑이 같은 동작 | 두 표면 스크린샷. I1이 FAIL이면 이 행도 웹-only로 명시 |
| I3 딥링크 착지 | `oort://join` · 채널 링크가 데스크탑을 열고 정확한 방에 착지. 웹 로그인 핸드오프 카드(LIVE-4)가 있으면 그 경로도 | `open -a` 증거. LaunchServices는 핸들러를 하나만 고른다(`clients/desktop/README.md:25-28,427-428`) |
| I4 에이전트 세션 관전+개입 | 웹·데스크탑 양쪽 VM 실화면 관전, 한쪽 control 개입 시 다른 쪽 observation 정합 | LIVE 스택이 이 회전에 없으면 `SKIP(LIVE host)` — 발명하지 말 것 |
| 재연결 | Centrifugo 또는 앱 재시작 후 타임라인 `message.seq` 정합 (I7 예행) | 화면/로그 |
| Diagnostics | 의도적 실패 후 번들 | `scripts/collect_diagnostics.sh --output-dir … --since 15m` |

Day 2 출력:

```md
## Day 2 / ITO-2 O3–O4 + I2–I4
- Agent member tested:
- O3 M5: ANSWERED / NOTICE / BLOCKED (값 + 경로):
- O4: PASS / SKIP(#1361) / FAIL
- I2 parity:
- I3 deeplink:
- I4 LIVE: PASS / SKIP(LIVE host) / FAIL
- Reconnect:
- Diagnostics bundle:
- Bugs/feedback:
- Notes:
```

---

## 6. Day 3 — ITO-3 잔여(I5–I8) + soak + ITO-4

| 시나리오 | PASS | 증거 |
|---|---|---|
| I5 데스크탑 자동업데이트 1왕복 | next 채널 재발행분 수신 → 자가 업데이트 → 재로그인 불요 | 현행 채널 정본 [`docs/NEXT_CHANNEL.md`](NEXT_CHANNEL.md) · 발행 `scripts/publish_next_build.sh`. T-D(#1281) 준비 전제는 **실발행이 성재 맥**. 미발행이면 `SKIP(T-D/#1281)`. Swift/Sparkle 런북 [`MACOS_ALPHA_UPDATE_CHANNEL.md`](MACOS_ALPHA_UPDATE_CHANNEL.md)는 은퇴 — 실행하지 말 것 |
| I6 네이티브 알림 | 수신 확인. **클릭 라우팅은 known gap**(fire-and-forget) — `clients/desktop/README.md` Notification 절·Known gaps. 기대를 여기에 명시했으므로 결함으로 **중복 접수하지 않는다** | 배너가 보인 증거. 클릭 착지는 FAIL이 아님 |
| I7 재연결 내성 | 네트워크 단절→복구 시 두 표면 타임라인 정합(outbox→relay 재구독) | 화면 + outbox 질의 |
| I8 iOS 시뮬레이터 (보조) | `npm --prefix clients/mobile run lane:phone` 그린 + 수동 로그인·타임라인 1회 | 실기기/APNs는 스코프 밖 |
| Soak | 마지막 날 스택이 쓰이고 P0/P1 없음 | `docker stats` 스냅샷 또는 수동 노트. 72h 무인 soak 수치는 이 팩이 실측하지 않았다 — 발명하지 말 것 |
| Triage | 모든 피드백이 P0–P3 | 이슈 목록 또는 로컬 표 |
| 최종 판정 | `LAUNCH_READY` / `BLOCKED` / `NEEDS_MORE_INTERNAL` | §10 보고서 |

`LAUNCH_READY` 필수 행: H1, O1, O2, O3(`ANSWERED` 또는 명시한 `NOTICE`), I1(T-A 증거 위), I2, I3, I6(수신), I7, 열린 P0/P1 = 0, Day 0–3 증거. H2/H3/O4/I4/I5/I8의 SKIP은 이름과 후속 이슈가 있으면 필수 행을 막지 않는다. I1이 T-A 없이 비면 `BLOCKED` 또는 `NEEDS_MORE_INTERNAL`이지 `LAUNCH_READY`가 아니다. O3가 `BLOCKED`(에이전트 메시지 0)이면 `LAUNCH_READY`가 아니다.

Day 3 출력:

```md
## Day 3 / ITO-3 remainder + ITO-4
- Total active time:
- Local stack uptime:
- I5 updater: PASS / SKIP(T-D/#1281) / FAIL
- I6 notification receive (click = known gap):
- I7 reconnect:
- I8 lane:phone: PASS / SKIP / FAIL
- Resource notes (no invented 72h numbers):
- Final diagnostics:
- Open P0 / P1 / P2/P3:
- Final decision: LAUNCH_READY / BLOCKED / NEEDS_MORE_INTERNAL
- Rationale:
- Follow-up issues:
```

---

## 7. 버그 심각도

정본 트리아지: [`docs/INTERNAL_ALPHA_FEEDBACK.md`](INTERNAL_ALPHA_FEEDBACK.md). 이 3일 실행에서:

| 심각도 | `LAUNCH_READY`를 막나 | 예 |
|---|---|---|
| P0 | 예 | 데이터 손실, 테넌트 누출, 시크릿 노출, 모든 테스터에게 웹 또는 데스크탑 로그인 불가 |
| P1 | 예 | 전송/수신, 초대/합류, 에이전트 런타임, 실시간, diagnostics, 이 팩의 로컬 게이트를 정상 테스터가 끝내지 못함 |
| P2 | 자동은 아님 | 우회 가능한 마찰, 빠진 카피, 문서화되지 않은 임기응변 1회 |
| P3 | 아니오 | 폴리시, 문구, 작은 레이아웃 |

P0/P1은 최종 판정 전에 빌드 가능한 이슈가 되어야 한다. P2/P3는 후속 이슈·owner·우회 또는 비차단 노트가 있을 때만 열린 채로 둘 수 있다. 문서 밖 임기응변 1회 = 결함 1건(ITO 정본 §3.1, #1229 방법론).

---

## 8. 시작 · 정지 · 복구

정본 시작은 Swift runner가 아니라 셀프호스트다.

```bash
scripts/self_host_env.sh --local-build
# 스크립트가 인쇄한 한 줄을 그대로:
scripts/self_host_env.sh --compose up -d --build --wait
```

```bash
oort() { scripts/self_host_env.sh --compose "$@"; }
oort down          # 데이터 유지
oort down -v       # 볼륨 삭제 — 되돌릴 수 없음
```

다시 처음부터: `oort down -v` + `rm infra/rust/local.secrets.env` + `--local-build`부터 (`SELF_HOST.md:284-285`).

데스크탑 릴리스 번들(서명·공증 불요, 로컬 app):

```bash
cd clients/desktop
cargo tauri build --bundles app
# 산출 경로·앱 이름은 clients/desktop/README.md Run 절을 따른다.
```

웹 개발 서버(`npm --prefix clients/web run dev`)는 ITO-1 H1 증거가 아니다. H1은 이미지 안 번들 + Caddy 엣지다.

복구 드릴:

1. 가능하면 재시작 전에 diagnostics.
2. 실패한 컴포넌트만 재시작(`oort logs api` / `relay` / `agent-worker`).
3. `general`에 사람 메시지 1.
4. 에이전트가 있는 채널에 `@핸들` 1.
5. `message.seq`와 degraded/available.
6. 일일 보고서에 기록.

`scripts/local_alpha_runner.sh`는 호스트 Swift 서비스를 띄우는 MOMO-240 러너다. ITO 실행 지시가 아니다.

---

## 9. 증거 레이아웃

```text
~/claudedocs/ito-YYYYMMDD/          # 로컬, 커밋 금지 (ITO 정본 §6)
  day0-hosting.md
  day1-onboarding.md
  day2-agent.md
  day3-decision.md
  bench-onboarding/                 # 또는 /tmp/oort-onboarding-bench/<UTC>/ 경로 링크
  local-gates/
  diagnostics/
  screenshots/
  resource-snapshots/
  final-report.md
```

ITO 산출 증거는 로컬에 두고 보고서만 레포/이슈로 올린다.

---

## 10. ITO-4 최종 보고서 템플릿

```md
## ITO 3-Day Final Report

### Summary
- Commit:
- Worktree:
- Start:
- End:
- Final decision: LAUNCH_READY / BLOCKED / NEEDS_MORE_INTERNAL

### ITO-1 Hosting
- H1:
- H2:
- H3:
- bench_onboarding M1–M3 (값 + 경로):

### ITO-2 Onboarding
- O1:
- O2 web join / oort://join:
- O3 M5 ANSWERED / NOTICE / BLOCKED:
- O4:

### ITO-3 Dogfood
- I1 (T-A evidence 좌표):
- I2:
- I3:
- I4:
- I5:
- I6 (click = known gap, not a fail):
- I7:
- I8:

### Required Evidence
- Day 0–3 reports:
- Docs gate:
- Web gate (해당되면):
- Diagnostics bundle:
- Resource notes:

### Feedback Triage
| Severity | Count | Open | Links |
|---|---:|---:|---|
| P0 | | | |
| P1 | | | |
| P2 | | | |
| P3 | | | |

### Decision Rationale
- Why this is or is not ready to recruit external self-hosters:
- Largest remaining risk:
- Follow-up issues:

### Operator Notes
- Commands that worked:
- Commands that failed:
- Improvisations outside SELF_HOST.md (each is a defect):
- Recovery drills:
- Secret redaction confirmed: yes/no
```

---

## 11. 시나리오 색인 (팩만으로 실행)

| ID | 하는 일 | 바로 가는 곳 |
|---|---|---|
| H1 | 로컬 빌드 첫 설치 | `docs/SELF_HOST.md` 1–4 · Day 0 |
| H2 | digest pull | `SELF_HOST.md` §2 B · 첫 발행 완료(원장 #1332). amd64 부팅 실측은 잔여 |
| H3 | 도메인+TLS | `SELF_HOST.md` §운영 · `docs/runbooks/ncp-rust-deploy.md` |
| O1 | 키 둘 | `SELF_HOST.md` §5 · Day 1 |
| O2 | GUI 초대 + 합류 | 설정 › 멤버와 초대 · `docs/onboarding-deeplink.md` · Day 1. 통합 첫 하루 런북은 T-B(#1608) |
| O3 | 멘션 응답 | `SELF_HOST.md` §5 · `scripts/bench_onboarding.sh` M5 · Day 2 |
| O4 | Grok E2E | #1361 · Day 2 |
| I1–I8 | 웹↔데스크탑 | Day 1–3 + [`INTERNAL_ALPHA.md`](INTERNAL_ALPHA.md) A–F |
| 판정 | LAUNCH_READY 등 | §0 · §10 |
| 인테이크 | 발견 전량 티켓 | [`INTERNAL_ALPHA_FEEDBACK.md`](INTERNAL_ALPHA_FEEDBACK.md) |

---

## 12. `--profile macos-ui` 잔존 — 실행 문서 / 사문서

`STATUS.md:11`(#1525)이 게이트 밖 문서 10곳에 **42회**가 남아 있다고 적고, 이 goal(ITO-0 T-C / #1609)이 그 분류를 맡는다. `scripts/local_gate.sh` usage는 이 이름을 **받지 않는다**(W-S1 / #1215). 아래 «실행 지시»는 테스터가 복사해 돌리도록 적힌 위치다.

| 위치 | 분류 | 이 PR |
|---|---|---|
| `docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md` | 실행 문서였음 | **전면 개정** — 실행 지시 0 |
| `docs/INTERNAL_ALPHA.md` | 실행 문서였음 | **전면 개정** — 실행 지시 0 |
| `docs/INTERNAL_ALPHA_FEEDBACK.md` | 실행 문서(게이트 페어링) | **미세 정정** — 예시에서 제거 |
| `docs/MACOS_ALPHA_UPDATE_CHANNEL.md` | 실행 문서였음 (Swift 업데이트) | **은퇴 배너** — 본문은 사문서 |
| `docs/LOCAL_SOLO_ALPHA_ROADMAP.md` | 실행처럼 보이는 구 로드맵 | **은퇴 배너** — 본문은 사문서. 후속은 이 팩 |
| `docs/INDEX.md` 로컬 게이트 프로파일 목록 | 실행 지도 | 현행 usage에 맞춤 (`macos-ui` 삭제) |
| `docs/GITHUB_OPS.md` | 실행 잔존 (게이트 명령 예시) | **비접촉** — 티켓 후보 |
| `docs/BACKLOG.md` | 사문서 (역사 티켓) | 비접촉 |
| `docs/adr/0003-macos-packaging-architecture.md` | 사문서 (ADR) | 비접촉 |
| `BUILD_TICKETS.md` · `ROADMAP.md` · `STATUS.md` (레포 루트) | 사문서/증거 원장 | T-C는 `docs/**`만 — 비접촉. 루트 정본의 은퇴 명령 일괄 정리는 #1525가 남긴 후속 |

실행 지시 위치(이 팩·INTERNAL_ALPHA·피드백 게이트 표·INDEX 프로파일 목록)에서 은퇴 스택 명령을 0으로 만든다. 사문서 본문의 역사 문자열은 고치지 않는다.
