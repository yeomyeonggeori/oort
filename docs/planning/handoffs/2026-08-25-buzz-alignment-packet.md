# buzz 정합 파도 패킷 — UX-D·HD·TC 시리즈

> Status: `ready` (성재 직접 발제 2026-08-25 오전 — 스크린샷 16장 일괄 검수 피드백) · Planner owner: Fable · Integrator: momo-main
> 레퍼런스 증거 정본: `claudedocs/buzz-feedback-20260825/` (27~41 번호 = 발제 이미지 순번)
> 워커: codex(grok 402 소진 중) · 병렬 2(uxui 1 + engine 1) · UI 티켓은 독립 design-review Blocker 0 필수
> ADR: **ADR-0172**(lucide 아이콘, Accepted — 성재 지시 자체가 결정) · TC-2는 ADR 선행 미착수

## 티켓·순서

| 순번 | 티켓 | 트랙 | 요지 |
|---|---|---|---|
| 1 | **UX-D2 #1753** | uxui | 스레드 루트 아래 보더 제거 · 스레드 첫 메시지 호버 툴바 깨짐 버그 · cmd+K 입력 보더 제거 |
| 1' | **HD-1 #1757** | engine (병렬) | 허들 서버 복원 — server-rust REST 4종 포팅(참조: `server/Sources/MomoServer/Routes/HuddleRoutes.swift`·`Huddles/`) + LiveKit compose 배선. 스키마 016·046 재사용 |
| 2 | **UX-D1 #1754** | uxui | lucide-react 전환 전 표면 스윕 (ADR-0172 집행 + 디자인 시스템 아이콘 절 개정) |
| 3 | **UX-D3 #1755** | uxui | ⋯ 더보기 메뉴 보강(buzz 27 참고 — 기능 실존 항목만, Remind/Report는 적립) |
| 4 | **UX-D4 #1756** | uxui | 사이드바 개편 — 프로필 카드(36)·상태 조절(37, ADR-0160 기배선 UI화)·패널 접기 상단 이동(34·35·38)·채널 호버 액션+섹션 접기(39·40) |
| 5 | **TC-1 #1758** | uxui | 채널 하단 터미널 패널 buzz형(33) — T1~T3 작업 세션 기반 UI 재배치 |
| — | **TC-2 #1759** | 기획 적립 | 작업 콘솔 팀 트래킹+원격 조작 — 보안/권한 ADR 선행, 성재 기획 세션 트리거 대기 |
| — | **#850** | uxui (HD-1 후행) | 웹 허들 UI — HD-1 랜딩+승격 선행 조건 명시 코멘트 완료 |

## 공통 계약

- UX-HT/UX-CB 리뷰 9회전 교훈 준수: 새 진입점은 capture 레인이 실제로 누른다 · 호버 노출=조건부 렌더+탭스톱 규율 · 포커스 핸드오프는 키보드 모달리티만 · 무선언 가로 스크롤 금지 · 새 그릇 §2.2 산술 · popover는 실제 트리거 앵커.
- 기능 발명 금지 — buzz 참고는 "우리에게 실존하는 기능의 표면"에 한정, 부재 기능은 적립 명시.
- codex 샌드박스 제약: 브라우저 게이트(capture·gate-*)·docker(PG 게이트)는 오케스트레이터 대행.
- 머지: 각 티켓 diff 재판정 → (UI면) 독립 design-review Blocker 0 → track 머지 순차. main 승격은 성재 게이트.

## 근거·경위

- 허들 실체(2026-08-25 실측): 스키마 생존 · Rust 서버 미포팅 · 현행 compose LiveKit 부재 · 웹 UI 0건 — #850의 "서버 완비" 전제는 Swift 시대 기록.
- 상태 조절: ADR-0160(프레즌스 6b) 선언상태가 서버 기배선 — D4는 UI 노출만.
- 아이콘: ADR-0172. 이모지 "무라이브러리"(#1688)와 별개 축임을 ADR에 성문.
