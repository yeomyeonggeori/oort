# 웹·데스크탑 언어 어댑터 — #4832

UXUI / S3 / `track/uxui`, ADR-0213 §5·§9. P0-1/2의 공개
`@momo/core/i18n` API만 소비해요. 기존 화면 전체의 문구 추출은 P1 범위예요.

## 연결

- `index.html`이 `boot.ts`를 시작하고, `main.tsx`는 선호와 사전이 준비된 뒤
  첫 화면을 마운트해요. 영문 사전은 코어의 번들 fallback이고 한국어는
  `loadMessageCatalog`의 별도 청크예요. 실패하면 영어로 앱을 열고 프로필
  언어 행에서 실패 문구와 재시도를 제공해요.
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
