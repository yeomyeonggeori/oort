# Local Gate 최적화 — 검증 오버헤드 ~30% 회수 계획 (2026-07)

> 입력 = `scripts/local_gate.sh` 전 프로파일 + `verify_*.sh` + AGENTS/CODEX/LOCAL_PR_GATE 계약 실측 감사.
> 목표: 풀코스 재설계(01 문서, ~50-60 PR) 동안 PR당 게이트 시간을 줄이되 **evidence 규율 자체는 유지**한다.
> 원칙: 게이트를 약화시키지 않는다 — 중복 제거·캐시·프로파일 자동 선택으로 같은 증거를 더 싸게 만든다.

---

## 1. 실측 진단

**지배적 비용 = Swift 빌드의 중복.**

| 발견 | 위치 | 비용 |
|---|---|---|
| `host-runtime`이 Docker 이미지 5개를 매번 무캐시 빌드(각각 `swift build` from scratch) | `verify_internal_host_runtime.sh:186-205` + `infra/prod/docker/swift-service.Dockerfile:20` | **10~20분** |
| `all` 프로파일 = host-runtime 5빌드 + host `swift` 프로파일 5빌드 = **동일 소스 10회 컴파일** | `local_gate.sh` | +8~10분 |
| worktree마다 `.build/` 비공유 → 병렬 worktree N개 = 풀빌드 N회 | `.conductor/setup.sh:44-114` | worktree당 8~10분 |
| 마이그레이션 멱등성 검증을 별도 run으로 2회(all에선 4회) 실행 | `verify_internal_host_runtime.sh:200-222`, `local_gate.sh:198-199` | 회당 5~10초 |
| compose 기동을 `wait_http` 폴링으로 대기 | `verify_internal_host_runtime.sh:211` | 5~30초 |
| `runtime-db` 6개 verifier 직렬 실행(공유 부트스트랩 후에도) | `local_gate.sh:203-213` | 1~3분 |
| 변경 경로와 무관하게 프로파일을 사람이 선택(docs-only PR에 swift 프로파일을 습관적으로 돌림) | 계약상 강제는 아님 | 2~10분/PR |

**이미 잘 돼 있는 것(건드리지 않음):** worktree별 포트/compose 네임스페이스 격리, 프로파일 내 명령 dedupe(`add_cmd_once`), run-slug 이미지 태깅, cleanup trap, env preflight fail-fast.

**계약 재확인:** AGENTS.md가 PR당 요구하는 최소치는 "변경 표면에 맞는 프로파일"이지 `all`이 아니다. `all`은 merge-critical 전용. → 최적화의 절반은 기술이 아니라 **프로파일 선택의 자동화**다.

## 2. 최적화 플랜 (절감/노력/리스크 순 랭킹)

### Wave 1 — Quick wins (1~2일, PR당 3~8분 절감)

