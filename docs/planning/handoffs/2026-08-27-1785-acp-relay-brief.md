# #1785 브리프 — ACP 이벤트 릴레이 이식 (engine, #1777 후속)

> 실행플랜 순서 ⑤ 첫 발사(상호 독립 3건 중 터미널 축 급소). 방향 기승인(성재 자율 진행 위임).
> 새 브랜치 `feat/1785-acp-relay`, base=`origin/track/engine`(sync-26 반영 최신). 워크트리 `~/projects/momo-tracks/momo-worktrees/w1785-acp-relay`.

## 0. 현황 (이슈 #1785 실측 승계)

- `PATCH …/acp` + `event` 계열이 400 `ACP event ingestion requires work host signature` — 데몬은 보내고 서버가 안 받는다. #1777이 이식한 세 팔(create·lifecycle·bindRemotePTY)과 같은 클래스의 미이식.
- 관전 도크 폐곡선은 #1777로 이미 열림 — 이 티켓은 에이전트 실행 진행 상황(도구 호출·단계 전이)의 구조화 수신 팔.

## 1. 계약

1. **이식 원본이 계약**: `server/Sources/`의 ACP 이벤트 수신 팔을 권한 규칙·에러 문장·wire 필드명 그대로 이식(#1777 규율 — 데몬이 이미 보내는 모양이 계약, 발명 금지). host-signed 검증은 #1777이 놓은 `work_host_auth` 경로 재사용.
2. 수신 이벤트의 **투영·소비면 실측**: 원본에 있으면 같이 이식, 없으면 서버 수신(세션 원장 반영)까지만 — 표면은 별도 티켓 제안으로 PR NOTES에 남긴다.
3. **#1345 재사용 금지**(감사 티켓 — #1777 워커 명시 경고). 정본 번호는 #1785.
4. 단일 쓰기경로·RLS 불변식 준수. `schema_v0.sql` 비접촉.

## 2. red proof ([rust] 3종 — 이슈 AC 그대로)

- 무서명 요청 거절(현행 400 문장 회귀 아님 — 이식 후에도 무서명은 닫혀 있어야 함).
- 정상 host-signed 이벤트 200.
- 수신 이벤트가 세션 원장에 반영(재조회 실측).
- red 관례: 이식 전 정상 서명 이벤트가 거절되는 RED를 선행 확인 후 GREEN 전환.

## 3. 게이트 (전부 자가 실행, 그린 로그를 PR 코멘트에 동반)

cargo fmt --check · clippy -D warnings · cargo test --workspace · 관련 PG 컨포먼스(기존 `host_signed_session_conformance_pg` 확장 또는 신설 — 15432 게이트 PG) · `scripts/verify_openapi_contract_rust.sh`(스펙 접점 있으면 갱신 동반) · gitleaks.

## 4. 정지 조건 (정지 시 push 없이 보고만)

- **라이브 리그 DB(oort-t 스택) 비접촉 — 게이트 PG만 사용. 테스트·검증이 리그 컨테이너/포트에 닿아야 할 이유가 생기면 무조건 정지**(2026-08-27 사고 재발 방지, 상설).
- 이식 원본과 현행 Rust 구조가 모순돼 발명 없이 이식이 불가할 때.
- `schema_v0.sql` 접촉 필요해 보일 때.
- 게이트 RED 원인이 범위 밖일 때.

## 5. 금지·완료

- merge/close 금지 · force push 금지 · 시크릿 커밋 금지 · 커밋 한국어(무엇이 왜).
- 완료 = push + PR 생성(제목에 `#1785`, base=track/engine, red proof·게이트 요약) 후 정지.
