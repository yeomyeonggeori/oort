# buzz급 진단 감사 — 축 E: 문서·정체성 드리프트

> 워커 E · 2026-08-10 · 읽기 전용(변경 0줄) · 기준 브랜치 `origin/track/engine`(main-only 사실은 명시)
> 패킷: `docs/planning/handoffs/2026-08-10-buzz-diagnosis-audit-packet.md` §E
> buzz 기준선은 `github.com/block/buzz` **실측**(gh api / gh repo view, 2026-08-10).

---

## 0. 한 줄 판정

**진입점 문서(README·AGENTS·CODEX·RUN·INDEX·NOTICE·SECURITY)가 가리키는 제품은 은퇴 중인 Swift/macOS 스택이고, 실제 개발선은 Rust/web이다.** 문서 드리프트는 "낡음"이 아니라 **문서를 그대로 따르면 죽은 스택을 빌드하게 되는 방향 오류**다. 리브랜딩은 사용자 노출층(ADR-0152 D2 1단계)만 끝났고 문서 산문층(2단계)은 미착수다. 열린 이슈 125건에 **중복은 사실상 0**이며, 문제는 중복이 아니라 **상태 라벨 드리프트와 은퇴 스택 백로그의 잔존**이다.

---

## 1. 축 E 체크리스트 판정

| # | 항목 | 판정 | 층 |
|---|---|---|---|
| E-1 | README가 안내하는 빌드/스택 = 실제 개발선 | **GAP (중대)** | 1층 |
| E-2 | 루트 계약 문서(AGENTS/CODEX)의 제품·스택 서술 정확성 | **GAP (중대)** | 1층 |
| E-3 | docs 진입점(INDEX)의 현재성·외부 가용성 | **GAP** | 1층 |
| E-4 | SECURITY.md 지원 버전 정책의 실재성 | **GAP (자기모순)** | 1층 |
| E-5 | NOTICE의 제품명·의존성 목록 정확성 | **GAP** | 1층(A축과 중첩) |
| E-6 | 레포/이미지/도메인 식별자 일관성 (momo↔oort↔Dawn-kim-official↔yeomyeonggeori↔oor7.com) | **GAP** | 1층 |
| E-7 | 사용자 노출 리브랜딩(ADR-0152 D2 1단계) | **PASS** | — |
| E-8 | 문서 산문 리브랜딩(D2 2단계) | **GAP (미착수, 계획대로)** | 2층 |
| E-9 | 문서 언어 일관성(외부 기여자 진입) | **GAP** | 2층 |
| E-10 | 클라이언트 트리 8개 중 "제품"의 식별 가능성 | **GAP** | 2층 |
| E-11 | 내부 오케스트레이션 산출물의 공개 노출 | **성재 결정 대기** (공개 범위) | 1층 |
| E-12 | 이슈 트래커 형상 — 중복 | **PASS** (중복 ≈0) | 2층 |
| E-13 | 이슈 트래커 형상 — 라벨/상태 위생 | **GAP** | 2층 |
| E-14 | 이슈 트래커 형상 — 연령/은퇴 스택 잔존 | **GAP** | 2층 |
| E-15 | 커뮤니티 파일 세트(buzz 대비) | **GAP** | 2층 |
| E-16 | 릴리스/버전 표면 | **GAP (0 tag / 0 release)** | 1층 |
| E-17 | 공개 시점·범위·레포명 변경 | **성재 결정 대기** | — |

집계: PASS 2 · GAP 13 · 성재 결정 대기 2 · BLOCKED 0

---

## 2. 1층 — go/no-go 재료

### E-1 · README가 은퇴 스택을 가르친다 (중대)

`README.md:150-158`(**main·engine 동일 — `git diff main origin/track/engine -- README.md` 출력 없음**):

```
## Development
Requires Swift 6.2. Common checks:
    make build
    make test
    scripts/local_gate.sh --profile docs
Local runtime setup ... in docs/RUN.md
```

- `Makefile:32,45` — `build`/`test`는 **`SWIFT_PKGS`의 `Package.swift`만** 순회해 `swift build`/`swift test`를 돈다. Rust 워크스페이스(`server-rust/Cargo.toml`)는 **한 번도 호출되지 않는다.**
- 루트에 `Cargo.toml`이 없고(`ls Cargo.toml` → No such file), Rust는 `server-rust/` 아래에만 있다.
- 실측 언급 카운트(양 브랜치 동일):

