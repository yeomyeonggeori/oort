# ADR-0158 — prime 3번째 provider 정식 승격 + 자기수정(refine) 채널 이벤트

- Status: **Accepted** (기안 2026-08-08 Fable · 성재 결정 3건 2026-08-08 — 판단지점 인터뷰로 확정)
- 관련: #1130(전제 3건 — ①#1152 edit 계약 ②#1162 refine 감사 ③#1162 HOME 격리, **전부 충족**) · #1128 스파이크 판정("3번째 provider 승격 가치 있음") · `research/2026-08-07-prime-refine-upstream-draft.md` §2(채널 이벤트 설계 스케치 — 이 ADR의 구현 명세) · #1183(여는 표식) · #1173/#1183 이탈(runId 서비스 전제)

## Context

prime(MIT CLI 하네스)은 스파이크에서 steer·승인 다이얼로그·스트리밍이 단일 쓰기경로 폐곡선 위에서 실증됐고, 전제 3건이 전부 랜딩됐다. 남은 것은 ①REST 어댑터의 `runId` 서비스 개시(현재 거절 — 서버측 스트림 닫기의 전제) ②자기수정(refine)을 채널에 알리는 이벤트 계약 ③스파이크 어댑터의 상주화다.

## Decision

1. **D1 — refine 공지=채널 기본 공개** (성재 확정): 에이전트=1급 멤버 정체성 — "동료가 스스로를 바꿨다"는 팀이 보는 사실. 조용한 `system` 줄.
2. **D2 — 메시지 타입=`system` 재사용** (성재 확정): 새 타입 0. `props["momo.harnessRefine"]`(스케치 §2 — trigger·entryIds·refinementIds·scope)로 구분 가능하게 실어, 필터 수요 실증 시 분리 여지.
3. **D3 — 롤백=v0 비노출** (성재 확정): `rollbackId`는 원장/감사에만. 채널 되감기 UI는 수요 실증 후 별건.
4. **D4 — 멱등**: `clientMsgId = RefinementResult.id`(스파이크 §8의 "재시도 키 없음"이 공짜로 해소 — 스케치 그대로). 커널 경로(이벤트 무음) 유래는 `trigger:"observed-drift"`로 파일 관찰자가 발행.
5. **D5 — runId 서비스 개시**: REST 메시지 쓰기에 `runId` 수용(현재 거절 → 검증 후 허용 — run 실재·같은 워크스페이스·어댑터 자격). 이로써 `open_stream_message_for_run_in_tx`가 REST 스트림을 찾고 **서버측 닫는 PATCH가 어댑터 경로에도 성립**(ADR-0155 완전체). 검증은 fail-closed — 남의 run·타 워크스페이스 run 거절.
6. **D6 — 어댑터 상주화**: `scripts/spikes/prime-agent/` → `adapters/prime/`(hermes 전례 형식). v0.7.0 핀·HOME+TMPDIR full 격리(#1162)·stream 계약 소비(#1152 edit+#1183 여는 표식+outcome 닫기)·refine 관찰→D1~D4 이벤트 POST. 컨테이너 실행이 기본(비샌드박스 금지 — 스파이크 격리 결론 계승).

## Slack·업계 비교

Slack 앱은 자기수정이 없다 — 이 표면은 에이전트 네이티브 고유. Devin/Cursor류는 자기 설정 변경을 개인 로그에 묻지만, 멀티플레이어 채널 제품에서는 D1처럼 팀의 사실이어야 한다(1인용은 세션 상태로 때워도 채널 히스토리는 자기서술 — ADR-0155와 같은 논리).

## Consequences

- 서버 축: runId 검증 3종+refine 이벤트 수용+서버측 REST 스트림 닫기. 어댑터 축: adapters/prime 상주.
- ADR-0004 불변: prime 자격증명(로그인)은 어댑터 컨테이너 안에서만 — 서버·원장 비유입.
- 미결(수요 실증 후): refine 필터/전용 타입 분리·롤백 UI·prime의 사용자 노출 provider 승격(v0=운영자 구성).

## 증보 1 — D7 (2026-08-08 성재 승인)

**에이전트 토큰에 메시지 PATCH 스코프 허용 — 저자 본인 메시지 한정.** W-N이 적발한 공백(스코프 표가 POST만 — Swift 시절부터, 아무도 안 물은 질문): 이게 없으면 어댑터가 자기 자격증명으로 stream edit 계약(#1152)을 소비할 수 없다(스파이크가 턴당 17 메시지였던 실제 이유). 결정: `required_agent_scope`에 PATCH 메시지 라우트 추가 + **저자 검사**(에이전트는 자기가 쓴 메시지만 — 사람 edit의 기존 저자 검사와 대칭). 전용 라우트 신설·보류는 기각(전자=표면 추가 비용, 후자=17메시지 회귀).
