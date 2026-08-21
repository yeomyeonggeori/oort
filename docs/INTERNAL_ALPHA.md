# Internal Alpha Runbook (웹 + 데스크탑)

> 목적: 한 팀원이 셀프호스트 스택을 띄우고, 브라우저와 Tauri 데스크탑으로
> 초대/합류·에이전트 멘션·diagnostics를 스모크한 뒤, 쓸모 있는 버그를 남긴다.
> 3일 판정 계약은 [`docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md`](LOCAL_3_DAY_ALPHA_TEST_PACK.md)가 정본이다
> (`LAUNCH_READY` / `BLOCKED` / `NEEDS_MORE_INTERNAL`). 시나리오 표는
> [`docs/planning/research/2026-08-20-oss-launch-readiness-and-internal-test-plan.md`](planning/research/2026-08-20-oss-launch-readiness-and-internal-test-plan.md) §4–§5.
>
> 범위: 개발자 머신 + Docker의 내부 알파. M7 릴리스 게이트가 아니고 공개 런칭이 아니다.
> AWS 1주일 호스트 토폴로지는 [`docs/AWS_INTERNAL_ALPHA.md`](AWS_INTERNAL_ALPHA.md) — **ITO 판정값이 아니다.**

은퇴: `MomoMacDevApp`, 삭제된 `scripts/macos_dev_run.sh`, 삭제된 `clients/macOS` 트리, local-gate 프로파일 `macos-ui`. 그 이름은 실패하지 않고 **잘못된 스택을 가리킨다.** <!-- docs-cmd-ignore: 은퇴 스택 이름 호명 (#1609) -->

---

## 0. 먼저 읽을 것

- dedicated worktree에서 한다. dirty 루트에서 알파 스모크를 돌리지 않는다.
- `.env`, diagnostics, 앱 로그, 시크릿이 든 스크린샷을 커밋하지 않는다.
- 초대 원문 코드는 bearer다. 서버는 해시만 저장하므로 발급 순간에 복사한다.
- 쓰기 경로: REST → Postgres 트랜잭션 → outbox → relay. 웹·데스크탑 모두 Centrifugo에 직접 publish하지 않는다.
- 셀프호스트 로그인은 `docs/SELF_HOST.md` §4. 기본 `http://localhost:8088` · `owner@oort.local` · `infra/rust/local.secrets.env`의 `MOMO_INITIAL_OWNER_PASSWORD`. `demo@momo.local` / `dev-password`는 이 경로의 계정이 아니다(온보딩 벤치마크 A7: 셀프호스트에서 401).
- 웹은 same-origin이라 CORS가 없다(`SELF_HOST.md:254-257`). 데스크탑 릴리스는 `tauri://localhost` — 로그인 실기동은 T-A(#1607). README Known gaps를 PASS로 바꾸지 마라.
- «에이전트 초대됨»과 «provider 연결됨»은 다르다. 전자는 `member.kind='agent'` + 채널 멤버십, 후자는 설정 › AI 연결에 키가 들어가 멘션이 `ANSWERED`가 되는 것이다.
- 설정 › AI 연결 403 = `PLATFORM_ADMIN_EMAILS` 없음. 503 = `PROVIDER_LINK_MASTER_KEY` 없이 api가 뜸 (`SELF_HOST.md` §막히면).

---

## 1. 도구

| 도구 | 확인 | 용도 |
|---|---|---|
| Docker Engine + Compose v2 | `docker compose version` | 셀프호스트 이미지 스택 (`SELF_HOST.md` 전제) |
| git | `git --version` | 클론/워크트리 |
| 브라우저 | — | H1 로그인. 셀프호스트는 호스트에 Node/Rust를 요구하지 않는다 |
| Rust (데스크탑만) | `cargo --version` | Tauri 셸. 워크스페이스 MSRV는 `clients/desktop/src-tauri` = 1.89.0 (`STATUS.md` #1442 실측). 서버 이미지는 Docker 안에서 빌드된다 |
| jq (REST 스모크만) | `jq --version` | curl 예시 |

권장 시작:

```bash
git status --short --branch
```

호스팅 env는 `.env.worktree`가 아니라 `scripts/self_host_env.sh`가 쓰는 `infra/rust/local.secrets.env`다. 파일이 있으면 덮어쓰지 않는다.

---

## 2. 기동 (현행 스택)

`docs/SELF_HOST.md` 1–4장이 정본이다. 요지만 반복한다 — 어긋나면 SELF_HOST를 따른다.

```bash
scripts/self_host_env.sh --local-build
scripts/self_host_env.sh --compose up -d --build --wait
```

`--wait`가 끝나면 준비된 것이다. 브라우저에서 스크립트가 인쇄한 주소로 로그인한다.

```bash
oort() { scripts/self_host_env.sh --compose "$@"; }
curl -fsS "http://127.0.0.1:${MOMO_WEB_PORT:-8088}/health"
```

포트는 env가 고른 값이다. 8088이 쓰이면 스크립트가 다음 빈 포트를 고르고 알려 준다.

정리:

```bash
oort down
# 데이터까지: oort down -v && rm infra/rust/local.secrets.env
```

Swift `MomoServer` / `OutboxRelay` / `AgentWorker`를 호스트에서 `swift run`으로 띄우지 않는다. 그 빈은 이미지 안의 `momo-server` · `momo-relay` · `momo-agent-worker`다.

---

## 3. 로그인 가정 (셀프호스트)

셀프호스트 시드는 `SELF_HOST.md`가 만든 첫 owner다. `002_seed.sql`의 `demo@momo.local` 세계를 **이 런북의 로그인으로 쓰지 않는다.**

| 항목 | 값 | 좌표 |
|---|---|---|
| URL | 기본 `http://localhost:8088` | `SELF_HOST.md:115-118,157` |
| 이메일 | 기본 `owner@oort.local` | 같은 절 |
| 비밀번호 | `MOMO_INITIAL_OWNER_PASSWORD` | `infra/rust/local.secrets.env` (권한 600, 커밋 금지) |
| 서버 주소 칸 | 비운다 | `SELF_HOST.md:162` |
| 채널 목록 | `agent-lab` · `general` (`#` 없이) | `SELF_HOST.md:173-175` |
| 에이전트 시드 | 0명으로 시작 | 온보딩 벤치마크 A2 · `MOMO_AGENT_SEED_MODE=none` |

에이전트는 설정 › AI 연결 후 명부에서 만들고 채널에 초대한다(`SELF_HOST.md` §5).

---

## 4. 로그인, 초대, 합류

### 웹

1. 엣지 주소를 연다. 이메일·비밀번호만 채운다.
2. 설정 › **멤버와 초대** (`clients/web/src/features/settings/SettingsRoute.tsx` `id: "members"`).
3. **초대 링크 만들기** (`InviteSection.tsx`). 원문 코드는 이 화면에서만 보인다.
4. 둘째 사람은 조인 링크를 브라우저에서 연다. 통합 «첫 하루» 서술은 T-B(#1608) 몫이다.

### 데스크탑 딥링크

형식 정본: [`docs/onboarding-deeplink.md`](onboarding-deeplink.md).

```
oort://join?server=<percent-encoded base URL>&code=<invite code>
```

릴리스 번들에만 스킴이 붙는다:

```bash
cd clients/desktop
cargo tauri build --bundles app
open -a <README Run 절의 .app 경로> \
  "oort://join?server=http%3A%2F%2Flocalhost%3A8088&code=<code>"
```

좌표: `clients/desktop/README.md:353-370`. 기본 `oort://` 핸들러를 믿지 마라 — LaunchServices가 하나면 고른다(`:25-28`).

### REST (증거 보조)

GUI가 막혔을 때만. 베이스 URL·비밀번호는 env에서 읽는다. 시크릿을 셸 히스토리에 남기지 마라.

```bash
# MOMO_WEB_PORT · MOMO_INITIAL_OWNER_* 는 local.secrets.env
# POST /v1/auth/login  (workspace 칸 없이 — SELF_HOST §4)
# POST /v1/workspaces/$WORKSPACE_ID/invites
# POST /v1/join
```

기대: 신규 멤버 HTTP 201, 이후 그 이메일 로그인이 성공, 공개 초대만으로 owner/platform admin이 되지 않음.

---

## 5. 데스크탑 셸

개발 창(증거 아님):

```bash
cd clients/desktop
cargo tauri dev
```

릴리스 번들(ITO-3 증거):

```bash
cd clients/desktop
cargo tauri build --bundles app
```

실측된 셸 숫자(`clients/desktop/README.md` Measured 2026-07-25): 콜드스타트 537 ms, 유휴 ~196 MB. 이것은 로그인 왕복이 아니다.

로그인 왕복은 T-A(#1607)가 셀프호스트 스택에 대고 재실측한다. 이 런북은 Known gaps를 덮지 않는다.

업데이트 UI: 접속 화면 · 사이드바 뱃지 · 설정 > 업데이트 (`/settings?section=updates`). 채널 정본 [`docs/NEXT_CHANNEL.md`](NEXT_CHANNEL.md). Swift `Updates` 팝오버 런북은 은퇴.

알림: 멘션·승인 대기만, 포커스 없는 창. 클릭 라우팅은 known gap — 중복 이슈 금지.

---

## 6. 스모크 A–F (웹 + 데스크탑)

ITO-3 I1–I8의 한 세션 대응물이다. 3일 체크리스트는 팩 Day 1–3.

### A. 기본 채팅 — I1 메신저 축

1. 웹에서 `general`을 연다.
2. 짧은 사람 메시지를 보낸다.
3. 기대: 타임라인에 나타나고 `message.seq`가 증가한다.
4. 실시간이 안 오면 outbox를 본다(`SELF_HOST.md:299-307`). `broadcast|done`이면 서버 쪽은 끝난 것이다.
5. T-A 증거가 있으면 같은 계정으로 데스크탑에서도 보내고, 반대 표면에서 산다. 없으면 이 칸을 웹-only로 적고 I1을 PASS라고 쓰지 마라.

### B. 초대/합류 — O2 · I3

1. 설정 › 멤버와 초대에서 링크를 만든다. 원문을 즉시 복사한다.
2. 둘째 사용자: 브라우저 조인 링크.
3. 같은 코드로 데스크탑 `oort://join`(릴리스 번들 + `open -a`).
4. 기대: 로그인 가능, 공개 채널 보임, 권한 승격 없음.
5. 코드를 잃으면 그 초대를 폐지하고 새로 만든다.

### C. 에이전트 멘션 — O3 · O4

1. 설정 › AI 연결이 열리는지(O1). 403/503이면 `SELF_HOST.md` §5·§막히면.
2. 외부 `https://` provider 주소와 키를 넣는다. 루프백 로컬 모델은 오늘 400 (`scripts/bench_onboarding.sh:38-41`).
3. 에이전트를 만들고 채널에 초대한 뒤 `@핸들`을 보낸다.
4. 기대: 에이전트가 쓴 채널 메시지가 있다. 판정은 `ANSWERED` / `NOTICE` / `BLOCKED` (`bench_onboarding.sh:31-41`). 키 없는 기본 측정은 `NOTICE`가 정직하다. 기준선 3:58은 `#1534` M5 NOTICE(재시도 소진 포함) — `ANSWERED`를 그 숫자로 말하지 마라.
5. 자격 있는 외부 런타임 게이트:

   ```bash
   scripts/local_gate.sh --profile external-agent-provider
   ```

   기본은 `runtime-unverified(external provider credentials)` skip으로 PASS할 수 있다. 그 skip은 O3 `ANSWERED`가 아니다.
6. O4(#1361 Grok)는 성재 1단계가 열렸을 때만. 아니면 `SKIP(#1361)`.

### D. Diagnostics

실패 후, 전체를 내리기 전에:

```bash
scripts/collect_diagnostics.sh --output-dir /tmp/momo-diagnostics --since 15m
```

디렉터리 + `summary.md` + `.tar.gz`. 콜렉터가 시크릿을 가린 뒤에도 `summary.md`와 파일 이름을 보고 공유한다.

### E. 상태 표면 (구 «Alpha Command Center» 대응)

Swift 우측 `Alpha` 탭은 없다. 현행 대응물:

| 구 행 | 지금 |
|---|---|
| Server | 엣지 `/health`, `oort logs api` |
| Realtime | 메시지 실시간 · outbox 질의 · `oort logs relay` |
| Agent runtime | 설정 › AI 연결 · `@핸들` 결과 |
| Invites | 설정 › 멤버와 초대 |
| Diagnostics | 스모크 D |
| Updates | 설정 > 업데이트 · [`NEXT_CHANNEL.md`](NEXT_CHANNEL.md). I5는 T-D(#1281) 전제 |

LIVE 관전+개입(I4)은 이 표의 별행이다. 호스트가 없으면 `SKIP(LIVE host)`.

### F. Local gate

런북/팩 변경:

```bash
scripts/local_gate.sh --profile docs
```

diagnostics 툴링:

```bash
scripts/local_gate.sh --profile diagnostics
```

웹 클라:

```bash
scripts/local_gate.sh --profile web
```

내부 알파 패킷(호스트 런타임 · 백업 리허설 · diagnostics — UI 런치 없음):

```bash
scripts/local_gate.sh --profile internal-alpha
```

로컬 Docker RC 패킷:

```bash
scripts/local_gate.sh --profile local-alpha
```

에이전트 mock 경로:

```bash
scripts/local_gate.sh --profile runtime-agent
```

`macos-ui` 프로파일은 `local_gate.sh`가 거절한다. `LOCAL_GATE_LAUNCH_UI=1` + Xcode `DEVELOPER_DIR`로 MomoMac을 띄우지 마라.

PR/이슈에는 스크립트가 인쇄한 `## Local Gate` 블록을 붙인다.

---

## 7. 한 사람 진입 게이트 (ITO, AWS가 아님)

이 절은 «개발자 맥을 떠나 AWS로»가 아니다. H1이 열렸는지 + 스모크 A–C가 증거와 함께 끝나는지다. AWS 승격 언어(`AWS_READY`)는 쓰지 않는다.

권장 핸드오프:

```text
~/claudedocs/ito-<YYYYMMDD>/handoff.md
```

| 검사 | 증거 | PASS |
|---|---|---|
| 웹 로그인 | 스크린샷 또는 로그 | `owner@oort.local`이 로컬 엣지에 인증. 실패는 복구 가능한 에러 |
| 채널 | 화면 또는 API | `general` · `agent-lab` 로드 |
| 메시지 | 트랜스크립트 또는 게이트 | seq 순서. 가능하면 두 계정 |
| 초대/합류 | 마스킹된 코드 + 둘째 로그인 | 권한 승격 없음 |
| 에이전트 멘션 | M5 판정 | `NOTICE` 또는 `ANSWERED`. `BLOCKED`는 진입 실패 |
| 재시작 | 웹 새로고침 · `oort up -d --wait` | 히스토리 유지, 실시간 또는 REST 폴백이 보임 |
| diagnostics | 번들 경로 + `summary.md` 검토 | 시크릿 가림, 빠진 소스는 명시 |
| feedback | 이슈 URL 또는 로컬 노트 | «블로커 없음»도 1건 |

최소 명령:

```bash
scripts/local_gate.sh --profile docs
scripts/local_gate.sh --profile internal-alpha
scripts/local_gate.sh --profile external-agent-provider
```

`external-agent-provider`의 no-credential skip은 로컬 도그푸드에는 허용된다. `LAUNCH_READY`에서 에이전트 실사용을 주장하려면 팩 §0의 O3 규칙을 따른다.

---

## 8. AWS 호스트는 ITO 판정이 아니다

[`docs/AWS_INTERNAL_ALPHA.md`](AWS_INTERNAL_ALPHA.md)는 공유 1주일 호스트 토폴로지(계획)다. 프리플라이트는 정적이다. 실제 AWS 생성·DNS/TLS·registry·SOPS·PITR은 `runtime-unverified(aws-host)`.

ITO-4는 `LAUNCH_READY` / `BLOCKED` / `NEEDS_MORE_INTERNAL`이다. `AWS_READY`로 이 런북을 닫지 마라. H3(도메인+TLS)은 팩 Day 0의 조건부 행이고, 정본 절차는 `docs/runbooks/ncp-rust-deploy.md`다.

---

## 9. 피드백

정본: [`docs/INTERNAL_ALPHA_FEEDBACK.md`](INTERNAL_ALPHA_FEEDBACK.md). GitHub 템플릿 `Internal alpha feedback`. 라벨 `type:feedback` · `area:alpha` · `status:needs-triage`. `status:ready`는 Goal/Context/Acceptance가 붙은 뒤다.

발견은 즉흥 수리하지 않고 전량 티켓화한다(ITO 정본 §3.4).

---

## 10. 알려진 한계 (현행)

- 데스크탑 릴리스 로그인/CORS: T-A(#1607) 전까지 README Known gaps가 정본. 낙관 금지.
- 알림 클릭 라우팅: known gap (`clients/desktop/README.md` Notification).
- GHCR digest pull: 첫 발행·익명 pull·attestation PASS(원장 #1332 코멘트 2026-08-21, amd64 단일). H2 amd64 부팅 실측은 잔여(Apple Silicon native pull 불가만 실측). 구 `SELF_HOST.md:88` `runtime-unverified` — H2 SKIP(L2) 문면은 해당 없음.
- 공개 호스트 DNS/TLS/SOPS/PITR: `runtime-unverified(public host)` unless 호스트 증거 패킷.
- iOS 실기기/APNs/external TestFlight: 스코프 밖. I8은 `lane:phone`만.
- 루프백 로컬 모델 provider: 셀프호스트 env는 `MOMO_ENV=staging`, 외부 https만.
- 초대 원문은 발급 후 복구 불가.
- Diagnostics는 best-effort. 빠진 Docker 로그는 콜렉터 실패가 아니라 빠진 증거.
- Swift `MomoMacDevApp` / Sparkle alpha 채널 / in-app Alpha 탭은 제품 표면이 아니다.

---

## 11. 빠른 피드백 초안

```md
## Summary
- One sentence:
- Severity: P0/P1/P2/P3
- Repro rate: always / often / once / unknown

## Environment
- Commit:
- Worktree:
- OS:
- Docker:
- Surface: web / desktop release / desktop dev / both
- Server URL (no secrets):

## Workspace Context
- Workspace:
- Channel:
- Member/user:
- Agent involved: none / named handle / other

## Steps
1.
2.
3.

## Expected

## Actual

## Evidence
- Local gate profile:
- Local gate evidence path or PR URL:
- Diagnostics bundle:
- Screenshots or screen recording:
- Relevant log excerpt:

## Scope Notes
- invite/join?
- agent mention / provider link?
- approval / realtime reconnect?
- T-A desktop login / CORS?
- secrets removed?
```
