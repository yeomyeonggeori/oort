# #1716 첨부 실측 크기 패킷 — 「0 B」 잰 척 제거의 서버 절반

> Status: `ready` · Planner: Fable · Integrator: momo-main · 트랙=engine · 워커=grok · 검수=Fable
> 근거: #1703 design-review Medium-1(전송 후 메타줄이 크기 미독 파일을 「파일 · 0 B」로 표기 — 웹·폰 공통). 잔재 표식=momo-core model.test.ts의 해당 단정 주석.

## 계약

1. **선행 실측(보고 의무)**: 클라가 `sizeBytes: 0`(sizeKnown=false)으로 선언한 업로드가 현행 서버에서 어디까지 가는가 — create 수용 여부, PUT 후 complete의 크기 대조(mismatch 거부?)까지 코드·테스트로 확정하고 보고에 명시.
2. **서버가 실측을 정본으로**: complete 시점에 **실수신 바이트**를 attachment 행 크기로 기록(기존 컬럼 재사용 — 신규 마이그레이션이 필요하면 발급하되 schema_v0 불변). 선언 크기는 사전 검증 힌트일 뿐 정본이 아니게.
3. **미지 크기 선언 경로 개방(필요 시 최소로)**: 1의 실측에서 0-선언이 mismatch로 죽는다면, 미지 선언을 허용하는 최소 계약(예: 선언 0=미지 취급, 대조 생략·실측 기록)을 열고 openapi 문면 갱신. 100MB 상한은 **수신 시점에 실측으로 강제**(선언 우회 불가 red proof).
4. **응답에 실측 반영**: complete 응답과 메시지의 attachments가 실측 크기를 실어 클라의 「0 B」 표기가 데이터로 소멸. 클라 코드 변경은 이 티켓 범위 밖(코어 잔재 주석 갱신만 후속).

## AC
- 단위+PG 통합: 0-선언→실바이트 PUT→complete가 실측 크기로 기록·응답. 상한 초과를 선언 축소로 우회 못 함(red proof). 정상 선언 경로 회귀 무.
- openapi·docs 게이트 그린. worker는 PR(base=track/engine) 후 정지, merge/close 금지.
