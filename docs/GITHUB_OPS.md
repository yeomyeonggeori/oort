# momo — GitHub 운영 구조 (Codex가 goal로 자율작업)

> 목적: **계획은 사람/워크플로우가, 실제 작업은 Codex가 GitHub Issue를 goal로 받아 자율 실행**하는 운영 골격.
> repo: `Dawn-kim-official/momo` · branch: `main` · 모든 사실은 2026 기준 1차 출처로 확인했고 추정은 "(추정)"으로 표기.

---

## 0. 한눈 구조

| GitHub 프리미티브 | momo에서의 역할 | 산출 파일 |
|---|---|---|
| **Milestones** | **릴리스/게이트** (M0~M8 순서가 로드맵) | `scripts/github_bootstrap.sh` |
| **Issues** | **Codex의 goal 단위.** 이슈 본문이 작업 프롬프트 | `scripts/github_bootstrap.sh`, `.github/ISSUE_TEMPLATE/` |
| **Labels** | 택소노미: `type/status/priority/area/size/gate` | `.github/labels.json` |
| **Projects (v2)** | roadmap/board 뷰 (iteration으로 일정) | 수동 1회 + §4 |
| **Issue Types** (org) | 1급 분류(선택, admin:org 필요) | `scripts/github_bootstrap.sh` 주석 §하단 |
| **AGENTS.md** | Codex 운영 계약(빌드/검증/DoD/picker/PR) | `/AGENTS.md` |

일괄 생성: `scripts/github_bootstrap.sh` (idempotent). `scripts/github/bootstrap.sh`와 TSV 파일은 legacy 보존용이며 guard가 걸려 있다.

---

## 1. Milestones = 릴리스/게이트 (로드맵)

순서가 곧 로드맵이다. **QA/사용성 게이트(M7)가 스토어 제출(M8)의 하드 선행.**

| # | 마일스톤 | 의미 | 선행 |
|---|---|---|---|
| M0 | Foundation (완료) | 리포 골격 + 5개 Swift 패키지 컴파일 통과 + 정본 스키마/인프라/마이그레이션 정합 | — |
| M1 | Backend 런타임 + 배포(staging) | docker(PG18+Centrifugo v6+hermes)에서 G-0 런타임 e2e + staging | M0 |
| M2 | 멀티팀 온보딩 | invite_code + 자가가입 + platform_admin 추적 | M1 |
| M3 | 데스크탑 v0 UX | macOS D/B/C 경험을 staging 실데이터로 렌더 | M1 |
| M4 | 데스크탑 패키징 | Xcode .app + Developer ID + notarytool + DMG + Sparkle | M3 |
| M5 | iOS 앱 | iOS 26 SDK + Push + 계정삭제 + UGC + PrivacyInfo | M2, M3 |
| M6 | CI/CD | fastlane/ASC Key/GitHub Actions, release jobs dry-run | M0, M4, M5 |
| M7 | **QA · 사용성 검수 게이트** | G-0~G-H 전부 PASS + 증거 기록 — **스토어 선행** | M1, M3, M4, M5, M6 |
| M8 | 스토어 제출 | App Store + macOS 공개 배포. **M7 PASS 후에만** | M7 |

