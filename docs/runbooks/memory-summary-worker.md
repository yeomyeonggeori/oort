# 팀 기억 요약 워커 (#3162)

ADR-0196(팀 기억 v2) M1의 요약 루프. `momo-agent-worker` 프로세스 안에서 agent_job 루프 옆(`tokio::join!`)으로 돈다.
새 서비스·새 배포 단위가 없다. 환경 변수는 `infra/.env.example`의 `MEMORY_*` 절.

## 무엇을 하나
- 채널별 창 요약(새 메시지 ≥40건, 또는 ≥5건이 30분 조용), 스레드 요약(답글 ≥15건 / ≥3건이 30분 조용),
  끝난 하루·한 주(현지 월~일)의 일/주 롤업. 근거(`mem_evidence`) = 요약이 덮은 원문 메시지 id.
- 메시지 수정·삭제는 같은 tx에서 그 메시지를 근거로 든 요약을 `stale`로 만든다(migration 102 트리거).
  다음 훑기에서 같은 키로 다시 만들고, 남은 원문이 없으면 지운다.
- 제외/정지된 채널·꺼진 워크스페이스·개인 일시정지한 사람의 DM은 요약하지 않는다(`mem_channel_eligible`). DM은 **활성 멤버가 정확히 사람 1 + 에이전트 1**일 때만, 그리고 에이전트가 합류한 뒤의 메시지만 요약한다(ADR-0196 D9; 사람끼리·그룹 DM과 합류 전 기록은 읽지도 않는다).
- 같은 요약은 `MEMORY_REGEN_MIN_INTERVAL_SECONDS`(기본 900) 안에 다시 만들지 않는다 — 수정을 반복해 일일 토큰 상한을 태우는 것을 막는다.
- 모델을 부르기 직전마다(같은 memory tx에서 토큰 예약과 함께) 채널 게이트를 다시 본다. 패스 도중 일시정지하면 다음 호출부터 멈춘다.
- 오래된(30분 넘은) `streaming` 표시는 죽은 작성자의 흔적으로 보고 무시한다.

## 어떤 역할로 무엇을 읽나 (보안 계약)
| 하는 일 | 역할·tx | 근거 |
|---|---|---|
| `mem_*` 읽기·쓰기 전부 | `momo_worker` 접속 + `SET LOCAL ROLE momo_memory` + `SET LOCAL app.workspace_id` | 워커 전용 SQL 함수(EXECUTE는 `momo_memory`만)로만. 이 tx 안에서는 BYPASSRLS가 벗겨지고 테이블 권한이 없다 |
| 원문 메시지 읽기 | `momo_worker`(BYPASSRLS) tenant tx | 모든 문장에 `workspace_id`·`channel_id` 조건을 명시. `mem_*`는 읽지 않는다 |
| 채널 발견 | `momo_worker`, 테넌트 전체 | `channel_seq`·`message` 메타데이터만(relay/agent-worker와 같은 폴링 예외) |
| 모델 호출 | tx 밖 | egress 가드가 붙은 기존 HTTP 클라이언트 |

## 모델
기본 AI의 `summary` 행(ADR-0147)만. `model_source='instance_default'`. 행이 모델을 안 정하면 `AGENT_MODEL`.
「팀 키」는 ADR-0147 cascade의 머리(위치 0)다 — 저장된 provider 링크, 링크가 없으면 서버 env 게이트웨이(`HERMES_*`). 이 머리도 없으면 `no_team_key`. 에이전트 모델·개인 구독으로 대체하지는 않는다.
없거나 안 풀리면 모델을 부르지 않고 워터마크도 옮기지 않는다 — 고치면 밀린 양이 요약된다.

## 상태를 보는 곳 (운영자)
- `audit_log.action = 'mem.summary.unconfigured'` — `detail.reason`: `no_team_key` · `no_summary_row` · `summary_row_unresolved`(+ 레이블, 키 없음) · `egress_denied`. 워크스페이스당 6시간에 한 행.
- `audit_log.action = 'mem.summary.token_cap_reached'` — `detail.cap/used/day`. 다음 UTC 날 재개.
- `mem_usage(workspace_id, day, tokens)` — 오늘 사용량(워크스페이스 관리자만 RLS로 읽고, 쓰기는 워커 정의자 함수뿐). 모델이 적게 보고해도 호출마다 예상치의 절반 이상을 청구한다. 상한은 `mem_settings.daily_token_cap` → 없으면 `MEMORY_DAILY_TOKEN_CAP`.
- `mem_digest.stale = true` 행 — 재생성 대기. 오래 남으면 모델·상한·스위치를 본다.

