# 파도 7 핸드오프 패킷 — LIVE-5b(#1549) + #1534·#1510·[#1541+#1542+#1543 묶음]

> 2026-08-18 Fable 발급 · Status: `ready` · 워커: 단발 무명 Opus 5 ×4.
> planning ID: **PLN-20260815-01** · integrator: momo-main. #1549는 전용 패킷 `2026-08-18-live-5b-web-packet.md`가 정본, 나머지는 각 이슈 본문=1차 정본.
> 병렬 파일군: #1549=clients/web(work·timeline)+momo-core(카드 액션 가산) · #1534=infra(compose·self_host_env)+docs(SELF_HOST) · #1510=server-rust(messages 투영)+openapi+momo-core(quote)+web-legacy 재생성 · #1541묶음=clients/web(hostedAgents·settings의 비-ConfirmButton 컨트롤+사유 배선+착지). **#1511(낱말 잔여)은 #1549와 WorkSessionDetail 겹침으로 제외 — 5b 랜딩 후.**
> 기준: origin/track/engine 최신(fetch 후 claim). **claim은 `--base track/engine` 명시**(main goal_claim에 #1464 부재 — 파도 6 교훈).

## 공통 계약
표준 절차·merge/close 금지·ADR-0132·공유 계약 파일 소비 테스트+typecheck(openapi 변경 시 web-legacy `npm run generate:types` 동일 PR — 파도 6 교훈)·red proof·UI goal 웹 프리플라이트·템플릿 §5.1·docker 회수. scripts/·보호 경로 접촉 시 정책 마커=momo-main.

## goal별 보강
- **#1549(앵커)**: 전용 패킷 §0~§7 전부. 서버 비접촉·오버레이는 설계만.
- **#1534(T1)**: #1526 정본(F1·F8) 좌표 — self_host_env.sh가 PLATFORM_ADMIN_EMAILS 생성+정본 compose api가 읽게. 시크릿 비커밋·기본값은 예시 플레이스홀더. 완료 기준=문서 경로만으로 provider 키 등록 성공+bench_onboarding.sh M5 측정 가능. self_host_env.sh는 scripts/ — 정책 마커 대상 여부 확인, fail은 보고만.
- **#1510**: 계약 결정 1문단(ADR-0148 정합 — 권고: QuotedMessage에 `propsKind?` 최소 신호 필드, 서버 인용 투영이 props.kind만 투영·본문 props 비유입) → openapi+서버 투영+quote.ts 판정+양방향(서버 풀림·클라 로컬 풀림) 테스트+거짓 묘비 red proof. 마이그 불요(투영 SELECT 확장). #1508 랜딩분(presentBody) 비회귀.
- **#1541묶음(=#1541+#1542+#1543 한 워커)**: 같은 파일군 3티켓 일괄 — ①비-ConfirmButton 컨트롤 6곳 in-flight 분리(#1541) ②형제-쓰기 잠금 사유 배선(#1542 — CLEANUP_BUSY_NOTE 동형·StartPanel 비대칭 동반) ③완주 착지 로직 이식(#1543 — EventSubscriptionSection:114-127 동형). 문법 정본=#1486 회전·#1490 busy·#1540 랜딩분. PR 1개·`Closes #1541 #1542 #1543`.

## 컨텍스트 델타
- 새로 고정: 같은 파일군 다(多)티켓은 묶음 워커 1기(파도 5 교훈의 역방향 적용).
- 의도적 미결정: #1510 신호 필드 형태(워커 결정 1문단·권고 기재) · #1549 §7 항목들.
