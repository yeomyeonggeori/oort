# Design Review — 컴포저 「작성 중」 한 줄 (PR #1059 / feat/B3-W2-typing @ deabf788)

## 정리 상태
- 임시 워크트리 `/private/tmp/momo-review-b3w2/wt` **제거 완료** (worktree 목록 16→15)
- 스크래치 디렉터리 삭제 완료, main 워킹트리 clean, **리포 파일 수정 0건**
- 잔존물: `crop-light.png`, `crop-dark.png`, 이 파일 (`/private/tmp/momo-review-b3w2/`)

## 평가 수단
1. **코드** — `origin/feat/B3-W2-typing` @ `deabf788`을 임시 워크트리에 체크아웃해 정독. 아래 인용 file:line은 전부 그 트리에서 실재 확인.
2. **캡처** — `artifacts/`는 `clients/web/.gitignore:7`로 무시되어 브랜치에 없음. 워커 워크트리
   `~/projects/momo-tracks/momo-worktrees/B3W-conversation/clients/web/artifacts/typing/typing-{light,dark}.png` (1280x900) 사용.
   출처 검증: 그 워크트리 HEAD가 리뷰 중 `f33cb751`로 리베이스됐으나
   `git diff deabf788 f33cb751 -- TypingLine.tsx Composer.tsx typing.ts` = **빈 diff**(바뀐 건 quote 계열 2파일) → 동일 픽셀.
3. **파생 증거** — 위 크롭 2장(컴포저 하단 3행 3배 확대). 좌표/색은 PIL 실측.
4. **런타임 시뮬레이션** — 코어 순수함수(`typing.ts`)를 그대로 실행해 H-1 재현.
5. **기계 프리플라이트** — `bash scripts/design_preflight_web.sh`

```
OK emdash:0  raw_color:0  inline_style:0  arbitrary_tw:0  ai_gradient:0
OK toast:0   naked_focus:0 external_font:0 hype:0 pure_bw:0
RESULT: PASS, 10/10 categories clean.
```

## 실측값 (typing-light.png)
| 행 | y밴드 | 첫 잉크 x | 렌더 폭 |
|---|---|---|---|
| `Enter로 보내기…` 힌트 | 825-837 | **265** | 189px |
| `이도현, 김민서님이 작성 중…` | 851-864 | **256** | 137px |
| `김인턴이 작업 중 0s` | 877-888 | **256** | 100px |

행 피치 26px (`--text-meta--line-height` 18px + `pb-2` 8px).
대비: `--ink-muted`/`--surface` = 라이트 **5.34:1** · 다크 **6.36:1** / `--agent`/`--surface` = 5.44 · 6.63 → 12px 본문 AA(4.5) 양 스킴 통과.
채도(최대): 작성 중 행 **11**(무채색) / 작업 중 행 **57**(라이트) · **66**(다크, `--agent`).

---

## [Blocker] 0건
클릭 불능 컨트롤·타이틀바 침범·기본 폭 잘림 모두 해당 없음. 새 줄은 비대화형 `<p>`이고 탭 순서를 바꾸지 않는다.

---

## [High] 3건

### H-1. 이름 순서가 재발행마다 뒤집혀 문장이 ~1.5초마다 다시 쓰인다
- `packages/momo-core/src/features/chat/typing.ts:307` — `sentAtMs` 오름차순 정렬
- `packages/momo-core/src/features/chat/typing.ts:252-262` — `mergeTypingSignal`이 재발행 프레임마다 엔트리를 통째로 교체
- `packages/momo-core/src/lib/realtimeEvents.ts:189` — 새 `sentAtMs`의 출처인 `frame.ts`는 **발행 시각**

즉 정렬 키가 "언제 시작했나"가 아니라 "가장 최근 언제 발행했나"다. 두 사람이 3초 케이던스로 위상차를 두고 계속 치면 순서가 계속 뒤집힌다. 코어 모듈 그대로 실행:

```
t=2.0s -> 이도현, 김민서님이 작성 중…
t=3.5s -> 김민서, 이도현님이 작성 중…
t=5.0s -> 이도현, 김민서님이 작성 중…
t=6.5s -> 김민서, 이도현님이 작성 중…
```

