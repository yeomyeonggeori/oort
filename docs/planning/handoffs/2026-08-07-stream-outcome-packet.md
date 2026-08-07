# 핸드오프 패킷 — ADR-0155 구현: stream.outcome 동결 계약 (#1160, 1워커 단발)

- status: **ready-after(W-A/W-B 랜딩 후)** — dark-1155 워커가 폰 테스트·토큰을 만지는 중이라 클라 파일 경합 회피. 발사는 현 배치 머지 뒤.
- 정본: **ADR-0155 Accepted**(docs/adr/0155-cancelled-streaming-message.md — 결정 5항이 곧 수용기준) · #1160 · #1152(edit 계약 선례 PR)

## 과업 체인 (한 워커, 서버→코어→클라 순)
1. **momo-messaging**: `StreamEdit`에 `outcome` 수용(`"cancelled"`|`"failed"` — rev 단조·final 규칙 불변, outcome은 final:true와만 동반 가능하게 검증). openapi PATCH stream 블록에 선택 필드 등재(하위호환 — 기존 소비자 무영향 단정).
2. **worker 생산자**: 취소 경로(lib.rs Suppressed 분기 — 스트리밍 중이면 Suppressed 대신 닫는 PATCH)·사망 경로(mark_run_failed)에서 닫는 PATCH 1회 best effort. 실패 시 final:false 잔류 허용(방어 렌더링이 받는다) — 로그만.
3. **코어**: 렌더 판정 1개(outcome 존재 ∨ run 종결×final:false → 같은 꼬리)+문구 상수(appVoice 계열 — 「중단됨」/「응답이 끊김」 두 값). 판정을 웹·폰이 공유.
4. **웹·폰 꼬리 렌더**: 절제된 톤(accent 금지 — 상태이지 강조가 아님). ephemeral(agent.partial) 경로 무접촉 단정.

## 함정
- `stream.rs` 머리말·`partial.rs` 정책 산문이 현행 전제를 서술 — 바뀌는 문장은 함께 갱신(산문이 코드를 거짓말하게 두지 않기).
- 취소-동결 메시지는 보통 메시지 — 인용·고정·검색 회귀 단정 각 1.
- `ade1_6`(#1158)이 tool_result 키를 잰다 — stream 키 공간과 무관함을 건드리지 않기.

## 검증
cargo workspace+실DB(스트리밍 conformance — 취소가 outcome을 남기는 폐곡선) · red proof ≥2(①닫는 PATCH 제거 시 final:false 잔류를 방어 렌더링 단정이 잡음 ②outcome이 final:false와 동반 시 거절) · 코어/웹/폰 스위트+병합 트리 3종 · UI 변경이므로 **design-review는 오케스트레이터 발주**. PR "Closes #1160"·이탈 절·STOP.
