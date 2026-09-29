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
