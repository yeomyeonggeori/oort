# 핸드오프 패킷 — #1613 셀프호스트 스택·볼륨 교차-체크아웃 충돌 fail-closed

- status: ready · planning: PLN-20260815-01 · owner: Fable(momo-main) · integrator: momo-main
- 기준 커밋: `origin/track/engine` (ITO-0 5/5 + #1332 랜딩 계열)
- 이슈: **#1613** (P1 — AC 정본은 이슈 본문·실사고 서사 포함) · 결재: ITO-0 후속 파도(스냅샷 44 "후속 파도 선두")
- 워커: grok 4.6 단독 · 검수: Fable · supersedes: 없음

## 결정 요약
2026-08-20 실사고 실측: `COMPOSE_PROJECT_NAME` 기본 `oort` 고정 + compose 볼륨 `name: oort-pgdata` 고정 때문에 **다른 체크아웃의 `--compose up`이 가동 중인 스택을 무경고 recreate**하고, 프로젝트명을 분리해도 **같은 PG 데이터 디렉토리를 공유 마운트**(PostgreSQL 이중 기동 실측 — 손상 위험). 셀프호스터 실경로(clone A 운영 중 clone B에서 up)라 **ITO-1 H1 전 수리**가 조건.

## 파일 맵 (실측)
- `infra/rust/docker-compose.rust.yml:409-412` — `volumes: pgdata:` + 고정 `name` 주석("Swift 스택 볼륨 비채택" 원 의도 — 이 의도는 보존할 것)
- `scripts/self_host_env.sh` — `PROJECT="${COMPOSE_PROJECT_NAME:-oort}"`(:546 부근)·env 기록(:604 부근)·`:56` usage 주석
- `scripts/tests/test_self_host_env_modes.sh` — 동형 테스트 자리
- `docs/SELF_HOST.md` — 「멈추기·지우기」·「막히면」 절(문면 반영 대상), `docs/SELF_HOST_FIRST_DAY.md`(T-B — 링크 정합만)
- 사고 원문·재현 시퀀스: 이슈 #1613 본문

## 작업 (AC는 이슈 — 여기는 순서 권장)
1. **택일 상신 ①(볼륨 정체성)**: (a) 프로젝트 스코프 볼륨(기본 — 프로젝트마다 자기 데이터) vs (b) 고정 이름+선점 잠금. 어느 쪽이든 **기존 설치 마이그레이션 경로 필수** — 기존 `oort-pgdata` 사용자가 업그레이드 후 `up` 했을 때 데이터가 조용히 새 볼륨으로 "사라져 보이는" 사태 금지(감지→명시 안내 or 채택 절차).
2. **기동 전 충돌 검출 fail-closed**: 같은 볼륨/프로젝트를 쓰는 **살아있는 타 스택**(다른 working_dir 라벨) 감지 시 up을 중단하고 원인·해법 출력(docker compose ls / 컨테이너 라벨 `com.docker.compose.project.working_dir` 대조가 실측 가능한 신호).
3. 회귀 테스트: 충돌 시나리오 2종(동일 프로젝트명 타 체크아웃·프로젝트 분리+볼륨 공유)이 RED로 잡히는 단언 — 실 docker 불가 환경이면 라벨 파싱 단위로.
4. `SELF_HOST.md` 문면: 두 체크아웃 운용 시 규칙 1절(왜 막히는지·어떻게 분리하는지).

## 지켜야 할 계약·함정
- **기존 데이터 보존이 최상위** — 어떤 갈래도 기존 `oort-pgdata`를 삭제·무언 대체하지 않는다. down -v 의미 변화 금지.
- **#1361 재개 호환**: `momo-tracks/engine` 체크아웃의 기존 볼륨 스택 재개(`--compose up -d --wait`)가 마이그레이션 경로의 대표 케이스 — 이 시나리오가 무경고로 계속 동작해야 한다(같은 체크아웃=정당한 소유자).
- Swift 스택 볼륨(`momo-pgdata`) 비채택 원 의도 보존(:411-412 주석 계승).
- `server-rust/**` 비접촉 · 기존 env 덮어쓰기 금지 · 시크릿 비유입 · push/PR/머지 금지(로컬 커밋만).
- T-A(#1607)가 이 파일들에 방금 랜딩 — 그 문면(tauri CORS·append-if-absent) 훼손 금지.

## 검증
`test_self_host_env_modes.sh` 확장 그린 · `bash -n` · `check_docs_commands.py` · 가능하면 실 docker로 충돌 감지 1회 실측(불가 시 정직 라벨).

## 착수
`scripts/goal_claim.sh --base track/engine 1613` → 패킷+이슈만으로 착수. 최종 출력: ## 요약 / ## 택일과 논거(볼륨 정체성·마이그레이션 경로) / ## 변경 파일 / ## 재검증 표 / ## 계획 이탈 / ## 티켓 후보
