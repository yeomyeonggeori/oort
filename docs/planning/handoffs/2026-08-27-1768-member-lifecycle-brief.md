# #1768 브리프 — AC-2 멤버 라이프사이클 10경로 Rust 이식 (engine, 최대 티켓)

> 실행 순서 ⑥(성재 결재 ④: #1798 랜딩으로 위계 헬퍼+매트릭스 골격이 정본화된 지금이 착수 적기). 방향 기승인.
> 새 브랜치 `feat/1768-member-lifecycle`, base=`origin/track/engine`(#1819 반영 최신). 워크트리 `~/projects/momo-tracks/momo-worktrees/w1768-lifecycle`.

## 0. 현황 (이슈 #1768·감사 축3 승계)

- 역할은 가입 시점 고정(`join.rs:942 ON CONFLICT DO NOTHING`). ADR-0128 D2의 10경로(role 변경·suspend/reinstate/remove/bans 등)는 **은퇴 Swift에만 존재**(`server/Sources/MomoServer/Routes/MemberLifecycleRoutes.swift:13-22`), Rust 0건.
- 스키마·audit 원장은 기립(`026_workspace_membership_lifecycle.sql`, workspace_ban 포함) — **마이그레이션 신설 불요가 기본**, `schema_v0.sql` 비접촉.

## 1. 계약

1. **이식 원본이 계약**: Swift `MemberLifecycleRoutes`의 경로·페이로드·에러 문장·권한 판정 보존(#1777·#1785 규율 — 발명 금지). 이식 불가 모순 발견 시 정지.
2. **위계 판정은 #1798 정본 패턴 승계**: `workspace_authorization.rs`에 경로 계열별 `can_*_for(target)` 사다리 확장(예: `can_change_role_of`·`can_suspend`·`can_remove`·`can_ban` — Swift 판정과 일치하는 이름·의미로). 판정은 **도메인 층·같은 테넌트 트랜잭션에서 행위자·대상 role 동시 조회**(라우트 층 단독 권위 금지). 인가 단일 권위=`active_workspace_role()`/`is_admin()`.
3. **채널 role은 라벨**(ADR-0128 D1) — 승격 의미는 워크스페이스 층에서만.
4. **하드 불변식**: 마지막 owner 강등·추방·정지 방지(워크스페이스 고아화 금지 — self-leave의 409 선례) · 자기 자신 대상 제약(Swift 문장 그대로) · audit 행 기록(026 원장 관례) · 실시간 반영은 **outbox/relay만**(직접 publish 금지) · 정지 계정 로그인 차단·밴 재가입 차단은 기존 인증/join 경로와의 접점 실측 후 이식.
5. OpenAPI 반영 + `schema.d.ts` 재생성 + STATUS.md 항목 + ENGINE_HANDOFF ready 행(웹 UI 후속용).

## 2. red proof (신설 `membership_lifecycle_conformance_pg` — #1798 매트릭스 픽스처 골격 복제)

- **행위자(owner/admin/member/guest/self)×경로 매트릭스** — 경로 계열마다 허용/403 칸 전량. #1798처럼 이식 전 RED(경로 부재 404 또는 우회 허용)를 선행 커밋으로 남기고 GREEN 전환.
- 마지막 owner 보호(강등·추방·정지 각각) · self 제약 · **정지 계정 로그인 차단**(suspend 후 auth 실측) · **밴 재가입 차단**(ban 후 초대 redeem 실측) · reinstate 복원 · RLS 자가검증(교차 테넌트) · audit 행 정확(kind·actor·target).
- 게이트 PG는 15432 관례. **라이브 리그(oort-t)·외부 VM 절대 비접촉**(상설 정지 조건).

## 3. 게이트 (전부 자가 실행, 그린 로그를 PR 코멘트에 동반)

cargo fmt --check · clippy -D warnings · cargo test --workspace · `cargo test -p momo-server --test membership_lifecycle_conformance_pg` · `scripts/verify_openapi_contract_rust.sh` · `scripts/verify_web_generated_types.sh` · gitleaks.

## 4. 정지 조건 (정지 시 push 없이 보고만)

- **라이브 리그 DB 비접촉 — 게이트 PG만**(상설).
- Swift 계약과 ADR-0128 D2가 모순될 때(어느 쪽도 임의 채택 금지 — 모순 실측을 보고).
- `schema_v0.sql` 수정·이동 또는 026 원장 스키마 변경이 필요해 보일 때.
- 위계 판정을 도메인 층에 넣을 수 없는 구조적 이유 발견 시.
- 게이트 RED 원인이 범위 밖일 때.

## 5. 금지·완료

- merge/close 금지 · force push 금지 · 시크릿 커밋 금지 · 커밋 한국어(무엇이 왜 — 티켓이 크므로 경로 계열별 커밋 분할 권장).
- 완료 = push + PR 생성(제목에 `#1768`, base=track/engine, 매트릭스 red proof·게이트 요약) 후 정지.
