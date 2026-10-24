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

- 상태: **Accepted** (2026-10-24). 공개 API(새 라우트·읽음 투영 필드)와 DB 계약(새 테이블·열·트리거)이 바뀌어서, ADR-0100에 따라 이 증보가 구현 머지 조건이에요. 독립 설계 검토 1회차(2026-10-24, FAIL: High 2 — 워터마크, 슬라이스 이슈의 실시간 문구)를 반영한 판이에요.
- owner 원문:
  - 2026-10-24(폰 실기 캡처 — DM 목록 끝의 「나간 멤버와의 대화 1개」): 「나간 멤버와의 대화를 저렇게 지울 수도 없게해서 보여주는 이유가 있어? 그리고 모바일에서 멤버 꾹눌러서 채팅 나가는 기능도 포함할거지? 업데이트할때마다 나간멤버좀 그만뜨게 해. 임시 처리하지말고 제대로 처리해서 이후에 실제 조직에서 적용해도 나간멤버때문에 불편함 겪지 않도록 해.」
  - 2026-10-22: 「모바일 기준으로 아직도 나간 멤버나 kwak의 claude 같은게 있는데 정상이야 ? 그리고 모바잏에서는 다이렉트 메세지쪽 꾹 눌러서 제거하고 그런거 없어 ?」
  - 2026-10-20: 「나간 멤버랑 Claude Code X로 계속 제거하는데 왜 계속 뜨냐」
  - 2026-10-17(닫기 단추 규칙, `sidebarDmClosure.ts` 머리): 안 읽음이 있으면 닫기 단추를 숨긴다.
  - 위임(2026-10-22): 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」 — 아래 D6~D13의 세부는 planner 권장안이에요.
- 표기: [V] 직접 확인(track/engine `68e95f345`) · [확인 필요] · `runtime-unverified`.

### 확인한 사실 [V]

- **닫기는 기기 로컬이에요.**
  - 웹·데스크탑의 DM 닫기는 `localStorage` 키 `momo.web.sidebar-closed-dms.v1` 원장뿐이에요(`clients/web/src/features/sidebar/sidebarDmClosure.ts:71`). 그래서 다른 기기에서는 도로 보이고, 데이터가 초기화되면 다시 보여요.
  - 워터마크는 **클라이언트가 본** `latestSeq`예요(`withClosedDm`·`closeDmOnDevice`).
  - 안 읽음이 있으면 닫기를 내밀지 않아요(`dmCloseOffered`, 위 2026-10-17 규칙).
- **#4252의 「나간 멤버」 규칙은 서버를 건드리지 않은 임시 규칙이에요**(`packages/momo-core/src/features/sidebar/goneDm.ts` 머리 주석이 스스로 그렇게 적어요).
  - 상대가 명부에 없고 안 읽은 것이 없으면 접고, 「나간 멤버와의 대화 N개」 줄로 세요. 그 줄은 지울 수 없어요. owner가 지적한 화면이 이거예요.
  - 이 규칙은 다음 넷을 지켜요:
    - 명부가 미완·미수신이면 접지 않아요(`rosterLoaded`·`rosterIsComplete`).
    - 투영이 loading이면 숨김을 유지하고, error면 보여요.
    - `mentionCount > 0`이면 보여요.
    - 「여기부터 안 읽음」(`markedUnreadBeforeSeq`, ADR-0178)이면 보여요.