**왜 문제인가**: 이 줄은 사라질 때가 아니라 살아 있는 동안 흔들린다. 12px 회색 한 줄이 1.5초마다 자기 텍스트를 다시 쓰면 "새 사람이 들어왔나"로 읽혀 눈이 되돌아온다 — 주변시로 흘려보내야 할 신호가 정반대로 작동한다. 잘림 지점과 폭도 함께 바뀐다.
덧붙여 `packages/momo-core/src/features/chat/typing.test.ts:313`의 테스트 이름이 **"orders by when each person started, not by arrival"**인데 사람당 1회 발행만 다뤄 재발행 경로가 비어 있다. 코드가 자기 테스트가 이름 붙인 불변식을 깨고, 테스트는 그걸 못 본다.

### H-2. 줄의 등장/소멸이 캐럿을 26px 밀어 올린다 — 같은 파일이 옆 줄에는 자리를 예약해 두고서
- `clients/web/src/features/chat/TypingLine.tsx:54` — `if (sentence === null) return null;`
- `clients/web/src/features/chat/TypingLine.tsx:57-60` — 주석 "자리를 비워 두지 않는다"
- `clients/web/src/features/chat/Composer.tsx:658-662` — 마운트 위치(입력창 아래)
- `clients/web/src/features/chat/Composer.tsx:491` — 컴포저 루트 `<div className="safe-area-bottom border-t border-line">` (셸 하단 고정 블록)
- `clients/web/src/features/timeline/Timeline.tsx:252-253` — `alignToBottom` / `followOutput="auto"` → 타임라인은 바닥 정렬 유지, 따라서 움직이는 건 **입력창·전송 버튼**

**대조 근거(같은 파일)**: `Composer.tsx:374`·`:515-520`은 라우팅 줄이 사라질 때 `MENTION_ROUTING_ROW_CLASS`(`clients/web/src/features/routing/MentionRoutingBar.tsx:73` = `h-8`, 32px)를 빈 자리로 **예약**한다 — 캐럿 아래가 흔들리지 않게 하려고.
TypingLine의 반박("이 줄은 남의 일이다")은 **내용**의 차이는 설명하지만 **흔들림**의 차이는 설명하지 않는다. 캐럿 이동량은 같고, 트리거가 내 손이 아니라 남의 키라 예측 불가능성은 더 높다. 빈도도 다르다: 라우팅 줄은 내가 @를 지울 때 한 번, 이 줄은 팀원이 치기 시작할 때마다 + 멈추고 6초 뒤마다. 작업 중 줄까지 겹치면 최대 52px 왕복. 폰(`safe-area-bottom`, 키보드 올라온 상태)에서는 엄지 아래에서 전송 버튼이 움직인다.

### H-3. 메타 3행의 왼쪽 모서리가 8px 어긋난다 — 그게 틀렸다는 판정이 바로 위 줄에 이미 적혀 있다
- `clients/web/src/features/chat/TypingLine.tsx:56` — `className="truncate px-4 pb-2 text-meta text-ink-muted"`
- `clients/web/src/features/chat/Composer.tsx:637` — 바로 위 힌트는 `px-6`
- `clients/web/src/features/chat/Composer.tsx:630-632` — 그 이유: *"px-6 = 폼의 p-3(12px) + 텍스트에어리어의 px-3(12px). 힌트의 첫 글자가 플레이스홀더의 첫 글자와 같은 세로선에 선다. **px-4는 어느 쪽 모서리와도 맞지 않아 4px 어긋난 줄로 보였다.**"*

실측 265 vs 256 (크롭 3배에서 육안으로 분명). 입력창 아래 12px 회색 3행이 왼쪽 모서리를 두 개 갖는다.
공동 책임 명시: `Composer.tsx:159`의 AgentActivityBar `<ul className="flex flex-col gap-1 px-4 pb-2">`가 기존부터 `px-4`였다. 다만 이 PR이 그 사이에 3번째 행을 끼워 넣어 어긋남을 "두 줄 사이 우연"에서 "스택의 성질"로 바꿨고, 정답은 이미 같은 파일에 문서화돼 있다.

