# ADR-0115: Signed Webhook Ingress — 서명 수신 + Slack-호환 모드

- Status: **Accepted** (2026-07-17, 성재 — 권고안 D1-A/D2-A/D3/D4 승인. 파생 SE-04B=MOMO-412, §9 부하 규칙 아래 발급)
- 관련: `docs/planning/proposals/2026-07-14-superapp-engine-roadmap.md` §ADR-0115·SE-04B, ADR-0113(Accepted — D4 Slack-호환 채택, D6 manifest), `research/16-plugin-platform/04`(Slack/MM 와이어 호환 실검증), MOMO-410(plugin registry — webhook은 첫 reference plugin), 제1불변식(단일 쓰기 경로)
- 발단: 채널 설정의 웹훅 탭은 placeholder(발급·서명·수신 경로 없음). 성재 발제 "Slack/Mattermost에서 쓰던 것 계속 사용"이 ADR-0113 D4로 채택되어, 이 ADR이 그 실행 계약을 정본화한다.

## Context

1. 외부 시스템(CI/모니터링/서드파티)이 oort 채널로 이벤트를 밀어 넣는 공식 경로가 없다. 수신 경로는 반드시 단일 쓰기 경로(REST→PG 트랜잭션→outbox→relay)를 지나야 하며, provider가 Centrifugo에 직접 publish하는 일은 없어야 한다.
2. 기존 예약(2026-07-14 proposal)이 골격을 이미 권고: per-install HMAC-SHA256, canonical signature base, replay window, `(workspace_id, installation_id, delivery_id)` 멱등 receipt, 같은 tenant 트랜잭션 원자 기록.
3. ADR-0113 D4가 채택한 Slack-호환의 실체(16-04 검증): **Slack incoming webhook은 URL 자체가 시크릿**(별도 서명 없음)이고, Mattermost가 12년째 이 와이어 포맷을 수용해 "URL만 바꾸면 기존 도구가 동작"을 실증했다. 화이트리스트는 MM 검증 부분집합 차용이 안전.
4. MOMO-410으로 plugin registry가 랜딩 — webhook은 `external_webhook` **첫 reference plugin**으로 SE-04B에서 구현된다(기존 예약 그대로).

## Options & Decision (Proposed)

### D1. 서명 방식 (native 모드)
- **A (권고) — per-install HMAC-SHA256**: signature base = `version + HTTP method + canonical endpoint/install ID + timestamp + delivery ID + raw-body SHA-256`, constant-time 비교, key ID 포함(회전 대비). 발급 시 one-time reveal(재조회 불가 — secret ref만 저장), overlap rotation(신구 키 동시 유효 창) + revoke.
- B — asymmetric publisher key(ed25519 등): 발신자 다수·공개 검증 시나리오용 — v0 과설계. **후속 예약**(publisher enrollment는 커뮤니티 플러그인 시점).

### D2. Slack-호환 모드 (ADR-0113 D4 이행)
- **A (권고) — 같은 ingress의 별도 모드**: `POST /hooks/{token}` — Slack 동형 **URL-시크릿 모델**(서명 없음 — 원본 Slack과 등가 보안, 고엔트로피 토큰+HTTPS). 페이로드 변환기: `text` + legacy `attachments`(MM 지원 필드 화이트리스트) + `<url|text>`/멘션/`<!channel>` 번역 → oort 메시지. **`blocks`는 v0 거부(400 + 명시 오류)** — 표시 부분집합은 후속 ADR. 미지원 목록(mrkdwn/parse/link_names 등)은 MM과 동일하게 문서화.
- B — Slack 페이로드도 HMAC 서명 요구: 기존 도구가 서명을 못 붙이므로 "URL만 바꾸면 동작"이라는 채택 이유가 죽는다. **기각.**
- 두 모드의 공통 강제: rate limit, max body, replay/멱등(delivery ID 없는 Slack 모드는 `(install, body hash, 시간창)` 근사 멱등), **channel binding**(발급 시 채널 고정 — Slack 모던 webhook과 동일), 오류 응답의 정보 비노출.

### D3. 기록 계약
- verified 이벤트는 **한 tenant 트랜잭션**에서 receipt + deterministic `client_msg_id` + channel seq/message/outbox 원자 기록(기존 예약 그대로). 발신 주체는 워크스페이스의 webhook 전용 표기(메시지 author 처리)로 — 구체 author 모델(전용 member kind vs 설치자 위임 표기)은 SE-04B 구현 재량 + 근거 기록, 단 **사람/에이전트 사칭 불가**가 하드 계약.
- webhook install은 MOMO-410 registry의 `external_webhook` plugin install로 기록(grant 불요 — inbound 전용), audit_log 같은 트랜잭션.

### D4. 발급·관리 표면
- v0: owner/admin이 채널 단위 발급/회전/revoke(REST). 채널 설정 placeholder 탭의 실배선은 UX 트랙 티켓(발급 UI)과 분담 — 서버 계약이 이 ADR, 화면은 Codex UI handoff 대조 후.

## Consequences

- (+) GitHub/Jenkins/Grafana/Alertmanager류 기존 Slack 연동이 URL 교체만으로 oort에 알림 — "쓰던 것 계속 사용"의 첫 실물. native HMAC 모드는 업계(token 대조) 대비 상향 보안.
- (+) 단일 쓰기 경로·멱등·감사 불변식 안에서 외부 이벤트가 원장에 합류.
- (−) 변환기 유지비(단 Slack legacy 포맷은 사실상 동결 — MM 12년 유지가 근거). blocks 미지원 구간의 사용자 혼동은 명시 오류+문서로 완화.
- 보류: blocks 표시 부분집합(후속 ADR — "MM보다 나은 호환" 기회), outgoing/slash 호환(2순위), asymmetric key, 발급 UI(UX 트랙).

## 파생 (Accepted 후)

SE-04B 단일 goal(기존 예약 수용기준 승계 + D2 Slack-호환 모드 추가): 발급/회전/revoke REST + native HMAC 수신 + Slack-호환 수신·변환기 + receipt 멱등 + verifier(위조/재전송/stale/cross-workspace/회전 경합/시크릿 redaction + **Slack 페이로드 픽스처 왕복**). 발급은 부하 안정 + 성재 승인 후 codex-fleet.
