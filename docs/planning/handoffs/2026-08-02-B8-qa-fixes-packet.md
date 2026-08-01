# goal B8 — QA 실사용 결함 수정 1차 (체감 최상위)

너는 momo 레포의 구현 worker다(Claude Opus 5). 이 문서가 유일한 지시서.
**base = `track/engine`**(WSS 오리진 수정 이후). 워크트리 `~/projects/momo-tracks/momo-worktrees/B8-qa`(브랜치 `feat/B8-qa-fixes`, 생성됨).
발단: 실서버 QA 스윕(2026-08-01, 브라우저 실사용 46샷). Blocker B1(WSS 403)은 오케스트레이터가 인프라에서 해소함 — 이 배치는 **클라이언트/서버 표면 결함**.

## 0. 규율
`.env` 금지 · **PR 후 STOP**(amend/force-push 금지) · docker 검증 금지(서버측은 `#[ignore]`) · Swift 실측=정답(서버 계약) · taste 스킬 준수(UI) · route raw SQL 0 · 새 마이그레이션 금지.

## 1. 할 일 (체감 순 — 전부 이번 배치)
1. **H4 Enter 전송**: Enter=전송 / Shift+Enter=줄바꿈(한글 IME 조합 중 Enter는 전송 금지 — composition 이벤트 처리 필수). 컴포저에 힌트 문구.
2. **H6 마크다운 렌더**: 메시지 본문 마크다운(굵게·기울임·코드·목록·링크) 안전 렌더(XSS 차단 — 기존 의존 없으면 최소 파서 또는 검증된 경량 lib, 번들 영향 명시). 에이전트 답변이 `**`를 그대로 노출하지 않게.
3. **H2 provider 원문 오류 은닉**: 에이전트 실패 메시지를 사용자 문장으로(내부 코드네임·raw JSON·영문 원문 제거). 원문은 run 상세/감사에만. **서버측**(agent-worker degraded 메시지)이 정본 — 사용자 문장은 한국어 1문장 + "자세히"는 카드 안.
4. **B2 연결 상태 가시화**: 실시간 끊김이 지속되면(예: 15초+) 상단에 배너 1줄 + 재연결 버튼. 8px 무라벨 점만으로는 사용자가 회복 불가.
5. **H10 재확인**: 열린 채널의 unread 뱃지 모순이 WSS 복구로 사라졌는지 확인, 남아 있으면 수정(읽고 있는 채널은 도착 즉시 읽음 처리).
6. **L7 날짜 컨텍스트**: 에이전트 시스템 프롬프트/컨텍스트에 현재 날짜 주입(에이전트가 2025년이라 답하는 문제).

## 2. 하지 말 것
H1 API 404군(별도 배치 — 미이식 표면 정직화)·H3 메시지 액션·H5 검색·H7 DM 무멘션 응답·M/L군(후속).

## 3. 검증·PR
UI: npm build+tsc+test+lint+preflight+캡처(컴포저 힌트·마크다운·배너 신규 화면). 서버: cargo check/test/fmt/clippy. PR `feat/B8-qa-fixes` → `track/engine`. 본문: 항목별 전후·IME 처리 근거·마크다운 안전성(sanitize)·번들 영향·이탈. **PR 후 STOP.**
