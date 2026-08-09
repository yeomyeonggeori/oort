# goal B11 — 메시지 액션 (QA H3: 답글·반응·수정·삭제)

너는 momo 레포의 구현 worker다(Claude Opus 5). 이 문서가 유일한 지시서.
**base = `track/engine`**(`47094c60`). 워크트리 `~/projects/momo-tracks/momo-worktrees/B11-message-actions`(브랜치 `feat/B11-message-actions`, 생성됨).

발단: 실사용 QA에서 **메시지에 아무 액션이 없다**(H3). 보낸 뒤 답글도 반응도 수정도 삭제도 불가 — 메신저로서 기본선 미달.

## 0. 규율
`.env` 금지 · **PR 후 STOP**(amend/force-push 금지) · **docker 검증 금지**(서버측 실DB 테스트는 `#[ignore]`, 게이트는 오케스트레이터) · **Swift 실측 = 서버 계약의 정답** · route에 raw SQL 0(도메인 crate 경유) · **새 마이그레이션 금지** · taste 스킬 준수(UI).

## 1. 사실관계 (오케스트레이터 실측 — 여기서 출발해라)
- 스키마에 **이미 있다**: `reaction(id, workspace_id, message_id, member_id, emoji, created_at, UNIQUE(message_id, member_id, emoji))`, `thread(root_id, workspace_id, channel_id, reply_count, last_reply_seq, last_reply_at, participant_ids)`, `message.root_id/reply_to_id/edited_at/deleted_at`. → **마이그레이션 불요.**
- Swift 정본 `server/Sources/*/Routes/MessageRoutes.swift`의 8개 중 Rust에 이식된 것은 **3개뿐**(send·history·replies). 미이식 5개가 이번 범위:
  | Swift | 상태 |
  |---|---|
  | `PATCH /v1/workspaces/:ws/messages/:id` (edit) | 미이식 |
  | `DELETE /v1/workspaces/:ws/messages/:id` (delete) | 미이식 |
  | `PUT /v1/workspaces/:ws/messages/:id/reactions/:emoji` | 미이식 |
  | `DELETE /v1/workspaces/:ws/messages/:id/reactions/:emoji` | 미이식 |
  | `GET /v1/workspaces/:ws/channels/:ch/reactions` (snapshot) | 미이식 |
- Rust 라우터 등록부 = `server-rust/bins/momo-server/src/lib.rs`, 메시지 도메인 = `crates/momo-messaging/src/message.rs`.

## 2. 할 일

### 2-1. 서버 (파리티 이식)
위 5개를 **Swift 구현을 읽고 계약을 그대로** 이식한다. 상태코드·에러 코드·응답 봉투·권한 규칙(누가 수정/삭제 가능한지)·soft delete 여부·반응 스냅샷 응답 형태 전부 Swift가 정답이다. 임의로 개선하지 말고, Swift가 틀렸다고 판단되면 **이탈 섹션에 근거와 함께 적고** 그 판단을 PR 본문에 남겨라.

불변식(하나도 못 깬다):
1. **단일 쓰기경로** — REST→PG→outbox. 실시간 통지는 직접 publish가 아니라 **`emit_outbox()` chokepoint 경유**, 메시지 write와 **같은 트랜잭션**.
2. **gapless `message.seq`** — 수정/삭제/반응은 **새 seq를 소비하지 않는다**(Swift 실측으로 확인 후 그대로). 채널 seq 카운터를 건드리면 안 된다.
3. **RLS FORCE** — 모든 접근은 `with_tenant_tx()` 안에서. 라우트에서 직접 SQL 금지.
4. **에이전트 = member 무분기** — 사람/에이전트 구분 없이 같은 경로로 반응·답글이 가능해야 한다.
5. 반응 emoji 입력 검증(길이 상한·제어문자 배제). UNIQUE 충돌 = 멱등 성공(중복 PUT이 500이 되면 안 됨).

### 2-2. 클라이언트 (`clients/web`)
1. **메시지 액션 바** — 데스크탑=hover, **모바일=long-press**(터치에서 hover는 존재하지 않음. B9 모바일 정밀화 기조 유지). 액션: **답글 · 반응 · 수정 · 삭제**. 수정/삭제는 **본인 메시지만** 노출(서버가 정본, 클라는 노출 제어).
2. **반응 표시·토글** — 메시지 하단 반응 칩(이모지+카운트), 내가 누른 건 강조. 클릭 = 토글. 자주 쓰는 이모지 몇 개 + 나머지 선택 경로. 낙관적 반영 후 실시간/응답으로 수렴(실패 시 되돌리고 사용자 문장으로 알림 — B8의 오류 은닉 원칙 준수: 내부 코드·raw JSON 노출 금지).
3. **답글(스레드)** — `GET .../messages/{root}/replies`는 **이미 이식돼 있다**. 답글 작성→스레드 열람 경로를 배선. 목록에는 `threadRollup`(이미 `clients/web/src/lib/api.ts`에 존재) 활용해 "답글 N개" 표시.
4. **수정/삭제 표시** — 수정된 메시지는 "(수정됨)", 삭제는 tombstone(“삭제된 메시지”)로. 목록에서 조용히 사라져 seq 구멍처럼 보이게 하지 마라.
5. **접근성·터치** — 액션 버튼 44px 터치 타깃, 키보드 도달 가능, 스크린리더 라벨. 가로 스크롤 유발 금지(B9 게이트가 잡는다).

## 3. 하지 말 것
H1 미이식 표면 정직화·H5 검색 UI(→ B12) · DM 무멘션 응답·M/L군(→ B13) · 새 마이그레이션 · 스키마 수정 · `schema_v0.sql` 수정/이동.

## 4. 검증·PR
- 서버: `cargo check` / `cargo test`(실DB 필요한 건 `#[ignore]`) / `cargo fmt --check` / `cargo clippy -- -D warnings`.
- 클라: `npm run build` + `tsc` + `test` + `lint` + preflight + **캡처**(액션 바·반응 칩·스레드·수정/삭제 표식, 데스크탑+모바일 폭 둘 다).
- PR `feat/B11-message-actions` → `track/engine`. 본문에 **Swift 계약 대조표**(엔드포인트별 상태코드·권한·응답), seq 미소비 근거, outbox 이벤트 종류, 이탈. **PR 후 STOP**(머지·close 금지).
