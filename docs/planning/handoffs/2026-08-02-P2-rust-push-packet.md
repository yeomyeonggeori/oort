# goal P2 — 푸시 체인 Rust 이식 (devices 라우트 + notifier + APNs 발송)

너는 momo(제품명 oort) 레포의 구현 worker다. 이 문서가 유일한 지시서.
**base = `track/engine`**. 워크트리 `~/projects/momo-tracks/momo-worktrees/P2-rust-push`(브랜치 `feat/P2-rust-push`, 생성됨).

발단: #837 게이트 4 감사가 **"Rust 서버에 APNs 코드 0줄, devices 라우트 없음"**을 실측했다. 클라이언트 NSE가 완벽히 생존해도 **그것을 깨울 주체가 Rust 경로에 없다.** 서버는 Swift→Rust 이식 중(ADR-0145)이므로 이 공백은 닫혀야 한다.

## 0. 규율
`.env`·자격증명 금지(파일명 출력도) · **docker 실행 금지**(실DB 테스트는 `#[ignore]`, 게이트는 오케스트레이터) · route에 raw SQL 0(도메인 crate 경유) · **새 마이그레이션 금지**(010/011이 이미 있다 — 아래) · `schema_v0.sql` 수정/이동 금지 · **Swift 실측 = 계약의 정답** · 커밋은 새 커밋만 · **PR 후 STOP**.
**실제 APNs로 발송하지 마라.** 인증 키가 없고 있어서도 안 된다. 전송 계층은 주입 가능하게 만들고 테스트는 목으로 한다.

## 1. 실측된 현재 상태 (오케스트레이터·감사 확인)
- **스키마는 이미 있다**: `server/Migrations/010_push_registration.sql`, `011_push_notifier.sql`. → **새 마이그레이션 불요.**
- **Swift 정본**:
  - 디바이스 등록 REST `POST/GET/DELETE /v1/workspaces/:ws/devices` — `server/Sources/MomoServer/Routes/DeviceRoutes.swift`(504줄).
  - 발송 체인 `Swift NotifierWorker ──HTTP POST /v1/push──▶ Swift PushRelay ──HTTP/2──▶ APNs`.
  - APNs 발송 실체 `relay/PushRelay/Sources/PushRelay/APNSSender.swift` — `api.push.apple.com`으로 HTTP/2 POST, **ES256 JWT provider token**. 엔드포인트 상수는 `Config.swift`.
  - 페이로드 구성 `relay/PushRelay/Sources/PushRelay/PushDispatch.swift:101-165`의 `APNSPayload`.
- **Rust 쪽**: `bins/momo-server/src/routes/mod.rs`가 나열하는 28개 라우트 모듈에 `devices`·`push` **없음**. `momo-notifier`는 "push-candidate drain은 여기 없다, 별도 배치"라고 스스로 명시(의도된 미완).
- 참고: 마이그레이션 011의 `push_candidate_enqueue_trg`가 메시지 insert 시 발화한다(B1 배치에서 실측된 사실 — outbox 오라클이 이 때문에 kind 필터를 넣었다).

## 2. 할 일

### 2-1. 먼저 읽어라 (추측 금지)
Swift `DeviceRoutes.swift`·`PushDispatch.swift`·`APNSSender.swift`·`Config.swift`와 마이그레이션 010/011을 **직접 읽고** 계약을 표로 정리한 뒤 이식해라. 상태코드·응답 봉투·권한·중복 등록 처리·토큰 갱신·디바이스 폐기 규칙 전부 Swift가 정답이다. Swift가 틀렸다고 판단되면 **이탈 섹션에 근거와 함께** 적고 판단을 PR 본문에 남겨라.

### 2-2. devices 라우트 이식
`POST/GET/DELETE /v1/workspaces/{ws}/devices`를 Rust로. 도메인 로직은 적절한 crate에(신규 모듈이 필요하면 만들되 **새 crate를 만들면 `server-rust/Dockerfile`의 매니페스트 목록에 반드시 추가**해라 — B1.7에서 이걸 빠뜨려 옛 이미지가 배포된 전례가 있다).

### 2-3. push candidate drain + 발송 경로
`push_candidate`(011)를 소비해 APNs로 보내는 경로를 이식해라.
**불변식(하나도 못 깬다)**:
1. **id-only 페이로드** — ADR-0120 D2-A: **대화 내용이 우리 인프라를 지나지 않는다.** 페이로드에 본문·발신자 이름 등 내용이 들어가면 이 설계의 존재 이유가 사라진다. Swift `APNSPayload` 실측을 그대로 따르고, **내용이 새지 않음을 테스트로 못박아라**(이게 이 배치의 red test 1번이다).
2. **RLS FORCE** — 모든 DB 접근은 `with_tenant_tx()` 경유. 단 drain 소비자는 워크스페이스 술어가 없는 claim이므로 **`momo_worker`(BYPASSRLS) 포스처**가 맞는지 기존 워커(`momo-agent-worker`·`momo-notifier`)가 어떻게 하는지 보고 **같은 관례**를 따라라.
3. **멱등** — 같은 후보가 두 번 발송되지 않는다. 기존 워커의 리스/클레임 관례(008 리스 재사용 등)를 따라라.
4. **자격증명은 코드·레포에 없다** — APNs 키는 런타임 env/파일 주입. 키가 없으면 **부팅 거부 또는 명시적 비활성**(조용히 성공한 척하지 마라). 어느 쪽인지 판단하고 근거를 적어라.
5. **전송 계층은 주입 가능해야** 한다(테스트에서 목으로 교체). 실제 HTTP/2 발송은 오케스트레이터/성재가 실 키로 확인한다.

### 2-4. 테스트 (red test 규율)
각 성질마다 **되돌리면 빨개지는 이름 있는 단정**을 붙여라. 최소:
- 페이로드에 **대화 내용이 없다**(id-only) — 가장 중요
- 같은 후보가 두 번 발송되지 않는다(멱등)
- 다른 테넌트의 디바이스로 새지 않는다
- APNs 키 부재 시 조용히 성공하지 않는다
- 디바이스 등록/조회/삭제의 Swift 계약 파리티
실DB가 필요한 것은 **`#[ignore]`**로 달아라(오케스트레이터가 docker 게이트에서 돌린다). 파일 상단에 실행 커맨드를 주석으로 남기는 기존 관례를 따라라.

## 3. 하지 말 것
새 마이그레이션 · 실제 APNs 발송 · FCM/Android 경로(**보류 결정**) · RN 스캐폴드(`clients/mobile-spike/`) 진입 · 웹 클라이언트 수정 · docker 실행.

## 4. 검증·PR
`cargo check` / `cargo test`(실DB는 `#[ignore]`) / `cargo fmt --check` / `cargo clippy -- -D warnings`. 새 crate를 만들었으면 **Dockerfile 매니페스트 목록 갱신 확인**.
PR `feat/P2-rust-push` → `track/engine`. 본문에 **Swift 계약 대조표**·id-only 근거·워커 포스처 선택 근거·키 부재 시 동작 판단·이탈. **PR 후 STOP.**
