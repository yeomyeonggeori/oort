# #2066 — 셀프호스트 webhook 마스터키 분리 + 설치 단위 rate 예산 (ADR-0004 증보 4)

- status: ready
- issue / planning ID: #2066 · PLN-20260922-2066
- owner / reviewer: Fable(planner) / 독립 검수 = Grok 리뷰어 C(diff 사본) + planner 재판정
- track / base commit: engine · `origin/track/engine` (발사 시 tip을 브리프 체크포인트에 기록)
- supersedes: 없음

## Goal
`OUTBOUND_WEBHOOK_MASTER_KEY`가 미설정이면 `JWT_HMAC`으로 폴백하는 결합을 끊는다. 생성기가 webhook 마스터키를 독립 생성하고, 기존 설치는 업그레이드 백필이 **현재 유효값의 명시 복사**(D2(a))를 넣어 발급된 secret 무효화 0으로 이행한다. 폴백 코드는 삭제하고 미설정은 기동 거부. 인그레스에 설치 단위 토큰 버킷(429 + Retry-After + 감사 1행).

## 계약과 범위
- 정본: `docs/adr/0004-codex-oauth-hermes-provider-boundary.md` **증보 4(Accepted 2026-09-22, D2(a))** D1~D4. 수용기준 = 증보 4 D4 + 아래 red proof.
- 허용 파일: `server-rust/bins/momo-server/src/config.rs` · `server-rust/crates/momo-webhook/src/**`(crypto·ingress·rate) · `server-rust/bins/momo-server/src/routes/webhook_ingress.rs` · `scripts/self_host_env.sh` · 생성기 시험 `scripts/test_self_host_env_modes.sh`·`test_railway_template.sh`·`test_self_host_build_sha.sh` · `oort` CLI doctor/upgrade의 백필 지점(`scripts/oort*` 또는 `infra/**`에서 #2433 백필 규율이 사는 파일 — 먼저 grep으로 좌표를 확인하고 브리프 체크포인트에 적는다) · `docs/SELF_HOST.md` §시크릿 회전 · `docs/api/openapi.yaml`(429 응답 추가 시) · 관련 시험.
- 지킬 계약: `schema_v0.sql`·Migrations 무접촉 · 재사용 금지 가드(`config.rs:1353-1356` 계열)를 새 키에도 확장하되 **D2(a) 이행 창(두 값 동일)은 기동 허용 + doctor `warn`** · 정본 키 수 계약 갱신(43→44 또는 45, T2 44→45/46)은 같은 커밋 · `--railway` ≡ `--platform railway` 바이트 동일 유지 · 시크릿 값·지문을 로그·문서에 남기지 않음.
- 범위 밖: 워크스페이스/토큰 단위 세분화(ADR-0164 합류 후속), 인바운드/아웃바운드 키를 하나로 줄일지의 택일은 워커가 `crypto.rs` 도메인 분리 근거로 결정하고 **PR 본문에 근거 3줄**.

## 구현에 필요한 맥락
- 폴백 좌표: `config.rs:85`·`:1475`(`env("OUTBOUND_WEBHOOK_MASTER_KEY", jwtHMAC)` 바이트 유지 이식). 인바운드 파생: `config.rs:1466`, `momo-webhook/src/crypto.rs:48`(`momo.webhook.native.v1\n` 도메인 분리).
- 생성기: `scripts/self_host_env.sh:1443`·`:2105`가 `PROVIDER_LINK_MASTER_KEY`만 독립 생성 — 같은 managed-key 규율로 추가.
- 백필 선례: #2433(momo_notifier 롤 + 기존 env 백필) — 같은 분기·같은 doctor 판정 스타일.
- 기존 limiter: CURRENT_STATE 「기존 limiter 존재 확인」 — 인그레스에 이미 있는 제한 코드를 먼저 찾아 **중복 버킷을 만들지 않는다**(있으면 설치 단위 키·env 조정·429/감사만 보강).
- 함정: `bash -n a b c d`는 첫 파일만 검사(#2444 R1 전례) — 시험 스크립트는 파일별로.

## 검증과 전달
- 필수: `cargo fmt --all --check` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo test --workspace` · 생성기 시험 3본 · `scripts/local_gate.sh --profile docs`(문서 변경분).
- red proof(증보 4 D4): 폴백 경로를 되살리면 기동 거부/doctor RED · 두 키 동일이면 doctor `warn` · 예산 초과 → 429 + 감사 행 · 키 수 계약 시험 갱신 · 보호 경로(`scripts/**`) 변경이므로 **정책 감사 동반**(GITHUB_OPS 규칙, PR 라벨은 planner가).
- 격리 PG로 인그레스 429·감사 시험(runtime-db). 실환경 미검증분은 `runtime-unverified`.
- 전달: PR(track/engine) + `scripts/goal_release.sh 2066 --review --pr <url>` + 보고(한 일/커밋/검증/PR/남은 것·이탈, D2 택일 근거 3줄).

## 체크포인트
(발사 시 기록)
