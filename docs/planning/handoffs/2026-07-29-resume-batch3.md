# 재개 세팅 3 — 2026-07-29 (성재 "잠시 중단" 지점)

> **이 문서 하나로 재개한다.** 이전 재개 문서: `2026-07-28-resume-batch2.md`(완료). 배치 준비/완료 기록: `2026-07-29-workflow-batch-prep.md`.
> **워커 모델 = Opus 5**(성재 지시, effort 핀 없음). 병렬 실행은 **Workflow**(`/workflows` 라이브 관전) — 단일 워커 순차는 폐기.

## 0. 성재에게 이렇게 시키시면 됩니다

| 하고 싶은 것 | 지시 문장 |
|---|---|
| 멈춘 지점 그대로 재개 | **"재개 문서 3 읽고 이어서 해줘"** |
| 배치 3만 검수·머지 | **"배치 3 검수해줘"** |
| NCP 서버 smoke 재개 | **"T3 smoke 이어서"** |

## 1. 지금 상태 한 줄

**배치 3(H·I·J·K) 4개 PR이 전부 열려 있고 오케스트레이터 검수 전이다.** main은 `4ce7e53b`(배치 2까지 반영 완료). NCP 스모크 서버는 **RUN 상태이고 공인 IP 미할당**.

## 2. 재개 시 바로 할 일 (순서대로)

### (1) 배치 3 검수 — 여기서 멈췄다

4개 PR 전부 **worker 로컬 검증은 green**, docker 계층은 오케스트레이터 몫이다.

| 레인 | PR | 브랜치 / 워크트리 | base |
|---|---|---|---|
| **H** #904 | [#910](https://github.com/Dawn-kim-official/momo/pull/910) `0139accc` | `feat/904-openapi-sample-backfill` / `momo-worktrees/904-openapi-backfill` | track/engine |
| **I** #908 | [#912](https://github.com/Dawn-kim-official/momo/pull/912) `22144956` | `feat/908-attach-followup` / `momo-worktrees/908-attach-followup` | track/engine |
| **J** #849+#848 | [#909](https://github.com/Dawn-kim-official/momo/pull/909) `cd237ace` | `feat/849-consent-followup` / `momo-worktrees/849-consent-followup` | **track/uxui** |
| **K** #879① | [#911](https://github.com/Dawn-kim-official/momo/pull/911) `887abf03` | `feat/879-floor-precision` / `momo-worktrees/879-floor-precision` | track/engine |

**검수 절차(배치 1~2에서 확립된 형태 그대로)**: 각 워크트리에서 `git merge origin/track/<base>` → 충돌 해소(STATUS.md는 항상 양측 보존) → 빌드·테스트 → **docker 검증기 + red proof 실행** → 머지 → PR 코멘트 + 이슈 close.

**레인별 오케스트레이터 실행 목록:**
- **H**: `scripts/verify_openapi_contract.sh` 완주. 기대: `PASS operation coverage (128 operations sampled)` — **부채 접미사가 사라져야 한다**. 실패 다발이면 `OPENAPI_GATE_MAX_FAILURES` 올려 전체 목록 확보. **워커가 실주행을 안 했으므로 진짜 드리프트 발견은 내 몫**(발견 시 별건 티켓).
- **I**: `scripts/verify_workd_attach.sh` + `WORKD_ATTACH_PROVE_RED=replay-marker`(실패해야 통과) + `scripts/verify_workd.sh`(attach 미설정 시 리스너 미개방 무회귀).
- **J**: **design-review 에이전트(fresh context, Blocker 0)** 필수 — 하드 룰. 웹 게이트 6종. 그 뒤 **track/uxui**에 머지(engine 아님).
- **K**: `scripts/verify_t3_interval_precision.sh` + `T3_PRECISION_PROVE_RED=interval-floor`(exit 1이어야 통과) + T3 스위트 무회귀(`verify_t3_convergence`·`verify_t3_provider_continuity`·`verify_t3_lifecycle_concurrency`·`verify_t3_migration_repair`) + 무회귀 4종(`work_session`·`work_session_idle`·`work_host`·`workd`).

**머지 순서 권고**: K → H → I (engine, K가 058 마이그레이션이라 먼저) · J는 독립(uxui).

**주의 — 마이그레이션 번호**: K가 **058** 사용. 다음 배치는 059부터.

### (2) 검수에서 특히 볼 것 (워커 자기신고 이탈)

