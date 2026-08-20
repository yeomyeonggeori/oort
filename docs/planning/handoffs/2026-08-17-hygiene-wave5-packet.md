# 위생 파도 5 핸드오프 패킷 — #1463·#1498·#1501·#1503·#1472 (5 goal 병렬)

> 2026-08-17 Fable 발급 · Status: `ready` · 워커: 단발 무명 Opus 5 ×5.
> planning ID: **PLN-20260815-01** (owner: Fable · integrator: momo-main) · supersedes: 없음
> 정본 goal: 각 GitHub Issue 본문 + 본 패킷. 병렬: 파일군 분리 — #1463=web(work/useWorkSessions)+core(sessionVerification)·#1498=core(timeline/quote)·#1501=web(hostedAgents/CleanupArtifactRow+settings 낱말)·#1503=mobile(AgentDetailScreen)+core(workSessionFormat 역할 결정 시)·#1472=server-rust(fmt)+scripts(local_gate). **#1502(in-flight 5곳)는 #1501과 파일 겹침으로 이번 파도 제외 — #1501 랜딩 후 순차.**
> 기준 커밋: **origin/track/engine 최신**(`ef8d4138` 이후 fetch). claim: `goal_claim.sh <n> --base track/engine`.

## 공통 계약
표준 절차(claim→구현→검증→PR `## 계획 이탈`→release --review→정지)·merge/close 금지·ADR-0132·공유 계약 파일 소비 테스트+typecheck·red proof 문화·UI goal 웹 프리플라이트 자가 수행·템플릿 §5.1.

## goal별

- **#1463(앵커·최대 규모)**: 세션 검증 read-model — 목록 행 칩+장스레드(>1000행) 최신 리포트 도달. **설계 1문단 선행**(원천·왕복 수). 제약: **스키마/서버 투영 신설은 이 goal에서 금지** — 클라 측 해법(예: 세션당 newest-first 소량 페이지 1회로 최신 리포트만 탐색, 기존 oldest-first 이벤트 읽기와 분리) 우선. 서버 read-model이 유일 정합이면 **정지+이탈 보고**(ADR 검토 선행). 정직 규율 유지(부재≠미검증·절단 시 침묵 — 단 이번엔 최신 리포트를 실제로 도달시키는 것이 목표). 좌표: `clients/web/src/features/work/useWorkSessions.ts`(fetchSessionEvents·EVENT_MAX_PAGES)·`packages/momo-core/src/features/work/sessionVerification.ts`·`fetchThreadReplies`의 커서/방향 파라미터 실사.
- **#1498**: core quote.ts:175·:212 런타임 null body — `hasRenderableBody` 규율 정합(4태 테스트·인용 스냅샷). web-legacy 동형은 죽은 코드 검증 후 기록만.
- **#1501**: ①CleanupArtifactRow `busy={saving}` 배선(+hostedDisconnectScope.test.ts:303 낡은 주석 정정) ②낱말 정본화(위임 결정 기집행 — 명사+중): 「저장하는 중」2·「확인하는 중」1·「호스트에 연결하는 중」3 ③AiLinkSection:406 ASCII '...'→U+2026. **HostedConnectionSection의 in-flight 접힘 구조는 비접촉**(#1502 좌표) — 낱말만.
- **#1503**: 폰 AgentDetailScreen.tsx:456·:554 — running=초록(ok) vs 웹 warn 어긋남+unavailable 코어(muted)↔폰(accent). **역할 결정은 웹/코어 표가 정본**(momo-main 위임 결정: 코어 `SESSION_STATUS_CLASS`/워킹시그널 문법을 폰이 소비 — 새 역할 발명 금지, 코어에 없는 키가 필요하면 이탈 보고). 캡처/테스트 동반.
- **#1472**: ①기준 커밋 fmt 드리프트 6파일 `cargo fmt` 정리(의미 무변경 — diff가 포맷뿐임을 증명) ②local_gate에 fmt 단계 도입 여부 결정 1문단(버전 스큐: rust-toolchain 비신설 판정(#1442) 정합 — 도입 시 버전 검사 동반 또는 미도입 근거) ③#1377 문서 정정 연계 확인. server-rust 소스 의미 변경 금지.

## 컨텍스트 델타
- 새로 고정: 겹침 파일 goal은 파도 분리(순차)로 처리. #1503의 역할 정본=코어 표.
- 의도적 미결정: #1463 클라 해법의 구체 형태(설계 1문단) · #1472 게이트 단계 도입(결정 1문단).