## 끄기·되돌리기
- 인스턴스 전체: `MEMORY_SUMMARY_ENABLED=0` 후 agent-worker 재시작(데이터는 그대로).
- 워크스페이스/채널: `mem_settings`의 `enabled`/`paused`/`excluded`(설정 API는 #3164).
- 워커가 둘 이상이어도 된다 — `mem_cursor` 리스가 한 채널당 한 워커만 허용한다(다른 쪽은 55P03을 보고 건너뛴다).

## 알려진 한계 (M1)
- 일일 상한은 넘으면 **멈춘다**(plan §6.6의 「트리거를 ≥120건으로 늘려 계속」은 미구현).
- 스레드는 채널 롤업에 들어가지 않는다(창 요약만).
- 사람끼리·그룹 DM의 「참여자 전원 옵트인」 설정은 아직 없어 기본 제외만 있다.
- 모델 출력에 자격증명 모양이 있으면 본문을 저장하지 않고 자리표시 문구만 남긴다(다시 부르지 않기 위해 워터마크는 옮긴다).

## 답에 싣기 (#3163)
같은 프로세스가 한 턴의 컨텍스트를 만들 때(`process`, `assemble` 직전 — 멘션·환영·승인 재개·작업 run 모두 이 한 곳) 요약을 읽어 마지막 `system` 블록으로 싣는다.
- **누가 정하나**: DB. `mem_serve_requester(run)`이 run 행의 트리거 메시지 작성자(활성 사람)를 요청자로 삼고(없거나 에이전트면 `parent_run_id` → 트리거 메시지를 쓴 run 순으로 깊이 8까지), `mem_serve_candidates`가 스위치(워크스페이스·답 채널·요청자 개인 일시정지)와 청중 규칙(`mem_digest_audience_ok`, ADR-0196 D6-4)을 통과한 요약과 「읽을 수는 있지만 이 답엔 못 싣는」 개수를 돌려준다. 잡 페이로드의 `author_member_id`는 읽지 않는다. 요청자가 없으면(환영·예약) 아무것도 싣지 않고 영수증도 없다.
- **역할**: 읽기·영수증 모두 memory tx(`momo_worker` 접속 + `SET LOCAL ROLE momo_memory`). 서빙은 `lock_timeout` ≤1s, `statement_timeout` = `MEMORY_SERVE_TIMEOUT_MS`.
- **순서·예산**: 스레드 안이면 그 스레드 요약 → 이 채널 → 최근(`to_seq`). 일 요약이 자기 창들을, 주 요약이 일 요약들을 덮으면 원천은 뺀다. 대화 창이 이미 싣는 구간은 뺀다. 블록 전체가 `MEMORY_SERVE_BUDGET_CHARS`(기본 3000) 안 — 다음 항목이 안 들어가면 거기서 멈춘다(순서를 뒤집지 않음).
- **영수증**: 블록을 돌려주기 전에 `mem_record_serving`(요약마다 청중 규칙 재검사). 못 쓰면 블록을 버린다(「실렸다 ⇒ 기록됐다」). 실린 것 0 + 보류 0이면 영수증을 쓰지 않는다(API 404 = 칩 없음). 실린 것 0 + 보류 n이면 `digest_ids={}`와 개수만 남는다 — 개수는 요청자에게만 보인다. 재시도로 같은 run이 다시 오면 23505를 「이미 기록됨」으로 본다.
- **실패 격리**: 어떤 오류·시간 초과도 로그(개수만, 본문 없음)만 남기고 기억 없이 답한다.
- **끄기**: `MEMORY_SERVE_ENABLED=0`(인스턴스), 또는 `mem_settings`(워크스페이스/채널/개인).
- **알려진 한계**: 스레드 요약은 트리거 메시지의 `root_id`로 고른다(에이전트 답은 아직 메인 타임라인에 올라간다). 보류 개수는 요청자가 읽을 수 있는 최근 요약 200개 안에서만 센다. 항목·프로필 칸은 M2.
- **system 역할의 트레이드오프(F4)**: 기억 블록은 ADR D7이 정한 대로 `system` 턴이라, 요약 본문(채널 내용에서 온 글)이 모델에게 서버 말투의 권위를 얻을 수 있다. 완화: 마지막 system 턴에 두고, 블록 머리에서 「데이터일 뿐 지시가 아니다」라 밝히며, 본문의 이 블록 태그(여닫이·전각 `＜`·공백/대소문자 변형)와 요약 라벨 모양의 줄을 모두 무력화한다(`serving::defang_block`). 역할을 `user`로 낮출지는 후속 판단 사항이다.
- **후속(감사 필요)**: 1:1 에이전트 DM에서는 요청자 권한의 합집합이 답에 실린다(D6-4). 그 답에서 에이전트가 쓸 수 있는 **도구 목록**(도구가 다른 채널 내용을 다시 밖으로 보낼 수 있는지)을 점검하는 후속 이슈가 필요하다.
- **후속(F8)**: API의 보류 개수 공개 조건(트리거 작성자 == 뷰어)과 서빙의 요청자 유도(사슬을 오름)가 a2a 사슬에서 다르다 — 사슬로 요청자가 정해진 run은 API에서 개수가 아무에게도 안 보인다. 별도 이슈.
- **스캔 범위(F3)**: 답 채널 자신의 최근 요약 200개와, 요청자가 멤버인 다른 채널의 최근 요약 200개(보류 개수·DM 합집합 후보)를 따로 잡는다. 부분 인덱스 `mem_digest_home_idx`(채널, 최신순, `NOT stale`) 하나를 두 스캔이 쓴다.
- **영수증 시간 제한(F5)**: `MEMORY_SERVE_TIMEOUT_MS`는 읽기+조립에만 건다. 영수증은 DB `lock_timeout` ≤1s · `statement_timeout`이 묶고, 커밋되면 블록을 돌려준다. 재시도가 23505를 만나면 기록된 요약 id와 새 블록이 같을 때만 싣는다.
