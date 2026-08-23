# U-8(#1699) 컴포저 하단 메타 2행 통합 패킷

> Status: `ready` · Planner: Fable · Integrator: momo-main · 트랙=uxui(base=track/uxui 5679f6c8) · 워커=sol · 검수=Fable+design-review

## 계약 (이슈 #1699 본문이 정본)
- 힌트 행("Enter로 보내기 · Shift+Enter로 줄바꿈", wide-only)과 상시 예약 타이핑 라인 행을 **한 행으로 공유**: 기본=힌트, 작성 중이면 같은 행이 타이핑 라인으로 스왑. 행 자체는 항상 존재(H-2 "흔들리지 않는다" 유지) → 빈 채널 컴포저 하단 26px 영구 회수.
- `clients/web/src/features/chat/TypingLine.tsx` 헤더 주석의 배치 논지(작업 중 줄과의 인접 대조·이름 색 축·6초 TTL)를 새 배치로 재서술 — 주석이 코드와 다른 말을 하면 안 된다.
- AgentActivityBar("작업 중")와의 인접성 유지. 스왑 시 aria-live 이중 발화 금지(타이핑 라인의 기존 낭독 계약 유지, 힌트는 장식이라 낭독 불요).
- 폰(<600px)은 힌트 행이 원래 없음 — 폰 타이핑 라인 배치 비접촉 확인만.

## AC
- 빈 채널 컴포저 하단 밴드 실측 26px 감소(테스트 또는 계산 근거).
- 타이핑 시작/종료에 레이아웃 시프트 0(행 높이 불변 단정).
- 기존 타이핑 라인 테스트 전부 그린 + 스왑 전이 테스트 신규.
- tsc·web 테스트·design_preflight_web 그린. worker는 PR(base=track/uxui) 후 정지.
