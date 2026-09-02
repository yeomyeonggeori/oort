# 워커 브리프 — UX-R1b 드로어·스레드 패널·⌘K enter/exit + 사이드바 사다리 (uxui · ADR-0179 · UX-R1a 후)

> 워커: grok 4.6 · base=origin/track/uxui · `git merge origin/main --no-edit` · ms 리터럴 금지 · 서버 무접촉 · MCP 금지.
> 정본: ADR-0179 D1(패널·드로어·사이드바 접기=standard)·D4·D8. **`motion/react` 도입은 이 티켓이 첫 소비자** — 허용 범위: ⌘K 팔레트(`src/app/QuickSwitcher.tsx`)·스레드 패널(`ThreadPanel.tsx`)·390 드로어(`sidebar-drawer` 유틸) exit 애니메이션에 `AnimatePresence`만. `useReducedMotion()`으로 duration 0 규율. 다른 표면에 확산 금지(preflight 규칙: `motion/react` import 허용 파일 allowlist 3 — 신설).

## 구현 계약
1. 드로어(390): 이미 `160ms`→`--motion-fast`(UX-R0)로 흡수됨 — enter/exit 대칭 확인·스크림 페이드(`--elevation-float` 스크림).
2. 스레드 패널: 열림 `standard` slide-in(우측), 닫힘 `fast`. 폭 리사이즈(A10)는 별도.
3. ⌘K 팔레트: `cmdk` Dialog에 `MODAL_*` 상수 + `AnimatePresence`로 exit. 리스트 항목 삽입/삭제는 `layout` 금지(리스트 성능) — 페이드만.
4. 사이드바 접기 `--duration-sidebar`=standard(UX-R0 반영) 실측 확인·타이틀바 토글 회귀 0.
5. preflight: `motion/react` import allowlist 카테고리 `motion_lib_scope` 신설(허용 3파일 외 hard-zero) — `scripts/design_preflight_web.sh` 카테고리 1개 추가(정책 감사 대상).

## red proof (선행 커밋)
- allowlist 밖 파일에 `import { motion } from "motion/react"` → preflight 붉음 · 팔레트 닫힘 exit 애니메이션 완료 후 언마운트(AnimatePresence 시험) · reduced-motion에서 duration 0 · 패널 열림 중 타임라인 스크롤 위치 불변(기존 gate:shell).

## 완료 절차
vitest·tsc·lint 0·preflight(+selftest)·`CAPTURE_PORT=8625`·`SHELL_GATE_PORT=8627 SHELL_GATE_FOCUS_ONLY=1`·`verify_merge_tree.sh`·`npm ls motion`(의존 1개 추가 명시, 라이선스 MIT 확인·NOTICE 귀속) → PR → track/uxui → 정지.
