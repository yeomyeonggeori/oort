# #1720(클라 항목) 패킷 — rowFocus 유닛 고정·바이트 예산·픽스처

> Status: `ready` · Planner: Fable · Integrator: momo-main · 트랙=uxui · 워커=sol · 검수=Fable
> 스코프: #1720의 1·3·4항만. 2항(읽기 fan-out 배치)은 서버 결정이라 **명시 비스코프**.

## 계약

1. **rowFocus jsdom 유닛**(#1719 리뷰 신규 Medium): `normalizeRow` 두 분기(구성원 0=행 자신이 정거장 / 구성원 有=primary 우선·focused 보존)와 신규 DOM 행동 둘 — MutationObserver 재정규화(늦게 마운트된 구성원이 -1로 정규화됨), focusout primary 복원(행 안 이동은 비리셋·행 이탈은 복원) — 을 기존 rowFocus.test 문법으로 고정. 캡처 레인 없이 계약이 살게.
2. **언퍼얼 이미지 캐시 바이트 예산**: useUnfurlImage의 개수 상한(48)을 바이트 축 병행 상한으로(초과 시 LRU 방출). 상수는 근거 주석과 함께 명명.
3. **캡처 픽스처 썸네일 실물화**: 1×1 검정 PNG → 실물 비율(예: 1200×630 OG 표준) 픽스처로 교체해 crop/종횡 거동이 프레임에 찍히게. 레인 재실행으로 프레임 갱신 확인.
4. (동승 1줄) `clients/mobile/src/features/conversation/TypingBar.tsx`의 웹 구 헤딩 인용을 현행 헤딩("공유 행은 항상 26px을 예약한다")으로 — U-8 리뷰 Nit, 폰 접촉이 생긴 김에.

## AC
- 신규 유닛 전부 그린+기존 스위트 그린+tsc. 3항은 `npm run capture:design` 완주(exit 0) 증거. worker는 PR(base=track/uxui) 후 정지.
