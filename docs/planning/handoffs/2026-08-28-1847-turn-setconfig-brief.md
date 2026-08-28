# 워커 브리프 — #1847 허들 TURN 리라이트 셰임의 setConfiguration 경로 커버 (uxui)

> 워커: cursor-agent grok-4.6-high-fast · 병렬 1 · base=origin/track/uxui
> 정지 조건: 라이브 리그 DB 비접촉(이 티켓은 DB 불요). 머지·이슈 close 금지(오케스트레이터 몫).

## 실측 근거 (2026-08-28 종합 테스트, v0.1.3 실배포 Funnel VM, 외부 크롬 계측)
- livekit-client는 RTCPeerConnection을 **빈 iceServers로 생성**한 뒤 `pc.setConfiguration({iceServers: [...]})`로 JoinResponse ICE를 주입한다.
- #1825의 세션 스코프 셰임은 **생성자 config만** 리라이트 → 실환경에서 미발동, 최종 설정에 `turns:<host>:443` 잔존 → ICE 실패·허들 드롭.
- 페이지에서 setConfiguration 경로에 같은 리라이트를 임시 패치하자 최종 설정에 8443이 실리고 TURN 할당 성공 — 수리 방향 검증됨.

## 수리 계약
1. `huddleTurnRewrite`의 기존 리라이트 함수·게이트 조건(시그널 host 동일성 등)을 **그대로 재사용**한다 — 판정 로직 신설 금지.
2. 세션 스코프 셰임 설치 시 **`RTCPeerConnection.prototype.setConfiguration` 인터셉트를 추가**한다:
   - 설치·복원 시점은 #1826 재검수 폐곡선 계약 유지 — connect 직전 설치, **세션 종료(disconnect·connect 실패 catch)에 복원**, idempotent.
   - 생성자 경로 리라이트는 유지(livekit-client 버전에 따라 주입 경로가 갈릴 수 있음 — 이중 커버가 계약).
   - 인터셉트는 iceServers가 있는 호출만 변환하고 나머지 인자·반환은 투명 전달.
3. Cloud/직결 배치 무발동 불변(게이트 조건 재사용으로 자동 보장). 새 플래그 0.

## red proof (선행 커밋)
- 빈 ctor config로 PC 생성 → `setConfiguration`으로 `turns:<host>:443` 주입 → `getConfiguration()`에 8443 실림.
- 세션 종료 후 prototype 원복 확인(이후 setConfiguration 호출은 무변환).
- 비-셀프호스트(host 불일치·Cloud URL) setConfiguration 무발동 회귀.
- 기존 생성자 경로 테스트 전부 그린 유지.

## 완료 절차
vitest 등 해당 게이트 자가 실행 → 커밋(#1847 참조) → push → PR(base=track/uxui, 본문에 red proof 결과) → 정지. 마지막 출력에 PR URL과 변경 요약.