| 파일 | `server-rust|momo-rust|cargo` | `swift build|Swift 6|swift test` |
|---|---|---|---|
| `README.md` | **0** | 1 |
| `AGENTS.md` | **0** | 14 |
| `CODEX.md` | **0** | 14 |
| `docs/RUN.md` (113 KB, README의 "Local runtime setup" 목적지) | **0** | 12 |
| `docs/INDEX.md` | **0** | 0 |
| `docs/TRACKS.md` | **0** | 0 |
| `docs/DEPLOY.md` | 1 | 3 |

- Rust 빌드를 설명하는 유일한 문서는 `infra/rust/README.md`인데, **README·INDEX·CONTRIBUTING 어디서도 링크되지 않는다**(`grep -rn "infra/rust" README.md docs/*.md` → 히트는 `docs/DEPLOY.md:542`, `docs/PUSH_RELAY_RUNBOOK.md:97`, ADR-0120, 그리고 `docs/planning/*` 내부 문서뿐).
- `ROADMAP.md:6`은 이 전환을 **정직하게 인정**한다: "기존 M0~M8은 'Swift 5패키지 → macOS 공증 → iOS 스토어'를 전제로 짜였는데, 서버 재작성(ADR-0145)이 그 전제를 관통했다." → 즉 **드리프트는 인지되어 있고 로드맵에만 반영됐으며, 진입점 문서에는 반영되지 않았다.**

**결과:** 문서를 따르는 신규 기여자·셀프호스터는 은퇴 예정 Swift 스택을 빌드한다. `make build`는 **실패하지 않는다** — 성공적으로 잘못된 것을 짓는다(더 나쁘다).

### E-2 · 루트 계약 문서가 제품을 잘못 서술한다 (중대)

`AGENTS.md`는 buzz도 채택한 표준 파일명이라 **외부 AI 지원 기여자가 가장 먼저 읽는 파일**이다.

- `AGENTS.md:22` §0 제품 1줄: *"oort = ... **macOS 우선 + iOS, 공유 Swift 코어(MomoCore)**. 백엔드 **Hummingbird 2** + Centrifugo v6 + PostgreSQL 18."* → 서버는 Rust/Axum(ADR-0145), 제품 표면은 web/Tauri(ADR-0119/0133), macOS·iOS는 삭제 패킷 대기(W-S1).
- `AGENTS.md:9` 현재 위치: *"Phase 0 = 5개 Swift 패키지 `swift build` green ... 2026-07 재설계 6티켓(316/323/301/300/302/318) 머지 완료"* → 그 뒤 **2,407 커밋**, 최신 이슈는 #1223.
- `AGENTS.md:16` §-1: 트랙 워크트리를 `~/projects/momo-tracks/{uxui,engine}`로 지정 — **메인테이너 로컬 머신 경로가 루트 계약 문서에** 박혀 있다.
- `AGENTS.md:3`은 스스로 *"이 파일은 코딩 에이전트가 **momo** 리포에서"*라 쓴다(제목은 oort).
- `CODEX.md`는 AGENTS.md의 사본(동일 14/0 카운트) — 드리프트가 두 벌 존재한다.

### E-3 · docs 진입점(INDEX.md)이 외부에서 쓸 수 없다

- `docs/INDEX.md:4`: *"경로는 모두 리포 루트(**`/Users/kwakseongjae/projects/momo`**) 기준 상대경로. GitHub: `Dawn-kim-official/momo`"* — 메인테이너 홈 디렉터리 절대경로가 문서 지도 헤더에 있다.
- `docs/INDEX.md:14`: *"현재 = **M1 runtime MOMO-001~004 검증**"* — `STATUS.md` 최상단은 `ADR-0158 서버 축 (#1130, 2026-08-08)`이다. INDEX가 선언한 "가장 먼저 읽을 것 1순위"가 스스로를 46일 전 상태로 소개한다.
- `docs/INDEX.md:34`: Makefile을 "빌드 명령"으로 등재 — E-1과 같은 오도.
- `/Users/kwakseongjae` 절대경로는 추적 중인 **md 20개**에 존재(`docs/MULTI_SESSION_OPS.md`, `docs/RELEASE_PLAYBOOK.md`, `docs/INDEX.md`, `docs/cicd/00-apple-cicd-pipeline.md`, `research/07-deepdive/*` 포함).

### E-4 · SECURITY.md가 존재하지 않는 것을 지원한다고 약속한다

`SECURITY.md:10-15`:
> "oort is pre-1.0. Security fixes are provided for the **latest published `v0.x` tag** only."
> | Latest published `v0.x` tag | Yes | / | Earlier tags, branches, and untagged source snapshots | No |