| # | 조치 | 절감 | 리스크 |
|---|---|---|---|
| 1 | **diff 기반 프로파일 자동 선택**: `local_gate.sh --auto` 추가. `git diff --name-only origin/main...HEAD`를 경로 매핑(docs/*→docs, clients/*→swift+macos-ui, server/Migrations→runtime-db, relay→runtime-relay, workers→runtime-agent, infra/prod→staging-smoke)으로 변환. 수동 프로파일 지정은 항상 override 가능 | PR당 2~10분 | 낮음 — 보수적 매핑(모호하면 넓은 프로파일)으로 시작 |
| 2 | `compose up -d` → **`compose up -d --wait`** + `wait_http` 루프 제거 | run당 5~30초 | 낮음 |
| 3 | **마이그레이션 멱등성 1-run 검증**: 2회 실행 대신 1회 실행 후 `compose logs migrate`에서 skip 마커 캡처를 evidence로 | run당 5~10초 ×2~4회 | 중 — evidence 형식 합의 필요 |

### Wave 2 — 빌드 캐시 (3~5일, run당 4~10분 절감)

| # | 조치 | 절감 | 리스크 |
|---|---|---|---|
| 4 | **BuildKit 레이어 캐시**: `DOCKER_BUILDKIT=1` + `swift-service.Dockerfile`에 `--mount=type=cache,target=/build/.build` cache mount. Package.resolved 레이어 분리로 의존성 캐시 고정 | host-runtime 첫 run 이후 10분 → 1~2분 | 중 — macOS arm64 Docker Desktop에서 검증 1회 필요 |
| 5 | **worktree 간 Swift 빌드 캐시 공유**: `.conductor/setup.sh`에서 패키지별 공유 캐시 디렉터리(`~/.cache/momo-build/<pkg>`)를 `--scratch-path`로 지정. 동시 접근은 패키지별 flock | worktree당 8~10분 → 2~3분 | 중상 — 브랜치 간 dirty state 누출 검증 필요. flock + 브랜치별 서브키로 완화 |

### Wave 3 — 구조 (풀코스 진행 중 병행, run당 1~3분 + 안정성)

| # | 조치 | 절감 | 리스크 |
|---|---|---|---|
| 6 | `runtime-db` 6개 verifier 중 독립적인 3개(rls/roster/channels) 병렬화 | 1~3분 | 높음 — DB 격리 검증 필요, e2e role 분리는 이미 존재 |
| 7 | 웜 pgdata 볼륨 opt-in(`--reuse-volumes`, alpha 게이트 제외) | 10~20초 | 높음 — 재현성 훼손 가능, CI에서는 항상 fresh |

**하지 않을 것:** 웜 compose 스택 worktree 공유(격리 파괴), Swift incremental in Docker(BuildKit 캐시가 안정화되기 전엔 실험 금지), evidence 파일 생성 생략(계약 위반).

## 3. 사람 개입 최소화 — 디자인 리뷰 루프 (Track A의 절반을 회수)

01 문서에서 "MomoDS 기간의 절반은 취향 판정 루프"라 했던 부분을 자동화한다. 설치 완료:

- **`.claude/skills/momo-design-taste/`** — taste-skill(MIT, 57.7k★)의 구조(Design Read → 다이얼 → 하드 룰 → AI-Tells → mechanical pre-flight)를 SwiftUI/HIG용으로 재작성. 원본은 스스로 "native는 out of scope, HIG를 직접 쓰라"고 선언하므로 규칙을 이식하지 않고 방법론만 이식했다. anthropics `frontend-design`의 프로세스(Design Read, self-critique with screenshots, microcopy 규칙)와 OneRedOak `design-review`의 rubric을 결합.
- **`.claude/agents/design-review.md`** — 구현 컨텍스트와 분리된 리뷰 에이전트. 스크린샷(스냅샷 테스트 또는 `LOCAL_GATE_LAUNCH_UI=1` + screencapture) 기반으로 rubric 7단계 채점, `[Blocker]`는 자동으로 구현자에게 반송, **사람에겐 High 이하만 도달**.
- 루프: 구현(skill 활성) → 빌드/캡처 → design-review 에이전트 → Blocker 0이면 사람 리뷰. mechanical pre-flight(금지 패턴 grep)는 CI 훅으로도 승격 가능(`local_gate.sh --profile swift`에 1줄 추가).
- 후속 옵션: `swift-snapshot-testing` 도입(라이트/다크/고대비/큰글씨 4변형 PNG를 결정론적 evidence로 — 현재 클라 테스트에 스냅샷 의존성 없음, 확인됨), raintree-technology/hig-doctor의 `hig_audit`를 정적 lint 게이트로(76★ 초기 프로젝트라 corpus만 복사하는 쪽 권장).

이로써 01 문서의 "사람만 할 수 있는 것 4가지" 중 ①(시각 취향 판정)은 **최종 승인만 사람**으로 줄고, ②③④(macOS 26 실기기 / 한국어 WER / credentialed provider)만 남는다.

## 4. 티켓 제안

| 제안 | 내용 | 우선순위 |
|---|---|---|
| MOMO-316 | Wave 1: `--auto` 프로파일 선택 + `--wait` + 마이그레이션 1-run 멱등 evidence | **P0** (풀코스 시작 전) |
| MOMO-317 | Wave 2: BuildKit cache mount + worktree 공유 빌드 캐시 | P1 |
| MOMO-318 | design-taste pre-flight grep을 `swift` 프로파일에 연결 + snapshot-testing 도입 | P1 |
| MOMO-319 | Wave 3: runtime-db verifier 부분 병렬화 + 웜 볼륨 opt-in | P2 |

**기대 효과:** 전형적 Swift PR 게이트 12~18분 → **4~7분**, host-runtime 게이트 15~25분 → **5~8분**(캐시 웜 기준), worktree 3개 병렬 시 초기 빌드 비용 1/3. 디자인 리뷰 인건 시간은 "전 화면 육안 검수" → "리포트 승인"으로 축소.
