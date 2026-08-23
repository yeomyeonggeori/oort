# ADR-0168: 모바일 사진·파일 picker 네이티브 의존성 — Expo 모듈 낱개 연장

- Status: **Accepted** (2026-08-23 성재 승인 — "다 승인할게" 위임 집행, 기록=Fable/momo-main. 기안 같은 날 — M-2 발사 선행 조건 충족)
- 관련: ADR-0137 D1(스택=bare RN+**Expo 모듈 낱개**·EAS 미도입 — 본 ADR은 그 정책의 첫 "새 네이티브 권한 표면" 적용), ADR-0120(푸시 NSE — 서명 표면 비접촉 확인 대상), UXUI 완성도 파도 계획 `docs/planning/research/2026-08-23-uxui-completeness-wave-plan.md` §2 M-2
- 실측 근거: 2026-08-23 재연 QA — D8 셀프호스트에서 첨부 업로드가 `no-archive`(파일 보관소 미연결)로 막히는 것 실측(`claudedocs/uxui-qa-d8-20260823/`). picker는 클라 표면이고 보관소는 서버 배포 구성이므로 **분리 결정**임을 여기 명시한다.

## Context

1. M-1(#1681)이 폰 첨부 **표시**면(P0 유실 복구)을 랜딩했고, 전송면(사진·파일 고르기→업로드)은 M-2로 남아 있다. 갭 감사 판정은 P0-②.
2. picker는 순수 JS로 불가능한 첫 표면이다 — 사진 라이브러리/카메라/문서 제공자는 네이티브 모듈이 필요하고, iOS 권한 문자열(Info.plist)이 앱 심사 표면에 늘어난다. ADR-0137 D1은 "Expo 모듈 낱개"를 문법으로 정했지만, **새 네이티브 의존성 + 새 권한 표면**은 자동 승인이 아니라 결정 기록 대상이다(파도 계획이 ADR 선행을 명시).
3. 현행 `clients/mobile`은 이미 Expo 모듈 낱개 4종을 소비 중이다(`expo-clipboard`·`expo-file-system`(M-1 hoist)·`expo-notifications`+`expo` 코어, Expo 57/RN 0.86.2/New Arch). autolinking 경로가 살아 있고 fastlane/match 서명 체계는 그대로다.
4. 업로드 경로는 서버 계약 비접촉이다 — web과 같은 `/v1` 첨부 REST를 소비한다(단일 쓰기경로 불변). 100MB 상한·실패 사유 카피(`packages/momo-core` attachments model: too-large/forbidden/no-archive/…)는 코어에 이미 있고 폰이 재사용한다.

## Options

1. **`expo-image-picker` + `expo-document-picker` (Expo 모듈 낱개 2종)** — **채택.**
   - D1 문법 그대로: 이미 쓰는 Expo SDK 계열이라 버전 정합(57.x)·autolinking·New Arch 지원이 검증된 경로. iOS는 PHPicker 기반이라 **사진 선택만으로는 권한 프롬프트가 없다**(out-of-process picker — limited-library 상호작용 최소화). 카메라 촬영·저장에만 권한 문자열이 필요하다.
   - bare 유지: config plugin 없이 `ios/` Info.plist에 `NSCameraUsageDescription`·`NSPhotoLibraryAddUsageDescription`(필요 시 `NSPhotoLibraryUsageDescription`)을 수기 추가 — D1의 "iOS는 손으로 유지"와 일치. NSE·App Group·entitlement 비접촉.
2. 커뮤니티 페어(`react-native-image-picker` + `@react-native-documents/picker`) — 기각. 기능 동등하나 Expo 계열 밖 유지보수 축이 둘 늘고, 이미 Expo 낱개 4종을 쓰는 레포에서 문법 혼종이 된다.
3. 네이티브 직결(PHPickerViewController 수기 브리지) — 기각. NitroModule/TurboModule 수기 브리지는 M-2 폭(게이트 2)을 넘고, Android 신설 시 이중 구현이 된다.

## Decision (요청)

- `clients/mobile`에 `expo-image-picker`·`expo-document-picker`(Expo 57 정합 버전) 추가를 승인한다. 권한 문자열은 위 목록으로 한정하고, 카피는 ux-bible 문법(용도를 사람 말로)으로 작성한다.
- 업로드는 기존 첨부 REST 소비만 — 서버·스키마 변경 0. 실패 4상태(선택 취소/권한 거부/초과/보관소 미연결)는 momo-core 카피를 재사용해 인라인 표시.
- 수용 게이트(M-2 티켓): 사진 1장·파일 1개 왕복 + 권한 거부 상태 렌더 + design-review Blocker 0.

## Consequences

- Info.plist diff가 앱 심사 표면에 노출된다(카메라·사진 추가 저장). TestFlight 재빌드 1회 필요.
- 셀프호스트 배포에서 파일 보관소 미연결(`no-archive`)이면 picker가 열려도 전송이 막힌다 — **서버측 보관소 구성은 별도 전선**(D8 실측 티켓 참조)이며 M-2 범위 밖.
