# goal #851 — MOMO-644: 내 세션 연속성 표면

너는 momo 레포의 Codex worker다. 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/uxui`.** 모델: gpt-5.6-sol medium.

## 0. 착수 전 필수
1. `git status` clean 선검사. `pwd` 확인. 2. 자격증명 탐색 금지·`.env` 금지·시크릿 금지. 3. **PR 후 STOP.**
4. typecheck·test·build·preflight는 돌려라. Playwright는 오케스트레이터. 5. **심볼은 쓰기 전 grep 확인.**

## 1. 전제 (오케스트레이터 검증 완료 — 서버 변경 불요)
- `WorkSession`(api.ts:1036)에 필요한 것이 **이미 다 있다**: `memberId`(사람 소유자) · `hostId` · `status(running|orphaned|ended)` · `startedAtMs` · `endedAtMs?` · `resumedFromSessionId?` · `rootMessageId`(스레드 앵커).
- `WorkHost`(api.ts:1152)에 `online: boolean` · `lastSeenAtMs?` · `displayName`이 있다.
- 실시간 `work.session.started/ended`·ACP 이벤트 파서가 `realtime.ts`에 이미 있다.
- **티켓 본문의 "마지막 활동 시각"은 서버 필드가 없다 — 만들지 마라.** `startedAtMs`·status 전이·실시간 이벤트 수신으로 표현 가능한 범위까지만. 세션별 durable "마지막 활동"이 필요하면 **보고만** 해라(엔진 티켓 사안).

## 2. 만들 것
1. **내 활성 세션 목록**: `memberId === 내 member.id`로 필터(클라이언트 파생). 세션별 — 호스트 displayName·**online 여부**, tool, 채널, startedAtMs, 상태.
2. **바로 붙기**: 각 행에서 관전 터미널(기존 `WorkSessionDetail` 경로)과 세션 스레드(`rootMessageId`)로.
3. **호스트 오프라인 구분**: `host.online === false`인 running 세션은 "호스트 응답 없음"으로 — **살아 있는 것처럼 보이면 안 된다.** orphaned 전이는 서버 sweep의 몫이니 클라이언트가 상태를 지어내지 말고, 표시 톤만 구분해라(기존 `workSessionFormat.ts`의 orphaned 톤 선례).
4. 빈 상태 3종: 세션 0건 · 호스트 0건 · 로드 오류 — 각각 침묵 없이.
5. **위치**: 기존 `WorkPanel.tsx` 확장이냐 별도 표면이냐는 네 판단 — 근거를 커밋에 적어라. 단 기존 워크스페이스 범위 목록을 **깨지 마라**(내 것 필터는 추가 관점이지 대체가 아니다).

## 3. 함정
- `WorkPanel.tsx:495` 주석이 이미 경계를 적어뒀다 — 클라이언트는 running→orphaned를 **추정하지 않는다**. 유지해라.
- 게이트 픽스처에 **online:false 호스트 + running 세션** 조합을 반드시 넣어라 — 이 티켓의 핵심 단정이다. 목 타이밍 아티팩트 금지(#839 교훈): 세션과 호스트 응답이 어긋나게 도착하는 케이스 포함.
- ADR-0139(Proposed — idle 상태)가 승인되면 이 표면에 idle이 얹힌다. **미리 구현하지 마라.** 상태 렌더를 값 열거가 아니라 미지 상태 안전(unknown → 중립)으로 짜두면 충분하다.

## 4. 검증
- typecheck · test 무회귀 · build · preflight 10/10 · 웹 게이트 3종 무회귀(오케스트레이터).
- **게이트로 잠글 것**: 오프라인 호스트의 running 세션이 활성으로 렌더되지 않음 · 내 것 필터가 남의 세션을 보여주지 않음. 레드 증명 절차 명시.

## 5. PR
`feat/851-momo-644-my-sessions` → `track/uxui`. **#850 랜딩 후 머지 예정이므로 충돌 가능 파일(realtime.ts·api.ts)은 최소로 건드려라.** PR 후 STOP.
