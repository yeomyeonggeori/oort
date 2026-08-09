# 핸드오프 패킷 — buzz급 진단 감사 (5워커 전면 병렬 · A~E)

> 발주: 2026-08-10 Fable (성재 발제 "기준을 buzz로 두고 버즈급 런칭을 할 수 있을 수준인지 진단"). 구체화 정본: `docs/planning/research/2026-08-10-ouroboros-buzz-diagnosis-interview.md`(세션 `interview_20260809_145721`).
> **"buzz급" 해석(인터뷰 확정·성재 확인 대기 S-10)**: 아키텍처 모방 아님(ADR-0145 — buzz는 레퍼런스, 불변식 3개 충돌). **오픈소스 프로젝트로서의 성숙도·런칭 가능 상태** 벤치마크 — buzz(github.com/block/buzz)가 실제로 갖춘 것이 기준선이다.

## 공통 규율 (전 워커)

- **감사는 측정이지 수리가 아니다.** 코드·설정 변경 0줄. 산출물 = 보고서 파일 1개(스크래치패드) + 최종 보고.
- 모든 주장에 근거: 레포는 파일:줄, 실측은 명령+출력 요지, buzz 기준선은 그 레포의 실제 상태(WebFetch/gh로 github.com/block/buzz 실측 — 추측 금지).
- 판정 형식: 축별 체크리스트 각 항목에 `PASS / GAP(격차 서술) / BLOCKED(선행 필요)` + 1층(go/no-go 재료)과 2층(격차 베이스라인) 구분.
- 이 레포 기준 브랜치: **origin/track/engine이 개발선**(main은 문서 정본, engine이 앞선다). 실측은 engine 기준, main-only 사실은 명시.
- 성재만 답할 수 있는 것(공개 시점·범위·라이선스 선택·런칭 정의 등)은 판정하지 말고 "성재 결정 대기"로 기록.
- 보고서 파일: `/private/tmp/claude-501/-Users-kwakseongjae-projects-momo/ab94d88e-3191-46c6-b77e-ce06e7aa9df5/scratchpad/buzz-audit-<축문자>.md`
- 중간 보고 없음. 완주 후 최종 보고 1회(파일 경로+체크리스트 집계+상위 발견 3개).

## A — 라이선스·공개 준비

인터뷰 선행 실측(검증·확장하라): `check_spm_licenses.sh`에 cargo 문자열 0 → `Cargo.lock` 309 crate 전부 미커버 · npm 섹션은 폐기 트리 `web-legacy` 기준(정본 web 477·mobile 1076 미커버) · CONTRIBUTING이 기여자에게 "GPL/AGPL fail-closed"를 약속 · `publish-images.yml`이 GHCR 푸시 중(Apache-2.0 §4(d) 재배포 조건 이미 발효).

- 의존 라이선스 전수: cargo(`cargo license` 류 또는 Cargo.lock 파싱)·npm(web·mobile·core) — AGPL/GPL/미상 라이선스 존재 여부. CLAUDE.md "AGPL 백본 금지"와 대조.
- LICENSE·NOTICE·저작권 헤더 현황. buzz 레퍼런스 코드가 실제 복사됐는지(ADR-0145는 "패턴 인용만"이라 주장 — 반증 시도).
- **git 히스토리 시크릿**: 전 히스토리 대상 시크릿 스캔(키·토큰·비번·pem 경로). 커밋 이력에 남은 것은 파일 삭제로 안 지워진다 — 공개 차단급인지 판정.
- 공개 시 노출되는 것 목록: 내부 인프라 주소·계정 식별자·운영 문서. `legal/privacy-policy.md` 빈칸 상태 확인.
- buzz 기준선: block/buzz의 LICENSE·NOTICE·의존 감사 장치·CONTRIBUTING 실태.

## B — 배포 재현성·단일 이미지

인터뷰 선행 실측: 단일 이미지가 **두 개**(문서·README·publish 워크플로=Swift 이미지+web-legacy, 라이브=momo-rust) · 운영 배포 정의는 서버 위 compose 5+env 2 수작업 — 레포에서 재현 불가 · `infra/rust/docker-compose.rust.yml`은 스스로 "smoke"라 선언(caddy·redis·prometheus·notifier·web 의도적 제외).

