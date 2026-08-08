### Design Review — 폰 다크 팔레트 20역할 웹 정렬 (PR #1186, feat/dark-1164-parity @ 732d636a)
Screenshots: /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/dark-1164/clients/mobile/measure/captures/dark1164-{theme,avatar,landed,approval,danger,scrim}-{dark,light}.png (12장, 1206x2622px, pt=px/3)

Reading this as: 메시지 타임라인/승인 카드/편집 시트/테마 컨트롤의 다크 팔레트 전면 정렬, phone(RN) HIG-first, density 6/10, motion 0/10 (색 전용 배치 — 모션 무변경).

## 검증 방법
- 정본 선행: `.claude/skills/momo-design-taste/SKILL.md` + `references/review-rubric.md` + `references/ios-rubric.md` + `docs/ux-bible/README.md`.
- 웹 정본 대조: `clients/web/src/design/tokens.css` 를 직접 읽어 16역할 light-dark 두 항 확인.
- 독립 재계산: WCAG 상대휘도·OKLab/OKLCH(테스트 파일과 동일 행렬) 파이썬 재구현으로 PR 의 수치 주장 전수 재계산.
- 픽셀 실측: 12장 전부 최빈값 히스토그램(상태바 180px·홈 인디케이터 100px 제외) + 구팔레트 15값 전수 스캔 + 특정 토큰 픽셀 카운트.
- 가드 실행: `jest paletteContrast + conversationHygiene + conversationVisual` — 3 suites / 208 tests green (캐시는 scratchpad 로 돌려 워크트리 무변경).

## 우선순위 검증 4건 — 전부 실측 재현됨

① **에이전트 색 아이덴티티 통일** — 재현.
- 웹 정본 `--agent: light-dark(#4a6785, #7fa0c4)` + 주석 *"never neon AI purple"* 확인(tokens.css L46-47).
- dark1164-avatar-dark.png: agent #7fa0c4 = 1,667px · agentSurface #1e2836 = 11,075px, **구 보라 #b58bd6 = 0px**. 12장 전체에서 구팔레트 15값 잔존 0px.
- 새 다크 agent 는 라이트 agent 와 색상각 1.06° — 한 아이덴티티의 두 스킴이 됐다. accent(호박)와는 178° 반대편이라 「에이전트 ≠ 내 것」 구분도 산다.
- 구분성: avatar-dark 에서 사람 행(중성 아바타+백색 이름)과 에이전트 행(슬레이트 이름+「에이전트」칩)이 같은 해부구조 위에서 칩·이름색만으로 갈라진다 — SKILL §4(같은 그리드, 정체성은 accent 토큰만) 준수. AA: agent on bg 6.63:1 · on agentSurface 5.47:1.
- 단, 구현자가 근거로 세 곳에 적은 「159°」는 오기다(아래 M1). 실제 59.4°.

② **N1 해소(warn/accent 18.08°)** — 소수 넷째 자리까지 재현.
- before #d9a441 vs #f0a850: dE 0.0425 / 10.87° (주장 일치). after #d4a72c vs #f0a850: dE 0.0560 / **18.08°** (주장 일치). 라이트 25.92° (일치).
- 소프트 단 역근접(warnSurface vs accentSurface dE 0.046→**0.023** · 각 20.0°→27.8°)도 재현 — PR 이 정직하게 적은 그대로이고, 남는 결정 ②(accent 의미 재배선)로 넘긴 것이 맞다.

③ **위험 위계(채도 자)** — 재현.
- 웹 `--danger` 주석(순서의 자 = OKLab C) 원문 확인(tokens.css L69).
- before: danger C 0.1305 / warn C 0.1295 = **1.007배**(우연). after: 0.1661 / 0.1407 = **1.180배**. 라이트 1.652배. 새 가드 `C(danger)>C(warn)>C(textMuted)` 두 스킴 green.

④ **스크림 합성** — 산술·픽셀 양쪽 재현.
- 웹 `--scrim` 다크 `rgb(9 8 11 / .62)` → `#09080b9e` 변환 정확(0.62*255=158.1→0x9e).
- 산술 합성 #09080b9e over #17161a = **#0e0d11**, danger-dark 881,106px · scrim-dark 1,061,039px 로 최빈값 실측. surface 위 합성 #121115 도 15,209px 확인. 라이트 #c5c3c0(산술 #c4c3bf, 채널당 1 LSB iOS 반올림) 재현.
- scrim-dark 의 순흑 38,536px 는 전량 y<200(Dynamic Island/상태바) — 시스템 크롬이고 팔레트 아님.

## 가드 건전성 (paletteContrast.test.ts)
- **웹 파일 파싱 15역할×2스킴 + scrim rgb→#rrggbbaa**: 코드로 확인 — 기대값이 테스트 파일에 없고 출처는 tokens.css 뿐. 「베낀 기대값 0」 주장 참.
- **실패 모드 닫힘**: 파서 throw 를 단정으로 잡는 테스트 존재(L369-376) — 변수 개명 시 조용한 통과 불가.
- **파생 계열각 문턱 15°의 출처**: tokens.css L99 *"위험 계열 hue 차 <= 15도"* 원문 확인 — 여기서 고른 숫자가 아니라는 주장 참. 실측 여유: 다크 최대 13.63°(dangerSurface) · 라이트 최대 12.65°(warnSurface) — 독립 재계산 일치.
- **회전 재도출 검증**: tone 회전각 +7.21°/+10.42°/−10.10° 재계산 일치. 파생 8역할의 tone 대비 오프셋이 정렬 전후 0.8° 이내 보존(예: warnSurface 4.08°→4.69°).
- **onWarn 제외 사유**: 라이트 onWarn=#fffefb(채도 0.004) — 무채색 각 측정 무의미, 대비는 BODY_INK 가 짐(onWarn on warn 8.19:1 재계산). 타당.

