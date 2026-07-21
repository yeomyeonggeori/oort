# MOMO-503 핸드오프: E-1 푸시 페이로드 v2 — notifier 확장 (모바일 플랜 Phase C 선행)

> 발급: 2026-07-21 Fable (성재 위임). 정본: docs/planning/handoffs/2026-07-20-ios-v1-mobile-plan.md §E-1/MOMO-503.
> 트랙: 엔진 · base = main · PR base = track/engine · 도메인 = workers(notifier)+server (필요 시 openapi/docs 가산)

## 목표
iOS 504(알림 UX v2 — 빠른 답장·승인 액션·스레드 그룹핑·서버 badge)가 소비할 푸시 페이로드 확장. **id-only 원칙 유지**(NSE가 fetch — 본문 평문 미탑재 불변).

## 구현 범위
1. **`thread-id`**: APNs 표준 그룹핑 키 — 채널 단위(스레드 답글은 루트 메시지 기준). NSE 그룹핑·iOS 알림 스택이 그대로 소비.
2. **카테고리**: `momo.message` / `momo.mention` / `momo.approval` / `momo.work` — 판정은 기존 notifier 파이프라인 안에서(멘션 판정은 기존 mention_member_ids 투영 재사용, 승인/워크는 이벤트 타입으로). APNs `category` 필드로 탑재(iOS 액션 버튼 바인딩용).
3. **`approval_id`**: 승인 카테고리 푸시에만 id 가산(잠금화면 승인/거부 액션이 REST 호출할 대상).
4. **서버 계산 badge**: ADR-0109 unread 집계를 재사용해 수신자별 badge count를 페이로드에 탑재. 집계 쿼리는 기존 unread 경로 재사용 — 새 집계 테이블 금지.
5. **억제 회귀 0**: 음소거(MOMO-477 notification-pref)·자기 메시지 억제 등 기존 판정 결과는 변경 금지 — 페이로드 *내용*만 확장.

## 하드 경계
- 단일 쓰기경로 불변: notifier는 outbox 소비자 위치 그대로. Postgres=SoT, 메시지 본문/시크릿 페이로드 미탑재(id-only) 유지.
- schema_v0.sql 수정·이동 금지. 새 migration이 필요하면 기존 번호 이어서(024~), unread 재사용이 원칙이라 가급적 무-migration.

## 수용 기준
- `verify_push_notifier.sh` 확장: 4 카테고리 각각의 페이로드 필드 단정(thread-id·category·approval_id·badge), 음소거 억제 회귀, badge가 unread 집계와 일치 단정. 격리 compose·전용 포트 밴드(기존 밴드와 충돌 사전검사 — 27990~27993 권장).
- server/notifier 단위 테스트 가산, 기존 전체 테스트 회귀 0. OpenAPI/docs 갱신(푸시 페이로드 문서화 위치 있으면 가산).
- Docker 실런은 오케스트레이터 담당 — worker는 정적/단위까지, STATUS에 `runtime-unverified`로 명시.

## 규율
- 커밋 자주, PR 생성 후 멈춤, merge/close 금지, docker 실행 금지. verifier는 bash(로그인 셸 LibreSSL 함정 — openssl 쓰면 find_openssl 리졸버 패턴 재사용, rg 금지·grep만, python3 >=3.10 탐색 패턴).
