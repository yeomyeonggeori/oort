# GPT 작업 런타임 설계 가설 대조 검토 (2026-07-29, Fable)

- 입력: 성재가 전달한 GPT 설계 문서("momo 제품 방향 및 실행 아키텍처 고도화 검토") + 성재 구두 지시 2건
- 성재 구두 지시(문서보다 우선):
  1. **"E2B는 아마 사실상 폐기일 가능성이 높아."**
  2. **"셀프호스팅 유저는 의존성이 없어야 하는데 스스로 세팅은 쉬워야 한다. 워크스페이스 유저는 쉽게 우리를 통해 cloud 자원을 구매해 사용할 수도, 필요하면 본인이 호스팅해서 연동할 수도 있다."**
- 방법: 문서 §0 요구대로 각 제안을 ①이미 반영 ②충돌/수정 필요 ③도입 가치 높음 ④현 단계 과도 로 분류. 근거는 코드 경로·ADR.

## 0. 한 줄 결론

GPT 문서의 **격리·관찰·연속성 원칙 절반은 oort에 이미 있고**(용어만 다르다), **핵심 신규 기여는 둘**이다 — (a) Workstream(목표)과 실행 단위의 분리, (b) actor-independent 인계. **가장 큰 충돌도 둘**이다 — (a) `work_session.member_id` 소유권 결합(현행 연속성이 사람에 묶여 있음), (b) "local-first" 표현이 oort 하드 불변식(Postgres=SoT·단일 쓰기경로)과 정면 충돌. E2B 폐기는 **스키마 1곳 + 클라이언트 1곳**의 교체 문제이지 설계 붕괴가 아니다 — ADR-0140이 provider 경계를 이미 일반형으로 잘라놨다.

## 1. 문서 §26 요구 표

