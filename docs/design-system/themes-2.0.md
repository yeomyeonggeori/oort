# 테마 토큰 표 — 디자인 시스템 2.0

> 결정: [ADR-0189](../adr/0189-design-system-2-dawn-sky-multi-theme.md). 이 문서는 그 결정에 쓰는 **값과 실측 결과**를 담는다. 코드의 정본은 `packages/momo-core/src/design/themes.ts`다(DS2-0, #2712). 둘이 어긋나면 core가 이긴다. 그 경우 이 표를 core에서 다시 적는다. §2 값과 §3 실측은 웹 `clients/web/src/design/themes/palettes/themes2.doc.test.ts`가 core와 한 칸씩 대조한다. §8~§13은 증보 3(2026-10-21)의 카탈로그·유리와 배경화면 하한·열린 테마·표시 설정을 담는다. 그 수치는 프로토타입 측정이라 이 시험이 읽지 않고, 구현 이슈(AP-1b·AP-1c·AP-3~5)가 core 시험을 더하면 그 시험이 정본이 된다.
>
> 출처는 로컬 방향 제안서 `claudedocs/design-2.0/brief.md` §3·§6과 시안 `mockups.html`의 CSS 변수다. 두 파일 모두 gitignore 대상이다. 시안에 없던 값과 기준을 못 넘어 고친 값은 §1에 모았고, 전부 §3에서 쟀다.

## 1. 시안에서 바꾸거나 새로 정한 값

| 테마·모드 | 역할 | 시안 값 | 쓰는 값 | 이유 |
|---|---|---|---|---|
| 새벽하늘 라이트 | `ok` | `#1E8049` | `#0E7740` | `ok-soft` 위 대비가 4.26이라 온라인 알약 글자 기준 4.5에 못 미친다. 바꾼 뒤 `ok-soft` 위 4.84, 바닥 정지점 최소 4.61이다. 첫 판 `#147A43`은 바닥 아래 정지점 위에서 4.41이라 R1에서 한 단 더 내렸다. |
| 노을띠 라이트 | `ok` | `#1E8049` | `#147A43` | 같은 이유다. `ok-soft` 위 4.64다. |
| 새벽하늘 라이트 | `line-strong` | `#8B8984` | `#85837E` | 입력 테두리가 바닥 위에 설 수 있다(사이드바 검색). 시안 값은 바닥 정지점 위 2.86~2.99라 3:1에 못 미친다. 바꾼 뒤 모든 면 위 3.10 이상이다(R1). |
| 흑연 라이트 | `line-strong` | `#8A8F99` | `#878C96` | 시트·`surface-muted`·바닥 `#F3F4F6` 위 2.95였다. 바꾼 뒤 3.07이다(R1). |
| 새벽하늘 라이트 | `danger` | `#C0302A` | `#BE2C4F` | `signal` `#C2410C`와 OKLab 거리가 0.039라 안 읽음 배지와 오류가 같은 색으로 보인다. 색상을 OKLCH에서 15° 돌려 거리 0.082로 벌렸다. 표면 위 5.69다. |
| 흑연 라이트 | `surface`·`on-primary`·`on-signal` | `#FFFFFF` | `#FDFDFE` | 순백 금지 규칙(디자인 시스템 §2.2). |
| 흑연 | `primary` | (시안은 코발트 채움) | 잉크 | ADR-0189 D2: 주 행동은 잉크다. 코발트는 `signal`로 쓴다. |
| 흑연 | `sheet`·`surface-muted`·`canvas` | (시안의 bg·raised·sidebar) | 다크 `#101113`·`#1B1D21`·`#0B0C0E`, 라이트 `#F3F4F6` 셋 | 시안의 이름을 공유 역할에 대응시켰다. 흑연은 평면 바닥이다. |
| 노을띠 라이트 | `signal` | `#F2A33A` | `#BE7200` | 시안의 흰 시트(지금의 `surface` `#FFFDF8`) 위 2.05, 지금의 `sheet` `#F5F1E8` 위 1.85라 텍스트 없는 신호 점이 3:1에 못 미친다(제안서 §6). 명도만 낮췄다. 표면 3.69, 바닥 3.33, 띠 4.07, `on-signal` 4.85다. |
| 노을띠 | `canvas` | (시안은 띠 + 시트) | 라이트 `#F5F1E8`, 다크 `#161A25` 평면 | 띠는 `band` 역할로 따로 둔다(폰 헤더·데스크탑 사이드바). 본문 바닥이 띠와 섞이면 중간 정지점에서 글자를 읽을 수 없다. |
| 노을띠 다크 | `surface`·`surface-muted` | (시안은 `sheet`·`surface2`만) | `#20252F`·`#282D38` | 다크에서는 카드가 바닥보다 밝아야 떠 보인다. `#282D38`은 새로 정한 값이다. |
| 노을띠 | `primary` | (시안은 호박 채움 FAB) | 잉크 | 호박 채움은 경계가 2.05라 쓰지 않는다. |
| 전 테마 | `warn`·`warn-soft`·`danger-soft` | (시안에 없음) | 현행 `tokens.css` 값 | 현행 값을 새 표면 위에서 다시 쟀다. |
| 흑연 | `ok-soft` | (시안에 없음) | 새벽하늘의 같은 모드 값 | 새 표면 위에서 다시 쟀다. |
| 새벽하늘 라이트 | `warn` | (시안에 없음, 현행 `#8A5C00`) | `#855900` | DS2-1(#2713). 원장 칩(`SESSION_STATUS_CLASS` running)이 톤 없는 그릇 `muted-soft` 위에 이 글자를 세운다. 현행 값은 그 위 4.28이라 명도만 다섯 단 내렸다. 바꾼 뒤 `muted-soft` 위 4.5 이상, 표면 6.08이다. |
| 새벽하늘 라이트 | `signal-text` | `#B03A0A` | `#AF3908` | DS2-1. 같은 칩의 orphaned 글자가 `muted-soft` 위 4.48이라 명도 한 단을 내렸다. 눈으로는 구분되지 않는다. |
| 새벽하늘 라이트 | `ok-soft`·`warn-soft`·`danger-soft` | (현행 `#E1F2E7`·`#FFEDD4`·`#FFE9E5`) | `#E4F5EA`·`#FFF0DB`·`#FFEDEB` | DS2-1. 측정 칩의 그릇이 가리킨 행(`surface-hover`) 위 1.02~1.04라 웹 칩 그릇 자(대비 1.05·OKLab 0.02)에 못 미쳤다. 명도만 올렸다. `danger-soft`는 `danger` 회전(위 행)을 따라가지 않아 색상 17°였고, 새 값은 12.6°다. 제 톤 글자는 오히려 올랐다(4.97·5.47·5.07). |
| 새벽하늘 다크 | `signal-soft` | `#3A2519` | `#392418` | DS2-1. 선택된 행(`signal-soft`) 위 원장 칩 그릇(`muted-soft`)이 1.046이었다. 명도 한 단을 내렸다. |

## 2. 값 — 테마 × 모드 × 역할

색은 sRGB hex다. `canvas`는 세로 그라데이션 세 정지점(위 → 가운데 → 아래)이다. 가운데 정지점은 폰에서 46%, 데스크탑에서 42%다. 평면 테마는 한 값만 쓴다. `band`가 없는 테마(—)는 헤더와 사이드바가 바닥 위에 서고, 바닥에서 `ink`·`ink-muted`를 쓴다.

| 역할 | 새벽하늘 라이트 | 새벽하늘 다크 | 흑연 다크 | 흑연 라이트 | 노을띠 라이트 | 노을띠 다크 |
|---|---|---|---|---|---|---|
| `canvas` | `#F7EADB` → `#EFEDEA` → `#E2E9F3` | `#231D1B` → `#171A20` → `#0F141C` | `#0B0C0E` (평면) | `#F3F4F6` (평면) | `#F5F1E8` (평면) | `#161A25` (평면) |
| `band` | — | — | — | — | `#1C2440` | `#0D1222` |
| `on-band` | — | — | — | — | `#F4F1EA` | `#F1EEE7` |
| `on-band-muted` | — | — | — | — | `#B9BFD3` | `#9DA4BA` |
| `surface` | `#FFFEFC` | `#1B1E25` | `#141518` | `#FDFDFE` | `#FFFDF8` | `#20252F` |
| `surface-muted` | `#F3F1EE` | `#252933` | `#1B1D21` | `#F3F4F6` | `#F5F1E8` | `#282D38` |
| `sheet` | `#F4F2EF` | `#14171D` | `#101113` | `#F3F4F6` | `#F5F1E8` | `#161A25` |
| `ink` | `#16171B` | `#F1F1F3` | `#EDEEF0` | `#0F1115` | `#1D1B18` | `#EEEBE4` |
| `ink-muted` | `#5A5C64` | `#A4A7B0` | `#9A9EA8` | `#5B606B` | `#625D55` | `#A39F97` |
| `icon` | `#7C7F88` | `#8A8E98` | `#7D818B` | `#80858F` | `#857F75` | `#8A877F` |
| `line` | `#E7E4DF` | `#2C3039` | `#25272C` | `#E4E6EA` | `#EAE4D8` | `#2A2F3B` |
| `line-strong` | `#85837E` | `#737782` | `#6C707A` | `#878C96` | `#8A847A` | `#737784` |
| `primary` | `#16171B` | `#F1F1F3` | `#EDEEF0` | `#0F1115` | `#1D1B18` | `#EEEBE4` |
| `on-primary` | `#FFFEFC` | `#16171B` | `#0B0C0E` | `#FDFDFE` | `#FFFDF8` | `#161A25` |
| `signal` | `#C2410C` | `#FF8A4C` | `#7596FF` | `#2754E0` | `#BE7200` | `#F5AE4A` |
| `on-signal` | `#FFFEFC` | `#16171B` | `#0B0C0E` | `#FDFDFE` | `#1D1406` | `#1D1406` |
| `signal-text` | `#AF3908` | `#FF9A62` | `#7596FF` | `#2754E0` | `#A2560A` | `#F8BD68` |
| `signal-soft` | `#FBE9DE` | `#392418` | `#1A2340` | `#E8EEFD` | `#FCEFD9` | `#3A2C16` |
| `agent` | `#2F5B8A` | `#8DB3E2` | `#45C9C0` | `#0B7A74` | `#3A5A8C` | `#93B2E0` |
| `agent-soft` | `#E3ECF6` | `#1B2A3C` | `#0F2A28` | `#E1F3F1` | `#E5EBF5` | `#1C2638` |
| `ok` | `#0E7740` | `#4CC47E` | `#4DC27F` | `#1F7A43` | `#147A43` | `#4CC47E` |
| `ok-soft` | `#E4F5EA` | `#173325` | `#173325` | `#E1F2E7` | `#E1F2E7` | `#173325` |
| `warn` | `#855900` | `#D4A72C` | `#D4A72C` | `#8A5C00` | `#8A5C00` | `#D4A72C` |
| `warn-soft` | `#FFF0DB` | `#372E1B` | `#372E1B` | `#FFEDD4` | `#FFEDD4` | `#372E1B` |
| `danger` | `#BE2C4F` | `#FF6B63` | `#FF6A60` | `#C4312B` | `#C0302A` | `#FF6B63` |
| `danger-soft` | `#FFEDEB` | `#402A26` | `#402A26` | `#FFE9E5` | `#FFE9E5` | `#402A26` |

유리·스크림·그림자:

| 테마 | 유리(`glass`) | 스크림 | 그림자 |
|---|---|---|---|
| 새벽하늘 | 라이트 `rgba(255,254,252,.74)`, 다크 `rgba(32,35,43,.72)` + blur 22 | 라이트 `rgba(20,18,16,.34)`, 다크 `rgba(0,0,0,.55)` | rest `0 1px 2px rgba(40,30,20,.05), 0 8px 24px -10px rgba(40,30,20,.14)` / float `0 16px 40px -12px rgba(30,24,20,.28), 0 2px 6px rgba(30,24,20,.06)`. 다크는 `inset 0 1px 0 rgba(255,255,255,.04~.06)` 하이라이트를 더한다. |
| 흑연 | `surface`에 알파 .72 + blur 22 | 새벽하늘과 같다 | 새벽하늘 레시피와 같다. 테마는 그림자를 바꾸지 않는다(ADR-0189 D2). |
| 노을띠 | `surface`에 알파 .74 + blur 22 | 새벽하늘과 같다 | 같다 |

- 투명도 줄이기가 켜지면 유리를 불투명 `surface`로 그린다. 저사양이거나 블러가 실패하면 `surface` 94%로 대체한다.
- 94% 대체값의 글자 대비는 새벽하늘 기준 라이트 ink 17.59~17.64, ink-muted 6.55~6.57, 다크 ink 14.79~14.95, ink-muted 6.94~7.01이다(세 정지점 위에서 잼).
- 실제 유리 대비는 렌더 캡처 위에서만 잴 수 있다(`runtime-unverified`).
- 노을띠 데스크탑 워크스페이스 레일의 더 짙은 띠(라이트 `#141A31`, 다크 `#090D19`)는 장식 값이다. 그 위 `on-band`는 15.24/16.73, `on-band-muted`는 9.38/7.80이다.

### 표 밖 역할 (core 계산값)

ADR-0189 D5에 따라 표에 없는 역할은 DS2-0이 새 표면 위에서 다시 계산했다. 손으로 고른 값이 아니라 `themes.ts` `deriveRoles`가 표의 값에서 계산하므로, 테마를 더하면 함께 생긴다. 규칙은 다음과 같다.

- `surface-hover`: `surface`에서 잉크 쪽으로 OKLCH 명도만 옮겨, `surface`·`sheet` 위에서 두 자(대비 1.05 이상, OKLab 0.02 이상)를 처음 넘는 값.
- `surface-pressed`: 거기서 한 단 더. `surface`·`sheet`·`surface-hover` 위에서 넘는다.
- `muted-soft`: 톤 없는 칩 그릇. `surface`·`sheet`·`surface-hover`·`surface-pressed` 위에서 넘는다.
- `danger-fill`: `danger`가 모든 면에서 3:1을 넘고 그 위 잉크가 4.5:1을 넘으면 `danger` 그대로다. 여섯 조합 모두 그렇다.
- `on-danger-fill`: 그 모드의 `on-primary`와 `ink` 가운데 대비가 큰 쪽.

세 채움 위에서 `ink`·`ink-muted`가 4.5:1을 넘는 것도 core 시험이 잰다.

| 역할 | 새벽하늘 라이트 | 새벽하늘 다크 | 흑연 다크 | 흑연 라이트 | 노을띠 라이트 | 노을띠 다크 |
|---|---|---|---|---|---|---|
| surface-hover | `#ECEBE9` | `#20232A` | `#1A1B1E` | `#EDEDEE` | `#ECEAE5` | `#252A34` |
| surface-pressed | `#E5E4E2` | `#25282F` | `#1F2023` | `#E6E6E7` | `#E5E3DE` | `#2A2F39` |
| muted-soft | `#DEDDDB` | `#2A2D35` | `#242528` | `#DFDFE0` | `#DEDCD7` | `#2F353F` |
| danger-fill | `#BE2C4F` | `#FF6B63` | `#FF6A60` | `#C4312B` | `#C0302A` | `#FF6B63` |
| on-danger-fill | `#FFFEFC` | `#16171B` | `#0B0C0E` | `#FDFDFE` | `#FFFDF8` | `#161A25` |

## 3. 대비 실측

WCAG 2.1 상대 휘도로 계산했다. 텍스트 기준은 4.5, 비텍스트 기준은 3이다. 바닥(`canvas`)은 세 정지점을 모두 재고 그중 최소값을 적었다.

**전수 범위(R1).** 전경 11역할(`ink`·`ink-muted`·`signal-text`·`agent`·`ok`·`warn`·`danger`·`icon`·`line-strong`·`signal`·`primary`)을, 글자와 컨트롤이 설 수 있는 면 전부(`surface`·`surface-muted`·`sheet`·바닥 정지점 전부)에서 쟀다. 여기에 띠와 채움 쌍을 더했다. 6조합에서 **356쌍이 모두 기준을 넘는다.** 가장 빠듯한 쌍은 흑연 라이트의 `agent`/`agent-soft` 4.52와 `line-strong` 3.07이다.

- **포커스 링**은 현행과 같이 `--focus-ring-ink`(기본값은 신호색) 2px로 그린다. 표의 `signal` 행이 그 링이 설 수 있는 모든 면에서의 대비다. 채움 컨트롤 위에서는 `on-primary`·`on-signal`로 바꿔 그리고, 그 대비는 채움 쌍 행에 있다.
- **입력 테두리**(`line-strong`)는 모든 면 위에서 3:1을 넘도록 값을 정했다. 그래서 입력 그릇을 어느 면에 두어도 된다.
- **띠 위 규칙.** 노을띠의 `band` 위에는 `on-band`·`on-band-muted`·`signal`만 쓴다. 다른 역할은 띠 위에서 재지 않았다. 실측하면 라이트 `ink` 1.13처럼 기준에 못 미치므로, 이것은 금지 규칙이다. DS2-0 시험이 이 금지를 단정한다.

| 전경 / 배경 | 기준 | 새벽하늘 L | 새벽하늘 D | 흑연 D | 흑연 L | 노을띠 L | 노을띠 D |
|---|---|---|---|---|---|---|---|
| `ink` / `surface` | 4.5 | 17.77 | 14.79 | 15.73 | 18.59 | 16.90 | 12.90 |
| `ink` / `surface-muted` | 4.5 | 15.89 | 12.90 | 14.54 | 17.17 | 15.24 | 11.58 |
| `ink` / `sheet` | 4.5 | 16.03 | 15.91 | 16.27 | 17.17 | 15.24 | 14.59 |
| `ink` / `canvas (정지점 최소)` | 4.5 | 14.66 | 14.74 | 16.86 | 17.17 | 15.24 | 14.59 |
| `ink-muted` / `surface` | 4.5 | 6.61 | 6.94 | 6.81 | 6.20 | 6.42 | 5.83 |
| `ink-muted` / `surface-muted` | 4.5 | 5.91 | 6.05 | 6.29 | 5.73 | 5.79 | 5.23 |
| `ink-muted` / `sheet` | 4.5 | 5.97 | 7.46 | 7.04 | 5.73 | 5.79 | 6.59 |
| `ink-muted` / `canvas (정지점 최소)` | 4.5 | 5.46 | 6.91 | 7.30 | 5.73 | 5.79 | 6.59 |
| `signal-text` / `surface` | 4.5 | 6.11 | 7.98 | 6.58 | 6.02 | 5.34 | 9.12 |
| `signal-text` / `surface-muted` | 4.5 | 5.46 | 6.96 | 6.08 | 5.56 | 4.81 | 8.19 |
| `signal-text` / `sheet` | 4.5 | 5.51 | 8.59 | 6.80 | 5.56 | 4.81 | 10.32 |
| `signal-text` / `canvas (정지점 최소)` | 4.5 | 5.04 | 7.96 | 7.05 | 5.56 | 4.81 | 10.32 |
| `agent` / `surface` | 4.5 | 6.98 | 7.69 | 9.01 | 5.10 | 6.84 | 7.08 |
| `agent` / `surface-muted` | 4.5 | 6.24 | 6.70 | 8.33 | 4.71 | 6.17 | 6.36 |
| `agent` / `sheet` | 4.5 | 6.30 | 8.27 | 9.33 | 4.71 | 6.17 | 8.01 |
| `agent` / `canvas (정지점 최소)` | 4.5 | 5.76 | 7.66 | 9.66 | 4.71 | 6.17 | 8.01 |
| `ok` / `surface` | 4.5 | 5.58 | 7.55 | 8.12 | 5.27 | 5.30 | 6.95 |
| `ok` / `surface-muted` | 4.5 | 4.99 | 6.58 | 7.51 | 4.86 | 4.78 | 6.24 |
| `ok` / `sheet` | 4.5 | 5.04 | 8.12 | 8.40 | 4.86 | 4.78 | 7.86 |
| `ok` / `canvas (정지점 최소)` | 4.5 | 4.61 | 7.53 | 8.70 | 4.86 | 4.78 | 7.86 |
| `warn` / `surface` | 4.5 | 6.08 | 7.44 | 8.14 | 5.72 | 5.72 | 6.85 |
| `warn` / `surface-muted` | 4.5 | 5.44 | 6.49 | 7.52 | 5.28 | 5.16 | 6.15 |
| `warn` / `sheet` | 4.5 | 5.49 | 8.00 | 8.42 | 5.28 | 5.16 | 7.75 |
| `warn` / `canvas (정지점 최소)` | 4.5 | 5.02 | 7.41 | 8.72 | 5.28 | 5.16 | 7.75 |
| `danger` / `surface` | 4.5 | 5.69 | 5.98 | 6.51 | 5.41 | 5.59 | 5.51 |
| `danger` / `surface-muted` | 4.5 | 5.09 | 5.22 | 6.01 | 4.99 | 5.04 | 4.95 |
| `danger` / `sheet` | 4.5 | 5.13 | 6.44 | 6.73 | 4.99 | 5.04 | 6.23 |
| `danger` / `canvas (정지점 최소)` | 4.5 | 4.69 | 5.97 | 6.97 | 4.99 | 5.04 | 6.23 |
| `icon` / `surface` | 3 | 3.97 | 5.09 | 4.68 | 3.64 | 3.91 | 4.28 |
| `icon` / `surface-muted` | 3 | 3.55 | 4.44 | 4.33 | 3.37 | 3.52 | 3.84 |
| `icon` / `sheet` | 3 | 3.58 | 5.47 | 4.84 | 3.37 | 3.52 | 4.84 |
| `icon` / `canvas (정지점 최소)` | 3 | 3.27 | 5.07 | 5.02 | 3.37 | 3.52 | 4.84 |
| `line-strong` / `surface` | 3 | 3.76 | 3.73 | 3.68 | 3.32 | 3.65 | 3.44 |
| `line-strong` / `surface-muted` | 3 | 3.36 | 3.25 | 3.40 | 3.07 | 3.29 | 3.09 |
| `line-strong` / `sheet` | 3 | 3.39 | 4.01 | 3.81 | 3.07 | 3.29 | 3.89 |
| `line-strong` / `canvas (정지점 최소)` | 3 | 3.10 | 3.71 | 3.95 | 3.07 | 3.29 | 3.89 |
| `signal` / `surface` | 3 | 5.14 | 7.14 | 6.58 | 6.02 | 3.69 | 8.07 |
| `signal` / `surface-muted` | 3 | 4.59 | 6.23 | 6.08 | 5.56 | 3.33 | 7.25 |
| `signal` / `sheet` | 3 | 4.63 | 7.68 | 6.80 | 5.56 | 3.33 | 9.13 |
| `signal` / `canvas (정지점 최소)` | 3 | 4.24 | 7.12 | 7.05 | 5.56 | 3.33 | 9.13 |
| `primary` / `surface` | 3 | 17.77 | 14.79 | 15.73 | 18.59 | 16.90 | 12.90 |
| `primary` / `surface-muted` | 3 | 15.89 | 12.90 | 14.54 | 17.17 | 15.24 | 11.58 |
| `primary` / `sheet` | 3 | 16.03 | 15.91 | 16.27 | 17.17 | 15.24 | 14.59 |
| `primary` / `canvas (정지점 최소)` | 3 | 14.66 | 14.74 | 16.86 | 17.17 | 15.24 | 14.59 |
| `on-band` / `band` | 4.5 | — | — | — | — | 13.53 | 16.09 |
| `on-band-muted` / `band` | 4.5 | — | — | — | — | 8.33 | 7.50 |
| `signal` / `band` | 3 | — | — | — | — | 4.07 | 9.79 |
| `on-primary` / `primary` | 4.5 | 17.77 | 15.88 | 16.86 | 18.59 | 16.90 | 14.59 |
| `on-signal` / `signal` | 4.5 | 5.14 | 7.67 | 7.05 | 6.02 | 4.85 | 9.56 |
| `signal-text` / `signal-soft` | 4.5 | 5.22 | 6.98 | 5.57 | 5.27 | 4.77 | 8.04 |
| `agent` / `agent-soft` | 4.5 | 5.90 | 6.71 | 7.50 | 4.52 | 5.80 | 7.00 |
| `ok` / `ok-soft` | 4.5 | 4.97 | 6.19 | 6.08 | 4.60 | 4.64 | 6.19 |
| `warn` / `warn-soft` | 4.5 | 5.47 | 5.97 | 5.97 | 5.07 | 5.07 | 5.97 |
| `danger` / `danger-soft` | 4.5 | 5.07 | 4.78 | 4.74 | 4.72 | 4.88 | 4.78 |

쌍 수: 356

| OKLab 거리 | 새벽하늘 L | 새벽하늘 D | 흑연 D | 흑연 L | 노을띠 L | 노을띠 D |
|---|---|---|---|---|---|---|
| `signal`–`agent` | 0.271 | 0.235 | 0.191 | 0.216 | 0.275 | 0.220 |
| `signal`–`danger` | 0.082 | 0.078 | 0.294 | 0.355 | 0.141 | 0.161 |
| `agent`–`danger` | 0.252 | 0.247 | 0.299 | 0.271 | 0.257 | 0.240 |

색 사이 거리의 기준(ADR-0189 D2·D3)은 OKLab 0.07 이상이다. 현행 새벽 라이트의 액센트와 위험색 사이 실측값 0.073을 하한으로 삼았다.

## 4. 신호 프리셋 — ADR-0174 액센트의 이행

옛 액센트 값을 새벽하늘 표면 위에 `signal`로 그대로 올려 쟀다. 네 프리셋은 보정 없이 통과한다. 다른 테마 위에서는 DS2-0 엔진이 보정하고 그 결과를 표로 남긴다.

| 프리셋 | 모드 | `signal` | 표면 위 (3) | 바닥 최소 (3) | `on-signal` (4.5) | `signal-soft` 위 글자 (4.5) | OKLab: agent / danger |
|---|---|---|---|---|---|---|---|
| seongun 성운 | 라이트 | `#9C447C` | 5.90 | 4.87 | 5.90 | 4.89 | 0.175 / 0.127 |
| seongun 성운 | 다크 | `#F890BC` | 7.71 | 7.69 | 8.32 | 6.63 | 0.169 / 0.118 |
| hongyeom 홍염 | 라이트 | `#66002C` | 13.01 | 10.73 | 13.00 | 10.40 | 0.231 / 0.221 |
| hongyeom 홍염 | 다크 | `#FE5A94` | 5.64 | 5.62 | 6.09 | 5.13 | 0.247 / 0.083 |
| hyeseong 혜성 | 라이트 | `#8B005A` | 9.28 | 7.65 | 9.27 | 7.38 | 0.213 / 0.163 |
| hyeseong 혜성 | 다크 | `#FF4BCC` | 5.66 | 5.65 | 6.11 | 4.98 | 0.262 / 0.174 |
| gamram 감람 | 라이트 | `#005400` | 9.19 | 7.58 | 9.18 | 7.67 | 0.198 / 0.304 |
| gamram 감람 | 다크 | `#8CB858` | 7.24 | 7.21 | 7.81 | 6.13 | 0.193 / 0.252 |

- OKLab 거리의 위험색 기준은 시안 원래 값 `#C0302A`/`#FF6B63`이다. §1에서 바꾼 `danger`로 다시 재도 모두 0.07 이상이다(최소는 홍염 다크 0.083, 독립 검수 R1 재계산).
- `dawn`은 프리셋으로 옮기지 않는다. 테마 기본 신호(`signal: null`)가 그 자리를 대신한다.

### 보정 엔진 결과 — 네 프리셋 × 여섯 조합 (DS2-0)

`packages/momo-core/src/design/signal.ts` `resolveSignal`의 출력이다. 네 프리셋은 여섯 조합 모두에서 통과하거나 보정된다. 거절은 없다. 노을띠 라이트는 신호가 어두운 띠 위에서도 3:1을 넘어야 해서 네 프리셋 모두 명도를 올렸다. 새벽하늘과 흑연은 두 모드 모두 보정 없이 통과한다. 새벽하늘 행의 신호 값은 위 표와 같다.

- `on-signal`은 그 모드의 `ink`·`on-primary` 가운데 대비가 큰 쪽이다. 위 표의 `on-signal` 열은 시안의 옛 잉크(`#FFFEFB`·`#17161A`)로 잰 값이라 둘째 자리가 조금 다르다.
- `signal-text`는 신호의 색상각·채도로 명도만 옮긴 값이고, `signal-soft`는 표면에서 신호 쪽으로 OKLab 14%(라이트)·20%(다크) 섞은 값이다. 둘 다 엔진이 늘 계산한다. 테마 기본 신호(`signal: null`)는 엔진을 거치지 않고 §2의 값을 쓴다.
- 거절 조건: `#RRGGBB`가 아닐 때, 명도를 옮겨도 조건을 못 채울 때, 보정 뒤 `agent`·`danger`와 OKLab 0.07 미만일 때. 명도는 [0.2, 0.97] 안에서만 골라 순백·순흑이 나가지 않는다.

| 프리셋 | 테마 · 모드 | 입력 | `signal` | `on-signal` | `signal-text` | `signal-soft` | 보정 |
|---|---|---|---|---|---|---|---|
| seongun | 새벽하늘 라이트 | `#9C447C` | `#9C447C` | `#FFFEFC` | `#9C447C` | `#F3E3E9` | 그대로 |
| seongun | 새벽하늘 다크 | `#F890BC` | `#F890BC` | `#16171B` | `#F890BC` | `#423340` | 그대로 |
| seongun | 흑연 라이트 | `#9C447C` | `#9C447C` | `#FDFDFE` | `#9C447C` | `#F1E2EB` | 그대로 |
| seongun | 흑연 다크 | `#F890BC` | `#F890BC` | `#0B0C0E` | `#F890BC` | `#3B2B34` | 그대로 |
| seongun | 노을띠 라이트 | `#9C447C` | `#A84F87` | `#FFFDF8` | `#A14981` | `#F4E4E8` | 명도 보정 |
| seongun | 노을띠 다크 | `#F890BC` | `#F890BC` | `#161A25` | `#F890BC` | `#473948` | 그대로 |
| hongyeom | 새벽하늘 라이트 | `#66002C` | `#66002C` | `#FFFEFC` | `#66002C` | `#ECDADC` | 그대로 |
| hongyeom | 새벽하늘 다크 | `#FE5A94` | `#FE5A94` | `#16171B` | `#FF6599` | `#452C39` | 그대로 |
| hongyeom | 흑연 라이트 | `#66002C` | `#66002C` | `#FDFDFE` | `#66002C` | `#EAD9DD` | 그대로 |
| hongyeom | 흑연 다크 | `#FE5A94` | `#FE5A94` | `#0B0C0E` | `#FE5A94` | `#3D242E` | 그대로 |
| hongyeom | 노을띠 라이트 | `#66002C` | `#B14E6A` | `#FFFDF8` | `#A94763` | `#F6E4E3` | 명도 보정 |
| hongyeom | 노을띠 다크 | `#FE5A94` | `#FE5A94` | `#161A25` | `#FF75A1` | `#4A3242` | 그대로 |
| hyeseong | 새벽하늘 라이트 | `#8B005A` | `#8B005A` | `#FFFEFC` | `#8B005A` | `#F2DDE4` | 그대로 |
| hyeseong | 새벽하늘 다크 | `#FF4BCC` | `#FF4BCC` | `#16171B` | `#FF5BCE` | `#452B42` | 그대로 |
| hyeseong | 흑연 라이트 | `#8B005A` | `#8B005A` | `#FDFDFE` | `#8B005A` | `#F0DCE5` | 그대로 |
| hyeseong | 흑연 다크 | `#FF4BCC` | `#FF4BCC` | `#0B0C0E` | `#FF4BCC` | `#3E2337` | 그대로 |
| hyeseong | 노을띠 라이트 | `#8B005A` | `#BB3E83` | `#FFFDF8` | `#B4387D` | `#F8E3E7` | 명도 보정 |
| hyeseong | 노을띠 다크 | `#FF4BCC` | `#FF4BCC` | `#161A25` | `#FF6CD1` | `#4A314B` | 그대로 |
| gamram | 새벽하늘 라이트 | `#005400` | `#005400` | `#FFFEFC` | `#005400` | `#DCE5D8` | 그대로 |
| gamram | 새벽하늘 다크 | `#8CB858` | `#8CB858` | `#16171B` | `#8CB858` | `#2F3A31` | 그대로 |
| gamram | 흑연 라이트 | `#005400` | `#005400` | `#FDFDFE` | `#005400` | `#DAE4DA` | 그대로 |
| gamram | 흑연 다크 | `#8CB858` | `#8CB858` | `#0B0C0E` | `#8CB858` | `#293126` | 그대로 |
| gamram | 노을띠 라이트 | `#005400` | `#357D31` | `#FFFDF8` | `#2F772B` | `#E2EBDB` | 명도 보정 |
| gamram | 노을띠 다크 | `#8CB858` | `#8CB858` | `#161A25` | `#8CB858` | `#33403A` | 그대로 |

## 5. 플랫폼층과 밀도

이름만 공유하고 값은 플랫폼마다 따로 둔다(ADR-0189 D6). 테마는 이 표를 바꾸지 않는다.

| 축 | 폰 | 웹·데스크탑 |
|---|---|---|
| 반경 사다리 | `10` 배지 · `14` 행 선택·입력 · `20` 카드·묶음 · `27` 컴포저(원 반경 18 + 사방 여백 9, #4179 — 26 이던 것을 Buzz 동심 실측으로 올림) · `30` 시트 상단 · `pill` | `6` 코드 칩 · `10` 배지·태그 · `14` 행·입력 · `18` 본문 판 · `20` 카드 · `pill` |
| 타입 | large-title 30/36 800 · title 24/30 800 · headline 17/22 700 · body 16/23 · callout 15/21 · subhead 13.5/19 · caption 12/16 500 | display 22 · title 17 · heading 16 · body 15/22 · label 14 · code 13 · meta 12 · caption 11 (#3774 Accepted, 시안 값이 아니라 토큰 정본). 기본 글자 크기 단계의 값이고 글자 크기 설정이 배율을 곱한다(아래) |
| 내비 기하 | 탭바 높이 64, 인셋 좌 16·하 30 · FAB 64 · 시트 상단 58 | 사이드바 268 · 판 인셋 8 · 판 반경 18 |
| 간격 | 현행 리듬 `{4,8,12,16,24,32}`에 `20`(폰 헤더 좌우 인셋) 하나를 더한다 | 현행 리듬 |
| 고도 | rest·float 2단(ADR-0179 D6). RN `shadow*`/`elevation` | `--elevation-rest`·`--elevation-float` |

밀도(ADR-0189 증보 1 D1, 대화 밀도 세 단계 — AP-2a #4189가 대화 표면에서 읽어 옮겼다):

| 항목 | compact (촘촘하게) | comfortable (편하게, 기본) | spacious (여유롭게) | 웹 변수 |
|---|---|---|---|---|
| 같은 사람이 연달아 쓴 두 행 사이 | 8 | 12 | 16 | `--spacing-row`(4 / 6 / 8) × 2 |
| 사람이 바뀌는 자리(묶음 사이) | 12 | 18 | 24 | `--spacing-row` + `--spacing-row-head`(8 / 12 / 16) |
| 메시지 아바타(와 거터) 한 변 | 28 | 32 | 36 | `--spacing-message-avatar` |
| 마크다운 블록(문단·목록·코드) 사이 | 6 | 8 | 10 | `--spacing-prose` |
| 목록 항목 사이 | 0 | 0 | 4 | `--spacing-list-item` |
| 폰 목록 행 | 44 (터치 하한) | 46 | 52 | (폰은 아직 읽지 않는다) |
| 폰 섹션 머리 | 36 | 44 | 52 | (폰은 아직 읽지 않는다) |
| 데스크탑 사이드바 행 | 28 | 34 | 40 | (아직 읽지 않는다) |
| 카드 안 여백 | 10 | 14 | 14 | (아직 읽지 않는다) |
| 카드 반경 / 행 선택 반경 — 폰 | 14 / 10 | 20 / 14 | 20 / 14 | (폰은 아직 읽지 않는다) |
| 카드 반경 / 행 반경 — 웹 | 18 / 10 | 20 / 14 | 20 / 14 | (아직 읽지 않는다) |
| 탭바·FAB·타입·터치 하한 | 바꾸지 않는다 | 바꾸지 않는다 | 바꾸지 않는다 | |

- **읽은 값, 제안값이 아니다.** 대화 표면의 다섯 줄(위)은 지금 화면이 그리는 값에서 읽었다: 행 사이 12·묶음 사이 18은 코어
  `ROW_SPACE`, 아바타 32는 `AVATAR_SIZE`, 마크다운 블록 사이 8은 `MessageBody`의 `gap-2`였다. 그래서 「편하게」는 이 기능이
  생기기 전과 **픽셀이 같다**. 이 표가 처음 적었던 메시지 사이 16·아바타 36은 화면에 없던 값이라 지웠다(ADR-0189 증보 1
  D1: 수치는 DS2-8이 대화 표면에서 읽어 정한다). 「촘촘하게」·「여유롭게」는 같은 비율로 한 단씩 벌렸다.
- **목록 항목 사이는 촘촘과 기본이 같다.** 본문 줄 높이(`leading-relaxed`)가 항목 사이를 이미 열어 둬서 현행 간격이 0이다.
  기본을 0에서 올리면 기본 모양이 바뀌므로, 아래로는 더 내릴 수 없고 「여유롭게」만 4로 연다(Buzz는 4 / 6 / 8이지만 Buzz의
  본문은 14px 글자에 줄 높이 20px이고, oort 본문은 15px 글자에 `leading-relaxed`(1.625)로 약 24px이라 항목 사이가 이미 더 열려 있다).
- **웹 배선은 대화 표면(타임라인·스레드 행, 마크다운 글, 설정 미리보기, 타임라인 꼬리 행인 AI 계정 카드의 거터)만이다.** 사이드바
  행·카드 여백·반경·폰 값은 아직 읽는 곳이 없다. 값은 코어 `DENSITY`가 정본이고 `appearance/density.css`가 그 번역이며,
  `densityTokens.test.ts`가 한 칸씩 대조하고 `densityTokens.browser.test.ts`가 WebKit·Chromium에서 계산된 값으로 잰다. 밀도는
  터치 타깃 44·컨트롤 높이·타입 스케일을 바꾸지 않는다.
- **밀도가 닿으면 안 되는 자리는 이름을 갈랐다.** `--spacing-row`는 대화 행의 값이다. 같은 6px을 빌려 쓰던 폰 폭 채널 머리(57px)와
  컴포저 슬래시 명령 목록(행·머리글·발치)은 밀도를 따르지 않는 쌍둥이 `--spacing-row-fixed`를 읽는다(그대로 두면 명령 목록 행이
  48/52/56px, 폰 폭 채널 머리가 53/57/61px로 변했다 — 실측). `densityTokens.test.ts`가 밀도 변수를 읽는 파일을 닫힌 목록으로
  지켜서(타임라인 상수 파일과 호버 툴바 두 규칙뿐) 다음 빌려 쓰기를 시험에서 잡는다.

글자 크기(ADR-0189 증보 1 D2 · 증보 3 D8, AP-2a #4189): 루트 속성 `data-font-size`가 글자 배율 `--type-scale`(작게 14/15 ·
기본 1 · 크게 16/15)을 고르고, 웹 텍스트 역할 여덟 개의 크기와 줄 높이가 모두 `calc(var(--type-rem) * 곱수)`로 그 배율을
곱한다(`--type-rem` = `1rem` × 배율). 본문 15px이 기준이라 작게 14 · 기본 15 · 크게 16px이다(증보 1의 13/14/15를
정정했다: 본문 15px은 2026-10-13 owner 결정이고, 13/14/15면 「기본」이 글자를 줄인다).

| 역할 | 곱수 | 작게 | 기본 | 크게 |
|---|---|---|---|---|
| `timestamp` (캡션) | 0.6875 | 10.3 | 11 | 11.7 |
| `meta` | 0.75 | 11.2 | 12 | 12.8 |
| `code` | 0.8125 | 12.1 | 13 | 13.9 |
| `label` | 0.875 | 13.1 | 14 | 14.9 |
| `body` (메시지 본문) | 0.9375 | 14 | 15 | 16 |
| `heading` | 1 | 14.9 | 16 | 17.1 |
| `title` | 1.0625 | 15.9 | 17 | 18.1 |
| `display` | 1.375 | 20.5 | 22 | 23.5 |

- 브라우저 확대·루트 글자 크기와 직교한다(`rem`에서 나오므로 그 위에 얹힌다). 틀을 읽는 rem(간격·반경·컨트롤 높이)은 배율을
  받지 않는다: 글자만 커지고 틀은 움직이지 않는다.
- 손가락 화면의 입력 칸은 세 단계 모두 16px 바닥을 지킨다(`--field-text-floor`는 배율을 곱하지 않는 `1rem`이고, 작게에서
  16px 밑으로 내려갈 heading·title은 `max(바닥, 배율을 곱한 크기)`로 묶었다).
- 폰은 이 슬라이스의 범위 밖이다(폰 글자 크기는 DS2-5 시트가 따로 정한다).

> 증보 1 D1(2026-10-07)이 밀도를 3단(`compact`·`comfortable`·`spacious`)으로 바꿨다. `spacious` 열과 3단의 최종 수치는 AP-2a(#4189, #2720을 흡수)가 대화 표면에서 읽어 이 표에 옮긴다. 글자 크기는 §12다.

## 6. DS2 시리즈

| 단계 | 이슈 | 내용 | 의존 |
|---|---|---|---|
| DS2-0 | #2712 | 토큰 원천(core), 테마 엔진, 전 조합 대비 시험, 웹 CSS 생성 | 이 ADR |
| DS2-1 | #2713 | 웹 토큰 교체, 프리미티브 | DS2-0 |
| DS2-2 | #2714 | 폰 셸(탭바, FAB, 시트) | DS2-0, #2702 |
| DS2-3 | #2715 | 폰 홈 | DS2-2 |
| DS2-4 | #2716 | 폰 대화, 에이전트 카드, 컴포저 | DS2-2 |
| DS2-5 | #2717 | 프로필·설정 시트 재도색, 테마 행(#2702 후속) | #2702, DS2-2 |
| DS2-6 | #2718 | 데스크탑 셸 | DS2-1 |
| DS2-7 | #2719 | 테마 선택·커스텀 UI, ADR-0174 이행 | DS2-0, DS2-1, DS2-5, DS2-6 |
| DS2-8 | #2720 | 밀도 옵션(증보 1 D1이 3단으로 바꿨고 AP-2a #4189가 흡수한다, §13) | DS2-1, DS2-3, DS2-4, DS2-6, DS2-7 |

상위 이슈는 #2703(모바일)과 #2704(데스크탑·웹)다. 로고·마스코트는 #2705에서 정한다. 정식 앱 아이콘은 #2650에서 정한다.

## 7. 접근성 설정의 RN 노출 (ADR-0189 D7, DS2-0 확인)

iOS 「대비 증가」는 React Native에서 읽을 수 있다. 폰이 쓰는 RN 0.86.2 기준으로 확인했다.

- `AccessibilityInfo.isDarkerSystemColorsEnabled()`: iOS 전용. 네이티브 `RCTAccessibilityManager`가 `UIAccessibilityDarkerSystemColorsEnabled()`를 돌려준다. 이것이 설정 앱의 「대비 증가」다. Android에서는 늘 `false`다.
- 이벤트 `darkerSystemColorsChanged`: `UIAccessibilityDarkerSystemColorsStatusDidChangeNotification`을 받아 바뀐 값을 보낸다. `AccessibilityInfo.addEventListener`로 구독한다.
- `DynamicColorIOS({light, dark, highContrastLight, highContrastDark})`: 시스템이 대비 증가 여부에 따라 색을 고른다. 다만 D7의 고대비 규칙(평면 바닥, 불투명 유리, 카드 테두리, 보조 글자를 `ink`로)은 색 하나를 바꾸는 것보다 넓다. 그래서 적용은 위 조회와 이벤트로 하는 것을 기본으로 둔다. 적용은 DS2-2 이후 폰 셸의 일이다.
- 투명도 줄이기는 `AccessibilityInfo.isReduceTransparencyEnabled()`와 `reduceTransparencyChanged` 이벤트로 읽는다(D7).
- 실기기에서 켜고 끄며 확인하지는 않았다(`runtime-unverified`). 근거는 설치된 RN 소스(`Libraries/Components/AccessibilityInfo/AccessibilityInfo.js`, `React/CoreModules/RCTAccessibilityManager.mm`)다.

## 8. 카탈로그 — 첫 파티 3종 곁의 57종 (증보 3 D1·D2)

> ADR-0189 증보 3(2026-10-21)이 더하는 선택 테마다. §8~§13의 수치는 프로토타입(`derive2.mjs`)을 57종으로 다시 잰 값(2026-10-22)이고 아직 어떤 시험도 이 절을 대조하지 않는다. 코드의 정본은 AP-1b(#4188)가 만드는 `themeCatalog.generated.ts`와 `derive.ts`다. 그 시험이 들어오면 이 표를 core에서 다시 적는다.

### 8.1 구성

| 단계 | 수 |
|---|---|
| Buzz 목록(커밋 `af5bb0a`, `theme-loader.ts`) | 62 |
| − Buzz 자체 테마 `buzz`·`buzz-dark`(브랜드 전용, 우리 자리는 첫 파티 3종) | 60 |
| − `aurora-x`(GPL-3.0, 허용 라이선스 밖) | 59 |
| − `slack-dark`·`slack-ochin`(경쟁 제품 이름·상표, 결정 2) | **57** |

- 57종은 쌍 16 × 2 + 라이트 단독 1 + 다크 단독 24이고 묶으면 **41항목**이다. 쌍 묶기는 Buzz의 `THEME_PAIRS`를 따르되 항목 하나로 합친다(id는 라이트 쪽 기준의 명시 표).
- 갤러리 타일은 첫 파티 3종을 더해 시스템 19 · 라이트 20 · 다크 43이다. 정렬은 첫 파티 먼저, 그다음 id 순이다. 라벨은 생성기의 명시 표다(모드 낱말을 자동으로 지우면 `light-plus`처럼 이름 전체가 사라지는 사례가 있다).
- 라이선스는 MIT 52 · Apache-2.0 5(`material-theme` 계열)이고 상류 저장소는 25곳이다. 근거는 `tm-themes@1.12.12`의 `NOTICE`다. Buzz가 잠근 `shiki 4.1.0`의 테마 파일과 이 `NOTICE` 사이의 차이는 확인하지 못했다.
- 청사진 R6 초안은 59종·42항목 기준이었다(하한 분포 8/14/28 등). 이 문서의 수치는 전부 57종으로 다시 쟀다.

### 8.2 항목 표 (41항목)

저장 문자열은 `catalog:<id>`다. 「하한」은 §9의 값이고 굵게 표시한 「불가」는 하한이 95%를 넘는 테마·모드다.

| id | 구분 | 라이트 출처 | 다크 출처 | SPDX | 하한 라이트 | 하한 다크 |
|---|---|---|---|---|---|---|
| `andromeeda` | 다크 단독 | - | andromeeda | MIT | - | 0.84 |
| `ayu-dark` | 다크 단독 | - | ayu-dark | MIT | - | 0.82 |
| `catppuccin` | 쌍 | catppuccin-latte | catppuccin-mocha | MIT | **1.00** 불가 | 0.80 |
| `catppuccin-frappe` | 다크 단독 | - | catppuccin-frappe | MIT | - | 0.90 |
| `catppuccin-macchiato` | 다크 단독 | - | catppuccin-macchiato | MIT | - | 0.84 |
| `dracula` | 다크 단독 | - | dracula | MIT | - | 0.76 |
| `dracula-soft` | 다크 단독 | - | dracula-soft | MIT | - | 0.76 |
| `everforest` | 쌍 | everforest-light | everforest-dark | MIT | **1.00** 불가 | 0.93 |
| `github` | 쌍 | github-light | github-dark | MIT | 0.73 | 0.80 |
| `github-dark-dimmed` | 다크 단독 | - | github-dark-dimmed | MIT | - | 0.92 |
| `github-default` | 쌍 | github-light-default | github-dark-default | MIT | 0.71 | 0.70 |
| `github-high-contrast` | 쌍 | github-light-high-contrast | github-dark-high-contrast | MIT | 0.65 | 0.69 |
| `gruvbox-hard` | 쌍 | gruvbox-light-hard | gruvbox-dark-hard | MIT | 0.86 | 0.78 |
| `gruvbox-medium` | 쌍 | gruvbox-light-medium | gruvbox-dark-medium | MIT | 0.88 | 0.83 |
| `gruvbox-soft` | 쌍 | gruvbox-light-soft | gruvbox-dark-soft | MIT | 0.92 | 0.86 |
| `houston` | 다크 단독 | - | houston | MIT | - | 0.71 |
| `kanagawa` | 쌍 | kanagawa-lotus | kanagawa-wave | MIT | **1.00** 불가 | 0.80 |
| `kanagawa-dragon` | 다크 단독 | - | kanagawa-dragon | MIT | - | 0.81 |
| `laserwave` | 다크 단독 | - | laserwave | MIT | - | 0.72 |
| `material` | 쌍 | material-theme-lighter | material-theme | Apache-2.0 | **1.00** 불가 | 0.77 |
| `material-theme-darker` | 다크 단독 | - | material-theme-darker | Apache-2.0 | - | 0.71 |
| `material-theme-ocean` | 다크 단독 | - | material-theme-ocean | Apache-2.0 | - | 0.82 |
| `material-theme-palenight` | 다크 단독 | - | material-theme-palenight | Apache-2.0 | - | 0.93 |
| `min` | 쌍 | min-light | min-dark | MIT | 0.70 | 0.81 |
| `monokai` | 다크 단독 | - | monokai | MIT | - | 0.74 |
| `night-owl` | 다크 단독 | - | night-owl | MIT | - | 0.75 |
| `nord` | 다크 단독 | - | nord | MIT | - | 0.86 |
| `one` | 쌍 | one-light | one-dark-pro | MIT | 0.85 | **0.96** 불가 |
| `plastic` | 다크 단독 | - | plastic | MIT | - | 0.93 |
| `poimandres` | 다크 단독 | - | poimandres | MIT | - | 0.92 |
| `red` | 다크 단독 | - | red | MIT | - | 0.69 |
| `rose-pine` | 쌍 | rose-pine-dawn | rose-pine | MIT | **1.00** 불가 | 0.74 |
| `rose-pine-moon` | 다크 단독 | - | rose-pine-moon | MIT | - | 0.79 |
| `snazzy-light` | 라이트 단독 | snazzy-light | - | MIT | **1.00** 불가 | - |
| `solarized` | 쌍 | solarized-light | solarized-dark | MIT | **1.00** 불가 | **1.00** 불가 |
| `synthwave-84` | 다크 단독 | - | synthwave-84 | MIT | - | 0.83 |
| `tokyo-night` | 다크 단독 | - | tokyo-night | MIT | - | 0.90 |
| `vesper` | 다크 단독 | - | vesper | MIT | - | 0.66 |
| `vitesse` | 쌍 | vitesse-light | vitesse-dark | MIT | 0.82 | 0.75 |
| `vitesse-black` | 다크 단독 | - | vitesse-black | MIT | - | 0.75 |
| `vscode-plus` | 쌍 | light-plus | dark-plus | MIT | 0.61 | 0.80 |

쌍 16 · 라이트 단독 1 · 다크 단독 24 = 41. 첫 파티 3종(`dawnsky`·`graphite`·`noeul`)을 더하면 44다.

### 8.3 씨앗과 파생 요약

- **씨앗**(테마당 한 모드): 필수 `editor.background`·`editor.foreground`. 선택으로 `comment` 토큰 색(`tokenColors`와 `settings` 둘 다 읽는다), git 장식색 `added`·`deleted`·`modified`(키 우선순위 `gitDecoration.*ResourceForeground` > `editorGutter.*Background` > `diffEditor.*TextBackground`), 신호 씨앗(`focusBorder` > `textLink.foreground` > `button.background` > `activityBarBadge.background`), 에이전트 씨앗(`terminal.ansiCyan` > `terminal.ansiBlue`), 사이드바 `sideBar.background`, 상태색 대체 후보인 ANSI 초록·빨강·노랑. 모드는 바탕 휘도가 0.5 미만이면 다크다(`type`은 힌트일 뿐이다).
- **바닥과 표면**: Buzz `adaptive-theme.ts`의 산수를 쓴다. 바탕 휘도 L에서 d = `0.035·ln(1+(L+0.0135)·10)`를 구해, 바닥(`chrome`: 바닥 세 정지점·시트)은 바탕보다 휘도가 d만큼 낮은 색이고 본문 판(`pane`)은 바탕이다. 바탕이 너무 어두워 d만큼 내릴 수 없으면 바닥은 순흑이고 판이 휘도 d의 색이 된다. `surface`는 라이트에서 판 그대로, 다크에서 판을 `elevate`(.04)한 색이다. `surface-muted`는 판을 `elevate`(라이트 .04, 다크 .08)한 색이다(`elevate`는 라이트에서 어둡게, 다크에서 밝게 간다). `line`은 판과 글자의 12%(라이트)·15%(다크) 혼합이다. 카탈로그에는 띠(`band`)가 없다.
- **글자**: `ink`·`ink-muted`·`icon`·`line-strong`은 OKLCH 명도만 옮겨 모든 면(표면·시트·판·바닥)에서 4.5·4.5·3·3을 맞춘다. 라이트는 더 어둡게, 다크는 더 밝게만 가고, 0.0025 단계이며 명도 범위는 [0.02, 1.0]이다(순백·순흑 씨앗에서도 출발해야 한다). `primary`는 `ink`이고 `on-primary`는 `surface`·`pane` 중 `ink`와 대비가 큰 쪽이다. `ink-muted`는 `comment`에서, 없으면 글자와 바탕 40% 혼합에서 출발한다.
- **상태색**: 후보 목록에서 의미 색상각 창(OKLCH) 안의 첫 값을 쓰고 없으면 oort 기본값이다. `danger` 10–40°, `ok` 120–170°, `warn` 60–100°(채도 0.04 이상). `*-soft`는 `surface`에서 상태색 쪽으로 OKLab 12%(라이트)·18%(다크) 섞은 색이고, 상태색은 그 위에서도 4.5가 되게 맞춘다.
- **신호와 에이전트**: 신호가 먼저 정해진다(씨앗 → `resolveSignal`, 거절이면 기본 신호, 그래도 거절이면 `ink`로 중립). 에이전트는 그 뒤 씨앗에서 만들고 신호·위험과 OKLab 거리 0.07 이상이 될 때까지 색상각을 15°씩 돌린다. 기존 core 함수의 변경은 `resolveSignal`의 옵션 `agentYields`(에이전트 거리 검사를 끔) 하나이고 기본값은 현행 의미 그대로다.
- **표 밖 역할 5개**는 core `deriveRoles`가 그대로 계산한다. `glass`는 `surface`에 알파 .74(라이트)·.72(다크), `scrim`은 첫 파티와 같은 상수다.
- **Buzz 결함은 옮기지 않는다.** Buzz는 comment 색을 `settings`만 읽는데 shiki 4.1.0 테마 모듈에는 `settings`가 없고 `tokenColors`만 있다. 우리는 `tokenColors ?? settings`로 읽고 `tokenColors`만 있는 픽스처로 시험한다.

### 8.4 대비 보정 실측 (57종)

| 측정 | 결과 |
|---|---|
| 보정 없이 파생 | 57종 중 **56종**이 `contrastPairs`·신호·에이전트·위험 거리 0.07 중 하나 이상을 어긴다 |
| 명도 보정 + 의미 색상각 창 + 신호 우선 | **0/57** 위반(`deriveRoles` 성공) |
| 보정이 닿은 테마 | 56/57. 역할별(테마 수): `ink-muted` 48 · `danger` 47 · `line-strong` 32 · `ok` 30 · `warn` 28 · `icon` 23 · **`ink` 3**(`material-theme-lighter`·`solarized-dark`·`solarized-light`). 에이전트 색상각을 돌린 테마 5 |
| 이동량(OKLab ΔE) | `ink-muted` 중앙 0.103·최대 0.272(comment가 있는 53종), `ink` 최대 0.173. 큰 이동(`ink` > 0.15 또는 `ink-muted` > 0.25)은 2종 |
| 상태색의 출처 | `danger` 45 · `ok` 37 · `warn` 46종이 테마 씨앗에서, 나머지는 oort 기본값 |
| 신호 씨앗 | 50종 통과(그중 28종은 명도 보정), 7종 거절 → 기본 신호(`near-agent` 5 · `near-danger` 2) |
| 속도 | 57종 약 38ms(테마당 약 0.66ms, 최악 1.23ms, V8). WKWebView·Hermes는 미측정 |
| 크기 | 씨앗 표 5색 3.2KB(gzip 1.4KB) · 13색 6.6KB(gzip 2.6KB). 정적 CSS로 바꾸면 41항목 약 65KB(gzip 약 10.4KB). Buzz식 테마 모듈 57종은 합 약 1.32MB |
| 원본 사이드바 색 | 씨앗이 있는 55종 중 에디터 바탕과 눈에 띄게 다른 것(ΔY > 0.02) 7종, 띠로 쓸 수 있는 것 51종 |

한계: 프로토타입은 테마의 한 모드만 파생하고 시험 쌍 계산을 위해 `{light, dark}`에 같은 값을 채웠다(두 모드의 씨앗이 서로 독립이라 결과에는 영향이 없다). 신호 씨앗은 `button.background` 먼저 읽었고 구현은 `focusBorder` 먼저 읽는다. 시안(캡처)을 보지 않아 미감은 미검증이다.

### 8.5 신호 프리셋 × 카탈로그 (결정 11)

4프리셋 × 57 테마-모드 = 228조합을 `resolveSignal`로 풀었다.

| 의미 | 거절 | 이유 | 프리셋별 |
|---|---|---|---|
| 에이전트 고정(현행 core) | 43 | `near-danger` 39 · `near-agent` 4 | 성운 13 · 홍염 26 · 혜성 0 · 감람 4 |
| 에이전트 양보(D2 순서) | 39 | 전부 `near-danger` | 성운 13 · 홍염 26 · 혜성 0 · 감람 0 |

카탈로그·사용자 테마에서는 프리셋을 런타임으로 풀고, 거절된 스와치는 `aria-disabled`와 core `SIGNAL_REJECTION_COPY` 한 줄로 보인다. 홍염이 57 테마-모드 중 26곳에서 못 쓰이는 것은 정상이다(위험 표시 색과 겹치지 않게 하는 본문 D3의 규칙이다). 생성 CSS의 「모든 테마에서 통과해야 한다」 `throw`는 첫 파티에만 남는다.

### 8.6 id·네임스페이스·단일 모드 규칙

- **id 핀을 넓히지 않는다.** `THEME_ID_RE = /^[a-z]+$/`(core `themes.ts`)와 같은 문자 집합이 부트 스크립트·캡처·게이트에 박혀 있어 `github-light-default` 같은 하이픈 id가 막힌다. 첫 파티 id는 그대로이고 카탈로그는 새 네임스페이스다(저장 `catalog:github-default`·`user:abc123`, 정규식 `/^[a-z0-9]+(-[a-z0-9]+)*$/`). 루트에는 `data-palette="derived"`와 `data-theme-ref="catalog:github-default"`를 찍는다.
- **단일 모드 규칙 세 가지**(Buzz `resolveSystemTheme`·`handleModeSelect`를 순수 함수 `themeResolve.ts`로 옮긴다).
  1. 라이트·다크 탭에서 단일 모드 테마를 고르면 색 모드를 그 모드로 맞춘다.
  2. 색 모드를 시스템으로 바꿀 때 현재 테마에 짝이 없으면 첫 짝 테마(새벽하늘)로 옮기고 한 줄로 알린다.
  3. 색 모드를 라이트↔다크로 바꿀 때 현재 테마에 그 모드가 없으면 짝으로, 짝도 없으면 그 모드의 첫 테마로 간다.
- 유효 스킴은 테마가 한 모드뿐이면 그 모드이고, 이때 루트 `data-theme`를 그 모드로 못 박아 폼 컨트롤·스크롤바의 `color-scheme`이 어긋나지 않게 한다.

### 8.7 귀속 절차

1. 생성기가 `tm-themes` NOTICE에서 SPDX·저작권·원문 URL을 읽어 `themeCatalog.generated.ts`의 `source`와 `legal/generated/THEME_PALETTE_NOTICES.txt`(상류 25곳의 고지 본문)를 만든다. `aurora-x`와 허용 밖 SPDX는 생성기가 거절한다.
2. `legal/THIRD_PARTY_NOTICES.md`에 상류 25곳 행을 더하고 Buzz 행을 코드 차용으로 고친다(위치·도입 이슈 표기). 코드가 들어오는 AP-1b·AP-3 PR이 한다.
3. 차용한 파일 머리에 Apache-2.0 §4(b) 변경 표시(출처 파일·커밋 `af5bb0a`·변경 요약)를 단다.
4. 시험: 모든 항목의 SPDX가 허용 목록 안, `source.repo`가 `legal/` 파일에 있음, `aurora-x` 부재.

## 9. 유리·배경화면 하한 (증보 3 D4·D6)

### 9.1 정의

- **최악 합성**: 색조 한 겹(`canvas-mid`, 불투명도 α)을 순흑·순백 위에 얹은 두 끝이다. 합성 채널값이 바탕 픽셀에 대해 단조라서 어떤 사진·바탕화면에서도 최악은 이 두 끝이다(증보 2 D3).
- **하한**: 두 끝 모두에서 `ink`가 7:1을 지키는 최소 α(0.01 올림)다. 폰 `scrim.ts`의 `minimumScrimAlpha`와 같은 산수이고, 같은 함수가 증보 2의 표(0.69/0.76 · 0.65/0.73 · 0.69/0.78)를 재현한다. AP-1c(#4187)가 이 산수를 core로 올린다.
- 그 α에서 `ink-muted`·`icon`·`signal-text`는 최악 합성 위에서 OKLCH 명도만 옮겨 4.5·3으로 맞춘다(여유 `FIT_MARGIN` 0.3). 사이드바·타이틀바의 글자는 띠 규칙의 `on-band`·`on-band-muted`로 다시 묶어 보정값을 꽂는다.
- 슬라이더 범위는 [하한, 95%]다. **하한이 95%를 넘는 테마·모드는 유리도 배경화면도 쓸 수 없다**(불가). 0.97 기준은 쓰지 않는다. 기본값은 AP-3(#4190)이 캡처로 정한다.
- `GLASS_FALLBACK_OPACITY`(94%)는 블러 미지원 폴백이고 하한이 아니다.

### 9.2 첫 파티 6조합 (현행 core 값)

| 조합 | 보정 없이 `ink`·`ink-muted`·`icon`을 지키는 최소 α | `ink` 7:1만 지키는 최소 α(하한) |
|---|---|---|
| 새벽하늘 라이트 / 다크 | 0.94 / 0.85 | 0.69 / 0.76 |
| 흑연 라이트 / 다크 | 0.95 / 0.83 | 0.65 / 0.73 |
| 노을띠 라이트 / 다크 | 0.93 / 0.88 | 0.69 / 0.78 |

Buzz의 30–90%는 왼쪽 열을 어기므로 옮기지 않는다. 오른쪽 열이 슬라이더 하한이다.

### 9.3 카탈로그 57종의 분포

최소 0.61 · 중앙 0.82 · 최대 1.00(항목별 값은 §8.2).

| 하한 | 테마-모드 | 뜻 |
|---|---|---|
| 0.80 이하 | 26 | 범위가 넓다 |
| 0.80 초과 0.85 미만 | 9 | |
| 0.85 이상 0.95 이하 | 13 | 범위가 좁다(폭 10%p 이하). 배경에는 「사진이 많이 흐려져요」 힌트 |
| 0.95 초과 | **9** | **불가** |

불가 9건은 `catppuccin`·`everforest`·`kanagawa`·`material`·`rose-pine`·`snazzy-light`의 라이트, `solarized`의 라이트와 다크, `one`의 다크(0.96)다. 하한 1.00인 8건은 불투명(α=1)에서도 `ink`가 7:1에 못 미친다(대비 4.50~6.77). ADR-0189 증보 3 D6에 표가 있다. 하한이 정확히 95%인 테마는 지금 카탈로그에 없다.

### 9.4 불가·공존

- 불가일 때: 유리는 토글을 비활성으로 두고 이유를 말한다(제안 「이 테마에서는 글자가 읽히도록 유리 배경을 쓸 수 없어요.」). 배경화면도 비활성이다(제안 「이 테마에서는 글자 대비 때문에 배경 사진을 쓸 수 없어요.」).
- 폴백 세 갈래(미지원 / 투명도 줄이기·고대비 / 켜기 실패)는 ADR-0189 증보 1 D4 그대로다.
- 배경과 유리는 공존하지 않는다(결정 9). `data-wallpaper`가 켜져 있으면 유리 토글은 비활성이고 문장으로 이유를 말한다. 판정 함수 하나를 AP-3과 AP-4가 공유하고, 둘이 같은 파도에서 나가므로 뒤에 랜딩하는 쪽이 연결한다.

## 10. 배경화면 — 웹·데스크탑 (증보 3 D4)

- **종류**: 없음 / 단색 8 / 기본 제공 6 / 내 사진 / 「기본으로」. 폰의 `BACKDROP_SOLIDS`·`BACKDROP_PRESETS`와 모델을 core `wallpaper.ts`로 복사한다(폰 import 교체는 AP-6). 움직이는 배경은 P2다(AP-8).
- **자리**: `.app-shell`의 배경 맨 아래 층(`--shell-layer-wallpaper`, AP-1a가 층 변수로 쪼갠다). 보이는 곳은 사이드바 열·창 가장자리(판 인셋 8px)·상단 줄이다. 본문 판·카드·시트는 그 위(불투명)라 읽기가 안전하다.
- **scrim**: 폰 `scrim.ts`의 `blend`·`worstCaseBackdrops`·`minimumScrimAlpha`·`fitForeground`를 core로 올려(AP-1c) 바닥색 한 겹을 α = 하한으로 얹고, 글자 역할은 최악 합성 위로 보정한다(4.5·3 + 여유 0.3). 불가·힌트 판정은 §9.
- **사진 처리**: `<input type="file" accept="image/*">` → `createImageBitmap` → canvas에서 긴 변 ≤ 2560px → JPEG 재인코딩(품질 0.85 → 0.7 → 0.55 → 0.4, 그래도 크면 해상도 0.75배 → 0.56배)으로 1.5MB 이하. 끝까지 크면 거절하고 이유를 말한다. 항상 재인코딩이라 EXIF(위치 포함)가 벗겨진다. 상한은 웹 화면에 맞춘 제안값이다(폰은 1600px·1MB).
- **저장**: IndexedDB(DB `momo-appearance`, 스토어 `blobs`, 키 `wallpaper`). 프로덕션 코드의 IndexedDB 전례가 없어 AP-4가 Tauri 웹뷰의 영속성·쿼터를 실측한다. CSP가 `img-src 'self' data:`라 `blob:` URL은 쓸 수 없다.
- **그리기**: `FileReader.readAsDataURL`로 `data:` URL을 만들어 전용 요소 `<div data-wallpaper-layer>`의 `style.backgroundImage`를 CSSOM으로 한 번 설정한다. 1.4MB 문자열을 상속되는 커스텀 프로퍼티에 싣지 않는다. JSX `style=`은 쓰지 않는다(`inline_style` 게이트).
- **수명**: 바꾸거나 「기본으로」를 누르면 이전 사진을 지우고, 로그아웃·세션 경계에서도 지운다. 시작할 때 참조가 가리키는 사진이 없으면 「없음」으로 돌린다. 네트워크 호출은 0이며 모듈 소스에 `fetch`·`XMLHttpRequest`·`upload`가 없음을 정적으로 단정한다.
- **접근성**: `prefers-reduced-transparency`·`prefers-contrast: more`가 켜지면 배경을 끄고 불투명 기본 바닥으로 돌아간다. 선택은 지우지 않는다.

## 11. 열린 테마 (증보 3 D3·D5)

### 11.1 범위

- 여는 것: ① VS Code·shiki 테마 JSON 가져오기(파일·붙여넣기) → 씨앗 → 파생 ② oort 테마 JSON 내보내기·가져오기 ③ 사용자 토큰 편집기(기본 테마 + 덮어쓰기) ④ 배경화면(§10) ⑤ 사이드바 색 ⑥ 저장은 이 기기.
- 열지 않는 것: 임의 CSS(외부 `url()`로 새는 길, `raw_color`·`inline_style` 규칙, CSP 충돌. 결정 8), 외부 URL 이미지, 서버 업로드, 테마가 반경·그림자·타입·내비를 바꾸는 것(본문 D2), 공유 링크와 마켓(P2).

### 11.2 가져오기 규칙 (`vscodeImport.ts`, 순수)

- 입력은 256KB 이하의 문자열이다. JSONC(주석·후행 쉼표)를 의존성 없이 직접 벗긴다(문자열 리터럴 안은 보존). VS Code 공식 가이드에서 JSONC·`include` 지원 문구는 확인하지 못했다(미확인). 실무에서 쓰이므로 가정하고 설계한다.
- 필수는 `editor.background`·`editor.foreground`이고 없으면 거절한다(「배경색과 글자색이 있는 테마만 가져올 수 있어요.」). 모드는 바탕 휘도로 정한다.
- 색은 `#RGB`·`#RGBA`·`#RRGGBB`·`#RRGGBBAA`만 읽고 알파는 버린다. `rgb()`·이름 색은 그 키만 무시한다. `include`는 무시하고 경고한다(「이 테마는 다른 파일을 포함해요. 포함된 색은 가져오지 못했어요.」). `tokenColors`가 문자열(외부 `.tmTheme` 경로)이면 무시한다.
- **보안 경계**: 입력은 신뢰하지 않는다. 결과는 `#rrggbb` 12개 안팎과 이름뿐이고, CSS로 나가는 값은 전부 우리가 다시 직렬화한다. 이름·작성자는 40자 이하, 제어문자 제거, 텍스트로만 그린다. JSON 깊이 8 이하, 키 수 상한, 모르는 키는 버린다. 시험은 악성 샘플(거대 중첩·`</style>`·`url(`·`__proto__`)과 로컬 퍼저다.

### 11.3 사용자 토큰 편집기 (AP-5)

「새 테마 만들기」는 기본 테마를 고른 뒤 아래만 덮어쓴다. 라이트·다크 탭마다 따로다.

| 그룹 | 항목 | 내부 처리 |
|---|---|---|
| 바탕 | 창 바탕(평면 1색 또는 2~3정지점 그라데이션), 본문 판 | 씨앗 `bg` 재파생 또는 역할 덮어쓰기 → 파생 재계산 |
| 사이드바 | 사이드바 색 | `band` 덮어쓰기. `on-band`·`on-band-muted`는 엔진이 푼다 |
| 글자 | 본문 글자색, 보조 글자색 | 명도 보정 4.5 |
| 강조 | 강조색 | `resolveSignal`(보정·거절 문구는 기존 것) |
| 에이전트·상태 | 에이전트색, 성공·경고·위험 | 명도 보정 + 거리 0.07 |

- 덮어쓸 수 있는 역할은 10개다. 강조색은 기존 `signal` 필드이고 나머지 아홉(`canvas`·`surface`·`ink`·`ink-muted`·`agent`·`ok`·`warn`·`danger`·`band`)은 `overrides`다. 전부 직접 지정하는 「고급」 모드는 P2다.
- 항목마다 색 입력(텍스트 hex가 정본, 컬러 입력은 보조)·「기본으로」·보정 또는 거절 문구가 있고, 미리보기는 앱 전체가 라이브다.
- 현재 모양은 기본 테마 + `overrides`(+ 배경)다. 설정의 「사이드바 색」 같은 행은 현재 모양의 `overrides`를 바로 고치고, 「내 테마로 저장」은 그 스냅샷을 이름 붙여 저장한다. 가져온 테마도 같은 목록에 들어간다.

### 11.4 `oort-theme` v1

```jsonc
{
  "format": "oort-theme",
  "version": 1,
  "id": "midnight-dev",                  // /^[a-z0-9]+(-[a-z0-9]+)*$/, 40자 이하. 저장 시 user:<id>
  "name": "한밤 개발자",                   // 1~40자, 제어문자 제거, 일반 텍스트로만 표시
  "author": "kwak",                      // 선택, 40자 이하
  "license": "CC0-1.0",                  // 선택, 40자 이하, 정보용
  "extends": "catalog:nord",             // 선택: "oort:<dawnsky|graphite|noeul>" 또는 "catalog:<id>"
  "seed": {                              // extends가 없으면 필수. 최소 한 모드
    "light": { "bg": "#fdf6e3", "fg": "#586e75", "comment": "#93a1a1",
               "added": "#859900", "deleted": "#dc322f", "modified": "#b58900",
               "accent": "#268bd2", "agent": "#2aa198", "sidebar": "#eee8d5" },
    "dark":  { "bg": "#002b36", "fg": "#839496" }
  },
  "signal": { "custom": "#ff7b72" },     // 선택: null | { "preset": id } | { "custom": "#RRGGBB" } (기존 신호 규칙·보정·거절 그대로)
  "overrides": {                         // 선택. 모드별. 허용 키 9개뿐
    "dark": { "canvas": ["#101418", "#0d1117", "#0b0f14"], "surface": "#161b22",
              "ink": "#e6edf3", "ink-muted": "#9aa7b4", "agent": "#79c0ff",
              "ok": "#3fb950", "warn": "#d29922", "danger": "#f85149", "band": "#0b1020" },
    "light": { "band": "#eee8d5" }
  },
  "wallpaper": { "kind": "preset", "id": "bam" }   // none | solid | preset (image는 기본 제외)
  // "wallpaper": { "kind": "image", "dataUrl": "data:image/jpeg;base64,..." }  ← 내보낼 때 「사진 포함」을 고른 경우만, 1.5MB 이하
}
```

- 검증: 크기 256KB 이하(이미지 없음) 또는 2.2MB 이하(이미지 포함), 깊이 8 이하, 색은 전부 `#RRGGBB`만 통과, 모르는 키는 버리고 경고, `id`·`name` 정규화, `format`·`version` 불일치는 거절한다. 값이 하나도 CSS 문자열로 그대로 가지 않는다. `export → import`가 같은 파생 결과를 낸다(속성 시험).
- `extends`와 `seed`가 함께 있을 때의 우선순위는 AP-5가 정한다. 모듈 위치는 `packages/momo-core/src/design/userTheme.ts`(+시험)이고 폰도 같은 파서를 쓴다.
- 사용자 테마는 최대 20개, 개당 8KB 이하(이미지 제외)이며 id는 `user:<slug>`다. 저장은 `momo.web.userThemes.v1`이다.

### 11.5 사이드바 색 (D5)

이미 있는 장치를 쓴다. 사이드바 열 아래의 `--band` 층, 사이드바 안 글자 역할을 띠 역할로 다시 묶는 규칙, 「띠 위에는 `on-band`·`on-band-muted`·`signal`만 선다」는 시험이다. 사용자가 색 하나(모드별, `overrides.band`)를 고르면 엔진이 `on-band`(4.5)·`on-band-muted`(4.5)를 풀고 신호가 띠 위 3:1인지 확인한다(`resolveSignal`이 띠를 비텍스트 호스트로 이미 다룬다). 카탈로그의 원본 사이드바 색은 눈에 띄게 다른 테마가 55종 중 7종뿐이라 옵션으로 만들지 않고 사용자 지정만 연다. 사이드바 이미지는 P2다.

### 11.6 공유 링크 (P2)

딥링크 `oort://theme?d=<base64url(deflate(json))>`을 재사용하고, 자동 적용 없이 미리보기와 「가져오기」 확인을 거친다. 이미지는 제외하고 길이 상한을 둔다. 형식(v1)이 굳은 뒤 별도 이슈다(AP-8).

## 12. 표시 설정 (증보 3 D8)

| 컨트롤 | 값 | 저장 | 앱에 닿는 경로 | 이슈 |
|---|---|---|---|---|
| 글자 크기 | 작게·기본·크게 = 메시지 본문 14·15·16px(±0.1) | `fontSize` | 루트 `data-font-size` → `--type-scale` → `--type-rem` → `--text-*`. 다른 글자 역할도 비례하고 브라우저 줌과 직교한다. 터치 입력 칸의 `--field-text-floor`(16px)는 변하지 않는다 | AP-2a |
| 대화 밀도 | 촘촘하게·편하게·여유롭게 | `density` | 루트 `data-density`. 값은 §5의 표이고 AP-2a가 대화 표면에서 읽어 옮긴다 | AP-2a |
| 선택한 항목 강조 | 켬·끔 | `prominentActive` | 루트 `data-prominent-active`. 선택 행이 `--primary` 채움과 `--on-primary` 글자(4.5:1, 띠 위 사이드바에서도) | AP-2b |
| 스레드 배치 | 옆에 열기(`split`)·겹쳐 열기(`focus`) | `threadLayout` | 루트 `data-thread-layout`. `focus`는 폭과 무관하게 겹쳐 열린다. `split`은 현행(900px 미만에서 자동 겹침)이고 행 설명이 그 사실을 말한다 | AP-2b |

- 컨트롤은 소비자와 같은 PR에서만 공개한다(S0 핸드오프 R4). 눌러도 안 바뀌는 컨트롤은 한 번도 나가지 않는다.
- 본문 15px(`--text-body`)이 기준이다. 증보 1 D2의 13/14/15는 14/15/16으로 대체했다.

## 13. AP 시리즈 (증보 3)

상위는 설정 개편 에픽 #3578이다. #2720(DS2-8)은 AP-2a가 흡수한다.

| 단계 | 이슈 | 내용 | 트랙 | 규모 | 의존 | 우선 |
|---|---|---|---|---|---|---|
| AP-0 | #4185 | 증보 3 + 문서·이슈 정리 | 엔진(기획 문서) | S | — | P0 |
| AP-1a | #4186 | 외양 저장소 v2 이행·루트 속성·CSS 조각·합성 골격(보이는 변화 0) | UXUI | M~L | — | P0 |
| AP-1c | #4187 | scrim 산수 core 이전 | UXUI | S | — | P0 |
| AP-1b | #4188 | 테마 엔진 + 카탈로그 57종 + 갤러리 | UXUI | L | 1a, 1c, 증보 3 | P0 |
| AP-2a | #4189 | 글자 크기 3단 + 대화 밀도 3단(#2720 흡수) | UXUI | L | 1a | P0 |
| AP-3 | #4190 | 데스크탑 유리 배경 + 불투명도 슬라이더 | UXUI | M | 1a, 1c | P0 |
| AP-4 | #4191 | 배경화면(웹·데스크탑) | UXUI | L | 1a, 1c, 증보 3 | P0~P1 |
| AP-5 | #4192 | 열린 테마: 가져오기·편집기·내보내기·사이드바 색 | UXUI | L | 1b, 증보 3 | P1 |
| AP-2b | #4193 | 선택한 항목 강조 + 스레드 배치 | UXUI | S | 1a | P1 |
| AP-6 | #4194 | 모바일 카탈로그 + 테마 고르기 화면 | UXUI(폰) | M~L | 1b, 1c, 증보 3 | P1 |
| AP-7 | #4195 | 외양 계정 동기화(새 ADR 필수) | 엔진 + UXUI | L | 5 안정화 | P2 |
| AP-8 | #4196 | P2 묶음(공유 링크·Base16·오로라·사이드바 이미지·터미널 파생·Liquid Glass·코드 하이라이트) | UXUI | 항목별 | — | P2 |

**병렬 파도**: 파도 0은 AP-0 ‖ AP-1a ‖ AP-1c(서로 다른 파일). 파도 1은 1a·1c 머지 뒤 AP-1b ‖ AP-2a ‖ AP-3 ‖ AP-4(「엔진 + 갤러리」가 첫 가치라 AP-1b가 먼저 시작·검수된다). 파도 2는 AP-5(1b 뒤) ‖ AP-2b ‖ AP-6(1b 뒤). 파도 3은 AP-7·AP-8이다. 증보 3이 Accepted로 track/engine에 랜딩하는 것이 AP-1b·4·5·6의 머지 조건이고 착수와 PR 작성은 먼저 해도 된다(ADR-0100).

**충돌 방지(파일 소유)**
- `design/theme.ts`·`public/theme-boot.js`·core `appearance.ts`·`AppearanceSection.tsx`와 `tokens.css`의 두 군데(`.app-shell` 배경 층 변수화, 파일 위쪽의 `@import`)는 AP-1a가 소유한다. 다른 이슈는 건드리지 않고 `design/appearance/*.css` 조각과 행 파일만 더한다.
- `tokens.css`의 `@theme --text-*`와 `--spacing-row`는 AP-2a만 만진다.
- core `design/`의 새 파일은 이슈마다 따로다(AP-1c `scrim.ts`, AP-1b `themeSeed.ts`·`themeCatalog.generated.ts`·`derive.ts`, AP-2a `density.ts`, AP-4 `wallpaper.ts`, AP-5 `userTheme.ts`·`vscodeImport.ts`). `themeResolve.ts`만 AP-1a에서 AP-1b로 이어진다.
- `legal/THIRD_PARTY_NOTICES.md`는 AP-1b(Buzz 행·카탈로그 행)와 AP-3(「Desktop client direct additions」 행)이 서로 다른 표를 고친다.