실측: `git tag | wc -l` → **0**, `gh release list` → **빈 출력**. **태그가 하나도 없으므로 이 정책 하에서는 지원되는 버전이 존재하지 않는다.** 동시에 `README.md:28-30`은 운영자에게 `MOMO_IMAGE=ghcr.io/dawn-kim-official/momo:<v0.x-tag>@sha256:<digest>`로 핀하라고 지시한다 — **핀할 태그가 없다.**

### E-5 · NOTICE가 제품명과 스택을 둘 다 틀린다

`NOTICE:1-2`: `momo` / `Copyright (c) 2026 dawnkim` — 제품명 oort 아님.
나열된 "Major bundled/linked components" 24개는 **전부 Swift/JS 계열**(swift-log, hummingbird, async-http-client, postgres-nio, jwt-kit, SwiftNIO, centrifuge-swift, SwiftTerm, SwiftProtobuf …) — **Rust crate 0개**. 레포 언어 분포는 Rust 4,891,672 bytes(3위)다.
`NOTICE:32-34`에 내부 에이전트 지시가 그대로 실려 있다: `TODO(Codex): regenerate from Package.resolved via scripts/gen-notices.sh ... per AGENTS.md §9.` — Apache-2.0 §4(d) 보존 대상 법무 파일에 미완료 TODO와 내부 도구 이름이 들어 있다. (의존성 커버리지 자체의 판정은 A축)

### E-6 · 식별자 4중 불일치

| 표면 | 값 | 근거 |
|---|---|---|
| 제품명 | **oort** | README:1, CONTRIBUTING:1, SECURITY:8 |
| 레포 실소유 | **yeomyeonggeori/momo** | `gh repo view --json owner` → `{"login":"yeomyeonggeori"}`; `gh api /orgs/yeomyeonggeori` → 존재 |
| 문서·워크플로가 쓰는 경로 | **Dawn-kim-official/momo** | `README.md:24`(clone URL), `SECURITY.md:26`(advisory URL), `docs/INDEX.md:4`, `.github/ISSUE_TEMPLATE/config.yml:4,7`, `.github/workflows/publish-images.yml:19` |
| 실제 git remote | `https://github.com/Dawn-kim-official/momo.git` | `git remote -v` |
| 도메인 정본 | **oor7.com / app.oor7.com** | ADR-0152 Consequences, `docs/DEPLOY.md:542` |
| 이미지 | `ghcr.io/dawn-kim-official/momo` | `publish-images.yml:19` |
| 레포 description | *"AI agents as first-class team members in a self-hosted Slack-like messenger **for macOS and iOS**."* | `gh repo view --json description` |

- `Dawn-kim-official/momo`는 조회되지만(`gh repo view Dawn-kim-official/momo` → OK) 반환 owner는 `yeomyeonggeori` — **org 개명 리다이렉트에 의존**하고 있다. ADR-0152 D3이 이 위험을 이미 명시했다: *"repo명 변경(4d)은 org 이동 리다이렉트(yeomyeonggeori) 위에 한 번 더 쌓이므로 …"*. 공개 시 `Dawn-kim-official` 네임스페이스를 제3자가 선점하면 README·SECURITY·이슈 템플릿의 링크가 전부 타인 소유로 향한다.
- **레포 description이 제품을 "macOS and iOS"로 소개한다** — GitHub 검색·소셜 카드·기여자 첫인상이 전부 이 한 줄이다.

### E-11 · 내부 오케스트레이션 산출물의 공개 노출 (성재 결정 대기)

| 표면 | 실측 |
|---|---|
| `docs/planning/` | **275 파일 / 3.5 MB** — `JOURNAL.md`, `CURRENT_STATE.md`, `DEVIATION_LOG.md`, `handoffs/`, `research/`, 세션 브리프 |
| `research/` (루트) | **112 파일** — 유니콘 아이디에이션 방법론, 경쟁 스캔, L4 스펙 |
| 개인 실명(`성재`) 포함 md | **260 파일** |
| 로컬 절대경로(`/Users/kwakseongjae`) 포함 md | **20 파일** |
| buzz 경쟁분석·모방 카탈로그 | `docs/planning/2026-07-22-buzz-competitive-analysis.md`, `2026-07-30-buzz-reference-catalog.md`, `2026-07-28-buzz-agents-tab-delta.md`("buzz Agents 탭 대응") |
| 내부 이슈 템플릿 | `.github/ISSUE_TEMPLATE/codex-goal.md` — *"이 이슈 본문이 Codex의 작업 프롬프트(goal)가 된다"* 가 외부 방문자의 이슈 생성 선택지로 노출 |

