# 핸드오프 패킷 — prime 정식 승격 (ADR-0158, 2워커 단발)

- status: **ready** · 기준: `origin/track/engine` 최신(#1187 머지 후) · 워커=단발 Opus 무명 · 발주 전 랜딩분 대조 완료(runId 서비스=미개시 실측 #1183 이탈·adapters/prime=부재·refine 이벤트=구현 0 실측 #1162) · 중간 보고 없음
- 정본: **ADR-0158 Accepted**(D1~D6) · 설계 명세=`research/2026-08-07-prime-refine-upstream-draft.md` §2 · 스파이크 실측=`research/2026-08-06-prime-agent-spike.md`+`scripts/spikes/prime-agent/**` · 선례=#1152(edit)·#1183(여는 표식)·#1165(outcome)·adapters/hermes(상주 형식)
- 경합 지도: W-N=server-rust(momo-messaging·momo-server routes)+openapi / W-O=adapters/prime 신설(+스파이크 참조) — **무교차**. 머지는 N 먼저(O가 N의 와이어를 소비).

## 워커 N — 서버 축: runId 서비스 개시 + refine 이벤트 + 서버측 REST 스트림 닫기
1. **runId 수용(D5)**: REST 메시지 쓰기(POST·PATCH)의 `runId` 거절 해제 — 검증 3종 fail-closed(run 실재·같은 워크스페이스·요청 주체가 그 run의 에이전트 자격). 거절은 기존 ApiError 문법. openapi 등재(하위호환 단정).
2. **서버측 REST 스트림 닫기**: runId가 실리면 `open_stream_message_for_run_in_tx`가 REST로 연 스트림을 찾는다 — 취소/사망 닫는 PATCH가 어댑터 경로에도 발화(ADR-0155 완전체). in-process와 동형 단정.
3. **refine 이벤트 수용(D1~D4)**: `system` 메시지+`props["momo.harnessRefine"]`(스케치 §2의 필드 그대로 — trigger·entryIds·refinementIds·scope), `clientMsgId=RefinementResult.id` 멱등. 스키마 검증은 수용 지점에서(모르는 필드 거절 — #1183 deny_unknown_fields 전례). 롤백 필드는 저장만(D3 — UI 계약 없음).
4. 검증: cargo+실DB(runId 검증 3종 폐곡선·refine 멱등 재시도 1행·REST 스트림 서버 닫기)·red proof ≥3(①남의 run 거절 ②검증 제거→타 워크스페이스 run 통과 재현 ③refine 멱등 제거→중복 공지)·병합 트리 7레인. PR "#1130 서버 축 — 이슈는 어댑터 랜딩까지 오픈"·이탈 절·STOP.

## 워커 O — 어댑터 축: adapters/prime 상주화(D6)
1. `scripts/spikes/prime-agent/`의 rpc_adapter를 `adapters/prime/`으로 승격 — **hermes 전례 형식**(디렉터리 구조·엔트리·README·구성 파일). 스파이크 산물은 남긴다(참조 — 삭제 금지).
2. 계약: prime v0.7.0 핀(SHA 검증 유지)·컨테이너 실행 기본(비샌드박스 금지)·HOME+TMPDIR full 격리(#1162 tenancy 결론 — run_spike의 full 모드 코드 계승)·자격증명은 컨테이너 안(ADR-0004).
3. 스트리밍: #1152 edit 계약 소비(rev 단조·body 절대값)+**여는 POST 표식(#1183)**+runId 탑재(W-N 와이어 — W-N 머지 전엔 로컬 브랜치 병합으로 개발, PR 본문에 의존 명시). 델타 버퍼링은 스파이크 실측 파라미터.
4. refine 관찰→이벤트 발행: refine_complete(RPC 유래)+파일 관찰(커널 유래 — `trigger:"observed-drift"`) 양 경로, D4 멱등 키.
5. 검증: 목 프로바이더로 폐곡선(프롬프트→스트리밍→완결/취소·refine→공지 1행·재시도 무중복)·컨테이너 빌드 실측·red proof ≥2(격리 제거→누수 재현(스파이크 red proof 재사용 가능)·멱등 키 제거→중복 공지)·병합 트리 7레인. **로컬 스택 실연동 1회**(infra/rust compose — 프로덕션 금지·down -v). PR "#1130 어댑터 축"·이탈 절·STOP.

## 공통
무명 단발 Opus·`origin/track/engine` 새 워크트리·동결층 불변·시크릿/프로덕션 금지·Docker down -v·워크트리 보고 후 대기. 스크래치 접두 `primeN-*`/`primeO-*`. 머지 순서 N→O(오케스트레이터)·병합 교차 실측.
