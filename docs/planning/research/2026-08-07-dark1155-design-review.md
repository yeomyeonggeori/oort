### Design Review — 폰 다크 accent 여명화 + 로그아웃 테두리 (PR #1163, feat/dark-1155 @ 455fd8a8)

Screenshots (실측 원본, iPhone 17 Pro 1206×2622px = 402×874pt, pt=px/3):
- /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/dark-1155/clients/mobile/measure/captures/dark1155-theme-dark.png
- /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/dark-1155/clients/mobile/measure/captures/dark1155-theme-light.png
- /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/dark-1155/clients/mobile/measure/captures/dark1155-composer-dark.png
- /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/dark-1155/clients/mobile/measure/captures/dark1155-composer-light.png

리뷰 성격: 구현 컨텍스트와 분리된 신선한 리뷰. 모든 판정은 픽셀 샘플링·산술 재계산·테스트 실행 실측.

---

## 0. 구현자 주장 대 실측 대조표

| 주장 | 실측 | 판정 |
|---|---|---|
| 웹 다크 3역할 바이트 일치 (#f0a850 / #33261a / #17161a) | 웹 tokens.css L42-44 직접 확인: `--accent: light-dark(#a54c08, #f0a850)` · `--accent-soft: light-dark(#f4e7d6, #33261a)` · `--on-accent: light-dark(#fffefb, #17161a)`. 폰 darkPalette·lightPalette 양쪽 모두 일치 | 성립 |
| 다크 composer: 밝은 호박 채움 + 어두운 글자 | dark1155-composer-dark.png 픽셀 최빈값: 채움 #f0a850 (15,653px), 글리프 최암값 #17161a | 성립 (바이트 일치) |
| 라이트 composer: 어두운 호박 + 종이색 글자 | dark1155-composer-light.png: 채움 #a54c08, 글리프 최명값 #fffefb | 성립 |
| theme 고른 칸: 테두리=accent·채움=accentSurface·글자=accentText | 다크: 테두리 #f0a850·채움 #33261a·글리프 #fcba6e / 라이트: #a54c08·#f4e7d6·#8f4207 — 전부 토큰값 그대로 | 성립 |
| 답글 롤업 링크·내 반응 칩도 같은 계열 | 다크 링크 #fcba6e(accentText), 칩 테두리 #f0a850 + 채움 #33261a | 성립 |
| onAccent 대비: 채움 위 8.94:1 · 눌린 채움 위 6.47:1 · accent/bg 9.38:1 | 재계산 8.94 · 6.46(반올림 차) · 9.38 | 성립 |
| 로그아웃 테두리: border 1.406/1.315 (3:1 미달) → textFaint 3.909/3.587 | 재계산 정확히 일치. 캡처의 ThemeControl 안 고른 칸이 같은 토큰쌍을 같은 bg 위에서 실증(다크 #6b7280 · 라이트 #84817d) | 성립 |
| 파생 3역할 OKLCH 관계 | accentPressed dL −0.0891(주장 −0.0887=라이트의 걸음, hex 양자화 오차), dH 0.00°, C비 0.999 / accentText dL +0.0498, dH 0.20°, C비 0.902 / accentSurfaceStrong dL +0.0567 — 옛 다크 자기 걸음 +0.0577 제자리 확인, C비 1.295 | 성립 (정직한 주석) |
| 주석 실측값 1.19·1.45 갱신 | 재계산 1.19 · 1.45 | 성립 |
| accentSurface vs warnSurface OKLab 0.047·색상각 20도 | 재계산 0.046 · 20.0 | 성립 |

## 1. 루브릭 페이즈별

**P0 Prep** — 캡처 4장(두 표면 × 두 스킴) 확보, measure 하네스가 실제 프로덕션 컴포넌트를 렌더함을 확인
(measure/surfaces.tsx 가 src 의 Composer·MessageRow·ThemeControl 을 직접 import). increased-contrast /
large-Dynamic-Type 변형 캡처는 없음 — RN measure 레인의 기존 한계, 이 PR 신설 아님.

**P1 Interaction** — 동작 변경 없음(색 값 + borderColor 토큰 1건). sign-out confirm/cancel 플로는 기존
shell.test 가 계속 통과(131건). 죽은 컨트롤 신설 없음. 눌린 상태(sendPressed=accentPressed) 정의 유지,
onAccent 대비 6.46:1 AA 유지.

**P2 Layout/Window** — 레이아웃 델타 0. 한/영 혼용 문자열 변경 없음. SKIPPED-N/A (변경 없음, 캡처로 회귀 부재 확인).

**P3 Visual polish** — 토큰 준수 완전(뷰 코드 raw hex 0 — 아래 pre-flight). 표면당 액센트 하나 원칙이 이
PR 로 웹과 문자 그대로 수렴. 두 스킴이 같은 가족(호박)을 입는 것이 theme 캡처 두 장에서 육안+픽셀로 성립.
스킴 전환 시 「내 것」의 색 계열 이탈(파랑→호박 단절)이 실제로 소멸.

**P4 Accessibility** — AA 산술 전건 재검증: onAccent/accent 8.94 · onAccent/accentPressed 6.46 ·
accentText/bg 11.15 · accentText/accentSurface 8.65 · text/accentSurfaceStrong ≥4.5(스위트) ·
로그아웃 테두리 3.909/3.587 ≥ 3:1. VoiceOver 표면 변경 없음.

**P5 Robustness** — 파리티 가드 건전성:
- 웹 tokens.css 를 파일로 읽어 대조 — 값 복사 아님. red proof 시뮬레이션: 옛 파랑 3값 전부 웹 정본과
  불일치로 FAIL 재현(scratchpad/redproof.js).
- 실패 모드가 닫혀 있음: 변수 개명·서식 변경 시 lightDark() throw → 시끄럽게 실패.
- `--accent:` 정의는 tokens.css 에 1곳뿐 — first-match 위험 현재 없음.
- shell.test 는 렌더 트리에서 두 테두리를 읽어 「같다」를 단정 + textFaint 계열임/border 계열 아님을 별도 단정
  — 낡은 값 복귀와 짝 이탈 양쪽을 잡는다. 스위트 3+2건 전부 그린(131+89).

**P6 Code health** — 매직값 0. 주석의 실측 숫자 전건 재현(위 표). accentSurfaceStrong 의 L 걸음 +0.0577 은
옛 다크 자기 걸음과 소수 4자리까지 일치 — 출처 주장 정직. pre-flight 원출력:

```
$ grep -rn "#[0-9a-fA-F]{6}" src --include='*.tsx' --include='*.ts' | grep -v 'design/tokens.ts'
→ 7건 전부 주석(AdeControlPanel 1 · MessageRow 6). 뷰 코드 0건.
$ grep -rn '—|–' src --include='*.tsx' (문자열/JSX 텍스트 필터)
→ 전건 코드 주석·JSX 주석·개발자 콘솔 로그. 제품 카피 0건.
```

**P7 Copy** — 사용자 가시 문자열 변경 없음. INDEX §2.1 신규 4행은 이웃 행과 서식 일치, cicd/10~13 실재,
`cicd/20-*` 잔존 참조 0건(전 repo grep).

## 2. Findings

[Blocker] — 없음

[High] — 없음

[Medium]
- M1: sign-out footer 의 두 상태(기본·confirm) 캡처가 없다. 기본 상태는 ThemeControl 안 고른 칸이 같은
  토큰쌍(textFaint on bg)을 같은 판에서 실증하므로 간접 증거가 충분하지만, confirm 상태는 이 PR 이 관계를
  뒤집었다: 이전엔 danger 테두리(1.70:1)가 기본(1.41:1)보다 진했고, 지금은 취소(3.91:1)가 파괴적 확인
  로그아웃(1.70:1 다크·1.76:1 라이트)보다 진하다. 나란한 두 버튼 중 파괴적인 쪽의 유일한 윤곽선이 화면에서
  가장 흐린 선이 됐다. 코드 주석의 면제 논거(danger 굵은 글자가 어포던스를 진다)는 그럴듯하고 danger/bg 는
  AA 를 넘지만, 픽셀로 확인된 적이 없다. 방향: confirm 상태 캡처 1장으로 닫거나, 파괴 버튼의 윤곽을 3:1
  계열로 올리는 것을 검토. 후속 티켓 허용.

[Nitpick]
- N1: 다크에서 warn(#d9a441)과 accent(#f0a850)가 OKLab dE 0.042·색상각 10.9도의 이웃이 됐다 —
  「여기를 보라」(미읽 경계·멘션)와 「내가 한 것」(보내기·내 반응)이 색으로는 더이상 구분되지 않는다.
  웹은 애초에 한 색이 두 뜻을 지므로 파리티의 필연이고, 한 화면에서 형태·위치가 겹치는 혼동 사례를 찾지
  못했다. MessageRow 주석이 이 상실을 정직하게 기록했고 hygiene 테스트가 바이트 분리를 계속 잰다. 기록만.
- N2: measure 하네스 머리글("테마 — 세 칸과…")의 em-dash 가 캡처에 보인다. -momoMeasure 전용 진단
  표면이라 제품 카피 아님, U2 기존물, 이 PR 밖.
- N3: 파생 관계 중 accentSurfaceStrong 의 채도 ×1.3 만 출처 없는 발명값(옛 다크 걸음은 ×1.005였다).
  주석이 출처를 사칭하지 않았고, 가시 결과(1.45 대 1.19 의 2단 위계)는 테스트가 잰다. 기록만.
- N4: accentPressed(#d28c30) 눌린 상태의 런타임 캡처 없음 — AA 6.46:1 산술과 스위트로만 검증. 기록만.

## 3. Verdict

**PASS** (Blocker 0 · High 0 · Medium 1 · Nitpick 4)

파리티 목표 성립(웹 다크 3역할 바이트 일치를 픽셀·정본 파일·가드 3중 실측), 명암 뒤집힘 캡처 성립(다크
#f0a850 채움+#17161a 글자 픽셀 일치), 로그아웃 테두리 3:1 초과 성립(3.909/3.587), 가드는 red proof
재현으로 낡은 값 복귀를 실제로 잡음을 확인. taste 루브릭 위반 없음. M1 은 후속 허용 등급.
