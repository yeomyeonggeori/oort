# MOMO-499 핸드오프: IOS-9 메시지 상호작용 — 롱프레스·반응 (모바일 플랜 Phase B)

> 발급: 2026-07-21 Fable (성재 위임). 정본: docs/planning/handoffs/2026-07-20-ios-v1-mobile-plan.md §MOMO-499.
> 트랙: UXUI · base = **track/uxui**(543 타임라인 v2가 이미 랜딩된 베이스 — main 아님 주의) · PR base = track/uxui · 도메인 = clients/iOS (MomoiOSKit 우선)

## 목표
iOS 타임라인에서 메시지 롱프레스 상호작용을 연다 — Discord/Slack 모바일 문법. 엔진 X-2/X-5(반응·수정·삭제 REST + realtime 4종)는 전부 main에 있고 Core 계약(RealtimeReplayController 비순서 이벤트 분기)도 기완비 — **소비만**.

## 구현 범위
1. **롱프레스 컨텍스트 시트**: 메시지 행 롱프레스 → 시스템 시트(UIKit/SwiftUI 표준, 커스텀 오버레이 금지). 항목: 반응(최근 이모지 행 + 피커), 답글(기존 스레드/답장 경로 재사용), 수정(작성자 본인만), 삭제(작성자 본인만·확인 다이얼로그), 복사.
2. **반응 REST 왕복**: `POST/DELETE .../messages/{id}/reactions`(X-2 계약, openapi.yaml 참조). 낙관적 UI 금지 — 서버 확정 후 반영(기존 mute/read 패턴과 동일한 in-flight 가드).
3. **reaction pill 행**: 메시지 아래 반응 집계 pill(이모지+카운트, 내 반응 강조), 탭 토글. 543이 만든 그룹핑 레이아웃 보존 — pill은 그룹 마지막 행이 아니라 **해당 메시지**에 귀속.
4. **realtime 소비**: `reaction.added/removed`·`message.edited/deleted` 4종을 기존 reducer로 실시간 반영 + 재시작(cold load) 복원은 543의 state/editedAtMs/deletedAtMs 경로 재사용.
5. **fail-closed**: 비확정 seq(전송 중) 메시지는 컨텍스트 메뉴 미노출 — macOS A-9 규칙 동일.

## 수용 기준
- MomoiOSKit 테스트: 시트 노출 조건(작성자/타인/전송중), 반응 토글 왕복, realtime 4종 reducer, 수정/삭제 흐름. 기존 41 tests 회귀 0.
- 시뮬레이터 빌드/스냅샷/실기기 왕복(맥에서 반응→폰 반영 = C-4 모바일판)은 오케스트레이터/성재 게이트 — worker 범위 아님.
- 한국어/영어 카피 병기(verb-first, em-dash 금지).

## 규율
- 커밋 자주, PR 생성 후 멈춤, merge/close 금지. xcodebuild/시뮬레이터 실행 금지(컴파일 확증=오케스트레이터, Swift 6 sending/Sendable 오류 전례 있음 — 문법 수준까지만 자체 확인).
- ConversationViews.swift는 핫파일 — 이 goal 단독 점유(다른 iOS goal과 병렬 금지 규칙 준수됨). Core 계약은 가산 소비만, 수정 필요 시 STATUS에 역요청.
