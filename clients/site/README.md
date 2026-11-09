# clients/site: oort 내려받기 페이지

팀이 oort 앱을 받는 정적 페이지예요(주소 `app.oor7.com`, #5562). 언어마다 HTML 한 장이고, CSS와 스크립트는 페이지 안에 들어 있어요. 외부 글꼴·스크립트·추적은 없어요.

## 팀 한정 규칙 (M7-S 전)

- 모든 페이지가 `noindex, nofollow`이고, 빌드가 `robots.txt`(`Disallow: /`)를 만들어요.
- 공개 README·저장소 About에는 이 페이지를 걸지 않아요. 공개 출시는 [M7 게이트](../../docs/cicd/03-store-readiness-gate.md)의 스토어 등급(M7-S) 뒤예요.
- 페이지 안에는 푸터 한 줄로만 적어요(팀 페이지, 검색 노출 없음).

## 파일

| 파일 | 하는 일 |
|---|---|
| `values.json` | 바뀌는 값 한 곳: 설치 파일 주소(`DMG_ARM_URL`·`DMG_X64_URL`), `VERSION`, `MIN_MACOS`, `WEB_URL`, `SITE_HOST`(hreflang 절대 주소) |
| `i18n/<lang>.json` | 문구. ko·en·ja·zh-Hans·zh-Hant·es·fr, 모든 언어의 키가 같아야 해요 |
| `src/index.html` | 페이지 틀. `{{t.키}}`는 문구, `{{v.키}}`는 값 |
| `src/site.css` · `src/site.js` | 모양과 칩 고르기·메뉴·언어 기억 |
| `src/sky.js` | 첫 화면 하늘(WebGL1 셰이더). 움직임 줄이기면 한 장, WebGL이 없으면 CSS 하늘 |
| `assets/` | 앱 화면(`app-{ko,en}-{light,dark}.webp`)과 아이콘 |
| `build.py` | 표준 라이브러리만 쓰는 빌드 |
| `scripts/capture-app.mjs` | 앱 화면 다시 찍기 |
| `scripts/check.mjs` | 숫자로 확인하기 |

## 빌드와 미리 보기

```sh
python3 clients/site/build.py                     # -> clients/site/dist/ (커밋하지 않아요)
cd clients/site/dist && python3 -m http.server 21410 --bind 127.0.0.1
```

결과 폴더에는 `/`(영어, 첫 방문이면 브라우저 언어로 옮김), `/<lang>/`, `assets/`, `robots.txt`가 들어가요. 빌드는 어느 폴더에서 돌려도 이 스크립트 위치를 기준으로 `clients/site/dist/`에 써요(Python 3.9 이상, 표준 라이브러리만). `dist/`는 저장소 루트 `.gitignore`가 이미 빼요.

빌드는 다음이면 실패해요: 어느 언어에 키가 빠졌거나 남음, 빈 값, 줄표(U+2014·U+2013), 일본어·중국어 밖이나 속성·`<title>`에 들어가는 키에 쓴 구절 힌트 `|`, 채우지 못한 `{{자리}}`, `values.json` 값 빠짐, 결과 폴더에 없는 파일을 가리키는 링크.

## 확인

```sh
npm --prefix clients/web ci                       # Playwright(번들 Chromium)를 여기서 빌려 써요
SITE_URL=http://127.0.0.1:21410 SHOTS_DIR=/tmp/site-shots node clients/site/scripts/check.mjs
ONLY=chip,lang node clients/site/scripts/check.mjs   # 일부만
```

7개 언어 × 390·1280 × 밝게·어둡게의 가로 넘침·깨진 그림·콘솔 오류·글자 대비(4.5:1), 움직임 줄이기(두 장면이 같음), WebGL 끔(대체 바탕), 화면 밖·숨긴 탭(멈춤), 칩 고르기(키보드), 언어 첫 방문·기억, 좁은 폭(주 버튼의 칩·터치 44·TestFlight 표지·메뉴·첫 화면에 「다른 기기」 없음·웹 링크 아이콘의 툴팁과 언어 아이콘과 같은 모양·꼬리 언어 링크의 왼쪽 끝과 간격), 폰 흉내(첫 화면이 웹으로 열기, JS 없으면 Mac), WebKit 일본어 줄바꿈, 머리 줄(7개 언어 × 320~600 × 일반·폰 흉내), 머리 로고 배색(링은 글자색, 위성은 `clients/web/src/design/tokens.css`의 `--signal`: 메뉴 막대 `oort-tray-unread-on-*`와 같은 값), 첫 화면 문구(7개 언어 × 320·360·390·768·1280: 머리글·증거 칩 3이 사전 그대로 제자리에·칩이 화면 밖으로 안 나감·제목·머리글·칩의 낱말 가운데 끊김 0·줄 머리 문장 부호 0·넘침 0, 탭 제목 「oort」, meta description 150자 이하·첫 문장에 oort·Mac), 움직임 줄이기 정지 장면의 글자 대비(7개 언어 × 320·360·390·768·1280 × 밝게·어둡게, 글자 줄 상자 화소의 하위 2%: 머리글 4.5 이상, 로고·제목·리드·칩·사양도 기준 이상), 폰 첫 화면 높이 5종(320×568·375×548·375×629·375×635·390×664) × 7개 언어와 WebKit iPhone SE·14에서 주 행동이 첫 화면 안인지를 재요. 정지 장면은 혜성이 없는 순간이에요(`src/sky.js`의 `STILL`, 폰 폭에서 보이는 혜성은 글 덩어리나 로고를 지나요). 폰은 증거 칩이 주 행동·기기 안내 뒤에 와요. 제목 반쪽·리드·칩의 줄 수는 막지 않고 기록만 해요(`ONLY=pages`는 390·1280, `ONLY=copy`는 다섯 폭과 칩). `SHOT_LANGS=ko,en`으로 캡처 언어를 고를 수 있어요.

## 첫 문구 바꾸기

- 문구는 `i18n/<lang>.json`의 `hero_eyebrow`(제목 위 머리글), `hero_title_1`·`hero_title_2`(제목 두 반쪽, `src/index.html`의 `<h1>`에서 반쪽마다 블록으로 쌓여요), `hero_lead`(한 문단), `hero_proof_1`~`hero_proof_3`(리드 아래 증거 칩 셋, `<ul class="proof">`)예요. 칩은 단추가 아니라 표지라 누를 곳이 없어요.
- 링크 미리 보기에 나가는 `meta_description`은 리드 앞 두 문장을 150자 이하로 맞춰요(`check.mjs`가 막아요). 탭 제목 `meta_title`은 7개 언어 모두 `oort` 그대로예요(owner 11-09, `check.mjs`가 막아요).
- 7개 언어를 함께 바꿔요(빌드가 키를 맞춰 봐요). 줄표는 쓰지 않고, 일본어는 아래 「언어 더하기」 4처럼 구절 힌트 `|`와 `\u00a0`을 써요. 중국어는 제목 반쪽에만 `|`를 넣어요(제목만 `word-break: keep-all`, 본문은 글자 사이 줄바꿈이 관례라 그대로). 한국어 제목에서 한 덩어리로 둘 낱말 사이는 `\u00a0`(「한\u00a0팀으로」), 리드의 가운뎃점은 앞뒤에 `\u2060`(단어 결합 문자)를 붙여 「·같은」처럼 줄 머리에 오지 않게 해요. 보이지 않는 글자는 사전에 이스케이프로 적어요.
- 다시 재기: 빌드 → 미리 보기 → `SITE_URL=… ONLY=pages,copy,still,phone,header,webkit node clients/site/scripts/check.mjs`. 넘침·대비(정지 장면 화소 포함)·폰 첫 화면(높이 5종)·낱말 가운데 끊김·칩 넘침·일본어 줄바꿈은 단정이 막아요. 「제목 반쪽 줄 수」와 「리드 줄 수」·「칩 줄 수」는 기록이라 값을 보고 판단해요. `SHOTS_DIR`을 주면 `SHOT_LANGS` 언어의 전체 그림을 남겨요.

## 값 바꾸기

새 판을 올리면 `values.json`의 `DMG_*_URL`·`VERSION`만 고치고 다시 빌드해요. 설치된 앱의 업데이트 주소(`momo-alpha` Pages의 `update-*.json`)는 이 페이지와 따로예요.

## 언어 더하기

1. `i18n/<code>.json`을 다른 언어와 같은 키로 만들어요(빌드가 키를 맞춰 봐요).
2. `build.py`의 `LANGS`와 `root_redirect`(브라우저 언어 고르기), `scripts/check.mjs`의 `LANGS`에 코드를 더해요.
3. 앱이 그 언어를 지원하기 전까지는 영어 앱 화면과 `app_lang_note` 한 줄이 붙어요.
4. 일본어처럼 사파리(WebKit)가 구절을 모르는 언어는 긴 본문 문구의 구절 사이에 `|`를 넣어요. 빌드가 `<wbr>`로 바꾸고 CSS `word-break: keep-all`이 그 자리에서만 줄을 바꿔요(`build.py`의 `PHRASE_LANGS`, 중국어는 제목에만). 빈칸 뒤에 조사가 오면 `\u00a0`(줄 안 바꾸는 빈칸)으로 써요.

## 앱 화면 다시 찍기

```sh
npm --prefix clients/web ci && npm --prefix clients/web run build
CAPTURE_PORT=21401 node clients/site/scripts/capture-app.mjs
```

지금의 웹 클라이언트를 가상 인물(이도현·최민수·박서연, 「달무리 스튜디오」, 에이전트 코메토)로 찍어요. 백엔드 없이 `/v1`을 고정 응답으로 채우고, 결과는 1600px WebP예요. 실제 이름·대화·서버 주소는 넣지 않아요.

## 배포

Vercel 프로젝트 oort가 저장소를 따라 빌드해요: 저장소 루트에서 `python3 clients/site/build.py`를 돌리고 `clients/site/dist`를 올려요(설치 명령·프레임워크 없음, `clients/site/`가 바뀐 커밋만). PR마다 미리 보기 주소가 생기고(팀 로그인 필요), 실제 주소 `app.oor7.com` 반영은 planner가 해요. 저장소에 `vercel.json`은 두지 않아요(설정은 Vercel 쪽). 워커는 배포·도메인을 건드리지 않아요.
