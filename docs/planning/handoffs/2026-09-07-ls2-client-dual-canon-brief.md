# 워커 브리프 — LS-2 클라 이중 정본 해소: clients/web-legacy·clients/mobile-spike 삭제 + 참조 0 + work 표면 셀프호스트 기본 숨김 (uxui · #2166 · ADR-0183 D5 + 1차 목표 결정 §5-2)

> 워커: grok 4.6 · base=origin/track/uxui · 워크트리 `momo-worktrees/wls2`(`feat/ls2-client-dual-canon`) · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. `scripts/**`·`.github/**`·`server-rust/**`·`docs/adr/**` 무접촉(LS-0이 게이트 배선을 이미 끊었다 — `web-legacy`가 게이트에 남아 있으면 우회 말고 보고 후 정지). `clients/web/src/design/**` 토큰 무수정. 시크릿 금지.
> 근거: ADR-0183 D5 · 후보 §1 #4·#6 · `docs/planning/2026-09-07-first-goal-two-cases.md` §5-2(work 표면 숨김) · ADR-0137(RN parity 후 킷 은퇴, #1292).

## 1. 구현 계약
1. **삭제(`git rm`)**: `clients/web-legacy/**`(45) · `clients/mobile-spike/**`(70).
2. **참조 정리**: `clients/web/package.json` description · `clients/web/src/lib/session.ts:37` 주석 → `f399e417:clients/web-legacy/src/auth/session.ts` 고정 참조 · `clients/web/README.md`·`clients/mobile/README.md` · `clients/mobile/package.json` description · `clients/mobile/__tests__/composerHangul.test.tsx:27`·`measure/harness.tsx:29` 주석(고정 참조) · `packages/momo-core` 주석 4곳(고정 참조) · `NOTICE`·`.dockerignore`·`.gitleaksignore`의 web-legacy 행 · `legal/THIRD_PARTY_NOTICES.md`의 web-legacy 3행(생성 스크립트가 있으면 재생성, 없으면 행 삭제 — 어느 쪽인지 PR에) · `docs/design-system/README.md`·`docs/INDEX.md`·`docs/LOCAL_PR_GATE.md`의 web-legacy 문장. `server-rust/bins/momo-server/tests/ephemeral_typing_touches_no_pg.rs`의 문자열 언급은 **무접촉**(engine, NOTES에 보고).
3. **work 표면 숨김(§5-2)**: `packages/momo-core/src/features/capabilities/serverSurfaces.ts`의 `SURFACES` 표에서 work 계열(`workstreams` + work 패널·work console·ADE·터미널 관전 등 workd/T3 데몬을 전제하는 id 전부 — 표를 읽고 목록을 PR에)을 **셀프호스트 기본 `provided:false`**로. 라우트·컴포넌트·시험은 유지. 진입점(사이드바 섹션·⌘K 명령·설정 탭)이 그 플래그를 읽는지 확인하고, 안 읽는 진입점은 `isSurfaceProvided`로 감싼다(새 플래그 발명 금지). 회귀 시험 1본: `provided:false`일 때 사이드바·QuickSwitcher에 work 진입점 0, `true`로 되돌리면 복귀.
4. **문서**: `clients/web/README.md`에 「work 표면은 서버 capability로 숨김(ADR-0183 D4-②)」 1줄.

## 2. red proof
- 계수: `git ls-files clients | wc -l`(1,250 → 실측) · `git grep -lE 'web-legacy|mobile-spike' -- . ':!docs/adr' ':!docs/planning' ':!STATUS.md' ':!server-rust'` → 빈 목록(`f399e417:` 고정 참조 제외).
- 병합 트리 게이트 8레인(`scripts/verify_merge_tree.sh`, lint 포함) PASS 원문 · `npm --prefix clients/web run typecheck && test && build` · `npm --prefix clients/mobile run typecheck && test` · `npm run test --workspace @momo/core`.
- 숨김 시험 사보타주: 시험에서 `provided:false`를 뒤집어 붉어지는지 1회.
- design-review 불요(픽셀 무변화 — 진입점 소거만). 캡처 스위트가 work 표면 장면을 가지면 그 장면을 스킵 목록에 넣고 사유를 PR에.

## 3. 완료 절차
커밋 순서: ①삭제 ②참조 정리 ③work 표면 플래그+시험 ④문서. push `feat/ls2-client-dual-canon` → PR(base `track/uxui`) 본문: 계수·grep 0·게이트 원문·숨긴 표면 id 목록·NOTES. 마지막 출력 `DONE / COMMITS / GATES / PR / NOTES`.

## 4. 규율
삭제는 `git rm`. 토큰·디자인 파일 무수정. 「실패할 수 없는 단정」 금지(플래그 시험은 실제 렌더 트리에서 진입점 계수). 막히면 보고 후 정지.