buzz는 `docs/`에 `spec/`·`nips/`·`formal/`·`admin/`·`assets/`만 두고 세션 저널·핸드오프·이탈 로그에 해당하는 것이 **없다**.

**판정하지 않음 — 성재 결정 대기:** ① 공개 범위(전체 히스토리 공개인지, 문서 서브셋 정리 후 공개인지) ② buzz 경쟁분석 문서의 공개 여부(ADR-0145가 "패턴 인용"이라 선언한 것과 카탈로그 문서의 병존이 어떻게 읽힐지) ③ 개인 실명 표기 정책.

### E-16 · 릴리스 표면 부재

`git tag` 0 · `gh release list` 빈 출력 · 레포 PRIVATE · star 0 · `CHANGELOG.md` 없음.
buzz: `latestRelease = desktop-v0.5.8` (2026-08-08 게시), `CHANGELOG.md`·`RELEASING.md` 루트 존재, README에 플랫폼별 다운로드 파일명 표가 있다.

---

## 3. 2층 — 격차 베이스라인

### E-8 · 리브랜딩 잔여 (ADR-0152 D2 진행도)

**1단계(사용자 노출 12곳) = PASS.** engine 실측:
- `clients/desktop/**/tauri.conf.json:3` → `"productName": "oort"`
- `clients/web/index.html:9`, `clients/web-legacy` → `<title>oort</title>`
- `clients/mobile/app.json:3` → `"displayName": "oort"` (내부 `"name": "MomoMobile"`은 D1 동결층 아님, 잔여)

**2단계(문서 산문 358파일) = 미착수.** momo/oort 등장 비율:

| 파일 | momo | oort |
|---|---|---|
| `docs/BACKLOG.md` | 324 | 6 |
| `docs/RUN.md` | 323 | 38 |
| `docs/DEPLOY.md` | 190 | 9 |
| `docs/LOCAL_PR_GATE.md` | 88 | 3 |
| `docs/RELEASE_PLAYBOOK.md` | 74 | 3 |
| `AGENTS.md` | 25 | 2 |
| `README.md` | 20 | 15 |
| `ROADMAP.md` 제목 | `# momo(oort) — 릴리스 ROADMAP` | 병기 |

`momo.local` 등 dev 도메인 잔재: md/yml **20 파일**. `oor7` 언급: md **24 파일**.
→ ADR-0152가 정한 순서상 **정상적인 미완**이지만, 공개 시점에는 2단계 완료가 선행돼야 한다(D2 2단계는 "위험 0, 신호 즉시 가능"으로 이미 분류돼 있다).

### E-9 · 문서 언어 이원화

한글 라인 비율 실측(라인 중 한글 포함 비율):

| 영어(0% ko) | 한글 우세 |
|---|---|
| `README.md` 0% · `SECURITY.md` 0% · `NOTICE` 0% · `docs/INTERNAL_ALPHA.md` 2% · `docs/LOCAL_PR_GATE.md` 4% | `docs/INDEX.md` 72% · `AGENTS.md` 69% · `docs/QA_GATE.md` 65% · `CODEX.md` 59% · `docs/RUN.md` 53% · `docs/DEPLOY.md` 52% · `CONTRIBUTING.md` 42% |

**진입 경로가 언어 벽에서 끊긴다:** 영어 README → 한글 CONTRIBUTING(42%) → 한글 RUN.md(53%)/DEPLOY.md(52%)/AGENTS.md(69%). buzz는 전 문서 영어 단일이다.
(SECURITY.md는 `docs/security/README.ko.md`를 한국어 보조본으로 명시 — 이 파일만 언어 분리를 의도적으로 설계했다. 존재 확인됨.)

### E-10 · 클라이언트 트리 8개 — 무엇이 제품인가

| 트리 | 파일 수 | engine 최종 커밋 | README |
|---|---|---|---|
| `clients/macOS` | **19,218** | 2026-08-06 | 없음 |
| `clients/iOS` | **11,475** | 2026-08-06 | 없음 |
| `clients/desktop` | 3,780 | 2026-08-07 | 있음 |
| `clients/Core` | 2,502 | 2026-08-07 | 없음 |
| `clients/web` | 313 | **2026-08-09** | 있음 |
| `clients/mobile` | 299 | **2026-08-09** | 있음 |
| `clients/mobile-spike` | 71 | 2026-08-07 | 있음 |
| `clients/web-legacy` | 46 | 2026-08-08 | 있음 |

