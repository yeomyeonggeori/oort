# 웹·데스크탑 언어 어댑터 — #4832

UXUI / S3 / `track/uxui`, ADR-0213 §5·§9. P0-1/2의 공개
`@momo/core/i18n` API만 소비해요. 기존 화면 전체의 문구 추출은 P1 범위예요.

## 연결

- `index.html`이 `boot.ts`를 시작하고, `main.tsx`는 선호와 사전이 준비된 뒤
  첫 화면을 마운트해요. 영문 사전은 코어의 번들 fallback이고 한국어는
  `loadMessageCatalog`의 별도 청크예요. 실패하면 영어로 앱을 열고 프로필
  언어 행에서 실패 문구와 재시도를 제공해요. 청크 대기 상한과 실패 뒤 복구
  방식은 아래 「사전 청크 대기 상한과 실패 복구」(#4915)를 봐요.
- `LocaleProvider`는 계정·워크스페이스 provider 바깥에 있어요. 이후 문구를
  옮기는 화면은 `useAppLocale()`과 `useLocaleSnapshot(locale)`으로 변경을
  구독하고 `locale.service`를 사용해요. 독립 fixture에는 provider를 넣어야
  언어 행이 나타나요.
- 웹은 origin의 `localStorage["oort.locale.preference"]`에 저장해요. 읽기 실패는
  system, 쓰기 실패는 마지막 정상 선택 유지 + 재시도예요. 로그아웃 경로와
  저장 키를 공유하지 않아요. 선택은 사전을 먼저 받은 뒤 저장·context·HTML
  lang에 반영해요. 복귀/포커스/`languagechange`에 기기 정보를 다시 읽어요.
- 선택지는 system → 한국어 → English예요. 사전이 없는 언어를 OS가 우선하면
  영어 문장 fallback을 사용해요. 베타 표시는 없고(owner 10-31, #4936), 영어에서만
  부분 지원 한 줄(「Some screens are still in Korean.」)을 보여요.
- Tauri는 기존 `app.path().app_data_dir()` 안의 `locale-preference.json`을
  사용해요. 기존 데스크탑에는 공용 언어 설정 파일이 없었어요. 브라우저 저장
  값을 이 파일로 옮기지 않으며 플러그인·의존성·lockfile을 추가하지 않았어요.
  명령 세 개는 로컬 main 창에만 허용돼요. 메뉴 문자열은 코어
  `catalogs/{ko-KR,en-US}/desktop.json` → 웹 formatter → `locale_menu_set`으로
  전달해요. predefined 항목의 OS 동작과 단축키를 유지하고 about/services는
  OS 소유로 남겨요. Rust에는 번역 문장이 없어요.
- 로딩은 높이를 유지하는 중립 바와 `aria-busy`, 오류는 행 안 alert와 재시도,
  저장이 없는 상태는 system 선택으로 표현해요. 선택은 기존 ListboxSelect의
  키보드 동작을 쓰고, 재시도 중 포커스를 유지하며 성공하면 선택 칸으로 돌아가요.

## 첫 화면 언어 칩 — #4670

로그인 전 첫 화면(D0 서버 고르기·D1 로그인·D1′ 초대) 머리 줄 오른쪽에 작은 칩(`LanguageChip.tsx`)이 서요. 칩 → 언어 목록
(`DropdownMenu` 라디오 묶음) → 즉시 반영이고, **설정 › 프로필의 언어 행(`LanguageRow`)과 같은 값**이에요.

- 같은 앱 언어 객체의 같은 `locale.setPreference()`를 불러요. 그래서 같은 저장소(`oort.locale.preference`, 데스크탑은 같은
  `locale-preference.json`), 같은 사전 불러오기와 대기 상한, 같은 HTML `lang`이에요. 칩이 따로 저장하거나 따로 읽지 않아요.
- 선택지는 코어 `languageChoices(availableLocales)`예요(기기 언어 따르기 + 사전이 있는 언어). 언어가 늘면 `availableLocales`
  하나만 늘리면 설정 행과 칩이 함께 늘어요.
- 고른 뒤 사전이 들어오고 저장이 끝나면 목록이 닫혀요. 실패하면 열린 채 같은 오류 문장과 「다시 시도」(거절된 청크는
  「새로고침」)를 말해요. 영어 UI에서만 부분 지원 한 줄(설정과 같은 문장)이 서요.
- 머리 줄은 창 끌기 자리라 칩의 눌림은 뒤로 버튼처럼 `pointerdown`을 멈춰요. 앱 언어가 없는 독립 fixture에서는 빈 칸만 둬요.
- 칩은 머리 줄(`1fr auto 1fr`)의 **셋째 칸**, 오른쪽 끝에 못 박혀요(`tokens.css`, #5101). D0에는 진행 점이 없어 줄의 자식이
  둘뿐인데, 칸을 정하지 않으면 칩이 가운데 칸에 들어가 D1에서 오른쪽 끝으로 옮겨 가요. 렌더된 자리는 jsdom이 못 재서
  `scripts/capture-5101.mjs`가 번들 Chromium으로 D0·D1의 칩 오른쪽 끝을 1440·390에서 재요(`npm run build` 뒤 실행).
- **알려진 한계**: 첫 화면의 기존 문구는 아직 직접 쓴 한국어예요(문구 추출은 P1). 그래서 영어를 골라도 지금 즉시 바뀌는 것은 칩·
  「이메일 기억하기」 줄 같은 사전 문구와 `html lang`뿐이고, 나머지는 P1에서 따라와요.

시험: `src/i18n/LanguageChip.test.tsx`(칩 → 목록 → 영어, 설정 행·저장소·목록이 같은지, 사전 실패 시 열린 채 오류).

## 로컬 검증 (2026-10-30)

| 명령 | 결과 |
|---|---|
| `npm --prefix clients/web run typecheck` | PASS |
| 웹 ESLint: `src/i18n`, `LanguageRow.tsx`, `ProfileSection.tsx`, `lib/tauri.ts`, `main.tsx` | PASS, 경고 0 |
| 코어 ESLint: autonyms, index, service.test, generated | PASS |
| `npm --prefix clients/web test -- src/i18n/localeStore.test.tsx` | 10시험 PASS |
| `npm --prefix clients/web test` | 602파일·8,858시험 PASS; 22파일 실패(85시험 + suite hooks), 103 skipped·2 todo. 실패는 모두 Chromium `bootstrap_check_in ... Permission denied (1100)` 실행 제한이에요. 전체 PASS로 취급하지 않아요 |
| `npm --prefix packages/momo-core test` | 최종 275파일·6,755시험 PASS, 1 todo |
| 코어 `typecheck`, `i18n:check`, `gate:purity`, `gate:copy` | PASS |
| `scripts/design_preflight_web.sh` | PASS |
| 웹 `vite build --outDir /tmp/4832-web-build` | PASS, 한국어 `ko-KR-*.js` 별도 청크 확인 |
| 데스크탑 `cargo fmt --all --check`, `cargo clippy -p momo-desktop --all-targets -- -D warnings` | PASS |
| 데스크탑 `cargo test -p momo-desktop locale::tests` | 저장/복원·입력 검증·로컬 main ACL 2시험 PASS |
| 데스크탑 `cargo test -p momo-desktop` | 369 PASS·2 FAIL·3 ignored. 기존 git timeout 시험은 개별 재실행 PASS, 기존 `pty::tests::closing_the_app_kills_every_session`은 개별 재실행도 `Operation not permitted`예요 |
| `git diff --check` | PASS |

사전 확장으로 코어 `service.test.ts`의 고정 11개 단정이 실패했어요. 이 한 줄만
등록된 desktop 키 검사로 바꿨고, 바로 다음의 ko/en 전체 키 동등 검사와 기존
실문장·복수형 검사는 유지했어요. 파일 소유 밖의 유일한 코어 시험 수정이에요.

사보타주 두 건: `localStorage.setItem`을 무효화하면 새 어댑터의 재시작 복원
시험이 RED, HTML `lang` 대입을 무효화하면 첫 화면/즉시 갱신 시험이 RED였어요.
각 변조는 시험 뒤 원복했어요. 증거 로그는 `/tmp/4832-sabotage-{storage,lang}.log`,
전체 시험은 `/tmp/4832-{web,core,desktop}-tests*.log`예요. PR 본문에는 planner가
최종 병합 HEAD 증거와 함께 옮겨야 해요.

## 스택 검증 메모

바뀐 화면은 웹·Tauri 설정 › 프로필의 언어 행과 네이티브 메뉴예요.
ko/en/system 선택 → 즉시 반영/HTML lang → 새로고침/앱 재시작 → 로그아웃·계정
전환 뒤 유지, 새 설치(system), 지원 밖 기기 언어, 한국어 청크 지연·실패·재시도,
오프라인 영어 전환, 저장 실패, 영어에서만 서는 부분 지원 한 줄(베타 표시 없음)을 확인해요. 밝음/어두움,
390/900/1440 폭, 큰 글자, 동작 줄이기, Tab·방향키·Enter·Escape와 재시도 포커스도
봐야 해요. 네이티브 메뉴는 재시작 뒤 ko/en, 편집 단축키, 창 동작을 확인해요.

- Playwright: 기존 `npm --prefix clients/web run gate:shell`
  (`gates/gate-shell-layout.mjs`)의 설정 프로필 장면을 다시 돌리고 새 언어 행
  선택·저장/복원·실패 재시도 장면을 보강해요. 전체 웹 시험의 Chromium 실패도
  브라우저 실행이 가능한 스택 환경에서 다시 돌려요.
- Maestro: 폰 #4833이 착륙한 뒤 기존 `60-profile-sheet.yaml`과
  `114-settings-shell-flow.yaml`의 설정 열기/닫기 회귀를 다시 돌려요. 이 두
  기존 흐름이 새 언어 동작까지 검증한다고 주장하지 않아요. 폰 언어 전용
  장면과 키/역할 조회 연결은 #4833·#4710과 함께 스택에서 확인해요.

`runtime-unverified`: 실제 Tauri 메뉴/재시작, 화면 캡처·실기기·독립 design-review,
Maestro/Playwright 흐름, 병합 트리 검증. 사용자 지시에 따라 시뮬레이터·Xcode·Docker·
별도 캡처·배포·커밋·push·PR은 실행하지 않았어요. 새 Rust `include_str!` 입력은
없으며 정책 파일도 수정하지 않았어요. planner가 착륙·전체 스택 검증을 맡아요.

## 사전 청크 대기 상한과 실패 복구 — #4915

#4860의 「영어로 열고 다시 시도」는 복구하지 못했어요. 브라우저는 실패한 `import()`를
URL마다 문서가 살아 있는 동안 기억해서(HTML 모듈 맵, Chromium·WebKit), 같은 청크를 다시
불러도 네트워크로 나가지 않아요. 그리고 첫 화면은 청크를 상한 없이 기다렸어요.

**대기 상한.** 사전 청크를 기다리는 모든 `change()`는 `LOCALE_CATALOG_BUDGET_MS`(2,500ms,
근거는 `app/boot.ts`)까지만 기다려요. 넘으면 번들된 영어로 열고 오류 상태(다시 시도)로
가요. 요청은 취소하지 않아요. 늦게 도착한 청크는 그사이 사람이 다른 언어를 고르지 않았다면
저절로 적용돼요(`app/boot.ts`의 「결과는 도착하면 보인다」 규칙). 상한을 첫 `change()`에만
걸지 않은 까닭은, 멈춘 요청이 남아 있으면 이어지는 새로고침·재시도가 그 뒤에 줄을 서서
영영 움직이지 못하기 때문이에요.

**실패 종류 셋**(`LocaleSnapshot.needsReload`가 둘째를 알려요).

| 종류 | 「다시 시도」가 하는 일 |
|---|---|
| 상한 초과(요청이 아직 진행 중) | 다시 `import()`하면 진행 중인 요청에 합류해요. 제자리 재시도(「다시 시도」) |
| 거절된 import(즉시 실패, 서버 오류, 상한 뒤 늦게 실패) | 이 문서에서는 다시 요청할 길이 없어요. 「새로고침」 단추가 고른 언어를 저장한 뒤 페이지를 다시 불러요 |
| 그 밖(저장 실패 등) | 제자리 재시도(「다시 시도」) |

새로고침은 사람이 단추를 누른 뒤에만 일어나요. `refresh()`(포커스·복귀·언어 변경)와
늦은 도착 처리는 어떤 경우에도 새로고침하지 않아요. 새 문서의 부팅이 저장된 선택을 읽고
청크를 새로 요청하므로 「다시 시도」의 뜻이 그대로 지켜져요.

**규칙에서 벗어난 한 곳.** 평소 선택은 사전을 받은 뒤에 저장하지만, 새로고침 직전에는
선택을 먼저 저장해요(저장이 실패하면 새로고침하지 않고 오류로 남아요). 저장하지 않고
새로고침하면 사람이 고른 한국어가 사라지기 때문이에요. 새 부팅이 또 실패하면 평범한
콜드 스타트 폴백(영어 + 오류 행)이 정확히 그 상태예요.

### 왜 질의 문자열(`?retry=1`)이 아닌가

질의 문자열 자체는 이 경로들에서 통해요. Tauri `tauri://localhost` 프로토콜은 `?`와 `#`을
떼고 자산을 찾아요(`tauri-2.11.5/src/protocol/tauri.rs`의 `get_response`). 프로덕션 빌드를
`vite preview`로 서빙해 재 보니 `ko-KR-….js?retry=1`·`?retry=2`가 모두 질의 없는 요청과
같은 200·16,900B·`text/javascript`였어요. 서비스 워커의 `cachedAsset`은 질의가 다르면
캐시를 놓치고 네트워크로 가요(코드 확인). 배포 Caddy는 직접 재지 않았어요. 막히는 곳은 그 앞이에요.

- 한국어 청크의 이름은 `ko-KR-<해시>.js`예요. 프로덕션 빌드(2026-11-01)에서 확인했어요:
  진입 청크 안의 리터럴 `import("./ko-KR-….js")` 하나이고, `__vitePreload`의 deps가 `[]`라서
  modulepreload `<link>`도 없어요. 실행 중에 이 주소를 알 길이 없어요.
- 오류 메시지에서 주소를 뽑는 길은 브라우저마다 달라요. WebKit(데스크탑 macOS의 WKWebView)의
  메시지에는 주소가 없다고 알려져 있어요(이 환경에서 직접 재지 못했어요).
- 이름을 고정하거나 `build.manifest`를 읽는 길은 `vite.config.ts`·배포·서비스 워커의
  「해시 이름은 낡을 수 없다」 전제를 건드려요. 드문 복구 길 하나를 위해 바꿀 일이 아니라 후속으로 남겨요.
- 질의 문자열은 배포 중 사라진 해시 청크(404)를 고치지 못해요. 새로고침은 고쳐요.
  저장소의 복구 선례도 새로고침이에요(`pwa/store.ts`의 `applyUpdate`, `lib/session.ts`,
  `DisplayObserver`, `ObserverTerminal`).

### 데스크탑(Tauri)

같은 `createAppLocale`을 쓰므로 상한·늦은 적용·실패 종류가 그대로예요. 프로덕션은 임베디드
자산이라 네트워크 실패가 거의 없고, 거절된다면 번들이 깨진 것이라 새로고침이 맞아요.
새로고침 직전의 저장은 네이티브 `locale_preference_write`를 거쳐요(시험은 비동기 포트).
`window.location.reload()`는 `on_page_load`(`lib.rs`)를 타서 **그 창의 터미널 세션과
rotation hold를 정리해요**(#2824 M3·#3098). 이 경로가 드물어 감수했어요. 그리고
`syncMenu`가 `change()` 안에서 지연 import하던 `desktopMenu`(638B) 청크는 같은 부류의 실패가
제자리 재시도로 풀리지 않아 정적 import로 바꿨어요.

### 검증 (2026-11-01)

| 명령 | 결과 |
|---|---|
| `npm --prefix clients/web test -- src/i18n/localeStore.test.tsx src/app/boot.test.ts` | 23시험 PASS(localeStore 18 = 기존 7 유지 + 수정·교체 3 + 새 8, boot 5) |
| 사보타주 10건(아래) | 각각 의도한 시험만 RED, 원복 뒤 PASS |
| `npm --prefix clients/web run typecheck`, 웹·코어 ESLint(바뀐 파일) | PASS |
| `npm --prefix packages/momo-core run i18n:check` · `typecheck` · `gate:copy` | PASS |
| `node packages/momo-core/src/i18n/tooling/direct-copy.mjs web` · `mobile` | PASS(장부 증가 0) |
| `scripts/design_preflight_web.sh` | PASS (web 14/14 + core 6/6 + names) |
| `npm --prefix packages/momo-core test` | 288파일·6,946시험 PASS, 1 todo |
| `npm --prefix clients/web test` (전체 한 번) | 643파일 PASS·1 skipped, 9,283시험 PASS·7 skipped·2 todo, 실패 0 |
| `(cd clients/mobile && npx tsc --noEmit)`, 폰 `copyCatalog`·`testkit/query` | PASS(2수트·10시험). 공용 사전에 키가 하나 늘어서 확인했어요 |
| `vite build`(임시 폴더) + `vite preview` | 한국어 청크 하나가 지연 청크로 남고 `desktopMenu` 청크는 사라짐, 청크에 `?retry=1`·`?retry=2` 요청이 200 |

사보타주(각 변조는 시험 뒤 원복): 같은 URL로 다시 부르기(retry가 새로고침을 안 함)는
거절 뒤 복구 시험 4건 RED · 상한 제거는 상한·늦은 적용·재시도 시험 7건 RED · 늦은 도착
적용 제거는 2건 RED · 최신 선택 확인 제거는 1건 RED · 항상 새로고침은 제자리 재시도
시험 3건 RED · 저장 먼저 제거는 2건 RED · 늦은 실패의 승격 제거는 1건 RED · 단추 이름
항상 「다시 시도」는 1건 RED · `refresh()`가 새로고침하게 하면 1건 RED · 저장 실패 뒤
「새로고침」 유지 제거는 1건 RED.
모듈 맵 모델(`moduleMap`)은 거절된 URL을 기억하고 진행 중 요청에는 합류해요. 예전
시험의 mock은 두 번째 호출에 새로 답해서 이 버그를 통과시켰어요.

### 스택 검증 메모

바뀐 화면은 설정 › 프로필의 언어 행(오류 행의 단추 이름)뿐이에요. Playwright
(`gate:shell`의 설정 프로필 장면 또는 새 장면)로 한국어 청크 요청을 ① 즉시 실패시키기
② 응답 없이 붙잡기 ③ 대기 상한 뒤 풀어 주기를 만들어 봐요. ① 첫 화면 영어 + 「새로고침」
→ 누르면 페이지가 다시 열리고 한국어 + 새 요청, ② 2.5초 안에 영어 첫 화면(빈 화면 없음) + 「다시
시도」, ③ 풀리면 저절로 한국어로 바뀜. 데스크탑은 같은 ① 장면에서 새로고침 뒤 네이티브 메뉴가
한국어로 돌아오는지, 그리고 터미널 세션이 정리되는 것을 봐요(실행은 이 PR 밖).
`gates/gate-boot-budget.mjs`에 청크 요청을 붙잡는 장면을 더하는 것은 후속이에요.

`runtime-unverified`: 실제 브라우저·WKWebView의 모듈 맵 동작과 새로고침, Tauri 새로고침 뒤
메뉴·PTY, 화면 캡처·독립 design-review, 병합 트리 검증. 시험의 모듈 맵은 사양(HTML
「fetch a single module script」)의 모델이지 브라우저 실행이 아니에요.