---

## [Medium] 4건

### M-1. 문서화된 대조축 「이름 색 = 사람의 잉크」가 마크업에 없다
`clients/web/src/features/chat/TypingLine.tsx:20-25`의 표가 네 축(시계 / 클릭 / **이름 색** / 소멸)을 주장하는데, `:56`은 문장 전체를 `text-ink-muted` 하나로 칠하고 이름을 감싼 `<span>`이 없다 — 이름과 나머지 글자가 완전히 같은 색이다(캡처 채도 실측 11 = 무채색).
실제로 작동하는 구분은 **에이전트 줄에만 있는 표지**(파란 이름 + 시계 + 클릭)이고, 사람 줄이 가진 건 "그게 없음"뿐이다.
- 두 줄이 **함께 보일 때**: 읽힌다. 배치 의도는 이 조건에서 성립.
- **작업 중 줄이 없을 때**(에이전트 턴 없는 대부분의 시각): 남는 단서가 12px 회색의 **한 음절**(작**성** 중 / 작**업** 중)뿐. 배치의 논지 자체가 "떨어뜨려 두면 각자 그냥 「무언가 진행 중」으로 읽힌다"인데, 그 상태가 기본값이 된다. 나란히 두는 것만으로는 학습이 일어나지 않는다 — 사람 줄에도 자기 표지가 있어야 대조가 양방향이 된다.

(부수: `님` 유무는 실제로 작동하는 네 번째 축이다. 표에는 없지만 유일하게 사람 줄 쪽에 있는 표지.)

### M-2. 잘린 이름의 유일한 복구 경로가 `title` 툴팁 — hover 전용, 키보드·터치 불가
`clients/web/src/features/chat/TypingLine.tsx:63` — `title={typingLabel(names, threshold) ?? undefined}`
1. `packages/momo-core/src/features/chat/typing.ts:337-340`은 이 값의 목적을 "보조기술이 읽을 이름"이라 말하지만, 역할 없는 `<p>`의 접근 이름은 텍스트 콘텐츠에서 나온다. 스크린리더는 `…`가 붙은 **보이는 텍스트를 그대로 읽고** `title`은 설명으로 덧붙을 뿐이라, 의도한 치환이 일어나지 않는다. (이중 낭독 여부는 리더별 차이 → **확인 필요**. "title이 보이는 텍스트를 대체하지 않는다"는 부분은 확정.)
2. `aria-live` 미적용 판단(`TypingLine.tsx:27-32`) 자체는 타당하고 작업 패널 선례와 일관된다. 다만 그 결과 이 줄은 능동 고지도 없고 포커스도 못 받아, 잘렸을 때 전체 이름을 얻는 길이 마우스 사용자에게만 있다.

### M-3. 잘린 줄과 온전한 줄이 구분되지 않는다
`clients/web/src/features/chat/TypingLine.tsx:56`의 `truncate` 말줄임과 문장이 원래 가진 `…`(`packages/momo-core/src/features/chat/typing.ts:333-334`)가 같은 글자다. 한국어는 동사가 끝에 오므로 잘리는 순간 **「작성 중」이라는 말 자체가 사라지고** 이름 나열 + `…`만 남는다 — 집계 문구와도 다르고 아무 말도 하지 않는다.
현재 조건(1280폭 · 2명 · 3글자 이름)은 137px로 여유가 크고, 폰 390폭에서도 `px-4` 제외 358px가 남아 기본 이름 길이로는 안 잘린다. 긴 표시명 2명(예: "김민서 프로덕트디자인", 약 340px+)에서 발생 — **narrow 뷰포트/긴 이름 런타임 캡처는 확보하지 못했으므로 폭 실측 기반 추정, 확인 필요.**

