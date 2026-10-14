# ADR-0200: 외부 에이전트 작업 상태를 사실대로 — run 상태 어휘·이벤트 원장·대기열·생존 신호

- Status: **Accepted** (2026-10-13 성재 결재 — 아래 「결재 기록」. 공개 API·DB 계약 변경이라 ADR-0100에 따라 이 Accepted가 구현 머지 조건이다.) 초안은 같은 날 Proposed였고 결재로 D4-5(`oort_ping`)가 추천안과 달라졌다.
- Date: 2026-10-13
- Deciders: 성재
- 기안: Opus 5.5 (#3736 + #3737 묶음)
- 관계: ADR-0162 증보 3(D9 「새 저장소 없음」, D11 「단계 표식은 realtime 없음」, D13 보드 가시성, D17 비목표, 부록 A lease·암묵 갱신) **일부를 이 ADR이 바꾼다**(아래 「바뀌는 기존 결정」), ADR-0171(도어벨), ADR-0186(승인 액션 — run을 park), ADR-0199(인박스 투영 — 같은 방식의 쓰기 시 투영), ADR-0198, ADR-0100
- 표기: [V] 코드·문서 직접 확인 · **[추정]** 해석 · [확인 필요] 구현 전 사실 확인 · `runtime-unverified` 실행 안 함

## 맥락

### 2026-10-13 운영 실측 (운영 v0.1.22 + 맥 0.1.24, 이슈 #3736 원문)

| 시각(KST) | 사실 |
|---|---|
| 11:23:57 | `@grokbot 채널 만들어줘. grokbot-lab으로` → `agent_run` 생성 |
| 11:23:59 | 도어벨 `ok_200` (그록 웹훅이 받았다는 뜻일 뿐) |
| 11:23~ | 그록봇 도어벨 루틴은 「Oort Agent Port 대상이 일시적으로 unavailable」로 일감을 수령 못 함 |
| ~11:24:50 | 화면 「grok 작업 중 55s」 → 「신호 소실 · 종료를 보지 못했습니다」. 작업 패널 「아직 도착한 진행이 없습니다」·「패널을 닫으면 이 기록은 사라집니다」 |
| 11:35:17 | 15분 루틴이 수령 → `channel.create` 승인 제안 |
| 12:35 | 아무도 승인하지 않아 `approval_expired` → run `timed_out` |

성재: 「작업이 진행되고 있는지 대체 파악 자체가 안되잖아. 원래였으면 사고 과정이랑 현재 진행중인 작업 그런것들이 순차 병렬적으로 보여야해」, 「토큰이 연결돼 있다고 연결이 아니라, 지금 살아있는지가 궁금한거야」(#3737).

화면은 11분 동안 세 번 틀렸다. ① 아직 아무도 가져가지 않은 run을 「작업 중」이라 했고, ② 수령되지도 않았는데 「신호 소실」이라 했고(수령은 11분 뒤에 일어났다), ③ 11:35 이후 승인 대기와 12:35의 시간 초과는 어디에도 보이지 않았다. 둘째 질문(「연결돼 있나」)에는 `hosted_agent_connection.status='active'`(10-10 토큰 증명 이후 그대로)와 도어벨 `ok_200`밖에 근거가 없다.

### 확인한 코드 사실 [V] (main `2eb618e4a`)

**run 상태와 lease**
- `agent_run.status`는 `queued/running/awaiting_approval/paused/succeeded/failed/cancelled/timed_out`(`momo-agent/src/run.rs:35`). hosted 수령(`oort_jobs_claim`)은 **run.status를 바꾸지 않는다.** `queued → running`은 첫 `oort_run_event`(`running|thinking|streaming`)가 `mark_run_started_in_tx`(`run.rs:1233`)를 부를 때뿐이다. 즉 「수령됨」은 run 행에 없고, 전달 행(`outbox`, `kind='agent_job'`)의 `lease_owner/lease_expires_at`에만 있다. **수령 시각은 job 행(`outbox.lease_acquired_at`)에만 있고, 재claim 때 덮어써지며 job이 끝나면 읽을 수 없다 — run의 이력으로는 남지 않는다.**
- claim 순서는 `ORDER BY o.id ASC`(`momo-outbox/src/gateway.rs:353`, 에이전트별 `partition_key`)다. FIFO이고, hosted claim은 그 connection이 승인받은 채널의 job만 후보로 삼는다(`hosted_connection_channel_ids`).
- lease는 기본 30분(5~120분, 부록 A1). **만료돼도 job을 되돌리는 reaper가 없고**(부록 A, 2026-10-06 실측) 아무도 재claim하지 않으면 같은 핸들이 계속 유효하다(A3 암묵 갱신). `agent_run.deadline_at`은 승인 경로(`run.rs:1339`)에서만 쓰인다. 따라서 **수령 뒤 사라진 에이전트의 run은 `running`으로 영원히 남는다**(G1 동시성 계산이 600초 넘은 `running`을 빼는 것은 계산일 뿐 상태를 바꾸지 않는다, `a2a.rs`).
- 승인 만료는 notifier 스위프(`momo-notifier/src/approval_sweep.rs:172`)가 run을 `timed_out{code:"approval_expired", approval_id}`로 끝내고 종결 rail 프레임을 낸다. 위 12:35가 이 경로다.

**run 이벤트가 저장되는 곳**
- `oort_run_event` = `record_gateway_event_in_tx`(`agent_gateway.rs:326`). 한 이벤트가 하는 일: ① `mark_run_started` ② 상태 프레임을 rail로 relay(`emit_rail_frame`, 영속 아님) ③ `text_delta`를 rail로 relay(**저장하지 않는다** — 「relay이지 accumulator가 아니다」) ④ `stage`가 있으면 `agent_run.output.stages`(최대 12개, 오래된 것부터 버림, 연속 동일 접음, 타임스탬프 없음)와 `step_count` ⑤ `audit_log` 1행 `agent.gateway.status`(`detail`은 **감사 전용**, `eventId`로 멱등).
- 그러므로 「사고 과정」(`textDelta`)은 **Centrifugo를 지나가는 동안에만** 존재한다. 서버에 이력이 없다.
- `audit_log`는 관리자 감사 표면이고 채널 멤버용 읽기 경로가 없으며, run별 안정 순서·보존 정책이 다르다. 원장으로 쓰지 않는다(대안 B).

**연결 생존 신호**
- `oort_inbox_read`(`agent_port_tools.rs:366`)는 `list_hosted_inbox_in_tx`를 부르는 **순수 읽기**다. 커서는 불투명·클라이언트 보관이고 서버에 소비자 쪽 기록이 없다([V] `hosted_inbox.rs`의 INSERT/UPDATE는 전부 생산자 쪽 counter·event). `hosted_agent_inbox_counter`와 `hosted_agent_doorbell.last_seen_inbox_seq`는 생산자·송신기 쪽 값이다. **`last_inbox_read_at`은 새로 만드는 것이지 재사용이 아니다.**
- `hosted_agent_doorbell.last_fired_at/last_status`는 송신기가 쓴다(`ok_<http status>` 또는 실패 라벨, 마지막 `abandoned`). 「수신됨」이지 「처리됨」이 아니다.
- stale/위조 커서와 비활성 connection은 모두 같은 `ToolFailure::Unavailable`로 답한다(`agent_port_tools.rs:386-391` 주석: 「커서가 안 열리면 재수립해야 한다」). **[추정]** 그록봇이 본 「Oort Agent Port unavailable」은 이 경로(커서 불일치·connection 상태)일 수 있다. 운영 로그는 이 설계 범위에서 열지 않았다([확인 필요]: 11:23~11:35 KST 서버 로그의 `agent_port.*` 거절 사유).

**클라이언트의 「작업 중」「신호 소실」**
- 서버는 run 생성 때 `opening_agent_status_payload`로 `phase=queued, run_status=queued` rail 프레임을 낸다(`status.rs:85`, `agent_runs.rs:445`; 프레임 문서: 「run 행은 있고 아직 아무도 가져가지 않았다」). 클라이언트는 이 프레임을 **열린 turn**으로 보고 `AgentWorkingSignal`을 만든다(`agentRail.ts:223-236`, `agentWorkingSignal.ts`). 「작업 중 55s」는 이 신호의 경과 타이머다. **[추정]** 헤드라인이 queued와 running을 구분하지 않아 「작업 중」으로 읽혔다.
- 「신호 소실」의 판정 근거는 **클라이언트 시계 하나**다: `isStaleSignal`/`workLogLiveness`가 `now − lastActivityAtMs > IDLE_CUTOFF_MS(90_000)`이면 `signal_lost`(`workLog.ts:498-506`, `workingSignal.ts:158`). 서버의 lease·claim·run 상태는 판정에 들어가지 않는다. 마지막 활동이 queued 프레임 시각이라, 에이전트가 11분 뒤에 수령하는 정상 경로에서도 90초에 「소실」이 된다. 추가로 `ZOMBIE_CLEAR_MS=120_000` 뒤 신호 자체가 지워진다.
- 작업 패널 기록은 web 모듈 전역 맵이다(`workLogStore.ts`: 「구독된 run만 기록, 패널을 닫으면 지움」, D1 휘발 관전 v0). 서버에서 읽는 경로가 없다.
- 서버가 이미 가진 읽기: `GET /v1/workspaces/{ws}/channels/{ch}/agent-runs`, `…/agents/{agent}/runs`, `…/agent-runs/{run}`(`lib.rs:1264-1277`, 채널 멤버십으로 판정). 단 `output.stages`만 있고 이벤트별 시각·수령 정보·대기 순번은 없다.

### 시계가 여섯 개다

| 시계 | 값 | 어디서 | 이 ADR 이후 |
|---|---|---|---|
| 클라 IDLE_CUTOFF | 90초 | `workingSignal.ts` | hosted run 판정에서 **제거**(서버 사실로 대체) |
| 클라 ZOMBIE_CLEAR | 120초 | `agentWorkingSignal.ts` | 서버 파생 상태가 있는 run에는 적용하지 않음 |
| G1 stale running | 600초 | `a2a.rs` | 동시성 계산 전용, 그대로 |
| hosted lease | 30분(5~120) | `gateway.rs` | 그대로. 「미갱신」 표시의 기준 |
| 승인 만료 스위프 | 승인 `expires_at` | notifier | 그대로. 종결 사유를 원장에 남김 |
| 신규 `lease_abandoned` | D1-4 | notifier | 신규(owner 결정 ②) |

## 바뀌는 기존 결정

이 ADR이 Accepted가 되면 ADR-0162 증보 3의 다음을 **이 범위에서** 대체한다. 증보 3 파일에는 역방향 한 줄만 단다(ADR-0197 관례).

- **D9 「새 테이블·새 큐를 만들지 않는다」 → 새 테이블 2개**(`agent_run_event`, `hosted_agent_liveness`). 이유: `output.stages`는 12개 상한·시각 없음·행 잠금 아래 jsonb 재작성이라 「닫아도 남는 기록」「수령 시각」「몇 번째 대기」를 담을 수 없다. 새 **도구·scope·MCP Tasks 연동은 여전히 만들지 않는다**(D9 나머지 유지).
- **D11 「단계 표식은 realtime 이벤트를 만들지 않는다」 → 원장 행마다 얇은 realtime 신호.** 패널이 실시간이어야 한다는 것이 이 일의 요지다. 신호는 seq·종류만 싣고(D2-4) 내용은 REST로 읽는다.
- **D13 「mention run은 보드에 넣지 않는다」는 유지**하되, **이 ADR의 읽기 경로(채널 run 목록·run 이벤트)는 mention run을 포함한다.** 10-13 사건이 mention run이었다. 보드(팀 단위 작업 목록)와 채널 작업 패널은 다른 표면이다.
- **D17 「새 task/run 저장소, 새 MCP 도구」 비목표 → 저장소는 위처럼 예외, 도구는 `oort_ping`을 넣지 않는다(D4-5).** 도구 비목표는 유지된다.

## 결정

### D1. run 상태 어휘는 서버가 파생해서 내려준다 (`phase`)

DB 열거형(`run_status`)은 바꾸지 않는다. 읽기 응답에 **파생 필드 `phase`와 근거 필드**를 더한다. 클라이언트는 아무것도 추정하지 않고 이 필드를 그린다.

| phase | 서버 판정 (한 SQL) | 근거 필드 | 사람 문구 예 |
|---|---|---|---|
| `queued` | run `queued` ∧ 전달 job `pending` ∧ lease 없음(`lease_owner IS NULL`) | `queue_position`(D3), `queued_at`(=run `created_at`) | 「대기 중 · 에이전트 앞에 2건」 |
| `claimed` | run `queued` ∧ job에 `lease_owner` 있음(만료 여부 무관) | `claimed_at`, `claimed_by_connection_id`(응답에는 표시명만), `lease_state` | 「가져감 · 11:35 · grok」 |
| `running` | run `running` | `stage`(최신 단계), `last_event_at`, `step_count` | 「진행 중 · 채널 만드는 중」 |
| `awaiting_approval` | run `awaiting_approval` | `approval_id`, `approval_expires_at` | 「승인 대기 · 카드 보기」 |
| `paused` | run `paused` | — | 「일시 정지」 |
| `succeeded` / `failed` / `timed_out` / `cancelled` | run 종결 | `finished_at`, `end_reason`(닫힌 코드: `approval_expired`, `lease_abandoned`, `unclaimed_expired`, `agent_error`, `cancelled_by_member`, …) | 「시간 초과 · 승인이 만료됨」 |

- 수령 이력은 job 행의 `lease_acquired_at`(현재 lease만)으로는 부족하다. 수령 시각을 **원장 행(D2, `kind='claimed'`)** 으로 같은 tx에서 남긴다(전달 job 행에 열을 더하지 않는다: `outbox`는 범용·핫 테이블이다).
- **lease_state**는 `phase`와 직교하는 서버 사실이다: `live`(`lease_expires_at > now()`) / `stale`(만료, 재claim 없음) / `none`. `stale`의 문구는 **「lease 미갱신 n분」** 이다. 부록 A3 때문에 만료 lease의 에이전트는 **돌아올 수 있다** — 만료는 「끊김」이 아니라 「n분째 소식 없음, 돌아올 수 있음」이다. 그래서 「끊김」 문구는 쓰지 않는다.
- **「신호 소실」을 없앤다.** 클라이언트 TTL(90s/120s)로 상태를 정하는 일을 hosted run에서 멈춘다. 대신 서버 사실만 말한다: 수령 전이면 「대기 중(미수령 n분)」, 수령 뒤면 「마지막 보고 n분 전 · lease 미갱신 n분」.
- **D1-4. 영원히 `running`인 run 방지.** 하드 종결은 클라 TTL이 아니라 서버 스위프의 명시적 사실로 한다(결재 2). notifier 스위프가 `running/claimed`이고 `lease_state=stale`이며 `last_event_at`(없으면 `claimed_at`)이 **lease 만료 후 2시간 이상** 지난 run을 `timed_out{code:"lease_abandoned"}`로 종결하고(승인 스위프와 같은 `end_parked_run_in_tx` 경로·종결 프레임), 수령되지 않은 `queued` run은 **24시간** 뒤 `timed_out{code:"unclaimed_expired"}`로 종결한다. 재claim으로 되살아난 run은 위 조건이 깨지므로 건드리지 않는다. 전달 job을 다른 에이전트로 옮기는 재배정은 하지 않는다. 「전달 job 이 settle 된 고아 run」(연결 해제·credential 폐기 뒤 남은 run)도 같은 코드 `lease_abandoned`로 끝낸다 — 에이전트가 그 run 에 보고할 길이 없기 때문이다(S5 검수 M-3). 7일 넘게 침묵한 유령은 채널 줄·rail 프레임 없이 조용히 끝낸다. 숫자는 환경변수로 봉인했다(`MOMO_RUN_LEASE_ABANDON_HOURS` 2, `MOMO_RUN_UNCLAIMED_EXPIRE_HOURS` 24).
- `awaiting_approval`은 절대 「작업 중」이 아니다(`workingSignal.ts` 머리말과 같은 규칙, 유지).

### D2. run 이벤트 원장 — 서버가 기억하고, 닫아도 남는다

**새 테이블 `agent_run_event`** (마이그레이션은 구현 시점의 다음 번호 — 현재 최신 127이므로 128 예상):

```
workspace_id  uuid NOT NULL           -- RLS 키
run_id        uuid NOT NULL           -- FK (workspace_id, run_id) → agent_run ON DELETE CASCADE
seq           bigint NOT NULL         -- run 안 단조 증가, PK (workspace_id, run_id, seq)
kind          text NOT NULL CHECK     -- 닫힌 어휘, 아래
stage         text                    -- ≤80자, work_session_share 단계 표식 검증 함수 재사용(복사 금지)
code          text                    -- 닫힌 사유 코드 (end_reason 등), 자유 서술 없음
approval_id   uuid
actor_member_id uuid                  -- 에이전트 또는 사람(승인자·취소자)
created_at    timestamptz NOT NULL DEFAULT now()
```

- `kind` 어휘(S1 구현 확정): `queued` · `claimed` · `started`(첫 `running`) · `stage` · `paused` · `resumed` · `approval_requested` · `approval_decided`(code=approved/rejected/expired/cancelled) · `succeeded` · `failed` · `timed_out` · `cancelled`. 도어벨은 run이 아니라 connection 단위 사실이라 원장 kind가 아니다(`hosted_agent_doorbell.last_fired_at/last_status`를 읽기에서 합친다). **→ 2026-10-14 증보가 `doorbell_rung`을 더해 이 문장을 바꾼다.** 하위 봇 위임은 별도 kind 없이 `stage`(「위임: …」)로 보고한다. `lease_renewed`는 잡음이라 넣지 않는다. 수명주기 행은 `agent_run`/`approval` 트리거가, `claimed`·`stage`는 서버 코드가 같은 SQL 함수(`agent_run_event_append`)로 쓴다. 200행 상한은 `agent_run_event_trim`(DELETE는 이 함수에만, 트리거 경로의 notifier 역할에는 DELETE 없음).
- 쓰기는 **이미 있는 전이 지점의 같은 tx**에서 한다: run 생성(`agent_runs::create`), 도어벨 결과(송신기 — `momo_relay` 역할이 이미 `hosted_agent_doorbell`을 쓴다), `jobs_claim`, `record_gateway_event_in_tx`, `action_propose`/`card_suggest`의 park, 승인 결정·만료 스위프, `complete_gateway_run_in_tx`, 취소. 생산자별 호출에 의존하지 않도록 **상태 전이 헬퍼 한 곳**(`append_run_event_in_tx`)을 거치게 하고, 우회 INSERT는 시험으로 막는다.
- **자유 텍스트를 새로 저장하지 않는다.** `stage`(≤80자, 기존 검증)와 닫힌 `code`뿐이다. `detail`은 여전히 감사 전용, `textDelta`는 저장하지 않는다(D5의 한계 참조). 표시는 일반 텍스트 이스케이프(증보 3 D15 그대로).
- **크기 상한.** run당 최대 200행. 초과하면 가장 오래된 **`stage`** 행부터 지운다(수명주기 행 `queued/claimed/started/approval_*/종결`은 지우지 않는다). `output.stages`(12개)와 `step_count`는 호환을 위해 그대로 쓴다.
- **보존.** `agent_run`과 함께 CASCADE. 별도로 종결 후 `SHARE_RETENTION_DAYS`(D13과 같은 상수)가 지나면 읽기가 거르고 notifier 정리가 삭제한다. 진행 중 run의 행은 지우지 않는다.
- **RLS.** `ENABLE`+`FORCE`, `ws_isolation` 정책(`workspace_id = current_setting('app.workspace_id', true)::uuid`), `momo_app` 앱 역할 GRANT, 쓰기 경로 BYPASSRLS 금지(도어벨 송신기만 기존 `momo_relay` 예외 범위 안에서 `kind='doorbell'`을 쓴다 — [확인 필요]: 송신기가 INSERT하는 대신 앱 쪽 스위프가 `last_status` 변화를 원장으로 옮기는 안도 가능, 구현 슬라이스 S1이 하나로 고정).
- **읽기 API.**
  - `GET /v1/workspaces/{ws}/agent-runs/{run}/events?after_seq=&limit=` (limit ≤200, 기본 100). 이미 `seq`로 이어 받는 단순 키셋. 가시성은 D3의 한 SQL.
  - 기존 `GET …/channels/{ch}/agent-runs`(와 `…/agents/{agent}/runs`)를 **확장**한다: 각 항목에 `phase`, `lease_state`, `queue_position`, `last_event_at`, `latest_stage`를 더한다. 새 목록 경로를 만들지 않는다. `?state=active`(종결 아님) 필터를 더해 작업 패널이 「진행 중인 run들」을 한 번에 받는다.
  - 여러 run은 **순서대로(대기열)와 병렬로(동시 진행)** 모두 같은 목록이다: `phase`와 `queued_at`으로 클라이언트가 그린다(대기 → 진행 → 종결 열, 동시 진행 run은 나란히). 병합 규칙(오래된 것 먼저)은 `byOldestTurn`을 유지한다.
- **실시간.** 원장 INSERT와 **같은 tx**에서 outbox INSERT → relay → Centrifugo(채널 토픽, 기존 `emit_rail_frame` 계열)로 `agent.run.event` 프레임 `{run_id, seq, kind}`을 보낸다. **프레임에는 stage 문자열을 싣지 않는다**(내용은 REST) — 가시성은 조회가 다시 강제한다(ADR-0194 D8 구조). `stage` 프레임은 run당 2초에 1개로 합친다(합쳐도 seq로 간격을 메운다: 클라는 마지막 seq 이후를 재조회). 클라이언트 직접 publish는 금지 그대로. 재연결·누락은 `after_seq` 재조회로 복구한다.

### D3. 대기열 공개

- 순번은 claim의 실제 순서(`outbox.id ASC`, 에이전트별)를 그대로 쓴다. 「대기 n번째」는 같은 에이전트의 `phase='queued'`인 run 중 내 run보다 `outbox.id`가 앞선 개수 + 1이다. **수령 가능한 job만** 센다(그 connection이 승인받은 채널의 job — claim 후보와 같은 술어).
- **누가 보나.** run 가시성은 D13과 같다: 읽는 사람이 `agent_run.channel_id`의 활성 멤버(채널 미보관·`left_at IS NULL`). 아니면 「멤버 아님」·「없는 run」·「다른 테넌트」가 모두 같은 404/빈 결과다. DM의 run은 그 DM의 두 사람에게만 보인다.
- **정보 누출 경계.** 내 run 앞에 **내가 볼 수 없는 다른 채널의 run**이 있어도 순번은 센다. 응답은 `queue_position`(정수)과 `ahead_total`만 주고, 앞선 run의 id·채널·요청자·제목은 **내가 멤버인 채널의 것만** `ahead[]`에 낸다. 남은 누출은 「이 에이전트가 지금 바쁘다」는 집계뿐이다. **[추정]** 이는 에이전트를 멘션할 수 있는 사람이 응답 지연으로 이미 체감하는 사실과 같은 수준이라 받아들인다(owner 결정 ④가 이 상한 대신 「순번 숨김」을 고르게 한다). 워크스페이스 전체 큐 조회 API는 만들지 않는다.
- `claimed` 이후에는 순번이 없다(`queue_position=null`).

### D4. 연결 생존 신호

**새 테이블 `hosted_agent_liveness`** (connection당 1행, PK `(workspace_id, connection_id)`, FK는 `hosted_agent_connection(workspace_id, id, agent_member_id)` CASCADE, RLS 위와 같음):

```
last_inbox_read_at   timestamptz   -- oort_inbox_read 성공
last_claim_at        timestamptz   -- oort_jobs_claim이 job을 실제로 가져감
last_run_event_at    timestamptz   -- oort_run_event/oort_run_complete/oort_action_propose
last_ping_at         timestamptz   -- oort_ping (D4-5), 30초 스로틀
last_ping_state      text          -- 'idle' | 'working'
last_tool_call_at    timestamptz   -- 인증된 어떤 Agent Port 도구 호출이든
last_tool_error_at   timestamptz   -- Unavailable/NotAuthorized 등 거절
last_tool_error_code text          -- 닫힌 코드(자유 서술 없음)
```

- 도어벨 `last_fired_at/last_status`는 기존 `hosted_agent_doorbell`에 있으므로 중복 저장하지 않고 **읽기에서 합친다.**
- **쓰기 비용.** `oort_inbox_read`는 순수 읽기라 이 신호가 그 호출을 쓰기로 바꾼다. 그래서 UPSERT는 **열별 30초 스로틀**(`… SET last_inbox_read_at = now() WHERE hosted_agent_liveness.last_inbox_read_at < now() - interval '30 seconds'`)이고, 인증 직후 같은 tx에서 한다. 스로틀에 걸려 쓰지 못한 호출은 실패가 아니다. (기존 `with_tenant_tx` 안, 새 역할·BYPASSRLS 없음.)
- **파생 상태** (서버가 계산해서 내려줌, 임계값은 환경변수·기본값은 아래):

| 상태 | 판정 | 표시 |
|---|---|---|
| `responsive` | 일 신호(`max(last_inbox_read_at, last_claim_at, last_run_event_at)`)가 `≤ 20분` 전 | 「응답함 · n분 전」 |
| `alive_idle` | 일 신호는 없거나 20분 초과인데 `last_ping_at`이 `≤ 20분` 전 | 「살아 있음 · 일은 안 가져감」 |
| `woken_not_collected` | 도어벨 `ok_2xx` 이후 `≥ 5분`이 지났는데 그 사이 `last_claim_at`·`last_inbox_read_at`이 도어벨 이후로 갱신되지 않았고, 수령 가능한 `queued` run이 있음 | 「깨웠지만 아직 안 가져감 · n분」(+ 다시 깨우기) |
| `work_waiting` | 수령 가능한 일감이 응답 창(20분) 넘게 기다렸는데 그 일감이 큐에 들어간 뒤 claim이 없음 — inbox를 읽거나 ping을 보내도 가리지 못함(도어벨 불필요, S3 보안 검수 M3). 단 quiet 창(60분) 안에 신호가 있는 에이전트에 한한다: 완전히 침묵한 에이전트는 `unresponsive`가 우선(재검수 M-A) | 「일감이 기다리는데 가져가지 않음 · n분」 |
| `quiet` | 마지막 신호(ping 포함)가 20~60분 전 | 「조용함 · 마지막 응답 n분 전」 |
| `unresponsive` | 마지막 신호(ping 포함)가 `> 60분` 전이거나 신호가 없음(`never`) | 「응답 없음 · n분」 |
| `error` | `last_tool_error_at`이 마지막 성공 호출(어떤 도구든)보다 새롭다. 거절 기록은 `Unavailable`/`NotAuthorized` 두 종류만 | 「호출이 거절됨 · <닫힌 사유>」 |

  `error`는 「가장 최근 사실이 거절」일 때만 켜진다: 다른 도구의 성공이 끼면 라벨은 풀리지만 `last_tool_error_*`는 관리자 상세에 남는다(한 도구만 계속 거절되는 경우는 거기서 읽는다 — S3 보안 검수 M2). 20분은 15분 루틴 + 여유, 60분은 lease 기본(30분)의 2배다. 숫자는 구현 티켓이 봉인한다. `connection.status='active'`는 표시에서 「연결됨(토큰 증명)」으로 이름을 바꿔 **「살아 있음」과 분리**한다(#3737의 지적).
- **어디에 보이나.** 멤버 목록의 에이전트 행, 에이전트 헤더, 작업 패널 머리. 읽기: `GET …/hosted-agent-connections`(기존 목록)와 `GET …/agents/{agent}`에 `liveness{state, last_signal_at, last_doorbell{at,status}, …}`를 더한다. 가시성은 기존 connection 읽기 권한(워크스페이스 admin·에이전트 소유자) + 채널 멤버에게는 **상태 라벨과 `last_signal_at`만**(오류 코드·도어벨 URL 등은 admin·소유자 전용).
- **「다시 깨우기」** — 둔다. `POST …/hosted-agent-connections/{id}/doorbell/ring`: 사람 JWT, 권한은 **그 에이전트의 소유자(연결 생성자 또는 `agent.owner_human_id`) 또는 워크스페이스 admin**(모두 현재 활성 워크스페이스 멤버; 채널 멤버 일반에게는 열지 않는다: 남용 시 소유자의 벤더 usage를 태운다, 증보 3 D16). 비허용·미존재 연결은 같은 404. 한도: connection당 **60초 쿨다운 + 시간당 5회**, 넘으면 429와 다음 가능 시각. 페이로드는 ADR-0171 D2 그대로 **내용 없는 신호**이고 기존 송신기 경로(코얼레싱·SSRF 정책 포함)를 재사용한다. `MOMO_DOORBELL_ENABLED`가 꺼져 있으면 빈 404, 도어벨 미등록·비활성 연결은 409. ring 은 도어벨 행을 재무장할 뿐(`pending_trailing`, 창 해제)이고 결과(`ok_200`/실패)는 기존 `lastFiredAt`/`lastStatus`로 보인다(원장 kind 아님).
- **`oort_ping`(에이전트 쪽 heartbeat 도구)을 넣는다** (성재 결재: 추천안 「넣지 않음」이 아니라 「생존 신호도 추가」). 초안은 ping이 「부르라고 배웠다」만 증명한다는 이유로 반대했고, 그 우려는 **ping을 일 수령 신호와 분리해서 판정**하는 것으로 처리한다(아래). 확정 계약(보수적 기본값):
  - **스키마.** 이름 `oort_ping`, 입력 `{ "state"?: "idle" | "working" }`(기본 `idle`, `additionalProperties:false`, 그 밖의 자유 텍스트 없음), 출력 `{ "status":"ok", "recorded": bool, "serverTimeMs": int, "minIntervalSeconds": 30 }`.
  - **권한.** 새 scope를 만들지 않는다(D3의 6-scope 상한 유지). 기존 `agent:inbox:read`를 요구하고, hosted 자격(`HostedCaller`)이어야 하며, **호출한 자격의 connection 한 행만** 쓴다(인자로 connection/agent를 받지 않는다). 비활성·해제된 connection, 다른 인증 경로는 기존 `authorize_in_tx`가 같은 `Unavailable`/`NotAuthorized`로 거절한다.
  - **남용 상한.** 서버 스로틀: connection당 **최소 30초**. 간격 안의 호출은 오류가 아니라 `recorded:false`로 성공 응답한다(에이전트 루틴이 재시도 루프에 빠지지 않게, 그리고 상한의 존재를 오류 신호로 쓰지 않게). 스로틀은 `UPDATE … WHERE last_ping_at IS NULL OR last_ping_at < now() - interval '30 seconds'` 한 문장이다.
  - **저장·감사.** `hosted_agent_liveness`에 `last_ping_at`, `last_ping_state` 두 열(닫힌 값). 호출마다 `audit_log` 행은 쓰지 않는다(잡음; 이 행이 기록이다). 오류 거절만 기존처럼 `last_tool_error_*`에 남는다.
  - **생존 판정에서의 위치.** ping은 **「살아 있음」만** 증명하고 「일을 가져감」은 증명하지 않는다. 일 신호(`last_inbox_read_at`·`last_claim_at`·`last_run_event_at`)가 ≤20분이면 `responsive`다. ping만 ≤20분이고 일 신호가 없거나 오래됐으면 새 상태 **`alive_idle`(「살아 있지만 일은 안 가져감」)** 이다. 수령 가능한 `queued` run이 있고 도어벨 이후 5분이 지났는데 일 신호가 없으면 ping이 있어도 `woken_not_collected`가 우선한다(살아 있어도 일을 안 가져간다는 것이 핵심 정보). `quiet`/`unresponsive`의 「마지막 신호」에는 ping도 포함한다.
  - **지시문 주기(D5).** 루틴 실행마다 시작 시 1회, 장기 작업 중에는 5분마다(작업 중이면 `run_event`가 같은 신호를 주므로 ping은 필수가 아니다).

### D5. 에이전트 지시문 보강과 보이는 것의 한계

`docs/SELF_HOST_AGENT.md` §3.3.17.4의 생산 루틴 문구와 도구 설명(`momo-mcp/src/tools.rs`)을 고친다. 규약:

0. **루틴 실행마다 시작 시 `oort_ping`을 1회**(`state:"idle"`). 추적되는 run 안에서는 `oort_run_event`가 5분 하트비트다 — ping 은 run 을 살려 두지 못한다(ping 만 하는 런타임은 `alive_idle`, 서버 정지 스위프 대상). leaseHandle 없이 바쁜 동안(추적되지 않는 회신)에만 5분마다 `state:"working"`. 30초 안 재호출은 `recorded:false`로 무시된다. Unavailable·429·5xx·시간 초과면 이번 wake 를 멈추고 루프로 재시도하지 않는다(S6 검수 M-2, L-1).
1. **수령 직후 60초 안에 `oort_run_event`를 한 번** 보낸다: `stage="시작: <한 줄 요약>"`.
2. **단계가 바뀔 때마다** `stage`를 보낸다. 형식: 한국어 동사구 **≤40자**(서버 상한은 80자), 비밀·URL 쿼리·토큰·경로 전체를 쓰지 않는다. 예: 「채널 이름 확인」「승인 카드 제안」「grokbot-lab 생성 대기」.
3. **작업 중에는 최소 5분마다** 보고한다. 보낼 단계가 없으면 `stage` 없이 `status="running"`만 보낸다(원장 행은 안 만들지만 `last_run_event_at`이 갱신된다 — 「살아 있음」 신호).
4. **하위 봇에게 위임하면 위임 자체를 단계로 보고한다**: 위임 때 `stage="위임: <봇> · <일>"`, 결과를 받으면 `stage="위임 결과 수신: <봇>"`. 서버는 하위 봇의 내부를 모른다.
5. `oort_action_propose`로 park하면 서버가 `approval_requested`를 남기므로 따로 보고하지 않고 turn을 끝낸다(ADR-0186 규칙 유지).
6. 루틴이 `Unavailable`을 받으면 같은 turn에서 재시도하지 말고 종료한다(다음 도어벨/폴링에서 재수립). 서버는 D4의 `last_tool_error_*`로 이를 기록한다.

**한계 (화면에 정직하게 적는다).** 보이는 사고 과정은 **에이전트가 `stage`/`textDelta`로 내보낸 만큼**이다. `textDelta`는 저장되지 않고 지나가는 동안에만 보이며, 패널을 늦게 열면 이미 지나간 delta는 없다(원장에는 단계 표식만). 에이전트가 아무것도 보내지 않으면 oort는 「가져갔고 n분째 보고 없음」까지만 말할 수 있고 내부 추론을 알 수 없다. 이 지시문은 규약이지 보증이 아니며(증보 3 D16의 `runtime-unverified` 규율) 실계정 동작은 별도 `[manual]` 증거 전까지 카피에 「실시간」을 쓰지 않는다.

### D6. 이 ADR이 열지 않는 것

- 사고 과정 전문 저장·터미널 바이트·원격 입력(증보 3 D15/D17 유지).
- 서버 쪽 재배정(다른 에이전트로 job 이전)·자동 재시도. 스위프는 종결만 한다.
- 관리형(momo-agent worker)·BYOA gateway run의 클라이언트 휴리스틱 폐기. 이번 범위는 **hosted 에이전트**이고, 다른 종류는 기존 90초 규칙을 두되 문구만 「신호 소실」 대신 「조용함」으로 낮추는 것은 UXUI 슬라이스가 같이 한다(서버 사실이 없는 곳에서 단정하지 않는다).
- 워크스페이스 전체 큐/대시보드, 푸시 알림 신규 reason(「응답 없음」 푸시는 후속).
- 새 scope·새 인증 경로. 새 MCP 도구는 `oort_ping` 하나뿐이다.

## 대안과 기각

| 대안 | 기각 이유 |
|---|---|
| A. 클라이언트 TTL만 늘림(90s→15분) | 라벨이 여전히 추정이다. 15분 루틴이 늦으면 또 틀리고, 기록이 휘발한다는 문제는 그대로. |
| B. `audit_log`를 원장으로 | 관리자 감사 표면, 채널 멤버 읽기 경로·run별 순서·보존 정책이 없고 `detail`이 감사 전용(D11). 읽기 권한을 넓히면 감사 로그의 경계가 흐려진다. |
| C. `output.stages` 상한(12)만 올림 | 시각·수령·대기·승인 사실이 없고, 이벤트마다 run 행 jsonb를 잠금 아래 다시 쓴다. 「닫아도 남는 기록」은 해결해도 「몇 번째·언제 가져갔나」는 못 푼다. |
| D. `oort_ping`을 일 신호와 **합쳐서** 「응답함」으로 판정 | 거짓 양성(ping만 부르고 일을 안 가져가도 정상으로 보임). 결재로 ping 자체는 도입하되 판정을 `alive_idle`로 분리(D4-5). |
| E. 서버가 에이전트에 능동 프로브(도어벨로 상태 질의) | 도어벨은 내용 0 신호(ADR-0171 D2)이고 응답을 받는 채널이 없다. 수령 사실(`last_claim_at`)이 더 직접적이다. |
| F. 큐 전체를 모든 멤버에게 공개 | 다른 채널의 제목·요청자 누출. D3은 집계 숫자까지만. |
| G. lease 만료 즉시 run 실패 처리 | 부록 A3(암묵 갱신)을 깨고, 늦게 깨어난 정상 에이전트의 작업을 버린다. 대신 표시는 즉시, 종결은 유예(D1-4). |
| H. MCP Tasks를 SoT로 | 증보 3 D9/D17이 이미 기각. |

**업계 비교 (외부 자료를 이번에 새로 확인하지는 않았다. 일반 지식 수준, [확인 필요] 문구 인용 전 재확인).** Slack 앱의 어시스턴트 상태(`assistant.threads.setStatus` 계열)는 앱이 자기 보고하는 문자열이고 서버가 사실로 검증하지 않는다 — D5의 「자기 보고」 한계와 같다. GitHub Actions는 job을 `queued/in_progress/completed`로 나누고 러너 오프라인을 서버 heartbeat로 판정하지만 큐 순번은 노출하지 않는다 — 우리는 상태 어휘와 서버 판정은 따르고 순번은 가시성 경계 안에서 더한다. Linear의 agent session은 세션 상태와 함께 활동(thought/action/response/elicitation) 로그를 남겨 UI가 읽는다 — D2 원장과 같은 모양(이력은 서버, 표시는 UI)이다.

## 귀결

- (+) 「신호 소실」 오표시가 사라지고, 11분 미수령은 「대기 중 · 미수령 11분 · 깨웠지만 아직 안 가져감」으로 정직하게 보인다. 12:35 시간 초과도 「승인이 만료됨」으로 남는다.
- (+) 패널을 닫아도 기록이 남고 다른 기기에서도 같은 기록을 본다.
- (+) 「연결됨」과 「살아 있음」이 분리된다.
- (−) 새 테이블 2개와 hot path(`inbox_read`)의 스로틀된 쓰기. 쓰기 폭증 지표를 구현 PR이 측정한다.
- (−) 스위프가 run을 종결시키는 새 상태 변경(`lease_abandoned`, `unclaimed_expired`). 임계값 오설정 시 정상 느린 에이전트의 run이 종결될 수 있다(2시간 유예·환경변수로 완화).
- (−) 지시문은 규약이라 에이전트가 따르지 않으면 단계가 비어 보인다 — 그래서 「마지막 보고 n분 전」을 항상 같이 보인다.

## 불변식 대조

- REST send → seq 증가 + message INSERT + outbox INSERT 단일 tx: 원장 INSERT는 상태 전이와 **같은 tx**에서 outbox와 함께 쓴다. 클라이언트 직접 publish 없음. 순서는 `agent_run_event.seq`, 멱등은 기존 `eventId`(`run_event_recorded`) 재사용. 
- 에이전트는 `member.kind='agent'` 1급 멤버: 원장 `actor_member_id`가 에이전트 멤버.
- 모든 테넌트 경로 `workspace_id` + RLS FORCE + `SET LOCAL app.workspace_id`: 신규 두 테이블 모두. 쓰기 경로 BYPASSRLS 금지(송신기 기존 예외만).
- `schema_v0.sql` 불변, 신규 migration으로 확장. sqlx 런타임 쿼리.
- 공개 API 변경 → 이 Accepted가 머지 조건(ADR-0100).

## 결재 기록 (2026-10-13, 성재 AskUserQuestion)

1. 진행 기록 → 「새 기록 테이블 (Recommended)」 — `agent_run_event` (D2).
2. 죽은 작업 → 「서버가 끝내기 (Recommended)」 — lease 만료 후 2시간 무소식 `lease_abandoned`, 24시간 미수령 `unclaimed_expired` (D1-4).
3. 생존 판단 → **「생존 신호도 추가」**(추천안과 다름). 선택지 설명 인용: 「에이전트가 주기적으로 「살아 있음」을 보내는 도구(oort_ping)도 넣어요. 그록봇 지시문에 주기를 넣어야 해요.」 활동 기록 기반 파생 상태와 「다시 깨우기」(소유자·admin, 60초 쿨다운, 시간당 5회)는 유지하고 `oort_ping`을 더한다 (D4-5, 보수적 기본값은 planner 확정).
4. 대기열 공개 → 「내 채널만 자세히 (Recommended)」 — 내가 멤버인 채널의 앞선 run은 상세, 다른 채널은 「앞에 N건」 숫자만 (D3).

## 구현 슬라이스 (Accepted 후)

의존: S1 → S2·S3 → S5. U1은 S2 계약이 고정되면 mock으로 병행 가능. 각 슬라이스는 한 이슈·한 PR이고 서버는 engine, 화면은 UXUI 트랙.

**서버 (engine)** — 구현 순서 S1→S6, 각각 별도 이슈·PR을 앞 슬라이스 위에 쌓는다. `oort_ping`은 S3에 포함.
- **S1 스키마·원장 쓰기.** 마이그레이션 `agent_run_event`·`hosted_agent_liveness` + RLS/GRANT, `append_run_event_in_tx` 헬퍼, 전이 지점 연결(생성·claim·run_event·park·승인 결정/만료·complete·취소·도어벨 결과). red proof: ① claim이 `claimed` 행을 남기지 않으면 실패 ② 승인 만료 스위프가 `timed_out`+`approval_expired` 행을 남기지 않으면 실패 ③ 타 테넌트가 행을 못 읽음(RLS) ④ run당 201번째 `stage`가 수명주기 행을 지우지 않음 ⑤ 같은 `eventId` 재시도가 행을 두 번 만들지 않음.
- **S2 읽기 API.** `…/agent-runs/{run}/events`, 채널·에이전트 run 목록 확장(`phase/lease_state/queue_position/ahead/latest_stage`, `?state=active`). red proof: queued 두 건 중 나중 것이 `queue_position=2`; 수령 후 `null`; 다른 채널 run은 `ahead_total`에만 반영되고 id·제목이 응답에 없음; 멤버 아님은 404; mention run 포함.
- **S3 생존 신호 + `oort_ping`.** 스로틀 UPSERT(인증된 도구 호출 5곳), `oort_ping` 도구(D4-5), 파생 상태 계산(임계값 환경변수), connection·agent 읽기에 `liveness`, `last_tool_error_*`. red proof: 30초 안 두 번째 `inbox_read`는 쓰지 않음; `Unavailable` 거절이 `last_tool_error_code`로 남음; 도어벨 이후 미수령 5분 경과 시 `woken_not_collected`; 신호 없음은 `unresponsive`(never) — 「active」여도; ping만 있고 일 신호가 없으면 `alive_idle`; 30초 안 재ping은 `recorded:false`이고 열이 안 움직임; 다른 connection의 liveness 행을 쓰지 못함.
- **S4 다시 깨우기.** ring 엔드포인트+송신기 소비, 소유자/admin 권한, 60초·시간당 5회 한도. red proof: 권한 없음 404, 쿨다운·시간당 429, 도어벨 꺼짐 빈 404, 미등록 409, 페이로드에 내용 없음, 동시 요청 중 하나만 성공, disconnect 와 락 순서 동일(ADR-0171 D2 시험 재사용).
- **S5 실시간·보존·스위프.** `agent.run.event` 프레임(stage 합치기 2초, 프레임에 stage 문자열 없음), 보존 정리, 결정 ② 승인 시 `lease_abandoned`/`unclaimed_expired` 스위프. red proof: 프레임 JSON에 stage가 없음; 재claim으로 되살아난 run은 스위프가 건드리지 않음; 임계 직전은 종결하지 않음.
- **S6 지시문.** `SELF_HOST_AGENT.md` §3.3.17.4와 도구 설명을 D5 규약으로 갱신(`runtime-unverified` 표기, 실계정 `[manual]` 증거는 별도). docs 게이트.

**UXUI**
- **U1 core 판정 교체.** `momo-core`: 서버 `phase`/`lease_state`를 문구로 옮기는 순수 함수, hosted run의 `workLogLiveness`/`isStaleSignal`/zombie 경로 제거(「신호 소실」 문구 삭제), 이벤트 원장 재조회(`after_seq`)+realtime 프레임 병합. red proof: 마지막 활동이 11분 전이어도 `phase=queued`면 「신호 소실」이 아니라 「대기 중」; 서버가 `timed_out/approval_expired`를 주면 그 사유 문구.
- **U2 작업 패널.** 패널을 열면 서버 기록을 읽고, 닫아도 기록이 남으므로 「패널을 닫으면 이 기록은 사라집니다」 고지를 지운다(`WORK_LOG_CLOSE_NOTICE`). 여러 run을 대기 → 진행 → 종결 순서로, 동시 진행은 나란히. 승인 대기는 카드로 링크. 「아직 도착한 진행이 없습니다」는 수령 전/후 문구로 분기. 「실행 중인 작업」 띠와 채널 「작업 중」 배지는 `phase=running`만 「작업 중」, `queued`는 「대기 중」, `awaiting_approval`은 「승인 대기」.
- **U3 생존 표시.** 멤버 목록·에이전트 헤더·작업 패널 머리의 liveness 라벨(D4 문구), 「연결됨」 vs 「응답함」 분리, 「다시 깨우기」 버튼(소유자/admin에게만, 쿨다운 표시).
- **U4 폰.** 같은 읽기 계약을 폰 시트에 적용(`momo-core` 순수 함수 공유). UI 변경이므로 각 슬라이스는 해당 표면 preflight와 design-review Blocker 0·High 0, 캡처 전달.

## 증보 2026-10-14 (#3822) — 도어벨 깨움을 대기 중 run 원장에 기록

- Status: Accepted 범위의 **관측 추가**다(기존 원장 의미·권한·읽기 계약을 좁히거나 넓히지 않는다). 새 결정이 owner 몫인 곳은 없다(아래 「왜 owner 결정이 필요 없는가」).
- 배경: 성재(2026-10-14) 「프로필 변경 작업 자체가 너무 오래걸려… 웹훅으로 작업을 요청하는게 아니야?」 운영 실측에서 도어벨 발사 이력은 `hosted_agent_doorbell.last_fired_at` **마지막 1건**만 남아 「이벤트→발사→그록 기동→claim」 구간을 나눌 수 없었다. D2는 도어벨을 connection 단위 사실이라 원장 밖에 두었는데, 그 결과 run 하나의 대기 시간을 원장만으로 설명할 수 없다.

**바뀌는 것 (D2의 한 문장).** `agent_run_event.kind`에 **`doorbell_rung`** 하나를 더한다(마이그레이션 132는 `agent_run_event_kind_ck`만 바꾼다). 어휘는 12개에서 13개가 된다.

| 항목 | 값 |
|---|---|
| 쓰는 곳 | 도어벨 송신기(`momo-webhook-sender`)가 발사를 끝낸 직후(성공·실패 모두), 기존 `agent_run_event_append`로 |
| 쓰는 대상 | 그 connection의 에이전트가 맡은 run 중 **`queued`이고 `claimed` 행이 아직 없는 것**(대기 중). 한 번에 최대 20개 |
| `code` | 닫힌 토큰 **`<edge>_<result>`**: edge = `leading`(창이 닫혀 있던 첫 이벤트) · `trailing`(합쳐 둔 이벤트·수동 「다시 깨우기」) · `urgent`(추적 작업 `agent_job`이 쿨다운을 건너뛴 발사), result = `ok` · `failed`. 예: `leading_ok`, `urgent_failed` |
| `created_at` | 발사가 끝난 시각(HTTP 응답 뒤). 재시도가 있으면 그 끝 |
| 싣지 않는 것 | HTTP 상태·호스트·사유·`stage`·행위자·승인 id. 그건 `hosted_agent_doorbell.last_status`(소유자·admin 전용)와 감사 로그에 그대로 남는다 |
| 상한 | run당 `doorbell_rung` **10행**(그 뒤는 쓰지 않는다). 몇 시간 기다리는 run의 원장이 쿨다운마다 자라지 않는다 |
| 활동으로 세지 않음 | `last_event_at`(작업 패널의 「마지막 신호」)에서 제외한다. 우리가 보낸 신호는 에이전트의 활동이 아니다 |
| 실시간 | 130의 AFTER INSERT 트리거가 그대로 얇은 `agent.run.event` 프레임(`kind`만)을 낸다. 프레임 스키마 불변 |

- **읽기 계약.** `GET …/agent-runs/{run}/events`의 `kind` enum에 `doorbell_rung`이 늘고 `code`는 위 토큰이다. **기존 클라이언트는 알 수 없는 kind를 만나면 원장 전체를 `WireShapeError`로 거부한다**(`parseAgentRunEvents`, 실측 확인). 그래서 읽기는 **기본으로 `doorbell_rung`을 빼고**, 새 선택 쿼리 `?include=doorbell`을 줄 때만 싣는다(그 외 값은 400). 이미 배포된 맥·웹·폰 클라이언트는 응답이 그대로라 깨지지 않고, 표시를 만드는 UXUI 이슈가 이 쿼리를 켠다. 실시간 프레임은 `kind`를 문자열로만 읽어 재조회 신호로 쓰므로 영향이 없다. 클라이언트 표시 문구 **「깨움 보냄」**(보조 줄: 시각, `…_failed`면 「깨움이 닿지 않았어요」)은 UXUI 이슈로만 연다. 서버는 문구를 내려주지 않는다.
- **쿨다운 규칙 (ADR-0171 D4 보강, 관측이 아니라 동작 변경이라 별도 기록).** 메시지 이벤트는 D4 그대로 합친다. **추적되는 작업(`agent_job` 인박스 이벤트)은 쿨다운 창이 열려 있어도 기다리지 않고 즉시 발사**하되, 도어벨 폭주를 막는 상한으로 **같은 connection에서 `MOMO_DOORBELL_URGENT_GAP_SECONDS`(기본 10, 최소 1)초에 한 번**만 쏜다. 간격 안에 들어온 작업은 소비하지 않고 보류해 두었다가 간격이 끝나는 첫 폴링에서 한 번에 깨운다(유실 없음). 페이로드·인증·SSRF 방어·재시도는 불변이다. connection당 최대 분당 6회(작업 기준), 메시지는 이전처럼 분당 1회 안팎이다. 이전에는 쿨다운이 끝날 때까지(최대 60초) 두 번째 요청이 깨움 없이 기다렸다.
- **왜 owner 결정이 필요 없는가.** ① 새 저장소·새 테이블·새 권한이 없다: 같은 테이블의 CHECK 어휘 한 줄, 같은 SQL 함수. ② 새로 보이는 정보가 없다: 이미 run을 볼 수 있는 사람이 보는 원장에 「깨웠다/못 깨웠다」 두 값과 시각이 추가될 뿐이고, 호스트·상태 코드는 일부러 뺐다. ③ 외부로 나가는 것이 없다: 웹훅 페이로드·대상·인증은 불변이고 발사 빈도만 작업 이벤트에 한해 최대 6배(분당 1→6) 상한으로 는다. ④ D2가 도어벨을 원장 밖에 둔 이유(connection 단위 사실)는 그대로이고, 이 증보는 그 사실을 **대기 중인 run들에 복사**한 관측 행을 더할 뿐 `hosted_agent_doorbell`의 의미를 바꾸지 않는다. owner가 반대하면 마이그레이션 132와 송신기 호출 한 곳을 되돌리면 된다(읽기 쪽은 알 수 없는 kind를 무시).
- **쓰기 경로 경계.** 송신기는 `momo_relay`(BYPASSRLS, 전 테넌트 폴링 예외)로 쓰되, 기존에 이미 `hosted_agent_doorbell`을 쓰던 그 예외 범위 안이다. tx마다 `app.workspace_id`를 설정하고 `workspace_id`를 모든 조건에 건다(교차 테넌트 시험 포함). 원장 쓰기가 실패해도 이미 나간 발사 결과는 바뀌지 않는다(로그만).
- **측정 용도.** 같은 run의 `queued` → `doorbell_rung` → `claimed` → `started` 시각 차이가 「oort→웹훅」·「웹훅→그록 기동」·「claim→시작」 구간이다(2026-10-14 실측 표는 #3822 PR 본문).