> ⚠️ **native `gh milestone` 명령은 없다**(2026 현재). 마일스톤은 `gh api repos/{owner}/{repo}/milestones`로 생성한다. 출처: [cli/cli#1200](https://github.com/cli/cli/issues/1200). `scripts/github_bootstrap.sh`가 이 우회를 자동 처리.
>
> due_on(마감일)은 의도적으로 비워뒀다 — 추정 날짜를 강제하지 않고 **Projects iteration**으로 일정을 잡는다(§4).

---

## 2. Labels 택소노미 (6축)

| 축 | 라벨 | 용도 |
|---|---|---|
| **type** | `type:feature` `type:bug` `type:chore` `type:docs` `type:spec` `type:infra` | 무엇인가 |
| **status** | `status:ready` `status:in-progress` `status:blocked` `status:needs-review` `status:runtime-unverified` | 지금 어디 (picker가 `status:ready`만 집음) |
| **priority** | `priority:p0` `priority:p1` `priority:p2` | 우선순위 (p0=릴리스 블로커) |
| **area** | `area:server/relay/worker/core/macos/ios/infra/adapter/schema/tenancy/store/ci` | 어디 코드 |
| **size** | `size:s` `size:m` `size:l` | 공수 추정 |
| **gate** | `gate:qa` `agent:codex-ok` | 검수 게이트 / Codex 자율 적합 |

생성: `gh label create ... --force`(있으면 갱신, 없으면 생성 → idempotent).

> **Labels vs Issue Types:** GitHub은 2025-03부터 **Issue Types**(1급 분류)와 sub-issues·advanced search를 GA했다([changelog](https://github.blog/changelog/2025-03-18-github-issues-projects-rest-api-support-for-issue-types/)). 단 Issue Types는 **org 레벨 + `admin:org` 스코프**가 필요하다([REST docs](https://docs.github.com/en/rest/orgs/issue-types)). repo 스코프만 있는 환경에서는 `type:*` **라벨**로 대체하고, org admin 권한이 생기면 `scripts/github_bootstrap.sh` 하단 주석의 `gh api orgs/Dawn-kim-official/issue-types`로 승격한다.

---

## 3. Issues = Codex의 goal (핵심)

### 3.1 이슈 본문 = 작업 프롬프트
Codex(cloud)는 `@codex` 멘션으로 이슈를 받으면 **이슈 본문을 작업 프롬프트(goal)로** 삼아 sandbox에서 클론→작업→PR을 연다([Codex cloud](https://developers.openai.com/codex/cloud)). 그래서 이슈 템플릿(`.github/ISSUE_TEMPLATE/codex-goal.md`)은 Codex가 바로 실행 가능하도록 `## Goal / ## Context / ## Acceptance / ## Depends on / ## Out of scope`를 강제한다.

### 3.2 이슈 → 실행 흐름
```
이슈 작성(goal+검증등급) ─▶ status:ready ─▶ claim + worktree ─▶ 계획/리서치 검증
        │                                                                │
        ▼                                                                ▼
  picker 규칙(AGENTS.md §6)                         구현 ─▶ 테스트 ─▶ commit/push ─▶ PR
                                                                           │
                                                                           ▼
                                                   리뷰(보안/품질) ─▶ 최종 테스트 ─▶ merge
                                                                           │
                                                                           ▼
                                                main local gate ─▶ 로드맵/이슈/마일스톤 정리
```
- **수동 트리거:** 이슈에서 `@codex implement this issue`.
- **자동 위임(추정/조직 설정 의존):** triage에 들어온 이슈가 규칙에 맞으면 Codex에 자동 할당([upgrades to Codex](https://openai.com/index/introducing-upgrades-to-codex/)). 규칙 기반 자동 위임은 org/플랜 설정에 따라 가용. (추정 — 정확 가용은 org 설정 확인 필요)
- **품질 레버:** 어려운 이슈는 `codex cloud exec --attempts N`으로 best-of-N 후보 중 선택([upgrades to Codex](https://openai.com/index/introducing-upgrades-to-codex/)). (추정 — 플래그 정확 표기는 CLI reference 확인)
- **로컬/데스크탑 실행:** `scripts/goal_claim.sh` 같은 운영 스크립트가 있으면 issue assignee/status/branch/worktree를 한 번에 맞춘다. 아직 스크립트가 없는 checkout에서는 수동으로 별도 branch/worktree를 만들고 같은 규칙을 따른다.
- **완료 기준:** PR 생성이 끝이 아니다. 리뷰 스킬/에이전트 검수 → 최종 테스트 → merge → `main` local gate 확인까지가 한 사이클이다. GitHub Actions를 다시 주 gate로 켠 기간에는 Actions green도 함께 확인한다.
- **대기 시간 사용:** CI를 기다리는 동안 로드맵 위치, 기술스택/중요 결정 변경 여부, 새 리스크나 참고 소스가 생겼는지 점검한다. 변화가 있으면 `STATUS.md`/`ROADMAP.md`/이슈로 반영하거나 후속 이슈를 제안한다.

### 3.2a GitHub Actions 비주요 기간: Local PR Gate

당분간 GitHub Actions를 merge의 주 gate로 쓰지 않는 기간에도 PR 품질 기준은 유지한다.

- 정본: [`docs/LOCAL_PR_GATE.md`](LOCAL_PR_GATE.md).
- PR body에는 `Local Gate: PASS`, 날짜, machine/toolchain, 실행 명령, runtime coverage, 미검증 범위를 기록한다.
- 기본 명령:
  ```bash
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make build
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make test
  python3 -m py_compile adapters/hermes/momo_adapter.py
  jq empty .github/labels.json infra/centrifugo.json
  ```
- runtime 변경은 해당 profile을 추가한다: `scripts/verify_rls.sh`, `scripts/verify_agent_worker.sh`, `make up && make migrate` 등.
- merge 후에는 `main`을 갱신하고 같은 local gate를 한 번 더 실행한다. Actions 확인 단계는 Actions를 다시 주 gate로 켤 때 복원한다.

### 3.2b 5개+ session/worktree 운영

- 정본: [`docs/MULTI_SESSION_OPS.md`](MULTI_SESSION_OPS.md).
- `momo-main` thread는 issue picker/review/merge/orchestration 전담.
- worker thread는 한 GitHub Issue만 claim하고, remote branch를 lock으로 사용한다.
- worker는 완료 시 issue, branch, worktree path, PR URL, local gate, remaining risks를 `momo-main`에 보고한다.
- 같은 package family의 대형 변경, 특히 `server/`, `infra/`, migrations, shared model 변경은 동시에 2개 이상 열지 않는다.

### 3.3 의존성 표현
- 이슈 본문 `## Depends on:`에 선행 이슈 title/번호. picker(AGENTS.md §6)는 의존이 **모두 닫혀야** 그 이슈를 고른다.
- 큰 작업은 **sub-issues**로 분할 가능(GA, 부모당 100개 한도·다단계 그룹핑은 제한적, [community#154148](https://github.com/orgs/community/discussions/154148)).
- 1차 의존 진실은 `BUILD_TICKETS.md`의 STEPS 표(T01→…→T10 + P1~P6).

### 3.4 sandbox 안전(2026)
Codex cloud는 네트워크 격리 sandbox에서 돌고, **GitHub 브랜치 보호 규칙이 그대로 적용**되어 리뷰 없이 main 직접 push가 막힌다([introducing Codex](https://openai.com/index/introducing-codex/)). main 브랜치 보호 + PR 필수 + `swift build` green 체크를 권장.

---

## 4. Projects (v2) — roadmap

1. org/repo에 Project 생성(이름: `momo roadmap`).
2. 뷰: **Roadmap**(timeline) + **Board**(status별) + **Table**.
3. **iteration 필드** 추가 → 일정/속도 관리(due_on을 마일스톤에 안 박은 이유). 그룹핑: Milestone 또는 area 라벨.
4. 이슈 일괄 추가:
   ```bash
   # Project 번호 확인
   gh project list --owner Dawn-kim-official
   # 마일스톤별 이슈를 Project에 추가 (예시)
   gh issue list --repo Dawn-kim-official/momo --milestone "M1 Backend 런타임 + 배포(staging)" --json url -q '.[].url' \
     | xargs -I{} gh project item-add <PROJECT_NUMBER> --owner Dawn-kim-official --url {}
   ```
- Project 한도: 50,000 items([GA changelog](https://github.com/orgs/community/discussions/154148)). momo 규모에 충분.
- 자동화: Project workflow로 "이슈 closed → Done", "PR merged → 이슈 status 갱신"을 설정(수동 1회).

---

## 5. 일괄 부트스트랩 (실행)

```bash
# 0) 인증 (repo 스코프 필요; 마일스톤 gh api도 repo로 충분)
gh auth status

# 1) dry-run 으로 검토
scripts/github_bootstrap.sh --dry-run --org Dawn-kim-official --repo momo

# 2) 실제 적용 (idempotent: 재실행해도 중복 0)
scripts/github_bootstrap.sh --org Dawn-kim-official --repo momo

# 옵션
scripts/github_bootstrap.sh --org Dawn-kim-official --repo momo --skip-issues   # 라벨/마일스톤만
```
생성 순서: 라벨 → 마일스톤(중복 skip) → 이슈(동일 title 열린 이슈 skip). 데이터 정본은 `.github/labels.json`과 `scripts/github_bootstrap.sh`의 `MILESTONES`/`TICKETS` heredoc이다.

---

## 6. AGENTS.md와의 관계
- 이 문서는 **GitHub 쪽 구조**(마일스톤/라벨/이슈/Project)를 정의한다.
- `/AGENTS.md`는 **Codex가 한 이슈를 받았을 때의 실행 계약**(빌드/검증 명령, DoD, 다음 티켓 선택법 §6, 브랜치/PR §5, 리포맵 §8)을 정의한다.
- Codex는 세션 시작 시 git root→leaf로 `AGENTS.md`를 병합한다(leaf override, [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)). 패키지별 세부 규칙이 필요하면 해당 디렉터리에 nested `AGENTS.md`를 추가한다.

---

## 7. 비용 / 일정 / 요건 (2026, 1차 출처)

| 항목 | 값 | 출처 | 비고 |
|---|---|---|---|
| Apple Developer Program | **$99 / 년** | [developer.apple.com/programs](https://developer.apple.com/programs/whats-included/) | macOS 공증·iOS 배포 공통 전제 |
| macOS 공증 소요 | 대부분 **15분 내(98%)** | [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) | `xcrun notarytool`(altool deprecated) + `stapler` |
| iOS 업로드 SDK 요건 | **2026-04-28부터 iOS 26 SDK 이상** | [Apple upcoming requirements](https://developer.apple.com/news/upcoming-requirements/) | 구 SDK 빌드는 업로드 거부 |
| App Review 소요 | **~90%가 24h 내** | [Apple App Store submitting](https://developer.apple.com/app-store/submitting/) | 복잡 앱 2~5일(추정 범위) |
| TestFlight 빌드 만료 | **90일** | [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/) | 첫 빌드만 그룹 추가 시 리뷰 |
| GitHub Project 한도 | **50,000 items** | [GA changelog](https://github.com/orgs/community/discussions/154148) | 2025-03 GA |
| sub-issue 한도 | 부모당 **100개** | [community#154148](https://github.com/orgs/community/discussions/154148) | 다단계 그룹핑 제한적 |

> **법무/스토어 정책 관련 모든 텍스트는 법률 자문이 아님.** Apple/GitHub 공식 문서를 1차 출처로 확인했고, 정책은 수시 변경되므로 제출 직전 재확인 필요.

---

## 8. 운영 규칙 요약
- 한 이슈 = 한 goal = 한 PR. 스코프 늘리지 말 것(필요시 새 이슈).
- `status:ready` + 의존 충족 + 미할당 = Codex picker 대상.
- 가능하면 worktree에서 작업한다. 동시에 여러 작업을 받을 수 있도록 root dirty worktree는 건드리지 않는다.
- 작업 전 계획 문서를 확인하고, 계획이 미흡하면 추가 리서치부터 한다.
- PR 이후에는 보안/품질 리뷰, 최종 테스트, merge, `main` local gate 확인까지 완료한다.
- Actions를 비주요 gate로 두는 기간에는 `docs/LOCAL_PR_GATE.md`의 local evidence + reviewer pass + merge 후 main local gate를 완료 기준으로 사용한다.
- QA/사용성 게이트(M7) PASS 기록 전에는 M8(스토어/공증 공개 배포) 이슈 착수 금지.
- 런타임 미검증은 `status:runtime-unverified` + STATUS.md에 정직 표기. Docker/psql로 가능한 검증은 수행하고, hermes 등 외부 의존은 실제 의존성 또는 mock 준비를 먼저 검토한다.
