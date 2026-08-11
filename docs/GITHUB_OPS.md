# oort — GitHub 운영 구조 (Codex가 goal로 자율작업)

> 목적: **계획은 사람/워크플로우가, 실제 작업은 Codex가 GitHub Issue를 goal로 받아 자율 실행**하는 운영 골격.
> repo: `yeomyeonggeori/oort` · branch: `main` · 모든 사실은 2026 기준 1차 출처로 확인했고 추정은 "(추정)"으로 표기.

---

## 0. 한눈 구조

| GitHub 프리미티브 | oort에서의 역할 | 산출 파일 |
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
| **type** | `type:feature` `type:bug` `type:chore` `type:docs` `type:feedback` `type:spec` `type:infra` | 무엇인가 |
| **status** | `status:needs-triage` `status:ready` `status:in-progress` `status:blocked` `status:needs-review` `status:runtime-unverified` | 지금 어디 (picker가 `status:ready`만 집음) |
| **priority** | `priority:p0` `priority:p1` `priority:p2` | 우선순위 (p0=릴리스 블로커) |
| **area** | `area:server/relay/worker/core/macos/ios/infra/adapter/schema/tenancy/store/ci/alpha` | 어디 코드 |
| **size** | `size:s` `size:m` `size:l` | 공수 추정 |
| **gate** | `gate:qa` `agent:codex-ok` | 검수 게이트 / Codex 자율 적합 |

생성: `gh label create ... --force`(있으면 갱신, 없으면 생성 → idempotent).

