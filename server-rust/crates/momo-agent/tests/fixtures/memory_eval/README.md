# 팀 기억 평가 세트 (MEM-M0, #3160)

계획 `claudedocs/memory-research/plan.md` §8의 골격. 전부 합성 데이터이며 실제 팀 대화는 쓰지 않는다.

| 파일 | 역할 |
|---|---|
| `tests/eval_kit/corpus.rs` | 시드 고정 생성기(`SEED`, 400건: 결정 30(10 변경)·약속 20·잡담·봇 20·에이전트 6·시크릿 모양 8·`#hr`/DM 카나리) |
| `labels.json` | 정답 라벨(결정 현재값·옛값·유효 기간·근거 id, 약속·담당, 저장 금지 id, 누수 카나리·단정, 질의 30, 기준 수치). 시크릿 값은 없음 |
| `tests/eval_kit/harness.rs` | `MemoryBackend` trait + 검사 함수(`leak_violations`, `decision_score`, `commitment_recall`, `policy_and_provenance_violations`) |
| `tests/eval_kit/reference.rs` | 기준 모델(제품 아님, 결함 스위치로 검사기가 실패할 수 있음을 증명) + `product_backend()` 이음새 |
| `tests/eval_kit/pg.rs` | 권한 누수 시나리오 PG 시드(`send_message_in_tx` 경유) |

- 시험: `memory_eval.rs`(DB 없음, 게이트에 포함), `memory_eval_pg.rs`(`--ignored`, 격리 PG).
- `--ignored` 로 돌리면 `red_*` 가 실패해야 한다(제품 구현 없음). M1~M3 가 `product_backend()` 를 채우고 축별로 ignore 를 푼다.
- 시크릿 모양 문자열은 런타임 조립이라 저장소에 없다. 확인용 덤프: `MEMORY_EVAL_DUMP=<dir> cargo test -p momo-agent --test memory_eval optional_corpus_dump`.
- 라벨 재생성: `MEMORY_EVAL_BLESS=1 cargo test -p momo-agent --test memory_eval committed_labels`.
- 한국어 검색 축(§8.4, 질의 50쌍)은 #3159 fixture 소유. 여기서 만들지 않고, 그 파일이 정해지면 `labels.json` 의 `thresholds.korean_search_fixture` 를 그 경로로 바꾼다.

- #3168(M2): `product_backend()` 는 등록 방식이다(`register_product_backend`). `momo-agent-worker/tests/memory_eval_items_pg.rs` 가 실제 요약 워커 + 실제 PG 로 items 경로를 등록해 누수 8단정과 수집 정책·출처를 돌린다(격리 PG, `--ignored`). 의사결정 추적(§8.2)·약속 재현은 M3 까지 `NotImplemented`. 단정 7(다른 채널 문구)은 **요청자 본인의 에이전트 DM 에서만** ADR-0196 D6-4 의 권한 합집합을 허용한다(그룹 채널은 그대로 금지).
