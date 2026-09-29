# MEM-M3 벡터 검색 평가 스파이크 (#3173, 1단계)

- 날짜 2026-09-30 · 트랙 엔진 · ADR-0196 D5(RRF k=60)·D8(임베딩 제공자는 **평가 뒤** 결정, 성재 확인) · 계획 `claudedocs/memory-research/plan.md` Q7
- **제품 코드·마이그레이션·`embedding` 칼럼 없음.** 이 문서는 D8의 결정을 위한 측정이다. 결정과 구현(2단계)은 성재 확인 뒤에 한다.
- 벤치: `server-rust/bench/mem-vector-search/` (워크스페이스 밖 독립 크레이트, 자체 `[workspace]`·`Cargo.lock` → 서버 `Cargo.lock`·GHCR 고지 번들 불변). 결과 원본 `results-2026-09-30.json`. 모델 가중치·캐시는 레포에 없다(`.gitignore`, 스크래치 `~/.cache/momo-scratch/3173/models`).
- 재현
  1. `cargo build --release` (임베딩; fastembed가 모델을 HF에서 내려받음)
  2. `python3 ../kr-keyword-search/gen_corpus.py --out <dir> --scale 50000` → M0 코퍼스 900건 + 잡음 5만 건(M0 `fixtures/`와 바이트 동일함을 `cmp`로 확인) 이어붙여 `docs_all.jsonl`
  3. `python3 gen_deficit_queries.py` (결손 질의 46건, 시드 20260930)
  4. `mem-vector-search-bench <모델> <캐시> <출력접두> docs_all.jsonl queries_all.jsonl`
  5. `python3 run_eval.py --docs … --emb … --probe-emb … > results.json` (격리 PG `3173-pg` = `pgvector/pgvector:pg18` → PG 18.4, pgvector 0.8.5, `--shm-size=2g`; 끝나면 `docker rm -f -v`), `run_exact_scan.py`, `report.py`

## 0. 결론 먼저

| | 내용 |
|---|---|
| **권고** | **② 로컬 소형 다국어 모델 = `intfloat/multilingual-e5-small`(MIT, 384차원) int8 ONNX**를 **agent-worker(서빙 경로)**에서 돌리고, 융합은 **가중 RRF(키워드 ×2 : 벡터 ×1, k=60)**. 키워드(pg_trgm)는 그대로 1차 신호다. 브라우저용 검색(API 프로세스)은 M3에서는 키워드만. |
| 근거 요약 | 키워드는 표기가 겹치는 질의에서 이미 recall 0.93~1.0이지만 **바꿔 말하기·외래어 표기는 0.00**, 약어 풀이·질문형은 0.46/0.18(잡음 5만 건에선 0.06/0.10). 로컬 e5-small은 손으로 쓴 12건 점검에서 **top-1 10/12(키워드 5/12)**, 융합 11/12. 제공자 API(①)는 프리셋 4종 중 **2종만** 임베딩 엔드포인트가 있고, 전 기억 본문이 외부로 나가며 API 프로세스 「HTTP 0」 불변식과 부딪힌다. |
| 정직한 한계 | 합성 코퍼스에서는 벡터 융합의 **전체 recall 이득이 작다**(풀 900건: 0.557→0.632 융합, 잡음 5만 건: 0.501→0.504, 가중 융합은 0.501). 이득은 「바꿔 말한 질의」에 몰리고, 이미 풀리던 종류(조사·띄어쓰기)에서는 비가중 RRF가 0.93→0.87로 깎는다 → **가중 융합이 사실상 필수**. ③(키워드 유지)도 방어 가능한 선택이다. |
| 성재 결재 필요 | ② 채택 여부, 모델 크기(e5-small int8 vs bge-m3), 배포 이미지에 모델 118 MB·ONNX Runtime을 싣는 것(빌드 시 외부 다운로드 의존). |

## 1. 방법

- **코퍼스**: M0 합성 900건(개념 50개 = 낱말 짝 (A, B), 정답은 A·B를 함께 담은 8건). 「pool」 = 900건만 / +잡음 1만 / +잡음 5만. 운영에서는 질의가 뷰어의 멤버십 채널로 이미 좁혀지므로(`mem_search_items_core`) **pool 900이 가장 운영에 가깝고**, 5만 건은 최악(좁히기 없음) 시나리오다.
- **질의 96건** = M0 50건(조사·2음절·띄어쓰기·영문 혼용·오타) + **결손 46건**(이번에 추가, 코퍼스는 무변경, 정답 라벨은 M0 그대로):

  | 종류 | 건수 | 만드는 법 | 예 |
  |---|---|---|---|
  | `synonym` | 12 | A·B를 코퍼스에 **없는** 유의어로 | 「품의 구상」 (결재·기획) |
  | `translit` | 12 | A·B를 영문/외래어 표기로 | 「approve schedule」 (승인·일정) |
  | `abbrev` | 10 | 약어 A(PR·QA…)를 풀어쓰고 B는 그대로 | 「pull request 정산」 |
  | `question` | 12 | 의문문으로 재서술, A 그대로 + B 유의어 | 「채용 얘기하다가 반영 건은 어떻게 됐어?」 |

  생성기가 치환어가 코퍼스에 부분 문자열로도 없음을 검사한다(`gen_deficit_queries.py`, 실패하면 종료; 실제로 「심의」가 걸려 「따져보기」로 바꿨다).
