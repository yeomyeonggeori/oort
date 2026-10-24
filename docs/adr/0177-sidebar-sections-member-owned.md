# ADR-0177: 사이드바 조직화 문법 — 멤버별 소유 섹션·별표

- 상태: **Accepted** (2026-09-01 성재 결재 — 기안 Fable)
- 발제: 2026-09-01 버즈 패리티 감사 사각지대 S1 (`docs/planning/research/2026-09-01-buzz-parity-audit.md` §3-S1·§4 순위 1)
- 증보: **2026-10-24 (#4226) DM 닫기를 서버에 두기·나간 멤버와의 대화는 기본으로 닫힘** (성재 「임시 처리하지말고 제대로 처리해서 이후에 실제 조직에서 적용해도 나간멤버때문에 불편함 겪지 않도록 해.」) — 파일 끝. D1~D5는 그대로다.
- 관련: ADR-0159(디자인 시스템) · BZ-1 사이드바 접기(#1870) · 우로보로스 인터뷰 interview_20260901_052920

## 맥락

사이드바 섹션이 `SidebarSectionId = "channels" | "dms"` 하드코딩 2종이라, 사용자가 접을 대상 자체를 만들 수 없다. 그 위에 BZ-1 접기·unread 집계·hover 액션·⌥↑↓ 순회가 이미 올라가 있어 **섹션이 데이터가 되는 시점이 늦을수록 그 전부를 다시 뜯는다**. buzz 실사: 섹션은 nip44 자기-암호화 개인 블롭을 릴레이로 로밍 동기화(`desktop/src/features/sidebar/lib/channelSectionsSync.ts`) — **순수 멤버별 소유이며 워크스페이스 공유 개념이 없다**(Slack 동형).

## 결정

- **D1 소유 = 멤버별.** 섹션·채널 배치·별표는 각 멤버의 사적 구성이다. 워크스페이스 공유 구조(관리자가 정한 공통 섹션)는 **v2 명시 보류** — 필요해지면 별도 ADR.
- **D2 저장 = 서버 member-scoped 로밍.** 신규 테이블 `member_sidebar_prefs`(workspace_id·member_id 유니크, `payload JSONB`, `updated_at`) — RLS `ws_isolation` 동일 적용, 단일 쓰기경로(REST→PG). 구조 데이터라 기기 로밍이 필요하므로 localStorage-only 기각. **outbox 이벤트 없음(v1)** — 자기 기기는 즉시 반영, 타 기기는 부트스트랩 GET으로 수렴(리마인더 #1888의 무-outbox 전례 동형).
- **D3 계약.** `GET/PUT /v1/workspaces/{ws}/members/me/sidebar-prefs`, `require_human`(에이전트 403 — 에이전트에 사이드바 없음). payload v1: `{version:1, sections:[{id,name,order,channelIds[]}], starredChannelIds[], sectionSort?}`. 서버는 형식·크기 상한만 검증(섹션 ≤50·이름 ≤80자·채널 참조 ≤500), **채널 membership은 검증하지 않는다** — 탈퇴·삭제된 채널 id는 클라가 표시 시점에 걸러낸다(관용적 계약, 경합 단순화).
- **D4 클라 통합.** 하드코딩 2종은 **기본 섹션**(채널·DM — 삭제 불가, 이름변경 불가)으로 남고, 커스텀 섹션이 그 문법에 합류한다. 배치되지 않은 채널은 기본 「채널」 섹션에 귀속. 접기 상태는 현행 localStorage 유지(기기별 — 접힘은 기기 성향, 구조는 로밍). 섹션 배치·별표·정렬의 파생 계산은 momo-core 단일점 함수로 — 웹·폰이 공유.
- **D5 페이징.** BT-4(골격: 서버+CRUD+배치+기존 접기/unread/hover 통합) → BT-5(상호작용: 별표 UI·A–Z/Recent 정렬·DnD 재정렬). D2 스키마는 별표까지 처음부터 수용.

## 기각 대안

- **워크스페이스 소유**: 훔치는 원본(buzz·Slack)이 멤버별이고, 공유 구조는 권한·충돌 설계가 별개 문제 — v2로.
- **localStorage-only**: 조직화 구조가 기기마다 다르면 "내 사이드바"가 성립하지 않는다.
- **정규화 테이블(섹션·배치 행 단위)**: v1 규모에서 JSONB 단일 행이 검증·마이그레이션·경합 전부 값싸다. 공유 구조가 생기는 v2에서 재평가.

## 영향·게이트

- 스키마: 신규 마이그레이션 1본(`member_sidebar_prefs` + RLS). `schema_v0.sql` 무접촉.
- 게이트: momo-core 파생 함수 테스트 + 크기 상한 red proof + 에이전트 403 시험. 기존 BZ-1 접기·unread 집계 회귀 금지.

## 증보 (2026-10-24, #4226) — DM 닫기를 서버에 두기, 나간 멤버와의 대화는 기본으로 닫힘

- 상태: **Accepted** (2026-10-24). 공개 API(새 라우트·읽음 투영 필드)·DB 계약(새 테이블·열·트리거)이 바뀌어서, ADR-0100에 따라 이 증보가 구현 머지 조건이에요.
- owner 원문:
  - 2026-10-24(폰 실기 캡처 — DM 목록 끝의 「나간 멤버와의 대화 1개」): 「나간 멤버와의 대화를 저렇게 지울 수도 없게해서 보여주는 이유가 있어? 그리고 모바일에서 멤버 꾹눌러서 채팅 나가는 기능도 포함할거지? 업데이트할때마다 나간멤버좀 그만뜨게 해. 임시 처리하지말고 제대로 처리해서 이후에 실제 조직에서 적용해도 나간멤버때문에 불편함 겪지 않도록 해.」
  - 2026-10-22: 「모바일 기준으로 아직도 나간 멤버나 kwak의 claude 같은게 있는데 정상이야 ? 그리고 모바잏에서는 다이렉트 메세지쪽 꾹 눌러서 제거하고 그런거 없어 ?」
  - 2026-10-20: 「나간 멤버랑 Claude Code X로 계속 제거하는데 왜 계속 뜨냐」
  - 위임(2026-10-22): 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」 — 아래 D6~D13의 세부는 planner 권장안이에요.
- 표기: [V] 직접 확인(track/engine `68e95f345`) · [확인 필요] · `runtime-unverified`.

### 확인한 사실 [V]

- **닫기는 기기 로컬이에요.**
  - 웹·데스크탑의 DM 닫기는 `localStorage` 키 `momo.web.sidebar-closed-dms.v1` 원장뿐이에요(`clients/web/src/features/sidebar/sidebarDmClosure.ts:71`).
  - 그래서 다른 기기, 데이터 초기화, 앱 재설치 뒤에는 도로 보여요.
  - 폰에는 닫기가 없어요.
- **#4252의 「나간 멤버」 규칙은 서버를 건드리지 않은 임시 규칙이에요**(`packages/momo-core/src/features/sidebar/goneDm.ts` 머리 주석이 스스로 그렇게 적어요).
  - 상대가 명부에 없고 안 읽은 것이 없으면 접고, 「나간 멤버와의 대화 N개」 줄로 세요.
  - 그 줄은 지울 수 없고 늘 남아요. owner가 지적한 화면이 이거예요.
- **되살림은 클라이언트가 메시지를 다시 읽어 판정해요**(`dmRevival.ts`, #4142).
  - 읽음 투영(`GET /v1/workspaces/{ws}/read-state`)의 `latest_seq`(`routes/read_state.rs:40`)는 기계 메시지까지 센 수예요. 그래서 「사람이 읽을 마지막 seq」가 없어요.
  - 기계 메시지 판정은 코어 `isAmbientMessage`예요(`ambientMessage.ts:29-41`). 삭제됨, `tool_call`·`tool_result`·`system`, `props.kind = "work_session"`이 기계 메시지예요.
- **`member_sidebar_prefs`(D2)는 payload 하나를 통째로 PUT해요.** `deny_unknown_fields`이고 채널 참조 상한이 500이에요(D3). 기기 둘이 동시에 쓰면 나중 쓰기가 이겨요.
- **`channel_seq(channel_id, workspace_id, last_seq)`가 send tx에서 seq를 올려요**(`001_init.sql:142`). 메시지 INSERT 트리거 선례는 `push_candidate_enqueue_trg`예요(`011_push_notifier.sql`).

### D6. 저장 — 멤버 소유 `dm_closure` 테이블

- 신규 migration으로 `dm_closure(workspace_id, member_id, channel_id, closed_at_seq bigint NOT NULL, closed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (member_id, channel_id))`를 둬요.
  - 외래 키는 `workspace`·`member`·`channel` ON DELETE CASCADE예요.
  - RLS ENABLE + FORCE, `ws_isolation` 정책 대상이에요. `schema_v0.sql`은 건드리지 않아요.
- **DM만 받아요.** 라우트가 `channel.kind = 'dm'`이고 요청자가 그 DM의 참여자인지 확인해요. 아니면 404(남의 DM 존재를 알리지 않음)예요.
- `member_sidebar_prefs` payload에 넣지 않는 이유:
  - DM마다 멱등 쓰기가 필요해요.
  - payload 통째 PUT의 기기 간 경합을 피해요.
  - 500 상한·`deny_unknown_fields`와 무관하게 늘어나야 해요.
  - 읽음 투영과 행 단위로 맞물려야 해요.

### D7. API — 닫기·다시 열기, 멱등

- `PUT /v1/workspaces/{ws}/channels/{ch}/closure` → 닫기, 204예요.
  - `closed_at_seq`는 **서버가** 그 순간의 `channel_seq.last_seq`로 정해요. 클라이언트가 seq를 보내지 않아서 경합이 없어요.
  - 다시 PUT하면 갱신(최신 seq)이에요.
- `DELETE` 같은 경로 → 다시 열기, 204예요. 행이 없어도 204예요.
- `require_human`(에이전트 403, D3과 같음), 참여자만이에요. 쓰기 경로에 BYPASSRLS가 없고 tx마다 `SET LOCAL app.workspace_id`를 걸어요.

### D8. 투영 — 읽음 투영에 두 필드를 더해요 (가산)

- `GET /v1/workspaces/{ws}/read-state`의 행에 `latest_human_seq`(bigint)와 `closed_at_seq`(nullable, 요청자 본인의 닫기)를 더해요. 옛 클라이언트는 무시해요.
- **보임 판정은 코어 함수 하나**예요. 웹·폰이 같이 읽어요. 다음 중 하나면 보여요.
  1. 지금 열려 있는 DM이에요(보는 대화가 목록에서 사라지지 않음 — 지금 규칙 그대로).
  2. 별표했거나 커스텀 섹션에 넣었어요(D1의 명시적 의도).
  3. 명시적 닫기가 없고 상대가 명부에 있어요.
  4. 명시적 닫기가 있지만 `latest_human_seq > closed_at_seq`예요(닫은 뒤 사람이 읽을 메시지가 왔음 → 되살아남).
  5. 상대가 나갔지만 `latest_human_seq > last_read_seq`예요(안 읽은 사람 메시지가 남음 → 읽을 때까지 보임).
- 되살아날 때 서버 행을 지우지 않아요. 판정이 seq 비교라서 쓰기가 필요 없어요.

### D9. `latest_human_seq` — 메시지 INSERT 트리거 하나

- 신규 migration으로 `channel_seq`에 `last_human_seq bigint NOT NULL DEFAULT 0`을 더해요.
- `AFTER INSERT ON message` 트리거가 사람이 읽을 메시지일 때만 `last_human_seq = GREATEST(last_human_seq, NEW.seq)`로 올려요. 같은 tx라서 send 단일 tx 계약을 그대로 지켜요.
  - **사람이 읽을 메시지** = `type`이 `tool_call`·`tool_result`·`system`이 아니고, `props->>'kind'`가 `work_session`이 아닌 메시지예요.
  - 트리거는 모든 INSERT 경로(REST send, 에이전트, 시스템 줄)에 한 점으로 걸려요. 선례는 `push_candidate_enqueue_trg`예요.
- 기존 채널은 migration에서 한 번 채워요(기계 메시지를 뺀 최대 seq).
- **단조 증가예요.** 나중에 그 메시지가 삭제돼도 내리지 않아요. 되살림 쪽으로 틀리는 것(보임)이 숨김 쪽으로 틀리는 것보다 낫다는 지금 원칙과 같아요.
- **규칙 드리프트 시험**: 메시지 모양별 기대 판정을 golden 파일 하나에 두고, 코어 `isAmbientMessage` 시험과 Rust 트리거 시험이 같은 파일을 읽어요(`docs/api/harness-refine-client-msg-id.golden.json` 선례).

### D10. 다른 기기 반영 — v1은 실시간 이벤트 없음

- D2와 같은 이유로 outbox 이벤트를 두지 않아요. 닫은 기기는 즉시 반영해요.
- 다른 기기는 다음 읽음 투영 조회(앱 앞으로 올 때·사이드바 재조회)에서 맞춰져요.
- 개인 실시간 채널은 새 Centrifugo 채널 종류(보안 경계)라 별도 ADR로 미뤄요.
- owner 원문의 「업데이트할 때마다」는 기기 로컬 원장이 사라져서 생긴 문제예요. 서버 저장만으로 닫혀요.

### D11. 나간 멤버와의 대화 — 기본으로 닫힘, 줄을 없애요

- **「나간 멤버와의 대화 N개」 줄을 없애요.** 나간 상대의 DM은 D8-5대로 안 읽은 사람 메시지가 없으면 목록에 아예 없어요. 나간 사람은 새 글을 쓸 수 없으니 한 번 읽으면 다시 뜨지 않아요.
- 대상은 명부 밖의 상대 전부예요(나감·정지·은퇴·꺼 둔 개인 에이전트). 명부를 믿을 수 있을 때만 판정해요(`rosterLoaded`·`rosterIsComplete` 지금 규칙 그대로).
- **찾는 길**:
  - ⌘K·검색은 지금처럼 숨긴 대화도 열어요.
  - DM 섹션 머리 「⋯ › 닫은 대화」 목록을 둬요. 명시적 닫기와 나간 상대의 대화를 함께 보이고, 「다시 열기」가 있어요.
  - 계속 보이게 두고 싶으면 별표(D8-2)해요.
- **표시 낱말**: 사람은 「나간 멤버」, 에이전트는 에이전트 아바타와 「꺼진 에이전트」예요(코어 `GONE_MEMBER_LABEL`을 종류로 갈라요). 폰의 빈 원 아바타는 웹처럼 기본 아바타로 바꿔요.
- **기록은 지우지 않아요.** 닫기는 「내 목록에서 치우기」이고, 메시지·참여 행은 워크스페이스 기록으로 남아요. 「대화 삭제」는 두지 않아요.

### D12. 기기 로컬 원장 이전

- 웹·데스크탑은 서버가 이 표면을 실으면 로컬 원장(`momo.web.sidebar-closed-dms.v1`)의 항목을 한 번 PUT으로 올려요(멱등). 그 뒤 로컬 키를 비워요.
- 서버가 표면을 안 실으면 지금 동작을 유지해요(옛 서버 호환).
- #4142의 클라이언트 되살림 읽기(`dmRevival.ts`)는 지워요. 판정은 D8의 서버 필드로 해요.
- 폰은 로컬 원장을 새로 만들지 않아요.

### D13. 폰 — 길게 눌러 닫기·나가기

- 폰 사이드바 행 길게 누르기 시트(#4229)에 이 항목들을 둬요.
  - DM: 「대화 닫기」(D7)
  - 채널: 「채널 나가기」(확인 단계)
  - 둘 다: 읽음 처리·알림 끄기·복사
- 항목 판정 함수는 코어로 옮겨 웹 행 메뉴와 같이 써요. 서버가 닫기 표면을 안 실으면 「대화 닫기」 항목이 없어요.

### 바뀌지 않는 것

- D1~D5(섹션·별표는 `member_sidebar_prefs`, 접기 상태는 기기 로컬)는 그대로예요.
- REST→PG 단일 쓰기 경로, RLS, 클라이언트 직접 publish 금지도 그대로예요.
- 채널 나가기 규칙(참여 행 삭제)도 바뀌지 않아요.

### 기각 대안

- **`member_sidebar_prefs` payload에 넣기**: 통째 PUT 경합이 있고, 상한·`deny_unknown_fields`를 바꿔야 해요. 행 단위 판정과 맞지 않아요.
- **클라이언트 되살림 유지**(#4142): 기기마다 메시지를 다시 읽고 판정이 어긋나요. 서버가 이미 아는 사실(메시지 종류)이에요.
- **나간 멤버 DM 삭제**: 워크스페이스 기록이 사라져요. Slack도 사용자에게 DM 삭제를 주지 않아요.
- **「나간 멤버와의 대화」 줄 유지**: owner가 지적한 바로 그 화면이에요. 지울 수 없는 줄은 실제 조직에서 사람이 나갈 때마다 쌓여요.
- **지금 실시간 개인 채널 추가**: 새 Centrifugo 채널 종류(보안 경계)예요. 이 문제의 원인(기기 로컬 저장)과 무관해서 미뤄요.

### 구현 슬라이스 (한 슬라이스 = 한 이슈)

- **#4227 (engine)**: D6 테이블·D9 열·트리거·채우기 migration, D7 라우트, D8 투영 필드, golden 드리프트 시험, 격리 PG 시험, 독립 보안 검수(테넌트 경계).
- **#4228 (uxui, 웹·데스크탑)**: D8 코어 판정, D11 줄 제거·「닫은 대화」 목록·낱말 분리, D12 이전, 캡처·design-review.
- **#4229 (uxui, 폰)**: D13 길게 누르기 시트, D8·D11 같은 판정, 폰 기본 아바타.

### 수용 기준 (red proof)

1. 남의 DM·참여하지 않은 DM의 닫기는 404이고, 다른 워크스페이스 행은 안 보여요. RLS 정책을 빼는 사보타주 → 빨강.
2. 기계 메시지(`tool_call`·`tool_result`·`system`·`work_session`)는 `last_human_seq`를 올리지 않고, 사람 메시지는 올려요. 트리거 필터를 빼는 사보타주 → 빨강.
3. PUT·DELETE는 멱등이에요(두 번 해도 결과·응답이 같음).
4. golden 파일의 판정이 코어 `isAmbientMessage`와 Rust 트리거에서 같아요. 한쪽만 바꾸면 빨강이에요.
5. 나간 상대 DM: 다 읽었으면 웹·폰 목록에 없고, 안 읽은 사람 메시지가 있으면 보이고, 별표하면 보여요. 「나간 멤버와의 대화」 줄은 그려지지 않아요(UI 시험).
6. 로컬 저장소를 지운 뒤(재설치·업데이트 모사)에도 닫은 DM이 닫혀 있어요(투영만으로 판정).
7. 로컬 원장 이전은 한 번만 일어나고, 이전 뒤 로컬 키가 비어 있어요.
