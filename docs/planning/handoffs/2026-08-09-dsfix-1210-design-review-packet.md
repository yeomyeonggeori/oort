# 핸드오프 패킷 — PR #1215 design-review (웹+폰, #1210 종결 전 관문)

> 발주: 2026-08-09 Fable 세션 (성재 편성 승인). 리뷰어는 구현 컨텍스트와 무관한 fresh 컨텍스트여야 한다.

## 0. 대상

- **PR #1215** `fix/dsfix-1210` @ `fe64e03a` — "컨트롤 경계 3:1 · 폰 파괴 채움 토큰 · 포커스 링 페이드 · 웹 lint 게이트 배선 (#1210)". base = `track/engine`.
- 워크트리(보존됨, 읽기 전용으로 쓸 것): `~/projects/momo-tracks/momo-worktrees/dsfix-1210`
- 캡처: 폰 `clients/mobile/measure/captures/dsfix1210-*`(전/후×다크/라이트) · 웹 `clients/web/artifacts/dsfix1210/`
- **주의**: PR의 빨간 체크 `MomoiOS | Default`는 Xcode Cloud가 퇴역 대상 Swift 트리를 빌드하는 것으로 **PR 내용과 무관함이 실측됨** — 판정에 반영하지 말 것.

## 1. 리뷰 기준

- 웹: `momo-design-taste-web` 스킬(정본 `~/.claude/skills/momo-design-taste-web/SKILL.md`) — Dawn 팔레트 토큰·4상태·포커스 규칙·프리플라이트.
- 폰(RN): `momo-design-taste` 스킬의 원칙부(토큰 규율·AI-tell 금지)를 RN 문맥으로 적용. 폰 캡처 축척 **pt = px/3**.
- 판정: **Blocker 0 = PASS**. Blocker/High/Medium/Nit 분류, 각 판정에 근거(파일:줄 또는 캡처 좌표).

## 2. 검증 우선순위 (이 순서로, 주장을 검증하라 — 재서술이 아니라 반증 시도)

1. **D1 웹 `Button secondary` 경계** `--line`→`--line-strong`(1.32/1.43 → 3.59/3.56:1) — **채움 위계 불변** 확인(danger-fill 7.02/6.42 > accent 5.34/8.94 >> surface-raised 1.07/1.10). 신규 `controlBorders.test.ts`가 프리미티브 6개 역할표를 **닫는다**는 주장이 실제로 성립하는지(테스트를 읽고, 빠진 프리미티브가 없는지).
2. **D2 폰 `dangerFill`/`onDangerFill` 신설** — 거부 채움 1.64→**5.83:1**(다크)·1.89→7.52(라이트). 캡처에서 **승인 vs 거부 위계가 눈으로도 성립**하는지.
3. **D3 포커스 링** — 구현자가 감사 결론을 정정했다("프리미티브 3개→25곳"은 불성립, 25곳 중 22곳이 feature 자체 클래스 → `@layer utilities` 재정의로 31곳). 브라우저 실측 주장: 첫 프레임 `--ink`→150ms에 `--accent`로 번지던 것이 수리 후 **첫 프레임=정착색**. **직접 재현할 것**(워크트리에서 dev 서버 기동 가능. 재현 불가 환경이면 그 사실을 판정에 명시).
4. **merge-tree 7→8레인**(web lint) — red proof #6(조건부 훅이 tsc·프리플라이트 초록인데 이 레인만 빨강)이 **추가 가치를 증명**하는지.
5. **하네스 전용 `initialArmed` prop** — "파괴 채움이 그려지는 유일 화면이 한 번도 촬영된 적 없었다"는 발견의 산물. **테스트 통로가 제품에 새지 않는지**(`src/` 호출자 0을 테스트가 강제한다는 주장 검증).

## 3. 보고 규약

- 보고서 파일: `/private/tmp/claude-501/-Users-kwakseongjae-projects-momo/ab94d88e-3191-46c6-b77e-ce06e7aa9df5/scratchpad/dsfix1210-design-review.md` (판정·근거 전문)
- 최종 보고(마지막 텍스트) = 판정 한 줄(PASS/FAIL + Blocker/High 수) + 파일 경로 + 항목별 1줄 요약.
- 중간 보고 없음. 코드 수정·커밋·머지 금지(리뷰 전용).