- 레포에서 라이브를 재현하는 데 필요한 전부를 목록화: 어떤 파일이 레포에 있고(경로), 어떤 것이 서버에만 있나(이름만 — 값 금지). 격차 = "레포화 필요 항목" 표.
- 단일 이미지 격차: 현행 momo-rust 이미지에 없는 것(웹 정적·caddy·centrifugo 설정·마이그레이션 실행 모델) vs buzz의 배포 스토리(단일 바이너리/이미지인가? 실측).
- `publish-images.yml`이 짓는 것과 라이브가 쓰는 것의 불일치 전말.
- 서버측 실측이 필요한 항목은 **읽기 전용 덤프 명령 목록**으로 정리만(성재 `!` 대행용 — 시크릿 값이 출력되지 않게 설계: 파일명·docker ps·이미지 태그·마운트만). 실행하지 말 것.

## C — time-to-hello 실주행 (문서 리뷰 아님 — 직접 밟아라)

- 신규 셀프호스터 시나리오: **레포 클론 → 문서가 시키는 대로 → 채팅 화면에서 메시지 1개 왕복**까지 실제로 밟는다. README/`docs/DEPLOY.md`/quickstart 중 문서가 안내하는 경로 그대로. 로컬 Docker 사용 가능(데몬 떠 있음).
- 어디서 깨지는지(명령·에러 원문), 문서에 없는 임기응변이 몇 번 필요한지, 총 소요를 기록. Swift 경로와 Rust 경로 둘 다 문서가 가리키면 문서가 가리키는 쪽을 따르되 다른 쪽도 짧게.
- ⚠ 자원 위생(하드): compose 프로젝트명은 `buzzaudit-` 접두 고유값, 끝나면 `docker compose down -v` + 생성 이미지·볼륨 회수 확인. 호스트 과열 전례 있음.
- buzz 기준선: buzz의 셀프호스트 quickstart가 약속하는 time-to-hello(문서 실측).

## D — 프로덕션 운영 준비

인터뷰 선행 실측: 부하·성능 근거 0(스크립트·문서) · prometheus 라이브 부재 · `upgrade.sh`는 Swift용·forward-only · 운영 인력 1인·열린 이슈 125.

- 백업/복구: PG 백업 절차·복구 리허설 흔적·outbox/첨부(Drive) 복구 경계. 실재하는 문서/스크립트 대 부재 목록.
- 관측: 메트릭·로그·알림의 정의(레포) vs 라이브 추정(레포 근거로만 — 서버 실측은 B의 대행 목록에 위임).
- 업그레이드·마이그레이션 정책: 롤백 가능성(마이그레이션 62+·forward-only), 버전 정책 부재 여부.
- 장애 대응: 런북 커버리지(있는 것: ncp-rust-deploy 등 — 없는 것: 무엇이 죽으면 어떻게), 단일 서버 SPOF.
- 성능: 실측 근거가 있는 수치 전부 수집(스파이크 게이트 p95 등 과거 기록 포함), "buzz급 실워크로드" 판정에 부족한 측정 목록.
- CI: 워크플로 5개 전부 workflow_dispatch(2026-06-26 과금 이슈)·PR CI 0·**CI가 Rust 워크스페이스를 빌드한 적 없음** — 외부 기여 수용 불가 구조의 전말.

## E — 문서·정체성 드리프트

- README·docs 최상위 경로가 안내하는 제품상 vs 실제(라이브 스택·브랜치 구조·momo↔oort 리브랜딩 잔여 표면 — 도메인 oor7.com·앱명·이미지명·레포명 momo).
- 신규 방문자(잠재 기여자/셀프호스터)가 처음 30분에 만나는 모순 목록.
- 열린 이슈 125의 형상(트리아지 가능성 — 라벨·중복·연령 분포. 내용 판정은 아님).
- buzz 기준선: block/buzz의 README·문서 구조가 갖춘 것.