- **키워드 기준선 두 가지**
  - `kw_current`: `server/Migrations/104_mem_item.sql`의 `mem_search_items_core`의 낱말 분해(최대 8, 길이≥2)·조사 제거 정규식·`word_similarity ≥ 0.5`·낱말별 최대 유사도 합 순위를 **그대로 옮긴 SQL 함수**(`run_eval.py`의 `kw_cur`). 함수 자체가 아니다: RLS·`readable_by`·청중 좁히기는 없다.
  - `kw_bigram`: M0 후보 1(공백 낱말 + 한글 bigram → `simple` tsvector, `to_tsquery` OR, `ts_rank_cd`). Rust 토크나이저의 **Python 이식**이다(lindera 미포함).
- **벡터**: 모델별 정확 코사인(numpy). e5 계열은 `query: `/`passage: ` 접두. **RRF k=60**(ADR-0196 D5) 상위 50 후보끼리 융합, 최종 상위 10.
- **지표**: recall@10 = 상위 10 안의 정답 수 / min(10, 정답 수), MRR(상위 10). 측정기 점검: 오라클 1.0·빈 결과 0.0이 아니면 러너가 멈춘다. 참고 지표 `word_hit@10` = 상위 10 중 개념 낱말 A 또는 B(원래 표기)를 담은 문서 비율 — **짝을 못 맞춰도 의미상 가까운 문서를 가져왔는가**. `synonym`·`translit`에서만 의미가 있다(`abbrev`·`question`은 한쪽 낱말을 그대로 써서 키워드도 높게 나온다).
- **환경**: Apple M5 Pro 18코어, macOS, **CPU만**(ONNX Runtime 기본 CPU EP), 다른 작업이 도는 개인 맥(load ≈ 3~4). 지연은 단일 프로세스 순차 측정이다.

## 2. 결손 분석 — 키워드만으로는 무엇을 놓치는가

pool 900(운영에 가까운 좁혀진 범위), 칸 = recall@10 / MRR.

| 종류 | `kw_current` (pg_trgm) | `kw_bigram` (M0 1) |
|---|---|---|
| 조사 변형 (M0) | 1.00 / 1.00 | 0.55 / 0.91 |
| 두 음절 (M0) | 1.00 / 1.00 | 1.00 / 1.00 |
| 띄어쓰기 (M0) | 0.97 / 1.00 | 1.00 / 0.95 |
| 영문 혼용 (M0) | 1.00 / 1.00 | 1.00 / 1.00 |
| 오타 (M0) | 0.70 / 0.76 | 0.17 / 0.39 |
| **유의어·바꿔 말하기** | **0.00 / 0.00** | **0.00 / 0.00** |
| **영문/외래어 표기 (디플로이·deploy↔배포)** | **0.00 / 0.00** | **0.00 / 0.00** |
| **약어 풀이** | **0.46 / 0.44** | 0.28 / 0.32 |
| **질문형 재서술** | **0.18 / 0.34** | 0.05 / 0.22 |
| M0 5종 평균 (50건) | 0.94 | 0.74 |
| 결손 4종 평균 (46건) | 0.15 | 0.07 |
| 전체 (96건) | 0.557 / 0.585 | 0.423 / 0.504 |

