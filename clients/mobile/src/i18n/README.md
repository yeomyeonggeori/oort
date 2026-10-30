# Phone locale adapter — #4833 / ADR-0213 §3·§5·§9

## Intl 초기화와 Apple Hermes 사실

잠긴 엔진은 `hermes-v250829098.0.16`(upstream `90f23852efcd361315688e2904d2446707fa274c`)이다. 이
엔진에는 `Locale`·`PluralRules`·`RelativeTimeFormat`이 없고, `getCanonicalLocales`·`DateTimeFormat`
(+`formatToParts`)·`Collator`·`NumberFormat.format`은 Apple Foundation 위에 구현돼 있다. 시작 검사는
ko/en 네이티브 기능을 확인한 뒤 Locale → PluralRules → RelativeTimeFormat 순서로 각각 **측정이 실패한
것만** FormatJS polyfill로 채우고, 끝에 셋을 다시 측정한다. 실패하면 서비스/앱을 열지 않고 영어
`SAFE_MESSAGE`와 `mobile-intl-initialization-failed`를 보여 준다.

**`NumberFormat.prototype.formatToParts`는 Apple Hermes에 등록되지 않는다.**
[`lib/VM/JSLib/Intl.cpp` L1289-L1297](https://github.com/facebook/hermes/blob/90f23852efcd361315688e2904d2446707fa274c/lib/VM/JSLib/Intl.cpp#L1289-L1297)은
이 메서드를 `#ifndef __APPLE__` 안에서만 등록한다.
[Apple C++ 구현](https://github.com/facebook/hermes/blob/90f23852efcd361315688e2904d2446707fa274c/lib/Platform/Intl/PlatformIntlApple.mm#L2637)의
`llvm_unreachable`은 JS에서 닿지 않는다. 잠긴 엔진을 실제로 실행해도
`Object.getOwnPropertyNames(Intl.NumberFormat.prototype)`은 `constructor, format, resolvedOptions`뿐이고
`typeof Intl.NumberFormat.prototype.formatToParts`는 `undefined`다(아래 실행 결과).
`@formatjs/intl-relativetimeformat@12.3.16`의 `PartitionRelativeTimePattern`
(`node_modules/@formatjs/intl-relativetimeformat/index.js`, `typeof numberFormat.formatToParts ===
"function"` 분기)은 그 메서드가 함수일 때만 쓰고 아니면 `numberFormat.format()`을 쓴다.
그래서 RTF polyfill은 NumberFormat polyfill 없이 잠긴 엔진에서 동작하고, `@formatjs/intl-numberformat`은
**추가하지 않았다**(수용기준의 「필요한 polyfill만」, 「엔진에 쓸 수 있는 구현이 있으면 넣지 않는다」).
앱·코어·`intl-messageformat`은 `NumberFormat.formatToParts`를 호출하지 않는다(`@formatjs/intl`의
`formatNumberToParts`는 쓰지 않는다). 새 NumberFormat 의존이 생기면 이 사실을 다시 확인한다.

「등록됨」이 아니라 「실제로 동작함」을 재는 방식은 이렇다. RTF 검사는 `RELATIVE_CASES`의 CLDR 문구
(en `in 1 day`·`in 2 days`·`yesterday`, ko `1일 후`·`2일 후`·`어제`)를 글자 그대로 비교한다. 엔진이
`formatToParts`를 등록했다면 RTF polyfill 경로에서 이 검사가 그 메서드를 실제로 호출한다. 등록은 됐지만 동작하지 않으면
`intl-polyfill-initialization-failed`로 닫힌다(시험으로 고정). 엔진을 올릴 때는 아래 probe를 다시 실행한다.

## 설치 단위와 화면

- `MobileLocaleProvider`는 계정/워크스페이스 및 세션 부팅 위에 있다. Intl 검사 →
  ko/en 사전 준비 → MMKV 복원 → 코어 locale 서비스 → 앱 렌더 순이다.
- 전용 MMKV `oort.mobile.preferences`의 `oort.mobile.locale.v1`에 `system` 또는
  지원 ID만 저장한다. 인증 저장소·계정 키를 쓰지 않으며 로그아웃은 건드리지 않는다.
  성공적으로 쓴 뒤에만 새 서비스와 컨텍스트를 함께 공개한다.
- `Settings.watchKeys`는 iOS `AppleLanguages`·지역·12/24시간 설정을 관찰한다.
  AppState `active`에도 기기 정보를 다시 읽는다. 명시 선택은 유지하면서 지역·시간대를
  갱신한다. 사전이 없는 OS 언어는 그 지역을 보존한 영어로 표시한다.
- 설정 › 프로필 › 언어는 기존 ListRow/ChoiceRow/페이지 스택을 쓴다. 기기 언어가
  첫 행이고, 출시한 ko/en만 자칭 표기와 베타로 보인다. 공용 부분 지원 안내를 유지한다.
  선택은 다른 계정 트리를 다시 마운트하지 않는다. 큰 글자를 제한하는 행 높이·줄 수를
  추가하지 않았고 자칭 행은 자기 언어로 VoiceOver를 지정한다.
- 빈 저장값은 system 선택, 사전 로딩은 앱 진입 전 로더, 쓰는 중은 행 잠금/진행 표시,
  저장 오류는 기존 언어를 유지한 인라인 재시도다. 두 사전은 Metro에 포함하므로
  오프라인 전환에 네트워크가 필요하지 않다. 키보드 입력은 없다. 뒤로/가장자리 밀기와
  VoiceOver escape·동작 줄이기는 기존 페이지 부품을 따른다.

## 출하 설정과 플랫폼 문구

Metro는 워크스페이스 `node_modules`를 watch한다. Babel의 출하 static-block 변환은
`intl-messageformat`과 static block이 있는 세 polyfill 패키지에만 적용한다.
#4835의 `env.test` 설정은 유지했다. 런타임 조건 로드는 코드 분할을 뜻하지 않는다.
Metro release에는 조건문이 참일 때 필요한 코드와 ko/en 데이터가 모두 패키지된다.
Locale polyfill의 내장 canonicalization/likely-subtag 표는 upstream 그대로다.

기존 Info.plist 권한 이유 여섯 개를 `mobile.ios.*`에서 ko/en InfoPlist.strings로
생성한다. 개발 언어 en, Xcode knownRegions en/ko/Base, PBXVariantGroup 및 앱 Resources를
맞췄다. OS 권한창은 iOS가 고른 언어이며 앱 내 변경의 즉시 반영을 보장하지 않는다.
이 한계도 `mobile.locale.permissionNotice`로 설정에 보인다.

```sh
npm --prefix packages/momo-core run i18n:generate
node clients/mobile/scripts/generate-info-plist-strings.mjs
node clients/mobile/scripts/generate-info-plist-strings.mjs --check
node clients/mobile/scripts/generate-intl-notices.mjs
node clients/mobile/scripts/generate-intl-notices.mjs --check
```

Intl 추가분 고지 묶음은 `legal/generated/MOBILE_INTL_NOTICES.txt`다. 코어 NOTICE와
폰 polyfill 의존 closure의 전체 upstream 라이선스를 포함하며 폰 재배포 때 동봉한다.
전체 React Native/CocoaPods 고지 묶음을 대체하지 않는다.

## Hermes probe — 잠긴 엔진에서 실행한 결과

probe 진입점은 `clients/mobile/scripts/hermes-intl-probe.js`다. 아래 명령은 같은 출하 Metro 설정으로
전용 JS/HBC를 만들고 compiler 버전을 검사한다(경로는 stdout JSON의 `output`).
**컴파일은 VM 실행이 아니므로** 이 번들을 잠긴 엔진에서 따로 평가해 `globalThis.__oortIntlProbe`를 본다.

```sh
node clients/mobile/scripts/verify-intl-bundle.mjs --probe
```

**실행 기록(2026-10-30, `Build: Release`, `OSS Release Version: 250829098.0.16`, Bytecode 98).**
`node_modules`에는 컴파일러 `hermesc`뿐이고(`-exec` 미지원) VM이 없다. 그래서 `pod install`이
`hermes-engine.podspec`/`hermes-utils.rb`로 내려받는 같은 Maven 산출물
`https://repo1.maven.org/maven2/com/facebook/hermes/hermes-ios/250829098.0.16/hermes-ios-250829098.0.16-hermes-ios-release.tar.gz`
(SHA1 `8889394f46764d163e8acb48d7d6d81fea07d6c3`, Maven `.sha1`과 일치)를 빈 폴더에 풀고,
`destroot/Library/Frameworks/macosx/hermesvm.framework`를 `evaluateJavaScript`와 `console.log`만 가진
JSI 프로그램에 링크해 `shipping.bundle`(JS)과 `hermesc -O -emit-binary`로 만든 `shipping.hbc`를
각각 실행했다. 두 출력은 바이트 단위로 같고 `diagnostic`은 없다. 이것은 macOS slice다: iOS와 같은
`__APPLE__` 등록·`PlatformIntlApple.mm` 경로라 API 표면과 초기화는 확인되지만, 통화 기호·날짜 문구는
Foundation 버전에 따라 다를 수 있고 iOS 시뮬레이터/기기 실행은 planner 스택 검증 몫이다.

| 항목 | ko-KR | en-US |
|---|---|---|
| 네이티브(polyfill 전) | Locale·PluralRules·RelativeTimeFormat **없음**, DateTimeFormat·NumberFormat·Collator 있음(일곱 언어 모두) | 같음 |
| `NumberFormat.prototype` | `constructor, format, resolvedOptions` (`formatToParts` 없음, 초기화 뒤에도 없음) | 같음 |
| cardinal 0/1/2/1.5/1,000,000 | other ×5 | other, one, other, other, other |
| ordinal 같은 순서 | other ×5 | other, one, two, other, other |
| `12345.67` | 12,345.67 | 12,345.67 |
| USD / JPY / KRW | US$12,345.67 / JP¥12,346 / ₩12,346 (소수 2/0/0) | $12,345.67 / ¥12,346 / ₩12,346 (소수 2/0/0) |
| 상대 −1/0/1/2/12345.67일 | 어제, 오늘, 내일, 모레, 12,345.67일 후 | yesterday, today, tomorrow, in 2 days, in 12,345.67 days |
| 정렬(NFC, 동률은 ID) | 가 日 中 é(a) é(b) item2 item10 | é(a) é(b) item2 item10 가 中 日 |

ko·en 각각 네 UTC 경계 × UTC/Asia/Seoul/America/New_York = 12값, 모두 24값이 아래 시각 표와 같다(ko는
`2026. 03. 08. 06:59:59`, en은 `03/08/2026, 06:59:59` 형식으로 나온다). 뉴욕은 03-08에 01:59:59 다음
03:00:00으로 건너뛰고, 11-01에는 01:59:59(EDT) 다음 01:00:00(EST)으로 되돌아간다.

probe는 polyfill 전 일곱 언어의 API 지원 여부, 실행 엔진 속성, 초기화 후 ko/en의
plural·날짜·숫자·통화·상대 시각·CJK/악센트/숫자 표시 정렬을 출력한다. ja·zh·es·fr의
locale-data는 로드하지 않는다. 아래 CLDR cardinal 표에서 실행한 것은 ko·en 행뿐이고
ja·zh·es·fr 행은 P2 데이터가 준비된 뒤의 기대값이다.

| 언어 | 0 | 1 | 2 | 1.5 | 1,000,000 |
|---|---|---|---|---|---|
| ko / ja / zh-Hans / zh-Hant | other | other | other | other | other |
| en | other | one | other | other | other |
| es-419 (P2) | other | one | other | other | many |
| fr (P2) | one | one | other | one | many |

영어 ordinal은 같은 입력 순서로 other/one/two/other/other, 한국어 ordinal은 모두
other다. 숫자는 `12,345.67`, 통화는 서버가 준 USD/JPY/KRW 각각을 보존한다. 기본 소수
자릿수는 USD 2, JPY·KRW 0(12,346 반올림)이다. 통화 기호·공백과 CJK 정렬 순서는
OS 차이를 출력 그대로 기록하되 악센트/NFC 동률은 ID로 안정화하고 item2는 item10보다
앞선다. 상대 시각은 -1/0/1일의 어제/오늘/내일 및 yesterday/today/tomorrow를 포함한다.

| UTC 입력 | UTC 시각 | Asia/Seoul 시각 | America/New_York 시각 |
|---|---|---|---|
| 2026-03-08T06:59:59Z | 03-08 06:59:59 | 03-08 15:59:59 | 03-08 01:59:59 |
| 2026-03-08T07:00:00Z | 03-08 07:00:00 | 03-08 16:00:00 | 03-08 03:00:00 |
| 2026-11-01T05:59:59Z | 11-01 05:59:59 | 11-01 14:59:59 | 11-01 01:59:59 |
| 2026-11-01T06:00:00Z | 11-01 06:00:00 | 11-01 15:00:00 | 11-01 01:00:00 |

## Release 크기 재현

코어 README의 `measure-bundles.mjs mobile`과 같은 Metro release
`dev=false,minify=true`·gzip level 9·Hermes `-O -emit-binary` 방식이다.
`verify-intl-bundle.mjs`는 출하 설정을 그대로 쓰며, 방출된 모든 FormatJS 모듈의
의존 대상이 실제 방출 집합에 있는지 검사해 null dependency를 거부한다. 생성 도구·TS
컴파일러와 ko/en 이외 locale-data도 거부한다.

```sh
node packages/momo-core/src/i18n/tooling/measure-bundles.mjs mobile
node clients/mobile/scripts/verify-intl-bundle.mjs --baseline-ref c3edf8461f11dc67a12d80d8157d492cd9eb6cd9
node clients/mobile/scripts/verify-intl-bundle.mjs
```

기준/도입 뒤는 같은 현재 설정·의존성으로 잰다. 기준에서만 App.tsx·
SettingsPage.tsx·sheetParts.tsx의 source를 위 고정 HEAD에서 읽어 임시 transformer에 전달한다.
제품 파일은 고치지 않으며 resolver/Babel 옵션은 두 단계에서 동일하다. 도입 뒤는
임시 transformer 없이 출하 entry 그대로다. 설치 가능한 앱 용량이나 실제 Hermes
runtime 검증을 뜻하지 않는다.

**최종 범위(Locale·PluralRules·RelativeTimeFormat 세 polyfill, NumberFormat polyfill 없음)**의
실측(위 HEAD + 이 작업 diff, Node 24.14.0·Metro 0.84.4·Hermes compiler 250829098.0.16):

| bytes | 기준 | 도입 뒤 | 차이 |
|---|---:|---:|---:|
| Metro iOS release JS | 3,856,835 | 4,291,936 | +435,101 |
| gzip level 9 | 1,022,885 | 1,156,029 | +133,144 |
| Hermes `-O -emit-binary` | 5,487,138 | 6,027,582 | +540,444 |

같은 입력으로 도입 뒤를 두 번 재도 세 크기가 같았다(HBC는 바이트 배치만 실행마다 다를 수 있다).
출하 그래프는 FormatJS 17모듈, PR/RTF 각각 en·ko 데이터 4파일, null 의존 0,
tooling/TypeScript 포함 0이다. core README 명령도 추가 옵션 없이 통과했다.
그 명령은 이미 도입된 제품에 retained probe를 더하는 비교라 +74 raw/+152 gzip/
+800 HBC이며, 기능 도입 차이는 위 source 기준 표다.

## 실행한 검증

- 폰/코어 `typecheck`, 변경 폰 20파일·코어 6파일 ESLint, core `i18n:check`·`gate:purity`·
  `gate:copy`, `git diff --check`: PASS.
- `node scripts/check_npm_licenses.mjs`: 세 npm root 1,853패키지 PASS(의존 변경 없음).
  권한/NOTICE 생성기 `--check`(폴리필 8패키지 + 코어), 세 iOS 리소스의 `plutil -lint`,
  `scripts/tests/test_pr_ci_guardrails.sh`: PASS.
- `npm --prefix clients/mobile test -- --watchman=false --runInBand __tests__/mobileLocale.test.tsx`:
  **14 PASS**. MMKV 복원·로그아웃 보존, 앱 복귀, 실제 RN settingsUpdated 관찰, 지원 밖/오프라인,
  원자적 전체 컨텍스트 전환과 마운트 보존, 저장 실패 재시도, 초기화 실패의 영어 안전 문구/진단,
  조건 로드와 공식 ko/en 데이터, 그리고 Intl 세 모양: ① 엔진이 working `formatToParts`를 등록(Node),
  ② Apple Hermes 모양(`formatToParts` 미등록 + `HermesInternal`)에서 실제 공식 polyfill이 초기화되어
  `in 2 days`·`3 weeks ago`·`내일`·`12,345.67일 후`를 내고, ③ 등록은 됐지만 던지는 `formatToParts`는
  호출된 채 `intl-polyfill-initialization-failed`로 닫힌다. 문구만 있는 반쪽 네이티브 RTF는 교체한다.
- 기존 설정 머리 전수에 언어 장을 추가했다. 해당 전수 8 PASS. 코어 catalog 시험은
  샘플 11키 상한 대신 비어 있지 않음·유일성·ko/en 집합 동등성을 계속 검사한다.
- 끝에 `npm --prefix clients/mobile test -- --watchman=false` 전체 1회: **258 suite 통과(skip 1) ·
  6,740 PASS · skip 5 · 실패 0**. retryRegistry의 중첩 Jest가 외부 Watchman 상태 폴더 권한에 걸리던
  것은 중첩 명령에도 `--watchman=false`를 넣어 해결했다. 전체 실행 끝의 「worker failed to exit
  gracefully」 경고는 `mobileLocale`을 뺀 전체에서도 나오는 기존 경고다. 코어는 이 마무리에서 다시
  건드리지 않아 앞선 전체 1회(275파일·6,755 PASS, 기존 todo 1)를 재사용한다.
- `node clients/mobile/scripts/sabotage-locale.mjs`: 변이마다 **원본으로 먼저 통과(control)** 를 확인하고
  임시 사본에서 실제 assertion RED를 확인한다. ① 복수형 조건 제거(`Expected number of calls: 0`), ②
  복귀 재평가 제거, ③ 지운 `HermesInternal` 차단을 되살림(Apple Hermes 모양 시험이 RED), ④ RTF 검사를
  「문구가 있기만 하면 통과」로 약화(반쪽 RTF 시험이 RED), ⑤ 종료 후 재측정에서 RTF 제거(등록됐으나
  동작 않는 `formatToParts` 시험이 RED). 원본은 변조하지 않았고 사본은 정리된다.
  권한/NOTICE·빌드·스택 게이트의 미실행분을 runtime PASS로 세지 않는다.

## 스택 검증 메모

바뀐 화면은 설정 › 프로필 언어 행/언어 페이지와 Intl 부팅 실패 화면이다.
폰 전용 preflight 명령은 없으므로 designSystem/paletteContrast와 해당 표면 시험을
기계 근거로 쓰며, 화면 캡처와 독립 design-review B0/H0는 아직 미검증이다.

planner는 `clients/mobile/maestro/114-settings-shell-flow.yaml`,
`60-profile-sheet.yaml`, `113-settings-capture.yaml`을 다시 돌리고 언어 선택·재실행·
로그아웃/계정/워크스페이스 전환·system/지원 밖 OS·오프라인·복귀·OS 변경·저장 오류
재시도를 추가로 확인한다. 375/390폭, 큰 글자, VoiceOver 자칭/선택/뒤로·escape,
동작 줄이기, ko/en OS 권한창 여섯 문구와 앱 언어 차이를 확인하고, iOS 시뮬레이터/기기에서
`scripts/hermes-intl-probe.js`(`globalThis.__oortIntlProbe`)가 위 macOS slice 실행과 같은 값을 내는지
본다(`numberFormat.formatToParts`가 `undefined`여야 한다).
웹·데스크탑 파일은 바꾸지 않았으며 그 언어 Playwright 흐름은 #4832 스택 검증 몫이다.
Rust include_str! 입력·migration·정책 파일 변경은 없다. merge-tree/전체 스택·커밋·
push·PR은 planner가 맡는다.
