# UXC-A 프로듀서 핸드오프 패킷 — 완료 리포트의 서버 저작 트리거·파이프라인

> 2026-08-17 Fable 발급 · Status: `ready` · 워커: 단발 무명 Opus 5.
> planning ID: **PLN-20260815-01** (owner: Fable · integrator: momo-main) · supersedes: 없음
> 정본 goal: GitHub Issue **#1454**(status:ready — metadata-only binding). 수용기준 정본 = 본 패킷 §4.
> 근거: ADR 불요(#1440 동결 경계의 해제 — 카드 kind 추가의 프로듀서 반쪽, 경계 무변경). 병렬: **#1441(웹 세션 칩)과 병렬 — 파일군 분리(server-rust vs 웹/코어), 머지 순서 무관**.
> 기준 커밋: **`track/engine@54f5d2dc`**(#1440 완료 리포트 카드 랜딩 HEAD).

## 1. 미션 요약 (왜 이 작업인가)

#1440이 완료 리포트 카드의 **소비자 반쪽**을 랜딩했다: 코어 계약(`completionReportCard.ts` — 파싱·집계·톤 역할)+웹/폰 렌더+방출 계약(props 스키마). 동결로 남긴 것이 **프로듀서 반쪽** — 서버 워커가 턴 종료 시 리포트를 **언제·어떻게** 저작하는가. `loginHandoffCard.ts`가 계약이고 `approval.rs`가 프로듀서인 격이며, 코어 픽스처 `REPORT_PROPS`가 맞출 봉투를 이미 핀해 후속은 기계적이다(#1454 이슈 본문).

세 조각:
1. **트리거·저작 설계 1문단**(PR 본문 첫 절): 어떤 턴이 리포트를 받는가(모든 턴? 긴 작업? 모델 판단?)·누가 요약/불릿/게이트 표를 쓰는가(모델이 구조화 산출 — 서버는 검증·전달만, 내용 조작·날조 금지)·`elapsed_ms`의 원천(서버 관측 시각 — 모델 자기보고 아님).
2. **워커 프로듀서 배선**: 에이전트 턴 메시지에 `props.kind = "completion_report"` 봉투를 실어 방출. **새 MessageType·마이그레이션·새 원장 금지** — 평범한 턴 메시지의 props다(#1440 커밋 메시지·코어 머리말이 정본). 방출은 단일 쓰기경로(REST→PG→outbox→relay) 그대로.
3. **실 방출→카드 왕복 conformance**: 프로듀서가 만든 실제 봉투가 코어 계약이 파싱하는 그 형상임을 잰다 — 코어 픽스처 `REPORT_PROPS`(`packages/momo-core/src/features/timeline/completionReportCard.test.ts:35`)와 서버 산출의 키·형이 일치함을 Rust 쪽 conformance 테스트로(선례: `server-rust/bins/momo-server/tests/display_attach_conformance_pg.rs`). +clippy 무회귀(**미호출 빌더 문제 해소** — 기준 커밋에서 clippy를 돌려 미호출 경고의 실체를 먼저 확인하라).

## 2. 필독 코드 좌표 (기준 커밋에서 재확인 — 다르면 코드가 진실, 계약이 다르면 정지+이탈 보고)

- 방출 계약 정본: `packages/momo-core/src/features/timeline/completionReportCard.ts`(kind=`completion_report`·`elapsed_ms`·gates 어휘 pass/fail/skip/pending·동의어 표·상한 MAX_*) · 픽스처 `completionReportCard.test.ts:35`(`REPORT_PROPS`). **이 파일들은 읽기 전용** — #1441이 웹/코어를 만진다, 이 goal은 server-rust만.
- 턴 종료 경로: `server-rust/bins/momo-agent-worker/src/lib.rs`(턴 메시지 방출·`login_handoff` 검사 지점 :1182 근방이 props 취급 선례) · `stream.rs`·`tool_exec.rs`.
- props 저작 선례: `server-rust/crates/momo-agent/src/approval.rs:738,863`(`apply_login_handoff_props` — 단 그쪽은 승인 카드, 이쪽은 **평범한 턴 메시지**라 승인 기계 비접촉).
- 게이트 결과의 원천: 워커가 실제로 아는 것만 싣는다 — 툴 실행 결과(`tool_exec.rs`)에서 온 실측이 아니면 게이트 표를 짓지 않는다. 모델이 산출한 표라면 그것이 모델 저작임이 봉투에서 위조되지 않게(서버가 pass를 지어내지 않는다).

## 3. 지켜야 할 계약

- Postgres=SoT·단일 쓰기경로·순서=`message.seq`·에이전트=`member`·RLS FORCE·`schema_v0.sql` 비접촉. **마이그레이션 금지**(이 goal은 스키마 무변경이 계약).
- 코어 파싱 상한(MAX_COMPLETION_ACTIONS 100 등)을 프로듀서가 초과 방출하지 않게 상한 인지(초과분은 클라가 정직 절단하지만, 프로듀서가 일부러 수천 개 싣는 설계 금지).
- 정직 규율(ADR-0132): 없는 게이트 결과를 짓지 않는다·skip과 fail을 접지 않는다·`elapsed_ms`는 서버 관측.
- provider 자격증명 비유입(ADR-0004) — 리포트 본문에 시크릿·자격이 새지 않게(모델 산출 여과는 기존 여과 계약 재사용, 신설 금지·부재 시 이탈 보고).
- 클라(웹/폰/코어) 파일 비접촉 — 렌더·계약 변경이 필요해 보이면 그건 이탈이다.

## 4. 수용기준 (정본)

1. 트리거·저작 설계 1문단이 PR 본문에 있고 구현과 일치.
2. 워커 프로듀서 배선 — 실제 턴 종료 경로에서 `completion_report` props 방출(단일 쓰기경로·스키마 무변경).
3. 실 방출→카드 왕복 conformance 테스트 그린(서버 산출 봉투 ↔ 코어 `REPORT_PROPS` 형상 일치).
4. `cargo clippy` 무회귀(미호출 빌더 문제 해소 포함)·기존 서버 스위트 그린.

## 5. 알려진 함정 / 컨텍스트

- **미호출 빌더**: 이슈 본문이 "clippy 무회귀(미호출 빌더 문제 해소)"를 명시 — 기준 커밋에서 `cargo clippy`를 먼저 돌려 어떤 심볼이 미호출인지 실측하고, 이 goal의 배선으로 자연 해소되는지/별개인지 PR에 기록.
- outbox 발행 payload에 props 탑재 확인(템플릿 §5.1-6 — REST↔outbox 일치 단정, X-9 전례).
- 턴 메시지에는 이미 `usage`가 실린다(코어 머리말) — 같은 봉투에 얹는 것이지 새 봉투가 아니다. props 병합 시 기존 키를 밟지 않게.
- `login_handoff`는 승인 카드(별도 기계) — 동형 복사하다 승인 hold 기계를 끌고 오지 말 것. 완료 리포트에는 결정이 없다(코어 머리말 "이 카드가 그리지 않는 것").
- 공통 함정은 템플릿 §5.1 전항 적용(특히 게이트 후 `momo-docker-reclaim.sh`).

## 6. 검증

- `scripts/local_gate.sh --profile swift` + `cargo clippy` + 서버 conformance 테스트.
- 가능하면 로컬 실기동으로 실 방출 1건→웹 카드 렌더 확인(불가하면 conformance로 갈음하고 PR에 명시 — 정직 라벨).

## 7. 이탈 보고 의무

수용기준·계약과 다르게 구현하게 되면 PR `## 계획 이탈` 섹션에 기록. 판단 필요 시 `scripts/goal_release.sh 1454 --blocked "<사유>"`로 정지. 임의 재설계 금지.

## 8. 착수 절차

```bash
scripts/goal_status.sh
scripts/goal_claim.sh 1454
# 구현 → 게이트 → PR(이슈 1개, ## 계획 이탈 섹션 포함) →
scripts/goal_release.sh 1454 --review --pr <PR URL>
# 여기서 정지. merge/close/로드맵은 momo-main 몫.
```

## 9. 컨텍스트 델타 (오케스트레이터/다음 planner용)

- 새로 고정: 프로듀서=server-rust만·스키마 무변경·코어 봉투가 계약 정본(REPORT_PROPS 형상).
- 의도적 미결정: 리포트 저작 트리거의 정확한 조건(워커 설계 1문단으로 상신 — 채택 여부는 리뷰에서 판정).
- 구현 결과에 따라 재기획: 트리거가 제품 결정(모든 턴 vs 선별)을 요구하면 성재 결정 큐로 — env 폐곡선(후보 B)의 리포트 재사용 설계는 B ADR에서.
