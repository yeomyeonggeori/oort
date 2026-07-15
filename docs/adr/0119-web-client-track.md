# ADR-0119: 웹 클라이언트 트랙 — "서버 URL이 곧 웹 주소"

- Status: **Accepted** (2026-07-15, 성재 — 권고안 D1-A~D5-A 전체 승인, 웹 우선 확정. 실행은 Fable이 엔진/인프라 트랙 한정 momo-main 겸임으로 진행)
- 관련: `research/15-platform-expansion/`(00 코드 사실·02 업계 패턴·03 제안), ADR-0002(compose 레이어링), ADR-0112(듀얼 모드 — 웹 v0는 기본 모드만), ADR-0117(멀티 워크스페이스 — 웹 데이터 모델이 선반영), ADR-0121(배포판·초대 관통, 병행 draft), ux-bible P2·P5·P6
- 발단: 성재 발제(2026-07-15) "본인 서버 URL을 웹에 입력하면 웹사이트에서도 확인" + 방향 확정 "웹 먼저가 맞는 듯" — iOS(M5)보다 웹 선행. 엔진/인프라 트랙은 Fable 위임, UX/UI 트랙(momo-main·성재)과 파일군 비충돌이 배치 제약.

## Context

1. **웹 자산은 0건이고 로드맵에 웹 트랙 자체가 없다** (`ROADMAP.md:77` — 트랙 정의가 🖥 macOS/📱 iOS/⚙️ 백엔드뿐). 완전 미개척지라 기존 티켓·엔진 큐(ADR-0113~0116)·UX 체인(MOMO-385/386)과 파일군 충돌이 없다 — 위임 조건에 정확히 부합.
2. **초대 관통의 열쇠다.** 현재 신규 멤버 합류는 macOS 앱 설치가 전제다. 웹이 있으면 초대 링크 → 브라우저 합류(무설치)가 성립하고, 이것이 ADR-0121 universal link 초대의 1차 랜딩 표면이 된다. 스토어 심사가 없어 iOS보다 리드타임이 짧다는 점도 성재의 "웹 먼저" 판단과 정합.
3. **업계 수렴 답이 명확하다** (`research/15-platform-expansion/02` §2-3): Mattermost/Rocket.Chat/Zulip 모두 서버가 같은 도메인에서 웹 SPA를 직접 서빙 — "설치하면 웹까지 끝, 서버 URL이 곧 웹 주소". Element만 분리 배포인데 셀프호스터가 배포물 2개를 관리하는 마찰이 확인됐다. Slack/Discord도 웹 클라이언트가 곧 데스크톱(Electron 래핑)인 웹-우선 구조다 — momo는 역방향(네이티브 먼저)이므로 웹은 "두 번째 클라이언트"라는 점이 계약 관리 요구를 만든다(D4).
4. **서버 코드 사실** (2026-07-15 @ b720250 대조):
   - CORS 미들웨어·쿠키 발급 코드가 전혀 없다(server/Sources grep 0건). 브라우저가 다른 오리진에서 `/v1/*`를 호출하면 현재 서버로는 불가능 — 같은 오리진 서빙(D1-A)을 고르면 CORS 문제가 아예 발생하지 않는다.
   - 인증은 JSON body 베어러: login이 `accessToken`(15m)/`refreshToken`(30d, 회전)/`realtimeWebSocketUrl`을 반환한다(`server/Sources/MomoServer/Routes/DTOs.swift:41-58`, `AuthRoutes.swift:105`). 토큰은 DB `token` 테이블에 hash 영속 + revocation(MOMO-300). 웹은 이 토큰을 어디에 두는가가 D3.
   - Caddy는 `{$API_DOMAIN}`/`{$REALTIME_DOMAIN}` 2-site 구조로 보안 헤더(HSTS, X-Frame-Options DENY 등)를 이미 강제한다(`infra/prod/Caddyfile`). SPA 서빙은 site 추가로 해결 가능 — ADR-0002 레이어 경계 안이다.
   - realtime은 서버 소유 `realtimeWebSocketUrl` + 단기 연결 JWT(`POST /v1/auth/realtime-token`) 구조라, 웹의 centrifuge-js도 macOS의 centrifuge-swift와 같은 계약으로 붙는다. websocket은 쿠키가 아닌 토큰 인증이므로 rt. 서브도메인 교차 오리진이어도 문제없다.
