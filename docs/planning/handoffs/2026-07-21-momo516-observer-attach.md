# MOMO-516 핸드오프: 관전 attach — observer capability 등급 (ADR-0126 D1 엔진)

> 발급: 2026-07-21 Fable (성재 우선순위 3). 정본: ADR-0126(Accepted) D1.
> 트랙: 엔진 · base = main · PR base = track/engine · 도메인 = server (+openapi/docs 가산). **migration 번호 024 사용**(025는 MOMO-519 예약 — 충돌 금지). verifier 포트 밴드 **28010~28013**(기존 밴드와 충돌 사전검사).

## 목표
"하나의 화면을 팀이 같이 본다": 세션 소유자 외 워크스페이스 멤버에게 **입력 불가(read-only) 관전** attach를 연다.

## 구현 범위
1. **capability 등급**: `POST .../work-sessions/:id/terminal-attach`에 `mode: "controller"|"observer"`(body, 기본 controller — 기존 계약 후방호환).
   - controller: 기존 그대로(소유자 human 전용).
   - observer: 같은 워크스페이스 active human 멤버 + 세션 채널 멤버십 보유 시 발급. capability 원장에 mode 각인(digest 원장 컬럼 가산 — migration 024).
2. **호스트 검증 확장**: `.../terminal-attach/validate`가 mode를 반환 — 호스트는 observer capability로 온 연결에 send_stdin/resize/kill을 거부(검증 응답의 mode가 계약). 서버는 발급 시점+검증 시점 이중으로 mode를 강제.
3. **observation 토글**: work_session에 `observation`('open'|'owner_only', 기본 'open') — 소유자만 PATCH. owner_only면 observer 발급 403.
4. **관전자 수 투영**: observer 발급 시 `work.session.observer` realtime 이벤트(count만 — 신원은 스레드 참여로 이미 공개적이나 v0는 count만). 세션 read projection에 `observerGrantCount`(발급 누계 아닌 유효 grant 수 — 만료 정리 포함).
5. **X-8 동시 해소**: 이왕 read projection을 만지므로 `remoteAttachAvailable`(bool — pty 결속 여부)을 세션 list/read에 가산(ENGINE_HANDOFF X-8, capability/endpoint는 계속 비투영).

## 하드 경계
- raw 스트림은 여전히 클라↔호스트 직결 — 서버/relay 무경유 불변. observer도 동일.
- agent bearer는 어떤 mode도 발급 불가(human only). RLS FORCE. 60초 grant TTL 동일.

## 수용 기준
- verifier `verify_observer_attach.sh`(신규, 28010~28013): 소유자 controller / 채널 멤버 observer 발급 200 / 비채널 멤버 403 / owner_only 토글 후 403 / observer mode로 validate 시 mode="observer" 반환 / agent 403 / revoke 즉시 무효 / RLS. runtime-db 편입.
- 기존 verify_terminal_attach.sh 회귀 0(기본 mode=controller 후방호환 단정 추가).
- server 테스트 가산, OpenAPI 갱신(mode·observation·observerGrantCount·remoteAttachAvailable).

## 규율
- 커밋 자주. PR 후 멈춤(base=track/engine). merge/close·docker 실행 금지(오케스트레이터). schema_v0.sql 수정 금지. verifier는 bash·grep만(rg 금지)·find_openssl 패턴(Ed25519 쓰면)·python3>=3.10 탐색 패턴 준수.
