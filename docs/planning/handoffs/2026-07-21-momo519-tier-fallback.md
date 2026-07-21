# MOMO-519 핸드오프: 티어 폴백 — 호스트 상실 감지·전환 제안·git 계보 재개 (ADR-0125 D11 엔진)

> 발급: 2026-07-21 Fable (성재 우선순위 4). 정본: ADR-0125 D11(Accepted).
> 트랙: 엔진 · base = main · PR base = track/engine · 도메인 = server(+workers 필요 시) · **migration 번호 025 사용**(024는 MOMO-516 예약 — 충돌 금지). verifier 포트 밴드 **28020~28023**.

## 목표
"T1에서 작업하다 맥이 닫히면 T3로 전환해 재개할까요?" — 호스트 상실을 감지하고, 정책에 따라 전환을 제안하며, git 계보로 재개를 잇는 서버 절반.

## 구현 범위
1. **티어 정책 원장**(migration 025): `work_tier_policy`(workspace 기본 + member 오버라이드) — `mode: 't1_only'|'ask'|'auto'`(기본 ask), auto일 때 `auto_target`(work_host_id 또는 'cloud' 예약). GET/PUT REST(owner/admin=워크스페이스 기본, 본인=오버라이드).
2. **orphaned 전이**: work_host heartbeat가 유예(기본 90s, env `MOMO_HOST_OFFLINE_GRACE_S`) 넘게 끊기면 그 호스트의 running work_session을 `orphaned`로 전이(원장 이벤트 `work.session.orphaned` + realtime). 전이 판정은 기존 heartbeat 폴링 경로에 가산(새 데몬 금지 — outbox/notifier 문법 재사용).
3. **전환 제안 카드**: 정책 ask면 orphaned 전이 시 세션 스레드에 기존 **approval_request 문법 재사용**으로 "다른 호스트에서 재개할까요?" 카드 생성(kind 구분 `resume_offer`) + notifier가 `momo.work` 카테고리 푸시(503 계약 소비 — notifier 판정에 resume_offer 가산). t1_only면 카드 없이 ended(orphaned) 정리만.
4. **재개 REST**: `POST .../work-sessions/:id/resume`(human 소유자, body: `target_host_id`) — 검증(orphaned 상태·대상 host 등록·미revoke·정책 허용) 후 **새 work_session 생성 + `resumed_from_session_id` 계보 기록**(같은 스레드에 연결 — 0114 D2의 스레드 지속). 원 세션은 ended(resumed). 실제 스폰은 기존 work.spawn 디스패치 경로 재사용(대상 호스트로 라우팅). git clone/재개 프롬프트 구성은 호스트측(workd/앱) 몫 — 서버는 계보·라우팅만.
5. **auto 모드**: orphaned 전이 시 카드 없이 resume를 서버가 직접 디스패치(auto_target으로). 감사 원장에 auto 명시.

## 하드 경계
- 단일 쓰기경로(REST→PG→outbox→relay) 불변 — orphaned 전이·카드·재개 전부 이 경로. PTY/프로세스 상태 이전 없음(v0는 계보만). 자격증명·경로 비유입.

## 수용 기준
- verifier `verify_tier_fallback.sh`(신규, 28020~28023): heartbeat 정지→유예 후 orphaned 전이 / ask 정책→resume_offer 카드+outbox 푸시 dispatch 생성 / t1_only→카드 없음 / resume REST→새 세션+계보+원 세션 ended(resumed) / 비소유자 403 / revoked host 대상 409 / RLS. runtime-db 편입.
- 기존 work_session/control/pool verifier 회귀 0. server 테스트 가산. OpenAPI 갱신(policy REST·resume·orphaned 상태·계보 필드).

## 규율
- 커밋 자주. PR 후 멈춤(base=track/engine). merge/close·docker 실행 금지(오케스트레이터). schema_v0.sql 수정 금지. 유예/타이밍 검증은 verifier에서 grace를 env로 2~3s로 줄여 결정론화(sleep 최소화).