가장 활발한 두 트리(`web`, `mobile`)가 파일 수로는 **가장 작다**. 은퇴 대상(macOS+iOS = 30,693 파일)이 트리의 대부분을 차지하고 둘 다 README가 없다. `web` vs `web-legacy`, `mobile` vs `mobile-spike`의 관계를 루트 문서 어디에서도 설명하지 않는다. `docs/TRACKS.md`(정본)의 트랙 표는 엔진 소유를 `server/**, relay/**, workers/**, services/**, adapters/**, infra/**, scripts/**, clients/Core/**`로 정의 — **`server-rust/**`도 `clients/web/**`도 목록에 없다.**

### E-12~E-14 · 열린 이슈 125건의 형상

실측: `gh issue list --state open --limit 200 --json number,title,labels,createdAt,updatedAt,assignees,milestone,comments` (2026-08-10) → 125건.

**중복 — PASS.** 제목 정규화(MOMO-NNN 접두·`[area]`·기호 제거) 후:
- 완전 일치 그룹 **0**
- 토큰 Jaccard ≥ 0.70 쌍 **0**
- Jaccard ≥ 0.45 쌍 **1** — `#1066 AI 연결 표면 후속 다듬기 — #1056 리뷰 Medium/Nit 적립분` / `#1065 typing 줄 후속 다듬기 — #1059 리뷰 Medium/Nit 적립분` (동일 패턴의 **형제 후속 티켓**이지 중복 아님)

→ **트리아지 부담의 원인은 중복이 아니다.**

**라벨 위생 — GAP.**

| 지표 | 값 | 비율 |
|---|---|---|
| 라벨 0개 | 22 | 18% |
| `priority:*` 없음 | 105 | 84% |
| `area:*` 없음 | 82 | 66% |
| `type:*` 없음 | 84 | 67% |
| `status:*` 없음 | 22 | 18% |
| **`status:*` 2개 이상(모순)** | **6** | #496·#497·#500·#502·#504·#506 전부 `status:in-progress` + `status:needs-review` 동시 부착 |
| 담당자 없음 | 107 | 86% |
| 마일스톤 없음 | 93 | 74% |
| 코멘트 0 | 69 | 55% |
| 제목에 `MOMO-NNN` 접두 | 68 | 54% |

`status:` 분포: ready 44 · blocked 32 · needs-review 26 · in-progress 7 · 없음 22.

**연령·정체 — GAP.**

| 생성 연령 | 건수 | | 최종 갱신 | 건수 |
|---|---|---|---|---|
| 0–7d | 55 | | 0–7d | 55 |
| 7–14d | 20 | | 7–14d | 20 |
| 14–30d | 23 | | 14–30d | 23 |
| 30–60d | 27 | | **30d+ 무갱신** | **27** |
| 60d+ | 0 | | | |

레포 생성이 2026-06-24(47일 전)이므로 60d+ 버킷이 0인 것은 정상. **30d+ 무갱신 27건은 전량 동일 블록이다:** `#15~#41`(MOMO-030~095) + `#246`. 내용은 macOS 공증/Sparkle, iOS Xcodeproj/APNs/App Store 제출, `ci-build.yml: swift build/test`, XCUITest, TestFlight, 법무 L3/L5·L7 — 즉 **은퇴 중인 Swift/스토어 스택의 백로그**이며 전부 `status:blocked`(blocked 32건의 중앙값 연령 = 46일, 최대 46일 = 레포 개설일).

**`status:needs-review` 26건이 12~24일째 리뷰 대기.** 최고령 `#440`(24d), 그 다음 `#496~#506` 6건(22d, 위 모순 라벨과 동일 집합), `#569~#605` 6건(19d), `#839~#882` 12건(12~13d). 리뷰 파이프라인이 흐르지 않고 라벨이 상태를 반영하지 못한다.

**라벨 없는 22건은 반대로 전부 최신**(0~16d) — `#1223`, `#1222`, `#1218`, `#1208`, `#1201`, `#1177` 등. 즉 **최근 작업은 트래커 규율 밖에서 만들어지고 있다**(`area:`/`type:`/`priority:` 미부착).

**area 분포:** macos 16 · server 13 · store 11 · ios 10 · schema 6 · ci 4 · infra 2 · legal 2 · worker 1 · core 1 · **web 0**. 라벨 택소노미에 `area:web`이 정의되어 있으나(`gh label list`) **부착된 열린 이슈가 0건** — 가장 활발한 표면이 트래커에서 보이지 않는다.

