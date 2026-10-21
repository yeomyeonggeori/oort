# ADR-0168: 모바일 사진·파일 picker 네이티브 의존성 — Expo 모듈 낱개 연장

- Status: **Accepted** (2026-08-23 성재 승인 — "다 승인할게" 위임 집행, 기록=Fable/momo-main. 기안 같은 날 — M-2 발사 선행 조건 충족. 증보 1 2026-10-21: 앱 안 최근 사진 그리드와 사진 보관함 읽기 권한(`expo-media-library`), 성재 결재 원문은 증보 절에 인용)
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

## 증보 1 — 앱 안 최근 사진 그리드: `expo-media-library` 추가와 사진 보관함 읽기 권한 (2026-10-21)

- Status: **Accepted** (2026-10-21 성재 결재, AskUserQuestion 원문 인용은 아래)
- 발단·결재 인용(2026-10-21, #4181):
  - 요청: 「모바일에서의 첨부관련해서 oort와 버즈의 UI를 첨부했어. 뭔가 펼쳐지는 애니메이션이나 확장되는 애니메이션, 커스텀 UI같은 디테일 부분을 한번 버즈 레퍼런스를 확인해서 작업해봐도 좋을 거 같아.」
  - 결정(AskUserQuestion): 「그리드 + 권한 (Recommended)」 — 앱 안 최근 사진 그리드, 처음 한 번 사진 접근 권한을 묻고, 거부·일부 허용이면 시스템 사진 창으로 이어져요. expo-media-library 추가와 ADR-0168 증보 포함.
- 본문과의 관계: 본문 결정(PHPicker 기반 `expo-image-picker`로 사진을 고르고 그 경로에는 권한 프롬프트가 없다)은 **그대로 유효하다.** 그 경로(`pickPhoto`)는 카드의 「전체 사진」으로 남는다. 이 증보는 그 옆에 **사진 보관함을 읽는 두 번째 경로**를 더한다. 본문 Context 2의 「새 네이티브 의존성 + 새 권한 표면은 결정 기록 대상」이 이 증보의 근거다.

### Options
1. 시스템 picker만 유지 — 기각. Buzz 레퍼런스(성재가 고른 IMG_4320·IMG_4321)의 앱 안 그리드 카드, 곧 메뉴가 카드로 변신하는 화면은 PHPicker로 만들 수 없다. PHPicker는 앱 화면 안에 그릴 수 없는 시스템 UI다.
2. **`expo-media-library`(Expo 모듈 낱개)** — **채택.** 같은 Expo 계열이라 ADR-0137 D1의 문법·버전 정합(57.x)·autolinking·New Architecture가 그대로고, `ph://` 주소를 RN `Image`가 그릴 수 있게 하는 이미지 로더(`MediaLibraryImageLoader`)를 함께 싣는다.
3. `@react-native-camera-roll/camera-roll` — 기각. 본문 Option 2와 같은 이유다(Expo 계열 밖 유지보수 축이 늘고 문법이 섞인다).
4. PhotoKit 수기 브리지 — 기각. 본문 Option 3과 같다.

### D1. 의존성
- `clients/mobile`에 `expo-media-library`를 `~57.0.3`으로 더한다. 이 범위는 Expo 57.0.9의 `bundledNativeModules.json`이 가리키는 값이다. `npm view expo-media-library versions`에서 57.x는 57.0.0~57.0.5이고 dist-tag `sdk-57`은 57.0.5이며, 잠금은 57.0.5로 풀린다(`58.x`는 SDK 58용이라 쓰지 않는다).
- 라이선스 MIT, 전이 의존 없음(peer `expo`·`react-native`만). CocoaPods `ExpoMediaLibrary` 한 포드가 늘고(`Podfile.lock` +7줄) 시스템 프레임워크 Photos·PhotosUI를 링크한다.
- NOTICE와 `legal/THIRD_PARTY_NOTICES.md`(「Phone client direct additions」)에 반영했고 `node scripts/check_npm_licenses.mjs --root clients/mobile`이 PASS다(1,092개 모두 허용 목록 안).

### D2. API는 `expo-media-library/legacy`다
- SDK 57에서 패키지 루트는 클래스 기반 새 API(`Query`·`Asset`)이고, 옛 함수 이름(`getAssetsAsync`·`getAssetInfoAsync`·`presentPermissionsPickerAsync` …)은 루트에서 부르면 **런타임에 던진다**(패키지 `legacyWarnings.ts`).
- 이 카드가 필요한 것은 커서 페이지(`after`)·자산별 로컬 파일·일부 허용 창이다. 옛 API가 각각 한 번의 호출로 주고, 새 API는 속성마다 비동기 호출이다. `./legacy`는 SDK 58에서도 제공된다(58.0.11 패키지의 `exports` 확인). 새 API로의 이행은 별도 일이다.
- 이 모듈에 닿는 파일은 `src/features/attachments/photosNative.ts` 하나이고 `projectShape.test.ts`가 그것과 `legacy` 진입점을 지킨다. 카드와 훅은 포트 인터페이스만 안다.

### D3. 권한은 카드를 연 사람이 「허용」을 누를 때만 묻는다
1. **선제 요청 금지.** 앱 시작·컴포저 마운트·첨부 메뉴 열기에서 사진 권한 API를 부르지 않는다. 상태 읽기도 0회다. 훅은 카드가 열려 있지 않으면 포트를 한 번도 부르지 않고, 시험이 진짜 네이티브 포트로 그 횟수를 센다.
2. 카드를 열면 **상태를 읽을 뿐**(프롬프트 없는 `getPermissionsAsync`) 요청하지 않는다. 시스템 프롬프트는 미결정 상태에서 사람이 카드 안의 「허용」을 눌렀을 때 한 번 뜬다. iOS는 한 번 거부한 앱에 다시 묻지 않으므로 거부 상태에는 「허용」을 세우지 않고 「설정 열기」만 세운다.
3. 네 상태는 카드 안에서 사람 말(해요체)로 갈린다: 미결정 → 설명 + 「허용」, 거부 → 설명 + 「설정 열기」 + 「전체 사진에서 고르기」, 일부 허용 → 허용된 사진 + 「사진 더 고르기」, 전체 허용 → 그리드.

### D4. 일부 허용(limited)은 정상 경로다
- 오류도 경고 막대도 아니다. 허용된 사진을 그대로 보여 주고 「사진 더 고르기」가 시스템 창(`presentPermissionsPickerAsync`)을 연다.
- 그 창에는 닫혔다는 신호가 없다. 대신 보관함 변경 이벤트(`addListener`, 허용 사진을 바꿀 때도 불린다)로 목록을 다시 읽는다. 설정 앱에서 돌아오면(앱이 다시 활성) 권한을 다시 읽는다.

### D5. 사진은 기기 밖으로 나가지 않는다 — 고른 것만 기존 첨부 업로드로
- 카드는 사진 보관함을 **읽기만** 한다. 쓰기·앨범·삭제 API는 부르지 않고, `projectShape.test.ts`가 앱 소스에서 그 이름이 나타나면 빨개진다.
- 서버로 가는 것은 사람이 고른 사진뿐이고 경로는 이미 있던 것이다: `ph://` 자산 → `getAssetInfoAsync`의 로컬 파일 → 앱 캐시 복사 → 기존 첨부 업로드(`PickedAttachmentFile` 계약 그대로). 서버·스키마·REST 변경 0, 새 네트워크 경로 0이다.
- 목록 썸네일은 `ph://`를 RN `Image`가 보관함에서 필요한 크기로만 읽는다. 원본은 고른 뒤에만 파일이 된다.

### D6. Info.plist — 읽기 문구 교체와 저장 키 신설
- `NSPhotoLibraryUsageDescription`을 카드가 서는 용도로 바꾼다(해요체, 「대화에 첨부할 최근 사진을 보여 주고 고르게 하려고 사진 보관함을 읽어요. 고른 사진만 올라가요.」). 이 문구는 「허용」을 눌렀을 때 뜨는 시스템 프롬프트에 그대로 실린다.
- **「읽기만」의 뜻.** PhotoKit에는 읽기 전용 접근 수준이 없다. 이 모듈은 `readWrite`로 묻는다. 쓰기 권한까지 얻지만 앱이 쓰는 일은 하지 않는다. 이 사실을 사람에게 숨기지 않으려고 위 D5의 가드를 둔다.
- `NSPhotoLibraryAddUsageDescription`을 신설한다(「oort는 사진을 보관함에 저장하지 않아요. 허용하지 않아도 모든 기능을 쓸 수 있어요.」). 모듈이 저장 API(`UIImageWriteToSavedPhotosAlbum`·`PHAssetCreationRequest` 등)를 바이너리에 링크하므로 키가 없으면 업로드가 ITMS-90683으로 반려될 수 있다. 마이크 키와 같은 사정이고 같은 처방이다(#2568). 사진을 저장하는 기능이 생기는 날 이 문구가 거짓이 되며, 가드가 그 시점을 알린다.

### D7. 파일화
- HEIC·HEIF는 JPEG(품질 0.9, 기존 의존 `expo-image-manipulator`, ADR-0189 증보 2)로 바꿔 올리고, 그 밖의 형식은 형식·이름 그대로 앱 캐시로 복사해 올린다. 이름·MIME·크기는 기존 `PickedAttachmentFile` 계약이다.
- 근거: 아이폰 사진 대부분이 HEIC이고 웹(크롬)은 HEIC를 인라인으로 그리지 못한다. 기존 시스템 picker(`pickPhoto`)가 같은 사진을 어떤 형식으로 주는지는 PHPicker의 `automatic` 모드가 「시스템이 고른 최선」이라 실기기로 확인하기 전에는 단정하지 못한다(한계 절). 규칙은 `needsJpeg` 한 곳에 있어, 반대로 판명되면 그 함수 하나를 고친다.
- 보관함 안 파일을 업로드 시점까지 붙들지 않는다. `getAssetInfoAsync`가 돌려준 로컬 파일을 곧바로 앱 캐시로 복사하고 그 복사본을 올린다(OS가 용량이 모자라면 비우는 자리).
- iCloud에만 있는 사진은 기기 쪽을 먼저 묻고(`shouldDownloadFromNetwork: false`), 없다고 할 때만 「iCloud에서 내려받는 중이에요」를 말하며 내려받는다. 못 받으면 연결을 확인하라는 문장이 따로 선다.

### D8. 상한
- 고르는 순간 `MAX_ATTACHMENTS_PER_MESSAGE − 트레이 개수`로 건다. 기존 `addPickedFiles`가 일부라도 거절되면 던지므로(「rejected는 도달 불가 불변식」), 변환된 파일은 한 번의 호출로 넘기고 상한은 선택 단계에서 지킨다.

### 영향
- Info.plist diff가 앱 심사 표면에 노출된다(읽기 문구 교체 + 저장 키 신설). TestFlight 재빌드 1회.
- 사진 접근 프롬프트가 첨부 경로에 **처음** 생긴다(「허용」을 누를 때만). 기존 `pickPhoto`는 권한 없이 그대로 돈다.
- 새 직접 의존 1개(`expo-media-library`). 새 애니메이션 의존성은 없다(변신은 RN 내장 `Animated`).

### 한계와 미검증
- 일부 허용 상태는 시뮬레이터에서 만들 수 없다(`xcrun simctl privacy`는 허용·거부·초기화뿐). 그 상태의 화면은 포트 주입으로 그렸고, 실제 OS 흐름은 `runtime-unverified`다.
- 실기기 미확인(`runtime-unverified`): iCloud 내려받기, Live Photo(`getAssetInfoAsync`가 짝 영상 임시 파일을 함께 쓴다), 큰 HEIC의 JPEG 변환 시간·메모리, `getAssetInfoAsync`가 돌려준 보관함 안 파일을 앱이 읽을 수 있는 시간(그래서 곧바로 복사한다), PHPicker `automatic` 모드의 HEIC 처리와 이 경로의 형식 일치.
- 변환된 복사본은 앱 캐시에 남는다. 업로드가 끝나도 지우지 않는다(기존 picker 결과도 같다). OS가 비운다.
