# Fable 재개 체크포인트 (2026-08-27, 세션 중단점)

> 성재 지시로 이 지점에서 정리·중단. 다음 Fable 세션은 이 파일 → `2026-08-27-post-audit-execution-plan.md` → `JOURNAL.md` 최신 항목 순으로 읽으면 즉시 복원된다.
> 역할 불변: **기획·검수 = Fable · 실작업 = cursor grok 4.6(병렬 1) · 머지·재판정 = Fable · main 동기화·CURRENT_STATE 갱신 = momo-main/성재 위임.**

## 이번 세션에서 닫힌 것

1. **DNS 급소 종료** — `app.oor7.com` A(→101.79.11.189) 성재 삭제, 권위 NS(가비아)에서 소거 확인(삭제 45초 후 응답 중단, 3리졸버 교차). oort7.com 존에서 그 IP를 가리키던 유일 레코드였음(apex·www 이미 공백). **레포 밖 표면 노출 0.**
2. **#1799 랜딩** — 초대 revoke/regenerate/redeem, track/engine `89298a2f`, #1769 close. 위계 재점검 통과.
3. **#1798 수리 완료** — 패스워드 리셋 위계(ADR-0128 D2) 구멍 닫힘. 상태는 아래 §머지 게이트.
4. **#1803 랜딩**(이 브랜치 `docs/2026-08-26-planning-flush`, e2b53eee) — NCP 잔재 갱신(AGENTS/CODEX 헤더·런북 은퇴 배너·Caddyfile 고지). CLAUDE.md는 잔재 0건이었음(이슈 기재 정정).
5. **결재 5건 전부 판정·기록** — §post-audit-execution-plan §1.1. 허들 폴백 **P2(운영자 TURN)** 확정(#1792 코멘트).

## 머지 게이트 — #1798 (재개 시 첫 확인)

- 수리 커밋 **d8d68b89**(`feat/1767-password-reset`, base=track/engine post-#1799). PR head 일치·MERGEABLE.
- **Fable 재검수 통과**: `WorkspaceRole::can_issue_password_reset_for` — Owner→전부, Admin→member/guest만, Member/Guest→불가. self는 `issue_password_reset_in_tx` 진입 즉시 Forbidden. 행위자·대상 role 둘 다 같은 테넌트 트랜잭션에서 조회(라우트 `require_admin`은 비단독 권위). 단위 테스트 `password_reset_ladder_matches_adr_0128_d2`가 20칸 사다리 명시.
- **워커 RED proof**(PR 코멘트): 매트릭스 20칸 중 4칸(admin→owner·admin→admin 계열)이 수리 전 201 → 수리 후 403. `password_reset_conformance_pg` 25 passed. fmt/clippy/workspace test·OpenAPI 82/82 PASS.
- **중단 시점 CI 상태**: policy integrity·gitleaks·OpenAPI 계약·레인 선택 PASS. `cargo test + 카고 라이선스`·`canonical track alignment` **pending**(백그라운드 워처 bczbeoifb가 판정).
- **재개 액션**: CI 그린이면 `gh pr merge 1798 --merge`(성재 실권한: "괜찮아 보이면 머지" 위임). 머지 후 PR 제목 `[머지 보류]` 무의미해지므로 그대로 close됨. #1767 이슈는 트랙 머지라 수동 close(코멘트에 88·d8 커밋 명시). track/engine SHA 갱신 기록.
  - CI RED이면 로그 판정 → 원인이 수리 범위면 같은 워커 재투입(브리프 `2026-08-27-1798-hierarchy-repair-brief.md` 정지 조건 절 준수), 범위 밖(flake)이면 재실행.

## 다음 실행 순서 (post-audit-execution-plan §1 그대로)

```
③ #1800 workspace.settings REST ─────── AC-4 선행 (다음 워커 발사 후보 1순위)
④ #1770 재발주 (AC-4 역할 표시명)
⑤ #1792 SPIKE-HD(P2 폴백 확정) ∥ #1785 ACP 릴레이 ∥ #1797 에이전트 자격  ← 병렬
⑥ #1768 AC-2 멤버 라이프사이클 10경로 ── #1798 위계 헬퍼+매트릭스 골격을 정본 패턴으로 승계 (최대 티켓, 마지막)
─── 구조 처방(틈새): #1801 GATE-COND · #1802 TD-EXT · #1803(랜딩됨)
```

- **#1768 착수 시점 = 순서 ⑥ 유지**(성재 "권장 시점" 위임). 근거: #1798이 `can_*_for` 사다리 + conformance 매트릭스 픽스처를 남겨, AC-2 10경로(승격·강등·정지·추방·밴)가 같은 패턴을 복제하면 된다.
- 워커 규율: grok 병렬 1. 발사 전 자기 트랙 워크트리(`~/projects/momo-tracks/momo-worktrees/`) 준비, 머지 직후 회수(`momo-worktree-reclaim.sh` — 이번에 infra 비-git 디렉터리 pipefail 결함 수리됨).

## 성재 잔여 (이 세션 종료 시점)

- 실행 결재는 **전부 소진**. 남은 건 판정이 아니라 실행 진행뿐 — 다음 세션이 순서 ③부터 자율 진행 가능(방향 기승인).
- `momo-worktrees/infra/rust/local.secrets.env` = 리그 기동 산물 추정 시크릿 파일, 회수 안 하고 보존. 성재 확인 대상(위생).

## 미커밋 상태 (중단 전 커밋 필요)

- 이 파일 + JOURNAL 신규 항목 + `momo-worktree-reclaim.sh` 수리(`~/.local/bin`, repo 밖이라 별도). 실행플랜 §1.1은 커밋됨(1fb6d373).