### E-15 · 커뮤니티 파일 세트

| 파일 | oort | buzz |
|---|---|---|
| `README.md` | 있음 | 있음(스크린샷 4장 + 정직성 표) |
| `LICENSE` (Apache-2.0) | 있음 | 있음 |
| `NOTICE` | 있음(드리프트) | 없음 |
| `CONTRIBUTING.md` | 있음(24줄) | 있음(12절 TOC) |
| `SECURITY.md` | 있음(태그 없음) | 있음(정책 활성) |
| `CODE_OF_CONDUCT.md` | **없음** | 있음(Contributor Covenant v2.1) |
| `GOVERNANCE.md` | **없음** | 있음(Block OSS governance 링크) |
| `CHANGELOG.md` | **없음** | 있음 |
| `RELEASING.md` | **없음** | 있음 |
| `ARCHITECTURE.md` | 없음(`docs/architecture/overview.md`) | 있음(루트) |
| `TESTING.md` | **없음** | 있음 |
| `VISION.md` (+7 VISION_*) | **없음** | 있음 |
| `.env.example` | **없음** | 있음 |
| `AGENTS.md` / `CLAUDE.md` | 있음(내부 지향) | 있음 |
| `.github/CODEOWNERS` | **없음** | 있음 |
| `.github/ISSUE_TEMPLATE` | bug/chore/feature/**codex-goal**/internal-alpha-feedback (+`blank_issues_enabled: false`) | Bug report / Feature request (본문에 중복 검색 지시 포함) |
| `.github/pull_request_template.md` | 있음 | 있음 |
| 워크플로 | **5개, 전부 `workflow_dispatch`** | **17개** (`ci.yml`, `release.yml`, canary 4종, helm-chart 2종, docker, benchmark 등) |
| `deny.toml` / `renovate.json` / `rust-toolchain.toml` | 없음 | 있음 |

### buzz 기준선 요약 (실측 2026-08-10)

- `block/buzz` — public, **star 25,484 / fork 2,999**, 생성 2026-03-06, 최종 push 2026-08-09, primary language Rust, Apache-2.0.
- 열린 이슈 **500+**(조회 상한 도달), 닫힌 이슈 138, 열린 PR **200+**. → 커뮤니티 유입이 실재하고, 이슈 수가 많은 것 자체는 buzz도 마찬가지다. **차이는 수가 아니라 그 이슈들이 외부인이 연 것이라는 점**이다(oort 125건은 전량 내부 티켓, 54%가 `MOMO-NNN` 접두).
- README 구조: 중앙정렬 타이틀 + 한 줄 포지셔닝 + **6개 문서로 가는 내비게이션 바** + 스크린샷 4장 + "What is this, really?" + "Stuff you do in Buzz" + **`✅ Works today / 🚧 Being wired up / 💭 Strong opinions, pending code` 3열 정직성 표** + **청중별 4갈래 Getting started**("I just want to try the app" / "I want my own hosted relay"(Railway 원클릭) / "I work at Block" / "I want to build & run from source") + Quick start + Windows 전제조건 + ASCII 아키텍처.
- buzz의 time-to-hello 약속(문서 실측): `git clone && cd buzz` → `. ./bin/activate-hermit` → `just setup && just build` → 매일은 `just dev` → *"Relay on `ws://localhost:3000`. Desktop app pops up. **You're in.**"* — **명령 4개, 조건부 분기 0개.** 프로덕션은 별도로 `deploy/compose/` 번들을 가리키고, 루트 `docker-compose.yml`은 "day-to-day development only"라고 **스스로 범위를 선언**한다.
- buzz README는 완성되지 않은 것을 숨기지 않는다: 모바일·워크플로 승인 게이트·허들 수명주기를 🚧로, 푸시 알림·평판을 💭로 표시하고 각주로 *"Please do not plan your compliance program around the 💭 column yet."*
- CONTRIBUTING: 행동강령 이메일(`conduct@buzz-relay.org`), 중복 검색 선행 지시, AI 지원 PR 명시 허용, Conventional Commits + squash-merge 규칙, "새 event kind / MCP tool / API endpoint 추가법" 3개 하우투.

---

## 4. 신규 방문자 첫 30분에 만나는 모순 — 발생 순서대로

