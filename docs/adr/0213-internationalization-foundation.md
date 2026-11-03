# ADR-0213: 다국어 기반 — 공유 문장 사전과 1차 7개 언어

- Status: **Accepted** (2026-10-30, owner의 2026-10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐」 위임에 따라 아래 권장안을 채택). 추가 판단은 「owner 확인 필요」에 분리한다.
- Date: 2026-10-30
- Deciders: product-owner 위임을 받은 planner. 기안: #4240 Codex 워커, 엔진 트랙, S2 칸 5, base `track/engine`.
- 일정 근거: owner 2026-10-30 「다국어 지원쪽도 한번 일정을 땡겨서 가져가보고」. S2는 이 결정, S3는 P0, S4부터 P1이다.
- 계약: [#4240](https://github.com/yeomyeonggeori/oort/issues/4240), [PIPELINE §5](../planning/PIPELINE.md#5-스택--묶음-단위-실행과-시험), [공유 디자인 시스템](../design-system/README.md), [ADR-0100](0100-decision-governance.md).
- 범위: 설계 문서만. 구현·새 의존성 설치·migration·새 이슈 생성·배포는 하지 않는다. 아래 예정 경로·함수·필드는 구현 계약이며 현재 존재한다고 주장하지 않는다. 구현 동작은 **runtime-unverified**다.

## 1. 출발점과 번호 확인

2026-10-30 조회에서 원격 `main@1a822521`·`track/engine@c8172508`·`track/uxui@2dcf161a`의 트리에 `docs/adr/0213-*`가 없었다. 같은 시점 열린 PR #4802·#4803·#4805~#4809의 **변경 파일 목록**에도 없었다. 로컬 세 canonical ref와 이 작업 트리도 확인했다. planner의 10-30 예약(0213=#4240)을 사용한다. `docs/adr/README.md`는 없어 목록 파일을 새로 만들지 않는다.

이슈의 10-22 집계(한국어 포함 파일 웹 581·폰 241·코어 205, 로케일 고정 38곳)는 **당시 스냅샷**이다. P0에서 현재 수치를 다시 목록화하고 P1의 추출 장부로 쓴다. 이번 확인에서는 공용 i18n 의존성이 없고 웹·폰에 `ko-KR` formatter가 흩어져 있으며, 코어에 `lib/koreanParticle.ts`가 있는 것을 확인했다. 폰 `__tests__/copyCatalog.test.ts`는 사전 도입 전 `*copy*.ts`의 빈 문구 검사이고 #4710 testkit을 이미 소비한다. 따라서 #4710을 새로 만들거나 완료분을 재구현하지 않고 사전 입력으로 연결한다.

`server/Migrations/001_init.sql:61-70`의 `human`은 `(workspace_id, member_id)`에 속하며 `tz DEFAULT 'UTC'`가 **이미 있다**. 전역 계정 프로필은 아니다. 언어를 이 열과 혼동하지 않는다. 에이전트의 고정 시차 기본값은 `server-rust/bins/momo-agent-worker/src/config.rs`의 `AGENT_CONTEXT_UTC_OFFSET_MINUTES`(540)다.

## 2. 언어와 출시 범위

1차 언어 **7개**와 기준 변형을 확정한다. 사전 ID와 UI 표시 이름은 다음과 같다. 영어가 지원 밖 언어·누락 번역의 공통 fallback이고 한국어는 원문 작성 언어다.

| 사전 ID | 설정에 보이는 자칭 | 기기 언어 매칭 |
|---|---|---|
| `ko-KR` | 한국어 | `ko-*` |
| `en-US` | English (United States) | `en-*` |
| `ja-JP` | 日本語 | `ja-*` |
| `zh-Hans` | 简体中文 | 명시적 Hans 우선, 없으면 CN·SG, 지역 없는 `zh`는 Hans |
| `zh-Hant` | 繁體中文 | 명시적 Hant 우선, 없으면 TW·HK·MO |
| `es-419` | Español (Latinoamérica) | `es-*` (스페인 기기도 1차에는 중남미 변형) |
| `fr-FR` | Français (France) | `fr-*` |

BCP 47 정규화 후 기기의 **선호 언어 목록 순서**에서 첫 지원 항목을 고른다. 전부 지원 밖이면 `en-US`다. 의사 로케일 `en-XA`는 개발·시험 전용이고 일곱 언어에 세지 않는다. 2차는 `de-DE`·`pt-BR`·`it-IT`·`en-GB`; RTL 언어와 레이아웃 미러링은 후속 ADR 범위다.

언어 목록 확정은 오늘 일곱 언어가 구현됐다는 뜻이 아니다. P0는 새 기반과 영어·의사 로케일, P1은 기존 화면의 한국어·영어 추출 완료, P2는 나머지 다섯 언어다. P0/P1에서 영어를 켜면 이관 전 화면은 한국어로 남을 수 있어 **베타·부분 지원**으로 알린다. 새로 추출한 키의 fallback은 영어로 통일한다. 완역·검수 전 언어는 베타 표시를 유지한다.

### 비교 근거 (공식 원문, 2026-10-30 확인)

| 제품 | 확인한 사실과 이번 결정에 쓰는 범위 |
|---|---|
| Slack | [언어 설정](https://slack.com/help/articles/215058658-Manage-your-language-preferences)은 CJK·미/영 영어·프랑스어·독/이/포/스페인어 변형을 안내한다. 일부 시스템 문장은 워크스페이스 언어로 보일 수 있다. [워크스페이스 기본 언어](https://slack.com/help/articles/115004236403-Set-the-default-language-of-a-workspace-or-organization)는 개인 언어 선택과 별개다. 1차/2차 언어와 UI/공유 문장 분리의 비교 대상이다. |
| Discord | [공식 도움말](https://support.discord.com/hc/en-us/articles/216406447-How-can-I-change-Discord-s-Language)은 사용자 설정의 언어 선택을 안내한다. 계정·기기 간 동기화 범위와 전체 지원 변형은 이번에 확인하지 않아 근거로 쓰지 않는다. |
| Telegram | [공식 번역 플랫폼](https://translations.telegram.org/)은 문장별 제안·투표와 플랫폼 간 기능 용어 통일을 안내한다. 용어집·검수 흐름의 참고다. 외부 플랫폼을 oort에 도입하는 결정은 아니다. |
| Buzz | 영어 전용이라는 #4240의 10-22 조사 기록은 이번에 upstream 재검증하지 않았다. **미확인**으로 두고 언어 개수·구현 라이브러리의 근거로 쓰지 않는다. |

## 3. 라이브러리 결정과 크기 근거

**FormatJS를 채택한다.** 코어의 `@formatjs/intl`과 React 어댑터 `react-intl`을 쓰고 ICU MessageFormat을 사전 형식으로 통일한다. 코어는 React를 가져오지 않고, 웹·RN은 각 provider로 같은 사전·형식 문맥을 소비한다. 별도 JSON 복수형 규칙과 ICU plugin을 함께 관리하지 않는 점, 문장·날짜·숫자를 한 서비스로 묶는 점이 선택 이유다. 최저 크기라는 주장은 하지 않는다.

| 후보 | 공유 코어·웹·폰 적용과 ICU | 판단 |
|---|---|---|
| i18next + react-i18next | namespace·키 중심 이관에 적합. 기본 JSON 복수형은 ICU 문법과 다르며 ICU 사용에는 `i18next-icu` + `intl-messageformat` peer가 필요하다([공식 ICU 안내](https://react.i18next.com/misc/using-with-icu-format)). Hermes 복수형 polyfill도 필요하다. | 가능하지만 이번에는 plugin·형식 계층을 하나 줄인다. |
| FormatJS | [React Intl](https://formatjs.github.io/docs/react-intl/) + 비 React `@formatjs/intl`. ICU plural/select, 숫자·날짜 formatter를 같은 계약으로 제공한다. Hermes의 빠진 Intl API는 별도 보완해야 한다. | **채택**. 화면에서는 아래 wrapper만 쓰므로 공급자 교체 경계도 남는다. |
| Lingui | [코어](https://lingui.dev/ref/core)·[RN 안내](https://lingui.dev/tutorials/react-native). ICU를 빌드 때 컴파일하고 명시적 ID·추출·의사 로케일을 지원한다. Vite·Metro 양쪽 추출/컴파일 설정과 매크로 도구를 맞춰야 한다. | 작은 runtime이 장점이나 이번 이관에서는 두 빌드 파이프라인의 매크로 계약을 추가하지 않는다. |

### npm 실측 (2026-10-30, byte)

공식 registry의 **버전별 메타데이터 `dist.unpackedSize`**와 그 `dist.tarball` 응답 바이트를 조회했다. 전자는 타입·문서·여러 빌드·locale data를 포함하고, 후자는 npm 배포 tgz다. **둘 다 앱 번들 크기가 아니다.** 합계·순위로 실제 tree-shaking·Hermes bytecode·앱 용량을 단정하지 않는다. transitive dependency와 polyfill·선택 언어 데이터도 별도다.

| 패키지@조회 버전 | SPDX | unpacked | tgz |
|---|---|---:|---:|
| i18next@26.5.11 | MIT | 544,053 | 130,676 |
| react-i18next@17.1.9 | MIT | 981,861 | 239,107 |
| i18next-icu@2.6.1 | MIT | 576,741 | 143,471 |
| intl-messageformat@12.1.4 (ICU peer/FormatJS 의존) | BSD-3-Clause | 117,556 | 28,420 |
| react-intl@12.1.6 | BSD-3-Clause | 199,594 | 43,652 |
| @formatjs/intl@6.1.4 | MIT | 116,938 | 23,504 |
| @formatjs/icu-messageformat-parser@3.5.22 | MIT | 253,885 | 50,697 |
| @lingui/core@6.11.0 | MIT | 40,923 | 11,519 |
| @lingui/react@6.11.0 | MIT | 24,650 | 8,329 |
| @lingui/cli@6.11.0 (개발 전용) | MIT | 176,147 | — |
| @formatjs/cli@6.16.36 (개발 전용) | MIT | 1,459,501 | 319,788 |
| @formatjs/intl-pluralrules@6.3.16 | MIT | 953,271 | — |
| @formatjs/intl-locale@5.3.12 | MIT | 1,205,407 | — |
| @formatjs/intl-relativetimeformat@12.3.16 | MIT | 12,363,917 | — |

재현: `https://registry.npmjs.org/<package>/<version>`의 `license`·`dist.unpackedSize`·`dist.tarball`을 읽는다(예: [react-intl 12.1.6 메타데이터](https://registry.npmjs.org/react-intl/12.1.6)). 위 수치는 표의 **고정 버전**으로 재현하며 `latest`는 다시 비교할 때만 사용한다. 이번에는 후보 root/주요 peer만 확인했다. P0 의존성 PR에서 lockfile 전체의 permissive 라이선스와 NOTICE를 검증하고, Vite release gzip 및 Metro release/Hermes bytecode를 **같은 HEAD·설정의 도입 전후**로 재어 PR 본문에 남긴다. 사전·polyfill·locale data·도구 의존성을 구분하고 cli/매크로가 runtime에 들어가지 않는지도 확인한다. 이번 문서에서는 번들을 빌드하지 않았다.

### 폰 Hermes 지원: 잠긴 버전의 문서·소스 실측

로컬 `clients/mobile/package.json`·lockfile은 RN **0.86.2**, `ios/Podfile.lock:103-105`는 **hermes-engine 250829098.0.16 Pre-built**다. 설치된 RN의 `sdks/hermes-engine/version.properties`는 V1=250829098.0.16, 구형=0.17.0이며 podspec은 `RCT_HERMES_V1_ENABLED=0`일 때만 구형을 고른다. 따라서 `.hermesversion`의 `hermes-v0.17.0`만 보고 폰 엔진을 판정하지 않는다.

이에 대응하는 공식 Hermes 태그 `hermes-v250829098.0.16`의 commit은 **90f23852efcd361315688e2904d2446707fa274c**다. [버전 고정 Intl 문서](https://github.com/facebook/hermes/blob/90f23852efcd361315688e2904d2446707fa274c/doc/IntlAPIs.md), [JS 등록 소스](https://github.com/facebook/hermes/blob/90f23852efcd361315688e2904d2446707fa274c/lib/VM/JSLib/Intl.cpp), [Apple 구현](https://github.com/facebook/hermes/blob/90f23852efcd361315688e2904d2446707fa274c/lib/Platform/Intl/PlatformIntlApple.mm)을 직접 조회했다. `createIntlObject`가 등록하는 constructor는 **Collator·DateTimeFormat·NumberFormat 3개**이며 `PluralRules` 문자열은 등록 소스와 Apple 구현에서 각각 0회다.

| API | 잠긴 버전에서 확인한 범위 | P0 계약 |
|---|---|---|
| `Intl.PluralRules` | 등록 없음. `Intl.Locale`·`RelativeTimeFormat`도 없음. | FormatJS polyfill과 필요한 전제 API·일곱 언어 데이터만 locale 서비스·앱 UI 초기화 전에 로드한다. 한국어 시험만으로 통과시키지 않는다. |
| `Intl.DateTimeFormat` | constructor·format·supportedLocalesOf·resolvedOptions 존재. Apple 소스에 formatToParts도 있다. 문서의 구형 제한 표를 모든 새 기능의 보장으로 읽지 않는다. | 명시적 timezone·기본 날짜/시각 옵션만 공용 API로 노출. formatRange·고급 옵션은 지원 확인 전 쓰지 않는다. |
| `Intl.NumberFormat` | 기본 format·통화·숫자 존재. **Apple `formatToParts`는 `llvm_unreachable("…unimplemented…")`**. compact/engineering·signDisplay에도 구현 제한이 있다. | 기본 십진·백분율·통화 format만 사용. parts·compact에 기대지 않는다. 필요할 때 선택 polyfill 또는 별도 계약을 만든다. |
| `Intl.Collator` | compare·supportedLocalesOf·resolvedOptions 등록. OS의 로케일 시설에 위임하므로 OS별 결과 차이가 가능하다. | 화면 표시 정렬에만 사용하고 동률은 안정 ID로 가른다. 서버 검색·페이지 커서·정본 순서를 바꾸지 않는다. |

이것은 **실제 앱의 엔진 버전을 기준으로 한 문서·소스 조사**다. 시뮬레이터·실기기 실행, 일곱 언어 `supportedLocalesOf` 결과·OS별 출력·성능은 **runtime-unverified**다. Node/Jest의 Intl 결과를 Hermes 실행 증거로 바꾸어 쓰지 않는다. 일반 [FormatJS Hermes 안내](https://formatjs.github.io/docs/guides/react-native-hermes/)의 최신 지원 표와 이 태그는 다를 수 있어 잠긴 소스를 우선한다.

P0 폰 PR은 시작 시 지원 API와 일곱 언어의 실제 결과를 검사하고 필요한 polyfill을 서비스 초기화 전에 로드한다. P0 스택 검증에서 실제 Hermes에 대해 plural 0·1·2·1.5·1,000,000, 날짜(UTC/Asia/Seoul/America/New_York·DST 경계), 12,345.67·USD/JPY/KRW, CJK·악센트·숫자 포함 정렬을 기록한다. 초기화 실패는 한국어로 조용히 진행하지 않고 영어 안전 문구·진단 코드로 처리한다.

## 4. 문장 사전과 형식 경계

예정 위치는 `packages/momo-core/src/i18n/`이다. `catalogs/<locale>/<feature>.json`에 ICU 원문을 두고, 키·인자 타입·컴파일된 ICU AST는 생성한다. 앱은 사전·서비스의 공개 export만 가져온다. 웹은 언어별 chunk를 로드하고 폰은 오프라인 전환이 되도록 출시한 사전을 패키지에 포함한다. 의사 사전은 제품 배포에서 뺀다. locale 전환 시 기존 문맥의 formatter cache를 폐기하고 필요한 사전 로드가 끝난 뒤 화면을 함께 갱신한다.

- 키는 **`feature.surface.intent`** 형태의 안정적인 영문 의미 ID(예: `settings.profile.languageLabel`, `chat.message.deleteConfirm`)다. 문장 자체·줄번호·한국어를 키로 쓰지 않는다. 표면별 별칭을 무작정 합치지 않으며 접근성 이름·힌트·빈 상태·오류도 포함한다.
- 인자는 `{actorName}`·`{count}`처럼 의미·타입이 있다. 문장 조각 연결, 번역된 문구의 재보간, HTML 삽입은 금지한다. 링크 등 rich text는 허용된 토큰을 앱 컴포넌트에 매핑한다. 사용자 이름은 값으로만 넣고 실행·HTML·ICU 문법으로 해석하지 않는다.
- 원문은 한국어로 관리하되 출시된 키는 **한국어·영어 둘 다 필수**다. 번역 누락은 개발/CI에서 실패, 운영에서는 `선택 언어 → en-US → 공용 안전 문구`로 간다. 마지막 단계에서 키 문자열·서버 원문·내부 오류를 그대로 사용자에게 보이지 않는다. 누락 키 진단에는 사용자 값·본문을 담지 않는다.
- CI는 키 유일성·참조 키 존재·빈/공백 값·ICU parse·인자 이름/타입·plural의 `other`·활성 언어별 키 집합을 검사한다. 미출시 언어의 초안은 완역 주장과 섞지 않는다. 동적 키는 닫힌 enum 매핑만 허용한다.
- 의사 로케일은 **ICU AST의 literal만** 악센트화하고 괄호 표식과 35% 길이 증가(허용 30~40%)를 준다. 인자·키·태그·plural 선택자·숫자 형식은 보존한다. 버튼·설정 행·오류·접근성 텍스트·다중행에서 잘림·겹침을 확인한다.
- S3에서 **「새 화면은 사전 키로만」** CI를 켠다. 기준 HEAD의 기존 직접 문구는 추출 장부/파일별 예외로 고정하고 새 화면·새 사용자 문구에는 증가를 허용하지 않는다. 영어도 탐지 대상이며 한글 정규식만으로 구현하지 않는다. 사용자 콘텐츠·진단 로그·시험 fixture는 명시적으로 구별한다. P1에서는 이관 표면의 예외를 지운다. 정책 파일 변경이면 지정 owner 감사 절차를 따른다.
- [#4710](https://github.com/yeomyeonggeori/oort/issues/4710)의 코어·웹·폰 testkit은 키와 접근성 역할로 문구를 조회한다. 기존 폰 카탈로그 입력을 새 사전으로 바꾸고 빈 목록이 통과하지 않게 한다. 번역 문장 자체의 검수 시험과 화면 행동 시험을 구분하며, 기존 한국어 assertion 전체 이관은 종류별 작은 PR로 진행한다.

### ICU 복수형과 한국어 문장

[Unicode CLDR 49 복수형 표](https://www.unicode.org/cldr/charts/49/supplemental/language_plural_rules.html)를 따른다. cardinal에서 한·일·중은 `other`만, 영어는 `one/other`, 스페인어·프랑스어는 큰 수의 `many`까지 고려한다. 프랑스어 0·1 및 소수의 분류는 영어와 같지 않다. `count === 1`을 언어 공통 규칙으로 만들지 않는다. ordinal은 cardinal과 별도다. 명시 `=0`은 제품 의미가 있을 때만 쓰고 모든 plural에 `other`를 둔다. 예를 들어 영어 키 값은 `{count, plural, one {# message} other {# messages}}`이며, 동일 키의 한국어는 `{count}개 메시지`일 수 있다.

`koreanParticle`·`attachParticle`을 공용 문장 생성에서 제거한다. 호출자가 이름+조사를 조립하지 않고 **언어별 완결된 문장 틀**에 이름을 넣는다. 한국어 번역에서 조사가 꼭 필요하면 한국어 전용 인자 formatter를 번역 계층 안에 한정하고 기존 조사 시험을 유지한다. 다른 언어가 조사 함수를 호출하거나 조사 붙은 이름을 전달받지 않는다. 애매한 외국 이름은 「{actorName} 님」처럼 조사 의존을 줄인 틀을 권장한다.

해요체는 한국어 가이드로 유지한다. 영어는 짧고 직접적인 sentence case, 일본어는 です/ます, 중국어는 간결하고 공손한 표현, 중남미 스페인어는 지역 중립적인 tú, 프랑스어는 vous를 초기 문체로 한다. 용어·높임·금지 표현은 언어별 검수에서 다듬는다. 현재 한국어 문구 검사는 한국어 사전·이관 전 한국어 예외에만 적용하고 다른 언어에 종결어미 검사를 걸지 않는다.

## 5. 언어 설정과 형식

웹·데스크탑·폰 모두 **설정 › 프로필 › 언어**에 `기기 언어 따르기`와 자칭 언어 목록을 둔다. 선택 즉시 현재 앱 전체와 등록된 모든 워크스페이스·계정에 적용하며 재로그인은 필요 없다. 언어를 모르는 사람도 복구할 수 있게 자칭 표기를 유지한다. 베타 여부와 부분 지원 안내를 함께 보여 준다.

**owner 10-31 (#4936) — 표시 규칙 변경:** 언어 행에 베타 표시를 두지 않는다(폰·웹·데스크탑, 화면·낭독 모두). 폰은 언어 아래 설명(현재 언어·적용 범위·부분 지원·권한 창)을 걷고 영어 UI일 때만 「Some screens are still in Korean.」 한 줄을 남기며, 웹·데스크탑의 영어 UI 안내도 같은 한 줄이다. 이 줄이 §2·§5·§8의 「베타 표시」 문장에 우선한다.

**P0 저장 위치는 앱 설치/브라우저 프로필 단위의 로컬 preference**(`system` 또는 지원 BCP 47 ID)다. 웹은 해당 origin의 localStorage, 데스크탑은 Tauri 앱 설정, 폰은 MMKV를 사용한다. 비밀이 아니므로 인증 키 저장소에 넣지 않는다. 로그아웃·계정 제거로 지우지 않는다. 명시 선택이 없으면 기기 언어 목록을 다시 읽으며, system 모드는 앱 복귀·OS 언어 변경 때 재평가한다. 웹의 읽기 전 초기 화면도 같은 규칙으로 `<html lang>`를 맞춘다.

**「모든 워크스페이스에 적용」은 현재 앱 설치 안에서의 범위**다. 다른 기기·다른 브라우저 origin·다른 서버로 자동 동기화하지 않는다. tenant의 `human.locale` 열을 여러 서버에 복제하거나 이메일로 신원을 합치지 않는다. #4240이 참조한 **ADR-0209는 현재 트리에 없는 예약 번호**이며, 현행 멀티 계정 설계 작업은 [#4287](https://github.com/yeomyeonggeori/oort/issues/4287)의 `계정=(origin, workspaceId, memberId)`다. 이 ADR은 그 세션·캐시 경계를 좁히지 않는다. 언어는 설치 전역이어도 데이터/자격은 계속 계정별이다. 장래 동기화는 별도 결정으로 둔다.

공용 진입점 **`createLocaleService(context)` 하나**에서 문장·날짜·시각·상대 시각·숫자·통화·표시 정렬·주 시작 요일을 제공한다. context는 `messageLocale`·지역을 포함한 `formatLocale`·IANA `timeZone`·hour cycle을 명시한다. `zh-Hans/Hant`는 문장 ID이고 형식은 기기의 대응 지역(예: zh-CN/zh-TW)을 보존하며 지역이 없으면 CN/TW를 쓴다. 다른 언어도 기기 지역을 보존하되 명시 언어 선택을 반영한다. es-419처럼 단일 국가가 아닌 경우 지역이 없으면 해당 CLDR 기본을 따른다.

- 기존 로케일 고정 지점은 이 서비스로 옮긴다. 렌더 바깥의 `ko-KR` singleton은 허용하지 않는다. locale·timezone·옵션을 cache key로 쓰고 변경을 구독한다.
- 시각은 epoch/UTC로 보관하고 표시할 때 변환한다. timezone은 사용자가 명시한 유효 IANA 값 → 기기 IANA 값 → UTC다. `human.tz`는 멤버별 기존 값이며 별도 연결 PR에서 읽기/변경 계약을 정한다. 기본 `'UTC'`만으로 사용자의 명시 선택이라고 추정하지 않는다. 언어 변경이 시간대·예약 발송 시각을 바꾸지 않는다([ADR-0208](0208-scheduled-messages.md)).
- 상대 시각은 `Intl.RelativeTimeFormat`의 선택 polyfill과 공통 now 입력으로 생성하고, 오늘/어제 경계도 context timezone 기준으로 계산한다. 시험에는 now를 주입한다. 숫자·백분율은 native 기본 format, 통화는 **API가 준 ISO 4217 코드**를 명시한다. 언어에서 통화를 추정하거나 저장 값을 바꾸지 않는다.
- 주 시작은 기기의 유효한 명시 설정을 우선하고, 없으면 고정한 CLDR 지역 자료의 작은 매핑을 공용으로 둔다. Hermes에 없는 `Intl.Locale`의 최신 weekInfo API에 의존하지 않는다. 기기 지역이 없으면 formatLocale의 지역 기본을 쓴다. 월/일요일을 전 세계 하나로 고정하지 않는다.
- 정렬은 context의 Collator를 재사용하고 동률이면 안정 ID를 사용한다. NFC·악센트·대소문자·숫자 옵션을 표면별로 명시한다. 메시지 `seq`·서버 검색(pg_trgm/simple)·멱등 키·페이지 순서는 번역하지 않는다.

## 6. 글꼴과 줄바꿈

현재 시스템 글꼴·오프라인 원칙을 유지한다. 웹 `tokens.css`의 한국어 중심 sans stack을 바탕으로 `:lang(ja)`는 Hiragino Sans/Yu Gothic/Meiryo/Noto Sans CJK JP, `:lang(zh-Hans)`는 PingFang SC/Microsoft YaHei/Noto Sans CJK SC, `:lang(zh-Hant)`는 PingFang TC/Microsoft JhengHei/Noto Sans CJK TC 순의 **설치된 시스템 대체**를 둔다. 이 목록은 CSS fallback 후보이지 모든 OS 설치 보장이 아니다. CDN 폰트를 추가하지 않는다. RN은 system font fallback과 텍스트의 언어/접근성 설정을 쓰고 특정 Apple 글꼴을 다른 OS에 하드코딩하지 않는다.

UI chrome은 선택 언어의 lang을 상속한다. 사용자 메시지는 UI 언어가 메시지 언어라는 가정을 하지 않고, 신뢰할 수 있는 언어 메타데이터가 있으면 **텍스트 블록 단위** lang을 지정한다. 없으면 혼합 CJK의 긴 문장 시험으로 기본 규칙을 검증한다. `lang`을 텍스트 내용에서 임의 추정해 영속하지 않는다.

[#4231](https://github.com/yeomyeonggeori/oort/issues/4231)과 일치하게 한국어는 어절 유지(`word-break: keep-all`), 일본어·중국어는 `word-break: normal; line-break: strict` 후보로 금칙과 자연스러운 CJK 줄바꿈을 확인한다. 긴 URL·식별자·코드는 `overflow-wrap: anywhere` 등 전용 예외를 둔다. 한국어 keep-all을 일·중 본문 전체에 강요하지 않는다. 폰은 CSS를 흉내 낸 수동 줄바꿈/공백 삽입 대신 네이티브 줄바꿈과 폭·큰 글자 시험으로 검증한다. 사용자 글꼴 선택과 Dynamic Type도 유지한다. P1/P2의 390·900·1440폭/큰 글자·혼합 언어 검수에서 글리프 누락·이체자·행 높이·잘림을 확인한다.

## 7. 서버 문장·기존 기록·푸시

오류·시스템 줄·푸시의 의미는 **안정된 코드 + 타입 있는 값**으로 보낸다. wire 오류 코드/이벤트 종류와 번역 키는 별도 닫힌 매핑으로 연결한다. 예시 형태는 `code: "channel_member_added", values: {actorName, memberName}, version: 1`이며 **실제 새 API/props 스키마는 P3 PR에서 가산 변경**한다. 기존 `error.code`·`kind`·HTTP 상태와 [ADR-0204](0204-phone-notifications-v2.md)의 닫힌 푸시 어휘·보안 판정은 언어 때문에 바꾸지 않는다.

- 시스템 이벤트는 locale 없는 값과 코드로 저장하고 읽는 앱이 자기 언어로 만든다. 사용자가 쓴 본문·봇이 이미 보낸 본문을 시스템 코드로 재해석하지 않는다. 신규 코드는 구형 클라이언트용 한국어 호환 body를 전환 기간 함께 유지하고 신형은 알려진 version만 번역한다. 정본 send tx·outbox·relay·Centrifugo 및 seq/멱등성은 유지한다.
- 이미 저장된 한국어 시스템 메시지는 **역번역·본문 치환·정규식 추론을 하지 않는다**. 구조화된 기존 kind/props만으로 의미를 확정할 수 있을 때 신형 renderer를 적용하고 나머지는 원문 그대로 보인다. 전환 전 기록은 원문일 수 있음을 언어 설정 안내에 적는다. backfill이 필요하면 별도 migration 이슈와 검증을 거친다.
- 알려지지 않은 오류/이벤트 코드는 선택 언어의 안전한 일반 문장과 지원용 코드만 보여 준다. 서버 상세 메시지를 그대로 UI fallback으로 쓰지 않는다. 구형 앱의 기존 body 소비는 호환성 계약으로 유지한다.
- **푸시는 서버가 수신 기기의 유효 언어를 골라 title/body를 렌더한다.** APNs `loc-key/loc-args`는 [앱 bundle의 문자열을 OS가 찾는 방식](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CreatingtheNotificationPayload.html)이라 앱 내 선택·system 모드·버전 차이와 맞추기 어렵다. 1차에는 서버 렌더를 택하고 앱 OS 알림·웹 알림도 같은 코드 사전을 쓴다. JS 함수 복제 대신 사전에서 생성한 버전 있는 제한된 서버 템플릿을 사용하고 ICU 전 기능을 Rust에서 새로 구현하지 않는다.
- P3에서 **설치/기기와 수신 계정**에 결속된 `effective_locale`·사전 버전 갱신 계약을 추가한다. 설치 전역 언어 변경은 각 로그인 계정의 자기 서버에만 보낸다. system 모드는 기기에서 해석한 지원 locale을 보낸다. 전송 실패 시 마지막 확인 값, 없으면 영어다. 언어 값을 계정 조회/다른 workspace 읽기 권한으로 쓰지 않으며 RLS·멤버 범위를 유지한다. 같은 알림을 받는 두 기기의 언어가 달라도 각각 렌더한다. 다중 계정 push 설계 #4444와 합의한 가산 스키마로 한다.
- 잠금화면의 본문/이름 노출 정책, 숨김 미리보기, 승인 행동 토큰·수신 자격은 기존 계약 그대로 적용한다. 번역 전후에 같은 비공개 값이 가려져야 한다. 푸시 사전 불일치·구형 버전에는 일반 영어 알림을 쓰고 번역 키를 노출하지 않는다.

## 8. 플랫폼 문구·AI·번역 생산

### 플랫폼

iOS 카메라·사진·마이크 등 권한 이유는 **각 출시 언어의 `InfoPlist.strings`**로 제공하고 Xcode 지역화 목록/개발 언어와 맞춘다. 공용 사전의 플랫폼 namespace에서 생성하되 OS가 표시하는 권한창과 앱 안 안내는 별도 키로 검수한다. 앱 안 언어와 OS가 고르는 권한창 언어가 다를 수 있다는 한계를 시험/안내에 남기며 즉시 전환을 보장하지 않는다. 권한 문구 누락은 해당 언어 출시를 막는다.

Tauri 메뉴·트레이·앱이 생성한 OS 알림·단축키 설명도 같은 locale의 플랫폼 사전을 소비한다. OS 소유 메뉴·날짜 선택기는 OS 언어일 수 있다. App Store/Play Store·데스크탑 배포 페이지의 설명·권한/개인정보 설명·스크린샷은 언어별 **별도 검수 산출물**이다. 번역 PR이 스토어 제출·M7 등급/owner 배포 승인을 대신하지 않는다. P0 영어 설정과 기본 권한 문구를 먼저 맞추고 P2에서 다섯 언어를 확장한다.

### AI와 시간대

1. 개인 요청/DM 답은 **이번 요청의 명시 언어 → 요청자 UI 언어 → 영어**다. UI 언어만 바꿔 과거 답을 번역하지 않는다. 선택은 답의 지침이며 모델의 준수를 보장하지 않으므로 P3 다국어 품질 검수를 한다.
2. 공유 채널 답·공유 기억 요약은 **이번 요청의 명시 언어 → 워크스페이스 기본 언어 → 영어**다. 참여자마다 다른 UI 언어로 같은 공유 메시지를 다시 생성하지 않는다. 개인 기억 요약은 요청자 기준을 쓴다. 공유 언어 설정이 도입되기 전 기존 워크스페이스는 한국어 호환 기본을 유지하고 신규 설정의 기본은 생성자의 유효 언어로 제안한다.
3. 기억 원문·인용·사용자 메시지는 보존한다. 언어가 바뀌었다고 임베딩을 일괄 재생성하거나 기존 요약을 몰래 덮어쓰지 않는다. 이후 요약에 생성 언어·버전을 기록한다. 메시지 자동 번역 제품은 별도 범위다.
4. 요청자 시간대(명시 유효 값/기기 보고) → 워크스페이스 IANA 시간대 → UTC를 사용한다. unattended 작업은 워크스페이스 → UTC다. 고정 UTC+9를 세계 공통 기본으로 쓰지 않는다. 기존 운영 설정의 540은 이행 시 명시값으로 보존하고, 새 기본을 UTC로 바꾸는 PR에서 예약·자정·DST 회귀를 확인한다. 언어로 시간대를 추정하지 않는다. 신뢰된 언어·시간대 메타데이터만 지침에 넣고 사용자 텍스트를 시스템 지침으로 승격하지 않는다.

### 번역 생산

레포 안에 한국어 원문·영어 기준 번역·언어별 JSON·용어집·문체 가이드·검수 manifest를 둔다. manifest는 키/원문 hash·번역 버전·`draft / llm-draft / reviewed`·검수 역할/일자를 기록한다. **LLM 초안 → 용어/변수/ICU 자동 검사 → 원어민 문맥 검수 → 화면 검수** 순서이며 원문 변경은 해당 키 검수를 만료시킨다. 미검수 언어는 설정에 베타 표시, `reviewed`만 정식 표시다. 영어도 예외가 아니다.

LLM에는 제품 사전·용어집·가짜 예시만 주고 사용자 메시지·실명·비밀을 번역 재료로 보내지 않는다. CJK 간체/번체는 기계 문자 변환만으로 완료 처리하지 않고 각각 용어·지역 표현을 검수한다. 외부 번역 SaaS·런타임 원격 사전 다운로드는 도입하지 않는다. 번역가가 코드/HTML을 삽입할 수 없도록 허용 태그·인자 계약을 CI에서 검사한다.

## 9. 스택 단위 이행 계획 — planner가 PR 크기 이슈로 편성

아래 각 행은 **PR 하나 크기의 이슈 제안**이다. 새 번호를 임의로 만들지 않는다. #4710·#4231·#4444 등 기존 작업은 재사용/연결한다. 한 스택 최대 8칸과 착륙·스택 검증·승격 경계는 PIPELINE §5를 따른다. P1 이후의 정확한 스택 번호는 선행 스택 검증과 planner 용량에 따라 정한다. 기한 없는 전면 추출을 P0 한 PR에 넣지 않는다.

| 스택/단계 | PR 단위 이슈 제안 | 완료 조건·선행 |
|---|---|---|
| **S2 / ADR** | #4240 이 문서 | 수용기준·번호·근거·독립 검수. full docs gate는 planner가 수행 |
| **S3 / P0-1** | 코어 사전·FormatJS wrapper·키/인자 생성 | ko/en 공용 샘플·ICU 검증·fallback·lockfile/NOTICE·웹/Metro 크기 비교. 제품 표면 전면 이관 없음 |
| **S3 / P0-2** | 코어 locale preference/기기 매칭·공용 형식 context | 일곱 언어 매칭·system/en fallback·계정 전환 무관성·주 시작·timezone 계약. P0-1 뒤 |
| **S3 / P0-3** | 웹·데스크탑 언어 설정 어댑터 | 설정 › 프로필·저장·재시작·html lang·Tauri 메뉴 ko/en. P0-1/2 뒤 |
| **S3 / P0-4** | 폰 언어 설정·Hermes 초기화 | MMKV·복귀/OS 변경·선택 polyfill·ko/en 권한 문구. 잠긴 Hermes probe와 release 차이 측정. P0-1/2 뒤 |
| **S3 / P0-5** | 의사 로케일·새 화면 키 전용 CI | +35% literal·ICU 보존·키 누락/빈 문구·직접 문구 새 증가 실패·기존 추출 장부. P0-1 뒤 |
| **S3 / P0-6** | **#4710** testkit·문구 조회 헬퍼 연결 | 이미 있는 testkit을 사전 입력으로 연결. 키/역할 조회·빈 목록 실패·원어민 문장 시험 분리. P0-1 뒤 |
| **S4부터 / P1-1** | 코어: 공용 오류·설정·초대/연결 문구 추출 | ko/en·조사 호출 격리·키/인자 동등·고정 formatter 장부 감소. P0 스택 PASS 뒤 |
| **P1-2** | 코어: 대화·인박스·작업/에이전트 문구 추출 | 공용 문장/상태의 ko/en 완비·seq/서버 계약 불변. P1-1 뒤 |
| **P1-3** | 웹: 프로필·설정·연결·진입 화면 추출 | 대응 코어 키 소비·aria/오류/빈 상태·관련 한국어 시험 이관. 코어 묶음 뒤 |
| **P1-4** | 웹: 대화·목록·인박스 추출 | #4231 줄바꿈 계약·390/900/1440·의사 로케일. P1-3 뒤 |
| **P1-5** | 웹: 작업·에이전트·기억 표면 추출 | 잔여 고정 formatter/직접 문구 예외 제거·웹 영어 범위 장부 완료. P1-4 뒤 |
| **P1-6** | 폰: 프로필·설정·연결·목록 추출 | 코어/웹 어휘 통일·큰 글자·VoiceOver/접근성. 웹 묶음 뒤 |
| **P1-7** | 폰: 대화·인박스 추출 | 한국어 조사/줄바꿈·의사 로케일·관련 Maestro 문구 조회 이관. P1-6 뒤 |
| **P1-8** | 폰: 작업·에이전트·미디어 추출 | 남은 예외/locale 고정 제거·폰 영어 범위 장부 완료. P1-7 뒤 |
| **그 뒤 / P2-1~5** | **일본어 / 간체 / 번체 / 중남미 스페인어 / 프랑스어 각각 별도 PR** | LLM 초안·언어별 용어/문체·plural·원어민 검수 상태·베타·glyph/줄바꿈. P1 추출 스택 PASS 뒤 |
| **P2-6** | 플랫폼 문구·스토어 언어별 검수 산출물 | iOS 지역화·메뉴/OS 알림·메타데이터·스크린샷. 문구 누락 언어 출시 차단. P2 사전 뒤, 배포 별도 승인 |
| **그 뒤 / P3-1** | 서버 오류 code+값·클라이언트 매핑 | 가산 API·구형 body 호환·알 수 없는 code fallback·민감 상세 가림. P2 스택 PASS 뒤 |
| **P3-2** | 시스템 이벤트 code+값·기존 기록 renderer | 신규 tx/outbox 유지·구형 메시지 보존·확정 props만 렌더·호환 시험. P3-1 뒤 |
| **P3-3** | 기기/계정 locale 전달·수신자별 푸시 렌더 | #4444와 합의·RLS·다중 계정/기기 언어·숨김 미리보기·버전 fallback. P3-1/2 뒤 |
| **P3-4** | 워크스페이스 언어/시간대 설정 | 관리자 설정·기존 ko/운영 시차 보존·IANA 검증·권한 시험. AI/푸시 기본값의 명시 입력 |
| **P3-5** | AI 응답·개인/공유 기억 언어·시간대 | P3-4 뒤, 개인/공유 우선순위·인용 보존·DST·명시 언어 요청·일곱 언어 품질 검수 |
| **P3 후 / 2차** | 독일어 / 브라질 포르투갈어 / 이탈리아어 / 영국 영어 각각 PR | 1차 운영·번역 품질 검수 이후 같은 계약을 확장. RTL은 포함하지 않음 |

행별 표면이 예상 PR 크기를 넘으면 planner가 **표면/namespace별로 더 나누되**, 코어 → 웹 → 폰 순서와 단계별 PASS를 지킨다. 같은 스택의 기반 의존 PR은 선행 API를 합의하고 순차 착륙한다. 구현 PR의 검증 증거는 해당 PR 본문이 정본이며, 현재 HEAD에서 이미 통과한 증거는 변경 범위에 맞게 재사용한다.

## 10. 검증·검수와 owner 확인 필요

이번 문서의 확인은 번호 조회·npm 메타데이터/tgz·잠긴 Hermes 문서/소스·저장소 사실·문서 명령 검사다. `python3 scripts/check_docs_commands.py`는 운영 문서 명령을 검사하므로 이 ADR의 링크/사실까지 검증했다고 주장하지 않는다. 새 ADR의 상대 링크·Markdown fence·표는 별도로 확인한다. `scripts/local_gate.sh --profile docs`(Docker 포함)와 독립 검수의 최종 수용은 planner 인계에서 끝낸다. 코드가 없어 TS 타입/단위 시험·UI 캡처·Maestro/Playwright를 이번 칸에서 돌리지 않는다.

워커 확인(2026-10-30): 문서 명령 검사 **PASS**(21개 문서·622 facts), ADR 상대 링크/앵커 5개·표·공백 검사 **PASS**. fresh context의 독립 설계 검수는 변경 사본과 저장소/공식 근거를 대조해 **Blocker 0·High 0·잔여 지적 0**이었다. Low 1건(잘못 표현한 polyfill 초기화 시점)은 수정 후 재확인했다. full docs gate와 아래 runtime 검증은 이 결과에 포함하지 않는다.

**후속 스택 검증 메모:** S2는 바뀐 화면 없음. S3는 프로필 언어 선택 → 재시작/로그아웃/계정 전환 → system/지원 밖/오프라인 → 의사 로케일 잘림 → 실제 Hermes probe를 확인한다. 이후 P1/P2는 설정·목록·대화/스레드·인박스·작업·에이전트·미디어를 ko/en/en-XA와 출시 언어로 확인하고, 관련 기존 Playwright·Maestro 흐름을 #4710 키/역할 조회로 연결해 다시 돌린다. 현재 없는 흐름 이름을 실행 명령처럼 만들지 않는다. UI 독립 design-review **Blocker 0·High 0**, 큰 글자/접근성·CJK 줄바꿈과 병합 트리 검증은 각 해당 스택의 승격 전 의무다.

### owner 확인 필요

이미 위임된 일곱 언어·es-419·라이브러리·로컬 설치 단위 설정·이행 순서는 재승인을 기다리지 않는다. 새 판단은 아래와 같이 따로 남긴다.

| 새 판단 | 권장안과 진행 경계 |
|---|---|
| 원어민 검수 인력·유료 검수 예산·정식 지원 공개 시점 | 언어별 베타로 시작하고 담당 원어민 검수와 화면 검수 완료 뒤 정식 표시. 비용 집행·공식 출시 약속은 owner 확인 필요. 기반·추출·초안은 진행 가능 |
| 서로 다른 기기/서버까지 언어 설정 동기화 요구 | 1차는 이 ADR의 설치 단위를 유지. 필요하면 멀티 계정 신원 경계를 포함한 별도 설계로 판단. 미확정 전 전역 계정 테이블·이메일 매칭을 만들지 않음 |
| RTL·사용자 메시지 자동 번역·외부 번역 SaaS | 이번 범위 밖 유지 권장. 제품 방향/외부 처리·비용이 추가되므로 요청 시 별도 결정 |

이 ADR의 Accepted는 문서의 설계 채택이며 일곱 언어 구현 완료·runtime PASS·스토어 제출/팀 배포 허가를 뜻하지 않는다.