| 제안 | 현재 구현 상태 | 코드 근거 | 충돌 또는 Gap | 권장 조치 | 우선순위 |
|---|---|---|---|---|---|
| **Workstream 도입** | ③ 없음. 가장 가까운 것은 스레드 앵커(`work_session.root_message_id`, ADR-0114 "세션=스레드")지만 이는 실행 1건의 앵커지 목표가 아님 | `019_work_session.sql:16` | 목표·수용기준·담당 이력을 담는 타입 부재. 현재 "목표"는 GitHub Issue(개발 메타)에만 존재 — 제품에는 없음 | 신규 ADR로 도입. 스레드를 대체하지 말고 **스레드에 워크스트림을 앵커**(대화 문법 유지) | **P1** |
| **Workstream/Task 분리** | ③ 해당 타입 자체가 없어 충돌도 없음 | 동상 | `work_session`은 문서의 Run에 해당. Task 계층은 부재 | 첫 슬라이스에서는 Task≈`work_session` 1:1로 시작, 분리는 병렬 Subtask 필요 시점에 | P2 |
| **Actor-independent Handoff** | ② **충돌** — 연속성이 사람에 묶여 있음 | `work_session.member_id NOT NULL`(019:13) · 재부착은 소유자만(ADR-0139 D1) · resume도 요청자 본인 세션 생성(`WorkSessionRoutes.swift:1410` `principal.memberID`) | 문서 §1.7의 "A 요청→B 시작→Agent 이어받기→C 인계"가 현 모델로 불가능 | **Workstream이 목표를 소유하고 Run(=work_session)은 실행자만 기록**하는 구조로 ADR. member_id는 Run의 실행자로 의미 축소 | **P1** |
| **Source Lane / Worktree** | ② 부분 — 순차 계보는 있음, 병렬 분기는 없음 | `resumed_from_session_id`(025, ADR-0125 D11) — git 계보 재개 | 병렬 Subtask·Fork·Integration 부재. 단 oort 개발 파이프라인 자체는 워크트리 병렬을 이미 실증(트랙/worker 워크트리) | Lane=branch+base+lease의 얇은 모델로 ADR-0141 확장 시 함께 | P2 |
| **Writer Lease** | ② 부분 — 암묵적으로 존재 | 소유자만 입력(ADR-0139) · 호스트당 미정산 1건(049 unique) · observer input 거부(#857) | "명시적 이전(transfer)"이 없음 — 인계가 곧 세션 종료+신규 생성 | Takeover 절차와 함께 도입. **단독 도입은 불필요**(현행 암묵 규칙이 P0 안전은 이미 보장) | P2 |
| **Live Run Observation** | ① **대부분 있음** | `observation` 컬럼+observer grant(`WorkSessionRoutes.swift` 33개소) · 호스트 로컬 링버퍼 replay(ADR-0139 D2, #857) · observer 입력 거부 · `verify_observer_attach` | **Secret Redaction 부재**(②) · T1 로컬 관찰의 opt-in 정책 명문화 부재 | Redaction은 관찰 스트림 확장 전 필수. 나머지는 유지 | P1(Redaction만) |
| **Takeover / Fork 구분** | ③ 없음 | 현행 인계는 orphaned→계보 재개뿐(장애 경로) | 관찰자가 인계받는 명시 절차 부재. #893(unreachable)과 같은 상태 모델 지점 | ADR-0141 재론 시 Takeover를 D1(사용자 행동이 orphaned를 만든다)과 통합 — **같은 결정의 두 얼굴** | P2 |
| **Queue / Compute Pool** | ② Pool은 있음, Queue는 없음 | `work_pool`(022 — max_active·per_member_soft_limit) · 슬롯 부족=409 즉시 거부(`CloudUsageLedger.swift:95-105`) | "가득 차면 줄 서기"가 없어 사용자가 재시도해야 함. 문서 §11의 우선순위·선점·버스트는 전부 부재 | RunRequest 큐 최소형(대기+알림)만 P2로. 우선순위·선점은 ④ | P2 |
| **T1·T2·T3 Target** | ① **실질 동형** | 모든 티어가 `work_host`(Ed25519·서명 REST·capabilities) — T2 데몬과 T3 cloud workd가 **같은 workd**(ADR-0136), macOS 앱 호스트도 같은 표면. TierFallbackSweep 존재 | 문서의 ExecutionTarget/Router는 현행 work_host+tier fallback의 확장형. capability 기반 라우팅은 부분적 | 유지. Router 고도화는 ④ | ①확인 |
| **Checkpoint 기반 Resume** | ② 부분 — 원칙은 이미 일치 | Cold(git 계보, D11)=항상 가능 · Hot(idle 재부착, ADR-0139 D1/D3)=최적화 — **문서 §14.1 원칙과 정확히 동일 구조**. Warm(WIP push)=ADR-0141에 기안됨(보류) | 미커밋 checkpoint(Warm) 미구현 — ADR-0141 보류 해제 대상 | ADR-0141 재론 시 Handoff Package(§14.2)를 흡수 | P1~P2 |
| **Workstream 격리** | ② 격리축이 다름 | 현행: workspace RLS FORCE + 세션별 sandbox + 호스트당 1세션. "목표 단위" 격리는 개념 부재 | Lane 격리는 Workstream 도입에 종속 | Workstream ADR에 포함 | P2 |
| **Sandbox Provider 추상화** | ② **충돌 — E2B가 스키마에 박혀 있음** | `045:103 CHECK (provider = 'e2b')` · `CloudLifecycleReconciler`의 E2B HTTP 클라이언트 · `Config.swift` e2bAPIBaseURL/e2bAPIKey | 성재: E2B 사실상 폐기. **단 ADR-0140 D4(intent→외부호출→재검증·수렴표·idempotency key)는 provider-일반형** — 살릴 것은 이미 일반형이고 버릴 것은 껍데기 | **P0. Provider 인터페이스 ADR**(BYOC 포함) — §3 참조 | **P0** |
| **Self-hosted 독립성** | ① 핵심 불변식이자 창립 원칙 | permissive 스택(AGPL 백본 금지) · compose 셀프호스트 · ADR-0004 | 컴퓨트 축에서만 미완: T3가 E2B 전용이라 "직접 호스팅해서 연동"(BYOC)이 불가 | Provider ADR이 해소 | **P0**(위와 동일 건) |

## 2. 문서 §26 최종 9항

1. **가장 잘 맞는 부분**: 실행 패브릭. 문서의 "T1·T2·T3 동일 Runner Protocol"은 oort에서 이미 사실 — 전 티어가 `work_host` 하나의 표면(서명 v2·capabilities·PTY 호스트 로컬)이고, T3 cloud workd는 T2 데몬과 같은 바이너리다. 관찰 모델(read-only observer·입력 거부·ring replay)도 문서 §10과 거의 일치. **Cold 항상 가능/Hot은 최적화 원칙(§14.1)은 ADR-0139 D3에 이미 같은 문장으로 있다.**
2. **가장 큰 구조적 충돌**: ① `work_session.member_id` 소유권 — 연속성이 목적이 아니라 사람에 묶여 있다(문서 §22.1이 경고한 바로 그 형태). ② **"local-first"** — oort 하드 불변식은 Postgres=SoT·Centrifugo 전송전용·단일 쓰기경로다. 문서의 local-first sync 확장(§25.7)은 이 불변식과 정면 충돌하며, Accepted ADR 없이 수용 불가. **권고: 문서 표현을 "offline-tolerant client + server-authoritative ledger"로 재해석**하고 SoT는 유지.
3. **기존 타입의 과책임**: `work_session`은 Run이다. 과책임은 없다 — 오히려 **상위 계층(목표)이 통째로 비어 있는 것**이 문제. GPT 문서의 Task 이중의미 비판은 oort에는 적용되지 않고, "Workstream 부재" 비판만 적용된다.
4. **Workstream 도입 필요?**: **필요.** 단 oort 문법으로 — 대화 정본(스레드)을 대체하지 않고 스레드에 앵커. 이미 `root_message_id`가 그 앵커 자리다.
5. **Live Observation 구현 가능?**: 이미 구현돼 있다(§1 표). 남은 것은 Redaction과 T1 opt-in 정책 명문화.
6. **Writer Lease·Source Lane의 자리**: Lease는 Takeover 절차의 부속(ADR-0141 재론에 흡수). Lane은 Workstream ADR의 부속. **독립 ADR로 세우지 말 것** — 개념 수가 곧 비용이다.
7. **첫 Vertical Slice**: 문서 §23(16단계)은 과대. 축소안: **①Workstream 테이블+스레드 앵커 ②세션→Workstream 연결 ③"이어받기"(타인이 같은 Workstream에서 새 Run 시작 — Handoff Package는 ADR-0141 WIP push 재사용) ④관찰은 기존 그대로.** Queue·병렬 Lane·Fork는 다음 슬라이스.
8. **현 단계 과도(④)**: Project 계층(workspace+repo로 충분) · Request 별도 타입 · RunAttempt 분리(문서 스스로 MVP 불요라 명시) · 우선순위 5단 Queue와 선점 · Spot/다중 Region/Enterprise Pool(§단계7) · 의미 유사도 Workstream 검색 · Workstream별 동시 실행 한도.
9. **작성할 ADR**:
   - **ADR-0142(P0): T3 Provider 인터페이스 + BYOC** — E2B 폐기 대응. §3.
   - **ADR-0143(P1): Workstream — 목표와 실행의 분리, actor-independent 연속성** — member_id 의미 축소 포함.
   - **ADR-0141 개정(P1~P2, 보류 해제 시): Checkpoint/Handoff Package/Takeover** — D1(unreachable)과 Takeover는 같은 결정.
   - (P2, 나중) RunRequest 큐 최소형.

## 3. E2B 폐기 영향 실측

**바꿔야 하는 것** (생각보다 작다):
- `045:103 CHECK (provider = 'e2b')` — 마이그레이션 1건으로 완화
- `CloudLifecycleReconciler.swift`의 E2B HTTP 호출부 + `Config.swift` e2b* 설정 — provider 어댑터 인터페이스로 추출
- mock E2B 검증기 — mock provider로 개명·일반화
- ADR-0136/0139 D4/0141의 E2B 고유 수치(pause 4초/GiB·keepMemory·상한 24h) — provider별 capability 선언으로 이동

**살아남는 것** (전부 provider-일반형으로 이미 설계됨):
- ADR-0140 전부 — durable intent·수렴 규칙·idempotency key·`t3_terminate`·advisory 직렬화·전이표. **404/410→provider_missing 같은 수렴 규칙은 어떤 provider든 동일.**
- 크레딧 원장·GENERATED pause=0·슬롯 게이트 — provider 무관
- cloud workd 부트스트랩(1회 토큰 digest→Ed25519 자체 등록) — provider 무관. **BYOC의 핵심 재료가 이미 있다**: "사용자가 아무 VM에나 workd를 깔고 부트스트랩 토큰으로 등록"이 곧 BYOC다. T2 데몬 등록과 같은 문법.

**성재 원칙과의 정합**: "셀프호스팅은 의존성 0 + 세팅 쉬움, 워크스페이스는 momo 통해 구매 또는 직접 연동" → 정확히 **T3-BYOC를 1급으로, oort Cloud를 그 위의 관리형 provider 구현 하나로** 두는 구조. 문서 §17.2 표와 동일. 현재 코드는 반대로 oort Cloud(E2B)만 있고 BYOC가 없다 — 이 역전이 ADR-0142의 핵심.

**진행 중 작업 판정**: #891(T-3 정본화)은 provider-일반형이라 **계속 가치 있음 — 완주시킨다**. **#892(T-4 수렴)는 reconciler의 provider 호출부를 재작성하는 티켓이므로 ADR-0142 결정 전 착수 보류** — E2B 어댑터를 다시 쓰는 낭비를 피한다.

## 4. 파이프라인 지시 반영 (2026-07-29 성재)

- 기획=Fable 유지, **워커 모델 sol medium → Claude Opus medium 전환**(다음 spawn부터, 가동 중 #891은 완주).

## 5. 우로보로스 인터뷰 산출 (interview_20260729_053912, 모호성 0.17→0.10)

인터뷰가 결정 공백 5개를 찾았고, Fable 판단으로 채운 것과 성재 몫으로 남긴 것을 구분한다.

**Fable 판단으로 확정 (ADR 기안에 반영할 것):**
1. **BYOC = 순수 compute 모델** (federated SoT 아님) — oort 서버가 control plane, BYOC는 workd 등록으로 붙는 compute. T2 데몬과 같은 문법의 연장이라 하드 불변식(PG=SoT)과 정합. federated는 기각.
2. **인계 = 소유권 이전이 아니라 "같은 Workstream 아래 새 Run"** — `work_session.member_id`는 불변 실행 기록으로 의미 축소(이전 안 함). 기존 계보 재개와 같은 문법이라 마이그레이션 최소. Writer Lease가 필요한 유일한 지점은 라이브 PTY takeover뿐(ADR-0141 재론에 귀속).
3. **Workstream 권한 = 채널 멤버십 파생** (새 권한 체계 발명 금지). 명시 할당은 P2. WIP push의 git 원격 접근은 oort 권한 밖 — 비대칭을 ADR에 명문화.
4. **cross-provider 연속성 = ADR-0142의 부정형 의무 2개로 보장** — ①어댑터는 죽음을 정직하게 보고(provider_missing) ②연속성 필수 상태를 provider 내부에 두지 않음(스냅샷=최적화, 원본 금지). 수용 기준: mock provider 2종 간 재개 시 계보+WIP 복원. BYOC 해지 시 provider 내부 잔여 스냅샷 삭제만 사용자 책임(고지 의무).
5. **ADR-0143 P1 수용 기준**: 스레드 첫 Run 시 Workstream 암시 생성 · 같은 채널 멤버 B의 이어받기(새 Run이 같은 Workstream에 연결, 실행 이력에 A·B 병기) · 비멤버 403(RLS 강제 — 정보성 경고 불가) · WIP 메타 노출은 원장까지(git fetch 권한은 범위 밖).

**성재 몫으로 남긴 결정** (아래 §6):
- E2B 폐기 확정 여부 + BYOC-first 역전 승인
- BYOC 등록 단위(워크스페이스 공용 vs 개인 vs 둘 다)
- Workstream 방향(스레드 앵커·암시 생성) 승인
- #892(T-4) 보류 여부

## 6. 다음 행동

1. 성재 결정 4건 수령 → ADR-0142(provider+BYOC)·ADR-0143(Workstream) 기안
2. #891 완주·검수·머지(계속) — provider-일반형이라 E2B 결정과 무관하게 유효
3. #892는 ADR-0142 결정 전 보류(권고)
4. 다음 워커 spawn부터 Claude Opus medium

## 7. 성재 결정 (2026-07-29 수령 — §6 질문 4건의 답)

1. **E2B 폐기 확정 — BYOC-first 역전** (권고안 채택)
2. **BYOC 등록 단위 = 워크스페이스 공용만** (개인 BYOC는 후속 — 권고안 '둘 다'에서 축소)
3. **Workstream 이대로 기안** (스레드 앵커·암시 생성·채널 멤버십 파생·member_id 의미 축소)
4. **#892 보류** (ADR-0142 Accepted 후 새 인터페이스 대상으로 재개)

→ ADR-0142(`docs/adr/0142-t3-provider-interface-byoc.md`)·ADR-0143(`docs/adr/0143-workstream-actor-independent-continuity.md`) 기안 완료(Proposed). 승인 대기.

## 8. 인프라 축 감사 — "관리형 oort(k8s 호스팅)" 방향 반영도 (2026-07-29 성재 질문)

성재 방향: Slack처럼 oort가 k8s를 띄워 호스팅하고, 사용자는 워크스페이스 생성·에이전트 연동·Claude Code/Codex 개발·컴퓨트 사용을 쉽게 한다. VM·스토리지 축 반영도 실측:

### 반영돼 있는 것 (설계가 이미 이 방향을 받는다)

1. **VM 축의 자리**: ADR-0142 D1/D2가 oort Cloud를 "인터페이스 뒤의 관리형 provider 구현 하나"로 분리해 뒀다 — k8s fleet은 그 구현으로 들어가면 되고 인터페이스는 무변경. 과금·슬롯·수명주기(ADR-0136/0140)는 전부 provider-무관으로 이미 잘려 있다.
2. **스토리지 축(첨부)**: 걱정보다 좋다 — **ADR-0127(Accepted, 07-21)이 이미 S3 호환 어댑터를 결정·구현**했다(`S3ArchiveClient.swift` 실재, `MOMO_ARCHIVE_BACKEND=drive|s3`). Drive는 Dawn 자사 운영용 백엔드일 뿐 결합이 아니다. 관리형 SaaS는 env 1줄로 S3 계열 선택. presigned 직송이라 서버가 바이트를 중계하지 않는 경계도 유지.
3. **작업 상태 스토리지**: ADR-0142 D3(연속성 무상태 — 원본은 git+원장, 샌드박스 스토리지=소모품)가 곧 관리형 스토리지 전략이다. 샌드박스 디스크를 영속 자산으로 관리할 필요가 없다.
4. **컨트롤 플레인 멀티테넌시**: RLS FORCE·워크스페이스 경계·크레딧 원장 — SaaS 전제와 정합.

### 반영 안 된 것 (이번 방향 전환이 새로 만든 결정 — ADR-0144 후보)

1. **[P0] 격리 경계**: E2B 폐기로 **E2B가 공짜로 주던 microVM 격리가 우리 몫**이 됐다. k8s 컨테이너/네임스페이스는 임의 에이전트 코드의 보안 경계가 아니다(GPT §16.2도 동일 지적 — 당시 ④로 미뤘으나 k8s 방향 확정으로 되살아남). run당 microVM(Firecracker/Kata)·gVisor·전용 노드풀 중 결정 필요.
2. **[P1] 샌드박스 이미지·캐시 전략**: base 이미지(Claude Code/Codex/도구 사전 설치), content-addressed 패키지 캐시(읽기 전용 공유), cold start 대 warm pool 비용 균형(리서치 완료분 — Modal min_containers 패턴). 관리형의 체감 속도와 원가가 여기서 결정된다.
3. **[P1] 관리형 샌드박스 안의 LLM 자격증명**: T1/T2는 사용자 기기라 자기 로그인이 있지만, oort Cloud 샌드박스에서 Claude Code가 무슨 자격으로 도는가는 **미결정**. ADR-0004(비유입)와의 긴장 — 권고 방향: 첫 사용 시 샌드박스 안 대화형 로그인(자격증명이 샌드박스에만 살고 oort는 저장 안 함), 단기 브로커 주입은 후속.
4. **[P2] 컨트롤 플레인 k8s 배포 자산**: 현재 compose뿐(infra/ + prod compose). helm/manifest 부재 — 설계 충돌은 아니고 운영 작업. "관리형도 셀프호스트와 같은 스택" 원칙 유지가 조건.
5. **[P3] 명명 부채**: `attachment.drive_file_id` 컬럼명(017)이 백엔드 중립이 아님 — 동작 문제 없음, 기록만.
6. **범위 밖 기록**: SaaS 좌석 과금·조직 결제는 T3 크레딧과 별개 축 — 필요 시점에 별건.

### 판정

**인터페이스·스토리지·과금은 반영 완료, VM 실체(격리·이미지·자격증명)가 빈 곳**이다. 이는 ADR-0142가 의도적으로 "후속 별건"으로 미룬 자리인데, 성재의 k8s 방향 확정으로 이제 기안 대상이 됐다 → **ADR-0144(oort Cloud substrate: k8s + microVM 격리 + 이미지/캐시 + 자격증명) 기안 필요.**
