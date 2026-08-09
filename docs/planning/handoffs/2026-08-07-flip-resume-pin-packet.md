# 핸드오프 패킷 — run_turn flip(#1161) + resume 서버 검증(#1139) + pin 다듬기(#1146·#1149) (3워커 단발)

- status: **ready** · 기준: `origin/track/engine` 최신(#1165 머지 후) · 워커=단발 Opus 무명 · 스크래치 파일명 고유 · 중간 보고 없음
- 정본: ADR-0155(Accepted — 결정 5가 #1161의 근거) · #1138 이탈 3(#1139의 실측) · #1145/#1148 리뷰(pin Medium 정본)
- 경합 지도: W-D=momo-agent-worker(lib.rs·stream.rs·partial.rs) / W-E=momo-server routes(work_sessions) — **서버 두 워커는 모듈 분리, 머지는 순차+병합 트리** / W-F=클라 pin 표면(웹·폰) — 서버 무접촉.

## 워커 D — #1161 run_turn in-process 스트리밍 전환
- **핵심**: in-process 턴을 partial 힌트+끝 커밋에서 `stream.rs` 계약(rev 단조 edit)으로 전환 — 채널 메시지가 답 도착과 함께 자란다. 취소/사망의 닫는 PATCH 경로는 #1165가 깔았다(전제 충족).
- 결정 지점(실측으로 답하고 근거 기록): ①`agent.partial` 힌트와의 공존/은퇴 — 750ms 코얼레싱 창은 outbox 볼륨 논거였다. stream edit도 같은 창을 재사용하는 안이 유력(스트리밍 write가 델타마다면 outbox·Centrifugo 폭증 — partial.rs의 산술을 계승)하나, 실측으로 정하라. ②`TurnCommit::Suppressed` 분기 — 스트리밍 중 취소면 이제 닫는 PATCH 경로가 정답(억제는 메시지가 아직 없을 때만). ③최종 커밋과 스트리밍 메시지의 관계 — 같은 `client_msg_id`(run id)로 dedup 합류하는지, 이중 메시지가 안 생기는지가 1급 단정.
- 함정: `partial.rs`·`stream.rs` 머리말 산문이 "flip은 별도 결정" 서술 — 바뀌면 함께 갱신. `ade1_5/6`(#1158) tool_result 키와 무관 유지. hlc/seq 순서 계약(전 프레임 FIFO=partition_key) 불변.
- 검증: cargo workspace+실DB(스트리밍 턴 폐곡선 — 자라는 메시지→완결·취소·사망 3종 종결)·red proof ≥2(①rev 역행 거절 ②취소 시 이중 메시지 부재 — 억제 분기 잘못 살리면 빨강)·병합 트리 3종. 웹/폰 소비는 기존(#1165 꼬리·`momo.stream` props)이 이미 받는다 — 클라 0줄이 이상적, 필요 시 이탈 절에.
- PR "Closes #1161"·이탈 절·STOP.

## 워커 E — #1139 resume 대상 호스트 서버 검증 이식
- **핵심**: Swift `requireResumeTarget` 4검사+target≠source가 Rust 포트에서 누락 — 클라 코어 필터가 유일한 검증. fail-closed로 서버가 최종 검증자가 되게 이식. Swift 원본을 실측해 규칙을 바이트 수준으로 옮기고(발명 0), Rust에 이미 있는 spawn 쪽 판정(`spawn_host_ineligible_reason_in_tx` 계열·`workSessionResumeTargets` 코어 규칙)과 한 뿌리로 — 두 곳에서 지으면 한 곳만 낡는다.
- 경계: momo-server routes(work_sessions)+conformance. 클라 변경 금지(기이행). 와이어 신설 0(거절 코드는 기존 ApiError 문법).
- 검증: 실DB conformance(자격 없는 대상 거절·target=source 거절 폐곡선)·red proof ≥2(검증 제거 시 자격 없는 resume 통과 재현)·`work_control_spawn` 무회귀·병합 트리 3종. PR "Closes #1139"·이탈 절·STOP.

## 워커 F — #1146+#1149 pin 다듬기 묶음 (웹·폰)
- 정본은 두 이슈 본문(리뷰 Medium 항목별) — 원 리뷰 전문 `research/2026-08-0*-*design-review*` 참조. 요지: #1146 M1(폰 스레드 패널 고정 — 잇거나 부재 문서화 중 실측으로 판단)·M2(loaded/failed 비트 — 오프라인 「없습니다」 거짓말 방지)·M3(행 고정 흔적 — 티켓화 or 「왜 안 그리는가」 기록)·N1(목록 시각=정렬 근거 일치+연도)·N2(서로게이트 절단)·N4(두 이름 통일). #1149 M1(스켈레톤이 가진 항목을 가림 — 보여줄 것 없을 때만)·M2(edited+pinned 공존 픽스처)·M3(failed+항목 공존 촬영+separator 소속)·M4(웹 빈 본문 ※ 표지 — 폰 대응 확인).
- "티켓화 or 기록" 항목은 실측 후 판단하고 이탈 절에 근거 — 전부 구현이 강제가 아니다.
- 검증: 웹·폰 스위트+lint 총계·게이트(gate:pin 포함)·red proof(각 수리에 1 — 소형이라 단정 단위 허용)·캡처(바뀐 표면 다크/라이트·pt=px/3)·병합 트리 3종. **UI 변경 — design-review는 오케스트레이터 발주.** PR "Closes #1146, Closes #1149"·이탈 절·STOP.

## 공통
무명 단발 Opus·`origin/track/engine` 새 워크트리·동결층 불변·시크릿/프로덕션 금지·Docker down -v·워크트리 보고 후 대기(정리는 오케스트레이터). 서버 두 PR(D·E)은 오케스트레이터가 순차 머지+교차 실측.
