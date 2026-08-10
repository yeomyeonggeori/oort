# 핸드오프 패킷 — 3차 소형 위생 (W-F1 #1246 · W-F2 #1248)

> 발주: 2026-08-10 Fable. 공통 규율: wave1 패킷과 동일(워크트리 base=origin/track/engine · PR base=track/engine · STOP).

## W-F1 — #1246 staging-smoke 픽스처 현행화 · 브랜치 `fix/staging-fixture-1246`

- 근거: PR #1245 적립 — `verify_staging_smoke.sh:171` STRICT_ENV 픽스처가 runtime-role 분리 이전·multibinary 이전 형태(필수 키 7 누락, 2026-07-23부터 red).
- 픽스처를 현행 `prod_env_preflight.sh` strict 계약으로 재작성(W-H의 #1245 방식 승계: 저엔트로피 더미 값 — gitleaks 베이스라인 오염 금지).
- 검증: `verify_staging_smoke.sh`가 preflight 단계를 **통과**해 다음 단계로 진행(전체 그린까지 요구하지 않음 — 다음 단계가 별개 결함이면 적립 보고) + red proof(키 하나 제거 시 preflight가 그 이름으로 죽음).

## W-F2 — #1248 join.rs 이메일 비교 통일 · 브랜치 `fix/email-join-1248`

- 근거: PR #1247 적립 — `join.rs`의 raw `h.email = $1` 4곳(호출자 규율에만 의존). 064 제약으로 저장측은 안전 — 위험은 조회 miss.
- #1247의 방식 승계: SQL 자체 표현식 `lower(btrim($n))`(Rust 정규화 금지 — btrim/trim 불일치). 4곳 전수 + 웹/코어 로그인 폼 클라측 정규화(`packages/momo-core` 로그인 입력 — 소형, 실재하면).
- 검증: `cargo test --workspace` + 대문자 이메일로 해당 경로 각각의 왕복 테스트(기존 테스트 픽스처 재사용) + red proof 1곳 + **병합 트리 8레인**(core 접촉 시).

## 보고
PR 번호+검증+적립. 중간 보고 없음. 서로·타 워커 파일 무접촉.