> **Labels vs Issue Types:** GitHub은 2025-03부터 **Issue Types**(1급 분류)와 sub-issues·advanced search를 GA했다([changelog](https://github.blog/changelog/2025-03-18-github-issues-projects-rest-api-support-for-issue-types/)). 단 Issue Types는 **org 레벨 + `admin:org` 스코프**가 필요하다([REST docs](https://docs.github.com/en/rest/orgs/issue-types)). repo 스코프만 있는 환경에서는 `type:*` **라벨**로 대체하고, org admin 권한이 생기면 `scripts/github_bootstrap.sh` 하단 주석의 `gh api orgs/yeomyeonggeori/issue-types`로 승격한다.

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
- **로컬/데스크탑 실행:** `scripts/goal_status.sh`로 ready/in-progress/needs-review/blocked와 branch/PR/worktree 충돌을 확인한 뒤 `scripts/goal_claim.sh <issue>`로 issue assignee/status/branch/worktree를 한 번에 맞춘다. 아직 스크립트가 없는 checkout에서는 수동으로 별도 branch/worktree를 만들고 같은 규칙을 따른다.
- **완료 기준:** PR 생성이 끝이 아니다. 리뷰 스킬/에이전트 검수 → 최종 테스트 → merge → `main` local gate 확인까지가 한 사이클이다. GitHub Actions를 다시 주 gate로 켠 기간에는 Actions green도 함께 확인한다.
- **대기 시간 사용:** CI를 기다리는 동안 로드맵 위치, 기술스택/중요 결정 변경 여부, 새 리스크나 참고 소스가 생겼는지 점검한다. 변화가 있으면 `STATUS.md`/`ROADMAP.md`/이슈로 반영하거나 후속 이슈를 제안한다.

### 3.2a PR CI + Local PR Gate

공개 레포 전환 뒤 canonical PR은 `main`·`track/engine`·`track/uxui`에서 `PR CI gate`와 base-trusted `Policy integrity gate` 두 required context를 쓴다(ADR-0153 D5). Rust/Node/legacy 생성계약은 `pr-ci`가 변경 경로별로 실행한다. DB·Centrifugo·Docker·외부 provider runtime은 계속 local gate가 정본이다. release/유료 macOS workflow의 owner/M7 제한은 그대로다.

- 정본: [`docs/LOCAL_PR_GATE.md`](LOCAL_PR_GATE.md), 실행 진입점: `scripts/local_gate.sh`.
- PR body에는 `scripts/local_gate.sh --profile ...`가 출력하는 `Local Gate: PASS`, 날짜, machine/toolchain, 실행 명령, runtime coverage, 미검증 범위를 붙인다.
- 기본 실행:
  ```bash
  scripts/local_gate.sh --profile docs
  scripts/local_gate.sh --profile swift
  scripts/local_gate.sh --profile diagnostics
  scripts/local_gate.sh --profile runtime-db
  scripts/local_gate.sh --profile runtime-agent
  scripts/local_gate.sh --profile macos-ui
  ```
- 수동 fallback 명령:
  ```bash
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make build
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make test
  python3 -m py_compile adapters/hermes/momo_adapter.py
  jq empty .github/labels.json infra/centrifugo.json
  ```
- runtime 변경은 해당 profile을 사용한다. `runtime-relay`는 `scripts/verify_relay.sh`가 생기기 전까지 PASS를 만들 수 없고, MOMO-002 수동 relay 검증 경로를 PR evidence로 남긴다.
- 내부 alpha 장애 공유는 `scripts/collect_diagnostics.sh --output-dir /tmp/momo-diagnostics --since 15m`로 redacted bundle을 만들고, diagnostics tooling 변경 PR은 `scripts/local_gate.sh --profile diagnostics` evidence를 붙인다.
- merge 직전에 현재 PR head의 `PR CI gate`·`Policy integrity gate`와 exact-base wrapper provenance를 모두 확인한다. merge 후에는 `main`을 갱신하고 같은 local gate를 한 번 더 실행하며 `track-alignment` 결과도 확인한다.
- 세 canonical branch 보호 상태와 repository Actions 기본 권한은 `scripts/github_track_guardrails.sh --check`로 확인한다. read-only check는 GitHub Actions 공식 App ID와 `main → track/*` 조상 topology를 사용하므로 정상적인 track-ahead 상태에서도 동작한다. workflow 기본 권한은 read·PR 승인 불가다. apply는 기존의 더 강한 check/review/restriction/linear-history 설정을 보존하며, 동시 변경이나 404 이외의 조회 실패에서는 fail-closed하고 부분 적용이면 즉시 `--check`로 남은 드리프트를 확인해 같은 bootstrap 창에서 수리한다.

#### Trusted policy-integrity gate (#1302)

공개/Free 저장소에는 Enterprise ruleset을 전제하지 않는다. `policy-integrity.yml`의
`pull_request_target`은 **base**의 `scripts/verify_policy_integrity.sh`와 GitHub API
metadata만 평가한다. 후보 checkout·후보 스크립트 실행·의존성 설치를 하지 않는다.
그 결과 `Policy integrity gate` 정적 status는 정확한 PR head에, exact run attempt를
target으로 게시된다.

그러나 같은 GitHub Actions App과 status 이름은 위조 가능한 표면이다. 통합 직전에는
후보/topic checkout이 아닌 **현재 PR의 exact canonical base branch/HEAD에서 wrapper bytes가
그 base와 일치하는 checkout**으로 반드시 다음을 실행한다. wrapper는 자기 bytes와
HEAD가 PR API의 exact base commit인지 확인하고 그 commit object에서 verifier를 추출한다.
따라서 worktree/candidate verifier bytes는 무시되고 실행되지 않는다.
추출된 verifier는 현재 PR head/base를 workflow ID/path, `pull_request_target` event,
run-attempt, current default-main workflow authority가 포함된 base-controlled run-name,
check-suite app, evaluator job에 묶고 현재 changed-files/audit evidence 및 마지막 API
재읽기까지 수행한다.

commit status와 Check Suite의 신원 축은 같지 않다. 2026-08-12 첫 live PR 실측에서
status creator는 exact `github-actions[bot]`(GitHub user id `41898282`, type `Bot`)이고,
run/check-suite/job의 실행 주체는 별도 GitHub Actions App(id `15368`, slug
`github-actions`)이었다. verifier는 status의 context/state/current-head/target run-attempt와
bot login+id+type을 먼저 결속한 뒤, target run의 suite/job을 App id+slug에 따로 결속한다.
bot user id를 App id처럼 비교하거나 둘 중 한 축만으로 provenance를 주장하지 않는다.

```bash
scripts/verify_policy_integrity_from_base.sh \
  --repo yeomyeonggeori/oort --pr <PR-number>
```

정책 파일 변경은 PR author가 지정 policy owner `kwakseongjae`(stable GitHub user id
`87296259`)이고, 같은 지정 owner의 exact `Policy-Integrity-Audit: <40sha>` comment가
있어야 한다. 그 뒤에도 같은 login+id의 지정 owner가 현재
`policy-change-approved` label을 붙여야 한다. org 저장소에서 해당 계정의
`author_association`은 `MEMBER`이므로 `OWNER` association 문자열을 권한 증거로 쓰지
않는다. head가 바뀌거나 audit comment/label transition이 수정되면 label을 다시 붙여야
하며, 기존 승인은 재사용되지 않는다. local gate fixture는 이 재승인·run binding·후보
실행 금지 RED를 고정하고, required context는 `PR CI gate`와 `Policy integrity gate` 두
개다. 첫 live PR에서 status creator와 run/suite/job App 축, bare run path, PR-head
run/suite/job SHA 형상을 확인했다. API가 반환할 수 있는 다른 run-head 형상은 의미를
추정하지 않고 세 객체의 내부 SHA 일치만 요구하며, 원격 branch-protection apply/readback은
bootstrap 완료 전까지 `runtime-unverified`다.

초기 bootstrap은 workflow가 아직 base에 없는 **#1302의 track/engine→main 최초 랜딩
체인 전체**와, 첫 live 응답에서 드러난 status-user/App identity 불일치 때문에 기존
exact-base verifier가 genuine run을 거부하는 **#1307의 track/engine→main 수리 체인**만
reviewed exception으로 허용한다. #1307은 후보 verifier를 merge 권위로 사용하지 않고 독립
보안 리뷰, 두 required context, focused/static/docs local gate, live read-only 진단을 모두
기록한다. #1307이 main에 랜딩하면 갱신된 exact-base wrapper로 대기 중인 PR을 다시 검증하며,
세 canonical ref를 동일 SHA로 맞추는 순간부터 예외는 없다. 먼저 main의 정본 label 정의를
확인하고 지정 owner가 원격 label을 만든다.

```bash
scripts/github_bootstrap.sh --dry-run --labels-only
scripts/github_bootstrap.sh --labels-only
gh label view policy-change-approved --repo yeomyeonggeori/oort \
  --json name --jq 'select(.name == "policy-change-approved") | .name'
```

그 동일 base에서 각 target branch마다 docs-only bootstrap PR 하나를 열어 다음처럼
target별 PR을 정확히 매핑한다. `--apply` 자체도 clean·exact-equal canonical main에서만
실행되며, 각 cycle마다 PR exact base object의 verifier를 다시 추출한다.

```bash
scripts/github_track_guardrails.sh --repo yeomyeonggeori/oort --apply \
  --policy-pr 'main=N,track/engine=N,track/uxui=N'
scripts/github_track_guardrails.sh --repo yeomyeonggeori/oort --check
```

guard가 세 PR 모두를 verify한 뒤에만 보호를 적용한다. PR들은 merge하지 않고 닫는다.
workflow_dispatch로 status를 seed하지 않는다. default main이 전진했으면 과거 authority의
run을 재사용할 수 없으므로 label toggle 등 새 `pull_request_target` event로 status를
갱신한 뒤 verifier를 다시 실행한다.

#### 지정 policy owner 회전 / break-glass

계획된 계정 회전은 **기존 지정 owner를 아직 신뢰할 수 있을 때** old policy 아래의 최소
정책 PR로 수행한다. verifier의 login+numeric id, label 설명과 이 절차 문서만 바꾸고,
기존 owner가 그 PR exact head에 audit comment → label 순서로 승인한다. 정상 wrapper와 두
required context로 랜딩·canonical 정렬한 뒤 각 target에 fresh docs-only verification PR을
열어 새 owner evidence로 세 branch를 검증하고 닫는다. 열린 기존 PR은 label toggle 등 새
event/run을 만들며, 마지막에 `scripts/github_track_guardrails.sh --check`를 기록한다.

기존 계정을 잃었거나 침해가 의심되면 그 계정의 comment/label은 사용하지 않는다. 먼저
공개 incident issue에 사유·승인 actor·UTC 시작시각·세 canonical SHA·영향받은 PR/status/run
ID와 변경 전 protection JSON을 기록하고 **모든 merge를 중지**한다. 저장소 관리자가 세
branch에서 오직 `Policy integrity gate` required context만 임시 제거하고 PR-only,
`PR CI gate`, admin enforcement, conversation resolution, force/delete 금지는 유지한다.
새 login+numeric id와 이 runbook만 바꾸는 최소 recovery PR을 독립 검토·local gate 후
track→main 초기 체인과 같은 명시적 예외로 랜딩한다. 즉시 세 ref를 같은 SHA로 정렬하고,
label 정본을 적용/readback한 뒤 target별 fresh bootstrap PR 세 개로 `--apply` → `--check`를
완료해 두 context를 복구한다. bootstrap PR은 unmerged close한다. incident issue에는 exact
recovery PR/merge SHA, 임시 protection 변경 actor/time, fresh run IDs, 최종 `--check`와
복구시각을 추가한다. direct/force push, workflow_dispatch seed, 다른 보호 완화, 비감사
예외 재사용은 금지한다.

### 3.2b 5개+ session/worktree 운영

- 정본: [`docs/MULTI_SESSION_OPS.md`](MULTI_SESSION_OPS.md).
- `momo-main` thread는 issue picker/review/merge/orchestration 전담.
- worker thread는 한 GitHub Issue만 claim하고, remote branch를 lock으로 사용한다.
- 시작 명령:
  ```bash
  scripts/goal_status.sh --repo yeomyeonggeori/oort
  scripts/goal_claim.sh <issue-number>
  ```
- worker는 완료 시 issue, branch, worktree path, PR URL, local gate, remaining risks를 `momo-main`에 보고한다.
- PR 생성 후에는 `scripts/goal_release.sh <issue-number> --review --pr <PR URL>`로 issue를 review 상태로 넘기고, 블로커가 있으면 `--blocked "<reason>"`로 이유를 남긴다.
- 같은 package family의 대형 변경, 특히 `server/`, `infra/`, migrations, shared model 변경은 동시에 2개 이상 열지 않는다.

### 3.2c Internal alpha feedback intake

- 정본: [`docs/INTERNAL_ALPHA_FEEDBACK.md`](INTERNAL_ALPHA_FEEDBACK.md).
- raw tester report는 GitHub `Internal alpha feedback` 템플릿으로 접수하고 `type:feedback`, `area:alpha`, `status:needs-triage`를 붙인다.
- `status:needs-triage`는 worker claim 대상이 아니다. momo-main이 severity(P0 data loss/security, P1 core alpha flow blocked, P2 usability friction, P3 polish), evidence, labels, milestone을 정리한다.
- 필수 evidence: local gate profile, diagnostics bundle path, repro steps, workspace/channel/member context, expected/actual.
- buildable goal로 바꿀 때만 `## Goal / ## Context / ## Acceptance / ## Out of scope`를 채우고 `status:ready`로 전환한다.
- 상태 확인:
  ```bash
  scripts/goal_status.sh --repo yeomyeonggeori/oort
  gh issue list --repo yeomyeonggeori/oort --label status:needs-triage --state open
  ```

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
   gh project list --owner yeomyeonggeori
   # 마일스톤별 이슈를 Project에 추가 (예시)
   gh issue list --repo yeomyeonggeori/oort --milestone "M1 Backend 런타임 + 배포(staging)" --json url -q '.[].url' \
     | xargs -I{} gh project item-add <PROJECT_NUMBER> --owner yeomyeonggeori --url {}
   ```
- Project 한도: 50,000 items([GA changelog](https://github.com/orgs/community/discussions/154148)). oort 규모에 충분.
- 자동화: Project workflow로 "이슈 closed → Done", "PR merged → 이슈 status 갱신"을 설정(수동 1회).

---

## 5. 일괄 부트스트랩 (실행)

```bash
# 0) 인증 (repo 스코프 필요; 마일스톤 gh api도 repo로 충분)
gh auth status

# 1) dry-run 으로 검토
scripts/github_bootstrap.sh --dry-run --org yeomyeonggeori --repo oort

# 2) 실제 적용 (idempotent: 재실행해도 중복 0)
scripts/github_bootstrap.sh --org yeomyeonggeori --repo oort

# 옵션
scripts/github_bootstrap.sh --org yeomyeonggeori --repo oort --skip-issues   # 라벨/마일스톤만
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
