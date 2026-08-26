# Design Review R3 (표적 검증) — clients/web 이모지 피커 (UX-EB / #1742 / PR #1746)

- 대상: `feat/1742-uxeb-emoji-picker` @ **90ae48aa** (R2 수리 1커밋)
- 앞선 정본: `REPORT.md`(1차 19건) · `REPORT-R2.md`(재리뷰, 신규 5건)
- 범위: 팀 리드 지시대로 **R2 신규 findings 표적 검증 + 회귀 스팟체크**. 전면 재리뷰 아님.
- 방법: 1차·2차와 **같은 프로브**(Playwright 복제 하네스 `/tmp/eb-review/`, 계산 스타일·바운딩박스 실측), 두 스킴. 캡처 `r3-` 접두사.
- 리뷰 중 레포 파일은 한 줄도 수정하지 않았다.

---

## 최종 판정

# PASS (Blockers: 0 · High: 0)

R2 신규 5건 중 **4건 CLOSED, 1건은 권고대로 시스템 미결로 이관**(이 PR 비접촉). 회귀 스팟체크 4축 전부 보존. ADR-0133 웹 패리티 목표(Blocker 0 · High 0) 충족.

| 등급 | 잔여 |
|---|---|
| Blocker | **0** |
| High | **0** |
| Medium | 0 |
| Nitpick | 1 (수용된 트레이드, 코드에 근거 기재) |

---

## ① R2-B1 — 폰 카테고리 탭: **CLOSED**

수리: `EmojiPickerPanel.tsx:351-359` — `flex-nowrap overflow-x-auto` → **`flex flex-wrap gap-1` 환원** + 왜 되돌렸는지(무선언 가로 스크롤·iOS 어포던스 부재·`data-scroll-x` 요건)를 주석으로 기재.

**실측 (390×844, light·dark 동일):**

| 항목 | R2 | R3 |
|---|---|---|
| `flex-wrap` / `overflow-x` | nowrap / auto | **wrap / visible** |
| `scrollWidth / clientWidth` | 428 / 364 (**+64 누수**) | **364 / 364** |
| `scrollable` | true | **false** |
| 탭 가시 수 | 7 / 9 | **9 / 9** |
| 화면 밖 탭 | `symbols`(+16) · `flags`(+64) | **`[]`** |

**캡처 레인:** `npm run capture:design` → **exit 0, 완주**. 로그 실측:

```
overflow-x emoji picker light: 0 (문서 390px = 390px, 스크롤 상자 누수 0)
overflow-x emoji picker dark : 0 (문서 390px = 390px, 스크롤 상자 누수 0)
tap targets emoji picker light/dark: … composer-emoji-trigger 44x44, emoji-search 312x44 …
```

폰 light/dark 프레임이 다시 생성됐다(패킷 AC `capture:design 갱신(light/dark)` 충족). 캡처 `r3-01-mobile-tabs-{light,dark}.png`, `r3-01-mobile-tabs-crop.png` — 9탭이 7+2 두 줄로 전부 보인다.

> 1차 **N-7**(둘째 줄 고아 둘)이 되돌아왔다. **수용한다**: Nit 하나와 「빨간 게이트 + 사라진 탭 하나」를 맞바꾼 것이고, 그 판단 근거가 이제 코드 주석에 있다. 아래 「잔여」에 Nit으로 남긴다.

## ② R2-B2 — 터치 시트 포커스 소유: **CLOSED**

수리: `EmojiPickerDialog.tsx:154-165` — `DialogContent`에 `ref={sheetRef} tabIndex={-1}`, `onOpenAutoFocus`가 preventDefault **뒤 시트 자신을 포커스**. 왜 검색창도 트리거도 아닌지 주석에 기재(ADR-0112 D6 인용).

**실측 (390, 1차 R2와 같은 프로브, light·dark 동일):**

| 시점 | R2 activeElement | R2 시트 안 / aria-hidden | **R3 activeElement** | **R3 시트 안 / aria-hidden** |
|---|---|---|---|---|
| 열린 직후 | `composer-emoji-trigger` | ✗ / **true** | **`composer-emoji-picker` (DIV)** | **✓ / false** |
| Tab ×1 | `composer-input` | ✗ / **true** | **`emoji-search`** | ✓ / false |
| Tab ×2 | `emoji-search` | ✓ | **`emoji-skin-toggle`** | ✓ / false |
| Tab ×3 | `emoji-skin-toggle` | ✓ | **`emoji-cat-frequent`** | ✓ / false |
| Tab ×4 | — | — | **`picker-insert-👍️`** | ✓ / false |
| Tab ×5 | — | — | **`emoji-search`** (순환) | ✓ / false |
| Shift+Tab | — | — | **`picker-insert-👍️`** (역순환) | ✓ / false |