- **되살림은 클라이언트가 메시지를 다시 읽어 판정해요**(`dmRevival.ts`, #4142).
  - 읽음 투영(`GET /v1/workspaces/{ws}/read-state`)의 `latest_seq`는 `channel_seq.last_seq`예요(`momo-messaging/src/read_state.rs:262`). 기계 메시지까지 센 값이라, 「사람이 읽을 마지막 seq」가 없어요.
  - 투영은 보관된 채널을 빼요(`read_state.rs:271`).
  - 기계 메시지 판정은 코어 `isAmbientMessage`예요(`ambientMessage.ts:29-41`). 삭제됨, `tool_call`·`tool_result`·`system`, `props.kind = "work_session"`이 기계 메시지예요.
- **`member_sidebar_prefs`(D2)는 payload를 통째로 PUT해요.** 채널 참조 상한이 500이고(D3), `deny_unknown_fields`예요.
- **`channel_seq`**:
  - `channel_seq(channel_id, workspace_id, last_seq)`는 FORCE RLS 표이고, seq는 한 곳에서 올려요(`momo-messaging/src/message.rs:507-510`).
  - 메시지 INSERT 트리거 선례는 `push_candidate_enqueue_trg`예요(`011_push_notifier.sql`, INVOKER 함수가 FORCE RLS 표 `outbox`에 씀).
  - migration의 FORCE RLS 표 백필은 `SET LOCAL row_security = off`가 필요해요. 없으면 정책에 걸려 조용히 0행이 돼요(선례 `002`·`005`·`012`·`055`·`064`·`088`).
- **에이전트 bearer는 정확한 경로 허용목록에 없는 경로에 오지 못해요**(`momo-auth/src/agent_scope.rs:84-`). `require_human`은 그 위의 두 번째 층이에요(`routes/sidebar_prefs.rs` 머리 설명).
- **클라이언트의 「이 서버가 싣는 표면」 판정**은 코어 `serverSurfaces.ts`의 정적 표와 404 접기(`serverSaysAbsent`) 두 겹이에요.

### D6. 저장 — 멤버 소유 `dm_closure` 테이블

- 신규 migration으로 `dm_closure(workspace_id, member_id, channel_id, closed_at_seq bigint NOT NULL, closed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (member_id, channel_id))`를 둬요.
  - 외래 키는 `workspace`·`member`·`channel` ON DELETE CASCADE예요.
  - RLS ENABLE + FORCE, `ws_isolation` 정책 대상이에요. `schema_v0.sql`은 건드리지 않아요.
  - 멤버·채널의 워크스페이스 일치는 라우트가 확인해요. 복합 FK는 방어 심층으로 둘 수 있어요(084와 같은 판단).
- **DM만 받아요.** 라우트가 `channel.kind = 'dm'`, 보관되지 않음, 요청자가 참여자인지 확인해요. 아니면 404예요(남의 DM 존재를 알리지 않음).
- **멤버 경계는 쿼리 술어가 지켜요.** RLS는 워크스페이스만 가르므로, 쓰기·읽기·투영 조인 모두 `member_id = 요청자` 술어를 가져요(084 머리 「멤버 경계는 라우트가, 테넌트 경계는 정책이」).
- `member_sidebar_prefs` payload에 넣지 않는 이유:
  - DM마다 멱등 쓰기가 필요해요.
  - 기기 간 통째 PUT 경합을 피해요.
  - 500 상한과 무관하게 늘어나야 해요.
  - 투영과 행 단위로 맞물려야 해요.

### D7. API — 닫기·다시 열기, 클라이언트가 본 seq로 멱등

- `PUT /v1/workspaces/{ws}/channels/{ch}/closure`, 본문 `{ "seenSeq": <정수> }` → 204예요.
  - `seenSeq`는 클라이언트가 그 DM에 대해 **본** 마지막 seq(투영의 `latest_seq`)예요.
  - 서버는 `closed_at_seq = GREATEST(기존 값, LEAST(seenSeq, channel_seq.last_seq))`로 저장해요.
  - 그래서 투영과 PUT 사이에 온 메시지는 묻히지 않아요. 같은 값의 재전송도 결과가 같고, 늦게 온 재전송이 그 뒤 메시지를 지우지 않아요.
- 닫기 단추는 지금처럼 **안 읽음이 있으면 내밀지 않아요**(2026-10-17 규칙). 별표했거나 커스텀 섹션에 넣은 DM에도 닫기를 내밀지 않고, 「별표를 먼저 빼요」로 안내해요(D8과 함께 봐요).
- `DELETE` 같은 경로 → 다시 열기, 204예요. 행이 없어도 204이고, 참여자가 아니거나 보관된 DM이면 404예요(PUT과 같음).
- **권한 층**:
  - 에이전트 bearer는 경로 허용목록(`agent_scope.rs`)에 이 경로를 넣지 않아서 막혀요.
  - `require_human`(D3과 같음)이 두 번째 층이에요.
  - 쓰기 경로에 BYPASSRLS가 없고, tx마다 `SET LOCAL app.workspace_id`를 걸어요.

### D8. 투영과 보임 판정 — 코어 함수 하나, 입력과 우선순위를 못박아요

- `GET /v1/workspaces/{ws}/read-state` 행에 두 필드를 가산으로 더해요. 옛 클라이언트는 무시해요.
  - `latest_readable_seq`(bigint, D9)
  - `closed_at_seq`(nullable, **요청자 본인의** 닫기만 — `member_id = 요청자` 조인)
- **코어 함수 하나**를 웹과 폰이 같이 읽어요. 입력은 다음과 같아요.
  - `isOpen`
  - `starredOrSectioned`
  - `closedAtSeq`·`latestReadableSeq`·`lastReadSeq`
  - `markedUnreadBeforeSeq`·`mentionCount`
  - `counterpart: present | gone | unknown`
  - `phase: loading | error | ready`
- 위에서부터 처음 맞는 줄이 답이에요.

| # | 조건 | 결과 | 근거 |
|---|---|---|---|
| 1 | `isOpen` | 보임 | 보는 대화가 목록에서 사라지지 않음(지금 규칙) |
| 2 | `phase = error` | 보임 | 모를 때 숨기는 쪽이 최악(지금 규칙) |
| 3 | `phase = loading` | 직전 판정 유지(첫 페인트는 아래 캐시) | 깜빡임 방지 |
| 4 | `starredOrSectioned` | 보임 | D1의 명시적 의도. 이런 DM에는 닫기를 내밀지 않음(D7) |
| 5 | `markedUnreadBeforeSeq ≠ null` 또는 `mentionCount > 0` | 보임 | 사람이 직접 남긴 신호(지금 규칙) |
| 6 | `closedAtSeq ≠ null` 이고 `latestReadableSeq ≤ closedAtSeq` | 숨김 | 명시적 닫기 |
| 7 | `closedAtSeq ≠ null` 이고 `latestReadableSeq > closedAtSeq` | 보임 | 닫은 뒤 읽을 메시지가 옴(되살림) |
| 8 | `counterpart = gone` 이고 `latestReadableSeq ≤ lastReadSeq` | 숨김 | 나간 상대, 안 읽은 것 없음(D11) |
| 9 | 그 밖 | 보임 | |

- `counterpart = unknown`(명부 미완·미수신)이면 8번을 적용하지 않아요. 비어 있는 명부 앞에서 모든 DM이 「나간 멤버」가 되는 것을 막아요(지금 규칙).
- **첫 페인트**: 클라이언트는 마지막으로 받은 투영의 닫힘 사실을 **캐시**로 들고 있다가 콜드 스타트에 써요. 이것은 원장이 아니라 서버 사실의 사본이라, 투영이 오면 통째로 바뀌어요. 저장소가 비어 있으면(재설치) 투영이 올 때까지 3번처럼 판정을 미뤄요(골격).
- **다시 열기**: 사람이 ⌘K·주소·「닫은 대화」 목록으로 명시적으로 닫은 DM을 열면, 클라이언트가 `DELETE`를 보내요(지금 `reopenDmOnDevice`와 같은 뜻). 나간 상대의 DM(8번)은 연다고 아무것도 쓰지 않아요. 열려 있는 동안만 보여요.
- 되살아날 때 서버 행은 지우지 않아요. 판정이 seq 비교라서 쓰기가 필요 없어요.

### D9. `last_readable_seq` — 메시지 INSERT 트리거 하나

- 신규 migration으로 `channel_seq`에 `last_readable_seq bigint NOT NULL DEFAULT 0`을 더해요.
  - 「사람이 읽을」이 아니라 「읽을」이에요. 에이전트의 보통 답도 읽을 메시지라서요.
- **트리거**: `AFTER INSERT ON message`. 읽을 메시지일 때만 `UPDATE channel_seq SET last_readable_seq = GREATEST(last_readable_seq, NEW.seq) WHERE channel_id = NEW.channel_id AND workspace_id = NEW.workspace_id`를 해요.
  - 함수는 `SECURITY INVOKER`이고 `SET search_path = pg_catalog, public`(089 선례)이에요. DEFINER는 쓰지 않아요(소유자도 FORCE RLS 대상).
  - message INSERT가 RLS를 통과한 같은 tx·같은 `app.workspace_id`라서, `channel_seq` UPDATE도 같은 정책으로 통과해요(011 선례). BYPASSRLS 역할 경로도 그대로 돌아요. send 단일 tx 계약을 지켜요.
- **읽을 메시지** = `NEW.type NOT IN ('tool_call','tool_result','system') AND (NEW.props->>'kind') IS DISTINCT FROM 'work_session'`이에요.
  - **`<>`를 쓰지 않아요.** `kind`가 없는 보통 메시지(NULL)가 거짓이 되어 아무것도 안 올라가요.
- **순서**: 트리거를 먼저 만들고, 그다음 백필해요(틈 없음).
- **백필**:
  - `SET LOCAL row_security = off`를 걸고 채널마다 `LATERAL (… ORDER BY seq DESC LIMIT 1)`로 채워요(`message_channel_seq_idx` 사용).
  - 갱신 행 수를 단정해요.
  - 라이브 트리거와 같은 뜻으로, 나중에 삭제된 메시지도 세요.
- **단조 증가예요.** 그 메시지가 나중에 삭제돼도 내리지 않아요. 틀려도 보임 쪽이라 받아들여요. 되살림은 한 번뿐이에요(다시 닫으면 워터마크가 올라가요).
- **신뢰 가정**: 클라이언트는 자기 메시지의 `type`·`props.kind`를 보낼 수 있어요(`routes/messages.rs`). 그래서 보낸 사람이 자기 메시지를 「기계」로 만들어 상대의 닫은 DM을 되살리지 않게 할 수 있어요. 지금 클라이언트 규칙도 같아서 새 위험이 아니고, 영향은 보낸 사람 의도 쪽이에요.
- **규칙 드리프트 시험**: golden 파일 하나에 메시지 모양별 `core` 기대와 `trigger` 기대를 따로 둬요. 코어 시험과 Rust 트리거 시험이 같은 파일을 읽어요(`docs/api/harness-refine-client-msg-id.golden.json` 선례).
  - `kind` 없는 보통 메시지 모양은 필수예요.
  - 삭제됨 모양은 `trigger: "n/a(insert-time)"`로 적어요. 트리거는 INSERT 시점이라 삭제를 볼 수 없어요(알려진 차이를 시험 안에 둠).
  - 새 `type`을 더하거나 `kind` 규칙을 한쪽만 바꾸면 빨개져요.

### D10. 다른 기기 반영 — v1은 실시간 이벤트 없음

- 원본 D2와 같은 이유로 outbox 이벤트를 두지 않아요.
  - 닫은 기기는 즉시 반영해요.
  - 다른 기기는 다음 읽음 투영 조회(앱이 앞으로 올 때·사이드바 재조회)에서 맞춰져요.
- 개인 실시간 채널은 새 Centrifugo 채널 종류(보안 경계)라 별도 ADR로 미뤄요.
- **#4227·#4228 이슈 본문의 실시간 문구는 이 D10대로 고쳐요**(2026-10-24).
- owner의 「업데이트할 때마다」에 대해:
  - 폰은 닫기 자체가 없고, 문제의 줄이 #4252의 접힘 줄이에요. D11이 풀어요.
  - 데스크탑은 기기 로컬 원장이 업데이트·재설치로 사라진 것으로 **추정**해요. Tauri 업데이트가 `localStorage`를 지우는지는 [확인 필요]예요. 어느 쪽이든 서버 저장이 풀어요.

### D11. 나간 멤버와의 대화 — 기본으로 닫힘, 줄을 없애요

- **「나간 멤버와의 대화 N개」 줄을 없애요.** 나간 상대의 DM은 D8-8대로 안 읽은 읽을 메시지가 없으면 목록에 없어요. 나간 사람은 새 글을 쓸 수 없으니 한 번 읽으면 다시 뜨지 않아요.
- 대상은 명부 밖의 상대 전부예요(나감·정지·은퇴·꺼 둔 개인 에이전트). 명부를 믿을 수 있을 때만 판정해요(D8 `unknown`).
- **찾는 길**:
  - ⌘K·검색은 지금처럼 숨긴 대화도 열어요.
  - DM 섹션 머리 「⋯ › 닫은 대화」 목록은 명시적 닫기(D8-6)와 나간 상대(D8-8)의 대화를 「다시 열기」와 함께 보여요. 지금 사이드바에 보이는 대화는 이 목록에 넣지 않아요.
  - 계속 보이게 두고 싶으면 별표해요(D8-4).
- **표시 낱말**: 사람은 「나간 멤버」, 에이전트는 에이전트 아바타와 「꺼진 에이전트」예요. 코어 `GONE_MEMBER_LABEL`(`directory.ts:181`)을 종류로 갈라요. 폰의 빈 원 아바타는 웹처럼 기본 아바타로 바꿔요.
- **기록은 지우지 않아요.** 닫기는 「내 목록에서 치우기」이고, 메시지·참여 행은 워크스페이스 기록으로 남아요. 「대화 삭제」는 두지 않아요.

### D12. 기기 로컬 원장 이전

- 웹·데스크탑에서, 코어 `serverSurfaces.ts`에 새 표면 키 `dmClosure`가 「제공」이면 이전해요. 404면 `serverSaysAbsent`로 접어 「미제공」으로 봐요.
- (기기, 워크스페이스)마다 한 번, 로컬 원장의 **지금 숨은 항목만** 이전해요. 되살아난 항목은 올리지 않아요.
  - 각 항목은 로컬 워터마크를 `seenSeq`로 보내요(D7).
  - 항목별로 2xx나 404를 받은 뒤에만 그 항목을 로컬에서 지워요. 실패한 항목은 남겨 다음 실행에 다시 해요.
  - 다른 워크스페이스의 항목은 건드리지 않아요.
- 서버가 표면을 안 실으면 지금 동작(로컬 원장)을 유지해요.
- #4142의 클라이언트 되살림 읽기(`dmRevival.ts`)는 서버 필드로 바꾸고 지워요.
- 폰은 로컬 원장을 새로 만들지 않아요.

### D13. 폰 — 길게 눌러 닫기·나가기

- 폰 사이드바 행 길게 누르기 시트(#4229)에 이 항목들을 둬요.
  - DM: 「대화 닫기」(D7, 안 읽음 있음·별표면 안 보임)
  - 채널: 「채널 나가기」(확인 단계)
  - 둘 다: 읽음 처리·알림 끄기·복사
- 항목 판정 함수는 코어로 옮겨 웹 행 메뉴와 같이 써요. 서버가 `dmClosure` 표면을 안 실으면 「대화 닫기」 항목이 없어요.

### 바뀌지 않는 것

- D1~D5(섹션·별표는 `member_sidebar_prefs`, 접기 상태는 기기 로컬)는 그대로예요.
- REST→PG 단일 쓰기 경로, RLS, 클라이언트 직접 publish 금지도 그대로예요.
- 채널 나가기 규칙(참여 행 삭제)과 2026-10-17 「안 읽음 있으면 닫기 숨김」도 바뀌지 않아요.
- 열린 의존: 작성자 본인 메시지도 읽을 메시지로 세요. 보내기는 작성자의 읽음 커서를 올리지 않으므로(`momo-messaging/src/message.rs`), 열린 DM에서 클라이언트가 커서를 올리는 지금 동작에 기대요 [확인 필요: #4228·#4229 시험].

### 기각 대안

- **`member_sidebar_prefs` payload에 넣기**: 통째 PUT 경합이 있고, 상한·`deny_unknown_fields`를 바꿔야 해요. 행 단위 판정과 맞지 않아요.
- **서버가 닫는 순간의 `last_seq`를 워터마크로**: 투영과 PUT 사이의 메시지를 묻고, 재전송이 늦은 메시지를 지워요(독립 검토 High-1).
- **클라이언트 되살림 유지**(#4142): 기기마다 메시지를 다시 읽고 판정이 어긋나요. 서버가 이미 아는 사실이에요.
- **나간 멤버 DM 삭제**: 워크스페이스 기록이 사라져요. Slack도 사용자에게 DM 삭제를 주지 않고 닫기만 줘요.
- **「나간 멤버와의 대화」 줄 유지**: owner가 지적한 바로 그 화면이에요. 지울 수 없는 줄은 사람이 나갈 때마다 쌓여요.
- **지금 실시간 개인 채널 추가**: 새 Centrifugo 채널 종류(보안 경계)예요. 원인(기기 로컬 저장)과 무관해요.

### 구현 슬라이스 (한 슬라이스 = 한 이슈)

- **#4227 (engine)**: D6·D9 migration(테이블·열·트리거·백필), D7 라우트, D8 투영 필드, golden 드리프트 시험, 격리 PG 시험, 독립 보안 검수(테넌트·멤버 경계). **실시간 이벤트는 만들지 않아요(D10).**
- **#4228 (uxui, 웹·데스크탑)**: D8 코어 판정 함수와 시험 행렬, 첫 페인트 캐시, D11 줄 제거·「닫은 대화」 목록·낱말 분리, D12 이전, `serverSurfaces.ts` 표면 키, 캡처·design-review.
- **#4229 (uxui, 폰)**: D13 길게 누르기 시트, D8·D11 같은 판정, 폰 기본 아바타.

### 수용 기준 (red proof)

1. **테넌트**: 다른 워크스페이스의 행이 보이지 않아요. 음성 단정(남의 행 0)과 양성 단정(내 행 1)을 나눠요. 사보타주: 정책을 빼면 음성 단정이 빨개요.
2. **멤버 경계**: A가 닫은 DM은 B의 투영에서 `closed_at_seq = null`이에요. 사보타주: 조인의 `member_id = 요청자` 술어를 지우면 빨개요.
3. **에이전트**: 에이전트 bearer는 403이에요. 두 층(경로 허용목록, `require_human`)을 각각 따로 시험해요.
4. **404**: 참여하지 않은 DM과 보관된 DM의 PUT·DELETE는 404예요.
5. **워터마크**:
   - 투영 seq s를 받은 뒤 사람 메시지가 s+1로 오고, 그다음 `PUT seenSeq=s`가 와도 그 메시지는 묻히지 않아요.
   - 뒤늦게 온 같은 `seenSeq`의 재전송도 그 뒤 메시지를 지우지 않아요.
   - 같은 PUT 두 번은 결과·응답이 같아요.
6. **트리거**: 기계 모양은 올리지 않고, 읽을 모양(`kind` 없음 포함)은 올려요. 사보타주: `IS DISTINCT FROM`을 `<>`로 바꾸면 `kind` 없음 모양에서 빨개요.
7. **백필**: 두 워크스페이스에 메시지가 든 DB에 migration을 적용하면 기대값(기계를 뺀 최대 seq)이 나와요. 갱신 행 수도 단정해요. 사보타주: `row_security = off`를 빼면 빨개요.
8. **golden**: 코어와 트리거가 모양별 기대(`core`/`trigger`)를 지켜요. 한쪽만 바꾸면 빨개요.
9. **보임 판정**: D8 표의 아홉 줄과 `unknown`을 웹·폰 공용 코어 함수의 시험 행렬로 재요.
   - 나간 상대 + 다 읽음 → 없음
   - 안 읽은 읽을 메시지 → 보임
   - 별표 → 보임
   - 「안 읽음으로」 → 보임
   - 명부 미완 → 보임
   - 열림 → 보임
10. **콜드 스타트**: 캐시가 있으면 닫은 DM이 깜빡이지 않아요. 저장소를 지운 뒤(재설치 모사)에도 투영이 오면 닫혀 있어요.
11. **이전**:
    - (기기, 워크스페이스)마다 한 번만 일어나요.
    - 숨은 항목만 올라가요.
    - 부분 실패한 항목은 남아요.
    - 다른 워크스페이스 항목은 건드리지 않아요.
12. **화면**: 「나간 멤버와의 대화」 줄이 웹·폰 어디에도 그려지지 않아요(UI 시험).