5. **경계 유지**: 웹 v0는 ADR-0112의 **기본 모드만** 구현한다(개발자 모드·Work 상세·대시보드는 v1+). 파일(ADR-0113/0116 동결)·웹훅(0115)·presence(0104)·멀티 워크스페이스 rail(0117)은 각 게이트 뒤 — 웹이 이 결정들을 앞지르지 않는다.

## Options

### D1. 서빙 모델
- **A (권고) — 대표 도메인 1-site 추가, 같은 오리진 통합**: Caddy에 `{$APP_DOMAIN}`(워크스페이스 대표 URL, 예: `momo.example.com`) site를 추가해 정적 SPA를 서빙하고, 같은 site의 `/v1/*`를 api 컨테이너로 reverse_proxy한다. 브라우저 기준 SPA와 API가 같은 오리진 → CORS 불요·서버 무변경. realtime은 기존 `rt.` 유지(토큰 인증이라 교차 오리진 무해). `/v1/centrifugo/*` 엣지 403 규칙은 신규 site에도 동일 적용.
- B — API 도메인에서 SPA 서빙: `api.<domain>`이 웹 주소가 된다. 동작하지만 "API와 웹 표면의 도메인 분리 가능" 원칙(ADR-0002)과 주소 의미론을 훼손. **기각.**
- C — 분리 배포(Element식 정적 호스팅): CORS 미들웨어 신설 필요 + 셀프호스터 배포물 2배. 업계에서 마찰이 실증된 모델. **기각.**

### D2. 스택
- **A (권고) — TypeScript + Vite + React + centrifuge-js**: 전부 MIT/Apache(permissive 하드 룰 부합). centrifuge-js는 Centrifugo 공식 클라이언트로 recovery(offset/epoch) 계약이 centrifuge-swift와 동일. React는 Codex worker 숙련도·생태계·채용 가능성 최대 — worker가 goal 단위로 구현하는 우리 체제에서 가장 안전한 선택.
- B — Svelte/Solid: 번들·성능 우위는 실재하나 worker 산출물 품질 분산이 크고 생태계 이점이 v0 규모에서 무의미. **기각(v0).**
- C — Swift/WASM(MomoCore 공유): 계약 공유의 이상은 맞지만 SwiftWasm 생태계 성숙도·번들 크기·디버깅 비용이 과대. **기각.** 계약 공유는 D4(스펙 정본)로 달성한다.

### D3. 브라우저 인증 (토큰 보관)
- **A (권고, v0=내부 알파 한정) — 메모리 access + localStorage refresh + 강한 CSP**: 서버 무변경으로 즉시 성립(기존 login/refresh 회전 재사용). 약점은 XSS 시 refresh 탈취 — 완화책: 엄격 CSP(자체 오리진만, inline 금지), 토큰 회전(탈취 토큰은 1회 사용 시 revoke 경쟁), `token` 테이블 revocation. **공개 배포 전 B 승격을 게이트 조건으로 명시한다.**
- B (v1 승격 예약) — refresh를 httpOnly Secure SameSite=Strict 쿠키로: XSS 내성 상향. 대가: 서버에 쿠키 발급/CSRF 방어 경로 신설 + macOS(베어러)와 웹(쿠키) 이중 인증 표면 유지비. 내부 알파 단계에서 과설계라 v0 채택 안 함, **공개 알파 전 필수 승격**.
- C — localStorage에 access까지: 완화 장치 없음. **기각.**

### D4. 계약 정본화 (두 번째 클라이언트 문제)
- **A (권고) — 수기 OpenAPI 스펙 정본 + 생성 타입**: `docs/api/openapi.yaml`을 웹 v0 표면(login/refresh/join/roster/channels/messages/read-state/dms/approvals)부터 수기로 정본화하고, 웹은 openapi-typescript로 타입 생성, 서버와의 drift는 게이트 스크립트(응답 shape 대조)로 검증. MomoCore(Swift)는 기존대로 두되 스펙이 상위 정본이 된다.
- B — 서버 코드에서 스펙 자동 생성: Hummingbird 생태계의 OpenAPI 도구는 spec-first(swift-openapi-generator) 방향이라 기존 수기 라우트에 소급 적용하려면 서버 재작성 리스크. **기각(v0)** — 스펙 우선 이관은 ADR-0108(서버 스택 판정)에서 재검토.
- C — 문서 없이 수동 동기화: 이중 클라이언트에서 drift 사고 확정 경로. **기각.**

