### Design Review — 멈춘 답의 꼬리 (ADR-0155, PR #1165 / feat/outcome-1160)

Screenshots:
- /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/outcome-1160/clients/web/artifacts/pin/stream-stop-row-light.png
- /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/outcome-1160/clients/web/artifacts/pin/stream-stop-row-dark.png
- /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/outcome-1160/clients/mobile/measure/captures/outcome1160-stream-stop-light.png
- /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/outcome-1160/clients/mobile/measure/captures/outcome1160-stream-stop-dark.png

Design Read: 메시지 타임라인 꼬리(상태 서술 한 낱말), 내부 팀 macOS/웹/폰, HIG-first, density 7/10, motion 0/10 (모션 추가 없음).

---

## Phase 0 — Prep / 증거

- 웹 2장(라이트·다크, gate-pin captureShots가 행 단위로 캡처) + 폰 2장(라이트·다크, measure 하네스 `stream-stop`, 1206x2622 @3x). 폰은 세 판(완결 무언·「중단됨」·「응답이 끊김」)이 한 장에 나란히 선다 — 요구 충족.
- 웹은 「중단됨」 한 판만 촬영됨. 방어 경로(「응답이 끊김」)의 웹 사진은 없다 (→ M-3).
- increased-contrast·large-type 변형: 미촬영. SKIPPED로 기록.

## Phase 1 — Interaction

- 꼬리는 비인터랙티브 텍스트 한 조각. 새 컨트롤 0, 키보드 경로 변화 0. 웹 행의 roving focus·롱프레스·액션 컬럼은 코드상 무변경(꼬리 span은 `data-row-action` 없음 — 포커스 정거장을 늘리지 않는다). 히트테스트 추론으로 클리어, 죽은 컨트롤 없음.

## Phase 2 — Window behavior / 좁은 폭

- 웹: 꼬리 줄은 `flex flex-wrap gap-2` — 「중단됨 · 수정됨 · 고정됨 · 답글 N개」가 다 서도 줄바꿈으로 산다. 폰: `tailRow`에 `flexWrap: 'wrap'` 확인(MessageRow.tsx buildStyles). 한국어 고정 낱말이라 영어 전용 길이 가정 없음. 클리핑 없음(캡처 4장 전부 전체 낱말 가독).

## Phase 3 — Visual polish (토큰·실측)

- **잉크 동일성**: 폰은 `styles.tailMark`(= `color.textFaint`) 하나를 「수정됨」·「고정됨」과 공유 — 구조적으로 같은 잉크. 픽셀 실측: 라이트에서 mark·rollup 모두 ink=(132,129,125), 다크 모두 (107,114,128) — 행 안 완전 일치, accent 오염 없음(중립 회색/한색 계열, 폰 accent 파랑·웹 호박 어느 쪽 값도 아님). 웹은 gate-pin 6d가 computed color로 「수정됨」과 동일·accent/danger 불일치를 매 런 단언하고, 실측 ink는 라이트 (114,109,104)/다크 (146,143,154) — `--ink-muted` 계열.
- **대비**: 웹 4.74:1(라이트)·5.68:1(다크) — 보조 텍스트로 충분. 폰 3.59:1/3.91:1 — AA(4.5) 미달이나 이 레포가 faint 잉크에 스스로 세운 하한(≥3:1, conversationVisual.test.tsx:170)은 충족, 그리고 「수정됨」과 같은 값이라는 것이 이 ADR의 계약 (→ N-1).
- **배치**: 꼬리 배열 맨 앞(stopMark → 수정됨 → 고정됨 → 답글) — 웹 DOM 순서·폰 tail 배열 순서 모두 확인. 「본문 서술이 가장 안쪽」 논거가 코드 주석과 코어 독스트링에 있음. 본문은 얼려져 그대로(캡처 4장 전부 「배포 로그를 보면 첫 번째 원인은」이 문장 중간에서 끊긴 채 완전 표시).
- Mac AI-Tells 해당 없음(칩·배지·펄스 없음, 흐린 글자 한 낱말).

## Phase 4 — Accessibility

- 폰: `tail` 배열이 `rowAccessibilityLabel`의 재료(MessageRow.tsx:1449-1465, 2130-2141) — stopMark가 라벨 맨 앞 서술로 실리고 테스트가 `중단됨` 포함을 단언(conversationVisual.test.tsx:1292-1295). 웹: 행이 aria-label을 덮지 않으므로 DOM 순서 그대로 낭독 — 시각 순서=낭독 순서.
- reduceMotion: 신규 애니메이션 0 — 해당 없음.

## Phase 5 — Robustness

- 침묵 기본값: 완결(무언)·도착 중(무언)·사람 글(marker 없음 → null)·낯선 outcome 토큰(null로 강등) 전부 코어 `streamStop.ts`에서 처리, 테스트 있음.
- 묘비 억제: 웹 `deleted ? null`(MessageRow.tsx:345)·폰 동일(1447)·폰 테스트(1303-1306) — 클리어.
- 부재≠종결: `endedRuns`는 터미널 프레임을 **본** run만 적고, 레일 트랙 부재를 종결로 읽지 않는다(웹·폰 각 스토어 헤더에 논거). 소문자 접기 규칙이 `streamRunId`와 스토어 양쪽에서 일치. 워크스페이스 전환 시 `resetEndedRuns` — 다른 세션의 run id 상속 없음.
- 재렌더 예산: 목록이 한 번 구독하고 행엔 boolean(`runEnded`)만 — 폰 memo 비교에 `runEnded` 추가됨(빠졌으면 취소 직후 행이 안 깨어나는 버그가 됐을 자리, 잘 막음).

