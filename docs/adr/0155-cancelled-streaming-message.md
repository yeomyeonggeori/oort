# ADR-0155 — 취소된 스트리밍 메시지: 정지 버튼 뒤에 남는 것

- Status: **Proposed** (기안 2026-08-07 Fable · 승인=성재)
- 관련: ADR-0154(ADE 관제 표면) · #1152(메시지 edit 계약 — stream rev) · #1130(prime 전제 ①)

## Context

오늘의 취소는 "아무것도 남기지 않기"다. run이 enqueue와 commit 사이에 취소되면 워커는 답을 버린다(`TurnCommit::Suppressed("run cancelled")` — `momo-agent-worker/src/lib.rs:1349-1352`). 채널에는 메시지가 없고, 배지는 터미널 상태 프레임으로 배운다. 이것이 가능한 이유는 **답이 끝에 한 번 커밋되기** 때문이다 — 진행 중 화면은 ephemeral `agent.partial` 힌트(`partial.rs` — "a lost partial is nothing")가 채우고, durable한 것은 아직 없다.

\#1152가 이 전제를 바꿀 장치를 랜딩했다. 스트리밍 edit 계약(`stream.rs`)에서는 **턴 시작에 메시지가 실재**하고 rev 단조로 자라난다. prime/hermes 어댑터가 이미 이 계약의 소비자이고, in-process 턴의 전환(`run_turn` flip)은 의도적으로 미뤄져 있다 — 그 이유가 바로 이 ADR이다. `stream.rs:14-21` 원문: *"post nothing" is no longer available — the message already exists — and what a cancel should then do to it (tombstone it, freeze it mid-sentence, mark it abandoned) is a product decision about what a human sees after they press stop.*

같은 질문이 취소가 아닌 **프로바이더 사망**에도 있다: `mark_run_failed`(lib.rs:1697~)는 오늘 메시지를 쓰지 않지만, 스트리밍 중 사망이면 반쯤 자란 메시지가 이미 채널에 있다.

## Options

**A. 동결 + 명시 마킹 (권고)** — 부분 본문을 그대로 두고, 마지막 PATCH 한 번으로 `stream` 블록을 닫는다: `{rev: N+1, final: true, outcome: "cancelled" | "failed"}`. `state`·`edited_at` 불변(#1152의 "답의 도착은 수정이 아니다"와 같은 논리 — 중단의 도착도 수정이 아니다). 클라이언트는 `outcome`을 읽어 본문 꼬리에 절제된 「중단됨」/「응답이 끊김」을 그린다.
- 근거: **사람이 이미 읽은 텍스트는 사라지지 않는다**(정지를 누른 사람은 그 부분 답을 보고 눌렀다 — 그 근거를 지우면 "내가 왜 멈췄지"가 함께 사라진다). 메시지가 자기서술적이라 히스토리 독자가 run 테이블 없이도 진실을 안다. 와이어 추가는 선택 필드 하나.
- 함정 처리: 닫는 PATCH 자체가 실패하면 메시지는 `final: false`로 남는다 — run 터미널 상태가 이미 durable하므로(job status가 진실) 클라이언트는 "run은 끝났는데 stream이 열림"을 감지해 같은 꼬리를 그릴 수 있어야 한다(방어 렌더링, 서버 sweeper 불요).

**B. 삭제(tombstone)** — 취소=없던 일. 오늘의 Suppressed와 대칭.
- 기각 사유: 읽은 것이 사라지는 유일한 경로가 된다(U4 삭제 접기는 **저자의 의사**였다 — 이것은 시스템이 지우는 것). 부분 답을 인용/고정했다면 참조가 끊긴다. "멈춤"과 "철회"는 다른 행위다.

**C. 동결, 마킹 없음** — 가장 싸다.
- 기각 사유: 거짓말이다 — 문장 중간에서 끝나는 답이 완결된 답과 같은 옷을 입는다.

## Decision (Proposed)

**A안.** 세부:
1. `stream.outcome` 선택 필드 신설(`"cancelled"`·`"failed"` 두 값 — 정상 완결은 오늘처럼 `final: true`만). 생산자 의무: 취소/사망 경로에서 닫는 PATCH 1회, best effort.
2. ephemeral 모드(`agent.partial`)는 **불변** — durable한 것이 없으므로 Suppressed 유지. 이 ADR은 스트리밍 edit 모드에만 적용.
3. 클라 렌더링: `outcome` 있는 메시지 + "run 종결인데 `final: false`"인 메시지 둘 다 같은 꼬리(방어 렌더링). 문구는 코어 상수(appVoice 계열)로 한 곳에.
4. 취소-동결된 메시지는 보통 메시지다 — 인용·고정·검색 전부 그대로.
5. `run_turn`의 스트리밍 전환(in-process flip)은 이 ADR Accepted를 전제 조건으로 하는 **별도 티켓**.

## Slack·업계 비교

Slack은 스트리밍 자체가 없다(전송=완결) — 비교 대상은 어시스턴트 제품군. Claude.ai·ChatGPT 모두 정지 시 **부분 답을 남기고** 정지 어포던스를 표시한다(삭제하는 주류 제품 없음). 우리 차별점은 메시지가 멀티플레이어 채널의 사실이라는 것 — 그래서 "남긴다"만으로 부족하고 `outcome`이 메시지 자체에 기록되어야 한다(1인용 UI는 세션 상태로 때울 수 있지만 채널 히스토리는 자기서술이어야 한다).

## Consequences

- openapi: PATCH stream 블록에 `outcome` 선택 필드 1개(하위호환 — 기존 소비자 무영향).
- 코어: 렌더 판정 1개(`outcome` 존재 ∨ run 종결×`final:false`)와 문구 상수.
- 미결로 남기는 것: 취소된 부분 답을 에이전트가 다음 턴에 "이어쓰기"할 수 있는가 — 수요 실증 전까지 열어둠(재개는 새 메시지).
