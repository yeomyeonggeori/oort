# 파도 6 핸드오프 패킷 — LIVE-5a(#1524) + dsh/위생 4건(#1525·#1526·#1527·#1502)

> 2026-08-18 Fable 발급 · Status: `active`(성재 재개 발화로 발사) · 워커: 단발 무명 Opus 5 ×5.
> planning ID: **PLN-20260815-01** · integrator: momo-main. 각 이슈 본문=1차 정본. #1524는 전용 패킷 `2026-08-18-live-5a-engine-packet.md`가 정본.
> 병렬 파일군: #1524=server-rust(momo-t3·momo-server display 계열)+infra/cubesandbox+runbooks · #1525=scripts 게이트(+문서 위반 정리) · #1526=측정 하네스 신규(제품 코드 비접촉) · #1527=docs(단, **AGENTS.md 비접촉** — 참조만, 렛슨은 리서치/규율 문서에. AGENTS.md 정리는 #1525 몫) · #1502=clients/web(hostedAgents·settings 5파일). **#1510(서버 인용 투영)·#1511(낱말 잔여)은 이번 파도 제외** — 각각 #1524·#1502 랜딩 후 순차.
> 기준: origin/track/engine 최신(fetch 후 goal_claim — #1464로 트랙 base 자동 인지, base 줄 출력 확인).

## 공통 계약
표준 절차(claim→구현→검증→PR `## 계획 이탈`→`goal_release.sh <n> --review`→정지)·merge/close 금지·ADR-0132 정직 규율·공유 계약 파일 소비 테스트+typecheck·red proof 문화·UI goal 웹 프리플라이트 자가 수행·템플릿 §5.1 공통 함정·게이트 후 docker 회수.
보호 정책 경로(scripts/local_gate.sh·AGENTS.md 등) 접촉 goal(#1525)은 정책 마커=momo-main — CI fail은 보고만.

## goal별 보강
- **#1524**: 전용 패킷 §1~§7 전부. momo-turn은 프로덕션 실사용 중 — 은퇴 순서 엄수.
- **#1525**: dsh 정본 §3-A. 범위 결정 1문단(문서·명령 클래스). 기존 위반 발견 시 같은 PR에서 정리(AGENTS.md 포함 가능 — 마커는 momo-main).
- **#1526**: dsh 정본 §3-B. 실측은 재현 스크립트로(1회 손실측 금지). 개선 티켓 후보는 목록만 — 발급은 momo-main.
- **#1527**: dsh 정본 §4. 반영처=`docs/planning/research/` 계열+워커 컨텍스트 규율 문서. **AGENTS.md·CLAUDE.md 비접촉.**
- **#1502**: #1486 회전이 세운 문법(진행=aria-busy+낱말·잠금=aria-disabled+흐림+사유)+#1490 busy prop. 5파일: AiLinkChain·EventSubscriptionSection·AiLinkSection·HostedConnectionSection(2곳)·WorkspaceSection. CleanupArtifactRow 비접촉(랜딩분).

## 컨텍스트 델타
- 새로 고정: 파도 6부터 goal_claim 트랙 자동 인지 사용(#1464 실전 첫 적용 — base 줄 확인이 워커 의무).
- 의도적 미결정: #1525 범위(워커 1문단) · #1526 개선 우선순위(momo-main 후속).
