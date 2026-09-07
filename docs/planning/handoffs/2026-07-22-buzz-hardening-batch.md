# 핸드오프 패킷 — buzz 하드닝 배치 (Wave H, 2026-07-22)

> 계약 정본: `docs/planning/2026-07-22-buzz-actions-plan.md` **§4.2 프롬프트 전문**(티켓별)이 각 goal의 이슈 계약이다. 이 패킷은 §4.2를 핸드오프 패킷으로 승격하는 문서이며, 발급 이후 확정된 정정만 추가로 담는다. 근거는 같은 문서 §1(감사 사실)과 `2026-07-22-buzz-competitive-analysis.md`, ADR-0132(Accepted).

## 티켓 ↔ 이슈 매핑

| 티켓 | 이슈 | 상태(2026-07-22 심야) | 비고 |
|---|---|---|---|
| MOMO-554 | #647 | **main 랜딩**(083a36f+4a7b34b) | Critical. verifier 3회차 PASS(28170~28173) |
| MOMO-555 | #648 | **main 랜딩**(5b271dd) | 리베이스 시 local_gate.sh 유니온 해소 |
| MOMO-556 | #649 | worker 진행 중 | 555 랜딩 후 스폰됨 |
| MOMO-557 | #650 | 검수 중(verifier 반복) | migration **038** 재부여됨 |
| MOMO-558 | #651 | blocked(557 소비, base track/uxui) | |
| MOMO-559 | #652 | 검수 대기 | verifier 28191~28194 |
| MOMO-560/561/563 | #653/#654/#655 | blocked(H1 후) | 561은 554 랜딩으로 선행조건 충족 |
| MOMO-564 | #656 | ready | 공개 릴리스 전제 |

## 발급 후 확정 정정 (§4.2 대비 델타)

1. **마이그레이션 번호**: 647이 037을 사용했다. 650은 **038로 재부여 완료** — 이후 티켓은 **039부터**. `scripts/check_migration_numbers.sh`(555)가 게이트에서 강제한다.
2. **verifier 포트**: 28170~28173(554)·28184~28187(557)·28191~28194(559) 사용 중. 다음 예약은 **28200대**에서 선점 grep 후.
3. **local_gate.sh 겹침**: 554·555·557·559가 전부 이 파일을 수정한다. 리베이스 시 add_cmd_once 리스트는 **유니온**(라벨 중복 없이 한 줄 유지)으로 해소한다.
4. **`.env.example` 동기화 의무**: 554가 `secrets.env.example`만 갱신하고 `infra/prod/.env.example`을 누락해 main docs 게이트가 깨졌던 전례(30c639c로 해소). prod env 템플릿을 바꾸면 **두 파일을 함께** 갱신하라.
5. **e2e worker 서비스는 콜드 소스 빌드**: verifier가 `compose up -d worker` 후 즉시 짧은 대기창을 열면 안 된다 — "agent worker starting" 로그 마커를 먼저 기다려라(650 verifier에 패턴 반영됨).

## 불변 (재확인)

- PR base = track/engine(558만 track/uxui), Draft PR 후 정지, merge/close 금지.
- Docker verifier/게이트는 오케스트레이터 실행(runtime-unverified 인계).
- `schema_v0.sql` 불변, 시크릿 커밋 금지, ADR-0004(자격증명 비유입).
- 머지 후 push 전: 추적 소스 마커 grep 0 + macOS `swift build` PASS.
