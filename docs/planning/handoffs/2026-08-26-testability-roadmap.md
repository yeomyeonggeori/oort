# 핸드오프 — 테스트 가능성 로드맵 확정본 (Fable 검수, 2026-08-26)

> **경로**: 성재 지시 → Opus 5(momo-main 대행)가 순서 제안 → **Fable이 코드 실물 대조로 검수·확정**(이 문서) → Opus가 티켓별 임무서 작성 → grok 4.6 워커 실행.
> **목표**: 성재가 **터미널 · UXUI · 허들 · 그록봇** 네 축을 손으로 테스트할 수 있는 상태.
> **근거 시점**: CURRENT_STATE 스냅샷 68. 트랙 실측 main=`dafe81b1` · track/engine=`8a827ca9`(#1782 T-2 랜딩 포함) · track/uxui=`a3f22dfe`, main⊂engine·main⊂uxui 확인.
> **검수 방법**: 브리프 요약을 믿지 않고 대상 파일·이슈 본문·리서치를 직접 읽었다. 부록 A에 실측 증거 목록. 확인 못 한 것은 본문에 `미확인`으로 표기.

---

## 1. 판정 요약 — Opus 계획에서 승인한 것과 바꾼 것

| # | 판정 | 결과 |
|---|---|---|
| 1 | 1차 병렬 2기(engine+uxui) 골격 | **승인** — 트랙 분리·파일군 비충돌 확인(§3) |
| 2 | 터미널 = #1777 (display 경로 아님) | **승인, 단 범위 확대 필수** — bindRemotePTY만으로는 안 열린다(판정 ②) |
| 3 | D5-B(display 우선)로 터미널 테스트를 여는 안 | **기각** — display 평면은 `type='cloud' AND provider='cubesandbox'` 한정(증보 3 D7, BYOC fail-closed)이라 성재 맥의 로컬 세션(T1)을 원리적으로 못 덮는다. TC-2 리서치 ㉮가 스스로 그 한계를 적시한다. D5-B는 **TC-2 조작(#1759)의 표면 선택지**로 보존 — 성재 동기 결정(ADR) 뒤 |
| 4 | #850 = "웹 허들 UI 신축" | **재정의** — 전제("웹 허들 코드 0건")가 낡았다. 웹 허들 UI·REST 소비·실시간 구독이 **세 트랙 모두에 이미 있다**. 잔여는 **active 응답 와이어 드리프트 1건(P0) + 리그 실기동 검증**(판정 ④) |
| 5 | #1781 = 허들 선결 | **강등 + 재배치** — 허들 테스트의 선결 아님(리그는 어차피 env를 채운다). 예비판정: **게이트 오탐**. 단 docs 게이트 상시 RED가 모든 후속 PR 증거를 오염시키므로 **파도 1 선두**로 당긴다(판정 ⑤) |
| 6 | #1778 위치 | **파도 1 내 후행** — 터미널 테스트의 선결 아님(observation 기본값 open). 같은 파일군·같은 이식 원본이라 #1777 직후 같은 워커 순차가 가장 싸다(판정 ③) |
| 7 | 2차(LiveKit 실기동)·3차(그록봇) 순서 | **승인 + #1747 추가** — `MOMO_HOSTED_DELIVERY_ENABLED`가 compose에 실제로 미배선(rg 0건)이라, 안 닫으면 도어벨 재시험이 수동 우회 2건을 계속 요구(판정 ⑥) |

### 판정 ① — 터미널 최단 경로는 #1777이다 (display 기각 상세)

- 성재가 만질 표면은 **TC-1 관전 도크**(`clients/web/src/features/work/TerminalDock.tsx`)이고, 그 소비 계약은 도크 머리말에 명문화돼 있다: `issueObserverTerminalAttach({ mode: "observer" })` **PTY 평면 전용**, 새 세션 POST 없음, 입력 인코더 없음.
- display 평면이 급전하는 표면은 WorkPanel의 **화면 관전/조작**이라는 다른 표면이고, 세션 범위가 cloud/cubesandbox 한정이라 성재 맥에서 도는 로컬 작업 세션(T1)을 덮지 못한다(TC-2 리서치 ㉮·D5-B 행 원문).
- TC-2 리서치 §5 0단계 스스로 0-a(host-signed 세션 변이 이식)를 "TC-2가 설 바닥"으로 규정하고 **ADR 불요·티켓 발급 가능**(성재 기승인 ADR-0126 D1의 일부)이라 판정했다. D5-B를 택해도 빠지는 것은 "TC-2 v0의 조작"에서일 뿐, **TC-1 도크 테스트에는 0-a가 무조건 필요**하다.

### 판정 ② — #1777의 범위: 세 팔 전부가 MUST다

이슈 원문은 "최소 `bindRemotePTY`, 가능하면 lifecycle 전이·ACP 이벤트까지"라고 쓴다. **이 최소로는 테스트가 안 열린다.** 데몬의 실루프는:

1. `POST work-sessions` — **host-signed create(controlId 대조)** → 현행 400 (`work_sessions.rs:172-176`, 머리말 :36-44 미이식 목록)
2. `PATCH` lifecycle(`reportSessionRunning/Idle`) → 현행 403 (`work_sessions.rs:406-411`)
3. `PATCH bindRemotePTY` → 현행 400 (`work_sessions.rs:383-387`)

1이 안 되면 세션 행 자체가 안 생기고, 2가 안 되면 상태가 안 흐르고, 3이 안 되면 `remote_attach_available`(`lifecycle.rs:528-530`)가 영원히 false다. **셋 다 MUST. ACP 이벤트 릴레이(400, `:394-398`)는 SHOULD**(미이식 시 refused-by-name 유지 + 후속 이슈 번호 명기). observation 팔은 #1778로 분리 유지.

**좋은 소식(실측)**: 데몬 루프의 나머지 절반은 Rust에 이미 전부 이식돼 있다 — host 등록(`work_hosts.rs:202-212`), **서명 폴 pending-controls**(`work_hosts.rs:33-38`·:273-301, WorkHost principal 검사 포함), work-controls 발급/ack/auto-approve REST(`lib.rs:800-816`). 즉 **갭은 정확히 세션 변이 팔들뿐**이고, `verify_workd.sh`의 시나리오(:340-359 — owner→agent credential(`work:control` 스코프)→auto-approve→spawn control POST 201 dispatched)가 Rust 리그에서 그대로 재현 가능하다.

### 판정 ③ — #1778은 선결 아님, 그러나 파도 1 안에서 닫는다

`observation` 기본값이 open이라 도크 관전은 #1778 없이 붙는다. 다만 (a) 웹에 스위치가 이미 그려져 있어 성재가 테스트 중 누르면 400 오류를 본다, (b) "동의 스위치가 열린 채 잠김"은 출시 결함 라벨이 정당한 신뢰 문제다, (c) #1777과 같은 PATCH 디스패처·같은 이식 원본(`WorkSessionRoutes.swift:1663-1755`)이라 같은 워커 연속 작업이 리뷰·컨텍스트 비용을 최소화한다. → 파도 1, #1777 직후 순차.

### 판정 ④ — 허들: #850의 전제가 낡았고, 진짜 잔여는 드리프트 1건이다

**이슈 본문의 "clients/web/src·clients/desktop에 huddle 코드 0건"은 현행 거짓**이다(이슈가 랜딩 이전에 쓰였다):

- 세 트랙 모두 `clients/web/src/features/huddles/` 4파일 존재(git ls-tree 실측): `HuddleHeaderControl.tsx`(ChatShell 배선 확인) · `useHuddle.ts` · `huddleRuntime.ts`(LiveKit SDK 동적 import) · `huddleRuntimeLoader.ts`.
- momo-core에 REST 4종 소비(`api.ts:481-`)·와이어 디코더(`huddleFromWire`)·허들 모델과 테스트(`features/huddles/huddleModel.test.ts`)가 있다.
- 실시간도 정합: 웹 `subscribeHuddle`(`clients/web/src/lib/realtime.ts:455-485`)이 채널 스트림에서 lifecycle 프레임을 받고, Rust가 같은 채널로 `huddle_started`/`huddle_participants_changed`/`huddle_ended`를 outbox 발행한다(`momo-messaging/src/huddle.rs:148·230·308·528`).
- openapi에 허들 경로 4종 + 생성 타입(`clients/web-legacy/src/api/schema.d.ts`) 재생성 완료.

**실측으로 확정한 P0 드리프트 1건**: 활성 없음 응답에서

- 계약 정본 openapi(:1594-1595): *"otherwise the optional field is omitted"* — **필드 생략이 정상**.
- Rust도 그렇게 낸다: `ActiveHuddleResponse`의 `huddle: Option<_>`에 `skip_serializing_if = "Option::is_none"` → JSON `{}`.
- 그런데 웹 디코더는 `source.huddle === null`만 통과시키고(`api.ts:490`), 생략(undefined)이면 `huddleFromWire(undefined)` → `record()`가 null → **`WireShapeError` throw**(`api.ts:443-444`, `wire.ts:11-15`).
- 기존 테스트 픽스처도 `huddle: null` 형태로 잘못 잠겨 있다(`huddleModel.test.ts:76`) — **픽스처가 실서버 모양을 안 재는 전형** (오늘 리뷰 16회전의 반복 실패 양식 그대로).

귀결: **유휴 채널(활성 허들 없음 = 기본 상태)에서 허들 컨트롤이 Rust 서버 상대로는 오류 상태**가 된다. 위반자는 웹 쪽이므로 수리도 웹/momo-core 쪽이다. #850을 "UI 신축"으로 워커에 넘기면 이미 있는 것을 다시 짓는다 — **브리프에 재정의를 명시**해야 한다.

### 판정 ⑤ — #1781: 예비판정 "게이트 오탐", 파도 1 선두 배치

compose 실측: `MOMO_LIVEKIT_*`의 compose 보간 레벨 표기는 전부 `${VAR:-}`(빈 기본값 — 절대 하드 요구 아님, `docker-compose.rust.yml:130-131·271-273`)이고, `:?` required 표기는 **livekit 서비스 entrypoint의 `$$` 이스케이프 문자열 안에만** 있다(:125-127 — compose가 보간하지 않고 컨테이너 셸에 넘기는 형태). 게이트 스크립트(`check_compose_env_templates.sh`)의 grep이 `$${VAR:?}`를 보간 요구로 오인하는 구조다. → **profile 밖 운영자에게 실요구되지 않는다**가 예비판정. 단 이슈가 요구하는 실측 2건(`docker compose config` + profile 없는 `up -d`)으로 워커가 확정하고, 오탐이면 **게이트를 수리하되 단정을 약화시키지 않는다**(이슈 원문 규율). 허들 테스트와는 독립 — 그러나 docs 프로파일 게이트가 상시 RED면 파도 1·2의 모든 PR 증거가 "RED는 원래 그래" 오염을 입으므로 **엔진 슬롯 첫 티켓**으로 당긴다.

### 판정 ⑥ — #1747을 파도 2에 추가

`MOMO_HOSTED_DELIVERY_ENABLED`는 `infra/rust/` 어디에도 배선돼 있지 않음을 실측(rg 0건; `MOMO_DOORBELL_ENABLED`는 :253·:443에 있음). RERUN.md §2의 수동 우회 2건(env 수동 주입 + drive 볼륨 chown)은 #1747이 닫혀야 사라진다. 도어벨 재시험(파도 3, 성재 선행)이 있기 전 파도 2에서 랜딩.

### 판정 ⑦ — 묶음: 병렬 2기 승인

- 파일군 교차 검사: 엔진 슬롯(#1781 `scripts/`+`infra/rust/` · #1777/#1778 `server-rust/`)과 uxui 슬롯(#850-잔여 `packages/momo-core/`+`clients/web/`)은 **서로 안 겹친다**.
- 오늘 실측 관례(워커 병렬 1~2, 5티켓/세션)와 부합. 슬롯 내부는 순차(1 이슈 = 1 PR 유지).

---

## 2. 테스트 축 4 × 최소 경로

### 2.1 UXUI — 지금 열려 있음

- **경로**: 티켓 0. 성재 행동만 — `~/Desktop/oort-uxui-review.app` 실행(track/uxui `264bb1dc` 빌드, 이후 UI 변경 0건이므로 현행 유효).
- **판정 기준**: 이미 충족.
- **주의**: 파도 1의 #850-잔여가 track/uxui에 랜딩되면 리뷰 앱과 트랙 HEAD가 갈라진다 — 랜딩 시 **재빌드 + "빌드 원본" 고지**가 오케스트레이터 의무.

### 2.2 터미널 — #1777(범위 확대) → #1778, 이후 리그 검증

- **경로**: #1781(게이트 소음 제거) → **#1777**(host-signed 3팔 + 세션 생산 하네스) → #1778(동의 토글) → 오케스트레이터 리그 검증 → 성재.
- **축 열림 판정 기준** (전부 리그에서, 모킹 없이):
  1. 하네스 1회 실행으로 **실세션 1건 생성**(스크립트가 성재도 재실행 가능한 형태로 남는다)
  2. `GET work-sessions`에 세션 등장 + `remote_attach_available: true`
  3. TC-1 도크 탭에서 그 세션 선택 → **실시간 셸 출력 바이트 표시**
  4. 소유자 관전 토글 왕복(꺼짐→관전 거부, 켬→재관전) 200
- **안 재지는 것**: WorkHostDaemon의 Rust 서버 상대 전체 루프는 현행 Swift e2e(`infra/docker-compose.e2e.yml` — Swift 서버를 빌드)에서만 검증돼 있다. Rust 리그 상대는 #1777의 하네스가 처음 잰다. 데몬 빌드는 swift 툴체인 필요(은퇴 트리지만 **데몬이 유일한 PTY 생산자**이므로 [swift] 등급 예외 사용이 정당 — 새 기능을 얹는 게 아니라 기존 실행체를 돌리는 것). 데몬을 맥 로컬 프로세스로 돌릴지 e2e식 컨테이너로 돌릴지는 워커가 하네스 개조 시 결정하고 문서화.

### 2.3 허들 — #850-잔여 + 리그 실기동

- **경로**: 파도 1 uxui 슬롯 #850-잔여(드리프트 수리) ∥ 파도 2 오케스트레이터가 리그에 `huddle` profile 실기동(LiveKit env 주입 — devkey 로컬 생성 가능, `rust-smoke.env.example:81-83`은 빈 값 존재만) → 성재+오케스트레이터 2-클라이언트 검증.
- **축 열림 판정 기준**:
  1. 유휴 채널에서 오류 없이 "허들 시작" 컨트롤 노출(= 드리프트 수리 증명)
  2. 시작→참가→나가기 REST 왕복 + live 배지·참가자 전이가 실시간 반영
  3. **2-클라이언트 오디오 왕복**(성재 1 + 오케스트레이터 1 — 워커는 못 한다, #850 원문 AC 계승)
  4. 마지막 퇴장 시 서버 종료 전이가 화면 반영
  5. env 미설정 리그에서 503 "허들 미구성" 정직 표기(fail-closed 확인)
- **안 재지는 것**: LiveKit 실기동은 지금까지 `verify_huddle_livekit.sh`(Swift 시절 작성)로만 검증됐고 Rust 스택+웹 클라 조합의 e2e는 이번이 처음. NAT/UDP 환경 이슈는 리그 로컬에선 안 드러날 수 있다(원격 2-클라 시나리오는 후속).

### 2.4 그록봇·도어벨 — #1747 + 성재 선행 → RERUN

- **경로**: 파도 2 #1747(compose 배선+chown) → **성재**: 그록봇 VM/Funnel 상태 확인 + 벤더(cursor) sender key 재발급 → `claudedocs/e2e-doorbell-20260824/RERUN.md` 재주행(오케스트레이터 배석).
- **축 열림 판정 기준**: RERUN.md의 성공 조건(초인종 왕복 — 그록봇 발신→oort 수신 표시).
- **안 재지는 것**: 벤더(cursor) 쪽 500 재발 여부는 우리 통제 밖. D8 Funnel 무응답의 원인(VM 정지인지 funnel 프로세스인지)은 성재 확인 전까지 미확인. T-2 플레이북(#1782 랜딩)은 문서 재작성이며 실주행 검증은 이 재시험이 처음이다.

---

## 3. 파도 편성 (grok 4.6 워커 단위)

| 파도 | 슬롯 | 티켓(순차) | 트랙 | 선행 조건 | 예상 사이클 |
|---|---|---|---|---|---|
| **1** | 엔진 | **#1781 → #1777 → #1778** (1 이슈 = 1 PR) | track/engine | 없음 — 지금 시작 가능 | 1781: 1~2 · 1777: 2~3 · 1778: 1~2 |
| **1** | uxui | **#850-잔여** (재정의 브리프 필수, §4.4) | track/uxui | 없음 — 지금 시작 가능 | 1~2 |
| **2** | 엔진 | **#1747** | track/engine | 파도 1과 독립(먼저 시작해도 무방하나 병렬도 2 유지 우선) | 1 |
| **2** | 오케스트레이터 | 리그 검증 2건 — (a) LiveKit profile 실기동+허들 폐곡선 (b) 터미널 하네스 재주행+도크 육안 확인. **워커 티켓 아님** | 리그(로컬) | 파도 1 랜딩 | 워커 사이클 아님 |
| **3** | 성재+오케스트레이터 | 도어벨 RERUN 재주행 | — | 성재: VM/Funnel 확인 + key 재발급, #1747 랜딩 | — |
| 이후 | — | AC 4건(#1767~#1770) → 폰 패리티(#1748·#1752) → TC-2(#1759, **성재 ADR 선행**) → 리뷰 적립(#1745·#1763) → #1774. TC-2 갭 ③(감사 읽기 표면)은 **미티켓** — #1759 기획에서 티켓화 권고 | — | — | — |

- 병렬도: 상시 2 워커 이하(오늘 관례). 파도 1 두 슬롯은 파일군 비충돌 확인 완료(판정 ⑦).
- 성재 검증 이벤트는 파도 2 완료 후 **한 번에**(터미널+허들 같은 리그 세션에서) 잡는 것을 권고 — 성재 호출 횟수 최소화.

---

## 4. 티켓별 임무서 골자 (Opus가 브리프 쓸 때 누락 금지 항목)

> 공통: 오늘 리뷰 16회전의 반복 실패 양식 3종을 각 티켓에 명시적으로 방어한다 —
> ㉠ **픽스처가 못 재는 축**(모킹이 실서버 모양과 다름) ㉡ **새 진입점을 안 누르는 캡처**(기존 화면만 찍고 통과 선언) ㉢ **기승인 계약의 배선 누락**(문서·게이트 미갱신).

### 4.1 #1781 — LiveKit env 게이트 RED (engine, 파도 1 선두)

- **범위**: 실측 2건(`docker compose config` 출력 + huddle profile 없는 `up -d` 실기동)으로 오탐/실요구를 확정 → 오탐이면 게이트 스크립트가 `$$` 이스케이프와 compose 보간을 가르게 수리, 실요구면 entrypoint required 표기 제거 또는 huddle 전용 override 분리. Fable 예비판정은 오탐(§1 판정 ⑤)이나 **실측이 정본**.
- **보존 계약**: 게이트의 단정 강도 — "문서대로 따라 한 운영자의 스택이 실제로 뜨는가"를 약화시키는 수리 금지(이슈 원문). livekit 서비스 자체의 fail-fast(`:?` 셸 검사)는 보존.
- **red proof**: 수리 전 RED 로그(4개 시나리오) 첨부 → 수리 후 GREEN + profile 없는 `up -d` 성공 로그.
- **게이트**: docs 프로파일 + `rust-smoke.env.example` 빈 값 판정 결과 명기 + 문서 4곳(infra/rust/README §2·§3, push-relay 런북, ncp-rust-deploy) 정합.
- **실패 양식 방어(㉢)**: "게이트를 GREEN으로 만드는 가장 싼 방법 = required 단정 삭제" 우회를 브리프에서 명시적으로 금지.

### 4.2 #1777 — host-signed 세션 변이 이식 (engine, 파도 1 핵심)

- **범위(확정 — 이슈 원문 "최소 bindRemotePTY"를 상향)**: `work_host_auth`를 세션 변이 라우트 계열 allow-list로 확장 + **세 팔 MUST**: ① host-signed create(controlId ↔ dispatched spawn control 대조) ② lifecycle 전이(running/idle) ③ `bindRemotePTY`(pty_id+attach_endpoint). **ACP 이벤트 릴레이는 SHOULD** — 미이식 시 현행 refused-by-name(400) 유지 + 후속 이슈 번호를 코드 TODO와 PR에 명기. observation 팔은 건드리지 않는다(#1778 소유).
- **보존 계약**: 이식 원본 `server/Sources/`의 권한 규칙·에러 문장·wire 필드명을 그대로(재발명 금지 — 데몬 `WorkHostAPIClient.swift`가 이미 보내는 모양이 계약). 인간 경로의 기존 거절(무서명 pty 필드 400 등) 회귀 금지. BYPASSRLS 금지(쓰기 경로 불변식).
- **red proof**: (a) 통합 시험 — 무서명 거절·타 호스트 서명 거절·controlId 불일치 거절·정상 서명 200 + `remote_attach_available` false→true 반전. (b) **하네스 의무**: `verify_workd.sh`를 Rust 리그 대상으로 개조(또는 `verify_workd_rust.sh` 신설 — 기존 것은 Swift e2e compose를 향하므로 그대로는 못 쓴다). 시나리오는 기존 :340-359 재사용(work-controls REST는 Rust에 전부 이식 확인, `lib.rs:800-816`). **수리 전 이 하네스가 400/403에서 멈추는 RED 로그 → 수리 후 실 PTY 바이트가 도크 attach WS까지 도달하는 GREEN 로그.**
- **테스트용 세션 생산 레시피(AC 필수 — 이것이 없으면 도크는 여전히 빈다)**: 하네스가 곧 레시피다. 산출물에 "성재/오케스트레이터가 리그에서 1커맨드로 실세션을 만드는 절차"를 스크립트+짧은 런북으로 남긴다. 데몬 실행 형태(맥 로컬 vs 컨테이너)는 워커가 결정·문서화.
- **게이트**: [rust] 3종(fmt --all/clippy -D warnings/test --workspace) + 하네스 실행 로그. UI 변경 없음 → design-review 불요(근거 명시).
- **실패 양식 방어(㉠)**: 픽스처 모킹으로 "붙는다"를 증명하는 것 금지 — TC-1 랜딩 때 리뷰 4회전이 이 층을 못 본 원인이 캡처 픽스처의 세션 모킹이었다(#1777 이슈 원문). 실 데몬 프로세스가 만든 실 PTY 바이트 로그만 인정.

### 4.3 #1778 — 소유자 관전 차단 토글 400 (engine, #1777 직후)

- **범위**: observation PATCH 팔 이식(인간-소유자 경로). 값 전이 규칙(open ↔ owner_only)·소유자만 200·감사 행. 이식 원본 `WorkSessionRoutes.swift:1663-1755`.
- **보존 계약**: **ADR-0004 증보 3 D3 원문 준수** — "비관측의 주어는 에이전트, 인간 관전은 기존 모델 그대로". `owner_only` 강제는 077 파도가 스스로 넓힌 규칙이므로 **원문으로 회귀하는 이식**이지 새 정책이 아니다(이슈 각주). 웹이 이미 보내는 호출의 wire 모양과 대조(신규 필드명 발명 금지 — ㉢ 방어).
- **red proof**: 소유자 토글 200 · 비소유자 403 · 차단 상태에서 관전 attach 시도 거부 · 재개방 후 재관전 · 감사 행 기록. 웹 표면은 이미 호출 중이므로 서버만 고치면 폐곡선.
- **게이트**: [rust] 3종.

### 4.4 #850-잔여 — 허들 active 드리프트 수리 (uxui, 파도 1)

- **브리프 서두에 재정의 명시(필수)**: "#850 원문의 '웹 허들 코드 0건'은 낡은 전제다. UI·REST 소비·실시간 구독은 이미 있다(§1 판정 ④의 증거 목록 인용). **이 티켓은 신축이 아니라 와이어 수리다.** 기존 4파일의 구조 변경 금지."
- **범위**: ① `momo-core/src/lib/api.ts` `fetchActiveHuddle`이 **필드 생략(undefined)을 '활성 없음'으로 수용**(`=== null` → null 병합 판정; 구형 `huddle: null`도 계속 수용) ② `huddleModel.test.ts:76`류 픽스처를 openapi 정본 모양(`{}` 생략형)으로 정정 + 양형 모두 단정 ③ #850 원문 AC의 4종 상태(미구성 503 · 활성 없음 · 참가 중 · 오류) 단정이 이미 있는지 확인, 없는 것만 보강.
- **보존 계약**: openapi가 계약 정본 — *"otherwise the optional field is omitted"*(:1594-1595). **서버(Rust)는 계약대로다 — 서버를 고치지 마라**(engine 트리 접근 금지). momo-core는 공유 트리이므로 웹·폰 양쪽 소비 회귀 검사.
- **red proof**: `{}` 픽스처로 현재 코드의 `WireShapeError`를 먼저 재현(테스트 RED) → 수리 후 null 반환(GREEN).
- **게이트**: [web](typecheck·test·build·preflight) + **`verify_merge_tree.sh`**(momo-core 공유 트리 — 브랜치 green만으로 부족, U4-6 B1 전례) + gate:wire.
- **실패 양식 방어(㉠·㉡)**: 픽스처를 실서버 모양으로 잠그는 것이 이 티켓의 본질임을 명시. 리그 실기동 검증은 **파도 2 오케스트레이터 몫** — 워커가 "리그에서 검증했다"고 쓰지 않도록 PR 템플릿의 runtime-unverified 표기 요구. 표면 픽셀 변화 없음 → design-review 스킵 근거를 PR에 명기.

### 4.5 #1747 — 셀프호스트 갭 2건 (engine, 파도 2)

- **범위**: `MOMO_HOSTED_DELIVERY_ENABLED` compose 배선(현재 rg 0건 실측) + drive 볼륨 초기 권한(chown). E2E 2026-08-24 발견분 그대로.
- **red proof**: RERUN.md §2의 수동 우회 2건이 불필요해지는 것 — 갓 뜬 스택에서 우회 없이 해당 경로 통과.
- **게이트**: [infra] + `docker compose config` 정합 + compose-env 게이트 GREEN(#1781 선행 랜딩 가정) + 문서 정합(RERUN.md의 우회 안내 갱신 — ㉢ 방어).

---

## 5. 성재 몫 (성재만 할 수 있는 것 · 무엇을 막는가)

| 항목 | 막는 것 | 비고 |
|---|---|---|
| **그록봇 VM/Funnel 상태 확인** | 파도 3 전체(도어벨 재시험) | D8 무응답 원인이 VM 정지인지 funnel 프로세스인지 성재만 확인 가능 |
| **벤더(cursor) sender key 재발급** | 도어벨 RERUN 선행 | RERUN.md 명기 |
| **TC-2 동기 결정**(부재중 대체/동시작업/지시주입) | #1759 ADR → D5-A/B 선택 → TC-2 v0 착수 | 이번 4축 테스트는 안 막는다 — #1777/#1778은 ADR 불요(기승인 0126 D1) |
| **2-클라 오디오 검증 참여** | 허들 축 폐곡선(판정 기준 3) | 파도 2 후 터미널 검증과 한 세션 권고 |
| **RA-7 D-1**(계정 진입장벽) | 이번 4축 테스트 안 막음 | 셀프호스트 트랙 후속 |
| ~~#1781 판정~~ | — | **성재 미결에서 제거 권고** — 실측 2건(§4.1)이 판정을 대체한다. 결정이 아니라 사실 확인이다 |

---

## 6. 리스크와 중단 조건 (멈추고 성재/momo-main에 물을 시점)

1. **#1777 이식 중 계약 수준 분기**: 이식 원본(Swift)의 권한 모델·서명 스킴이 Rust 구조와 계약 수준에서 갈라져 재설계 판단이 필요해지면 — 임의 재설계 금지, `goal_release --blocked` + 이탈 보고(AGENTS §4-10).
2. **데몬 상호운용 실패**: Rust 리그 상대에서 데몬 서명/직렬화가 예상 밖 불일치(에러 문장 아닌 형식 수준)를 드러내면 — 하네스 RED 로그 첨부하고 중단 보고. 데몬(은퇴 트리) 코드 수정이 필요해 보이는 순간이 경계다: **[swift] 트리 수정은 이 파도의 범위 밖**, 성재 판단 필요.
3. **#850-잔여의 범위 초과**: 수리가 momo-core 디코더 1곳+픽스처를 넘어 계약 자체(openapi) 변경을 요구하게 되면 — 중단(경계 변경은 ADR 사안).
4. **#1781이 "실요구"로 판명**: 오탐이 아니라 compose가 정말 profile 밖에서 요구한다면 — 수리 방향(override 분리 vs entrypoint 제거)이 셀프호스트 첫-실행 계약(#1231)을 건드리므로 momo-main 확인 후 진행.
5. **LiveKit 실기동에서 오디오 불통**(devkey·로컬 NAT/UDP): compose UDP 제한 확인 후에도 안 붙으면 성재에게 네트워크 환경 질문 — 무한 디버깅 금지, 1사이클 상한.
6. **도어벨 재시험에서 벤더 500 재발**: 우리 통제 밖 — 즉시 중단하고 성재에게 벤더 채널 확인 요청.
7. **파도 1 두 슬롯의 예상 밖 파일 충돌**(예: #850-잔여가 web 쪽 도크 파일을 건드리게 되는 경우): 발견 즉시 한 슬롯을 홀드하고 순차 전환.

---

## 부록 A — 이번 검수의 실측 증거 (Opus·워커 재확인용)

| 사실 | 근거 (전부 직접 열람) |
|---|---|
| 데몬 세션 변이 5종이 400/403으로 거절됨 | `work_sessions.rs:172-176·383-387·394-398·399-402·406-411`, 머리말 :36-44; TC-2 리서치 §1.6 갭 ① 표 |
| 서명 폴·work-controls REST는 이식 완료 | `work_hosts.rs:33-38·273-301`, `lib.rs:800-816` |
| 스폰 컨트롤 디스패치 시나리오 재사용 가능 | `verify_workd.sh:340-359`(REST) · :189-214(신원 SQL 시딩) — 단 현행 타깃은 Swift e2e compose |
| TC-1 도크는 PTY 관전 전용·세션 생성 없음 | `TerminalDock.tsx` 머리말 계약 |
| display 평면은 cloud/cubesandbox 한정 (T1 못 덮음) | TC-2 리서치 ㉮·D5-B 행·증보 3 D7 |
| 웹 허들 UI·소비면 3트랙 존재 | `git ls-tree` 3트랙 × `clients/web/src/features/huddles/` 4파일; `realtime.ts:455-485`; `momo-messaging/huddle.rs:148·230·308` |
| active 드리프트: 생략이 계약, 웹이 `=== null`만 수용 | `openapi.yaml:1594-1595` · Rust `ActiveHuddleResponse(skip_serializing_if)` · `api.ts:481-492·442-444` · `wire.ts:11-15` · `huddleModel.test.ts:76` |
| LiveKit env는 compose 레벨 `:-`, `:?`는 `$$` entrypoint 안에만 | `docker-compose.rust.yml:118-131·253·271-273` |
| `MOMO_HOSTED_DELIVERY_ENABLED` compose 미배선 | `infra/rust/` rg 0건 (`MOMO_DOORBELL_ENABLED`는 :253·:443 존재) |
| 트랙 정렬 | main=`dafe81b1`⊂engine=`8a827ca9`⊂ 각각 ancestor 확인, uxui=`a3f22dfe` |

**미확인으로 남긴 것**: ① 데몬↔Rust 서버의 서명/직렬화 상호운용(하네스가 처음 잰다 — #1777 red proof가 확인 방법) ② `useHuddle` 상태 4종 단정의 현행 커버리지(워커가 테스트 트리에서 확인 — `clients/web/src`에 huddle 테스트 파일 0건 실측, momo-core 쪽만 존재) ③ D8 Funnel 무응답 원인(성재 확인 전 미확인) ④ LiveKit devkey 리그 오디오 실기동(파도 2가 확인 방법).

---

## 델타 — Fable 검수 반영 실행 순서 (2026-08-27)

> 근거: `docs/planning/research/2026-08-27-fable-audit-of-opus-session.md`. 골격(축 단위로 성재 테스트 가능 상태를 만든다)은 유효. 아래 3건이 로드맵 밖에서 발생해 순서를 갱신한다.
> ① DNS 정리(보안·즉시, 로드맵에 없던 것) ② #1798 블로커(첫 걸음이 수정 없이는 못 나감) ③ #1768(AC-2) 좌표가 자기보고 누락으로 흐려짐.

### 실행 순서 (갱신)

| 순 | 항목 | 담당 | 비고 |
|---|---|---|---|
| **0** | **[보안·즉시] `app.oor7.com` DNS A 레코드 정리** | **성재** | 등록기관(가비아) 접근이 성재에게만. 반납 IP `101.79.11.189` dangling. #1802가 재발 방지 |
| **1** | **#1798 위계 결함 수정** → 머지(AC-1) | 워커+검수 | owner만 owner/admin 대상 reset. `admin→owner=403` 테스트 필수. **수정 전 머지 금지** |
| 2 | #1799 머지(AC-3 초대 3경로) | 검수 | CLEAN — 게이트 통과 시 랜딩 |
| 3 | #1800 `workspace.settings` REST(AC-4a 선행) | 워커+검수 | 키 네임스페이스·크기 상한 강제 |
| 4 | #1770 재발주(AC-4 역할 표시명) | 워커+검수 | #1800 랜딩 후 |
| 5 | #1768(AC-2 승격·강등·정지·추방·밴) | 워커+검수 | ADR-0128:27(토큰 즉시 revoke+realtime 차단)까지 걸리는 대형. 계정축 최장 |
| **6 (병렬)** | #1792 SPIKE-HD ∥ #1785 ACP 릴레이 ∥ #1797 EXT-1 | 상호 독립 | 허들·터미널·그록봇 축이 서로 안 막음 |

### 구조 처방 (검수 §5·§7·§8 → 티켓)

- **#1801 GATE-COND** — 접촉 경로 조건부 게이트 3종(openapi 타입·셸 스모크·compose 스모크). "무엇을 통과하라"를 사람 기억에서 경로 트리거로 이관. ㉣·㉢·㉠ 재발 차단.
- **#1802 TD-EXT** — teardown 체크리스트에 "레포 밖 표면" 4축(DNS·인증서·클라 저장·외부 등록물). dangling DNS 재발 방지.
- **#1803 DOC-STALE** — 철수 후 정본 잔재 갱신(성재 결재 후 랜딩).

### 워커 브리프 상설 항목 (검수 §8-3·§7㉤ → 다음 발주부터 적용)

1. **권한 매트릭스**: 신규/변경 엔드포인트마다 "행위자 role × 대상 role → 기대 응답(2xx/403)" 표를 수용기준에. #1798류를 구조적으로 차단.
2. **정지 조건 절 상설**: "다음을 발견하면 우회 말고 멈춰라 — (a) 계약↔스키마/코드 불일치 (b) 수용기준에 필요한 표면 부재 (c) 경계(API/보안/스키마) 신설 필요". 정지를 "실패"가 아니라 "발견"으로 명명(AC-4 워커의 옳은 정지를 규범화).

### 성재 결재 대기 (검수 §9)

DNS 정리(즉시) · #1798 수정 계약 승인 · 허들 폴백 순서(P1 실패 시 P3 LiveKit Cloud vs P2 운영자 TURN) · #1768 착수 시점 · #1803 정본 diff.