## 기존 가드 재서술 2건 — 둘 다 참인 문장
- **① 고도 띠 절대 문턱(<1.1) → 순위 단정**: 다크 밴드 1.1001(0.0001 초과 실측 확인) < 최소 색채움 1.1641(warnSurface) · 라이트 1.0716 < 1.0801(okSurface) — 두 스킴 다 성립. 절대값 상한이 사라진 공백은 같은 파일의 바이트 파리티 가드가 bg/surface 를 웹에 고정하므로 닫혀 있다. `conversationVisual` 의 인용 블록 가드도 같은 관계로 이전 — 성립.
- **③ 순흑 면제에서 스크림 제거**: 구 다크 스크림이 실제 #000000aa 였고 8자리라 6자리 비교를 통과해 면제가 사실을 가렸다는 서술 — 참. 새 값 #09080b9e 는 알파를 뗀 색 부분(#09080b)이 재지고, 면제는 shadow 하나만 남는다. 가드 강화가 맞다.
- (`conversationHygiene` 값 분리 가드 무수정 주장도 diff 로 확인 — 주석 숫자만 갱신.)

## AA 재계산 스팟 (전부 통과)
agent on bg 6.627 · agent on agentSurface 5.473 · dangerText on dangerSurface 9.876 · warn on bg 8.029 · danger on bg 7.031 / on surface 6.391 · ok on bg 6.327 · textMuted on bg 6.358 / on warnSurface 5.462 · onWarn on warn 8.188. textFaint on bg 3.909→3.562 로 하락했지만 이 토큰의 계약은 본문 AA 가 아니라 컨트롤 테두리 3:1 이고(3.562≥3, surface 위 3.238≥3) 본문 용례는 이미 textMuted 로 옮겨져 있다.

## 기계 프리플라이트 (모바일 적응판, 원출력)
```
$ grep -rnE "#[0-9a-fA-F]{6}\b" src --include='*.ts*' | grep -v 'design/tokens.ts' | (주석행 제외)
(0건)  ← 뷰 코드 raw hex 0. measure 하네스의 손 hex 13개도 이 PR 에서 토큰 참조로 전환됨.
$ grep -rnE "['\"`][^'\"`]*[—–]" src …
src/push/native.ts:21,76 · src/push/PushProvider.tsx:76,120  ← 전부 dev 로그/주석, 기존 코드, 이 diff 밖.
```
사용자 노출 문자열 변경 0 (이 PR 의 산문은 전부 코드 주석).

## Findings

[Blocker] 없음.

[High] 없음.

[Medium]
- M1 — **에이전트 색상각 「159°」는 오기, 실측 59.4°다.** `clients/mobile/src/design/tokens.ts` L233·L295 (+PR 본문 3곳). 구 다크 agent #b58bd6 의 OKLCH 색상각은 309.3°, 라이트 --agent #4a6785 는 249.9° — 차는 59.4° 이고, 이 PR 자신의 hueGap 도구로도 159 는 나오지 않는다. 논지는 살아 있다(59.4° 도 계열 갈아탐이고, 정렬 후 1.06° 로 닫힘). 그러나 이 PR 스스로 「값이 움직이면 그 값을 인용한 숫자가 거짓말이 된다」며 낡은 실측 14곳을 갱신한 배치에서, 새로 새긴 근거 숫자가 틀린 채 정본 주석에 두 번 앉았다 — 다음 팔레트 작업이 이 숫자를 인용한다. 두 주석의 숫자를 재측정값으로 교정할 것(단정 변경 없음, 산문 2줄).

[Nitpick]
- N1 — 12장 캡처가 `onWarn`(#191405)을 한 픽셀도 싣지 않는다(채워진 warn 컨트롤 표면이 캡처 셋에 없음). 수학 가드(8.19:1)는 있으니 기록만 — warn 채움 버튼이 생기는 날 캡처 케이스가 함께 필요하다.
- N2 — measure 하네스 헤더 라벨(「아바타 — 사람 · …」)의 em-dash 는 개발 전용 표면+기존 문자열이라 카피 룰 위반으로 세지 않았다. 기록만.
- N3 — warnSurface/accentSurface dE 0.023 근접은 웹 파리티의 필연이고 PR 이 「남는 결정 ②(accent 의미 재배선, 성재 결정)」로 올바르게 격리했다. #1164 ② 를 닫을 때까지 이 근접은 의도된 상태로 취급.

## SKIPPED
- 증가 대비(increased-contrast)·큰 Dynamic Type 변형 캡처: measure 프로토콜에 원래 없는 축 — 이 배치는 색 값만 움직였고 타이포/레이아웃 무변경이라 위험 낮음. 상호작용 워크(폰 실기기 탭 경로)는 캡처+코드 히트테스트 추론으로 대체(변경이 StyleSheet 값·주석뿐임을 diff 로 확인).

Verdict: **PASS** (Blocker 0 · High 0 · Medium 1 · Nitpick 3)
M1 은 산문 2줄 교정이라 이 PR 에서 고치면 좋고, 후속 커밋으로 미뤄도 머지를 막을 급은 아니다.
