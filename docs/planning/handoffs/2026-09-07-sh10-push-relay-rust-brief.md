# 워커 브리프 — SH-10 momo-push-relay Rust: 셀프호스트 동봉 APNs relay (engine · #1255 · ADR-0120 계약 보존 · ADR-0183 결재 기록 2)

> 워커: grok 4.6 · base=origin/track/engine · 워크트리 `momo-worktrees/wsh10`(`feat/sh10-push-relay-rust`) · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. `scripts/**` 중 허용: `scripts/verify_push_relay.sh`(Rust relay로 재조준)·`scripts/push_relay_keygen.sh`(유지/정정)·`scripts/tests/test_push_relay_*.sh`(신규) · `scripts/local_gate.sh`(runtime-relay 프로파일 항목 1행) — 정책 감사 대상. `.github/**` 무접촉(`publish-images.yml`은 같은 이미지라 무변화). 시크릿(.p8·토큰) 커밋 금지 — 픽스처는 합성 키. APNs 실접속은 stub 모드로만(실수신은 planner·성재가 TestFlight로).
> 근거: ADR-0120(D1-A relay hop 구조적 필연·id-only·D4 등록 REST) · Rust 클라이언트 절반 `server-rust/bins/momo-notifier/src/push_relay.rs`(헤더 `X-Momo-Server-Id`·`X-Momo-Push-Signature`, raw-body Ed25519, 상태 분류·영수증) · Swift 원본 `f399e417:relay/PushRelay/Sources/PushRelay/{App,Config,PushDispatch,APNSSender,RateLimiter,Main}.swift`(≈700 LOC)·`Tests/PushRelayTests.swift`(225) · `docs/PUSH_RELAY_RUNBOOK.md`(env 계약: `MOMO_RELAY_SERVERS` 정적 레지스트리 JSON, `MOMO_APNS_SENDER=live|stub`, `MOMO_APNS_ALLOW_STUB`, `MOMO_APNS_KEY_PATH/KEY_ID/TEAM_ID`, `MOMO_PUSH_RELAY_HOST/PORT`, rate limit) · `infra/rust/docker-compose.push.yml`·`push-relay.env.example`.

## 1. 구현 계약
1. **바이너리** `server-rust/bins/momo-push-relay`(axum): `GET /health` · `POST /v1/push` — ①`X-Momo-Server-Id`로 레지스트리 조회 ②raw body Ed25519 검증(서명 헤더 base64) ③레이트리밋(서버별 분당 N) ④봉투 `momo.push.dispatch.v2` 검증 — **id-only**: 허용 필드 화이트리스트(server_id·device_token·badge·collapse_id·channel/message 해시·topic·env) 밖 필드는 400 ⑤송신 모드 `live`(APNs HTTP/2 토큰 인증 — `a2` 등 검증된 crate, .p8 ES256)·`stub`(Apple 미접속, `MOMO_APNS_ALLOW_STUB=1` 없으면 부팅 거부, 캡처 파일·고정 상태) ⑥영수증 JSON(Swift와 동일 필드: apns-id·status·reason) ⑦상태 매핑은 `push_relay.rs::classify_relay_status`가 기대하는 코드 집합과 일치(시험으로 고정).
2. **이미지·컴포즈**: `server-rust/docker-entrypoint.sh` 서브커맨드 `push-relay` 추가(멀티커맨드 이미지, 별도 Dockerfile 없음) · `infra/rust/docker-compose.push.yml`의 relay 서비스 이미지 = `${MOMO_RUST_IMAGE}` + `command: [push-relay]` · `push-relay.env.example` 키 정합 · `scripts/check_compose_env_templates.sh` push 행이 그대로 초록.
3. **등록 모델 v0**: 정적 레지스트리 `MOMO_RELAY_SERVERS`(JSON: server_id → Ed25519 public key) 유지. 자기등록 API는 **범위 밖**(NOTES에 설계 메모만).
4. **문서**: `docs/PUSH_RELAY_RUNBOOK.md`를 3 운영 모드로 재작성 — ①Dawn 공용(App Store 앱 기본: 셀프호스터가 `push_relay_keygen.sh`로 키를 만들고 Dawn에 server_id+공개키 등록, notifier env 3키) ②자체 relay(자기 Apple 계정·자기 빌드 앱: 같은 이미지 `push-relay` + 자기 .p8) ③stub(로컬). `docs/SELF_HOST.md`(en)+ko에 「폰 푸시」 절(설정 3키·doctor 확인) · `docs/cicd/12-push-relay-deploy-runbook.md`는 Rust 이미지 기준으로 정정. 배너 2줄 제거.
5. **검증기**: `scripts/verify_push_relay.sh`를 Rust relay(stub 모드)로 재조준 — notifier → relay 왕복(서명 OK/서명 위조 401/리플레이/레이트리밋 429/id-only 위반 400/stub 영수증) · `scripts/tests/test_push_relay_contract.sh`(red proof) · `scripts/oort doctor`의 outbox 오라클이 relay 구성 시 원래 규칙으로 복귀하는지 1회.

## 2. red proof
- conformance(`cargo test -p momo-push-relay`): 서명 거부·리플레이·레이트리밋·stub 영수증·id-only 위반·부팅 거부(stub 무허가) 각 RED 선행.
- 로컬 stub E2E: `docker-compose.rust.yml` + `push.yml` 기동 → 기기 토큰 등록(REST) → 멘션 → notifier dispatch → relay stub 캡처 파일에 id-only 봉투 1건(대화 본문 0바이트) → 영수증 → `push_dispatch_log` 행. 원문 첨부.
- `docker build` 완주(이미지 하나) · docs·web 프로파일 PASS · `scripts/tests/*` 초록.
- 사보타주: 봉투에 `body` 필드를 넣은 요청이 400인지 / 서명 바이트 1개 뒤집으면 401인지.

## 3. 완료 절차
커밋 순서: ①crate 골격+config+stub ②서명·레지스트리·레이트리밋 ③APNs live 송신 ④엔트리포인트·컴포즈 ⑤검증기·시험 ⑥문서. push → PR(base `track/engine`): 게이트 원문·E2E 원문·보호 경로 변경 목록·NOTES(자기등록 설계 메모). 마지막 출력 `DONE / COMMITS / GATES / PR / NOTES`. TestFlight 실수신은 planner가 Dawn relay(live)로 1회 — 워커 범위 밖.

## 4. 규율
Swift 원본은 참조일 뿐 번역이 아니다 — Rust 관용구로, 단 와이어 계약(헤더·봉투·영수증·상태 코드)은 바이트 단위로 보존. 실패할 수 없는 단정 금지(캡처 파일을 실제로 파싱해 필드 집합을 단정). 막히면 보고 후 정지.
