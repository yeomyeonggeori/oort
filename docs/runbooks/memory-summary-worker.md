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

## 항목 추출 (#3168, M2)
창 요약을 만드는 **같은 모델 호출**이 `{summary, items[]}` JSON을 돌려주고, 항목(결정·사실·약속)은 요약과 **같은 tx**에서
`mem_add_item`(워커 전용 SQL 함수, migration 104)으로 **추가만** 된다. 끄려면 `MEMORY_EXTRACT_ENABLED=0`(M1처럼 요약만).
- 후보는 워커가 먼저 엄격히 거른다: 근거 번호가 그 창의 메시지여야 하고, 근거 작성자가 사람이어야 하며(에이전트·봇 발언은 사실로
  쓰지 않는다), 본문·근거에 시크릿 모양이 없어야 하고, 종류가 decision/fact/commitment, 한 문장(300자), 창당 6개. 어긋나면 그 후보만 버린다.
  DB가 같은 것을 다시 확인한다(작성자 종류, 근거 ⊆ 요약 근거, 수정 후 읽기 40001, 스위치 55000, 토큰 모양 백스톱).
- 응답이 JSON이 아니면 원문이 요약 본문이 되고 항목은 0개다(요약은 항상 만들어진다). 요약 본문에 자격증명 모양이 있으면 그 응답의 항목도 버린다.
- DM(사람↔에이전트)에서 나온 항목은 개인 공간(`space_kind='personal'`, 소유자 = 그 사람)이다.
- 읽기: 저장 채널·모든 근거 채널을 지금 읽을 수 있고 근거 메시지가 살아 있을 때만 보인다. 근거가 삭제·수정되면 즉시 가려진다 —
  행은 지우지 않는다(`retired_reason=source_deleted/edited`로 내리는 정리 잡은 M3, #3172). 같은 내용이 다시 추출되면 죽은 옛 행은 `stale`로 표시되고 새 행이 들어간다.
- 모델 호출 예산: 창 호출은 출력 허용량 +700토큰을 더 예약한다(`ITEMS_OUTPUT_ALLOWANCE`).
- 상태 보기: `mem_item`(행), `mem_event`(생성 이벤트, 본문 없음). 프롬프트 버전은 `mem_digest.prompt_version`(digest-v2)과 `mem_item.extractor_version`(items-v1)에 남는다.
- 검색: `mem_search_items(질의, 개수)`(열람 API, momo_app 세션만, 질의 200자 상한) / `mem_search_items_for(요청자, 질의, 개수, 답 채널)`(서빙, 워커 전용, **답 채널 필수**).
  pg_trgm 낱말 유사도 + 조사 떼기, 뷰어의 멤버십 채널로 좁힌 뒤 RLS와 같은 읽기 규칙. GIN 인덱스는 RLS 아래에서 쓰이지 않아 만들지 않았다(ADR-0196 증보 2026-09-30).
  워크스페이스 항목 수에 비례해 느려진다 — 측정은 PR #3200 본문. 시크릿 판정은 Rust `looks_like_secret`과 SQL `mem_looks_like_secret`이 같은 예/아니오 목록으로 시험된다.

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

## 항목 서빙과 기억 제안 (#3169)
- **항목 섹션**: 요약 블록 뒤에 `<기억 항목 참고자료>`가 붙는다(트리거 메시지 본문으로 `mem_serve_items`가 검색). 예산 `MEMORY_SERVE_ITEM_BUDGET_CHARS`(3000), 후보 `MEMORY_SERVE_MAX_ITEMS`(8). 영수증 `budget_chars`는 두 예산의 합(기본 6000). **항목 섹션만 끄기**: `MEMORY_SERVE_ITEMS_ENABLED=0`. 항목 읽기가 실패·시간 초과여도 요약은 그대로 실린다.
- **에이전트 제안 도구 `memory_suggest`**: 에이전트 프로필의 `enabled_tools`에 넣어야 켜진다(기본 꺼짐 — `card_suggest`와 같은 이름 면제, 프로필이 안 켰으면 호출은 거부된다). 켜진 에이전트의 창에는 사람 메시지마다 `#<seq>`가 붙고(근거 번호), 규칙 블록이 함께 실린다. 도구는 `mem_proposal`에 **대기** 행만 만든다: 검색·서빙·기억 브라우저가 읽지 않는다. 채널 멤버가 `POST …/memory/proposals/{id}/accept`로 수락해야 `origin=confirmed` 항목이 된다.
- **끄기·회수**: 프로필에서 도구를 빼면 새 제안이 멈춘다. 대기 제안은 14일 뒤 만료(목록에서 사라지고 수락 불가). 만료·근거 삭제된 제안의 본문 정리는 M3 정리 잡(#3172) 몫이다 — 그 전까지 행은 남지만 RLS가 가린다.
- **한도**: run당 3건 · 채널 대기 20건 · 에이전트당 시간당 30건(도구가 「too many proposals」로 답한다).
- **모니터링**: 로그 `memory serving recorded`의 `served_items`, `mem_event`의 `proposed`/`created`/`confirmed`/`rejected`, 감사 `memory.proposal.accepted|rejected`.

## 임베딩과 벡터 검색 (#3173, M3)
- **무엇**: 항목(`mem_item`)마다 로컬 모델(`intfloat/multilingual-e5-small`, MIT, int8 ONNX, 384차원)의 벡터를 `mem_item_embedding`(항목·모델 키)에 저장하고, 서빙 때 질문 벡터와 **가중 RRF**(키워드×2 : 벡터×1, k=60)로 융합한다. 브라우저(API) 검색은 M3에서도 키워드만이다(API 프로세스는 모델을 싣지 않는다). 요약(`mem_digest`)은 임베딩하지 않는다 — 요약 서빙은 질의가 아니라 청중 규칙이 고른다.
- **어디서 도나**: 같은 워커 프로세스. 시작할 때 백그라운드에서 모델을 한 번 올리고(약 0.5초), 임베딩 루프가 `MEMORY_EMBED_POLL_SECONDS`마다(또는 이 프로세스가 항목을 저장한 직후) **벡터가 아직 없는 살아 있는 항목**을 `MEMORY_EMBED_BATCH`개씩 임베딩한다. 신규·편집(curated) 사본·수락된 제안·기존 이력(백필)이 모두 이 한 길이다. 워크스페이스당 스윕당 `MEMORY_EMBED_MAX_PER_SWEEP`(200)개가 상한이라 5,000건 이력도 약 13분에 걸쳐 조용히 채워진다.
- **누가 정하나**: 권한은 여전히 SQL 하나다. 벡터는 순위 신호일 뿐이다. `mem_serve_items_fused`는 (1) 멤버십으로 좁힌 행만 거리 계산을 받고 (2) `mem_item_readable_by` + `mem_item_audience_ok`를 **통과한 것만** 후보로 세며(거른 뒤 자른다) (3) 키워드 후보(`mem_search_items_core`, 같은 규칙)와 융합한다. `mem_item_embedding`은 어떤 런타임 역할에도 테이블 권한이 없고(임베딩은 본문 복원 재료), 쓰기·읽기 함수는 `momo_memory`만 부른다.
- **품질 손잡이**: `MEMORY_EMBED_MIN_SIMILARITY`(0.80)와 `MEMORY_EMBED_MARGIN`(0.04)이 「그나마 가까운」 무관 항목을 막고, 키워드 후보에 없는 벡터 전용 항목은 답당 3개까지만 싣는다(SQL 상수). 실제 질문 분포로 재기 전의 초기값이다.
- **실패 격리**: 질문 임베딩은 `MEMORY_EMBED_QUERY_TIMEOUT_MS`(250) 예산 안에서만 기다린다. 모델이 아직 안 올라왔거나 바쁘거나 느리거나 실패하거나 융합 SQL이 오류를 내면 **M2와 같은 키워드 전용 읽기**로 돌아가고 답은 나간다. 모델 디렉터리가 없으면 경고를 한 번 남기고 임베딩 루프는 끝난다.
- **모델 교체**: `momo_embed::MODEL_ID`가 바뀌면 다른 `model` 값의 새 행으로 병행 백필되고, 검색은 자기 모델의 행만 본다(옛 행 정리는 후속).
- **끄기**: `MEMORY_EMBED_ENABLED=0` — 이후 서빙은 M2와 바이트 단위로 같다. 이미 쌓인 벡터는 남지만 읽히지 않는다.
- **ONNX Runtime**: 정적 링크가 아니라 실행 시 `ORT_DYLIB_PATH`(이미지에서는 `/opt/momo/lib/libonnxruntime.so`, Microsoft 공식 1.28.2, sha256 고정)로 적재한다. 못 올리면 오류로 돌려받아 키워드 전용으로 서빙한다(패닉 없음). 로컬 개발에서 모델을 돌리려면 Microsoft 릴리스의 `libonnxruntime.dylib/.so`를 받아 `ORT_DYLIB_PATH`를 지정한다(`cargo build/test`는 필요 없다).
- **이미지 검증**: `momo-agent-worker --embed-check`(모델 로드 + 문장 하나 임베딩 + 모양 검사)를 이미지 빌드가 돌린다. 실행 중 상태는 로그 `memory embedder loaded` / `memory embedding sweep`, 그리고 워크스페이스별 `mem_embedding_stats(model)`(살아 있는 항목 수 / 임베딩된 수)로 본다.
- **알려진 한계(runtime-unverified)**: x86 Linux(Railway)에서의 지연·RSS는 재지 않았다(스파이크: ARM 맥에서 질의 3~5ms, 프로세스 최대 RSS ≈ 1 GB @ 배치 32 — 여기 기본 배치 16). int8 파일 이름의 `avx512_vnni`는 CPU 요구가 아니라 양자화 대상 이름이다(ARM 맥에서도 돈다). 색인(HNSW)은 만들지 않았다: 워크스페이스당 수만 행을 넘으면 `hnsw.iterative_scan`과 함께 도입한다.
