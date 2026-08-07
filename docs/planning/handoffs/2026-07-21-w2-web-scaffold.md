# W-2 핸드오프: clients/web 스캐폴드 — 로그인 + 채널 목록 + 타임라인 읽기 (ADR-0119)

> 발급: 2026-07-21 Fable (성재 우선순위 1 — 웹 트랙 실행 재개). 정본: ADR-0119(Accepted — D1~D5 전체), 진단 docs/planning/2026-07-21-opensource-cowork-diagnosis.md §1.
> 트랙: 엔진/인프라(0119 명시 — Fable momo-main 겸임 위임 범위) · base = main · PR base = track/engine · 도메인 = **clients/web(신설)** — 기존 파일군과 충돌 0.

## 목표
oort의 세 번째 클라이언트: 브라우저에서 서버 URL 입력 → 로그인 → 채널 목록 → 타임라인 읽기(read-only v0). "서버 URL이 곧 웹 주소"(0119)의 첫 실행.

## 스택 (0119 D2-A 고정 — 변경 금지)
TypeScript + Vite + React + centrifuge-js. 전부 MIT/Apache. 상태관리는 v0 최소(React Query 권장, Redux 금지). CSS는 라이트/다크 대응 CSS 변수 — 디자인 토큰은 macOS Theme의 시맨틱 이름을 따른다(`--color-accent`, `--color-bg-primary` 등. AI-slop 그라데이션 금지, momo-design-taste §0/§3 준수).

## 구현 범위
1. **`clients/web/` 스캐폴드**: Vite+React+TS 프로젝트, `npm run dev/build/test/lint`. openapi-typescript로 `docs/api/openapi.yaml`에서 타입 생성(`npm run gen:api` — 생성물 커밋).
2. **서버 연결 화면**: 서버 URL 입력(https 강제, localhost 예외) → `/health` 확인 → 저장(localStorage). iOS LoginView와 같은 문법(서버/이메일/비밀번호/초대 코드 optional).
3. **로그인**: `POST /v1/auth/login` → access는 메모리, refresh는 localStorage(0119 D3-A — 내부 알파 한정, 코드 주석에 공개 전 httpOnly 승격 게이트 명시). refresh 회전(`/v1/auth/refresh`) 자동 — 401 시 1회 갱신 후 재시도.
4. **채널 목록**: `GET /v1/workspaces/:ws/channels` — unread/mention 뱃지, 음소거 아이콘(muted 투영). 워크스페이스 헤더.
5. **타임라인 읽기(v0 read-only)**: `GET .../messages?limit=200` + 과거 cursor 페이지네이션. 렌더 패리티: 저자 그룹핑(5분 창=300000ms, iOS와 동일 로직), 날짜 구분선, edited 배지, tombstone("메시지 삭제됨"), 코드블록(가로 스크롤)·링크, `props.mention_member_ids` 기반 내 멘션 하이라이트(accent 10% 배경), 반응 pill(GET .../reactions 스냅샷, read-only).
6. **realtime**: centrifuge-js — `POST /v1/auth/realtime-token` → `realtimeWebSocketUrl` 연결, `message.new/edited/deleted`·`reaction.added/removed` 소비(콜드 로드 중 버퍼링 — iOS IOSTimelineModel.load()의 버퍼 패턴 준수). recovery(offset) 사용.
7. **상태 4종**: 각 표면 empty/loading/error/offline — 에러는 무엇이 실패했고 뭘 하면 되는지(재시도 버튼), 토큰 만료 시 기존 메시지 유지+인라인 배너(MOMO-514 교훈 — 전체 화면 대체 금지).

## 하드 경계
- 컴포저/전송·승인·Work 표면은 범위 밖(W-4+). 쓰기 요청은 read-state 갱신(`PUT .../read-state`)만 허용.
- 서버/스키마/Caddy 수정 금지(Caddy 서빙은 W-3 별도). CORS 필요 없게 dev는 Vite proxy(`/v1`→서버)로.
- 시크릿/토큰을 URL·로그에 남기지 않는다. 콘솔 로그에 메시지 본문 금지.

## 수용 기준
- `npm run build` 성공 + `npm run test`(vitest — 그룹핑 리듀서·토큰 회전·멘션 판정 단위 테스트 ≥10) + `npm run lint`(eslint) PASS.
- 타입은 전부 생성 타입 소비 — `any` 금지(eslint 규칙).
- README: 로컬 서버(docker-compose.e2e) 상대로 dev 실행법.
- 실서버 육안(라이트/다크·한국어 장문·200+ 스크롤)은 오케스트레이터 게이트 — worker 범위 아님.

## 규율
- 커밋 자주. PR 생성 후 멈춤(base=track/engine). merge/close 금지. docker/브라우저 실행 금지(오케스트레이터). node_modules 커밋 금지(.gitignore). LOCAL_PR_GATE.md에 web 프로파일(npm lint/test/build) 초안 추가.