- **K**: `work_host_usage_interval.active_seconds`를 **DROP하고 `active_micros`로 교체**했다(두 컬럼 공존 시 옛 이름이 뒷문이 된다는 근거). 058 이전 정산 행은 `active_micros IS NULL`로 영구 합법 = **과거 청구 불변**. reconciler `confirm()`의 구간 겹침(`now()` vs `clock_timestamp()`) 3줄도 함께 고쳤다 — 경계 확장이지만 us 정밀도에서 이중청구가 되는 자리라 타당.
- **I**: 서버 `ValidateTerminalAttachRequest`에 `stream: boolean` 1필드 추가 — **만료 조항만** 완화(TTL 60초라 재검증이 곧 스트림 절단이 되는 문제). 나머지 인가 조항 전부 유지, 계약 테스트로 소스 문자열까지 잠금. observer GC 보존기간 1시간 확대(재검증이 행을 재사용하므로).
- **J**: `--danger` 위계를 **대비가 아니라 채도(OKLab chroma)로** 재정의. 실측상 옛 다크 danger는 warn보다 대비가 **높았고**(10.55 vs 8.03) 역전의 실체는 채도(0.068 vs 0.141)였다. sRGB에서 "채도·대비 둘 다 warn보다 높은 빨강"은 존재하지 않는다는 것이 근거. 새 토큰 `--spacing-action: 144px` 추가. **파일 경계 1개 초과**: `.claude/skills/momo-design-taste-web/references/tokens.md`(#848 수용 기준이 명시 요구).
- **H**: 미샘플 44건은 "샘플 누락"이 아니라 **게이트가 그 환경을 안 켜서 도달 불가**였다 — compose override로 플랫폼 관리자·T3·공개 엔드포인트를 켰다. 기존 샘플 무영향을 코드로 확인했다고 주장하나 **실주행 확인은 내 몫**. SQL 지름길 2곳(orphaned 세션·context packet id) 사용 — REST로 못 만드는 선행 상태라 기존 선례와 동형.

### (3) 검수 후: main 반영 — **성재 승인 필요**

배치 3 머지 후 engine/uxui 양쪽이 앞서므로 순차 머지 + 원점 검증(서버·워커·kit·웹 typecheck/vitest/build + 게이트 6종). **웹 변경(J)이 있으므로 게이트 필수.**

## 3. NCP T3 smoke (별건, 진행 중)

- **서버**: `momo-t3-smoke` / 인스턴스 `143929369` / **RUN** / Ubuntu 22.04(KVM) / s2-g3(2vCPU·8GB) / KR-2
- **자원**: VPC `144489` · Subnet `314600` · ACG `377539`(SSH를 `211.209.174.249/32`로만) · SSH키 `~/Downloads/momo-t3-smoke.pem`
- **다음 한 걸음**: 공인 IP 할당 — `scratchpad/ncp-assign-ip.py` 실행(성재 트리거. 클라우드 자원 생성이라 자동 승인 분류기가 막는다).
- 그 뒤: SSH 확인 → compose 스택 + momo-workd 설치 → **BYOC 등록→세션→과금 원장→종료** smoke → `MOMO_T3_ENABLED` 판단 자료.
- **도구**: NCP 공식 MCP(`scratchpad/NCP-Claude-Project/ncp-mcp`) + venv(`scratchpad/ncp-venv`, mcp 1.x 고정). 자격증명 `~/.ncp/credentials.env`.
- **MCP 한계 실측**: `provision_server`는 구형 XEN 코드 체계 전용이라 **KVM 세대(Ubuntu 22.04) 서버 생성 불가** — `serverImageNo`+`serverSpecCode`+`networkInterfaceList`로 직접 호출해야 한다(`scratchpad/ncp-create-kvm.py`가 그 형태). `list_servers`는 `responseFormatType` 미지정이라 XML을 반환 → `_build_path`로 우회.
- **보안 후속**: API 키가 명령줄에 노출됐다 — **작업 종료 후 NCP 콘솔에서 재발급 권고**(성재).
- **비용**: s2-g3 시간당 100원대. 쓰지 않을 땐 정지, 끝나면 서버·공인IP·VPC 반납.

## 4. 열린 티켓 (배치 3 랜딩 후 기준)

- **#886**(049 fail-closed 복구 — 이미 랜딩된 #886과 별개인지 확인 필요) · **#849 8·9·10**(J가 1~7만 처리) · **#904 파생**: provider link/chain·effort-table 스펙이 `additionalProperties: true` 자리표시자라 샘플이 있어도 드리프트 감지 불가 → **실 DTO를 스키마로 승격하는 별건 티켓 후보**(H 보고).
- **#837** RN 스파이크 실기기 · **ADR-0138**(온보딩) · **ADR-0113 증보**(3자 OAuth) · `legal/privacy-policy.md` 빈칸(공개 런칭 차단).
- **ADR-0141 보류 해제**: 사용 패턴 데이터가 모이면 재론(Takeover·unreachable·WIP push).
- **ADR-0144 이행 1**: Kata PoC — **베어메탈/중첩가상화 노드 필요**(NCP 일반 VM 불가). BYOC smoke 결과 본 뒤 판단.

## 5. 파이프라인 교훈 (배치 3 구간 추가분)

- **워크플로 병렬이 정착했다**: 배치 1(4레인 27분)·2(3레인 32분)·3(4레인 49분). 단일 워커 순차 대비 구현 구간이 크게 압축됐고 `/workflows`로 가시성도 확보.
- **결함은 여전히 docker 계층에 몰린다** — 배치 1~2에서 오케스트레이터가 고친 것: 픽스처 provider 누락·마이그레이션 번호 충돌·sweep 간섭·destroy 라우트 오기·red 사본 `.env.example` 제외·실왕복 하니스 배선. **워커의 로컬 green은 필요조건일 뿐이다.**
- **"아무 non-2xx나 통과" 단정 금지** — 라우터 404와 의도된 거부를 구분 못 한다(#907 실측). 상태코드·본문을 특정하라. 배치 3 패킷부터 공통 규율에 넣었다.
- **워커가 자기 이탈을 근거와 함께 신고하는 형태가 자리잡았다** — 배치 3은 4레인 전부 이탈을 자진 보고했고 대부분 타당했다(K의 컬럼 교체, I의 최소 서버 변경, J의 채도 기준). 패킷에 "이탈은 숨기지 말고 근거와 함께"를 계속 유지할 것.
