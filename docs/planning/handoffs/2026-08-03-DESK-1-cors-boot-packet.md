# goal DESK-1 — 데스크탑이 서버에 못 닿는다(CORS 부재) + 부팅 30초 지연

너는 momo(제품명 oort) 레포의 구현 worker다. 이 문서가 유일한 지시서.
**base = `track/engine`**. 워크트리 `~/projects/momo-tracks/momo-worktrees/DESK-1-cors-boot`(브랜치 `feat/DESK-1-cors-boot`, 생성됨).

발단: 성재가 실제 데스크탑 앱(`~/Desktop/oort.app`, Tauri 셸 + 웹 번들)으로 검수를 시작했고 **로그인이 아예 안 된다**. 폰(RN)과 웹은 정상이다.

## 0. 오케스트레이터 실측 (여기서 출발해라)
- 증상: 연결 화면에서 **"서버에 닿지 못했습니다"**(= `NetworkError`). 주소 `https://app.oor7.com`, 워크스페이스 UUID 정상 입력.
- **원인 확정 — 서버에 CORS 가 없다.**
  ```
  curl -H "Origin: tauri://localhost" https://app.oor7.com/healthz   → 200, Access-Control-* 헤더 0개
  curl -X OPTIONS -H "Origin: tauri://localhost" …/v1/auth/login      → 405 (preflight 미지원)
  ```
  `grep -rn "CorsLayer\|Access-Control" server-rust/bins/momo-server/src/` → **0건**. 웹 배포는 same-origin 이라 CORS 가 필요한 적이 없었고, 그래서 아무도 못 봤다. 데스크탑 웹뷰는 `tauri://localhost` 오리진이라 교차 출처다.
- **부팅 30초 지연**은 별건이다. 업데이터 엔드포인트는 **0.04초**(200)라 범인이 아니다. 연결 화면에 mDNS 발견 결과(`MacBook-Pro-2.local:28000`)가 뜨는 것으로 보아 **mDNS 탐색이 유력한 용의자**다 — 확인해라, 믿지 마라.

## 1. 규율
`.env`·자격증명 금지 · **`schema_v0.sql` 금지** · **docker 금지**(배포는 오케스트레이터) · **`clients/mobile` 수정 금지**(검수 중이다) · `packages/momo-core` 는 읽기 우선 · 커밋은 새 커밋만 · **PR 후 STOP**.
**비밀번호·이메일 같은 실제 자격증명을 레포에 커밋하지 마라.** 3번은 **환경변수 경유**다.

## 2. 할 일

### 2-1. CORS — 서버(Rust)에 추가
- **허용 오리진을 열어두지 마라.** `tauri://localhost`·`http://tauri.localhost`(+ 필요하면 `https://tauri.localhost`)처럼 **명시 목록**이어야 하고, 운영 env 로 확장 가능해야 한다. `*` 는 금지다.
- **preflight(`OPTIONS`)를 처리**해야 한다(지금 405).
- 허용 헤더에 우리가 실제로 쓰는 것(`content-type`, `authorization`, 그리고 코드가 쓰는 커스텀 헤더 전부 — **찾아서** 넣어라)만.
- 자격증명 모드: 우리는 **Bearer 토큰**이고 쿠키가 아니다. `Allow-Credentials` 가 정말 필요한지 확인하고, 필요 없으면 켜지 마라(켜면 `*` 와 함께 못 쓰고 공격 표면이 는다).
- **Centrifugo 는 별건이다.** WebSocket 은 이미 `allowed_origins` 로 따로 통제되고, 데스크탑은 `tauri://localhost` 를 보낸다 — 그 목록에 이미 들어 있는지 **확인만** 하고 서버 설정 파일은 바꾸지 마라(오케스트레이터가 배포한다). 결과를 PR 에 적어라.
- **red test**: 허용 오리진이면 헤더가 붙고, **모르는 오리진이면 안 붙는다**. preflight 가 200 이고 필요한 메서드·헤더를 광고한다. 되돌리면 빨개지게.

### 2-2. 부팅 30초 지연
연결 화면이 뜨기까지 **약 30초** 스켈레톤이 유지된다(성재 실측, 재현 스크린샷 있음).
- 원인을 **코드로** 밝혀라. mDNS 탐색이 유력하지만 단정하지 마라 — 부팅 경로에서 무엇이 언제 완료되는지 실제로 재라.
- **화면을 무엇도 기다리게 하지 마라.** 발견 결과는 **오면 나타나는** 것이지 화면을 붙잡을 이유가 없다. 시간 예산을 넣더라도 **UI 는 즉시** 서야 한다.
- 고친 뒤 **부팅→연결 화면 시간을 측정**해서 적어라(전/후).

### 2-3. 테스트 기간 한정 로그인 프리필 (성재 요청)
> "지금은 테스트 기간이니까 저거 그대로 넣어주고, 로그인 버튼만 누르면 로그인 되게 해줘"

- **자격증명을 소스에 넣지 마라.** 빌드 타임 env(`VITE_…`)로 읽고, **값이 없으면 아무것도 프리필하지 않는다**(=기본 배포는 지금과 동일).
- 프리필이 켜졌을 때 화면에 **그 사실이 보여야 한다**(예: "테스트 프리필" 표식). 조용히 채워진 비밀번호는 나중에 사고가 된다.
- **프로덕션 웹 배포 경로에 영향 0** 이어야 한다 — 웹 `dist` 는 이 env 없이 빌드된다.
- 어느 env 이름을 읽는지 **README 에 적어라**(값은 적지 마라).

## 3. 검증
- CORS: 위 red test + `cargo check/test/fmt/clippy`.
- 데스크탑: `npx @tauri-apps/cli build --no-bundle` 가 서는지(번들·서명은 오케스트레이터).
- **회귀 0**: `clients/web`(`test`·`build`) · `packages/momo-core`(`test`·`gate:purity`) 수치 불변. `clients/mobile` 은 손대지 않았으니 확인만.
- 부팅 시간 전/후 수치.

## 4. PR
`feat/DESK-1-cors-boot` → `track/engine`. 본문에: CORS 허용 목록과 근거·Centrifugo 확인 결과·30초 원인 규명과 전후 수치·프리필 env 이름과 안전장치·이탈. **PR 후 STOP.**