**시트 뒤 컨트롤에 닿는 탭 스톱: 0.** 포커스가 열자마자 모달 안에 있으므로 Radix FocusScope 트랩이 정상 작동하고, 폰에서도 4스톱 닫힌 순환(검색→스킨→카테고리→그리드)이 성립한다. Escape는 시트를 닫고 포커스는 `composer-input`(보이는 실제 컨트롤)으로 복귀 ✅. 소프트 키보드를 부르는 자동 포커스도 여전히 없다(H-5 원 결함 유지 CLOSED).

## ③ R2-M1 — 창 렌더 하단 빈 띠: **CLOSED**

수리: `gridWindow.ts:26-28` — `startRow = centerRow - Math.floor(rows/2)`(위6/아래6) → **`centerRow - 3`**(위3/아래9). 앵커가 «보이는 밴드의 첫 행»이라는 사실에 창을 맞췄고, 근거를 주석으로 기재. 가드 신설 `gridWindow.test.ts:29-35`(앵커 아래가 위보다 깊고 ≥7행).

**실측 (people 카테고리, 스크롤 후 600ms 정착, 밴드 320px):**

| 스크롤 | R2 빈 패드 | **R3 빈 패드** | R3 이모지 행 |
|---|---|---|---|
| 25% | 25px (8%) | **0px (0%)** | 8행 |
| 50% | 43px (13%) | **0px (0%)** | 8행 |
| 90% | 41px (13%) | **0px (0%)** | 8행 |

light·dark 동일. 캡처 `r3-02-scroll-{0_25,0_5,0_9}-light.png`.

## R2-N2 / R2-N3 — CLOSED (소스 확인)

- **R2-N2**: `EmojiPickerPanel.tsx:432-440` — 빈 목록에 `EmptyInvite headline="표시할 이모지가 없습니다"` 복원(`testId="emoji-grid-empty"`), 도달 불가라는 사실도 주석에 기재. §4 「모든 표면이 빈 상태를 갖고 출하한다」가 다시 코드에 있다. 런타임 도달 경로가 없으므로 **소스 확인만**(추측하지 않는다).
- **R2-N3**: `EmojiPickerDialog.tsx` import 뒤 이중 빈 줄 제거.

## R2-N1 — 시스템 미결로 이관 (이 PR 비접촉, 권고대로)

soft 채움(`--accent-soft`)의 luminance 대비는 다크 1.117 · 라이트 1.207로 WCAG 1.4.11의 3:1을 넘지 못하고, 이 팔레트의 어떤 soft 채움도 넘지 못한다(오르트 구름 §2.2의 산술). 이 PR이 아니라 §5.3 「비텍스트 대비를 살 수 있는 곳: 없다」의 자리다. **이 판정에 반영하지 않는다.**

---

## ④ 회귀 스팟체크 — 4축 전부 보존

| 축 | 실측 (light / dark 동일) | 판정 |
|---|---|---|
| **키보드 4스톱 닫힌 순환 + 포커스 링** | `emoji-skin-toggle → emoji-cat-frequent → picker-insert-👍️ → emoji-search → (순환)`, 전 정거장 `outline: solid 2px` | **보존** ✅ |
| **Esc 층 분리** | 열림 skin=true·picker=true → **Esc#1 skin=false·picker=true** → Esc#2 picker=false | **보존** ✅ |
| **B-1 커서 소유** | 포인터를 🔥에 두고 움직이지 않은 채 "smile" 입력 → active=**"grinning face"(index 0)**, ArrowDown×2 → **"grinning face with smiling eyes"**, 채움 가진 칸 **1개**, **Enter 삽입 `😄`** | **보존** ✅ |
| **900px 안전** | 팝오버 x=292 w=384 → right=**676 ≤ 900** | **보존** ✅ |

캡처 `r3-03-cursor-ownership-light.png`, `r3-04-900w-light.png`.

---

## 기계 레인

