# 워커 브리프 — M0w 기기 연결 웹/데스크톱 절반: 「폰 연결」 QR 카드 (uxui · ADR-0180 · M0s 랜딩 후)

> 워커: grok 4.6 · base=origin/track/uxui · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. 서버 무접촉(계약은 M0s PR #1986 그대로 — `POST /v1/auth/device-link` 201 `{id, token(1회), expiresAt, sas?, deepLink}` · `GET /v1/auth/device-link/{id}` `{status: pending|consumed|expired, device?}` · `POST …/{id}/confirm-sas`). MCP 금지. 토큰 원문·deepLink는 화면 QR/복사 버튼 외 어디에도(로그·테스트 출력·캡처 프레임 이름) 남기지 않는다.
> 정본: **ADR-0180 D7**(표면) + D4(SAS는 서버가 `sas`를 줄 때만 표시). 디자인시스템 정본 + §2.6 모션 축(UX-R0 랜딩: `motion-*`·`press` 유틸, ms 리터럴 금지) + ADR-0182(일시 확인: 복사 버튼 in-place `복사됨`, 연결 완료는 카드 안 상태 전이).

## 구현 계약
1. **설정 › 기기 「폰 연결」 카드**(`clients/web/src/features/settings/` 신규 섹션, `settingsNav` 등재): 버튼 「QR 만들기」 → POST → QR 렌더(**의존 추가 금지** — 순수 SVG QR 인코더를 코어에 작성하거나 레포에 이미 있는 것을 실사; 없으면 소형 구현 + 테스트) · 120초 카운트다운(`--motion-*` 사다리 밖 숫자는 카운트다운 텍스트뿐) · 만료 시 「다시 만들기」 · `sas`가 있으면 4자리 크게 표시 + 「폰에 같은 숫자가 보이면 확인」 버튼(confirm-sas) · 상태 폴링(≤2s)으로 `consumed`→「연결됨: <기기명>」 전이 · 오류는 InlineBanner.
2. **온보딩 S5 진입점**(선택적, 브리프 2순위): 계정 스텝 완료 후 「폰에서도 쓰기」 카드가 같은 컴포넌트를 연다 — S0~S2 셸(`onboardingFlow.ts`)에 스텝을 늘리지 말고 완료 화면의 카드로.
3. **기기 목록**: 세션 토큰의 `device_label`이 API에 노출되면 목록+「연결 해제」; 노출되지 않으면 이 항목은 NOTES에 갭으로 적고 구현하지 않는다(서버 후속).
4. 접근성: QR에 `aria-label`(내용은 토큰 없이 "폰 연결 QR"), 카운트다운은 `aria-live=polite`로 30초마다만 낭독, SAS 숫자는 낭독.

## red proof (선행 커밋)
- POST 응답의 토큰이 DOM에 QR/복사 버튼 값 외 텍스트로 노출되지 않음(테스트가 innerText 전수 검색) · 만료 → 버튼 상태 전이 · `sas` 유무에 따른 SAS 블록 분기 · 폴링이 `consumed`에서 멈춤 · confirm 실패(409/400) 배너.

## 완료 절차
`clients/web` vitest·tsc·lint 0오류·`scripts/design_preflight_web.sh`(13종)·`CAPTURE_PORT=8617 capture:design`(카드 3상태: 대기·QR·연결됨, 두 스킴)·`SHELL_GATE_PORT=8619 SHELL_GATE_FOCUS_ONLY=1 gate:shell`·`scripts/verify_merge_tree.sh` → 커밋 → `git push -u origin feat/m0w-device-link-web` → `gh pr create --base track/uxui` → 정지.

## 규율
토큰만·ms 리터럴 금지(raw_motion)·토스트 금지. 짧은 픽스처 금지(긴 기기명·만료 경계). 막히면 보고 후 정지.
