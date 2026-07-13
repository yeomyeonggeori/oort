# Handoff Packet — Agent Work Surface v0 (MOMO-362/363/364/365)

- Status: **active** (2026-07-13, momo-main/Fable · ADR-0111 Accepted, Option A=BYOA — 성재 발제·판정)
- 정본: `docs/adr/0111-agent-work-surface.md` (D1~D5·Non-goals가 경계), ADR-0102(gateway 경로 보장 매트릭스), ADR-0004(provider 자격증명 비유입), MOMO-349(승인 왕복)·350(status/partial)·341(lease).
- 목표: 채널에서 특화 에이전트에게 실제 업무(터미널·코드 작업)를 시키고, 시작→진행 transcript→승인→결과(diff/PR/exit)가 전부 타임라인 원장에 남는 v0. **momo 서버는 코드를 실행하지 않는다.**

## 공통 계약 (네 티켓 모두)

- `schema_v0.sql` 불변. v0는 신규 migration 없이 convention으로: work 계약은 `agent_run.input` jsonb, capability는 `agent.config.capabilities`(string 배열, 예 `["code","terminal"]`).
- 불변식: REST 단일 쓰기 경로, 순서=`message.seq`, actor binding(자기 run만), RLS FORCE, ADR-0004.
- worker 금지: DB/Docker/verifier/`local_gate.sh` 실행, merge/close, 시크릿 커밋. UI 티켓은 스냅샷 정본 재기록을 오케스트레이터 대기로 명시.
- 승인 티어(ADR-0111 D3): read-only=자동, workspace-write=승인 왕복 필수, network 쓰기·자격증명=승인+감사, danger 상당=표면에서 요청 불가(fail-closed).

## MOMO-362 — work run 계약 v0 `[swift/runtime-agent]` (선행, 단독 스폰)

문제: `agent_run.input`에 work 계약이 없고, 승인 티어를 서버가 강제하지 않는다.
방향:
1. work input 계약 검증 — `{type:"work", title, brief, repo?, branch?}` shape를 run 생성/트리거 경로에서 검증(비-work run은 무영향). 잘못된 shape는 4xx(트랜잭션 밖 매핑 — MOMO-341 교훈).
2. 승인 티어 서버 가드 — gateway 승인 요청 payload에 `tier` 필드(read_only|workspace_write|network_write)를 받고, `danger` 상당 요청은 400 fail-closed. tier는 approval 카드 metadata로 전달.
3. work run 목록/상세 REST 표면(기존 run 조회 확장 수준, 새 테이블 없음) + 서버 단위 테스트(shape 검증·tier fail-closed·actor binding).
4. 기존 349/350/341 경로 회귀 없음 — 동등성 verifier 계약 비파괴.

## MOMO-363 — codex-workbench gateway adapter `[python/runtime-agent]` · 의존: MOMO-362

문제: work run을 실행할 레퍼런스 에이전트가 없다.
방향:
1. `adapters/codex-workbench/` — hermes adapter 패턴 승계(같은 bearer/gateway REST 계약). work run claim → 에이전트 호스트에서 `codex exec` headless 실행(`--output-last-message`, 세션 id 보존→후속 지시는 `codex exec resume`).
2. sandbox 티어 매핑: read-only 명령은 `-s read-only`로 즉시, workspace-write 필요 시 **실행 전** 승인 요청(tier=workspace_write, 명령 요약 포함)→승인 후 `-s workspace-write` 실행. danger-full-access는 코드 경로 자체가 없다.
3. transcript는 status/partial 스트림(350 계약)으로, 최종 결과는 구조화 결과 카드(diff 요약·변경 파일 수·exit code·PR 링크 자리)로 commit. 운영 공지는 MOMO-356 계약대로 durable 유출 금지.
4. provider 자격증명(codex OAuth)은 어댑터 호스트에만(ADR-0004). mock codex 바이너리 기반 계약 테스트(py, DB 비접속) + `bash -n`/py_compile. 실 codex 실행 검증은 오케스트레이터.

## MOMO-364 — Work 표면 UI `[swift/macos-ui]` · 의존: MOMO-362 (363과 병렬 가능)

방향:
1. Work 시작 컴포저 — 채널 입력창 `/work` 커맨드(+컴포저 버튼): 대상 에이전트 선택(365의 배지 후보), title/brief 입력.
2. 타임라인 work 카드 — 상태(대기/실행/승인 대기/완료/실패), 라이브 로그 테일(partial 스트림 재사용, 접기 기본), 인라인 승인(기존 승인 카드 재사용), 결과 요약(diff/exit/링크).
3. work 상세 페인 — transcript 전체 스크롤, 노이즈는 카드 접기로 억제(P8).
4. momo-design-taste 준수, light/dark 스냅샷(핵심 픽셀: 상태 칩·로그 테일·승인 버튼·결과 요약), MessageListView 그루핑(359)과 비충돌.

## MOMO-365 — capability 배지·Work 대상 선택 `[swift/macos-ui]` · 의존: MOMO-362 (364와 병렬 가능)

방향:
1. `agent.config.capabilities`를 roster/agent 상세 응답에 표면화(서버는 read-through, 새 스키마 없음)하고, 사이드바 멤버 행·Cmd+K 스위처·멘션 후보에 capability 배지(code/terminal 등) 표시.
2. Work 시작 시 대상 후보 = **선택 채널에 초대된 active 에이전트 중 해당 capability 보유자만**(354 invite-gating 술어 재사용). 자동 라우팅 없음(v1+).
3. 배지는 AGENT 배지 문법과 정합(공용 컴포넌트 추출 기회 — 358 리뷰 이월사항과 합류 가능).
4. 스냅샷 + 후보 필터 단위 테스트.

## 검수·머지 절차 (오케스트레이터)

362 랜딩(runtime-agent gate) → 363(mock 계약 검수 + 실 codex 왕복은 오케스트레이터가 라이브 검증) / 364·365(design-review Blocker 0 + 스냅샷 재기록 + macos-ui gate) 순차 머지 → root gate → 라이브 반영(성재 머신 codex-workbench 1기 기동) → 성재 육안: 채널에서 /work → 승인 → 결과 카드.
