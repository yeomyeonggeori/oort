# 컴포저 buzz형 재구성 패킷 — UX-CB

> Status: `ready` (성재 직접 발제 2026-08-25 — 실물 검수 중 스크린샷 2장 + "buzz처럼 구성·하단 패딩 처리") · Planner owner: Fable · Integrator: momo-main
> GitHub binding: UX-CB=**#1749** · 워커: grok 병렬 1 — **UX-HT(#1743) 랜딩 후 착수**
> 기준: origin/track/uxui (UX-HT 랜딩 커밋) · 레퍼런스 증거: `claudedocs/composer-buzz-ref-20260825/`(current-oort-composer.png · buzz-reference.png)
> ADR: not required(UI 구성 변경 — 서버/스키마 비접촉)

## 1. 사실 (현행)

- `clients/web/src/features/chat/Composer.tsx` — 현행 구성: 입력 필드 **바깥** 좌측에 [첨부][이모지], 우측에 [보내기]가 한 행. 컴포저 아래 죽은 패딩 밴드 존재(성재 지적 — current-oort-composer.png 하단).
- 소비처: 채널 본문·스레드 패널(·DM 동형). 멘션 자동완성(C-1)=`MentionAutocomplete.tsx`, 이모지=UX-EB popover(`useComposerEmoji.ts` 앵커), 첨부 pending(U-3 계열), 타이핑 인디케이터 방출.
- 폰(`clients/mobile`) TypingBar는 별도 표면 — **이 티켓은 웹만**. `composerParity.test.ts`가 웹-코어 접점을 잰다.

## 2. 목표 구성 (buzz-reference.png)

단일 그릇(테두리 rounded 컨테이너) 내부 2행:

```
┌──────────────────────────────────────────────┐
│  <textarea: autogrow, 내부 무테두리>           │
│  [@] [첨부] [이모지]                 [보내기] │
└──────────────────────────────────────────────┘
```

- **1행 입력**: 기존 textarea 이동. placeholder·자동성장·Enter 전송/Shift+Enter 줄바꿈·IME 관례 불변.
- **2행 액션**: 좌측 [@]·[첨부]·[이모지](기존 버튼 이동), 우측 [보내기](기존). **Aa(서식) 버튼 금지** — 서식 기능이 없다. 기능 발명 금지, 액션은 기존 인벤토리만.
- **[@] 신설**: 클릭=캐럿에 `@` 삽입+입력 포커스 → 기존 멘션 자동완성이 자연 발동. 새 상태/스토어 금지.
- **하단 여백**: 컴포저 그릇 아래 패딩 밴드 제거/최소화(safe-area 인셋만 유지). 그릇-창 하단 간격은 그릇-타임라인 간격과 같은 어휘로.

## 3. 보존 계약 (깨지면 FAIL)

- 멘션 자동완성 팝업 위치(입력 기준) · 이모지 popover가 **새 이모지 버튼 위치에 앵커**(트리거 기준 — H-4 교훈) · 첨부 pending/실패 상태 · 오프라인 disabled 의미 · 타이핑 인디케이터 방출 타이밍 · 포커스 링·탭 타깃(44px) · 기존 testId(캡처 하네스 배선) · 스레드 컴포저 동형 적용.
- 탭 순서: 입력 → @ → 첨부 → 이모지 → 보내기(자연 DOM 순). 행 추가로 탭스톱 총수 증가는 [@] 1개뿐.
- 토큰 규율: hex/임의값/inline style 0. 그릇 테두리는 컨트롤 문법(`--line-strong` 계열 — 디자인 시스템 §6 「테두리는 컨트롤의 것」 준수).

## 4. AC

- 4상태(rest/focus/disabled·오프라인/첨부 pending) · light/dark.
- `capture:design` 갱신 — 컴포저 프레임 재생성(desktop+phone 캡처 하네스 그린 완주).
- `composerParity.test.ts` 현행화 · 신규 red proof: [@] 클릭→자동완성 발동 · 탭스톱 총수 단정.
- tsc·vitest 전량·프리플라이트 그린. 독립 design-review Blocker 0(신선 컨텍스트).

## 5. 적립 (구현 금지 — PR 본문 명시)

- 폰 TypingBar 동형 재구성(별도 티켓 — 폰 표면 정본 절차).
- 서식(Aa) 기능 자체의 도입 여부(제품 결정 — 성재).