### M-4. 변하지 않는 정보가 캐럿에 더 가깝고, 변하는 정보가 3번째 줄에 있다
순서: 입력창 → 키 안내(`clients/web/src/features/chat/Composer.tsx:637`, 절대 안 바뀜) → 작성 중(`:658`) → 작업 중(`:664`). 지금 새로 생긴 사실이 캐럿에서 가장 먼 두 줄에 있고 그 사이를 정적 안내문이 막는다.
부수: `packages/momo-core/src/features/chat/typing.ts:321` 독스트링은 이 줄을 "컴포저 **위** 한 줄"이라 부르는데 실제 렌더는 입력창 **아래**다 — 문서와 화면이 서로 다른 배치를 말한다.

---

## [Nitpick] 4건

- **N-1** `님`이 마지막 이름에만 붙는다. `packages/momo-core/src/features/chat/typing.ts:334` — `${names.slice(0, limit).join(", ")}님이` → "이도현, 김민서**님이**". 같은 캡처 상단 채널 헤더는 이름 나열에 `님`을 쓰지 않는다("곽성재, 이도현, 김민서 외 2"). 한 화면에 나열 규칙이 둘이다. (조사 자체는 안전 — `님`/`명` 모두 받침이 있어 `이`가 항상 맞다.)
- **N-2** 집계 숫자에 `data-numeric`이 없다. `packages/momo-core/src/features/chat/typing.ts:333`의 `${names.length}명이 작성 중…`은 순수 문자열이라 붙일 자리가 없다. 26px 아래 `clients/web/src/features/chat/Composer.tsx:222`의 「외 `<span data-numeric>`N`</span>`명」은 붙어 있다 → 2→3→4명에서 폭이 흔들린다(SKILL-web §3).
- **N-3** `clients/web/src/features/chat/typingStore.ts:84`의 `resetTyping`이 `src/` 어디서도 호출되지 않는다. 독스트링은 "세션 해제 · 워크스페이스 전환 · 테스트"라고 말한다. 채널 id 필터와 6초 만료 덕에 영향은 작으나, 배선되지 않은 teardown이다.
- **N-4** 증거 공백. 제출 캡처는 **빈 채널**("이 채널을 함께 시작하세요")에서 두 명이 작성 중 + 에이전트 작업 중인 장면이다. 줄만 떼어 보기엔 좋지만, 루브릭 phase 5(밀집 타임라인 200행)에서 이 3행 스택이 어떻게 읽히는지는 아직 아무도 못 봤다.

---

## 지정 질문 4개 직답

1. **「작성 중」(사람)과 「작업 중」(에이전트)이 어휘 없이 읽히는가** — 조건부. 두 줄이 함께 있을 때만 읽힌다(파란 이름 + 시계 + `님`). 작업 중 줄이 없으면 단서는 한 음절뿐이고, 표가 주장한 「이름 색」 축은 구현에 없다 → **M-1**.
2. **등장/소멸이 레이아웃을 밀지 않는가** — **민다. 26px.** 자리 예약 없음. 같은 컴포저의 라우팅 줄은 32px를 예약해 둔 상태 → **H-2**.
3. **라이트/다크 대비** — 문제 없음. 5.34:1 / 6.36:1로 양 스킴 AA 통과, 다크에서 `--agent` 이름도 6.63:1.
4. **TTL 소멸 시 잔상/깜빡임** — **소멸 쪽은 깨끗하다**: 3s 재발행 vs 6s TTL로 마진 2배, `clients/web/src/features/chat/typingStore.ts:126-134`가 렌더 시각을 다시 읽어 판정, `packages/momo-core/src/features/chat/typing.ts:269-275`가 버릴 게 없으면 같은 배열을 돌려줘 리스너를 안 깨움, 애니메이션 0이라 reduced-motion 이슈 없음. 문제는 소멸이 아니라 **생존 중**이다 → **H-1**.

---

**Verdict: FAIL(blockers: 0)** — Blocker 0이지만 High 3건이라 루브릭 통과선(Blocker 0 · High ≤2; ADR-0133 게이트 목표는 High 0)을 넘지 못함 → 구현자에게 반송.
수정 우선순위 제안: **H-1**(진실성·읽기 방해) > **H-2**(입력 중 흔들림) > **H-3**(1단어 수정).
