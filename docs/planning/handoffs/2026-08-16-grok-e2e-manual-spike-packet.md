# GROK-E2E 매뉴얼 스파이크 패킷 — #1361 (성재 실행 · Fable 관측·기록)

> 2026-08-16 Fable 발급. 성재 결재(2026-08-16 "#1361 준비"). **이 goal은 워커가 자동 실행할 수 없다** — Grok 앱 로그인·MFA·consent·pairing 사람 확인이 필수라 **성재가 절차를 밟고 Fable이 라이브 원장·로그를 읽어 기록**하는 협업 스파이크다.
> 정본 goal: GitHub Issue **#1361**(status:blocked → 이 패킷으로 ready 근거). 사전 검증 완료(2026-08-16 라이브 실측).
> 경계: ADR-0162(+증보 1) · ADR-0004(자격 비유입 — pairing/active 값은 evidence·repo·log 비유입, 성재만 Grok 앱에 입력).

## 0. 사전 검증 결과 (라이브 실측 2026-08-16T14:08Z, 무자격)

- **Agent Port 라이브**: `POST https://app.oor7.com/v1/mcp/agent-port` → **401** `WWW-Authenticate: Bearer scope="agent:port:connect"`(#1344 시점 404 → 지금 401 = 표면 살아있음). `GET`은 405 POST-only. 배포 커밋 68fc52ff = engine HEAD 바이트 동일.
- **인증 = static bearer**(OAuth 아님). OAuth AS는 **닫힘**(`/v1/oauth/authorize` 404 — 4개 env 미설정). 이번 스파이크는 static 경로 전용, OAuth는 비목표.
- **페어링 폐곡선 서버측 완비**: create(paused member+`momo_pair_v1.*` TTL 15분)→detect(봇이 pairing bearer로 initialize)→confirm(별도 active bearer 발급·member unpause)→disconnect(revoke+cleanup manifest). 8툴(inbox_read·conversation_read·message_post·jobs_claim/renew/release·run_event/complete), 승인 scope 부분집합만.
- **유일 미지수 = Grok 커넥터가 static Authorization 헤더를 실제 전송하는가**(preset `verified:false`). 이 관측이 스파이크 1단계이자 존재 이유.

## 1. 성재 실행 절차 (Fable이 각 단계 라이브 관측)

> ⚠ pairing 값·active credential은 **Grok 앱에만 입력**, 채팅/이슈/로그/스크린샷에 남기지 말 것(ADR-0004). Fable은 값이 아니라 **상태 전이·원장 행·왕복 성립**만 읽는다.

**A. oort 웹(app.oor7.com) — 페어링 위저드(#1360)**
1. Agent Hub → "호스팅 에이전트 연결" → **Grok Bot preset** → displayName/handle 입력 → 생성. 화면이 주는 것: Agent Port 주소 `https://app.oor7.com/v1/mcp/agent-port` · 일회성 pairing 값 · routine 이름/지시문. → **Fable 관측**: 연결이 `pairing_pending`으로 원장에 생성됐는지(라이브 DB 무자격 불가 → 성재 화면 공유 or Fable이 서버 로그 tail).

**B. Grok 앱(성재 로그인·직접)**
2. Create Plugin → 비공개 플러그인 → mcp.json에 위 주소를 원격 서버로 등록.
3. 인증 헤더 bearer = **pairing 값** 입력 → 커넥터 설치. → 커넥터가 `POST /v1/mcp/agent-port`(MCP initialize, `MCP-Protocol-Version: 2025-11-25` legacy 또는 modern 2026-07-28) 실행. → **Fable 관측 핵심**: (a) Grok이 **Authorization 헤더를 실제로 보냈는가**(서버 로그의 401 재발 vs initialize 도달) (b) 도달했으면 연결이 `detected`로 전이했는가·client name/version 기록.
4. routine을 위 이름/문장으로 생성 → **수동 1회 Test run**.

**C. oort 웹 — confirm**
5. 감지된 연결의 이름/전용 member/채널·권한 확인 → **confirm**(authMode=static_bearer·audience=/v1/mcp/agent-port·approvedChannelIds·approvedScopes⊇agent:port:connect·agentMemberId) → **active credential** 일회 노출.
6. Grok 커넥터 bearer를 pairing 값 → **active credential로 교체**(2값 setup — ADR-0162 D6).
7. routine 재실행 → Grok `tools/list`(승인 툴 부분집합) → `oort_message_post`(승인 채널) → **PG→outbox→Centrifugo 왕복**. → **Fable 관측**: DB seq/run ↔ 사용자 reply redact correlation, hosted gateway claim/renew/complete.

**D. 스케줄 트리거·재접속·disconnect**
8. routine을 Active로 두고 **사람이 Test run을 누르지 않은 scheduled wake**가 실제 발화하는지(wake latency·cadence·retry provenance 기록). 불가하면 제품 카피를 manual-run 수준으로 제한(GREEN 금지).
9. restart/reconnect 후 새 credential 동작·replay pairing/stale 실패.
10. disconnect → old credential의 MCP/tool/job 접근·in-flight renewal 실패·managed fallback 0 확인. connector Uninstall/Routine Delete의 residual(local plugin files·routine)을 별개 artifact로 추적(#1344 계약: Active off만으론 cleanup 아님).

## 2. RED→GREEN 판정 (이슈 #1361 Acceptance)

이슈 본문 체크리스트가 정본. 분기:
- **Grok이 static 헤더 전송 → E2E 즉시 진행 가능** — 8~10까지 밟아 전 폐곡선 GREEN.
- **Grok이 OAuth만 요구 → 차단**. 선행 3건(#1369 consent runtime proof·프로덕션 OAuth AS 4 env 개방·Grok client_id+redirect allowlist 등록). 이 경우 스파이크는 "static 미지원" 관측으로 종료하고 OAuth 파도를 별도 편성(ADR-0162 증보 1 §A5: flag 개방=별도 운영자 결정).

## 3. 규율
- 유료구독 미구매·실계정/비프로덕션 워크스페이스만·provider secret/identifier 비유입. private API 리버스·roster scraping 금지.
- Fable 산출: 관측 기록 → research 정본 `research/2026-08-16-grok-e2e-observation.md`(성재 실행 후)+#1361 Acceptance 체크. 코드 변경은 관측 결과가 서버 결함/카피 제한을 요구할 때만 별도 goal.
