# 워커 브리프 — BF-A3(#1886) 허들 마이크 디바이스 선택 + 게인 (uxui)

> 워커: grok build CLI grok-4.6 · base=origin/track/uxui (A2 랜딩 포함 최신)
> 정지 조건: 머지·이슈 close 금지. MCP 금지. 서버 무접촉.
> 참조: `~/projects/reference/buzz`(Apache-2.0) `desktop/src/features/huddle/lib/useAudioDevices.ts`(70줄 — enumerateDevices+devicechange) + `components/MicControls.tsx`(게인).

## 근거
- `clients/web/src/features/huddles/`에 디바이스 열거·선택·게인 코드 0건 — OS 기본 마이크 강제. "왜 웹캠 마이크로 잡히지"의 정답 부재.

## 구현 계약
1. **훅 신설**: `useAudioInputDevices` — `navigator.mediaDevices.enumerateDevices()`로 audioinput 목록, `devicechange` 구독으로 갱신, 권한 전(레이블 빈 문자열) 상태 구분. buzz 70줄 훅 문법 이식.
2. **선택 UI**: 허들 라이브 컨트롤(HuddleHeaderControl 라이브 상태)에 마이크 선택 진입 — 기존 컨트롤 그룹 문법(라운드 버튼 → DropdownMenu)으로 디바이스 라디오 목록. 선택 시 세션의 오디오 트랙을 해당 deviceId로 재발행(livekit-client의 트랙 교체 API — `createLocalAudioTrack({deviceId})` 후 republish 또는 `setDeviceId` 계열, 실코드 조사 후 정확한 경로 채택).
3. **게인**: 0~100% 슬라이더(같은 메뉴 안) — WebAudio GainNode 경유 또는 livekit 지원 API 조사 후 채택. 미지원 판정이면 게인은 범위 제외하고 사유를 PR 본문에 보고(디바이스 선택만 랜딩).
4. **기억**: 선택 deviceId를 localStorage(`momo.web.huddle.mic.v1`)에 저장, 다음 허들 참여 시 해당 디바이스로 시작(부재 시 기본 폴백 — 오류 없이).
5. **권한·상태 문장**: 권한 미허용이면 목록 대신 문장형 안내. 디바이스 0개(이론) 상태 처리.
6. 허들 기존 동작(참여·마이크 토글·Live 칩·나가기) 회귀 0. gate:huddle(390 라이브 축 포함) 그린.

## red proof (선행 커밋)
- 훅: 열거·devicechange 갱신·권한 전 상태(모킹).
- 선택 시 트랙 재발행 1회·저장·재참여 시 적용(모킹).
- 허들 게이트·기존 테스트 전부 그린.

## 완료 절차
web vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=7877 capture:design·SHELL_GATE_PORT=7879 SHELL_GATE_FOCUS_ONLY=1 gate:shell·gate:huddle 그린 실측 → 커밋(#1886) → git push -u origin feat/1886-bfa3-mic-devices → gh pr create --base track/uxui → 정지.
