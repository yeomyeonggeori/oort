# 워커 브리프 — #1265 웹훅 인바운드 공개 ingress 2경로 Rust 이식: `POST /v1/webhooks/{ws}/{installation}`(서명) · `POST /hooks/{token}`(Slack 호환) (engine · #1265 · ADR-0115 Accepted 계약 이식)

> 워커: grok 4.6 · base=origin/track/engine · 워크트리 `momo-worktrees/w1265`(`feat/1265-webhook-inbound`) · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. `scripts/**` 중 허용: `scripts/verify_webhook_rust.sh`(인바운드 케이스 추가)·`scripts/tests/test_webhook_inbound_contract.sh`(신규) — 정책 감사. `.github/**` 무접촉. `server/Migrations` **신규 파일만**(번호 순, `check_migration_numbers`), `schema_v0.sql` 무접촉. 시크릿 금지.
> 근거: ADR-0115(D1 서명 수신 · D2 Slack 호환 `/hooks/{token}` URL-시크릿 모델 · D3 레이트리밋 · D4 본문 크기 가드) · ADR-0113(D4 Slack 호환 채택) · Rust 송신·관리 이식 #1222/#1264(`server-rust/crates/momo-webhook`: `crypto.rs` 서명 파생·`subscriptions.rs`·`outbound.rs`; `routes/webhook_admin`) · Swift 원본 `f399e417:server/Sources/MomoServer/Routes/WebhookRoutes.swift`(ingress 2경로·검증 순서·오류 코드) · 하드 룰: 단일 쓰기경로(REST → PG → outbox → relay) — 인바운드는 메시지를 **REST 경로로** 생성(직접 INSERT 금지), `message.seq` 서버 배정.

## 1. 구현 계약
1. **라우트 2**: `POST /v1/webhooks/{ws}/{installation}` — 헤더 서명(`momo-webhook` crate의 파생과 동일 알고리즘, 타임스탬프 창·리플레이 캐시) 검증 → 본문 스키마(텍스트/blocks 부분 지원은 ADR-0115 D2 범위) → 설치의 대상 채널에 에이전트/봇 멤버 명의로 메시지 생성(기존 메시지 생성 경로 호출) → 202/200 영수증. `POST /hooks/{token}` — 고엔트로피 토큰 조회(설치 테이블의 인바운드 토큰, 해시 저장) → Slack 호환 페이로드(`text`·`blocks` 일부·`attachments` 미지원 시 명시 오류) → 같은 생성 경로.
2. **가드**: 본문 상한(ADR-0115 D4 값 그대로) · 설치별 레이트리밋(슬라이딩 창, 429) · 폐기된 설치/토큰 → 404(존재 누설 금지, 두 경로 동일 문장) · 인증 실패 401(서명)·404(토큰) — Swift 원본 코드와 대조표를 PR에.
3. **저장**: 인바운드 토큰이 스키마에 없으면 마이그레이션 1본(해시·회전·폐기 컬럼). 회전·폐기는 기존 관리 REST(#1222)가 담당 — 없으면 최소 `rotate` 1개만 추가(범위 명시).
4. **문서**: `docs/api/openapi.yaml`에 2경로(`verify_openapi_contract_rust.sh` 초록) · `docs/SELF_HOST_AGENT.md` 「웹훅으로 보내기」 절 5줄(+ko) · 셀프호스트 공개 엣지에서 `/hooks/*`가 CSP·403 규칙과 충돌하지 않음을 `Caddyfile` 픽스처로 확인(Caddyfile 무수정 — 안 맞으면 보고 후 정지).

## 2. red proof
- 컨포먼스(`server-rust/bins/momo-server/tests/webhook_inbound_conformance_pg.rs`): 서명 OK/위조/만료/리플레이 · 토큰 OK/폐기/오타(404 동일 문장) · 본문 초과 413 · 429 · 생성된 메시지가 `message.seq` 연속·outbox 행 존재(단일 쓰기경로) · 직접 INSERT 0(코드 grep).
- `scripts/verify_webhook_rust.sh` 인바운드 케이스 + 시험 스크립트 · `cargo test --workspace` · docs·web 프로파일 · 사보타주: 서명 검증 순서를 본문 파싱 뒤로 옮기면 RED(리플레이 케이스).

## 3. 완료 절차
커밋 순서: ①마이그레이션(필요 시)+토큰 모델 ②서명 경로(RED→GREEN) ③Slack 호환 경로 ④가드 ⑤OpenAPI·검증기·문서. push → PR(base `track/engine`): 대조표·게이트 원문·보호 경로 목록. `DONE / COMMITS / GATES / PR / NOTES`.

## 4. 규율
단일 쓰기경로 위반 금지. 존재 누설 금지(두 경로 오류 문장 동일). 막히면 보고 후 정지.