| 레인 | 결과 |
|---|---|
| `scripts/design_preflight_web.sh` | **PASS** — web 12/12 + core 5/5, EXIT=0 |
| `npx tsc -b` | **rc=0** |
| **`npm run capture:design`** | **exit 0, 완주** — 두 스킴 × 데스크톱/폰 전량 재생성, `overflow-x emoji picker light/dark: 0` |
| `npm run build` | 성공 |
| `npx vitest run` (touched areas: `src/design` · `src/features/{emoji,chat,timeline}`) | **40 files / 391 tests PASS** |
| `npx vitest run` (전량) | 1474/1476 — **red 2건은 이 PR과 무관한 환경 오염** (아래) |
| **폰(`clients/mobile`)** | **기계 프리플라이트가 존재하지 않는다.** 이번 diff는 폰을 건드리지 않았다 — 빈 칸으로 두지 않고 명시한다 (오르트 구름 §5.4) |

> **전량 vitest의 red 2건에 대한 정직한 귀인.** 실패는 `gates/preview-guard.contract.test.mjs`의 두 케이스이고, 이 파일은 `vite preview`를 **4300/4301 포트에 띄워** 기동 문구를 읽는 하네스 계약 테스트다. 그 두 포트를 **이 레포와 무관한 프로세스가 점유**하고 있다: `lsof -nP -iTCP:4300` → PID **4023** `…/Desktop/projects/omd-test-0820/arms/omd/node_modules/.bin/vite preview --port 4300` (4301은 PID 4024, 같은 외부 프로젝트). 실패 메시지 자체가 그 가드가 잡도록 설계된 「port squat」 시나리오다. 리뷰어 기기의 오염이며 **PR의 결함이 아니다**. 남의 프로세스이므로 종료하지 않았다. 이 PR이 만진 40개 파일 391 테스트는 전부 초록이고, R2 대비 총 테스트 수가 1475 → 1476으로 는 것은 `gridWindow.test.ts`의 신설 가드 1건이다.

---

## 잔여 (비차단)

| 등급 | 항목 | 상태 |
|---|---|---|
| **Nit** | 폰 390에서 카테고리 탭 9개가 7+2 두 줄로 접혀 둘째 줄에 고아 둘 (1차 N-7 환원) | **수용.** 대안(가로 스크롤)이 게이트를 빨갛게 만들고 탭 하나를 어포던스 없이 숨긴다는 것이 R2에서 실측됐고, 그 판단이 `EmojiPickerPanel.tsx:351-353` 주석에 남았다. 개선하려면 `data-scroll-x` 선언 + 스크롤 어포던스가 함께 와야 한다 |
| — | soft 채움 vs WCAG 1.4.11 3:1 (R2-N1) | 시스템 미결로 이관, 이 PR 비접촉 |
| — | 소프트 키보드가 올라온 폰 프레임 | Playwright가 가상 키보드를 렌더하지 못한다. 대신 포커스 소유권을 직접 측정했다(②) — 추측하지 않는다 |

---

## R3 캡처 (`claudedocs/design-review-1746/`, `r3-` 접두사)

| 검증 | 파일 |
|---|---|
| ① 폰 탭 9/9 가시 (7+2 wrap) | `r3-01-mobile-tabs-light.png` · `r3-01-mobile-tabs-dark.png` · `r3-01-mobile-tabs-crop.png` |
| ③ 스크롤 25/50/90% 빈 패드 0 | `r3-02-scroll-0_25-light.png` · `r3-02-scroll-0_5-light.png` · `r3-02-scroll-0_9-light.png` |
| ④ B-1 커서 소유 (단일 마커·Enter=😄) | `r3-03-cursor-ownership-light.png` |
| ④ 900px 안전 | `r3-04-900w-light.png` |

(② R2-B2는 시각이 아니라 포커스 소유권이 대상이라 스크린샷이 아니라 `document.activeElement` 실측 표로 남긴다.)

---

## 결론

**PASS.** 1차 19건 → 18 CLOSED, 2차 신규 5건 → 4 CLOSED + 1 이관, 회귀 4축 보존, 캡처 레인 초록 완주. 세 회전에 걸쳐 열렸던 Blocker 3건(B-1 · R2-B1 · R2-B2)이 전부 실측으로 닫혔고, 각 수리가 회귀 가드(`EmojiPickerPanel.test.tsx` 7건 · `gridWindow.test.ts` 5건 · `composerParity.test.ts` 강화)를 함께 놓았다 — 다음 사람이 같은 자리를 다시 열면 기계가 먼저 말한다. 사람 검수(성재 실물)로 진행 가능.
