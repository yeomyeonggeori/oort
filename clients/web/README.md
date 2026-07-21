# momo web client (v0)

ADR-0119 W-2 (MOMO-391) 스캐폴드: 로그인 → 채널 목록 → 타임라인 읽기(seq
페이지네이션 + `?after=` backfill) → centrifuge-js 실시간 구독.
ADR-0119 W-4 (MOMO-400)가 대화 표면을 연다: 메시지 작성(clientMsgId 멱등),
read-state(unread 배지 + `user:read-state` 실시간), 승인 카드(ADR-0112 기본
모드), DM 목록/열기. ADR-0119 W-5 (MOMO-401)가 초대 링크 웹 합류를 연다:
`/join/<code>` 랜딩 → 공개 `POST /v1/join` → 세션 수립(아래 참조).

- 스택: Vite + React + TypeScript + centrifuge-js (전부 permissive 라이선스,
  ADR-0119 D2-A). 상태관리 라이브러리 없음(v0 규모에서 불필요).
- 서빙: 같은 오리진 배포(D1-A). Caddy `{$APP_DOMAIN}` site가 이 앱의 `dist/`를
  정적 서빙하고 같은 오리진의 `/v1/*`를 api로 프록시한다(`infra/prod/Caddyfile`).
  CORS 없음, 서버 코드 무변경.
- REST 계약: `docs/api/openapi.yaml`이 정본. `src/api/schema.d.ts`는
  `npm run gen:api`(openapi-typescript)로 생성해 **커밋**한다 — web 게이트가
  스펙과의 동기화를 diff로 강제한다.

## 서버 연결

첫 화면에서 서버 URL을 입력하면 로그인 전에 `GET /health`를 확인하고
`localStorage`에 저장한다. 원격 서버는 HTTPS만 허용하며 로컬 개발은
`http://localhost`와 loopback 주소를 예외로 허용한다. access token은 서버 URL과
함께 저장되지 않고 계속 메모리에만 존재한다. 초대 코드는 URL이나 로그에 넣지
않고 메모리에서 가입 폼으로 전달한다.

## 토큰 정책 (ADR-0119 D3-A — 내부 알파 한정)

| 항목 | v0 (현재) |
|---|---|
| access token (15m) | **메모리 전용** — 어디에도 저장하지 않음 |
| refresh token (30d, 단일사용 회전) | `localStorage` (`momo.web.session.v1`) |
| 로그아웃 | 서버 revoke(`POST /v1/auth/logout`, access+refresh) 후 로컬 삭제 |
| 세션 복원 | 저장된 refresh 1회 회전(`POST /v1/auth/refresh` → 새 쌍 발급, 기존 revoke) |
| XSS 완화 | 엄격 CSP(자체 오리진만, inline script/style 금지) + 토큰 회전 + 서버측 revocation |

### 공개 배포 전 승격 게이트 (필수, ADR-0119 D3-B)

**이 저장 모델은 내부 알파 전용이다.** momo 웹을 내부 알파 밖(공개 알파 포함)
어떤 대상에게든 배포하기 전에, 아래를 완료해야 한다:

1. refresh token 보관을 `localStorage`에서 **httpOnly Secure SameSite=Strict
   쿠키**로 승격한다(서버에 쿠키 발급 경로 + CSRF 방어 신설 필요 — 서버 측
   변경은 별도 ADR-게이트 티켓).
2. `src/auth/session.ts`의 localStorage 사용을 제거하고 이 README의 표를 갱신한다.
3. 승격 전 배포는 **금지**다. 이 항목이 남아 있는 한 `clients/web`은 공개
   배포 게이트를 통과하지 못한 상태로 간주한다.

이 섹션이 승격 게이트의 정본이다(코드 주석이 아니라 여기).

## 초대 링크 웹 합류 (`/join/<code>`, MOMO-401 — ADR-0119 W-5 / ADR-0121 D2-B)

- 링크 형태는 D2-B(서버 자체 도메인): `https://<APP_DOMAIN>/join/<code>`.
  MOMO-390의 SPA 폴백(try_files)이 딥링크를 서빙한다. Dawn 단축 링크(S-4)와
  앱 딥링크는 범위 밖.
- **초대 코드는 bearer secret이다.** `App.tsx`가 모듈 로드 시 경로 세그먼트에서
  코드를 1회 캡처한 즉시 `history.replaceState`로 주소창을 `/`로 치환한다 —
  코드는 브라우저 히스토리에 남지 않고, 이후 어떤 요청 URL·로그에도 실리지
  않으며, `POST /v1/join` 요청 body로만 서버에 전달된다.
