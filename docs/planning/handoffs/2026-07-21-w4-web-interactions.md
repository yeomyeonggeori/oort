# W-4 핸드오프: 웹 상호작용 — 승인 카드·read-state·recovery 왕복 (ADR-0119)

> 발급: 2026-07-21 Fable. 정본: ADR-0119 파생 W-4 — W-2(clients/web: 로그인·타임라인·realtime·컴포저[deviation 수용분]) main 랜딩 기반.
> 트랙: 엔진/인프라 · base = main · PR base = track/engine · 도메인 = **clients/web 한정**(서버·Caddy·Core 무변경 — W-3와 파일군 비충돌로 병렬 안전).

## 구현 범위
1. **승인 카드**: 타임라인의 `type=approval_request` 메시지를 카드로 렌더(제목·요청 에이전트·상태 칩 pending/approved/rejected/expired·`props.approval_status` 소비) + pending이면 승인/거부 버튼 → 기존 승인 REST(macOS/iOS와 동일 계약 — openapi `ApprovalDecision`, clientDecisionId 멱등 재사용). 결정 후 realtime `approval.*` 이벤트로 카드 상태 갱신(콜드 로드 복원 포함). resume_offer(`props.kind=resume_offer`)는 v0에서 일반 승인 카드로 렌더하되 결정 버튼 대신 "데스크톱에서 재개하세요" 안내(웹 Work 표면은 v1+ — 0119 §5 경계).
2. **read-state 정착**: 타임라인 가시 범위 기반 `PUT .../read-state`(debounce — iOS visibleMessageIDs 문법), 채널 목록 unread/mention 뱃지 실시간 갱신(`message.new` 수신 시 비활성 채널 카운트 — 서버 재조회 폴백).
3. **recovery·폴백 왕복 완성**: centrifuge-js recovery(offset/epoch) 실패 시(`recovered=false`) history REST 재수화(reconcile — 중복 seq 제거·순서 보존), ws 단절 시 인라인 "실시간 연결 끊김·재연결 중" 배너(기존 데이터 유지 — MOMO-514 규율), 지수 백오프 재연결.
4. **컴포저 정리(W-2 deviation 후속)**: 전송 실패 재시도 UI(같은 clientMsgId 재사용 단정 유지)·전송 중 상태·오프라인 시 비활성+사유.

## 수용 기준
- vitest 가산(승인 카드 상태기계·read-state debounce·reconcile 중복 제거 ≥8) + lint/typecheck/build PASS. 생성 타입만 소비(any 금지).
- 실서버 왕복(승인 카드 결정→상태 전이, 2탭 read-state)은 오케스트레이터 게이트 — STATUS에 runtime-unverified 명기.
- 카피 한국어 verb-first·em-dash 금지·토큰/본문 콘솔 로깅 금지.

## 규율
- 커밋 자주. PR 후 멈춤(base=track/engine). merge/close·docker·브라우저 금지(게이트=오케스트레이터). node_modules 커밋 금지.
