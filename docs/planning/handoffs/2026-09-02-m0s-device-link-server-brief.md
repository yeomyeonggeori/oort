# 워커 브리프 — M0s 기기 연결 서버 절반: 1회용 링크 토큰 발급·소비 (engine · **ADR-0180 Accept 후 개방**)

> 워커: grok 4.6 · base=origin/track/engine · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. `schema_v0.sql` 무접촉(신규 마이그레이션 1본). MCP 금지. 토큰 원문은 로그·테스트 출력·PR 본문 비유입.
> 정본: **ADR-0180 D1~D6** 전부 구속. 선례 코드: `POST /v1/claim`(`routes/claim.rs` — 1회용 토큰 소비·해시 저장)·hosted pairing challenge(`routes/hosted_agent_connections.rs`)·`POST /v1/join`(공개 라우트 마운트 사유·per-IP 레이트리밋)·`momo-auth` `record_session_token`/`revoke_member_session_tokens`(세션 발급·회수)·`LoginResponse`(`dto.rs:116` — access/refresh/member/realtime_web_socket_url).

## 구현 계약
1. **마이그레이션** `086_device_link_token.sql`(번호는 `scripts/check_migration_numbers.sh`로 확정): `device_link_token(id, workspace_id, member_id, issued_session_token_id, token_hash, sas text, expires_at, consumed_at, device_label, created_at)` + RLS `ws_isolation` + 인덱스(hash unique·expires). 만료 행 청소는 소비/발급 시 게으른 삭제(cron 신설 금지).
2. **라우트** ①`POST /v1/auth/device-link`(인증·`require_human`) → 201 `{id, token(원문 1회), expiresAt, sas?, deepLink:"oort://link?server=…&token=…"}` — `server`는 요청의 공개 오리진(ADR-0167 same-origin 파생 규칙 재사용). ②`POST /v1/auth/device-link/redeem`(공개, `/v1/join`과 같은 마운트·레이트리밋) 본문 `{token, device:{name, platform}}` → `LoginResponse` 동형 + `pendingSas: bool`. ③`GET /v1/auth/device-link/{id}`(발급자 세션만) → `{status: pending|consumed|expired, device?}`. ④`POST /v1/auth/device-link/{id}/confirm-sas`(발급자) → 세션 활성. SAS 필요 여부(D4)는 서버 config의 공개 오리진 모드 판정으로만 — **새 env 금지**; 판정 함수가 없으면 config.rs 실사 후 파생하고 NOTES.
3. **세션**: redeem은 그 멤버의 새 세션 토큰 쌍을 발급하되 SAS 대기 중이면 `pending` 상태로 기록(access 경로가 거부) — 활성화 시 정상. 발급자 로그아웃(`revoke_member_session_tokens`)이 미소비 토큰도 무효화.
4. **감사**: `audit_event(kind='device.linked', payload:{device, via:'qr'})`(기존 감사 테이블 문법). 설정 › 기기 목록 소비는 M0w(세션 토큰에 `device_label` 컬럼이 없으면 이 마이그레이션에서 nullable 추가 — 결정 주석).
5. **OpenAPI** 갱신 + web-legacy 생성 타입 동기화(#1932 선례). `docs/onboarding-deeplink.md`에 `oort://link` 절 추가(형식·파라미터 2개·순서 무관·미지 파라미터 무시).

## red proof (선행 커밋 — PG 컨포먼스)
① 만료 토큰 redeem 401 ② 2회 redeem 409 ③ 에이전트 세션 발급 403 ④ 발급자 로그아웃 후 redeem 401 ⑤ 공개 오리진 모드: confirm 전 access 401, confirm 후 200 ⑥ 루프백 모드: `pendingSas:false`·즉시 200 ⑦ 로그·응답(원문 1회 제외)에 토큰 원문 0건(grep 게이트) ⑧ 타 워크스페이스 RLS 격리.

## 완료 절차
`cargo fmt`·clippy·`cargo test`·PG 컨포먼스(로컬 게이트 runtime-db 프로파일)·`scripts/verify_openapi_contract_rust.sh`·`scripts/check_migration_numbers.sh` 그린 실측 → 커밋(RED 선행) → `git push -u origin feat/m0s-device-link-server` → `gh pr create --base track/engine` → ENGINE_HANDOFF는 오케스트레이터가 기록 → 정지.

## 규율
토큰은 자격이 아니라 교환권(D1) — 어떤 API도 토큰으로 직접 호출되지 않아야 한다(시험으로 단정). 막히면 우회 말고 보고 후 정지.
