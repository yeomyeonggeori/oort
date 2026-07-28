# goal #858 — MOMO-650: 웹 idle 표시 + 재부착 동선 (ADR-0139 D3)

너는 momo 레포의 Codex worker다. 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/uxui`** (#850·#851 랜딩분 포함). 모델: gpt-5.6-sol high (service_tier=priority: Fast).

## 0. 착수 전 필수
1. `git status` clean. 2. 자격증명·`.env` 금지. 3. **PR 후 STOP.** 4. typecheck·test·build·preflight 필수, Playwright는 오케스트레이터. 5. 심볼은 grep으로 실재 확인.

## 1. 결정 정본 (ADR-0139 D3 — 바꾸지 마라)
재부착과 계보 재개는 **다른 경로**고 화면도 갈라 말한다:
- 호스트 살아 있음 + `running|idle` → **"이어서 보기/쓰기"**(같은 PTY, 관전 attach 재사용).
- 호스트 죽음 → orphaned → **"새 호스트에서 재개"**(git 계보 — 기존 랜딩분, 미커밋 손실 고지).
- **같은 버튼에 섞지 않는다.** 두 동선이 한 화면에 공존할 때 헷갈리지 않는 카피.

## 2. 소비 계약 (전부 랜딩됨 — 재확인하고 써라)
- **#856(PR #867)**: `work_session.status`에 `idle` 추가. 실시간 프레임 **`work.session.idle`**·**`work.session.resumed-to-running`**(스키마는 PR #867 본문 — payload에 session_id/channel_id/root_message_id/member_id/host_id/status/exit_code?/idle_at|resumed_at, **UUID는 대문자**). 완료 푸시(id-only, `momo.work`)와 채널 메시지 `props.kind="work_session_idle"`·본문 "작업 완료 — idle 대기".
- **#851**: `WorkPanel`의 내 세션 표면 — **미지 상태 중립 폴백("상태 확인 필요")로 idle 자리를 만들어뒀다.** `workSessionModel.ts`(continuityStatus)·`workSessionFormat.ts`(톤 맵)·`gate:my-sessions`.
- 관전 attach: `WorkSessionDetail`·`ObserverTerminal`. **주의**: 데몬 public WSS 어댑터는 미랜딩(#869) — idle 세션 attach가 실제로 붙는 것은 호스트가 endpoint를 주는 경우뿐이다. **attach 실패는 기존 15s 데드라인·정직 문구가 처리한다 — 새로 발명하지 마라.**

## 3. 할 일
1. **idle 파서·모델**: `realtime.ts`에 프레임 2종 추가(기존 방어 스타일 — 타입 전도 시 null). `workSessionModel`·`workSessionFormat`에 idle 상태(— "완료 — 대기 중" 톤: 오류도 진행도 아님). **UUID 대소문자 정규화 주의.**
2. **표면 반영**: 내 세션 행·채널/전체 행·상세에 idle 표시. `exit_code`는 "마지막 실행 결과"로(세션 종료 아님 — #856 의미 재정의).
3. **재부착 동선**: idle/running(호스트 online) 행에서 "이어서 보기" — 기존 상세→관전 경로 재사용. orphaned의 "새 호스트에서 재개"(기존)와 **카피·버튼 분리**.
4. **완료 푸시/메시지 랜딩**: `props.kind="work_session_idle"` 채널 메시지가 타임라인에서 세션 카드 문법으로 렌더되고, 클릭 시 해당 세션으로.
5. idle→running 복귀·idle→ended(idle_timeout) 전이가 실시간으로 화면에 반영.

## 4. 함정 (이 배치에서 반복 실측된 것)
- **"자기 원칙을 자기가 만진 나머지 분기에 미적용"**(#851 1R)·**"기존 셸과의 통합 지점"**(#850 1R)이 최근 FAIL의 전부다. idle 톤·문구를 한 곳(모델)에서 정의하고 세 표면(내 세션·채널 목록·상세)이 공유하게 하라.
- **게이트 픽스처는 응답 타이밍을 어긋나게**(#839 교훈). idle 전이 프레임이 목록 로드보다 먼저/나중 도착하는 두 케이스.
- `gate:my-sessions` 기존 단정·red proof를 깨지 마라. 신규 단정: idle 행이 제3 상태로 렌더·"이어서 보기"와 "새 호스트에서 재개"가 **동시에 다른 행에 공존**할 때 라벨 구분. **red proof 절차 명시.**

## 5. 검증
- typecheck · test(897+, 무회귀) · build · preflight 10/10 · 게이트 6종 무회귀(wire/shell/csp/huddle/my-sessions + 신규 단정).

## 6. PR
`feat/858-momo-650-web-idle` → `track/uxui`. 본문: 상태 톤 판단, 두 동선 카피, attach 한계 고지(#869 선행 관계), 오케스트레이터 실행 목록, 계획 이탈. **PR 후 STOP.**
