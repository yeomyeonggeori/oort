# 핸드오프 패킷 SRV-B6 — 하네스 위생 묶음 (#1038)

- status: **ready** · worker: SRV-B3 워커(전 결함 3종의 발견자) · 기준: `origin/track/engine` 최신 · 한 goal(묶음), PR 1~2장 재량
- 발단: 오늘 사이클에서 확정된 하네스 결함 3종 — 전부 "게이트가 다른 것을 보고 있었다" 계열.

## 범위 3건

1. **게이트웨이 모드 하네스 신설**: `AGENT_GATEWAY_MODE=gateway`를 구성하는 실DB 스위트 0(#1037·#1012 실측) — `/agent-runs` 생성 표면·gateway `events`가 HTTP 레벨 무검증. 최소 하네스 1개(게이트웨이 모드로 부팅→작업 런 생성→events 왕복→투영 단정).
2. **momo-push 픽스처 격리**: device conformance가 고정 토큰이라 재실행 불가(#1039 실측 — 첫 DB만 10/10). 런당 랜덤화 또는 셋업 정리 — `cargo test --workspace` 한 방이 초록이 되게.
3. **openapi 게이트 재조준**: `verify_openapi_contract.sh`의 e2e 스택이 `swift:6.2` — 스펙이 이제 Rust를 서술하므로(#1040) **server-rust 스택을 샘플**하게 전환. Swift 병행 기간엔 듀얼 샘플이 과하면 Rust 단일로(스펙 정본=배포본 원칙, 근거 주석). #1040이 예고한 "승인 샘플 예상 빨강"이 이걸로 해소되는지 확인.

## 계약

- 수정: server-rust/**·scripts/verify_*·infra e2e compose. 제품 로직 무변경(하네스·게이트만). 프로덕션 접촉 금지.
- 검증: ①신규 게이트웨이 스위트 green+red proof ②push 스위트 2연속 실행 green ③openapi 게이트가 Rust 스택 대상으로 전 경로 green(승인 포함). ④`cargo test --workspace` 한 방 green이 최종 단정.
- 턴 규율 유지(20분·마일스톤 보고). PR "Closes #1038".