- **가입 성공(201 신규 / 200 기존 재합류) = 로그인이다.** 정본 스펙
  (`docs/api/openapi.yaml` `JoinResponse`)이 `accessToken`/`refreshToken`/
  `realtimeWebSocketUrl`을 **required**로 정의하므로("issuing a session token
  pair"), join 응답의 토큰 쌍으로 즉시 세션을 수립하고 채팅 표면으로 진입한다.
  이는 스펙을 앞지르는 자동 로그인이 아니라 스펙 그 자체다. 별도
  `POST /v1/auth/login` 왕복은 없다.
- 초대 오류는 서버 오류 envelope 기반으로 구분된 한국어 카피를 렌더한다:
  스펙 정본 상태코드(404 무효 / 409 소진·중복 redeem / 410 만료·회수 / 403
  가입 불가)를 1차 키로, 410·409의 이중 의미는 envelope의 안정 메시지
  (`JoinRoutes.swift`)로 분리한다. 미인식 409/410 메시지는 특정 원인을 주장하지 않는 결합 카피로
  폴백하며 영문 서버 문자열을 그대로 노출하지 않는다. 이미 redeem한 계정에는
  로그인 폼(이메일 프리필) 연결을 제안한다.
- 알려진 한계(v0): 로그인된 세션이 있는 상태에서 `/join/<code>`를 열면
  세션이 우선한다(코드는 주소창에서 제거되고 무시된다). 로그인 상태의 재합류
  UX는 후속 판단.

### 알려진 한계 (v0)

- **멀티 탭 refresh 회전 경쟁**: refresh token은 단일사용이라 두 탭이 동시에
  회전을 시도하면 한쪽이 revoked 토큰을 제시해 세션이 끊길 수 있다. 탭 내
  동시 요청은 single-flight로 직렬화했지만 탭 간 조정(BroadcastChannel/
  Web Locks)은 미구현 — 내부 알파에서 실제로 문제가 되면 이탈 보고 후 후속
  티켓으로 다룬다(핸드오프 패킷 §9의 열린 질문).
- **낙관적 렌더링 없음(v0 의도)**: composer는 서버 echo(POST 201 응답/
  브로드캐스트/backfill)만 렌더한다. 실패한 전송은 같은 `clientMsgId`로
  재시도하고, 본문을 고치면 새 키를 만든다. 오프라인에서는 입력과 전송을
  비활성화하되 기존 타임라인은 유지한다.
- 승인 카드는 `props.approval_status`, decision receipt, `approval.*` 실시간
  이벤트를 한 상태로 합친다. `resume_offer`는 웹에서 결정하지 않고 데스크톱
  재개 안내만 표시한다.
- 파일/웹훅/presence/멀티 워크스페이스 rail 비구현(각 ADR 게이트,
  ADR-0119 D5-A non-goals).

## 실시간 계약

- websocket 주소는 **login 응답의 `realtimeWebSocketUrl`만** 사용한다
  (ADR-0110). API 오리진에서 유추하지 않는다.
- 연결 토큰: `POST /v1/auth/realtime-token`(단기 JWT). 채널 구독은 클라가
  시도만 하고 Centrifugo subscribe proxy가 서버에서 멤버십/자격 liveness를
  재검증한다(MOMO-300).
- **websocket transport 전용**: 서빙 CSP가 `connect-src 'self'` +
  `wss://REALTIME_DOMAIN`만 허용한다. HTTP 폴백 transport를 추가하려면
  `infra/prod/Caddyfile` CSP와 `scripts/web_serving_smoke.sh` 기대값을 같은
  PR에서 갱신해야 한다(가능하면 피할 것).
- 순서 정본은 `message.seq`. 구독 확립 시(`recovered:false` 포함) REST
  `?after=<seq>` backfill로 갭을 메운다 — Centrifugo history는 편의,
  Postgres가 권위다.
- 구독 채널명은 `ch:ws<WORKSPACE_UUID>.<CHANNEL_UUID>` **대문자** UUID
  (relay가 Swift `uuidString`으로 publish하고 Centrifugo 채널명은 대소문자
  구분). REST가 주는 소문자 id는 클라에서 대문자로 정규화한다. UUID 비교는
  항상 case-insensitive(`uuidEq`).
- read-state 개인 채널은 `user:read-state#<MEMBER_UUID>` — member-id 표기의
  정본은 서버가 outbox에 굽는 채널명이다:
  `server/Sources/MomoServer/Routes/ReadStateRoutes.swift:227`
  (`personalChannel`, Swift `uuidString` = **대문자**). Centrifugo
  user-limited 채널은 `#` 뒤가 연결 JWT `sub`와 byte-match해야 하는데 그
  `sub`도 대문자 `uuidString`이다
  (`server/Sources/MomoServer/Auth/JWT.swift:172`). 그래서
  `readStateChannelName`은 member id를 `toUpperCase()`한다.
- read-state cursor는 단조 전진: 서버가 `max(current, min(requested,
  latestSeq))`로 보장하고, 클라(`src/state/readStates.ts`)도 후퇴 PUT을
  보내지 않는다. 50% 이상 보이는 메시지 중 가장 높은 seq를 300ms debounce로
  전송한다. 비활성 채널 `message.new`는 배지를 즉시 갱신하고 REST projection을
  다시 조회한다. unread 계산의 최종 권위는 서버 projection이다.
- recovery 실패(`recovered:false`)나 seq gap은 현재 메시지를 지우지 않고
  `?after=<seq>` REST 페이지로 복구한다. 같은 seq는 하나로 합치고 순서를
  보존한 뒤 대기 중인 실시간 이벤트를 재생한다.

## 개발

```bash
# 저장소 루트: 격리 로컬 서버 준비(실행은 오케스트레이터 게이트에서 수행)
docker compose -f infra/docker-compose.e2e.yml up -d --wait

cd clients/web
npm ci
npm run dev            # http://localhost:5173, /v1 -> 127.0.0.1:8080 프록시
                       # (MOMO_DEV_API_URL로 대상 변경)
npm run lint
npm run test           # Vitest: 그룹핑/reducer·토큰 회전·멘션 판정
npm run typecheck
npm run gen:api        # docs/api/openapi.yaml -> src/api/schema.d.ts (커밋 대상)
npm run build          # dist/ (Caddy가 서빙; inline script/style 금지 유지)
npm run check:licenses # permissive-only 라이선스 게이트 + 인벤토리 출력
```

개발 화면의 서버 입력값은 `http://localhost:5173`로 둔다. Vite가 `/health`와
`/v1` 요청을 `MOMO_DEV_API_URL`(기본 `http://127.0.0.1:8080`)로 프록시하므로
CORS 설정은 필요 없다. 작업이 끝나면 위 compose 프로젝트는 오케스트레이터가
내린다.

- `node_modules/`, `dist/`는 커밋 금지(루트 .gitignore), `package-lock.json`은
  커밋한다.
- 새 의존성 추가 시: permissive(MIT/Apache/ISC/BSD)만. GPL/AGPL 등 카피레프트
  유입 금지(하드 룰). `npm run check:licenses`가 게이트에서 강제한다.
- 스타일은 `src/styles.css` 단일 파일. **inline style/style attribute 금지**
  (CSP `style-src 'self'`가 런타임에서 차단한다).

## 게이트

```bash
scripts/local_gate.sh --profile web
```

단계 상세와 스모크 격리 규칙(전용 compose 프로젝트 `momo391web`, 루프백 포트
18990-18995, 자기 것만 정리)은 `docs/LOCAL_PR_GATE.md`의 "Web client gate"
섹션 참조. 브라우저 스모크는 실제 prod Caddyfile(엄격 CSP) 뒤에서 Chromium으로
로그인 → 타임라인 표시 → 실시간 수신에 더해(MOMO-400) 작성 멱등(동일
clientMsgId 재전송 → DOM/REST 각 1건), read-state 반영(외부 cursor PUT → user
채널 push로 배지 갱신, 브라우저 PUT 단조성), 승인 왕복(승인 200 receipt +
타 기기 선결정 409 receipt의 카드 전이), DM 열기/왕복까지 검증하고,
(MOMO-401) 초대 웹 합류 — REST 초대 발급 → `/join/<code>` 딥링크(주소창
코드 제거) → 가입 → JoinResponse 토큰 쌍으로 타임라인 진입 → 로그아웃 →
생성 자격증명 재로그인, 만료/소진/무효 코드의 구분 카피, 코드의 요청
URL·콘솔 비유출 — 까지 검증한다.