- M0 5종의 0.94는 #3200 본문의 「~0.94」와 일치한다(이식이 맞다는 점검).
- 결손은 진짜다: 낱말이 겹치지 않으면 trgm·bigram 모두 0. 약어·질문형은 한쪽 낱말이 남아 있어 부분적으로 걸리지만 **잡음이 늘면 무너진다**(pool 5만: 약어 0.06, 질문형 0.10 — 남은 낱말이 잡음 문서 수천 건과도 일치).
- 현행 키워드 지연(워크스페이스 좁히기 없음, 전체 테이블): 900건 p50 4.6 ms / p95 17.4 ms, 1.09만 건 52.6 / 207 ms, 5.09만 건 236 / 941 ms. 멤버십 좁히기 뒤에는 훨씬 줄어야 한다(M0·#3200과 같은 결론, 여기서 재측정하지 않음).

## 3. 로컬 임베딩 옵션

### 3.1 라이선스 (원천 확인, 2026-09-30)

| 대상 | 라이선스 | 근거 | 판정 |
|---|---|---|---|
| `fastembed` 7.1.0 (fastembed-rs) | Apache-2.0 | [crates.io/crates/fastembed](https://crates.io/crates/fastembed) 메타데이터(`cargo metadata`) | OK |
| `ort` / `ort-sys` 2.0.0-rc.13 | MIT OR Apache-2.0 | `cargo metadata`, [ort.pyke.io](https://ort.pyke.io) | OK — **`rc` 버전**(안정판 아님)이 의존이 된다 |
| ONNX Runtime 1.28 (바이너리) | MIT | [microsoft/onnxruntime LICENSE](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) | OK. 단 `ort-sys`가 빌드 때 **`cdn.pyke.io`에서 미리 빌드한 정적 라이브러리를 내려받는다**(빌드 로그 확인). pyke 문서에 이 바이너리의 별도 귀속 문구는 없다 |
| `tokenizers` 0.23.2, `hf-hub` 0.5.0, `ndarray` 등 전이 의존 338개(기본 feature) | 전부 permissive 표기, **예외 1개**: `option-ext` **MPL-2.0**(`hf-hub → dirs → dirs-sys`) | `cargo metadata --locked` | `default-features = false`(hf-hub 제거, 모델은 벤더링)로 **사라진다**(임시 크레이트로 확인: 의존 123개 전부 MIT/Apache/BSD/ISC/Zlib/Unicode/CDLA-Permissive-2.0/Unlicense) |
| `intfloat/multilingual-e5-small` (384d) | **MIT** | [HF API 메타데이터](https://huggingface.co/api/models/intfloat/multilingual-e5-small) `license: mit`, [모델 카드](https://huggingface.co/intfloat/multilingual-e5-small) | OK. 학습 데이터 출처 감사는 안 했다 |
| `intfloat/multilingual-e5-base` (768d) | MIT | [HF API](https://huggingface.co/api/models/intfloat/multilingual-e5-base) | OK (측정만) |
| `BAAI/bge-m3` (1024d) | MIT | [HF API](https://huggingface.co/api/models/BAAI/bge-m3), [모델 카드](https://huggingface.co/BAAI/bge-m3) | OK (측정만; 가중치 2.27 GB) |
| `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (384d) | Apache-2.0 | [HF API](https://huggingface.co/api/models/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2) | 라이선스는 OK, **품질로 탈락**(아래). fastembed는 `Xenova/…` 변환본을 받는데 그 저장소는 **라이선스 표기가 없다**([페이지](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2)) → 쓴다면 원저장소(sentence-transformers, 자체 `onnx/` 포함)를 가리켜야 한다 |
| `Alibaba-NLP/gte-multilingual-base` (768d) | Apache-2.0 ([HF API](https://huggingface.co/api/models/Alibaba-NLP/gte-multilingual-base)) | | **제외 — 기술 사유**: `trust_remote_code=True` 필요, 저장소에 ONNX 파일 없음(`model.safetensors`만) → fastembed로 못 쓴다. 측정하지 않았다 |
| CC-BY-NC 등 비상업 | 이번 후보 중 **없음** | | |

`multilingual-e5-large`(fastembed는 `Qdrant/…` 변환본 사용)는 측정하지 않았다.

### 3.2 품질 — 단독과 융합 (recall@10 / MRR)

pool 900, 전체 96건. 「M0」 = 5종 평균, 「결손」 = 4종 평균.

| 후보 | 전체 | M0(50) | 결손(46) | 유의어 | 외래어 | 약어 | 질문형 |
|---|---|---|---|---|---|---|---|
| kw_current (기준) | 0.557 / 0.585 | 0.94 | 0.15 | 0.00 | 0.00 | 0.46 | 0.18 |
| e5-small 벡터 단독 | 0.604 / 0.756 | 0.87 | 0.32 | 0.14 | 0.21 | 0.64 | 0.34 |
| e5-small int8 벡터 단독 | 0.604 / 0.741 | 0.86 | 0.32 | 0.12 | 0.24 | 0.65 | 0.33 |
| **e5-small RRF(벡터+kw_current)** | 0.632 / 0.743 | 0.93 | 0.31 | 0.14 | 0.21 | 0.62 | 0.31 |
| e5-small **가중** RRF(벡터×1+kw×2) | 0.624 / 0.739 | 0.94 | 0.28 | 0.14 | 0.21 | 0.60 | 0.24 |
| e5-small RRF(벡터+kw+bigram) | 0.592 / 0.696 | 0.90 | 0.26 | 0.12 | 0.21 | 0.55 | 0.20 |
| minilm 벡터 단독 | 0.245 / 0.402 | 0.34 | 0.14 | 0.10 | 0.14 | 0.25 | 0.08 |
| minilm RRF(+kw_current) | 0.456 / 0.632 | 0.66 | 0.23 | 0.10 | 0.14 | 0.57 | 0.17 |
| e5-base 벡터 단독 | 0.638 / 0.820 | 0.84 | 0.42 | 0.36 | 0.32 | 0.53 | 0.49 |
| e5-base RRF(+kw_current) | 0.663 / 0.779 | 0.92 | 0.39 | 0.36 | 0.32 | 0.60 | 0.29 |
| bge-m3 벡터 단독 | 0.665 / 0.811 | 0.83 | 0.49 | 0.28 | 0.51 | 0.71 | 0.50 |
| bge-m3 RRF(+kw_current) | 0.684 / 0.796 | 0.92 | 0.43 | 0.28 | 0.51 | 0.68 | 0.29 |

같은 표, 잡음 5만 건을 더한 최악 시나리오(pool 50,900):

| 후보 | 전체 | M0(50) | 결손(46) | 유의어 | 외래어 | 약어 | 질문형 |
|---|---|---|---|---|---|---|---|
| kw_current | 0.501 / 0.540 | 0.93 | 0.04 | 0.00 | 0.00 | 0.06 | 0.10 |
| e5-small 벡터 단독 | 0.430 / 0.576 | 0.71 | 0.12 | 0.00 | 0.10 | 0.31 | 0.09 |
| e5-small RRF(+kw_current) | 0.504 / 0.576 | 0.87 | 0.11 | 0.00 | 0.10 | 0.24 | 0.12 |
| e5-small 가중 RRF(×1:×2) | 0.501 / 0.564 | 0.90 | 0.07 | 0.00 | 0.10 | 0.06 | 0.10 |
| e5-small RRF(+kw+bigram) | 0.536 / 0.609 | 0.90 | 0.14 | 0.00 | 0.10 | 0.39 | 0.10 |
| bge-m3 벡터 단독 | 0.448 / 0.636 | 0.67 | 0.21 | 0.12 | 0.20 | 0.40 | 0.16 |
| bge-m3 RRF(+kw_current) | 0.525 / 0.637 | 0.85 | 0.17 | 0.12 | 0.20 | 0.29 | 0.10 |

`word_hit@10`(짝은 못 맞춰도 의미상 가까운 문서를 가져왔는가), pool 900, 유의어/외래어: kw_current 0.00/0.00, e5-small 0.41/0.50, e5-base 0.62/0.63, bge-m3 0.59/0.86, minilm 0.39/0.57. 즉 벡터는 recall이 낮아 보여도 의미상 가까운 문서를 실제로 가져온다(키워드는 0). recall은 「A·B 짝을 함께 담은 문서만 정답」이라는 라벨 조건 때문에 의미 검색을 **과소평가**할 수 있다. 전체 표는 `results-2026-09-30.json`(`quality`, `models.*.quality`), `python3 report.py results-2026-09-30.json`로 다시 뽑는다.

**읽는 법**
1. 벡터는 결손에서 키워드가 못 하는 일을 한다(0 → 0.14~0.51, 모델이 클수록 좋음). 그러나 **조사·오타 같은 M0 종류에서는 단독으로 키워드보다 약하다**(0.87 vs 0.94, 잡음에서 0.71 vs 0.93).
2. 동등 가중 RRF는 M0 종류를 살리지만 잡음에서 약간 깎는다(0.93 → 0.87). **키워드 ×2 가중**이면 M0가 0.90~0.94로 유지된다. 대신 결손 이득이 줄어든다(잡음에서는 약어·질문형이 키워드 수준으로 되돌아옴). 「키워드가 충분히 잘 맞았으면 벡터는 채우기만」이라는 게이팅이 더 나을 수 있으나 **이번에 측정하지 않았다** — 2단계 튜닝 항목이다.
3. bigram을 3번째 신호로 얹으면 잡음에서 오타(0.49→0.72)·약어가 오르지만 조사가 떨어진다(0.93→0.79). 이득이 일관되지 않아 권고에 넣지 않는다.
4. **`paraphrase-multilingual-MiniLM-L12-v2`는 단독 0.245로 탈락**한다(짧은 낱말 질의를 못 다룸). 라이선스(Apache-2.0)는 문제없다.
5. e5-small **int8 양자화**(`onnx/model_qint8_avx512_vnni.onnx`, 118 MB)는 fp32와 recall이 같다(0.604/0.604, 손글씨 점검 동일). 배포 후보는 int8.

### 3.3 손글씨 점검 (합성 코퍼스 한계 가늠용, 지표 아님)

손으로 쓴 한국어 팀 기억 12건 + 낱말이 거의 겹치지 않는 바꿔 말한 질의 12건(`fixtures/probe.json`; 예: 「배포 미루기로 함」 → 「4월 릴리스는 QA 일정 때문에 다음 달로 연기하기로 결정했어요」). 12건 안에서 정답 항목의 순위.

| | top-1 | 찾음(12 중) | MRR |
|---|---|---|---|
| kw_current | 5 | 6 | 0.458 |
| minilm 단독 / +RRF | 4 / 7 | 12 / 12 | 0.488 / 0.724 |
| **e5-small 단독** (int8 동일) | **10** | 12 | 0.889 |
| **e5-small + RRF(kw)** | **11** | 12 | 0.931 |
| e5-base 단독 / +RRF | 11 / 11 | 12 | 0.927 |
| bge-m3 단독 / +RRF | 12 / 12 | 12 | 1.000 |

표본이 12건에 후보도 12건뿐이라 쉬운 점검이다. 그래도 합성 세트의 「짝 라벨」 문제를 걷어내면 **키워드는 절반을 놓치고 e5-small은 거의 다 잡는다**는 방향은 분명하다. 바꿔 말하기가 진짜로 흔한지(사용자가 실제로 이렇게 묻는지)는 이 스파이크로 알 수 없다.

### 3.4 비용 — 지연·크기·메모리 (CPU, 이 맥)

캐시가 데워진 상태에서 잰 값(첫 수치의 「로드」는 HF 다운로드를 뺀 순수 로드).

| 모델 | 차원 | 모델 파일 | 로드 | 문서 1건(배치 1) p50/p95 | 배치 32 처리량 | 질의 p50/p95 | 프로세스 최대 RSS |
|---|---|---|---|---|---|---|---|
| e5-small fp32 | 384 | 470 MB | 0.47 s | 4.0 / 4.7 ms | 784 건/s | 3.6 / 5.2 ms | 1,391 MB |
| **e5-small int8** | 384 | **118 MB** | 0.47 s | 4.8 / 6.0 ms | 655 건/s | 3.4 / 5.8 ms | **978 MB** |
| minilm | 384 | 470 MB | 0.51 s | 4.4 / 5.5 ms | 843 건/s | 3.2 / 5.0 ms | 1,402 MB |
| e5-base | 768 | 1.1 GB | 0.68 s | 7.7 / 9.2 ms | 341 건/s | 6.3 / 7.9 ms | 2,787 MB |
| bge-m3 | 1024 | 2.27 GB | 0.78 s | 20.2 / 22.7 ms | 120 건/s | 18.0 / 21.7 ms | 2,025 MB |

- 항목 본문 하나를 임베딩하는 데 ≈ 4~5 ms(단건) 또는 ≈ 1.5 ms(배치): 추출 잡 빈도(사람당 하루 수십 건)에서는 무시할 수 있다. 백필 5만 건 ≈ 1분(e5-small 배치 처리량 898 건/s, 5만 900건 임베딩 실측).
- RSS는 배치 32 기준 최대치(ORT 작업 영역 포함)이고, 배치를 줄이면 내려갈 가능성이 크지만 **측정하지 않았다**. Railway 인스턴스 크기는 x86 Linux에서 다시 재야 한다(**runtime-unverified**: ARM 맥의 CPU 결과, `avx512_vnni`라는 int8 파일 이름과 달리 ARM에서 돌았고 x86 속도는 미측정).
- 크레이트: 릴리스 바이너리 33.6 MB(정적 ONNX Runtime 포함, 모델 제외).
- **벤더링**: 모델은 git에 넣지 않는다(118 MB). 이미지 빌드 단계에서 HF 리비전 SHA를 고정해 내려받고 sha256을 검증하거나 릴리스 자산으로 두는 방식이 필요하다. `ort-sys`의 미리 빌드된 정적 라이브러리 다운로드(`cdn.pyke.io`)는 M0의 lindera 사전 다운로드(`Lindera.dev`)와 **같은 종류의 빌드 외부 의존**이다. 완화: `ort-load-dynamic` + Microsoft 릴리스의 공유 라이브러리를 sha256으로 고정, 또는 CI 캐시.

### 3.5 pgvector — 크기·지연·필터 (`pgvector/pgvector:pg18`, pgvector 0.8.5)

HNSW `m=16, ef_construction=64`, 코사인, `ef_search=40`. 질의 96개 × 3회. 데이터는 **실제 임베딩**(M0 900건 + 템플릿 잡음). 잡음 문장이 템플릿이라 분포가 실제 대화보다 뭉쳐 있다 — ANN 재현율은 실제보다 낮게 나올 수 있다.

| 모델(차원) | 항목 수 | 인덱스 | 테이블 | 빌드 | 질의 p50/p95 | ANN 재현율@10 |
|---|---|---|---|---|---|---|
| e5-small (384) | 1k | 2.1 MB | 2.1 MB | 0.2 s | 0.23 / 0.25 ms | 1.00 |
| | 10k | 20.5 MB | 16.8 MB | 0.7 s | 0.34 / 0.46 ms | 0.98 |
| | 50k | 102 MB | 82 MB | 4.1 s | 0.40 / 0.72 ms | 0.92 |
| e5-base (768) | 50k | 205 MB | 210 MB | 17 s | 0.62 / 0.98 ms | 0.93 |
| bge-m3 (1024) | 1k / 10k | 8.2 / 81.9 MB | 5.7 / 56.4 MB | 0.3 / 3.7 s | 1.16 / 0.62 ms | 1.00 / 0.97 |
| | 50k | 409 MB | 280 MB | 21 s | 0.73 / 1.26 ms | 0.92 |

(인덱스 크기는 차원에 거의 선형: 항목당 e5-small ≈ 2 KB, bge-m3 ≈ 8 KB. 나머지 모델·크기는 JSON.)

**필터 질의(워크스페이스 1/50로 좁힘) — 운영에서 가장 중요한 결과**

| e5-small, 워크스페이스 = 항목의 1/50 | 재현율 | 반환 행 수(평균, 목표 10) | 질의 p50/p95 | 계획 |
|---|---|---|---|---|
| HNSW + `WHERE workspace = …` (기본) | **0.10** (5만) / 0.08 (1만) | **1.0** | 0.43 ms | HNSW 색인 사용 후 사후 필터 |
| + `hnsw.iterative_scan = relaxed_order` | 0.99 / 0.99 | 10 | 4.5 / 6.4 ms (5만) | HNSW 색인 |
| 색인 없이, `workspace` btree로 좁힌 행만 **정확 스캔** (워크스페이스당 1,000행) | 1.00(정확) | 10 | **0.49 / 1.02 ms** | Bitmap Heap Scan → Sort |
| 같은, 워크스페이스당 5,000행 | 1.00(정확) | 10 | 3.0 / 3.8 ms | 〃 |
| bge-m3 1,000행 / 5,000행 | 1.00(정확) | 10 | 2.1 / 2.8 ms · 10.0 / 10.9 ms | 〃 |

- **기본 HNSW는 필터 질의에서 10개를 내야 할 자리에 평균 1개를 낸다**(후보 40개를 뽑은 뒤 필터). 이 기능은 「워크스페이스·멤버십으로 좁힘」이 본질이므로 그대로 쓰면 조용히 결과가 비는 함정이다. e5-base·bge-m3에서는 플래너가 HNSW 대신 정확 스캔을 골라 재현율 1.0이 나왔다 — **계획이 모델·통계에 따라 뒤바뀐다**는 증거이기도 하다.
- 결론: M3 규모(워크스페이스당 수천 행)에서는 **ANN 색인이 필요 없다.** 멤버십으로 좁힌 후보에 대한 정확 코사인이 0.5~3 ms(384d)다. 색인은 워크스페이스당 항목이 수만 개를 넘을 때 `iterative_scan`과 함께 도입한다.

## 4. 제공자 API 옵션 (실제 호출·키 사용 없음)

### 4.1 우리가 지원하는 제공자와 임베딩 엔드포인트

프리셋 4종은 ADR-0004 증보 5 D5 표, 봉인 kind와 wire는 ADR-0147 증보 2026-09-27이다. 제공자 문서는 2026-09-30에 확인했다.

| 프리셋 | wire | 임베딩 엔드포인트 | 근거 |
|---|---|---|---|
| `openai` | chat/completions | **있음** `POST /v1/embeddings`: `text-embedding-3-small` 1536d(문서 표기 $0.016 / 1M 토큰), `-large` 3072d($0.104), 8,192 토큰, `dimensions`로 축소 가능 | [OpenAI 임베딩 가이드](https://developers.openai.com/api/docs/guides/embeddings) (가격은 문서 표기이며 재확인 필요) |
| `openrouter` | chat/completions | **있음** `POST /embeddings`(OpenAI 호환, 예 `openai/text-embedding-3-small`) | [OpenRouter API 레퍼런스](https://openrouter.ai/docs/api-reference/embeddings/create-embeddings) |
| `anthropic` | Messages | **없음.** 「Anthropic does not offer its own embedding model」 — Voyage AI를 권장(별도 회사·별도 키·`api.voyageai.com`) | [Claude 문서 Embeddings](https://platform.claude.com/docs/en/build-with-claude/embeddings) |
| `xai` | chat/completions | **공개 REST 임베딩 없음**(모델 문서에 임베딩 항목 없음; gRPC API에는 임베딩 모델 조회 호출이 있으나 우리의 `openai` wire로는 못 부른다) | [xAI 모델 문서](https://docs.x.ai/docs/models), 웹 검색 결과 — 낮은 확신, 제공자 쪽 변경 가능 |

→ **Anthropic 또는 xAI로 팀 에이전트를 쓰는 팀은 임베딩용 링크를 따로 하나 더 만들어야 한다**(OpenAI/OpenRouter 키 또는 Voyage 키). 봉인 kind에 「Voyage」 wire도 새로 필요하다.

### 4.2 평가

| 항목 | 평가 |
|---|---|
| 품질 | **측정하지 않았다**(키 없음, 유료 호출 금지). 대리로 e5/bge-m3를 썼다: 「좋은 다국어 임베딩이면 유의어·외래어 recall이 0 → 0.3~0.5 수준」까지는 대리로 말할 수 있고, OpenAI `text-embedding-3-small`이 bge-m3와 비슷한 급이라는 것은 일반 지식이라 이 문서의 수치가 아니다. |
| 프라이버시 | **모든 기억 본문(백필 포함)이 제공자로 나간다.** 채팅 답에는 이미 청중 좁힌 항목만 나가지만, 임베딩은 **저장 시점에 전량**이다. 회사 방침·인사 내용이 들어 있는 비공개 채널 기억도 포함. ADR-0196 D9의 동의 스위치·제공자 항목과 함께 설계해야 하고, 기억을 「잊기」할 때 제공자 쪽 잔존은 우리가 통제하지 못한다. |
| 비용 | 사실상 무시: 항목당 ~60토큰을 가정하면 100만 건 = 6천만 토큰 ≈ $1 (small, 위 표기 단가로 계산한 산술이며 실측 아님). 문제는 돈이 아니라 프라이버시·가용성·키 한 개 더. |
| SSRF/이그레스 | 임베딩 호출도 **같은 가드 클라이언트**(`GuardedResolver`, redirect 없음, 프록시 없음, 사설 주소 거부; ADR-0004 증보 5 D2·D3)를 타야 한다. 프록시 전용 이그레스 배포는 끊긴다(증보 5 D3). `momo-egress` 허용 목록/`egress_use` 원장 정책에 「임베딩 호출」을 새 용도로 넣는 결정이 필요하다. |
| 불변식 충돌 | **ADR-0147 결정 4: API 프로세스는 HTTP 0.** 브라우저 검색(`mem_search_items`)은 API 프로세스에서 돌므로 **질의 시점 임베딩이 불가능**하다(연결 확인 증보가 좁힌 예외는 봉인 크레이트 경유 GET 한 번). 서빙(agent-worker)만 벡터를 쓸 수 있다. |
| 종속 | 제공자·모델·차원이 바뀌면 전량 재임베딩. 키 만료·한도 초과 시 검색이 조용히 키워드로 떨어진다(장애 표면이 하나 늘어남). |

## 5. 권고

| | ① 제공자 API | **② 로컬 e5-small int8** | ③ 키워드만 |
|---|---|---|---|
| 결손 해소 | 대리 측정상 ②와 비슷하거나 더 좋음(미측정) | 손글씨 점검 top-1 10/12(융합 11/12); 합성: 유의어·외래어 0 → 0.12~0.24 | 유의어·외래어 0, 약어·질문형은 잡음에서 붕괴 |
| M0 종류(조사·띄어쓰기 등) | 가중 융합이면 유지 | 가중 융합이면 0.90~0.94 유지 | 0.93~1.0 |
| 프라이버시 | 본문 전량 외부 전송 | 외부 전송 0 | 0 |
| 프리셋 커버 | 4종 중 2종 | 제공자 무관 | — |
| 불변식 | API 프로세스 HTTP 0과 충돌(브라우저 검색 불가) | worker에서 로컬 연산이라 충돌 없음 | — |
| 이미지/CI | 추가 없음 | 모델 118 MB + ORT 정적 라이브러리(+~30 MB 바이너리), 빌드 시 외부 다운로드 2건 | — |
| 운영 | 키·한도·장애 | RSS ≈ 1 GB(배치 32) 별도 산정 필요 | — |

**② 권고 이유** (1) 프라이버시와 「프리셋 4종 중 2종」 문제가 사라진다. (2) 서빙 경로(worker)에만 필요하다는 점이 불변식과 맞는다. (3) 비용은 항목당 수 ms로 무시 수준이고 int8은 품질 손실이 없었다. (4) `embedding_model`·차원을 행에 기록하면 이후 bge-m3(MIT, 결손에서 더 강함: 외래어 0.21 → 0.51)나 제공자 API로 교체할 길이 열려 있다.

**조건과 「하지 말아야 할 때」**
- 융합은 **키워드 우선 가중**(기본 ×2:×1)이다. 동등 RRF는 조사 질의를 깎는다.
- ③이 맞는 경우: 사용자 질의의 대부분이 원문 낱말을 그대로 쓴다고 판단되면 이득이 작다(합성 5만 건에서 융합의 전체 recall 이득 ≈ 0). 그때는 M3에서 벡터를 빼고 요약·엔티티·시간 신호에 투자한다. 이 판단은 실제 질의 로그가 없어 제품 데이터로는 못 한다 — **성재가 「바꿔 말한 질의」가 흔하다고 보는지**가 결정 변수다.
- 이미지에 118 MB + ONNX Runtime을 싣는 것과 빌드 시 외부 다운로드 2건(HF 모델, cdn.pyke.io 또는 Microsoft 릴리스)을 받아들이는 결재가 필요하다.

## 6. 프로덕션 변경 계획 (2단계; 코드 아님)

1. **마이그레이션(다음 빈 번호; 현재 트랙 최신은 105)**: 새 테이블 `mem_item_embedding(item_id uuid, workspace_id uuid, model text, dims int, embedding vector(384), created_at)` — PK `(item_id, model)`. 칼럼을 `mem_item`에 두지 않는다: pgvector 인덱스는 차원이 고정된 타입이 필요하므로 **모델·차원 변경 = 새 행(다른 `model`)으로 병행 백필 → 전환**이 되도록. 저장 절약이 필요하면 `halfvec`(절반 크기). 
   - RLS FORCE + `workspace_id`. 신규 테이블은 101의 **동적 잠금 블록이 자동으로 순회**해 잠근다(#3200 본문: 새 테이블 2개가 그렇게 잠김)(테이블 권한 없음, `momo_app`·`momo_worker` 직접 읽기 금지 — 임베딩은 텍스트 복원(inversion) 위험이 있어 본문과 같은 등급). 접근은 정의자 함수로만: `mem_set_item_embedding(item, model, dims, vec)`(EXECUTE는 `momo_memory`만, 근거 항목이 같은 워크스페이스·미폐기인지 검사, 멱등) 하나.
   - 항목이 폐기·stale·삭제되면 `readable_by`가 이미 가리고 임베딩 행은 FK `ON DELETE CASCADE`. 「잊기」/초기화(`reset_epoch`)의 전량 삭제 경로에 새 테이블 포함(시험 필요).
   - HNSW는 **만들지 않는다**(3.5 결과). 도입 시점의 기준: 워크스페이스당 항목 수만 개 + `hnsw.iterative_scan = relaxed_order`·`ef_search` 설정을 정의자 함수 `SET`으로 고정.
2. **어디서 임베딩하나**: 항목 추가 `mem_add_item`은 그대로 두고, **요약/추출 워커의 같은 tx 뒤 별도 단계**에서 새 항목을 임베딩해 `mem_set_item_embedding`을 부른다(ONNX 추론 ≈ 5 ms; 실패해도 항목 저장은 성공, 임베딩이 없으면 키워드만으로 검색 — 우아한 저하). 워커는 이미 tx마다 `SET LOCAL ROLE momo_memory`를 쓴다. 모델은 **agent-worker 프로세스**에 상주(API 프로세스와 이미지에는 넣지 않는다).
3. **백필**: 임베딩이 없는 항목을 배치(예: 500건)로 훑는 워커 잡. 처리량 ≈ 900건/s(e5-small), 워터마크·리스는 요약 워커와 같은 방식(tx마다 `SET LOCAL app.workspace_id`). 모델 교체 시에는 새 `model` 값으로 같은 잡을 돌리고 커버리지 100%에서 검색을 전환한다.
4. **검색 융합**: `mem_search_items_core` 안에서 멤버십으로 좁힌 후보에 대해 벡터 정확 거리 상위 N을 구해 키워드 순위와 **가중 RRF(k=60)**로 합친 뒤, 기존처럼 `mem_item_readable_by`·청중 좁히기 루프를 **그 뒤에** 돈다(권한 정의는 여전히 하나, 시험은 「검색 결과 == RLS로 읽히는 행 ∩ 일치」를 벡터 경로에도 적용). 질의 벡터는 서빙 진입점(`mem_search_items_for`, 워커 전용)의 인자로 받는다 — DB가 모델을 부르지 않는다. 브라우저용 `mem_search_items`는 M3에서 키워드만.
5. **NOTICE/고지**(지금은 아무것도 배포하지 않으므로 변경 없음; 채택하면 필요): `NOTICE`·`legal/THIRD_PARTY_NOTICES.md`에 fastembed(Apache-2.0), ort/ort-sys(MIT OR Apache-2.0), ONNX Runtime(MIT, Microsoft), tokenizers(Apache-2.0), 모델 가중치 `intfloat/multilingual-e5-small`(MIT, 저자 귀속) 추가; 전이 의존 약 120개는 `default-features = false`로 permissive만(MPL `option-ext` 제거 확인); `scripts/generate_ghcr_notice_bundle.py generate` → `check_ghcr_notice_bundle.sh` PASS → `legal/generated/GHCR_*` 함께 커밋; 새 크레이트 디렉터리면 `server-rust/Dockerfile` 매니페스트 COPY.
6. **범위 밖/후속**: 브라우저 검색의 벡터화(API HTTP 0 유지 위해 워커 RPC 필요), 게이팅 융합 튜닝, 실제 질의 로그 기반 평가, x86 Linux(Railway)에서의 지연·RSS 재측정, ADR-0196 D8 증보와 ADR-0100 참조(공개 API·DB 계약 변경이므로 Accepted ADR이 머지 조건).

## 7. 한계 (읽을 때 유의)

- **합성 코퍼스**: 템플릿 문장에 낱말 짝 라벨이다. 「짝을 함께 담은 문서만 정답」이라 의미 검색에 가혹하고(recall이 낮게 나옴), 잡음 문서도 템플릿이라 실제 대화의 어휘 다양성과 분포가 다르다. 절대 수치보다 종류별 상대 비교로 읽을 것. 결손 질의 46건은 우리가 설계한 치환이라 실제 사용자의 바꿔 말하기 분포와 다르다.
- 벡터 단독이 키워드보다 약하게 나오는 M0 종류(조사·오타)는 실제 모델의 한국어 실력이 아니라 이 라벨링(짝 조건) 때문일 수 있다.
- `kw_current`는 함수 본문의 **이식**이다(RLS·`readable_by`·청중 좁히기·타이 브레이커 `valid_to`/`recorded_at` 없음). `kw_bigram`은 lindera 없이 Python 이식이다.
- 제공자 API 품질·지연은 측정하지 않았고(유료 호출 금지), 제공자 문서 인용은 2026-09-30 시점이다. xAI 임베딩 부재는 낮은 확신.
- 단일 맥·순차·load 3~4 환경. RSS는 프로세스 최대치(배치 32 포함). x86 Linux/Railway는 **runtime-unverified**.
- 손글씨 점검은 12건이다.
- 모델 가중치의 학습 데이터 출처 라이선스는 감사하지 않았다(카드에 표기된 모델 라이선스만 확인).
