# oort 트랙 파이프라인 (정본, 2026-07-18 성재 지시)

> **모든 세션(Claude/Fable, GPT/momo-main, Codex worker)은 작업 시작 전에 이 문서로 자기 트랙을 선언한다.**
> 관련: `docs/MULTI_SESSION_OPS.md` §4.1(루트 무접촉·clean 유지), `docs/planning/ENGINE_HANDOFF.md`(엔진→UXUI 큐).

## 0. 세션 첫 행동 (모든 에이전트 공통)

1. **트랙 선언**: 이번 작업이 UXUI인지 엔진인지 한 줄로 선언하고 시작한다. 판별 기준은 §1의 소유 파일군.
2. **자기 트랙 워크트리로 이동**: 루트(`~/projects/momo`, main 체크아웃)에서는 절대 구현하지 않는다. 루트는 항상 clean + origin/main 일치(문서/머지 전용).

## 1. 트랙 정의

> **2026-08 현행화(#1226).** 이 표는 Swift/macOS 시절에 쓰였고 그때의 파일군만 담고 있었다 — `server-rust/**`도 `clients/web/**`도 목록에 없어서, **오늘 가장 활발한 두 트리가 어느 트랙 소유인지 이 정본이 답하지 못했다.** 아래는 현행 트리를 채운 것이다. 파일군은 현행화하되 **트랙 이원화 규칙 자체(§2·§3)는 손대지 않았다** — 그건 성재 지시 사항이다.

| 트랙 | 소유 파일군 (현행) | 트랙 브랜치 | 트랙 워크트리 |
|---|---|---|---|
| **UXUI** | `clients/web/**`(제품 웹 표면), `clients/desktop/**`(Tauri 셸), `clients/mobile/**`(React Native) — 그리고 은퇴 중인 `clients/macOS/**`·`clients/iOS/**` | `track/uxui` | `~/projects/momo-tracks/uxui` |
| **엔진** | `server-rust/**`(Rust/Axum), `server/Migrations/**`(정본 DDL), `adapters/**`, `infra/**`, `scripts/**`, `.github/**` — 그리고 은퇴 중인 `server/Sources/**`·`relay/**`·`workers/**`·`services/**`·`clients/Core/**` | `track/engine` | `~/projects/momo-tracks/engine` |

- 트랙 워크트리 경로는 **메인테이너 로컬 관례**다. 다른 환경에서는 경로만 바꾸고 브랜치 이름(`track/uxui`·`track/engine`)을 지킨다.
- **공유 계약은 가산 변경 원칙.** 은퇴 중인 `clients/Core`(Swift)의 자리를 지금은 `packages/momo-core`(TypeScript, `@momo/core`)가 맡는다. 계약을 좁히거나 깨는 변경은 반대편 트랙을 먼저 부순다 — `scripts/verify_merge_tree.sh`가 **병합 결과**에서 그것을 잡는다(#1108: 각 브랜치는 초록인데 병합 트리에서만 폰이 무너진 전례).
- **양 트랙이 함께 만지는 트리가 실재한다(실측).** `clients/web`·`packages/momo-core`는 UXUI 표면이지만 엔진 트랙도 디자인 시스템·보안 헤더·계약 변경으로 랜딩해 왔다. 지금 규율은 "소유가 아니라 통보" — **최소 diff + 상대 트랙에 로그**(ENGINE_HANDOFF 또는 이슈 코멘트) + 병합 트리 게이트. 이 겹침을 배타적 소유로 가를지 여부는 **성재 결정 대기**이며, 결정 전까지 이 문서가 임의로 선을 긋지 않는다.
- goal 단위 세부 워크트리(worker 격리)는 지금처럼 만들어도 된다. 단 **PR/머지 대상은 main이 아니라 자기 트랙 브랜치다.**

## 2. 빌드·확인 규칙 — 성재가 보는 것은 항상 트랙 워크트리 빌드

- 성재에게 보여주는 앱은 **반드시 자기 트랙 워크트리에서** 빌드·실행한다(웹 `npm --prefix clients/web run dev`, 데스크톱 Tauri 셸, 폰 `clients/mobile`의 `build:sim`/`lane:phone`. 은퇴 중인 macOS 앱은 `scripts/macos_dev_run.sh`).
- 실행 전 반드시 확인·고지: **"빌드 원본: <워크트리 경로> <브랜치>@<짧은 SHA>"**. main 빌드를 보여주거나, 워크트리에서 작업하고 main 빌드로 확인시키는 것 금지(작업이 사라진 것처럼 보이는 사고의 원인).
- 게이트/검증도 트랙 워크트리(또는 goal 워크트리) 기준으로 돈다.

## 3. 머지 규칙 — main은 성재 게이트

1. **작업 → 트랙 브랜치**: 각 트랙은 자기 브랜치까지 자율로 축적한다(리뷰·게이트 규율은 기존 그대로 — 검증 없는 머지 금지).
2. **트랙 브랜치 → main**: **성재의 명시 승인이 있을 때만.** 두 경로뿐:
   - 세션이 "main에 머지할까요?"라고 묻고 성재가 승인, 또는
   - 성재가 먼저 "main에 머지하자"라고 말할 때.
   그 외 어떤 자동 main 머지도 금지. (성재는 특히 UXUI에서 더 다듬고 싶은 경우가 많다 — 머지 재촉 금지.)
3. main 머지 실행은 통합자(현재 Fable)가 순차 수행하고, 머지 후 **두 트랙 브랜치를 fast-forward하거나 main을 merge commit으로 합류**시켜 드리프트를 막는다. 원격 track의 rebase/history rewrite와 force-push는 금지한다.

### 3.1 정렬 topology와 기계 가드

- 허용 상태는 `main`이 `track/engine`과 `track/uxui` 각각의 조상인 상태다. 트랙이 main보다 앞서는 것은 승인 대기 작업이므로 정상이다. 트랙이 main보다 뒤처지거나 양쪽에 고유 커밋이 생긴 divergence는 정렬 실패다.
- canonical local upstream은 정확히 `main → origin/main`, `track/engine → origin/track/engine`, `track/uxui → origin/track/uxui`다. local ahead는 push 대기 상태라 허용하지만 local behind/divergence와 upstream 없음·오배선은 실패한다.
- 상태 확인은 `scripts/check_track_alignment.sh --remote --local-existing`. 모든 local canonical branch까지 요구하는 메인테이너 감사는 `--all`. checker는 fetch나 ref 이동을 하지 않으므로 먼저 `git fetch origin --prune`한다.
- `scripts/local_gate.sh`·선택적 pre-push hook·`scripts/verify_merge_tree.sh`가 같은 checker를 소비한다. GitHub에서는 `track-alignment.yml`이 세 canonical branch push, 일일 schedule, 수동 실행에서 remote topology를 감시한다.
- main 통합 직후 track이 behind/diverged면 다음 goal을 시작하지 말고 main을 각 track에 합류시킨다. 이미 PR-only 보호가 켜졌다면 main→track PR로 수리한다. force-push, branch 삭제, 자동 충돌 해결, 승인되지 않은 track→main 통합은 금지다.

### 3.2 GitHub 보호 적용 순서

1. #1297 코드가 main에 들어가고 `main`·`track/engine`·`track/uxui`를 같은 SHA로 정렬한다.
2. `pr-ci.yml`을 `workflow_dispatch`하여 그 SHA에 안정 context `PR CI gate`를 만든다.
3. `scripts/github_track_guardrails.sh --repo yeomyeonggeori/oort --check`로 현재 차이를 확인한다.
4. 통합자가 명시적으로 `--apply`한 뒤 다시 `--check`한다. 기본 호출은 항상 read-only다.

관리 정책은 세 branch 모두 PR-only, GitHub Actions app ID에 고정된 strict `PR CI gate`, 관리자 포함, conversation resolution 필수, force-push·삭제 금지다. repository Actions 기본 권한은 read이며 workflow의 PR 승인은 금지한다. 새 보호의 승인 수는 solo-owner 운영과 성재의 채팅 승인을 보존하기 위해 0이며, 코드리뷰·local gate evidence 계약은 그대로다. 이미 더 강한 required check·review 수/code-owner·last-push·push restriction·linear-history 설정이 있으면 `--apply`는 낮추지 않고 보존한다. 보호 조회는 명시적 404만 미설정으로 취급하며, 최초 snapshot 뒤 동시 변경이나 auth/network/5xx/잘못된 JSON은 첫 PUT 전에 실패한다.

## 4. 엔진→UXUI 핸드오프 루프

1. 엔진 트랙은 UI가 소비할 수 있는 기능을 트랙에 랜딩할 때마다 `docs/planning/ENGINE_HANDOFF.md`에 **ready 항목**을 추가한다(무엇이 준비됐고, UI가 무엇을 할 수 있고, 계약 포인터는 어디인지).
2. UXUI 트랙은 세션 시작 시와 작업 사이사이 이 파일을 읽고, `ready` 항목을 성재에게 **"이거 구현할까요?"** 로 제안한다.
3. 상태 전이: `ready`(엔진 완료) → `proposed`(성재에게 제안됨) → `in-progress`(승인·작업 중) → `done`. 갱신은 항목을 소비하는 쪽이 한다.

## 5. 위반 시 (반복 사고 예방)

- 루트에서 구현 파일 편집 발견 → 즉시 중단하고 자기 워크트리로 이동, 루트 사본은 본인이 정리(타 세션이 stash로 보관하게 만들지 말 것).
- main 무승인 머지 → 되돌리지 말고 성재에게 즉시 보고(이력 보존).