### D5. v0 스코프
- **A (권고) — "초대받은 사람이 브라우저로 합류해 대화한다"**: 초대 링크 합류(JoinRoutes 재사용) → 로그인 → 채널/DM 타임라인(읽기+작성, seq 기반 backfill) → unread/read-state(ADR-0109 계약) → 승인 카드(승인/거부) → realtime 구독(centrifuge-js recovery+REST 폴백). ADR-0112 기본 모드 문법만.
- B — macOS 풀 패리티(개발자 모드·Work 상세·디렉터리·설정 전부): 표면 4배, UX 정본(momo-main 트랙)과 충돌 위험. **기각(v0)** — v1+에서 UX 트랙과 합류.
- C — 읽기 전용 뷰어: 초대 관통 가치(합류→첫 대화)가 죽는다. **기각.**
- 명시적 non-goals(v0): 파일 업로드(0113/0116 게이트), 웹훅 UI(0115), presence 표시(0104), 멀티 워크스페이스 rail(0117 — 단 로컬 저장 모델은 "서버 URL+계정" 복수 전제로 설계), 브라우저 알림(0120과 합류해 v1), Electron 데스크톱, 오프라인 캐시.

## Decision (Proposed 권고안)

D1-A + D2-A + D3-A(공개 배포 전 B 승격 게이트) + D4-A + D5-A.
로드맵 반영 제안: 트랙 🌐 신설, 웹 v0를 iOS(M5) **앞에** 배치(성재 방향 확정 반영, 정본 반영은 momo-main 통합 시).

## 파생 배치 후보 (Accepted 후 momo-main이 티켓·패킷 발급, MOMO-389+)

| 후보 | 내용 | 프로파일 | 의존 |
|---|---|---|---|
| W-1 | `docs/api/openapi.yaml` v0(웹 표면 라우트) + 서버 응답 drift 게이트 스크립트 | docs/python | 없음 |
| W-2 | `clients/web` 스캐폴드(Vite+React+TS+centrifuge-js) + 로그인/타임라인 읽기 — e2e compose 대상 | **web(신설 게이트)** | W-1 |
| W-3 | Caddy `{$APP_DOMAIN}` site + compose 정적 서빙 + CSP/보안 헤더 | infra | 없음 (W-2와 병렬) |
| W-4 | 작성/read-state/승인 카드 + realtime 구독·recovery·REST 폴백 왕복 | web | W-2 |
| W-5 | 초대 링크 웹 합류 흐름(JoinRoutes) — ADR-0121 universal link와 합류 | web | W-2, W-3 |

게이트 노트: worker 게이트 프로파일에 `web`(node 기반 lint/test/build + playwright smoke) 신설이 필요하다 — 티켓 발급 시 `LOCAL_PR_GATE.md` 갱신을 W-2에 포함.

## Consequences

- (+) 초대 링크의 무설치 관통이 성립 — 멤버 확보 파이프라인의 최대 마찰 제거. "서버 URL = 웹 주소"가 자연 성립.
- (+) 같은 오리진 설계로 CORS·쿠키·CSRF 표면을 v0에서 원천 회피 — 서버 코드 무변경으로 시작.
- (+) UX/UI 트랙(momo-main·성재)과 파일군 완전 분리(`clients/web`/`infra`/`docs/api` vs `clients/macOS`) — 병렬 안전.
- (−) 두 번째 클라이언트의 계약 유지비 발생 — D4 스펙 게이트가 상쇄 장치. 스펙과 서버의 괴리는 게이트 FAIL로 드러나게 한다.
- (−) 웹 게이트 인프라(node/playwright) 신설 비용 — worker 게이트 시간 증가 수용.
- (−) D3-A는 내부 알파 한정 보안 수준 — 공개 배포 전 B 승격이 조건부 부채로 남는다(게이트 조건 명문화).
- 보류: 웹 개발자 모드·Work 상세(v1, UX 트랙 합류 후), 브라우저 알림(ADR-0120 랜딩 후), PWA 설치성(검토만).
