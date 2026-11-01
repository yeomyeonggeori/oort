# ADR-0200: 외부 에이전트 작업 상태를 사실대로 — run 상태 어휘·이벤트 원장·대기열·생존 신호

- Status: **Accepted** (2026-10-13 성재 결재 — 아래 「결재 기록」. 공개 API·DB 계약 변경이라 ADR-0100에 따라 이 Accepted가 구현 머지 조건이다.) 초안은 같은 날 Proposed였고 결재로 D4-5(`oort_ping`)가 추천안과 달라졌다.
- Date: 2026-10-13
- Deciders: 성재
- 증보: 2026-10-14 (#3822) 도어벨 깨움 `doorbell_rung` · 2026-10-15 (#3838) oort 호출 기록 `tool_call`(T1~T5)·「지금 실행 중」 읽기(R1) · 2026-10-24 증보 3 (#4332) 깨웠는데 가져가지 않은 run 종결 `woken_not_collected`(30분)·환영 run 종결은 조용히·환영 대상 정책·notifier 열 읽기 · **2026-10-27 증보 4 (#4618) Accepted(planner 위임, owner 사후 보고 2026-10-27) — Agent Port 호출 기록 `agent_port.call`: 깨어서 무엇을 부르고 멈추는지** · **2026-10-27 증보 5 (#4622) Accepted(planner 위임, owner 방향 승인 2026-10-26 「ㄱㄱ」 — #4577 C·E) — D5 증보: 대화에는 무엇을 쓰나·진행은 stage로·빈 인사 금지·답 자리. 스레드 안에서 부른 일의 최종 답은 같은 스레드에(ADR-0148 증보), 채널 최상위 멘션의 새 스레드는 #4646** — 증보 5 절 · **2026-10-27 증보 6 (#4621) Accepted(planner 위임, owner 사후 보고 2026-10-27) — 에이전트 확인 박자 `cadence`: 「다음 확인 때 가져가요」의 근거(루틴형이면 박자와 마감, 모르면 「모름」)** — 증보 6 절 · **2026-11-01 증보 7 (#4655) Proposed — 에이전트 활동 보고 `activities[]`·`plan[]`(종류+짧은 라벨)·원장 종류 `activity`·`plan`·생각은 저장하지 않음·보고 박자 60초(owner 결정 Q1~Q3은 권장안, planner가 원문 확인 뒤 Accepted로 올려요)** — 증보 7 절(파일 끝).
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
- **D1-4. 영원히 `running`인 run 방지.** 하드 종결은 클라 TTL이 아니라 서버 스위프의 명시적 사실로 한다(결재 2). notifier 스위프가 `running/claimed`이고 `lease_state=stale`이며 `last_event_at`(없으면 `claimed_at`)이 **lease 만료 후 2시간 이상** 지난 run을 `timed_out{code:"lease_abandoned"}`로 종결하고(승인 스위프와 같은 `end_parked_run_in_tx` 경로·종결 프레임), 수령되지 않은 `queued` run은 **24시간** 뒤 `timed_out{code:"unclaimed_expired"}`로 종결한다. 재claim으로 되살아난 run은 위 조건이 깨지므로 건드리지 않는다. 전달 job을 다른 에이전트로 옮기는 재배정은 하지 않는다. 「전달 job 이 settle 된 고아 run」(연결 해제·credential 폐기 뒤 남은 run)도 같은 코드 `lease_abandoned`로 끝낸다 — 에이전트가 그 run 에 보고할 길이 없기 때문이다(S5 검수 M-3). 7일 넘게 침묵한 유령은 채널 줄·rail 프레임 없이 조용히 끝낸다. 숫자는 환경변수로 봉인했다(`MOMO_RUN_LEASE_ABANDON_HOURS` 2, `MOMO_RUN_UNCLAIMED_EXPIRE_HOURS` 24). → **2026-10-24 증보 3**이 초인종이 닿았는데 수령·생존 증거 없이 30분이 지난 run을 `woken_not_collected`로 끝내는 규칙과, 환영 run의 종결 줄·종결 프레임을 남기지 않는 규칙을 더한다(24시간 값은 그대로).
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

- `kind` 어휘(S1 구현 확정): `queued` · `claimed` · `started`(첫 `running`) · `stage` · `paused` · `resumed` · `approval_requested` · `approval_decided`(code=approved/rejected/expired/cancelled) · `succeeded` · `failed` · `timed_out` · `cancelled`. 도어벨은 run이 아니라 connection 단위 사실이라 원장 kind가 아니다(`hosted_agent_doorbell.last_fired_at/last_status`를 읽기에서 합친다). **→ 2026-10-14 증보가 `doorbell_rung`을 더해 이 문장을 바꾼다.** **→ 2026-10-15 증보(T1)가 `tool_call`을 더한다(14개, `?include=tools` 뒤에서만 읽힘).** **→ 증보 7(Proposed)이 `activity`·`plan`을 더한다(16개, `?include=activity` 뒤에서만 읽힘).** 하위 봇 위임은 별도 kind 없이 `stage`(「위임: …」)로 보고한다. `lease_renewed`는 잡음이라 넣지 않는다. 수명주기 행은 `agent_run`/`approval` 트리거가, `claimed`·`stage`는 서버 코드가 같은 SQL 함수(`agent_run_event_append`)로 쓴다. 200행 상한은 `agent_run_event_trim`(DELETE는 이 함수에만, 트리거 경로의 notifier 역할에는 DELETE 없음).
- 쓰기는 **이미 있는 전이 지점의 같은 tx**에서 한다: run 생성(`agent_runs::create`), 도어벨 결과(송신기 — `momo_relay` 역할이 이미 `hosted_agent_doorbell`을 쓴다), `jobs_claim`, `record_gateway_event_in_tx`, `action_propose`/`card_suggest`의 park, 승인 결정·만료 스위프, `complete_gateway_run_in_tx`, 취소. 생산자별 호출에 의존하지 않도록 **상태 전이 헬퍼 한 곳**(`append_run_event_in_tx`)을 거치게 하고, 우회 INSERT는 시험으로 막는다.
- **자유 텍스트를 새로 저장하지 않는다.** `stage`(≤80자, 기존 검증)와 닫힌 `code`뿐이다. `detail`은 여전히 감사 전용, `textDelta`는 저장하지 않는다(D5의 한계 참조). 표시는 일반 텍스트 이스케이프(증보 3 D15 그대로). **→ 증보 7(Proposed, 7-3)이 이 문장을 이 범위에서 바꾼다: 에이전트가 쓴 글 열이 `stage`(≤80자)·활동 `label`(≤40자)·계획 `text`(≤60자) 셋이 되고 모두 같은 문자 규칙을 지난다(여기에 보이는 식별자 `activity_id`, 닫힌 글자 ≤32자가 더해진다).**
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
- **정보 누출 경계.** 내 run 앞에 **내가 볼 수 없는 다른 채널의 run**이 있어도 순번은 센다. 응답은 `queue_position`(정수)과 `ahead_total`만 주고, 앞선 run의 id·채널·요청자·제목은 **내가 멤버인 채널의 것만** `ahead[]`에 낸다. 남은 누출은 「이 에이전트가 지금 바쁘다」는 집계뿐이다. **[추정]** 이는 에이전트를 멘션할 수 있는 사람이 응답 지연으로 이미 체감하는 사실과 같은 수준이라 받아들인다(owner 결정 ④가 이 상한 대신 「순번 숨김」을 고르게 한다). 워크스페이스 전체 큐 조회 API는 만들지 않는다. **→ 2026-10-15 증보(R1)가 「내가 멤버인 채널의」 지금 실행 중 목록과 에이전트별 동시 수를 연다. 워크스페이스 전체 큐는 여전히 없다.**
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
1. **수령 직후 60초 안에 `oort_run_event`를 한 번** 보낸다: `stage="시작: <한 줄 요약>"`. (→ 증보 7(Proposed, 7-5): 10초 안이 권장이고 60초는 한도다. 말만 통일하고 한도는 그대로다.)
2. **단계가 바뀔 때마다** `stage`를 보낸다. 형식: 한국어 동사구 **≤40자**(서버 상한은 80자), 비밀·URL 쿼리·토큰·경로 전체를 쓰지 않는다. 예: 「채널 이름 확인」「승인 카드 제안」「grokbot-lab 생성 대기」.
3. **작업 중에는 최소 5분마다** 보고한다. **→ 증보 7(Proposed, 7-5; owner 결정 Q3)이 「최소 60초마다」로 바꾼다.** 보낼 단계가 없으면 `stage` 없이 `status="running"`만 보낸다(원장 행은 안 만들지만 `last_run_event_at`이 갱신된다 — 「살아 있음」 신호).
4. **하위 봇에게 위임하면 위임 자체를 단계로 보고한다**: 위임 때 `stage="위임: <봇> · <일>"`, 결과를 받으면 `stage="위임 결과 수신: <봇>"`. 서버는 하위 봇의 내부를 모른다.
5. `oort_action_propose`로 park하면 서버가 `approval_requested`를 남기므로 따로 보고하지 않고 turn을 끝낸다(ADR-0186 규칙 유지).
6. 루틴이 `Unavailable`을 받으면 같은 turn에서 재시도하지 말고 종료한다(다음 도어벨/폴링에서 재수립). 서버는 D4의 `last_tool_error_*`로 이를 기록한다.

**한계 (화면에 정직하게 적는다).** 보이는 사고 과정은 **에이전트가 `stage`/`textDelta`로 내보낸 만큼**이다. `textDelta`는 저장되지 않고 지나가는 동안에만 보이며, 패널을 늦게 열면 이미 지나간 delta는 없다(원장에는 단계 표식만). 에이전트가 아무것도 보내지 않으면 oort는 「가져갔고 n분째 보고 없음」까지만 말할 수 있고 내부 추론을 알 수 없다. 이 지시문은 규약이지 보증이 아니며(증보 3 D16의 `runtime-unverified` 규율) 실계정 동작은 별도 `[manual]` 증거 전까지 카피에 「실시간」을 쓰지 않는다. → 2026-10-29 owner 결정(#4755 결정 2)이 이 한계를 다시 확인한다: 진행 메모(`stage`, 표시 40자)만 남고 흐르는 생각 글(`textDelta`)은 저장하지 않는다. 새 결정이 아니다(#4655 Q2와 같다). 화면 규칙은 `docs/design-system/agent-request-loop.md` 3절, 서버 계약은 [ADR-0186](0186-agent-workspace-actions.md) 증보 v6.

### D6. 이 ADR이 열지 않는 것

- 사고 과정 전문 저장·터미널 바이트·원격 입력(증보 3 D15/D17 유지).
- 서버 쪽 재배정(다른 에이전트로 job 이전)·자동 재시도. 스위프는 종결만 한다.
- 관리형(momo-agent worker)·BYOA gateway run의 클라이언트 휴리스틱 폐기. 이번 범위는 **hosted 에이전트**이고, 다른 종류는 기존 90초 규칙을 두되 문구만 「신호 소실」 대신 「조용함」으로 낮추는 것은 UXUI 슬라이스가 같이 한다(서버 사실이 없는 곳에서 단정하지 않는다).
- 워크스페이스 전체 큐/대시보드, 푸시 알림 신규 reason(「응답 없음」 푸시는 후속). **→ 2026-10-15 증보(R1)가 멤버 채널 범위의 「지금 실행 중」 읽기만 연다.**
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
- **쿨다운 규칙 (ADR-0171 D4 보강, 관측이 아니라 동작 변경이라 별도 기록).** 메시지 이벤트는 D4 그대로 합친다. **추적되는 작업(`agent_job` 인박스 이벤트)은 쿨다운 창이 열려 있어도 기다리지 않고 즉시 발사**하되, 도어벨 폭주를 막는 상한으로 **같은 connection에서 `MOMO_DOORBELL_URGENT_GAP_SECONDS`(기본 10, 최소 1)초에 한 번**만 쏜다. 간격 안에 들어온 작업은 소비하지 않고 보류해 두었다가 간격이 끝나는 첫 폴링에서 한 번에 깨운다(유실 없음). 페이로드·인증·SSRF 방어·재시도는 불변이다. connection당 **발사는 최대 분당 6회**(작업 기준)이고, HTTP 시도는 발사마다 최대 3번(재시도 2회)이라 **최악 분당 약 18회**다(이전 최악 3회). 메시지는 이전처럼 분당 1회 안팎이다. 간격 안의 작업만 있는 connection은 claim 집합에서 아예 빼서(`claim_doorbell_batch`) 보류 중에 폴링을 헛돌리지 않는다. 전역 상한은 없고 connection 수에 선형이며, 느린 대상이 발사 루프를 붙잡는 기존 구조(순차 발사)는 그대로다. 이전에는 쿨다운이 끝날 때까지(최대 60초) 두 번째 요청이 깨움 없이 기다렸다.
- **왜 owner 결정이 필요 없는가.** ① 새 저장소·새 테이블·새 권한이 없다: 같은 테이블의 CHECK 어휘 한 줄, 같은 SQL 함수. ② 새로 보이는 정보가 없다: 이미 run을 볼 수 있는 사람이 보는 원장에 「깨웠다/못 깨웠다」 두 값과 시각이 추가될 뿐이고, 호스트·상태 코드는 일부러 뺐다. ③ 외부로 나가는 것이 없다: 웹훅 페이로드·대상·인증은 불변이고 발사 빈도만 작업 이벤트에 한해 최대 6배(분당 1→6) 상한으로 는다. ④ D2가 도어벨을 원장 밖에 둔 이유(connection 단위 사실)는 그대로이고, 이 증보는 그 사실을 **대기 중인 run들에 복사**한 관측 행을 더할 뿐 `hosted_agent_doorbell`의 의미를 바꾸지 않는다. owner가 반대하면 마이그레이션 132와 송신기 호출 한 곳을 되돌리면 된다(읽기 쪽은 알 수 없는 kind를 무시).
- **쓰기 경로 경계.** 송신기는 `momo_relay`(BYPASSRLS, 전 테넌트 폴링 예외)로 쓰되, 기존에 이미 `hosted_agent_doorbell`을 쓰던 그 예외 범위 안이다. `relay`는 이미 모든 테넌트 테이블 DML 권한과 원장 시퀀스 USAGE를 가졌고(128) 이 변경은 권한을 늘리지 않는다. BYPASSRLS라 RLS가 안전망이 아니므로 **방어선은 SQL의 `workspace_id`·`connection_id` 조건뿐**이고(모든 서브쿼리에 걸었고 교차 테넌트 시험이 있다), `set_config('app.workspace_id')`는 RLS 역할로 바뀌어도 같은 쿼리가 맞게 도는 습관일 뿐 보호 수단이 아니다. 원장 쓰기가 실패해도 이미 나간 발사 결과는 바뀌지 않는다(로그만).
- **보이는 정보 (보안 검수 M-2 반영).** `include=doorbell`로 읽으면 run을 볼 수 있는 채널 멤버 누구나 「깨움이 닿았나(`ok`/`failed`)」와 시각을 본다. `hosted_agent_doorbell.last_status`는 소유자·admin 전용이지만 이 한 비트는 일반 멤버에게도 「왜 안 가져가나」를 설명하는 데 필요해서 의도적으로 연다. 에이전트의 대기 run 전부에 같은 행이 찍히므로 다른 채널의 이벤트 때문에 난 발사 시각이 보일 수 있고(`urgent`는 그 이벤트가 작업이었음까지), 내용·채널·사람은 드러나지 않는다. 이 노출이 과하다고 보면 `ok`/`failed`를 합쳐 `rung` 한 값으로 줄이면 된다(마이그레이션 변경 없음, 송신기 한 줄).
- **롤아웃·롤백 (보안 검수 M-1 반영).** 새 필터는 새 서버에만 있다. 한 이미지로 api·송신기가 함께 오르는 배포에서는 같은 순간에 바뀌지만, **구 서버 이미지로 롤백하면** 이미 쌓인 `doorbell_rung` 행이 필터 없이 내려간다. 롤백 절차: 구 이미지로 돌리기 **전에** `DELETE FROM agent_run_event WHERE kind = 'doorbell_rung';` (CHECK를 옛 정의로 되돌릴 때도 이 행이 있으면 실패한다).
- **측정 용도.** 같은 run의 `queued` → `doorbell_rung` → `claimed` → `started` 시각 차이가 「oort→웹훅」·「웹훅→그록 기동」·「claim→시작」 구간이다(2026-10-14 실측 표는 #3822 PR 본문).


## 증보 2026-10-15 (#3838) — oort 호출 기록(`tool_call`)과 「지금 실행 중」 읽기

- Status: **Accepted** (2026-10-15 성재 결재 — 아래 인용. 공개 API·DB 계약 변경이라 ADR-0100에 따라 이 기록이 구현 머지 조건이다.)
- 결재 원문(2026-10-15, AskUserQuestion): 「oort 호출 + VM 개수 보고 (추천)」 — oort 도구 호출은 서버가 자동으로 기록한다(이름·걸린 시간·성공/오류, 인자·본문 없음). VM 안의 일은 에이전트가 닫힌 범주의 개수로만 스스로 보고하고 「에이전트 보고」로 표시한다. 이 증보는 앞쪽(서버 기록)과 「지금 실행 중」 읽기를 적고, 자기 보고 개수는 ADR-0162 증보 5 C1이 적는다.
- 함께 결재: 「한 화면, 필터로 나눔 (추천)」의 「팀 = 내가 멤버인 채널」 범위가 R1의 가시성이다(ADR-0202 D2).
- 사실 [V] (track/engine `6ee2386f8`): 도구 호출 기록은 어디에도 없다 — 원장 어휘(migration 128·132)에 호출 종류가 없고, Agent Port 디스패처의 `record_liveness`(`routes/agent_port_tools.rs:284-372`)는 `hosted_agent_liveness`의 시각 열만 고친다. run별 시간은 이미 있다(`agent_runs.rs:842-845`의 `claimed_at`·`last_event_at`, `runPhase.ts:195-241`). 동시성은 채널별 run 목록으로만 보인다(D3 「워크스페이스 전체 큐 조회 API는 만들지 않는다」, D6).

### T1. `tool_call` 원장 종류 — Agent Port에서 서버가 기록한다
| 항목 | 값 |
|---|---|
| 어휘 | `agent_run_event.kind`에 **`tool_call`** 하나를 더한다(13 → 14). 마이그레이션은 구현 시점의 다음 번호(알려진 최신 132 — 이름 붙이기 직전에 `origin/track/engine`과 열린 PR(#3837 등)의 `server/Migrations/` 최고 번호를 확인) |
| 새 열 | `tool text`(닫힌 도구 이름 — `momo_mcp::TOOL_CATALOG`의 이름만, 정규식 `^oort_[a-z_]{1,40}$` CHECK + 서버 쪽 닫힌 목록), `duration_ms integer`(0 ≤ x ≤ 600 000). 둘 다 NULL 허용이고 CHECK가 「`kind='tool_call'`이면 둘 다 있음, 아니면 둘 다 없음」을 강제 |
| 결과 | 기존 `code` 열: `ok` 또는 닫힌 실패 코드 `invalid_arguments` · `not_authorized` · `unavailable` · `conflict` · `already_claimed` · `claim_expired` · `internal`(`ToolFailure` 7종과 1:1, `momo-mcp/src/tools.rs:1155`) |
| 싣지 않는 것 | 인자·결과 본문·`leaseHandle`·채널/메시지 id·오류 문장·`stage`·`actor_member_id` 외의 신원. `stage` 열은 NULL |
| 기록하는 곳 | Agent Port 디스패처가 도구가 끝난 직후(`record_liveness`와 같은 자리), **별도의 짧은 테넌트 tx**(`with_tenant_tx`, `momo_app`, BYPASSRLS 없음, 2초 시간 제한). 기록 실패는 도구 응답을 바꾸지 않는다(로그만). 상태 전이가 아니라 관측이라서 D2의 「전이와 같은 tx」 규칙의 예외로 둔다 — 도구가 쓴 상태 전이 행(`claimed`·`stage` 등)은 여전히 그 도구의 tx 안에서 쓰인다 |
| `duration_ms` | 디스패처가 `tools/call` 처리를 시작한 순간부터 결과가 정해진 순간까지 서버 단조 시계로 잰다(네트워크 왕복 제외). 에이전트가 보낸 값이 아니다 |

### T2. 어느 run에 붙나 — 핸들이 말해 주는 run에만
- 원장은 run 단위다. 호출이 **run 하나를 가리킬 때만** 행을 쓴다:
  - 핸들을 받는 도구: `oort_job_renew` · `oort_job_release` · `oort_run_event` · `oort_run_complete` · `oort_action_propose` · `oort_card_suggest` · `oort_action_claim_secret` — 서버가 봉인한 핸들을 열어 **호출한 에이전트의 run**으로 확인된 경우(lease를 잃어 `conflict`로 거절돼도 핸들이 진짜면 기록한다).
  - job을 돌려준 도구: `oort_job_start`(돌려준 job의 run), `oort_jobs_claim`(가져간 job마다 그 run에 한 행).
- run을 가리키지 않는 호출(`oort_inbox_read` · `oort_conversation_read` · `oort_message_post` · `oort_ping`, 열리지 않는 핸들, job 없이 끝난 claim)은 **원장 행도 집계도 없다.** 기존처럼 `hosted_agent_liveness`의 `last_tool_call_at`·`last_tool_error_*`(D4)만 움직인다. 「하나뿐인 lease라서 그 run이겠지」 식의 추정 귀속은 하지 않는다 — 이 ADR은 추정을 화면에서 빼려고 만들었다.
- 대상은 Agent Port(호스팅 에이전트)다. 관리형 워커의 도구(`momo-agent/src/tools.rs`)는 이 증보 범위가 아니다(후속 결정).

### T3. 지우지 않는다 — 기록을 멈추고 세기만 한다
- 성재 결재의 「행을 지우지 않는다」를 따른다. **`tool_call` 행은 `agent_run_event_trim`이 세지도 지우지도 않는다**(trim의 200행 계산에서 빼고, DELETE 술어에 넣지 않는다). trim이 지금 `stage`·`claimed`를 지우는 동작은 그대로다.
- 상한은 **run당 `tool_call` 100행**이다 **[추정 — 기본값]**. 100행을 넘는 호출은 행을 쓰지 않고 집계만 올린다.
- **집계 테이블** `agent_run_tool_tally`(새 테이블, `(workspace_id, run_id, tool)` PK, `ok_count`·`error_count bigint`, `duration_ms_sum bigint`, FK `(workspace_id, run_id) → agent_run` CASCADE, RLS `ENABLE`+`FORCE`, `ws_isolation`, `momo_app` GRANT). **모든** run 귀속 호출(처음 100개 포함)이 UPSERT로 올린다 — 그래서 합계는 행 상한과 무관하게 정확하고, 행은 「앞부분 100개의 순서」를 보여 준다. 크기는 run당 도구 수(카탈로그 14개 이하)로 닫힌다.
- 수명: 행·집계 모두 `agent_run`과 함께 CASCADE, 종결 후 `SHARE_RETENTION_DAYS` 지나 기존 보존 정리가 지우는 것은 그대로다(「수명 삭제」만 있고 「상한 삭제」는 없다).

### T4. 읽기 — `?include=tools` 뒤에서만
- 배포된 클라이언트는 모르는 kind를 만나면 원장 전체를 `WireShapeError`로 버린다(위 2026-10-14 증보의 실측, #3830 선례). 그래서 `GET …/agent-runs/{run}/events`는 **기본으로 `tool_call`을 빼고**, `include`에 `tools`가 있을 때만 싣는다.
- `include`는 쉼표로 나눈 닫힌 집합 `{doorbell, tools}`가 된다(`include=doorbell,tools` 가능). 모르는 값은 지금처럼 400. 지금 코드는 `doorbell` 하나만 받는다(`agent_runs.rs:887-890`) — 구 서버가 `include=tools`에 400을 내면 새 클라이언트는 `tools` 없이 한 번 다시 읽고 「oort 호출 기록은 서버 업데이트 뒤에 보여요」라고 적는다.
- `include=tools` 응답에는 원장 행 외에 `toolTally: [{tool, ok, error, durationMsSum}]`(T3 집계)와 `toolCallRowsCapped: bool`이 실린다.
- 가시성은 원장 그대로(run의 채널 활성 멤버, D3·D13). 도구 이름·시간·성공 여부는 그 run을 볼 수 있는 사람에게 열린다. 새로 보이는 것은 「에이전트가 oort의 어떤 문을 언제 몇 번 두드렸나」뿐이고 내용은 없다.
- **표시 규칙.** 이 행들은 서버가 직접 잰 사실이므로 「oort 기록」으로 표시하고, ADR-0162 증보 5 C2의 VM 안 개수(「에이전트 보고」)와 **같은 칸에 섞지 않는다.**

### T5. 실시간·활동 판정
- `tool_call` INSERT는 `agent.run.event` 프레임을 **내지 않는다**(migration 130 트리거의 술어에서 뺀다). 호출마다 프레임이면 채널 토픽이 시끄럽다. 클라이언트는 다른 원장 프레임(`stage`·수명주기)이나 패널을 열 때 재조회에서 본다.
- `last_event_at`(작업 패널의 「마지막 보고」)에는 **넣는다** — 핸들로 run에 묶인 호출은 그 에이전트가 그 run에서 한 일이다(도어벨 행을 뺀 이유와 반대). 단 run 상태, 스톨 스위프 입력(`agent_run.updated_at`), `hosted_agent_liveness` 판정은 바꾸지 않는다.

### R1. 「지금 실행 중」 읽기 — 내가 멤버인 채널 범위, 에이전트별 동시 수
- **새 경로** `GET /v1/workspaces/{ws}/agent-runs?state=active`(사람 JWT). 지금 있는 채널·에이전트별 목록(D2)과 같은 항목 모양(`phase`·`lease_state`·`queue_position`·`latest_stage`·`last_event_at`)에 `channel_id`를 더한 목록이다.
- **행의 범위**: 읽는 사람이 **활성 멤버인 채널**(미보관·`left_at IS NULL`; DM은 그 두 사람)의 run 중 종결이 아닌 것(`queued`·`claimed`·`running`·`awaiting_approval`·`paused`). 멘션 run 포함(위 「바뀌는 기존 결정」 D13 항목과 같은 이유). 에이전트 종류(호스팅·관리형·BYOA·팀 AI)로 거르지 않는다. D3의 한 SQL 가시성을 재사용한다(복사 금지).
- **에이전트별 동시 수** `agents: [{agentMemberId, visible:{running, queued, awaitingApproval}, activeTotal}]`:
  - `visible.*`는 위 행 범위 안의 개수다.
  - `activeTotal`은 그 에이전트의 **워크스페이스 전체** 미종결 run 수(숫자 하나)다. D3의 `ahead_total`과 같은 등급의 누출(「이 에이전트가 지금 바쁘다」는 집계)이고, 2026-10-13 결재 4 「내 채널만 자세히 (Recommended)」 — 다른 채널은 숫자만 — 를 그대로 따른다. 다른 채널 run의 id·채널·요청자·제목은 어디에도 실리지 않는다.
  - 호스팅 claim은 에이전트별 직렬화가 없고(`momo-outbox/src/gateway.rs:76-77`의 claim 한도, `:266-283`의 hosted claim), 관리형은 직렬화된다(`momo-outbox/src/agent_job.rs:80-100`) [V]. 그래서 `activeTotal`이 2 이상인 호스팅 에이전트는 실제로 병렬로 일하고 있을 수 있다 — 화면은 「동시 n건」으로 쓰되 「병렬 실행」을 단정하지 않는다.
- 워크스페이스 **전체 큐**(남의 채널 run 목록)는 여전히 없다. D3·D6의 해당 문장은 이 범위로만 좁혀진다.
- 페이징: `(created_at, id)` 키셋, `limit ≤ 100`. 실시간은 새 프레임 없이 기존 `agent.run.event`·`work.run.updated` 재조회.

### 불변식 대조 (이 증보)
- 새 테이블 `agent_run_tool_tally`와 원장 열 추가는 신규 migration으로, RLS FORCE, `schema_v0.sql` 불변, sqlx 런타임 쿼리.
- 쓰기 경로 BYPASSRLS 없음(Agent Port는 `momo_app` 테넌트 tx). 클라이언트 직접 publish 없음.
- 원장은 여전히 상태의 원본이 아니라 관측 기록이다. `tool_call`은 run 상태를 바꾸지 않는다.

### 구현 슬라이스 (Accepted 후)
- **T-S1 (engine) 기록.** migration(kind CHECK·`tool`/`duration_ms` 열·trim 술어·130 트리거 술어·`agent_run_tool_tally`), 디스패처 기록, 귀속 규칙. red proof: ① 핸들 도구 한 번이 `tool_call` 행 1개·집계 1을 만든다, ② 인자·본문이 행 어디에도 없다(열 목록 고정 시험), ③ `oort_inbox_read`·`oort_message_post`는 행 0개, ④ 101번째 호출은 행이 늘지 않고 집계만 오른다(상한을 지우면 실패), ⑤ trim이 `tool_call`을 지우지 않고 200행 계산에 넣지 않는다(술어를 되돌리면 실패), ⑥ 다른 테넌트가 집계를 못 읽는다(RLS), ⑦ 기록 tx 실패가 도구 응답을 바꾸지 않는다.
- **T-S2 (engine) 읽기.** `include=tools`(쉼표 집합), `toolTally`, R1 경로. red proof: ① `include` 없으면 `tool_call`이 없다(필터를 지우면 실패), ② `include=doorbell,tools`가 둘 다 싣는다, ③ 모르는 값 400, ④ R1에서 비멤버 채널 run은 행에 없고 `activeTotal`에만 반영, ⑤ 멘션 run 포함, ⑥ DM run은 그 두 사람에게만.
- **T-U1 (UXUI).** run 상세에 「oort 기록」 칸(호출 이름·시간·성공/오류, 「에이전트 보고」 칸과 분리), 구 서버 400 물러서기, 「작업」 화면 머리의 에이전트별 「동시 n건」(ADR-0202).

## 증보 3 (2026-10-24, #4332 → 구현 #4284) — 깨웠는데 가져가지 않은 작업을 정직하게 끝낸다

- Status: **Accepted** (2026-10-24).
  - 근거: 성재 2026-10-24 「저거 정상은 아니잖아. 문제원인 파악하고 해결좀 해봐.」(DM 아래 「grok: 대기 1번째 17시간째 기다려요」 캡처) + 2026-10-22 위임 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」
  - 이 증보는 결재 2(24시간 `unclaimed_expired`)를 **초인종이 닿았고 에이전트가 살아 있는 다른 증거가 없는 run에 한해** 앞당겨요. 닫힌 종결 코드 하나와 notifier 역할의 읽기 범위가 늘어요.
  - 그래서 ADR-0100에 따라 #4284 머지 조건이에요.
- 독립 설계 검토 두 번(1회차 High 3, 2회차 High 2. 지적 요약은 #4332 코멘트)을 반영한 판이에요.
- 표기: [V] 코드·운영 직접 확인 · **[추정]** 해석 · **[권장]** planner 결정(위임)

### 배경 — 운영 실측 (2026-10-24, 읽기 전용, 이슈 #4284 코멘트)
- [V] 사람이 부른 DM run이 10-23 21:00 `queued`가 됐어요.
  - 원장에는 `doorbell_rung` `leading_ok`가 두 번 있어요(21:00:30, 10-24 14:20:31).
  - `claimed`는 없어요. 화면은 「대기 1번째 17시간째 기다려요」였어요.
- [V] 그 연결의 `hosted_agent_liveness`
  - `last_inbox_read_at` 10-19 13:02, `last_claim_at` 10-18 00:30
  - `last_run_event_at` 10-18 00:30, `last_ping_at` 10-24 14:26(`idle`)
  - 마지막 도구 거절은 10-16이고, 그 뒤로 oort가 거절한 적은 없어요(권한 조건 전부 참·cursor 봉인 키 불변·도구 계약 추가만).
  - 실행기는 깨어나 ping만 보내고 받은편지함을 읽지 않아요.
- [V] 같은 에이전트의 15분 sweep 루틴 실측(운영 감사 `auth.agent_bearer.used`, 10-18 17:11~10-19 02:55, #4284 코멘트 3)
  - 깨어남 37회, 간격 36개예요. 간격은 10~29분, 중앙값 15분, 평균 16.2분이에요.
  - 표본은 한 에이전트·약 10시간이에요.
  - `SELF_HOST_AGENT.ko.md`는 「`@every 15m` 스케줄 루틴의 첫 실행은 지연 가능(수십 분), 실측 첫 발화 ~28분」이라고 적어요.
- [V] 서버는 이 상태를 이미 D4 `woken_not_collected`로 판정해요(`momo-agent/src/hosted_liveness.rs` `derive_liveness`). 연결 단위 마지막 발사를 써요.
- [V] 그런데 D1-4의 수령 전 종결은 24시간 `unclaimed_expired` 하나뿐이에요(`momo-outbox/src/stalled.rs`).
  - 10-23 환영 작업(#general)도 24시간을 기다렸어요. 그 뒤 사람 없는 채널에 「아무도 가져가지 않아…」 줄을 남겼어요(운영 원장 조회, #4284 코멘트).
- 리서치 `docs/planning/research/2026-08-24-grokbot-webhook-doorbell.md` §fallback이 예고한 실패 모드예요.

### 결정

**E1. 종결 조건 — run 단위, 판정은 Rust 한 곳.**

스위프 구조는 둘로 나눠요.
- **후보**: notifier 교차 테넌트 SQL은 상위집합 후보만 골라요.
  - 조건: `status='queued'`, 원장에 `claimed` 없음, 호스티드 run, 원장에 `doorbell_rung` `<edge>_ok` 행 있음, `created_at ≤ now() − MOMO_RUN_WOKEN_EXPIRE_MINUTES`
  - 상위집합인 이유: T(아래 4·5)는 이 run의 원장 ok 행 시각이거나 그보다 늦어요. run 생성 뒤이므로 `now − created_at ≥ now − T`예요. 그래서 판정이 참인 run은 모두 후보에 들어요.
- **판정**: 테넌트 tx에서 run 행과 전달 job 행을 함께 잠가요(`FOR UPDATE OF o`, `pending_job_has_live_lease_in_tx`와 같은 모양). 그다음 **`momo-agent`의 순수 Rust 함수 `woken_uncollected_verdict(..)`**가 최종 판정해요.
  - claim은 job 행을 잠가요. 그래서 판정과 종결 사이에 claim이 끼어들지 못해요.
  - SQL은 판정을 대신하지 않아요.

아래를 **모두** 만족할 때만 `timed_out{code:"woken_not_collected"}`로 끝내요. 조건마다 판정 함수의 입력 하나예요.

1. **연결 상태**: 그 run 에이전트의 호스티드 연결이 지금 `active`예요(D4 `inactive`가 아님).
   - 운영자가 연결을 해제했으면 이 규칙 대상이 아니에요. 24시간 규칙과 연결 해제 정리가 다뤄요.
2. **oort 쪽 거절 없음**: 이 연결의 `last_tool_error_at`이 T 이후가 아니에요.
   - T 이후에 거절이 있었다면 원인이 oort 쪽일 수 있어서 이 규칙 대상이 아니에요. 24시간 규칙과 연결 화면이 다뤄요.
   - D4 `error`와 같은 이유예요. 조건은 그보다 좁아요(D4는 「거절이 마지막 성공보다 새로움」).
   - 폐기된 토큰으로 시도한 에이전트도 거절이 남아서 여기서 보호돼요.
3. **수령 가능 job — oort 쪽 사실만**: 이 run의 전달 job이 지금 oort 쪽 조건으로는 수령 가능해요.
   - job: `method='gateway'`, `status='pending'`, `available_at ≤ now()`, live lease 없음
   - run: 승인 대기·종결이 아님
   - 에이전트: 멤버 active(`member`)
   - 커넥터 소유자 조건: 에이전트에 `agent.connector_owner_human_id`가 있으면 job의 `author_member_id`가 그 사람이어야 하고, trial 정지(`agent_provider_pin.kind='operator_env'`이면서 활성 사람 수가 1이 아님)가 아니어야 해요. 술어의 같은 하위 절(`gateway.rs` `trial_members_stop_sql!`)을 그대로 써요.
   - 연결: `approved_scopes`에 `agent:jobs:read`, run 채널이 연결의 승인 채널(`hosted_connection_channel_ids`)
   - 게이트웨이 claim 술어(`momo-outbox/src/gateway.rs` `CLAIMABLE_JOB_PREDICATE`)에서 **토큰 조건과 연결 상태(1)를 뺀 부분집합**이에요. 토큰 조건은 토큰 행의 종류·폐기·만료·audience·scope예요.
   - 토큰 만료·갱신 누락은 에이전트 쪽 사실이라 보호가 아니에요. OAuth 접근 토큰은 30분이면 만료돼요(`momo-auth/src/hosted_oauth.rs`). 술어 전체를 쓰면 죽은 OAuth 연결의 run이 이 규칙에서 빠져요.
   - **live lease**는 `lease_owner IS NOT NULL AND lease_expires_at > now()`예요. lease를 되돌리는 reaper가 없어서 만료된 `lease_owner`가 job 행에 남아요. 만료된 lease는 수령 가능이에요(`gateway.rs` 술어와 같아요).
   - 하나라도 거짓이면 24시간 규칙이에요.
4. **깨움 시각 T**: 공용 비교식 **`collected_since(t, row)`**를 써요. 정의는 `max(last_inbox_read_at, last_claim_at) ≥ t − 30초`예요.
   - 30초는 발사 시각이 HTTP 응답 뒤에 찍히는 skew 여유예요.
   - T는 이 run 원장의 `doorbell_rung` `<edge>_ok` 행 가운데 `collected_since(행 시각)`이 거짓인 **가장 이른** 행의 시각이에요. 곧 마지막 수령 증거 뒤의 첫 미수령 발사예요.
   - D4 `derive_liveness`도 같은 함수를 연결 단위 발사 시각으로 불러요. 두 판정의 차이는 넘기는 시각뿐이에요.
   - 그런 행이 없으면 이 규칙 대상이 아니에요(24시간 규칙). run 생성 이전 발사는 이 run 원장에 없어서 T가 될 수 없어요.
   - 연결 단위 `last_fired_at`은 T로 쓰지 않아요. 초인종은 승인 채널의 모든 새 메시지에 울려요(쿨다운 60초). 그래서 대화가 이어지면 약 60초마다 갱신돼요. 그걸 T로 쓰면 낮에 대화하는 워크스페이스에서는 30분이 차지 않아요.
5. **시계는 사람만 되돌려요**: 대화로 발사가 이어져도 T는 첫 미수령 발사에 서 있어요.
   - T보다 늦은 사람의 「다시 깨우기」 요청(이 연결의 `hosted_agent_doorbell_ring.requested_at`)이 있으면, T를 그 가운데 가장 늦은 요청 시각으로 옮겨요.
   - 사람이 다시 깨운 직후에 바로 끝내지 않으려는 거예요.
6. **살아서 다른 일을 하는 증거 없음**: 아래 셋 중 하나라도 참이면 끝내지 않아요.
   - (i) 같은 에이전트가 다른 `agent_job`의 live lease(3의 정의)를 쥐고 있어요. 만료된 lease는 보호하지 않아요.
   - (ii) `last_run_event_at ≥ T`예요.
   - (iii) T 이후에 `oort_ping{state:"working"}`이 왔어요.
     - `last_ping_state`는 마지막 값 하나라서, 새 wake의 `idle` ping이 `working`을 덮어써요.
     - 그래서 (iii)은 약한 보호예요. 겹치는 wake에서는 (i)·(ii)가 보호해요.
   - 사건의 grok은 셋 모두 해당하지 않아요. 마지막 claim(10-18 00:30) 뒤 lease 상한 120분이 지나 live lease가 없고, ping은 `idle`만 왔어요. 그래서 여전히 잡혀요.
7. **경과**: `now() − T ≥ MOMO_RUN_WOKEN_EXPIRE_MINUTES`예요(E2).

**남는 위험**: 아래 run은 이 규칙 대상이 아니라서 기존 24시간 규칙으로 끝나요. 모두 보호 쪽 오류예요.
- 수령 증거 뒤 발사가 원장에 없는 run. 원장 쓰기 한도 때문이에요.
  - run당 처음 10행(`DOORBELL_RUNG_PER_RUN_CAP`)을 수령 증거 전에 다 쓴 run
  - 발사마다 최근 20개 run에만 행을 쓰는 한도(`DOORBELL_RUNG_RUNS_PER_RING`) 밖의 오래된 run
  - best-effort 원장 쓰기가 실패한 run
- 승인 뒤 재큐된 run. `claimed` 행이 이미 있고 ring 행을 쓰지 않아요.
- 받은편지함을 읽기만 하고 이 job을 가져가지 않는 에이전트의 run. 읽기가 수령 증거라서 보호돼요(기각 B).
- 초인종이 없는 연결의 run.
- 이 run들의 종결 전 표시는 E6이 다뤄요. 줄이는 방법은 후속 이슈로 남겨요.

**배포 첫 스위프**: 배포 시점에 이미 조건을 만족하는 queued run(24시간 이내)은 첫 틱에 한꺼번에 끝나요. 사람이 부른 run마다 줄·푸시가 나가요. 의도된 소급이에요(7일 유령 규칙과 같은 이유, `run_stall_sweep.rs`).

결재 2의 24시간 `unclaimed_expired`·7일 유령 규칙은 그대로예요.

**E2. 기본값 30분 [권장].**
- 근거: 실측 sweep 간격(중앙값 15분, 최대 29분)과 문서가 인정한 첫 실행 지연(~28분)이에요. 첫 미수령 발사 뒤 sweep이 한 번은 돌 시간을 줘요. 15분 × 2 = 30분이에요.
- 마진은 최대 간격보다 1분이에요. 표본이 한 에이전트·약 10시간이라서, 운영에서 더 긴 간격이 보이면 env로 값을 올려요.
- #4284 본문의 「10~15분」에서 늘렸어요. 15분이면 지연된 sweep(최대 29분)이 회수했을 run을 먼저 끝내요.
- clamp 범위는 10~1440이에요. 전역 값이라 모든 호스티드 연결에 같아요. 연결별 값은 범위 밖이에요.
- D4의 `woken_grace`(5분)는 「깨웠지만 아직 안 가져감」을 **보이기 시작하는** 시점이에요. 30분은 **끝내는** 시점이에요.

**E3. 정리 경로 — `unclaimed_expired`와 같아요.** 한 테넌트 tx에서 아래를 해요. 행위자는 시계예요. 재배정·재시도는 없어요(D1-4).
- run 종결(원장 트리거가 코드 기록)
- 전달 job 은퇴
- 감사 1행(`agent.run.stalled`, code)
- E4의 줄·프레임 규칙

앱 표지는 **`site_silent`**(「에이전트가 답하지 않아요」)예요. 초인종이 닿았으니 「꺼져 있음」(`site_off`)은 거짓이에요. `run_stall_sweep.rs`의 코드↔표지 고정 시험에 새 코드를 넣어요.

**E4. 줄과 프레임 — 「아무도 기다리지 않는 서버 작업」만 조용히.**
- **조용히 끝내는 대상은 환영 run 하나예요.**
  - 판별: `input.welcome_kind`가 있거나 `idempotency_key`가 `welcome:`으로 시작해요.
  - 처리: 채널 줄 없이 끝내요. 원장·감사에는 남아요.
  - 적용 범위: 스위프 줄 한 곳에서 **세 코드 모두**(`woken_not_collected`·`unclaimed_expired`·`lease_abandoned`)에 적용해요.
- **사람이 부른 run**(트리거 메시지가 있는 run + 사람이 「작업」 버튼으로 요청한 Work run)은 서버가 본문을 쓴 시스템 줄 `agent_run_timed_out{code}`을 남겨요.
  - `woken_not_collected` 본문: 「에이전트가 이 작업을 가져가지 않아 종료했어요. 다시 요청해 주세요. 계속 안 되면 에이전트 소유자에게 알려 주세요.」
  - 일반 멤버는 연결을 볼 수 없어요. 연결 확인은 소유자·admin이 보는 liveness 문구(E6)에 맡겨요.
  - 「트리거 없음」은 판별자가 아니에요. Work run도 트리거가 없어요.
- **종결 rail 프레임 기준은 하나예요.** 시작 프레임이 있는 run(사람이 부른 run)이나 원장에 `claimed`가 있는 run만 종결 프레임을 내요.
  - 환영 run은 시작 프레임이 없어요(`routes/welcome.rs`). 그래서 수령 전에 끝나면(`woken_not_collected`·`unclaimed_expired`) 종결 프레임이 없어요.
  - 환영 run도 에이전트가 claim해서 상태 프레임을 낸 뒤 `lease_abandoned`로 끝나면 종결 프레임을 내요. 줄은 어느 쪽도 없어요.
  - migration 130 트리거가 원장 행마다 내는 얇은 `agent.run.event` 프레임은 그대로 나가요(화면 갱신용).
- 코어 `runPhase.ts` `END_REASON_TEXT`에 `woken_not_collected: "깨웠지만 가져가지 않아 끝냈어요"`를 더해요. 푸시·`answers_message_id`는 ADR-0204 D8 그대로예요.

**E5. 환영 대상 정책 (ADR-0181 D3 보강).**

호스티드 에이전트를 환영 대상으로 삼으려면 아래 중 하나가 참이어야 해요. 호스티드 에이전트는 호스티드 연결이 있는 에이전트예요. `owner_only`만으로는 해당하지 않아요.
- (a) 일 신호 `max(last_inbox_read_at, last_claim_at, last_run_event_at)`가 최근 `MOMO_WELCOME_HOSTED_SIGNAL_HOURS` 안이에요. 기본 24 [권장], 범위 1~168이에요.
- (b) 연결이 `active`가 된 지(`proved_at`) 같은 창 안이에요. 이건 **신규 연결 예외**예요. ADR-0185 D-C c2의 「활성 전이 = 첫 환영」 훅이 이 예외로 그대로 살아요.

동작 정리:
- 표준 sweep을 도는 건강한 에이전트(15분마다 읽음)는 통과해요.
- 10-23의 grok은 일 신호가 4일 전이고 활성은 10-10이라 탈락해요. 이 규칙이 10-23 사건을 막아요.
- 한계: 초인종 전용이면서 하루 넘게 한가한 에이전트도 탈락해요.
  - 그 경우는 다음 후보나 「오프너 없음」이에요.
  - 운영자가 웰컴 에이전트를 지정하면 되돌릴 수 있어요.
- 지정 에이전트(`welcome_agent_member_id`)의 의미는 **현행 그대로**예요. 지정이 대상이 될 수 없으면 다음 후보로 넘어가지 않고 오프너를 만들지 않아요(`welcome.rs` 현행 `None`).
- 지정이 없을 때는 #general 안 후보를 생성순으로 보되, 호스티드 후보마다 위 검사를 해요.
- 환영 마커는 사람마다 한 번만 써요(`welcome:{ws}:{member}:opener:v1`). 죽은 에이전트로 고르면 그 사람의 첫 환영이 사라져요. 그래서 이 검사가 필요해요.
- 적용 위치: 활성 전이 호출(`auth.rs` 활성화·OAuth 첫 토큰)과 가입 호출(`routes/join.rs`·`routes/claim.rs`) 모두 같은 정책을 써요.

**E6. 화면 계약 — 새 필드 없음.**
- 종결 코드 enum에 `woken_not_collected` 하나가 늘어요.
  - [V] 클라이언트 원장 파서는 `code`를 닫힌 집합으로 검사하지 않아요(`packages/momo-core/src/lib/api.ts` `optionalString(row, "code")`).
  - 모르는 `kind`도 #3824부터 `unknown` 한 줄로 받아요.
  - 그래서 이미 배포된 맥·웹·폰은 깨지지 않아요.
- 시스템 줄 본문은 서버가 써서, 구 클라이언트도 그대로 보여요.
- **종결 전 표시**: 대기 run 에이전트에게 D4 경고 라벨(예: `woken_not_collected`·`work_waiting`·`unresponsive`)이 있으면, 「대기 1번째 n시간째 기다려요」 대신 그 liveness 문구를 먼저 보이고 경과 시간은 뒤에 보여요.
  - 30분 창의 `woken_not_collected`만이 아니에요. 24시간 규칙으로 남는 run(E1 남는 위험)도 이 표시로 정직해져요.
  - 범위는 #4285(대화 아래 활동 줄·홈 작업 카드)예요.
  - 소유자·admin에게는 「다시 깨우기」(S4)와 연결 화면으로 가는 길을 둬요.
- 롤백: 데이터 정리가 필요 없어요. 새 코드로 끝난 run은 구 서버에서도 `timed_out` 행일 뿐이에요. E7의 열 단위 SELECT도 읽기뿐이라 롤백해도 해가 없어요.

**E7. 권한 — notifier 역할의 읽기 범위.**
- 스위프는 `momo_notifier`(BYPASSRLS, 테이블·열 단위 GRANT)로 돌아요. 판정(E1)에 필요한 만큼 아래 **열 단위 SELECT만** 더해요. 쓰기·DELETE는 없어요.
  - `hosted_agent_liveness(workspace_id, connection_id, agent_member_id, last_inbox_read_at, last_claim_at, last_run_event_at, last_ping_at, last_ping_state, last_tool_error_at)`: 새로 줘요.
  - `hosted_agent_connection`: 이미 있는 `(workspace_id, agent_member_id)`에 `id, status, approved_scopes, approved_channel_ids, approved_dm_channel_ids, confirmed_by`를 더해요. 뒤의 세 열은 `hosted_connection_channel_ids`(invoker 권한)가 읽어요.
  - `hosted_agent_doorbell_ring(workspace_id, connection_id, requested_at)`: E1-5에 써요.
  - `agent_provider_pin(workspace_id, agent_member_id, kind)`: E1-3의 trial 정지에 써요.
- 주지 않는 것
  - `token`: BYPASSRLS 역할에 토큰 읽기를 주지 않아요. E1-3이 토큰 조건을 빼는 이유이기도 해요.
  - `hosted_agent_doorbell`: `url`·`secret_sealed`가 있는 테이블이에요. E1은 연결 단위 발사를 쓰지 않아요.
- 이미 있는 권한
  - `outbox`: 테이블 단위 SELECT·INSERT·UPDATE
  - `agent_run_event`: SELECT·INSERT
  - `agent`·`member`·`membership`·`channel`: 테이블 단위 SELECT. 커넥터 소유자 조건의 `agent.connector_owner_human_id`와 활성 사람 수(`member.kind·status·deleted_at`)는 여기로 읽어요.
- 구현은 `infra/rust/sql/bootstrap_runtime_roles.sql`·`scripts/tests/test_notifier_role_grants.sh`·`prod_role_conformance_pg.rs`를 함께 고쳐요.
- 열 목록은 구현 쿼리와 맞춰 확정해요. 이 목록보다 늘어나면 머지 전에 ADR 증보로 적어요.

**E8. 바뀌지 않는 것.**
- D1-4의 `lease_abandoned`(2시간)·`unclaimed_expired`(24시간)와 그 값, 7일 유령 규칙
- D4 liveness 상태·임계값. 단 비교식을 공용 `collected_since`로 옮기면서 30초 skew 여유가 D4에도 들어가요.
  - 발사 전 30초 안의 읽기를 수령으로 봐요. 그래서 D4 `woken_not_collected` 라벨이 그만큼 덜 서요.
  - `hosted_liveness.rs`의 경계 시험을 이 값에 맞춰 고쳐요.
- ADR-0171 초인종 페이로드·쿨다운·대상
- 재배정 없음
- 결재 3의 `oort_ping` 의미(ping `idle`은 일을 가져간다는 증거가 아니에요)

### 기각 대안
| 대안 | 기각 이유 |
|---|---|
| A. 24시간 값을 줄인다 | 초인종 사실 없이 시간만 보면, 살아서 줄을 처리하는 에이전트의 정상 대기까지 끊어요. |
| B. claim만 본다(읽기 무시) | 앞선 작업을 처리하며 받은편지함을 읽는 에이전트의 대기 run을 끊어요. |
| C. 연결 단위 발사(`last_fired_at`)를 T로 쓴다 | 대화가 이어지면 약 60초마다 갱신돼 30분이 차지 않아요. run 생성 이전 발사도 이 run의 깨움으로 세요. |
| D. 원장의 마지막 미수령 발사를 T로 쓴다 | C와 같은 이유로 대화가 시계를 계속 밀어요. 첫 미수령 발사에 고정하고, 사람의 「다시 깨우기」만 되돌려요(E1-5). |
| E. 시계 재시작을 허용하고 상한(첫 미수령 발사 + 60분)을 둔다 | 실효 기한이 대화량에 따라 30~60분으로 흔들려요. 고정 T가 더 단순하고 같은 사건을 잡아요. |
| F. claim 술어 전체(토큰 포함)를 수령 가능 조건으로 쓴다 | 토큰 만료라는 에이전트 쪽 사실이 보호가 돼서, 죽은 OAuth 연결의 run이 빠져요. BYPASSRLS 역할에 `token` 읽기도 필요해요. |
| G. ping을 「살아 있음」으로 보고 끝내지 않는다 | 이번 실측이 반례예요. ping `idle`만 5일째 오고 일은 하지 않았어요. `working` ping만 보호해요(E1-6). |
| H. 재배정·자동 재시도 | D1-4가 기각했어요(중복 응답, 다른 에이전트의 오답). |
| I. 클라이언트 TTL로 표시만 | D1 「서버 사실만」에 어긋나요. |
| J. 「트리거 없음」으로 침묵 판별 | Work run이 사람이 부른 작업인데 조용히 끝나요. |
| K. 환영 대상에 `last_claim_at` 7일 | 신규 연결이 첫 환영에서 영영 빠지고, 10-23 사건(claim 5일 전)도 못 막아요. |

### 수용 기준 (red proof, #4284)

판정 조건은 순수 함수 `woken_uncollected_verdict(..)`의 표 시험으로 써요. 표의 각 행은 **한 번에 한 조건만 거짓**이에요. DB 통합 시험은 그 위에 아래 픽스처 규칙으로 더해요.
- 원장 ring 행은 손으로 INSERT하지 않아요. 실제 `record_doorbell_rung_in_tx`로 만들어요.
- 시계는 과거 `created_at`을 지정한 superuser INSERT로 넣어요. 원장에 UPDATE 불변 트리거가 있어서 행을 늙힐 수 없어요(migration 128).

1. **종결**: 첫 미수령 `ok` 발사 뒤 30분 동안 수령 증거·살아 있는 증거가 없는 사람 트리거 run은 `timed_out{woken_not_collected}`으로 끝나요. 원장 1, 감사 1, 채널 줄 1(서버 본문), 종결 프레임 1, job 은퇴가 남아요.
2. **보호 짝**: 아래 각각은 끝내지 않아요. 각 조건을 판정에서 지우면 그 행이 빨개지는 사보타주를 둬요.
   - T 뒤 받은편지함 읽기 1회
   - 다른 job의 live lease
   - `last_run_event_at ≥ T`
   - T 뒤 `working` ping
   - 연결 비활성(표 시험에서 나머지 조건은 모두 참)
   - T 뒤 도구 거절
   - oort 쪽으로 수령 불가인 job(채널 미승인·scope 없음·trial 정지 각각)
   - **음성 대조**: 아래는 보호하지 않아요(끝내요). 보호 조건에 넣으면 빨개져요.
     - 만료된 lease(`lease_owner`가 남아 있고 `lease_expires_at ≤ now()`)
     - 만료된 토큰(OAuth 접근 토큰 만료)
3. **경계**
   - 29분 59초는 끝내지 않고 30분은 끝내요.
   - `read = T − 29초`는 수령으로 보고 `T − 31초`는 미수령으로 봐요.
   - clamp 밖 env는 경계값을 써요.
4. **시계**
   - 대화로 발사가 계속 나서 원장 ok 행이 이어져도 T는 첫 미수령 발사예요. 사보타주: 마지막 발사를 T로 쓰면 빨개요.
   - T 뒤에 사람의 「다시 깨우기」 요청이 있으면 T는 그 시각이에요. 사보타주: 요청을 무시하면 빨개요.
   - 수령 증거 뒤 원장 ok 행이 없으면(상한을 수령 전에 다 씀) 대상이 아니에요.
   - 연결 `last_fired_at`만 있고 원장 행이 없으면 대상이 아니에요.
5. **깨움 실패**
   - `_failed`만 있으면 대상이 아니에요(24시간).
   - `_ok` 뒤 `_failed`가 온 run은 그 `_ok`가 T예요.
   - 사보타주: `_failed` 행을 T로 쓰면 빨개요.
6. **줄·프레임**
   - 환영 run의 세 코드는 줄 0이에요.
   - 환영 run의 수령 전 종결(`woken_not_collected`·`unclaimed_expired`)은 종결 rail 프레임 0이고, claim 뒤 `lease_abandoned`는 종결 프레임 1이에요.
   - Work run의 같은 코드는 줄 1, 종결 프레임 1이에요.
   - 사보타주: 판별자를 `trigger IS NULL`로 바꾸면 Work 시험이 빨개요.
7. **환영 대상**
   - 사건 재현(claim 5일 전·읽기 4일 전·활성 14일 전): 그 호스티드 에이전트로 환영 run이 생기지 않아요.
   - 막 활성된 연결(일 신호 없음): 생겨요.
   - 15분마다 읽는 에이전트: 생겨요.
   - 지정 에이전트가 탈락하면 오프너가 없어요(다음 후보로 넘어가지 않음).
   - 사보타주: 신규 연결 예외를 제거하거나 검사를 제거하면 빨개요.
8. **건드리지 않는 run**: claim된 run, `running`·`awaiting_approval` run, 원장에 `doorbell_rung` ok 행이 없는 run(초인종이 없거나 울리지 않음)이에요.
   - 각 대조군은 그 조건 하나만 빼고 E1의 나머지 조건을 모두 만족해야 해요. 나머지 조건은 ring ok 행·수령 증거 없음·30분 경과예요.
   - 판정 함수는 「`queued`이고 `claimed` 없음」을 잠근 행에서 다시 확인해요. 후보 SQL만 믿지 않아요.
   - 그래야 상태 필터를 지우면 빨개져요.
9. **한 정의**
   - `collected_since`의 비교 방향을 뒤집으면 D4 시험과 스위프 시험이 같이 빨개져요.
   - SQL 후보는 Rust 판정의 상위집합이에요. DB 통합 시험에 아래 입력을 넣어서, 판정이 참인 입력이 모두 후보 SQL에 잡히는 걸 보여요.
     - `created_at = now() − 30분` 경계
     - 원장 ok 행 1개뿐
     - 다시 깨우기로 T가 늦어진 run
10. **권한**
    - notifier 역할로 스위프가 권한 오류 없이 돌아요(prod role 시험).
    - grant 시험이 `hosted_agent_liveness`·`hosted_agent_connection`·`hosted_agent_doorbell_ring`·`agent_provider_pin`에 테이블 단위 SELECT가 없음을 단언해요. 모양은 `test_notifier_role_grants.sh`의 `workspace` 단언과 같아요. 새 열은 `column_reads`에 올려요.
    - `token`·`hosted_agent_doorbell`에는 notifier GRANT가 하나도 없음을 단언해요. 기존 파서는 `ON TABLE` 줄만 보므로, 열 단위 GRANT(`GRANT SELECT (…) ON …`)까지 읽도록 파서를 넓히고 그 확장이 열 단위 GRANT 픽스처에서 빨개지는지 보여요. 실제 DB에서는 `has_table_privilege`·`has_column_privilege`로 한 번 더 단언해요(prod role 시험).
11. **표지**: `woken_not_collected`의 앱 표지는 `site_silent`예요(코드↔표지 고정 시험).
12. **교차 테넌트**: 다른 워크스페이스에 **같은 `run_id`의 `doorbell_rung` ok 행**을 넣어요. 원장은 FK가 없어서 넣을 수 있어요(migration 128).
    - 판정·후보 조인에서 `workspace_id` 조건을 지우면 빨개져요.
    - `hosted_agent_liveness`·`hosted_agent_doorbell_ring`은 복합 FK(`workspace_id, connection_id`)라 다른 워크스페이스 행을 같은 연결 id로 만들 수 없어요. 이 두 조인은 FK가 막는다는 사실을 스키마 시험으로 고정하고, 판정 쿼리의 조인 키에 `workspace_id`가 있음을 소스 시험으로 봐요.
13. **호환**: 코어 `agentRunLedgerFromWire`가 `timed_out`+`woken_not_collected` 행을 받아들여요. `endReasonText`는 새 문장을 돌려주고, 모르는 코드에는 `undefined`를 돌려줘요(`runPhase.test.ts` 모양).
14. **줄 계약**: 새 코드의 줄도 `answers_message_id`를 가져요. `client_msg_id`는 run id가 아니에요(기존 push·agent port 적합성 시험 모양).

### 구현 슬라이스
- **#4284 (engine)**
  - 범위: E1~E5·E7, 서버 본문·코어 코드 문구, 위 수용 기준
  - 함께 바꿀 것
    - `StallKind` 변종과 고정 시험(`stalled.rs`), `stall_app_notice` 분기와 고정 시험
    - 부트스트랩 GRANT·prod role 시험·grant 시험
    - 새 환경변수 두 개(`MOMO_RUN_WOKEN_EXPIRE_MINUTES`·`MOMO_WELCOME_HOSTED_SIGNAL_HOURS`)의 설정·배포 문서
    - `docs/SELF_HOST_AGENT.md`·`SELF_HOST_AGENT.ko.md`의 종결 코드 서술
    - 코어 `END_REASON_TEXT`와 시험
    - `run_stall_sweep.rs`의 낡은 주석(트리거 없는 run의 줄)
  - 검증: workspace `cargo fmt/clippy/test`, 독립 보안 검수 Blocker 0·High 0(BYPASSRLS 역할 범위 변경)
- **#4285 (UXUI)**: E6 종결 전 표시(대화 아래 활동 줄·홈 작업 카드)와 소유자 「다시 깨우기」 길(웹·데스크탑·폰). 사람 트리거 종결 줄은 서버 본문이라 화면 변경 없이 보여요.
- 역방향 줄: ADR-0181 D3, ADR-0204 D8(이 PR).


## 증보 4 (2026-10-27, #4618) — Agent Port 호출 기록 `agent_port.call`: 깨어서 무엇을 부르고 멈추는지

- Status: **Accepted(planner 위임, owner 사후 보고 2026-10-27)**. **관측 추가**예요. 새 테이블·새 열·새 권한·새 API가 없고 새로 보이는 내용도 없어서 owner 결정 없이 planner 위임으로 수락해요. 근거는 아래 「왜 owner 결정이 필요 없는가」 네 가지예요. 공개 API·DB 계약은 바뀌지 않지만 Agent Port와 감사 기록을 건드려서, ADR-0100에 따라 이 Accepted가 구현 머지 조건이에요. 초안은 같은 날 Proposed였어요(#4618 1단계).
- 결재 기록 (planner 위임, 2026-10-27, #4618 2단계 지시): ① 이 증보를 Accepted로 수락해요. ② 1단계가 이슈 본문(method·도구·결과)보다 넓힌 두 가지, 곧 서버가 센 **개수**(`events`·`agent_jobs`·`jobs`)와 거절 **이유** `reason`을 승인해요. 배포→관찰 한 번이 비싸서 한 번에 원인을 가르려는 것이고, 거절 이유는 **닫힌 어휘로만** 둬요(호출자가 고른 문자열의 일부도 안 들어가요). ③ owner에게는 사후 보고해요.
- 근거: 이슈 #4618과 코멘트 두 개(2026-10-26, 운영 읽기 전용 집계). 2026-10-15·10-24 증보와 같은 줄기예요(「에이전트가 살아 있는데 일을 안 가져간다」를 서버 사실로 가른다).
- 표기: [V] 코드·운영 직접 확인 · **[추정]** 해석

### 배경

- [V] 운영 실측(2026-10-26, #4618). grok의 마지막 완료는 10-18 00:30이에요. 그 뒤 실행 3건은 시간 초과 2·대기 1이에요. 도어벨은 `ok_200`이고, grok 자격은 약 15분 박자로 한 번에 3~6번 `POST /v1/mcp/agent-port`를 불러요(전부 허용). 그런데 `claimed`·run 이벤트·메시지가 없어요.
- [V] 서버가 그 호출을 기억하지 못하는 이유(`track/engine` `b17e1b3df`).
  - `auth.agent_bearer.used`는 인증 tx 안에서, 디스패치 **전에** 써요(본문은 이미 읽었지만 method·도구·결과는 아직 몰라요). 그래서 경로(`POST /v1/mcp/agent-port`)만 있고 method·도구·결과가 없어요(`auth.rs`).
  - `hosted_agent_liveness`는 성공한 도구 호출의 시각과, 거절 중 `unavailable`·`not_authorized` 두 가지만 남겨요(`agent_port_tools.rs` `record_liveness`의 `Err(_) => return`).
  - 2026-10-15 증보(T1) `tool_call` 원장은 **run을 가리키는** 호출만 남겨요. `oort_inbox_read`·`oort_ping`·`tools/list`·`initialize`는 run을 가리키지 않아요.
  - `-32602` 거절만 경고 로그(`Agent Port refused request params`)가 있어요(`log_invalid_params`). `-32700`(JSON 깨짐)·`-32600`·`-32601`·`-32020`(헤더 불일치)·`-32022`(버전)·`415`·`413`은 로그도 기록도 없어요.
- 그래서 깨어서 호출은 하는데 일을 안 가져가는 런타임이 **어느 호출에서 멈추는지** 서버에서 가를 수 없었어요. 서버 안쪽(현행 루틴대로 부르는 클라이언트로 DM·채널 멘션·연속 DM을 돌리는 PG 시험 `grok_like_agent_flow_pg.rs`)은 끊기지 않아요.

### 바뀌는 것

**A1. 기록하는 곳과 때.** 인증과 속도 제한을 통과한 Agent Port POST마다, **답이 정해진 뒤에** 감사 행 한 줄을 남겨요(`routes/agent_port.rs` `trace_call`).
- `audit_log.action = 'agent_port.call'`, `detail.schema = 'oort.agent_port.call.v1'`이에요.
- 행위자는 호출한 에이전트 멤버, `target_type = 'route'`예요. `via_token_id`는 비워요. 페어링 자격의 id는 `token` 행이 아니라서 외래 키에 맞지 않아요.
- 별도의 짧은 테넌트 tx(`momo_app`, BYPASSRLS 없음, 2초 제한)예요. 2026-10-15 증보(T1) `tool_call` 기록과 같은 방식이에요.
- 인증 실패(401)·범위 없음(403)·속도 제한(429)에는 이 행이 없어요. 그 경우의 기록은 기존 `auth.agent_bearer.scope_denied`·`agent_port.rate_limit.denied`가 맡아요. 429는 신원을 만들기 전에 답하므로 행이 붙을 수 없고, 시험이 입장 제한을 켠 서버에서 확인해요.
- 전송 거절(헤더 중복·본문 64KiB 초과 등)은 인증 뒤에 답하므로 이 행이 남아요. 본문을 읽지 않은 거절(헤더 길이·개수 초과, 413)의 `method`는 `unparsed`예요(아래 「읽는 법」의 라벨 주의).

**A2. 싣는 것 — 전부 서버가 가진 닫힌 어휘나 서버가 센 숫자예요.**

| 키 | 값 | 비고 |
|---|---|---|
| `method` | `initialize`·`notifications/initialized`·`ping`·`tools/list`·`tools/call`·`server/discover` / `other`(모르는 method) / `unparsed`(JSON 아님) / `no_method`(method 없음) | 호출자가 보낸 method 문자열은 어디에도 안 들어가요 |
| `tool` | `tools/call`에서만. `momo_mcp::TOOL_CATALOG`의 13개 이름 / `unknown` | 카탈로그 이름은 이 호출자의 view가 못 부르는 도구여도 남겨요(「받지 못한 도구를 불렀다」가 진단이에요). 응답은 지금처럼 「unknown tool」이에요 |
| `outcome` | `ok` / `invalid_arguments` · `not_authorized` · `unavailable` · `conflict` · `already_claimed` · `claim_expired` · `internal` / `protocol_error` | 앞의 일곱은 `ToolFailure::code()`와 같은 토큰이에요(`tool_call` 원장과 한 어휘). 시험이 `ToolFailure` 변종마다 대조해요 |
| `reason` | 거절일 때만. 서버가 쓰는 고정 문장 48개를 닫힌 토큰 27가지로 옮긴 값(예: `parse_error` · `accept` · `content_type` · `version_header` · `version_mismatch` · `mcp_method_header` · `mcp_name_header` · `modern_meta` · `request_shape` · `unknown_tool` · `tool_arguments`)과 `tool_artifacts`, 표에 없는 문장의 `other` | 하나의 코드 아래 원인이 여럿이라서 필요해요(도달할 수 있는 문장이 `-32020` 아래 8가지, `-32600` 아래 10여 가지예요). 아래 A3 |
| `status`·`rpc_code` | HTTP 상태, JSON-RPC `error.code`(성공이면 없음) | |
| `era` | `modern` · `legacy` · `other` · `none` | `MCP-Protocol-Version` 헤더가 말한 시대. 헤더 문자열은 안 남겨요 |
| `tools_listed` | `tools/list` 성공 때 이 호출자의 view가 보여 준 도구 수 | 「목록이 비었나, 일부인가」를 가르는 숫자예요 |
| `events`·`agent_jobs` | 성공한 `oort_inbox_read`가 돌려준 이벤트 수, 그중 `agent_job` 수 | 서버가 자기 응답에서 센 정수예요 |
| `jobs` | 성공한 `oort_jobs_claim`이 내준 job 수 / `oort_job_start`는 내줬으면 1, `job:null`이면 0 | 같음 |

**A3. 싣지 않는 것 (T1·T3 규율 그대로).** 인자의 이름과 값, 커서, `leaseHandle`, 요청 `id`, 헤더 값, 채널·메시지·run id, 본문, 오류 문장, 토큰, 그리고 **호출자가 고른 문자열의 일부**(접두·자른 조각·해시 포함)예요.
- `CallShape.method`·`tool`은 `&'static str`이에요. 호출자의 문자열은 타입 수준에서 이 행에 들어갈 길이 없어요.
- `reason`은 응답의 `error.message`를 **정확히 일치하는 표(`momo_mcp::REFUSAL_REASONS`)에서만** 찾아 그 표의 토큰을 내보내요. 문장은 복사하지 않아요. 표에 없는 문장(새로 추가했는데 행을 안 단 문장, 앞으로 호출자 글이 섞일지도 모르는 메시지)은 `other`예요. 그래서 닫힘이 구성으로 보장되고, 행이 빠지면 누출이 아니라 `other`로 보여요. `src/lib.rs`에서 리터럴로 쓴 문장이 모두 표에 있는지 소스 스캔 시험이 잠가요. 동적으로 만든 문장(`format!`)은 스캔이 못 보고, 실제 거절 40여 건을 디스패처에 넣는 시험이 보완해요. 닫힘 자체는 정확 일치 조회가 구성으로 지켜요.
- 개수(A2의 마지막 세 줄)는 호출자 입력이 아니라 서버 응답에서 세요. 이 값들이 2026-10-15 증보(T1)의 「싣지 않는 것: 결과 본문·채널/메시지 id」를 넘지 않는다는 근거예요. 세는 함수는 정수만 돌려주는 `ResultCounts`(`Copy`)예요.

**A4. 상한 — 멈추고, 지우지 않아요(T3과 같은 규칙).** 자격(토큰 id)당 **시간당 240행**이에요. 넘으면 이 행만 안 써요. 슬라이딩 창이라 가장 오래된 도장이 1시간을 넘기는 대로 한 칸씩 다시 써요(한 번에 풀리지 않아요). 호출 자체는 제한하지 않고, 넘은 만큼을 따로 세지도 않아요. 쓰기에 실패하거나 시간이 초과돼도 한 칸은 쓴 것으로 세요(행 ≤ 시도).
- 15분 박자 루틴은 한 번에 3~10번이라 시간당 수십 행이에요.
- 한 자격·한 프로세스 기준으로 최악의 하루 크기는 5,760행이에요. 단위가 토큰 id라서 같은 에이전트의 자격이 여럿이면 그만큼 열려요(OAuth 접근 토큰은 30분마다 갱신되고 갱신마다 새 `token` 행이라 새 예산이에요). 인-프로세스 상태라 재시작·복제본마다 처음부터예요. 에이전트 쪽 천장은 입장 속도 제한(`per_agent_limit` 기본 분당 480, 시간당 28,800 호출)이에요. 이 행은 허용된 호출당 최대 한 줄이라, 같은 호출이 이미 남기는 `auth.agent_bearer.used`(상한 없음)의 행 수를 넘을 수 없어요. 그래서 새 증가 등급이 아니에요(최악도 그 행의 두 배).
- 상한은 전용 타입 `CallTraceBudget`(`rate_limit.rs`)에 있어요. 공유 limiter는 스윕이 **스윕을 일으킨 호출의 창**(60초)으로 돌아서 1시간 버킷을 잊어요. 같은 이유로 `member_writes`가 따로 있어요. 시험이 시간을 주입해 두 경우를 나란히 보여 줘요.

**A5. 실패해도 응답은 그대로예요.** 기록 tx가 실패하거나 2초를 넘으면 경고 로그만 남기고 버려요. 응답·다른 감사 행·liveness·`tool_call`은 영향이 없어요. 시험이 두 경로를 따로 확인해요. 기록 INSERT를 거절하는 트리거(실패 경로)와, `pg_sleep(4)`를 거는 트리거(2초 시간 초과 경로: 응답이 같고, 행이 안 남고, 응답이 느린 쓰기를 기다리지 않고, 취소된 tx가 풀을 망가뜨리지 않아 다음 호출은 기록돼요)예요.

**A6. 읽는 길.** `audit_log`를 읽는 기존 길뿐이에요. 새 API·새 화면·새 테이블·마이그레이션이 없고, 이 행을 읽는 클라이언트 코드는 만들지 않아요. 오늘은 감사 행을 목록으로 읽는 REST 경로가 서버에 없어서(아래 「왜 owner 결정이 필요 없는가」 2) 운영 관찰은 DB 읽기 전용 집계(planner)로 해요.

### 읽는 법 (깨운 뒤 그 에이전트의 행을 시각순으로)

| 보이는 것 | 뜻 | 다음 |
|---|---|---|
| 행이 없다 | 호출이 서버에 닿지 않았거나 인증 단계에서 거절(401/403/429)이에요. 또는 이 자격이 그 시간의 상한(240행)에 이미 닿았거나(로그 `Agent Port call trace capped`), 기록이 실패했어요(로그 `Agent Port call trace write failed`·`write timed out`) | 기존 `auth.agent_bearer.*`·`agent_port.rate_limit.denied` 감사. `auth.agent_bearer.used`는 쌓이는데 이 행만 전혀 없으면 배포가 안 됐거나 기록이 막힌 거예요 |
| `protocol_error` + `reason` | 런타임이 요청을 잘못 만들었어요. `parse_error`(JSON 깨짐: 문자열에 줄바꿈이 들어가는 쉘 보간 등) · `accept`(Accept에 `text/event-stream` 없음) · `content_type` · `version_header`(modern `_meta`인데 `MCP-Protocol-Version` 헤더 없음) · `version_mismatch` · `mcp_method_header`·`mcp_name_header`(헤더가 본문과 다름 — 이전 호출의 `curl`을 재사용할 때 흔해요) · `modern_meta` · `request_shape` · `method_not_found` | 서버 문제가 아니라 루틴 지시문·런타임 쪽이에요. 이유 토큰이 고칠 곳을 말해 줘요 |
| `tools/list` `tools_listed` < 13 | 범위가 모자란 연결 | 승인 범위·토큰 범위 확인 |
| `tools/call` `unknown` 또는 카탈로그 이름 + `invalid_arguments` | 없는 도구나, view가 못 쓰는 도구를 불렀어요 | 범위 또는 루틴이 부르는 이름 |
| `oort_ping` ok 뒤 `oort_inbox_read` 행이 없다 | 루틴이 ping 뒤에 멈췄어요 | 루틴 지시문 |
| `oort_inbox_read` ok `agent_jobs ≥ 1`, 뒤에 `oort_job_start`·`oort_jobs_claim` 행이 없다 | **job이 보였는데 가져가지 않았어요** | 런타임 쪽(지시문·모델) |
| `oort_inbox_read` ok `events = 0`, 그런데 대기 run이 있다 | 커서가 이미 그 이벤트를 지나갔어요 | 루틴 5단계(`oort_job_start {}`)가 필요해요 |
| `oort_job_start` ok `jobs = 0`, 그런데 oort 쪽으로 수령 가능한 대기 run이 있다 | **서버 claim 술어 문제** | 재현 시험 요청(엔진) |
| `oort_job_start` ok `jobs = 1`, 뒤에 `oort_run_event`·`oort_run_complete`가 없다 | 시작 보고 뒤 에이전트가 멈췄어요 | 2026-10-15 증보(T1) 원장·liveness |

라벨을 읽을 때 알아 둘 것(모두 닫힌 어휘 안이라 누출이 아니에요).
- `method: unparsed`는 JSON이 아닌 본문뿐 아니라, 본문을 읽지 않은 전송 거절(헤더 길이·개수 초과, 413)에도 붙어요.
- `era: none`은 헤더가 없거나 중복이거나 UTF-8이 아닌 경우예요. `reason: transport_headers`는 쿼리 문자열 거절에도 붙어요. `413 ↔ body_too_large`는 「본문 거절은 413뿐」이라는 가정으로 상태 코드에서 정해요(코드 주석에 적혀 있어요).
- 같은 키가 두 번 있는 본문(`{"method":"ping","method":"tools/call", …}`)은 디스패처가 `parse_error`로 거절하는데 `method`·`tool`은 마지막 키 기준이에요. 실제로 실행된 요청에서는 둘이 일치해요(검수가 임의 요청 30만 건으로 대조했어요).
- `reason: rate_limited`는 도달할 수 없는 방어 행이에요(429는 기록하지 않아요). 표에 남겨 둔 이유는 그 문장이 `other`로 보이지 않게 하려는 것뿐이에요.

### 왜 owner 결정이 필요 없는가

planner 위임으로 수락하는 근거는 넷이에요(2026-10-14 증보와 같은 형식이에요).

1. **새로 보이는 내용이 없어요 — 본문·인자·토큰이 없어요.** 행에는 닫힌 어휘(`method`·`tool`·`outcome`·`reason`·`era`)와 HTTP 상태·JSON-RPC 코드, 서버가 자기 응답에서 센 정수(`tools_listed`·`events`·`agent_jobs`·`jobs`)만 실려요. 인자의 이름과 값·커서·`leaseHandle`·요청 `id`·헤더 값·채널/메시지/run id·본문·토큰은 읽지 않아요. 읽는 호출자 입력은 `method`와 `tools/call`의 `params.name` 둘뿐인데 둘 다 고정 목록에서 찾은 이름만 내보내고, 거절 `reason`도 서버가 쓴 문장을 정확 일치 표에서 찾아 표의 토큰만 내보내요. 그래서 호출자 문자열의 일부·접두·해시도 행에 들어갈 길이 없고(타입 `&'static str`·정확 일치 표), 시험이 값이 새지 않는 것을 잠가요(A3). 호출한 에이전트가 이미 아는 사실(자기가 부른 method·도구와 서버의 답)과 서버가 센 숫자라서, 2026-10-15 증보(T1)가 `?include=tools`로 채널 멤버에게도 연 것(도구 이름·시간·성공 여부)보다 좁아요. 밖으로 나가는 호출·웹훅·푸시도 이 행에서는 일어나지 않아요.
2. **기존 감사 열람 범위 그대로예요.** 새 테이블·열·권한·API·화면이 없어요. `audit_log`에 행 종류(`action`) 하나를 더할 뿐이고, 스키마·RLS·역할·GRANT는 그대로예요.
   - 오늘 `audit_log`를 목록으로 읽는 REST 경로는 서버에 없어요. OpenAPI의 `listWorkspaceAudit`은 핸들러가 등록되지 않은 폐기 경로예요(`docs/security/README.ko.md` 126행, ADR-0183 판정표). 그래서 이 행을 읽는 사람은 운영 DB를 직접 읽을 수 있는 운영자뿐이에요.
   - 나중에 감사 목록 API가 생기면 그 API의 열람 범위(owner/admin)를 따라가요. 이 행만 따로 열거나 닫지 않아요.
   - 서버 코드에서 `audit_log`를 읽는 쿼리 열두 곳(2026-10-27 전수 확인)은 모두 특정 `action`이나 `run_id`·`target_type = 'work_control'`로 좁혀서 읽어요. 이 행(`target_type = 'route'`, `run_id` 없음)은 그 어느 쿼리에도 걸리지 않아요.
3. **시간당 240행 상한이 있어요.** 자격(토큰 id)당 시간당 240행이고(전용 타입 `CallTraceBudget`, A4), 넘으면 그 시간이 지날 때까지 이 행만 안 써요. 호출은 막지 않고 쌓인 행도 지우지 않아요. 상한이 없다면 입장 속도 제한(`AgentPortConfig` 기본값 토큰당 분당 240·에이전트당 분당 480)만큼, 토큰당 시간당 14,400행까지 쌓일 수 있어서 상한은 그 1/60이에요. 15분 박자 루틴은 시간당 수십 행이고, 하루 최대는 자격당 5,760행으로 닫혀요. 인증과 속도 제한을 통과한 호출만 기록하고, 응답 본문·상태·헤더·제한·인증은 그대로예요(호출당 INSERT 한 건이 더해질 뿐이에요).
4. **되돌리기가 쉬워요.** `trace_call` 호출 두 곳을 지우면 새 행이 안 쌓여요. 쌓인 행은 감사 표에 남지만 읽는 소비자가 없어서 해가 없어요. 기록이 실패해도 응답은 바뀌지 않아요(경고 로그만, A5).

남는 주의 다섯.
1. 이 행은 「서버가 본 호출」이에요. 호출자가 보낸 도구 이름은 카탈로그 이름이나 `unknown`까지만 알 수 있고, 에이전트가 하려던 일은 알려 주지 않아요.
2. 기록은 답이 정해진 뒤 응답을 보내기 **전에** 기다려요(별도 tx, 2초 제한). 느린 DB에서는 호출당 최대 2초가 늘 수 있어요. 2026-10-15 증보(T1)의 `tool_call`·liveness 기록과 같은 방식·같은 한도예요. 새로 늘어나는 곳은 둘이에요. 지금까지 호출 뒤 DB 쓰기가 없던 호출(`initialize`·`tools/list`·`server/discover`·`ping`·거절·전송 거절)이고, lease 핸들을 건네는 `oort_jobs_claim`·`oort_job_start`예요(liveness 2초·`tool_call` 2초에 이어 이 기록 2초까지 기다린 뒤 응답해요. 클라이언트가 먼저 끊으면 「가져갔는데 핸들을 못 받음」이 되는데, #4284가 가리키는 증상과 같은 계열이에요. 정상 지연(ms)에서는 무시할 수준이고, DB가 2초씩 느린 때는 어차피 전체가 느려진 때예요). 시간당 240행을 넘은 뒤에는 이 기록의 DB 일이 없어요.
3. 이 행은 **진단용이고 보안 감사 통제가 아니에요.** 한 자격이 1분 안에 시간당 예산을 다 쓰면 그 뒤 한 시간은 호출이 이 행으로 남지 않아요(그 호출을 이 행에서 가릴 수 있어요). `auth.agent_bearer.used`는 허용된 호출마다 한 줄, 상한 없이 그대로여서 감사 기록 자체가 약해지진 않아요.
4. 상한에 닿은 뒤에도 사실 계산(요청 본문 1회·응답 본문 3회 파싱)은 호출마다 해요. 입장 속도 제한 아래에서 코어 하나의 0.4%(전형)~2.4%(3.2 MB 응답) 정도라 증폭이 되지 않아서 받아들였어요(검수 R1-01, Low).
5. `audit_log`에는 `run_id`·`action` 인덱스가 없고(`audit_ws_time_idx`·`audit_actor_idx`·`audit_subject_idx`·`audit_target_idx`뿐이에요), 이 행은 Agent Port발 감사 행을 한도 아래에서 대략 두 배로 늘려요. 위쪽이 닫혀 있어(자격당 시간당 240) 등급은 그대로예요. 후속 이슈 후보: `(workspace_id, action, created_at)` 인덱스와 보존 정책(검수 R1-06).

### 불변식 대조

- REST send → seq + message + outbox 단일 tx: 건드리지 않아요. 이 행은 관측이라 상태 전이와 같은 tx 규칙의 예외예요(2026-10-15 증보 T1과 같은 설명).
- 모든 테넌트 경로는 `workspace_id` + RLS FORCE + tx마다 `SET LOCAL app.workspace_id`: `with_tenant_tx`(`momo_app`)로 써요. BYPASSRLS 없음이에요.
- 클라이언트 직접 publish 없음. `schema_v0.sql`·마이그레이션 변경 없음. sqlx 런타임 쿼리(`write_audit`)예요.

### 구현 슬라이스

- **#4618 (engine) 1단계.** `momo-mcp`의 `call_shape`·`outcome_code`·`response_rpc_code`·`result_counts`(순수 함수, 닫힌 어휘), `routes/agent_port.rs` `trace_call`, `rate_limit.rs` `CallTraceBudget`.
- 시험: `momo-mcp/tests/call_trace.rs`(어휘가 닫혀 있다·`ToolFailure` 변종마다 결과 토큰이 같다·개수는 서버 응답에서만) · `momo-mcp/tests/refusal_reason.rs`(실제 거절 요청 40여 건이 각자의 토큰·상태·코드를 내요·`ToolFailure` 변종마다 토큰·디스패처의 모든 문장이 표에 있다·표에 없는 문장은 `other`) · `bins/momo-server/tests/agent_port_call_trace_pg.rs`(모든 종류의 호출이 정확히 한 행·값이 안 새요·상한·기록 실패가 응답을 못 바꿔요·개수가 「job을 봤는데 안 가져감」을 가려요) · `bins/momo-server/tests/grok_like_agent_flow_pg.rs`(현행 루틴대로 부르는 클라이언트의 DM·멘션·연속 DM 재현) · `rate_limit.rs` 단위(시간 주입, 240·3600 값 고정) · 검수 보강: `call_trace.rs`의 `every_listed_method_is_one_the_dispatcher_answers`(`CALL_METHODS`와 디스패처가 어긋나지 않는다) · `agent_port_call_trace_pg.rs`의 `a_trace_write_that_outlasts_its_ceiling_is_abandoned_and_the_answer_is_unchanged`(2초 시간 초과 경로)·`a_call_the_admission_limiter_refused_leaves_no_trace_row`(429)·모든 행의 열과 키를 보는 `assert_every_row_is_plain`.
- **#4618 (engine) 2단계.** workspace 게이트(`cargo fmt/clippy/test`)·독립 보안 검수(Blocker 0·High 0)·PR이에요. 검증 증거의 정본은 PR 본문이에요.
- 배포 뒤 운영 관찰은 planner가 읽기 전용 집계로 해요. 서버만 배포하면 되고(앱 빌드 없음), 에이전트를 한 번 깨운 뒤 최근 3시간의 `agent_port.call` 행을 시각순으로 위 「읽는 법」 표대로 읽어요. 이 증보는 원인을 고치지 않고 **어디서 멈추는지를 가르는 것**까지가 범위예요. 고치는 일은 갈린 결과에 따라 후속으로 해요.


## 증보 5 (2026-10-27, #4622) — D5 증보: 대화에는 무엇을 쓰나·진행은 stage로·빈 인사 금지·답 자리

- Status: **Accepted(planner 위임, owner 방향 승인 2026-10-26 「ㄱㄱ」 — #4577 권장 C 「진행은 에이전트 자신의 말로」·E 「답 자리」)**. 증보 4 전례예요. owner가 승인한 것은 C·E의 **방향**이고, 이 증보가 더한 판단 둘은 planner 위임으로 수락해요(아래 「결재 기록」). ① 스레드 안에서 부른 일의 최종 답을 같은 스레드에 단다(서버 정렬 1차, ADR-0148 증보). ② ADR-0162 D8 template의 한 문장을 교체한다. 공개 API·DB 계약은 바뀌지 않지만(새 열·새 권한·새 API·새 도구 없음) 에이전트 지시문·도구 설명과 최종 답이 놓이는 자리가 바뀌어서, ADR-0100에 따라 이 Accepted가 구현 머지 조건이에요. 1단계(#4622, `861baa384`·`286c7f7b0`)는 Proposed였고 지시문·도구 설명만 고쳤어요. 2단계가 서버 정렬 1차를 더했어요.
- 결재 기록 (planner 위임, 2026-10-27, #4622 2단계 지시): ① 이 증보와 ADR-0148 증보를 Accepted로 수락해요. 근거는 owner의 「ㄱㄱ」(C·E)예요. ② **서버 정렬 1차는 이 PR에서 해요.** 스레드 안에서 부른 일의 최종 답이 스레드를 떠나는 것은 owner가 승인한 E(「스레드 안 → 같은 스레드」)와 어긋나는 결함으로 봐요. ③ **2차(채널 최상위 멘션 → 트리거 아래 새 스레드)는 하지 않아요.** 보이는 동작이 크게 바뀌고 화면(#4619·#4620 스레드 요약 칩)과 맞춰야 해서 **#4646**으로 넘겨요. ④ job 페이로드의 답 자리 힌트(`work.triggerRootId` 등)는 최종 답의 자리를 서버가 정하므로 더하지 않아요(공개 API를 늘리지 않아요). ⑤ 관리형 워커·Hermes·REST gateway가 `stage`를 못 내는 점은 **#4647**로 넘겨요.
- 바뀌는 기존 결정: ① ADR-0162 D8 routine template의 한 문장 「결과를 원래 thread에 게시한다」를 아래 규칙으로 바꿔요. 그 문장은 서버가 하는 일과 달랐어요(최종 답은 에이전트가 게시하지 않고 `oort_run_complete`가 올려요). ② ADR-0132 D4의 빈 인사 목록을 해요체까지 넓혀요(원문 상수는 그대로 두고 더해요). ③ ADR-0148 규칙 6의 전제(「답은 본류에 놓인다」)를 **ADR-0148 증보(2026-10-27, #4622)가 스레드 안 트리거에 한해 바꿔요.** 이 증보는 그 결정을 인용해요.
- 표기: [V] 코드·시험 직접 확인(`track/engine` `d61dcd7cd`) · **[추정]** 해석 · `runtime-unverified` 실행 안 함

### 확인한 사실

- [V] 「빈 인사 금지」는 없던 규칙이 아니에요. ADR-0132 D4가 정했고 서버가 관리형·공동 호스팅 Hermes·외부 에이전트 job의 `system_prompt`에 실어요(`AGENT_INTERACTION_SAFETY_PREAMBLE`, 외부 A2A 카드 런타임은 제외). 외부 루틴 4번(`SELF_HOST_AGENT.md` §3.3.17.4)에도 있어요. **없던 것**은 ① 해요체 목록(「확인했어요」는 합쇼체 목록 밖이었어요), ② 「대화에는 결과·막힘·사람이 할 일만」, ③ 「진행은 stage, 대화로는 아님」, ④ 답 자리예요. 팀 AI 프롬프트·`oort_message_post`/`oort_run_complete` 설명·외부 연결 프롬프트에는 넷 모두 없었어요.
- [V] `stage`를 내보낼 수 있는 곳은 Agent Port의 `oort_run_event`뿐이에요. REST gateway 콜백은 `stage`를 받지 않고(`agent_gateway.rs`의 event 라우트가 `stage: None`), 관리형 워커에는 stage 보고가 없고, Hermes 어댑터는 `gateway/events`에 `status`·`detail`·`text_delta`만 보내요. 그래서 이 셋에게 규칙 7은 「stage로 보내라」가 아니라 「대화에 중계하지 마라」예요. 이 발견은 #4619 레일의 「지금 단계」가 이 셋에서는 비어 있을 수 있다는 뜻이에요. 이 증보는 고치지 않고 **#4647**이 이어받아요.
- [V] 외부 연결 프롬프트의 본문은 `HostedAgentWizard.tsx`가 아니라 `packages/momo-core/src/features/hostedAgents/presets.ts`의 `HOSTED_ROUTINE_TEMPLATE`예요. 위저드는 그 값을 보여 주기만 해요.
- [V] 최종 답을 쓰는 곳은 `complete_gateway_run_in_tx` 하나(REST 콜백과 `oort_run_complete` 두 문이 같은 함수를 불러요), 관리형 워커의 커밋과 **스트림 열기**, 팀 AI예요. 넷 모두 `lock_gateway_run_in_tx`로 잠근 run 행을 이미 읽고 있어서, 트리거 메시지의 root를 같은 문장에서 읽게 했어요(`GatewayRunSnapshot::trigger_root_id`).

### 규칙 (D5의 0~6에 이어요)

7. **진행은 stage로, 대화로는 아니다.** `oort_run_event`가 있는 에이전트(외부 Agent Port)는 단계를 `stage`로 보내고 메시지로 쓰지 않는다(「하는 중이에요」「확인해 볼게요」). `stage`를 못 내보내는 런타임(관리형·Hermes·팀 AI)은 진행을 말하지 않고 결과가 생길 때까지 조용히 있는다.
8. **대화에는 결과·막힘·사람이 할 일만.** 메시지와 `oort_run_complete.body`에는 ① 결과, ② 막힌 점(무엇이 막았고 무엇이 필요한지), ③ 사람이 할 일(승인·선택·보내 줄 것)만 쓴다. 그것부터 쓴다(빈 인사·요청 되풀이·맺음말 없음). 환영처럼 인사 자체가 일인 턴은 그 인사가 결과라서 이 규칙의 대상이 아니다.
9. **빈 인사 금지(ADR-0132 D4 확장).** 어떤 말투로도 쓰지 않는다: 「확인했습니다」「확인했어요」「알겠습니다」「알겠어요」「진행할게요」「시작할게요」, "got it", "understood", "on it", "will do". 초안에 그것뿐이면 아무것도 보내지 않는다. D4의 나머지(새 정보를 더할 때만 · 사람이 물었으면 반드시 응답 · 침묵은 성공)는 그대로다.
10. **답 자리.** E의 기준은 DM은 본류, 채널 최상위 멘션은 그 메시지의 스레드(`rootId`=그 메시지 id), 스레드 안은 같은 스레드(`rootId`=그 스레드의 root)예요. **에이전트가 직접 올리는 메시지**(`oort_message_post`, `oort_card_suggest`의 `rootId`)에는 이 규칙을 지시문으로 써요. **최종 답은 `oort_run_complete.body`이고 oort가 올려요.** 자리는 에이전트가 못 골라요. 서버가 정해요. 스레드 안에서 부른 일은 **같은 스레드**(ADR-0148 증보, #4622), 그 밖은 본류+인용이에요(채널 최상위 멘션의 새 스레드는 #4646). 그래서 같은 내용을 `oort_message_post`로 또 보내지 않는다. 지시문은 최종 답의 자리를 약속하지 않아요. 서버가 쥔 규칙이고 #4646에서 한 번 더 바뀌어서, 약속하면 지키지 못하는 문장이 돼요.

### 답 자리 현황 (서버가 강제하나, 지시문뿐인가) [V]

| 에이전트가 내는 것 | 자리를 정하는 곳 | DM | 채널 최상위 멘션 | 스레드 안 | E와 |
|---|---|---|---|---|---|
| **최종 답**: 외부 `oort_run_complete`·REST 콜백(`complete_gateway_run_in_tx`), 관리형 워커(`lib.rs` 커밋·`stream.rs` 열기), 팀 AI(`team_ai.rs`) | **서버 고정** `root_id: trigger_root_id` + `reply_to_id`=트리거. **전**: `root_id: None` 고정 | 본류+인용 | 본류+인용 | **같은 스레드+인용.** **전**: 본류+인용, 스레드를 떠났어요 | 채널 최상위만 어긋나요(#4646) |
| `oort_message_post` | 에이전트. 서버는 `rootId`·`replyToId`가 이 채널의 것인지만 봐요(`agent_port_tools.rs`) | 에이전트 몫 | 에이전트 몫 | 에이전트 몫 | 지시문뿐 |
| `oort_card_suggest` | 관리형: 서버(트리거의 스레드, 없으면 본류, `tool_exec.rs`). 외부: 에이전트(`rootId`, 존재만 검증) | 본류 | 관리형은 본류(새 스레드를 안 열어요) | 같은 스레드 | 스레드 안만 일치 |
| 호출 불가·건너뜀 안내 줄, 채널 쓰기 승인 카드 | 서버 `root_id: send.root_id`(말한 자리, `agent_mentions.rs`) | 본류 | 본류 | 같은 스레드 | 「말한 자리」 규칙 |
| ADR-0193 구독 경계 안내 | 서버 `notice_root`(`agent_mentions.rs`) | 평가 안 함 | 트리거 아래 새 스레드 | 같은 스레드 | E와 같아요 |
| 답 대용 줄: 관리형 워커의 못 돌 때 안내(`settle_refused_turn`), 정지·승인 만료 closing line(`momo-notifier`), A2A 막힘 줄 | 서버 `root_id: None` | 본류 | 본류 | **본류(스레드 밖)** | 어긋나요(#4646에서 같이 판단) |

행동 시험이 이미 잠근 것은 안내 줄·승인 카드의 말한 자리(`agent_port_tools_conformance_pg.rs`), 카드의 트리거 스레드, 관리형 답의 **인용**(`agent_worker_conformance_pg.rs`)이에요. **최종 답의 `root_id`는 1단계 전에는 어떤 시험도 잠그지 않았어요.** 1단계가 `agent_answer_place_pg.rs`로 외부 Agent Port 경로를 「현행」으로 잠갔고(격리 PG 18에서 세 칸 모두 `root_id` NULL + 트리거 인용), 2단계가 그 시험을 새 동작으로 바꿨어요. 네 경로(외부 Agent Port·REST 콜백·관리형 워커 비스트리밍과 스트리밍·팀 AI) 모두 같은 자리를 행동 시험으로 확인해요(아래 「반영 자리와 시험」).

### 어긋남과 판단

- 어긋남 1(**남음**): 채널 최상위 멘션의 최종 답이 본류+인용이라 E와 달라요. ADR-0148 규칙 6의 설계(「인용은 대화를 본류에 두면서 맥락만 끌어오는 장치」)예요. **#4646**이 화면과 함께 해요.
- 어긋남 2(**고침, 2단계**): 스레드 안에서 부르거나 답글로 깨워도(ADR-0162 증보 5) 최종 답이 스레드 밖 본류로 나왔어요. run에는 트리거 id만 있었고 답을 쓰는 곳이 트리거의 root를 읽지 않았어요. 이제 같은 스레드에 달려요(ADR-0148 증보).
- 어긋남 3(**정리**): 외부 에이전트는 job에서 트리거의 root도 DM 여부도 받지 못해요(`work`는 `triggerMessageId`만 주고, 메시지에는 `rootId`가 있지만 채널 종류는 없어요). **최종 답은 서버가 자리를 정하므로 이 정보 없이 맞아요.** 에이전트가 직접 올리는 메시지의 DM·최상위 구분은 아직 지시문뿐이에요(「모르겠으면 `rootId`를 넣지 않는다」). 서버가 대신 정할지 힌트를 줄지는 #4646에서 같이 정해요(결재 ④: 이번에는 더하지 않아요).
- **판단 1: 서버 정렬 1차는 이 PR에서 한다.** 근거 셋이에요.
  1. owner가 승인한 E가 「스레드 안 → 같은 스레드」를 명시했고, 스레드를 떠나는 현행은 그것과 어긋나는 결함이에요.
  2. 원래 설계가 아니었어요. B5.1 이식 때 `momo-messaging`에 메시지의 root를 읽는 길이 없어서 본류로 답했고(그 주석이 「Swift는 트리거의 스레드 안에서 답한다」고 적었어요), 그 제약은 사라졌어요(`lock_gateway_run_in_tx`가 읽어요).
  3. 에이전트의 컨텍스트 창은 이미 스레드를 세션 경계로 봐요(`agent_context_window_in_tx`: 트리거가 스레드 안이면 root와 답글을 먼저 채워요). 에이전트의 이전 답이 스레드 안에 있어야 다음 턴의 창에 들어와요.
- **판단 2: 2차는 하지 않는다.** 보이는 동작이 크게 바뀌어요. E의 화면(스레드 요약 행의 작업 중 칩)은 #4619(A·B·D)에 없어서, 서버가 먼저 뒤집히면 답이 「답글 1개」 뒤로 숨어요. 인용이 스레드 root 자신을 가리키는 중복, 푸시·안 읽음·hosted 인박스가 스레드 답글을 세는 방식, 스레드 깨우기(W1이 「첫 답글을 에이전트가 쓴 스레드」를 그 에이전트가 연 스레드로 봐요)와의 맞물림도 그때 정해요.
- **판단 3: 지시문은 서버가 정한 자리를 거짓으로 말하지 않는다.** 규칙 10은 에이전트가 고르는 자리에만 쓰고, 최종 답은 「oort가 올려요, 자리를 고르지 않아요」로만 말해요. `oort_run_complete` 설명에는 자리 낱말이 없고 시험이 그것을 잠가요(`the_final_answers_tool_promises_no_place`). 서버 정렬 뒤에도 이 문장은 그대로 참이에요.

### 열어 두는 것

1. **서버 정렬 2차 — #4646.** 채널 최상위 멘션의 최종 답을 트리거 아래 새 스레드로(`notice_root`와 같은 규칙, DM은 본류) + ADR-0148 증보 + #4619·#4620과 같이 출시. 정렬 PR은 `agent_answer_place_pg.rs`의 채널 최상위 시험을 먼저 빨갛게 만든 뒤 고쳐요. 같이 정할 주변 줄(위 표 마지막 줄)도 거기에 있어요.
2. **job 페이로드의 답 자리 힌트.** 이번에는 더하지 않았어요(결재 ④). 에이전트가 직접 올리는 메시지의 DM·최상위 구분이 필요하면 #4646에서 `work`에 `triggerRootId`(와 채널 종류)를 더할지 정해요. 공개 API 가산이라 ADR이 필요해요(Buzz는 하니스가 `<context>`에 답 위치를 넣어 줘요).
3. **`stage`를 못 내는 세 경로 — #4647.**

### 반영 자리와 시험

| 자리 | 바꾼 것 |
|---|---|
| `docs/SELF_HOST_AGENT.md`·`.ko.md` §3.3.17.4 4번 | 규칙 7~10(외부 루틴) |
| `momo-mcp/src/tools.rs` | `oort_message_post`(무엇을 올리나·자리), `oort_run_complete`(body는 oort가 올려요·결과/막힘/할 일만), `oort_run_event`(진행은 여기), `oort_card_suggest`(스레드 안이면 `rootId`) |
| `momo-agent/src/mention.rs` | `AGENT_CONVERSATION_PREAMBLE`(규칙 7~9, ADR-0132 D4 상수는 그대로). 관리형·공동 호스팅 Hermes·외부 job의 `system_prompt`가 받아요 |
| `momo-workspace-actions/src/team_ai.rs` | 팀 AI 프롬프트 규칙 한 줄(규칙 8·9) |
| `packages/momo-core/src/features/hostedAgents/presets.ts` | `HOSTED_ROUTINE_TEMPLATE`(외부 연결 프롬프트, ADR-0162 D8 문장 교체). 위저드 tsx는 diff 0 |
| `momo-agent/src/run.rs` | `GatewayRunSnapshot.trigger_root_id`: 트리거의 root(같은 채널의 살아 있는 최상위 메시지일 때만)를 run 잠금 문장에서 같이 읽어요. 지워진 root는 `None`이라 사람이 못 올리는 자리에 답이 가지 않아요 |
| `momo-server/.../agent_gateway.rs` | `complete_gateway_run_in_tx`: `root_id: run.trigger_root_id`, 롤업을 지키는 `send_thread_notice_in_tx`로 써요(REST 콜백과 `oort_run_complete`가 함께 받아요) |
| `momo-agent-worker/src/lib.rs`·`stream.rs` | 시작 트랜잭션이 root를 읽어 `MessageStream::new`에 넘기고(스트리밍한 답은 열기 쓰기가 만들고 커밋은 dedupe라서), 커밋도 같은 값을 써요. `MessageStream::new`는 root를 필수 인자로 받아요 |
| `momo-agent-worker/src/team_ai.rs` | `team_ai_finish`가 같은 자리·같은 spine |
| 시험(행동) | `agent_answer_place_pg.rs`(외부 Agent Port: DM·채널 최상위 불변, 스레드 안은 같은 스레드+롤업+`thread.updated`, 지워진 root 폴백), `gateway_mode_conformance_pg.rs`(REST 콜백), `agent_worker_conformance_pg.rs`(관리형 워커 비스트리밍·스트리밍), `team_ai_conformance_pg.rs`(팀 AI). 사보타주 결과는 PR 본문 |

지시문 시험(`bins/momo-server/tests/agent_conversation_rules.rs`, `presets.test.ts`)은 문장 존재가 아니라 **규칙마다 핵심 낱말 집합**이 그 자리 안에 모두 있는지 봐요. 시험이 낱말을 하나씩 지워 보고 그 규칙이 빨개지는지를 스스로 확인해서(사보타주) 「실패할 수 없는 단정」이 되지 않게 해요. 각 규칙이 #4622 이전 문장에서는 빨갛다는 것도 시험이 스스로 확인해요(원래 있던 낱말로 채워지는 규칙은 아무것도 증명하지 않아요). 시험이 못 보는 것은 낱말이 있어도 문장이 부정형으로 바뀐 경우와, 실제 모델이 따르는지예요.

### 한계

- 규약이지 보증이 아니에요(증보 3 D16의 `runtime-unverified` 규율). 규칙 7~9는 모델이 따를 때만 지켜져요. 서버가 막는 것이 아니에요. 규칙 10 중 최종 답의 자리는 서버가 정해서 규약이 아니에요.
- 답 대용 줄(위 표 마지막 줄)은 1차 뒤에도 스레드 밖에 남아요. 스레드 안에서 부른 요청이 못 돌거나 멈추면 그 안내는 본류에 나와요. #4646.
- #4646 전까지, 채널 최상위 멘션에서는 에이전트가 **직접 올리는** 메시지(규칙 10: 트리거 아래 스레드)와 **최종 답**(본류)의 자리가 달라요. 규칙 10이 직접 올리는 메시지에는 E를 그대로 쓰고, 최종 답의 자리는 서버가 정하기 때문이에요. 스레드 안에서는 둘 다 같은 스레드예요.
- `runtime-unverified`: 클라이언트가 스레드 안 **스트리밍** 답(열기 쓰기가 스레드 안에 만들어요)을 어떻게 그리는지, 실기기 푸시가 스레드로 묶이는지(판정 SQL은 `reply_to_id`로 묻는 사람을 찾고 `thread_id`를 root로 묶는 것까지 확인했어요), 스레드 안 답의 안 읽음 표시는 실행해 보지 않았어요.
- 팀 기억 요약(`memory.rs`의 `pending_stats`)은 최상위 메시지만 세요. 스레드 답글에 걸리는 기존 성질이고, 에이전트의 스레드 안 답도 이제 거기에 속해요. 스레드 단위 읽기(`read_range`)는 root와 답글을 함께 봐요. 이 증보는 고치지 않아요.

## 증보 6 (2026-10-27, #4621) — 에이전트 확인 박자 `cadence`: 「다음 확인 때 가져가요」의 근거

- Status: **Accepted(planner 위임, owner 사후 보고 2026-10-27)**. 읽기 필드 추가예요. 새 테이블·새 열·새 권한·마이그레이션이 없고 새로 보이는 내용도 이미 열린 정보와 같은 등급이라서, 증보 2·4와 같은 형식으로 owner 결정 없이 planner 위임으로 수락해요. 근거는 아래 「왜 owner 결정이 필요 없는가」 네 가지예요. 공개 API 필드 추가라 ADR-0100에 따라 이 Accepted가 구현 머지 조건이에요. 초안은 같은 날 Proposed였어요(#4621 1단계). 번호 5는 #4622의 에이전트 행동 규칙 증보가 쓰고 있어서 이 증보는 6이에요. 두 증보는 내용이 서로 독립이라(그쪽은 지시문과 답 자리, 이쪽은 읽기 필드) 병합 순서는 상관없지만, 이 절은 그 증보 뒤에 둬요.
- 결재 기록 (planner 위임, 2026-10-27, #4621 2단계 지시): ① 이 증보를 Accepted로 수락해요. ② 1단계가 미결로 올린 숫자와 정의를 이렇게 정했어요. 결재 1: **마감 허용 오차 2배**를 받아요. 결재 2: **규칙성 70%·박자 상한 90분·최소 표본 4**를 받아요(이슈 본문에 없던 게이트예요). 근거는 아래 시뮬레이션이고 이 증보에 적어요. 결재 3: 숫자를 환경변수로 봉인하지 않아요(코드 상수). 결재 4: **`realtime`의 뜻**(30분 이상 구간의 80% 이상에서 침묵 5분 이하)을 받아요. 화면은 「지금 연결됨」으로 읽어요. ③ 수락 경로는 planner 위임이에요(증보 2·4 선례와 아래 「왜 owner 결정이 필요 없는가」). ④ 도어벨 깨움 분리는 후속 이슈 #4652로 둬요. ⑤ owner에게는 사후 보고해요.
- 2단계 보강 (워커 판단, planner 확인 대상): 결재 4가 `realtime`을 「지금 연결됨」으로 읽게 했으므로 `realtime`에 **지금 호출 중** 조건(마지막 호출이 5분 안)을 더했어요. 이 조건이 없으면 한 시간 전에 멈춘 폴러가 24시간 동안 `realtime`으로 남아 「지금 연결됨」이 거짓이 돼요. 멈춘 폴러는 박자도 없어서 `unknown`이에요(C2 3). 결재 4의 정의를 좁힐 뿐 다른 값은 안 바뀌고, 조건 한 줄(`present_now`)을 지우면 1단계 정의로 돌아가요.
- 독립 보안 검수 (2026-10-27): R1이 High 둘을 냈고 고쳤어요(R1-01 읽는 일의 상한이 앱 조건에서는 성립하지 않았어요, R1-02 새 연결이 옛 연결의 박자를 물려받았어요). R2는 두 수리를 앱 조건 실측으로 확인해 **PASS(Blocker 0·High 0)**를 냈고, 수리가 만든 Medium 둘(R2-01 era 하한이 인덱스 조건이 아니라 필터였어요, R2-02 비활성 가드 시험이 가드를 못 봤어요)과 Low·Info(대조군의 취약함, 문서의 과한 문장, 오버플로 모양)도 고쳤어요. 아래 C1이 고친 모양이고, 검수가 낸 한계는 「남는 주의」 7~10에 적었어요.
- 근거: 이슈 #4621, 그리고 owner 2026-10-26 22시대 「ㄱㄱ」(#4577 권장안 D: 타임라인에는 예외만 남기고, 루틴형 에이전트에게는 「연결이 꺼져 있을 수 있어요」 대신 「다음 확인 때 가져가요」). 이 증보는 그 말의 **근거 데이터**예요. 운영 사실은 #4618 코멘트(2026-10-26, 읽기 전용 집계)예요.
- 표기: [V] 코드·운영 직접 확인 · **[추정]** 해석 · (결재 N) 위 결재 기록의 항목

### 배경

- [V] grok은 실시간 연결이 아니라 루틴 박자로 와요. 자격 사용 시각이 17:01 · 17:14 · 17:29:54 · 17:44:56 · 18:12 · 18:27이고, 한 번에 3~6번 불러요(#4618). 같은 연결의 10-18~19 표본은 깨어남 37회·간격 36개, 간격 10~29분·**중앙값 15분**·평균 16.2분이에요(증보 3 배경).
- [V] 그런데 화면은 `hostOnline=false`만 보고 「연결이 꺼져 있을 수 있어요」·「일하는 곳 · 연결 안 됨」이라고 말해요. `hostOnline`은 활성 자격이 **최근 10분 안에** 쓰였는가예요(`HOSTED_RECENTLY_SEEN_SQL`, 600초). 15분 박자 에이전트는 마지막 호출 10분 뒤부터 다음 박자까지 `false`예요. 꺼진 게 아니라 다음 박자를 기다리는 중이라 **사실과 다른 말**이에요.
- [V] 서버에는 박자를 추정할 재료가 이미 있지만, 박자를 말하는 곳이 없어요. 재료마다 쓸 수 있는지가 달라요.

| 재료 | 쓰는가 | 이유 |
|---|---|---|
| `audit_log` `auth.agent_bearer.used` | **쓴다** | 허용된 호출마다 한 줄이에요. 상한이 없고, 이 변경 전의 이력도 있고, `actor_member_id`가 에이전트예요. |
| `agent_port.call`(증보 4) | 쓰지 않는다 | 자격당 시간당 240행 상한이라, 자주 부르는 에이전트가 더 드물게 부르는 것처럼 보여요. #4634 배포 뒤의 행만 있어요. |
| `oort_ping`(D5 0번)과 `hosted_agent_liveness` | 쓰지 않는다 | `last_ping_at`은 값 하나(마지막)라 중앙값을 낼 이력이 없어요. 루틴이 지시문을 따른다는 보증도 없어요. |

### 바뀌는 것

**C1. 재료와 읽기.** `audit_log` 행 가운데 `action='auth.agent_bearer.used'`이고 `detail.path='/v1/mcp/agent-port'`이고 `actor_member_id`가 그 에이전트이고 최근 24시간이고 가장 새로운 2,000행까지예요.
- 에이전트로 묶어요. **토큰으로 묶지 않아요.** OAuth 접근 토큰은 30분마다 새 `token` 행이라 토큰 기준이면 박자가 30분마다 끊겨요.
- 경로 조건은 방어선이에요. 호스팅 자격은 자기 audience에서만 허용돼서(`auth.rs`) 호스팅 에이전트의 `used` 행은 모두 이 경로예요. 같은 멤버의 다른 자격이 REST를 부른 행은 「확인」이 아니라서 세지 않아요.
- 읽는 곳은 호출 때가 아니라 읽기 때예요: 멤버가 읽는 `GET …/agents/{agent}/liveness`와 관리자의 `GET …/hosted-agent-connections`(목록·단건). 테넌트 tx(`momo_app`, BYPASSRLS 없음)에서 `workspace_id`를 SQL에 명시하고 RLS가 한 번 더 막아요.
- 서버 코드에서 `audit_log`를 읽는 **열세 번째** 쿼리예요. 증보 4가 센 열두 곳(2026-10-27 전수)은 모두 특정 `action`이나 `run_id`로 좁혀 읽는데, 이 쿼리도 에이전트·action·경로·창으로 좁혀요. 행은 서버 밖으로 나가지 않고 파생값만 나가요.
- **era — 지금 연결의 호출만 세요.** 호출은 에이전트로 묶는데, 해제된 에이전트는 같은 멤버에 **새 연결**로 다시 등록될 수 있어요(`subscription_agents` `reuse_in_tx`). 하한이 없으면 새 연결이 `active`가 되는 순간 옛 연결의 24시간치가 그 박자가 돼서, 한 번도 부르지 않은 호스트에 「보통 15분 안」이 나가요(검수 R1-02). 그래서 읽기는 에이전트의 **현재 연결이 만들어진 때**부터만 세요. 현재 연결은 liveness 라우트가 고르는 것과 같아요(활성 우선, 그다음 최신). 연결 행은 `create_hosted_connection_in_tx` 한 곳에서만 만들어지고 `created_at`은 어떤 경로(재발급·확정·감지)에서도 바뀌지 않으며, 첫 호출은 자격이 연결 생성 뒤에 발급·제시된 다음에만 남으므로 새 연결의 정당한 호출은 언제나 그 연결의 era 안이에요(검수 R2). 하한은 **`COALESCE`나 서브셀렉트로 감싸지 않은 바깥 열**(`e.era_start`)이어야 해요. 그래야 플래너가 인덱스 조건으로 만들어 순서 스캔이 era에서 멈추고, 감싸면 필터가 돼서 재등록한 병적 폴러의 옛 행을 전부 읽고 버려요(검수 R2-01). 시험은 연결이 한 시간 된 에이전트의 옛 6,000행으로 재는데, **앱 역할(`momo_app`, RLS)로** 재요: 같은 문장이 슈퍼유저에서는 인덱스 조건이고 앱에서는 필터가 될 수 있어서, 슈퍼유저로 재면 이 퇴화를 못 봐요(검수 R3-01이 사보타주로 보였고, 그 뒤 시험을 앱 역할로 옮겼어요).
- **읽는 일의 상한 — 순서 인덱스 스캔을 강제해요.** `LIMIT`은 돌려주는 행의 상한이지 읽는 행의 상한이 아니에요. 플래너는 한 에이전트의 행 수를 모든 행위자의 평균으로 어림해서 몇 행으로 보고, `audit_actor_idx`를 순서대로 걷다 멈추는 계획이 아니라 비트맵 스캔 + 정렬을 골라 그 에이전트의 창 안 행을 전부 읽어요(하루 최대 약 69만 행, 검수 R1-01이 앱 조건 `momo_app`·바인드 파라미터에서 재현했어요). 그래서 읽는 동안만 `enable_bitmapscan = off`로 두어요. 시험이 같은 문장을 플래너에 맡겼을 때(6,000행 에이전트에서 50행을 달라고 하면 6,000튜플을 읽어요)와 로더(50튜플)를 나란히 재요.
- **실패해도 라우트는 답해요.** 읽기는 자기 savepoint 안에서 2초(`CALL_READ_TIMEOUT`) 한도로 돌고, 끝나면 savepoint를 되돌려 두 설정이 라우트의 다른 질의로 새지 않게 해요. 읽기가 실패하거나 한도를 넘으면 그 박자는 `unknown`으로 읽고(로그만 남겨요) 나머지 응답은 그대로 나가요. 박자는 보여 주는 값이고, 관리자가 「연결 해제」로 가는 길이 이 GET들이라서 박자가 라우트를 끌어내리면 안 돼요(검수 R1-04).
- **활성 연결만 읽어요.** 비활성은 어차피 `unknown`이라 읽지 않아요(버리는 읽기를 없앴어요).

**C2. 추정식 — 순수 함수 한 곳**(`momo-agent` `derive_cadence`). 입력은 호출 시각 목록과 `now`뿐이라 모든 경계를 시험할 수 있어요.

1. 창(24시간) 안의 호출만 써요. 창이 낡음 기준이에요: 24시간 동안 한 번도 안 불렀으면 `unknown`이에요. 따로 낡음 상수를 두지 않아요.
2. **깨어남**: 호출 사이 침묵이 5분을 넘으면 새 깨어남이에요. 루틴 한 번의 3~6호출은 한 사건이에요.
3. **`realtime`**: 첫 호출과 마지막 호출 사이가 30분 이상이고, 그 구간의 80% 이상에서 침묵이 5분을 넘지 않았고, **지금도 마지막 호출이 5분 안**이면 쉬지 않고 부르는 에이전트예요. 박자를 추정할 대상이 아니에요(「연결됨」을 묻는 게 맞아요). 이 규칙이 없으면 10초마다 부르는 에이전트는 24시간짜리 깨어남 하나라 간격이 0개고 `unknown`이 돼요.
   - 「지금」 조건이 2단계 보강이에요. `realtime`은 화면이 「지금 연결됨」으로 읽는 말(결재 4)이라서 지금의 말이어야 해요. 침묵이 5분(깨어남을 가르는 그 침묵)을 넘으면 더는 지금이 아니에요. 그러면 `realtime`이 아니고, 한 번 길게 일하고 멈춘 폴러는 깨어남이 하나뿐이라 박자도 없어서 `unknown`이에요.
4. 아니면 **깨어남 시작 사이의 간격**을 모아요. 간격이 4개 미만(깨어남 5개 미만)이면 `unknown`이에요.
5. **박자 = 간격의 중앙값** M이에요. 두 가지를 더 통과해야 해요.
   - M이 **90분 이하**여야 해요. 더 길면 루틴의 박자로 읽기엔 길어서 `unknown`이에요.
   - 간격의 **70% 이상이 M의 ±50% 안**에 들어야 해요. 아니면 주기가 없는 에이전트라서 `unknown`이에요. 「보통 40분」을 지어내지 않아요.
6. `routine`이면 세 값을 내려요.
   - `typicalMinutes` = M을 가장 가까운 분으로(최소 1).
   - `expectedCheckAtMs` = 가장 새로운 깨어남의 시작 + **2 × M**.
   - `late` = 마지막 호출 뒤 **3 × M**을 넘게 소식이 없음.

| 숫자 | 값 | 이유 |
|---|---|---|
| 창 | 24시간 | 15분 박자면 5개 깨어남에 1시간, 한 시간 박자도 5시간이면 돼요. |
| 깨어남을 가르는 침묵 | 5분 초과 | 실측 박자의 최소 간격(10분)보다 짧고 한 깨어남 안의 호출 간격(수 초~수십 초)보다 길어요. 길게 일하는 깨어남도 호출이 5분 넘게 끊기지 않으면 한 사건이에요. |
| 최소 표본 | 간격 4개(깨어남 5개) (결재 2) | 15분 박자면 관측 1시간이에요. #4618의 6개 깨어남 표본(간격 5개)이 통과해야 하고, 더 적게 잡으면 우연한 두세 번의 깨어남을 박자로 읽어요. |
| 규칙성 | 간격의 70%가 M의 ±50% (결재 2) | 실측 15분 박자(약 13·16·15·27·15분)는 4/5가 안(27분만 밖)이에요. 10~29분 분포(중앙값 15분)로 흉내 낸 36개 표본은 32개(89%)가 안이에요. 시뮬레이션(아래)에서 주기 없는 에이전트를 가장 잘 거르면서 실측 모양을 통과시키는 값이에요. |
| 박자 상한 | M ≤ 90분 (결재 2) | 한 시간 크론(지터 포함)은 통과하고 두 시간 크론은 말하지 않아요. 상한이 없으면 하루 몇 번 우연히 깨는 에이전트의 중앙값(수 시간)이 박자로 읽혀요. |
| 마감 | 마지막 깨어남 시작 + 2M (결재 1) | 아래. |
| 늦음 | 마지막 **호출** 뒤 3M 초과 | 이슈의 「3배 초과」. |
| realtime | 30분 이상 구간의 80% 이상에서 침묵 ≤ 5분이고, 마지막 호출이 5분 안 (결재 4 + 2단계 보강) | 폴링 에이전트. 깨어남 하나가 24시간이 되는 함정을 피해요. 「마지막 호출이 5분 안」이 없으면 멈춘 폴러가 하루 동안 `realtime`으로 남아요. |
| 행 수 | 에이전트당 최대 2,000 | 한 번의 읽기가 만드는 일의 천장이에요. |

**숫자를 시뮬레이션으로 골랐어요 [추정] (결재 2의 근거).** 알고리즘을 그대로 파이썬으로 옮겨 무작위 1,000일씩 돌렸어요(레포에 넣지 않은 일회성 계산이에요). 모델은 이래요.
- 한 깨어남은 호출 3~6번이고, 호출 사이는 {8, 12, 20, 33, 47}초에서 골라요.
- 15분 루틴의 간격은 실측 모양 36개 표본에서 골라요: 10분 3개 · 12분 4개 · 14분 5개 · 15분 8개 · 16분 5개 · 18분 4개 · 20분 3개 · 24분 2개 · 29분 2개(중앙값 15분, 최소 10분·최대 29분은 증보 3 배경의 실측).
- 주기 없는 에이전트는 깨어남을 24시간 안에 균등하게 흩뿌려요.
- 난수 시드를 고정했어요(`random.Random(462100)`). 2단계에서 다시 돌려 아래 표와 같은 수를 확인했어요.

합성 데이터라 실제 트래픽은 재지 않았어요(`runtime-unverified`).

| 시나리오 | 결과 |
|---|---|
| 15분 루틴, 이력 1.5·2·3·6·24시간 | 12~18분 박자로 읽힘 90 · 92 · 97 · 99 · 100%. 이력 1시간은 21%예요(새 에이전트는 두어 시간 걸려요). |
| 주기 없는 임의 깨어남(하루 6·10·20·40·80번) | 루틴으로 오판 0.6 · 0.6 · 1.9 · 0.6 · 2.7%. 규칙성 60%·박자 상한 없음이면 47 · 19 · 9 · 9 · 35%예요. |
| 15분 스윕 + 근무 10시간에 도어벨 깨움 15~120번 | 14~16분 박자 100%. 깨움이 섞여도 중앙값이 버텨요. |
| 도어벨로만 깨는 에이전트(대화마다 6~20분 간격 3~8번) | 61~91%가 8~23분 박자로 읽혀요(한계 1). |

**마감이 왜 2배인가 (결재 1).** 소비자(#4619 `uncollectedDeadlineMs`)는 `expectedCheckAtMs`를 「이 시각까지 가져가지 않으면 못 가져감」의 마감으로 그대로 써요. 중앙값이라서 간격의 절반은 M보다 길어요. 마감을 M에 두면 건강한 루틴의 느린 깨어남마다(실측 10~29분, 중앙값 15분) 「못 가져감」이 켜졌다가 곧 꺼져요. 한 박자를 통째로 놓쳐야 켜지도록 2배로 해요. 증보 3 E2의 `woken_not_collected` 30분(= 15 × 2, 실측 최대 29분보다 1분 많음)과 같은 비율이라 두 규칙이 서로를 반박하지 않아요.
- 마감은 예보가 아니라 **마감**이에요. 서버는 박자를 앞으로 여러 번 투영하지 않아요(과거 시각일 수 있어요). 소비자(#4619 구현)는 마감이 run이 들어오기 전이면 무시하고 기본 유예로 돌아가는 가드를 이미 갖고 있어요.
- `late`는 **마지막 호출**에서 재요. 깨어남 시작에서 재면, 50분짜리 일을 하며 2분마다 부르는 에이전트가 「늦다」가 돼요. 마감은 깨어남 **시작**에서 재요. 박자가 시작 사이의 간격이기 때문이에요.

예: #4618의 grok(17:01 · 17:14 · 17:29:54 · 17:44:56 · 18:12 · 18:27, 초 단위는 일부만 알려져 있어요)은 간격이 약 13·16·15·27·15분이라 중앙값이 15분 안팎이고 5개 가운데 4개가 박자 안이라서 `routine`, `typicalMinutes=15`예요. 마감은 18:57쯤이고, 18:27 깨어남의 마지막 호출 뒤 약 45분(19:13 안팎)까지 소식이 없으면 `late`예요.

**C3. 어휘.** `cadence.kind`는 `realtime | routine | unknown` 셋이고, `routine`만 `typicalMinutes`·`expectedCheckAtMs`·`late`를 가져요(「routine(~N분)」은 `kind=routine`과 `typicalMinutes=N`). 연결이 `active`가 아니면(대기·해제·만료) 이력이 있어도 `unknown`이에요: 끊어진 연결의 옛 호출은 다시 확인하겠다는 약속이 아니에요. `unknown`은 지금처럼 정직하게 「모름」이에요. `realtime`은 **지금 쉬지 않고 부르는 중**이라는 뜻이에요(마지막 호출이 5분 안). 화면은 「지금 연결됨」으로 읽어요(결재 4).

**C4. API 모양.** openapi `AgentCadence`(`additionalProperties: false`)를 `AgentLiveness`(멤버)와 `HostedAgentLiveness`(관리자)에 `cadence`로 더해요. 구 서버 응답에는 필드가 없고 소비자는 그것을 `unknown`과 같이 다뤄요.
- **명부(`GET …/roster`)에는 넣지 않아요.** 명부는 채널을 공유하지 않는 멤버에게도 보이고, 부팅마다 읽는 뜨거운 경로예요. 행마다 감사 읽기를 얹지 않아요.
- **run 읽기에도 넣지 않아요.** 박자는 run이 아니라 에이전트의 사실이고, 입력창 띠의 「다음 확인 때 가져가요」는 run이 생기기 전에 서야 해요.
- 소비자는 이미 같은 liveness 조회를 나눠 써요(`useAgentLiveness`: 멤버 목록·헤더·사이드바·작업 패널, 60초 폴링, 쿼리 키 공유). 새 요청이 생기지 않아요.
- 호스팅이 아닌 에이전트는 이 경로가 404예요. 서버가 도는 에이전트에게는 「확인 박자」라는 질문이 없어요.

**C5. 노출 범위.** 에이전트와 채널을 하나라도 공유하는 활성 사람 멤버(기존 liveness 경로 그대로)와 워크스페이스 관리자예요. 이슈의 「run을 볼 수 있는 멤버」는 이 집합 안이에요(run은 그 채널의 활성 멤버에게만 보이고 에이전트는 그 채널의 멤버예요). **새로 열리는 대상이 없어요.** 새로 보이는 것은 평소 간격(분)·마감 시각·늦음 여부예요. 같은 사람들이 이미 보는 `lastSignalAtMs`(마지막 신호 시각)를 요약한 것이라 같은 등급이고, 에이전트 박자는 내용이 아니에요. 호출 시각 목록·호출 수·간격 수·도구 이름·행 id는 응답에 없어요. 멤버 응답에는 `lastToolError*`·도어벨·ping 상세가 여전히 없어요.

**C6. 소비자 계약(#4619·#4620).** 이름은 #4619의 `RoutineHint`에 맞췄어요(`typicalMinutes`, `expectedCheckAtMs`).

| 서버 값 | 화면이 말하는 것 |
|---|---|
| `routine`, `late=false` | 아무도 가져가지 않은 요청에 「다음 확인 때 가져가요(보통 `typicalMinutes`분 안)」. 마감은 `expectedCheckAtMs`(run이 마감 뒤에 들어왔거나 값이 없으면 기본 유예 5분). 마감이 지나면 「못 가져감」 예외 줄. |
| `routine`, `late=true` | 「평소보다 늦어요」. 「다음 확인 때 가져가요」는 말하지 않아요(박자가 끊겼어요). |
| `realtime` | 「지금 연결됨」(결재 4). 박자는 말하지 않아요. 쉬지 않고 부르므로 기다림이 없어서 「다음 확인 때 가져가요」도 쓰지 않아요. 서버가 마지막 호출이 5분 안일 때만 `realtime`을 내려서, 멈춘 폴러가 연결됨으로 남지 않아요. |
| `unknown` 또는 필드 없음 | 박자를 말하지 않아요. 지금처럼이에요. |

- D4 생존 라벨이 먼저예요(`inactive`·`error`·`woken_not_collected`·`work_waiting`은 증보 3 E6대로 박자 문장 앞에 서요). 박자는 「에이전트가 온다」는 사실이지 「가져간다」는 약속이 아니에요. 오고도 가져가지 않는 에이전트(#4618의 grok 가설)는 마감이 지나면 「못 가져감」으로 서요.
- 이 증보는 코어 파서·문구를 바꾸지 않아요. 그건 #4619·#4620(UXUI)의 몫이에요.

### 바뀌지 않는 것

- D4 `derive_liveness`·임계값·`collected_since`, 증보 3의 스위프(30분 `woken_not_collected`, 24시간 `unclaimed_expired`, 2시간 `lease_abandoned`), ADR-0171 도어벨, 결재 3의 `oort_ping` 의미, 증보 4의 `agent_port.call` 기록.
- **박자는 상태 전이의 입력이 아니에요.** run을 끝내는 규칙에도, 다시 깨우는 규칙에도 들어가지 않아요. 보여 주는 사실이에요.

### 남는 주의

1. **도어벨로 깬 호출도 섞여요.** 스윕과 도어벨이 함께 있는 에이전트는 중앙값이 버텨요(시뮬레이션: 하루 120번이 섞여도 100%가 15분). 그러나 **도어벨로만 깨는 에이전트**는 대화 한복판의 간격(수 분~20분)이 서로 비슷해서 박자처럼 읽힐 수 있어요(합성 대화에서 61~91%). 이때 「보통 N분 안」은 실제 대기(도어벨 지연, 보통 1분 안팎)보다 길어서 약속을 어기는 쪽이 아니고, 대화가 멎고 3박이 지나면 `late`가 되어 소비자는 박자를 말하지 않고 지금처럼 돌아가요. 도어벨 깨움을 걸러내려면 발사 이력이 필요한데, 오늘 서버는 최근 run 몇 개의 원장(`doorbell_rung`)에만 남겨서 걸러내지 않아요(후속).
2. **24시간 도는 루틴을 전제해요.** 근무 시간에만 도는 루틴은 밤사이 `late`로 읽혀요(첫 호출이 오면 풀려요). 요일 패턴은 몰라요.
3. **약 6분보다 짧은 박자는 한 깨어남과 구분되지 않아요**(5분 침묵 규칙). 쉬지 않고 부르면 `realtime`, 그 밖에는 `unknown`이에요. 문서가 1분 폴링을 금하므로(`SELF_HOST_AGENT.md` §3.3.17.5) 의도한 한계예요. **90분보다 느린 박자**(두 시간 크론·일 단위)도 `unknown`이에요: 시뮬레이션에서 두 시간 크론은 상한 120분이면 47%만 읽히고 90분이면 0%인데, 상한을 늘릴수록 임의 깨어남 오판이 늘어요(상한 180분이면 하루 6번 임의 깨어남의 7%).
4. **비용.** liveness를 읽을 때마다(클라이언트당 에이전트별 60초) 에이전트당 최대 2,000행을 돌려주는 읽기 하나가 돌아요. 15분 박자는 24시간에 300~600행이에요. 이 읽기의 비용은 **돌려주는 행이 아니라 읽는 행**이 정해요: 플래너에 맡기면 에이전트의 창 안 행을 전부 읽어서(위 C1), 읽는 동안 `enable_bitmapscan = off`로 순서 인덱스 스캔을 강제하고 2초에 취소해요. 6,000행 에이전트에서 50행을 읽는 데 플래너에 맡기면 6,000튜플, 로더는 50튜플이에요(`agent_cadence_conformance_pg`가 앱 역할로, 통계를 플래너가 행 수를 적게 어림하는 쪽으로 기울여 같은 문장을 나란히 재요). 1단계의 측정(쉬지 않고 부르는 에이전트 2.2ms, 15분 박자 0.4ms, 관리자 목록 30개 6.5ms)은 슈퍼유저·리터럴 상수 조건이라 앱 조건의 계획이 아니었어요(검수 R1-01). 남은 비용은 필터에 걸러지는 같은 에이전트의 다른 행(`agent_port.call` 기록 등)을 더 읽는 것이에요(검수 측정: 호출 한 건당 같은 행위자의 전체 행이 평균 1.7, 상위 1% 3.5, 최대 7.5이니 돌려주는 행의 수 배예요). 순서 있는 대안 인덱스(`audit_ws_time_idx`)는 이 DB에서 계획 비용이 실제 선택의 수십 배라 고르지 않지만(재볼 때마다 통계에 따라 25~59배로 오르내려요), 행위자별 평균 추정이 워크스페이스 평균보다 작다는 가정에 기대요. 증보 4가 후속으로 적은 복합 인덱스가 이 탈출구도 닫아요. 운영 데이터 규모의 계획 선택과 지연은 재지 않았어요(`runtime-unverified`; 2초 한도가 최악을 `unknown`으로 막아요). 읽기 속도 제한·프로세스 캐시는 두지 않았어요(60초 폴링이 이미 있고, 한 번의 읽기가 한도로 묶여요). `audit_log`에 보존 정책이 생기면 창(24시간)보다 짧게 잡으면 안 돼요. 증보 4가 후속으로 적은 `(workspace_id, action, created_at)` 인덱스가 이 읽기에도 이득이에요.
5. 숫자는 코드 상수(`CadenceParams`)예요. 환경변수로 봉인하지 않았어요(결재 3): 운영자가 만질 값이 아니고, 오타가 모든 에이전트를 「늦음」으로 만들 수 있어요.
6. **아주 빠른 폴러는 `unknown`이에요.** 읽는 행이 에이전트당 최신 2,000행이라, 초당 1.1회보다 빠르게 부르는 에이전트는 그 2,000행이 30분을 못 덮어서 `realtime`의 최소 구간에 닿지 못해요. 틀린 말이 아니라 「모름」이고, 문서가 그런 폴링을 권하지 않으므로(`SELF_HOST_AGENT.md` §3.3.17.5) 받아들였어요.
7. **스케줄이 느려진 에이전트는 한동안 옛 박자로 읽혀요.** 박자는 24시간 전체 간격의 중앙값이라, 15분 루틴이 60분 루틴으로 바뀌면 새 간격이 옛 간격 수를 넘을 때까지(검수 시뮬레이션: 약 12시간은 `routine 15`, 16~20시간은 `unknown`, 약 22시간부터 `routine 60`) 「보통 15분 안」이 나가고, 새 박자로 정시에 온 에이전트가 `late`로 읽힐 수도 있어요. 빨라지는 방향은 보수적으로 틀려요. 마감(2배)을 넘기면 소비자는 「못 가져감」으로 서서 거짓 약속이 오래 가지는 않아요. 「최근 간격 3개 중 2개가 띠 안」 같은 최근성 규칙은 숫자를 건드리는 변경이라 시뮬레이션과 함께 후속으로 해요(#4685).
8. **일하는 중에 마감이 지나갈 수 있어요.** `late`는 마지막 **호출**에서, 마감은 최신 깨어남 **시작**에서 재요(위). 50분짜리 일을 하며 2분마다 부르는 에이전트는 시작 + 2박(30분)에 마감이 지나지만 계속 부르는 동안 `late`는 아니에요. 소비자는 마감이 지나면 「못 가져감」 줄을 세우는데, 그 말 자체(그 시각까지 가져가지 않았다)는 사실이고 D4 `work_waiting`(20분)도 같은 때 서요. 진행 중인 깨어남의 마감을 「마지막 호출 + 1박」까지 미루는 안은 후속(#4685)이에요.
9. **일시정지(paused) 에이전트와 D4 우선.** 일시정지는 연결을 `active`로 두고 호출은 계속 받아들여져서(`used` 행이 쌓여요) 박자는 `routine`으로 남아요. 에이전트가 도구를 부르면 모두 거절되어 D4가 `error`가 되고 C6의 「D4 라벨이 먼저」가 덮어요. 그러나 도구를 시도하지 않는 일시정지 에이전트는 `error`도 안 되고 박자만 `routine`으로 남아요(서버가 `paused`를 `cadence_for`에 넣는 안은 후속 #4685). `cadence`만 읽는 소비자는 이 규칙을 지켜야 해요(#4619·#4620의 시험이 일시정지 에이전트를 세워 고정하도록 이 PR에서 알려요).
10. **박자 읽기가 느릴 때.** 표가 잠기는 것 같은 드문 사고에서는 liveness 요청마다 풀 연결을 읽기 한도(2초)만큼 붙잡고 경고 로그 한 줄이 남아요(검수 R2-05). 한도는 문장 하나에 걸리므로 관리자 목록은 에이전트 전체에 한 번이에요(캐시 안에서는 에이전트당 약 1ms라 수천 개까지 괜찮고, 캐시 밖이면 수백 개에서 박자가 통째로 `unknown`이 될 수 있어요). 그 상황에서는 `audit_log`에 쓰는 Agent Port 호출도 멈추므로 2차 효과예요. 잠금 대기 한도(`lock_timeout`)와 경고 빈도 제한은 후속 후보예요.

### 왜 owner 결정이 필요 없는가

planner 위임으로 수락하는 근거는 넷이에요(증보 2·4와 같은 형식이에요).

1. **새 저장소·열·권한·마이그레이션이 없어요.** 읽는 것은 이미 쌓이는 감사 행이고 쓰는 곳이 없어요. 스키마·RLS·역할·GRANT는 그대로예요.
2. **새로 보이는 것이 이미 열린 정보와 같은 등급이에요.** 같은 사람들이 이미 `lastSignalAtMs`로 마지막 신호 시각을 봐요. 평소 간격·마감·늦음은 그 시각들의 요약이고 내용(본문·인자·도구 이름·id)이 없어요. 시각 목록·호출 수는 응답에 없고, 이슈 본문이 「에이전트 박자는 내용이 아니에요」를 owner 승인 범위(10-26 「ㄱㄱ」)로 적었어요. 대상도 새로 열리지 않아요(C5).
3. **밖으로 나가는 것이 없어요.** 웹훅·푸시·외부 호출이 없고, 읽기마다 `audit_log`를 읽는 문장 하나가 늘어요. 그 문장은 순서 인덱스 스캔으로 묶이고(읽는 행이 한도 근처) 2초에 취소되며, 실패해도 라우트는 답해요(C1, 한계 4).
4. **되돌리기가 쉬워요.** 필드 둘(`AgentLiveness.cadence`·`HostedAgentLiveness.cadence`)과 라우트의 호출 두 곳을 지우면 끝이고 데이터 정리가 없어요. 소비자는 필드가 없으면 박자를 말하지 않으니 지금처럼 동작해요.

숫자 넷은 planner가 받았어요(결재 1·2): 마감 2배, 규칙성 게이트 70%와 박자 상한 90분(이슈에 없던 추가: 빼면 하루 몇 번 임의로 깨는 에이전트의 9~47%가 「보통 N시간 안」으로 읽혀요), 최소 표본 4. 다르게 정하려면 `CadenceParams` 상수 한 줄씩이에요.

### 불변식 대조

- REST send → seq 증가 + message INSERT + outbox INSERT 단일 tx: 건드리지 않아요. 이 증보는 관측을 읽기만 해요.
- 모든 테넌트 경로 `workspace_id` + RLS FORCE + tx마다 `SET LOCAL app.workspace_id`: 기존 `agent_tenant_tx`(`momo_app`)로 읽고, SQL에 `workspace_id`를 명시해요. BYPASSRLS 없음이에요.
- 클라이언트 직접 publish 없음. `schema_v0.sql`·마이그레이션 변경 없음. sqlx 런타임 쿼리예요.
- 공개 API 변경(응답 필드 추가) → 이 증보의 Accepted가 머지 조건이에요(ADR-0100).

### 구현 슬라이스

- **#4621 (engine) 1단계.** `momo-agent/src/hosted_cadence.rs`(순수 `derive_cadence`, `load_agent_call_times_in_tx`), `dto.rs` `AgentCadenceDto`, `routes/hosted_agent_connections.rs`(멤버 liveness·관리자 연결 목록), openapi `AgentCadence`.
- 시험(`bins/momo-server/tests/`는 서버 크레이트 기준):
  - `hosted_cadence.rs` 단위 24건: 중앙값≠평균·묶음·최소 표본·규칙성 경계 70%·박자 상한 90분·실측 모양 36개 표본·늦음 경계·마감 배수·realtime·창, 2단계 보강의 「멈춘 폴러는 5분 침묵(정확히 5분은 아직 지금) 뒤 `unknown`」, 검수가 지적한 고정되지 않은 숫자(규칙성 띠 ±50%와 양쪽 가장자리·realtime 30분 구간과 80% 존재율의 가장자리·정확히 5:00 간격의 존재·24시간 창의 가장자리), 그리고 마감을 말할 수 없으면 `routine`이 아니라 `unknown`이라는 시험(크로노의 마지막 순간 근처).
  - `routes/hosted_agent_connections.rs` 셋: 읽는 쪽과 쓰는 쪽의 action·경로 상수가 같다, 응답이 닫힌 어휘다, 비활성 연결에는 박자를 약속하지 않는다(`cadence_for` 가드).
  - `agent_cadence_contract.rs` 4건(DB 없음): 스펙의 `AgentCadence`·두 liveness 스키마와 DTO의 키가 양방향으로 같고, `kind` 목록이 서버의 어휘와 같다.
  - `agent_cadence_conformance_pg.rs` 15건(아래 다섯이 수리분): 멤버·관리자 둘 다 `routine(15)`, 간격 3개 `unknown`·4개 `routine`, 늦음, realtime, 두 시간 전에 멈춘 폴러 `unknown`, 주기 없음, 로더의 술어마다 한 건씩(같은 id 두 번 포함), **실제 호출이 남긴 행을 읽음**, 비활성 연결 `unknown`, 멤버 응답에 허용된 키 밖의 것이 없음과 404. 수리분 다섯: 해제 뒤 새 연결은 옛 연결의 박자를 물려받지 않음(era) · 6,000행 에이전트에서 50행을 읽는 데 50튜플(순서 스캔 강제, 같은 문장을 플래너에 맡기는 대조는 6,000튜플) · 표를 다른 세션이 잠그면 박자만 `unknown`이고 라우트는 200이며 풀리면 다시 `routine` · 한도는 에이전트별 · 연결이 한 시간 된 에이전트의 옛 6,000행 앞에서 era 안 10행을 읽는 데 100튜플 이하(era 하한이 인덱스 조건). 비활성 시험은 활성 에이전트가 era 안의 루틴을 가진 채 `cleanup_pending`·`disconnected`로 가는 모양이라 이유가 era가 아니라 연결이에요(`cadence_for`의 가드 자체는 라우트 모듈의 단위 시험이 따로 잠가요).
  - 픽스처 행은 실제 호출 한 번의 `detail`을 본떠서 쓰는 쪽이 모양을 바꾸면 같이 빨개져요. 술어를 잡는 로더 시험은 superuser 연결로 로더를 직접 불러요(RLS가 가려 주는 술어와 순수 함수가 대신 거르는 창을 따로 잡으려고요). **읽는 일의 양을 재는 두 시험은 앱 역할(`momo_app`, 테넌트 지정)로 재요.** 플래너는 RLS 아래서 다른 계획을 고르기 때문이에요. 사보타주 표는 PR 본문에 있어요(1단계 41건 + 2단계 보강·수리 18건).
- **#4621 (engine) 2단계.** workspace 게이트·OpenAPI 계약 게이트(`verify_openapi_contract_rust.sh`가 이 GET을 샘플해요)·독립 보안 검수(노출 범위·열세 번째 `audit_log` 읽기)·PR. 검증 증거의 정본은 PR 본문이에요.
- 범위 밖(후속): 코어 파서의 `cadence` 읽기와 문구(#4619·#4620), 도어벨 깨움 분리(#4652), 박자 최근성·마감 기준점·일시정지(#4685), `audit_log` 인덱스·보존 정책.


## 증보 7 (2026-11-01, #4655) — 에이전트 활동 보고 `activities[]`·`plan[]`: 종류+짧은 라벨, 생각은 저장하지 않음, 보고 박자 60초

- Status: **Accepted**(2026-11-01 planner — owner 2026-10-27 「권장대로 해봐」(#4655 코멘트)로 Q1 종류+≤40자 라벨 보고 허용 · Q2 생각 저장 안 함 · Q3 보고 박자 60초를 결재. 이 절이 새로 연 7-Q1~Q4는 추천 (가)를 오케스트레이터 기본값으로 정했고 owner가 뒤집을 수 있어요). 공개 도구 표면(`oort_run_event` 필드 추가)·DB 계약(원장 종류 둘·열·합계 표)·노출(채널 멤버에게 보이는 에이전트 글 열 둘)이 바뀌므로 ADR-0100에 따라 Accepted가 #4656(구현) 머지 조건이에요.
- 결재 기록: owner 2026-10-27 「권장대로 해봐」(#4655 코멘트의 결정 원문). 7-Q1 (가) 오래된 활동부터 굴리기 · 7-Q2 (가) `stage` 서버 상한 80 유지 · 7-Q3 (가) `toolCounts`에 `delegate`를 더하지 않음 · 7-Q4 (가) `stage`와 같은 방어 — planner 2026-11-01.
- 기안: Sonnet 5.5 worker (#4655, 스택 S6). 설계이고 코드를 바꾸지 않았어요. migration 번호를 쓰지 않았어요(#4656이 착수 때 `origin/track/engine`과 열린 PR의 최고 번호를 보고 정해요).
- 근거: 이슈 #4655(이 증보)·#4656(구현)·#4580(계획 이벤트 절반을 이 증보가 맡아요)·#4622(증보 5, 지시문 합본)·#4968(ADR-0201 v3 S5, 도우미 진행). 업계 사례는 공개 규격의 요지만 옮겼고 원문·실명은 쓰지 않았어요.
- 표기: [V] 코드·문서 직접 확인(작업 폴더 `a0af35488` = track/engine 위. 읽기만 했고 실행하지 않았어요) · **[추정]** 이 증보가 정한 숫자·해석 · [확인 필요] 구현 전 확인 · `runtime-unverified` 실행 안 함.
- **구현이 인용할 절 id**: 사실 `7-0`(F1~F13) · 결정 `7-1`~`7-10` · 불변식 `7-11` · 수용 기준 `7-A1`~`7-A16` · 슬라이스 `7-S1`~`7-S4` · 열린 질문 `7-Q1`~`7-Q4` · 역방향 줄·열어 두는 것·귀결 `7-R`.

### 배경

- 문제: 에이전트가 실제로 무슨 도구로 무엇을 하는지, 잘 하고 있는지가 oort에서 전혀 추적되지 않는다는 owner의 지적(2026-10-27, #4655)이에요. 서버가 스스로 보는 것은 oort 도구 호출뿐이고(T1 `tool_call`, 증보 4 `agent_port.call`), VM 안의 셸·편집·검색은 에이전트가 말해야만 알아요. 지금 에이전트가 말할 통로는 한 줄 `stage`와 끝의 `toolCounts`(개수)뿐이라 「무슨 도구로 무엇을」이 비어요.
- 표준 통로가 없어요. MCP 진행 알림은 서버가 클라이언트의 요청에 진행을 알리는 방향이라 서버인 oort가 에이전트의 진행을 받을 수 없어요. ACP의 `session/update`는 하네스(`momo-workd`)가 소비하지만 원격 호스팅 run에는 없어요. 그래서 통로는 도구 호출 하나, 곧 이미 있는 `oort_run_event`의 스키마 확장이에요. 새 도구·새 scope·MCP Tasks 연동은 이 증보도 만들지 않아요(D6 유지).
- 모양은 ACP를 따라요: 도구 호출 한 건이 한 행으로 제자리에서 상태가 바뀌고, 계획은 통째로 교체돼요. 닫힌 종류와 짧은 라벨만 받고 명령·경로·제목·생각은 받지 않아요. 외부 규격 본문은 이번에 새로 조회하지 않았고 우리 코드(`momo-workd` 투영)가 닫아 둔 어휘를 근거로 삼았어요(`runtime-unverified`).

### 7-0. 확인한 사실 [V]

| id | 사실 | 근거 |
|---|---|---|
| F1 | `oort_run_event` 입력은 `leaseHandle`(필수), `status`(running·thinking·streaming·cancelled, 생략하면 running), `detail`(2,048바이트, 감사 전용), `textDelta`(8,192바이트, 릴레이만), `eventId`(UUID), `stage`(최대 320바이트)이고 `additionalProperties:false`라 모르는 키는 거절돼요 | `momo-mcp/src/tools.rs` `run_event_schema`, `agent_gateway.rs` `normalized_event_status` |
| F2 | `stage`는 서버가 1~80 **글자**(앞뒤 공백 제거), 제어·보이지 않는 글자·방향 글자(`is_unsafe_char`), `/`·`\` 금지로 검증해요. SQL 백스톱은 같은 규칙의 부분집합(`agent_run_event_stage_ck`). 지시문 규약은 「40자 안팎」이고 화면이 40자에서 줄여요. 맞지 않으면 호출 **전체**를 거절하고(`InvalidArguments`), lease가 살아 있을 때만 감사 행(`agent.run.report_rejected`, 코드 `stage_invalid`, 글 없음)을 남겨요 | `momo-t3` `validated_stage_markers`·`bounded_text`, 마이그레이션 114·128, `agent_port_tools.rs` run_event |
| F3 | 원장 `agent_run_event`는 kind 14개(128·132·133)이고 추가 전용으로 쓰여요(코드가 UPDATE하지 않아요). DELETE는 trim 함수에만 있어요. run당 200행 상한은 `agent_run_event_trim`이 가장 오래된 `stage`부터(그다음 `claimed`) 지우고, `tool_call`은 세지도 지우지도 않아요(T3). `seq`는 전역 시퀀스라 클라이언트에 내보내지 않아요 | 128·133, `run_event.rs` |
| F4 | D2: 「자유 텍스트를 새로 저장하지 않는다. `stage`(≤80자, 기존 검증)와 닫힌 `code`뿐이다」. `stage`는 `output.stages`(12개)에도 쓰이고 그때마다 `step_count`를 올려요(`LEAST(step_count+1, max_steps)`) | D2, `agent_gateway.rs` `record_stage_in_tx` |
| F5 | `GET …/agent-runs/{run}/events?include=`는 닫힌 쉼표 집합 `{doorbell, tools}`이고 그 밖은 400이에요. 원장을 통째로(커서·원시 seq 없음) 오래된 순으로 읽고 상한은 200(`tools`면 +100)이에요. 응답은 `events[{ordinal, kind, stage, code, approvalId, actorMemberId, tool, durationMs, createdAtMs}]`와 `tools`일 때 `toolTally`·`toolCallRowsCapped`예요. `ordinal`은 그 읽기 안의 순번이에요 | `agent_runs.rs` `parse_run_event_include`, `run_progress.rs` `list_run_ledger_in_tx` |
| F6 | TS 파서는 모르는 kind를 `unknown` 한 줄로 받고(#3824) 응답의 모르는 최상위 키·행 키를 무시해요. 그 전에 배포된 클라이언트는 모르는 kind가 있으면 원장 전체를 거부해요. `fetchAgentRunEvents`는 `include=doorbell`만 보내고 400이면 쿼리 없이 한 번 더 읽어요. 이 트리에는 `include=tools`를 읽는 코드가 없어요 | `packages/momo-core/src/lib/api.ts`, openapi `AgentRunEvent.kind` 설명 |
| F7 | 원장 INSERT마다 얇은 프레임 `agent.run.event {run_id, channel_id, kind}`(글·순번 없음)이 같은 tx의 outbox로 채널 토픽에 나가요. `stage` 행은 직전에 **프레임이 나간** `stage` 행에서 2초 안이면 프레임을 내지 않아요(`framed=false`, BEFORE INSERT 트리거). `tool_call`은 늘 `framed=false`예요. 클라이언트는 프레임을 받으면 원장을 통째로 다시 읽어요 | 130·133 |
| F8 | 쓰는 길: Agent Port `oort_run_event` → `record_gateway_event_in_tx`(run 행을 `FOR UPDATE`로 잠근 안). 같은 `eventId` 재전송은 `run_event_recorded`로 일찍 끝나고 승인 대기·종결 run은 409예요. 원장에 `stage`를 쓰는 것은 `hosted_lease`일 때뿐이에요. running·thinking·streaming 호출(status 기본값이 running이라 사실상 모든 호출)이 `mark_run_started_in_tx`로 `agent_run.updated_at`을 올리고(스톨 스위프 입력) 감사 행 `agent.gateway.status`를 남겨요(`detail`·`event_id`·`text_delta_bytes`, 단계 글은 없음) | `agent_gateway.rs`, `run.rs` `mark_run_started_in_tx`, `momo-outbox` `stalled.rs` |
| F9 | run 읽기의 `last_event_at`(「마지막 보고」)은 `doorbell_rung`을 뺀 모든 원장 행의 최대 시각이에요. 행을 안 쓰는 호출(`status:"running"`만, 접힌 `stage`)은 올리지 않아요(`updated_at`·liveness는 올라요) | `run_progress.rs` `progress_select_sql` |
| F10 | 하네스 투영(`momo-workd`)은 ACP `tool_call`의 **kind만**(제목 제외)과 `plan`(≤50항목×500자, 상태 pending·in_progress·completed)을 세션 이벤트로 싣고, 생각 조각은 이벤트 예산(분당 240) 때문에 일부러 버려요. ACP `ToolKind`는 read·edit·delete·move·search·execute·think·fetch·switch_mode·other 열 개예요 | `bins/momo-workd/src/projection.rs` |
| F11 | 끝 보고 `artifacts.toolCounts`는 `run·edit·read·search·web·other` 여섯 키(각 0~100,000, 「에이전트 보고」)예요. 형식이 틀린 `artifacts`는 완료 전체를 거절하고 `error.data{field, rule}`로 어느 칸인지 알려 줘요(C3). 같은 방식의 상세가 `oort_expression_assemble`에도 있어요(ADR-0218 G3.8, 닫힌 인자 이름). 그 밖의 도구와 `oort_run_event`의 거절은 상세 없는 평범한 `invalid tool arguments`이고 시험이 그렇게 못 박아요 | ADR-0162 증보 5 C2·C3, `tools.rs` `ArtifactViolation`·`InvalidAssembleParams`·`only_artifacts_faults_carry_detail` |
| F12 | 도우미(ADR-0201 v3) B5-7은 작업 모드 진행을 워커가 원장에 직접 쓰고 #4655·#4656이 들어오면 같은 어휘(종류 7개·`plan` ≤12·글 ≤60자)를 쓴다고 정했어요. B5-2는 서버 내부 표 `team_ai_task`에 계획(≤8항목)을 따로 둬요. 도우미의 읽기 도구 `get_agent_run`은 `RunEventInclude::default()`로 원장을 읽어 단계 이름만 모델 문맥에 넣어요. 원장의 수명주기 행(트리거)과 진행 목록 읽기는 호스팅 에이전트 run만 다루지만 `…/events` 읽기는 호스팅 여부를 보지 않아요 | ADR-0201 v3 B5-2·B5-7·B12·F12, `team_ai_tools.rs`, 128 `agent_run_event_is_hosted`, `run_progress.rs` |
| F13 | 지시문 현행: `oort_run_event` 설명 「at least every five minutes」, 루틴 §3.3.17.4 c) 「시작 보고는 깬 뒤 10초 안(하드 한도 60초)·단계마다·최소 5분마다」, D5 1번 「60초 안」·3번 「최소 5분마다」. `HOSTED_ROUTINE_TEMPLATE`에는 박자 문장이 없고, `AGENT_CONVERSATION_PREAMBLE` 규칙 7은 「`oort_run_event` stage를 보낼 수 있으면 그렇게」예요 | `tools.rs`, `SELF_HOST_AGENT.ko.md`, `presets.ts`, `mention.rs` |

**F5 증보 (2026-11-01, #5007) — 이벤트 장부의 승인 관련 필드.** F5의 응답 행 중 승인에 속한 필드 셋, `approvalId`·`actorMemberId`·`code`(`approval_requested`는 요청한 에이전트, `approval_decided`는 결정한 사람과 결과)는 ADR-0186 R-f가 `AgentRunProgress.approvalId`·`bundle`에 적용한 규칙과 같은 규칙을 따라요: **승인이 올라온 방의 활성 멤버에게만** 나가요(그 방은 run의 방과 달라도 돼요). 규칙 밖 사람에게는 승인 id가 있는 행에서 이 셋이 **함께** 빠지고, 행 자체(`ordinal`·`kind`·`createdAtMs`)·순서·행 수는 그대로예요. 승인 id가 없는 행(예: 종결 행의 `code`)은 건드리지 않고, 승인의 방을 알 수 없는 id(승인 행이 없거나 다른 워크스페이스 것)는 아무에게도 안 나가요. 판정은 `approval_is_named_to_viewer` 한 함수와 `visible_channels_in_tx` 한 조회예요(run 진행·`bundle`·장부가 같이 써요). 새 열·새 권한·migration이 없고 새 ADR 번호는 만들지 않아요.

### 7-1. 어휘 — 종류 일곱, 상태 넷, ACP 표

- **종류(`kind`) 일곱**: `run`(명령 실행) · `edit`(파일·자료 바꾸기) · `read`(읽기) · `search`(검색) · `web`(웹 요청) · `other`(그 밖) · `delegate`(다른 에이전트·하위 봇에게 맡기기). 앞의 여섯은 `toolCounts` 범주와 낱말·뜻이 같고(F11) `delegate` 하나가 더해졌어요. 표시 낱말은 클라이언트 i18n 사전의 몫이고 서버는 닫힌 토큰만 다뤄요.
- **상태(`status`)**: ACP 철자를 그대로 써요. 활동은 `in_progress` · `completed` · `failed`, 계획 항목은 `pending` · `in_progress` · `completed`예요. 같은 낱말이 두 칸에서 같은 뜻이라 에이전트가 어휘를 둘 외울 필요가 없고, 계획은 하네스 경로(F10)와 같은 철자라 화면이 계획 블록 하나로 그릴 수 있어요. 「시작 전」인 활동은 없어요(에이전트는 하기 전의 일을 알리지 않아요).
- 끝 보고 `artifacts.toolCounts`는 **바꾸지 않아요**(여섯 키, 7-Q3). 끝의 자기 보고 합계와 진행 중 활동 합계는 서로 다른 자기 보고라 맞춰 보지 않고(안 맞아도 오류가 아니에요) 읽는 쪽이 한 줄에 섞지 않아요. `delegate` 합계는 활동 합계에만 있어요.

| ACP `ToolKind`(F10의 열 가지) | oort `kind` | 비고 |
|---|---|---|
| `read` | `read` | |
| `edit` | `edit` | |
| `delete` · `move` | `edit` | 파일을 지우거나 옮기는 것도 바꾸는 일이에요 |
| `search` | `search` | |
| `execute` | `run` | |
| `fetch` | `web` | |
| `think` · `switch_mode` | `other` | 생각은 저장하지 않아요(7-4). 도구 호출의 제목을 라벨로 옮기지 않아요 |
| `other` | `other` | |
| (원천 없음) | `delegate` | ACP에는 위임 종류가 없어요. 에이전트가 하위 봇·자식 run에 맡길 때 스스로 보고해요(D5 4번 「위임:」 stage의 활동판) |

ACP 상태는 `pending` → 보내지 않아요 · `in_progress` → `in_progress` · `completed` → `completed` · `failed` → `failed`예요. ACP 계획 항목 `{content, priority, status}`는 `{text, status}`로 옮기고 `priority`는 버려요.

- 이 표가 쓰이는 곳은 둘이에요. (a) ACP를 쓰는 어댑터(Hermes X1, 관리형 워커 E4)가 같은 어휘로 접을 때. (b) UXUI가 하네스 세션 경로(`tool_call_name`에 열 가지)와 원장(일곱)을 한 아이콘 표로 그릴 때. 하네스 세션 경로 자체는 이 증보가 바꾸지 않아요.
- **서버는 줄이거나 고쳐 주지 않아요.** 어댑터가 라벨(40자)과 계획 글(60자)을 서버 규칙에 맞추고(제목을 옮기지 않고 종류만 보내도 돼요), 맞출 수 없으면 그 항목을 보내지 않아요. 서버가 조용히 자르면 거절 대신 조용한 변조가 되기 때문이에요.

### 7-2. 보고 모양 — `oort_run_event`에 선택 필드 둘

```
oort_run_event {
  leaseHandle, status?, detail?, textDelta?, eventId?, stage?,       // 지금 그대로
  activities?: [ ≤8 ]  { id, kind, label?, status, n? },             // 새 칸
  plan?:       [ ≤12 ] { text, status }                              // 새 칸
}
```

| 칸 | 규칙 | 숫자 |
|---|---|---|
| `activities[].id` | 필수. 이 run 안에서 한 활동을 가리키는 뜻 없는 번호 이름(`a1`·`r2`). 글자는 `A-Z a-z 0-9 _ -`만. 읽는 사람에게 그대로 보여요(7-3) | 1~32자 [추정] |
| `activities[].kind` | 필수. 7-1의 일곱 | 닫힘 |
| `activities[].label` | 선택. 하는 일의 이름(7-3). 없으면 화면이 종류 낱말을 써요 | 1~40자 (Q1) |
| `activities[].status` | 필수. `in_progress` · `completed` · `failed` | 닫힘 |
| `activities[].n` | 선택. 그 항목이 묶은 일의 수(「읽기 12」). 생략하면 1 | 1~100,000 (`toolCounts`와 같은 천장 `MAX_REPORTED_COUNT`) |
| `plan[].text` | 필수. 계획 한 단계의 이름 | 1~60자 |
| `plan[].status` | 필수. `pending` · `in_progress` · `completed` | 닫힘 |
| 개수 | 호출당 `activities` ≤8, `plan` ≤12 | [추정] |

- `activities`는 **변화분**이고 항목은 그 id의 **전체 상태**예요: 적은 id의 상태만 쓰고 적지 않은 id는 그대로예요. 칸을 빼면 빠진 값으로 써요(`n` 생략은 1, `label` 생략은 라벨 없음). 한 호출 안에서 같은 id가 두 번이면 뒤의 것이 이겨요. `plan`은 **통째 교체**예요: 있으면(`[]`은 비움) 그 계획으로 바뀌고 없으면 그대로예요.
- 한 호출에 `stage`·`status`·`activities`·`plan`을 같이 보낼 수 있고(권장: 단계 경계마다 한 번에, 7-5) 한 트랜잭션이라 전부 쓰이거나 전부 거절돼요. `activities`·`plan`만 든 호출도 `status` 기본값이 `running`이라 지금 규칙대로 `agent_run.updated_at`을 올려요(F8).
- **능력 감지.** 옛 서버는 모르는 키를 거절해요(F1). 에이전트는 `tools/list`의 `oort_run_event` 스키마에 `activities`가 보일 때만 두 칸을 보내요(결과 칸 `resultKind`와 같은 규칙, SELF_HOST_AGENT §3.3.17.4 d).
- **거절.** 호출 전체를 거절해요(-32602, 쓰기 0, lease 유지). 형식은 트랜잭션 밖에서 두 겹으로 판정해요: 스키마 겹(`validate_arguments`: 형·enum·필수·개수·바이트 길이·모르는 키)과 문자 겹(핸들러: 글자 수·금지 글자, 7-3). JSON-RPC `error.data`에 C3 모양의 닫힌 설명 `{field, rule, index?}`를 실어요: `field`는 `activities` · `activities.id` · `activities.kind` · `activities.label` · `activities.status` · `activities.n` · `plan` · `plan.text` · `plan.status` 중 하나, `rule`은 `enum` · `required` · `forbidden` · `range` · `format`, `index`는 몇 번째 항목인지(0부터, 위치라서 새 정보가 아니에요). 보낸 값은 되돌려 싣지 않고 로그·감사에도 없어요. lease가 살아 있을 때만 거절 감사 행(`agent.run.report_rejected`)에 닫힌 `reason`(`activities_invalid` · `plan_invalid`)·`field`·`rule`·몇 번째 거절인지를 남겨요(`stage_invalid`와 같은 경로). 이를 위해 `ToolFailure` 변종 하나를 더해요(`InvalidArtifacts`·`InvalidAssembleParams`와 같은 방식. `field`는 위 닫힌 목록에서만 고르고 호출자 글은 타입으로 막혀요). 「상세는 닫힌 목록의 위반에만」을 못 박는 시험 `only_artifacts_faults_carry_detail`(F11)은 지금 `oort_run_event`의 거절에 상세가 없음도 단정하므로, 이 증보가 새 칸에 한해서만 의도적으로 바꿔요(최상위의 모르는 키·`leaseHandle` 위반은 계속 평범한 거절, 7-S1).
- **재시도 규칙(도구 설명과 루틴에 적어요).** ① 같은 `leaseHandle`로 지적된 칸만 고쳐 다시 보내요(거절된 호출은 기록되지 않으니 같은 `eventId`를 써도 돼요). ② 고쳐 보내기는 최대 2번. ③ 그래도 거절되면 `activities`·`plan` 없이 `stage`·`status`만 보내요. **생존·진행 보고가 새 칸에 매이지 않아요.**
- **쓰는 곳.** 호스팅 lease의 Agent Port 호출뿐이에요(F8). REST gateway 콜백은 늘리지 않아요(#4647). 도우미 워커 같은 서버 안 기록자는 도구를 거치지 않고 같은 함수를 불러요(7-6, 7-10).
- **종결된 run은 쓰지 않아요.** 종결 run이 받는 유일한 이벤트인 `cancelled` 확인 호출에 든 `activities`·`plan`은 형식이 맞으면 `stage`와 같이 버려요(쓰기 0, 거절 아님. 승인 대기·그 밖의 종결 run은 지금처럼 409).
- **쓰지 않는 곳.** `output.stages`·`step_count`(`record_stage_in_tx`를 타지 않아요. 60초 박자에 `max_steps`가 먼저 차지 않게요), 감사 `detail`(감사 행 `agent.gateway.status`에는 활동·계획 **글 없이 개수만**), 알림·푸시.

### 7-3. 글 규칙 — D2 「자유 텍스트를 새로 저장하지 않는다」 문장을 이 범위에서 바꾼다

- **바뀌는 문장.** D2의 「자유 텍스트를 새로 저장하지 않는다. `stage`(≤80자, 기존 검증)와 닫힌 `code`뿐이다」는 이 범위에서 이렇게 읽어요: **에이전트가 쓴 일반 텍스트 열은 `stage`(≤80자) · 활동 `label`(≤40자) · 계획 `text`(≤60자) 셋이고, 셋 모두 같은 문자 규칙을 지난다.** 여기에 **식별자 `activity_id`**가 하나 더 있어요. 행을 제자리에서 갱신하고 접는 안정 키라 있어야 하고, 가장 좁은 닫힌 글자(`A-Za-z0-9_-`, ≤32자)만 받지만 채널 멤버에게 **그대로 보여요**. 그 안에 파일 이름·토큰 조각이 들어갈 수 있으므로 「글 열 셋 + 식별자 하나」로 세고, 같은 한계와 방어(아래)를 적용해요. `detail`은 여전히 감사 전용이고 `textDelta`는 저장하지 않아요.
- **문자 규칙은 한 함수예요.** 앞뒤 공백을 지우고 글자 수로 1~상한, 제어 글자·보이지 않는 글자·방향 글자(`is_unsafe_char`) 금지, `/`·`\` 금지예요. 지금 `validated_stage_markers`는 상한 80이 상수라서 **길이를 인자로 받는 한 함수로 일반화**해 `stage`·`label`·`text`가 같은 코드를 지나게 해요(복사 금지, D2의 「검증 함수 재사용」과 같은 원칙). SQL 백스톱 CHECK도 `work_session_share_stage_markers_ok`의 문자 식을 길이 인자만 달리한 함수로 써요(Rust 규칙이 SQL 규칙의 상위집합이라 CHECK가 먼저 걸리지 않아요, 128과 같음). 도구 스키마의 `maxLength`는 바이트 단위라 글자 상한의 4배 봉투예요(label 160, text 240, id 32). `pattern`을 이 검증기가 집행하지 않으므로(`tools.rs` 주석) `id`의 글자 제한은 어댑터가 집행해요.
- **정직한 한계.** 서버는 글자 종류와 길이만 보고 뜻은 못 봐요. 슬래시 없는 명령(`npm test`)·파일 이름·커밋 제목·비밀 토큰은 이 규칙으로 못 막아요(`id`는 글자가 더 좁을 뿐 `sk-abc123` 같은 조각은 실을 수 있어요). 방어는 겹겹이에요: ① 짧은 상한(40·60·32) ② 닫힌 종류 ③ 도구 설명·루틴의 금지(명령·경로·파일 이름·커밋 제목·요청 문구·비밀·추론을 쓰지 않는다. `id`는 뜻 없는 번호 이름) ④ 읽는 쪽이 「에이전트 보고」(믿지 않는 일반 텍스트)로 표시하고 이스케이프 ⑤ 청중이 `stage`와 같음(7-8) ⑥ 감사·푸시·기억·검색에 안 들어감(7-8). 하네스의 자격증명 마스킹(`redact_credentials`)을 서버 검증에 더할지는 이번에 넣지 않아요. 「stage와 같은 방어」가 결정이고 공유 crate로 옮기는 일이 따로 필요하며, 검증 함수가 한 곳이라 나중에 `stage`와 함께 조일 수 있어요(7-Q4). [확인 필요: 7-S2의 독립 보안 검수가 이 갈래를 정한다(`id` 포함)]
- **`stage`의 서버 상한은 80으로 유지해요.** ADR-0186 증보 R-f와 `docs/design-system/agent-request-loop.md` §3.2가 「40으로 줄일지는 #4655가 `activities[].label ≤40`과 한 번에 정한다」고 미뤘고 여기서 닫아요(7-Q2). 줄이지 않는 이유: 배포된 루틴이 「40자 안팎」이라 41~80자 `stage`가 이미 나가고, 줄이면 그 호출이 거절돼 생존 신호까지 잃어요. 지시문 규약(40자)과 화면의 40자 줄임은 그대로예요. 새 칸(`label` 40·`text` 60)은 호환 부담이 없어 처음부터 좁게 시작해요.
- **`label`은 선택이에요.** 어댑터(ACP를 접는 Hermes·관리형 워커)가 제목을 옮기지 않고 종류만 보낼 수 있게요(하네스의 「종류만」 선과 같아요). 라벨이 없으면 화면이 종류 낱말을 써요.

### 7-4. 생각 — 저장하지 않아요 (Q2)

- 어휘에 `think`가 없고 `thinking`은 run `status`일 뿐 글이 아니에요. ACP `agent_thought_chunk`는 어떤 어댑터도 옮기지 않고(하네스 투영이 이미 일부러 버려요, F10), ACP `think` 도구 호출은 `other`로 접되 제목을 라벨로 옮기지 않아요.
- 에이전트가 줄 수 있는 현실적인 「생각」은 단계마다 한 줄 진행 메모, 곧 `stage`예요. `label`은 하는 **일의 이름**이지 생각이 아니에요. 서버가 둘을 가를 수 없으니 도구 설명과 루틴이 말해요(7-3의 한계).
- `textDelta`는 그대로 릴레이 전용이에요. 스트림이 있을 때만 접힌 「생각 중」 행을 두는 것은 화면 몫이에요(`agent-request-loop.md` §3). 새 결정이 아니에요: D5 한계 문장과 ADR-0186 증보 R-a 2가 이미 같은 말을 해요.

### 7-5. 보고 박자 — 시작 10초 · 단계 바뀔 때 · 진행 중 60초 (Q3)

| 때 | 무엇을 | 지금(F13) | 이 증보 |
|---|---|---|---|
| 깬 뒤 | 시작 보고(`oort_job_start`의 stage) | 10초 안 권장, 60초 한도 | 같아요(말만 통일해요. 한도를 넘으면 화면은 「시작 보고 없음」 사실만 말해요) |
| 단계·활동이 바뀔 때 | `stage`(+`activities`·`plan`) 한 호출 | 단계마다 | **즉시**, 한 호출에 묶어요 |
| 일하는 동안 | 바뀐 것이 있으면 위 호출, 없으면 `status:"running"`만 | 최소 5분마다 | **최소 60초마다** |
| 긴 명령이 도는 동안 | 보낼 수 없어요 | — | 서버는 「마지막 보고 n분 전」 사실만 말하고 추측하지 않아요 |

- 박자는 **규약이지 서버가 강제하지 않아요.** 61초째에 서버는 아무것도 하지 않아요. 서버 임계값(D4의 20분·60분, D1-4의 2시간·24시간, 증보 3의 30분)은 그대로예요. 박자는 에이전트 지시와 화면 문구(「조용해요 · 마지막 보고 n분 전」)의 근거일 뿐이에요.
- **묶어서 보내요.** 보고 호출은 모델 턴을 쓴다고 봐요 [추정]. 한 호출에 `stage`·`activities`·`plan`을 같이 보내고, 바뀐 것이 없는 박자에는 `status:"running"`만 보내요. 같은 활동을 같은 내용으로 다시 보내면 서버가 접어요(7-6).
- **스크립트·타이머가 `running`을 쏘지 않아요.** 모델이 멈췄는데 「작업 중」이 서는 거짓이 돼요(D4-5의 `oort_ping`이 일 신호가 아닌 것과 같은 이유). 보고는 모델이 일하는 중에 직접 보내요. 서버가 가릴 수 없는 규약이에요.
- 바뀌는 것은 `oort_run_event` 진행 박자 5분 → 60초 하나예요(D5 3번). `oort_ping`의 5분, 시작 보고 60초 한도, 서버 임계값은 이 증보가 바꾸지 않아요.
- 비용(−): 진행 중 `oort_run_event`가 최대 5배가 돼 모델 턴·감사 행(`agent.gateway.status`)·T1 `tool_call` 100행이 더 빨리 차요(60초면 100분). T3 집계는 틀리지 않고 「처음 100개의 순서」가 보고 호출로 채워져요. 이 증보는 T2를 바꾸지 않아요(7-R).

### 7-6. 저장·상한·실시간

**원장 종류 둘.** `agent_run_event.kind`에 **`activity`**·**`plan`**을 더해요(14 → 16개, 새 마이그레이션이 `agent_run_event_kind_ck`를 바꿔요, 읽기는 `?include=activity` 뒤에서만, 7-7). 모양은 T1을 따라요: 새 열은 해당 종류 행에만 있고 CHECK가 「그 종류면 필요한 열이 모두 있고, 아니면 모두 없다」를 강제해요. `stage`·`code`·`approval_id`·`tool`·`duration_ms`는 두 종류에서 NULL이에요(`code`가 비어 있어 phase 판정에 새 어휘가 끼지 않아요).

| 종류 | 새 열 | 비고 |
|---|---|---|
| `activity` | `activity_id`(글자 규칙 CHECK) · `activity_kind`(일곱) · `label`(NULL 허용, 문자 규칙 ≤40) · `activity_status`(셋) · `activity_n`(1~100,000) · `activity_started_at`(그 id의 첫 보고 시각) | 한 행 = 한 활동의 한 상태 |
| `plan` | `plan`(jsonb 배열 ≤12, 항목 `{text, status}`, 문자 규칙 ≤60) | 한 행 = 그 시점의 계획 전체 |

**쓰는 함수는 하나예요.** `momo-agent`의 `record_run_activity_in_tx`(와 SQL 함수 `agent_run_activity_record`)가 유일한 쓰기예요. Agent Port의 `record_gateway_event_in_tx`(`hosted_lease`일 때, `GatewayEventInput`에 두 칸을 더해요)와 서버 안 기록자(도우미 워커, 7-10)가 같은 함수를 불러요. 같은 run의 기록자끼리만 직렬화해요(쓰기 접기·상한·합계가 읽고 쓰는 일이라서요. T1의 advisory lock과 같은 방식이고 128의 잠금 순환(M-A)을 만들지 않는지는 E2가 확인해요). [확인 필요] 이 함수를 부르는 DB 역할이 두 종류의 INSERT와 trim의 DELETE 권한을 갖는지도 E2가 확인해요.

**세 겹으로 행이 폭증하지 않아요.**
1. **쓰기 접기.** 같은 `activity_id`의 마지막 행과 (종류·라벨·상태·n)이 모두 같으면 행도 합계도 쓰지 않아요(`stage` 반복을 접는 규칙과 같아요). 60초마다 같은 `activities[]`를 다시 보내도 **바뀐 것만 행이 돼요**. `plan`도 마지막 계획과 같으면 접어요. `agent_run_event_append`의 `stage` 접기는 「마지막 행」을 볼 때 `tool_call`처럼 `activity`·`plan` 행도 **건너뛰어요**(안 건너뛰면 사이에 활동 행이 끼어 같은 `stage`가 매번 새 행이 돼요, 133이 `tool_call`에 한 것과 같아요).
2. **추가 전용 + 읽기 접기.** 행은 고치지 않고 쌓아요. 읽기가 id별 **최신 행**만(`plan`은 최신 하나만) 내려요(7-7).
3. **굴리는 상한.** run당 `activity` 행 **100개**, `plan` 행 **10개** [추정]. 넘으면 `agent_run_activity_trim`(활동을 쓰는 쪽만 부르는 trim 함수, DELETE는 여기에만 있어요)이 이 순서로 지워요: ① **대체된 행**(자기 id의 최신이 아닌 행)을 오래된 것부터 ② 없으면 **끝난 활동**(`completed`·`failed`)의 최신 행을 오래된 것부터 ③ 그것도 없으면 **진행 중** 활동을 오래된 것부터(폴백). ①이 먼저라서 지워도 읽기 결과가 달라지지 않고, ②③은 그 id가 목록에서 통째로 빠져요(앞 순서가 비어야 뒤로 가므로 한 id의 옛 행만 남아 되살아나는 일이 없어요). `plan`은 모두 최신에 대체된 행이라 가장 오래된 것부터 지워요. `stage`·수명주기·`tool_call` 행은 이 trim이 세지도 지우지도 않아요. 거꾸로 200행 trim도 `activity`·`plan`을 세지 않아요(`kind NOT IN ('tool_call','activity','plan')`. 안 빼면 활동 양이 `stage` 행을 밀어내요).
- **왜 굴리나.** 60초 박자에 보고 하나가 활동 1~4개면 100행이 25~50분 안에 차요. T3처럼 「넘으면 쓰지 않는다」면 긴 run의 「지금 무엇을 하나」가 굳고 처음 100개만 남아요. 이 기능의 목적이 「지금」이라서 최신 창이 맞아요. **서버가 잰 사실은 지우지 않고(T3 `tool_call`) 에이전트 자기 보고는 최신 창을 굴려요(D2 「초과하면 가장 오래된 `stage` 행부터 지운다」).** 새 원칙이 아니라 D2와 T3 두 문장을 그대로 읽은 거예요(T3도 「`stage`·`claimed`를 지우는 동작은 그대로다」라고 범위를 좁혔어요). 「행을 지우지 않는다」가 원장 전체의 원칙이었다면 이 문단과 7-A7을 T3 방식(넘으면 행 대신 집계)으로 바꿔요(7-Q1).
- **`activity_started_at`.** 대체된 행이 지워져도 한 활동의 시작 시각이 남게 모든 행이 첫 보고 시각을 들고 가요(쓰는 함수가 같은 id의 마지막 행을 읽어 복사해요).

**종류별 합계 표 `agent_run_activity_tally`**(새 테이블, `(workspace_id, run_id, kind)` PK, `completed_units`·`failed_units` bigint, RLS `ENABLE`+`FORCE` `ws_isolation`, `momo_app` GRANT). **값 = 각 활동 id의 *마지막* 보고가 끝난 값(`completed`·`failed`)일 때 그 `n`의 합**이에요. 같은 id를 다시 끝내면 앞의 값을 빼고 새 값을 더하고(`completed` → `failed`는 옮겨요) 다시 `in_progress`가 되면 빼요. 그래서 재전송·정정에 합계가 두 번 세어지지 않고 행을 지운 뒤에도 정확해요. 한계: 이미 지워진 id를 에이전트가 다시 끝내면 새 활동으로 세요. 이 합계는 **에이전트의 자기 보고 합**이지 oort가 센 사실이 아니에요.

**보존.** 원장 행은 `agent_run`과 함께 지워지고(128의 run 삭제 트리거), 끝난 run은 `RUN_EVENT_RETENTION_DAYS`(30일) 뒤 보존 스윕이 지워요. 합계 표도 같은 수명이에요: 스윕의 읽기 절반(`workspaces_with_expired_run_events`)과 쓰기 절반(`delete_expired_run_events_in_tx`)에 이 표를 넣고 알림 역할에 SELECT를 줘요(133이 `agent_run_tool_tally`에 한 것과 같아요). run 삭제와의 연결은 128의 M-A(원장은 FK 없이 트리거)와 133(집계 표는 FK) 중 E2가 잠금 순환 없는 쪽을 골라요.

**실시간.** 새 행도 같은 AFTER INSERT 트리거로 얇은 `agent.run.event` 프레임(`kind`만, 글·id 없음)을 같은 tx의 outbox로 내요. 2초 합치기는 `stage`·`activity`·`plan`이 **한 창을 나눠 써요**: 이 셋 중 직전에 **프레임이 나간** 행에서 2초 안이면 프레임을 내지 않아요(`framed=false`, BEFORE INSERT 트리거). 한 호출이 `stage`+`activities`+`plan`이면 프레임이 하나예요. 프레임은 재읽기 신호일 뿐이라(F7) 마지막 행이 프레임 없이 남을 수 있는 성질과 「active run은 타이머로도 다시 읽는다」는 클라이언트 규칙이 그대로예요.

**`last_event_at`·스톨 입력.** `activity`·`plan` 행은 `last_event_at`에 **들어가요**(T5의 `tool_call`과 같은 이유로, 그 에이전트가 그 run에서 한 일이에요). 스톨 스위프 입력(`agent_run.updated_at`)은 새로 건드리지 않아요: 이미 모든 `oort_run_event`가 올려요(F8). 그래서 바뀐 게 없어 접힌 보고는 행도 `last_event_at`도 올리지 않지만 `updated_at`과 liveness는 올라요. 이 비대칭은 `status:"running"`만 보내는 지금의 하트비트와 같아요(F9). [확인 필요: T1 `tool_call` 100행이 차면 접힌 보고가 `last_event_at`을 못 올려 화면이 「n분째 보고 없음」으로 틀릴 수 있어요. 60초 박자에서는 약 100분 뒤예요. E2가 「마지막 보고 수신 시각」을 run 읽기에 따로 줄지 정해요]

### 7-7. 읽기 — `?include=activity` 뒤에서만

- `GET …/agent-runs/{run}/events`의 `include`가 닫힌 쉼표 집합 `{doorbell, tools, activity}`가 돼요(`include=doorbell,tools,activity` 가능). 모르는 값은 지금처럼 400이고 메시지가 세 값을 말해요. **`include`에 `activity`가 없으면 `activity`·`plan` 행은 한 줄도 나가지 않아요**(`RunEventInclude`에 `activity` 필드를 더하고 `Default`는 꺼짐). 이 기본값이 도우미의 읽기 도구 `get_agent_run`(F12)이 에이전트가 쓴 라벨·계획 글을 읽지 않는 것을 보장해요. 읽게 하려면 ADR-0201의 청중·오염 규칙(B4-3)과 함께 따로 결정해요.
- 이유: 그 전에 배포된 맥·폰은 모르는 kind가 있으면 원장 전체를 거부하고(F6), `doorbell`·`tools`와 같은 문으로 맞추면 구 서버의 400 폴백(새 클라이언트가 쿼리 없이 한 번 다시 읽고 「활동 기록은 서버 업데이트 뒤에 보여요」)과 상한·정리 규칙을 한 곳에서 다뤄요.
- 응답: `events`에 새 행이 **종류로 구분돼 같은 시간 순서로** 들어와요(`stage`도 에이전트 보고이면서 `events`에 있어요). 새 종류의 행은 읽기에서 접혀 있어요: `activity`는 id별 **최신 행 하나**, `plan`은 **최신 하나**예요. 행 모양은 `kind:"activity"`면 `activity:{id, kind, label?, status, n, startedAtMs}`(`createdAtMs`는 마지막 갱신 시각), `kind:"plan"`이면 `plan:[{text, status}]`예요. 그 밖에 `activityTally:[{kind, completed, failed}]`와 `activityRowsTrimmed: bool`(합계가 지금 보이는 끝난 행의 `n` 합보다 크면 true. 일부는 합계로만 남았다는 뜻이고 `toolCallRowsCapped`와 같은 쓰임)이 `include=activity`일 때만 실려요. 행 수 상한은 `200 + (tools면 100) + (activity면 100 + 1)`로, 새 종류는 자기 상한이 있어 오래된 순 `LIMIT`에 잘리지 않아요.
- `ordinal`은 그 읽기 안의 순번이에요(키로 쓰지 않아요, 지금 규칙 그대로). 시간순은 `startedAtMs`와 `createdAtMs`로 그려요.
- **목록·진행 읽기(`…/agent-runs/progress`, 채널·에이전트 run 목록)에는 활동·계획을 싣지 않아요.** 요약 필드(`latestActivity`·`planProgress`)가 레일·독에 필요한지는 UXUI가 쓰는 모양을 보고 별도 증보로 정해요. 그때까지 레일·독은 보이는 run에 대해 `…/events?include=activity`를 읽어요.
- **읽는 쪽이 지킬 규칙(UXUI 슬라이스, 서버는 사실만 줘요).** ① `activity`·`plan` 행은 항상 「에이전트 보고」 꼬리표와 함께, 일반 텍스트로 이스케이프해 그리고 서버가 잰 줄(`tool_call`·`claimed` 등 「oort 기록」)과 한 칸에 섞지 않아요(ADR-0162 증보 5 C1의 `agentReported`와 같은 원칙). ② 종결된 run의 `in_progress` 활동은 진행 중으로 그리지 않아요(「끝 보고 없음」. 서버는 상태를 바꾸지 않아요, 원장은 사실의 기록이에요). ③ run이 조용하면(서버 liveness·`last_event_at`) 진행 표지를 걷고 「마지막으로 확인된 상태」로 말해요(D1 「클라이언트 TTL 금지」). ④ 재읽기는 프레임 합치기와 맞춰 2초 이상 간격으로 해요. ⑤ `label`이 없으면 종류 낱말이에요.
- 반영 자리: `docs/api/openapi.yaml`의 `include` 쿼리 설명·`AgentRunEvent.kind` enum(16)·`AgentRunEvent.activity`·`plan`·`AgentRunEventsResponse.activityTally`·`activityRowsTrimmed`, 그리고 계약 게이트(`scripts/verify_openapi_contract_rust.sh`).

### 7-8. 가시성·노출

- **누가 읽나.** run의 채널의 **읽는 시점의 활성 멤버**예요(D3·D13과 같은 한 SQL, `left_at IS NULL`). DM run은 그 DM의 두 사람이에요. 멤버 아님·없는 run·다른 테넌트는 모두 같은 404라 존재 오라클이 없어요. 워크스페이스 관리자라도 그 채널 멤버가 아니면 못 읽어요. 읽는 사람별로 거르는 것은 조회(REST)가 해요: 프레임은 글도 id도 싣지 않아요.
- **새로 보이는 것.** 전에는 채널 멤버가 에이전트가 쓴 글을 `stage` 한 줄씩(≤80자)만 봤어요. 이제 활동 라벨(≤40자)·계획 항목(≤60자)·활동 식별자(≤32자, 닫힌 글자)도 봐요. 글 열이 둘과 식별자 하나 늘고 양도 늘지만(run당 활동 ≤100행·계획 ≤12항목), **같은 청중·같은 문자 규칙·같은 「믿지 않는 일반 텍스트」 등급**이에요. 새 청중은 없어요.
- **어디에도 복사하지 않아요.** 감사 행은 개수만(7-2), 푸시·인박스·알림 판정에 안 들어가고, 메시지 본문·검색·기억 색인이 원장을 읽지 않아요(7-A12가 표지로 확인해요). outbox 프레임은 `kind`만이에요.
- **다른 에이전트·모델에게.** 외부 에이전트는 원장을 읽지 않아요(사람 REST). 도우미의 읽기 도구는 기본 `include`로 읽어 이 글을 보지 않아요(7-7). 라벨·계획은 어느 모델 문맥에도 들어가지 않아요.

### 7-9. 도구 설명·지시문 갱신 범위 (#4622 합본)

#4622(증보 5)가 이미 고친 자리에 낱말을 더하는 일이라 같은 표를 따라요. **권위 있는 자리는 도구 설명이에요**: `tools/list`는 에이전트가 깰 때마다 읽는 유일한 사본이고, 루틴 문구는 owner VM에 복사된 사본이라 낡아요(결과 칸의 기능 감지 선례). 도구 설명과 스키마는 같은 PR에서 바꿔요(광고와 수용이 어긋나지 않게).

| 자리 | 바꾸는 것 |
|---|---|
| `server-rust/crates/momo-mcp/src/tools.rs` `oort_run_event` 스키마·설명 | `activities`·`plan` 칸(7-2). 설명: 「at least every five minutes」→ 60초, 단계 경계마다 한 호출에 묶어 보내요, 종류 일곱과 `n`, 라벨은 일의 이름이지 명령·경로·파일 이름·커밋 제목·요청 문구·비밀·추론이 아니에요, `id`는 뜻 없는 번호 이름이고 파일 이름·비밀을 쓰지 않아요, 끝낸 활동은 `completed`·`failed`로 닫아요, `plan`은 전체를 보내요, 스크립트·타이머로 `running`을 쏘지 않아요, 거절되면 7-2의 재시도 규칙 |
| `docs/SELF_HOST_AGENT.md`·`.ko.md` §3.3.17.4 c)와 §3.3.17.4a 표 | 박자 5분 → 60초, 기능 감지(스키마에 `activities`가 보일 때만), 재시도 규칙, `oort_run_event` 행에 두 칸 |
| `packages/momo-core/src/features/hostedAgents/presets.ts` `HOSTED_ROUTINE_TEMPLATE` | 한 문장: 한 호출에 묶어 60초마다(기능 감지 조건 포함) |
| `server-rust/crates/momo-agent/src/mention.rs` `AGENT_CONVERSATION_PREAMBLE` | 규칙 7의 「`oort_run_event` stage」 옆에 `activities`·`plan`(가능하면) 한 낱말 묶음. 관리형·Hermes·팀 AI는 도구가 없으니 의미는 같아요(진행을 대화에 중계하지 않는다) |
| 시험 | 규칙마다 **핵심 낱말 집합**이 그 자리 안에 모두 있는지 보고 낱말을 하나씩 지워 빨개지는지 스스로 확인해요(증보 5의 방식). `agent_conversation_rules.rs`·`presets.test.ts`·도구 설명 시험 |

- 증보 5 규칙 7~10과 모순이 없어요: 「진행은 stage로, 대화로는 아니다」(7)는 그대로고 `activities`는 `stage`를 **대체하지 않아요**(`stage`는 단계의 이름, `activities`는 그 단계 안에서 한 일의 종류별 목록이에요). 「대화에는 결과·막힘·사람이 할 일만」(8)도 그대로예요: 활동 보고는 대화가 아니에요. 위임은 D5 4번의 `stage`(「위임: <봇> · <일>」)를 그대로 쓰고, 같은 호출에 `kind:"delegate"` 활동을 더해도 돼요.
- 규약이지 보증이 아니에요(`runtime-unverified`, 증보 3 D16). 실제 모델이 박자·묶음·라벨 규칙을 따르는지는 `[manual]` 증거 전까지 카피에 「실시간」을 쓰지 않아요.
- 이 슬라이스(7-S3)를 #4656에 합칠지 별도 이슈일지는 planner가 정해요.

### 7-10. ADR-0201 증보 v3(Accepted 2026-11-01)와 맞춘 것

작업 모드(B5)·진행 표시(#4968)가 같은 어휘를 쓰는 지점을 한 표로 맞췄어요. 어긋나면 이 증보가 어휘의 정본이고 0201은 인용해요.

| ADR-0201 v3 | 이 증보 | 맞춤 |
|---|---|---|
| B5-7 「종류 run·edit·read·search·web·other·delegate, `plan` ≤12·글 ≤60자」 | 7-1·7-2 | 같은 숫자·낱말로 확정 |
| B5-7 「워커가 원장에 직접 쓴다(`oort_run_event` 도구를 거치지 않는다)」 | 7-6 `record_run_activity_in_tx` | 도구 경로와 **같은 함수**: 같은 검증·접기·상한·합계예요. 둘이 다르게 조일 수 없어요 |
| B5-2 `team_ai_task`의 계획(≤8항목, 서버 내부 상태) | 7-2 `plan`(≤12, 사람이 보는 계획) | **다른 값이에요.** 도우미는 내부 계획이 바뀔 때마다 보이는 계획을 같은 함수로 써요(8 ≤ 12라 상한 안). 내부 표는 읽는 API가 없어요(B5-2) |
| B12 「쓴 양은 run 읽기 필드, `stage` 라벨에는 싣지 않는다」 | 7-2·7-6 | 활동·계획·라벨에 토큰·비용·검색 횟수 칸이 없어요. 쓴 양은 B12의 필드가 따로 말해요 |
| B5-7 「채팅으로 진행을 중계하지 않는다」·「단계 사이 대기는 `phase=running`」 | 7-5, 증보 5 규칙 7 | 충돌 없음 |
| F12 「`activities`·`plan`은 아직 들어오지 않았다」 | 7-S1 | 이 증보가 설계를 정해요. 구현은 #4656이고 #4968의 `activities`·`plan` 체크박스는 그 뒤예요(0201 B14-S5의 순서 그대로) |

- **범위 [확인 필요].** 이 증보의 어휘·검증·읽기는 `…/events`가 읽는 원장 행에 붙어요(그 읽기는 호스팅 여부를 보지 않아요, F12). 그런데 원장의 수명주기 행(트리거)과 진행 목록 읽기는 **호스팅 에이전트 run만** 다뤄요(128 `agent_run_event_is_hosted`). 도우미는 관리형(호스팅 연결 없음)이라 B5-7의 `stage` 직접 쓰기와 이 증보의 활동 쓰기가 같은 문제를 가져요: 원장 쓰기·진행 읽기의 범위를 도우미 run으로 넓히는 일이에요. 이 증보는 범위를 넓히지 않고, ADR-0201 B14-S5(#4968)가 착수 전에 정해요.

### 7-11. 바뀌는 것·바뀌지 않는 것·불변식

- **바뀌는 기존 결정**(Accepted가 되면). ① D2의 「자유 텍스트를 새로 저장하지 않는다」(7-3). ② D2의 kind 어휘 14 → 16, `?include=activity` 뒤(7-6·7-7). ③ D5 3번 「최소 5분마다」 → 「최소 60초마다」, 1번은 말만 통일(7-5).
- **바뀌지 않는 것.** D1~D4의 상태·대기열·생존 판정과 모든 임계값, 증보 3의 스위프, T1~T5(`tool_call`은 지우지 않고 200행 trim 밖), 증보 4·6, 증보 5의 규칙 7~10, `oort_ping`(5분)·시작 보고 한도(60초), `artifacts.toolCounts`(여섯 키), REST gateway 콜백, 하네스 세션 경로(`momo-workd`), 원장 범위(호스팅 run), 기본 `include`로 읽는 응답. 새 도구·새 scope·MCP Tasks 연동은 없어요(D6).
- **불변식 대조.**
  - REST send → channel_seq + message + outbox 단일 tx: 건드리지 않아요. 활동·계획 쓰기는 `record_gateway_event_in_tx`와 **같은 tx**에서 outbox 프레임과 함께 나가고, 클라이언트 직접 publish는 없어요. 순서는 `seq`, 재시도는 기존 `eventId` 멱등성이에요.
  - 모든 테넌트 경로 `workspace_id` + RLS FORCE + tx마다 `SET LOCAL app.workspace_id`: 새 합계 표는 `ENABLE`+`FORCE`+`ws_isolation`이고 원장의 새 열은 같은 표의 같은 정책 아래예요. 쓰기 경로 BYPASSRLS 없음(기록자의 DB 역할은 7-6이 확인을 요구해요).
  - `schema_v0.sql` 불변, 신규 migration으로 확장, sqlx 런타임 쿼리예요. 신규 테넌트 표는 RLS 정책 대상이에요.
  - 공개 API(도구 스키마·읽기 응답·openapi) 변경 → 이 증보의 Accepted가 #4656 머지 조건이에요(ADR-0100).
  - 에이전트는 `member.kind='agent'` 1급 멤버: 행의 `actor_member_id`가 그 에이전트예요.

### 7-A. 수용 기준 — 구현이 내야 할 red proof (각 시험은 해당 분기를 지우면 실패해야 한다)

| id | red proof | 지우면 실패해야 하는 것 |
|---|---|---|
| 7-A1 | `label`·`plan.text`에 `/`·`\`·제어·방향 글자가 있거나 41자·61자면 **호출 전체** 거절(-32602). `error.data`가 `{field, rule, index}`를 싣고 보낸 값은 응답·감사·로그 어디에도 없다. 쓰기 0(원장·합계·`output.stages`·`step_count` 불변). 정확히 40자·60자는 통과 | 문자 검사·길이 검사 각각, 거절 시 쓰기 0 |
| 7-A2 | 9번째 활동·13번째 계획 항목·일곱 밖 종류·상태 밖 값·`id`의 밖 글자(점·슬래시·공백)·33자·모르는 키는 거절. `n`이 0·100,001이면 거절 | 닫힌 어휘·개수 상한 |
| 7-A3 | 41~80자 `stage`는 지금처럼 통과, 81자는 거절(서버 상한 80 유지) | `stage` 상한이 줄지 않았음 |
| 7-A4 | 한 호출이 `stage`+`activities`+`plan`이면 전부 쓰이고, `activities`가 거절되면 `stage`도 안 쓰인다. 같은 `eventId` 재전송은 행·합계·감사를 늘리지 않는다 | 한 트랜잭션·멱등 |
| 7-A5 | 같은 id·같은 내용 반복은 행 0·합계 불변, 상태가 바뀌면 행 1. 읽기는 id별 최신 하나. 사이에 `activity`·`plan` 행이 끼어도 같은 `stage`는 접힌다 | 쓰기 접기·읽기 접기·`stage` 접기의 건너뛰기 |
| 7-A6 | 합계: 같은 id를 `completed` n=5로 두 번 → 5, n=7로 정정 → 7(12 아님), `completed` → `failed`는 옮김, `in_progress`는 안 셈, 다시 `in_progress`가 되면 뺌 | 「마지막 끝난 값의 합」 정의 |
| 7-A7 | 활동 행 100개를 넘기면 ① 대체된 행 ② 끝난 활동 ③ 진행 중 순서로 지운다. 진행 중 활동의 유일한 행은 끝난 활동이 남아 있는 동안 안 지워진다. 합계는 줄지 않고 `activityRowsTrimmed`가 켜진다. 지운 뒤에도 id별 최신 읽기가 옛 행을 되살리지 않는다 | 지우는 순서·합계 보존·되살림 없음 |
| 7-A8 | trim 경계: 활동이 `stage`·수명주기·`tool_call` 행을 밀어내지 않고(200행 계산 밖), `stage` 201번째가 활동을 지우지 않는다 | `kind NOT IN` 술어 |
| 7-A9 | 계획: 새 계획이 이전 항목을 모두 대체, 같은 계획 반복은 행 0, `[]`은 비움, `plan` 생략은 불변. 계획 행 11개째에 가장 오래된 행이 지워져도 읽기는 최신 하나 | 통째 교체·접기·행 상한 |
| 7-A10 | 읽기 문: `include` 없으면 `activity`·`plan` 행 0, `include=doorbell,tools,activity`가 셋 다, 모르는 값 400, `RunEventInclude::default()`(도우미 읽기 도구 경로)에 0행, `activityTally`·`activityRowsTrimmed`는 `include=activity`일 때만 | include 필터·기본 꺼짐 |
| 7-A11 | 가시성: 타 테넌트 읽기 0(합계 표도 두 테넌트 RLS), 채널 비멤버·DM 제3자·나간 멤버는 404, 존재 오라클 없음 | RLS·멤버 조건 |
| 7-A12 | 노출 경계: 라벨·계획 글·`id`에 고유 표지를 넣은 run 뒤, 메시지·감사·outbox·푸시 후보·기억 입력의 모든 텍스트 열에서 그 표지가 `agent_run_event`(와 읽기 응답) **밖에 0회**이고 감사 행에는 개수만 있다. 푸시·인박스 0 | 복사하지 않음 |
| 7-A13 | 실시간: 한 호출(`stage`+활동 8개+`plan`)이 프레임 1개(2초 창 공유), 프레임 JSON에 글·id 없음, 2초 뒤 다음 보고는 다시 프레임 | 창 공유·글 없음 |
| 7-A14 | 생존·비용 경계: 활동만 든 호출도 `updated_at`을 올리고, 활동·계획은 `step_count`·`output.stages`를 안 건드린다(60초 박자 200번에도 `step_count` 불변). 종결·승인 대기 run은 409이고 활동 쓰기 0. `cancelled` 확인 호출에 든 형식이 맞는 `activities`·`plan`은 버려지고(쓰기 0, 거절 아님) `stage`와 같다 | `record_stage_in_tx` 비경유·종결 run 필터 |
| 7-A15 | 서버 안 기록자(도우미 직접 쓰기)가 도구 경로와 같은 거절 코드·접기·상한·합계를 적용한다(같은 입력으로 두 경로 대조) | 함수 하나 |
| 7-A16 | 지시문·도구 설명: `oort_run_event` 설명·루틴(두 언어)·프리셋에 규칙마다 핵심 낱말 집합(종류 일곱, 「60초」, 한 호출, 라벨은 일의 이름, 스크립트 금지, 기능 감지, 재시도 2번)이 있고 낱말을 지우면 빨개진다. 보고 박자 문장에 옛 「five minutes」·「5분마다」가 없다(단 `oort_ping`의 5분은 남아 있다) | 낱말 집합 사보타주·옛 박자 부재 |

### 7-S. 구현 슬라이스 (Accepted 후, 한 슬라이스 = 한 이슈·브랜치·PR, base `track/engine`)

| id | 내용 | 트랙·크기·등급 | 선행 |
|---|---|---|---|
| 7-S1 | 쓰기: 마이그레이션(kind CHECK 16·새 열·SQL 백스톱·합계 표·trim 함수·`agent_run_event_trim`/`append`/`set_framed` 술어·보존 스윕 확장), 길이 인자 검증 함수, `record_run_activity_in_tx`, `oort_run_event` 스키마와 `record_gateway_event_in_tx` 연결, `ReportRejection`·`ToolFailure` 변종(C3 확장, 7-2). 시험 7-A1~A9·A13·A14·A15 | 엔진·L·1(공개 도구 표면) | 이 증보 Accepted |
| 7-S2 | 읽기: `include=activity`·`RunEventInclude`·응답 모양·openapi·계약 게이트, **독립 보안 검수 Blocker 0·High 0**(7-3의 한계·7-8의 노출). 시험 7-A10~A12 | 엔진·M·1 | 7-S1 |
| 7-S3 | 도구 설명·루틴(두 언어)·프리셋·preamble 낱말·시험(7-9, #4622 합본). 도구 설명은 스키마와 같은 PR(7-S1)이거나 그 뒤 | 엔진+문서·S·1 | 7-S1 |
| 7-S4 | (UXUI, 이 증보 밖) core 파서·타임라인 행 모델·패널의 활동 줄·레일의 최신 라벨·계획 「2 of 4」. 7-7의 읽는 쪽 규칙을 따라요 | UXUI | 7-S2 |

- 이슈 대응: #4656 = 7-S1+7-S2(수용 기준 둘째 줄은 7-6의 굴리기에 맞게 고쳐요, 7-Q1). 7-S3은 #4656에 합치거나 별도 이슈(planner).
- 이 증보가 흡수하지 않는 것: #4580의 **자식 run 목록 API**(`GET …/agent-runs/{run}/children`)와 Hermes todo 연결은 설계하지 않았어요. `delegate`는 에이전트가 말하는 한 줄이고 자식 run과 잇지 않아요(잇는 일은 #4580). #4580의 「계획 단계 이벤트(에이전트 보고)」 절반은 이 증보의 `plan`이 정해요.
- 후속(별도 이슈): Hermes 진행 메모·todo → `stage`·`plan`(X1), 관리형 워커 도구 호출을 서버 관측 행으로(E4, #4647과 함께 판단), 도우미 진행(#4968), 운영 보고 밀도 실측(P0).
- migration 번호는 쓰지 않았어요. #4656이 착수 때 정해요.

### 7-Q. 열린 질문 (owner 또는 planner에게, 쉬운 말, 추천이 앞)

- **7-Q1. 활동 기록이 가득 차면 어떻게 할까요?** (가, 추천) 오래된 것부터 지워요. 합계는 그대로 남고 화면은 늘 최근 100개를 보여 줘요. (나) 새 기록을 더 쓰지 않고 처음 100개만 남겨요(oort 호출 기록처럼). 긴 작업에서 중간부터 화면이 멈춘 것처럼 보여요. 「행을 지우지 않는다」가 모든 기록에 해당하는 원칙이면 (나)예요.
- **7-Q2. 단계 메모(`stage`)의 서버 글자 수 상한을 40자로 줄일까요?** (가, 추천) 80자 그대로 두고 화면이 40자에서 줄여요. 지금 에이전트가 안 깨져요. (나) 40자로 줄여요. 41자 이상 보고가 거절돼 살아 있다는 신호까지 잃을 수 있어요.
- **7-Q3. 끝 보고의 개수 칸(`toolCounts`)에 `delegate`를 더할까요?** (가, 추천) 더하지 않아요. 맡긴 횟수는 진행 중 활동 합계에만 있어요. (나) 더해요. ADR-0162 증보 5의 공개 칸이 바뀌어요.
- **7-Q4. 라벨·계획 글·`id`에서 비밀 모양(키·토큰)을 서버가 걸러 낼까요?** (가, 추천) 지금은 단계 메모와 같은 방어만 써요. 같은 함수라 나중에 한꺼번에 조일 수 있어요. (나) 하네스의 자격증명 거르기를 서버에도 붙여요. 공유 crate 이동이 필요해 더 커요.
- **planner 결정(2026-11-01)**: 7-Q1~Q4 모두 (가). owner가 다르게 원하면 해당 절(7-6·7-1·7-7·7-2)만 고쳐요.

### 7-R. 역방향 줄 대상·열어 두는 것·귀결

- **역방향 줄 대상**(결재 뒤 planner가 각 문서 머리에 한 줄만, 본문 결정은 바꾸지 않아요): ADR-0186 증보 R-f의 「40으로 줄일지는 #4655가 정한다」(→ 80 유지, 7-3) · `docs/design-system/agent-request-loop.md` §3.2의 같은 문장 · ADR-0201 증보 v3의 F12·B5-7·B14-S5(착륙 사실·어휘 정본) · ADR-0162 증보 5 C2(`toolCounts`는 그대로, 진행 중 합계는 이 증보) · #4580 본문(계획 절반 흡수, 자식 run 목록은 남음). ADR-0200 안의 앞방향 화살표(D2 kind 어휘·자유 텍스트 문장·D5 1·3번)는 이 증보와 함께 넣었어요.
- **열어 두는 것.** ① 보고용 호출(`oort_run_event`)을 T1 `tool_call` 행에서 빼는 일(60초 박자로 100행이 100분에 차요. 집계는 틀리지 않아요). ② 목록·진행 읽기의 요약 필드(`latestActivity`·`planProgress`). ③ `include=activity`의 재읽기 비용(최악 ≈401행, 필요하면 `after` 커서). ④ 서버가 박자를 알려 주는 `report{everySeconds}` 힌트(루틴이 낡아도 박자를 지시해요). ⑤ 도우미 run으로 원장 범위 넓히기(7-10, #4968). ⑥ 자격증명 패턴 거절(7-Q4).
- **귀결.** (+) 「무슨 도구로 무엇을 하고 있나」가 처음으로 서버에 남고 레일·독·패널·답 메시지 칩이 한 모델로 읽어요. (+) 생각은 저장하지 않고, 서버가 잰 사실과 에이전트 보고가 종류와 꼬리표로 갈려요. (+) 한 함수·한 검증·한 접기 규칙이라 외부 에이전트 경로와 도우미 경로가 어긋나지 않아요. (−) 에이전트가 쓴 글 열이 셋(`stage`·`label`·`text`)에 식별자 하나(`id`)가 되고 뜻은 서버가 못 봐요. 방어는 겹겹이지만 막는 것이 아니에요(7-3). (−) 진행 중 보고 호출이 최대 5배라 모델 턴·감사 행이 늘어요(7-5). 쓰기 폭증 지표를 7-S1이 측정해요. (−) 규약이라 에이전트가 안 따르면 활동·계획이 비어 보여요. 그래서 「마지막 보고 n분 전」을 항상 같이 보여요(D5 귀결과 같아요). (−) 읽기 응답이 커질 수 있어요(최악 ≈401행).
