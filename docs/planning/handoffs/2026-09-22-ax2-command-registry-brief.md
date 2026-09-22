# AX-2 — 명령 레지스트리 + ⌘K 「명령」 그룹 (UX-R3a 축소, ADR-0186 D1 클라이언트 정본)

- status: ready
- issue / planning ID: #2507 · PLN-20260922-AX2
- owner / reviewer: Fable(planner) / design-review(fresh) B0·H0 + Grok 리뷰어 C
- track / base commit: uxui · `origin/track/uxui` (발사 시 tip 기록)
- supersedes: `2026-09-02-launch-program-plan.md` §4 UX-R3a(범위 축소판)

## Goal
사람의 ⌘K와 에이전트 카탈로그가 **같은 명령 정의**를 소비할 토대를 세운다. TS 레지스트리 하나에 이동·만들기·설정 명령을 모으고, QuickSwitcher가 그것을 「명령」 그룹으로 그리며, 단축키 정본과의 드리프트를 시험이 막는다. 서버 `GET /v1/workspaces/{ws}/actions` 병합은 **인터페이스만**(AX-4가 채움).

## 계약과 범위
- 정본: ADR-0186 D1(클라이언트 명령=TS 정본) · ADR-0182 D2②(팔레트 상태줄) · `docs/design-system/README.md` · `momo-design-taste-web`.
- 수용기준: 이슈 #2507 Acceptance.
- 허용 파일: `packages/momo-core/src/features/commands/**`(신설) · `clients/web/src/app/QuickSwitcher.tsx` · `clients/web/src/app/keyboardShortcuts.ts`(id 추가만, 키 변경 금지) · `clients/web/src/app/ShortcutHelpDialog.tsx`(키캡 소비) · 관련 시험 · 캡처 장면(`scripts/capture-screens` 계열의 팔레트 장면 추가).
- 지킬 계약: 검색 그룹(`SEARCH_SURFACE_NAME`)·사람 섹션·cmdk `forceMount` 주석 규칙 유지 · 토스트 0 · raw color 0 · 모든 명령은 키보드 경로(SKILL §6) · `role="option"`·`aria` 현행 유지 · localStorage는 try/catch, 없어도 렌더.
- 범위 밖: 메시지 검색 연산자(R3b), 채널 브라우저(R3c), 서버 라우트, 카드.

## 구현에 필요한 맥락
- `QuickSwitcher.tsx:487-600`의 「이동」·「만들기」·「에이전트 설정」 항목이 하드코딩된 `go("/…")`다 — 전량 레지스트리로 이관하고 팔레트는 레지스트리를 map한다(하드코딩 항목 0을 시험이 잰다).
- `keyboardShortcuts.ts`: `KeyboardShortcut {id, description, keycaps, matches}` + `REGISTERED_SHORTCUTS`. 레지스트리 `Command.shortcutId`는 이 id를 가리킨다. 시험 2개: ①모든 `shortcutId`가 `REGISTERED_SHORTCUTS`에 존재 ②단축키 중 「팔레트에 노출」 표시된 것은 레지스트리에 존재(표시 플래그는 shortcut 객체에 `paletteCommandId?`로 추가 — 키 정의 변경 아님).
- 레지스트리 형태: `Command {id: "nav.inbox" | …, title: "인박스로 이동", group: "navigate"|"create"|"settings"|"agent", kind: "navigate"|"client", shortcutId?: string, run(ctx: {navigate, session, workspaceId})}`. `kind:"client"`는 서버 상태를 바꾸지 않는 명령(외양 등)이며 이 티켓에서는 정의만 두고 항목은 `navigate`만 넣는다(AX-5가 채움).
- 서버 카탈로그 병합 지점: `packages/momo-core/src/features/commands/serverActions.ts`에 `parseActionsCatalog(unknown) → ActionCatalogEntry[] | null`(총 파싱, 부재=null) + 팔레트에서 `null`이면 그룹 자체를 숨긴다. fetch 호출은 넣지 않는다(AX-4).
- 랭킹: 최근 사용 5 + 빈도, `momo.web.commands.recent.v1`. 결정성: 시험은 시계 고정.
- 상태줄: 명령 실행 결과 문장(「인박스로 이동」)은 팔레트 하단 `role=status` 3s(ADR-0182 ②). 표면이 닫히면 소거.
- 함정 전례: 「하네스 참·제품 거짓」(jsdom에 숫자 심기) — 팔레트 항목 수·그룹 존재는 렌더 DOM 구조로 단정, 시각은 캡처 레인.

## 검증과 전달
- `clients/web` typecheck·lint·test, `packages/momo-core` test, `scripts/design_preflight_web.sh`, 캡처 장면(팔레트 열림·「명령」 그룹·상태줄) 3짝, `scripts/verify_merge_tree.sh`(uxui base).
- design-review B0·H0(회귀 우선: 검색 그룹·사람 섹션·Escape 층).
- 전달: PR(track/uxui) + `scripts/goal_release.sh 2507 --review --pr <url>` + 보고.

## 체크포인트
(발사 시 기록)