| # | 지점 | 방문자가 보는 것 | 실제 | 근거 |
|---|---|---|---|---|
| 1 | GitHub 레포 카드 | *"...messenger **for macOS and iOS**"* | 제품 표면은 web + Tauri desktop, macOS/iOS는 삭제 대기 | `gh repo view --json description` |
| 2 | `README.md:24` | `git clone .../Dawn-kim-official/momo.git` | 실소유 `yeomyeonggeori/momo`, 개명 리다이렉트 의존 | `git remote -v`, `gh repo view --json owner` |
| 3 | `README.md:1` vs 레포/이미지/NOTICE | 제품은 **oort** | 레포·이미지·NOTICE·환경변수는 **momo** | `NOTICE:1`, `publish-images.yml:19` |
| 4 | `README.md:28-30` | *"Pin the release as `...:<v0.x-tag>@sha256:<digest>`"* | 태그 0개, 릴리스 0개 | `git tag`, `gh release list` |
| 5 | `README.md:152` | *"Requires Swift 6.2"*, `make build` | 개발선은 Rust(`server-rust/`), 루트에 `Cargo.toml` 없음 | `Makefile:32`, `ls Cargo.toml` |
| 6 | `README.md:13-16` → `infra/prod/docker/momo.Dockerfile` | "one multi-command image" | 그 Dockerfile은 **Swift 이미지**(`ARG SWIFT_IMAGE=swift:6.2-noble`, MomoServer/OutboxRelay/AgentWorker/LinkShort를 `swift build`) — 라이브가 쓰는 Rust 이미지가 아니다 | `momo.Dockerfile:6,10,25-38` (전말은 B축) |
| 7 | `SECURITY.md:10-15` | "latest published v0.x tag만 지원" | 지원 대상이 실재하지 않음 | `git tag` = 0 |
| 8 | `SECURITY.md:26` | advisory 링크가 `Dawn-kim-official` | 개명 전 네임스페이스 | — |
| 9 | `CONTRIBUTING.md` | 영어 README 다음인데 **한국어**(42% ko) | — | 언어 실측 |
| 10 | `CONTRIBUTING.md:24` | *"`scripts/check_spm_licenses.sh`로 THIRD_PARTY_NOTICES 재생성"* + GPL/AGPL fail-closed 약속 | SwiftPM 그래프 9개만 검사(Rust/npm 정본 미커버 — A축) · 열린 이슈 **#1201**이 *"check_spm_licenses.sh가 base부터 red — 전 프로파일 게이트 차단"* | `CONTRIBUTING.md:24`, issue #1201 |
| 11 | `CONTRIBUTING.md:20` | *"UI 변경은 `.claude/skills/momo-design-taste` 규율의 검토를 거칩니다"* | 외부 기여자는 Claude Code 스킬을 실행할 수 없다 — 통과 불가능한 수용 조건 | `CONTRIBUTING.md:20` |
| 12 | `AGENTS.md:22` | *"macOS 우선 + iOS, 공유 Swift 코어, 백엔드 Hummingbird 2"* | Rust/Axum + web | — |
| 13 | `AGENTS.md:16` | 워크트리 경로 `~/projects/momo-tracks/{uxui,engine}` | 메인테이너 로컬 경로 | — |
| 14 | `docs/INDEX.md:4` | 경로 기준이 `/Users/kwakseongjae/projects/momo` | — | — |
| 15 | `docs/INDEX.md:14` | *"현재 = M1 runtime MOMO-001~004 검증"* | `STATUS.md` 최상단 = #1130 / 2026-08-08, 2,407 커밋 | `STATUS.md:3` |
| 16 | `docs/RUN.md`(README의 로컬 실행 목적지) | 113 KB, 53% 한국어, `swift build` 12회, `cargo` **0회** | — | — |
| 17 | `clients/` | 8개 트리, 5개만 README, 최대 트리 2개(macOS·iOS, 30,693 파일)는 은퇴 대상 | — | — |
| 18 | 이슈 탭 "New issue" | Blank 비활성 + `Codex goal (작업 티켓)` 선택지 — *"이 이슈 본문이 Codex의 작업 프롬프트가 된다"* | 외부인이 쓸 수 없는 내부 템플릿 | `.github/ISSUE_TEMPLATE/config.yml:1`, `codex-goal.md` |
| 19 | 이슈 목록 | 125건 중 68건이 `MOMO-NNN:` 접두, 84%는 우선순위 없음, `area:web` 0건 | 외부인이 "무엇을 도울 수 있나"를 읽을 수 없음 | 실측 |
| 20 | `docs/planning/` | 275 파일 세션 저널·이탈 로그·핸드오프 + buzz 경쟁분석 3종 | — | 실측 |