## Phase 6 — Code health + 기계적 프리플라이트

- 문구는 코어 상수 한 곳(`STREAM_CANCELLED_MARK`·`STREAM_CUT_OFF_MARK`, packages/momo-core/src/features/timeline/streamStop.ts:132·141). **웹·폰 src에 중복 리터럴 0** (grep 실측 — 테스트·게이트의 리터럴은 의도된 독립 단언).
- 프리플라이트 grep 원출력:
  - `Color(red:` in macOS/Core Swift views: 0 hits (exit 1)
  - `Font.custom | .font(.system(size` in macOS views: 0 hits (exit 1)
  - raw hex in 변경된 웹/폰 view 파일: 주석 내 인용 6건뿐, 코드 0
  - 신규 사용자 노출 문자열의 em-dash: 0 (`중단됨`·`응답이 끊김` — 상수 자체 클린; hits는 전부 독스트링)
- 두 낱말의 구분 논거(「중단됨」=아는 행위 / 「응답이 끊김」=모르는 종결)가 코어 헤더에 있고 방어 경로가 사람에게 행위를 귀속하지 않음 — 카피 판단으로도 옳다.

## Phase 7 — Copy

- 상태 서술이므로 동사형 버튼 규칙 비해당. 하이프 어휘 0. 용어 일관(「수정됨」·「고정됨」과 같은 격의 -됨/명사형). 픽스처 본문은 실제적 한국어 팀 콘텐츠.

## ADR-0155 정합 (결정 3 방어 렌더링)

- 판정 함수 성립: `streamStopMark` = outcome 존재(cancelled→중단됨, failed→응답이 끊김) ∨ `streaming && runIsOver`→응답이 끊김 (streamStop.ts:154-167). 코어 테스트 + 폰 컴포넌트 테스트 + 폰 캡처(세 번째 판)로 확인.
- 배선 성립: 워커가 취소(lib.rs:1536)·사망(lib.rs:1799) 양 경로에서 `close_stopped_stream` best-effort PATCH, 트랜잭션 밖(재시도 루프 오염 방지 논거 명시). 클라는 터미널 `agent.status`를 본 run을 `endedRuns`에 적고 Timeline이 행마다 판정. openapi `StreamEdit.outcome`(final:true 동반 강제, 그 외 400) 문서화 확인.
- **구멍 하나**: 방어망이 세션-로컬이다 (→ M-2).

---

## Findings

[High]
- **H-1 · gate-pin.mjs 픽스처 id 충돌**: 신설 `STOPPED_MSG`(clients/web/gates/gate-pin.mjs:175)가 기존 `VOICELESS_MSG`(:180)와 **같은 UUID** `0199bbbb-…c5`·같은 seq 45를 쓴다. `exerciseKeepsWhatItHas`와 captureShots 실패 판에서 「본문 없는 고정 메시지」 페르소나의 pin 프레임이 이제 본문 있는 멈춘 행을 고정하고, 같은 id의 역사 행은 본문을 가진다 — 픽스처가 자기모순이 됐다. 오늘은 두 단언이 다른 표면(pin 목록 vs 타임라인)을 읽어 우연히 초록이지만, id로 조회하는 다음 단언부터 어느 페르소나를 재는지 아무도 모른다. c6 자리가 비어 있다.

[Medium]
- **M-2 · 방어 렌더링이 새로고침을 넘지 못한다 (ADR 결정 3 부분 성립)**: `endedRuns`는 터미널 프레임을 그 세션에서 본 run만 안다. 닫는 PATCH 실패 + 리로드(또는 히스토리 독자)의 이중 실패 판에서, `streaming:true`로 남은 반쪽 답이 **완결된 답의 옷을 입는다** — ADR이 C안을 기각한 바로 그 거짓말이 이 구석에 남는다. 클라 단독으로는 못 고친다(부재≠종결 원칙이 옳으므로): 페이지 읽기에 run 터미널 상태를 동봉하는 엔진 후속이 필요. X-17 핸드오프에 이 한계가 명시돼 있지 않다 — 후속 티켓과 함께 적을 것.
- **M-3 · 증거의 저자 신원이 제품과 다르다**: 네 캡처 모두 멈춘 답의 저자가 사람 모양(원형 아바타, @핸들·관리 병기 없음)이다. 스트리밍하는 것은 에이전트뿐이므로 실제 화면 해부(에이전트 아바타·agent 잉크 핸들, 같은 행의 AgentCard/턴 기록과 꼬리의 동거)는 한 장도 촬영되지 않았다. 웹은 방어 판(「응답이 끊김」) 사진도 없다(폰이 대신 보였음). 다음 캡처 배치에서 에이전트 저자 + 카드 동거 판을 추가할 것.

[Nitpick]
- **N-1 · 폰 faint 잉크 3.59:1/3.91:1**: 레포 자체 하한(≥3:1)과 「수정됨」 동일성 계약은 지켰으나 WCAG AA 텍스트 기준 미달. 이 낱말은 장식이 아니라 「이 답은 미완」의 유일한 기록이므로, 폰 팔레트가 다음에 faint 잉크를 손볼 때 이 낱말도 함께 오르는지 지켜볼 것(웹은 4.74/5.68로 여유).
- **N-2 · 게이트 픽스처 run_id `0199bbbb-…r1`**: 'r'은 UUID hex가 아니다. 클라는 문자열로만 읽어 무해하나, UUID 모양을 주장하는 픽스처 규약과 어긋난다.

Verdict: **PASS** (Blocker 0 · High 1 · Medium 2 · Nitpick 2 — High ≤2이므로 휴먼 리뷰 진행 가능, H-1은 이 PR에서 수리 권고)
