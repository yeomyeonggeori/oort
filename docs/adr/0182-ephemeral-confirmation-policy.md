# ADR-0182: 일시 확인(ephemeral confirmation) 정책 — 토스트 금지의 대안 문법

- 상태: **Proposed** (2026-09-02 기안 Fable — 성재 결재 대기. 인터뷰 Q2 권고 승인 = 금지 유지 + 대안 성문)
- 발제: 브리프 §2 근원 R6·웹 클라 실사 "No transient notification channel at all" / 편성 UX-R5e
- 관련: ADR-0159(디자인 시스템 §4 네 상태) · `momo-design-taste-web` §8 · `clients/web/src/features/common/States.tsx:35`("Toast stacks are banned; the message lives where the problem is") · `scripts/design_preflight_web.sh` 카테고리 6 `toast`(hard-zero) · `SettingsFields.tsx:584`(copy-with-inline-confirm 선례)

## 맥락

토스트는 정책과 게이트 양쪽에서 금지돼 있다(`sonner|useToast|showToast|toast(` hard-zero). 그 결과 "복사됨"·"리마인더 설정됨"·"에이전트 연결됨"·"메시지를 #채널에 보냈습니다" 같은 **결과가 사라져도 되는 확인**이 갈 자리가 없고, 표면마다 임기응변(버튼 라벨 교체·배너·무반응)이 갈린다. UX-R3 팔레트·R5 상호작용·M0 기기 연결이 이 부류의 확인을 대량으로 만든다. Slack·buzz는 토스트(`sonner`)에 기댄다 — 우리는 금지를 유지하되 **대안 문법을 정본으로** 둬야 반복 이슈가 닫힌다.

## 결정

- **D1 금지 유지.** 토스트·스낵바 스택은 계속 금지(게이트 불변). 근거 불변: 메시지는 문제가 있는 자리에 산다, 스택은 읽기 전에 사라진다, 접근성 낭독이 위치와 분리된다.
- **D2 허용 3형(정본 컴포넌트).**
  - **① in-place confirm** — 행동을 일으킨 컨트롤 자체가 결과를 말한다: 라벨 교체(`복사` → `복사됨`) ≤ 1.6s 후 복귀, `--motion-instant`. `useInlineConfirm()` 훅 + `ConfirmLabel` 1개로 통일(`SettingsFields` 선례 승격).
  - **② 팔레트/컴포저 상태줄** — 명령 표면(⌘K·컴포저)에서 실행된 결과는 그 표면 하단 **상태줄 한 줄**에 `role=status`로 3s 표시 후 소거(표면이 닫히면 함께 소거). 위치가 고정이라 낭독·시선이 분리되지 않는다.
  - **③ 지속 카드** — 결과가 나중에 필요하면(리마인더 예약·기기 연결됨·에이전트 합류) 사라지는 확인이 아니라 **사이드바/인박스 카드**로 남긴다(리마인더 인박스 도킹·초안 패널 선례).
- **D3 결정 트리(리뷰·워커용).** "이 결과를 사용자가 나중에 다시 찾을 일이 있는가?" — 예 → ③ / 아니오 → "결과를 일으킨 컨트롤이 화면에 보이는가?" — 예 → ① / 아니오(명령 표면·단축키·컨텍스트 메뉴) → ②. 오류는 이 트리 밖 — 현행 `InlineBanner`(문제 자리, 다음 행동 포함).
- **D4 접근성.** ①은 컨트롤의 `aria-live="polite"` 라벨 변화로 낭독, ②는 `role="status"` 고정 영역, ③은 카드 도착 시 1회 낭독. 낭독 문장은 결과+대상("#일반에 보냈습니다"), 감탄·이모지 금지(preflight `hype`).
- **D5 시간.** ① 1.6s · ② 3s · ③ 무기한(사용자 해제). 모두 `--motion-instant`로 나타나고 `--motion-fast`로 사라진다(ADR-0179 D4 비대칭).
- **D6 강제.** preflight `toast` 유지 + 신규 `ephemeral` 검사: `setTimeout` 뒤 `hidden`/언마운트로 사라지는 확인 UI가 ①②③ 정본 컴포넌트를 거치지 않으면 위반. design-review 루브릭에 "확인 결과의 자리" 항목 추가.

## 기각 대안

- **제한 허용 토스트(하단 1개·비스택)**: "1개"는 곧 스택이 된다(buzz `sonner` 실측). 금지 완화는 하지 않는다.
- **전부 지속 카드**: "복사됨"까지 카드로 남기면 인박스가 로그가 된다. ③은 "다시 찾을 일"에 한정.
- **무확인(조용히 성공)**: 클립보드·예약 같은 비가시 결과는 확인 없이는 실패와 구분되지 않는다. 기각.

## 영향·게이트

- 신규: `src/design/ui/inlineConfirm.ts`(훅+라벨), 팔레트·컴포저 상태줄 컴포넌트 1(UX-R3a와 함께), preflight `ephemeral`. 기존 `SettingsFields` copy-confirm은 정본 훅으로 이관.
- 소비 예정: 복사(메시지 링크·자격·QR URI)·리마인더 설정·상태 설정·기기 연결·에이전트 합류·팔레트 명령 전반.
- 게이트: 세 형 각각의 낭독 시험(aria-live·role=status) + 소거 타이밍 시험 + preflight hard-zero.
