# Project Work Console 구현 계획 — 전용 관제 화면과 T1/T2/T3 표식

- 날짜: 2026-08-11
- 대상 goal: [#1289 Work Console v1](https://github.com/yeomyeonggeori/oort/issues/1289)
- 트랙: UXUI (`clients/web`, Tauri는 같은 웹 번들을 사용)
- 검증 등급: `[web]` + design review + merge-tree verification
- 상태: 구현 계약. 이 문서는 ADR을 새로 만들거나 기존 ADR의 상태를 바꾸지 않는다.

## 0. 결론

#1289의 안전한 첫 슬라이스(G1)는 **현재 Rust API가 이미 제공하는 `WorkSession`·`WorkHost`와 읽기 전용 observer terminal을 전역 `/work` 화면으로 조립하는 것**이다. 채널 우측 패널을 열지 않아도 워크스페이스 전체 세션의 실행 위치, 상태, 담당자, 대화 맥락과 터미널 관전을 한곳에서 볼 수 있게 한다.

다만 사용자가 말한 “프로젝트별 repo/worktree/branch와 실제 GUI까지 보는 Codex View형 화면” 전체가 이미 가능한 것은 아니다. 현재 read projection에는 Project, repository, worktree, branch, cwd가 없으며 이를 session label이나 channel 이름에서 추측하면 거짓 UI가 된다. 특히 ADR-0143 D4는 Project 계층을 현 단계에서 명시적으로 유보했다. 따라서 #1289는 **Project-ready한 전용 셸**을 만들되 “프로젝트별”이라고 부르거나 가짜 그룹을 만들지 않는다. 1급 Project는 별도 ADR이 Accepted된 뒤 engine과 UXUI goal로 잇는다.

레퍼런스 배선의 한 줄 판정은 다음과 같다.

> **Orca의 master-detail 정보 구조 + Herdr의 host-owned PTY/reattach 개념 + oort ADR-0125의 host-direct attach 보안 경계**를 조합한다. 외부 UI, 코드, 에셋, dependency는 #1289에 복사하거나 추가하지 않는다.

## 1. 이전 터미널/ADE 리서치 복기

이번 화면은 새 방향이 아니라 다음 결정과 실측이 누적된 결과다.

1. `2026-07-15-workspace-first-superapp-shell.md`는 raw terminal 한 장이 아니라 task별 workspace/branch/process/transcript/diff/review가 필요하다고 정리했다. 동시에 PTY·credential·approval 경계가 ADR보다 먼저 UI로 굳어지는 것을 금지했다.
2. ADR-0114는 terminal과 채널 thread bridge를 병행하고, 실제 process와 provider credential은 사용자 실행 호스트에만 두도록 Accepted했다. 서버에는 기본적으로 큐레이션된 진행과 원장만 남고 raw terminal은 저장하지 않는다.
3. ADR-0125는 `work_host.type = app | workd | cloud`의 T1/T2/T3 단일 표면과, 원격 terminal byte가 서버를 지나지 않는 direct attach를 Accepted했다.
4. ADR-0139는 PTY 소유자를 host로 유지하고, host-local ring buffer replay로 재부착하는 계약을 Accepted했다. 서버가 terminal raw byte를 저장하지 않는 경계는 유지된다.
5. ADR-0143은 Workstream을 목표, WorkSession을 1회 Run으로 분리했지만 D4에서 **Project 계층은 필요 시 개별 재론**하도록 유보했다.
6. `2026-07-24-t3code-competitive-analysis.md`는 task thread와 worktree를 1급 UI로 드러내는 패턴의 가치를 확인했지만, oort의 팀·멤버십·승인 원장을 우회하는 별도 코드 GUI가 되어서는 안 된다고 판정했다.
7. `2026-08-02-herdr-runtime-analysis.md`와 `2026-08-06-herdr-spike.md`는 Herdr를 workd 대체재나 상태 진실 원천으로 채택하지 않기로 했다. 화면 tail 휴리스틱은 blocked 재현율이 낮았고 비대화형 `codex exec`를 idle로 오분류했다. 반면 host가 PTY를 계속 소유하는 구조, reattach, 상태의 자기보고와 “왜 이 상태인가” 설명 문법은 참고할 가치가 있다.
8. ADR-0154는 대화 공간의 한 줄 summary, 클릭 후 ADE drawer, terminal 별도 detail이라는 3층 표면을 Accepted했다. `/work`는 대화 summary나 drawer를 없애는 화면이 아니라, 그 세 번째 detail을 전역 진입점으로 승격하는 additive surface다. 세션의 원장 홈이 채널 thread라는 계약도 바꾸지 않는다.

## 2. 현재 제품 상태와 실제 공백

| 사용자 질문 | 현재 근거 | 판정 |
|---|---|---|
| 전용 작업/terminal 탭이 있는가 | `clients/web/src/app/App.tsx`에는 `/work` route가 없고, `Sidebar.tsx`에도 전용 진입점이 없다 | **없음**. #1289가 채울 공백 |
| 전체 작업을 한 화면에서 보는가 | `AdeDrawer.tsx`는 전역 요약·관제, `WorkPanel.tsx`는 채널 맥락의 세션 패널이다 | 부분 구현. master-detail 전용 화면은 없음 |
| 실제 terminal을 보는가 | `WorkSessionDetail.tsx`가 `ObserverTerminal.tsx`를 렌더하고 host-direct attach capability를 사용한다 | 읽기 전용 관전은 코드상 존재. controller 입력은 없음 |
| T1/T2/T3를 구분할 수 있는가 | `WorkHost.type`과 core의 host tier/durability 사상이 이미 있다 | 데이터는 있음. 전용 화면의 일관된 표식이 없음 |
| 프로젝트/repo/worktree별로 묶을 수 있는가 | `packages/momo-core/src/lib/api.ts`의 `WorkSession`·`WorkHost`에 Project/repo/worktree/branch/cwd 필드가 없다 | **불가능**. 추론 금지, 후속 ADR+engine 필요 |
| Workstream을 프로젝트 대용으로 쓸 수 있는가 | Workstream은 goal layer이며 Project가 아니다. Rust surface 미제공으로 capability가 꺼져 있다 | 대용 금지. #1289 의존성에서 제외 |
| 웹과 Tauri가 같은 화면을 쓰는가 | `clients/desktop`은 `clients/web/dist`를 감싼다 | `/work`를 web에 한 번 구현하면 두 표면의 코드가 갈라지지 않음 |

현재 projection으로 정직하게 답할 수 있는 “어디서/지금/무엇을”은 다음까지다.

- 어디서: host type, host 표시명, channel
- 지금: session lifecycle/derived observation 상태와 시작·종료 시각에서 계산한 경과 시간
- 무엇을: session label, tool, 담당 member, lifecycle/tool event detail
- 들어가기: 발원 channel thread와 observer-only terminal

Project명, repository, worktree, branch, cwd, 현재 shell command는 현재 계약으로 답할 수 없다.

## 3. 외부 레퍼런스 판정과 배선

| 레퍼런스 | 확인한 성격 | 채택 | 채택하지 않음 |
|---|---|---|---|
| [Orca](https://github.com/stablyai/orca) | 병렬 agent fleet용 ADE, MIT | session list → selected detail의 master-detail IA, 여러 작업의 위치·상태를 먼저 스캔하는 관제 문법 | 소스/UI/에셋 복사, Orca 자체를 runtime dependency로 동봉 |
| [Herdr](https://github.com/herdrdev/herdr) | Rust terminal multiplexer, v0.8.0부터 Apache-2.0 | PTY와 replay는 host가 소유, attach client는 갈아 끼울 수 있다는 개념; 상태 자기보고와 explain 문법 | workd 대체, unauthenticated local API 수용, 화면 tail 감지를 상태 SoT로 사용, #1289 코드 재사용 |
| [Conductor](https://www.conductor.build/docs/concepts/git-worktrees) | worktree를 workspace로 다루는 공개 제품 문법. 소스 재사용 후보가 아닌 proprietary reference | workspace/worktree/terminal/review를 한 작업 맥락으로 묶는 정보 구조만 참고 | 코드·에셋·프로토콜 재사용, 현재 데이터가 없는데 Project/worktree를 먼저 그리는 것 |
| [t3code](https://github.com/pingdotgg/t3code) | Codex 중심 GUI, MIT | task thread와 worktree를 별개 shell 장식이 아닌 1급 작업 맥락으로 보여주는 경쟁 신호 | 별도 agent runtime 또는 #1289 dependency로 도입 |

권장 데이터·바이트 배선은 아래와 같다.

```text
/work master list
  └─ Rust read projection: WorkSession + WorkHost + directory + channel
       └─ selected WorkSessionDetail
            ├─ lifecycle/tool event와 발원 thread 이동
            └─ observer attach capability 발급
                 └─ client ↔ work host direct WebSocket
                      └─ host-owned PTY/ring buffer
```

서버는 세션·권한·수명주기 원장을 제공하지만 raw PTY byte를 저장하거나 중계하지 않는다. 이 경계가 Herdr식 host ownership을 oort에 연결하는 지점이며, 실제 신뢰 경계는 ADR-0125가 결정한 capability + direct attach다.

## 4. G1 — #1289 Work Console v1 계약

### 4.1 정보 구조

- 전역 route: `/work`
- 전역 sidebar 진입점: `작업 콘솔`
- master: 워크스페이스 전체 WorkSession 목록. 검색 파라미터 `?session=<id>`로 선택 상태를 링크할 수 있다.
- detail: 기존 `WorkSessionDetail`을 재사용한다. 새 terminal 구현을 복제하지 않는다.
- narrow width: master에서 detail로 한 단계 들어가고 뒤로 돌아온다.
- wide width: master와 detail을 동시에 둔다.
- 발원 대화 이동: `channelId`, `rootMessageId`, `sessionId`라는 기존 사실만 사용한다.

Project가 없는 동안 master의 정본 단위는 **작업 세션**이다. channel은 대화 맥락으로 표시할 수 있지만 Project 그룹으로 이름을 바꾸지 않는다.

### 4.2 T1/T2/T3 표식 계약

실행 위치와 실행 상태는 다른 축이다. tier badge는 “어디서 실행되는가”, state chip은 “지금 어떤 상태인가”만 답한다. 온라인 여부, 과금 여부, 작업 성공 여부도 tier badge에 섞지 않는다.

| `work_host.type` | 항상 보일 텍스트 | 보조 아이콘 | 의미 | 금지할 추론 |
|---|---|---|---|---|
| `app` | `T1 · 데스크톱 앱` | 기기 | app host에 붙은 device-bound 실행 | viewer의 현재 기기, `running`, 안전함, 동기화됨을 의미하지 않음 |
| `workd` | `T2 · 셀프호스트` | server/host | 사용자가 운영하는 persistent workd | cloud 또는 oort 관리형으로 부르지 않음 |
| `cloud` | `T3 · 클라우드` | **cloud icon 필수** | cloud host에서 실행 | 활성 과금, online, 작업 성공을 의미하지 않음 |
| host 없음/미지원 값 | `실행 위치 확인 필요` | 경고/unknown | 확인 가능한 host 사실이 없음 | session label로 tier를 추측하지 않음 |

T3 표식은 compact row에서도 생략하지 않는다. 모든 표식은 icon+text이며 색만으로 구분하지 않는다. cloud를 눈에 띄게 하더라도 별도 raw color를 만들지 않고 기존 design token을 사용한다.

### 4.3 상태와 작업 설명

- lifecycle은 현행 core 모델의 `running | idle | orphaned | ended`와 기존 derived status 함수를 재사용한다.
- blocked/attention을 보여줄 때는 structured lifecycle/tool event에서만 도출한다. terminal 화면 문자열을 긁어 상태를 만들지 않는다.
- “무슨 작업 중인가”는 label → tool → 기존 fallback 순으로 정직하게 표시한다.
- 담당자는 `memberId`를 directory projection으로 해석하고, 찾지 못하면 확인 불가 상태를 숨기지 않는다.
- 목록의 시각은 서버가 준 `startedAtMs` 또는 `endedAtMs`를 `시작 HH:mm`·
  `종료 HH:mm`으로만 명시한다. 경과 시간은 기존 상세가 `useTickingNow`로
  보여주며, 목록 시각을 “최근 활동 시각”이나 “마지막 출력 시각”이라고 부르지 않는다.

### 4.4 상태·접근성·디자인 수용 기준

- loading: 목록과 detail의 위치가 크게 흔들리지 않는 명시 상태
- empty: “실행 중인 것 없음”과 “기록 자체 없음”을 현재 query 계약이 구분할 수 있는 범위에서만 안내
- error: 오류 원인 요약과 retry
- offline: 네트워크가 끊겼음을 명시하고 stale 정보를 live라고 표현하지 않음
- keyboard: sidebar, session row, 뒤로가기와 발원 대화 이동이 focus-visible로 조작 가능.
  narrow detail에서 뒤로가면 방금 고른 session row로, 유효하지 않은 selection을
  닫으면 첫 번째 남은 session row로 focus가 복귀한다.
- selection: URL과 시각 선택이 일치하고 text/ARIA로도 드러남
- light/dark, compact/wide에서 cloud tag와 상태 chip이 잘리거나 색에만 의존하지 않음
- 기존 design token과 flat list 문법을 쓰고, 외부 제품을 닮은 장식용 카드·gradient를 만들지 않음

### 4.5 #1289 명시적 비범위

- Project/repository/worktree/branch/cwd schema 또는 추론
- Workstream Rust API 복구
- interactive controller PTY, stdin, resize, kill, writer lease
- Rust `momo-workd` 구현/서명 프로토콜 변경
- GUI/VNC/browser/app preview
- 외부 dependency·코드·에셋 반입
- `track/uxui → main` merge

## 5. G1 뒤의 결정 게이트

### 5.1 First-class Project

Project는 단순 새 필드가 아니다. `workspace → channel → membership` 권한 모델에 새 상위/교차 계층을 넣고, Workstream과 Project의 관계를 정하며, repo metadata의 노출 범위를 결정한다. ADR-0143 D4의 유보를 뒤집는 제품·DB·권한 결정이므로 **새 ADR의 Accepted 상태가 구현 선행조건**이다.

후속 ADR이 최소한 답해야 할 질문은 다음과 같다.

- Project는 workspace 아래에 있고 여러 channel/Workstream을 묶는가, 아니면 channel에 종속되는가
- Project 접근 권한은 workspace membership, channel membership, 별도 membership 중 무엇에서 파생되는가
- 서버가 보관해도 되는 safe projection은 무엇인가
- repo URL, 로컬 절대경로, cwd, credential은 어떻게 비유입을 강제하는가
- Workstream과 WorkSession은 `project_id`를 직접 갖는가, anchor 관계에서 파생되는가
- branch/worktree 이름 공개가 channel membership 경계와 어떻게 정합하는가
- 삭제·이동·보관 시 원장과 RLS FORCE의 의미는 무엇인가

방향 가설은 opaque project ID + 사용자가 정한 표시명 + 최소 repo alias/fingerprint와 branch/worktree label까지만 서버 projection으로 두고, 절대경로와 credential은 host-local로 유지하는 것이다. 이는 **결정안이 아니라 ADR에서 검증할 가설**이다.

### 5.2 Rust workd

Rust workd는 ADR-0125·0139의 Accepted 방향과 기존 [#1256](https://github.com/yeomyeonggeori/oort/issues/1256) 계보에서 engine goal로 진행한다. #1289 UI가 terminal runtime을 새로 발명하거나 Herdr를 사이드카로 넣지 않는다. Rust 이식이 host registration, Ed25519/body binding, attach capability, replay splice 등 보안 경계를 바꾸면 기존 Accepted ADR로 충분한지 먼저 검토하고, 벗어나는 부분은 새 Accepted ADR 전까지 구현하지 않는다.

### 5.3 Controller PTY

ADR-0114·0125는 사람이 terminal에 입력하는 제품 방향을 허용하지만 현재 web 표면은 observer-only다. stdin/resize/kill을 열려면 observer capability와 분리된 controller scope, 단일 writer/writer lease, revoke, audit, ownership/takeover를 검증해야 한다. 현 Accepted 계약으로 이 권한 경계를 완전히 닫을 수 없으면 별도 ADR을 Accepted한 뒤 engine → UXUI 순으로 구현한다. #1289의 terminal을 interactive라고 표시하지 않는다.

### 5.4 GUI/App preview

GUI/VNC/browser preview는 현재 Accepted protocol이 없다. frame transport, input control, clipboard/file transfer, redaction, recording, bandwidth, sandbox escape와 mobile fallback을 결정하는 별도 ADR이 필요하다. raw frame도 terminal byte와 같이 server 비유입으로 할지부터 결정해야 하며, #1289 terminal detail에 빈 탭이나 가짜 버튼을 먼저 만들지 않는다.

## 6. Goal DAG — 1 issue = 1 goal = 1 PR

| 순서 | goal | 트랙 | 선행 | 산출물/종료 조건 | 성재 체크포인트 |
|---|---|---|---|---|---|
| **G1** | **#1289 Work Console v1** | UXUI | Accepted ADR-0114/0125/0139/0154 | `/work`, sidebar, master-detail, tier/state 분리, observer detail, 상태·접근성·capture·web/merge gate | light/dark × compact/wide 일괄 피드백 |
| G2 | Project 계약 ADR | docs/기획 | G1 사용성 피드백 | 계층·권한·safe projection·RLS·삭제/이동 계약. **Accepted 전 구현 없음** | ADR 승인 |
| G3 | Project read model/API | 엔진 | G2 Accepted | 신규 migration, RLS FORCE, Rust REST/read projection, 실제 로그인 격리 verifier | API/보안 리뷰 |
| G4 | Project별 Work Console | UXUI | G3 | Project → Workstream → Run 계층, repo/worktree safe metadata, filter/deep link | 프로젝트 관제 화면 일괄 피드백 |
| G5 | Rust workd direct attach 폐곡선 | 엔진 | 기존 #1256 계보, 보안 계약 확인 | signed host lifecycle, host-owned PTY/replay, observer attach E2E | runtime evidence 리뷰 |
| G6 | Controller PTY | 엔진 → UXUI | G5, controller 권한 계약 Accepted | controller capability/writer lease/revoke/audit 후 stdin/resize/kill UI | 위험 동작·권한 일괄 검수 |
| G7 | GUI/App preview ADR와 vertical slice | 기획 → 엔진 → UXUI | 별도 ADR Accepted | 최소 1개 view-only preview부터 frame/input 경계별 분리 | preview 보안·UX 승인 |

G2~G7은 이 문서가 이슈를 발급하거나 착수를 승인한 것이 아니다. 발급 시 각각 하나의 GitHub Issue, 별도 branch/worktree, 하나의 PR로 나누고, UXUI PR은 `track/uxui`, engine PR은 `track/engine`을 base로 한다. `track/* → main`은 성재의 명시 승인 뒤에만 진행한다.

## 7. #1289 검증 계획과 피드백 체크포인트

### 7.1 자동 검증

1. focused Vitest
   - host type 네 경우의 tag text와 unknown fail-closed 사상
   - `?session=<id>` 주소 생성과 identity 정규화
2. 전용 Playwright gate (`gate:work-console`)
   - delayed initial loading과 empty/offline/initial error
   - host/channel/directory 실패의 blocking 또는 fail-closed fallback
   - cached session/host refetch 실패 때 row와 detail 보존 + stale 경고
   - status와 tier tag 분리, T3 cloud SVG, unknown 문구
   - `?session=<id>` reload와 invalid/deleted session fallback
   - narrow master↔detail, 뒤로가기·invalid fallback의 focus 복귀
   - terminal의 `읽기 전용` chip/title과 stdin/resize/kill 컨트롤 부재
3. web hard gate
   - `scripts/local_gate.sh --profile web`
4. merge-tree hard gate
   - `scripts/verify_merge_tree.sh`
5. design mechanical gate
   - `scripts/design_preflight_web.sh`
6. 문서 gate
   - `scripts/local_gate.sh --profile docs`

### 7.2 화면 검수

- UXUI worktree 빌드 원본 경로, branch, SHA를 함께 고지한다.
- light/dark × compact/wide 네 장면을 동일 fixture로 캡처한다.
- T1, T2, T3, unknown row가 한 화면에서 icon+text로 구분되는지 확인한다.
- running/idle/orphaned/ended 상태 변화가 tier tag를 바꾸지 않는지 확인한다.
- keyboard-only로 sidebar → session → detail → 뒤로가기/발원 대화 이동을 확인한다.
- terminal은 “읽기 전용”으로 표시되고 입력 가능하다는 인상을 주지 않는지 확인한다.
- design review에서 Blocker 0을 확인한 뒤 성재에게 한 묶음으로 피드백을 요청한다.

### 7.3 중간 승인 지점

- 체크포인트 A: G1 화면 capture와 실제 desktop/Tauri 동작을 묶어 검수
- 체크포인트 B: Project ADR 초안을 G1 피드백과 함께 검토하고, 성재가 Accepted한 뒤 G3 착수
- 체크포인트 C: workd observer E2E evidence가 생긴 뒤 controller 권한 계약 검토
- 체크포인트 D: controller와 GUI preview는 서로 다른 보안 표면으로 따로 승인

## 8. 알려진 공백과 `runtime-unverified`

| 심각도 | 공백 | #1289 처리 | 해소 조건 |
|---|---|---|---|
| 높음 | Project/repo/worktree/branch/cwd projection이 없어 “프로젝트별” 그룹을 만들 수 없음 | 거짓 추론 금지, session master만 제공 | G2 Accepted → G3 → G4 |
| 높음 | observer terminal의 실제 T1/T2/T3 host matrix E2E가 이 goal에서 보장되지 않음 | UI와 기존 attach 경로만 재사용. 실행하지 못한 조합은 `runtime-unverified`로 보고 | G5 runtime verifier와 실제 host matrix |
| 높음 | controller PTY가 없어 실제 shell 입력·resize·kill을 할 수 없음 | 명시적으로 observer-only | G5 + G6 권한/런타임 폐곡선 |
| 중간 | ADR-0139 운영 주석상 T3 접합은 기본 비활성이고 실제 cloud session 데이터가 없을 수 있음 | cloud row fixture와 렌더 계약 검증, live T3라고 주장하지 않음 | T3 활성 환경의 실제 session evidence |
| 중간 | Workstream Rust surface가 제공되지 않아 Project 대신 goal 계층을 연결할 수 없음 | Workstream query를 #1289 의존성에서 제외 | 별도 engine parity goal |
| 중간 | web bundle 검증만으로 Tauri 패키징·OS 창·deep link 전체를 닫지 못함 | 동일 bundle 정합을 검증하고 desktop manual 결과를 별도 표기 | UXUI worktree의 Tauri 실기동 검수 |
| 중간 | GUI/App preview protocol과 구현이 없음 | 빈 UI를 만들지 않음 | G7 ADR + vertical slice |

`runtime-unverified`는 “기능이 동작한다”는 표현으로 덮지 않는다. 각 PR은 실제로 실행한 환경, host type, capability, 브라우저/Tauri 여부를 evidence에 적고, 실행하지 못한 조합만 좁게 남긴다.

## 9. 최종 판정

#1289는 사용자가 요청한 전용 관제 장소의 **실제 첫 구현**이며, 현재 계약만으로 만들 수 있는 범위를 끝까지 닫는다. 동시에 Project·interactive terminal·GUI를 한 PR에 섞어 보안과 제품 경계를 우회하지 않는다. G1 화면 검수 후 다음 우선순위는 Project ADR이 아니라 **실사용에서 Project grouping이 정말 최우선 공백인지 확인하는 것**이다. 최우선으로 확인되면 ADR-0143 D4를 명시적으로 재론하고 G2→G4를 진행한다. terminal 입력 신뢰성이 더 큰 공백이면 기존 ADR-0125 계보의 G5→G6을 먼저 진행한다.