---

## 5. 상위 발견 3개

1. **진입점 문서 전체가 은퇴 스택을 가리킨다.** README·AGENTS·CODEX·RUN.md의 `cargo|server-rust` 언급은 **양 브랜치 모두 0**이고 `swift build` 계열은 39회다. Rust 빌드 문서(`infra/rust/README.md`)는 루트 어디에서도 링크되지 않는다. 문서를 따르면 실패하는 게 아니라 **성공적으로 잘못된 것을 짓는다**. `ROADMAP.md:6`이 이 전환을 이미 인정했다는 점에서 이것은 인지 실패가 아니라 **반영 누락**이며, 반영 대상은 파일 6개 수준이다(README·AGENTS·CODEX·RUN·INDEX·TRACKS).

2. **정체성이 4중으로 갈라져 있고 그중 하나는 만료 위험이다.** 제품 `oort` / 레포 실소유 `yeomyeonggeori/momo` / 문서·워크플로·advisory 링크 `Dawn-kim-official` / 도메인 `oor7.com`. `Dawn-kim-official` 경로는 org 개명 리다이렉트로만 살아 있고 — ADR-0152 D3이 이미 지목한 위험 — 공개 후 제3자가 그 네임스페이스를 선점하면 README의 clone URL과 SECURITY.md의 취약점 신고 링크가 타인에게 향한다. 여기에 `SECURITY.md`가 "최신 `v0.x` 태그만 지원"이라 선언하면서 태그가 0개인 자기모순이 겹친다.

3. **이슈 125건의 문제는 중복이 아니라 은퇴 스택 백로그의 잔존과 상태 라벨 드리프트다.** 중복 의심 쌍은 정규화 후 **0**(Jaccard 0.45에서도 1쌍, 그마저 형제 후속). 대신 30일 무갱신 27건은 **전량** macOS 공증·iOS 스토어·`swift build` CI 백로그(#15~#41)이고, `status:needs-review` 26건이 12~24일째 멈춰 있으며 그중 6건은 `in-progress`와 `needs-review`를 동시에 달고 있다. 반대로 최근 22건은 라벨이 아예 없다 — 현재 작업이 트래커 규율 밖에서 흐른다. `area:web`이 붙은 열린 이슈는 **0건**이다.

---

## 6. 성재 결정 대기 (판정하지 않음)

- **공개 범위**: `docs/planning/`(275파일)·`research/`(112파일)·개인 실명 260파일·로컬 절대경로 20파일을 그대로 공개할지, 서브셋만 공개할지, 히스토리를 정리할지.
- **buzz 경쟁분석 3종**(`2026-07-22-buzz-competitive-analysis.md`, `2026-07-30-buzz-reference-catalog.md`, `2026-07-28-buzz-agents-tab-delta.md`)의 공개 여부 — ADR-0145의 "패턴 인용만" 입장과 병존했을 때의 읽힘.
- **레포명·이미지 경로 변경 시점**(ADR-0152 D2 4단계 d — D3에 따라 성재 신호 필요).
- **문서 언어 정책**: 영어 단일화인지, 영/한 병기인지(`docs/security/README.ko.md` 패턴 확장인지).
- **런칭 정의**: 태그·CHANGELOG·릴리스 아티팩트를 갖춘 `v0.1`을 공개 조건으로 볼지.

---

## 7. 재현 명령 (전부 읽기 전용, 실행됨)

```sh
git diff --stat main origin/track/engine -- README.md            # 출력 없음(동일)
grep -c "server-rust\|cargo\b" README.md AGENTS.md docs/RUN.md    # 0 0 0
grep -c "swift build\|Swift 6" AGENTS.md CODEX.md docs/RUN.md     # 14 14 12
git tag | wc -l ; gh release list                                  # 0 ; (빈 출력)
git remote -v ; gh repo view --json owner,description
gh issue list --state open --limit 200 --json number,title,labels,createdAt,updatedAt,assignees,milestone,comments
gh repo view block/buzz --json stargazerCount,latestRelease,codeOfConduct,issueTemplates
gh api /repos/block/buzz/git/trees/HEAD --jq '.tree[]|select(.type=="blob").path'
gh api /repos/block/buzz/contents/.github/workflows --jq '.[].name'   # 17개
find docs/planning -type f | wc -l                                 # 275
grep -rl "/Users/kwakseongjae" --include="*.md" . | wc -l           # 20
```
